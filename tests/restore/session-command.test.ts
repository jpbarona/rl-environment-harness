import { describe, it, expect } from "vitest";
import { runSessionCommand } from "../../src/restore/session-command.js";

describe("bounded session commands", () => {
  it("kills a hung child and reports the timeout", () => {
    const result = runSessionCommand(process.execPath, ["-e", "while (true) {}"], 100);
    expect(result.status).not.toBe(0);
    expect(result.signal).toBe("SIGKILL");
    expect((result.error as NodeJS.ErrnoException).code).toBe("ETIMEDOUT");
  });
  it("preserves input/output on success and rejects invalid bounds", () => {
    const result = runSessionCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], 2000, "SQL input");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("SQL input");
    expect(() => runSessionCommand(process.execPath, [], NaN)).toThrow(/timeout/);
  });
});
