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
  /**
   * Cost in USD: the provider-reported value when present, otherwise a
   * documented-ceiling estimate from the token usage (never silently zero).
   */
  readonly costUSD: number;
  /** True when costUSD is an estimate rather than a provider-reported value. */
  readonly costEstimated: boolean;
  readonly model: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  } | null;
}

/**
 * Documented fallback ceiling for cost estimation when the provider does not
 * report a cost: $3 per million input tokens and $15 per million output
 * tokens (frontier-tier published prices). Estimates are flagged and count
 * against the cap; they are never presented as actual spend.
 */
export const FALLBACK_INPUT_USD_PER_TOKEN = 3 / 1_000_000;
export const FALLBACK_OUTPUT_USD_PER_TOKEN = 15 / 1_000_000;

export function estimateCostFromTokens(inputTokens: number, outputTokens: number): number {
  return inputTokens * FALLBACK_INPUT_USD_PER_TOKEN + outputTokens * FALLBACK_OUTPUT_USD_PER_TOKEN;
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
        // Docker fixture work can block this process between calls. Do not
        // reuse an idle socket whose remote close has not been processed yet.
        connection: "close",
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
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }>; reasoning?: unknown }; finish_reason?: string }>;
      usage?: {
        cost?: number | null;
        prompt_tokens?: number;
        completion_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
      model?: string;
    };
    const choice = body.choices?.[0]?.message;
    const content = typeof choice?.content === "string"
      ? choice.content
      : Array.isArray(choice?.content)
        ? choice.content.map((part) => part.text ?? "").join("")
        : "";
    if (content.trim() === "") {
      // Precise diagnosis, no credentials: why the model produced nothing.
      const finishReason = body.choices?.[0]?.finish_reason ?? "unknown";
      const completionTokens = body.usage?.completion_tokens;
      const reasoningTokens = body.usage?.completion_tokens_details?.reasoning_tokens;
      const reasoningBlock = typeof choice?.reasoning === "string" && choice.reasoning.trim() !== "";
      const parts = [
        `model=${body.model ?? config.model}`,
        `finish_reason=${finishReason}`,
        `completion_tokens=${completionTokens ?? "unreported"}`,
        ...(reasoningTokens !== undefined ? [`reasoning_tokens=${reasoningTokens}`] : []),
        ...(reasoningBlock && reasoningTokens === undefined ? ["reasoning block present, token split unreported"] : []),
      ];
      throw new LlmError("invalid", `model returned empty content (${parts.join(", ")})`);
    }
    const inputTokens = body.usage?.prompt_tokens ?? 0;
    const outputTokens = body.usage?.completion_tokens ?? 0;
    const reportedCost = body.usage?.cost;
    const costEstimated = typeof reportedCost !== "number";
    return {
      text: content,
      costUSD: costEstimated ? estimateCostFromTokens(inputTokens, outputTokens) : reportedCost!,
      costEstimated,
      model: body.model ?? config.model,
      usage: { inputTokens, outputTokens },
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
  #estimatedUSD = 0;
  #observations = 0;

  constructor(readonly capUSD: number) {}

  /** The portion of the recorded spend that is estimated, not reported. */
  get estimatedUSD(): number {
    return this.#estimatedUSD;
  }

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

  record(actualCostUSD: number, label: string, options: { readonly estimated?: boolean } = {}): void {
    this.#spentUSD += actualCostUSD;
    if (options.estimated === true) {
      this.#estimatedUSD += actualCostUSD;
    }
    this.#observations += 1;
    if (this.#spentUSD > this.capUSD) {
      throw new LlmError(
        "budget",
        `aggregate model-spend cap exceeded after ${label}: ${this.#spentUSD.toFixed(4)} > cap ${this.capUSD.toFixed(2)} USD`,
      );
    }
  }
}
