# Optional live capture test

Run `npm run test:live` after major capture or provider changes. It is excluded from `npm run verify` and normal tests.

Create a dedicated OpenRouter key with a spending limit of $0.10 or less. Set `OPENROUTER_API_KEY` in the launching environment. The suite verifies that limit before inference. Do not store it in the repository. Optional `LIVE_MODEL` selects a specific model; it must pass the same free-model validation.

The suite first runs the deterministic failure tests and real OpenCode tests. It then runs three connected turns with real OpenCode, the production capture plugin/proxy, and a real OpenRouter model. Each turn reads, edits, and checks a small file. The test checks pre-turn file bytes, checkpoint identity, saved model inputs, tool gates, session continuity, and absence of the real key in capture storage. The script sets PASS/FAIL; the model does not judge capture.

## Cost boundary

Model spend must remain below $0.10. This implementation uses only models whose current catalog pricing is zero for every listed charge and which advertise tool support. It refuses paid models and model fallback lists. Requests are limited to 18; output is limited to 1,024 tokens per request. It never switches to a paid model. Catalog errors, rate limits, unsuitable tool behavior, and unavailable free providers fail the test. For additional account-side enforcement, use a dedicated OpenRouter key with a $0.10 limit. [OpenRouter key limits](https://openrouter.ai/docs/api/api-reference/api-keys/create-keys), [model catalog](https://openrouter.ai/api/v1/models).

## Coverage boundary

The live test proves the ordinary three-turn provider path. The deterministic suite triggers capture failures, missing identity, artifact failure/delay, compaction, and truncation. A small live model cannot reliably trigger every failure or compaction within this budget. Those tests remain controlled; OpenCode tool execution is real.

Evidence is saved under `work/e2e/live-free-*`. A successful live run writes `live-result.json`. Failed runs retain their trace and checkpoint files. A missing credential is an error, not a skipped pass.
