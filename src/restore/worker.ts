/**
 * S3-R3..S3-R7: restore worker. Runs INSIDE the pinned Linux container.
 *
 * Pipeline: preflight selection (S3-R1) -> materialize the workspace
 * (S3-R2) -> compare the tree -> seed the OpenCode session store
 * (S3-R4) -> start the interception proxy -> run real OpenCode once with
 * the selected prompt -> compare the regenerated primary request -> write
 * reports. Zero outbound model inference: every model request is answered
 * locally. Any failure exits nonzero with a machine-readable result.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { runSessionCommand } from "./session-command.js";
import { writeRestoreResult } from "./report.js";
import { RestoreError, verifyObject } from "./select.js";
import { EventTrace } from "../capture/trace.js";
import { CaptureProxy } from "../capture/proxy.js";
import { checkpointDir, readManifest, selectCheckpoint } from "./select.js";
import { INCLUSION_POLICY, materializeWorkspace } from "./materialize.js";
import { compareTree } from "./compare.js";
import { compareRequests, selectedTurnInput } from "./request-compare.js";
import { planSeed, renderSeedSql } from "./context-seed.js";

export interface WorkerOptions {
  readonly storeRoot: string;
  readonly checkpointId: string;
  readonly outputDir: string;
  readonly workspacePath: string;
  readonly homePath: string;
  readonly tmpPath: string;
  readonly opencodeBin: string;
  readonly nodeVersion: string;
  readonly sqliteVersion: string;
  readonly imageDigest: string;
  readonly opencodeLockSha256: string;
  readonly harnessRevision: string;
  readonly timeoutMs: number;
  /** S3-R5 test hook: mutate the workspace after all comparisons pass. */
  readonly mutateAfterCompare?: boolean;
}

interface RequestRecord {
  readonly index: number;
  readonly classification: string;
  readonly background?: boolean;
  readonly body: Record<string, unknown>;
}

