import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, chmodSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CaptureProxy } from "./proxy.js";
import { MockModelServer, defaultScript, type MockScript } from "./mock-model.js";
import { EventTrace } from "./trace.js";
import { writeCapturePlugin } from "./plugin.js";

const OPENCODE_BIN = resolve(
  join(process.env["HOME"] ?? "", ".opencode/bin/opencode"),
);

export interface E2EOptions {
  /** Test name; creates a unique run directory under work/e2e/. */
  readonly name: string;
  readonly failCapture?: boolean;
  readonly captureDelayMs?: number;
  readonly script?: MockScript;
  /**
   * Discovery probes: force OpenCode compaction with a tiny model context
   * limit, and force tool-output truncation with huge tool outputs.
   */
  readonly probe?: { readonly compaction?: boolean; readonly truncation?: boolean };
  /** Test hook: delay each artifact capture (R5 waiting evidence). */
  readonly artifactDelayMs?: number;
}

export interface E2EEnv {
  readonly workspace: string;
  readonly runDir: string;
  readonly proxy: CaptureProxy;
  readonly mock: MockModelServer;
  readonly trace: EventTrace;
  readonly traceFile: string;
  /** Run one opencode turn. `continueLast` chains to the previous session. */
  runPrompt(prompt: string, options?: { readonly continueLast?: boolean }): Promise<RunResult>;
  /**
   * Run one opencode turn and kill the process as soon as `stop` returns
   * true (polled every 500 ms), or after maxMs. Used to prove blocking
   * behavior without waiting for opencode's full retry backoff.
   */
  runPromptUntil(
    prompt: string,
    stop: () => boolean,
    options?: { readonly continueLast?: boolean; readonly maxMs?: number },
  ): Promise<RunResult>;
  cleanup(): Promise<void>;
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Build a fully isolated e2e environment: fixture workspace, isolated
 * OpenCode home (XDG), mock model, capture proxy, and an opencode.json
 * pointing at the proxy.
 */
export async function createE2E(options: E2EOptions): Promise<E2EEnv> {
  const repoRoot = resolve(join(import.meta.dirname, "..", ".."));
  const stamp = `${options.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const runDir = join(repoRoot, "work", "e2e", stamp);
  mkdirSync(runDir, { recursive: true });

  const workspace = join(runDir, "workspace");
  const home = join(runDir, "home");
  const captureStore = join(runDir, "capture-store");
  const traceFile = join(runDir, "trace.jsonl");
  for (const dir of [workspace, home, captureStore]) {
    mkdirSync(dir, { recursive: true });
  }

  // Fixture: tracked-equivalent file, a to-be-deleted file, executable, symlink.
  writeFileSync(join(workspace, "notes.md"), "# notes\nversion-1\n");
  writeFileSync(join(workspace, "obsolete.txt"), "obsolete content\n");
  writeFileSync(join(workspace, "run.sh"), "#!/bin/sh\necho ok\n");
  writeFileSync(
    join(workspace, "big-output.sh"),
    "#!/bin/sh\nhead -c 80000 /dev/zero | tr '\\0' 'y'\n",
  );
  chmodSync(join(workspace, "big-output.sh"), 0o755);
  chmodSync(join(workspace, "run.sh"), 0o755);
  symlinkSync("notes.md", join(workspace, "link-to-notes"));

  writeFileSync(join(workspace, ".gitignore"), ".env.local\n");
  // The declared workspace is a Git repository; project and plugin
  // discovery depend on it.
  execSync(`git init -q && git config user.email "harness@example.invalid" && git config user.name harness`, {
    cwd: workspace,
    env: { ...process.env, GIT_CONFIG_GLOBAL: join(runDir, "gitconfig"), GIT_CONFIG_SYSTEM: "/dev/null" },
    stdio: "ignore",
  });

  execSync("git add notes.md obsolete.txt run.sh link-to-notes .gitignore && git commit -qm fixture", {
    cwd: workspace,
    env: { ...process.env, GIT_CONFIG_GLOBAL: join(runDir, "gitconfig"), GIT_CONFIG_SYSTEM: "/dev/null" },
    stdio: "ignore",
  });

  const trace = new EventTrace(traceFile);
  const probeScript: MockScript | undefined =
    options.probe?.compaction === true || options.probe?.truncation === true
      ? ({ lastUserText, sawToolOutput }) => {
          if (options.probe?.truncation === true && lastUserText.includes("USE_TOOL_BIG")) {
            if (!sawToolOutput) {
              return {
                toolCalls: [
                  {
                    id: "call_big",
                    name: "shell",
                    args: { command: "./big-output.sh", description: "produce huge output" },
                  },
                ],
              };
            }
            return { content: "done big" };
          }
          if (options.probe?.compaction === true && lastUserText.includes("FILL")) {
            return { content: `filler.\n${"y".repeat(300000)}` };
          }
          if (lastUserText.startsWith("You MUST summarize")) {
            // OpenCode validates the compaction summary against its template;
            // return a minimal compliant summary.
            return {
              content: [
                "## Objective",
                "- Exercise the capture harness compaction probe.",
                "",
                "## Requirements",
                "- None beyond the probe.",
                "",
                "## Decisions",
                "- None.",
                "",
                "## Work State",
                "- Context was filled to trigger compaction; compaction ran.",
                "",
                "## Next Move",
                "- Continue the probe; exercise the shell tool.",
                "",
                "## Relevant Files",
                "- big-output.sh",
                "",
                "## Important Context",
                "- Mock model environment; no external services.",
                "- COMPACTION-SUMMARY-MARKER-424242",
              ].join("\n"),
            };
          }
          return undefined;
        }
      : undefined;
  const mock = new MockModelServer(
    options.script ??
      (probeScript !== undefined
        ? (input) => probeScript(input) ?? defaultScript(input)
        : undefined),
  );
  const mockURL = await mock.start();

  // Paths needed for runtime references; computed before the proxy so the
  // capture payload can embed them.
  const configPath = join(workspace, "opencode.json");
  const isoHome = join(home, "iso-home");
  mkdirSync(isoHome, { recursive: true });

  const proxy = new CaptureProxy({
    upstreamURL: `${mockURL}/v1`,
    mainModel: "mock-model",
    trace,
    workspaceRoot: workspace,
    captureStoreDir: captureStore,
    captureDelayMs: options.captureDelayMs ?? 0,
    // Shell tool truncation artifacts are written under the isolated
    // OpenCode data dir; allow them as capture roots.
    ...(options.probe?.truncation === true ? { artifactRoots: [join(home, "data")] } : {}),
    runtime: {
      opencodeVersion: "2.0.18",
      configPath,
      isolatedHome: isoHome,
      providerBaseURLIsConfiguredAfterStart: true,
    },
    ...(options.failCapture !== undefined ? { failCapture: options.failCapture } : {}),
    ...(options.artifactDelayMs !== undefined ? { artifactDelayMs: options.artifactDelayMs } : {}),
  });
  const proxyURL = await proxy.start();

  // Reusable capture plugin wiring (see src/capture/plugin.ts).
  const pluginPath = writeCapturePlugin(workspace, writeFileSync, mkdirSync);
  void pluginPath;

  // Isolated OpenCode config: only the mock provider, pointing at the
  // proxy. Stored inside the workspace as a project config so project
  // discovery resolves to the workspace, not the outer repository.
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        autoupdate: false,
        snapshot: false,
        share: "disabled",
        formatter: false,
        lsp: false,
        compaction: { auto: true, reserved: 60000 },
        model: "capture-mock/mock-model",
        small_model: "capture-mock/mock-small",
        provider: {
          "capture-mock": {
            npm: "@ai-sdk/openai-compatible",
            name: "CaptureMock",
            options: {
              baseURL: `${proxyURL}/v1`,
              // The key is supplied at runtime via env substitution; no
              // key material is written to the captured workspace.
              apiKey: "{env:CAPTURE_MOCK_API_KEY}",
            },
            models: {
              "mock-model": {
                name: "Mock Task Model",
                ...(options.probe?.compaction === true ? { limit: { context: 100000, output: 2000 } } : {}),
              },
              "mock-small": { name: "Mock Small Model" },
            },
          },
        },
      },
      null,
      2,
    ),
  );

  async function runPrompt(
    prompt: string,
    opts?: { readonly continueLast?: boolean },
  ): Promise<RunResult> {
    return await collect(spawnRun(prompt, opts), 180_000);
  }

  function spawnRun(
    prompt: string,
    opts?: { readonly continueLast?: boolean },
  ): ReturnType<typeof spawn> {
    const args = ["run", "--auto", "--standalone"];
    if (opts?.continueLast === true) {
      args.push("--continue");
    }
    args.push(prompt);
    return spawn(OPENCODE_BIN, args, {
      cwd: workspace,
      env: {
        ...process.env,
        // OpenCode resolves its project directory from $PWD, not
        // process.cwd(); npm/vitest export the repo root as PWD.
        PWD: workspace,
        HOME: isoHome,
        XDG_DATA_HOME: join(home, "data"),
        XDG_CONFIG_HOME: join(home, "cfg"),
        XDG_CACHE_HOME: join(home, "cache"),
        XDG_STATE_HOME: join(home, "state"),
        TMPDIR: join(runDir, "tmp"),
        OPENCODE_CONFIG: configPath,
        CAPTURE_SERVICE_URL: proxyURL,
        CAPTURE_MOCK_API_KEY: "e2e-runtime-only-key",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  async function runPromptUntil(
    prompt: string,
    stop: () => boolean,
    opts?: { readonly continueLast?: boolean; readonly maxMs?: number },
  ): Promise<RunResult> {
    const child = spawnRun(prompt, opts);
    const maxMs = opts?.maxMs ?? 120_000;
    await new Promise<void>((resolvePromise) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (stop() || Date.now() - started > maxMs) {
          clearInterval(poll);
          child.kill("SIGKILL");
          resolvePromise();
        }
      }, 500);
      child.on("exit", () => {
        clearInterval(poll);
        resolvePromise();
      });
    });
    return await collect(child, 10_000);
  }

  async function cleanup(): Promise<void> {
    await Promise.all([proxy.stop(), mock.stop()]);
  }

  return {
    workspace,
    runDir,
    proxy,
    mock,
    trace,
    traceFile,
    runPrompt,
    runPromptUntil,
    cleanup,
  };
}

function collect(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // The CLI may exit while its serve subprocess still holds the stdio
      // pipes; 'exit' fires reliably, 'close' may not. Kill leftovers.
      child.kill("SIGKILL");
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectPromise(err);
      }
    });
    child.on("exit", (code) => {
      finish({ code, stdout, stderr });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr });
    });
  });
}

/** Remove a completed run directory (call from tests that do not need evidence). */
export function removeRunDir(runDir: string): void {
  if (runDir.startsWith(join(tmpdir(), "")) || runDir.includes("work/e2e/")) {
    if (existsSync(runDir)) {
      rmSync(runDir, { recursive: true, force: true });
    }
  }
}