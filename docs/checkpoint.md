# Checkpoint — background task generation and grading

Step 5 acceptance authority is [docs/step-5-requirements.md](step-5-requirements.md). This document records the command, configuration, background workflow, pinned interfaces, and failure semantics.

## Command

The project-controlled executable lives at `bin/checkpoint`. Add this repository's `bin/` directory to `PATH` so OpenCode's `!` shell can run it:

```sh
!checkpoint "The agent did not do x"
```

- The description is a quoted string; there is no interactive prompt and no approval gate.
- The command selects the LAST attempt of the ACTIVE session through the harness proxy's `/checkpoint` endpoint (explicit session/message identity; never a global newest-session lookup). The command itself is excluded from task selection by the proxy.
- It prints `QUEUED <task-id>` and returns promptly. The pipeline runs as a detached background process that survives OpenCode or terminal closure.
- Status is persisted at every step; a crashed runner is reported FAILED (`runner.died`) on the next invocation instead of hanging.

```sh
checkpoint scores
```

prints one deterministic line per job:

```text
task-001  87/100
task-002  FAILED
task-003  RUNNING
```

Completed lines show the independent task-quality score, never a solver reward.

## Configuration

`checkpoint.config.json` (git-ignored; see `checkpoint.config.example.json`), or the path in `CHECKPOINT_CONFIG`:

- `storePath`, `outputDir`, `jobsDir`, `captureServiceURL` — directories and the capture proxy endpoint.
- `writer`, `reviewer`, `solver` — model endpoints (`baseURL`, `model`, `apiKeyEnv`, `maxOutputTokens`). The solver replays the CAPTURED model id; its configured `model` field is unused by design (model/version identity is retained from the capture).
- `judgeModel` — LiteLLM model string substituted into the generated `judge.toml`.
- `verifierEnv` — container variable name to host environment-variable NAME; values are resolved by Harbor at verification runtime and are never stored.
- `credentials` — credential environment-variable NAMES only.
- `modelSpendCapUSD` — aggregate per-checkpoint cap (default 0.20) covering generation, review, judge calls, and retries.
- `timeouts`, `retries` — bounded writer/reviewer calls, judge timeout, Harbor run timeout.
- `rubric` — the versioned universal task-quality rubric (default `universal-task-quality-v1`, six dimensions, equal weights; no weights were user-specified).

## Storage layout

```text
<outputDir>/
  tasks/<task-id>/   # published Harbor task packages (atomic renames only)
  jobs/<job-id>/     # status.json, job.json, log.txt, export/, task draft,
                     # fixture workspaces, harbor/ run output, diagnostics
```

Images live in Docker's image store. `images.lock.json` inside each task records the locked local image ids; tags are convenience names. Registry digests are recorded at publication time (later step).

## Background workflow

1. **Writer** (bounded model call): turns the frozen capture (selected request, prior-context excerpt, workspace inventory, attempt excerpt) and the failure description into a JSON envelope: instruction, task description, RewardKit `checks.py`, optional `judge.toml`, and a solution script. Invalid output retries within the configured limit.
2. **Build** (deterministic): the Step 4 exporter produces the frozen capture records and evidence split; the Step 3 materializer bakes the starting workspace into the solver image context; the builder writes `task.toml` (upstream schema v1.3), the pinned solver and verifier Dockerfiles, and `reward.toml`. Two recorded runtime rebinds adapt the captured workspace for a live solver: the capture-time provider config is removed and the capture plugin is deleted (the recorder proxy does not exist in the solver).
3. **Images**: the runner builds `rl-task-<task-id>-solver` and `rl-task-<task-id>-verifier` and locks their image ids in `images.lock.json`; `task.toml` references the prebuilt images.
4. **Validation**: the writer's solution runs inside the solver image to produce a known-correct fixture; the pristine workspace is the known-incorrect fixture. Both are graded through the verifier image with RewardKit. Thresholds: good >= 0.99, bad <= 0.5. A failure fails the job before any Harbor run.
5. **Native Harbor run**: `harbor run` executes the task with the custom `opencode_restore_agent`, which installs nothing (the pinned OpenCode 2.0.18 binary is baked into the image), seeds the captured session store via the compiled Step 3 seeder, and submits the ORIGINAL captured request exactly once with `opencode run --session <id>`. Harbor transfers `/app` and the ATIF trajectory to the separate verifier, which runs RewardKit and writes one numeric solver reward.
6. **Review**: an independent model call applies the versioned universal rubric and returns one score out of 100 with a per-dimension breakdown. It runs after the writer and never sees judge credentials.
7. **Publication**: a credential scan runs over the task files; the complete task is atomically renamed into `tasks/<task-id>`. Failures retain the draft and diagnostics under `jobs/`.

## Pinned interfaces

- Harbor `0.24.0` (PyPI `harbor`), installed in `work/harbor-venv` (Python 3.13). Custom agent: `python/opencode_restore_agent.py` (`module.path:opencode_restore_agent:OpenCodeRestoreAgent`), extending Harbor's built-in OpenCode agent for ATIF trajectory parsing.
- RewardKit `harbor-rewardkit==0.2.3`, baked into the verifier image (`pip install`), invoked by `tests/test.sh` as `rewardkit /tests --workspace /app --output /logs/verifier/reward.json`.
- OpenCode `v2.0.18` binary, checksum-pinned from the same lock as Step 3 (`containers/restore/lock.json`); the npm `opencode-ai` package (1.x line) is NOT used.
- Task schema: `schema_version = "1.3"` with root `artifacts = ["/app", "/logs/agent/trajectory.json"]`, `[verifier] environment_mode = "separate"`, and a dedicated `[verifier.environment]` image.
- Judge routing: RewardKit calls LiteLLM; the verifier image receives the judge credential variable names declared in `verifierEnv`.

## Failure semantics

- Every failure marks the job FAILED with a named check (`writer.*`, `build.image`, `validate.fixtures`, `harbor.*`, `spend.cap-exceeded`, `publish.*`, `runner.died`) and retains the draft, logs, and image evidence under `jobs/`.
- Judge timeout, API failure, or an invalid response is a grading error: the job fails; it is never silently recorded as solver reward 0.
- The model-spend cap is enforced before each admitted call and after each recorded cost; exceeding it fails the job. Credentials exist only as process environment values and are never written to disk.
- Publication is atomic: an incomplete draft can never appear under `tasks/`.
