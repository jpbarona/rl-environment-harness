import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { snapshotWorkspace } from "../../src/capture/snapshot.js";
import { RestoreError, selectCheckpoint } from "../../src/restore/select.js";
import { INCLUSION_POLICY, materializeWorkspace, validateManifest } from "../../src/restore/materialize.js";
import { compareTree } from "../../src/restore/compare.js";

let root: string;
let store: string;
let ws: string;
let ckpt1: string;
let ckpt2: string;

/** Build a two-turn fixture store using the real capture code path. */
function buildFixture(): void {
  root = mkdtempSync(join(tmpdir(), "restore-unit-"));
  store = join(root, "store");
  ws = join(root, "workspace");
  mkdirSync(ws, { recursive: true });

  // Turn 1 starting state.
  writeFileSync(join(ws, "notes.md"), "version-1\n");
  writeFileSync(join(ws, "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(ws, "run.sh"), 0o755);
  ckpt1 = snapshotWorkspace(ws, store, "ckpt-turn1").checkpointId;

  // Turn 1 actions: tracked edit, untracked file, ignored file, delete,
  // symlink. Turn 2's checkpoint records the result.
  writeFileSync(join(ws, "notes.md"), "version-2\n");
  writeFileSync(join(ws, "untracked.txt"), "untracked content\n");
  writeFileSync(join(ws, "fixture.ignored"), "ignored fixture content\n");
  rmSync(join(ws, "run.sh"));
  symlinkSync("notes.md", join(ws, "link-to-notes"));
  writeFileSync(join(ws, ".gitignore"), "fixture.ignored\n");

  // Turn 2 record.
  ckpt2 = snapshotWorkspace(ws, store, "ckpt-turn2").checkpointId;

  // Records for both turns: turn 2 first request continues the session.
  for (const [ckpt, classification] of [
    [ckpt1, "task-new-turn"],
    [ckpt2, "task-continuation"],
  ] as const) {
    writeFileSync(
      join(store, "checkpoints", ckpt, "model_requests.jsonl"),
      `${JSON.stringify({
        index: 3,
        classification,
        background: false,
        body: {
          model: "mock-model",
          // Identical prompt text in both turns: identity must distinguish.
          messages: [{ role: "user", content: "same words" }],
        },
      })}\n`,
    );
    writeFileSync(
      join(store, "checkpoints", ckpt, "runtime.json"),
      JSON.stringify({
        turnId: classification === "task-new-turn" ? "turn-00000001" : "turn-00000002",
        sessionId: "ses_test",
        messageId: classification === "task-new-turn" ? "msg_1" : "msg_2",
        mainModel: "mock-model",
        workspaceRoot: ws,
        opencodeVersion: "2.0.18",
      }),
    );
    writeFileSync(
      join(store, "checkpoints", ckpt, "prior_context.json"),
      JSON.stringify({ turnId: "turn", priorMessages: [{ role: "user", content: "same words" }] }),
    );
  }
}

beforeAll(() => {
  buildFixture();
});

describe("S3-R1 selection and preflight", () => {
  it("selects the second turn by checkpoint id with authoritative identity", () => {
    const selection = selectCheckpoint({ storeRoot: store, checkpointId: ckpt2 });
    expect(selection.messageId).toBe("msg_2");
    expect(selection.sessionId).toBe("ses_test");
    expect(selection.requestIndex).toBe(3);
    expect(selection.model).toBe("mock-model");
  });

  it("distinguishes identical prompt text by identity, not text", () => {
    const one = selectCheckpoint({ storeRoot: store, checkpointId: ckpt1 });
    const two = selectCheckpoint({ storeRoot: store, checkpointId: ckpt2 });
    expect(one.messageId).not.toBe(two.messageId);
    // Both captured the same prompt words; selection still resolves each.
    expect(one.messageId).toBe("msg_1");
  });

  it("rejects a conflicting expected identity", () => {
    expect(() =>
      selectCheckpoint({ storeRoot: store, checkpointId: ckpt2, expectedMessageId: "msg_1" }),
    ).toThrow(RestoreError);
  });

  it("rejects an unknown checkpoint id", () => {
    expect(() => selectCheckpoint({ storeRoot: store, checkpointId: "ckpt-nope" })).toThrow(
      /checkpoint-missing/,
    );
  });

  it("rejects a missing object before execution", () => {
    const objectPath = join(store, "objects", "10edf39");
    void objectPath;
    const manifest = JSON.parse(readFileSync(join(store, "checkpoints", ckpt2, "manifest.json"), "utf8")) as {
      files: Array<{ path: string; sha256?: string }>;
    };
    const victim = manifest.files.find((f) => f.sha256 !== undefined)!;
    rmSync(join(store, "objects", victim.sha256!));
    expect(() => selectCheckpoint({ storeRoot: store, checkpointId: ckpt2 })).toThrow(/objects\.missing/);
    // Repair for later tests.
    buildFixture();
  });

  it("rejects a corrupted object", () => {
    const manifest = JSON.parse(readFileSync(join(store, "checkpoints", ckpt2, "manifest.json"), "utf8")) as {
      files: Array<{ path: string; sha256?: string }>;
    };
    const victim = manifest.files.find((f) => f.sha256 !== undefined)!;
    writeFileSync(join(store, "objects", victim.sha256!), "tampered");
    expect(() => selectCheckpoint({ storeRoot: store, checkpointId: ckpt2 })).toThrow(/objects\.corrupt/);
    buildFixture();
  });

  it("repeated selections create no duplicate stored objects", () => {
    const before = readdirSync(join(store, "objects")).length;
    selectCheckpoint({ storeRoot: store, checkpointId: ckpt2 });
    selectCheckpoint({ storeRoot: store, checkpointId: ckpt2 });
    const after = readdirSync(join(store, "objects")).length;
    expect(after).toBe(before);
  });
});

describe("S3-R2 materialization and comparison", () => {
  it("materializes the complete captured tree exactly", () => {
    const selection = selectCheckpoint({ storeRoot: store, checkpointId: ckpt2 });
    void selection;
    const manifest = JSON.parse(readFileSync(join(store, "checkpoints", ckpt2, "manifest.json"), "utf8")) as Parameters<typeof validateManifest>[0];
    const dest = join(root, "restore-a");
    const { restored } = materializeWorkspace(store, manifest, dest);

    // Exact set: tracked edit, untracked, ignored fixture, executable,
    // symlink, .gitignore. Deleted run.sh is absent.
    expect(existsSync(join(dest, "notes.md"))).toBe(true);
    expect(readFileSync(join(dest, "notes.md"), "utf8")).toBe("version-2\n");
    expect(existsSync(join(dest, "untracked.txt"))).toBe(true);
    expect(existsSync(join(dest, "fixture.ignored"))).toBe(true);
    expect(existsSync(join(dest, "run.sh"))).toBe(false);
    expect(readlinkSync(join(dest, "link-to-notes"))).toBe("notes.md");
    expect((JSON.parse(JSON.stringify(manifest)) as { files: Array<{ path: string; mode?: number }> }).files.find((f) => f.path === "notes.md")!.mode).toBe(0o644);

    const comparison = compareTree(manifest.files, dest);
    expect(comparison.ok).toBe(true);
    expect(comparison.differences).toEqual([]);
    expect(restored).toBeGreaterThan(0);
    void INCLUSION_POLICY;
  });

  it("reports a missing file", () => {
    const dest = join(root, "neg-missing");
    const manifest = JSON.parse(readFileSync(join(store, "checkpoints", ckpt2, "manifest.json"), "utf8")) as Parameters<typeof validateManifest>[0];
    materializeWorkspace(store, manifest, dest);
    rmSync(join(dest, "untracked.txt"));
    const comparison = compareTree(manifest.files, dest);
    expect(comparison.ok).toBe(false);
    expect(comparison.differences.some((d) => d.type === "missing" && d.path === "untracked.txt")).toBe(true);
  });

  it("reports a misplaced file by content hash, once", () => {
    const dest = join(root, "neg-misplaced");
    const manifest = JSON.parse(readFileSync(join(store, "checkpoints", ckpt2, "manifest.json"), "utf8")) as Parameters<typeof validateManifest>[0];
    materializeWorkspace(store, manifest, dest);
    const content = readFileSync(join(dest, "untracked.txt"));
    rmSync(join(dest, "untracked.txt"));
    writeFileSync(join(dest, "elsewhere.txt"), content);
    const comparison = compareTree(manifest.files, dest);
    expect(comparison.differences.filter((d) => d.type === "misplaced")).toHaveLength(1);
    expect(comparison.differences.some((d) => d.type === "unexpected" && d.path === "elsewhere.txt")).toBe(false);
  });

  it("reports an unexpected file and directory", () => {
    const dest = join(root, "neg-unexpected");
    const manifest = JSON.parse(readFileSync(join(store, "checkpoints", ckpt2, "manifest.json"), "utf8")) as Parameters<typeof validateManifest>[0];
    materializeWorkspace(store, manifest, dest);
    writeFileSync(join(dest, "sneaky.txt"), "x");
    mkdirSync(join(dest, "sneaky-dir"));
    const comparison = compareTree(manifest.files, dest);
    expect(comparison.differences.some((d) => d.type === "unexpected" && d.path === "sneaky.txt")).toBe(true);
    expect(comparison.differences.some((d) => d.type === "unexpected" && d.path === "sneaky-dir")).toBe(true);
  });

  it("reports an incorrect permission", () => {
    const dest = join(root, "neg-mode");
    const manifest = JSON.parse(readFileSync(join(store, "checkpoints", ckpt2, "manifest.json"), "utf8")) as Parameters<typeof validateManifest>[0];
    void manifest;
    // Use turn 1 which has the executable run.sh.
    const manifest1 = JSON.parse(readFileSync(join(store, "checkpoints", ckpt1, "manifest.json"), "utf8")) as Parameters<typeof validateManifest>[0];
    materializeWorkspace(store, manifest1, dest);
    chmodSync(join(dest, "run.sh"), 0o644);
    const comparison = compareTree(manifest1.files, dest);
    expect(comparison.differences.some((d) => d.type === "mode" && d.path === "run.sh")).toBe(true);
  });

  it("reports an incorrect link target and changed bytes", () => {
    const dest = join(root, "neg-link");
    const manifest = JSON.parse(readFileSync(join(store, "checkpoints", ckpt2, "manifest.json"), "utf8")) as Parameters<typeof validateManifest>[0];
    materializeWorkspace(store, manifest, dest);
    rmSync(join(dest, "link-to-notes"));
    symlinkSync("untracked.txt", join(dest, "link-to-notes"));
    writeFileSync(join(dest, "notes.md"), "tampered\n");
    const comparison = compareTree(manifest.files, dest);
    expect(comparison.differences.some((d) => d.type === "link-target" && d.path === "link-to-notes")).toBe(true);
    expect(comparison.differences.some((d) => d.type === "bytes" && d.path === "notes.md")).toBe(true);
  });
});

describe("S3-R2 safety rejections", () => {
  function syntheticManifest(path: string, extra?: Partial<{ kind: "symlink"; target?: string }>): Parameters<typeof validateManifest>[0] {
    return {
      root: "/synthetic",
      checkpointId: "ckpt-x",
      manifestPath: "/synthetic/manifest.json",
      files: [
        { path: "ok.txt", kind: "file" as const, sha256: createHash("sha256").update("ok").digest("hex"), mode: 0o644 },
        { path, kind: "file" as const, sha256: createHash("sha256").update("x").digest("hex"), mode: 0o644, ...extra },
      ],
    };
  }

  it("rejects absolute, escaping, and backslash paths", () => {
    for (const bad of ["/etc/evil", "../evil", "a/../evil", "a\\b", "./evil"]) {
      expect(() => validateManifest(syntheticManifest(bad)), bad).toThrow(RestoreError);
    }
  });

  it("rejects absolute and escaping symlink targets", () => {
    expect(() => validateManifest(syntheticManifest("l1", { kind: "symlink", target: "/etc/passwd" }))).toThrow(
      /link-absolute/,
    );
    expect(() => validateManifest(syntheticManifest("a/l2", { kind: "symlink", target: "../../etc/passwd" }))).toThrow(
      /link-escaping/,
    );
    // Depth-safe relative target is accepted.
    expect(() => validateManifest(syntheticManifest("a/l3", { kind: "symlink", target: "../ok.txt" }))).not.toThrow();
  });

  it("rejects a symlink parent and unsupported kinds", () => {
    const manifest = syntheticManifest("link-child/inner.txt");
    (manifest.files as Array<{ path: string; kind: string; target?: string; sha256?: string; mode?: number }>).push({
      path: "link-child",
      kind: "symlink",
      target: "ok.txt",
    });
    expect(() => validateManifest(manifest)).toThrow(/symlink-parent/);
    expect(() =>
      validateManifest({
        ...syntheticManifest("w.txt"),
        files: [{ path: "w.txt", kind: "fifo" }] as unknown as Parameters<typeof validateManifest>[0]["files"],
      }),
    ).toThrow(/unsupported-kind/);
  });

  it("writes nothing outside the restore root on rejection", () => {
    const dest = join(root, "neg-unsafe");
    const outside = join(root, "outside-marker");
    expect(() =>
      materializeWorkspace(
        store,
        syntheticManifest("../outside-marker"),
        dest,
      ),
    ).toThrow(RestoreError);
    expect(existsSync(outside)).toBe(false);
  });

  it("restores synthetic secret fixtures as captured, with no credential source", () => {
    // A synthetic secret VALUE (never a personal credential) is part of the
    // captured workspace and is restored as content. No env or key material
    // is consulted by materialization.
    const dest = join(root, "secret-check");
    const sha = createHash("sha256").update("SYNTHETIC-SECRET-VALUE\n").digest("hex");
    const manifest = syntheticManifest("secret.txt");
    writeFileSync(join(store, "objects", manifest.files[0]!.sha256!), "ok");
    (manifest.files[1] as { sha256?: string }).sha256 = sha;
    writeFileSync(join(store, "objects", sha), "SYNTHETIC-SECRET-VALUE\n");
    materializeWorkspace(store, manifest, dest);
    expect(readFileSync(join(dest, "secret.txt"), "utf8")).toContain("SYNTHETIC-SECRET-VALUE");
  });
});