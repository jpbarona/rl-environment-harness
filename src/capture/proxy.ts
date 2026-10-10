import http from "node:http";
import https from "node:https";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { EventTrace, messageText } from "./trace.js";
import { snapshotWorkspace } from "./snapshot.js";

export interface RecordedRequest {
  readonly index: number;
  readonly turnId: string | null;
  /** True for title/compaction/other non-task calls. */
  readonly background: boolean;
  readonly model: string;
  /** Request path as received by the proxy. */
  readonly path: string;
  /** True when the request was forwarded to the upstream provider. */
  readonly forwarded: boolean;
  readonly upstreamStatus?: number;
  /** Classification reason, for trace consumers. */
  readonly classification: string;
}

export type CaptureState = "capturing" | "committed" | "failed" | "exhausted";

export interface TurnRecord {
  readonly id: string;
  /** Own checkpoint identifier; one checkpoint per capture attempt. */
  checkpointId: string | null;
  promptText: string;
  /** OpenCode session id, from the identity event that opened the turn. */
  sessionId: string | null;
  /** OpenCode user-message id, from the identity event that opened the turn. */
  messageId: string | null;
  requestCount: number;
  captureState: CaptureState;
  /** Capture attempts so far (bounded by maxCaptureAttempts). */
  captureAttempts: number;
  /** Whether per-request context files were persisted for this turn. */
  contextSaved: boolean;
  /** Referenced tool-output artifacts captured for this turn. */
  artifacts?: Array<{ originalPath: string; sha256: string }>;
  /** Artifact captures in flight; dependent requests wait for zero. */
  artifactsPending: number;
  /** Authoritative state supplied by the integration, not inferred from prose. */
  requiredState?: RequiredTurnState;
}

export interface RequiredTurnState {
  readonly priorSessionState?: unknown;
  readonly compaction?: unknown;
  readonly referencedToolOutputFiles?: readonly string[];
  readonly unsupported?: readonly string[];
}

/** Thrown to fail closed; the outer handler converts it to HTTP 502. */
export class CaptureBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`request blocked: ${reason}`);
    this.name = "CaptureBlockedError";
  }
}

/** Thrown when request identity cannot be established; maps to HTTP 503. */
export class IdentityError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

export interface CaptureProxyOptions {
  /** Upstream provider base URL; its protocol, host, and base path are preserved. */
  readonly upstreamURL: string;
  /** The configured task model id; other models are background calls. */
  readonly mainModel: string;
  readonly trace: EventTrace;
  readonly workspaceRoot: string;
  /** Root of the shared content store (objects/ + checkpoints/). */
  readonly captureStoreDir: string;
  /** Artificial delay inserted before capture commits. */
  readonly captureDelayMs?: number;
  /** Force capture to fail (fail-closed test mode). */
  readonly failCapture?: boolean;
  readonly port?: number;
  /**
   * How long a task-model request waits for its execution window and
   * capture before the proxy fails with a clear error. Default 10000 ms.
   */
  readonly identityTimeoutMs?: number;
  /** Maximum capture attempts per turn before requests are blocked. Default 3. */
  readonly maxCaptureAttempts?: number;
  /** Test hook: delay each artifact capture to prove dependent actions wait. */
  readonly artifactDelayMs?: number;
  /**
   * Restore mode (Step 3): every model request is answered locally with a
   * canned completion and NEVER forwarded upstream. The first primary task
   * request is the regenerated input under comparison.
   */
  readonly interceptRequests?: true;
  /** Called with each intercepted primary request body (restore mode). */
  readonly onRequestIntercepted?: (body: string, recorded: RecordedRequest) => void;
  /**
   * Runtime/configuration references persisted with every checkpoint.
   * Example: { opencodeVersion, configPath, isolatedHome, providerBaseURL }.
   */
  readonly runtime?: Record<string, unknown>;
  /** Explicitly permitted roots for externally referenced tool-output files. */
  readonly artifactRoots?: readonly string[];
  /** TLS verification for https upstreams. Default true; tests use false with self-signed certs. */
  readonly tlsRejectUnauthorized?: boolean;
}

/** Only provider chat-completion endpoints may be forwarded. */
const SUPPORTED_ENDPOINT_SUFFIX = "/chat/completions";

/**
 * Recorder proxy bound to loopback.
 *
 * Request identity (explicit, no text matching): a turn opens when the
 * plugin reports a user message (`session.inbox.enqueued`, item type user)
 * with sessionID + messageID. The turn's execution window opens with the
 * turn and closes on the plugin's execution-ended event. Every task-model
 * request arriving inside an open window is bound to that window's turn by
 * position, never by prompt text. Requests arriving with no open window are
 * held up to `identityTimeoutMs` and then fail with HTTP 503; ambiguity
 * (multi-session) is traced and fails requests closed.
 *
 * Capture barrier: a task request is forwarded only after its own turn's
 * capture commits. Any snapshot/context/request persistence failure seals
 * that turn permanently. Only a new user-message identity can recover.
 *
 * Forwarding: the configured upstream protocol, host, and base path are
 * preserved. Incoming absolute/protocol-relative URLs and unsupported
 * endpoint paths are rejected before any forwarding. The final destination
 * is validated (same protocol, host, and base path) before credentials are
 * attached. Credentials go only to https or loopback http and are never
 * recorded.
 */