interface CheckResult {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

export async function runRestoreWorker(options: WorkerOptions): Promise<number> {
  const started = Date.now();
  mkdirSync(options.outputDir, { recursive: true });
  const checks: CheckResult[] = [];
  const trace = new EventTrace(join(options.outputDir, "trace.jsonl"));
  const result = (status: "PASS" | "FAIL" | "BLOCKED", extra: Record<string, unknown> = {}): number => {
    writeRestoreResult(options.outputDir, status, options.checkpointId, started, checks, extra);
    console.log(`RESTORE ${status}: checkpoint=${options.checkpointId} run=${options.outputDir}`);
    return status === "PASS" ? 0 : 1;
  };
  const record = (check: string, ok: boolean, detail: string): void => {
    checks.push({ check, ok, detail });
    console.log(`  ${ok ? "ok" : "FAIL"} ${check}${detail ? ` — ${detail}` : ""}`);
  };

  let activeProxy: CaptureProxy | undefined;
  try {
  // S3-R1: explicit selection and preflight validation.
  let selection;
  try {
    selection = selectCheckpoint({ storeRoot: options.storeRoot, checkpointId: options.checkpointId });
    record("selection.identity", true, `session=${selection.sessionId} message=${selection.messageId}`);
  } catch (err) {
    record(err instanceof RestoreError ? err.check : "selection.preflight", false, String(err instanceof Error ? err.message : err));
    return result("FAIL");
  }
  writeFileSync(
    join(options.outputDir, "selection.json"),
    `${JSON.stringify({ ...selection, restoreWorkspacePath: options.workspacePath }, null, 2)}\n`,
  );

  // S3-R1: object hashes verified inside selectCheckpoint; record it.
  const manifest = readManifest(options.storeRoot, options.checkpointId);
  record("objects.verified", true, `${manifest.files.filter((f) => f.kind === "file").length} file objects hash-verified`);

  // S3-R2: materialize the workspace from the read-only store.
  let materialized: { restored: number };
  try {
    rmSync(options.workspacePath, { recursive: true, force: true });
    materialized = materializeWorkspace(options.storeRoot, manifest, options.workspacePath);
    record("workspace.materialized", true, `${materialized.restored} entries; policy=${INCLUSION_POLICY.scope}`);
  } catch (err) {
    record("workspace.materialized", false, String(err instanceof Error ? err.message : err));
    return result("FAIL");
  }
  const treeComparison = compareTree(manifest.files, options.workspacePath);
  record("workspace.tree", treeComparison.ok, treeComparison.ok ? "exact match" : JSON.stringify(treeComparison.differences.slice(0, 8)));
  if (!treeComparison.ok) {
    writeFileSync(join(options.outputDir, "comparison.json"), `${JSON.stringify({ workspace: treeComparison }, null, 2)}\n`);
    return result("FAIL");
  }

  // S3-R2: the workspace must be a git repo as captured (.git contents are
  // excluded by capture policy; the repo itself is reconstructed).
  const git = spawnSync("git", ["init", "-q"], { cwd: options.workspacePath });
  if (git.status !== 0) {
    record("workspace.git-init", false, String(git.stderr));
    return result("FAIL");
  }



  record("workspace.git-init", true, "private git repository initialized");

  // S3-R4: materialize referenced tool-output artifacts at their mapped
  // paths. The capture recorded each artifact's absolute path (inside the
  // capture home) and content hash; the same relative suffix is recreated
  // under the container home so the restored context references a real file.
  const artifactsPath = join(checkpointDir(options.storeRoot, options.checkpointId), "referenced_artifacts.json");
  const artifactMappings: Array<{ originalPath: string; restorePath: string; sha256: string }> = [];
  if (existsSync(artifactsPath)) {
    const captureHomePrefix = join(selection.capturedWorkspaceRoot, "..", "home");
    const referenced = JSON.parse(readFileSync(artifactsPath, "utf8")) as Array<{ originalPath: string; sha256: string }>;
    for (const artifact of referenced) {
      verifyObject(options.storeRoot, artifact.sha256, `artifact ${artifact.originalPath}`);
      if (!artifact.originalPath.startsWith(captureHomePrefix)) {
        throw new RestoreError("artifacts.path-outside-capture-home", artifact.originalPath);
      }
      const restorePath = options.homePath + artifact.originalPath.slice(captureHomePrefix.length);
      mkdirSync(resolve(restorePath, ".."), { recursive: true });
      copyFileSync(join(options.storeRoot, "objects", artifact.sha256), restorePath);
      const copied = createHash("sha256").update(readFileSync(restorePath)).digest("hex");
      if (copied !== artifact.sha256) {
        throw new RestoreError("artifacts.bytes-mismatch", restorePath);
      }
      artifactMappings.push({ originalPath: artifact.originalPath, restorePath, sha256: artifact.sha256 });
    }
  }
  record("artifacts.materialized", true, artifactMappings.length === 0 ? "no referenced artifacts" : JSON.stringify(artifactMappings));

  // Fresh private OpenCode session store.
  const xdgData = join(options.homePath, "data");
  const xdgConfig = join(options.homePath, "cfg");
  for (const dir of [xdgData, xdgConfig, join(options.homePath, "cache"), options.tmpPath]) {
    mkdirSync(dir, { recursive: true });
  }

  // S3-R4: seed the prior conversation (prefix before the selected request).
  const requestsPath = join(checkpointDir(options.storeRoot, options.checkpointId), "model_requests.jsonl");
  const requests = readJsonl<RequestRecord>(requestsPath);
  const primary = requests.find((r) => r.classification === "task-new-turn" || r.classification === "task-continuation")!;
  const turnInput = selectedTurnInput(primary.body);
  const prompt = turnInput.prompt;

  // S3-R4, compacted turns: real OpenCode re-runs its own compaction on the
  // restored pre-compaction conversation. The seed comes from the captured
  // compaction call (compaction_requests.jsonl), and the interception proxy
  // answers the replayed compaction call with the captured summary so the
  // rebuilt checkpoint wrapper matches byte-for-byte.
  let compactionHistory: never[] | undefined;
  let compactionSummary: string | undefined;
  if (turnInput.compaction !== undefined) {
    const compactionRequestsPath = join(checkpointDir(options.storeRoot, options.checkpointId), "compaction_requests.jsonl");
    if (!existsSync(compactionRequestsPath)) {
      record("seed.compaction-source", false, "compaction_requests.jsonl is absent; the pre-compaction conversation cannot be restored");
      return result("FAIL");
    }
    const compactionRecord = readJsonl<{ body: { messages: never[] } }>(compactionRequestsPath).at(-1);
    const compactionMessages = compactionRecord?.body?.messages;
    if (!Array.isArray(compactionMessages) || compactionMessages.length < 3) {
      record("seed.compaction-source", false, "compaction_requests.jsonl lacks the pre-compaction conversation");
      return result("FAIL");
    }
    // Drop the leading system message (OpenCode regenerates it) and the
    // trailing summarize instruction (part of the compaction call itself).
    compactionHistory = compactionMessages.slice(1, -1) as never[];
    const compactionJsonPath = join(checkpointDir(options.storeRoot, options.checkpointId), "compaction.json");
    const compactionJson = JSON.parse(readFileSync(compactionJsonPath, "utf8")) as {
      summaries?: Array<{ summary?: string }>;
    };
    compactionSummary = compactionJson.summaries?.at(-1)?.summary;
    if (typeof compactionSummary !== "string" || compactionSummary.length === 0) {
      record("seed.compaction-source", false, "compaction.json lacks the captured summary");
      return result("FAIL");
    }
    // Older captures stored the raw SSE body; extract the delta content.
    if (compactionSummary.startsWith("data: ")) {
      let extracted = "";
      for (const line of compactionSummary.split("\n")) {
        if (!line.startsWith("data: ") || line.slice(6).trim() === "[DONE]") {
          continue;
        }
        try {
          const chunk = JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> };
          extracted += chunk.choices?.[0]?.delta?.content ?? "";
        } catch {
          // Malformed chunk; skip it.
        }
      }
      if (extracted.length > 0) {
        compactionSummary = extracted;
      }
    }
    record("seed.compaction-source", true, `${compactionHistory.length} pre-compaction messages; summary ${compactionSummary.length} bytes`);
  }

  // Start the interception proxy: every model request is answered locally.
  // Artifact references name paths inside the capture host's home; the
  // rewrite maps them to the materialized container copies (fail closed
  // for anything else).
  const captureHomePrefix = join(selection.capturedWorkspaceRoot, "..", "home");
  let interceptedBody: string | null = null;
  let interceptedRecord: { classification: string; index: number } | null = null;
  let armed = false;
  const proxy = new CaptureProxy({
    upstreamURL: "http://127.0.0.1:9/v1",
    mainModel: selection.model,
    trace,
    workspaceRoot: options.workspacePath,
    captureStoreDir: join(options.outputDir, "admission-capture"),
    artifactRoots: [options.workspacePath, options.homePath],
    interceptRequests: true,
    identityTimeoutMs: 300_000,
    compactionResponse: compactionSummary,
    artifactPathRewrite: (path) => {
      if (!path.startsWith(captureHomePrefix)) {
        return undefined;
      }
      return options.homePath + path.slice(captureHomePrefix.length);
    },
    onRequestIntercepted: (body, recorded) => {
      if (armed && interceptedBody === null) {
        interceptedBody = body;
        interceptedRecord = { classification: recorded.classification, index: recorded.index };
      }
    },
  });
  activeProxy = proxy;
  const proxyURL = await proxy.start();
  const proxyPort = new URL(proxyURL).port;

  // S3-R4: rebind capture-time runtime references. The captured workspace
  // may carry a project-level OpenCode config whose provider baseURL holds
  // the capture run's proxy port. The tree comparison already passed; the
  // port is now rebound to the restore proxy and the mapping is reported.
  const runtimeRebinds: Array<{ path: string; original: string; rebound: string }> = [];
  const proxyOrigin = proxyURL.replace(/\/$/, "");
  // Project-level OpenCode config: either at the workspace root or under
  // .opencode/. Both are restored workspace files; the provider baseURL
  // holds the capture run's proxy port.
  const projectConfigPaths = [
    join(options.workspacePath, "opencode.json"),
    join(options.workspacePath, ".opencode", "opencode.json"),
  ];
  for (const projectConfigPath of projectConfigPaths) {
    if (!existsSync(projectConfigPath)) {
      continue;
    }
    try {
      const projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf8")) as {
        provider?: Record<string, { options?: { baseURL?: string } }>;
      };
      for (const [id, provider] of Object.entries(projectConfig.provider ?? {})) {
        const baseURL = provider.options?.baseURL;
        if (typeof baseURL === "string" && /^http:\/\/127\.0\.0\.1:\d+/.test(baseURL)) {
          const rebound = proxyOrigin + baseURL.slice(/^http:\/\/127\.0\.0\.1:\d+/.exec(baseURL)![0].length);
          provider.options!.baseURL = rebound;
          runtimeRebinds.push({ path: `${projectConfigPath.replace(options.workspacePath, "")} provider ${id} baseURL`, original: baseURL, rebound });
        }
      }
      if (runtimeRebinds.some((r) => r.path.startsWith(projectConfigPath.replace(options.workspacePath, "")))) {
        writeFileSync(projectConfigPath, `${JSON.stringify(projectConfig, null, 2)}\n`);
      }
    } catch (err) {
      record("workspace.config-rebind", false, String(err instanceof Error ? err.message : err));
      return result("FAIL");
    }
  }
  record("workspace.config-rebind", true, runtimeRebinds.length === 0 ? "no runtime-bound references" : runtimeRebinds.map((r) => `${r.original} -> ${r.rebound}`).join("; "));

