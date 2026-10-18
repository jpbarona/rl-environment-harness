/**
 * In-container session seeding for the Harbor solver (S5-R4).
 *
 * Runs INSIDE the solver container via node. Reuses the Step 3 restore
 * logic verbatim (select/context-seed/session-command): bootstraps a fresh
 * OpenCode session store, seeds the captured conversation prefix, seeds the
 * per-session sequence counter, and materializes referenced tool-output
 * artifacts at their mapped paths. The captured prompt is then submitted by
 * the Harbor agent with `opencode run --session <id>`.
 *
 * Zero inference happens here: the bootstrap run points at a dead loopback
 * provider so it only initializes the store.
 */
import { existsSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { checkpointDir, readManifest, selectCheckpoint, verifyObject } from "../restore/select.js";
import { planSeed, renderSeedSql } from "../restore/context-seed.js";
import { RestoreError } from "../restore/select.js";

interface Selected {
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly prompt: string;
  readonly model: string;
  readonly opencodeVersion: string;
  readonly capturedWorkspaceRoot: string;
}

interface RequestRecord {
  readonly index: number;
  readonly classification: string;
  readonly body: Record<string, unknown>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

export function seedSession(options: {
  readonly workspace: string;
  readonly captureDir: string;
  readonly checkpointId: string;
  readonly home: string;
  readonly opencodeBin: string;
  readonly timeoutMs: number;
}): void {
  const { workspace, captureDir, checkpointId, home, opencodeBin, timeoutMs } = options;
  const selection: Selected = readJson(join(captureDir, "selected.json"));

  // 1. Fresh isolated OpenCode home + config with a dead provider.
  const xdgData = join(home, "data");
  const xdgConfig = join(home, "cfg");
  for (const dir of [xdgData, xdgConfig, join(home, "cache"), join(home, "state"), join(home, "tmp")]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  const configPath = join(xdgConfig, "opencode", "opencode.json");
  mkdirSync(join(xdgConfig, "opencode"), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    snapshot: false,
    share: "disabled",
    formatter: false,
    lsp: false,
    model: `seed-dead/${selection.model}`,
    small_model: "seed-dead/seed-small",
    provider: {
      "seed-dead": {
        npm: "@ai-sdk/openai-compatible",
        name: "SeedDead",
        options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "seed-no-model" },
        models: { [selection.model]: { name: "Seed" }, "seed-small": { name: "SeedSmall" } },
      },
    },
  }, null, 2)}\n`);

  // 2. Bootstrap run initializes the store and the project row. The plugin
  // gate (if any) points at a dead port and fails fast; this run is never
  // compared or forwarded.
  const bootstrap = spawnSync(opencodeBin, ["run", "--auto", "--standalone", "--print-logs", "bootstrap"], {
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: xdgData,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_STATE_HOME: join(home, "state"),
      TMPDIR: join(home, "tmp"),
      OPENCODE_CONFIG: configPath,
      CAPTURE_SERVICE_URL: "http://127.0.0.1:9",
      PWD: workspace,
    },
    cwd: workspace,
    encoding: "utf8",
    timeout: timeoutMs,
    input: "",
  });
  const dbPath = join(xdgData, "opencode", "opencode.db");
  if (!existsSync(dbPath)) {
    throw new Error(`bootstrap run did not create the session store (exit ${bootstrap.status}): ${String(bootstrap.stderr).slice(0, 300)}`);
  }

  // 3. Project identity comes from OpenCode itself.
  const projectQuery = spawnSync("sqlite3", [dbPath, "SELECT id FROM project"], { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" });
  if (projectQuery.status !== 0) {
    throw new Error(`project query failed: ${String(projectQuery.stderr).slice(0, 200)}`);
  }
  const projectId = (projectQuery.stdout ?? "").trim().split("\n").filter((l) => l.trim() !== "")[0];
  if (projectId === undefined || projectId === "") {
    throw new Error("the bootstrap run created no project row");
  }

  // 4. Seed the captured conversation prefix (Step 3 logic verbatim).
  selectCheckpoint({ storeRoot: captureDir, checkpointId });
  const manifest = readManifest(captureDir, checkpointId);
  const recordsDir = checkpointDir(captureDir, checkpointId);
  const runtime = readJson<{ sessionId?: string; capturedAt?: string; messageId?: string }>(join(recordsDir, "runtime.json"));
  if (runtime.sessionId !== selection.sessionId) {
    throw new RestoreError("seed.identity-conflict", "selected.json conflicts with the stored runtime identity");
  }
  const requests = readJsonl<RequestRecord>(join(recordsDir, "model_requests.jsonl"));
  const primary = requests.find((r) => r.classification === "task-new-turn" || r.classification === "task-continuation");
  if (primary === undefined) {
    throw new RestoreError("seed.primary-missing", "the capture records hold no primary task request");
  }

  // 5. Referenced tool-output artifacts: materialized at the mapped paths
  // (capture home prefix -> container home), hash-verified after the copy.
  const captureHomePrefix = join(manifest.root, "..", "home");
  const artifactsPath = join(recordsDir, "referenced_artifacts.json");
  if (existsSync(artifactsPath)) {
    for (const artifact of readJson<Array<{ originalPath: string; sha256: string }>>(artifactsPath)) {
      verifyObject(captureDir, artifact.sha256, `artifact ${artifact.originalPath}`);
      if (!artifact.originalPath.startsWith(captureHomePrefix)) {
        throw new RestoreError("seed.artifact-outside-capture-home", artifact.originalPath);
      }
      const restorePath = home + artifact.originalPath.slice(captureHomePrefix.length);
      mkdirSync(resolve(restorePath, ".."), { recursive: true });
      copyFileSync(join(captureDir, "objects", artifact.sha256), restorePath);
      const copied = createHash("sha256").update(readFileSync(restorePath)).digest("hex");
      if (copied !== artifact.sha256) {
        throw new RestoreError("seed.artifact-bytes-mismatch", restorePath);
      }
    }
  }

  // 6. Compacted captures seed from the captured compaction call.
  let priorMessages: unknown[];
  let compactionSummary: string | undefined;
  const priorContext = readJson<{ priorMessages: unknown[] }>(join(recordsDir, "prior_context.json"));
  const primaryBody = primary.body as { messages?: Array<{ role: string; content?: unknown }> };
  const lastUser = [...(primaryBody.messages ?? [])].reverse().find((m) => m.role === "user");
  const isCompactionWrapper = typeof lastUser?.content === "string" && lastUser.content.includes("<conversation-checkpoint>");
  if (isCompactionWrapper) {
    const compactionRequestsPath = join(recordsDir, "compaction_requests.jsonl");
    if (!existsSync(compactionRequestsPath)) {
      throw new RestoreError("seed.compaction-source", "compaction_requests.jsonl is absent");
    }
    const compactionRecord = readJsonl<{ body: { messages: unknown[] } }>(compactionRequestsPath).at(-1);
    const compactionMessages = compactionRecord?.body?.messages;
    if (!Array.isArray(compactionMessages) || compactionMessages.length < 3) {
      throw new RestoreError("seed.compaction-source", "compaction_requests.jsonl lacks the pre-compaction conversation");
    }
    priorMessages = compactionMessages.slice(1, -1);
    const compactionJson = readJson<{ summaries?: Array<{ summary?: string }> }>(join(recordsDir, "compaction.json"));
    compactionSummary = compactionJson.summaries?.at(-1)?.summary;
    if (typeof compactionSummary !== "string" || compactionSummary.length === 0) {
      throw new RestoreError("seed.compaction-source", "compaction.json lacks the captured summary");
    }
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
  } else {
    priorMessages = priorContext.priorMessages;
  }

  const baseTime = runtime.capturedAt !== undefined ? Date.parse(runtime.capturedAt) || Date.now() : Date.now();
  const seedPlan = planSeed({
    priorMessages: priorMessages as never[],
    sessionId: selection.sessionId,
    projectId,
    directory: workspace,
    opencodeVersion: selection.opencodeVersion,
    title: "replay",
    modelId: selection.model,
    baseTime,
  });
  const sqlPath = join(home, "tmp", "seed.sql");
  writeFileSync(sqlPath, renderSeedSql(seedPlan));
  const seedRun = spawnSync("sqlite3", [dbPath], { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", input: readFileSync(sqlPath, "utf8") });
  if (seedRun.status !== 0) {
    throw new Error(`seed import failed: ${String(seedRun.stderr).slice(0, 300)}`);
  }
  process.stdout.write(`seeded session=${selection.sessionId} rows=${seedPlan.rows.length}\n`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const workspace = get("--workspace");
  const captureDir = get("--capture");
  const checkpointId = get("--checkpoint");
  const home = get("--home");
  const opencodeBin = get("--opencode-bin") ?? "/usr/local/opencode/opencode";
  const timeoutMs = Number(get("--timeout-ms") ?? 90_000);
  if (workspace === undefined || captureDir === undefined || checkpointId === undefined || home === undefined) {
    console.error("usage: seed.js --workspace <dir> --capture <dir> --checkpoint <id> --home <dir> [--opencode-bin <path>] [--timeout-ms <ms>]");
    process.exit(2);
  }
  try {
    seedSession({ workspace, captureDir, checkpointId, home, opencodeBin, timeoutMs });
  } catch (err) {
    console.error(`seed failed: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith("seed.js")) {
  main();
}
