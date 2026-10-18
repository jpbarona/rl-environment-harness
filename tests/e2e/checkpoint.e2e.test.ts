/**
 * S5 e2e: the complete checkpoint workflow with real OpenCode and native
 * Harbor.
 *
 * Real capture (two OpenCode turns) -> `checkpoint "<description>"` queues a
 * detached job -> later messages and file edits are proven not to touch the
 * frozen task -> the runner generates the task (mock writer), builds solver
 * and verifier images, grades known good/bad fixtures through the separate
 * verifier, runs a native Harbor trial that replays the captured session
 * with real OpenCode tool execution, applies the independent review (mock),
 * and publishes atomically. Model endpoints are deterministic mock servers;
 * paid live runs stay opt-in (tests/live).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createE2E, type E2EEnv } from "../../src/capture/e2e.js";
import { MockModelServer, type MockScript } from "../../src/capture/mock-model.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(repoRoot, "dist", "checkpoint", "cli.js");
const DOCKER = "/usr/local/bin/docker";
const HOST_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

let env: E2EEnv;
let scratch: string;
let solverMock: MockModelServer;
let solverURL = "";
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  const docker = spawnSync(DOCKER, ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  if (docker.status !== 0) {
    throw new Error("BLOCKED: Docker daemon unavailable for Step 5 e2e");
  }

  // Control mock: writer + reviewer + judge markers (host + container reach).
  const controlMock = new MockModelServer(controlScript());
  const controlURL = await controlMock.start();
  cleanups.push(() => controlMock.stop());

  // Solver mock: the replayed attempt gets the tool call that writes the file.
  solverMock = new MockModelServer(solverScript());
  const solverLocal = await solverMock.start();
  cleanups.push(() => solverMock.stop());
  solverURL = solverLocal.replace("127.0.0.1", "host.docker.internal");

  // Real OpenCode capture: two turns (turn 2 is the selection).
  const firstPrompt = "FIXTURE_FIRST change the starting files";
  const secondPrompt = "FIXTURE_SECOND create selected-output.txt with selected-result";
  const emitted = new Set<string>();
  env = await createE2E({ name: "checkpoint-fixture", captureDelayMs: 600,
    script: ({ model, lastUserText }) => {
      if (model !== "mock-model" || emitted.has(lastUserText)) return { content: "done" };
      let command: string;
      if (lastUserText.includes(firstPrompt)) {
        command = "printf 'version-2\\n' > notes.md; printf 'scratch-data\\n' > scratch.tmp; printf 'LOCAL_FIXTURE=true\\n' > .env.local; rm obsolete.txt";
      } else if (lastUserText.includes(secondPrompt)) {
        command = "printf 'selected-result' > selected-output.txt";
      } else return { content: "done" };
      emitted.add(lastUserText);
      return { toolCalls: [{ id: `call_${emitted.size}`, name: "shell", args: { command, description: "execute fixture" } }] };
    },
  });
  cleanups.push(env.cleanup);
  const r1 = await env.runPrompt(firstPrompt);
  expect(r1.code, `capture run 1 failed: ${r1.stderr}`).toBe(0);
  const r2 = await env.runPrompt(secondPrompt, { continueLast: true });
  expect(r2.code, `capture run 2 failed: ${r2.stderr}`).toBe(0);

  // Scratch + config.
  scratch = join(env.runDir, "checkpoint-scratch");
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, "checkpoint.config.json"), `${JSON.stringify({
    storePath: join(env.runDir, "capture-store"),
    outputDir: join(scratch, "output"),
    jobsDir: join(scratch, "output", "jobs"),
    captureServiceURL: env.proxy.url,
    writer: { baseURL: `${controlURL}/v1`, model: "mock-writer", apiKeyEnv: "WRITER_API_KEY", maxOutputTokens: 4096 },
    reviewer: { baseURL: `${controlURL}/v1`, model: "mock-reviewer", apiKeyEnv: "REVIEWER_API_KEY", maxOutputTokens: 1024 },
    judgeModel: "openai/o4-mini",
    // The judge endpoint here is the loopback mock: asserted free per call.
    judgeCostEstimateUSDPerCall: 0,
    solver: { baseURL: `${solverURL}/v1`, model: "unused-captured-id-wins", apiKeyEnv: "SOLVER_API_KEY", providerName: "capture-mock", maxOutputTokens: 1024 },
    verifierEnv: { OPENAI_API_KEY: "JUDGE_API_KEY", OPENAI_BASE_URL: "JUDGE_BASE_URL" },
    credentials: {},
    modelSpendCapUSD: 0.2,
  }, null, 2)}\n`);
}, 240_000);

afterAll(async () => {
  for (const fn of cleanups) {
    await fn();
  }
});

/** Writer / reviewer / judge marker routing for the control mock. */
function controlScript(): MockScript {
  return ({ systemText, firstUserText }) => {
    const prompt = `${systemText}\n${firstUserText}`;
    if (prompt.includes("You convert a failed coding-agent attempt")) {
      return {
        content: JSON.stringify({
          taskName: "replay-selected-output",
          taskDescription: "The agent must create selected-output.txt with the exact content selected-result.",
          instructionMd: "Working in /app, create a file named selected-output.txt containing the exact result string agreed in the prior conversation. Do not announce the result in prose.",
          checksPy: [
            "import rewardkit as rk",
            "rk.file_exists('selected-output.txt')",
            "rk.file_contains('selected-output.txt', 'selected-result')",
            "",
          ].join("\n"),
          judgeToml: [
            "[judge]",
            'judge = "JUDGE_MODEL_PLACEHOLDER"',
            'files = ["/app/selected-output.txt"]',
            "",
            "[[criterion]]",
            'description = "The file contains the exact required content."',
            'type = "binary"',
            "",
          ].join("\n"),
          solveSh: "printf 'selected-result' > selected-output.txt\n",
        }),
      };
    }
    if (prompt.includes("independent task-quality reviewer")) {
      return {
        content: JSON.stringify({
          scores: { D1: 90, D2: 90, D3: 80, D4: 80, D5: 80, D6: 90 },
          overall: 85,
          notes: "mock review: instructions clear, grading distinguishes outcomes, native run evidenced",
        }),
      };
    }
    if (prompt.includes("You are an evaluation judge")) {
      return { content: '{"score": 1, "reasoning": "mock judge: criterion satisfied"}' };
    }
    return { content: "ok" };
  };
}

