/**
 * S3-R4: compare the regenerated primary request against the captured one.
 *
 * The comparison is strict: instructions, ordered messages, tool schemas,
 * model id, and settings must match exactly after the DECLARED volatile
 * transforms below. Every transform is narrow and motivated; anything else
 * fails. The policy text lives in docs/restore.md and must stay in sync.
 */
import { RestoreError } from "./select.js";

export interface RequestComparisonEntry {
  readonly field: string;
  readonly reason: string;
  readonly detail: string;
}

export interface RequestComparison {
  readonly ok: boolean;
  /** Declared volatile fields that were transformed before comparison. */
  readonly declaredVolatile: RequestComparisonEntry[];
  readonly differences: Array<{ field: string; expected: string; actual: string }>;
}

export interface RequestCompareInput {
  readonly original: { body: Record<string, unknown> };
  readonly regenerated: { body: Record<string, unknown> };
  /** Captured host workspace root (original absolute paths). */
  readonly capturedWorkspaceRoot: string;
  /** Container workspace path (regenerated absolute paths). */
  readonly restoreWorkspacePath: string;
  /** Captured tmp dir prefix (TMPDIR under the run dir). */
  readonly capturedTmpPath?: string;
  /** Container tmp path. */
  readonly restoreTmpPath?: string;
}

interface Message {
  readonly role: string;
  readonly content?: unknown;
}

const SYSTEM_PLATFORM = /\bPlatform: (darwin|linux|win32)\b/g;
const SHELL_RUNTIME = /Commands run on (macOS using zsh|Linux using bash|Windows using PowerShell|Windows using cmd)/g;

/** Neutralize runtime-specific phrases with exact, narrow scopes. */
function neutralizeRuntime(text: string): string {
  return text
    .replace(SYSTEM_PLATFORM, "Platform: <runtime>")
    .replace(SHELL_RUNTIME, "Commands run on <runtime>");
}

function replaceAll(text: string, needle: string, replacement: string): string {
  return needle.length === 0 ? text : text.split(needle).join(replacement);
}

