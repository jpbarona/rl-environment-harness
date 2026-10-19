/**
 * Smart task writer (S5-R3).
 *
 * One bounded model call turns the frozen capture (selected request, prior
 * context, workspace inventory, original-attempt evidence) plus the user's
 * failure description into a Harbor task definition: instruction, task
 * metadata, programmatic RewardKit checks, an optional model-rubric judge
 * TOML, and a solution script used only to produce the known-correct
 * validation fixture. Output is a strict JSON envelope; anything else is a
 * writer failure and is retried within the configured limit.
 */
import { chatCompletion, LlmError, type ChatMessage, type SpendTracker } from "./llm.js";
import type { AgentModelConfig } from "./config.js";

export interface WorkspaceFileExcerpt {
  readonly path: string;
  readonly bytes: number;
  /** Up to 2048 chars of file content; empty files carry "". */
  readonly excerpt: string;
}

export interface WriterInput {
  readonly description: string;
  readonly selectedPrompt: string;
  readonly priorContextExcerpt: string;
  /** Bounded file contents (not just names) so criteria can be precise. */
  readonly workspaceFiles: readonly WorkspaceFileExcerpt[];
  readonly attemptExcerpt: string;
  readonly judgeModelPlaceholder: string;
  /**
   * Recorded runtime transformations applied to the materialized replay
   * workspace before the writer sees it (provider scrub, plugin removal).
   */
  readonly replayTransformations?: readonly string[];
  readonly workspacePaths?: readonly string[];
  /** The previous attempt's validation error, fed back on retry. */
  readonly previousError?: string;
}

export interface WriterOutput {
  readonly taskName: string;
  readonly taskDescription: string;
  readonly instructionMd: string;
  readonly checksPy: string;
  readonly judgeToml: string | null;
  readonly solveSh: string;
  /** Mutations of a solved workspace that must earn zero reward. */
  readonly invalidExamples?: readonly { readonly name: string; readonly script: string }[];
}

const WRITER_SYSTEM = `You convert a failed coding-agent attempt into a Harbor reinforcement-learning task.

You receive: the user's original request, the user's description of what went wrong,
bounded excerpts of the captured workspace files (path, size, content prefix), an
excerpt of the prior conversation, and an excerpt of the original failed attempt.

You produce a JSON object with these keys:
- "taskName": short-kebab-case task name (no spaces).
- "taskDescription": one-sentence task description.
- "instructionMd": the task instruction for a fresh agent working in /app. It must
  restate the intended outcome precisely, without revealing grading details or
  reference answers.
- "checksPy": a complete Python module for RewardKit programmatic criteria. Import
  rewardkit as rk and register criteria against the /app workspace. Use only
  deterministic built-ins (rk.file_exists, rk.file_contains, rk.command_succeeds,
  rk.json_key_equals, ...) or @criterion functions taking (workspace: Path).
  For decorators, use @rk.criterion explicitly (rk is already imported).
  At least one criterion is required. Never read /tests, /logs, or network paths.
- "judgeToml": either null, or a complete RewardKit judge TOML string. Use
  judge = "JUDGE_MODEL_PLACEHOLDER" literally; the harness substitutes the real
  judge model. List graded files under files = ["/app/..."]. Use binary or
  likert criteria with weights.
- "solveSh": a bash script that, run with /app as its working directory, turns the
  starting workspace into a CORRECT solution state (idempotent, no network).
- "invalidExamples": 1 to 4 objects with "name" and "script". Each bash script
  starts from a COPY OF THE SOLVED workspace and deliberately violates a required
  outcome. It must exit successfully; the verifier must return reward 0. For exact
  file content, include an extra trailing newline and wrong content. If other
  files must not change, include an unrelated-file edit. Never use these examples
  as special cases in checks: grade the real task constraints.

Rules: the success criteria must check the OUTCOME the user wanted, not the agent's
prose. Required programmatic checks are an all-pass gate: preservation alone
must not give credit when the requested result is absent. Keep exact byte/content
requirements exact: do not tolerate trailing newlines, trim whitespace, or weaken
"no other file changes" to checks on only one file. Do not relax the original
request in instructionMd. The verifier runs RewardKit in a plain Python container with NO sandbox or
overlay tooling: command criteria execute directly with /app as their working
directory. NEVER pass isolated=True to any command criterion (the verifier cannot
provide filesystem isolation; the criteria smoke rejects the attempt). Built-in
calls accept ONLY their positional arguments plus weight; @criterion accepts ONLY
description and shared. NEVER pass name=, description=, or any other keyword to a
built-in call. workspace_files contains BOUNDED CONTENT EXCERPTS, not a complete filesystem list.
workspace_paths, when present, lists all starting paths, including directories.
Preservation criteria must not treat pre-existing hidden directories as unwanted additions. Respect the
recorded runtime transformations in replay_transformations. Do not invent original
file contents beyond the excerpts. Output ONLY the JSON
object, no markdown fence.`;

