/**
 * Background checkpoint pipeline (S5-R2..S5-R8).
 *
 * Runs detached from the OpenCode session: writer -> task build ->
 * image builds + known good/bad verifier validation -> native Harbor run
 * with the replayed captured attempt -> independent quality review ->
 * atomic publication. Every transition is persisted to status.json so a
 * crash is reported, never silent. The aggregate model-spend cap covers
 * writer, reviewer, judge and retries.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type SystemConfig } from "./config.js";
import { appendJobLog, jobDir, markFailed, readStatus, writeStatus, type JobRecord, type JobStatus } from "./job.js";
import { runWriter, type WriterOutput } from "./writer.js";
import { runReviewer, type ReviewResult } from "./reviewer.js";
import { buildHarborTask } from "./harbor-task.js";
import { SpendTracker, LlmError } from "./llm.js";
import { readJsonl } from "./jsonl.js";

interface HarborTrialResult {
  readonly verifier_result?: { readonly rewards?: Record<string, number> } | null;
  readonly agent_result?: { readonly cost_usd?: number | null } | null;
}

/** Credential-shaped material that must never appear in a published task. */
const CREDENTIAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, "private key block"],
  [/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}\b/, "sk-style API token"],
  [/\bBearer [A-Za-z0-9._~+/=-]{16,}/, "Bearer token"],
];

function repoRoot(): string {
  // dist/checkpoint/runner.js and src/checkpoint/runner.ts both resolve here.
  return join(fileURLToPath(new URL("../../", import.meta.url)));
}

function harborBin(): string {
  const venvHarbor = join(repoRoot(), "work", "harbor-venv", "bin", "harbor");
  return existsSync(venvHarbor) ? venvHarbor : "harbor";
}

