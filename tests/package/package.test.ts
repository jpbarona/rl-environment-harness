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
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { snapshotWorkspace } from "../../src/capture/snapshot.js";
import { exportPackage } from "../../src/package/export.js";
import { validatePackage, type PackageValidation } from "../../src/package/validate.js";

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
  it("keeps a supplied checker unvalidated without recorded evidence; runs correct/incorrect outputs", () => {
    const verifier = join(repoRoot, "tests", "package", "fixtures", "fixture-verifier.sh");
    const out = join(root, "export-verified");
    const outcome = exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: out, repoRoot, verifierScript: verifier });
    expect(outcome.status).toBe("PASS");
    const pkg = outcome.packageDir!;
    const metadata = JSON.parse(readFileSync(join(pkg, "capture", "metadata.json"), "utf8")) as { verifier: { status: string }; tests: { kind: string } };
    // Supplying a checker must NOT auto-label it validated (S4-R4 fix 4).
    expect(metadata.verifier.status).toBe("unvalidated-candidate");
    expect(metadata.tests.kind).toBe("task-checker");
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

  it("labels validated-task-reward only with recorded validation evidence", () => {
    const verifier = join(repoRoot, "tests", "package", "fixtures", "fixture-verifier.sh");
    const evidence = join(root, "verifier-evidence.json");
    writeFileSync(evidence, JSON.stringify({
      validatedAt: new Date().toISOString(),
      source: "unit fixture validation: correct and incorrect outputs produce expected results",
    }));
    const out = join(root, "export-verified-evidence");
    const outcome = exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: out, repoRoot, verifierScript: verifier, verifierEvidence: evidence });
    expect(outcome.status).toBe("PASS");
    const pkg = outcome.packageDir!;
    const metadata = JSON.parse(readFileSync(join(pkg, "capture", "metadata.json"), "utf8")) as { verifier: { status: string; evidence?: string } };
    expect(metadata.verifier.status).toBe("validated-task-reward");
    expect(metadata.verifier.evidence).toBe("capture/verifier-evidence.json");
    expect(existsSync(join(pkg, "capture", "verifier-evidence.json"))).toBe(true);
    const validation = validatePackage(pkg);
    expect(validation.ok).toBe(true);
    expect(validation.checks.some((c) => c.check === "verifier.evidence" && c.ok)).toBe(true);
  });

  it("fails on missing or malformed verifier evidence", () => {
    const verifier = join(repoRoot, "tests", "package", "fixtures", "fixture-verifier.sh");
    // Evidence declared but the file is absent.
    const missing = exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: join(root, "neg-evidence-missing"), repoRoot, verifierScript: verifier, verifierEvidence: join(root, "no-such-evidence.json") });
    expect(missing.status).toBe("FAIL");
    expect(missing.checks.some((c) => c.check === "package.verifier-evidence-invalid" && !c.ok)).toBe(true);
    // Evidence file exists but is malformed.
    const bad = join(root, "bad-evidence.json");
    writeFileSync(bad, JSON.stringify({ validatedAt: "not-a-timestamp" }));
    const invalid = exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: join(root, "neg-evidence-invalid"), repoRoot, verifierScript: verifier, verifierEvidence: bad });
    expect(invalid.status).toBe("FAIL");
    expect(invalid.checks.some((c) => c.check === "package.verifier-evidence-invalid" && !c.ok)).toBe(true);
    // Evidence without a checker is rejected.
    const orphan = exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: join(root, "neg-evidence-orphan"), repoRoot, verifierEvidence: bad });
    expect(orphan.status).toBe("FAIL");
    expect(orphan.checks.some((c) => c.check === "package.verifier-evidence-without-verifier" && !c.ok)).toBe(true);
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

