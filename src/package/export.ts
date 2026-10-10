/**
 * S4-R1/R5: export one selected checkpoint into a portable Harbor-shaped
 * task package.
 *
 * Pipeline: select + preflight (reuses Step 3's selectCheckpoint; never
 * infers identity) -> render the package into a private staging directory
 * under the export root -> validate the staging directory with the package
 * validator -> atomically rename it to <output>/<task-id>.
 *
 * Invariants:
 * - The source store is only ever READ. Nothing writes into it.
 * - The selected attempt's own response/tool suffix (task-continuation
 *   request records after the primary, and their tool outputs) is moved to
 *   evidence/ and excluded from the active replay records (S4-R1).
 * - Publication is atomic: the final task directory never exists until the
 *   fully staged package has passed validation. A failed export retains the
 *   staging directory as diagnostic evidence and publishes nothing (S4-R5).
 * - Verifier status is recorded explicitly: the default export is an
 *   unvalidated candidate whose tests/test.sh is a runtime health check;
 *   an explicitly supplied --verifier script is recorded as a validated
 *   task-specific reward for that task only (S4-R4).
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RestoreError, checkpointDir, readManifest, selectCheckpoint, verifyObject } from "../restore/select.js";
import { selectedTurnInput } from "../restore/request-compare.js";
import { validatePackage } from "./validate.js";
import { renderTaskToml } from "./task-toml.js";

export interface ExportOptions {
  readonly storeRoot: string;
  readonly checkpointId: string;
  /** Export root; the package is published at <outputDir>/<task-id>. */
  readonly outputDir: string;
  /** Optional user-supplied validated task verifier script (S4-R4). */
  readonly verifierScript?: string;
  /** Harness repository root (for containers/restore/lock.json); overridable in tests. */
  readonly repoRoot?: string;
  /** Test injection: throw after this many staged writes (S4-R5 evidence). */
  readonly failAfterWrite?: number;
}