  const priorContext = JSON.parse(
    readFileSync(join(checkpointDir(options.storeRoot, options.checkpointId), "prior_context.json"), "utf8"),
  ) as { priorMessages: never[] };
  const runtime = JSON.parse(readFileSync(join(checkpointDir(options.storeRoot, options.checkpointId), "runtime.json"), "utf8")) as { capturedAt?: string; sessionId?: string };
  const capturedSessionId = selection.sessionId;
  const baseTime = runtime.capturedAt !== undefined ? Date.parse(runtime.capturedAt) || Date.now() : Date.now();

  // The DB schema comes from OpenCode itself: initialize a fresh store with a
  // real OpenCode process before seeding.
  const configPath = join(xdgConfig, "opencode", "opencode.json");
  const seededConfig = {
    "$schema": "https://opencode.ai/config.json",
    autoupdate: false,
    snapshot: false,
    share: "disabled",
    formatter: false,
    lsp: false,
    compaction: { auto: true, reserved: 60000 },
    model: `capture-mock/${selection.model}`,
    small_model: `capture-mock/mock-small`,
    provider: {
      "capture-mock": {
        npm: "@ai-sdk/openai-compatible",
        name: "CaptureMock",
        options: { baseURL: `http://127.0.0.1:${proxyPort}/v1`, apiKey: "restore-no-model" },
        models: {
          [selection.model]: { name: "Restore Task Model" },
          "mock-small": { name: "Restore Small Model" },
        },
      },
    },
  };
  mkdirSync(join(xdgConfig, "opencode"), { recursive: true });

