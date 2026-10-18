/**
 * OPT-IN live checkpoint workflow (S5-R7 real-provider evidence).
 *
 * NOT part of any default verification. Run manually:
 *   set -a && source .env && set +a && npm run -s build && \
 *   npx vitest run tests/live/checkpoint.live.test.ts
 *
 * The aggregate model-spend cap is $0.20 per checkpoint. This test selects
 * ONLY zero-priced tool-capable catalog models for the writer, reviewer,
 * judge, and solver, enforces the cap in the runner (it fails the job rather
 * than exceeding it), and refuses a credential whose account limit exceeds
 * $0.20. No paid fallback exists. A missing key is an error, not a skip.
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
const CAP_USD = 0.20;

let env: E2EEnv;
let scratch = "";
const cleanups: Array<() => Promise<void>> = [];

interface CatalogModel {
  readonly id: string;
  readonly pricing: Record<string, string>;
  readonly supported_parameters?: string[];
}

async function selectFreeToolModel(): Promise<string> {
  const key = process.env["OPENROUTER_API_KEY"];
  if (!key) {
    throw new Error("Set OPENROUTER_API_KEY for this opt-in test; never put it in a source file.");
  }
  const keyInfo = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000),
  });
  if (!keyInfo.ok) {
    throw new Error(`key validation failed: ${keyInfo.status}`);
  }
  const keyData = await keyInfo.json() as { data: { limit: number | null } };
  if (typeof keyData.data.limit !== "number" || keyData.data.limit < 0 || keyData.data.limit > CAP_USD) {
    throw new Error(`use a dedicated key with a spending limit of $${CAP_USD.toFixed(2)} or less`);
  }
  const catalog = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(20_000) });
  if (!catalog.ok) {
    throw new Error(`model catalog unavailable: ${catalog.status}`);
  }
  const { data } = await catalog.json() as { data: CatalogModel[] };
  const eligible = data
    .filter((m) => m.id.endsWith(":free") && m.supported_parameters?.includes("tools"))
    .filter((m) => Object.keys(m.pricing).length > 0 && Object.values(m.pricing).every((v) => Number(v) === 0));
  const preferred = process.env["LIVE_MODEL"];
  const model = preferred
    ? eligible.find((m) => m.id === preferred)
    : eligible.find((m) => /qwen.*coder/i.test(m.id)) ?? eligible.find((m) => /nemotron/i.test(m.id)) ?? eligible[0];
  if (!model) {
    throw new Error("no eligible zero-cost tool model; paid fallback is forbidden");
  }
  return model.id;
}

beforeAll(async () => {
  const docker = spawnSync(DOCKER, ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  if (docker.status !== 0) {
    throw new Error("BLOCKED: Docker daemon unavailable for the live checkpoint test");
  }
  scratch = join(repoRoot, "work", "live-checkpoint");
  mkdirSync(scratch, { recursive: true });
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups) {
    await fn();
  }
});

describe("opt-in live checkpoint workflow (real provider, $0 target)", () => {
  it("runs the full pipeline against OpenRouter free models within the $0.20 cap", async () => {
    const modelId = await selectFreeToolModel();
    const openrouter = "https://openrouter.ai/api/v1";
    const judgeEnv: Record<string, string> = { OPENROUTER_API_KEY: "OPENROUTER_API_KEY" };

    // Real capture: two turns with the selected free model.
    const firstPrompt = "LIVE_FIRST replace the notes version";
    const secondPrompt = "LIVE_SECOND create result.txt containing live-ok";
    const emitted = new Set<string>();
    env = await createE2E({ name: "live-checkpoint", captureDelayMs: 600,
      live: { upstreamURL: openrouter, model: modelId, apiKey: process.env["OPENROUTER_API_KEY"] ?? "" },
      script: ({ model, lastUserText }) => {
        if (model !== modelId && !model.endsWith(modelId.split("/").pop() ?? "")) return undefined;
        if (emitted.has(lastUserText)) return { content: "done" };
        let command: string;
        if (lastUserText.includes(firstPrompt)) {
          command = "printf 'live-2\\n' > notes.md";
        } else if (lastUserText.includes(secondPrompt)) {
          command = "printf 'live-ok' > result.txt";
        } else return { content: "done" };
        emitted.add(lastUserText);
        return { toolCalls: [{ id: `call_${emitted.size}`, name: "shell", args: { command, description: "live fixture step" } }] };
      },
    });
    cleanups.push(env.cleanup);
    const r1 = await env.runPrompt(firstPrompt);
    expect(r1.code, `live capture run 1 failed: ${r1.stderr}`).toBe(0);
    const r2 = await env.runPrompt(secondPrompt, { continueLast: true });
    expect(r2.code, `live capture run 2 failed: ${r2.stderr}`).toBe(0);

    // Solver mock is NOT used in the live path: the replay calls OpenRouter.
    const noopSolver = new MockModelServer((() => ({ content: "unused" })) as MockScript);
    const solverLocal = await noopSolver.start();
    cleanups.push(() => noopSolver.stop());
    void solverLocal;

    writeFileSync(join(scratch, "checkpoint.config.json"), `${JSON.stringify({
      storePath: join(env.runDir, "capture-store"),
      outputDir: join(scratch, "output"),
      jobsDir: join(scratch, "output", "jobs"),
      captureServiceURL: env.proxy.url,
      writer: { baseURL: openrouter, model: modelId, apiKeyEnv: "OPENROUTER_API_KEY", maxOutputTokens: 4096 },
      reviewer: { baseURL: openrouter, model: modelId, apiKeyEnv: "OPENROUTER_API_KEY", maxOutputTokens: 2048 },
      judgeModel: `openrouter/${modelId}`,
      solver: { baseURL: openrouter, model: "unused-captured-id-wins", apiKeyEnv: "OPENROUTER_API_KEY", providerName: "openrouter", maxOutputTokens: 2048 },
      verifierEnv: judgeEnv,
      credentials: {},
      modelSpendCapUSD: CAP_USD,
    }, null, 2)}\n`);

    const run = await new Promise<{ status: number; stdout: string; stderr: string }>((resolveRun) => {
      const child = spawn("node", [cli, "checkpoint", "the live agent did not create result.txt"], {
        env: { ...process.env, PATH: HOST_PATH, CHECKPOINT_CONFIG: join(scratch, "checkpoint.config.json") },
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
    expect(run.status, run.stderr).toBe(0);
    const taskId = run.stdout.trim().split(" ")[1] ?? "";
    expect(taskId).toMatch(/^task-\d{3}$/);

    const jobsDir = join(scratch, "output", "jobs");
    const jobDirPath = join(jobsDir, readdirSync(jobsDir)[0]!);
    const deadline = Date.now() + 3_600_000;
    let status: { state: string; detail: string; qualityScore?: number; spendUSD?: number } | undefined;
    while (Date.now() < deadline) {
      const raw = readFileSync(join(jobDirPath, "status.json"), "utf8");
      status = JSON.parse(raw) as typeof status;
      if (status!.state === "SCORED" || status!.state === "FAILED") {
        break;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    expect(status?.state, `live job detail: ${status?.detail}`).toBe("SCORED");
    expect(status?.qualityScore).toBeGreaterThan(0);
    expect(status?.spendUSD ?? 0).toBeLessThanOrEqual(CAP_USD);
    expect(existsSync(join(scratch, "output", "tasks", taskId, "images.lock.json"))).toBe(true);
    writeFileSync(join(jobDirPath, "live-result.json"), `${JSON.stringify({
      status: "PASS", taskId, model: modelId, capUSD: CAP_USD,
      spendUSD: status?.spendUSD ?? 0, evidence: jobDirPath,
    }, null, 2)}\n`);
  }, 3_600_000);
});
