import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CAPTURE_PLUGIN_SOURCE } from "../src/capture/plugin.js";

describe("capture plugin source", () => {
  it("is a loadable ES module with a default export", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plugin-src-"));
    const file = join(dir, "capture-plugin.mjs");
    writeFileSync(file, CAPTURE_PLUGIN_SOURCE);
    const mod = await import(pathToFileURL(file).href);
    expect(typeof (mod.default as { id?: string }).id).toBe("string");
    expect(typeof (mod.default as { setup?: unknown }).setup).toBe("function");
  });
});
