/**
 * S4-R2: package layout, metadata, and inventory validation.
 *
 * Validates an exported task package (or any directory claimed to be one)
 * using ONLY the package contents — never the source capture store. Every
 * check is named; the aggregated result drives export publication and the
 * portability gate.
 *
 * Checks:
 * - layout.files: every required file exists; no required miss.
 * - metadata.schema: required keys, types, and enum values.
 * - task.toml: parses, and taskId/verifier status agree with metadata.
 * - objects.inventory: the declared object set equals the referenced set
 *   (manifest + referenced artifacts) exactly; no orphans, no omissions.
 * - objects.hash: every object exists with matching content hash and size.
 * - records.present: every declared record exists, and the checkpoint
 *   directory contains exactly the declared record set (no extras).
 * - records.split: the active request log holds exactly the selected
 *   primary request; the attempt suffix lives only under evidence/.
 * - identity.consistent: metadata, runtime record, manifest, and task
 *   descriptor name the same checkpoint/session/message identity.
 * - paths.safe: object names are bare SHA-256 hex; declared paths are
 *   package-relative with no traversal.
 * - credentials.absent: no credential-shaped material in package-authored
 *   files or record/evidence text.
 * - hostpaths.undeclared: no source-host path references in package-authored
 *   files (instruction.md is preserved bytes and exempt; see docs/package.md).
 * - environment.pinned: the Dockerfile pins the locked image digest and
 *   OpenCode binary checksum.
 * - tests.kind: the test script kind agrees with the recorded verifier status.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseTaskToml, tomlValue } from "./task-toml.js";

export interface PackageCheck {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface PackageValidation {
  readonly ok: boolean;
  readonly checks: readonly PackageCheck[];
}

export interface PackageInventoryObject {
  readonly sha256: string;
  readonly bytes: number;
  readonly references: readonly string[];
}

export interface PackageMetadata {
  readonly schemaVersion: number;
  readonly taskId: string;
  readonly createdAt: string;
  readonly verifier: { readonly status: string };
  readonly selection: {
    readonly checkpointId: string;
    readonly sessionId: string;
    readonly messageId: string;
    readonly requestIndex: number;
    readonly model: string;
    readonly opencodeVersion: string;
  };
  readonly instruction: { readonly path: string; readonly origin: string };
  readonly tests: { readonly path: string; readonly kind: string };
  readonly environment: { readonly dockerfile: string };
  readonly runtimeLock: string;
  readonly inventory: {
    readonly objects: readonly PackageInventoryObject[];
    readonly records: readonly string[];
    readonly evidenceRecords: readonly string[];
  };
  readonly evidence: { readonly description: string; readonly paths: readonly string[] };
}

interface ManifestLike {
  readonly checkpointId?: unknown;
  readonly files?: ReadonlyArray<{ readonly path?: unknown; readonly kind?: unknown; readonly sha256?: unknown }>;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const VERIFIER_STATUSES = new Set(["unvalidated-candidate", "validated-task-reward"]);
const TEST_KINDS = new Set(["runtime-health-check", "task-verifier"]);

/** Credential-shaped material that must never enter a package. */
const CREDENTIAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, "private key block"],
  [/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}\b/, "sk-style API token"],
  [/\bBearer [A-Za-z0-9._~+/=-]{16,}/, "Bearer token"],
];

/** Absolute unix source-host path references (package-authored files only). */
const HOST_PATH_PATTERN = /\/(?:Users|home|root)\/[A-Za-z0-9._~@-]/;

