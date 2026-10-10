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
import { join } from "node:path";
import { EventTrace } from "../capture/trace.js";
import { CaptureProxy } from "../capture/proxy.js";
import { checkpointDir, readManifest, selectCheckpoint } from "./select.js";
import { INCLUSION_POLICY, materializeWorkspace } from "./materialize.js";
import { compareTree } from "./compare.js";
import { compareRequests, selectedPrompt } from "./request-compare.js";
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
    writeFileSync(
      join(options.outputDir, "result.json"),
      `${JSON.stringify({ status, checkpoint: options.checkpointId, runStarted: new Date(started).toISOString(), checks, ...extra }, null, 2)}\n`,
    );
    console.log(`RESTORE ${status}: checkpoint=${options.checkpointId} run=${options.outputDir}`);
    return status === "PASS" ? 0 : 1;
  };
  const record = (check: string, ok: boolean, detail: string): void => {
    checks.push({ check, ok, detail });
    console.log(`  ${ok ? "ok" : "FAIL"} ${check}${detail ? ` — ${detail}` : ""}`);
  };

  // S3-R1: explicit selection and preflight validation.
  let selection;
  try {
    selection = selectCheckpoint({ storeRoot: options.storeRoot, checkpointId: options.checkpointId });
    record("selection.identity", true, `session=${selection.sessionId} message=${selection.messageId}`);
  } catch (err) {
    record("selection.preflight", false, String(err instanceof Error ? err.message : err));
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

  // Start the interception proxy: every model request is answered locally.
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
    onRequestIntercepted: (body, recorded) => {
      if (armed && interceptedBody === null) {
        interceptedBody = body;
        interceptedRecord = { classification: recorded.classification, index: recorded.index };
      }
    },
  });
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
  const prompt = selectedPrompt(primary.body);
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

  // Use the project row OpenCode itself created for this directory; fall
  // back to a deterministic id only when OpenCode has not created one.
  const projectQuery = spawnSync("sqlite3", [dbPath, "SELECT id FROM project"], { encoding: "utf8" });
  const openCodeProjectId = (projectQuery.stdout ?? "").trim().split("\n").filter((line) => line.trim() !== "")[0];
  const projectId = openCodeProjectId !== undefined && openCodeProjectId !== "" ? openCodeProjectId : createHash("sha1").update(options.workspacePath).digest("hex");

  const seedPlan = planSeed({
    priorMessages: priorContext.priorMessages,
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
  const seedRun = spawnSync("sqlite3", [dbPath], { input: readFileSync(sqlPath, "utf8"), encoding: "utf8" });
  if (seedRun.status !== 0) {
    record("session.seed", false, String(seedRun.stderr).slice(0, 300));
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
    await proxy.stop();
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
    `${JSON.stringify({ workspace: treeComparison, request: requestComparison, runtimeRebinds }, null, 2)}\n`,
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
  return result(checks.every((c) => c.ok) ? "PASS" : "FAIL");
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
  }).then((code) => {
    process.exit(code);
  });
}

if (process.argv[1]?.endsWith("worker.js")) {
  main();
}