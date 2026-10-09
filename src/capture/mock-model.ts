import http from "node:http";
import https from "node:https";

export interface MockToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface MockResponse {
  readonly content?: string;
  readonly toolCalls?: MockToolCall[];
}

export type MockScript = (input: {
  readonly model: string;
  readonly lastUserText: string;
  /** True when the conversation already contains tool output for this turn. */
  readonly sawToolOutput: boolean;
}) => MockResponse | undefined;

export interface MockObservation {
  readonly model: string;
  readonly lastUserText: string;
  readonly sawToolOutput: boolean;
  /** Date.now() when the mock received the request (arrival evidence). */
  readonly receivedAt: number;
  /** Request path as received. */
  readonly path: string;
}

/**
 * OpenAI-compatible mock model server for tests. Binds loopback only.
 * Speaks both streaming SSE (chat.completion.chunk) and non-streaming JSON.
 */
export interface MockTlsOptions {
  readonly key: string;
  readonly cert: string;
}

/**
 * OpenAI-compatible mock model server for tests. Binds loopback only.
 * Speaks both streaming SSE (chat.completion.chunk) and non-streaming JSON.
 * Pass tlsOptions to serve HTTPS (self-signed in tests).
 */
export class MockModelServer {
  readonly #server: http.Server | https.Server;
  readonly observations: MockObservation[] = [];
  /** Authorization headers received (test assertions; not persisted). */
  readonly receivedAuth: string[] = [];
  /** Request paths received (test assertions). */
  readonly observedPaths: string[] = [];
  /** Scheme per request ("https"|"http"), from the server transport. */
  readonly observedSchemes: string[] = [];
  readonly #isTls: boolean;
  #url = "";
  #script: MockScript;

  constructor(script: MockScript = defaultScript, tlsOptions?: MockTlsOptions) {
    this.#script = script;
    this.#isTls = tlsOptions !== undefined;
    const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
      void this.#handle(req, res);
    };
    this.#server = tlsOptions !== undefined ? https.createServer(tlsOptions, handler) : http.createServer(handler);
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => {
      this.#server.listen(0, "127.0.0.1", resolve);
    });
    const addr = this.#server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("mock model failed to bind loopback");
    }
    const scheme = this.#isTls ? "https" : "http";
    this.#url = `${scheme}://127.0.0.1:${addr.port}`;
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
    if (req.method !== "POST" || !(req.url ?? "").endsWith("/chat/completions")) {
      res.writeHead(404);
      res.end();
      return;
    }
        const body = await readBody(req);
    this.observedPaths.push(req.url ?? "");
    this.observedSchemes.push(this.#isTls ? "https" : "http");
    const rawAuth = req.headers["authorization"];
    const auth = Array.isArray(rawAuth) ? (rawAuth[0] ?? null) : (rawAuth ?? null);
    if (auth !== null) {
      this.receivedAuth.push(auth);
    }
    let parsed: {
      model?: unknown;
      stream?: unknown;
      messages?: Array<{ role?: unknown; content?: unknown }>;
    } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const model = typeof parsed.model === "string" ? parsed.model : "";
    const messages = parsed.messages ?? [];
    const sawToolOutput = messages.some((m) => m.role === "tool" || m.role === "function");
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const observation: MockObservation = {
      model,
      lastUserText: textOf(lastUser?.content),
      sawToolOutput,
      receivedAt: Date.now(),
      path: req.url ?? "",
    };
    this.observations.push(observation);

    const scripted = this.#script(observation);
    const response = scripted ?? { content: "ok" };
    const id = `chatcmpl-${this.observations.length}`;
    const created = Math.floor(Date.now() / 1000);

    if (parsed.stream === true) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      for (const chunk of sseChunks(id, created, model, response)) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(jsonCompletion(id, created, model, response)));
  }
}

/** Default script: emit a shell tool call when asked, otherwise plain text. */
export const defaultScript: MockScript = ({ lastUserText, sawToolOutput }) => {
  if (lastUserText.includes("USE_TOOL")) {
    if (!sawToolOutput) {
      return {
        toolCalls: [
          {
            id: "call_probe",
            name: "shell",
            args: {
              command: "printf 'captured-by-tool' > tool-probe.txt",
              description: "write a probe file",
            },
          },
        ],
      };
    }
    return { content: "done" };
  }
  return { content: `ok: ${lastUserText.slice(0, 32)}` };
};

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}

interface Chunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
}

function* sseChunks(id: string, created: number, model: string, response: MockResponse): Generator<Chunk> {
  const firstDelta: Record<string, unknown> = { role: "assistant" };
  if (response.toolCalls !== undefined && response.toolCalls.length > 0) {
    const call = response.toolCalls[0];
    if (call === undefined) {
      throw new Error("unreachable");
    }
    firstDelta["tool_calls"] = [
      {
        index: 0,
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      },
    ];
    yield { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: firstDelta, finish_reason: null }] };
    yield { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
    return;
  }
  firstDelta["content"] = response.content ?? "";
  yield { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: firstDelta, finish_reason: null }] };
  yield { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
}

function jsonCompletion(
  id: string,
  created: number,
  model: string,
  response: MockResponse,
): unknown {
  if (response.toolCalls !== undefined && response.toolCalls.length > 0) {
    const call = response.toolCalls[0];
    if (call === undefined) {
      throw new Error("unreachable");
    }
    return {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
  }
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: response.content ?? "" },
        finish_reason: "stop",
      },
    ],
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}