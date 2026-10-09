import { describe, expect, it, afterAll } from "vitest";
import { createE2E } from "../../src/capture/e2e.js";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * End-to-end capture-boundary proof (design.md Step 2 acceptance gate):
 * real `opencode run` child processes talk only through the recorder proxy
 * to the mock model. Assertions run against the persisted event trace and
 * live server state, not against source code.
 */

const E2E_TIMEOUT = 240_000;

const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const fn of cleanups) {
    await fn();
  }
});

describe("capture boundary e2e (real opencode v2.0.18)", () => {
  it(
    "turn 1: capture commits before the first model request is forwarded; tool executes; turn 2 chains with its own capture",
    async () => {
      const env = await createE2E({
        name: "ordered-capture",
        captureDelayMs: 250,
      });
      cleanups.push(env.cleanup);

      // --- Turn 1: prompt asks the mock model to use the bash tool. ---
      const r1 = await env.runPrompt("USE_TOOL write the probe file please");
      expect(r1.code, `opencode run failed. stderr:\n${r1.stderr}\nstdout:\n${r1.stdout}`).toBe(0);

      // The mock model's bash tool call actually executed in the workspace.
      const probe = join(env.workspace, "tool-probe.txt");
      expect(existsSync(probe), `tool-probe.txt missing; stdout:\n${r1.stdout}`).toBe(true);
      expect(readFileSync(probe, "utf8")).toBe("captured-by-tool");
      expect(env.trace.filter("tool.gate.allowed").length).toBeGreaterThan(0);
      expect(env.trace.filter("request.arrived").some(e => e.data["purpose"] === "primary")).toBe(true);

      // Upstream-arrival evidence: a tool-result round is unambiguously
      // task traffic (title calls never carry tool outputs); it must reach
      // the upstream only after its turn's capture commit.
      const commitTimes = env.trace.filter("capture.committed").map((e) => Date.parse(e.ts));
      const toolRoundObservation = env.mock.observations.find((o) => o.sawToolOutput);
      expect(toolRoundObservation, "the tool result round must reach the upstream").toBeDefined();
      const firstCommit = Math.min(...commitTimes);
      expect(
        toolRoundObservation?.receivedAt,
        `task round arrived at ${toolRoundObservation?.receivedAt}, first commit at ${firstCommit}`,
      ).toBeGreaterThanOrEqual(firstCommit - 5);

      // Trace order: for turn 1, capture.committed precedes the first
      // forwarded request of that turn.
      const begin1 = env.trace.filter("turn.begin")[0];
      expect(begin1?.data["turnId"]).toBe("turn-00000001");
      const commit1 = env.trace.filter("capture.committed")[0];
      expect(commit1?.data["turnId"]).toBe("turn-00000001");
      const forwarded1 = env.trace
        .filter("request.forwarded")
        .filter((e) => e.data["turnId"] === "turn-00000001")[0];
      expect(forwarded1).toBeDefined();
      expect(commit1?.seq).toBeLessThan(forwarded1?.seq ?? Number.MAX_SAFE_INTEGER);

      // The workspace snapshot store exists for turn 1: shared object store,
      // per-checkpoint manifests.
      const storeRootEarly = join(env.runDir, "capture-store");
      const checkpointsDirEarly = join(storeRootEarly, "checkpoints");
      const checkpointIdsEarly = readdirSync(checkpointsDirEarly);
      expect(checkpointIdsEarly.length).toBeGreaterThanOrEqual(1);
      const firstManifest = JSON.parse(
        readFileSync(join(checkpointsDirEarly, checkpointIdsEarly[0] ?? "", "manifest.json"), "utf8"),
      ) as { files: Array<{ path: string; kind: string; sha256?: string }> };
      const paths = firstManifest.files.map((f) => f.path);
      expect(paths).toContain("notes.md");
      expect(paths).toContain("run.sh");
      expect(paths).toContain("link-to-notes");

      // --- Turn 2: continuation session with a new prompt. ---
      const r2 = await env.runPrompt("second turn, plain reply only", {
        continueLast: true,
      });
      expect(r2.code, `opencode run failed. stderr:\n${r2.stderr}\nstdout:\n${r2.stdout}`).toBe(0);

      const begins = env.trace.filter("turn.begin");
      expect(begins.length).toBeGreaterThanOrEqual(2);
      const begin2 = begins[1];
      expect(begin2?.data["turnId"]).toBe("turn-00000002");
      const commit2 = env.trace
        .filter("capture.committed")
        .filter((e) => e.data["turnId"] === "turn-00000002")[0];
      expect(commit2).toBeDefined();
      const forwarded2 = env.trace
        .filter("request.forwarded")
        .filter((e) => e.data["turnId"] === "turn-00000002")[0];
      expect(forwarded2).toBeDefined();
      expect(commit2?.seq).toBeLessThan(forwarded2?.seq ?? Number.MAX_SAFE_INTEGER);

      // Shared content store across checkpoints: at least two checkpoints,
      // every manifest references the same object for the unchanged
      // notes.md, and that object exists exactly once in objects/.
      const storeRoot = join(env.runDir, "capture-store");
      const checkpointsDir = join(storeRoot, "checkpoints");
      const checkpointIds = readdirSync(checkpointsDir);
      expect(checkpointIds.length).toBeGreaterThanOrEqual(2);
      const notesHashes = new Set<string>();
      for (const ckpt of checkpointIds) {
        const manifest = JSON.parse(
          readFileSync(join(checkpointsDir, ckpt, "manifest.json"), "utf8"),
        ) as { checkpointId: string; files: Array<{ path: string; sha256?: string }> };
        expect(manifest.checkpointId).toBe(ckpt);
        const notes = manifest.files.find((f) => f.path === "notes.md");
        expect(notes?.sha256).toBeDefined();
        notesHashes.add(notes?.sha256 ?? "");
      }
      expect(notesHashes.size, "all checkpoints must reference the same notes.md object").toBe(1);
      const objectFiles = readdirSync(join(storeRoot, "objects")).filter((f) => f === [...notesHashes][0]);
      expect(objectFiles).toHaveLength(1);

      // Turn identity: every turn is bound to sessionID + user-messageID.
      const turnRecords = [...env.proxy.turns.values()];
      expect(turnRecords.length).toBeGreaterThanOrEqual(2);
      for (const turn of turnRecords) {
        expect(turn.sessionId, `turn ${turn.id} missing sessionId`).toMatch(/^ses_/);
        expect(turn.messageId, `turn ${turn.id} missing messageId`).toMatch(/^msg_/);
      }

      // Each checkpoint has its own id; turn ids are distinct.
      const checkpointIdsInTrace = env.trace.filter("capture.committed").map((e) => e.data["checkpointId"]);
      expect(new Set(checkpointIdsInTrace).size).toBe(checkpointIdsInTrace.length);
      expect(checkpointIdsInTrace.every((id) => typeof id === "string" && id.startsWith("ckpt-"))).toBe(true);

      // Authenticated forwarding: opencode's provider Authorization header
      // reached the upstream and was never persisted.
      expect(env.mock.receivedAuth.length).toBeGreaterThan(0);
      expect(env.mock.receivedAuth[0]).toBe("Bearer e2e-runtime-only-key");

      // Every task model call maps to an open turn id, never background.
      // (Title-generation calls on the task model are background by marker
      // and excluded here; see the background assertion below.)
      const taskRequests = env.proxy.requests.filter((r) => r.model === "mock-model" && !r.background);
      expect(taskRequests.length).toBeGreaterThan(0);
      expect(taskRequests.every((r) => r.turnId !== null && /^turn-\d{8}$/.test(r.turnId)), JSON.stringify(taskRequests)).toBe(true);

      // Background calls (title generation on the small model) were observed
      // and classified separately from task calls.
      const backgroundRequests = env.proxy.requests.filter((r) => r.background);
      expect(
        backgroundRequests.some((r) => r.model === "mock-small"),
        `expected a background small-model call; requests: ${JSON.stringify(env.proxy.requests.map((r) => ({ model: r.model, classification: r.classification })))}`,
      ).toBe(true);

      // No credentials in the persisted trace on disk.
      const traceOnDisk = readFileSync(env.traceFile, "utf8");
      expect(traceOnDisk.includes("authorization")).toBe(false);
      expect(traceOnDisk.includes("Bearer")).toBe(false);
      expect(traceOnDisk.toLowerCase().includes("api-key")).toBe(false);

      // No key material anywhere in the run tree: trace, capture store,
      // isolated home, opencode logs.
      const found = scanFilesForKey(env.runDir, "e2e-runtime-only-key");
      expect(found, `key material found under ${env.runDir}: ${JSON.stringify(found)}`).toHaveLength(0);

      removeRunDirCheck(env);
    },
    E2E_TIMEOUT,
  );

  it("captures the actual first-turn file changes before the selected second attempt", async () => {
    const emitted = new Set<string>();
    const firstPrompt = "FIXTURE_FIRST change the starting files";
    const secondPrompt = "FIXTURE_SECOND create selected-output.txt with selected-result";
    const env = await createE2E({ name: "two-turn-deltas", captureDelayMs: 600,
      script: ({ model, lastUserText }) => {
        if (model !== "mock-model" || emitted.has(lastUserText)) return { content: "done" };
        let command: string;
        if (lastUserText.includes(firstPrompt)) {
          command = "printf 'version-2\\n' > notes.md; printf 'scratch-data\\n' > scratch.tmp; printf 'LOCAL_FIXTURE=true\\n' > .env.local; rm obsolete.txt; node -e \"require('fs').writeFileSync('first-tool-start.txt', String(Date.now()))\"";
        } else if (lastUserText.includes(secondPrompt)) {
          command = "node -e \"require('fs').writeFileSync('second-tool-start.txt', String(Date.now()))\"; printf 'selected-result' > selected-output.txt; printf 'attempt-state' > notes.md";
        } else return { content: "done" };
        emitted.add(lastUserText);
        return { toolCalls: [{ id: `call_${emitted.size}`, name: "shell", args: { command, description: "execute acceptance fixture" } }] };
      },
    });
    cleanups.push(env.cleanup);
    const r1 = await env.runPrompt(firstPrompt);
    expect(r1.code, r1.stdout + r1.stderr).toBe(0);
    expect(readFileSync(join(env.workspace, "notes.md"), "utf8")).toBe("version-2\n");
    const r2 = await env.runPrompt(secondPrompt, { continueLast: true });
    expect(r2.code, r2.stdout + r2.stderr).toBe(0);
    const turn2 = env.proxy.turns.get("turn-00000002");
    expect(turn2?.promptText).toBe(JSON.stringify(secondPrompt));
    const store = join(env.runDir, "capture-store");
    const dir = join(store, "checkpoints", turn2?.checkpointId ?? "missing");
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
      files: Array<{ path: string; sha256?: string; mode?: number; target?: string }> };
    const priorState = JSON.parse(readFileSync(join(dir, "session_state.json"), "utf8")) as {
      messages: Array<{ type: string; text?: string }> };
    expect(priorState.messages.some(m => m.type === "user" && m.text?.includes(firstPrompt))).toBe(true);
    expect(priorState.messages.some(m => m.type === "user" && m.text?.includes(secondPrompt))).toBe(false);
    const records = new Map(manifest.files.map(f => [f.path, f]));
    const contents = (path: string): string => readFileSync(join(store, "objects", records.get(path)?.sha256 ?? "missing"), "utf8");
    expect(contents("notes.md")).toBe("version-2\n");
    expect(contents("scratch.tmp")).toBe("scratch-data\n");
    expect(contents(".env.local")).toBe("LOCAL_FIXTURE=true\n");
    expect(records.has("obsolete.txt")).toBe(false);
    expect(records.has("selected-output.txt")).toBe(false);
    expect(records.has("second-tool-start.txt")).toBe(false);
    expect(records.get("link-to-notes")?.target).toBe("notes.md");
    expect(records.get("run.sh")?.mode).toBe(0o755);
    const commit = env.trace.filter("capture.committed").find(e => e.data["turnId"] === turn2?.id);
    const committedAt = Date.parse(commit?.ts ?? "");
    const actualToolStart = Number(readFileSync(join(env.workspace, "second-tool-start.txt"), "utf8"));
    expect(actualToolStart).toBeGreaterThanOrEqual(committedAt);
    const secondArrivals = env.mock.observations.filter(o => o.lastUserText.includes(secondPrompt));
    expect(secondArrivals.length).toBeGreaterThan(0);
    expect(secondArrivals.every(o => o.receivedAt >= committedAt)).toBe(true);
    expect(readFileSync(join(env.workspace, "selected-output.txt"), "utf8")).toBe("selected-result");
    expect(readFileSync(join(env.workspace, "notes.md"), "utf8")).toBe("attempt-state");
  }, E2E_TIMEOUT);

  it(
    "fail closed: when capture fails, the turn is blocked and the model never executes",
    async () => {
      const env = await createE2E({
        name: "fail-closed",
        failCapture: true,
      });
      cleanups.push(env.cleanup);

      // Run opencode and kill it once blocking is proven (after the first
      // request.blocked); opencode's retry backoff otherwise outlives the
      // test. The kill is expected and asserted via the exit code check
      // below.
      const r = await env.runPromptUntil(
        "USE_TOOL this attempt must be blocked",
        () => env.trace.filter("request.blocked").length >= 1,
        { maxMs: 120_000 },
      );

      // OpenCode must not have received a model response: run exits nonzero
      // or reports an error in its output.
      const blocked = r.code !== 0 || /error|fail/i.test(r.stdout + r.stderr);
      expect(blocked, `expected blocked execution; code=${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(true);

      // The mock model received zero task-model requests: nothing reached
      // the provider for execution. Background title calls may still occur.
      expect(env.mock.observations.filter((o) => o.model === "mock-model")).toHaveLength(0);

      // Trace proves the fail-closed path. Background calls (title
      // generation) may forward, but every task-model request is blocked.
      const types = env.trace.events.map((e) => e.type);
      expect(types).toContain("turn.begin");
      expect(types).toContain("capture.failed");
      expect(types).toContain("request.blocked");
      const forwardedTask = env.trace
        .filter("request.forwarded")
        .filter((e) => e.data["background"] !== true);
      expect(
        forwardedTask,
        `non-background requests forwarded: ${JSON.stringify(forwardedTask)}`,
      ).toHaveLength(0);
      expect(env.trace.filter("capture.committed")).toHaveLength(0);
      expect(existsSync(join(env.workspace, "tool-probe.txt"))).toBe(false);
      expect(
        env.proxy.requests.filter((req) => req.model === "mock-model" && !req.background).every((req) => !req.forwarded),
      ).toBe(true);

      removeRunDirCheck(env);
    },
    E2E_TIMEOUT,
  );
});

/** Keep run directories as persisted evidence under gitignored work/. */
function removeRunDirCheck(env: { runDir: string }): void {
  if (!existsSync(env.runDir)) {
    throw new Error(`evidence directory missing: ${env.runDir}`);
  }
}

/** Recursively scan text files under dir for a secret string. */
function scanFilesForKey(dir: string, secret: string): string[] {
  const hits: string[] = [];
  function walk(path: string): void {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          if (readFileSync(full, "utf8").includes(secret)) {
            hits.push(full);
          }
        } catch {
          // Binary or unreadable; skip.
        }
      }
    }
  }
  walk(dir);
  return hits;
}