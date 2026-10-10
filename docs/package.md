# Package — export command and schema reference

Step 4 acceptance authority is [docs/step-4-requirements.md](step-4-requirements.md). This document records the export command, the package layout, the metadata schema, and the policies the exporter enforces.

## Command

```sh
npm run package -- --store <capture-store> --checkpoint <checkpoint-id> --output <export-root> [--verifier <script>]
```

- `--store`: an existing capture store (`objects/` + `checkpoints/`). Only ever read; the exporter never writes into it.
- `--checkpoint`: the checkpoint directory name (for example `ckpt-f5da62aee83d`). Selection reuses Step 3's `selectCheckpoint`: identity comes from the stored `runtime.json`, never from prompt text.
- `--output`: the export root. The package is published at `<output>/<task-id>` where `<task-id>` is `task-<checkpoint-id>`.
- `--verifier`: optional path to a validated task-specific verifier script. When given, it becomes `tests/test.sh` and the package is labeled `validated-task-reward`. When absent, `tests/test.sh` is a runtime health check and the package is labeled `unvalidated-candidate` (S4-R4).

The export root also receives `result.json`: `{status, taskId, checkpoint, startedAt, checks, package?, staging?}`. Exit code is 0 only on PASS.

Fixed output on success: `PACKAGE PASS: task=<task-id> package=<dir>`.

## Layout

```text
<export-root>/<task-id>/
  instruction.md              # the selected request's exact bytes
  task.toml                   # task id, verifier status, file pointers
  environment/Dockerfile      # pinned runtime, generated from the lock
  capture/
    metadata.json             # schema version, identity, object inventory
    runtime-lock.json         # copy of containers/restore/lock.json
    objects/<sha256>          # every required object
    checkpoints/<id>/...      # the selected checkpoint's records (Step 2 schema)
  evidence/                   # the original attempt's response/tool suffix
    model_requests.jsonl
    tool_outputs.jsonl        # when the attempt produced tool outputs
  tests/test.sh               # runtime health check, or the supplied verifier
```

## Record split (S4-R1)

The selected attempt's own response and tool actions are kept separate:

- `capture/checkpoints/<id>/model_requests.jsonl` holds exactly the selected primary request (`task-new-turn`/`task-continuation` record whose index is the selection's `requestIndex`).
- `evidence/model_requests.jsonl` holds the original full request log for provenance, including the continuation rounds the attempt produced after the selected request. `evidence/tool_outputs.jsonl` holds their tool outputs.
- `evidence/` is not part of the restore pipeline. Step 3's restore reads only `capture/`, so the suffix never enters active replay context.

`instruction.md` is written byte-for-byte from the selected request's prompt (the un-JSON-quoted argv text, exactly as submitted).

## Metadata schema (capture/metadata.json)

- `schemaVersion`: 1.
- `taskId`: `task-<checkpoint-id>`.
- `createdAt`: ISO-8601 export time.
- `verifier.status`: `unvalidated-candidate` or `validated-task-reward` (S4-R4). The default export is unvalidated: a generic success reward is never invented for arbitrary captures. A `--verifier` script is recorded as a validated task-specific reward for that task only.
- `selection`: `{checkpointId, sessionId, messageId, requestIndex, model, opencodeVersion}` from the stored records.
- `instruction.path`: `instruction.md`; `origin`: `selected-user-request`.
- `tests`: `{path: "tests/test.sh", kind}` where kind is `runtime-health-check` or `task-verifier`, consistent with `verifier.status`.
- `environment.dockerfile`: `environment/Dockerfile`.
- `runtimeLock`: `capture/runtime-lock.json`.
- `inventory.objects`: every required object as `{sha256, bytes, references}`. The declared set must equal the referenced set exactly (manifest file hashes plus `referenced_artifacts.json` hashes); orphans and omissions both fail.
- `inventory.records`: the exact file set under `capture/checkpoints/<id>/`.
- `inventory.evidenceRecords`: the files under `evidence/`.
- `evidence.paths` + description: the attempt suffix records.

## Validation (S4-R2)

`validatePackage(<package-dir>)` validates from package contents alone. Named checks: `layout.files`, `metadata.schema`, `task.toml`, `task.toml.identity`, `paths.safe`, `objects.inventory` (existence, content hash, byte count, exact referenced-set equality), `records.present` (declared set equals actual set), `records.split`, `identity.consistent`, `credentials.absent`, `hostpaths.undeclared`, `environment.pinned`, `tests.kind`.

- Path escapes: object names must be bare SHA-256 hex; declared paths must be package-relative with no `..` traversal.
- Corrupt objects: content hash mismatches fail.
- Dangling references: any manifest/artifact hash missing from the inventory or from `capture/objects/` fails; so does any undeclared file in the checkpoint record set.
- Credentials: package-authored files, checkpoint records, and evidence text are scanned for private key blocks, `sk-`-style tokens, and `Bearer` tokens. A hit fails the export before publication. Workspace object bytes are not scanned: workspace content is restored as captured under the Step 3 inclusion policy, and the capture store is the credential boundary (auth headers are never recorded there).
- Source-host references: package-authored files (`capture/metadata.json`, `capture/runtime-lock.json`, `task.toml`, `environment/Dockerfile`, `tests/test.sh`) must not contain absolute unix home paths (`/Users/...`, `/home/...`, `/root/...`). `instruction.md` is exempt because its bytes are the captured prompt, preserved verbatim (S4-R1). The capture records keep their original absolute paths by design; Step 3's restore maps them under its declared path rules.

## Runtime and portability (S4-R3)

- `capture/runtime-lock.json` is a verbatim copy of `containers/restore/lock.json`: digest-pinned base image, checksum-pinned OpenCode build, exact apt versions from one frozen Debian snapshot.
- `environment/Dockerfile` is generated from that lock (no value drift). Its registries are declared: Docker Hub (digest), `https://snapshot.debian.org/archive/debian/20261008T000000Z` (frozen, HTTPS), and the pinned OpenCode URL. It fetches and hash-checks the pinned CA bundle. Offline execution is not claimed and was not tested.
- Portability proof: the package is relocated to an independent directory tree and `npm run restore -- --store <package>/capture --checkpoint <id> --output <run-dir>` (Step 3's command, unchanged) restores it in a fresh container with no access to the original store. Rebuilding `environment/Dockerfile` from the package was not exercised in Step 4; the restore uses the harness's identical pinned image.
- The verifier script and `evidence/` live outside `capture/`, so they are not mounted into the restored workspace; the retrying agent's context is the materialized workspace plus the seeded conversation only.

## Export pipeline and failure semantics (S4-R5)

1. Preflight selection and hash verification (reads only).
2. Render the package into a private staging directory under the export root (`.staging-<task-id>-<unique>`).
3. Validate the staging directory.
4. Atomically rename staging to `<output>/<task-id>`; the target must not already exist (`package.target-exists` otherwise).
5. Re-validate the published package and print the fixed status.

Failure behavior: every failure exits nonzero, names the failed check in `result.json`, and retains the staging directory as diagnostic evidence. Nothing is published unless validation passed and the rename succeeded; a partial staging directory is never a valid package (it fails `validatePackage`). The source store is never modified.
