/**
 * S4-R1/R2/R5 unit tests: export the selected checkpoint, validate the
 * package, prove the suffix split, and exercise the failure paths
 * (missing/misplaced files, corrupt objects, schema errors, dangling
 * references, path escapes, forbidden secrets, target collisions, injected
 * write failures, and unchanged source store).
 */
import { describe, expect, it, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { snapshotWorkspace } from "../../src/capture/snapshot.js";
import { exportPackage } from "../../src/package/export.js";
import { validatePackage } from "../../src/package/validate.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

let root: string;
let store: string;
let ckpt: string;
/** The selected prompt, exactly as the fake turn submitted it. */
const PROMPT = "FIXTURE_SECOND create selected-output.txt with selected-result";
const SUFFIX_TOKEN = "attempt-state";
const ARTIFACT_PATH = "/capture/run/home/data/opencode/shell/ab/call-1.out";

function checksumStore(dir: string): string {
  const parts: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        parts.push(`${toRel(dir, full)}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
      }
    }
  };
  walk(dir);
  return parts.join("\n");
}

function toRel(rootDir: string, path: string): string {
  return path.slice(rootDir.length + 1);
}

function copyStore(mutate?: (copy: string) => void): string {
  const copy = join(root, `store-copy-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(copy, { recursive: true });
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      copyDir(join(store, entry.name), join(copy, entry.name));
    } else {
      copyFileSync(join(store, entry.name), join(copy, entry.name));
    }
  }
  mutate?.(copy);
  return copy;
}

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      copyDir(join(from, entry.name), join(to, entry.name));
    } else {
      copyFileSync(join(from, entry.name), join(to, entry.name));
    }
  }
}

function taskRecord(index: number, classification: string, body: Record<string, unknown>): string {
  return `${JSON.stringify({ index, classification, at: new Date().toISOString(), body })}\n`;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "package-unit-"));
  store = join(root, "store");

  // Workspace contents for the selected checkpoint (turn 2 start state).
  const ws = join(root, "workspace");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "notes.md"), "version-2\n");
  writeFileSync(join(ws, "untracked.txt"), "untracked content\n");
  writeFileSync(join(ws, ".env.local"), "LOCAL_FIXTURE=true\n");
  writeFileSync(join(ws, "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(ws, "run.sh"), 0o755);

  // An external truncation artifact referenced by the selected context.
  const artifactContent = "full tool output bytes\n";
  const artifactSha = createHash("sha256").update(artifactContent).digest("hex");
  mkdirSync(join(store, "objects"), { recursive: true });
  writeFileSync(join(store, "objects", artifactSha), artifactContent);

  ckpt = "ckpt-unit0001";
  const manifest = snapshotWorkspace(ws, store, ckpt);
  const manifestRecord = JSON.parse(readFileSync(manifest.manifestPath, "utf8")) as { root: string };
  const capturedWorkspaceRoot = manifestRecord.root;

  // Checkpoint records (Step 2 schema), with a primary request, a suffix
  // continuation, tool outputs, and a referenced artifact.
  const records = join(store, "checkpoints", ckpt);
  writeFileSync(join(records, "runtime.json"), JSON.stringify({
    turnId: "turn-00000002",
    sessionId: "ses_unit",
    messageId: "msg_2",
    mainModel: "mock-model",
    workspaceRoot: capturedWorkspaceRoot,
    opencodeVersion: "2.0.18",
  }));
  writeFileSync(join(records, "session_state.json"), JSON.stringify({ session: { id: "ses_unit" } }));
  writeFileSync(join(records, "prior_context.json"), JSON.stringify({
    turnId: "turn-00000002",
    priorMessages: [
      { role: "user", content: '"FIXTURE_FIRST change the starting files"' },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "(no output)" },
      { role: "assistant", content: "done" },
    ],
  }));
  writeFileSync(
    join(records, "model_requests.jsonl"),
    taskRecord(5, "task-new-turn", {
      model: "mock-model",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: `"${PROMPT}"` },
      ],
    }) + taskRecord(6, "task-continuation", {
      model: "mock-model",
      messages: [
        { role: "user", content: `"${PROMPT}"` },
        { role: "assistant", content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: "shell", arguments: "{\"command\":\"printf attempt-state > suffix.txt\"}" } }] },
        { role: "tool", tool_call_id: "call_9", content: `wrote ${SUFFIX_TOKEN}` },
      ],
    }),
  );
  writeFileSync(join(records, "tool_outputs.jsonl"), `${JSON.stringify({ index: 6, toolOutputs: [{ index: 2, content: `wrote ${SUFFIX_TOKEN}` }] })}\n`);
  writeFileSync(join(records, "referenced_artifacts.json"), `${JSON.stringify([{ originalPath: ARTIFACT_PATH, sha256: artifactSha }])}\n`);
  writeFileSync(join(records, "compaction.json"), JSON.stringify({ source: "proxy-authoritative", summaries: [{ at: new Date().toISOString(), status: 200, summary: "S" }] }));
  writeFileSync(join(records, "compaction_requests.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), body: { messages: [{ role: "user", content: "x" }] } })}\n`);
});

