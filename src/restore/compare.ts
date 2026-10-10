/**
 * S3-R2: exact tree comparison between the manifest and an actual restored
 * root. Reports missing, misplaced, unexpected, kind, mode, byte, and link
 * differences with structured entries. Directory modes are not recorded by
 * capture and are never compared.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { FileRecord } from "../capture/snapshot.js";

export type DifferenceType =
  | "missing"
  | "misplaced"
  | "unexpected"
  | "kind"
  | "mode"
  | "bytes"
  | "link-target"
  | "unreadable";

export interface TreeDifference {
  readonly type: DifferenceType;
  readonly path: string;
  readonly expected?: string | undefined;
  readonly actual?: string | undefined;
}

export interface TreeComparison {
  readonly ok: boolean;
  readonly expectedEntries: number;
  readonly actualEntries: number;
  readonly differences: TreeDifference[];
}

interface ActualEntry {
  kind: "file" | "symlink" | "directory";
  mode?: number | undefined;
  sha256?: string | undefined;
  target?: string | undefined;
}

/** Walk the actual root and hash every regular file. */
function scanActual(root: string): Map<string, ActualEntry> {
  const out = new Map<string, ActualEntry>();
  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const rel = relative(root, absolute).split("\\").join("/");
      let kind: ActualEntry["kind"];
      if (entry.isSymbolicLink()) {
        kind = "symlink";
      } else if (entry.isDirectory()) {
        kind = "directory";
      } else if (entry.isFile()) {
        kind = "file";
      } else {
        kind = "file";
      }
      if (kind === "symlink") {
        let target: string | undefined;
        try {
          target = readlinkSync(absolute);
        } catch {
          target = undefined;
        }
        out.set(rel, { kind, target });
        continue;
      }
      if (kind === "directory") {
        out.set(rel, { kind });
        walk(absolute);
        continue;
      }
      try {
        const st = statSync(absolute);
        const content = readFileSync(absolute);
        out.set(rel, {
          kind,
          mode: st.mode & 0o777,
          sha256: createHash("sha256").update(content).digest("hex"),
        });
      } catch {
        out.set(rel, { kind: "file", sha256: undefined });
      }
    }
  }
  walk(root);
  return out;
}

function expectedKey(record: FileRecord): ActualEntry {
  if (record.kind === "symlink") {
    return { kind: "symlink", target: record.target };
  }
  if (record.kind === "directory") {
    return { kind: "directory" };
  }
  return { kind: "file", mode: record.mode, sha256: record.sha256 };
}

/**
 * Compare the manifest (expected) against the actual tree. Every manifest
 * entry must exist with matching kind, bytes, permissions, and link target;
 * every actual entry must be expected. The comparison is positional and
 * complete: a path present in the manifest but living elsewhere on disk
 * reports both missing and unexpected.
 */
export function compareTree(manifestFiles: readonly FileRecord[], actualRoot: string): TreeComparison {
  const actual = scanActual(actualRoot);
  const differences: TreeDifference[] = [];

  const expectedPaths = new Set<string>();
  for (const record of manifestFiles) {
    expectedPaths.add(record.path);
  }
  // Hash claims: an actual entry whose bytes match a missing expected file
  // is a misplaced file; claim it so it is not also reported as unexpected.
  const claimedByMisplacement = new Set<string>();
  for (const record of manifestFiles) {
    if (record.kind !== "file" || record.sha256 === undefined) {
      continue;
    }
    if (actual.has(record.path)) {
      continue;
    }
    for (const [path, entry] of actual) {
      if (entry.kind === "file" && entry.sha256 === record.sha256 && !expectedPaths.has(path)) {
        claimedByMisplacement.add(path);
        differences.push({ type: "misplaced", path: record.path, expected: record.path, actual: path });
        break;
      }
    }
  }
  for (const record of manifestFiles) {
    const want = expectedKey(record);
    const have = actual.get(record.path);
    if (have === undefined) {
      const alreadyReported = differences.some((d) => d.type === "misplaced" && d.path === record.path);
      if (!alreadyReported) {
        differences.push({ type: "missing", path: record.path });
      }
      continue;
    }
    if (have.kind !== want.kind) {
      differences.push({ type: "kind", path: record.path, expected: want.kind, actual: have.kind });
      continue;
    }
    if (want.target !== undefined && have.target !== want.target) {
      differences.push({ type: "link-target", path: record.path, expected: want.target, actual: have.target });
    }
    if (want.sha256 !== undefined) {
      if (have.sha256 === undefined) {
        differences.push({ type: "unreadable", path: record.path });
      } else if (have.sha256 !== want.sha256) {
        differences.push({ type: "bytes", path: record.path, expected: want.sha256, actual: have.sha256 });
      }
    }
    if (want.mode !== undefined && have.mode !== undefined && have.mode !== want.mode) {
      differences.push({
        type: "mode",
        path: record.path,
        expected: want.mode.toString(8),
        actual: have.mode.toString(8),
      });
    }
  }
  for (const path of actual.keys()) {
    if (!expectedPaths.has(path) && !claimedByMisplacement.has(path)) {
      differences.push({ type: "unexpected", path });
    }
  }
  differences.sort((a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type));
  return {
    ok: differences.length === 0,
    expectedEntries: manifestFiles.length,
    actualEntries: actual.size,
    differences,
  };
}