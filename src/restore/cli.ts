#!/usr/bin/env node
/**
 * S3-R7: restore-check command.
 *
 * `npm run restore -- --store <path> --checkpoint <id> --output <run-dir>`
 *
 * Validates the environment, builds/uses the pinned image, runs the restore
 * worker inside a fresh container with the capture store mounted read-only,
 * and propagates the worker's exit code. Zero on PASS only.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Args {
  readonly store: string;
  readonly checkpoint: string;
  readonly output: string;
  readonly reuseImage?: boolean | undefined;
  readonly opencodeBin?: string | undefined;
  readonly timeoutMs?: number | undefined;
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
  };
}

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const args = parseArgs(process.argv.slice(2));

// Environment gate: docker must be usable.
const dockerCheck = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
if (dockerCheck.status !== 0) {
  console.error("BLOCKED: docker daemon is unavailable; a Linux container runtime is required.");
  process.exit(1);
}

for (const [label, path] of [
  ["capture store", args.store],
  ["checkpoint directory", join(args.store, "checkpoints", args.checkpoint)],
] as const) {
  if (!existsSync(path)) {
    console.error(`BLOCKED: ${label} does not exist: ${path}`);
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
    console.error("BLOCKED: image build failed.");
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
  ],
  { stdio: "inherit" },
);

// The worker controls its own exit code; docker run propagates it.
if (run.status !== 0) {
  console.error(`RESTORE FAILED (exit ${run.status}). Evidence: ${args.output}`);
  process.exit(run.status ?? 1);
}
console.log(`Evidence: ${args.output}`);
process.exit(0);