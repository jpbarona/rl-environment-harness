/**
 * Harbor task builder (S5-R4, S5-R5).
 *
 * Deterministic code assembles the native Harbor task from the frozen
 * capture and the writer output. It reuses Step 4's exporter (capture
 * records, evidence split, object inventory) and Step 3's materializer for
 * the baked starting workspace. The writer authors only the instruction,
 * task description, criteria, and solution script; every structural file
 * (task.toml, Dockerfiles, test.sh, reward.toml) comes from these
 * templates so the pinned interfaces cannot drift.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportPackage } from "../package/export.js";
import { readManifest, selectCheckpoint } from "../restore/select.js";
import { materializeWorkspace } from "../restore/materialize.js";
import { selectedTurnInput } from "../restore/request-compare.js";
import type { SystemConfig } from "./config.js";
import type { WriterOutput } from "./writer.js";
import { readJsonl } from "./jsonl.js";
import { describeWorkspace } from "./workspace-inventory.js";

export interface BuiltTask {
  readonly taskDir: string;
  readonly selected: {
    readonly checkpointId: string;
    readonly sessionId: string;
    readonly messageId: string;
    readonly prompt: string;
    readonly model: string;
    readonly opencodeVersion: string;
  };
  readonly mutations: readonly string[];
}

interface RequestRecord {
  readonly index: number;
  readonly classification: string;
  readonly body: { readonly messages?: Array<{ role: string; content?: unknown }> };
}

/**
 * Export the frozen capture ONCE per job (writer-retry fix): the Step 4
 * package is produced and package-validated a single time and every writer
 * attempt reuses it. The exporter publishes exactly one package per export
 * root, so re-exporting per attempt would collide with
 * package.target-exists on the first retry. The source store is only ever
 * READ; the selected checkpoint and the store are never modified.
 */
export function exportFrozenCapture(options: {
  readonly config: SystemConfig;
  readonly jobDir: string;
  readonly checkpointId: string;
  readonly repoRoot: string;
}): string {
  const exported = exportPackage({
    storeRoot: options.config.storePath,
    checkpointId: options.checkpointId,
    outputDir: join(options.jobDir, "export"),
    repoRoot: options.repoRoot,
  });
  if (exported.status !== "PASS" || exported.packageDir === undefined) {
    throw new Error(`Step 4 export failed: ${exported.checks.filter((c) => !c.ok).map((c) => c.check).join(", ")}`);
  }
  return exported.packageDir;
}

/**
 * Recorded runtime rebinds applied to a materialized replay workspace.
 * Shared by the writer context and the task builder so the workspace the
 * writer sees is EXACTLY the workspace the solver starts from. Mutations
 * are returned for the build report and the writer prompt.
 */
export function applyReplayTransformations(appDir: string): string[] {
  const mutations: string[] = [];
  const workspaceConfigPath = join(appDir, "opencode.json");
  if (existsSync(workspaceConfigPath)) {
    const workspaceConfig = JSON.parse(readFileSync(workspaceConfigPath, "utf8")) as Record<string, unknown>;
    if ("provider" in workspaceConfig || "model" in workspaceConfig) {
      delete workspaceConfig["provider"];
      delete workspaceConfig["model"];
      writeFileSync(workspaceConfigPath, `${JSON.stringify(workspaceConfig, null, 2)}\n`);
      mutations.push("removed provider/model from workspace opencode.json (runtime selects the solver endpoint)");
    }
  }
  const pluginPath = join(appDir, ".opencode", "plugins", "capture-plugin.ts");
  if (existsSync(pluginPath)) {
    rmSync(pluginPath);
    mutations.push("removed the capture plugin from the baked workspace (no recorder proxy in the solver)");
  }
  return mutations;
}