describe("S4-R2 credential exclusion in instruction and objects", () => {
  it("rejects a synthetic secret inside an exported workspace object before publication", () => {
    // Synthetic value only; never a real key.
    const secret = "sk-synthetic-fixture-secret-0123456789abcdef";
    const secretStore = copyStore((copy) => {
      // Rewrite the notes.md object with secret content and keep the store
      // self-consistent (new object name, manifest updated) so only the
      // credential scan can fail the export.
      const manifestPath = join(copy, "checkpoints", ckpt, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: Array<{ path: string; sha256?: string }> };
      const victim = manifest.files.find((f) => f.path === "notes.md")!;
      const content = `# notes\n${secret}\n`;
      const newSha = createHash("sha256").update(content).digest("hex");
      writeFileSync(join(copy, "objects", newSha), content);
      rmSync(join(copy, "objects", victim.sha256!));
      victim.sha256 = newSha;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    });
    const out = join(root, "neg-object-secret");
    const outcome = exportPackage({ storeRoot: secretStore, checkpointId: ckpt, outputDir: out, repoRoot });
    expect(outcome.status).toBe("FAIL");
    expect(outcome.checks.some((c) => c.check === "package.validated" && !c.ok && c.detail.includes("credentials.absent"))).toBe(true);
    expect(existsSync(join(out, `task-${ckpt}`))).toBe(false);
    const validation = validatePackage(outcome.stagingDir);
    expect(validation.checks.some((c) => c.check === "credentials.absent" && !c.ok && c.detail.includes("capture/objects/"))).toBe(true);
    rmSync(outcome.stagingDir, { recursive: true, force: true });
  });

  it("rejects a synthetic secret inside the preserved instruction", () => {
    // The instruction bytes come from the selected prompt; plant the secret
    // there through a store copy.
    const secret = "sk-synthetic-fixture-secret-fedcba9876543210";
    const secretStore = copyStore((copy) => {
      const requestsPath = join(copy, "checkpoints", ckpt, "model_requests.jsonl");
      const lines = readFileSync(requestsPath, "utf8").trim().split("\n").map((line) => {
        const rec = JSON.parse(line) as { classification: string; body?: { messages?: Array<{ role: string; content?: string }> } };
        if (rec.classification.startsWith("task") && rec.body?.messages !== undefined) {
          const user = rec.body.messages.find((m) => m.role === "user");
          if (user !== undefined) {
            user.content = JSON.stringify(`${PROMPT} with key ${secret}`);
          }
        }
        return JSON.stringify(rec);
      });
      writeFileSync(requestsPath, `${lines.join("\n")}\n`);
    });
    const out = join(root, "neg-instruction-secret");
    const outcome = exportPackage({ storeRoot: secretStore, checkpointId: ckpt, outputDir: out, repoRoot });
    expect(outcome.status).toBe("FAIL");
    expect(existsSync(join(out, `task-${ckpt}`))).toBe(false);
    const validation = validatePackage(outcome.stagingDir);
    expect(validation.checks.some((c) => c.check === "credentials.absent" && !c.ok && c.detail.includes("instruction.md"))).toBe(true);
    rmSync(outcome.stagingDir, { recursive: true, force: true });
  });
});

describe("S4-R2 runtime lock schema and Dockerfile agreement", () => {
  it("fails when the exported lock is missing required pins", () => {
    const out = join(root, "export-lock-schema");
    const outcome = exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: out, repoRoot });
    const pkg = outcome.packageDir!;
    const lockPath = join(pkg, "capture", "runtime-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    // Drop the sqlite3 pin.
    delete (lock["aptPackages"] as Record<string, unknown>)["sqlite3"];
    writeFileSync(lockPath, JSON.stringify(lock));
    const validation = validatePackage(pkg);
    expect(validation.ok).toBe(false);
    expect(validation.checks.some((c) => c.check === "lock.schema" && !c.ok && c.detail.includes("sqlite3"))).toBe(true);

    // Unparseable digest.
    const broken = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    broken["imageDigest"] = "not-a-digest";
    writeFileSync(lockPath, JSON.stringify(broken));
    const second = validatePackage(pkg);
    expect(second.checks.some((c) => c.check === "lock.schema" && !c.ok)).toBe(true);
  });

  it("fails when the Dockerfile disagrees with the lock on a pinned value", () => {
    const out = join(root, "export-lock-agreement");
    const outcome = exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: out, repoRoot });
    const pkg = outcome.packageDir!;
    const dockerfilePath = join(pkg, "environment", "Dockerfile");
    // Drift one apt version.
    let df = readFileSync(dockerfilePath, "utf8");
    df = df.replace("sqlite3=3.40.1-2+deb12u2", "sqlite3=3.40.1-2+deb12u3");
    writeFileSync(dockerfilePath, df);
    let validation = validatePackage(pkg);
    expect(validation.ok).toBe(false);
    expect(validation.checks.some((c) => c.check === "environment.pinned" && !c.ok && c.detail.includes("sqlite3"))).toBe(true);

    // Drift the OpenCode checksum ARG.
    const lock = JSON.parse(readFileSync(join(pkg, "capture", "runtime-lock.json"), "utf8")) as { opencode: { sha256: string } };
    df = readFileSync(dockerfilePath, "utf8");
    df = df.replace(`ARG OPENCODE_SHA256=${lock.opencode.sha256}`, `ARG OPENCODE_SHA256=${"f".repeat(64)}`);
    writeFileSync(dockerfilePath, df);
    validation = validatePackage(pkg);
    expect(validation.checks.some((c) => c.check === "environment.pinned" && !c.ok && c.detail.includes("sha256 ARG"))).toBe(true);

    // Unlockable extra package in the install block.
    df = readFileSync(dockerfilePath, "utf8");
    df = df.replace("      git=", "      curl=1:7.88.1-10+deb12u8 \\\n      git=");
    writeFileSync(dockerfilePath, df);
    validation = validatePackage(pkg);
    expect(validation.checks.some((c) => c.check === "environment.pinned" && !c.ok && c.detail.includes("curl"))).toBe(true);
  });
});

