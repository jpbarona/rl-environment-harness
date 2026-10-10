import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RESTORE_CHECKS, writeRestoreResult } from "../../src/restore/report.js";

describe("complete failure evidence", () => {
  it("retains completed checks and real evidence, marks unrun checks, and resolves every reference", () => {
    const root = mkdtempSync(join(tmpdir(), "restore-report-"));
    try {
      writeFileSync(join(root, "selection.json"), JSON.stringify({ checkpoint: "selected" }));
      writeRestoreResult(root, "FAIL", "selected", 0, [
        { check: "selection.identity", ok: true, detail: "verified" },
        { check: "objects.corrupt", ok: false, detail: "object hash mismatch" },
      ]);
      const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
      expect(result.status).toBe("FAIL");
      expect(result.checks.find((entry: { check: string }) => entry.check === "selection.identity").ok).toBe(true);
      for (const check of RESTORE_CHECKS.filter((name) => name !== "selection.identity")) {
        expect(result.checks.find((entry: { check: string }) => entry.check === check).detail).toContain("not run:");
      }
      expect(JSON.parse(readFileSync(join(root, "selection.json"), "utf8"))).toEqual({ checkpoint: "selected" });
      for (const reference of Object.values(result.evidence)) {
        expect(() => readFileSync(join(root, reference as string))).not.toThrow();
      }
      const request = JSON.parse(readFileSync(join(root, "regenerated-request.json"), "utf8"));
      expect(request.status).toBe("unavailable");
      expect(request.body).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
