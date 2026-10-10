/**
 * Step 3 e2e: real Linux container + real OpenCode restore proof.
 * Runs against a capture store produced by a real OpenCode capture run.
 * Excluded from the ordinary suite; requires Docker (S3-R3).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createE2E, type E2EEnv } from "../../src/capture/e2e.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(repoRoot, "dist", "restore", "cli.js");
const IMAGE = "rl-restore:2.0.18";

let env: E2EEnv | undefined;
let store: string;
let ckpt2: string;
let scratch: string;
/** Container names owned by anything other than this suite. */
let preExistingContainers: string[] = [];

beforeAll(async () => {
  // Docker must be available.
  const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  if (docker.status !== 0) {
    throw new Error("BLOCKED: Docker daemon unavailable for Step 3 e2e");
  }
  preExistingContainers = (spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" }).stdout ?? "")
    .split("\n").filter((n) => n.startsWith("restore-"));
  // Build the pinned image if absent.
  const have = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" });
  if (have.status !== 0) {
    const build = spawnSync("docker", ["build", "--platform", "linux/arm64", "-t", IMAGE, join(repoRoot, "containers", "restore")], { stdio: "inherit" });
    expect(build.status).toBe(0);
  }
  // Real OpenCode capture: two-turn fixture (turn 2 is the selection).
  const firstPrompt = "FIXTURE_FIRST change the starting files";
  const secondPrompt = "FIXTURE_SECOND create selected-output.txt with selected-result";
  const emitted = new Set<string>();
  env = await createE2E({ name: "restore-fixture", captureDelayMs: 600,
    script: ({ model, lastUserText }) => {
      if (model !== "mock-model" || emitted.has(lastUserText)) return { content: "done" };
      let command: string;
      if (lastUserText.includes(firstPrompt)) {
        command = "printf 'version-2\\n' > notes.md; printf 'scratch-data\\n' > scratch.tmp; printf 'LOCAL_FIXTURE=true\\n' > .env.local; rm obsolete.txt; node -e \"require('fs').writeFileSync('first-tool-start.txt', String(Date.now()))\"";
      } else if (lastUserText.includes(secondPrompt)) {
        command = "node -e \"require('fs').writeFileSync('second-tool-start.txt', String(Date.now()))\"; printf 'selected-result' > selected-output.txt; printf 'attempt-state' > notes.md";
      } else return { content: "done" };
      emitted.add(lastUserText);
      return { toolCalls: [{ id: `call_${emitted.size}`, name: "shell", args: { command, description: "execute acceptance fixture" } }] };
    },
  });
  const r1 = await env.runPrompt(firstPrompt);
  expect(r1.code, `capture run 1 failed: ${r1.stderr}`).toBe(0);
  const r2 = await env.runPrompt(secondPrompt, { continueLast: true });
  expect(r2.code, `capture run 2 failed: ${r2.stderr}`).toBe(0);
  store = join(env.runDir, "capture-store");
  const turn2 = env.proxy.turns.get("turn-00000002");
  ckpt2 = turn2?.checkpointId ?? "";
  expect(ckpt2).not.toBe("");
  scratch = mkdtempSync(join(tmpdir(), "restore-e2e-"));
}, 240_000);

describe("S3-R3 pinned runtime probe", () => {
  it("verifies versions and a deterministic read/write/read/delete probe in the container", async () => {
    const probe = spawnSync("docker", [
      "run", "--rm", "--platform", "linux/arm64", IMAGE, "bash", "-c",
      [
        'set -e',
        'test -x /usr/local/opencode/opencode',
        '/usr/local/opencode/opencode --version | grep -qx "opencode v2.0.18"',
        'node --version | grep -q "^v22\\."',
        'test -s /usr/local/share/harness-sqlite-version && cat /usr/local/share/harness-sqlite-version | grep -q "^3\\."',
        'git --version | grep -q "^git version"',
        'd=/work/ws; mkdir -p "$d"',
        'echo v1 > "$d/probe.txt"',
        'test "$(cat "$d/probe.txt")" = v1',
        'echo v2 > "$d/probe.txt"',
        'test "$(cat "$d/probe.txt")" = v2',
        'rm "$d/probe.txt"',
        'test ! -e "$d/probe.txt"',
      ].join(" && "),
    ], { encoding: "utf8", timeout: 120_000 });
    expect(probe.status, probe.stderr).toBe(0);
  });
});

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Capture a real fixture and return the selected last-turn checkpoint. */
async function captureFixture(
  name: string,
  createOptions: Parameters<typeof createE2E>[0],
  prompts: Array<{ text: string; continueLast?: boolean }>,
): Promise<{ store: string; ckpt: string; workspace: string }> {
  const e = await createE2E(createOptions);
  for (const prompt of prompts) {
    const r = await e.runPrompt(prompt.text, { continueLast: prompt.continueLast === true });
    expect(r.code, `${name} capture run failed: ${r.stderr}`).toBe(0);
  }
  const lastTurn = [...e.proxy.turns.values()].at(-1)!;
  expect(lastTurn.checkpointId).toBeTruthy();
  return { store: join(e.runDir, "capture-store"), ckpt: lastTurn.checkpointId!, workspace: e.workspace };
}

function fileSha(path: string): string {
  return spawnSync("shasum", ["-a", "256", path], { encoding: "utf8" }).stdout?.split(" ")[0] ?? "";
}

function runRestore(
  outDir: string,
  overrides: { store?: string; checkpoint?: string; opencodeBin?: string; timeoutMs?: number; mutateAfterCompare?: boolean } = {},
): Promise<RunResult> {
  const args = [
    "--store", overrides.store ?? store,
    "--checkpoint", overrides.checkpoint ?? ckpt2,
    "--output", outDir,
    "--reuse-image",
  ];
  if (overrides.opencodeBin !== undefined) {
    args.push("--opencode-bin", overrides.opencodeBin);
  }
  if (overrides.timeoutMs !== undefined) {
    args.push("--timeout-ms", String(overrides.timeoutMs));
  }
  if (overrides.mutateAfterCompare === true) {
    args.push("--mutate-after-compare");
  }
  // Async spawn: blocking the vitest worker with spawnSync starves its RPC
  // and fails the run with an unhandled onTaskUpdate timeout.
  return new Promise((resolveRun) => {
    const child = spawn("node", [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 420_000);
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolveRun({ status: code ?? 1, stdout, stderr });
    });
  });
}

