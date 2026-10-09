import { it, expect } from "vitest";
import http from "node:http";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createE2E } from "../../src/capture/e2e.js";

// Explicit opt-in only. This file is excluded from ordinary verification.
it("real OpenRouter model: three turns, tools, persisted inputs and file snapshots", async () => {
  const key = process.env["OPENROUTER_API_KEY"];
  if (!key) throw new Error("Set OPENROUTER_API_KEY for this optional test; never put it in a source file.");
  const keyInfo = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000),
  });
  if (!keyInfo.ok) throw new Error(`Test key validation failed: ${keyInfo.status}`);
  const keyData = await keyInfo.json() as { data: { limit: number | null } };
  if (typeof keyData.data.limit !== "number" || keyData.data.limit < 0 || keyData.data.limit > 0.1) {
    throw new Error("Use a dedicated test key with an OpenRouter spending limit of $0.10 or less.");
  }
  const catalog = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(20_000) });
  if (!catalog.ok) throw new Error(`Model catalog unavailable: ${catalog.status}`);
  const { data } = await catalog.json() as { data: Array<{
    id: string; supported_parameters?: string[]; pricing: Record<string, string>;
  }> };
  // Refuse all non-zero pricing, including auxiliary charges. No paid fallback.
  const eligible = data.filter(m => m.id.endsWith(":free") && m.supported_parameters?.includes("tools") &&
    Object.keys(m.pricing).length > 0 && Object.values(m.pricing).every(v => Number(v) === 0));
  const preferred = process.env["LIVE_MODEL"];
  const model = preferred ? eligible.find(m => m.id === preferred) :
    eligible.find(m => /qwen.*coder/i.test(m.id)) ?? eligible.find(m => /nemotron.*nano/i.test(m.id)) ?? eligible[0];
  if (!model) throw new Error("No eligible zero-cost tool model. Paid fallback is forbidden.");

  let requests = 0;
  // Budget boundary: one validated free model, no model fallback, bounded requests/output.
  const gateway = http.createServer((req, res) => { void (async () => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end(); return;
      }
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (body["model"] !== model.id || ++requests > 18) {
        res.writeHead(403).end("Live test request limit or model restriction"); return;
      }
      delete body["models"]; delete body["route"]; delete body["max_completion_tokens"];
      body["max_tokens"] = 1024;
      body["provider"] = { require_parameters: true };
      const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(45_000),
      });
      res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
      if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
      res.end();
    } catch { if (!res.headersSent) res.writeHead(502); res.end("Live provider transport failed"); }
  })(); });
  await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  if (!address || typeof address === "string") throw new Error("Gateway did not bind");
  const env = await createE2E({ name: "live-free", live: {
    upstreamURL: `http://127.0.0.1:${address.port}/v1`, model: model.id, apiKey: "local-test-placeholder",
  } }).catch(async (error: unknown) => {
    gateway.closeAllConnections();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    throw error;
  });
  try {
    for (let turn = 1; turn <= 3; turn++) {
      const before = turn === 1 ? "# notes\nversion-1\n" : `live-turn-${turn - 1}\n`;
      const after = `live-turn-${turn}\n`;
      const result = await env.runPrompt(
        `Use the shell tool. Read notes.md. Replace its contents with exactly live-turn-${turn} followed by a newline. ` +
        `Then use the shell tool to check its contents. Do not edit other files. Reply briefly.`,
        { continueLast: turn > 1 },
      );
      expect(result.code, `OpenCode failed; evidence: ${env.runDir}`).toBe(0);
      expect(readFileSync(join(env.workspace, "notes.md"), "utf8")).toBe(after);
      const record = [...env.proxy.turns.values()][turn - 1];
      expect(record?.captureState).toBe("committed");
      expect(record?.sessionId).toBeTruthy(); expect(record?.messageId).toBeTruthy();
      const checkpoint = join(env.runDir, "capture-store", "checkpoints", record?.checkpointId ?? "missing");
      const manifest = JSON.parse(readFileSync(join(checkpoint, "manifest.json"), "utf8")) as {
        files: Array<{ path: string; sha256?: string }>;
      };
      const file = manifest.files.find(f => f.path === "notes.md");
      expect(readFileSync(join(env.runDir, "capture-store", "objects", file?.sha256 ?? "missing"), "utf8")).toBe(before);
      const inputs = readFileSync(join(checkpoint, "model_requests.jsonl"), "utf8");
      expect(inputs).toContain("notes.md");
      expect(env.trace.filter("tool.gate.allowed").some(e => e.data["turnId"] === record?.id)).toBe(true);
    }
    expect(new Set([...env.proxy.turns.values()].map(t => t.sessionId)).size).toBe(1);
    // Scan captured metadata/objects; the real credential must never enter capture storage.
    const store = join(env.runDir, "capture-store");
    for (const entry of readdirSync(store, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) expect(readFileSync(join(entry.parentPath, entry.name)).includes(Buffer.from(key))).toBe(false);
    }
    writeFileSync(join(env.runDir, "live-result.json"), JSON.stringify({
      status: "PASS", model: model.id, turns: 3, requests, modelSpendUSD: 0,
      budgetUSD: 0.01, evidence: env.runDir,
    }, null, 2));
    console.log(`PASS: live capture; model=${model.id}; spend=$0; evidence=${env.runDir}`);
  } finally {
    await env.cleanup();
    gateway.closeAllConnections();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
  }
}, 600_000);