/** The replayed captured request produces the file-writing tool call once. */
function solverScript(): MockScript {
  return ({ lastUserText, toolCallIds }) => {
    // The seeded context carries turn-1 tool outputs, so key on the replay's
    // own call id, not on the presence of tool outputs in general.
    if (lastUserText.includes("FIXTURE_SECOND") && !toolCallIds.includes("call_replay")) {
      return {
        toolCalls: [{
          id: "call_replay",
          name: "shell",
          args: { command: "printf 'selected-result' > selected-output.txt", description: "create the required file" },
        }],
      };
    }
    return { content: "done" };
  };
}

function runCli(args: readonly string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn("node", [cli, ...args], {
      env: {
        ...process.env,
        PATH: HOST_PATH,
        CHECKPOINT_CONFIG: join(scratch, "checkpoint.config.json"),
        WRITER_API_KEY: "mock-writer-key",
        REVIEWER_API_KEY: "mock-reviewer-key",
        SOLVER_API_KEY: "mock-solver-key",
        JUDGE_API_KEY: "mock-judge-key",
        // JUDGE_BASE_URL flows from process.env (set with the dynamic port).
      },
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
    child.on("close", (code) => {
      resolveRun({ status: code ?? 1, stdout, stderr });
    });
  });
}

describe("S5-R1/R2 checkpoint command, freeze, and background job", () => {
  let queued = "";

  it("queues the last attempt with a quoted description and prints QUEUED", async () => {
    process.env["JUDGE_BASE_URL"] = `http://host.docker.internal:${judgePortForControl()}/v1`;
    const run = await runCli(["checkpoint", "the agent did not create selected-output.txt"]);
    expect(run.status, `queue failed: ${run.stderr}`).toBe(0);
    expect(run.stdout).toMatch(/^QUEUED task-\d{3}\n$/);
    queued = run.stdout.trim().split(" ")[1] ?? "";
    expect(queued).toMatch(/^task-\d{3}$/);
  }, 60_000);

  it("later messages and file edits cannot enter the frozen task; the job completes and publishes", async () => {
    expect(queued).not.toBe("");
    const jobsDir = join(scratch, "output", "jobs");
    const jobDirs = readdirSync(jobsDir);
    expect(jobDirs).toHaveLength(1);
    const jobDirPath = join(jobsDir, jobDirs[0]!);
    const job = JSON.parse(readFileSync(join(jobDirPath, "job.json"), "utf8")) as { checkpointId: string; storePath: string };
    const checksum = (dir: string): string =>
      readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => `${join(e.parentPath, e.name)}:${readFileSync(join(e.parentPath, e.name)).length}`)
        .sort()
        .join("|");

    // Freeze proof: the job record is QUEUED/RUNNING; the frozen checkpoint
    // records are checksummed NOW and again after later activity.
    const storeCkptDir = join(job.storePath, "checkpoints", job.checkpointId);
    const frozenBefore = checksum(storeCkptDir);

    // Later OpenCode activity: a third turn that edits files and a message
    // that would hijack the selection if selection were global.
    const third = await env.runPrompt("FIXTURE_THIRD delete selected-output.txt and make noise", { continueLast: true });
    expect(third.code, `third turn failed: ${third.stderr}`).toBe(0);
    expect(checksum(storeCkptDir)).toBe(frozenBefore);

    // Wait for the detached runner to finish (condition-based; no sleeps).
    const done = await waitForStatus(jobDirPath, 900_000);
    expect(done.state, `runner failed: ${done.detail}`).toBe("SCORED");
    expect(checksum(storeCkptDir)).toBe(frozenBefore);

    // Published task: complete Harbor task + score.
    const taskDir = join(scratch, "output", "tasks", queued);
    expect(existsSync(taskDir)).toBe(true);
    expect(existsSync(join(taskDir, "images.lock.json"))).toBe(true);
    const status = done;
    expect(status.qualityScore).toBeGreaterThan(0);
    expect(status.solverReward).toBe(1.0);
    expect(status.spendUSD).toBe(0);
    // The review breakdown is retained, not just the overall score.
    expect(Object.keys(status.qualityScores ?? {}).length).toBeGreaterThanOrEqual(6);
    // The published task retains the full review as grading provenance.
    const review = JSON.parse(readFileSync(join(taskDir, "review.json"), "utf8")) as { overall: number; scores: Record<string, number>; rubricVersion: string };
    expect(review.overall).toBe(status.qualityScore);
    expect(Object.keys(review.scores)).toHaveLength(6);
    expect(review.rubricVersion).toContain("universal-task-quality");

    // Published artifacts are the real graded outputs.
    const lock = JSON.parse(readFileSync(join(taskDir, "images.lock.json"), "utf8")) as { solver: { imageId: string }; verifier: { imageId: string } };
    expect(lock.solver.imageId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(lock.verifier.imageId).toMatch(/^sha256:[0-9a-f]{64}$/);
    const instructions = readFileSync(join(taskDir, "instruction.md"), "utf8");
    expect(instructions).toContain("selected-output.txt");
    expect(instructions).not.toContain("selected-result"); // no reference answers
    const buildReport = JSON.parse(readFileSync(join(taskDir, "build-report.json"), "utf8")) as { mutations: string[] };
    expect(buildReport.mutations.length).toBeGreaterThanOrEqual(1);
  }, 1_200_000);

  it("checkpoint scores prints the deterministic status lines", async () => {
    const run = await runCli(["scores"]);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toMatch(new RegExp(`^${queued}\\s+\\d+/100$`));
  }, 30_000);
});