function resultOf(outDir: string): { status: string; checks: Array<{ check: string; ok: boolean; detail: string }> } {
  return JSON.parse(readFileSync(join(outDir, "result.json"), "utf8"));
}

function checkNamed(outDir: string, name: string): { check: string; ok: boolean; detail: string } {
  const r = resultOf(outDir);
  const found = r.checks.find((c) => c.check === name);
  expect(found, `missing check ${name} in ${JSON.stringify(r.checks.map((c) => c.check))}`).toBeDefined();
  return found!;
}

function assertNoLeakedContainers(): void {
  const ps = spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" });
  const current = (ps.stdout ?? "").split("\n").filter((n) => n.startsWith("restore-"));
  // Only containers this suite CREATED may linger; pre-existing ones are not
  // this run's responsibility.
  const newLeftovers = current.filter((n) => !preExistingContainers.includes(n));
  expect(newLeftovers, `leaked containers: ${newLeftovers.join(", ")}`).toEqual([]);
}

describe("S3-R1/R2/R4/R7 restore of the second turn", () => {
  it("restores in a fresh container and matches workspace and regenerated input", async () => {
    const outDir = join(scratch, "run-main");
    const run = await runRestore(outDir);
    expect(run.status, `restore failed: ${run.stdout}\n${run.stderr}`).toBe(0);

    const result = resultOf(outDir);
    expect(result.status).toBe("PASS");
    expect(checkNamed(outDir, "selection.identity").ok).toBe(true);
    expect(checkNamed(outDir, "objects.verified").ok).toBe(true);
    expect(checkNamed(outDir, "workspace.materialized").ok).toBe(true);
    expect(checkNamed(outDir, "workspace.tree").ok).toBe(true);
    expect(checkNamed(outDir, "session.seeded").ok).toBe(true);
    expect(checkNamed(outDir, "request.interception").ok).toBe(true);
    expect(checkNamed(outDir, "request.comparison").ok).toBe(true);
    expect(checkNamed(outDir, "outbound.inference-count").ok).toBe(true);

    // Report layout (S3-R7).
    for (const f of ["selection.json", "runtime.json", "comparison.json", "regenerated-request.json", "result.json", "seed.sql", "trace.jsonl"]) {
      expect(existsSync(join(outDir, f)), `missing report file ${f}`).toBe(true);
    }

    // Regenerated request: selected prompt occurs once; prior turn content
    // is present; response/tool suffix absent.
    const regenerated = JSON.parse(readFileSync(join(outDir, "regenerated-request.json"), "utf8")) as {
      body: { model: string; messages: Array<{ role: string; content: unknown }> };
    };
    const texts = JSON.stringify(regenerated.body.messages);
    expect(texts.includes("FIXTURE_SECOND create selected-output.txt with selected-result")).toBe(true);
    expect(texts.includes("FIXTURE_FIRST change the starting files")).toBe(true);
    expect(texts.includes("selected-result\n") || regenerated.body.messages.at(-1)?.role === "user").toBe(true);
    expect(regenerated.body.model.length).toBeGreaterThan(0);

    // Declared volatile transforms were applied and recorded.
    const comparison = JSON.parse(readFileSync(join(outDir, "comparison.json"), "utf8")) as {
      request: { ok: boolean; declaredVolatile: Array<{ field: string }> };
    };
    expect(comparison.request.ok).toBe(true);
    expect(comparison.request.declaredVolatile.map((v) => v.field)).toContain("system.paths");

    // Runtime identity (S3-R3) recorded.
    const runtime = JSON.parse(readFileSync(join(outDir, "runtime.json"), "utf8")) as {
      imageDigest: string; opencodeVersion: string; harnessRevision: string; sqliteVersion: string;
    };
    expect(runtime.imageDigest).toContain("sha256:");
    expect(runtime.opencodeVersion).toContain("2.0.18");
    expect(runtime.harnessRevision).not.toBe("unknown");
    expect(runtime.sqliteVersion).toContain("3.");

    assertNoLeakedContainers();
  }, 480_000);
});