describe("S4-R1/R2 export and validation", () => {
  it("exports the selected checkpoint and the package validates", () => {
    const storeBefore = checksumStore(store);
    const out = join(root, "export-main");
    const outcome = exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: out, repoRoot });
    expect(outcome.status).toBe("PASS");
    const pkg = outcome.packageDir!;

    // Exact layout at the package root.
    expect(readdirSync(pkg).sort()).toEqual(["capture", "environment", "evidence", "instruction.md", "task.toml", "tests"]);
    expect(readdirSync(join(pkg, "capture")).sort()).toEqual(["checkpoints", "metadata.json", "objects", "runtime-lock.json"]);
    expect(readdirSync(join(pkg, "capture", "checkpoints", ckpt)).sort()).toEqual([
      "compaction.json", "compaction_requests.jsonl", "manifest.json", "model_requests.jsonl",
      "prior_context.json", "referenced_artifacts.json", "runtime.json", "session_state.json",
    ]);
    expect(readdirSync(join(pkg, "evidence")).sort()).toEqual(["model_requests.jsonl", "tool_outputs.jsonl"]);
    // S4-R1: instruction bytes are the selected prompt, exactly.
    expect(readFileSync(join(pkg, "instruction.md"), "utf8")).toBe(PROMPT);

    // S4-R1: identities preserved.
    const metadata = JSON.parse(readFileSync(join(pkg, "capture", "metadata.json"), "utf8")) as {
      taskId: string;
      verifier: { status: string };
      selection: { checkpointId: string; sessionId: string; messageId: string; requestIndex: number; model: string };
    };
    expect(metadata.taskId).toBe(`task-${ckpt}`);
    expect(metadata.selection).toMatchObject({ checkpointId: ckpt, sessionId: "ses_unit", messageId: "msg_2", requestIndex: 5, model: "mock-model" });
    const runtime = JSON.parse(readFileSync(join(pkg, "capture", "checkpoints", ckpt, "runtime.json"), "utf8")) as Record<string, string>;
    expect(runtime["sessionId"]).toBe("ses_unit");
    expect(runtime["messageId"]).toBe("msg_2");

    // S4-R1: the attempt suffix lives only in evidence/.
    const active = readFileSync(join(pkg, "capture", "checkpoints", ckpt, "model_requests.jsonl"), "utf8");
    const evidence = readFileSync(join(pkg, "evidence", "model_requests.jsonl"), "utf8");
    expect(active.split("\n").filter((l) => l.trim() !== "")).toHaveLength(1);
    expect(active.includes(SUFFIX_TOKEN)).toBe(false);
    expect(evidence.includes(SUFFIX_TOKEN)).toBe(true);
    expect(evidence.split("\n").filter((l) => l.trim() !== "")).toHaveLength(2);
    expect(readFileSync(join(pkg, "evidence", "tool_outputs.jsonl"), "utf8")).toContain(SUFFIX_TOKEN);
    expect(existsSync(join(pkg, "capture", "checkpoints", ckpt, "tool_outputs.jsonl"))).toBe(false);

    // S4-R2: the package validator passes, including the inventory.
    const validation = validatePackage(pkg);
    expect(validation.checks.filter((c) => !c.ok), JSON.stringify(validation.checks.filter((c) => !c.ok))).toEqual([]);
    expect(validation.ok).toBe(true);

    // S4-R4: default export is an unvalidated candidate with a health check.
    expect(metadata.verifier.status).toBe("unvalidated-candidate");
    expect(readFileSync(join(pkg, "tests", "test.sh"), "utf8")).toContain("not a task reward");

    // S4-R5: the source store is unchanged.
    expect(checksumStore(store)).toBe(storeBefore);
  });

  it("runs the health check script (mechanics only; not a task reward)", () => {
    const out = join(root, "export-health");
    const outcome = exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: out, repoRoot });
    const stubBin = join(root, "stub-opencode");
    mkdirSync(stubBin, { recursive: true });
    const stub = join(stubBin, "opencode");
    writeFileSync(stub, "#!/bin/sh\necho 'opencode 2.0.18'\n");
    chmodSync(stub, 0o755);
    const status = execFileSync("/bin/sh", ["-c", `OPENCODE_BIN=${stub} ${JSON.stringify(join(outcome.packageDir!, "tests", "test.sh"))}`]).toString();
    expect(status).toContain("runtime-health-check: PASS (not a task reward)");
  });

  it("exports twice into independent roots; both validate; store unchanged", () => {
    const storeBefore = checksumStore(store);
    const out1 = join(root, "export-repeat-1");
    const out2 = join(root, "export-repeat-2");
    const one = exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: out1, repoRoot });
    const two = exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: out2, repoRoot });
    expect(one.status).toBe("PASS");
    expect(two.status).toBe("PASS");
    expect(one.packageDir).not.toBe(two.packageDir);
    expect(validatePackage(one.packageDir!).ok).toBe(true);
    expect(validatePackage(two.packageDir!).ok).toBe(true);
    expect(checksumStore(store)).toBe(storeBefore);
  });
});