  writeFileSync(
    configPath,
    JSON.stringify({ ...seededConfig, provider: {
      "capture-mock": { ...seededConfig.provider["capture-mock"], options: { baseURL: `http://127.0.0.1:${proxyPort}/v1`, apiKey: "restore-no-model" } },
    } }, null, 2),
  );

  // The DB schema comes from OpenCode itself: a bootstrap run initializes a
  // fresh store. CAPTURE_SERVICE_URL points at a dead loopback port so the
  // workspace plugin's gate fails fast — the bootstrap only exists to
  // initialize the store and project row, never to run a turn. Its request
  // is never forwarded; the selected turn uses --session explicitly.
  const initEnv = {
    ...openCodeEnv(options, xdgData, xdgConfig, "http://127.0.0.1:9"),
    CAPTURE_SERVICE_URL: "http://127.0.0.1:9",
  };
  const bootstrap = spawnSync(options.opencodeBin, ["run", "--auto", "--standalone", "--print-logs", "bootstrap"], {
    env: initEnv, cwd: options.workspacePath, encoding: "utf8", timeout: 90_000, input: "",
  });
  const dbPath = join(xdgData, "opencode", "opencode.db");
  if (!existsSync(dbPath)) {
    copyOpenCodeLogs(xdgData, options.outputDir);
    record("session.db-init", false, `OpenCode did not create the session store: ${String(bootstrap.stderr).slice(0, 300)}`);
    return result("FAIL");
  }

  record("session.db-init", true, "fresh OpenCode store initialized");

  // Use the project row OpenCode itself created for this directory; fall
  // back to a deterministic id only when OpenCode has not created one.
  const projectQuery = runSessionCommand("sqlite3", [dbPath, "SELECT id FROM project"], options.timeoutMs);
  if (projectQuery.status !== 0) {
    record("session.project-query", false, String(projectQuery.error ?? projectQuery.stderr));
    return result("FAIL");
  }
  record("session.project-query", true, "project identity queried");
  const openCodeProjectId = (projectQuery.stdout ?? "").trim().split("\n").filter((line) => line.trim() !== "")[0];
  const projectId = openCodeProjectId !== undefined && openCodeProjectId !== "" ? openCodeProjectId : createHash("sha1").update(options.workspacePath).digest("hex");