export class CaptureProxy {
  readonly #options: CaptureProxyOptions;
  readonly #server: http.Server;
  /** Turn identity dedupe: "sessionId:messageId" -> turnId. */
  readonly #identityToTurn = new Map<string, string>();
  /** Latest turn per session (artifact events can outlive the window). */
  readonly #lastTurnBySession = new Map<string, string>();
  readonly turns = new Map<string, TurnRecord>();
  readonly requests: RecordedRequest[] = [];
  #requestIndex = 0;
  #turnSeq = 0;
  /** The open execution window: requests inside it bind to its turn. */
  #window: { turnId: string; sessionId: string; messageId: string } | null = null;
  /** User messages enqueued while another execution is still running. */
  readonly #identityQueue: Array<{ sessionId: string; messageId: string; text: string | undefined; requiredState?: RequiredTurnState }> = [];
  /** Set while a multi-session conflict is detected; fails requests closed. */
  #sessionConflict = false;
  #url = "";
  /** In-flight capture; task requests queue behind it. */
  #captureGate: Promise<boolean> | null = null;
  /** Waiters for a window to open (held requests with no window). */
  readonly #windowWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(options: CaptureProxyOptions) {
    this.#options = options;
    this.#server = http.createServer((req, res) => {
      void this.#handle(req, res);
    });
    // Loopback only, per design requirement.
    this.#server.on("error", (err) => {
      options.trace.append("proxy.error", { message: String(err) });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => {
      this.#server.listen(this.#options.port ?? 0, "127.0.0.1", resolve);
    });
    const addr = this.#server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("proxy failed to bind loopback");
    }
    this.#url = `http://127.0.0.1:${addr.port}`;
    this.#options.trace.append("proxy.started", { url: this.#url });
    return this.#url;
  }

  get url(): string {
    return this.#url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const trace = this.#options.trace;
    try {
      trace.append("http.received", { method: req.method, url: req.url });
      const body = await readBody(req);
      if (req.url === "/capture-gate" && req.method === "POST") {
        const identity = JSON.parse(body) as { sessionID?: unknown; messageID?: unknown };
        const turnId = typeof identity.sessionID === "string" && typeof identity.messageID === "string"
          ? this.#identityToTurn.get(key(identity.sessionID, identity.messageID)) : undefined;
        const turn = turnId ? this.turns.get(turnId) : undefined;
        if (!turn || this.#window?.turnId !== turn.id) throw new IdentityError("capture-identity-missing", "capture identity not active");
        if (turn.captureState === "capturing" && this.#captureGate) await this.#captureGate;
        if ((turn.requiredState?.unsupported?.length ?? 0) > 0) {
          this.#sealFailure(turn, new Error(`required state unsupported: ${turn.requiredState?.unsupported?.join(", ")}`));
        }
        if (turn.captureState !== "committed") {
          this.#options.trace.append("request.blocked", { turnId: turn.id, reason: "admission-capture-failed" });
          throw new CaptureBlockedError("turn-sealed-after-capture-failure");
        }
        res.writeHead(204); res.end(); return;
      }
      if (req.url === "/tool-gate" && req.method === "POST") {
        const identity = JSON.parse(body) as { sessionID?: unknown; messageID?: unknown };
        if (typeof identity.sessionID !== "string" || typeof identity.messageID !== "string") {
          throw new IdentityError("tool-identity-missing", "tool requires explicit session and user-message IDs");
        }
        const turnId = this.#identityToTurn.get(key(identity.sessionID, identity.messageID));
        const turn = turnId ? this.turns.get(turnId) : undefined;
        if (!turn || this.#window?.turnId !== turn.id) throw new CaptureBlockedError("tool-turn-not-active");
        if (turn.captureState === "capturing" && this.#captureGate) await this.#captureGate;
        if (turn.captureState !== "committed" || !turn.contextSaved || turn.requestCount < 1) {
          throw new CaptureBlockedError("tool-capture-not-ready");
        }
        this.#options.trace.append("tool.gate.allowed", { turnId: turn.id });
        res.writeHead(204); res.end(); return;
      }
      if (req.url === "/events" && req.method === "POST") {
        this.#handlePluginEvent(body);
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      // Credential passthrough: read in memory, forward, never record.
      const rawAuth = req.headers["authorization"];
      const auth = Array.isArray(rawAuth) ? (rawAuth[0] ?? undefined) : rawAuth;
      await this.#handleModelRequest(req, res, body, auth);
    } catch (err) {
      if (err instanceof CaptureBlockedError) {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: "capture-failed", reason: err.reason, message: "capture did not commit; execution blocked" }));
        return;
      }
      if (err instanceof IdentityError) {
        if (!res.headersSent) {
          res.writeHead(503, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: "identity-unresolved", reason: err.reason, message: err.message }));
        return;
      }
      trace.append("proxy.request.error", { message: String(err) });
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    }
  }

  #handlePluginEvent(body: string): void {
    let parsed: { type?: unknown; data?: unknown } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      return;
    }
    if (typeof parsed.type !== "string") {
      return;
    }
    this.#options.trace.append("plugin.event", {
      pluginType: parsed.type,
      data: parsed.data ?? {},
    });
    if (parsed.type === "user.message") {
      this.#handleUserIdentity(parsed.data);
    } else if (parsed.type === "execution.started") {
      this.#options.trace.append("execution.window.confirmed", {});
    } else if (parsed.type === "execution.ended") {
      this.#closeWindow();
    } else if (parsed.type === "tool.output.artifact") {
      // Truncation artifacts are discovered mid-execution, after the
      // turn's context was saved; capture them into the producing turn.
      // The event carries the producing user-message ID; late events bind
      // to that exact turn, never to whichever turn happens to be open.
      // The file may not be flushed yet — wait bounded, then fail closed.
      const d = (parsed.data ?? {}) as { sessionID?: unknown; messageID?: unknown; path?: unknown };
      let turnId: string | undefined;
      if (typeof d.sessionID === "string" && typeof d.messageID === "string") {
        turnId = this.#identityToTurn.get(key(d.sessionID, d.messageID));
      }
      if (turnId === undefined && typeof d.sessionID === "string") {
        turnId = this.#lastTurnBySession.get(d.sessionID);
      }
      const turn = turnId !== undefined ? this.turns.get(turnId) : undefined;
      if (turn !== undefined && typeof d.path === "string") {
        void this.#captureArtifactWithWait(turn, d.path).catch((err: unknown) => {
          this.#options.trace.append("artifact.capture.failed", {
            turnId: turn.id,
            path: d.path,
            message: String(err),
          });
          this.#sealFailure(turn, err instanceof Error ? err : new Error(String(err)));
        });
      } else {
        this.#options.trace.append("artifact.unattributed", {
          sessionID: d.sessionID,
          messageID: d.messageID,
          path: d.path,
        });
      }
    }
  }

  /** Capture an artifact, waiting bounded for its file to appear. */
  async #captureArtifactWithWait(turn: TurnRecord, path: string): Promise<void> {
    turn.artifactsPending += 1;
    try {
      // Test hook: delay capture to prove dependent actions wait.
      if ((this.#options.artifactDelayMs ?? 0) > 0) {
        await delay(this.#options.artifactDelayMs ?? 0);
      }
      const attempts = 8;
      const waitMs = 250;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          this.#captureArtifact(turn, path);
          if (turn.contextSaved && turn.checkpointId !== null) {
            this.#writeReferencedArtifacts(
              turn,
              join(this.#options.captureStoreDir, "checkpoints", turn.checkpointId),
            );
          }
          return;
        } catch (err) {
          const missing = err instanceof Error && "code" in err && (err as { code?: unknown }).code === "ENOENT";
          if (!missing || attempt === attempts) {
            throw err;
          }
          await delay(waitMs);
        }
      }
      throw new Error("artifact capture did not complete");
    } finally {
      turn.artifactsPending -= 1;
    }
  }

  /**
   * User-message identity. Opens the turn and its execution window when no
   * window is open; queues behind the running execution otherwise. Prompt
   * text is recorded for humans but never used to route requests.
   */
  #handleUserIdentity(data: unknown): void {
    const d = (data ?? {}) as {
      sessionID?: unknown;
      messageID?: unknown;
      id?: unknown;
      text?: unknown;
      role?: unknown;
      requiredState?: RequiredTurnState;
    };
    if (d.role !== undefined && d.role !== "user") {
      return;
    }
    const sessionId = typeof d.sessionID === "string" ? d.sessionID : null;
    const messageId =
      typeof d.messageID === "string"
        ? d.messageID
        : typeof d.id === "string"
          ? d.id
          : null;
    if (sessionId === null || messageId === null) {
      return;
    }
    const text = typeof d.text === "string" ? d.text : undefined;
    const key = `${sessionId}:${messageId}`;
    if (this.#identityToTurn.has(key)) {
      return;
    }
    const trace = this.#options.trace;
    if (this.#window !== null) {
      if (this.#window.sessionId !== sessionId) {
        // Multi-session capture is out of scope; fail closed.
        this.#sessionConflict = true;
        trace.append("identity.conflict", {
          openSession: this.#window.sessionId,
          newSession: sessionId,
          policy: "requests fail closed until the open window closes",
        });
      }
      throw new IdentityError("concurrent-turn-unsupported", "submit a new request only after the current execution ends");
    }
    this.#openWindow(sessionId, messageId, text, d.requiredState);
  }

  #openWindow(sessionId: string, messageId: string, text: string | undefined, requiredState?: RequiredTurnState): void {
    const trace = this.#options.trace;
    if (this.#sessionConflict) {
      // A conflict was detected earlier; keep failing closed until the
      // conflicting session is gone. This proxy instance is single-session
      // by scope; a restart is required for a new session.
      trace.append("identity.conflict", { sessionId, policy: "instance is conflicted; identity rejected" });
      return;
    }
    this.#turnSeq += 1;
    const turnId = `turn-${String(this.#turnSeq).padStart(8, "0")}`;
    const turn: TurnRecord = {
      id: turnId,
      checkpointId: null,
      promptText: text ?? "",
      sessionId,
      messageId,
      requestCount: 0,
      captureState: "capturing",
      captureAttempts: 0,
      contextSaved: false,
      artifactsPending: 0,
      ...(requiredState ? { requiredState } : {}),
    };
    this.turns.set(turnId, turn);
    this.#identityToTurn.set(key(sessionId, messageId), turnId);
    this.#lastTurnBySession.set(sessionId, turnId);
    this.#window = { turnId, sessionId, messageId };
    this.#captureGate = this.#runCaptureFor(turn).then(
      () => {
        this.#captureGate = null;
        return true;
      },
      () => {
        this.#captureGate = null;
        return false;
      },
    );
    // Wake held requests: a window now exists.
    for (const waiter of this.#windowWaiters.splice(0)) {
      waiter.resolve();
    }
  }

  #closeWindow(): void {
    if (this.#window === null) {
      return;
    }
    const closed = this.#window;
    this.#window = null;
    this.#options.trace.append("execution.window.closed", {
      turnId: closed.turnId,
      sessionId: closed.sessionId,
      messageId: closed.messageId,
    });
    const next = this.#identityQueue.shift();
    if (next !== undefined) {
      this.#openWindow(next.sessionId, next.messageId, next.text, next.requiredState);
    }
  }

  async #handleModelRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
    auth: string | undefined,
  ): Promise<void> {
    const trace = this.#options.trace;
    const purpose = req.headers["x-capture-purpose"];
    const requestSession = req.headers["x-capture-session"];
    trace.append("request.arrived", { index: this.#requestIndex + 1,
      purpose: purpose ?? "metadata-unavailable", sessionId: requestSession ?? null });
    if (purpose !== undefined && !["primary", "compaction", "title", "generate"].includes(String(purpose))) {
      throw new IdentityError("unsupported-call-purpose", "unsupported authoritative call purpose");
    }

    // Incoming URL validation: only relative provider endpoint paths.
    const path = req.url ?? "";
    const pathError = this.#validateIncomingPath(path);
    if (pathError !== null) {
      trace.append("request.rejected", { path, reason: pathError });
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unsupported-request-path", reason: pathError }));
      return;
    }

    let parsed: {
      model?: unknown;
      messages?: unknown;
      stream?: unknown;
    } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      trace.append("request.unparseable", {});
      res.writeHead(400);
      res.end();
      return;
    }
    const model = typeof parsed.model === "string" ? parsed.model : "";
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const last = messages.at(-1) as { role?: unknown; content?: unknown } | undefined;
    // Model ids may arrive with or without the provider prefix
    // ("capture-mock/mock-model" vs "mock-model"); compare on the id.
    const modelId = model.includes("/") ? (model.split("/").pop() ?? model) : model;
    const isTaskModel = modelId === this.#options.mainModel.split("/").pop();

    if (purpose === undefined || typeof requestSession !== "string") {
      throw new IdentityError("call-metadata-missing", "model request requires authoritative purpose and session identity");
    }
    const backgroundClassification = purpose === "primary" ? null : `background-${String(purpose)}`;

    // Capture barrier: task requests queue behind the in-flight capture.
    if (this.#captureGate !== null) {
      const committed = await this.#captureGate;
      if (!committed) {
        // The in-flight capture failed; this request's turn failed too.
        this.#blockRequest(model, path, "capture-in-flight-failed");
        return;
      }
    }

    const lastRole = typeof last?.role === "string" ? last.role : "";
    const lastText = messageText(last?.content);
    const isUserTurnCandidate = isTaskModel && lastRole === "user";

    // The checkpoint command is excluded from task selection. It never
    // opens a turn; the request is tagged and forwarded. Only the exact
    // command prefix is excluded; a task prompt starting with "!" is a
    // normal turn.
    if (isUserTurnCandidate && lastText.startsWith("!checkpoint")) {
      const recorded = this.#record({
        turnId: null,
        background: true,
        model,
        path,
        classification: "checkpoint-command-excluded",
      }, body);
      await this.#forward(req, res, body, auth, recorded);
      return;
    }

    // Explicit identity binding: bind to the open execution window. No
    // prompt-text matching anywhere.
    let held: RecordedRequest | null = null;
    if (this.#window === null || this.#sessionConflict) {
      // Hold until a window opens (bounded); fail closed on timeout.
      held = this.#record({
        turnId: null,
        background: false,
        model,
        path,
        classification: "task-held-awaiting-identity",
      }, body);
      trace.append("request.held", {
        index: held.index,
        reason: "awaiting-execution-window",
        sessionConflict: this.#sessionConflict,
      });
      try {
        await this.#waitForWindow();
      } catch (err) {
        trace.append("identity.timeout", {
          index: held.index,
          message: String(err),
        });
        if (!res.headersSent) {
          res.writeHead(503, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: "identity-unresolved", reason: "identity-timeout", message: "no session/message identity arrived for this request; execution stopped" }));
        return;
      }
    }
    const turn = this.#window !== null ? this.turns.get(this.#window.turnId) : undefined;
    if (turn === undefined) {
      this.#blockRequest(model, path, "window-turn-missing");
      return;
    }
    if (requestSession !== undefined && requestSession !== turn.sessionId) {
      throw new IdentityError("request-session-mismatch", "request session does not match the active turn");
    }
    // Promote the held record to its bound turn (single record per request).
    let bound: RecordedRequest | null = null;
    if (held !== null) {
      const heldIndex = this.requests.indexOf(held);
      this.requests[heldIndex] = { ...held, turnId: turn.id };
      const updated = this.requests[heldIndex];
      if (updated === undefined) {
        throw new Error("held request vanished");
      }
      bound = updated;
    }

    // The window's turn may still be capturing (the request was released
    // when the window opened). Forward only after its own capture commits.
    if (turn.captureState === "capturing") {
      const gate = this.#captureGate;
      if (gate !== null) {
        const committed = await gate;
        if (!committed) {
          this.#blockRequest(model, path, "capture-in-flight-failed");
          return;
        }
      }
    }

    if (turn.captureState !== "committed") {
      this.#blockRequest(model, path, "turn-sealed-after-capture-failure");
    }
    if (backgroundClassification !== null) {
      let recorded: RecordedRequest;
      if (bound !== null) {
        recorded = { ...bound, turnId: turn.id, background: true, classification: backgroundClassification };
        this.requests[this.requests.indexOf(bound)] = recorded;
      } else {
        recorded = this.#record({ turnId: turn.id, background: true, model, path,
          classification: backgroundClassification }, body);
      }
      trace.append(purpose === undefined ? "classification.provisional" : "classification.authoritative", {
        index: recorded.index, basis: backgroundClassification });
      // R4: record the actual compaction request and the summary response
      // OpenCode accepted, inside the turn whose execution produced them.
      // The call may arrive without a held binding; resolve the turn from
      // the authoritative session header.
      const isCompaction = backgroundClassification === "background-compaction";
      if (isCompaction) {
        const compactionTurn =
          bound !== null
            ? turn
            : typeof requestSession === "string"
              ? this.#resolveTurnForSession(requestSession)
              : undefined;
        if (compactionTurn !== undefined) {
          try {
            this.#appendCompactionRequest(compactionTurn.id, body);
          } catch (err) {
            this.#sealFailure(compactionTurn, err);
            this.#blockRequest(model, path, "compaction-record-failed");
          }
          await this.#forward(req, res, body, auth, recorded, (responseText, status) => {
            this.#recordCompactionSummary(compactionTurn.id, responseText, status);
          });
          return;
        }
        trace.append("compaction.record.skipped", {
          reason: "no identified turn for session",
          sessionID: requestSession,
        });
      }
      await this.#forward(req, res, body, auth, recorded);
      return;
    }
    try {
      if (!turn.contextSaved) {
        this.#saveTurnContext(turn, messages);
        turn.contextSaved = true;
      }
    } catch (err) {
      this.#sealFailure(turn, err);
      this.#blockRequest(model, path, "context-persistence-failed");
    }

    // R5 barrier: required tool-output artifacts must be captured before
    // any dependent model action consumes them. Wait for event-driven
    // captures to settle and capture any artifact this request itself
    // references. Failure seals the turn.
    try {
      await this.#settleTurnArtifacts(turn, body);
    } catch (err) {
      this.#sealFailure(turn, err);
      this.#blockRequest(model, path, "artifact-persistence-failed");
    }

    const classification = turn.requestCount === 0 ? "task-new-turn" : "task-continuation";
    let recorded: RecordedRequest;
    if (bound !== null) {
      const recordIndex = this.requests.indexOf(bound);
      this.requests[recordIndex] = { ...bound, classification };
      const updated = this.requests[recordIndex];
      if (updated === undefined) {
        throw new Error("bound request vanished");
      }
      recorded = updated;
    } else {
      recorded = this.#record({
        turnId: turn.id,
        background: false,
        model,
        path,
        classification,
      }, body);
    }
    // The effective model request is part of the captured task; persist it
    // before forwarding.
    try {
      this.#appendModelRequest(turn.id, recorded.index, classification, body, messages);
    } catch (err) {
      this.#sealFailure(turn, err);
      this.#blockRequest(model, path, "request-persistence-failed");
    }
    turn.requestCount += 1;
    await this.#forward(req, res, body, auth, recorded);
  }

  /**
 * Wait for in-flight artifact captures to settle and capture any
 * truncated-output artifact this request references directly. Bounded by
 * the identity timeout; failure seals the turn.
 */
  async #settleTurnArtifacts(turn: TurnRecord, body: string): Promise<void> {
    const paths = new Set<string>();
    for (const match of body.matchAll(/full output saved to ([^\\\]\s"]+)/g)) {
      const p = match[1];
      if (p !== undefined) {
        paths.add(p);
      }
    }
    for (const p of paths) {
      if (turn.artifacts?.some(a => a.originalPath === p)) {
        continue;
      }
      await this.#captureArtifactWithWait(turn, p);
    }
    const deadline = Date.now() + (this.#options.identityTimeoutMs ?? 10_000);
    while (turn.artifactsPending > 0 && Date.now() < deadline) {
      await delay(50);
    }
    if (turn.artifactsPending > 0) {
      throw new Error("artifact capture did not settle within the identity timeout");
    }
    if (paths.size > 0 && turn.checkpointId !== null) {
      this.#writeReferencedArtifacts(
        turn,
        join(this.#options.captureStoreDir, "checkpoints", turn.checkpointId),
      );
    }
  }

  /** The turn currently or most recently executing for a session. */
  #resolveTurnForSession(sessionId: string): TurnRecord | undefined {
    if (this.#window !== null && this.#window.sessionId === sessionId) {
      return this.turns.get(this.#window.turnId);
    }
    const turnId = this.#lastTurnBySession.get(sessionId);
    return turnId !== undefined ? this.turns.get(turnId) : undefined;
  }

  /** Append one compaction request body to the turn's checkpoint. */
  #appendCompactionRequest(turnId: string, body: string): void {
    const turn = this.turns.get(turnId);
    if (turn === undefined || turn.checkpointId === null) {
      throw new Error(`compaction request cannot be recorded: no checkpoint for turn ${turnId}`);
    }
    const dir = join(this.#options.captureStoreDir, "checkpoints", turn.checkpointId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "compaction_requests.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), body: JSON.parse(body) })}\n`,
    );
  }

  /** Record the compaction summary response OpenCode accepted. */
  #recordCompactionSummary(turnId: string, responseText: string, status: number): void {
    const turn = this.turns.get(turnId);
    if (turn === undefined || turn.checkpointId === null) {
      return;
    }
    const dir = join(this.#options.captureStoreDir, "checkpoints", turn.checkpointId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "compaction.json");
    let record: { source: string; summaries: Array<{ at: string; status: number; summary: string }> } = {
      source: "proxy-authoritative",
      summaries: [],
    };
    try {
      const existing = JSON.parse(readFileSync(file, "utf8")) as typeof record;
      if (existing.source === "proxy-authoritative" && Array.isArray(existing.summaries)) {
        record = existing;
      }
    } catch {
      // No prior authoritative record; start one.
    }
    record.summaries.push({ at: new Date().toISOString(), status, summary: responseText });
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    this.#options.trace.append("compaction.summary.recorded", {
      turnId,
      status,
      bytes: responseText.length,
    });
  }

  /** Capture one referenced artifact into the shared object store. */
  #captureArtifact(turn: TurnRecord, path: string): void {
    const existing = (turn.artifacts ??= []).find(a => a.originalPath === path);
    if (existing !== undefined) {
      return;
    }
    const source = realpathSync(path);
    const permitted = (this.#options.artifactRoots ?? []).some(root => {
      const rel = relative(realpathSync(root), source);
      return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    });
    if (!permitted) throw new Error(`required artifact outside allowed roots: ${path}`);
    const content = readFileSync(source);
    const sha256 = createHash("sha256").update(content).digest("hex");
    writeFileSync(join(this.#options.captureStoreDir, "objects", sha256), content);
    turn.artifacts?.push({ originalPath: path, sha256 });
    this.#options.trace.append("artifact.captured", {
      turnId: turn.id,
      originalPath: path,
      sha256,
      bytes: content.length,
    });
  }

  /** Rewrite referenced_artifacts.json from the turn's captured artifacts. */
  #writeReferencedArtifacts(turn: TurnRecord, dir: string): void {
    if (turn.checkpointId === null) {
      return;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "referenced_artifacts.json"),
      `${JSON.stringify(turn.artifacts ?? [])}\n`,
    );
  }

  /**
   * Incoming path validation. Rejects absolute URLs, protocol-relative
   * URLs, and any path that is not a provider chat-completions endpoint.
   * Returns an error reason, or null when the path is acceptable.
   */
  #validateIncomingPath(path: string): string | null {
    if (path === "") {
      return "empty-path";
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) {
      return "absolute-url-not-allowed";
    }
    if (path.startsWith("//")) {
      return "protocol-relative-url-not-allowed";
    }
    if (!path.startsWith("/")) {
      return "relative-path-not-allowed";
    }
    // Supported shape: /<one-segment-prefix>/chat/completions
    const match = /^\/[^/]+(\/chat\/completions)$/.exec(path);
    if (match === null || match[1] !== SUPPORTED_ENDPOINT_SUFFIX) {
      return `unsupported-endpoint-path (supported: /<prefix>${SUPPORTED_ENDPOINT_SUFFIX})`;
    }
    return null;
  }

  #blockRequest(model: string, path: string, reason: string): void {
    this.#requestIndex += 1;
    const blocked: RecordedRequest = {
      index: this.#requestIndex,
      turnId: null,
      background: false,
      model,
      path,
      forwarded: false,
      classification: "task-blocked-capture-failed",
    };
    this.requests.push(blocked);
    this.#options.trace.append("request.blocked", {
      index: blocked.index,
      model,
      reason,
    });
    throw new CaptureBlockedError(reason);
  }

  #record(
    input: Omit<RecordedRequest, "index" | "forwarded">,
    body: string,
  ): RecordedRequest {
    this.#requestIndex += 1;
    const recorded: RecordedRequest = {
      index: this.#requestIndex,
      turnId: input.turnId,
      background: input.background,
      model: input.model,
      path: input.path,
      forwarded: false,
      classification: input.classification,
    };
    this.requests.push(recorded);
    this.#options.trace.append("request.recorded", {
      index: recorded.index,
      turnId: recorded.turnId,
      background: recorded.background,
      model: recorded.model,
      classification: recorded.classification,
      // Allowlisted headers only; credentials never persist.
      headers: EventTrace.redactHeaders({ "content-type": "application/json" }),
      body,
    });
    return recorded;
  }

  /** Wait until a window opens or the identity timeout expires. */
  #waitForWindow(): Promise<void> {
    const timeoutMs = this.#options.identityTimeoutMs ?? 10_000;
    if (this.#window !== null && !this.#sessionConflict) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: (): void => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err: Error): void => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        const i = this.#windowWaiters.indexOf(waiter);
        if (i >= 0) {
          this.#windowWaiters.splice(i, 1);
        }
        reject(new Error(`no execution-window identity within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#windowWaiters.push(waiter);
    });
  }

  /** Run one capture for the turn; each attempt gets its own checkpoint id. */
  async #runCaptureFor(turn: TurnRecord): Promise<void> {
    const trace = this.#options.trace;
    turn.captureAttempts += 1;
    const checkpointId = `ckpt-${randomBytes(6).toString("hex")}`;
    turn.checkpointId = checkpointId;
    trace.append("turn.begin", {
      turnId: turn.id,
      checkpointId,
      sessionId: turn.sessionId,
      messageId: turn.messageId,
      promptText: turn.promptText,
      attempt: turn.captureAttempts,
    });
    trace.append("capture.started", { turnId: turn.id, checkpointId, attempt: turn.captureAttempts });
    try {
      if (this.#options.failCapture === true) {
        throw new Error("injected capture failure (failCapture mode)");
      }
      const snapshot = snapshotWorkspace(
        this.#options.workspaceRoot,
        this.#options.captureStoreDir,
        checkpointId,
      );
      if ((this.#options.captureDelayMs ?? 0) > 0) {
        await delay(this.#options.captureDelayMs ?? 0);
      }
      trace.append("capture.committed", {
        turnId: turn.id,
        checkpointId,
        fileCount: snapshot.files.length,
        manifestPath: snapshot.manifestPath,
      });
      turn.captureState = "committed";
    } catch (err) {
      trace.append("capture.failed", {
        turnId: turn.id,
        checkpointId,
        attempt: turn.captureAttempts,
        message: String(err),
      });
      turn.captureState = "failed";
      throw err;
    }
  }

  /** A failed turn is terminal. Only a new explicit identity can recover. */
  #sealFailure(turn: TurnRecord, error: unknown): void {
    turn.captureState = "failed";
    this.#options.trace.append("capture.failed", {
      turnId: turn.id, checkpointId: turn.checkpointId,
      message: String(error), terminal: true,
    });
  }

  /**
   * Persist per-turn context before any request of the turn is forwarded:
   * prior session context (everything before the final user message), tool
   * outputs, and runtime/configuration references. Explicitly reports what
   * could not be captured.
   */
  #saveTurnContext(
    turn: TurnRecord,
    messages: unknown[],
  ): void {
    const trace = this.#options.trace;
    if (turn.checkpointId === null) {
      trace.append("capture.report", {
        turnId: turn.id,
        saved: [],
        unsupported: ["context-files: no checkpoint id yet"],
      });
      throw new Error("missing checkpoint ID for required context");
    }
    const dir = join(this.#options.captureStoreDir, "checkpoints", turn.checkpointId);
    mkdirSync(dir, { recursive: true });
    const saved: string[] = [];
    const unsupported: string[] = [];

    // Prior session context: all messages before the final user message of
    // this turn's first request.
    const priorMessages = messages.slice(0, -1);
    writeFileSync(
      join(dir, "prior_context.json"),
      `${JSON.stringify({ turnId: turn.id, priorMessages }, null, 2)}\n`,
    );
    saved.push("prior_context.json");

    // Tool outputs referenced by this turn's requests are persisted as
    // requests arrive (see #appendModelRequest, tool_outputs.jsonl).
    saved.push("model_requests.jsonl");

    // Runtime/configuration references.
    writeFileSync(
      join(dir, "runtime.json"),
      `${JSON.stringify(
        {
          turnId: turn.id,
          sessionId: turn.sessionId,
          messageId: turn.messageId,
          capturedAt: new Date().toISOString(),
          mainModel: this.#options.mainModel,
          upstreamURL: this.#options.upstreamURL,
          workspaceRoot: this.#options.workspaceRoot,
          ...(this.#options.runtime ?? {}),
        },
        null,
        2,
      )}\n`,
    );
    saved.push("runtime.json");

    const required = turn.requiredState;
    if ((required?.unsupported?.length ?? 0) > 0) {
      throw new Error(`required state unsupported: ${required?.unsupported?.join(", ")}`);
    }
    if (required !== undefined) {
      writeFileSync(join(dir, "session_state.json"), `${JSON.stringify(required.priorSessionState ?? null)}\n`);
      // Compaction record: preserve an authoritative recorder-written record
      // (from actual compaction calls) and attach hook-declared metadata;
      // otherwise record the hook-declared compaction state as-is.
      const compactionFile = join(dir, "compaction.json");
      let authoritative: { source?: string; hookDeclared?: unknown } | null = null;
      try {
        const existing = JSON.parse(readFileSync(compactionFile, "utf8")) as { source?: string };
        if (existing !== null && typeof existing === "object" && existing.source === "proxy-authoritative") {
          authoritative = existing as { source?: string; hookDeclared?: unknown };
        }
      } catch {
        // No existing record.
      }
      if (authoritative !== null) {
        authoritative.hookDeclared = required.compaction ?? null;
        writeFileSync(compactionFile, `${JSON.stringify(authoritative, null, 2)}\n`);
      } else {
        writeFileSync(compactionFile, `${JSON.stringify(required.compaction ?? null)}\n`);
      }
      for (const path of required.referencedToolOutputFiles ?? []) {
        this.#captureArtifact(turn, path);
      }
      this.#writeReferencedArtifacts(turn, dir);
      saved.push("session_state.json", "compaction.json", "referenced_artifacts.json");
    }

    // Explicit unsupported list: state OpenCode does not expose to the
    // proxy at capture time.
    if (required === undefined) {
      unsupported.push(
        "session-state/compaction metadata: integration has not supplied authoritative state",
        "referenced-tool-output-files: integration has not supplied authoritative artifact inventory",
      );
    }

    trace.append("capture.report", {
      turnId: turn.id,
      checkpointId: turn.checkpointId,
      saved,
      unsupported,
    });
  }

  /** Extract tool-role message contents from a request. */
  #extractToolOutputs(messages: unknown[]): Array<{ index: number; content: string }> {
    const out: Array<{ index: number; content: string }> = [];
    messages.forEach((message, index) => {
      const m = message as { role?: unknown; content?: unknown };
      if (m.role === "tool" || m.role === "function") {
        out.push({ index, content: messageText(m.content) });
      }
    });
    return out;
  }

  /** Append one effective model request and its tool outputs to the checkpoint. */
  #appendModelRequest(turnId: string, index: number, classification: string, body: string, messages: unknown[]): void {
    const turn = this.turns.get(turnId);
    if (turn === undefined || turn.checkpointId === null) {
      return;
    }
    const dir = join(this.#options.captureStoreDir, "checkpoints", turn.checkpointId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "model_requests.jsonl"),
      `${JSON.stringify({ index, classification, at: new Date().toISOString(), body: JSON.parse(body) })}\n`,
    );
    const toolOutputs = this.#extractToolOutputs(messages);
    if (toolOutputs.length > 0) {
      appendFileSync(
        join(dir, "tool_outputs.jsonl"),
        `${JSON.stringify({ index, toolOutputs })}\n`,
      );
    }
  }

  /**
   * Forward to upstream, preserving the configured protocol, host, and base
   * path. Target = upstream origin + upstream base path (minus its last
   * segment) + incoming path. The final destination is validated (protocol,
   * host, base path) BEFORE credentials are attached; on mismatch nothing
   * is sent and the request fails with a clear error.
   */
  async #forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
    auth: string | undefined,
    recorded: RecordedRequest,
    onResponse?: (responseText: string, status: number) => void,
  ): Promise<void> {
    const trace = this.#options.trace;
    // Restore mode: answer locally, never open an upstream connection.
    if (this.#options.interceptRequests === true) {
      const model = recorded.model ?? "unknown";
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const created = Math.floor(Date.now() / 1000);
      const id = "restore-intercepted";
      for (const delta of [
        { role: "assistant", content: "Restore interception: no model executed." },
        {},
      ] as const) {
        const finish = delta.role === undefined ? "stop" : null;
        res.write(`data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
      trace.append("request.intercepted", {
        index: recorded.index,
        classification: recorded.classification,
        model,
      });
      if (
        this.#options.onRequestIntercepted !== undefined &&
        (recorded.classification === "task-new-turn" || recorded.classification === "task-continuation")
      ) {
        this.#options.onRequestIntercepted(body, recorded);
      }
      return;
    }
    const up = new URL(this.#options.upstreamURL);
    const basePath = up.pathname.replace(/\/[^/]*$/, "");
    // Manual concatenation: URL resolution with an absolute path would drop
    // the upstream base path.
    let target: URL;
    try {
      target = new URL(`${basePath}${req.url ?? "/"}`, `${up.protocol}//${up.host}`);
    } catch (err) {
      trace.append("destination.rejected", { reason: "target-build-failed", message: String(err) });
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "destination-rejected", reason: "target-build-failed" }));
      return;
    }

    // Validate the final destination BEFORE attaching credentials.
    const destError = this.#validateDestination(target, up, basePath);
    if (destError !== null) {
      trace.append("destination.rejected", {
        reason: destError,
        scheme: target.protocol,
        host: target.host,
        path: target.pathname,
      });
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "destination-rejected", reason: destError }));
      return;
    }

    // Credential policy: https upstreams always; http only to loopback
    // (development/tests). Plaintext credentials to non-loopback http are
    // never sent. Only the decision is recorded, never the value.
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(up.hostname);
    const httpsUpstream = up.protocol === "https:";
    const forwardAuth = auth !== undefined && (httpsUpstream || loopback);
    if (auth !== undefined) {
      trace.append(
        forwardAuth ? "auth.forwarded" : "auth.skipped",
        forwardAuth
          ? { transport: httpsUpstream ? "https" : "http-loopback" }
          : { reason: "http-non-loopback" },
      );
    }
    let response: http.IncomingMessage;
    try {
      response = await requestUpstream(target, body, {
        authorization: forwardAuth ? auth : undefined,
        rejectUnauthorized: this.#options.tlsRejectUnauthorized ?? true,
      });
    } catch (err) {
      trace.append("request.forward.failed", {
        index: recorded.index,
        turnId: recorded.turnId,
        message: String(err),
        scheme: target.protocol,
        host: target.host,
        path: target.pathname,
      });
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "upstream-failed" }));
      return;
    }
    const responseText = await readBody(response);
    if (onResponse !== undefined) {
      onResponse(responseText, response.statusCode ?? 0);
    }
    const index = this.requests.indexOf(recorded);
    const upstreamStatus = response.statusCode;
    this.requests[index] = {
      ...recorded,
      forwarded: true,
      ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
    };
    trace.append("request.forwarded", {
      index: recorded.index,
      turnId: recorded.turnId,
      background: recorded.background,
      upstreamStatus: response.statusCode,
      upstreamScheme: target.protocol.replace(":", ""),
    });
    res.writeHead(response.statusCode ?? 502, {
      "content-type": response.headers["content-type"] ?? "application/json",
    });
    res.end(responseText);
  }

  /** Validate the final destination before credentials are attached. */
  #validateDestination(target: URL, up: URL, basePath: string): string | null {
    if (target.protocol !== up.protocol) {
      return "destination-protocol-mismatch";
    }
    if (target.host !== up.host) {
      return "destination-host-mismatch";
    }
    const expectedPrefix = `${basePath}/`.replace(/^\/{2,}/, "/");
    if (!target.pathname.startsWith(expectedPrefix)) {
      return "destination-path-outside-base";
    }
    return null;
  }
}

function key(sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}`;
}

/** One upstream request via node:http/https, honoring the target protocol. */
function requestUpstream(
  target: URL,
  body: string,
  options: { authorization?: string | undefined; rejectUnauthorized: boolean },
): Promise<http.IncomingMessage> {
  const isHttps = target.protocol === "https:";
  const transport = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...(options.authorization !== undefined ? { authorization: options.authorization } : {}),
        },
        ...(isHttps ? { rejectUnauthorized: options.rejectUnauthorized } : {}),
      },
      resolve,
    );
    req.on("error", reject);
    req.end(body);
  });
}

function readBody(stream: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}