describe("S4-R4 verifier labeling", () => {
  it("records a supplied verifier as a validated task reward and runs correct/incorrect outputs", () => {
    const verifier = join(repoRoot, "tests", "package", "fixtures", "fixture-verifier.sh");
    const out = join(root, "export-verified");
    const outcome = exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: out, repoRoot, verifierScript: verifier });
    expect(outcome.status).toBe("PASS");
    const pkg = outcome.packageDir!;
    const metadata = JSON.parse(readFileSync(join(pkg, "capture", "metadata.json"), "utf8")) as { verifier: { status: string }; tests: { kind: string } };
    expect(metadata.verifier.status).toBe("validated-task-reward");
    expect(metadata.tests.kind).toBe("task-verifier");
    expect(validatePackage(pkg).ok).toBe(true);

    // Correct output passes; incorrect output fails. Both on scratch trees.
    const correct = join(root, "verify-correct");
    mkdirSync(correct, { recursive: true });
    writeFileSync(join(correct, "selected-output.txt"), "selected-result");
    expect(execFileSync("/bin/sh", [join(pkg, "tests", "test.sh"), correct]).toString()).toContain("fixture-verifier: PASS");
    const wrong = join(root, "verify-wrong");
    mkdirSync(wrong, { recursive: true });
    writeFileSync(join(wrong, "selected-output.txt"), "wrong");
    let failed = false;
    try {
      execFileSync("/bin/sh", [join(pkg, "tests", "test.sh"), wrong]);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});

describe("S4-R2 validation negatives", () => {
  function validPackage(name: string): string {
    const out = join(root, name);
    const outcome = exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: out, repoRoot });
    if (outcome.status !== "PASS") {
      throw new Error(`fixture export failed: ${JSON.stringify(outcome.checks)}`);
    }
    return outcome.packageDir!;
  }

  it("fails on a missing required file", () => {
    const pkg = validPackage("neg-missing-file");
    rmSync(join(pkg, "instruction.md"));
    const validation = validatePackage(pkg);
    expect(validation.ok).toBe(false);
    expect(validation.checks.some((c) => c.check === "layout.files" && !c.ok)).toBe(true);
  });

  it("fails on a misplaced record", () => {
    const pkg = validPackage("neg-misplaced");
    const records = join(pkg, "capture", "checkpoints", ckpt);
    copyFileSync(join(records, "runtime.json"), join(records, "runtime2.json"));
    rmSync(join(records, "runtime.json"));
    const validation = validatePackage(pkg);
    expect(validation.ok).toBe(false);
    expect(validation.checks.some((c) => c.check === "records.present" && !c.ok)).toBe(true);
  });

  it("fails on a corrupt object", () => {
    const pkg = validPackage("neg-corrupt");
    const objects = readdirSync(join(pkg, "capture", "objects"));
    writeFileSync(join(pkg, "capture", "objects", objects[0]!), "tampered");
    const validation = validatePackage(pkg);
    expect(validation.ok).toBe(false);
    expect(validation.checks.some((c) => c.check === "objects.hash" || (c.check === "objects.inventory" && !c.ok))).toBe(true);
  });

  it("fails on an invalid metadata schema", () => {
    const pkg = validPackage("neg-schema");
    const path = join(pkg, "capture", "metadata.json");
    const metadata = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete metadata["selection"];
    writeFileSync(path, JSON.stringify(metadata));
    const validation = validatePackage(pkg);
    expect(validation.ok).toBe(false);
    expect(validation.checks.some((c) => c.check === "metadata.schema" && !c.ok)).toBe(true);
  });

  it("fails on dangling object references in both directions", () => {
    // Declared but not referenced (orphan).
    const orphan = validPackage("neg-orphan");
    const metadataPath = join(orphan, "capture", "metadata.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { inventory: { objects: Array<{ sha256: string; bytes: number; references: string[] }> } };
    metadata["inventory"]["objects"].push({ sha256: "a".repeat(64), bytes: 1, references: [] });
    writeFileSync(metadataPath, JSON.stringify(metadata));
    let validation = validatePackage(orphan);
    expect(validation.ok).toBe(false);

    // Referenced but not declared (omission).
    const omission = validPackage("neg-omission");
    const omissionPath = join(omission, "capture", "metadata.json");
    const omissionMetadata = JSON.parse(readFileSync(omissionPath, "utf8")) as { inventory: { objects: Array<unknown> } };
    omissionMetadata.inventory.objects = omissionMetadata.inventory.objects.slice(1);
    writeFileSync(omissionPath, JSON.stringify(omissionMetadata));
    validation = validatePackage(omission);
    expect(validation.ok).toBe(false);
  });

  it("fails on a path escape in declared records", () => {
    const pkg = validPackage("neg-escape");
    const metadataPath = join(pkg, "capture", "metadata.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { inventory: { records: string[] } };
    metadata.inventory.records.push("../evil.json");
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const validation = validatePackage(pkg);
    expect(validation.ok).toBe(false);
    expect(validation.checks.some((c) => c.check === "paths.safe" && !c.ok)).toBe(true);
  });

  it("fails on a forbidden secret fixture", () => {
    const secretStore = copyStore((copy) => {
      const records = join(copy, "checkpoints", ckpt);
      const requests = readFileSync(join(records, "model_requests.jsonl"), "utf8");
      writeFileSync(join(records, "model_requests.jsonl"), requests.replace("attempt-state > suffix.txt", "attempt-state > suffix.txt; token sk-fixture-forbidden-credential-000000000001"));
    });
    const out = join(root, "neg-secret");
    const outcome = exportPackage({ storeRoot: secretStore, checkpointId: ckpt, outputDir: out, repoRoot });
    expect(outcome.status).toBe("FAIL");
    expect(outcome.checks.some((c) => c.check === "package.validated" && !c.ok)).toBe(true);
    expect(existsSync(join(out, `task-${ckpt}`))).toBe(false);
    expect(validatePackage(outcome.stagingDir).checks.some((c) => c.check === "credentials.absent" && !c.ok)).toBe(true);
    // The uncorrupted store still exports.
    expect(exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: join(root, "neg-secret-ok"), repoRoot }).status).toBe("PASS");
  });

  it("fails on undeclared source-host references in metadata", () => {
    const pkg = validPackage("neg-hostpath");
    const metadataPath = join(pkg, "capture", "metadata.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    metadata["note"] = "seen at /Users/jp/barona/workspace";
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const validation = validatePackage(pkg);
    expect(validation.ok).toBe(false);
    expect(validation.checks.some((c) => c.check === "hostpaths.undeclared" && !c.ok)).toBe(true);
  });

  it("fails when the export target already exists", () => {
    const out = join(root, "neg-collision");
    const first = exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: out, repoRoot });
    expect(first.status).toBe("PASS");
    const second = exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: out, repoRoot });
    expect(second.status).toBe("FAIL");
    expect(second.checks.some((c) => c.check === "package.target-exists" && !c.ok)).toBe(true);
    // The first package is untouched; the staging directory is retained.
    expect(validatePackage(first.packageDir!).ok).toBe(true);
    expect(existsSync(second.stagingDir)).toBe(true);
    rmSync(second.stagingDir, { recursive: true, force: true });
  });
});

describe("S4-R5 injected export-write failure", () => {
  it("publishes nothing, retains staging evidence, and the staging package is invalid", () => {
    const out = join(root, "neg-write-failure");
    const outcome = exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: out, repoRoot, failAfterWrite: 2 });
    expect(outcome.status).toBe("FAIL");
    expect(outcome.checks.some((c) => c.check === "package.export-failed" && !c.ok && c.detail.includes("injected"))).toBe(true);
    // Nothing was published at the target path.
    expect(existsSync(join(out, `task-${ckpt}`))).toBe(false);
    // The staging directory is retained as diagnostic evidence and is NOT a
    // valid package (no partial folder may be accepted as valid).
    expect(existsSync(outcome.stagingDir)).toBe(true);
    expect(validatePackage(outcome.stagingDir).ok).toBe(false);
    rmSync(outcome.stagingDir, { recursive: true, force: true });
  });

  it("a failed export leaves the source store unchanged", () => {
    const storeBefore = checksumStore(store);
    exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: join(root, "neg-write-failure-2"), repoRoot, failAfterWrite: 0 });
    expect(checksumStore(store)).toBe(storeBefore);
  });
});
