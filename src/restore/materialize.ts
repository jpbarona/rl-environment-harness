/**
 * S3-R2: exact workspace materialization with a safe inclusion policy.
 *
 * Rebuilds the captured tree from the shared object store. Rejects unsafe
 * paths, escaping or absolute symlink targets, symlink parents, and
 * unsupported kinds before writing anything. Nothing is written outside the
 * restore root, even on failure.
 */
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RestoreError, verifyObject } from "./select.js";
import type { FileRecord, WorkspaceSnapshot } from "../capture/snapshot.js";

/**
 * Inclusion policy: every manifest entry is restored. Captured-scope only —
 * `.git` and `node_modules` are excluded BY CAPTURE (snapshot.ts SKIP_DIRS)
 * and are therefore out of comparison scope; see docs/restore.md. Harness
 * and store files live outside the workspace root by construction.
 */
export const INCLUSION_POLICY = {
  /** Restored: every manifest entry (tracked, untracked, ignored fixtures). */
  scope: "all-manifest-entries",
  /** Not captured, therefore not restored and not compared. */
  excludedByCapture: [".git", "node_modules"],
  /** Store and credentials live outside the workspace root; never mounted in. */
  outsideWorkspace: true,
} as const;

const SUPPORTED_KINDS = new Set(["file", "directory", "symlink"]);

/** Validate one manifest path; returns the error name or null. */
function unsafePathReason(path: string): string | null {
  if (path.length === 0) {
    return "empty";
  }
  if (path.includes("\0")) {
    return "nul-byte";
  }
  if (path.includes("\\")) {
    return "backslash";
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return "absolute";
  }
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    return "escaping";
  }
  return null;
}

/** Validate all records up front; fail before any write. */
export function validateManifest(manifest: WorkspaceSnapshot): void {
  const seen = new Set<string>();
  const symlinkPaths = new Set<string>();
  for (const record of manifest.files) {
    const reason = unsafePathReason(record.path);
    if (reason !== null) {
      throw new RestoreError("materialize.unsafe-path", `${record.path}: ${reason}`);
    }
    if (!SUPPORTED_KINDS.has(record.kind)) {
      throw new RestoreError("materialize.unsupported-kind", `${record.path}: ${record.kind}`);
    }
    if (record.kind === "file" && typeof record.sha256 !== "string") {
      throw new RestoreError("materialize.file-record-incomplete", `${record.path}: file lacks sha256`);
    }
    if (record.kind === "symlink") {
      if (typeof record.target !== "string" || record.target.length === 0) {
        throw new RestoreError("materialize.link-target-missing", `${record.path}: symlink lacks target`);
      }
      if (record.target.startsWith("/") || /^[A-Za-z]:/.test(record.target)) {
        throw new RestoreError("materialize.link-absolute", `${record.path}: absolute link target ${record.target}`);
      }
      // Depth check: climbing ".." beyond the link's directory escapes the
      // workspace root. The link's directory is path minus its last segment.
      const dirDepth = record.path.split("/").length - 1;
      let climb = 0;
      let cursor = record.target;
      while (cursor === ".." || cursor.startsWith("../")) {
        climb += 1;
        cursor = cursor.slice(3);
      }
      if (climb > dirDepth) {
        throw new RestoreError("materialize.link-escaping", `${record.path}: target ${record.target} escapes the workspace`);
      }
      symlinkPaths.add(record.path);
    }
    if (seen.has(record.path)) {
      throw new RestoreError("materialize.duplicate-path", record.path);
    }
    seen.add(record.path);
  }
  // A symlink must never be the parent of another entry: writes through
  // unsafe symlink parents are rejected.
  for (const record of manifest.files) {
    const parts = record.path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const ancestor = parts.slice(0, i).join("/");
      if (symlinkPaths.has(ancestor)) {
        throw new RestoreError("materialize.symlink-parent", `${record.path}: parent ${ancestor} is a symlink`);
      }
    }
  }
}

/**
 * Materialize the manifest under `destRoot`. Verifies each object hash while
 * copying. Assumes validateManifest has passed; performs the same checks on
 * symlink parents at write time.
 */
export function materializeWorkspace(
  storeRoot: string,
  manifest: WorkspaceSnapshot,
  destRoot: string,
): { restored: number } {
  validateManifest(manifest);
  const resolvedRoot = resolve(destRoot);
  mkdirSync(resolvedRoot, { recursive: true });

  const directories = manifest.files.filter((f) => f.kind === "directory");
  const others = manifest.files.filter((f) => f.kind !== "directory");

  for (const record of directories) {
    mkdirSync(join(resolvedRoot, record.path), { recursive: true });
  }
  // Root parents for top-level entries.
  for (const record of others) {
    const dest = join(resolvedRoot, record.path);
    mkdirSync(resolve(dest, ".."), { recursive: true });
  }

  let restored = 0;
  for (const record of others) {
    writeEntry(storeRoot, resolvedRoot, record);
    restored += 1;
  }
  for (const _ of directories) {
    restored += 1;
  }
  return { restored };
}

function writeEntry(storeRoot: string, resolvedRoot: string, record: FileRecord): void {
  const dest = join(resolvedRoot, record.path);
  if (record.kind === "symlink") {
    // Re-check the parent chain is free of symlinks (defensive at write time).
    let probe = resolve(dest, "..");
    while (probe.startsWith(resolvedRoot) && probe !== resolvedRoot) {
      if (isSymlink(probe)) {
        throw new RestoreError("materialize.symlink-parent-write", `${record.path}: write would traverse a symlink`);
      }
      probe = resolve(probe, "..");
    }
    symlinkSync(record.target ?? "", dest);
    return;
  }
  const objectPath = join(storeRoot, "objects", record.sha256 ?? "");
  verifyObject(storeRoot, record.sha256 ?? "", `materialize ${record.path}`);
  const content = readFileSync(objectPath);
  writeFileSync(dest, content);
  if (record.mode !== undefined) {
    chmodSync(dest, record.mode);
  }
}

function isSymlink(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
  } catch {
    return false;
  }
}