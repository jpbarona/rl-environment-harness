/** Bounded child-process execution for session database query/import. */
import { spawnSync } from "node:child_process";

export function runSessionCommand(command: string, args: string[], timeoutMs: number, input?: string) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid session command timeout");
  return spawnSync(command, args, {
    encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL",
    ...(input !== undefined ? { input } : {}),
  });
}