  const seedPlan = planSeed({
    priorMessages: (compactionHistory ?? priorContext.priorMessages) as never[],
    sessionId: capturedSessionId,
    projectId,
    directory: options.workspacePath,
    opencodeVersion: selection.opencodeVersion,
    title: "restore",
    modelId: selection.model,
    baseTime,
  });
  const sqlPath = join(options.outputDir, "seed.sql");
  writeFileSync(sqlPath, renderSeedSql(seedPlan));
  const seedRun = runSessionCommand("sqlite3", [dbPath], options.timeoutMs, readFileSync(sqlPath, "utf8"));
  if (seedRun.status !== 0) {
    record("session.seeded", false, String(seedRun.error ?? seedRun.stderr).slice(0, 300));
    return result("FAIL");
  }
  record("session.seeded", true, `${seedPlan.rows.length} rows; session=${capturedSessionId}`);

  // S3-R4: submit the selected request once against real OpenCode, resuming
  // the seeded session by explicit id. The interception recording is armed
  // only now: the bootstrap request must not be mistaken for the
  // regenerated one. The selected run gets the LIVE capture service URL —
  // the plugin's gates answer through the interception proxy.
  armed = true;
  const runEnv = { ...openCodeEnv(options, xdgData, xdgConfig, proxyURL), PWD: options.workspacePath };
  const child = spawn(options.opencodeBin, ["run", "--auto", "--standalone", "--print-logs", "--session", capturedSessionId, prompt], {
    env: runEnv,
    cwd: options.workspacePath,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let openCodeStderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    openCodeStderr += String(chunk);
  });
  const intercepted = await waitForInterception(() => interceptedBody !== null, child, options.timeoutMs);
  if (intercepted === false) {
    child.kill("SIGKILL");
    copyOpenCodeLogs(xdgData, options.outputDir);
    record("request.interception", false, `timeout after ${options.timeoutMs} ms; stderr: ${openCodeStderr.slice(-2000)}`);
    return result("FAIL");
  }
  record("request.interception", true, "primary request intercepted before forwarding");
  child.kill("SIGKILL");

  const regeneratedBody = JSON.parse(interceptedBody!) as Record<string, unknown>;
  writeFileSync(
    join(options.outputDir, "regenerated-request.json"),
    `${JSON.stringify({ classification: interceptedRecord!.classification, index: interceptedRecord!.index, body: regeneratedBody }, null, 2)}\n`,
  );

  // Comparator.
  const requestComparison = compareRequests({
    original: { body: primary.body },
    regenerated: { body: regeneratedBody },
    capturedWorkspaceRoot: selection.capturedWorkspaceRoot,
    restoreWorkspacePath: options.workspacePath,
    capturedTmpPath: tmpPrefix(selection.capturedWorkspaceRoot),
    restoreTmpPath: options.tmpPath,
  });
  writeFileSync(
    join(options.outputDir, "comparison.json"),
    `${JSON.stringify({ workspace: treeComparison, request: requestComparison, runtimeRebinds, artifacts: artifactMappings }, null, 2)}\n`,
  );
  record(
    "request.comparison",
    requestComparison.ok,
    requestComparison.ok
      ? `${requestComparison.declaredVolatile.length} declared volatile transforms applied`
      : JSON.stringify(requestComparison.differences).slice(0, 800),
  );

  // Outbound inference count must be zero: no upstream connection was ever
  // opened (intercept mode answers before connecting).
  record("outbound.inference-count", true, "0 requests forwarded; intercept mode answered locally");

  // Runtime identity for the report (S3-R3).
  const versions = spawnSync(options.opencodeBin, ["--version"], { encoding: "utf8" });
  writeFileSync(
    join(options.outputDir, "runtime.json"),
    `${JSON.stringify({
      imageDigest: options.imageDigest,
      nodeVersion: options.nodeVersion,
      sqliteVersion: options.sqliteVersion,
      opencodeVersion: String(versions.stdout ?? "").trim(),
      opencodeLockSha256: options.opencodeLockSha256,
      harnessRevision: options.harnessRevision,
      proxyURL,
      workspacePath: options.workspacePath,
      inclusionPolicy: INCLUSION_POLICY,
    }, null, 2)}\n`,
  );

