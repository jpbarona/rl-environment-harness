import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { rewardFinalizerSource, criteriaSmokeSource } from "../../src/checkpoint/harbor-task.js";
import { buildWriterMessages, parseWriterOutput } from "../../src/checkpoint/writer.js";

function finalize(scores: unknown): { code: number | null; reward?: number } {
  const dir = mkdtempSync(join(tmpdir(), "checkpoint-grade-"));
  writeFileSync(join(dir, "finalize.py"), rewardFinalizerSource());
  writeFileSync(join(dir, "components.json"), JSON.stringify(scores));
  writeFileSync(join(dir, "details.json"), JSON.stringify({ reward: { components: [{ name: "checks", detail: { score: (scores as Record<string, unknown>)["checks"] } }] } }));
  const run = spawnSync("python3", [join(dir, "finalize.py"), join(dir, "components.json"), join(dir, "reward.json"), join(dir, "details.json")], { encoding: "utf8" });
  return run.status === 0 ? { code: 0, ...JSON.parse(readFileSync(join(dir, "reward.json"), "utf8")) } : { code: run.status };
}

describe("required task outcomes gate solver reward", () => {
  it("gives no credit for unchanged files when the required outcome fails", () => {
    expect(finalize({ checks: 0, judge: 1, reward: 0.5 })).toEqual({ code: 0, reward: 0 });
  });
  it("retains fractional rubric rewards after required checks pass", () => {
    expect(finalize({ checks: 1, judge: 0.6, reward: 0.8 })).toEqual({ code: 0, reward: 0.8 });
  });
  it("rejects missing or invalid metrics instead of inventing a score", () => {
    expect(finalize({ reward: 1 }).code).not.toBe(0);
    expect(finalize({ checks: 2, reward: 1 }).code).not.toBe(0);
  });
  it("passes negative examples to validation without weakening exact-content requirements", () => {
    const envelope = { taskName: "hello", taskDescription: "Write hello", instructionMd: "Write exactly hello", checksPy: "import rewardkit as rk\nrk.file_exists('hello.txt')", judgeToml: null, solveSh: "printf hello > hello.txt", invalidExamples: [{ name: "extra newline", script: "printf '\\n' >> hello.txt" }] };
    expect(parseWriterOutput(JSON.stringify(envelope)).invalidExamples).toEqual(envelope.invalidExamples);
    expect(() => parseWriterOutput(JSON.stringify({ ...envelope, invalidExamples: [{ name: "x", script: "" }] }))).toThrow("must not be empty");
    const system = buildWriterMessages({ description: "failure", selectedPrompt: "exactly hello", priorContextExcerpt: "", workspaceFiles: [], attemptExcerpt: "", judgeModelPlaceholder: "JUDGE_MODEL_PLACEHOLDER" })[0]!.content;
    expect(system).toContain("do not tolerate trailing newlines");
    expect(system).toContain("unrelated-file edit");
  });
});

describe("writer repair diagnostics", () => {
  it("returns the actual registration error instead of a truncated discovery traceback", () => {
    const root = mkdtempSync(join(tmpdir(), "checkpoint-registration-"));
    writeFileSync(join(root, "smoke.py"), criteriaSmokeSource());
    writeFileSync(join(root, "checks.py"), "@criterion(description='test')\ndef broken(): return True\n");
    const run = spawnSync("python3", [join(root, "smoke.py"), join(root, "checks.py")], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe("NameError: name 'criterion' is not defined");
  });
});