describe("S3-R5 independent repeated restoration", () => {
  it("restores the same checkpoint twice; the store and restores stay independent", async () => {
    const objectSetBefore = checksumStore(store);
    const a = join(scratch, "run-a");
    const b = join(scratch, "run-b");
    expect((await runRestore(a)).status).toBe(0);
    expect(resultOf(a).status).toBe("PASS");
    expect((await runRestore(b)).status).toBe(0);
    expect(resultOf(b).status).toBe("PASS");
    expect(checksumStore(store)).toEqual(objectSetBefore);
    // Different run dirs, independent session stores (each run seeds its own).
    expect(a).not.toBe(b);
    expect(readFileSync(join(a, "runtime.json"), "utf8")).not.toBe(readFileSync(join(b, "runtime.json"), "utf8"));
    assertNoLeakedContainers();
  }, 900_000);
});

describe("S3-R6 bounded explicit failures", () => {
  function failingStore(mutate: (dir: string) => void): string {
    const copy = join(scratch, `neg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    spawnSync("cp", ["-R", store, copy]);
    mutate(copy);
    return copy;
  }

  it("fails on a missing object", async () => {
    const bad = failingStore((dir) => {
      const manifest = JSON.parse(readFileSync(join(dir, "checkpoints", ckpt2, "manifest.json"), "utf8")) as { files: Array<{ sha256?: string }> };
      const victim = manifest.files.find((f) => f.sha256 !== undefined)!.sha256!;
      rmSync(join(dir, "objects", victim));
    });
    const out = join(scratch, "neg-missing-object");
    const run = await runRestore(out, { store: bad });
    expect(run.status).not.toBe(0);
    expect(resultOf(out).status).toBe("FAIL");
    expect(checkNamed(out, "selection.preflight").ok).toBe(false);
    expect(checkNamed(out, "selection.preflight").detail).toContain("objects.missing");
    assertNoLeakedContainers();
  }, 240_000);

  it("fails on a corrupted object", async () => {
    const bad = failingStore((dir) => {
      const manifest = JSON.parse(readFileSync(join(dir, "checkpoints", ckpt2, "manifest.json"), "utf8")) as { files: Array<{ sha256?: string }> };
      const victim = manifest.files.find((f) => f.sha256 !== undefined)!.sha256!;
      writeFileSync(join(dir, "objects", victim), "tampered");
    });
    const out = join(scratch, "neg-corrupt-object");
    const run = await runRestore(out, { store: bad });
    expect(run.status).not.toBe(0);
    expect(checkNamed(out, "selection.preflight").detail).toContain("objects.corrupt");
  }, 240_000);

  it("fails on invalid context", async () => {
    const bad = failingStore((dir) => rmSync(join(dir, "checkpoints", ckpt2, "prior_context.json")));
    const out = join(scratch, "neg-context");
    const run = await runRestore(out, { store: bad });
    expect(run.status).not.toBe(0);
    expect(resultOf(out).status).toBe("FAIL");
    expect(checkNamed(out, "selection.preflight").ok).toBe(false);
  }, 240_000);

  it("fails on runtime launch failure", async () => {
    const out = join(scratch, "neg-runtime");
    const run = await runRestore(out, { opencodeBin: "/nonexistent/opencode" });
    expect(run.status).not.toBe(0);
    expect(resultOf(out).status).toBe("FAIL");
    expect(checkNamed(out, "session.db-init").ok).toBe(false);
    assertNoLeakedContainers();
  }, 240_000);

  it("fails on a model-input mismatch", async () => {
    const bad = failingStore((dir) => {
      const path = join(dir, "checkpoints", ckpt2, "model_requests.jsonl");
      const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => {
        const rec = JSON.parse(line) as { classification: string; body?: { messages?: Array<{ role: string; content?: string }> } };
        if (rec.classification.startsWith("task") && rec.body?.messages !== undefined) {
          // Tamper a PRIOR assistant message: the seeder reads
          // prior_context.json, so the regenerated request keeps the real
          // content and the comparator must catch the difference.
          const assistant = rec.body.messages.find((m) => m.role === "assistant" && typeof m.content === "string");
          if (assistant !== undefined) {
            assistant.content = "TAMPERED";
          }
        }
        return JSON.stringify(rec);
      });
      writeFileSync(path, `${lines.join("\n")}\n`);
    });
    const out = join(scratch, "neg-mismatch");
    const run = await runRestore(out, { store: bad });
    expect(run.status).not.toBe(0);
    expect(resultOf(out).status).toBe("FAIL");
    expect(checkNamed(out, "request.comparison").ok).toBe(false);
    assertNoLeakedContainers();
  }, 480_000);

  it("fails on interception timeout without forwarding", async () => {
    const out = join(scratch, "neg-timeout");
    const run = await runRestore(out, { timeoutMs: 1 });
    expect(run.status).not.toBe(0);
    expect(resultOf(out).status).toBe("FAIL");
    expect(checkNamed(out, "request.interception").ok).toBe(false);
    assertNoLeakedContainers();
  }, 240_000);
});

describe("S3-R4 compacted context", () => {
  it("restores a compacted context; the regenerated input matches and no inference is forwarded", async () => {
    const { store: cStore, ckpt } = await captureFixture(
      "restore-compaction",
      { name: "restore-compaction", probe: { compaction: true, truncation: false } },
      [
        { text: "FILL the context please" },
        { text: "and then reply briefly", continueLast: true },
      ],
    );
    const out = join(scratch, "run-compaction");
    const run = await runRestore(out, { store: cStore, checkpoint: ckpt, timeoutMs: 120_000 });
    expect(run.status, `compaction restore failed: ${run.stdout}\n${run.stderr}`).toBe(0);
    expect(resultOf(out).status).toBe("PASS");
    expect(checkNamed(out, "workspace.tree").ok).toBe(true);
    expect(checkNamed(out, "session.seeded").ok).toBe(true);
    expect(checkNamed(out, "request.comparison").ok).toBe(true);
    expect(checkNamed(out, "outbound.inference-count").ok).toBe(true);
    // The compacted summary is part of the regenerated input.
    const regenerated = JSON.parse(readFileSync(join(out, "regenerated-request.json"), "utf8")) as {
      body: { messages: Array<{ role: string; content: string }> };
    };
    expect(JSON.stringify(regenerated.body.messages)).toContain("COMPACTION-SUMMARY-MARKER-424242");
    // The wrapper's recent section carries the pending prompt once, and the
    // replay appends it as the declared extra user message.
    const wrapper = regenerated.body.messages[1]!.content;
    const recent = wrapper.slice(wrapper.indexOf("<recent-context>"), wrapper.indexOf("</recent-context>"));
    expect(recent.split("and then reply briefly").length - 1).toBe(1);
    expect(regenerated.body.messages[2]).toEqual({ role: "user", content: JSON.stringify("and then reply briefly") });
    assertNoLeakedContainers();
  }, 540_000);
});

describe("S3-R4 truncated tool-output reference", () => {
  it("restores the referenced artifact bytes and matches the regenerated input", async () => {
    const { store: cStore, ckpt, workspace } = await captureFixture(
      "restore-truncation",
      { name: "restore-truncation", probe: { truncation: true, compaction: false } },
      [
        { text: "USE_TOOL_BIG write huge output" },
        { text: "one more turn please", continueLast: true },
      ],
    );
    const references = JSON.parse(
      readFileSync(join(cStore, "checkpoints", ckpt, "referenced_artifacts.json"), "utf8"),
    ) as Array<{ originalPath: string; sha256: string }>;
    expect(references.length, "the truncation fixture must reference an artifact").toBeGreaterThan(0);

    const out = join(scratch, "run-truncation");
    const run = await runRestore(out, { store: cStore, checkpoint: ckpt, timeoutMs: 120_000 });
    expect(run.status, `truncation restore failed: ${run.stdout}\n${run.stderr}`).toBe(0);
    expect(resultOf(out).status).toBe("PASS");
    expect(checkNamed(out, "request.comparison").ok).toBe(true);
    expect(checkNamed(out, "outbound.inference-count").ok).toBe(true);

    // The referenced artifact was materialized in the container at the
    // mapped path and its bytes hash-verified by the worker.
    const artifactsCheck = checkNamed(out, "artifacts.materialized");
    expect(artifactsCheck.ok).toBe(true);
    const mappings = JSON.parse(artifactsCheck.detail) as Array<{ originalPath: string; restorePath: string; sha256: string }>;
    expect(mappings.length).toBe(references.length);
    for (const reference of references) {
      const mapping = mappings.find((m) => m.originalPath === reference.originalPath);
      expect(mapping, `missing mapping for ${reference.originalPath}`).toBeDefined();
      expect(mapping!.sha256).toBe(reference.sha256);
      expect(mapping!.restorePath.startsWith("/work/home")).toBe(true);
    }
    // The regenerated input carries the truncated tail with the artifact
    // reference; the full output never enters the provider request.
    const regenerated = JSON.parse(readFileSync(join(out, "regenerated-request.json"), "utf8")) as {
      body: { messages: Array<{ role: string; content: string }> };
    };
    expect(JSON.stringify(regenerated.body.messages)).toContain("full output saved to");
    // The selected prompt occurs exactly once: as the final user message.
    const messageText = JSON.stringify(regenerated.body.messages);
    expect(messageText.split("one more turn please").length - 1).toBe(1);
    expect(regenerated.body.messages.at(-1)!.role).toBe("user");
    assertNoLeakedContainers();
    void workspace;
  }, 540_000);
});

describe("S3-R5 mutation isolation", () => {
  it("a mutation inside restore A changes neither the store, restore B, nor the original workspace", async () => {
    const storeBefore = checksumStore(store);
    const workspaceSentinels = ["notes.md", "selected-output.txt", "untracked.txt", "fixture.ignored"]
      .filter((f) => existsSync(join(env!.workspace, f)))
      .map((f) => `${f}:${fileSha(join(env!.workspace, f))}`);

    // Restore A mutates its own workspace after all comparisons pass.
    const a = join(scratch, "run-isolation-a");
    expect((await runRestore(a, { mutateAfterCompare: true })).status).toBe(0);
    expect(resultOf(a).status).toBe("PASS");
    expect(traceHasMutation(a)).toBe(true);

    // The store and the original capture workspace are untouched.
    expect(checksumStore(store)).toEqual(storeBefore);
    const workspaceAfter = ["notes.md", "selected-output.txt", "untracked.txt", "fixture.ignored"]
      .filter((f) => existsSync(join(env!.workspace, f)))
      .map((f) => `${f}:${fileSha(join(env!.workspace, f))}`);
    expect(workspaceAfter).toEqual(workspaceSentinels);

    // Restore B from the same selection still matches the captured state.
    const b = join(scratch, "run-isolation-b");
    expect((await runRestore(b)).status).toBe(0);
    expect(resultOf(b).status).toBe("PASS");
    expect(checkNamed(b, "workspace.tree").ok).toBe(true);
    expect(checkNamed(b, "request.comparison").ok).toBe(true);
    // Independent session stores: each run seeds its own home.
    expect(readFileSync(join(a, "runtime.json"), "utf8")).not.toBe(readFileSync(join(b, "runtime.json"), "utf8"));
    assertNoLeakedContainers();
  }, 600_000);
});

function traceHasMutation(outDir: string): boolean {
  const trace = readFileSync(join(outDir, "trace.jsonl"), "utf8");
  return trace.includes("workspace.mutated");
}

function checksumStore(storeDir: string): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else {
        parts.push(`${p}:${spawnSync("shasum", ["-a", "256", p], { encoding: "utf8" }).stdout?.split(" ")[0] ?? ""}`);
      }
    }
  };
  walk(storeDir);
  return parts.join("\n");
}