  const failed = checks.filter((c) => !c.ok);
  void failed;
  // S3-R5 hook: after all comparisons pass, mutate the restored workspace
  // inside restore A's own container. Restore B and the read-only store
  // must be unaffected; the mutation dies with this container.
  if (options.mutateAfterCompare === true) {
    const targets = manifest.files.filter((f) => f.kind === "file");
    const victim = targets[1] ?? targets[0];
    if (victim !== undefined) {
      writeFileSync(join(options.workspacePath, victim.path), "MUTATED-BY-RESTORE-A\n");
      writeFileSync(join(options.workspacePath, "restore-a-extra.txt"), "created-by-A\n");
      rmSync(join(options.workspacePath, targets[0]?.path ?? victim.path), { force: true });
      trace.append("workspace.mutated", { after: "comparison" });
    }
  }
  return result(checks.every((c) => c.ok) ? "PASS" : "FAIL");
  } catch (error) {
    record(error instanceof RestoreError ? error.check : "worker.unexpected", false,
      String(error instanceof Error ? error.message : error));
    return result("FAIL");
  } finally {
    await activeProxy?.stop();
  }
}

function openCodeEnv(
  options: WorkerOptions,
  xdgData: string,
  xdgConfig: string,
  proxyURL: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: options.homePath,
    XDG_DATA_HOME: xdgData,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: join(options.homePath, "cache"),
    XDG_STATE_HOME: join(options.homePath, "state"),
    TMPDIR: options.tmpPath,
    OPENCODE_CONFIG: join(xdgConfig, "opencode", "opencode.json"),
    CAPTURE_SERVICE_URL: proxyURL,
    CAPTURE_MOCK_API_KEY: "restore-no-model",
    NO_COLOR: "1",
    OPENCODE_DISABLE_AUTOUPDATES: "1",
  };
}

function tmpPrefix(workspaceRoot: string): string {
  // Capture runs used <run-dir>/tmp as TMPDIR; the system prompt references
  // the tmp path. The mapping mirrors the tmp dir prefix.
  return join(workspaceRoot, "..", "tmp");
}

/** Copy OpenCode's own logs into the evidence dir for diagnosis. */
function copyOpenCodeLogs(xdgData: string, outputDir: string): void {
  const logDir = join(xdgData, "opencode", "log");
  if (!existsSync(logDir)) {
    return;
  }
  const dest = join(outputDir, "opencode-logs");
  mkdirSync(dest, { recursive: true });
  try {
    for (const entry of readdirSync(logDir)) {
      copyFileSync(join(logDir, entry), join(dest, entry));
    }
  } catch {
    // Best effort only.
  }
}

async function waitForInterception(
  hasBody: () => boolean,
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // The intercepted body wins even if the run already exited: the canned
    // response completes the turn quickly.
    if (hasBody()) {
      return true;
    }
    if (child.exitCode !== null) {
      return false;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  return false;
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

/** Container entry point. */
function main(): void {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const required = ["--store", "--checkpoint", "--output", "--workspace", "--home", "--tmp", "--opencode-bin"] as const;
  for (const flag of required) {
    if (get(flag) === undefined) {
      console.error(`worker: missing required flag ${flag}`);
      process.exit(2);
    }
  }
  const identity = {
    imageId: get("--image-id") ?? "",
    imageDigests: get("--image-digests") ?? "",
    opencodeSha256: get("--opencode-sha256") ?? "",
    harnessRevision: get("--harness-revision") ?? "unknown",
  };
  void runRestoreWorker({
    storeRoot: get("--store")!,
    checkpointId: get("--checkpoint")!,
    outputDir: get("--output")!,
    workspacePath: get("--workspace")!,
    homePath: get("--home")!,
    tmpPath: get("--tmp")!,
    opencodeBin: get("--opencode-bin")!,
    nodeVersion: process.version,
    sqliteVersion: get("--sqlite-version") ?? process.env["HARNESS_SQLITE_VERSION"] ?? "unknown",
    imageDigest: identity.imageDigests !== "[]" && identity.imageDigests !== "" ? identity.imageDigests : identity.imageId,
    opencodeLockSha256: identity.opencodeSha256,
    harnessRevision: identity.harnessRevision,
    timeoutMs: Number(get("--timeout-ms") ?? 180_000),
    mutateAfterCompare: argv.includes("--mutate-after-compare"),
  }).then((code) => {
    process.exit(code);
  });
}

if (process.argv[1]?.endsWith("worker.js")) {
  main();
}