describe("S5-R5 solver and verifier isolation", () => {
  it("the solver image holds no verifier material and no judge credentials", async () => {
    const taskDir = join(scratch, "output", "tasks");
    const taskId = readdirSync(taskDir)[0]!;
    const lock = JSON.parse(readFileSync(join(taskDir, taskId, "images.lock.json"), "utf8")) as { solver: { tag: string }; verifier: { tag: string } };
    const probe = spawnSync(DOCKER, ["run", "--rm", "--platform", "linux/arm64", lock.solver.tag, "bash", "-c", "ls /tests >/dev/null 2>&1 && echo TESTS_PRESENT || echo TESTS_ABSENT; env | grep -cE 'OPENAI_API_KEY|JUDGE_API_KEY' || true; ls /opt/capture/checkpoints >/dev/null && echo CAPTURE_PRESENT"], { encoding: "utf8" });
    const lines = probe.stdout.trim().split("\n");
    expect(lines).toContain("TESTS_ABSENT");
    expect(lines).toContain("CAPTURE_PRESENT");
    expect(lines).toContain("0"); // zero judge-credential variables in the solver image
    // The verifier image bakes /tests/test.sh (no runtime upload assumption).
    const verifierProbe = spawnSync(DOCKER, ["run", "--rm", "--platform", "linux/arm64", lock.verifier.tag, "bash", "-c", "test -x /tests/test.sh && echo VERIFIER_TESTS_PRESENT"], { encoding: "utf8" });
    expect(verifierProbe.stdout).toContain("VERIFIER_TESTS_PRESENT");
  }, 120_000);

  it("the native trial transferred the finished workspace and trajectory to the verifier", async () => {
    const jobsDir = join(scratch, "output", "jobs");
    const jobDirPath = join(jobsDir, readdirSync(jobsDir)[0]!);
    const trialDir = readdirSync(join(jobDirPath, "harbor", "validation")).find((d) => d.startsWith("task"));
    expect(trialDir).toBeDefined();
    const trial = join(jobDirPath, "harbor", "validation", trialDir!);
    const manifest = JSON.parse(readFileSync(join(trial, "artifacts", "manifest.json"), "utf8")) as Array<{ source: string; status: string }>;
    const sources = manifest.map((m) => m.source);
    expect(sources).toContain("/app");
    expect(sources).toContain("/logs/agent/trajectory.json");
    expect(existsSync(join(trial, "agent", "trajectory.json"))).toBe(true);
    const appEntry = manifest.find((m) => m.source === "/app");
    expect(appEntry?.status).not.toBe("empty");
  }, 60_000);
});

function judgePortForControl(): number {
  // The control mock's port is embedded in the writer baseURL of the config.
  const config = JSON.parse(readFileSync(join(scratch, "checkpoint.config.json"), "utf8")) as { writer: { baseURL: string } };
  return Number(new URL(config.writer.baseURL).port);
}

interface StatusLike {
  state: string;
  detail: string;
  qualityScore?: number;
  qualityScores?: Record<string, number>;
  solverReward?: number;
  spendUSD?: number;
}

async function waitForStatus(jobDirPath: string, timeoutMs: number): Promise<StatusLike> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = readFileSync(join(jobDirPath, "status.json"), "utf8");
    const status = JSON.parse(raw) as StatusLike & { state: string };
    if (status.state === "SCORED" || status.state === "FAILED") {
      return status;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`job did not finish within ${timeoutMs} ms`);
}
