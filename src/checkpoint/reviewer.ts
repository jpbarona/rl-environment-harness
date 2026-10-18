/**
 * Independent task-quality reviewer (S5-R3).
 *
 * Runs AFTER the writer completes and inspects the generated task, its
 * verifier, and the validation evidence. It applies one versioned universal
 * rubric and returns one quality score out of 100 plus a per-dimension
 * breakdown. The quality score is separate from the solver reward.
 */
import { chatCompletion, LlmError, type ChatMessage, type SpendTracker } from "./llm.js";
import type { AgentModelConfig, SystemConfig } from "./config.js";

export interface ReviewInput {
  readonly instructionMd: string;
  readonly checksPy: string;
  readonly judgeToml: string | null;
  readonly validationSummary: string;
  readonly nativeRunSummary: string;
  readonly userDescription: string;
  readonly selectedPrompt: string;
}

export interface ReviewResult {
  readonly overall: number;
  readonly scores: Record<string, number>;
  readonly notes: string;
}

export function rubricPromptBlock(config: SystemConfig): string {
  const dims = config.rubric.dimensions
    .map((d) => `- ${d.id}: ${d.description} (weight ${d.weight})`)
    .join("\n");
  return `Universal task-quality rubric ${config.rubric.version} (score 0-100 per dimension):\n${dims}`;
}

export function buildReviewerMessages(input: ReviewInput, config: SystemConfig): ChatMessage[] {
  return [
    {
      role: "system",
      content: `You are an independent task-quality reviewer. You did not write the task under review and you do not grade solver attempts. Assess the generated Harbor task against the rubric and return ONLY a JSON object with keys "scores" (object mapping dimension id to a number 0-100), "overall" (weighted mean, rounded to the nearest integer), and "notes" (short justification). Be strict; do not inflate.\n\n${rubricPromptBlock(config)}`,
    },
    {
      role: "user",
      content: JSON.stringify({
        user_description_of_failure: input.userDescription,
        original_user_request: input.selectedPrompt,
        instruction_md: input.instructionMd,
        checks_py: input.checksPy,
        judge_toml: input.judgeToml,
        validation_evidence: input.validationSummary,
        native_harbor_evidence: input.nativeRunSummary,
      }),
    },
  ];
}

export function parseReviewerOutput(text: string): ReviewResult {
  let data: unknown;
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    data = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new LlmError("invalid", `reviewer output is not JSON: ${String(err)}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new LlmError("invalid", "reviewer output is not a JSON object");
  }
  const o = data as Record<string, unknown>;
  const scoresRaw = o["scores"];
  if (scoresRaw === null || typeof scoresRaw !== "object" || Array.isArray(scoresRaw)) {
    throw new LlmError("invalid", "reviewer output lacks a scores object");
  }
  const scores: Record<string, number> = {};
  for (const [key, value] of Object.entries(scoresRaw as Record<string, unknown>)) {
    if (typeof value !== "number" || value < 0 || value > 100) {
      throw new LlmError("invalid", `reviewer score ${key} is not a number in [0, 100]`);
    }
    scores[key] = value;
  }
  const overallRaw = o["overall"];
  if (typeof overallRaw !== "number" || overallRaw < 0 || overallRaw > 100) {
    throw new LlmError("invalid", "reviewer overall score is not a number in [0, 100]");
  }
  return {
    overall: Math.round(overallRaw),
    scores,
    notes: typeof o["notes"] === "string" ? o["notes"] : "",
  };
}

export async function runReviewer(
  config: AgentModelConfig,
  input: ReviewInput,
  systemConfig: SystemConfig,
  spend: SpendTracker,
  options: { readonly timeoutMs: number; readonly retries: number },
): Promise<ReviewResult> {
  const messages = buildReviewerMessages(input, systemConfig);
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    spend.admit(`reviewer attempt ${attempt + 1}`);
    try {
      const result = await chatCompletion(config, messages, { timeoutMs: options.timeoutMs });
      spend.record(result.costUSD, `reviewer attempt ${attempt + 1}`, { estimated: result.costEstimated });
      return parseReviewerOutput(result.text);
    } catch (err) {
      lastError = err;
      if (err instanceof LlmError && err.kind === "budget") {
        throw err;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new LlmError("http", String(lastError));
}
