/**
 * System configuration for the checkpoint command (S5-R3).
 *
 * One configuration file drives the whole Step 5 pipeline: directories,
 * writer/reviewer/judge models, credential ENVIRONMENT-VARIABLE NAMES (never
 * values), the per-checkpoint model-spend cap, timeouts, retry limits, and
 * the versioned universal task-quality rubric.
 *
 * Default location: <repo>/checkpoint.config.json. Override with the
 * CHECKPOINT_CONFIG environment variable.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface RubricDimension {
  readonly id: string;
  readonly description: string;
  /** Weight in the quality score; equal when unset by the user. */
  readonly weight: number;
}

export interface SystemConfig {
  /** Absolute path to the live capture store (objects/ + checkpoints/). */
  readonly storePath: string;
  /** Absolute export root for published tasks (output/tasks). */
  readonly outputDir: string;
  /** Absolute jobs root (output/jobs). */
  readonly jobsDir: string;
  /** Capture control endpoint of the harness proxy beside the OpenCode server. */
  readonly captureServiceURL: string;
  readonly writer: AgentModelConfig;
  readonly reviewer: AgentModelConfig;
  /** Judge model string used inside RewardKit judge.toml (LiteLLM format). */
  readonly judgeModel: string;
  /**
   * Solver endpoint: the replayed attempt runs against this endpoint with the
   * CAPTURED model id (model/version identity is retained from the capture).
   */
  readonly solver: AgentModelConfig & { readonly providerName: string };
  /**
   * Verifier environment variables: container variable name -> host
   * environment-variable NAME. Values are resolved by Harbor at runtime and
   * are never stored.
   */
  readonly verifierEnv: Record<string, string>;
  /** Credential environment-variable NAMES; values are never stored. */
  readonly credentials: Record<string, string>;
  /** Aggregate model-spend cap per checkpoint, in USD. Default 0.20. */
  readonly modelSpendCapUSD: number;
  readonly timeouts: {
    readonly writerMs: number;
    readonly reviewerMs: number;
    readonly judgeSec: number;
    readonly harborSec: number;
  };
  readonly retries: {
    readonly writer: number;
    readonly reviewer: number;
  };
  readonly rubric: {
    readonly version: string;
    readonly dimensions: readonly RubricDimension[];
  };
}

export interface AgentModelConfig {
  /** OpenAI-compatible chat-completions endpoint base URL. */
  readonly baseURL: string;
  /** Model identifier sent as request body `model`. */
  readonly model: string;
  /** Credential env-var NAME for the endpoint; resolved at runtime. */
  readonly apiKeyEnv: string;
  readonly maxOutputTokens: number;
}

export const DEFAULT_RUBRIC_VERSION = "universal-task-quality-v1";

/** The six agreed rubric dimensions; equal weights (none were specified). */
export function defaultRubric(): { version: string; dimensions: RubricDimension[] } {
  const descriptions = [
    "Clear instructions.",
    "Correct starting state and sufficient context.",
    "Success criteria match the user's intent.",
    "Grading covers results and required behaviour.",
    "Known correct and incorrect examples receive appropriate scores.",
    "Native Harbor execution works.",
  ];
  return {
    version: DEFAULT_RUBRIC_VERSION,
    dimensions: descriptions.map((description, i) => ({ id: `D${i + 1}`, description, weight: 1 })),
  };
}

export class ConfigError extends Error {
  constructor(readonly field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "ConfigError";
  }
}

export function configPath(explicit?: string): string {
  return resolve(explicit ?? process.env["CHECKPOINT_CONFIG"] ?? join(process.cwd(), "checkpoint.config.json"));
}

