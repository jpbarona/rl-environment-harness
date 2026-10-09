import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** One ordered event in the machine-readable capture trace. */
export interface TraceEvent {
  readonly seq: number;
  /** ISO-8601 UTC timestamp. */
  readonly ts: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/** Header allowlist: the only headers ever persisted from a model request. */
const HEADER_ALLOWLIST = new Set([
  "content-type",
  "content-length",
  "accept",
  "user-agent",
]);

/**
 * Ordered event trace. Append-only; sync writes keep on-disk order equal to
 * in-memory order. Used both for live assertions and as the persisted
 * machine-readable event trace under work/.
 */
export class EventTrace {
  readonly events: TraceEvent[] = [];
  #seq = 0;
  readonly #filePath: string | null;

  constructor(filePath?: string) {
    this.#filePath = filePath ?? null;
    if (filePath !== undefined) {
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, "");
    }
  }

  append(type: string, data: Record<string, unknown> = {}): TraceEvent {
    this.#seq += 1;
    const event: TraceEvent = {
      seq: this.#seq,
      ts: new Date().toISOString(),
      type,
      data,
    };
    this.events.push(event);
    if (this.#filePath !== null) {
      appendFileSync(this.#filePath, `${JSON.stringify(event)}\n`);
    }
    return event;
  }

  filter(type: string): TraceEvent[] {
    return this.events.filter((event) => event.type === type);
  }

  /** Reduce recorded headers to the allowlist. Drops all credentials. */
  static redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (!HEADER_ALLOWLIST.has(lower)) {
        continue;
      }
      const first = Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
      out[lower] = first;
    }
    return out;
  }
}

/** Flatten an OpenAI-compatible message content field to text. */
export function messageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (
          part !== null &&
          typeof part === "object" &&
          "text" in part &&
          typeof (part as { text: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}