export interface ExportCheck {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ExportOutcome {
  readonly status: "PASS" | "FAIL";
  readonly taskId: string;
  readonly checkpointId: string;
  /** The published package directory on PASS; undefined on failure. */
  readonly packageDir?: string;
  /** Retained staging directory (diagnostic evidence on failure). */
  readonly stagingDir: string;
  readonly checks: readonly ExportCheck[];
}

interface RequestRecord {
  readonly index: number;
  readonly classification: string;
  readonly at?: string;
  readonly body: Record<string, unknown>;
}

interface ArtifactReference {
  readonly originalPath: string;
  readonly sha256: string;
}

export function exportPackage(options: ExportOptions): ExportOutcome {
  const startedAt = new Date().toISOString();
  const checks: ExportCheck[] = [];
  const record = (check: string, ok: boolean, detail: string): void => {
    checks.push({ check, ok, detail });
  };
  const taskId = `task-${options.checkpointId}`;
  let stagingDir = "";

  const fail = (check: string, detail: string): ExportOutcome => {
    record(check, false, detail);
    return { status: "FAIL", taskId, checkpointId: options.checkpointId, stagingDir, checks };
  };

  try {
    // Selection + preflight: reuses Step 3's validation (identity from
    // records, manifest consistency, manifest object hash verification).
    let selection;
    try {
      selection = selectCheckpoint({ storeRoot: options.storeRoot, checkpointId: options.checkpointId });
      record("selection.identity", true, `session=${selection.sessionId} message=${selection.messageId} request=${selection.requestIndex}`);
    } catch (err) {
      return fail(err instanceof RestoreError ? err.check : "selection.preflight", String(err instanceof Error ? err.message : err));
    }
    const manifest = readManifest(options.storeRoot, options.checkpointId);

    // Primary request + selected instruction (S4-R1).
    const sourceCheckpointDir = checkpointDir(options.storeRoot, options.checkpointId);
    const requests = readJsonLines<RequestRecord>(join(sourceCheckpointDir, "model_requests.jsonl"));
    const primary = requests.find((r) => r.index === selection.requestIndex);
    if (primary === undefined) {
      return fail("selection.primary-request-missing", `no request record with index ${selection.requestIndex}`);
    }
    const instruction = selectedTurnInput(primary.body).prompt;
    record("instruction.rendered", true, `${Buffer.byteLength(instruction)} bytes from the selected request`);

    // Referenced artifacts: hash-verified before anything is staged.
    const artifactsPath = join(sourceCheckpointDir, "referenced_artifacts.json");
    let artifacts: ArtifactReference[] = [];
    if (existsSync(artifactsPath)) {
      const parsed = JSON.parse(readFileSync(artifactsPath, "utf8")) as ArtifactReference[];
      for (const artifact of parsed) {
        verifyObject(options.storeRoot, artifact.sha256, `artifact ${artifact.originalPath}`);
      }
      artifacts = parsed;
    }
    record("artifacts.verified", true, `${artifacts.length} referenced artifacts hash-verified`);

    // Runtime lock: the pinned runtime identities this package documents.
    const repoRoot = options.repoRoot ?? resolve(fileURLToPath(new URL("../../", import.meta.url)));
    const lockPath = join(repoRoot, "containers", "restore", "lock.json");
    let lock: RuntimeLock;
    try {
      lock = JSON.parse(readFileSync(lockPath, "utf8")) as RuntimeLock;
      if (typeof lock.imageDigest !== "string" || lock.opencode === undefined || typeof lock.opencode.sha256 !== "string" || typeof lock.opencode.version !== "string") {
        throw new Error("lock lacks imageDigest or opencode identity");
      }
      record("lock.read", true, `image=${lock.image} digest=${lock.imageDigest.slice(0, 20)}... opencode=${lock.opencode.version}`);
    } catch (err) {
      return fail("package.lock-missing", String(err instanceof Error ? err.message : err));
    }

    // Complete object inventory (S4-R2): manifest files + artifacts, deduped.
    const inventory = buildInventory(options.storeRoot, manifest.files, artifacts);
    for (const entry of inventory.values()) {
      const objectStat = statSync(join(options.storeRoot, "objects", entry.sha256));
      if (objectStat.size !== entry.bytes) {
        return fail("objects.inventory", `object ${entry.sha256} size changed between read and inventory`);
      }
    }
    record("objects.inventory", true, `${inventory.size} objects inventoried`);

    // Staging directory under the export root (same filesystem -> atomic rename).
    mkdirSync(options.outputDir, { recursive: true });
    stagingDir = join(options.outputDir, `.staging-${taskId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(stagingDir, { recursive: true });

    let writes = 0;
    const write = (path: string, content: string): void => {
      if (options.failAfterWrite !== undefined && writes >= options.failAfterWrite) {
        throw new Error(`injected export-write failure after ${writes} writes`);
      }
      writes += 1;
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, content);
    };
    const copy = (from: string, to: string): void => {
      if (options.failAfterWrite !== undefined && writes >= options.failAfterWrite) {
        throw new Error(`injected export-write failure after ${writes} writes`);
      }
      writes += 1;
      mkdirSync(resolve(to, ".."), { recursive: true });
      copyFileSync(from, to);
    };

    // instruction.md: the selected request's exact bytes (S4-R1).
    write(join(stagingDir, "instruction.md"), instruction);
    // task.toml + environment + lock.
    write(join(stagingDir, "task.toml"), renderTaskToml([
      { section: "task", key: "id", value: taskId },
      { section: "task", key: "version", value: 1 },
      { section: "task.instruction", key: "path", value: "instruction.md" },
      { section: "verifier", key: "status", value: options.verifierScript !== undefined ? "validated-task-reward" : "unvalidated-candidate" },
      { section: "environment", key: "dockerfile", value: "environment/Dockerfile" },
      { section: "capture", key: "schema_version", value: 1 },
      { section: "capture", key: "metadata", value: "capture/metadata.json" },
      { section: "capture", key: "runtime_lock", value: "capture/runtime-lock.json" },
      { section: "capture", key: "health_check", value: "tests/test.sh" },
    ]));
    write(join(stagingDir, "environment", "Dockerfile"), renderPackageDockerfile(taskId, lock));
    copy(lockPath, join(stagingDir, "capture", "runtime-lock.json"));

    // Objects: copied from the store, hash-verified after the copy.
    const objectsDir = join(stagingDir, "capture", "objects");
    mkdirSync(objectsDir, { recursive: true });
    for (const sha of inventory.keys()) {
      copy(join(options.storeRoot, "objects", sha), join(objectsDir, sha));
      const copied = createHash("sha256").update(readFileSync(join(objectsDir, sha))).digest("hex");
      if (copied !== sha) {
        return fail("objects.copy", `staged object ${sha} does not match the store object`);
      }
    }

    // Checkpoint records: verbatim copies, except the request log, which is
    // split (S4-R1): the active log holds exactly the primary request.
    const recordsDir = join(stagingDir, "capture", "checkpoints", options.checkpointId);
    mkdirSync(recordsDir, { recursive: true });
    for (const name of ["manifest.json", "prior_context.json", "session_state.json", "runtime.json", "referenced_artifacts.json", "compaction.json", "compaction_requests.jsonl"]) {
      const source = join(sourceCheckpointDir, name);
      if (existsSync(source)) {
        copy(source, join(recordsDir, name));
      }
    }
    const activeRequests = requests.filter((r) => r.index <= primary.index);
    write(join(recordsDir, "model_requests.jsonl"), `${activeRequests.map((r) => JSON.stringify(r)).join("\n")}\n`);
    record("records.split", true, `active holds ${activeRequests.length} request record(s); the attempt suffix moves to evidence`);

    // Evidence: the original attempt's full request/output trace (S4-R1).
    const evidenceDir = join(stagingDir, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    copy(join(sourceCheckpointDir, "model_requests.jsonl"), join(evidenceDir, "model_requests.jsonl"));
    const toolOutputsPath = join(sourceCheckpointDir, "tool_outputs.jsonl");
    const hasToolOutputs = existsSync(toolOutputsPath);
    if (hasToolOutputs) {
      copy(toolOutputsPath, join(evidenceDir, "tool_outputs.jsonl"));
    }

    // tests/test.sh: runtime health check by default; an explicitly supplied
    // verifier script replaces it and is recorded as a task reward (S4-R4).
    const testPath = join(stagingDir, "tests", "test.sh");
    if (options.verifierScript !== undefined) {
      copy(options.verifierScript, testPath);
    } else {
      write(testPath, renderHealthCheckScript(lock));
    }
    chmodSync(testPath, 0o755);

    // metadata.json last: it declares the final inventory and record sets.
    const recordFiles = listRecordFiles(recordsDir).map((p) => toPosix(relative(stagingDir, p)));
    const evidenceRecords = hasToolOutputs
      ? ["evidence/model_requests.jsonl", "evidence/tool_outputs.jsonl"]
      : ["evidence/model_requests.jsonl"];
    write(
      join(stagingDir, "capture", "metadata.json"),
      `${JSON.stringify(renderMetadata({
        taskId,
        checkpointId: options.checkpointId,
        selection,
        createdAt: startedAt,
        verifierStatus: options.verifierScript !== undefined ? "validated-task-reward" : "unvalidated-candidate",
        testKind: options.verifierScript !== undefined ? "task-verifier" : "runtime-health-check",
        objects: [...inventory.values()],
        records: recordFiles,
        evidenceRecords,
      }), null, 2)}\n`,
    );

    // Validate the staged package (S4-R2) before publishing.
    const validation = validatePackage(stagingDir);
    record(
      "package.validated",
      validation.ok,
      validation.ok
        ? validation.checks.map((c) => c.check).join(", ")
        : validation.checks.filter((c) => !c.ok).map((c) => `${c.check}: ${c.detail}`).join("; "),
    );
    if (!validation.ok) {
      return fail("package.validated", "the staged package failed validation; nothing was published");
    }

    // Atomic publish (S4-R5): the target must not exist; rename is atomic.
    const target = join(options.outputDir, taskId);
    if (existsSync(target)) {
      return fail("package.target-exists", `${target} already exists; choose a fresh export root or remove the previous package`);
    }
    renameSync(stagingDir, target);
    record("package.published", true, `renamed staging into ${target}`);
    return { status: "PASS", taskId, checkpointId: options.checkpointId, packageDir: target, stagingDir, checks };
  } catch (err) {
    return fail("package.export-failed", String(err instanceof Error ? (err.stack ?? err.message) : err));
  }
}

interface RuntimeLock {
  readonly image: string;
  readonly imageDigest: string;
  readonly tag: string;
  readonly platform: string;
  readonly opencode: { readonly version: string; readonly url: string; readonly sha256: string; readonly binPath: string };
  readonly aptPackages: Record<string, unknown>;
}

interface InventoryEntry {
  readonly sha256: string;
  readonly bytes: number;
  readonly references: string[];
}

function buildInventory(
  storeRoot: string,
  files: ReadonlyArray<{ readonly path: string; readonly kind: string; readonly sha256?: string }>,
  artifacts: ReadonlyArray<ArtifactReference>,
): Map<string, InventoryEntry> {
  const out = new Map<string, InventoryEntry>();
  const add = (sha256: string, reference: string): void => {
    const entry = out.get(sha256);
    if (entry === undefined) {
      const bytes = statSync(join(storeRoot, "objects", sha256)).size;
      out.set(sha256, { sha256, bytes, references: [reference] });
      return;
    }
    entry.references.push(reference);
  };
  for (const file of files) {
    if (file.kind === "file" && typeof file.sha256 === "string") {
      add(file.sha256, `manifest:${file.path}`);
    }
  }
  for (const artifact of artifacts) {
    // The label is path-free on purpose: artifact originalPaths are capture-host
    // paths that live only in referenced_artifacts.json (a record), never in
    // the authored metadata.
    add(artifact.sha256, "referenced_artifacts.json");
  }
  return out;
}

function renderMetadata(input: {
  taskId: string;
  checkpointId: string;
  selection: { sessionId: string; messageId: string; requestIndex: number; model: string; opencodeVersion: string };
  createdAt: string;
  verifierStatus: string;
  testKind: string;
  objects: readonly InventoryEntry[];
  records: readonly string[];
  evidenceRecords: readonly string[];
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    createdAt: input.createdAt,
    verifier: { status: input.verifierStatus },
    selection: {
      checkpointId: input.checkpointId,
      sessionId: input.selection.sessionId,
      messageId: input.selection.messageId,
      requestIndex: input.selection.requestIndex,
      model: input.selection.model,
      opencodeVersion: input.selection.opencodeVersion,
    },
    instruction: { path: "instruction.md", origin: "selected-user-request" },
    tests: { path: "tests/test.sh", kind: input.testKind },
    environment: { dockerfile: "environment/Dockerfile" },
    runtimeLock: "capture/runtime-lock.json",
    inventory: {
      objects: input.objects,
      records: input.records,
      evidenceRecords: input.evidenceRecords,
    },
    evidence: {
      description: "the selected attempt's own response and tool suffix; excluded from active replay context",
      paths: input.evidenceRecords,
    },
  };
}

/** Generate the package Dockerfile from the runtime lock (no value drift). */
function renderPackageDockerfile(taskId: string, lock: RuntimeLock): string {
  const snapshot = typeof lock.aptPackages["source"] === "string" ? lock.aptPackages["source"] : "";
  const packages = Object.entries(lock.aptPackages)
    .filter(([key, value]) => key !== "source" && key !== "caCertBootstrap" && typeof value === "string")
    .map(([key, value]) => `      ${key}=${String(value)}`)
    .join(" \\\n");
  const caBootstrap = lock.aptPackages["caCertBootstrap"] as { package?: string; sha256?: string } | undefined;
  const caPackage = caBootstrap?.package ?? "ca-certificates_20230311+deb12u1_all.deb";
  const caSha = caBootstrap?.sha256 ?? "";
  return `# Pinned runtime for ${taskId} (S4-R3). Values mirror capture/runtime-lock.json.
# Registries: the digest-pinned base image, the frozen Debian snapshot over
# HTTPS, and the checksum-pinned OpenCode build. Offline execution is not
# claimed; every fetch is pinned and hash-checked.
ARG BASE_IMAGE=${lock.image}@${lock.imageDigest}
FROM \${BASE_IMAGE}

# CA bundle: pinned .deb fetched from the frozen Debian snapshot and
# hash-checked before use (the base image ships no CA bundle).
RUN node -e "fetch(process.argv[1]).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); }).then(b => require('fs').writeFileSync('/tmp/ca-certificates.deb', Buffer.from(b)))" "${snapshot}/pool/main/c/ca-certificates/${caPackage}" \\
    && echo "${caSha}  /tmp/ca-certificates.deb" | sha256sum -c - \\
    && dpkg -x /tmp/ca-certificates.deb /tmp/ca-extract \\
    && mkdir -p /etc/ssl/certs \\
    && cat /tmp/ca-extract/usr/share/ca-certificates/mozilla/*.crt > /etc/ssl/certs/ca-certificates.crt \\
    && rm -rf /tmp/ca-extract /tmp/ca-certificates.deb
RUN set -eux; \\
    printf 'Types: deb\\nURIs: ${snapshot}\\nSuites: bookworm\\nComponents: main\\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\\n' > /etc/apt/sources.list.d/debian.sources; \\
    rm -f /etc/apt/sources.list.d/debian-security.sources; \\
    apt-get -o Acquire::Retries=8 -o Acquire::https::Timeout=60 update; \\
    apt-get -o Acquire::Retries=8 install -y --no-install-recommends \\
${packages}; \\
    rm -rf /var/lib/apt/lists/*

ARG OPENCODE_VERSION=${lock.opencode.version}
ARG OPENCODE_SHA256=${lock.opencode.sha256}
ARG OPENCODE_URL=${lock.opencode.url}
RUN node -e "fetch(process.argv[1]).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); }).then(b => require('fs').writeFileSync('/tmp/opencode.tar.gz', Buffer.from(b)))" "\${OPENCODE_URL}" \\
    && echo "\${OPENCODE_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c - \\
    && mkdir -p /usr/local/opencode \\
    && tar -xzf /tmp/opencode.tar.gz -C /usr/local/opencode \\
    && chmod +x ${lock.opencode.binPath} \\
    && rm /tmp/opencode.tar.gz \\
    && ${lock.opencode.binPath} --version

ENV OPENCODE_BIN=${lock.opencode.binPath}
WORKDIR /work
CMD ["/bin/bash"]
`;
}

function renderHealthCheckScript(lock: RuntimeLock): string {
  return `#!/bin/sh
# Runtime health check (S4-R4). This is NOT a task-success reward: it only
# verifies that the pinned runtime runs. This package's recorded verifier
# status lives in capture/metadata.json.
set -eu
bin="\${OPENCODE_BIN:-${lock.opencode.binPath}}"
test -x "$bin"
"$bin" --version | grep -q "${lock.opencode.version}"
probe="\${TMPDIR:-/tmp}/harness-health-$$"
mkdir -p "$probe"
printf probe > "$probe/probe.txt"
test "$(cat "$probe/probe.txt")" = probe
rm -rf "$probe"
echo "runtime-health-check: PASS (not a task reward)"
`;
}

function readJsonLines<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

function listRecordFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
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

function toPosix(path: string): string {
  return path.split("\\").join("/");
}
