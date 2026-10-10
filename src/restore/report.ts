/** Shared deterministic report completion for successful and failed restore runs. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RESTORE_CHECKS = [
  "selection.identity", "objects.verified", "workspace.materialized", "workspace.tree",
  "workspace.git-init", "workspace.config-rebind", "artifacts.materialized",
  "session.db-init", "session.project-query", "session.seeded", "request.interception",
  "request.comparison", "outbound.inference-count",
] as const;
export interface ReportCheck { readonly check: string; readonly ok: boolean; readonly detail: string }

export function writeRestoreResult(
  output: string, status: "PASS" | "FAIL" | "BLOCKED", checkpoint: string,
  started: number, checks: readonly ReportCheck[], extra: Record<string, unknown> = {},
): void {
  mkdirSync(output, { recursive: true });
  const complete = [...checks];
  if (status !== "PASS") {
    for (const check of RESTORE_CHECKS) {
      if (!complete.some((entry) => entry.check === check)) {
        complete.push({ check, ok: false, detail: "not run: restore stopped before this check" });
      }
    }
  }
  // Keep the same report layout on every exit. A placeholder explicitly
  // states why evidence does not exist; it never fabricates a request.
  for (const name of ["selection.json", "runtime.json", "comparison.json", "regenerated-request.json"]) {
    const path = join(output, name);
    if (!existsSync(path)) {
      writeFileSync(path, `${JSON.stringify({ status: "unavailable", reason: "not produced before restore stopped", checkpoint }, null, 2)}\n`);
    }
  }
  const trace = join(output, "trace.jsonl");
  if (!existsSync(trace)) writeFileSync(trace, "");
  writeFileSync(join(output, "result.json"), `${JSON.stringify({
    ...extra, status, checkpoint, runStarted: new Date(started).toISOString(), checks: complete,
    evidence: Object.fromEntries(["selection.json", "runtime.json", "comparison.json", "regenerated-request.json", "trace.jsonl"].map((name) => [name, name])),
  }, null, 2)}\n`);
}