describe("S4-R2 malformed metadata stops validation with a named failure", () => {
  function tamperedMetadata(name: string, mutate: (metadata: Record<string, unknown>) => void): PackageValidation {
    const pkg = join(root, name);
    // Build a fresh valid package, then corrupt its metadata copy.
    const outcome = exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: join(root, `${name}-src`), repoRoot });
    if (outcome.status !== "PASS") {
      throw new Error("fixture export failed");
    }
    cpSync(outcome.packageDir!, pkg, { recursive: true });
    const metadataPath = join(pkg, "capture", "metadata.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    mutate(metadata);
    writeFileSync(metadataPath, JSON.stringify(metadata));
    return validatePackage(pkg);
  }

  it("missing selection stops immediately with metadata.schema, without throwing", () => {
    const validation = tamperedMetadata("neg-null-selection", (m) => {
      delete m["selection"];
    });
    expect(validation.ok).toBe(false);
    expect(validation.checks).toHaveLength(1);
    expect(validation.checks[0]?.check).toBe("metadata.schema");
    expect(validation.checks[0]?.detail).toContain("selection identity incomplete");
  });

  it("null and wrong-typed fields produce named schema failures, not exceptions", () => {
    const nullVerifier = tamperedMetadata("neg-null-verifier", (m) => {
      m["verifier"] = null;
    });
    expect(nullVerifier.ok).toBe(false);
    expect(nullVerifier.checks[0]?.check).toBe("metadata.schema");

    const nullInventory = tamperedMetadata("neg-null-inventory", (m) => {
      m["inventory"] = null;
    });
    expect(nullInventory.ok).toBe(false);
    expect(nullInventory.checks[0]?.check).toBe("metadata.schema");

    const wrongTypes = tamperedMetadata("neg-wrong-types", (m) => {
      const selection = m["selection"] as Record<string, unknown>;
      selection["sessionId"] = 123;
      selection["requestIndex"] = "five";
      m["schemaVersion"] = "1";
      m["inventory"] = { objects: "all", records: [], evidenceRecords: [] };
    });
    expect(wrongTypes.ok).toBe(false);
    expect(wrongTypes.checks[0]?.check).toBe("metadata.schema");
    expect(wrongTypes.checks[0]?.detail).toContain("selection identity incomplete");
  });

  it("a JSON-null metadata document returns the named failure", () => {
    const pkg = join(root, "neg-null-doc");
    const outcome = exportPackage({ storeRoot: store, checkpointId: ckpt, outputDir: join(root, "neg-null-doc-src"), repoRoot });
    cpSync(outcome.packageDir!, pkg, { recursive: true });
    writeFileSync(join(pkg, "capture", "metadata.json"), "null\n");
    const validation = validatePackage(pkg);
    expect(validation.ok).toBe(false);
    expect(validation.checks).toHaveLength(1);
    expect(validation.checks[0]?.check).toBe("metadata.schema");
  });
});
