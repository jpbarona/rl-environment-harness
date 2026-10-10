/**
 * S4-R3 e2e: real container portability proof.
 *
 * A real OpenCode capture store is exported with the package command, the
 * package is relocated to an independent directory tree, and Step 3's own
 * restore command runs against the package's capture directory in a fresh
 * container. The original store is never passed to the restore worker and
 * its checksums are unchanged before and after. Includes the ordinary
 * two-turn fixture, the truncation-artifact fixture (object inventory with
 * referenced artifacts), and the compaction fixture (compaction records).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createE2E, type E2EEnv } from "../../src/capture/e2e.js";
import { validatePackage } from "../../src/package/validate.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const packageCli = join(repoRoot, "dist", "package", "cli.js");
const restoreCli = join(repoRoot, "dist", "restore", "cli.js");
const IMAGE = "rl-restore:2.0.18";

let scratch: string;
let preExistingContainers: string[] = [];
let mainStore = "";
const storeChecksums = new Map<string, string>();

interface CliRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawn a CLI as an async child (spawnSync starves the vitest RPC loop). */
function runCli(cliPath: string, args: string[], timeoutMs: number): Promise<CliRun> {
  return new Promise((resolveRun) => {
    const child = spawn("node", [cliPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolveRun({ status: code ?? 1, stdout, stderr });
    });
  });
}

function checksumDir(dir: string): string {
  const parts: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        parts.push(`${createSha(full)}:${full}`);
      }
    }
  };
  walk(dir);
  return parts.join("\n");
}

function createSha(path: string): string {
  return spawnSync("shasum", ["-a", "256", path], { encoding: "utf8" }).stdout?.split(" ")[0] ?? "";
}

function assertNoLeakedContainers(): void {
  const ps = spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" });
  const current = (ps.stdout ?? "").split("\n").filter((n) => n.startsWith("restore-"));
  const newLeftovers = current.filter((n) => !preExistingContainers.includes(n));
  expect(newLeftovers, `leaked containers: ${newLeftovers.join(", ")}`).toEqual([]);
}

/** Real OpenCode capture fixture; returns store + selected checkpoint id. */
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

/** Export, relocate the package away from the store, and return both paths. */
async function exportAndRelocate(
  label: string,
  store: string,
  ckpt: string,
  verifier?: string,
): Promise<{ pkg: string; relocated: string; exportRun: CliRun }> {
  const exportRoot = join(scratch, `export-${label}`);
  const exportRun = await runCli(packageCli, [
    "--store", store, "--checkpoint", ckpt, "--output", exportRoot,
    ...(verifier !== undefined ? ["--verifier", verifier] : []),
  ], 60_000);
  const pkg = join(exportRoot, `task-${ckpt}`);
  expect(exportRun.status, `export failed: ${exportRun.stdout}\n${exportRun.stderr}`).toBe(0);
  expect(exportRun.stdout).toContain(`PACKAGE PASS: task=task-${ckpt}`);
  // Relocate: an independent directory tree with no reference to the store.
  const relocated = join(scratch, `relocated-${label}`, `task-${ckpt}`);
  cpSync(pkg, relocated, { recursive: true });
  expect(validatePackage(relocated).ok, `relocated package must validate: ${relocated}`).toBe(true);
  storeChecksums.set(label, checksumDir(store));
  return { pkg, relocated, exportRun };
}

async function restoreFromPackage(label: string, relocated: string, ckpt: string): Promise<CliRun & { outDir: string }> {
  const outDir = join(scratch, `run-${label}`);
  const run = await runCli(restoreCli, [
    "--store", join(relocated, "capture"),
    "--checkpoint", ckpt,
    "--output", outDir,
    "--reuse-image",
  ], 600_000);
  return { ...run, outDir };
}

