import { createHash } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/** Complete tree types; never traverse symlinks or mistake them for additions. */
export function describeWorkspace(root: string): Array<{ path: string; kind: "file" | "directory" | "symlink"; target?: string; sha256?: string }> {
  const entries: Array<{ path: string; kind: "file" | "directory" | "symlink"; target?: string; sha256?: string }> = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix + entry.name;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) entries.push({ path, kind: "symlink", target: readlinkSync(full) });
      else if (entry.isDirectory()) { entries.push({ path, kind: "directory" }); walk(full, path + "/"); }
      else entries.push({ path, kind: "file", sha256: createHash("sha256").update(readFileSync(full)).digest("hex") });
    }
  };
  walk(root, "");
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

