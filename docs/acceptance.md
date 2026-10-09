# Acceptance contract

**Step 2 authority:** [Frozen Step 2 requirements](step-2-requirements.md) define the current finish line and supersede conflicting Step 2 wording below. Later-step checks remain separate.

**Step 3 authority:** [Step 3 requirements](step-3-requirements.md) define restoration acceptance. Portable task packaging is Step 4. The !checkpoint command and model-backed runtime smoke test are Step 5.

**Step 4 authority:** [Package requirements](step-4-requirements.md).

**Step 5 authority:** [Checkpoint requirements](step-5-requirements.md).

The checks below mirror the deterministic-check table in the MVP
design draft and make the user-turn boundary exact. Each check has a
pass condition; a check that cannot run is a failure of that step's
gate, not a pass.

## User-turn boundary (exact definition)

One user turn = one user request plus the agent attempt it produced.

For the selected turn, capture is complete when and only when the
pre-request state has been durably saved. The boundary is:

- Capture must finish before the selected request's first model call
  or first tool action starts.
- While capture is in progress, no model call and no tool action may
  start. Execution waits or fails.
- If capture fails, the turn is sealed: no model call and no tool
  action may run for that turn (fail closed).

## First-version scope

- Idle sessions only: capture assumes no model call is in flight when
  the user turn begins.
- One declared workspace: capture covers one declared directory and
  its Git-ignored files per the fixture policy. Running process
  memory, browser state, queued requests, and external service state
  are out of scope and must be reported as unsupported, not skipped
  silently.

## Deterministic checks

| Check | Pass condition |
|---|---|
| Package integrity | All required records, file objects, and runtime image references are available. |
| Workspace restoration | The complete directory/file set, contents, paths, types, permissions, and symbolic links match the capture; missing, misplaced, deleted, or unexpected entries are checked. |
| Context restoration | Request, prior context, tool definitions, and model settings match. Later messages are absent. |
| Runtime health | The container starts. Required tools and dependencies are available. |
| Tool execution | A known file can be read. A temporary probe file can be written, read, and deleted. |

## Status semantics

- `PASS` — the invoked step's required checks passed. Restore equality, package portability, agent runtime health, and RL reward validity are separate claims.
- `FAIL` — a required check failed.
- `INCONCLUSIVE` — a test limit prevented a decision (for example a
  model timeout).

The checkpoint confirmation is script-generated and fixed. An LLM
never writes the confirmation.

## Scaffold-level acceptance gate (Step 1)

- `npm run verify` (typecheck, then tests) exits 0.
- No secrets, credentials, or generated capture data are tracked in
  Git.
- Version evidence is recorded in `docs/versions.md`.
- Container tooling validation is explicitly deferred to Step 3; its
  absence is not a Step 1 failure.