beforeAll(async () => {
  const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  if (docker.status !== 0) {
    throw new Error("BLOCKED: Docker daemon unavailable for Step 4 e2e");
  }
  preExistingContainers = (spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" }).stdout ?? "")
    .split("\n").filter((n) => n.startsWith("restore-"));
  const have = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" });
  if (have.status !== 0) {
    const build = spawnSync("docker", ["build", "--platform", "linux/arm64", "-t", IMAGE, join(repoRoot, "containers", "restore")], { stdio: "inherit" });
    expect(build.status).toBe(0);
  }
  scratch = mkdtempSync(join(tmpdir(), "package-e2e-"));
}, 240_000);

describe("S4-R3 portability: ordinary two-turn fixture", () => {
  let ckpt = "";
  let relocated = "";

  beforeAll(async () => {
    const firstPrompt = "FIXTURE_FIRST change the starting files";
    const secondPrompt = "FIXTURE_SECOND create selected-output.txt with selected-result";
    const emitted = new Set<string>();
    const env: E2EEnv = await createE2E({ name: "package-fixture", captureDelayMs: 600,
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
    mainStore = join(env.runDir, "capture-store");
    ckpt = env.proxy.turns.get("turn-00000002")?.checkpointId ?? "";
    expect(ckpt).not.toBe("");
    const { relocated: rel } = await exportAndRelocate("main", mainStore, ckpt);
    relocated = rel;
  }, 360_000);

  it("restores from the relocated package with no access to the source store", async () => {
    const run = await restoreFromPackage("main", relocated, ckpt);
    expect(run.status, `restore failed: ${run.stdout}\n${run.stderr}`).toBe(0);
    const result = JSON.parse(readFileSync(join(run.outDir, "result.json"), "utf8")) as {
      status: string;
      checks: Array<{ check: string; ok: boolean }>;
    };
    expect(result.status).toBe("PASS");
    for (const name of ["selection.identity", "objects.verified", "workspace.tree", "session.seeded", "request.interception", "request.comparison", "outbound.inference-count"]) {
      expect(result.checks.find((c) => c.check === name)?.ok, name).toBe(true);
    }

    // S4-R1: instruction bytes preserved; the attempt suffix is absent from
    // the regenerated active input.
    expect(readFileSync(join(relocated, "instruction.md"), "utf8")).toBe("FIXTURE_SECOND create selected-output.txt with selected-result");
    const regenerated = JSON.parse(readFileSync(join(run.outDir, "regenerated-request.json"), "utf8")) as {
      body: { messages: Array<{ role: string; content: unknown }> };
    };
    const texts = JSON.stringify(regenerated.body.messages);
    expect(texts).toContain("FIXTURE_SECOND create selected-output.txt with selected-result");
    expect(texts).not.toContain("attempt-state");
    expect(texts).not.toContain("second-tool-start.txt");

    // S4-R5: the source store is unchanged after the restore as well.
    expect(checksumDir(mainStore)).toBe(storeChecksums.get("main"));
    assertNoLeakedContainers();
  }, 600_000);
});

describe("S4-R3 portability: truncation-artifact fixture", () => {
  it("exports referenced artifacts and restores them from the package", async () => {
    const { store, ckpt } = await captureFixture(
      "package-truncation",
      { name: "package-truncation", probe: { truncation: true, compaction: false } },
      [
        { text: "USE_TOOL_BIG write huge output" },
        { text: "one more turn please", continueLast: true },
      ],
    );
    const { relocated } = await exportAndRelocate("truncation", store, ckpt);
    // The inventory includes the referenced artifact objects.
    const metadata = JSON.parse(readFileSync(join(relocated, "capture", "metadata.json"), "utf8")) as {
      inventory: { objects: Array<{ sha256: string }> };
    };
    const references = JSON.parse(
      readFileSync(join(relocated, "capture", "checkpoints", ckpt, "referenced_artifacts.json"), "utf8"),
    ) as Array<{ sha256: string }>;
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(metadata.inventory.objects.some((o) => o.sha256 === reference.sha256), `artifact object ${reference.sha256} must be in the inventory`).toBe(true);
      expect(existsSync(join(relocated, "capture", "objects", reference.sha256))).toBe(true);
    }

    const run = await restoreFromPackage("truncation", relocated, ckpt);
    expect(run.status, `restore failed: ${run.stdout}\n${run.stderr}`).toBe(0);
    const result = JSON.parse(readFileSync(join(run.outDir, "result.json"), "utf8")) as {
      status: string;
      checks: Array<{ check: string; ok: boolean; detail: string }>;
    };
    expect(result.status).toBe("PASS");
    expect(result.checks.find((c) => c.check === "artifacts.materialized")?.ok).toBe(true);
    expect(result.checks.find((c) => c.check === "request.comparison")?.ok).toBe(true);
    expect(checksumDir(store)).toBe(storeChecksums.get("truncation"));
    assertNoLeakedContainers();
  }, 700_000);
});

describe("S4-R3 portability: compaction fixture", () => {
  it("exports compaction records and restores the compacted context from the package", async () => {
    const { store, ckpt } = await captureFixture(
      "package-compaction",
      { name: "package-compaction", probe: { compaction: true, truncation: false } },
      [
        { text: "FILL the context please" },
        { text: "and then reply briefly", continueLast: true },
      ],
    );
    const { relocated } = await exportAndRelocate("compaction", store, ckpt);
    // Compaction records are part of the package's capture records.
    expect(existsSync(join(relocated, "capture", "checkpoints", ckpt, "compaction.json"))).toBe(true);
    expect(existsSync(join(relocated, "capture", "checkpoints", ckpt, "compaction_requests.jsonl"))).toBe(true);

    const run = await restoreFromPackage("compaction", relocated, ckpt);
    expect(run.status, `restore failed: ${run.stdout}\n${run.stderr}`).toBe(0);
    const result = JSON.parse(readFileSync(join(run.outDir, "result.json"), "utf8")) as {
      status: string;
      checks: Array<{ check: string; ok: boolean }>;
    };
    expect(result.status).toBe("PASS");
    expect(result.checks.find((c) => c.check === "request.comparison")?.ok).toBe(true);
    const regenerated = JSON.parse(readFileSync(join(run.outDir, "regenerated-request.json"), "utf8")) as {
      body: { messages: Array<{ role: string; content: string }> };
    };
    expect(JSON.stringify(regenerated.body.messages)).toContain("COMPACTION-SUMMARY-MARKER-424242");
    expect(checksumDir(store)).toBe(storeChecksums.get("compaction"));
    assertNoLeakedContainers();
  }, 700_000);
});

describe("S4-R5 export failure reporting", () => {
  it("fails with a report and no published package on an invalid checkpoint", async () => {
    const exportRoot = join(scratch, "export-failure");
    const run = await runCli(packageCli, [
      "--store", mainStore,
      "--checkpoint", "ckpt-nope",
      "--output", exportRoot,
    ], 60_000);
    expect(run.status).not.toBe(0);
    const report = JSON.parse(readFileSync(join(exportRoot, "result.json"), "utf8")) as {
      status: string;
      checks: Array<{ check: string; ok: boolean; detail: string }>;
    };
    expect(report.status).toBe("FAIL");
    expect(report.checks.some((c) => c.check === "selection.checkpoint-missing" && !c.ok)).toBe(true);
    expect(existsSync(join(exportRoot, "task-ckpt-nope"))).toBe(false);
  }, 120_000);
});