/** Build the Harbor task draft under <jobDir>/task. */
export function buildHarborTask(options: {
  readonly config: SystemConfig;
  readonly jobDir: string;
  readonly checkpointId: string;
  /** The verified Step 4 export produced once per job by exportFrozenCapture. */
  readonly exportedPackageDir: string;
  readonly writer: WriterOutput;
  readonly repoRoot: string;
}): BuiltTask {
  const { config, jobDir, checkpointId, writer, repoRoot } = options;
  const taskDir = join(jobDir, "task");
  rmSync(taskDir, { recursive: true, force: true });
  mkdirSync(taskDir, { recursive: true });
  // The writer's task instruction for the Harbor task (distinct from the
  // replayed captured request, which the agent submits from selected.json).
  writeFileSync(join(taskDir, "instruction.md"), writer.instructionMd);

  // Selection + preflight from the frozen store (Step 3 validation).
  selectCheckpoint({ storeRoot: config.storePath, checkpointId });
  const manifest = readManifest(config.storePath, checkpointId);
  const recordsDir = join(config.storePath, "checkpoints", checkpointId);
  const requests = readJsonl<RequestRecord>(join(recordsDir, "model_requests.jsonl"));
  const primary = requests.find((r) => r.classification === "task-new-turn" || r.classification === "task-continuation");
  if (primary === undefined) {
    throw new Error("the frozen checkpoint holds no primary task request");
  }
  const runtime = JSON.parse(readFileSync(join(recordsDir, "runtime.json"), "utf8")) as {
    sessionId: string;
    messageId: string;
    opencodeVersion: string;
  };
  const prompt = selectedTurnInput(primary.body).prompt;

  // The verified Step 4 export was produced ONCE per job by
  // exportFrozenCapture and is consumed here per attempt; re-exporting per
  // attempt would collide with the exporter's one-package-per-root rule.
  const exportedPackageDir = options.exportedPackageDir;

  const mutations: string[] = [];

  // --- environment/: solver image context. ---
  const environmentDir = join(taskDir, "environment");
  mkdirSync(environmentDir, { recursive: true });

  // Baked starting workspace, materialized from the frozen objects.
  const appDir = join(environmentDir, "app");
  materializeWorkspace(config.storePath, manifest, appDir);
  // Runtime rebinds required for a live solver run (recorded, not silent):
  // the same shared transformation the writer context saw (no drift).
  mutations.push(...applyReplayTransformations(appDir));

  // Frozen capture records for in-container seeding + evidence.
  cpSync(join(exportedPackageDir, "capture"), join(environmentDir, "capture"), { recursive: true });
  writeFileSync(join(environmentDir, "capture", "selected.json"), `${JSON.stringify({
    checkpointId,
    sessionId: runtime.sessionId,
    messageId: runtime.messageId,
    prompt,
    model: primaryBodyModel(primary),
    opencodeVersion: runtime.opencodeVersion,
  }, null, 2)}\n`);
  // Compiled harness for the in-container seeder (Step 3 logic verbatim).
  cpSync(join(repoRoot, "dist"), join(environmentDir, "harness", "dist"), { recursive: true });

  writeFileSync(join(environmentDir, "Dockerfile"), solverDockerfile());
  // The reference solution lives in the task's Harbor-standard solution/
  // directory, NOT inside the solver image: the replaying agent must never
  // be able to read it. Fixture validation mounts it at run time.
  const solutionDir = join(taskDir, "solution");
  mkdirSync(solutionDir, { recursive: true });
  writeFileSync(join(solutionDir, "solve.sh"), writer.solveSh);
  chmodSync(join(solutionDir, "solve.sh"), 0o755);
  for (const [index, example] of (writer.invalidExamples ?? []).entries()) {
    writeFileSync(join(solutionDir, `invalid-${index}.sh`), example.script);
  }

  // --- tests/: verifier image context. ---
  const testsDir = join(taskDir, "tests");
  mkdirSync(testsDir, { recursive: true });
  writeFileSync(join(testsDir, "test.sh"), verifierTestSh());
  chmodSync(join(testsDir, "test.sh"), 0o755);
  writeFileSync(join(testsDir, "checks.py"), writer.checksPy);
  const baseline = Object.fromEntries(describeWorkspace(appDir).map((entry) => [entry.path, entry]));
  writeFileSync(join(testsDir, "workspace_baseline.py"), `import json\nBASELINE = json.loads(${JSON.stringify(JSON.stringify(baseline))})\n`);
  writeFileSync(join(testsDir, "finalize_reward.py"), rewardFinalizerSource());
  writeFileSync(join(testsDir, "criteria_smoke.py"), criteriaSmokeSource());
  if (writer.judgeToml !== null) {
    const substituted = writer.judgeToml.replaceAll("JUDGE_MODEL_PLACEHOLDER", config.judgeModel);
    writeFileSync(join(testsDir, "judge.toml"), substituted);
    mutations.push("substituted the configured judge model into judge.toml");
  }
  // RewardKit names a root judge TOML's dimension after its filename stem.
  const components = writer.judgeToml !== null ? "checks = 1.0, judge = 1.0" : "checks = 1.0";
  writeFileSync(join(testsDir, "reward.toml"), `[scoring.checks]\naggregation = "all-pass"\n\n[[reward]]\nname = "reward"\naggregation = "weighted-mean"\nweights = { ${components} }\n`);
  writeFileSync(join(testsDir, "Dockerfile"), verifierDockerfile());

  // --- task.toml (upstream Harbor schema v1.3). ---
  writeFileSync(join(taskDir, "task.toml"), taskToml(writer, config));

  // --- evidence/: the original attempt suffix, outside replay context. ---
  cpSync(join(exportedPackageDir, "evidence"), join(taskDir, "evidence"), { recursive: true });

  // --- capture/ at the task root: frozen capture provenance. ---
  cpSync(join(exportedPackageDir, "capture"), join(taskDir, "capture"), { recursive: true });

  writeFileSync(join(taskDir, "build-report.json"), `${JSON.stringify({
    builtAt: new Date().toISOString(),
    checkpointId,
    sessionId: runtime.sessionId,
    messageId: runtime.messageId,
    selectedPrompt: prompt,
    capturedModel: primaryBodyModel(primary),
    opencodeVersion: runtime.opencodeVersion,
    mutations,
    manifestFiles: manifest.files.length,
  }, null, 2)}\n`);

  return {
    taskDir,
    selected: {
      checkpointId,
      sessionId: runtime.sessionId,
      messageId: runtime.messageId,
      prompt,
      model: primaryBodyModel(primary),
      opencodeVersion: runtime.opencodeVersion,
    },
    mutations,
  };
}

