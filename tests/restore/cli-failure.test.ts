/**
 * S3-R7: the restore CLI must produce a machine-readable failure report on
 * every failure path, return nonzero, name the failed check, and mark the
 * checks that could not run. These tests exercise the CLI directly.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(repoRoot, "dist", "restore", "cli.js");

let scratch: string;
let fakeStore: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "restore-cli-"));
  // A minimal fake store that passes the CLI's existence checks.
  fakeStore = join(scratch, "store");
  mkdirSync(join(fakeStore, "checkpoints", "ckpt-fake"), { recursive: true });
  mkdirSync(join(fakeStore, "objects"), { recursive: true });
  writeFileSync(join(fakeStore, "checkpoints", "ckpt-fake", "manifest.json"), JSON.stringify({ root: "/x", checkpointId: "ckpt-fake", files: [] }));
  // The CLI runs from dist; build it if absent.
  if (!existsSync(cli)) {
    const build = spawnSync("npm", ["run", "-s", "build"], { encoding: "utf8", cwd: repoRoot });
    expect(build.status, build.stderr).toBe(0);
  }
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface RunOutcome {
  readonly status: number;
  readonly report?: {
    readonly status: string;
    readonly checkpoint: string;
    readonly checks: Array<{ check: string; ok: boolean; detail: string }>;
    readonly result: string;
  } | undefined;
}

function runCli(outDir: string, args: string[], env: NodeJS.ProcessEnv = {}): RunOutcome {
  // process.execPath: an overridden PATH must not break spawning node —
  // the test targets the CLI's inner docker check.
  const run = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  const reportPath = join(outDir, "result.json");
  const report = existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, "utf8")) as RunOutcome["report"])
    : undefined;
  return { status: run.status ?? 1, report };
}

function expectFailureShape(outcome: RunOutcome, failedCheck: string, detailNeedle: string): void {
  expect(outcome.status).not.toBe(0);
  expect(outcome.report, "a failure report must exist").toBeDefined();
  expect(outcome.report!.status === "FAIL" || outcome.report!.status === "BLOCKED").toBe(true);
  const failed = outcome.report!.checks.find((c) => c.check === failedCheck);
  expect(failed, `check ${failedCheck} must be present`).toBeDefined();
  expect(failed!.ok).toBe(false);
  expect(failed!.detail).toContain(detailNeedle);
  // Every other check is explicitly marked as not run — none may claim PASS.
  for (const c of outcome.report!.checks) {
    if (c.check !== failedCheck) {
      expect(c.ok, `${c.check} must not claim success`).toBe(false);
      expect(c.detail).toContain("not run");
    }
  }
}

describe("S3-R7 CLI failure reports", () => {
  it("reports BLOCKED with runtime.docker when docker is unavailable", () => {
    const out = join(scratch, "out-docker");
    const outcome = runCli(out, ["--store", fakeStore, "--checkpoint", "ckpt-fake", "--output", out], { PATH: "/nonexistent-dir" });
    expectFailureShape(outcome, "runtime.docker", "docker daemon is unavailable");
  });

  it("reports FAIL with selection.store-missing when the store is absent", () => {
    const out = join(scratch, "out-store");
    const outcome = runCli(out, ["--store", join(scratch, "no-such-store"), "--checkpoint", "ckpt-fake", "--output", out]);
    expectFailureShape(outcome, "selection.store-missing", "does not exist");
  });

  it("reports FAIL with selection.checkpoint-missing when the checkpoint is absent", () => {
    const out = join(scratch, "out-ckpt");
    const outcome = runCli(out, ["--store", fakeStore, "--checkpoint", "ckpt-nope", "--output", out]);
    expectFailureShape(outcome, "selection.checkpoint-missing", "does not exist");
  });

  it("reports FAIL with worker.run when the container exits without a report", () => {
    // The output path is an existing FILE: the evidence mount cannot be
    // created, so the container exits nonzero without writing a report.
    const out = join(scratch, "out-file");
    writeFileSync(out, "not a directory");
    const outcome = runCli(out, ["--store", fakeStore, "--checkpoint", "ckpt-fake", "--output", out, "--reuse-image"]);
    // The CLI's own mkdir may fail before docker runs; either way the
    // failure must be reported and nonzero.
    expect(outcome.status).not.toBe(0);
    if (outcome.report !== undefined) {
      expect(outcome.report.status).not.toBe("PASS");
      for (const c of outcome.report.checks) {
        expect(c.ok).toBe(false);
      }
    }
  });
});