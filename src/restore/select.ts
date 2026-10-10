/**
 * S3-R1: explicit selection and preflight validation.
 *
 * A restore selection names one checkpoint id and resolves the
 * authoritative session/message identity from the stored records. Identity
 * is never inferred from prompt text and the newest session is never chosen
 * globally. All referenced object hashes are verified before OpenCode runs.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FileRecord, WorkspaceSnapshot } from "../capture/snapshot.js";

export interface RestoreSelection {
  readonly checkpointId: string;
  /** Authoritative ids from the capture's runtime record. */
  readonly sessionId: string;
  readonly messageId: string;
  /** The selected first primary (task-new-turn) request record index. */
  readonly requestIndex: number;
  /** Model id exactly as captured on the wire. */
  readonly model: string;
  /** Captured workspace root on the host (for path mapping only). */
  readonly capturedWorkspaceRoot: string;
  readonly opencodeVersion: string;
}

export interface SelectionInput {
  readonly storeRoot: string;
  readonly checkpointId: string;
  /** Optional expected identity; a mismatch is a conflicting selection. */
  readonly expectedSessionId?: string;
  readonly expectedMessageId?: string;
}

export class RestoreError extends Error {
  constructor(
    readonly check: string,
    message: string,
  ) {
    super(`${check}: ${message}`);
    this.name = "RestoreError";
  }
}

interface RuntimeRecord {
  readonly turnId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly mainModel: string;
  readonly workspaceRoot: string;
  readonly opencodeVersion: string;
}

interface RequestRecord {
  readonly index: number;
  readonly classification: string;
  readonly background?: boolean;
  readonly body: { readonly model?: unknown };
}

interface PriorContextRecord {
  readonly turnId?: string;
  readonly priorMessages?: unknown;
}

export function checkpointDir(storeRoot: string, checkpointId: string): string {
  return join(storeRoot, "checkpoints", checkpointId);
}

export function readManifest(storeRoot: string, checkpointId: string): WorkspaceSnapshot {
  const dir = checkpointDir(storeRoot, checkpointId);
  if (!statExists(dir)) {
    throw new RestoreError("selection.checkpoint-missing", `no checkpoint directory: ${checkpointId}`);
  }
  const manifestPath = join(dir, "manifest.json");
  if (!statExists(manifestPath)) {
    throw new RestoreError("selection.manifest-missing", "manifest.json is absent");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new RestoreError("selection.manifest-corrupt", `unparseable manifest: ${String(err)}`);
  }
  const record = parsed as Partial<WorkspaceSnapshot>;
  if (
    record === null ||
    typeof record !== "object" ||
    typeof record.root !== "string" ||
    !Array.isArray(record.files)
  ) {
    throw new RestoreError("selection.manifest-invalid", "manifest lacks root/files");
  }
  return parsed as WorkspaceSnapshot;
}

function statExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the selection and validate every stored record and object hash.
 * Throws RestoreError naming the failed check. Never executes OpenCode.
 */
