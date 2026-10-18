#!/usr/bin/env node
/**
 * The `checkpoint` user command (S5-R1, S5-R2, S5-R8).
 *
 *   checkpoint "<failure description>"   queue a background job; prints QUEUED <task-id>
 *   checkpoint scores                     deterministic status listing
 *
 * The command never prompts, never requires a live conversation, and returns
 * promptly: the background runner is spawned detached and survives OpenCode
 * or terminal closure. Selection uses the harness proxy's active-session
 * identity (POST /checkpoint); the command itself is excluded from task
 * selection by the proxy.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, configPath } from "./config.js";
import { createJob, isRunnerAlive, listJobs, markFailed, readStatus, writeStatus, type JobStatus } from "./job.js";

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

interface Selection {
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly turnId: string;
}

async function selectLastAttempt(captureServiceURL: string): Promise<Selection> {
  const response = await fetch(`${captureServiceURL.replace(/\/$/, "")}/checkpoint`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`capture service rejected the selection (${response.status}): ${text.slice(0, 200)}`);
  }
  const body = (await response.json()) as Partial<Selection>;
  if (typeof body.checkpointId !== "string" || typeof body.sessionId !== "string" || typeof body.messageId !== "string") {
    throw new Error("capture service returned an incomplete selection");
  }
  return {
    checkpointId: body.checkpointId,
    sessionId: body.sessionId,
    messageId: body.messageId,
    turnId: body.turnId ?? "",
  };
}

/** Next sequential task id (task-001, task-002, ...). */
function nextTaskId(tasksDir: string, jobs: readonly JobStatus[]): string {
  let max = 0;
  const bump = (taskId: string | undefined): void => {
    const match = /^task-(\d+)$/.exec(taskId ?? "");
    if (match !== null) {
      max = Math.max(max, Number(match[1]));
    }
  };
  if (existsSync(tasksDir)) {
    for (const entry of readdirSync(tasksDir)) {
      bump(entry);
    }
  }
  for (const job of jobs) {
    bump(job.taskId);
  }
  return `task-${String(max + 1).padStart(3, "0")}`;
}

/** A RUNNING job whose runner process is gone failed; report it, never hang. */
function sweepCrashedJobs(jobs: readonly JobStatus[]): number {
  if (config === undefined) {
    return 0;
  }
  let swept = 0;
  for (const job of jobs) {
    if (job.state === "RUNNING" && !isRunnerAlive(job.runnerPid)) {
      markFailed(config.jobsDir, job, "runner.died", `the background runner (pid ${job.runnerPid ?? "unknown"}) is no longer alive`);
      swept += 1;
    }
  }
  return swept;
}

let config: ReturnType<typeof loadConfig> | undefined;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "";
  config = loadConfig(process.env["CHECKPOINT_CONFIG"] !== undefined ? process.env["CHECKPOINT_CONFIG"] : undefined);

  if (command === "scores") {
    const jobs = listJobs(config.jobsDir);
    sweepCrashedJobs(jobs);
    const refreshed = listJobs(config.jobsDir);
    if (refreshed.length === 0) {
      console.log("no checkpoint jobs");
      process.exit(0);
    }
    for (const job of refreshed) {
      const label = job.state === "SCORED" && job.qualityScore !== undefined
        ? `${job.qualityScore}/100`
        : job.state === "FAILED"
          ? "FAILED"
          : "RUNNING";
      console.log(`${job.taskId}  ${label}`);
    }
    process.exit(0);
  }

  if (command === "" || command === "--help" || command === "-h") {
    console.error('usage: checkpoint "<failure description>" | checkpoint scores');
    process.exit(2);
  }

  const description = argv.slice(command === "checkpoint" ? 1 : 0).join(" ").trim();
  if (description === "") {
    console.error("checkpoint: a quoted failure description is required");
    process.exit(2);
  }

  // Crash recovery sweep before admitting a new job.
  sweepCrashedJobs(listJobs(config.jobsDir));

  let selection: Selection;
  try {
    selection = await selectLastAttempt(config.captureServiceURL);
  } catch (err) {
    console.error(`checkpoint: selection failed: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }

  const jobs = listJobs(config.jobsDir);
  const taskId = nextTaskId(join(config.outputDir, "tasks"), jobs);
  const jobId = `job-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  mkdirSync(config.jobsDir, { recursive: true });
  createJob(config.jobsDir, {
    jobId,
    taskId,
    checkpointId: selection.checkpointId,
    sessionId: selection.sessionId,
    messageId: selection.messageId,
    storePath: config.storePath,
    description,
    createdAt: new Date().toISOString(),
  });

  // Detached background runner: survives OpenCode and terminal closure.
  const runner = join(repoRoot, "dist", "checkpoint", "runner.js");
  if (!existsSync(runner)) {
    console.error("checkpoint: the harness build is missing; run npm run build");
    process.exit(1);
  }
  const configFlag = process.env["CHECKPOINT_CONFIG"] !== undefined ? ["--config", configPath()] : [];
  const child = spawn(process.execPath, [runner, "--job", jobId, ...configFlag], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, HARNESS_REPO_ROOT: repoRoot },
  });
  child.unref();

  // The status file records the runner pid for crash detection.
  const status = readStatus(config.jobsDir, jobId);
  if (status !== undefined && child.pid !== undefined) {
    writeStatus(config.jobsDir, { ...status, runnerPid: child.pid });
  }

  console.log(`QUEUED ${taskId}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`checkpoint: ${String(err instanceof Error ? err.message : err)}`);
  process.exit(1);
});
