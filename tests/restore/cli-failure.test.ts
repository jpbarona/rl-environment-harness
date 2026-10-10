/**
 * S3-R7: the restore CLI must produce a machine-readable failure report on
 * every failure path, return nonzero, name the failed check, and mark the
 * checks that could not run. These tests exercise the CLI directly.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // Always test the current source build, never stale compiled code.
  {
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

  it.each([ ["build", "runtime.image-build"], ["run", "worker.run"] ])("reports a %s infrastructure failure with complete evidence", (failure, check) => {
    // Deterministic engine-failure injection. Real OpenCode/container
    // restoration remains covered by the separate container suite.
    const bin = join(scratch, `engine-${failure}`);
    mkdirSync(bin);
    const docker = join(bin, "docker");
    writeFileSync(docker, `#!/bin/sh
case "$1" in
version) echo 1; exit 0 ;;
build) ${failure === "build" ? "exit 23" : "exit 0"} ;;
image) echo fake-image; exit 0 ;;
run) exit 23 ;;
esac
exit 1
`);
    chmodSync(docker, 0o755);
    const out = join(scratch, `out-${failure}`);
    const outcome = runCli(out, ["--store", fakeStore, "--checkpoint", "ckpt-fake", "--output", out], { PATH: `${bin}:${process.env["PATH"] ?? ""}` });
    expectFailureShape(outcome, check!, failure === "build" ? "docker build failed" : "without producing a report");
    for (const name of ["selection.json", "runtime.json", "comparison.json", "regenerated-request.json", "trace.jsonl"]) {
      expect(existsSync(join(out, name)), name).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(out, "regenerated-request.json"), "utf8")).status).toBe("unavailable");
  });
});
