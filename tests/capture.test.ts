import { describe, expect, it } from "vitest";
import { EventTrace, messageText } from "../src/capture/trace.js";
import { snapshotWorkspace, restoreSnapshot } from "../src/capture/snapshot.js";
import { CaptureProxy } from "../src/capture/proxy.js";
import { MockModelServer, type MockScript } from "../src/capture/mock-model.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, chmodSync, rmSync, statSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import http from "node:http";

function makeTemp(): string {
  return mkdtempSync(join(tmpdir(), "capture-unit-"));
}

// One mock component (MockModelServer) serves as the upstream provider
// for both unit and e2e tests.
async function startUpstream(script?: MockScript): Promise<MockModelServer> {
  const mock = new MockModelServer(script ?? (() => ({ content: "ok" })));
  await mock.start();
  return mock;
}

async function post(url: string, body: unknown, path = "/v1/chat/completions", headers?: Record<string, string>): Promise<{ status: number; text: string }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-capture-purpose": "primary", "x-capture-session": "s1", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

function taskBody(prompt: string, model = "mock-model"): unknown {
  return {
    model,
    messages: [{ role: "user", content: prompt }],
  };
}

async function postEvent(proxyUrl: string, type: string, data: unknown): Promise<void> {
  const res = await fetch(`${proxyUrl}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, data }),
  });
  expect(res.status).toBe(204);
}

/** Identity event for one user message in one session. */
function identity(sessionID: string, messageID: string, text: string): { type: string; data: unknown } {
  return { type: "user.message", data: { sessionID, messageID, text } };
}

function spreadIdentity(event: { type: string; data: unknown }): [string, unknown] {
  return [event.type, event.data];
}

/** Raw HTTP request with an arbitrary request target (proxy-style paths). */
function rawRequest(baseURL: string, requestTarget: string, body: unknown, auth?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const base = new URL(baseURL);
    const req = http.request(
      {
        host: base.hostname,
        port: base.port,
        method: "POST",
        path: requestTarget,
        headers: {
          "content-type": "application/json",
          "x-capture-purpose": "primary", "x-capture-session": "s1",
          ...(auth !== undefined ? { authorization: auth } : {}),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

function generateSelfSignedCert(): { key: string; cert: string } {
  const dir = makeTemp();
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 2 -nodes -subj "/CN=127.0.0.1"`,
    { cwd: dir, stdio: "ignore" },
  );
  const key = readFileSync(join(dir, "key.pem"), "utf8");
  const cert = readFileSync(join(dir, "cert.pem"), "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { key, cert };
}

function statModeSync(path: string): number {
  return statSync(path).mode;
}

describe("EventTrace", () => {
  it("appends ordered events with monotonic sequence numbers", () => {
    const trace = new EventTrace();
    trace.append("a", { x: 1 });
    trace.append("b", { y: 2 });
    expect(trace.events.map((e) => e.type)).toEqual(["a", "b"]);
    expect(trace.events[0]?.seq).toBe(1);
    expect(trace.events[1]?.seq).toBe(2);
  });

  it("persists events to disk in order", () => {
    const dir = makeTemp();
    const file = join(dir, "trace.jsonl");
    const trace = new EventTrace(file);
    trace.append("turn.begin", { turnId: "t1" });
    trace.append("capture.committed", { turnId: "t1" });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ seq: 1, type: "turn.begin" });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ seq: 2, type: "capture.committed" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("redacts non-allowlisted headers", () => {
    const redacted = EventTrace.redactHeaders({
      Authorization: "Bearer secret",
      "x-api-key": "secret2",
      "Content-Type": "application/json",
      "user-agent": "opencode/2.0.18",
    });
    expect(Object.keys(redacted).sort()).toEqual(["content-type", "user-agent"]);
  });
});

describe("messageText", () => {
  it("reads string content and text parts", () => {
    expect(messageText("hello")).toBe("hello");
    expect(
      messageText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
    expect(messageText(undefined)).toBe("");
  });
});

describe("snapshotWorkspace", () => {
  it("captures files, modes, symlinks, and content-addresses objects", () => {
    const ws = makeTemp();
    const store = makeTemp();
    writeFileSync(join(ws, "a.txt"), "alpha");
    writeFileSync(join(ws, "b.sh"), "#!/bin/sh\n");
    chmodSync(join(ws, "b.sh"), 0o755);
    symlinkSync("a.txt", join(ws, "link"));
    mkdirSync(join(ws, "sub"));
    writeFileSync(join(ws, "sub", "a-copy.txt"), "alpha");
    mkdirSync(join(ws, ".git"));
    writeFileSync(join(ws, ".git", "ignored"), "x");

    const snap = snapshotWorkspace(ws, store, "ckpt-test0001");
    const paths = snap.files.map((f) => f.path).sort();
    expect(paths).toEqual(["a.txt", "b.sh", "link", "sub", "sub/a-copy.txt"]);

    const a = snap.files.find((f) => f.path === "a.txt");
    const copy = snap.files.find((f) => f.path === "sub/a-copy.txt");
    expect(a?.sha256).toBe(copy?.sha256);
    const link = snap.files.find((f) => f.path === "link");
    expect(link?.target).toBe("a.txt");
    const b = snap.files.find((f) => f.path === "b.sh");
    expect(b?.mode).toBe(0o755);

    // Content-addressed: two identical files share one object.
    const objects = snap.files
      .filter((f) => f.kind === "file")
      .map((f) => f.sha256)
      .filter((h): h is string => h !== undefined);
    expect(new Set(objects).size).toBe(2);

    // Manifest lives under checkpoints/<checkpointId>/; objects under objects/.
    expect(snap.manifestPath).toBe(join(store, "checkpoints", "ckpt-test0001", "manifest.json"));
    expect(existsSync(join(store, "objects", a?.sha256 ?? ""))).toBe(true);

    // Restore reproduces contents, mode, and link target.
    const dest = join(makeTemp(), "restored");
    restoreSnapshot(snap, store, dest);
    expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("alpha");
    expect(readFileSync(join(dest, "link"), "utf8")).toBe("alpha");
    const mode = statModeSync(join(dest, "b.sh"));
    expect(mode & 0o777).toBe(0o755);

    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });
});

describe("CaptureProxy: execution-frame identity and capture barrier", () => {
  it("binds requests inside an execution window; capture commits before forwarding", async () => {
    const ws = makeTemp();
    const store = makeTemp();
    writeFileSync(join(ws, "f.txt"), "x");
    const trace = new EventTrace();
    const mock = await startUpstream();
    const proxy = new CaptureProxy({
      upstreamURL: `${mock.url}/v1`,
      mainModel: "mock-model",
      trace,
      workspaceRoot: ws,
      captureStoreDir: store,
      captureDelayMs: 100,
    });
    const url = await proxy.start();

    await postEvent(url, ...spreadIdentity(identity("s1", "m1", "hello world")));
    await postEvent(url, "execution.started", { sessionID: "s1" });
    const res = await post(url, taskBody("hello world"));
    expect(res.status).toBe(200);

    // Ordering proof: capture.committed precedes the forward event, and the
    // mock observed the request only after that.
    const commit = trace.filter("capture.committed")[0];
    const forward = trace.filter("request.forwarded")[0];
    expect(commit?.seq).toBeLessThan(forward?.seq ?? Number.MAX_SAFE_INTEGER);
    expect(mock.observations.length).toBe(1);
    expect(mock.observations[0]?.receivedAt).toBeGreaterThanOrEqual(
      commit !== undefined ? Date.parse(commit.ts) - 5 : 0,
    );

    // Bound to the turn by position (window), not by text.
    const recorded = proxy.requests[0];
    expect(recorded?.turnId).toBe("turn-00000001");
    expect(recorded?.classification).toBe("task-new-turn");

    // Continuation rounds inside the window map to the same turn via
    // explicit identity (the open window), regardless of text.
    const cont = await post(url, {
      model: "mock-model",
      messages: [
        { role: "user", content: "hello world" },
        { role: "assistant", content: "ok" },
        { role: "tool", content: "tool output" },
      ],
    });
    expect(cont.status).toBe(200);
    const contRecorded = proxy.requests.at(-1);
    expect(contRecorded?.turnId).toBe("turn-00000001");
    expect(contRecorded?.classification).toBe("task-continuation");

    // Window closes on execution.ended; a further request is held, not
    // attributed by text.
    await postEvent(url, "execution.ended", { sessionID: "s1" });
    const afterClose = post(url, taskBody("hello world"));
    await sleep(150);
    expect(mock.observations.length).toBe(2);
    expect(trace.events.some((e) => e.type === "request.held")).toBe(true);
    expect(trace.events.some((e) => e.type === "execution.window.closed")).toBe(true);

    // A NEW message identity opens a new turn and releases the held request
    // to the NEW turn, even with identical text.
    await postEvent(url, ...spreadIdentity(identity("s1", "m2", "hello world")));
    expect((await afterClose).status).toBe(200);
    const released = proxy.requests.filter((r) => r.classification === "task-new-turn");
    expect(released.length).toBe(2);
    expect(released[1]?.turnId).toBe("turn-00000002");
    expect(trace.filter("capture.committed")).toHaveLength(2);

    await proxy.stop();
    await mock.stop();
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  it("holds requests arriving before identity and capture; forwards after both complete", async () => {
    const ws = makeTemp();
    const store = makeTemp();
    writeFileSync(join(ws, "f.txt"), "x");
    const trace = new EventTrace();
    const mock = await startUpstream();
    const proxy = new CaptureProxy({
      upstreamURL: `${mock.url}/v1`,
      mainModel: "mock-model",
      trace,
      workspaceRoot: ws,
      captureStoreDir: store,
      // Capture deliberately longer than any legacy disambiguation window.
      captureDelayMs: 600,
    });
    const url = await proxy.start();

    // Request arrives FIRST (no window, no identity yet).
    const pending = post(url, taskBody("late identity prompt"));
    await sleep(150);
    expect(mock.observations.length).toBe(0);
    expect(trace.events.some((e) => e.type === "request.held")).toBe(true);

    // Identity + window open; capture takes 600 ms; then forward.
    await postEvent(url, ...spreadIdentity(identity("s1", "m1", "late identity prompt")));
    const res = await pending;
    expect(res.status).toBe(200);
    expect(mock.observations.length).toBe(1);

    const commit = trace.filter("capture.committed")[0];
    const forward = trace.filter("request.forwarded")[0];
    expect(commit?.seq).toBeLessThan(forward?.seq ?? Number.MAX_SAFE_INTEGER);
    const held = proxy.requests[0];
    expect(held?.turnId).toBe("turn-00000001");
    expect(held?.classification).toBe("task-new-turn");
    expect(proxy.turns.get("turn-00000001")?.sessionId).toBe("s1");
    expect(proxy.turns.get("turn-00000001")?.messageId).toBe("m1");

    await proxy.stop();
    await mock.stop();
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  it("fails with a clear error when identity never arrives (timeout)", async () => {
    const ws = makeTemp();
    const store = makeTemp();
    const trace = new EventTrace();
    const mock = await startUpstream();
    const proxy = new CaptureProxy({
      upstreamURL: `${mock.url}/v1`,
      mainModel: "mock-model",
      trace,
      workspaceRoot: ws,
      captureStoreDir: store,
      identityTimeoutMs: 300,
    });
    const url = await proxy.start();

    const res = await post(url, taskBody("never identified"));
    expect(res.status).toBe(503);
    expect(JSON.parse(res.text)).toMatchObject({ error: "identity-unresolved", reason: "identity-timeout" });
    expect(mock.observations.length).toBe(0);
    expect(trace.events.some((e) => e.type === "identity.timeout")).toBe(true);
    expect(trace.events.some((e) => e.type === "request.forwarded")).toBe(false);

    await proxy.stop();
    await mock.stop();
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  it("capture failure permanently seals the turn; retries never recapture", async () => {
    const ws = makeTemp();
    const store = makeTemp();
    const trace = new EventTrace();
    const mock = await startUpstream();
    const proxy = new CaptureProxy({
      upstreamURL: `${mock.url}/v1`,
      mainModel: "mock-model",
      trace,
      workspaceRoot: ws,
      captureStoreDir: store,
      failCapture: true,
      maxCaptureAttempts: 3,
    });
    const url = await proxy.start();

    await postEvent(url, ...spreadIdentity(identity("s1", "m1", "hello world")));
    await postEvent(url, "execution.started", { sessionID: "s1" });

    // Attempt 1: blocked.
    const r1 = await post(url, taskBody("hello world"));
    expect(r1.status).toBe(502);
    // Attempt 2: remains sealed, no recapture.
    const r2 = await post(url, taskBody("hello world"));
    expect(r2.status).toBe(502);
    // Attempt 3: remains sealed.
    const r3 = await post(url, taskBody("hello world"));
    expect(r3.status).toBe(502);
    // Attempt 4: same terminal error, still no recapture.
    const r4 = await post(url, taskBody("hello world"));
    expect(r4.status).toBe(502);
    expect(JSON.parse(r4.text)).toMatchObject({ reason: "turn-sealed-after-capture-failure" });

    expect(mock.observations.length).toBe(0);
    expect(trace.filter("capture.failed")).toHaveLength(1);
    expect(trace.filter("capture.committed")).toHaveLength(0);
    expect(trace.events.map((e) => e.type)).toContain("request.blocked");
    expect(proxy.requests.every((r) => !r.forwarded)).toBe(true);

    await proxy.stop();
    await mock.stop();
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  it("rejects missing authoritative call metadata without forwarding", async () => {
    const ws = makeTemp(); const store = makeTemp(); const trace = new EventTrace(); const mock = await startUpstream();
    const proxy = new CaptureProxy({ upstreamURL: `${mock.url}/v1`, mainModel: "mock-model", trace,
      workspaceRoot: ws, captureStoreDir: store }); const url = await proxy.start();
    try {
      const response = await fetch(`${url}/v1/chat/completions`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(taskBody("unidentified")) });
      expect(response.status).toBe(503); expect(mock.observations).toHaveLength(0);
    } finally { await proxy.stop(); await mock.stop(); rmSync(ws, { recursive: true }); rmSync(store, { recursive: true }); }
  });

  it("declared required unsupported state fails closed", async () => {
    const ws = makeTemp(); const store = makeTemp(); const trace = new EventTrace(); const mock = await startUpstream();
    const proxy = new CaptureProxy({ upstreamURL: `${mock.url}/v1`, mainModel: "mock-model", trace,
      workspaceRoot: ws, captureStoreDir: store }); const url = await proxy.start();
    try {
      await postEvent(url, "user.message", { sessionID: "s1", messageID: "m1", text: "missing state",
        requiredState: { unsupported: ["compaction source unavailable"] } });
      expect((await post(url, taskBody("missing state"))).status).toBe(502);
      expect(mock.observations).toHaveLength(0);
      expect(proxy.turns.get("turn-00000001")?.captureState).toBe("failed");
    } finally { await proxy.stop(); await mock.stop(); rmSync(ws, { recursive: true }); rmSync(store, { recursive: true }); }
  });

  it("the explicit tool gate rejects missing identity and unready capture", async () => {
    const ws = makeTemp(); const store = makeTemp(); const trace = new EventTrace(); const mock = await startUpstream();
    const proxy = new CaptureProxy({ upstreamURL: `${mock.url}/v1`, mainModel: "mock-model", trace,
      workspaceRoot: ws, captureStoreDir: store, captureDelayMs: 600 });
    const url = await proxy.start();
    try {
      expect((await post(url, {}, "/tool-gate")).status).toBe(503);
      await postEvent(url, ...spreadIdentity(identity("s1", "m1", "gate")));
      expect((await post(url, { sessionID: "s1", messageID: "m1" }, "/tool-gate")).status).toBe(502);
      expect(mock.observations).toHaveLength(0);
      expect((await post(url, taskBody("gate"))).status).toBe(200);
      expect((await post(url, { sessionID: "s1", messageID: "m1" }, "/tool-gate")).status).toBe(204);
      await postEvent(url, "execution.ended", { sessionID: "s1" });
      expect((await post(url, { sessionID: "s1", messageID: "m1" }, "/tool-gate")).status).toBe(502);
    } finally { await proxy.stop(); await mock.stop(); rmSync(ws, { recursive: true }); rmSync(store, { recursive: true }); }
  });

  it("a transient filesystem failure seals the old turn but a new identity recovers", async () => {
    const ws = makeTemp();
    const store = makeTemp();
    const mock = await startUpstream();
    const trace = new EventTrace();
    // The store is initially unusable. Repairing it must NOT reopen m1.
    writeFileSync(join(store, "objects"), "not a directory");
    const proxy = new CaptureProxy({ upstreamURL: `${mock.url}/v1`, mainModel: "mock-model", trace,
      workspaceRoot: ws, captureStoreDir: store });
    const url = await proxy.start();
    try {
      await postEvent(url, ...spreadIdentity(identity("s1", "m1", "same")));
      expect((await post(url, taskBody("same"))).status).toBe(502);
      rmSync(join(store, "objects"));
      expect((await post(url, taskBody("same"))).status).toBe(502);
      expect(mock.observations).toHaveLength(0);
      expect(proxy.turns.get("turn-00000001")?.captureAttempts).toBe(1);
      await postEvent(url, "execution.ended", { sessionID: "s1" });
      await postEvent(url, ...spreadIdentity(identity("s1", "m2", "same")));
      expect((await post(url, taskBody("same"))).status).toBe(200);
      expect(mock.observations).toHaveLength(1);
    } finally { await proxy.stop(); await mock.stop(); rmSync(ws, { recursive: true }); rmSync(store, { recursive: true }); }
  });

  it("context persistence failure seals a turn even after storage is repaired", async () => {
    const ws = makeTemp(); const store = makeTemp(); const trace = new EventTrace();
    const mock = await startUpstream();
    const proxy = new CaptureProxy({ upstreamURL: `${mock.url}/v1`, mainModel: "mock-model", trace,
      workspaceRoot: ws, captureStoreDir: store });
    const url = await proxy.start();
    try {
      await postEvent(url, ...spreadIdentity(identity("s1", "m1", "hello")));
      const checkpoint = proxy.turns.get("turn-00000001")?.checkpointId ?? "";
      const blockedPath = join(store, "checkpoints", checkpoint, "prior_context.json");
      mkdirSync(blockedPath);
      expect((await post(url, taskBody("hello"))).status).toBe(502);
      rmSync(blockedPath, { recursive: true });
      expect((await post(url, taskBody("hello"))).status).toBe(502);
      expect(mock.observations).toHaveLength(0);
      expect(proxy.turns.get("turn-00000001")?.captureState).toBe("failed");
    } finally { await proxy.stop(); await mock.stop(); rmSync(ws, { recursive: true }); rmSync(store, { recursive: true }); }
  });

  it("request persistence failure seals a turn even after storage is repaired", async () => {
    const ws = makeTemp(); const store = makeTemp(); const trace = new EventTrace();
    const mock = await startUpstream();
    const proxy = new CaptureProxy({ upstreamURL: `${mock.url}/v1`, mainModel: "mock-model", trace,
      workspaceRoot: ws, captureStoreDir: store });
    const url = await proxy.start();
    try {
      await postEvent(url, ...spreadIdentity(identity("s1", "m1", "hello")));
      const checkpoint = proxy.turns.get("turn-00000001")?.checkpointId ?? "";
      const blockedPath = join(store, "checkpoints", checkpoint, "model_requests.jsonl");
      mkdirSync(blockedPath);
      expect((await post(url, taskBody("hello"))).status).toBe(502);
      rmSync(blockedPath, { recursive: true });
      expect((await post(url, taskBody("hello"))).status).toBe(502);
      expect(mock.observations).toHaveLength(0);
    } finally { await proxy.stop(); await mock.stop(); rmSync(ws, { recursive: true }); rmSync(store, { recursive: true }); }
  });

  it("repeated identical prompts in separate executions get distinct turns and checkpoints", async () => {
    const ws = makeTemp();
    const store = makeTemp();
    const trace = new EventTrace();
    const mock = await startUpstream();
    const proxy = new CaptureProxy({
      upstreamURL: `${mock.url}/v1`,
      mainModel: "mock-model",
      trace,
      workspaceRoot: ws,
      captureStoreDir: store,
    });
    const url = await proxy.start();
    const text = "identical prompt text";

    // Execution 1: identity (late request), request, close.
    const r1 = post(url, taskBody(text));
    await sleep(100);
    await postEvent(url, ...spreadIdentity(identity("s1", "m1", text)));
    await postEvent(url, "execution.started", { sessionID: "s1" });
    expect((await r1).status).toBe(200);
    await postEvent(url, "execution.ended", { sessionID: "s1" });

    // Execution 2: SAME text, NEW message id, late request again.
    const r2 = post(url, taskBody(text));
    await sleep(100);
    await postEvent(url, ...spreadIdentity(identity("s1", "m2", text)));
    expect((await r2).status).toBe(200);

    expect(mock.observations.length).toBe(2);
    expect(trace.filter("turn.begin")).toHaveLength(2);
    const checkpointIds = trace.filter("capture.committed").map((e) => e.data["checkpointId"]);
    expect(new Set(checkpointIds).size).toBe(2);

    const taskRequests = proxy.requests.filter((r) => r.classification.startsWith("task-") && r.classification !== "task-held-awaiting-identity");
    expect(taskRequests.map((r) => [r.turnId, r.classification])).toEqual([
      ["turn-00000001", "task-new-turn"],
      ["turn-00000002", "task-new-turn"],
    ]);
    expect(proxy.turns.get("turn-00000001")?.messageId).toBe("m1");
    expect(proxy.turns.get("turn-00000002")?.messageId).toBe("m2");

    await proxy.stop();
    await mock.stop();
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  it("classifies small-model calls, title fallback, and checkpoint commands as background", async () => {
    const ws = makeTemp();
    const store = makeTemp();
    const trace = new EventTrace();
    const mock = await startUpstream();
    const proxy = new CaptureProxy({
      upstreamURL: `${mock.url}/v1`,
      mainModel: "mock-model",
      trace,
      workspaceRoot: ws,
      captureStoreDir: store,
    });
    const url = await proxy.start();

    await postEvent(url, ...spreadIdentity(identity("s1", "m1", "background barrier")));
    // Classification does not exempt background calls from capture.
    const small = await post(url, taskBody("summarize this", "mock-small"), "/v1/chat/completions", { "x-capture-purpose": "title" });
    expect(small.status).toBe(200);

    // Title generator falling back to the TASK model (observed in
    // OpenCode v2.0.18): provisional background, never a turn.
    const titleOnMainModel = {
      model: "mock-model",
      messages: [
        {
          role: "system",
          content:
            "You are a title generator. You output ONLY a thread title. Nothing else.",
        },
        { role: "user", content: "USE_TOOL write the probe file please" },
      ],
    };
    const title = await post(url, titleOnMainModel, "/v1/chat/completions", { "x-capture-purpose": "title" });
    expect(title.status).toBe(200);
    const titleRecorded = proxy.requests.at(-1);
    expect(titleRecorded?.classification).toBe("background-title");
    expect(titleRecorded?.background).toBe(true);
    expect(trace.events.some((e) => e.type === "classification.authoritative")).toBe(true);
    expect(proxy.turns.size).toBe(1);

    // Checkpoint command -> excluded from task selection.
    const cp = await post(url, taskBody("!checkpoint"));
    expect(cp.status).toBe(200);

    const classifications = proxy.requests.map((r) => r.classification);
    expect(classifications).toContain("background-title");
    expect(classifications).toContain("background-title");
    expect(classifications).toContain("checkpoint-command-excluded");
    expect(trace.filter("capture.committed")).toHaveLength(1);

    await proxy.stop();
    await mock.stop();
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  it("rejects absolute URLs, protocol-relative URLs, and unsupported endpoint paths", async () => {
    const ws = makeTemp();
    const store = makeTemp();
    const trace = new EventTrace();
    const mock = await startUpstream();
    const proxy = new CaptureProxy({
      upstreamURL: `${mock.url}/v1`,
      mainModel: "mock-model",
      trace,
      workspaceRoot: ws,
      captureStoreDir: store,
    });
    const url = await proxy.start();

    await postEvent(url, ...spreadIdentity(identity("s1", "m1", "path validation")));
    await postEvent(url, "execution.started", { sessionID: "s1" });

    // Absolute-form request target (proxy-style), raw via node:http.
    const abs = await rawRequest(url, "http://evil.example.com/v1/chat/completions", taskBody("path validation"), "Bearer token-abs");
    expect(abs).toBe(400);
    // Protocol-relative URL.
    const protoRel = await fetch(`${url}//evil.example.com/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer token-rel" },
      body: JSON.stringify(taskBody("path validation")),
    });
    expect([400, 404]).toContain(protoRel.status);
    // Unsupported endpoint path.
    const wrongPath = await post(url, taskBody("path validation"), "/v1/embeddings");
    expect(wrongPath.status).toBe(400);
    expect(JSON.parse(wrongPath.text)).toMatchObject({ error: "unsupported-request-path" });

    // Nothing reached the upstream.
    expect(mock.observations.length).toBe(0);
    const rejected = trace.filter("request.rejected");
    expect(rejected.length).toBeGreaterThanOrEqual(2);
    // No credentials were attached anywhere: no auth.forwarded events.
    expect(trace.events.some((e) => e.type === "auth.forwarded")).toBe(false);
    // And no credential text in the trace.
    expect(JSON.stringify(trace.events).includes("token-abs")).toBe(false);
    expect(JSON.stringify(trace.events).includes("token-rel")).toBe(false);

    await proxy.stop();
    await mock.stop();
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  it("checkpoints share one content store; unchanged files are stored once", async () => {
    const ws = makeTemp();
    const store = makeTemp();
    writeFileSync(join(ws, "shared.txt"), "unchanged content");
    const trace = new EventTrace();
    const mock = await startUpstream();
    const proxy = new CaptureProxy({
      upstreamURL: `${mock.url}/v1`,
      mainModel: "mock-model",
      trace,
      workspaceRoot: ws,
      captureStoreDir: store,
    });
    const url = await proxy.start();

    await postEvent(url, ...spreadIdentity(identity("s1", "m1", "first turn")));
    await postEvent(url, "execution.started", { sessionID: "s1" });
    await post(url, taskBody("first turn"));
    await postEvent(url, "execution.ended", { sessionID: "s1" });
    await postEvent(url, ...spreadIdentity(identity("s1", "m2", "second turn")));
    await post(url, taskBody("second turn"));

    // Shared object store: exactly one object for the unchanged file.
    const objectsDir = join(store, "objects");
    const objects = readdirSync(objectsDir);
    expect(objects.length).toBe(1);
    const objectName = objects[0];
    expect(typeof objectName).toBe("string");

    // Two checkpoint manifests, each referencing the same shared object.
    const checkpointsDir = join(store, "checkpoints");
    const checkpointIds = readdirSync(checkpointsDir);
    expect(checkpointIds.length).toBe(2);
    for (const ckpt of checkpointIds) {
      const manifest = JSON.parse(
        readFileSync(join(checkpointsDir, ckpt, "manifest.json"), "utf8"),
      ) as { files: Array<{ path: string; sha256?: string }> };
      const rec = manifest.files.find((f) => f.path === "shared.txt");
      expect(rec?.sha256).toBe(objectName);
    }

    await proxy.stop();
    await mock.stop();
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  it("captures prior context, model requests, tool outputs, and runtime refs per checkpoint; reports gaps", async () => {
    const ws = makeTemp();
    const store = makeTemp();
    const trace = new EventTrace();
    const mock = await startUpstream();
    const proxy = new CaptureProxy({
      upstreamURL: `${mock.url}/v1`,
      mainModel: "mock-model",
      trace,
      workspaceRoot: ws,
      captureStoreDir: store,
      runtime: { opencodeVersion: "2.0.18", configPath: "/tmp/test/opencode.json" },
    });
    const url = await proxy.start();

    await postEvent(url, ...spreadIdentity(identity("s1", "m1", "capture context turn")));
    await postEvent(url, "execution.started", { sessionID: "s1" });
    await post(url, {
      model: "mock-model",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "earlier user message" },
        { role: "assistant", content: "earlier assistant reply" },
        { role: "user", content: "capture context turn" },
      ],
    });
    // Continuation with a tool output.
    await post(url, {
      model: "mock-model",
      messages: [
        { role: "user", content: "capture context turn" },
        { role: "assistant", content: "" },
        { role: "tool", content: "tool result text" },
      ],
    });

    const checkpointsDir = join(store, "checkpoints");
    const ckpt = readdirSync(checkpointsDir)[0];
    expect(typeof ckpt).toBe("string");
    const dir = join(checkpointsDir, ckpt ?? "");

    // Prior context: everything before the final user message.
    const prior = JSON.parse(readFileSync(join(dir, "prior_context.json"), "utf8")) as {
      priorMessages: Array<{ role: string }>;
    };
    expect(prior.priorMessages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);

    // Effective model requests persisted per turn.
    const requestsLog = readFileSync(join(dir, "model_requests.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { classification: string });
    expect(requestsLog.map((r) => r.classification)).toEqual(["task-new-turn", "task-continuation"]);

    // Tool outputs captured (per request, jsonl).
    const toolOutputsLines = readFileSync(join(dir, "tool_outputs.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { toolOutputs: Array<{ content: string }> });
    expect(toolOutputsLines[0]?.toolOutputs[0]?.content).toBe("tool result text");

    // Runtime references captured.
    const runtime = JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8")) as {
      opencodeVersion: string;
      configPath: string;
      sessionId: string;
    };
    expect(runtime.opencodeVersion).toBe("2.0.18");
    expect(runtime.sessionId).toBe("s1");

    // Explicit gap report exists.
    const report = trace.filter("capture.report")[0];
    expect(report?.data["saved"]).toBeDefined();
    const unsupported = (report?.data["unsupported"] as string[]) ?? [];
    expect(unsupported.some((u) => u.includes("compaction"))).toBe(true);

    await proxy.stop();
    await mock.stop();
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  it("captures declared session/compaction state and external artifacts; missing required artifacts block", async () => {
    const ws = makeTemp(); const store = makeTemp(); const artifacts = makeTemp(); const trace = new EventTrace();
    const mock = await startUpstream();
    const artifact = join(artifacts, "tool-result.txt"); writeFileSync(artifact, "complete tool result");
    const proxy = new CaptureProxy({ upstreamURL: `${mock.url}/v1`, mainModel: "mock-model", trace,
      workspaceRoot: ws, captureStoreDir: store, artifactRoots: [artifacts] });
    const url = await proxy.start();
    try {
      await postEvent(url, "user.message", { sessionID: "s1", messageID: "m1", text: "state",
        requiredState: { priorSessionState: { messages: ["original prefix"] }, compaction: { summary: "pinned summary" }, referencedToolOutputFiles: [artifact] } });
      expect((await post(url, taskBody("state"))).status).toBe(200);
      const checkpoint = proxy.turns.get("turn-00000001")?.checkpointId ?? "";
      const dir = join(store, "checkpoints", checkpoint);
      expect(JSON.parse(readFileSync(join(dir, "compaction.json"), "utf8"))).toEqual({ summary: "pinned summary" });
      expect(JSON.parse(readFileSync(join(dir, "session_state.json"), "utf8"))).toEqual({ messages: ["original prefix"] });
      const refs = JSON.parse(readFileSync(join(dir, "referenced_artifacts.json"), "utf8")) as Array<{ sha256: string }>;
      expect(readFileSync(join(store, "objects", refs[0]?.sha256 ?? "missing"), "utf8")).toBe("complete tool result");
      await postEvent(url, "execution.ended", { sessionID: "s1" });
      await postEvent(url, "user.message", { sessionID: "s1", messageID: "m2", text: "missing",
        requiredState: { referencedToolOutputFiles: [join(artifacts, "missing.txt")] } });
      expect((await post(url, taskBody("missing"))).status).toBe(502);
      writeFileSync(join(artifacts, "missing.txt"), "repaired too late");
      expect((await post(url, taskBody("missing"))).status).toBe(502);
      expect(mock.observations).toHaveLength(1);
    } finally { await proxy.stop(); await mock.stop(); for (const d of [ws, store, artifacts]) rmSync(d, { recursive: true }); }
  });

  it("forwards Authorization upstream in memory and never persists it", async () => {
    const ws = makeTemp();
    const store = makeTemp();
    const traceFile = join(makeTemp(), "trace.jsonl");
    const trace = new EventTrace(traceFile);
    const mock = await startUpstream();
    const proxy = new CaptureProxy({
      upstreamURL: `${mock.url}/v1`,
      mainModel: "mock-model",
      trace,
      workspaceRoot: ws,
      captureStoreDir: store,
    });
    const url = await proxy.start();
    const token = "Bearer sk-test-token-value-12345";

    await postEvent(url, ...spreadIdentity(identity("s1", "m1", "authenticated request")));
    await postEvent(url, "execution.started", { sessionID: "s1" });
    const res = await post(url, taskBody("authenticated request"), "/v1/chat/completions", { authorization: token });
    expect(res.status).toBe(200);

    // The upstream (mock provider) received the credential.
    expect(mock.receivedAuth).toEqual([token]);

    // Nothing on disk contains it: trace file and capture store.
    expect(readFileSync(traceFile, "utf8").includes("sk-test-token-value-12345")).toBe(false);
    for (const file of listFiles(store)) {
      expect(readFileSync(file, "utf8").includes("sk-test-token-value-12345")).toBe(false);
    }
    // Not in any in-memory trace event either.
    expect(JSON.stringify(trace.events).includes("sk-test-token-value-12345")).toBe(false);

    await proxy.stop();
    await mock.stop();
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  it("preserves upstream protocol, host, and base path (https routing)", async () => {
    const ws = makeTemp();
    const store = makeTemp();
    const trace = new EventTrace();
    const cert = generateSelfSignedCert();
    const mock = new MockModelServer(() => ({ content: "ok" }), { key: cert.key, cert: cert.cert });
    const mockURL = await mock.start();
    const proxy = new CaptureProxy({
      // Base path /api/v1: incoming /v1/chat/completions must forward to
      // https://127.0.0.1:<port>/api/v1/chat/completions.
      upstreamURL: `${mockURL}/api/v1`,
      mainModel: "mock-model",
      trace,
      workspaceRoot: ws,
      captureStoreDir: store,
      tlsRejectUnauthorized: false,
    });
    const url = await proxy.start();

    await postEvent(url, ...spreadIdentity(identity("s1", "m1", "https please")));
    await postEvent(url, "execution.started", { sessionID: "s1" });
    const res = await post(url, taskBody("https please"), "/v1/chat/completions", { authorization: "Bearer https-token-abc" });
    expect(res.status).toBe(200);

    // The https mock observed the request; scheme and full base path kept.
    expect(mock.observations.length).toBe(1);
    expect(mock.observedPaths).toEqual(["/api/v1/chat/completions"]);
    expect(mock.observedSchemes).toEqual(["https"]);
    // Credentials are allowed over https.
    expect(mock.receivedAuth).toEqual(["Bearer https-token-abc"]);

    await proxy.stop();
    await mock.stop();
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  it("never sends credentials to a non-loopback http upstream", async () => {
    const ws = makeTemp();
    const store = makeTemp();
    const trace = new EventTrace();
    const mock = await startUpstream();
    const proxy = new CaptureProxy({
      upstreamURL: `${mock.url}/v1`,
      mainModel: "mock-model",
      trace,
      workspaceRoot: ws,
      captureStoreDir: store,
    });
    const url = await proxy.start();

    // Simulate a misconfigured plaintext external upstream: the policy must
    // skip credentials. Use a real non-loopback hostname that fails fast.
    const badProxy = new CaptureProxy({
      upstreamURL: "http://example.invalid/v1",
      mainModel: "mock-model",
      trace,
      workspaceRoot: ws,
      captureStoreDir: store,
      identityTimeoutMs: 1000,
    });
    const badURL = await badProxy.start();
    await postEvent(badURL, ...spreadIdentity(identity("s1", "m1", "plaintext test")));
    const res = await post(badURL, taskBody("plaintext test"), "/v1/chat/completions", { authorization: "Bearer must-not-leak" });
    expect([502, 500]).toContain(res.status);

    const authEvents = trace.events.filter((e) => e.type === "auth.skipped" || e.type === "auth.forwarded");
    expect(authEvents.some((e) => e.type === "auth.skipped")).toBe(true);
    expect(authEvents.some((e) => e.type === "auth.forwarded")).toBe(false);
    // The loopback mock never saw anything from that proxy.
    expect(mock.receivedAuth.length).toBe(0);

    // Loopback http (the normal test/dev case) DOES forward credentials.
    await postEvent(url, ...spreadIdentity(identity("s1", "m2", "loopback test")));
    await postEvent(url, "execution.started", { sessionID: "s1" });
    const okRes = await post(url, taskBody("loopback test"), "/v1/chat/completions", { authorization: "Bearer loopback-token" });
    expect(okRes.status).toBe(200);
    expect(mock.receivedAuth).toEqual(["Bearer loopback-token"]);

    await proxy.stop();
    await badProxy.stop();
    await mock.stop();
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });
});