function primaryBodyModel(primary: RequestRecord): string {
  const model = (primary.body as { model?: unknown }).model;
  return typeof model === "string" ? model : "";
}

/** Solver image: the pinned Step 3 runtime + baked workspace/capture/harness. */
export function solverDockerfile(): string {
  const lock = JSON.parse(readFileSync(join(repoRoot(), "containers", "restore", "lock.json"), "utf8")) as {
    imageDigest: string;
    image: string;
    opencode: { version: string; sha256: string; url: string; binPath: string };
    aptPackages: Record<string, unknown>;
  };
  const snapshotBase = String(lock.aptPackages["source"] ?? "").trim().split(/\s+/)[0] ?? "";
  const aptPairs = Object.entries(lock.aptPackages)
    .filter(([key, value]) => key !== "source" && key !== "caCertBootstrap" && typeof value === "string")
    .map(([key, value]) => `      ${key}=${String(value)}`)
    .join(" \\\n");
  const ca = lock.aptPackages["caCertBootstrap"] as { package?: string; sha256?: string } | undefined;
  return `# Solver image for the replayed attempt (S5-R4). Pinned runtime from the
# harness restore lock; the starting workspace, frozen capture records, and
# the compiled seeding harness are baked in at task-build time.
ARG BASE_IMAGE=${lock.image}@${lock.imageDigest}
FROM \${BASE_IMAGE}

RUN node -e "fetch(process.argv[1]).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); }).then(b => require('fs').writeFileSync('/tmp/ca-certificates.deb', Buffer.from(b)))" "${snapshotBase}/pool/main/c/ca-certificates/${ca?.package ?? "ca-certificates_20230311+deb12u1_all.deb"}" \\
    && echo "${ca?.sha256 ?? ""}  /tmp/ca-certificates.deb" | sha256sum -c - \\
    && dpkg -x /tmp/ca-certificates.deb /tmp/ca-extract \\
    && mkdir -p /etc/ssl/certs \\
    && cat /tmp/ca-extract/usr/share/ca-certificates/mozilla/*.crt > /etc/ssl/certs/ca-certificates.crt \\
    && rm -rf /tmp/ca-extract /tmp/ca-certificates.deb
RUN set -eux; \\
    printf 'Types: deb\\nURIs: ${snapshotBase}\\nSuites: bookworm\\nComponents: main\\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\\n' > /etc/apt/sources.list.d/debian.sources; \\
    rm -f /etc/apt/sources.list.d/debian-security.sources; \\
    apt-get -o Acquire::Retries=8 -o Acquire::https::Timeout=60 update; \\
    apt-get -o Acquire::Retries=8 install -y --no-install-recommends \\
${aptPairs}; \\
    rm -rf /var/lib/apt/lists/*

ARG OPENCODE_VERSION=${lock.opencode.version}
ARG OPENCODE_SHA256=${lock.opencode.sha256}
ARG OPENCODE_URL=${lock.opencode.url}
RUN node -e "fetch(process.argv[1]).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); }).then(b => require('fs').writeFileSync('/tmp/opencode.tar.gz', Buffer.from(b)))" "\${OPENCODE_URL}" \\
    && echo "\${OPENCODE_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c - \\
    && mkdir -p /usr/local/opencode \\
    && tar -xzf /tmp/opencode.tar.gz -C /usr/local/opencode \\
    && chmod +x ${lock.opencode.binPath} \\
    && rm /tmp/opencode.tar.gz \\
    && ${lock.opencode.binPath} --version

COPY app /app
COPY capture /opt/capture
COPY harness /opt/harness

# The reference solution is intentionally NOT baked into this image (isolation:
# the replaying agent must not read it). It lives in the task's solution/ dir
# and is mounted only by the validation driver.

ENV OPENCODE_BIN=${lock.opencode.binPath}
ENV HARNESS_CAPTURE_DIR=/opt/capture
WORKDIR /app
CMD ["/bin/bash"]
`;
}

