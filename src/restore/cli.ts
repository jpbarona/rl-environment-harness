#!/usr/bin/env node
/**
 * S3-R7: restore-check command.
 *
 * `npm run restore -- --store <path> --checkpoint <id> --output <run-dir>`
 *
 * Validates the environment, builds/uses the pinned image, runs the restore
 * worker inside a fresh container with the capture store mounted read-only,
 * and propagates the worker's exit code. Zero on PASS only.
 *
 * Every failure path — docker unavailable, missing store/checkpoint, image
 * build failure, a worker that exits without a report, or an unexpected
 * error — writes the machine-readable `result.json` failure report with the
 * failed check named and every check that could not run marked explicitly.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeRestoreResult } from "./report.js";
import { fileURLToPath } from "node:url";

interface Args {
  readonly store: string;
  readonly checkpoint: string;
  readonly output: string;
  readonly reuseImage?: boolean | undefined;
  readonly opencodeBin?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly mutateAfterCompare?: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const store = get("--store");
  const checkpoint = get("--checkpoint");
  const output = get("--output");
  if (store === undefined || checkpoint === undefined || output === undefined) {
    console.error("usage: npm run restore -- --store <path> --checkpoint <id> --output <run-dir>");
    process.exit(2);
  }
  const timeoutRaw = get("--timeout-ms");
  return {
    store: resolve(store),
    checkpoint,
    output: resolve(output),
    reuseImage: argv.includes("--reuse-image"),
    opencodeBin: get("--opencode-bin"),
    timeoutMs: timeoutRaw !== undefined ? Number(timeoutRaw) : undefined,
    mutateAfterCompare: argv.includes("--mutate-after-compare"),
  };
}

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const args = parseArgs(process.argv.slice(2));

/**
 * Write the required machine-readable failure report. The named check
 * carries the failure detail; every other worker check is marked as not
 * run. Never claims PASS.
 */
function writeFailureReport(
  status: "FAIL" | "BLOCKED",
  failedCheck: string,
  detail: string,
): void {
  try {
    writeRestoreResult(args.output, status, args.checkpoint, Date.now(), [
      { check: failedCheck, ok: false, detail: `FAILED — ${detail}` },
    ], { store: args.store, result: detail });
  } catch (error) {
    console.error(`Cannot save failure evidence: ${String(error)}`);
  }
  console.error(`RESTORE ${status}: failed check=${failedCheck} — ${detail}`);
  console.error(`Report: ${join(args.output, "result.json")}`);
}

function main(): void {
  // Environment gate: docker must be usable.
  const dockerCheck = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  if (dockerCheck.status !== 0) {
    writeFailureReport(
      "BLOCKED",
      "runtime.docker",
      `docker daemon is unavailable (exit ${dockerCheck.status}); a Linux container runtime is required`,
    );
    process.exit(1);
  }

  for (const [check, label, path] of [
    ["selection.store-missing", "capture store", args.store],
    ["selection.checkpoint-missing", "checkpoint directory", join(args.store, "checkpoints", args.checkpoint)],
  ] as const) {
    if (!existsSync(path)) {
      writeFailureReport("FAIL", check, `${label} does not exist: ${path}`);
      process.exit(1);
    }
  }

  const lockPath = join(repoRoot, "containers", "restore", "lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    readonly image: string;
    readonly imageDigest: string;
    readonly tag: string;
    readonly platform: string;
    readonly opencode: { readonly version: string; readonly url: string; readonly sha256: string; readonly binPath: string };
  };

  // Build (or reuse) the pinned image.
  const imageRef = `${lock.tag}:${lock.opencode.version}`;
  if (args.reuseImage !== true) {
    console.log(`Building pinned image ${imageRef} ...`);
    const build = spawnSync(
      "docker",
      ["build", "--platform", lock.platform, "-t", imageRef, join(repoRoot, "containers", "restore")],
      { stdio: "inherit" },
    );
    if (build.status !== 0) {
      writeFailureReport("FAIL", "runtime.image-build", `docker build failed with exit ${build.status}; see the build output above`);
      process.exit(1);
    }
  }

  mkdirSync(args.output, { recursive: true });
  const runId = `restore-${Date.now()}`;
  const harnessDist = join(repoRoot, "dist");

  // Runtime identity (S3-R3): image id, node, sqlite, opencode lock hash.
  const imageId = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", imageRef], { encoding: "utf8" }).stdout?.trim() ?? "";
  const imageDigest = spawnSync("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", imageRef], { encoding: "utf8" }).stdout?.trim() ?? "[]";
  const opencodeSha = spawnSync("docker", ["run", "--rm", imageRef, "shasum", "-a", "256", lock.opencode.binPath], { encoding: "utf8" }).stdout?.split(" ")[0] ?? "";
  const sqliteVersion = spawnSync("docker", ["run", "--rm", imageRef, "bash", "-c", "cat /usr/local/share/harness-sqlite-version"], { encoding: "utf8" }).stdout?.trim() ?? "";
  const harnessRevision = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repoRoot }).stdout?.trim() ?? "unknown";

  console.log(`Running restore worker (${runId}) ...`);
  const run = spawnSync(
    "docker",
    [
      "run", "--rm", "--name", runId,
      "--platform", "linux/arm64",
      "-v", `${args.store}:/work/store:ro`,
      "-v", `${args.output}:/work/evidence:rw`,
      "-v", `${harnessDist}:/opt/harness/dist:ro`,
      imageRef,
      "node", "/opt/harness/dist/restore/worker.js",
      "--store", "/work/store",
      "--checkpoint", args.checkpoint,
      "--output", "/work/evidence",
      "--workspace", "/work/workspace",
      "--home", "/work/home",
      "--tmp", "/work/tmp",
      "--opencode-bin", args.opencodeBin ?? lock.opencode.binPath,
      "--image-id", imageId,
      "--image-digests", imageDigest,
      "--opencode-sha256", opencodeSha,
      "--sqlite-version", sqliteVersion,
      "--harness-revision", harnessRevision,
      ...(args.timeoutMs !== undefined ? ["--timeout-ms", String(args.timeoutMs)] : []),
      ...(args.mutateAfterCompare === true ? ["--mutate-after-compare"] : []),
    ],
    { stdio: "inherit" },
  );

  // The worker writes its own result.json on every bounded failure. If the
  // container exited nonzero WITHOUT one (worker crash, engine error), the
  // CLI records the failure with all worker checks marked as not run.
  const resultPath = join(args.output, "result.json");
  if (run.status !== 0 && !existsSync(resultPath)) {
    writeFailureReport(
      "FAIL",
      "worker.run",
      `the restore worker exited ${run.status ?? "abnormally"} without producing a report (container ${runId})`,
    );
    process.exit(run.status ?? 1);
  }
  if (run.status !== 0) {
    console.error(`RESTORE FAILED (exit ${run.status}). Evidence: ${args.output}`);
    process.exit(run.status ?? 1);
  }
  console.log(`Evidence: ${args.output}`);
  process.exit(0);
}

try {
  main();
} catch (err) {
  writeFailureReport("FAIL", "cli.unexpected", String(err instanceof Error ? (err.stack ?? err.message) : err));
  process.exit(1);
}