# Restore — commands and policies

Step 3 acceptance authority is [docs/step-3-requirements.md](step-3-requirements.md). This document records the exact commands, the workspace inclusion policy, the runtime lock, and the request comparison policy.

## Command

```sh
npm run restore -- --store <capture-store> --checkpoint <checkpoint-id> --output <run-dir>
```

- `--store`: an existing capture store (`objects/` + `checkpoints/`). Mounted read-only into the container; the restore worker never writes to it.
- `--checkpoint`: the checkpoint directory name (for example `ckpt-f5da62aee83d`). Selection is by explicit id. Session and message identity come from the stored `runtime.json`; identity is never inferred from prompt text and no newest-session lookup exists.
- `--output`: the evidence directory (`work/restore/<run-id>`). Created if missing; receives `selection.json`, `runtime.json`, `comparison.json`, `regenerated-request.json`, `result.json`, `seed.sql`, `trace.jsonl`, and the admission-capture store.
- `--reuse-image`: skip the image build and use the existing `rl-restore:<opencode-version>` image.

Exit code is 0 only when `result.json` reports `PASS`. `FAIL` and `BLOCKED` exit nonzero and list the failed check names in `result.json`.

Additional flags: `--timeout-ms <ms>` (default 180000) bounds the OpenCode interception window.

## Pipeline

1. **Preflight (S3-R1).** The worker validates the checkpoint id, loads `manifest.json`, `runtime.json`, `prior_context.json`, and `model_requests.jsonl`, selects the first primary task request, and verifies every referenced object's SHA-256 before OpenCode starts.
2. **Materialization (S3-R2).** The manifest is materialized under `/work/workspace` from the read-only object store, hash-verified per object.
3. **Tree comparison (S3-R2).** The actual tree in the container is compared against the manifest: paths, kinds, bytes, file permissions, and symlink targets. Differences fail the run.
4. **Git reconstruction.** Capture excludes `.git` contents, so the workspace is re-initialized as a git repository to restore the captured VCS state (`Is directory a git repo: yes`).
5. **Session seeding (S3-R4).** A bootstrap OpenCode run initializes a fresh session store; the prior conversation from `prior_context.json` is inserted as OpenCode session rows via sqlite3. The selected turn is submitted once with `opencode run --session <captured-session-id> "<selected prompt>"`. The bootstrap run is only a store initializer: it points the workspace plugin at a dead loopback port so it fails in under a second, and its own request is never compared or forwarded.
6. **Compacted context (S3-R4).** When the selected request's last user message is a compaction checkpoint wrapper, the seed is rebuilt from the captured compaction call (`compaction_requests.jsonl`, minus its system and summarize-instruction messages) and the pending prompt is submitted once. Real OpenCode then re-runs its own compaction; the interception proxy answers that call with the captured summary (from `compaction.json`), so OpenCode rebuilds the identical checkpoint wrapper and the regenerated request matches the original exactly — the prompt appears once, inside the wrapper, with no extra message.
7. **Referenced artifacts (S3-R4).** Files referenced by truncated tool outputs are materialized from the object store into the container at the mapped path (capture home prefix → container home), hash-verified after the copy (`artifacts.materialized` check). Referenced paths inside the restored conversation remain the original capture-time paths, so the provider request matches verbatim; the proxy maps request-time artifact reads through the same declared mapping and fails closed on anything outside it.
8. **Interception (S3-R4).** The restore proxy answers every model request locally with a canned completion. The first regenerated primary request is captured before it would be forwarded. **Outbound model requests: zero.**
9. **Request comparison (S3-R4).** The regenerated request is compared against the captured primary request under the policy below.
10. **Reports (S3-R7).** `result.json` lists every check; `comparison.json` holds the workspace and request comparisons; `runtime.json` records image digest, versions, and the harness revision.

## Inclusion policy (S3-R2)