export function validatePackage(packageDir: string): PackageValidation {
  const checks: PackageCheck[] = [];
  const record = (check: string, ok: boolean, detail: string): void => {
    checks.push({ check, ok, detail });
  };
  const fail = (check: string, detail: string): boolean => {
    record(check, false, detail);
    return false;
  };

  const captureDir = join(packageDir, "capture");
  const metadataPath = join(captureDir, "metadata.json");
  const metadata = readJson<PackageMetadata>(metadataPath);
  if (metadata === null) {
    record("metadata.schema", false, "capture/metadata.json is absent or unparseable");
    return { ok: false, checks };
  }

  // metadata.schema: required keys, types, enums.
  const schemaErrors = metadataSchemaErrors(metadata);
  record("metadata.schema", schemaErrors.length === 0, schemaErrors.length === 0 ? "schema version 1 with required fields" : schemaErrors.join("; "));
  const taskId = typeof metadata.taskId === "string" ? metadata.taskId : "";
  const checkpointId = typeof metadata.selection?.checkpointId === "string" ? metadata.selection.checkpointId : "";
  const checkpointDir = join(captureDir, "checkpoints", checkpointId);

  // layout.files: every required file exists.
  const requiredFiles = [
    "instruction.md",
    "task.toml",
    "environment/Dockerfile",
    "capture/metadata.json",
    "capture/runtime-lock.json",
    "tests/test.sh",
    ...(checkpointId !== "" ? [`capture/checkpoints/${checkpointId}/manifest.json`, `capture/checkpoints/${checkpointId}/prior_context.json`, `capture/checkpoints/${checkpointId}/runtime.json`, `capture/checkpoints/${checkpointId}/session_state.json`, `capture/checkpoints/${checkpointId}/model_requests.jsonl`] : []),
    ...metadata.inventory.evidenceRecords,
  ];
  const missingFiles = requiredFiles.filter((f) => !isFile(join(packageDir, ...f.split("/"))));
  record("layout.files", missingFiles.length === 0, missingFiles.length === 0 ? `${requiredFiles.length} required files present` : `missing: ${missingFiles.join(", ")}`);

  // task.toml: parses, and identity/verifier agree with metadata.
  const tomlCheck = validateTaskToml(packageDir, metadata);
  checks.push(...tomlCheck.checks);

  // paths.safe: declared paths are relative, traversal-free; object names hex.
  const unsafePaths = collectUnsafePaths(metadata);
  record("paths.safe", unsafePaths.length === 0, unsafePaths.length === 0 ? "declared paths are package-relative" : `unsafe: ${unsafePaths.join(", ")}`);

  // objects.inventory + objects.hash.
  const referenced = referencedObjectHashes(checkpointDir);
  const declared = new Map(metadata.inventory.objects.map((o) => [o.sha256, o]));
  const inventoryErrors: string[] = [];
  for (const sha of referenced.keys()) {
    if (!declared.has(sha)) {
      inventoryErrors.push(`undeclared referenced object ${sha}`);
    }
  }
  for (const [sha, entry] of declared) {
    if (!referenced.has(sha)) {
      inventoryErrors.push(`unreferenced declared object ${sha}`);
    }
    if (!SHA256_HEX.test(sha)) {
      inventoryErrors.push(`object name is not sha256 hex: ${sha}`);
    }
    const objectPath = join(captureDir, "objects", sha);
    if (!isFile(objectPath)) {
      inventoryErrors.push(`object file missing: ${sha}`);
      continue;
    }
    const content = readFileSync(objectPath);
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== sha) {
      inventoryErrors.push(`object ${sha} content hash mismatch`);
    }
    if (entry.bytes !== content.length) {
      inventoryErrors.push(`object ${sha} byte count ${content.length} does not match declared ${entry.bytes}`);
    }
  }
  record("objects.inventory", inventoryErrors.length === 0, inventoryErrors.length === 0 ? `${declared.size} declared objects match the referenced set exactly` : inventoryErrors.slice(0, 8).join("; "));

  // records.present: declared records exist; checkpoint dir holds exactly them.
  const recordErrors: string[] = [];
  const declaredRecords = new Set(metadata.inventory.records);
  const actualRecords = new Set(
    listFiles(checkpointDir).map((p) => toPosix(relative(packageDir, p))),
  );
  for (const declaredPath of declaredRecords) {
    if (!actualRecords.has(declaredPath)) {
      recordErrors.push(`declared record missing: ${declaredPath}`);
    }
  }
  for (const actualPath of actualRecords) {
    if (!declaredRecords.has(actualPath)) {
      recordErrors.push(`undeclared record present: ${actualPath}`);
    }
  }
  for (const declaredPath of [...metadata.inventory.evidenceRecords]) {
    if (!isFile(join(packageDir, ...declaredPath.split("/")))) {
      recordErrors.push(`declared evidence record missing: ${declaredPath}`);
    }
  }
  record("records.present", recordErrors.length === 0, recordErrors.length === 0 ? `${declaredRecords.size} checkpoint records match the declared set exactly` : recordErrors.slice(0, 8).join("; "));

  // records.split: active request log = exactly the selected primary request.
  const split = validateRecordSplit(packageDir, metadata);
  checks.push(...split.checks);

  // identity.consistent.
  const identityErrors = validateIdentity(metadata, checkpointDir);
  record("identity.consistent", identityErrors.length === 0, identityErrors.length === 0 ? `task=${taskId} checkpoint=${checkpointId}` : identityErrors.join("; "));

  // credentials.absent: authored files + records + evidence text.
  const credentialHits = scanCredentialPatterns(packageDir, metadata);
  record("credentials.absent", credentialHits.length === 0, credentialHits.length === 0 ? "no credential-shaped material in authored files, records, or evidence" : credentialHits.slice(0, 4).join("; "));

  // hostpaths.undeclared: authored files only; instruction.md is preserved bytes.
  const authoredFiles = [
    join(captureDir, "metadata.json"),
    join(captureDir, "runtime-lock.json"),
    join(packageDir, "task.toml"),
    join(packageDir, "environment", "Dockerfile"),
    join(packageDir, "tests", "test.sh"),
  ];
  const hostHits: string[] = [];
  for (const file of authoredFiles) {
    const text = readText(file);
    if (text !== null && HOST_PATH_PATTERN.test(text)) {
      hostHits.push(toPosix(relative(packageDir, file)));
    }
  }
  record("hostpaths.undeclared", hostHits.length === 0, hostHits.length === 0 ? "no source-host paths in package-authored files" : `source-host path references in: ${hostHits.join(", ")}`);

  // environment.pinned: the Dockerfile pins the locked digest and checksum.
  const pinned = validatePinnedEnvironment(packageDir);
  checks.push(...pinned.checks);

  // tests.kind: script kind agrees with verifier status; script is executable.
  const kindErrors: string[] = [];
  const expectedKind = metadata.verifier.status === "unvalidated-candidate" ? "runtime-health-check" : "task-verifier";
  if (metadata.tests.kind !== expectedKind) {
    kindErrors.push(`tests.kind ${metadata.tests.kind} does not match verifier status ${metadata.verifier.status}`);
  }
  const testScript = join(packageDir, "tests", "test.sh");
  const testMode = statSync(testScript, { throwIfNoEntry: false })?.mode;
  if (testMode === undefined) {
    kindErrors.push("tests/test.sh missing");
  } else if ((testMode & 0o111) === 0) {
    kindErrors.push("tests/test.sh is not executable");
  }
  record("tests.kind", kindErrors.length === 0, kindErrors.length === 0 ? `kind=${metadata.tests.kind} status=${metadata.verifier.status}` : kindErrors.join("; "));

  void fail;
  return { ok: checks.every((c) => c.ok), checks };
}

