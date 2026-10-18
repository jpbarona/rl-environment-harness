/** Read a JSONL file into typed records; empty lines are skipped. */
import { readFileSync } from "node:fs";

export function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}
