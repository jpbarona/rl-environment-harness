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
  readonly verifier: { readonly status: string; readonly evidence?: string };
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
const TEST_KINDS = new Set(["runtime-health-check", "task-checker"]);
/** The required runtime tools the frozen lock must pin. */
const REQUIRED_APT_PACKAGES = ["git", "git-man", "sqlite3", "libsqlite3-0", "ca-certificates", "openssl", "libssl3"] as const;

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
  if (schemaErrors.length > 0) {
    // Malformed metadata: stop immediately with the named schema failure
    // instead of running (or crashing in) downstream checks.
    return { ok: false, checks };
  }
  const taskId = metadata.taskId;
  const checkpointId = metadata.selection.checkpointId;
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

  // credentials.absent: authored files, instruction, records, evidence, and
  // every exported workspace object (byte-preserving scan).
  const credentialHits = scanCredentialPatterns(packageDir, metadata);
  record("credentials.absent", credentialHits.length === 0, credentialHits.length === 0 ? "no credential-shaped material in authored files, instruction, records, evidence, or objects" : credentialHits.slice(0, 4).join("; "));

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

  // Runtime lock: complete required schema, then exact Dockerfile agreement.
  const lock = readJson<PackageRuntimeLock>(join(captureDir, "runtime-lock.json"));
  const lockErrors = lockSchemaErrors(lock);
  const lockDetail = lock !== null && lockErrors.length === 0
    ? `image ${lock.image} digest-pinned; opencode ${lock.opencode?.version}; ${lockPackageCount(lock)} required apt packages pinned`
    : lockErrors.join("; ");
  record("lock.schema", lockErrors.length === 0, lockDetail);
  if (lock !== null && lockErrors.length === 0) {
    const agreement = validateLockAgreement(join(packageDir, "environment", "Dockerfile"), lock);
    checks.push(...agreement.checks);
  } else {
    record("environment.pinned", false, "skipped: the runtime lock failed its schema check");
  }

  // verifier.evidence: validated status requires recorded validation evidence.
  const evidenceErrors = validateVerifierEvidence(packageDir, metadata);
  record("verifier.evidence", evidenceErrors.length === 0, evidenceErrors.length === 0 ? `status=${metadata.verifier.status}` : evidenceErrors.join("; "));

  // tests.kind: script kind agrees with verifier status; script is executable.
  const kindErrors: string[] = [];
  if (metadata.tests.kind === "runtime-health-check" && metadata.verifier.status !== "unvalidated-candidate") {
    kindErrors.push("a runtime health check cannot carry a validated status");
  }
  if (metadata.verifier.status === "validated-task-reward" && metadata.tests.kind !== "task-checker") {
    kindErrors.push("a validated task reward requires tests.kind task-checker");
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

/** The runtime lock shape the validator requires. */
export interface PackageRuntimeLock {
  readonly name?: unknown;
  readonly platform?: unknown;
  readonly image?: unknown;
  readonly imageDigest?: unknown;
  readonly tag?: unknown;
  readonly opencode?: { readonly version?: unknown; readonly url?: unknown; readonly sha256?: unknown; readonly binPath?: unknown };
  readonly aptPackages?: {
    readonly source?: unknown;
    readonly caCertBootstrap?: { readonly package?: unknown; readonly sha256?: unknown };
  } & Record<string, unknown>;
}

function lockPackageCount(lock: PackageRuntimeLock): number {
  return Object.keys(lock.aptPackages ?? {}).filter((key) => (REQUIRED_APT_PACKAGES as readonly string[]).includes(key)).length;
}

/** Complete required lock schema: identity pins, download references, hashes. */
function lockSchemaErrors(lock: PackageRuntimeLock | null): string[] {
  if (lock === null || typeof lock !== "object") {
    return ["capture/runtime-lock.json is absent or unparseable"];
  }
  const errors: string[] = [];
  if (typeof lock.name !== "string" || lock.name === "") {
    errors.push("name missing");
  }
  if (typeof lock.platform !== "string" || !/^linux\/(arm64|x64)$/.test(lock.platform)) {
    errors.push("platform must be linux/arm64 or linux/x64");
  }
  if (typeof lock.image !== "string" || lock.image === "") {
    errors.push("image missing");
  }
  if (typeof lock.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(lock.imageDigest)) {
    errors.push("imageDigest must be sha256:<64 hex>");
  }
  if (typeof lock.tag !== "string" || lock.tag === "") {
    errors.push("tag missing");
  }
  const oc = lock.opencode;
  if (oc === null || oc === undefined || typeof oc !== "object") {
    errors.push("opencode identity missing");
  } else {
    if (typeof oc.version !== "string" || oc.version === "") {
      errors.push("opencode.version missing");
    }
    if (typeof oc.url !== "string" || !/^https:\/\/.+\.(tar\.gz|tgz)$/.test(oc.url) || (typeof oc.version === "string" && !oc.url.includes(oc.version))) {
      errors.push("opencode.url must be an https tarball reference containing the pinned version");
    }
    if (typeof oc.sha256 !== "string" || !SHA256_HEX.test(oc.sha256)) {
      errors.push("opencode.sha256 must be 64 hex");
    }
    if (typeof oc.binPath !== "string" || !oc.binPath.startsWith("/")) {
      errors.push("opencode.binPath must be an absolute container path");
    }
  }
  const apt = lock.aptPackages;
  if (apt === null || apt === undefined || typeof apt !== "object") {
    errors.push("aptPackages missing");
  } else {
    if (typeof apt.source !== "string" || !/^https:\/\/snapshot\.debian\.org\/archive\/debian\/\d{8}T\d{6}Z(?:\s+\(.+\))?$/.test(apt.source.trim())) {
      errors.push("aptPackages.source must be a frozen https Debian snapshot URL");
    }
    for (const required of REQUIRED_APT_PACKAGES) {
      const version = apt[required];
      if (typeof version !== "string" || version === "" || !/\d/.test(version)) {
        errors.push(`aptPackages.${required} is not pinned to an exact version`);
      }
    }
    const ca = apt.caCertBootstrap;
    if (ca === null || ca === undefined || typeof ca !== "object" || typeof ca.package !== "string" || ca.package === "" || typeof ca.sha256 !== "string" || !SHA256_HEX.test(ca.sha256)) {
      errors.push("aptPackages.caCertBootstrap must declare a package name and sha256");
    }
  }
  return errors;
}

/**
 * Exact agreement between the Dockerfile and the lock: every pinned value is
 * parsed from the Dockerfile text and compared for equality. Substring
 * presence alone is not accepted.
 */
function validateLockAgreement(dockerfilePath: string, lock: PackageRuntimeLock): PackageValidation {
  const checks: PackageCheck[] = [];
  const df = readText(dockerfilePath) ?? "";
  const errors: string[] = [];

  const base = /^ARG BASE_IMAGE=(\S+)@(\S+)$/m.exec(df);
  if (base === null || base[1] !== lock.image || base[2] !== lock.imageDigest) {
    errors.push("base image ARG does not pin the locked image digest");
  }

  const arg = (name: string): string | undefined => {
    const match = new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(df);
    return match?.[1];
  };
  if (arg("OPENCODE_VERSION") !== lock.opencode?.version) {
    errors.push("OpenCode version ARG does not equal the lock");
  }
  if (arg("OPENCODE_SHA256") !== lock.opencode?.sha256) {
    errors.push("OpenCode sha256 ARG does not equal the lock");
  }
  if (arg("OPENCODE_URL") !== lock.opencode?.url) {
    errors.push("OpenCode URL ARG does not equal the lock");
  }
  const bin = /^ENV OPENCODE_BIN=(\S+)$/m.exec(df);
  if (bin === null || bin[1] !== lock.opencode?.binPath) {
    errors.push("OpenCode binPath ENV does not equal the lock");
  }
  // The apt sources must point at exactly the locked frozen snapshot base.
  const sourceRaw = typeof lock.aptPackages?.source === "string" ? lock.aptPackages.source : "";
  const snapshotBase = sourceRaw.trim().split(/\s+/)[0] ?? "";
  if (snapshotBase === "" || !df.includes(`URIs: ${snapshotBase}`)) {
    errors.push("the Dockerfile apt sources do not reference the locked frozen snapshot");
  }
  if (!/sha256sum -c -/.test(df)) {
    errors.push("the Dockerfile does not wire sha256 verification for its downloads");
  }

  const ca = lock.aptPackages?.caCertBootstrap;
  if (ca !== undefined && typeof ca.package === "string" && typeof ca.sha256 === "string") {
    // The fetched .deb is hash-checked before use; parse the hashed value
    // and compare it for equality with the lock. The download must also
    // reference the locked package filename.
    const caEcho = new RegExp(`echo "([0-9a-f]{64})\\s+[^"]*\\.deb"`).exec(df);
    if (caEcho === null || caEcho[1] !== ca.sha256) {
      errors.push("the CA bootstrap checksum echo does not equal the lock");
    }
    if (!df.includes(`/${ca.package}`)) {
      errors.push("the CA bootstrap download does not reference the locked package name");
    }
  }

  // Apt installs: parse the key=value pairs from the install block and
  // compare the exact set and versions with the lock.
  const installStart = df.indexOf("--no-install-recommends");
  const installEnd = df.indexOf("rm -rf /var/lib/apt/lists");
  if (installStart < 0 || installEnd < 0 || installEnd < installStart) {
    errors.push("the pinned apt install block is missing");
  } else {
    const block = df.slice(installStart, installEnd);
    const installed = new Map<string, string>();
    for (const match of block.matchAll(/^\s{2,}([A-Za-z0-9+.-]+)=([^\s\\;]+);?\s*\\?$/gm)) {
      installed.set(match[1] ?? "", match[2] ?? "");
    }
    for (const required of REQUIRED_APT_PACKAGES) {
      const locked = lock.aptPackages?.[required];
      const found = installed.get(required);
      if (typeof locked !== "string" || found === undefined) {
        errors.push(`apt package ${required} is not installed in the Dockerfile`);
      } else if (found !== locked) {
        errors.push(`apt package ${required} is ${found}; the lock pins ${locked}`);
      }
    }
    for (const key of installed.keys()) {
      if (!(REQUIRED_APT_PACKAGES as readonly string[]).includes(key)) {
        errors.push(`the Dockerfile installs unlocked package ${key}`);
      }
    }
  }

  checks.push({ check: "environment.pinned", ok: errors.length === 0, detail: errors.length === 0 ? "Dockerfile agrees with the lock on every pinned value" : errors.join("; ") });
  return { ok: checks.every((c) => c.ok), checks };
}

/** Validated status requires recorded validation evidence; nothing is inferred. */
function validateVerifierEvidence(packageDir: string, metadata: PackageMetadata): string[] {
  const status = metadata.verifier.status;
  const evidence = metadata.verifier.evidence;
  if (status !== "validated-task-reward") {
    if (evidence !== undefined) {
      return ["validation evidence is declared without a validated status"];
    }
    return [];
  }
  if (typeof evidence !== "string" || evidence === "") {
    return ["validated-task-reward requires a declared evidence record"];
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(evidence) || evidence.split("/").some((p) => p === "..")) {
    return [`verifier.evidence is not a safe package-relative path: ${evidence}`];
  }
  const record = readJson<{ validatedAt?: unknown; source?: unknown }>(join(packageDir, ...evidence.split("/")));
  if (record === null || typeof record !== "object") {
    return [`verifier evidence ${evidence} is absent or unparseable`];
  }
  const errors: string[] = [];
  if (typeof record.validatedAt !== "string" || Number.isNaN(Date.parse(record.validatedAt))) {
    errors.push("verifier evidence lacks a parseable validatedAt timestamp");
  }
  if (typeof record.source !== "string" || record.source.trim() === "") {
    errors.push("verifier evidence lacks a source describing the validation");
  }
  return errors;
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
  // Package-authored files plus the preserved instruction bytes.
  const authored = [
    join(packageDir, "capture", "metadata.json"),
    join(packageDir, "capture", "runtime-lock.json"),
    join(packageDir, "task.toml"),
    join(packageDir, "environment", "Dockerfile"),
    join(packageDir, "tests", "test.sh"),
    join(packageDir, "instruction.md"),
  ];
  for (const file of authored) {
    const text = readText(file);
    if (text !== null) {
      targets.push({ file: toPosix(relative(packageDir, file)), text });
    }
  }
  // Checkpoint records and evidence text.
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
  // Exported workspace objects: byte-preserving latin1 decode, so ASCII
  // credential patterns are matched exactly inside binary content too.
  for (const object of metadata.inventory.objects) {
    const text = readObjectText(join(packageDir, "capture", "objects", object.sha256));
    if (text !== null) {
      targets.push({ file: `capture/objects/${object.sha256}`, text });
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
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return ["metadata is not an object"];
  }
  const errors: string[] = [];
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (metadata.schemaVersion !== 1) {
    errors.push(`unsupported schemaVersion ${String(metadata.schemaVersion)}`);
  }
  if (typeof metadata.taskId !== "string" || !/^task-[A-Za-z0-9_-]+$/.test(metadata.taskId)) {
    errors.push("taskId missing or malformed");
  }
  if (typeof metadata.createdAt !== "string") {
    errors.push("createdAt missing");
  }
  const verifier = metadata.verifier as unknown;
  if (!isRecord(verifier) || typeof verifier["status"] !== "string" || !VERIFIER_STATUSES.has(verifier["status"] as string)) {
    errors.push(`verifier.status must be one of ${[...VERIFIER_STATUSES].join(", ")}`);
  } else if (verifier["evidence"] !== undefined && (typeof verifier["evidence"] !== "string" || verifier["evidence"] === "")) {
    errors.push("verifier.evidence must be a non-empty string when present");
  }
  const selection = metadata.selection as unknown;
  if (
    !isRecord(selection) ||
    typeof selection["checkpointId"] !== "string" || selection["checkpointId"] === "" ||
    typeof selection["sessionId"] !== "string" || selection["sessionId"] === "" ||
    typeof selection["messageId"] !== "string" || selection["messageId"] === "" ||
    typeof selection["requestIndex"] !== "number" || !Number.isInteger(selection["requestIndex"]) ||
    typeof selection["model"] !== "string" || selection["model"] === "" ||
    typeof selection["opencodeVersion"] !== "string" || selection["opencodeVersion"] === ""
  ) {
    errors.push("selection identity incomplete");
  }
  const instruction = metadata.instruction as unknown;
  if (!isRecord(instruction) || instruction["path"] !== "instruction.md") {
    errors.push("instruction.path must be instruction.md");
  }
  const tests = metadata.tests as unknown;
  if (!isRecord(tests) || typeof tests["kind"] !== "string" || !TEST_KINDS.has(tests["kind"] as string) || tests["path"] !== "tests/test.sh") {
    errors.push("tests declaration missing or malformed");
  }
  const environment = metadata.environment as unknown;
  if (!isRecord(environment) || environment["dockerfile"] !== "environment/Dockerfile") {
    errors.push("environment.dockerfile must be environment/Dockerfile");
  }
  if (metadata.runtimeLock !== "capture/runtime-lock.json") {
    errors.push("runtimeLock must be capture/runtime-lock.json");
  }
  const inventory = metadata.inventory as unknown;
  if (!isRecord(inventory) || !Array.isArray(inventory["objects"]) || !Array.isArray(inventory["records"]) || !Array.isArray(inventory["evidenceRecords"])) {
    errors.push("inventory missing or malformed");
  } else {
    for (const object of inventory["objects"] as unknown[]) {
      if (!isRecord(object) || typeof object["sha256"] !== "string" || !SHA256_HEX.test(object["sha256"]) || typeof object["bytes"] !== "number" || !Array.isArray(object["references"])) {
        errors.push(`inventory object malformed: ${JSON.stringify(object)?.slice(0, 80)}`);
      }
    }
  }
  const evidence = metadata.evidence as unknown;
  if (!isRecord(evidence) || typeof evidence["description"] !== "string" || !Array.isArray(evidence["paths"])) {
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

/** Byte-preserving decode for object scanning (ASCII patterns stay exact). */
function readObjectText(path: string): string | null {
  try {
    return readFileSync(path).toString("latin1");
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