export function validateTaskToml(packageDir: string, metadata: PackageMetadata): PackageValidation {
  const checks: PackageCheck[] = [];
  let doc;
  try {
    doc = parseTaskToml(readText(join(packageDir, "task.toml")) ?? "");
    checks.push({ check: "task.toml", ok: true, detail: "parses in the supported subset" });
  } catch (err) {
    checks.push({ check: "task.toml", ok: false, detail: String(err instanceof Error ? err.message : err) });
    return { ok: false, checks };
  }
  const errors: string[] = [];
  if (tomlValue(doc, "task", "id") !== metadata.taskId) {
    errors.push("task.id does not match metadata.taskId");
  }
  if (tomlValue(doc, "verifier", "status") !== metadata.verifier.status) {
    errors.push("verifier.status does not match metadata.verifier.status");
  }
  for (const [section, key, expected] of [
    ["task.instruction", "path", metadata.instruction.path],
    ["environment", "dockerfile", metadata.environment.dockerfile],
    ["capture", "metadata", "capture/metadata.json"],
    ["capture", "runtime_lock", metadata.runtimeLock],
  ] as const) {
    if (tomlValue(doc, section, key) !== expected) {
      errors.push(`${section}.${key} does not match metadata`);
    }
  }
  checks.push({ check: "task.toml.identity", ok: errors.length === 0, detail: errors.length === 0 ? "descriptor agrees with metadata" : errors.join("; ") });
  return { ok: checks.every((c) => c.ok), checks };
}

