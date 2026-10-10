#!/usr/bin/env node
/**
 * S4 command: portable task package export.
 *
 * `npm run package -- --store <path> --checkpoint <id> --output <export-root>
 *  [--verifier <script>]`
 *
 * Exports one checkpoint into <export-root>/<task-id>/ using the staging +
 * atomic-rename pipeline in export.ts, validates the package, and prints a
 * fixed status line. Zero on PASS only; every failure path writes the
 * machine-readable result.json at the export root and exits nonzero.
 * The source capture store is only read.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exportPackage, type ExportCheck } from "./export.js";
import { validatePackage } from "./validate.js";
import { fileURLToPath } from "node:url";

interface Args {
  readonly store: string;
  readonly checkpoint: string;
  readonly output: string;
  readonly verifier?: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const store = get("--store");
  const checkpoint = get("--checkpoint");
  const output = get("--output");
  if (store === undefined || checkpoint === undefined || output === undefined) {
    console.error("usage: npm run package -- --store <path> --checkpoint <id> --output <export-root> [--verifier <script>]");
    process.exit(2);
  }
  return {
    store: resolve(store),
    checkpoint,
    output: resolve(output),
    verifier: get("--verifier"),
  };
}

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const args = parseArgs(process.argv.slice(2));

function writeResult(
  status: "PASS" | "FAIL",
  checks: readonly ExportCheck[],
  extra: Record<string, unknown>,
): void {
  try {
    mkdirSync(args.output, { recursive: true });
    writeFileSync(
      join(args.output, "result.json"),
      `${JSON.stringify({
        status,
        taskId: `task-${args.checkpoint}`,
        checkpoint: args.checkpoint,
        startedAt: new Date().toISOString(),
        checks,
        ...extra,
      }, null, 2)}\n`,
    );
  } catch (error) {
    console.error(`Cannot save export evidence: ${String(error)}`);
  }
}

function main(): void {
  if (args.verifier !== undefined && !existsSync(args.verifier)) {
    writeResult("FAIL", [{ check: "package.verifier-missing", ok: false, detail: `FAILED — verifier script does not exist: ${args.verifier}` }], {});
    console.error(`PACKAGE FAIL: failed check=package.verifier-missing — ${args.verifier}`);
    console.error(`Report: ${join(args.output, "result.json")}`);
    process.exit(1);
  }
  if (!existsSync(args.store)) {
    writeResult("FAIL", [{ check: "selection.store-missing", ok: false, detail: `FAILED — capture store does not exist: ${args.store}` }], {});
    console.error(`PACKAGE FAIL: failed check=selection.store-missing — ${args.store}`);
    console.error(`Report: ${join(args.output, "result.json")}`);
    process.exit(1);
  }

  const outcome = exportPackage({
    storeRoot: args.store,
    checkpointId: args.checkpoint,
    outputDir: args.output,
    ...(args.verifier !== undefined ? { verifierScript: resolve(args.verifier) } : {}),
    repoRoot,
  });

  if (outcome.status !== "PASS") {
    writeResult("FAIL", outcome.checks, {
      ...(outcome.stagingDir !== "" ? { staging: outcome.stagingDir } : {}),
    });
    const failed = outcome.checks.filter((c) => !c.ok).map((c) => c.check).join(", ");
    console.error(`PACKAGE FAIL: task=${outcome.taskId} failed check=${failed}`);
    if (outcome.stagingDir !== "") {
      console.error(`Staging retained (diagnostic evidence): ${outcome.stagingDir}`);
    }
    console.error(`Report: ${join(args.output, "result.json")}`);
    process.exit(1);
  }

  // The published package is validated one more time from its final
  // location, so the success status reflects the published bytes.
  const published = validatePackage(outcome.packageDir!);
  if (!published.ok) {
    writeResult("FAIL", [
      ...outcome.checks,
      { check: "package.published", ok: false, detail: `FAILED — published package failed re-validation: ${published.checks.filter((c) => !c.ok).map((c) => c.check).join(", ")}` },
    ], { package: outcome.packageDir });
    console.error(`PACKAGE FAIL: task=${outcome.taskId} failed check=package.published (post-rename re-validation)`);
    console.error(`Report: ${join(args.output, "result.json")}`);
    process.exit(1);
  }

  writeResult("PASS", outcome.checks, { package: outcome.packageDir });
  console.log(`PACKAGE PASS: task=${outcome.taskId} package=${outcome.packageDir}`);
  console.log(`Report: ${join(args.output, "result.json")}`);
  process.exit(0);
}

try {
  main();
} catch (err) {
  writeResult("FAIL", [{ check: "package.unexpected", ok: false, detail: `FAILED — ${String(err instanceof Error ? (err.stack ?? err.message) : err)}` }], {});
  console.error(`PACKAGE FAIL: failed check=package.unexpected`);
  console.error(`Report: ${join(args.output, "result.json")}`);
  process.exit(1);
}
