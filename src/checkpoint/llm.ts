/**
 * Bounded OpenAI-compatible chat-completions client for the writer and the
 * independent reviewer (S5-R3, S5-R7).
 *
 * Every call requests `usage: {include: true}` so the provider reports the
 * actual cost, which the SpendTracker accumulates against the aggregate
 * per-checkpoint cap. Credential VALUES are resolved from the configured
 * environment-variable names at call time and never persisted.
 */
import type { AgentModelConfig } from "./config.js";

export interface LlmCallResult {
  readonly text: string;
  /** Provider-reported cost in USD; 0 when the provider reports none. */
  readonly costUSD: number;
  readonly model: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  } | null;
}

export class LlmError extends Error {
  constructor(readonly kind: "http" | "budget" | "invalid", message: string) {
    super(message);
    this.name = "LlmError";
  }
}

export interface ChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export async function chatCompletion(
  config: AgentModelConfig,
  messages: readonly ChatMessage[],
  options: {
    readonly timeoutMs: number;
    readonly maxOutputTokens?: number;
  },
): Promise<LlmCallResult> {
  const apiKey = process.env[config.apiKeyEnv];
  if (apiKey === undefined || apiKey === "") {
    throw new LlmError("http", `credential environment variable ${config.apiKeyEnv} is not set`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(`${config.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: options.maxOutputTokens ?? config.maxOutputTokens,
        stream: false,
        usage: { include: true },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new LlmError("http", `model endpoint returned ${response.status}: ${text.slice(0, 200)}`);
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
      usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const choice = body.choices?.[0]?.message;
    const content = typeof choice?.content === "string"
      ? choice.content
      : Array.isArray(choice?.content)
        ? choice.content.map((part) => part.text ?? "").join("")
        : "";
    if (content.trim() === "") {
      throw new LlmError("invalid", "model returned empty content");
    }
    return {
      text: content,
      costUSD: typeof body.usage?.cost === "number" ? body.usage.cost : 0,
      model: body.model ?? config.model,
      usage: body.usage
        ? {
            inputTokens: body.usage.prompt_tokens ?? 0,
            outputTokens: body.usage.completion_tokens ?? 0,
          }
        : null,
    };
  } catch (err) {
    if (err instanceof LlmError) {
      throw err;
    }
    if ((err as { name?: string }).name === "AbortError") {
      throw new LlmError("http", `model call timed out after ${options.timeoutMs} ms`);
    }
    throw new LlmError("http", String(err instanceof Error ? err.message : err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Aggregate per-checkpoint spend cap (S5-R7). The cap covers generation,
 * independent review, validation judge calls and retries. Every admitted
 * call must fit; exceeding the cap at any accounting point fails the job
 * with a named error.
 */
export class SpendTracker {
  #spentUSD = 0;
  #observations = 0;

  constructor(readonly capUSD: number) {}

  get spentUSD(): number {
    return this.#spentUSD;
  }

  /**
   * Throws when the call would exceed the aggregate cap. Admission uses the
   * larger of a small placeholder and 1.5x the average actually-observed
   * cost, so free-model flows admit freely while paid flows stay bounded.
   */
  admit(label: string, placeholderUSD = 0.02): void {
    const observed = this.#observations > 0 ? this.#spentUSD / this.#observations : 0;
    const estimate = Math.max(placeholderUSD, observed * 1.5);
    if (this.#spentUSD + estimate > this.capUSD) {
      throw new LlmError(
        "budget",
        `model-spend cap exceeded before ${label}: spent ${this.#spentUSD.toFixed(4)} + estimated ${estimate.toFixed(4)} > cap ${this.capUSD.toFixed(2)} USD`,
      );
    }
  }

  record(actualCostUSD: number, label: string): void {
    this.#spentUSD += actualCostUSD;
    this.#observations += 1;
    if (this.#spentUSD > this.capUSD) {
      throw new LlmError(
        "budget",
        `aggregate model-spend cap exceeded after ${label}: ${this.#spentUSD.toFixed(4)} > cap ${this.capUSD.toFixed(2)} USD`,
      );
    }
  }
}