function validatePinnedEnvironment(packageDir: string): PackageValidation {
  const checks: PackageCheck[] = [];
  const lock = readJson<{ imageDigest?: unknown; opencode?: { sha256?: unknown } }>(join(packageDir, "capture", "runtime-lock.json"));
  if (lock === null || typeof lock.imageDigest !== "string" || lock.opencode === undefined || typeof lock.opencode.sha256 !== "string") {
    checks.push({ check: "environment.pinned", ok: false, detail: "capture/runtime-lock.json lacks imageDigest or opencode.sha256" });
    return { ok: false, checks };
  }
  const dockerfile = readText(join(packageDir, "environment", "Dockerfile")) ?? "";
  const errors: string[] = [];
  if (!dockerfile.includes(lock.imageDigest)) {
    errors.push("Dockerfile does not pin the locked base image digest");
  }
  if (!dockerfile.includes(lock.opencode.sha256)) {
    errors.push("Dockerfile does not pin the locked OpenCode checksum");
  }
  checks.push({ check: "environment.pinned", ok: errors.length === 0, detail: errors.length === 0 ? "Dockerfile pins the locked image digest and OpenCode checksum" : errors.join("; ") });
  return { ok: checks.every((c) => c.ok), checks };
}

function validateRecordSplit(packageDir: string, metadata: PackageMetadata): PackageValidation {
  const checks: PackageCheck[] = [];
  if (metadata.selection === undefined) {
    checks.push({ check: "records.split", ok: false, detail: "skipped: metadata schema invalid" });
    return { ok: false, checks };
  }
  const checkpointId = metadata.selection.checkpointId;
  const active = readJsonLines<{ index?: unknown; classification?: unknown }>(
    join(packageDir, "capture", "checkpoints", checkpointId, "model_requests.jsonl"),
  );
  const evidence = readJsonLines<{ index?: unknown; classification?: unknown }>(
    join(packageDir, "evidence", "model_requests.jsonl"),
  );
  const errors: string[] = [];
  if (active.length !== 1) {
    errors.push(`active request log must hold exactly the selected request; found ${active.length}`);
  } else {
    const only = active[0]!;
    if (typeof only.index !== "number" || only.index !== metadata.selection.requestIndex) {
      errors.push(`active request index ${String(only.index)} does not match selection ${metadata.selection.requestIndex}`);
    }
    if (typeof only.classification !== "string" || !only.classification.startsWith("task-")) {
      errors.push(`active request classification ${String(only.classification)} is not a task request`);
    }
  }
  const evidenceIndexes = evidence.map((r) => r.index).filter((i): i is number => typeof i === "number");
  if (evidence.length === 0 || !evidenceIndexes.includes(metadata.selection.requestIndex)) {
    errors.push("evidence log must retain the selected request for provenance");
  }
  const later = evidenceIndexes.filter((i) => i > metadata.selection.requestIndex);
  if (later.length !== evidenceIndexes.length - evidenceIndexes.filter((i) => i === metadata.selection.requestIndex).length) {
    errors.push("evidence log contains records before the selected request");
  }
  checks.push({
    check: "records.split",
    ok: errors.length === 0,
    detail: errors.length === 0 ? `active holds the primary request; evidence holds ${evidence.length} attempt records` : errors.join("; "),
  });
  return { ok: checks.every((c) => c.ok), checks };
}

