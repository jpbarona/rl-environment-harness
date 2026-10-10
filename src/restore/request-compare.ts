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
function neutralizePlatform(text: string): string {
  return text.replace(SYSTEM_PLATFORM, "Platform: <runtime>");
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
  // All model-request settings must match exactly. Only messages and tools
  // get dedicated comparisons (below); every other key — including limits
  // like max_tokens and any provider-specific option — is compared as a
  // setting. A key present on only one side is a difference.
  const settingsA = new Set(Object.keys(original).filter((k) => k !== "messages" && k !== "tools"));
  const settingsB = new Set(Object.keys(regenerated).filter((k) => k !== "messages" && k !== "tools"));
  const onlyA = [...settingsA].filter((k) => !settingsB.has(k));
  const onlyB = [...settingsB].filter((k) => !settingsA.has(k));
  for (const key of onlyA) {
    add(`settings.${key}`, original[key], undefined);
  }
  for (const key of onlyB) {
    add(`settings.${key}`, undefined, regenerated[key]);
  }
  for (const key of settingsA) {
    if (settingsB.has(key) && JSON.stringify(original[key]) !== JSON.stringify(regenerated[key])) {
      add(`settings.${key}`, original[key], regenerated[key]);
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
          return { ...t, function: { ...t.function, description: t.function.description.replace(SHELL_RUNTIME, "Commands run on <runtime>") } };
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
  }
  const common = Math.min(origMessages.length, regenMessages.length);
  for (let i = 0; i < common; i += 1) {
      const o = origMessages[i]!;
      const r = regenMessages[i]!;
      if (o.role !== r.role) {
        add(`messages[${i}].role`, o.role, r.role);
        continue;
      }
      if (i === 0 && o.role === "system" && r.role === "system") {
        const metadata = (message: Message): Record<string, unknown> => Object.fromEntries(
          Object.entries(message).filter(([key]) => key !== "content"),
        );
        if (JSON.stringify(metadata(o)) !== JSON.stringify(metadata(r))) {
          add("messages[0].metadata", metadata(o), metadata(r));
        }
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
        mapped = neutralizePlatform(mapped);
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
        const rcNeutral = dateLine(neutralizePlatform(rc));
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
export interface SelectedTurnInput {
  /** The original argv text of the selected user request. */
  readonly prompt: string;
  /** Present when the turn's context was compacted: the checkpoint summary
   * and the recent-context line OpenCode rendered into the wrapper. */
  readonly compaction?: { readonly summary: string; readonly recent: string };
}

/**
 * Extract the selected turn's input from the primary request. Two shapes:
 * an ordinary user message (possibly JSON-stringified by OpenCode), or a
 * compaction checkpoint wrapper whose <recent-context> carries the actual
 * pending prompt.
 */
export function selectedTurnInput(requestBody: Record<string, unknown>): SelectedTurnInput {
  const messages = (requestBody["messages"] ?? []) as Message[];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role !== "user") {
      continue;
    }
    if (typeof m.content !== "string") {
      throw new RestoreError("selection.prompt-shape", "selected user message content is not a string");
    }
    const content = m.content;
    if (content.includes("<conversation-checkpoint>")) {
      const summaryStart = content.indexOf("<summary>\n") + "<summary>\n".length;
      const summaryEnd = content.indexOf("</summary>");
      const recentStart = content.indexOf("<recent-context>\n") + "<recent-context>\n".length;
      const recentEnd = content.indexOf("</recent-context>");
      if (summaryStart < "<summary>\n".length || summaryEnd < 0 || recentEnd < 0) {
        throw new RestoreError("selection.checkpoint-wrapper-shape", "compaction wrapper lacks summary/recent sections");
      }
      const summary = content.slice(summaryStart, summaryEnd).replace(/\n$/, "");
      const recent = content.slice(recentStart, recentEnd).replace(/\n$/, "");
      const quoted = recent.replace(/^\[User\]: /, "");
      let prompt: string;
      try {
        const parsed = JSON.parse(quoted);
        if (typeof parsed !== "string") {
          throw new Error("not a string");
        }
        prompt = parsed;
      } catch {
        throw new RestoreError("selection.recent-prompt-shape", `recent context is not a JSON prompt: ${quoted.slice(0, 80)}`);
      }
      return { prompt, compaction: { summary, recent } };
    }
    // Ordinary prompt: OpenCode stores the argv text JSON-stringified.
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === "string") {
        return { prompt: parsed };
      }
    } catch {
      // Not a JSON string literal; submit as-is.
    }
    return { prompt: content };
  }
  throw new RestoreError("selection.prompt-missing", "primary request has no user message");
}