export function loadConfig(explicit?: string): SystemConfig {
  const path = configPath(explicit);
  if (!existsSync(path)) {
    throw new ConfigError("config", `configuration file does not exist: ${path}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError("config", `unparseable configuration: ${String(err)}`);
  }
  return validateConfig(parsed);
}

function requireString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(field, "must be a non-empty string");
  }
  return value;
}

function requireAgent(source: Record<string, unknown>, field: string): AgentModelConfig {
  const raw = source[field];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(field, "must be an object");
  }
  const agent = raw as Record<string, unknown>;
  const model = requireAgentString(agent, field);
  return {
    baseURL: model.baseURL,
    model: model.model,
    apiKeyEnv: model.apiKeyEnv,
    maxOutputTokens: model.maxOutputTokens,
  };
}

function requireAgentString(agent: Record<string, unknown>, field: string): {
  baseURL: string;
  model: string;
  apiKeyEnv: string;
  maxOutputTokens: number;
} {
  const baseURLRaw = agent["baseURL"];
  if (typeof baseURLRaw !== "string" || baseURLRaw.trim() === "" || !/^https?:\/\//.test(baseURLRaw)) {
    throw new ConfigError(`${field}.baseURL`, "must be an http(s) URL");
  }
  const modelRaw = agent["model"];
  if (typeof modelRaw !== "string" || modelRaw.trim() === "") {
    throw new ConfigError(`${field}.model`, "must be a non-empty string");
  }
  const apiKeyEnv = agent["apiKeyEnv"];
  if (typeof apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new ConfigError(`${field}.apiKeyEnv`, "must be an environment-variable NAME");
  }
  const rawTokens = agent["maxOutputTokens"];
  const maxOutputTokens = typeof rawTokens === "number" && Number.isInteger(rawTokens) && rawTokens > 0 ? rawTokens : 4096;
  return { baseURL: baseURLRaw, model: modelRaw, apiKeyEnv, maxOutputTokens };
}

function validateConfig(parsed: Record<string, unknown>): SystemConfig {
  const storePath = requireString(parsed, "storePath");
  const outputDir = requireString(parsed, "outputDir");
  const jobsDir = requireString(parsed, "jobsDir");
  const captureServiceURL = requireString(parsed, "captureServiceURL");
  if (!/^https?:\/\//.test(captureServiceURL)) {
    throw new ConfigError("captureServiceURL", "must be an http(s) URL");
  }
  const writer = requireAgent(parsed, "writer");
  const reviewer = requireAgent(parsed, "reviewer");
  const judgeModel = requireString(parsed, "judgeModel");
  const solverRaw = requireAgent(parsed, "solver");
  const providerNameRaw = (parsed["solver"] as Record<string, unknown>)["providerName"];
  if (typeof providerNameRaw !== "string" || !/^[A-Za-z0-9_-]+$/.test(providerNameRaw)) {
    throw new ConfigError("solver.providerName", "must be a provider identifier");
  }
  const solver = { ...solverRaw, providerName: providerNameRaw };
  const verifierEnvRaw = parsed["verifierEnv"];
  if (verifierEnvRaw !== undefined && (verifierEnvRaw === null || typeof verifierEnvRaw !== "object" || Array.isArray(verifierEnvRaw))) {
    throw new ConfigError("verifierEnv", "must be an object mapping container var names to host env-var names");
  }
  const verifierEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries((verifierEnvRaw ?? {}) as Record<string, unknown>)) {
    if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      throw new ConfigError(`verifierEnv.${key}`, "must name a host environment variable");
    }
    verifierEnv[key] = value;
  }
  const credentialsRaw = parsed["credentials"];
  if (credentialsRaw !== undefined && (credentialsRaw === null || typeof credentialsRaw !== "object" || Array.isArray(credentialsRaw))) {
    throw new ConfigError("credentials", "must be an object of env-var names");
  }
  const credentials: Record<string, string> = {};
  for (const [key, value] of Object.entries((credentialsRaw ?? {}) as Record<string, unknown>)) {
    if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      throw new ConfigError(`credentials.${key}`, "must name an environment variable");
    }
    credentials[key] = value;
  }
  const capRaw = parsed["modelSpendCapUSD"];
  if (capRaw !== undefined && (typeof capRaw !== "number" || capRaw <= 0)) {
    throw new ConfigError("modelSpendCapUSD", "must be a positive number");
  }
  const modelSpendCapUSD = typeof capRaw === "number" ? capRaw : 0.20;
  const timeoutsRaw = (parsed["timeouts"] ?? {}) as Record<string, unknown>;
  const num = (field: string, fallback: number): number => {
    const v = timeoutsRaw[field];
    return typeof v === "number" && v > 0 ? v : fallback;
  };
  const retriesRaw = (parsed["retries"] ?? {}) as Record<string, unknown>;
  const retryNum = (field: string, fallback: number): number => {
    const v = retriesRaw[field];
    return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback;
  };
  const rubricRaw = parsed["rubric"];
  let rubric = defaultRubric();
  if (rubricRaw !== undefined) {
    if (rubricRaw === null || typeof rubricRaw !== "object") {
      throw new ConfigError("rubric", "must be an object");
    }
    const r = rubricRaw as Record<string, unknown>;
    rubric = {
      version: typeof r["version"] === "string" ? r["version"] : DEFAULT_RUBRIC_VERSION,
      dimensions: defaultRubric().dimensions,
    };
  }
  return {
    storePath: resolve(storePath),
    outputDir: resolve(outputDir),
    jobsDir: resolve(jobsDir),
    captureServiceURL,
    writer,
    reviewer,
    judgeModel,
    solver,
    verifierEnv,
    credentials,
    modelSpendCapUSD,
    timeouts: {
      writerMs: num("writerMs", 180_000),
      reviewerMs: num("reviewerMs", 180_000),
      judgeSec: num("judgeSec", 300),
      harborSec: num("harborSec", 1_200),
    },
    retries: { writer: retryNum("writer", 1), reviewer: retryNum("reviewer", 1) },
    rubric,
  };
}