function validateIdentity(metadata: PackageMetadata, checkpointDir: string): string[] {
  const errors: string[] = [];
  if (metadata.selection === undefined) {
    return ["skipped: metadata schema invalid"];
  }
  const runtime = readJson<{ sessionId?: unknown; messageId?: unknown; turnId?: unknown }>(join(checkpointDir, "runtime.json"));
  if (runtime === null) {
    errors.push("checkpoint runtime.json missing");
    return errors;
  }
  if (runtime.sessionId !== metadata.selection.sessionId) {
    errors.push("metadata session id conflicts with runtime.json");
  }
  if (runtime.messageId !== metadata.selection.messageId) {
    errors.push("metadata message id conflicts with runtime.json");
  }
  const manifest = readJson<ManifestLike>(join(checkpointDir, "manifest.json"));
  if (manifest === null || manifest.checkpointId !== metadata.selection.checkpointId) {
    errors.push("manifest checkpoint id conflicts with metadata");
  }
  if (metadata.taskId !== `task-${metadata.selection.checkpointId}`) {
    errors.push("taskId is not task-<checkpointId>");
  }
  const prior = readJson<{ turnId?: unknown }>(join(checkpointDir, "prior_context.json"));
  if (prior !== null && typeof runtime.turnId === "string" && prior.turnId !== runtime.turnId) {
    errors.push("prior context turn id conflicts with runtime.json");
  }
  return errors;
}

/** Referenced object hashes: manifest file hashes + referenced artifact hashes. */
function referencedObjectHashes(checkpointDir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (sha: unknown, reference: string): void => {
    if (typeof sha === "string" && SHA256_HEX.test(sha)) {
      const refs = out.get(sha) ?? [];
      refs.push(reference);
      out.set(sha, refs);
    }
  };
  const manifest = readJson<ManifestLike>(join(checkpointDir, "manifest.json"));
  for (const file of manifest?.files ?? []) {
    add(file.sha256, `manifest:${String(file.path)}`);
  }
  const artifacts = readJson<ReadonlyArray<{ sha256?: unknown; originalPath?: unknown }>>(join(checkpointDir, "referenced_artifacts.json"));
  if (Array.isArray(artifacts)) {
    for (const artifact of artifacts) {
      add(artifact.sha256, `artifact:${String(artifact.originalPath)}`);
    }
  }
  return out;
}

function scanCredentialPatterns(packageDir: string, metadata: PackageMetadata): string[] {
  const targets: Array<{ file: string; text: string }> = [];
  const authored = [
    join(packageDir, "capture", "metadata.json"),
    join(packageDir, "capture", "runtime-lock.json"),
    join(packageDir, "task.toml"),
    join(packageDir, "environment", "Dockerfile"),
    join(packageDir, "tests", "test.sh"),
  ];
  for (const file of authored) {
    const text = readText(file);
    if (text !== null) {
      targets.push({ file: toPosix(relative(packageDir, file)), text });
    }
  }
  for (const declared of metadata.inventory.records) {
    const text = readText(join(packageDir, ...declared.split("/")));
    if (text !== null) {
      targets.push({ file: declared, text });
    }
  }
  for (const declared of metadata.inventory.evidenceRecords) {
    const text = readText(join(packageDir, ...declared.split("/")));
    if (text !== null) {
      targets.push({ file: declared, text });
    }
  }
  const hits: string[] = [];
  for (const target of targets) {
    for (const [pattern, label] of CREDENTIAL_PATTERNS) {
      if (pattern.test(target.text)) {
        hits.push(`${target.file}: ${label}`);
      }
    }
  }
  return hits;
}