/** Verifier image: pinned Python + pinned RewardKit, tests baked at /tests. */
export function verifierDockerfile(): string {
  return `# Dedicated verifier image (S5-R5). Grading dependencies and criteria are
# baked in; the judge calls its configured API at verification runtime.
FROM python:3.12-slim

RUN pip install --no-cache-dir "harbor-rewardkit==0.2.3"

COPY . /tests/
`;
}

export function verifierTestSh(): string {
  return `#!/bin/bash
# RewardKit entry point (S5-R6): one numeric solver reward.
set -eu
mkdir -p /logs/verifier
export PYTHONPATH="/tests\${PYTHONPATH:+:$PYTHONPATH}"
rewardkit /tests --workspace /app --output /logs/verifier/reward-components.json
python /tests/finalize_reward.py /logs/verifier/reward-components.json /logs/verifier/reward.json /logs/verifier/reward-details.json
cat /logs/verifier/reward.json
`;
}

/** task.toml per the upstream Harbor configuration schema (v1.3). */
export function taskToml(writer: WriterOutput, config: SystemConfig): string {
  const verifierEnvEntries = Object.entries(config.verifierEnv)
    .map(([container, host]) => `${container} = "\${${host}}"`)
    .join("\n");
  const verifierEnvBlock = verifierEnvEntries !== "" ? `\n[verifier.env]\n${verifierEnvEntries}\n` : "\n";
  return `schema_version = "1.3"
artifacts = ["/app", "/logs/agent/trajectory.json"]

[task]
name = "harness/${writer.taskName}"
description = "${writer.taskDescription.replaceAll('"', "'")}"

[agent]
timeout_sec = ${Math.round(config.timeouts.harborSec / 2)}

[verifier]
timeout_sec = ${config.timeouts.judgeSec * 2}
environment_mode = "separate"
${verifierEnvBlock}
[verifier.environment]
# VERIFIER_DOCKER_IMAGE_PLACEHOLDER

[environment]
build_timeout_sec = 900.0
# SOLVER_DOCKER_IMAGE_PLACEHOLDER
`;
}

function repoRoot(): string {
  // dist/checkpoint/harbor-task.js -> repo root
  return join(fileURLToPath(new URL("../../", import.meta.url)));
}

/** Preserve rubric partial scores only after every required programmatic check passes. */
export function rewardFinalizerSource(): string {
  return `import json, math, pathlib, sys

def main():
    source, destination, details_path = map(pathlib.Path, sys.argv[1:])
    scores = json.loads(source.read_text())
    details = json.loads(details_path.read_text())
    components = details.get("reward", {}).get("components", [])
    checks = next((item.get("detail", {}).get("score") for item in components if item.get("name") == "checks"), None)
    scores["checks"] = checks
    for key in ("checks", "reward"):
        value = scores.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError("invalid or missing reward component: " + key)
    reward = scores["reward"] if scores["checks"] == 1 else 0.0
    destination.write_text(json.dumps({"reward": reward}) + "\\n")

if __name__ == "__main__":
    main()
`;
}

/** Short registration errors survive bounded repair feedback; no judge call is made. */
export function criteriaSmokeSource(): string {
  return `import runpy, sys

def main():
    try:
        runpy.run_path(sys.argv[1])
    except Exception as error:
        print(type(error).__name__ + ": " + str(error), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
`;
}