function dateLine(text: string): string {
  // The OpenCode env block announces the current date; it moves with the
  // clock and carries no task state.
  return text.replace(/Today's date: [^\n]*\n?/g, "Today's date: <date>\n");
}

/**
 * Compare. Both bodies must share model, tools, stream settings, and (after
 * declared transforms) every message in order.
 */
export function compareRequests(input: RequestCompareInput): RequestComparison {
  const declared: RequestComparisonEntry[] = [];
  const differences: Array<{ field: string; expected: string; actual: string }> = [];

  const original = input.original.body;
  const regenerated = input.regenerated.body;

  const origMessages = (original["messages"] ?? []) as Message[];
  const regenMessages = (regenerated["messages"] ?? []) as Message[];

  const add = (field: string, expected: unknown, actual: unknown): void => {
    differences.push({ field, expected: JSON.stringify(expected), actual: JSON.stringify(actual) });
  };

  if (original["model"] !== regenerated["model"]) {
    add("model", original["model"], regenerated["model"]);
  }
  for (const key of ["stream", "stream_options", "store", "temperature", "top_p", "tool_choice"] as const) {
    if (JSON.stringify(original[key]) !== JSON.stringify(regenerated[key])) {
      add(key, original[key], regenerated[key]);
    }
  }
  // Tool schemas: the shell tool's description states the runtime OS and
  // shell, which differs between the macOS capture host and the Linux
  // restore container. Neutralize that single phrase on both sides.
  if (JSON.stringify(original["tools"]) !== JSON.stringify(regenerated["tools"])) {
    const neutral = (tools: unknown): unknown => {
      if (!Array.isArray(tools)) {
        return tools;
      }
      return tools.map((tool) => {
        const t = tool as { function?: { name?: string; description?: string } };
        if (t?.function?.name === "shell" && typeof t.function.description === "string") {
          return { ...t, function: { ...t.function, description: neutralizeRuntime(t.function.description) } };
        }
        return tool;
      });
    };
    if (JSON.stringify(neutral(original["tools"])) !== JSON.stringify(neutral(regenerated["tools"]))) {
      add("tools", original["tools"], regenerated["tools"]);
    } else {
      declared.push({
        field: "tools.shell.platform",
        reason: "the shell tool description states the runtime OS and shell, which differ between the macOS capture host and the Linux restore container",
        detail: "runtime phrase neutralized in the shell tool description only",
      });
    }
  }

  if (origMessages.length !== regenMessages.length) {
    add("messages.length", origMessages.length, regenMessages.length);
  } else {
    for (let i = 0; i < origMessages.length; i += 1) {
      const o = origMessages[i]!;
      const r = regenMessages[i]!;
      if (o.role !== r.role) {
        add(`messages[${i}].role`, o.role, r.role);
        continue;
      }
      if (i === 0 && o.role === "system" && r.role === "system") {
        const oc = typeof o.content === "string" ? o.content : JSON.stringify(o.content);
        const rc = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
        let mapped = oc;
        if (input.capturedWorkspaceRoot !== input.restoreWorkspacePath) {
          mapped = replaceAll(mapped, input.capturedWorkspaceRoot, input.restoreWorkspacePath);
          declared.push({
            field: "system.paths",
            reason: "host-to-container path mapping of the declared workspace and tmp dirs",
            detail: `${input.capturedWorkspaceRoot} -> ${input.restoreWorkspacePath}`,
          });
        }
        if (input.capturedTmpPath && input.restoreTmpPath) {
          mapped = replaceAll(mapped, input.capturedTmpPath, input.restoreTmpPath);
        }
        const beforePlatform = mapped;
        mapped = neutralizeRuntime(mapped);
        if (mapped !== beforePlatform) {
          declared.push({
            field: "system.platform",
            reason: "the capture host is macOS and the restore runtime is Linux",
            detail: "Platform: darwin -> Platform: linux (env block)",
          });
        }
        const beforeDate = mapped;
        mapped = dateLine(mapped);
        if (mapped !== beforeDate) {
          declared.push({
            field: "system.date",
            reason: "the env block states the current date, which advances between capture and restore",
            detail: "date line neutralized on both sides",
          });
        }
        mapped = neutralizeRuntime(mapped);
        const rcNeutral = dateLine(neutralizeRuntime(rc));
        if (mapped !== rcNeutral) {
          const at = firstDifferenceIndex(mapped, rcNeutral);
          differences.push({
            field: `messages[0].content (at ${at})`,
            expected: JSON.stringify(mapped.slice(Math.max(0, at - 80), at + 120)),
            actual: JSON.stringify(rcNeutral.slice(Math.max(0, at - 80), at + 120)),
          });
        }
        continue;
      }
      if (JSON.stringify(o) !== JSON.stringify(r)) {
        add(`messages[${i}]`, o, r);
      }
    }
  }

  return { ok: differences.length === 0, declaredVolatile: declared, differences };
}

function firstDifferenceIndex(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) {
      return i;
    }
  }
  return a.length === b.length ? -1 : n;
}

/** Extract the selected prompt: the last user message of the primary request. */
export function selectedPrompt(requestBody: Record<string, unknown>): string {
  const messages = (requestBody["messages"] ?? []) as Message[];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === "user") {
      if (typeof m.content === "string") {
        // OpenCode stores the prompt as JSON.stringify(argv text); the
        // selected request replays the original argv text.
        try {
          const parsed = JSON.parse(m.content);
          if (typeof parsed === "string") {
            return parsed;
          }
        } catch {
          // Not a JSON string literal; submit as-is.
        }
        return m.content;
      }
      throw new RestoreError("selection.prompt-shape", "selected user message content is not a string");
    }
  }
  throw new RestoreError("selection.prompt-missing", "primary request has no user message");
}