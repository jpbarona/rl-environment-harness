import { join } from "node:path";

/**
 * Reusable OpenCode capture plugin wiring.
 *
 * This is the production plugin source for the capture harness. The e2e
 * fixture writes it into a workspace's `.opencode/plugins/` directory; a
 * deployed harness writes it wherever capture is installed. One source of
 * truth for both paths.
 *
 * OpenCode v2.0.18 contract (verified):
 * - Plugins default-export `{ id, setup(ctx) }`.
 * - `ctx.session.hook("prompt", ...)` gates prompt admission (throwing
 *   blocks the prompt); `ctx.tool.hook("execute.before", ...)` gates tool
 *   execution; `ctx.session.hook("http.request", ...)` labels every
 *   outgoing provider request with authoritative purpose/session headers.
 * - `ctx.event.subscribe()` is the async-iterable event stream; event
 *   bodies live under `event.data`.
 */
export const CAPTURE_PLUGIN_SOURCE = `export default {
  id: "capture-plugin",
  async setup(ctx) {
    const url = process.env.CAPTURE_SERVICE_URL
    const send = async (type, data) => {
      const response = await fetch(url + "/events", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, data }), signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) throw new Error("capture event rejected: " + await response.text())
    }
    const identities = new Map()
    const referencedToolOutputFiles = []
    const artifactByCall = new Map()
    const collectTruncation = (messages) => {
      const unsupported = []
      const referenced = []
      for (const message of messages) {
        for (const part of message.content ?? []) {
          if (part.type !== "tool") continue
          const meta = part.state?.metadata ?? {}
          if (meta.truncated !== true) continue
          const output = typeof part.state?.output === "string" ? part.state.output : ""
          const rawContent = part.state?.content
          const contentText = typeof rawContent === "string"
            ? rawContent
            : Array.isArray(rawContent)
              ? rawContent.map(p => (p && typeof p === "object" && typeof p.text === "string") ? p.text : "").join("\\n")
              : ""
          const marker = /full output saved to ([^[\\]]+?)\\s*\\]?\\s*$/
          const match = marker.exec(output) ?? marker.exec(contentText)
          const known = part.id !== undefined ? artifactByCall.get(part.id) : undefined
          if (match !== null) {
            referenced.push(match[1].trim())
          } else if (known !== undefined) {
            referenced.push(known)
          } else if (typeof meta.truncatedOutputPath === "string" && meta.truncatedOutputPath.length > 0) {
            referenced.push(meta.truncatedOutputPath)
          } else {
            unsupported.push("truncated tool output has no verifiable artifact path")
          }
        }
      }
      return { unsupported, referenced }
    }
    await ctx.session.hook("prompt", async event => {
      const sessionID = event.sessionID
      const messageID = event.messageID
      const session = await ctx.session.get({ sessionID })
      const messages = await ctx.session.context({ sessionID })
      const compaction = messages.filter(message => message.type === "compaction")
      const truncation = collectTruncation(messages)
      identities.set(sessionID, messageID)
      await send("user.message", { sessionID, messageID, text: event.prompt.text,
        requiredState: {
          priorSessionState: { session, messages },
          compaction,
          unsupported: truncation.unsupported,
          referencedToolOutputFiles: [...new Set([...truncation.referenced, ...referencedToolOutputFiles])],
        },
      })
      const response = await fetch(url + "/capture-gate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionID, messageID }), signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) throw new Error("capture admission gate rejected: " + await response.text())
    })
    await ctx.tool.hook("execute.before", async event => {
      const sessionID = event.sessionID
      const messageID = identities.get(sessionID)
      const response = await fetch(url + "/tool-gate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionID, messageID }), signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) throw new Error("capture tool gate rejected: " + await response.text())
      send("tool.start", { sessionID, messageID })
    })
    await ctx.session.hook("http.request", event => {
      event.request.headers.set("x-capture-purpose", event.kind)
      event.request.headers.set("x-capture-session", event.sessionID)
    })
    const sampled = new Set()
    const pick = (v, keys) => {
      const out = {}
      for (const k of keys) {
        if (v && typeof v === "object" && v[k] !== undefined) out[k] = v[k]
      }
      return out
    }
    ;(async () => {
      for await (const event of ctx.event.subscribe()) {
        const type = String(event?.type ?? "")
        if (type === "session.created") {
          send("session.created", pick(event.data, ["sessionID", "parentID"]))
        } else if (type === "session.inbox.enqueued") {
          const d = event.data ?? {}
          const item = d.item ?? {}
          if (item.type === "user") {
            identities.set(d.sessionID, d.inboxID)
            const session = await ctx.session.get({ sessionID: d.sessionID })
            const messages = await ctx.session.context({ sessionID: d.sessionID })
            const truncation = collectTruncation(messages)
            await send("user.message", {
              sessionID: d.sessionID, messageID: d.inboxID, text: item.payload?.text,
              requiredState: {
                priorSessionState: { session, messages },
                compaction: messages.filter(message => message.type === "compaction"),
                unsupported: truncation.unsupported,
                referencedToolOutputFiles: [...new Set([...truncation.referenced, ...referencedToolOutputFiles])],
              },
            })
          }
        } else if (type === "session.execution.started") {
          send("execution.started", {
            ...pick(event.data, ["sessionID", "messageID", "id"]),
          })
        } else if (type.startsWith("session.execution.")) {
          send("execution.ended", { kind: type, ...pick(event.data, ["sessionID"]) })
        } else if (type === "session.tool.success") {
          // Truncation artifacts: OpenCode truncates long tool output and
          // writes the full output to a file, marking the inline tail with
          // "full output saved to <path>". Collect those paths; the proxy
          // captures the files into the checkpoint.
          const d = event.data ?? {}
          const texts = (Array.isArray(d.content) ? d.content : [])
            .map(p => (p && typeof p === "object" && typeof p.text === "string") ? p.text : "")
            .join("\\n")
          const match = /full output saved to ([^[\\]]+?)\\s*\\]?\\s*$/.exec(texts)
          if (match !== null) {
            const artifactPath = match[1].trim()
            if (!referencedToolOutputFiles.includes(artifactPath)) {
              referencedToolOutputFiles.push(artifactPath)
              if (typeof d.id === "string") {
                artifactByCall.set(d.id, artifactPath)
              }
              send("tool.output.artifact", { sessionID: d.sessionID, messageID: identities.get(d.sessionID) ?? null, path: artifactPath })
            }
          }
        } else if (type === "message.updated") {
          const d = event.data ?? {}
          const info = d.info ?? {}
          send("message.updated", {
            sessionID: info.sessionID ?? d.sessionID,
            id: info.id ?? d.id ?? d.messageID,
            role: info.role ?? d.role,
          })
        }
        if (!sampled.has(type) && !["session.created", "session.execution.started", "session.inbox.enqueued", "message.updated"].includes(type)) {
          sampled.add(type)
          send("event.sample." + type, { json: JSON.stringify(event).slice(0, 1200) })
        }
      }
    })().catch(() => {})
    return () => {}
  },
}
`;

/**
 * Write the capture plugin into a workspace's project plugin directory so
 * OpenCode loads it for that project.
 */
export function writeCapturePlugin(
  workspaceDir: string,
  writeFile: (path: string, content: string) => void,
  mkdir: (path: string, options?: { recursive?: boolean }) => void,
): string {
  const pluginDir = join(workspaceDir, ".opencode", "plugins");
  mkdir(pluginDir, { recursive: true });
  const pluginPath = join(pluginDir, "capture-plugin.ts");
  writeFile(pluginPath, CAPTURE_PLUGIN_SOURCE);
  return pluginPath;
}
