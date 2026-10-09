import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { join, relative } from "node:path";

export type FileKind = "file" | "symlink" | "directory";

export interface FileRecord {
  /** Path relative to the workspace root, POSIX separators. */
  readonly path: string;
  readonly kind: FileKind;
  /** POSIX permission bits, recorded for files only. */
  readonly mode?: number;
  readonly size?: number;
  /** SHA-256 of the file contents; contents are stored once under objects/. */
  readonly sha256?: string;
  /** Symlink target as recorded on disk. */
  readonly target?: string;
}

export interface WorkspaceSnapshot {
  readonly root: string;
  readonly checkpointId: string;
  readonly files: FileRecord[];
  readonly manifestPath: string;
}

const SKIP_DIRS = new Set([".git", "node_modules"]);

/**
 * Capture the declared workspace:
 * - `<storeRoot>/checkpoints/<checkpointId>/manifest.json`: file records
 *   (paths, modes, links, hashes) for this checkpoint.
 * - `<storeRoot>/objects/<sha256>`: unique file contents, shared across all
 *   checkpoints (content-addressed; unchanged files are never duplicated).
 */
export function snapshotWorkspace(
  root: string,
  storeRoot: string,
  checkpointId: string,
): WorkspaceSnapshot {
  const objectsDir = join(storeRoot, "objects");
  const manifestDir = join(storeRoot, "checkpoints", checkpointId);
  mkdirSync(objectsDir, { recursive: true });
  mkdirSync(manifestDir, { recursive: true });
  const files: FileRecord[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const rel = relative(root, absolute).split("\\").join("/");
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          continue;
        }
        files.push({ path: rel, kind: "directory" });
        walk(absolute);
        continue;
      }
      if (entry.isSymbolicLink()) {
        files.push({ path: rel, kind: "symlink", target: readlinkSync(absolute) });
        continue;
      }
      const content = readFileSync(absolute);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const objectPath = join(objectsDir, sha256);
      if (!existsSyncNoThrow(objectPath)) {
        writeFileSync(objectPath, content);
      }
      const st = statSync(absolute);
      files.push({
        path: rel,
        kind: "file",
        mode: st.mode & 0o777,
        size: st.size,
        sha256,
      });
    }
  }

  walk(root);
  const manifestPath = join(manifestDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({ root, checkpointId, files }, null, 2)}\n`);
  return { root, checkpointId, files, manifestPath };
}

/** Materialize a snapshot (used by tests to prove capture completeness). */
export function restoreSnapshot(snapshot: WorkspaceSnapshot, storeRoot: string, destRoot: string): void {
  const objectsDir = join(storeRoot, "objects");
  mkdirSync(destRoot, { recursive: true });
  for (const record of snapshot.files) {
    const dest = join(destRoot, record.path);
    if (record.kind === "directory") {
      mkdirSync(dest, { recursive: true });
      continue;
    }
    if (record.kind === "symlink") {
      symlinkSync(record.target ?? "", dest);
      continue;
    }
    writeFileSync(dest, readFileSync(join(objectsDir, record.sha256 ?? "")));
    if (record.mode !== undefined) {
      chmodSync(dest, record.mode);
    }
  }
}

function existsSyncNoThrow(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}