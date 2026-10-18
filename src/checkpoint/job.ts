/**
 * Background checkpoint job state (S5-R2, S5-R8).
 *
 * A job is one `checkpoint "<description>"` invocation: a frozen capture
 * selection plus a detached runner that publishes one Harbor task. Status
 * lives in <jobsDir>/<job-id>/status.json and is written on every state
 * transition, so a crashed runner is reported instead of hanging silently.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type JobState = "QUEUED" | "RUNNING" | "SCORED" | "FAILED";

export type JobStep = "queued" | "writer" | "build" | "validate" | "harbor" | "review" | "publish" | "done";

export interface JobStatus {
  readonly jobId: string;
  readonly taskId: string;
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly description: string;
  state: JobState;
  step: JobStep;
  detail: string;
  /** Independent task-quality score (0-100) once reviewed. */
  qualityScore?: number;
  /** Per-dimension breakdown of the quality review, retained (S5-R3). */
  qualityScores?: Record<string, number>;
  qualityNotes?: string;
  /** Solver reward from the Harbor validation run, when available. */
  solverReward?: number;
  /** Aggregate model spend recorded so far, in USD. */
  spendUSD?: number;
  /** The estimated (non-reported) portion of the recorded spend. */
  spendEstimatedUSD?: number;
  /** Published task directory, when SCORED. */
  taskDir?: string;
  /** Runner process id, for crash detection. */
  runnerPid?: number;
  readonly createdAt: string;
  updatedAt: string;
}

export interface JobRecord {
  readonly jobId: string;
  readonly taskId: string;
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly storePath: string;
  readonly description: string;
  readonly createdAt: string;
}

export function jobDir(jobsRoot: string, jobId: string): string {
  return join(jobsRoot, jobId);
}

export function createJob(jobsRoot: string, record: JobRecord): void {
  const dir = jobDir(jobsRoot, record.jobId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "job.json"), `${JSON.stringify(record, null, 2)}\n`);
  const status: JobStatus = {
    jobId: record.jobId,
    taskId: record.taskId,
    checkpointId: record.checkpointId,
    sessionId: record.sessionId,
    messageId: record.messageId,
    description: record.description,
    state: "QUEUED",
    step: "queued",
    detail: "queued for background processing",
    createdAt: record.createdAt,
    updatedAt: new Date().toISOString(),
  };
  writeStatus(jobsRoot, status);
}

export function readStatus(jobsRoot: string, jobId: string): JobStatus | undefined {
  const path = join(jobDir(jobsRoot, jobId), "status.json");
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JobStatus;
  } catch {
    return undefined;
  }
}

export function writeStatus(jobsRoot: string, status: JobStatus): void {
  const updated: JobStatus = { ...status, updatedAt: new Date().toISOString() };
  writeFileSync(join(jobDir(jobsRoot, status.jobId), "status.json"), `${JSON.stringify(updated, null, 2)}\n`);
}

export function appendJobLog(jobsRoot: string, jobId: string, line: string): void {
  appendFileSync(join(jobDir(jobsRoot, jobId), "log.txt"), `${new Date().toISOString()} ${line}\n`);
}

export function listJobs(jobsRoot: string): JobStatus[] {
  if (!existsSync(jobsRoot)) {
    return [];
  }
  const out: JobStatus[] = [];
  for (const entry of readdirSync(jobsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const status = readStatus(jobsRoot, entry.name);
    if (status !== undefined) {
      out.push(status);
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** A RUNNING job whose runner process is gone is a crashed job. */
export function isRunnerAlive(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    return code === "EPERM";
  }
}

export function markFailed(jobsRoot: string, status: JobStatus, check: string, detail: string): JobStatus {
  const failed: JobStatus = {
    ...status,
    state: "FAILED",
    step: status.step,
    detail: `${check}: ${detail}`,
  };
  writeStatus(jobsRoot, failed);
  return failed;
}