const DOCKER = "/usr/local/bin/docker";
const HOST_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function runDocker(args: readonly string[], timeoutMs: number): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(DOCKER, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export async function runPipeline(jobId: string, configPath?: string): Promise<void> {
  const config = loadConfig(configPath);
  const jobsRoot = config.jobsDir;
  const dir = jobDir(jobsRoot, jobId);
  const record = JSON.parse(readFileSync(join(dir, "job.json"), "utf8")) as JobRecord;
  let status: JobStatus | undefined = readStatus(jobsRoot, jobId);
  if (status === undefined) {
    throw new Error(`job ${jobId} has no status record`);
  }
  const log = (line: string): void => appendJobLog(jobsRoot, jobId, line);
  const update = (patch: Partial<JobStatus>): void => {
    status = { ...status!, ...patch };
    writeStatus(jobsRoot, status!);
  };
  const fail = (check: string, detail: string): void => {
    log(`FAILED ${check}: ${detail}`);
    markFailed(jobsRoot, status!, check, detail);
  };
  const step = (name: JobStatus["step"], detail: string): void => {
    update({ state: "RUNNING", step: name, detail, runnerPid: process.pid });
    log(`step ${name}: ${detail}`);
  };

  const spend = new SpendTracker(config.modelSpendCapUSD);
  try {
    // --- Writer (S5-R3). ---
    step("writer", "generating task definition from the frozen capture");
    const recordsDir = join(config.storePath, "checkpoints", record.checkpointId);
    const requests = readJsonl<{ index: number; classification: string; body: { messages?: Array<{ role: string; content?: unknown }> } }>(join(recordsDir, "model_requests.jsonl"));
    const primary = requests.find((r) => r.classification === "task-new-turn" || r.classification === "task-continuation");
    if (primary === undefined) {
      return fail("writer.input", "the frozen checkpoint holds no primary task request");
    }
    const messages = primary.body.messages ?? [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const selectedPrompt = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
    const manifest = JSON.parse(readFileSync(join(recordsDir, "manifest.json"), "utf8")) as { files: Array<{ path: string; kind: string; sha256?: string; size?: number }> };
    const priorContext = JSON.parse(readFileSync(join(recordsDir, "prior_context.json"), "utf8")) as { priorMessages: Array<{ role: string; content: unknown }> };
    const priorExcerpt = priorContext.priorMessages
      .slice(-6)
      .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 400) : "[structured content]"}`)
      .join("\n");
    const attemptExcerpt = messages
      .slice(-3)
      .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 400) : "[structured content]"}`)
      .join("\n");
    const writerInput = {
      description: record.description,
      selectedPrompt: selectedPrompt.slice(0, 4000),
      priorContextExcerpt: priorExcerpt.slice(0, 4000),
      workspaceFiles: workspaceExcerpts(config.storePath, manifest),
      attemptExcerpt: attemptExcerpt.slice(0, 2000),
      judgeModelPlaceholder: "JUDGE_MODEL_PLACEHOLDER",
    };
    const solverTag = `rl-task-${record.taskId}-solver`;
    const verifierTag = `rl-task-${record.taskId}-verifier`;

    // Writer + build + criteria smoke, with the validation error fed back to
    // the writer on retry (bounded). Real models invent unsupported API calls;
    // the smoke catches them before any fixture or Harbor spend.
    let writer: WriterOutput | undefined;
    let built: ReturnType<typeof buildHarborTask> | undefined;
    let verifierId = "";
    let previousError: string | undefined;
    const writerAttempts = 1 + config.retries.writer;
    for (let attempt = 1; attempt <= writerAttempts; attempt += 1) {
      step("writer", attempt === 1 ? "generating task definition from the frozen capture" : `retrying the writer with the previous validation error`);
      writer = await runWriter(
        config.writer,
        { ...writerInput, ...(previousError !== undefined ? { previousError } : {}) },
        spend,
        { timeoutMs: config.timeouts.writerMs, retries: 0 },
      );
      step("build", "assembling the Harbor task from the frozen capture");
      built = buildHarborTask({ config, jobDir: dir, checkpointId: record.checkpointId, writer, repoRoot: repoRoot() });
      update({ detail: `task assembled; ${built.mutations.length} recorded runtime rebinds` });
      step("build", "building the verifier image");
      const verifierBuild = runDocker(["build", "--platform", "linux/arm64", "-t", verifierTag, join(built.taskDir, "tests")], 900_000);
      if (verifierBuild.status !== 0) {
        return fail("build.image", `${verifierTag}: docker build failed: ${verifierBuild.stderr.slice(-400)}`);
      }
      verifierId = runDocker(["image", "inspect", "--format", "{{.Id}}", verifierTag], 30_000).stdout.trim();
      step("validate", "criteria smoke test (empty workspace)");
      const smoke = runDocker([
        "run", "--rm", "--platform", "linux/arm64",
        "-v", `${join(built.taskDir, "tests")}:/tests:ro`,
        verifierTag,
        "bash", "-c", "mkdir -p /tmp/ws /tmp/out && rewardkit /tests --workspace /tmp/ws --output /tmp/out/reward.json >/dev/null 2>/tmp/smoke-err.txt; cat /tmp/smoke-err.txt >&2; test -s /tmp/out/reward.json",
      ], 300_000);
      if (smoke.status === 0) {
        break;
      }
      previousError = (smoke.stderr || smoke.stdout).slice(-800);
      if (attempt === writerAttempts) {
        return fail("validate.criteria", `the generated criteria never ran cleanly: ${previousError.slice(0, 300)}`);
      }
      log(`criteria smoke failed; retrying the writer: ${previousError.slice(0, 200)}`);
    }
    if (writer === undefined || built === undefined) {
      return fail("writer.internal", "the writer loop produced no output");
    }

    // --- Image builds (S5-R5): immutable local identities. ---
    step("build", "building the solver image");
    const solverBuild = runDocker(["build", "--platform", "linux/arm64", "-t", solverTag, join(built.taskDir, "environment")], 900_000);
    if (solverBuild.status !== 0) {
      return fail("build.image", `${solverTag}: docker build failed: ${solverBuild.stderr.slice(-400)}`);
    }
    const solverId = runDocker(["image", "inspect", "--format", "{{.Id}}", solverTag], 30_000).stdout.trim();
    if (solverId === "" || verifierId === "") {
      return fail("build.image", "built images could not be inspected for immutable ids");
    }
    writeFileSync(join(built.taskDir, "images.lock.json"), `${JSON.stringify({
      lockedAt: new Date().toISOString(),
      solver: { tag: solverTag, imageId: solverId },
      verifier: { tag: verifierTag, imageId: verifierId },
      note: "Local image ids locked at validation time; tags are convenience names. Registry digests are recorded when a task is published to a registry (later step).",
    }, null, 2)}\n`);
    // Prebuilt images: point task.toml at the locked identities (solver env
    // and separate verifier env each get their own image reference).
    const tomlPath = join(built.taskDir, "task.toml");
    writeFileSync(
      tomlPath,
      readFileSync(tomlPath, "utf8")
        .replace("# VERIFIER_DOCKER_IMAGE_PLACEHOLDER", `docker_image = "${verifierTag}"`)
        .replace("# SOLVER_DOCKER_IMAGE_PLACEHOLDER", `docker_image = "${solverTag}"`),
    );

    // Pin verification (S5-R5): the tags in task.toml must still resolve to
    // the exact locked ids at execution time; a retag fails the job.
    for (const [label, tag, lockedId] of [
      ["solver", solverTag, solverId],
      ["verifier", verifierTag, verifierId],
    ] as const) {
      const currentId = runDocker(["image", "inspect", "--format", "{{.Id}}", tag], 30_000).stdout.trim();
      if (currentId !== lockedId) {
        return fail("image.retag-detected", `${label} image ${tag} now resolves to ${currentId || "nothing"}; the locked id was ${lockedId}`);
      }
    }

    // Judge-call cap admission (S5-R7): the judge runs inside RewardKit and
    // is invisible to the call-level tracker, so its bounded cost is admitted
    // up front from an explicit estimate, a provider price lookup, or a
    // verified zero price. Unaccountable judge pricing fails before any spend.
    const judgeBasis = await judgeCostBasis(config);
    if (judgeBasis === null) {
      return fail("spend.judge-unaccountable", `the judge model ${config.judgeModel} has no verifiable pricing and no judgeCostEstimateUSDPerCall override; the cap cannot be respected`);
    }
    const judgeCalls = writer.judgeToml !== null ? 3 : 0; // good fixture + bad fixture + harbor run
    if (judgeCalls > 0) {
      spend.admit(`${judgeCalls} judge calls`, judgeBasis.perCall * judgeCalls + 0.02);
    }

    // --- Known good/bad verifier validation (S5-R6). ---
    step("validate", "grading known correct and incorrect fixtures");
    const validation = validateFixtures({ built, verifierTag, solverTag, config, jobDir: dir });
    if (!validation.ok) {
      return fail("validate.fixtures", validation.detail);
    }
    update({ detail: `fixtures validated: good=${validation.goodReward} bad=${validation.badReward}` });

    // --- Native Harbor run (S5-R4). ---
    step("harbor", "running the native Harbor trial with the replayed attempt");
    const harborDir = join(dir, "harbor");
    const harborArgs = [
      "run",
      "-p", built.taskDir,
      "-a", "opencode_restore_agent:OpenCodeRestoreAgent",
      "-m", `${config.solver.providerName}/${built.selected.model}`,
      "--ak", `opencode_config=${solverOpencodeConfig(config, built.selected.model)}`,
      "--ae", `${config.solver.apiKeyEnv}=${solverApiKey(config)}`,
      "--yes",
      "--n-concurrent", "1",
      "--jobs-dir", harborDir,
      "--job-name", "validation",
      "--quiet",
    ];
    const harborCode = await spawnAwait(
      harborBin(),
      harborArgs,
      config.timeouts.harborSec * 1000,
      { PYTHONPATH: join(repoRoot(), "python"), PATH: HOST_PATH, ...judgeHostEnv(config) },
      (line) => log(`harbor: ${line}`),
    );
    if (harborCode !== 0) {
      return fail("harbor.run", `harbor exited ${harborCode}; see jobs/${jobId}/harbor`);
    }
    const trialDir = findTrialDir(join(harborDir, "validation"));
    if (trialDir === undefined) {
      return fail("harbor.run", "harbor produced no trial directory");
    }
    const trialResult = JSON.parse(readFileSync(join(trialDir, "result.json"), "utf8")) as HarborTrialResult;
    const solverReward = trialResult.verifier_result?.rewards?.["reward"];
    if (typeof solverReward !== "number") {
      return fail("harbor.verifier", "the native Harbor run produced no numeric solver reward");
    }
    if (!existsSync(join(trialDir, "agent", "trajectory.json"))) {
      return fail("harbor.trajectory", "the native Harbor run produced no ATIF trajectory");
    }
    update({ solverReward, detail: `native harbor run ok; solver reward ${solverReward}` });

    // Judge-call accounting: the verifier runs made judgeCalls judge
    // invocations (good fixture, bad fixture, native run). A verified-free
    // judge records exact zero; an asserted or catalog-priced judge records
    // its bounded worst case and is flagged as estimated.
    if (judgeCalls > 0) {
      spend.record(judgeBasis.perCall * judgeCalls, `judge calls x${judgeCalls}`, { estimated: !judgeBasis.exact });
    }
    step("review", "independent task-quality review against the universal rubric");
    const validationSummary = `good-fixture reward ${validation.goodReward}, bad-fixture reward ${validation.badReward} (thresholds: good >= 0.99, bad <= 0.5)`;
    const nativeRunSummary = `harbor trial completed with exit 0; solver reward ${solverReward}; ATIF trajectory present`;
    const review: ReviewResult = await runReviewer(
      config.reviewer,
      {
        instructionMd: readFileSync(join(built.taskDir, "instruction.md"), "utf8"),
        checksPy: writer.checksPy,
        judgeToml: writer.judgeToml,
        validationSummary,
        nativeRunSummary,
        userDescription: record.description,
        selectedPrompt: selectedPrompt.slice(0, 4000),
      },
      config,
      spend,
      { timeoutMs: config.timeouts.reviewerMs, retries: config.retries.reviewer },
    );

    // --- Publication (S5-R8). ---
    step("publish", "checking and publishing the complete task atomically");
    const credentialHits = scanCredentials(built.taskDir);
    if (credentialHits.length > 0) {
      return fail("publish.credentials", credentialHits.slice(0, 3).join("; "));
    }
    // The full review breakdown is retained: in the task (grading provenance)
    // and in the job status (S5-R3).
    writeFileSync(join(built.taskDir, "review.json"), `${JSON.stringify({
      rubricVersion: config.rubric.version,
      overall: review.overall,
      scores: review.scores,
      notes: review.notes,
      reviewedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    const tasksDir = join(config.outputDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    const target = join(tasksDir, record.taskId);
    if (existsSync(target)) {
      return fail("publish.target-exists", `${target} already exists`);
    }
    renameSync(built.taskDir, target);
    update({
      state: "SCORED",
      step: "done",
      detail: `published; quality ${review.overall}/100 (${config.rubric.version})`,
      qualityScore: review.overall,
      qualityScores: review.scores,
      qualityNotes: review.notes,
      spendUSD: spend.spentUSD,
      spendEstimatedUSD: spend.estimatedUSD,
      taskDir: target,
    });
    log(`SCORED task=${record.taskId} quality=${review.overall} breakdown=${JSON.stringify(review.scores)} solverReward=${solverReward} spend=${spend.spentUSD.toFixed(4)} (estimated ${spend.estimatedUSD.toFixed(4)})`);
  } catch (err) {
    if (err instanceof LlmError && err.kind === "budget") {
      fail("spend.cap-exceeded", err.message);
      return;
    }
    fail("runner.unexpected", String(err instanceof Error ? (err.stack ?? err.message) : err));
  }
}

/** Bounded file-content excerpts for the writer (S5-R3 gap fix). */
const EXCERPT_PRIORITY = [".md", ".py", ".ts", ".js", ".json", ".toml", ".yaml", ".yml", ".sh", ".txt"];

function workspaceExcerpts(storeRoot: string, manifest: { files: Array<{ path: string; kind: string; sha256?: string; size?: number }> }): Array<{ path: string; bytes: number; excerpt: string }> {
  const MAX_FILES = 24;
  const MAX_TOTAL_CHARS = 24_000;
  const PER_FILE_CHARS = 2048;
  const files = manifest.files
    .filter((f) => f.kind === "file" && typeof f.sha256 === "string")
    .filter((f) => (f.size ?? Number.MAX_SAFE_INTEGER) <= 64_000);
  const priority = (path: string): number => {
    const lower = path.toLowerCase();
    const ext = lower.slice(lower.lastIndexOf("."));
    const index = EXCERPT_PRIORITY.indexOf(ext);
    return index >= 0 ? index : EXCERPT_PRIORITY.length;
  };
  files.sort((a, b) => priority(a.path) - priority(b.path) || a.path.localeCompare(b.path));
  const out: Array<{ path: string; bytes: number; excerpt: string }> = [];
  let total = 0;
  for (const file of files) {
    if (out.length >= MAX_FILES || total >= MAX_TOTAL_CHARS) {
      break;
    }
    try {
      const content = readFileSync(join(storeRoot, "objects", file.sha256!), "utf8");
      const excerpt = content.slice(0, PER_FILE_CHARS);
      total += excerpt.length;
      out.push({ path: file.path, bytes: content.length, excerpt });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Per-call cost basis for one judge invocation. An explicit config override
 * is asserted exact; otherwise the provider catalog decides: verified
 * zero-priced models are exact zero, priced models are bounded by a
 * documented token ceiling per call (estimated), and unknown pricing returns
 * null (the cap cannot be respected).
 */
async function judgeCostBasis(config: SystemConfig): Promise<{ perCall: number; exact: boolean } | null> {
  if (typeof config.judgeCostEstimateUSDPerCall === "number" && config.judgeCostEstimateUSDPerCall >= 0) {
    return { perCall: config.judgeCostEstimateUSDPerCall, exact: true };
  }
  if (!config.judgeModel.startsWith("openrouter/")) {
    return null;
  }
  const modelId = config.judgeModel.slice("openrouter/".length);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      return null;
    }
    const { data } = (await response.json()) as { data: Array<{ id: string; pricing: Record<string, string> }> };
    const model = data.find((m) => m.id === modelId);
    if (model === undefined) {
      return null;
    }
    const prices = Object.values(model.pricing).map((v) => Number(v));
    if (prices.length === 0) {
      return null;
    }
    if (prices.every((p) => p === 0)) {
      return { perCall: 0, exact: true };
    }
    const inputPrice = Number(model.pricing["prompt"] ?? "0");
    const outputPrice = Number(model.pricing["completion"] ?? "0");
    // Documented ceiling for one judge interaction: 64k prompt tokens (the
    // rubric plus graded files) and 2k completion tokens.
    return { perCall: 64_000 * inputPrice + 2_000 * outputPrice, exact: false };
  } catch {
    return null;
  }
}

function solverOpencodeConfig(config: SystemConfig, capturedModelId: string): string {
  return JSON.stringify({
    provider: {
      [config.solver.providerName]: {
        npm: "@ai-sdk/openai-compatible",
        name: "SolverEndpoint",
        options: {
          baseURL: config.solver.baseURL,
          apiKey: `{env:${config.solver.apiKeyEnv}}`,
        },
        models: { [capturedModelId]: { name: capturedModelId } },
      },
    },
    model: `${config.solver.providerName}/${capturedModelId}`,
  });
}

/** Resolve the configured credential NAME at runtime; never persist the value. */
function credentialValue(apiKeyEnv: string): string {
  const value = process.env[apiKeyEnv];
  if (value === undefined || value === "") {
    throw new LlmError("http", `credential environment variable ${apiKeyEnv} is not set`);
  }
  return value;
}

function solverApiKey(config: SystemConfig): string {
  return credentialValue(config.solver.apiKeyEnv);
}

/** Host env for the harbor process: judge credential NAMES resolved at runtime. */
function judgeHostEnv(config: SystemConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const hostName of Object.values(config.verifierEnv)) {
    const value = process.env[hostName];
    if (value !== undefined && value !== "") {
      env[hostName] = value;
    }
  }
  return env;
}

/** Grade the known-correct and known-incorrect fixtures through the verifier image. */
function validateFixtures(options: {
  readonly built: ReturnType<typeof buildHarborTask>;
  readonly verifierTag: string;
  readonly solverTag: string;
  readonly config: SystemConfig;
  readonly jobDir: string;
}): { ok: boolean; goodReward: number; badReward: number; detail: string } {
  const { built, verifierTag, solverTag, config } = options;
  const goodDir = join(options.jobDir, "fixture-good");
  const badDir = join(options.jobDir, "fixture-bad");
  rmSync(goodDir, { recursive: true, force: true });
  rmSync(badDir, { recursive: true, force: true });
  cpSync(join(built.taskDir, "environment", "app"), goodDir, { recursive: true });
  cpSync(join(built.taskDir, "environment", "app"), badDir, { recursive: true });

  // Known-correct fixture: apply the writer's solution inside the solver
  // image. The solution is MOUNTED at run time, never baked into the image
  // (isolation: the replaying agent must not read the reference solution).
  const solve = runDocker([
    "run", "--rm", "--platform", "linux/arm64",
    "-v", `${goodDir}:/app`,
    "-v", `${join(built.taskDir, "solution", "solve.sh")}:/tmp/solve.sh:ro`,
    "-e", "HOME=/tmp",
    solverTag,
    "bash", "/tmp/solve.sh",
  ], 300_000);
  if (solve.status !== 0) {
    return { ok: false, goodReward: 0, badReward: 0, detail: `solution script failed (exit ${solve.status}): ${(solve.stderr || solve.stdout).slice(-300)}` };
  }

  const good = gradeFixture(verifierTag, goodDir, config);
  const bad = gradeFixture(verifierTag, badDir, config);
  if (good.reward === null || bad.reward === null) {
    return {
      ok: false,
      goodReward: good.reward ?? 0,
      badReward: bad.reward ?? 0,
      detail: `the verifier produced no numeric reward for a fixture (good exit ${good.exit}: ${good.diagnostic}; bad exit ${bad.exit}: ${bad.diagnostic})`,
    };
  }
  if (good.reward < 0.99) {
    return { ok: false, goodReward: good.reward, badReward: bad.reward, detail: `the known-correct fixture scored ${good.reward}; expected >= 0.99` };
  }
  if (bad.reward > 0.5) {
    return { ok: false, goodReward: good.reward, badReward: bad.reward, detail: `the known-incorrect fixture scored ${bad.reward}; expected <= 0.5` };
  }
  return { ok: true, goodReward: good.reward, badReward: bad.reward, detail: "ok" };
}

/** Run the verifier image against a fixture workspace; returns the reward or a diagnostic. */
function gradeFixture(verifierTag: string, fixtureDir: string, config: SystemConfig): { reward: number | null; exit: number; diagnostic: string } {
  const logsDir = `${fixtureDir}-verifier-logs`;
  rmSync(logsDir, { recursive: true, force: true });
  mkdirSync(logsDir, { recursive: true });
  const envArgs: string[] = [];
  const envNames: string[] = [];
  for (const [container, host] of Object.entries(config.verifierEnv)) {
    const value = process.env[host];
    envNames.push(`${container}<-${host}(${value === undefined || value === "" ? "MISSING" : "set"})`);
    if (value !== undefined && value !== "") {
      envArgs.push("-e", `${container}=${value}`);
    }
  }
  const result = runDocker([
    "run", "--rm", "--platform", "linux/arm64",
    "-v", `${fixtureDir}:/app`,
    "-v", `${join(fixtureDir, "..", "task", "tests")}:/tests:ro`,
    "-v", `${logsDir}:/logs/verifier`,
    ...envArgs,
    verifierTag,
    "bash", "/tests/test.sh",
  ], 600_000);
  const rewardPath = join(logsDir, "reward.json");
  if (!existsSync(rewardPath)) {
    const stderrTail = result.stderr.trim().split("\n").filter((l) => l.trim() !== "").slice(-1)[0] ?? "";
    return { reward: null, exit: result.status, diagnostic: `env ${envNames.join(", ")}; ${stderrTail.slice(0, 200)}` };
  }
  try {
    const rewards = JSON.parse(readFileSync(rewardPath, "utf8")) as Record<string, unknown>;
    const value = rewards["reward"];
    return { reward: typeof value === "number" ? value : null, exit: result.status, diagnostic: `env ${envNames.join(", ")}` };
  } catch {
    return { reward: null, exit: result.status, diagnostic: "reward.json unparseable" };
  }
}

function scanCredentials(taskDir: string): string[] {
  const hits: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "objects" || entry.name === "app" || entry.name === "harness") {
          continue;
        }
        walk(full);
      } else if (entry.isFile()) {
        try {
          const text = readFileSync(full, "utf8");
          for (const [pattern, label] of CREDENTIAL_PATTERNS) {
            if (pattern.test(text)) {
              hits.push(`${full}: ${label}`);
            }
          }
        } catch {
          // Binary or unreadable; skip.
        }
      }
    }
  };
  walk(taskDir);
  return hits;
}

function findTrialDir(harborJobDir: string): string | undefined {
  if (!existsSync(harborJobDir)) {
    return undefined;
  }
  for (const entry of readdirSync(harborJobDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith("task")) {
      return join(harborJobDir, entry.name);
    }
  }
  return undefined;
}

function spawnAwait(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  env: Record<string, string>,
  onLine?: (line: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (onLine !== undefined) {
        for (const line of `${stdout}\n${stderr}`.split("\n").filter((l) => l.trim() !== "").slice(-40)) {
          onLine(line);
        }
      }
      resolve(code ?? 1);
    });
  });
}

/** Container entry point. */
export function mainRunner(argv: readonly string[]): void {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const jobId = get("--job");
  if (jobId === undefined) {
    console.error("usage: runner.js --job <job-id> [--config <path>]");
    process.exit(2);
  }
  const configFlag = get("--config");
  runPipeline(jobId, configFlag).then(() => {
    process.exit(0);
  }, (err) => {
    console.error(String(err));
    process.exit(1);
  });
}

if (process.argv[1]?.endsWith("runner.js")) {
  mainRunner(process.argv.slice(2));
}