export function selectCheckpoint(input: SelectionInput): RestoreSelection {
  const { storeRoot, checkpointId } = input;
  if (!/^[A-Za-z0-9_-]+$/.test(checkpointId)) {
    throw new RestoreError("selection.invalid-id", `checkpoint id is not a store-relative id: ${checkpointId}`);
  }
  const manifest = readManifest(storeRoot, checkpointId);
  const dir = checkpointDir(storeRoot, checkpointId);

  const runtime = readJson<RuntimeRecord>(join(dir, "runtime.json"), "runtime.json");
  if (typeof runtime.sessionId !== "string" || typeof runtime.messageId !== "string") {
    throw new RestoreError("selection.identity-missing", "runtime.json lacks session/message identity");
  }
  if (
    (input.expectedSessionId !== undefined && input.expectedSessionId !== runtime.sessionId) ||
    (input.expectedMessageId !== undefined && input.expectedMessageId !== runtime.messageId)
  ) {
    throw new RestoreError(
      "selection.identity-conflict",
      `stored identity (${runtime.sessionId}, ${runtime.messageId}) conflicts with the selection`,
    );
  }
  if (typeof runtime.workspaceRoot !== "string" || typeof runtime.opencodeVersion !== "string") {
    throw new RestoreError("selection.runtime-incomplete", "runtime.json lacks workspace root or OpenCode version");
  }

  if (manifest.checkpointId !== checkpointId || manifest.root !== runtime.workspaceRoot) {
    throw new RestoreError("selection.identity-conflict", "manifest checkpoint/workspace conflicts with runtime");
  }
  const session = readJson<{ session?: { id?: unknown } } | null>(join(dir, "session_state.json"), "session_state.json");
  if (session !== null && (typeof session !== "object" || session.session?.id !== runtime.sessionId)) {
    throw new RestoreError("selection.identity-conflict", "session state conflicts with runtime session");
  }
  const prior = readJson<PriorContextRecord>(join(dir, "prior_context.json"), "prior_context.json");
  if (typeof runtime.turnId !== "string" || prior.turnId !== runtime.turnId) {
    throw new RestoreError("selection.identity-conflict", "prior context turn conflicts with runtime turn");
  }
  if (!Array.isArray(prior.priorMessages)) {
    throw new RestoreError("selection.context-missing", "prior_context.json lacks priorMessages");
  }

  const requestsPath = join(dir, "model_requests.jsonl");
  if (!statExists(requestsPath)) {
    throw new RestoreError("selection.requests-missing", "model_requests.jsonl is absent");
  }
  const requests = readJsonl<RequestRecord>(requestsPath);
  const primary = requests.find(
    (r) => r.classification === "task-new-turn" || r.classification === "task-continuation",
  );
  if (primary === undefined) {
    throw new RestoreError("selection.primary-request-missing", "no primary task request recorded");
  }
  if (primary.background === true) {
    throw new RestoreError("selection.primary-request-background", "selected request is background traffic");
  }
  if (typeof primary.body?.model !== "string") {
    throw new RestoreError("selection.request-invalid", "primary request lacks a model id");
  }

  verifyManifestObjects(storeRoot, manifest.files);

  return {
    checkpointId,
    sessionId: runtime.sessionId,
    messageId: runtime.messageId,
    requestIndex: primary.index,
    model: primary.body.model,
    capturedWorkspaceRoot: manifest.root,
    opencodeVersion: runtime.opencodeVersion,
  };
}

/** Read one JSON file with a named failure check. */
function readJson<T>(path: string, label: string): T {
  if (!statExists(path)) {
    throw new RestoreError("selection.record-missing", `${label} is absent`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    throw new RestoreError("selection.record-corrupt", `${label} is unparseable: ${String(err)}`);
  }
}

function readJsonl<T>(path: string): T[] {
  const text = readFileSync(path, "utf8");
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    try {
      out.push(JSON.parse(line) as T);
    } catch (err) {
      throw new RestoreError("selection.requests-corrupt", `model_requests.jsonl line is invalid: ${String(err)}`);
    }
  }
  return out;
}

/**
 * Every referenced object must exist and hash-match. S3-R1: missing or
 * corrupted objects fail before OpenCode starts.
 */
export function verifyManifestObjects(storeRoot: string, files: readonly FileRecord[]): void {
  for (const record of files) {
    if (record.kind !== "file" || record.sha256 === undefined) {
      continue;
    }
    verifyObject(storeRoot, record.sha256, `manifest entry ${record.path}`);
  }
}

export function verifyObject(storeRoot: string, sha256: string, label: string): void {
  const objectPath = join(storeRoot, "objects", sha256);
  if (!statExists(objectPath)) {
    throw new RestoreError("objects.missing", `${label}: object ${sha256} is absent`);
  }
  const actual = createHash("sha256").update(readFileSync(objectPath)).digest("hex");
  if (actual !== sha256) {
    throw new RestoreError("objects.corrupt", `${label}: object ${sha256} content hash mismatch`);
  }
}