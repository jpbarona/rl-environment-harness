import { describe, it, expect } from "vitest";
import { planSeed, renderSeedSql, type SeedInput } from "../../src/restore/context-seed.js";
import { compareRequests, selectedPrompt } from "../../src/restore/request-compare.js";
import { RestoreError } from "../../src/restore/select.js";

function seedInput(overrides: Partial<SeedInput> = {}): SeedInput {
  return {
    priorMessages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: '"FIXTURE_FIRST change the starting files"' },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: '{"command":"printf hi"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "(no output)" },
      { role: "assistant", content: "done" },
    ],
    sessionId: "ses_test",
    projectId: "proj123",
    directory: "/work/workspace",
    opencodeVersion: "2.0.18",
    title: "restore",
    modelId: "mock-model",
    baseTime: 1791583157723,
    ...overrides,
  };
}

describe("S3-R4 context seeding", () => {
  it("maps provider messages into session rows, skipping system and folding tool results", () => {
    const plan = planSeed(seedInput());
    expect(plan.rows.map((r) => r.type)).toEqual(["user", "assistant", "assistant", "idle"]);
    const toolRow = plan.rows[1]!.data as { content: Array<Record<string, unknown>> };
    const toolPart = toolRow.content[0] as {
      type: string;
      id: string;
      name: string;
      state: { status: string; input: unknown; content: Array<{ text: string }> };
    };
    expect(toolPart.type).toBe("tool");
    expect(toolPart.id).toBe("call_1");
    expect(toolPart.name).toBe("shell");
    expect(toolPart.state.input).toEqual({ command: "printf hi" });
    expect(toolPart.state.content[0]?.text).toBe("(no output)");
    const textRow = plan.rows[2]!.data as { content: Array<Record<string, unknown>> };
    expect(textRow.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("fails on a missing tool result or corrupt tool arguments", () => {
    const withoutResult = seedInput({ priorMessages: seedInput().priorMessages.filter((m) => m.role !== "tool") });
    expect(() => planSeed(withoutResult)).toThrow(/tool-result-missing/);
    const corrupt = seedInput({
      priorMessages: [
        { role: "user", content: "u" },
        { role: "assistant", content: null, tool_calls: [{ id: "c", function: { name: "shell", arguments: "not-json" } }] },
        { role: "tool", tool_call_id: "c", content: "x" },
      ],
    });
    expect(() => planSeed(corrupt)).toThrow(/tool-input-corrupt/);
  });

  it("renders SQL with safe quoting and transaction bounds", () => {
    const plan = planSeed(seedInput({ priorMessages: [{ role: "user", content: "it's got 'quotes'" }] }));
    const sql = renderSeedSql(plan);
    expect(sql.startsWith("BEGIN;")).toBe(true);
    expect(sql.endsWith("COMMIT;\n")).toBe(true);
    // Single quotes double inside SQL string literals.
    expect(sql.includes("it''s got ''quotes''")).toBe(true);
    expect(sql).toContain("'ses_test'");
    expect(sql).toContain("INSERT OR IGNORE INTO project");
  });
});

describe("S3-R4 request comparison", () => {
  const capturedRoot = "/Users/me/work/e2e/run-1/workspace";
  const restoreRoot = "/work/workspace";

  function baseSystem(): string {
    return [
      "You are an AI agent running in OpenCode.",
      "  Working directory: /Users/me/work/e2e/run-1/workspace",
      "  Workspace root folder: /Users/me/work/e2e/run-1/workspace",
      "  Platform: darwin",
      "  Today's date: Fri Oct 09 2026",
    ].join("\n");
  }

  function bodies(): [Record<string, unknown>, Record<string, unknown>] {
    const system = baseSystem();
    return [
      {
        model: "mock-model",
        stream: true,
        tools: [{ function: { name: "shell" } }],
        messages: [
          { role: "system", content: system },
          { role: "user", content: '"FIXTURE_FIRST change the starting files"' },
          { role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "shell", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_1", content: "(no output)" },
          { role: "assistant", content: "done" },
        ],
      },
      {
        model: "mock-model",
        stream: true,
        tools: [{ function: { name: "shell" } }],
        messages: [
          {
            role: "system",
            content: [
              "You are an AI agent running in OpenCode.",
              `  Working directory: ${restoreRoot}`,
              `  Workspace root folder: ${restoreRoot}`,
              "  Platform: linux",
              "  Today's date: Sat Oct 10 2026",
            ].join("\n"),
          },
          { role: "user", content: '"FIXTURE_FIRST change the starting files"' },
          { role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "shell", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_1", content: "(no output)" },
          { role: "assistant", content: "done" },
        ],
      },
    ];
  }

  it("passes when only declared volatile fields differ", () => {
    const [original, regenerated] = bodies();
    const comparison = compareRequests({
      original: { body: original },
      regenerated: { body: regenerated },
      capturedWorkspaceRoot: capturedRoot,
      restoreWorkspacePath: restoreRoot,
    });
    expect(comparison.ok).toBe(true);
    const fields = comparison.declaredVolatile.map((v) => v.field);
    expect(fields).toContain("system.paths");
    expect(fields).toContain("system.platform");
    expect(fields).toContain("system.date");
  });

  it("detects changed instructions, missing prior content, schema/settings changes", () => {
    const [original, regenerated] = bodies();
    // Changed instruction text.
    const changed = structuredClone(regenerated);
    (changed["messages"] as Array<{ content: string }>)[0]!.content =
      (changed["messages"] as Array<{ content: string }>)[0]!.content.replace("OpenCode", "OtherHarness");
    expect(
      compareRequests({ original: { body: original }, regenerated: { body: changed }, capturedWorkspaceRoot: capturedRoot, restoreWorkspacePath: restoreRoot }).ok,
    ).toBe(false);

    // Missing prior tool turn.
    const missing = structuredClone(regenerated);
    (missing["messages"] as unknown[]).splice(3, 1);
    const missingComparison = compareRequests({ original: { body: original }, regenerated: { body: missing }, capturedWorkspaceRoot: capturedRoot, restoreWorkspacePath: restoreRoot });
    expect(missingComparison.ok).toBe(false);
    expect(missingComparison.differences.some((d) => d.field === "messages.length")).toBe(true);

    // Changed tool schema.
    const schema = structuredClone(regenerated);
    schema["tools"] = [{ function: { name: "other" } }];
    expect(
      compareRequests({ original: { body: original }, regenerated: { body: schema }, capturedWorkspaceRoot: capturedRoot, restoreWorkspacePath: restoreRoot }).ok,
    ).toBe(false);

    // Changed settings.
    const settings = structuredClone(regenerated);
    settings["stream"] = false;
    expect(
      compareRequests({ original: { body: original }, regenerated: { body: settings }, capturedWorkspaceRoot: capturedRoot, restoreWorkspacePath: restoreRoot }).ok,
    ).toBe(false);

    // Changed model.
    const model = structuredClone(regenerated);
    model["model"] = "other-model";
    const modelComparison = compareRequests({ original: { body: original }, regenerated: { body: model }, capturedWorkspaceRoot: capturedRoot, restoreWorkspacePath: restoreRoot });
    expect(modelComparison.ok).toBe(false);
    expect(modelComparison.differences.some((d) => d.field === "model")).toBe(true);
  });

  it("fails on an undeclared path difference outside the mapping", () => {
    const [original, regenerated] = bodies();
    const undeclared = structuredClone(regenerated);
    (undeclared["messages"] as Array<{ content: string }>)[1]!.content =
      '"note about /Users/me/other/path"';
    const comparison = compareRequests({
      original: { body: original },
      regenerated: { body: undeclared },
      capturedWorkspaceRoot: capturedRoot,
      restoreWorkspacePath: restoreRoot,
    });
    expect(comparison.ok).toBe(false);
    expect(comparison.differences.some((d) => d.field.startsWith("messages[1]"))).toBe(true);
  });

  it("extracts the selected prompt from the primary request", () => {
    const [original] = bodies();
    (original["messages"] as unknown[]).push({ role: "user", content: '"FIXTURE_SECOND the selected request"' });
    // OpenCode stores the prompt as JSON.stringify(argv); the selection
    // returns the original argv text.
    expect(selectedPrompt(original)).toBe("FIXTURE_SECOND the selected request");
    expect(() => selectedPrompt({ messages: [] })).toThrow(RestoreError);
  });
});