export function buildWriterMessages(input: WriterInput): ChatMessage[] {
  const payload: Record<string, unknown> = {
    user_description_of_failure: input.description,
    original_user_request: input.selectedPrompt,
    prior_context_excerpt: input.priorContextExcerpt,
    workspace_files: input.workspaceFiles,
    original_attempt_excerpt: input.attemptExcerpt,
    judge_model_placeholder: input.judgeModelPlaceholder,
    ...(input.workspacePaths !== undefined ? { workspace_paths: input.workspacePaths } : {}),
  };
  if (input.replayTransformations !== undefined && input.replayTransformations.length > 0) {
    payload["replay_transformations"] = input.replayTransformations;
  }
  if (input.previousError !== undefined) {
    payload["previous_attempt_error"] = input.previousError;
    payload["fix_required"] = "Your previous checksPy failed to run with the error above. Fix checksPy so RewardKit accepts it.";
  }
  return [
    { role: "system", content: WRITER_SYSTEM },
    { role: "user", content: JSON.stringify(payload) },
  ];
}

/** Parse and validate the writer envelope; throws LlmError("invalid") on gap. */
export function parseWriterOutput(text: string): WriterOutput {
  let data: unknown;
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("no JSON object found");
    }
    data = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new LlmError("invalid", `writer output is not a JSON object: ${String(err)}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new LlmError("invalid", "writer output is not a JSON object");
  }
  const o = data as Record<string, unknown>;
  const str = (key: string): string => {
    const v = o[key];
    if (typeof v !== "string" || v.trim() === "") {
      throw new LlmError("invalid", `writer output field ${key} must be a non-empty string`);
    }
    return v;
  };
  const taskName = str("taskName");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(taskName)) {
    throw new LlmError("invalid", `writer taskName ${taskName} is not kebab-case`);
  }
  const checksPy = str("checksPy");
  if (!checksPy.includes("rk.") && !checksPy.includes("@criterion")) {
    throw new LlmError("invalid", "checksPy registers no RewardKit criteria");
  }
  if (/\bisolated\s*=\s*True\b/.test(checksPy)) {
    throw new LlmError(
      "invalid",
      "checksPy uses isolated=True on a command criterion; the configured verifier cannot provide filesystem isolation (no fuse-overlayfs in the container). Use the default isolated=False so the command runs directly in the graded workspace, or use file criteria.",
    );
  }
  const judgeRaw = o["judgeToml"];
  let judgeToml: string | null = null;
  if (judgeRaw !== null && judgeRaw !== undefined) {
    if (typeof judgeRaw !== "string" || judgeRaw.trim() === "") {
      throw new LlmError("invalid", "writer judgeToml must be null or a TOML string");
    }
    if (!judgeRaw.includes("JUDGE_MODEL_PLACEHOLDER")) {
      throw new LlmError("invalid", "writer judgeToml must use JUDGE_MODEL_PLACEHOLDER for the judge model");
    }
    judgeToml = judgeRaw;
  }
  const invalidRaw = o["invalidExamples"];
  let invalidExamples: { name: string; script: string }[] = [];
  if (invalidRaw !== undefined) {
    if (!Array.isArray(invalidRaw) || invalidRaw.length < 1 || invalidRaw.length > 4) {
      throw new LlmError("invalid", "invalidExamples must contain 1 to 4 negative validation examples");
    }
    invalidExamples = invalidRaw.map((entry: unknown) => {
      if (entry === null || typeof entry !== "object" ||
          typeof (entry as Record<string, unknown>)["name"] !== "string" ||
          typeof (entry as Record<string, unknown>)["script"] !== "string") {
        throw new LlmError("invalid", "negative examples require a name and script");
      }
      const e = entry as { name: string; script: string };
      if (!e.name.trim() || !e.script.trim()) throw new LlmError("invalid", "negative example fields must not be empty");
      return e;
    });
  }
  return {
    ...(invalidExamples.length ? { invalidExamples } : {}),
    taskName,
    taskDescription: str("taskDescription"),
    instructionMd: str("instructionMd"),
    checksPy,
    judgeToml,
    solveSh: str("solveSh"),
  };
}

export async function runWriter(
  config: AgentModelConfig,
  input: WriterInput,
  spend: SpendTracker,
  options: { readonly timeoutMs: number; readonly retries: number },
): Promise<WriterOutput> {
  const messages = buildWriterMessages(input);
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    spend.admit(`writer attempt ${attempt + 1}`);
    try {
      const result = await chatCompletion(config, messages, { timeoutMs: options.timeoutMs });
      spend.record(result.costUSD, `writer attempt ${attempt + 1}`, { estimated: result.costEstimated });
      return parseWriterOutput(result.text);
    } catch (err) {
      lastError = err;
      if (err instanceof LlmError && err.kind === "budget") {
        throw err;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new LlmError("http", String(lastError));
}
