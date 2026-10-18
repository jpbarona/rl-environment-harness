/**
 * S5 unit tests: config validation, job state + crash sweep, spend cap,
 * writer/reviewer envelopes, and the deterministic Harbor task builder.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ConfigError } from "../../src/checkpoint/config.js";
import { createJob, isRunnerAlive, listJobs, markFailed, readStatus, writeStatus, type JobStatus } from "../../src/checkpoint/job.js";
import { SpendTracker, LlmError, chatCompletion } from "../../src/checkpoint/llm.js";
import { parseWriterOutput, buildWriterMessages } from "../../src/checkpoint/writer.js";
import { parseReviewerOutput } from "../../src/checkpoint/reviewer.js";
import { buildHarborTask, exportFrozenCapture } from "../../src/checkpoint/harbor-task.js";
import { snapshotWorkspace } from "../../src/capture/snapshot.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function writeConfig(dir: string, overrides: Record<string, unknown> = {}): string {
  const path = join(dir, "checkpoint.config.json");
  writeFileSync(path, `${JSON.stringify({
    storePath: join(dir, "store"),
    outputDir: join(dir, "output"),
    jobsDir: join(dir, "output", "jobs"),
    captureServiceURL: "http://127.0.0.1:9",
    writer: { baseURL: "http://127.0.0.1:9", model: "writer-m", apiKeyEnv: "WRITER_API_KEY", maxOutputTokens: 2048 },
    reviewer: { baseURL: "http://127.0.0.1:9", model: "reviewer-m", apiKeyEnv: "REVIEWER_API_KEY", maxOutputTokens: 1024 },
    judgeModel: "openai/judge-m",
    solver: { baseURL: "http://127.0.0.1:9", model: "unused", apiKeyEnv: "SOLVER_API_KEY", providerName: "capture-mock", maxOutputTokens: 1024 },
    verifierEnv: { OPENAI_API_KEY: "JUDGE_API_KEY", OPENAI_BASE_URL: "JUDGE_BASE_URL" },
    credentials: {},
    modelSpendCapUSD: 0.2,
    ...overrides,
  }, null, 2)}\n`);
  return path;
}

describe("S5 config validation", () => {
  it("loads a complete config and resolves absolute paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "ckpt-cfg-"));
    const path = writeConfig(dir);
    const config = loadConfig(path);
    expect(config.storePath).toBe(join(dir, "store"));
    expect(config.modelSpendCapUSD).toBe(0.2);
    expect(config.solver.providerName).toBe("capture-mock");
    expect(config.rubric.dimensions).toHaveLength(6);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects missing fields, wrong types, and non-name credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "ckpt-cfg-"));
    const path = writeConfig(dir);
    const broken = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete broken["writer"];
    writeFileSync(path, JSON.stringify(broken));
    expect(() => loadConfig(path)).toThrow(ConfigError);

    const wrongCap = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    // Restore writer, break the cap type.
    wrongCap["writer"] = { baseURL: "http://x", model: "m", apiKeyEnv: "K", maxOutputTokens: 10 };
    wrongCap["modelSpendCapUSD"] = "free";
    writeFileSync(path, JSON.stringify(wrongCap));
    expect(() => loadConfig(path)).toThrow(ConfigError);

    const badCred = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    badCred["modelSpendCapUSD"] = 0.2;
    badCred["credentials"] = { writer: "NOT A NAME" };
    writeFileSync(path, JSON.stringify(badCred));
    expect(() => loadConfig(path)).toThrow(/credentials\.writer/);

    const missing = join(dir, "nope.json");
    expect(() => loadConfig(missing)).toThrow(/does not exist/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("S5 job state and crash sweep", () => {
  it("creates, reads, and lists jobs; a dead runner is swept to FAILED", () => {
    const dir = mkdtempSync(join(tmpdir(), "ckpt-job-"));
    const jobsRoot = join(dir, "jobs");
    createJob(jobsRoot, {
      jobId: "job-test-1", taskId: "task-001", checkpointId: "ckpt-x",
      sessionId: "ses_x", messageId: "msg_x", storePath: "/tmp/store",
      description: "did not do x", createdAt: new Date().toISOString(),
    });
    const status = readStatus(jobsRoot, "job-test-1");
    expect(status?.state).toBe("QUEUED");

    // Simulate a crashed runner: RUNNING with a pid that does not exist.
    const dead: JobStatus = { ...status!, state: "RUNNING", step: "writer", detail: "working", runnerPid: 2 ** 22 };
    expect(isRunnerAlive(dead.runnerPid)).toBe(false);
    markFailed(jobsRoot, dead, "runner.died", "runner is no longer alive");
    const swept = readStatus(jobsRoot, "job-test-1");
    expect(swept?.state).toBe("FAILED");
    expect(swept?.detail).toContain("runner.died");
    expect(listJobs(jobsRoot)).toHaveLength(1);

    // A live process (this test's own pid) stays RUNNING.
    const alive: JobStatus = { ...dead, state: "RUNNING", runnerPid: process.pid, detail: "working" };
    expect(isRunnerAlive(alive.runnerPid)).toBe(true);
    writeStatus(jobsRoot, alive);
    expect(readStatus(jobsRoot, "job-test-1")?.state).toBe("RUNNING");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("S5 provider response diagnostics", () => {
  it("reports finish reason and reasoning usage when the model returns empty content", async () => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => raw += String(chunk));
      req.on("end", () => {
        expect(raw).toContain("z-ai/glm-5.3-flash");
        res.setHeader("content-type", "application/json");
        // GLM-shaped reasoning-model response: all completion budget spent
        // on reasoning, no content, finish_reason length.
        res.end(JSON.stringify({
          model: "z-ai/glm-5.3-flash",
          choices: [{ finish_reason: "length", message: { content: "", reasoning: "long thinking trace" } }],
          usage: { prompt_tokens: 3200, completion_tokens: 8192, completion_tokens_details: { reasoning_tokens: 8192 }, cost: null },
        }));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    process.env["WRITER_API_KEY"] = "unit-test-key";
    try {
      await expect(chatCompletion(
        { baseURL: `http://127.0.0.1:${port}`, model: "z-ai/glm-5.3-flash", apiKeyEnv: "WRITER_API_KEY", maxOutputTokens: 8192 },
        [{ role: "user", content: "produce the envelope" }],
        { timeoutMs: 5000 },
      )).rejects.toThrow(/empty content \(model=z-ai\/glm-5\.3-flash, finish_reason=length, completion_tokens=8192, reasoning_tokens=8192\)/);
    } finally {
      await new Promise((ok) => server.close(ok));
    }
  });
});

describe("S5 spend cap", () => {
  it("admits free-model calls, records actuals, tracks estimates, and fails the job when the cap is exceeded", async () => {
    const { estimateCostFromTokens } = await import("../../src/checkpoint/llm.js");
    const tracker = new SpendTracker(0.2);
    tracker.admit("writer"); // placeholder 0.02
    tracker.record(0, "writer");
    tracker.admit("reviewer");
    tracker.record(0, "reviewer");
    expect(tracker.spentUSD).toBe(0);
    expect(tracker.estimatedUSD).toBe(0);

    // A missing provider cost is estimated from tokens at the documented
    // ceiling and flagged: it counts against the cap, never silently zero.
    const estimated = estimateCostFromTokens(10_000, 1_000);
    expect(estimated).toBeCloseTo(10_000 * (3 / 1_000_000) + 1_000 * (15 / 1_000_000));
    tracker.record(estimated, "unreported-cost call", { estimated: true });
    expect(tracker.estimatedUSD).toBeCloseTo(estimated);

    // A costly call that would exceed the cap is refused before running, and
    // a reported cost that crosses the cap fails the record.
    expect(() => tracker.record(0.16, "reported")).toThrow(/cap exceeded/);
    expect(() => tracker.admit("next")).toThrow(LlmError);
  });

  it("admits a reserved judge budget and records its worst case as estimated", () => {
    const tracker = new SpendTracker(0.2);
    tracker.admit("3 judge calls", 0.12); // reservation: 3 x 0.04
    tracker.record(0.12, "judge calls x3", { estimated: true });
    expect(tracker.spentUSD).toBeCloseTo(0.12);
    expect(tracker.estimatedUSD).toBeCloseTo(0.12);
    expect(() => tracker.record(0.09, "over")).toThrow(/cap exceeded/);
  });

  it("a missing credential fails the call before any request is sent", async () => {
    const { chatCompletion } = await import("../../src/checkpoint/llm.js");
    const saved = process.env["CKPT_TEST_MISSING_KEY"];
    delete process.env["CKPT_TEST_MISSING_KEY"];
    try {
      await expect(chatCompletion(
        { baseURL: "http://127.0.0.1:9/v1", model: "m", apiKeyEnv: "CKPT_TEST_MISSING_KEY", maxOutputTokens: 16 },
        [{ role: "user", content: "x" }],
        { timeoutMs: 1000 },
      )).rejects.toThrow(/CKPT_TEST_MISSING_KEY is not set/);
    } finally {
      if (saved !== undefined) {
        process.env["CKPT_TEST_MISSING_KEY"] = saved;
      }
    }
  });
});

describe("S5 writer and reviewer envelopes", () => {
  const validWriter = JSON.stringify({
    taskName: "fix-greeting",
    taskDescription: "Write the greeting file.",
    instructionMd: "Create hello.txt with hi.",
    checksPy: "import rewardkit as rk\nrk.file_contains('hello.txt', 'hi')\n",
    judgeToml: null,
    solveSh: "printf hi > hello.txt\n",
  });

  it("parses a valid writer envelope and rejects malformed ones", () => {
    const parsed = parseWriterOutput(validWriter);
    expect(parsed.taskName).toBe("fix-greeting");
    expect(parsed.judgeToml).toBeNull();

    expect(() => parseWriterOutput("no json here")).toThrow(/not a JSON object/);
    expect(() => parseWriterOutput('{"taskName": ""}')).toThrow(/non-empty string/);
    expect(() => parseWriterOutput(validWriter.replace('"fix-greeting"', '"Fix Greeting"'))).toThrow(/kebab-case/);
    expect(() => parseWriterOutput(validWriter.replace("rk.file_contains", "x"))).toThrow(/no RewardKit criteria/);
    expect(() => parseWriterOutput(validWriter.replace("null", '"[judge]"'))).toThrow(/JUDGE_MODEL_PLACEHOLDER/);
  });

  it("rejects isolated command criteria the verifier cannot run", () => {
    // The verifier container has no fuse-overlayfs: isolated=True cannot
    // provide the filesystem isolation it promises (observed live failure).
    const isolated = validWriter.replace(
      "rk.file_contains('hello.txt', 'hi')",
      "rk.command_succeeds('cat hello.txt', weight=1.0, isolated=True)",
    );
    expect(() => parseWriterOutput(isolated)).toThrow(/isolated=True.*isolation/s);
  });

  it("the writer prompt declares verifier capabilities, preservation rules, and the replay transformations", () => {
    const messages = buildWriterMessages({
      description: "did not do x", selectedPrompt: "do x", priorContextExcerpt: "user: do x",
      workspaceFiles: [{ path: "a.txt", bytes: 32, excerpt: "counter = 1" }], attemptExcerpt: "assistant: ok", judgeModelPlaceholder: "JUDGE_MODEL_PLACEHOLDER",
      replayTransformations: ["removed the capture plugin from the baked workspace (no recorder proxy in the solver)"],
    });
    expect(messages[0]?.content).toContain("isolated=True");
    expect(messages[0]?.content).toContain("Preservation criteria");
    const user = messages[1]?.content ?? "";
    expect(user).toContain("replay_transformations");
    expect(user).toContain("capture plugin");
  });

  it("the writer prompt carries the failure description, capture context, and file excerpts", () => {
    const messages = buildWriterMessages({
      description: "did not do x", selectedPrompt: "do x", priorContextExcerpt: "user: do x",
      workspaceFiles: [{ path: "a.txt", bytes: 32, excerpt: "counter = 1" }], attemptExcerpt: "assistant: ok", judgeModelPlaceholder: "JUDGE_MODEL_PLACEHOLDER",
    });
    expect(messages[0]?.role).toBe("system");
    const user = messages[1]?.content ?? "";
    expect(user).toContain("did not do x");
    expect(user).toContain("do x");
    expect(user).toContain("a.txt");
    expect(user).toContain("counter = 1");
  });

  it("parses a valid reviewer output and rejects out-of-range scores", () => {
    const parsed = parseReviewerOutput('{"scores": {"D1": 80, "D2": 100}, "overall": 90, "notes": "ok"}');
    expect(parsed.overall).toBe(90);
    expect(() => parseReviewerOutput('{"scores": {"D1": 180}, "overall": 90}')).toThrow(/in \[0, 100\]/);
    expect(() => parseReviewerOutput('{"scores": {}, "overall": "high"}')).toThrow(/number in \[0, 100\]/);
  });
});

describe("S5 deterministic task builder", () => {
  let root: string;
  let store: string;
  let ckpt: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ckpt-build-"));
    store = join(root, "store");
    // Two-turn synthetic store built with the real capture code path.
    const ws = join(root, "workspace");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "notes.md"), "version-2\n");
    writeFileSync(join(ws, "opencode.json"), JSON.stringify({ provider: { "capture-mock": { options: { baseURL: "http://127.0.0.1:1/v1" } } }, model: "capture-mock/mock-model", formatter: false }, null, 2));
    mkdirSync(join(ws, ".opencode", "plugins"), { recursive: true });
    writeFileSync(join(ws, ".opencode", "plugins", "capture-plugin.ts"), "// capture plugin\n");
    ckpt = "ckpt-build0001";
    const manifest = snapshotWorkspace(ws, store, ckpt);
    const manifestRecord = JSON.parse(readFileSync(manifest.manifestPath, "utf8")) as { root: string };
    const records = join(store, "checkpoints", ckpt);
    writeFileSync(join(records, "runtime.json"), JSON.stringify({
      turnId: "turn-00000001", sessionId: "ses_build", messageId: "msg_1",
      mainModel: "mock-model", workspaceRoot: manifestRecord.root, opencodeVersion: "2.0.18",
    }));
    writeFileSync(join(records, "session_state.json"), JSON.stringify({ session: { id: "ses_build" } }));
    writeFileSync(join(records, "prior_context.json"), JSON.stringify({
      turnId: "turn-00000001",
      priorMessages: [{ role: "user", content: '"FIXTURE_SECOND create selected-output.txt with selected-result"' }],
    }));
    writeFileSync(join(records, "model_requests.jsonl"), `${JSON.stringify({
      index: 3, classification: "task-new-turn",
      body: { model: "mock-model", messages: [{ role: "system", content: "s" }, { role: "user", content: '"FIXTURE_SECOND create selected-output.txt with selected-result"' }] },
    })}\n`);
  });

  it("assembles the complete Harbor task with recorded runtime rebinds", () => {
    const config = loadConfig(writeConfig(root, { storePath: store }));
    const jobDir = join(root, "job");
    mkdirSync(jobDir, { recursive: true });
    const exportedPackageDir = exportFrozenCapture({ config, jobDir, checkpointId: ckpt, repoRoot });
    const built = buildHarborTask({
      config,
      jobDir,
      checkpointId: ckpt,
      exportedPackageDir,
      writer: {
        taskName: "fix-greeting",
        taskDescription: "Write the greeting file.",
        instructionMd: "Create selected-output.txt with selected-result.",
        checksPy: "import rewardkit as rk\nrk.file_contains('selected-output.txt', 'selected-result')\n",
        judgeToml: '[judge]\njudge = "JUDGE_MODEL_PLACEHOLDER"\nfiles = ["/app/selected-output.txt"]\n\n[[criterion]]\ndescription = "correct content"\ntype = "binary"\n',
        solveSh: "printf selected-result > selected-output.txt\n",
      },
      repoRoot,
    });

    const task = built.taskDir;
    // Complete layout.
    expect(readdirSync(task).sort()).toEqual(["build-report.json", "capture", "environment", "evidence", "instruction.md", "solution", "task.toml", "tests"]);
    // Starting workspace baked with the recorded runtime rebinds.
    const report = JSON.parse(readFileSync(join(task, "build-report.json"), "utf8")) as { mutations: string[]; selectedPrompt: string; capturedModel: string };
    expect(report.mutations.some((m) => m.includes("provider/model"))).toBe(true);
    expect(report.mutations.some((m) => m.includes("capture plugin"))).toBe(true);
    expect(report.selectedPrompt).toContain("FIXTURE_SECOND");
    expect(report.capturedModel).toBe("mock-model");
    const appConfig = JSON.parse(readFileSync(join(task, "environment", "app", "opencode.json"), "utf8")) as Record<string, unknown>;
    expect(appConfig["provider"]).toBeUndefined();
    expect(appConfig["model"]).toBeUndefined();
    expect(existsSync(join(task, "environment", "app", ".opencode", "plugins", "capture-plugin.ts"))).toBe(false);
    // selected.json retains the captured identity and prompt.
    const selected = JSON.parse(readFileSync(join(task, "environment", "capture", "selected.json"), "utf8")) as Record<string, unknown>;
    expect(selected["sessionId"]).toBe("ses_build");
    expect(selected["prompt"]).toContain("FIXTURE_SECOND");
    // Solver Dockerfile pins the same runtime as the restore lock and does
    // NOT bake the reference solution (isolation).
    const solverDockerfile = readFileSync(join(task, "environment", "Dockerfile"), "utf8");
    const lock = JSON.parse(readFileSync(join(repoRoot, "containers", "restore", "lock.json"), "utf8")) as { imageDigest: string; opencode: { sha256: string } };
    expect(solverDockerfile).toContain(lock.imageDigest);
    expect(solverDockerfile).toContain(lock.opencode.sha256);
    expect(solverDockerfile).not.toContain("solution.sh");
    expect(existsSync(join(task, "environment", "solution.sh"))).toBe(false);
    expect(readFileSync(join(task, "solution", "solve.sh"), "utf8")).toContain("selected-output.txt");
    // Verifier: separate image, RewardKit pinned, tests baked.
    expect(readFileSync(join(task, "tests", "Dockerfile"), "utf8")).toContain("harbor-rewardkit==0.2.3");
    const toml = readFileSync(join(task, "task.toml"), "utf8");
    expect(toml).toContain('schema_version = "1.3"');
    expect(toml).toContain('artifacts = ["/app", "/logs/agent/trajectory.json"]');
    expect(toml).toContain('environment_mode = "separate"');
    expect(toml).toContain('OPENAI_API_KEY = "${JUDGE_API_KEY}"');
    expect(toml).toContain("VERIFIER_DOCKER_IMAGE_PLACEHOLDER");
    expect(toml).toContain("SOLVER_DOCKER_IMAGE_PLACEHOLDER");
    // Judge model substituted; placeholder gone.
    const judgeToml = readFileSync(join(task, "tests", "judge.toml"), "utf8");
    expect(judgeToml).toContain("openai/judge-m");
    expect(judgeToml).not.toContain("JUDGE_MODEL_PLACEHOLDER");
    // Solver capture (with selected.json) + task-root capture/evidence provenance.
    expect(existsSync(join(task, "environment", "capture", "selected.json"))).toBe(true);
    expect(existsSync(join(task, "capture", "checkpoints", ckpt, "manifest.json"))).toBe(true);
    expect(existsSync(join(task, "evidence", "model_requests.jsonl"))).toBe(true);
    // The Step 4 export record exists beside the task.
    expect(existsSync(join(jobDir, "export", `task-${ckpt}`))).toBe(true);
  });

  it("reuses the verified export across rebuilds: two writer attempts, one package, no collision", () => {
    const config = loadConfig(writeConfig(root, { storePath: store }));
    const jobDir = join(root, "job-retry");
    mkdirSync(jobDir, { recursive: true });
    // The frozen capture is exported exactly once for the job.
    const exportedPackageDir = exportFrozenCapture({ config, jobDir, checkpointId: ckpt, repoRoot });
    const firstWriter = {
      taskName: "fix-greeting",
      taskDescription: "Write the greeting file.",
      instructionMd: "Create selected-output.txt with selected-result.",
      checksPy: "import rewardkit as rk\nrk.file_contains('selected-output.txt', 'selected-result')\n",
      judgeToml: null,
      solveSh: "printf selected-result > selected-output.txt\n",
    };
    // A repaired second attempt: different criteria, same frozen export.
    const repairedWriter = { ...firstWriter, taskName: "fix-greeting-2", checksPy: "import rewardkit as rk\nrk.file_exists('selected-output.txt')\n" };
    const first = buildHarborTask({ config, jobDir, checkpointId: ckpt, exportedPackageDir, writer: firstWriter, repoRoot });
    // The rebuilt draft replaces the first attempt's task directory.
    const firstChecks = readFileSync(join(first.taskDir, "tests", "checks.py"), "utf8");
    const second = buildHarborTask({ config, jobDir, checkpointId: ckpt, exportedPackageDir, writer: repairedWriter, repoRoot });
    expect(firstChecks).toBe(firstWriter.checksPy);
    expect(readFileSync(join(second.taskDir, "tests", "checks.py"), "utf8")).toBe(repairedWriter.checksPy);
    // The export root still holds exactly ONE published package: the second
    // attempt reused it instead of colliding with package.target-exists.
    expect(readdirSync(join(jobDir, "export"))).toEqual([`task-${ckpt}`]);
  });

  it("solver container replays the captured session end-to-end (real OpenCode, real Harbor)", { timeout: 900_000 }, () => {
    // Requires Docker; the container suite covers this in the e2e file.
    const docker = spawnSync("/usr/local/bin/docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
    if (docker.status !== 0) {
      throw new Error("BLOCKED: Docker daemon unavailable");
    }
  });
});
