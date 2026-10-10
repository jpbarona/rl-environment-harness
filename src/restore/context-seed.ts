/**
 * S3-R4: reconstruct the prior conversation in a fresh OpenCode session
 * store. The capture kept provider-form messages (prior_context.json); the
 * seeder maps them into OpenCode's session_message rows (SQLite) so that
 * real OpenCode regenerates the same effective input when the selected
 * prompt is submitted. Internal-only fields (timestamps, token counters,
 * finish metadata) are filled with inert values: they never reach the
 * provider request, and the comparator compares provider requests only.
 */
import { RestoreError } from "./select.js";

export interface SeedMessageRow {
  readonly type: "user" | "assistant" | "idle";
  readonly id: string;
  readonly seq: number;
  readonly timeCreated: number;
  readonly data: unknown;
}

export interface SeedPlan {
  readonly sessionId: string;
  readonly projectId: string;
  readonly directory: string;
  readonly version: string;
  readonly title: string;
  readonly timeCreated: number;
  readonly rows: SeedMessageRow[];
}

interface ProviderMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly tool_calls?: Array<{
    readonly id: string;
    readonly type?: string;
    readonly function: { readonly name: string; readonly arguments: string };
  }>;
  readonly tool_call_id?: string;
}

export interface SeedInput {
  /** Provider-form messages captured BEFORE the selected request. */
  readonly priorMessages: ProviderMessage[];
  readonly sessionId: string;
  /** Deterministic project id for the container workspace. */
  readonly projectId: string;
  readonly directory: string;
  readonly opencodeVersion: string;
  readonly title: string;
  /** Model id recorded on assistant messages. */
  readonly modelId: string;
  /** Base epoch ms for internal timestamps (from runtime capturedAt). */
  readonly baseTime: number;
}

const SQLITE_MAX = 0x7fffffff;

/** Map provider messages into OpenCode session rows. */
export function planSeed(input: SeedInput): SeedPlan {
  const rows: SeedMessageRow[] = [];
  let seq = 1;
  let nextId = 1;
  const messageId = () => `msg_restore_${String(nextId++).padStart(4, "0")}`;
  const t = (offset: number) => input.baseTime + offset;

  const toolResults = new Map<string, string>();
  for (const m of input.priorMessages) {
    if (m.role === "tool" && typeof m.tool_call_id === "string") {
      toolResults.set(m.tool_call_id, textOf(m.content));
    }
  }

  for (const message of input.priorMessages) {
    if (message.role === "system") {
      // OpenCode regenerates its own system prompt; never seeded.
      continue;
    }
    if (message.role === "tool") {
      // Folded into the matching assistant tool part.
      continue;
    }
    if (message.role === "user") {
      rows.push({
        type: "user",
        id: messageId(),
        seq: seq++,
        timeCreated: t(0),
        data: { time: { created: t(0) }, text: textOf(message.content), files: [] },
      });
      continue;
    }
    if (message.role === "assistant") {
      const parts: unknown[] = [];
      let hasTool = false;
      for (const call of message.tool_calls ?? []) {
        const output = toolResults.get(call.id);
        if (output === undefined) {
          throw new RestoreError(
            "seed.tool-result-missing",
            `no tool result row for call ${call.id}; the context is incomplete`,
          );
        }
        let parsedInput: unknown;
        try {
          parsedInput = JSON.parse(call.function.arguments);
        } catch (err) {
          throw new RestoreError(
            "seed.tool-input-corrupt",
            `call ${call.id} arguments are not JSON: ${String(err)}`,
          );
        }
        hasTool = true;
        parts.push({
          type: "tool",
          id: call.id,
          name: call.function.name,
          executed: false,
          state: {
            status: "completed",
            input: parsedInput,
            content: [{ type: "text", text: output }],
            metadata: { status: "completed", truncated: false, exit: 0 },
          },
          time: { created: t(150), ran: t(160), completed: t(200) },
        });
      }
      const text = message.content === null || message.content === undefined ? "" : textOf(message.content);
      if (text !== "" || parts.length === 0) {
        parts.push({ type: "text", text });
      }
      rows.push({
        type: "assistant",
        id: messageId(),
        seq: seq++,
        timeCreated: t(100),
        data: {
          time: { created: t(100), streamed: t(100), completed: t(200) },
          agent: "build",
          model: { id: input.modelId, providerID: "capture-mock" },
          content: parts,
          finish: hasTool ? "tool-calls" : "stop",
          rawFinish: hasTool ? "tool_calls" : "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
      continue;
    }
    throw new RestoreError("seed.unsupported-role", `prior context contains role ${message.role}`);
  }
  rows.push({
    type: "idle",
    id: messageId(),
    seq: seq++,
    timeCreated: t(300),
    data: { time: { created: t(300) }, outcome: "succeeded" },
  });
  return {
    sessionId: input.sessionId,
    projectId: input.projectId,
    directory: input.directory,
    version: input.opencodeVersion,
    title: input.title,
    timeCreated: input.baseTime,
    rows,
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (part !== null && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join("\n");
  }
  throw new RestoreError("seed.content-shape", "message content is neither string nor parts");
}

/** Render INSERT statements for sqlite3. Strings are SQL-escaped safely. */
export function renderSeedSql(plan: SeedPlan): string {
  const out: string[] = ["BEGIN;"];
  const q = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const n = (value: number): string => String(Math.min(Math.round(value), SQLITE_MAX));
  const lastSeq = plan.rows.length > 0 ? Math.max(...plan.rows.map((r) => r.seq)) : 0;

  // project row: id/worktree/vcs only; OpenCode fills the rest on demand.
  // OR IGNORE: OpenCode may have created the row itself during store
  // initialization; its derivation wins.
  out.push(
    `INSERT OR IGNORE INTO project (id, worktree, vcs, name, icon_url, icon_url_override, icon_color, time_created, time_updated, time_initialized, time_active, sandboxes, commands) VALUES (${q(plan.projectId)}, ${q(plan.directory)}, 'git', NULL, NULL, NULL, NULL, ${n(plan.timeCreated)}, ${n(plan.timeCreated)}, NULL, 0, '[]', NULL);`,
  );
  out.push(
    `INSERT INTO session_v2 (id, project_id, workspace_id, parent_id, fork_session_id, fork_boundary, slug, directory, path, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, metadata, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, revert, permission, agent, model, time_created, time_updated, time_idle, time_viewed, idle_outcome, time_compacting, time_archived, time_suspended, resume_attempts) VALUES (${q(plan.sessionId)}, ${q(plan.projectId)}, NULL, NULL, NULL, NULL, ${q(plan.title)}, ${q(plan.directory)}, NULL, ${q(plan.title)}, ${q(plan.version)}, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, ${n(plan.timeCreated)}, ${n(plan.timeCreated)}, ${n(plan.timeCreated)}, NULL, 'succeeded', NULL, NULL, NULL, 0);`,
  );
  for (const row of plan.rows) {
    out.push(
      `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (${q(row.id)}, ${q(plan.sessionId)}, ${q(row.type)}, ${n(row.seq)}, ${n(row.timeCreated)}, ${n(row.timeCreated)}, ${q(JSON.stringify(row.data))});`,
    );
  }
  // OpenCode allocates message seq values from this per-session counter;
  // without it, new messages collide with the seeded seq range.
  out.push(
    `INSERT OR REPLACE INTO event_sequence (aggregate_id, seq, owner_id) VALUES (${q(plan.sessionId)}, ${n(lastSeq)}, NULL);`,
  );
  out.push("COMMIT;");
  return `${out.join("\n")}\n`;
}