function metadataSchemaErrors(metadata: PackageMetadata): string[] {
  const errors: string[] = [];
  if (metadata.schemaVersion !== 1) {
    errors.push(`unsupported schemaVersion ${String(metadata.schemaVersion)}`);
  }
  if (typeof metadata.taskId !== "string" || !/^task-[A-Za-z0-9_-]+$/.test(metadata.taskId)) {
    errors.push("taskId missing or malformed");
  }
  if (typeof metadata.createdAt !== "string") {
    errors.push("createdAt missing");
  }
  if (metadata.verifier === undefined || !VERIFIER_STATUSES.has(metadata.verifier.status)) {
    errors.push(`verifier.status must be one of ${[...VERIFIER_STATUSES].join(", ")}`);
  }
  const selection = metadata.selection;
  if (
    selection === undefined ||
    typeof selection.checkpointId !== "string" || selection.checkpointId === "" ||
    typeof selection.sessionId !== "string" || selection.sessionId === "" ||
    typeof selection.messageId !== "string" || selection.messageId === "" ||
    typeof selection.requestIndex !== "number" ||
    typeof selection.model !== "string" || selection.model === "" ||
    typeof selection.opencodeVersion !== "string" || selection.opencodeVersion === ""
  ) {
    errors.push("selection identity incomplete");
  }
  if (metadata.instruction === undefined || metadata.instruction.path !== "instruction.md") {
    errors.push("instruction.path must be instruction.md");
  }
  if (metadata.tests === undefined || !TEST_KINDS.has(metadata.tests.kind) || metadata.tests.path !== "tests/test.sh") {
    errors.push("tests declaration missing or malformed");
  }
  if (metadata.environment === undefined || metadata.environment.dockerfile !== "environment/Dockerfile") {
    errors.push("environment.dockerfile must be environment/Dockerfile");
  }
  if (metadata.runtimeLock !== "capture/runtime-lock.json") {
    errors.push("runtimeLock must be capture/runtime-lock.json");
  }
  const inventory = metadata.inventory;
  if (inventory === undefined || !Array.isArray(inventory.objects) || !Array.isArray(inventory.records) || !Array.isArray(inventory.evidenceRecords)) {
    errors.push("inventory missing or malformed");
  } else {
    for (const object of inventory.objects) {
      if (typeof object.sha256 !== "string" || !SHA256_HEX.test(object.sha256) || typeof object.bytes !== "number" || !Array.isArray(object.references)) {
        errors.push(`inventory object malformed: ${JSON.stringify(object).slice(0, 80)}`);
      }
    }
  }
  if (metadata.evidence === undefined || typeof metadata.evidence.description !== "string" || !Array.isArray(metadata.evidence.paths)) {
    errors.push("evidence declaration missing or malformed");
  }
  return errors;
}

function collectUnsafePaths(metadata: PackageMetadata): string[] {
  const unsafe: string[] = [];
  const checkRelative = (label: string, path: string): void => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(path) || path.split("/").some((p) => p === "..")) {
      unsafe.push(`${label}: ${path}`);
    }
  };
  checkRelative("instruction.path", metadata.instruction?.path ?? "");
  checkRelative("tests.path", metadata.tests?.path ?? "");
  checkRelative("environment.dockerfile", metadata.environment?.dockerfile ?? "");
  checkRelative("runtimeLock", metadata.runtimeLock ?? "");
  for (const record of metadata.inventory?.records ?? []) {
    checkRelative("inventory.records", record);
  }
  for (const record of metadata.inventory?.evidenceRecords ?? []) {
    checkRelative("inventory.evidenceRecords", record);
  }
  for (const object of metadata.inventory?.objects ?? []) {
    if (typeof object.sha256 === "string" && !SHA256_HEX.test(object.sha256)) {
      unsafe.push(`inventory.objects.sha256: ${object.sha256.slice(0, 24)}`);
    }
  }
  return unsafe;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (path: string): void => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

function readJson<T>(path: string): T | null {
  const text = readText(path);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function readJsonLines<T>(path: string): T[] {
  const text = readText(path);
  if (text === null) {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      return out;
    }
  }
  return out;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}
