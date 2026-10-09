# rl-environment-harness

Capture normal OpenCode coding sessions as reproducible reinforcement-learning task candidates.

The harness records starting workspace state, session context, and model requests. OpenCode connects through a recording proxy to the model provider. Task capture and replay are being developed in stages.

## Status

Step 2 capture hardening is implemented and tested. Integration gaps remain for reusable plugin installation, real compaction coverage, and automatic truncated-output artifact capture. Full replay and task packaging are not complete.

## Planning and evidence

- `design.md`: requirements, workflows, and numbered implementation plan.
- `agent-log.md`: append-only technical history and cited validation evidence.

## Checks

```sh
npm ci
npm run verify
```

Integration tests use real OpenCode v2.0.18 with a deterministic model endpoint. See `docs/versions.md` for prerequisites. Generated capture data and local credentials are excluded from Git.