- **Restored:** every manifest entry — tracked files, untracked files, ignored fixture files, directories, executable permissions, and symbolic links (relative targets only).
- **Excluded by capture, therefore not restored and not compared:** `.git/` and `node_modules/` (capture's `SKIP_DIRS`). The git repository itself is reconstructed with `git init`.
- **Never included:** the capture store, harness files, and credentials. The store is mounted read-only; no host environment values are written into the workspace or reports.
- **Rebound runtime references (S3-R4).** The capture fixture's workspace-level `opencode.json` carries the capture run's proxy port as `provider.*.options.baseURL`. After the tree comparison passes, the worker rewrites that port to the restore proxy and records the original and rebound values in `comparison.json` (`runtimeRebinds`) and the `workspace.config-rebind` check. Only loopback base URLs are rebound; anything else fails the comparison.
- **Unsupported state:** absolute or escaping paths, absolute or escaping symlink targets, symlink parents, and unknown file kinds are rejected before any write. Validation failure never writes outside the restore root.

## Runtime lock (S3-R3)

Recorded in `containers/restore/lock.json` and baked into the image:

- Base image: `node:22-bookworm-slim` pinned by digest `sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`, platform `linux/arm64`.
- OpenCode: `v2.0.18` Linux ARM64 build from `https://opencode.ai/files/bin/2.0.18/opencode-linux-arm64.tar.gz`, pinned by SHA-256 `f46253f0ff5eff0c1751d3b734ede55cc60d932d60af81d061d03745f9998082`. The macOS host binary is never copied into Linux.
- Tools: every apt dependency is pinned to an exact version and resolved from one frozen Debian snapshot over HTTPS (`https://snapshot.debian.org/archive/debian/20261008T000000Z`, bookworm main): `git 1:2.39.5-0+deb12u3`, `git-man 1:2.39.5-0+deb12u3`, `sqlite3 3.40.1-2+deb12u2`, `libsqlite3-0 3.40.1-2+deb12u2`, `ca-certificates 20230311+deb12u1`, `openssl 3.0.20-1~deb12u2`, `libssl3 3.0.20-1~deb12u2`. The base image ships no CA bundle, so the pinned `ca-certificates` .deb is vendored in the build context (sha256 recorded in `lock.json`) and extracted before any apt traffic; a version drift fails the build. Node.js comes from the digest-pinned base. Resolved strings are baked into the image (`/usr/local/share/harness-*-version`) and re-recorded in `runtime.json` per run.
- Deterministic probe: each e2e run performs a read/write/read/delete cycle in the container's private workspace before restoration.

## Request comparison policy (S3-R4)

Everything is compared exactly: model id, ordered messages and their content, tool schemas, and request settings (`stream`, `stream_options`, `store`, `temperature`, `top_p`, `tool_choice`). Three volatile regions are declared and transformed before comparison; anything else fails:

| Field | Reason | Scope |
|---|---|---|
| `system.paths` | The system prompt states the absolute workspace and tmp-dir paths, which necessarily differ between capture host and container. | Exact-string replacement of the captured workspace root (and its tmp prefix) with the container paths, inside the first system message only. |
| `system.platform` | The capture host is macOS; the restore runtime is Linux. | `Platform: darwin` becomes `Platform: linux`, inside the first system message only. |
| `system.date` | The env block states the current date, which advances between capture and restore. | The `Today's date:` line is neutralized on both sides. |
| `tools.shell.platform` | The shell tool description states the runtime OS and shell. | The phrase `Commands run on <macOS using zsh / Linux using bash>` is neutralized in the shell tool description only. |

Other declared non-comparisons: OpenCode-internal session fields (message ids, timestamps, token counters, agent labels) never reach the provider request and are not compared. The selected prompt must occur exactly once, and its own response and tool suffix must be absent from the captured prefix (`prior_context.json` never contains them).

## Failure semantics (S3-R6, S3-R7)

Validation happens before execution. The run stops — with a named check in `result.json` and exit code 1 — on: missing or corrupt records/objects (`objects.missing`, `objects.corrupt`, `selection.*`), unsafe filesystem state (`materialize.*`), workspace tree mismatch (`workspace.tree`), session store initialization failure (`session.db-init`), seeding failure (`session.seed`, `seed.compaction-source`), interception timeout (`request.interception`), or request mismatch (`request.comparison`). There is no fallback to a guessed session, no partial replay, and no provider forwarding. Each run owns one container that is removed on exit; evidence under `work/restore/<run-id>` is retained.

The CLI reports every failure path in `result.json` as well: docker unavailable (`runtime.docker`, status `BLOCKED`), missing store or checkpoint (`selection.store-missing`, `selection.checkpoint-missing`), image build failure (`runtime.image-build`), and a worker that exits without a report (`worker.run`). The failed check carries the detail and every check that could not run is marked `not run`; a PASS is never claimed on a failure path.

## Repeated restoration (S3-R5)

The same checkpoint can be restored repeatedly into fresh containers and isolated session stores. The store is read-only to the worker, so a mutation inside restore A cannot change the stored objects, restore B, or the original capture.