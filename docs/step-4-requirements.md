# Step 4 — Portable task package requirements

## Goal and boundary

Export one selected checkpoint into the agreed task layout. It must restore from another location without the original capture store. Reuse Step 3's restore and comparison code. No !checkpoint integration, provider calls, or new restore engine belongs here.

This document defines Step 4's completion gate. S4-R1–R5 are the baseline. New requirements need user approval. Findings block this step only when they demonstrate a listed violation. Never weaken requirements or mark skipped evidence as passing.

## Layout and entry point

```text
src/package/                  # export and package validation
tests/package/               # inventory, layout, export-failure tests
tests/e2e/package.e2e.test.ts # real container portability test
docs/package.md              # export/import command and schema reference

<export-root>/<task-id>/
  instruction.md
  task.toml
  environment/Dockerfile
  capture/
    metadata.json             # schema version, task and selection identity, object inventory
    runtime-lock.json         # pinned image/OpenCode/dependency identities
    objects/<sha256>          # all required objects; can later use verified archive transport
    checkpoints/<id>/...      # selected records using Step 2's schema
  evidence/                   # original attempt suffix; not active replay context
  tests/test.sh               # identified runtime smoke check, or validated task verifier
```

This layout follows Harbor's instruction/configuration/environment/test structure with a custom capture extension. It is a candidate format; folder validation alone does not prove native Harbor evaluation compatibility. [Primary format reference](https://docs.harborframework.com/tasks/overview)

Proposed command contract for implementation: `npm run package -- --store <path> --checkpoint <id> --output <export-root>`. Document it in docs/package.md. This proposal defines the target, not an existing command.

## Requirements and evidence

| ID | Requirement | Required evidence |
|---|---|---|
| S4-R1 | Preserve explicit task/checkpoint/session/message identity and the selected instruction. Preserve prior context and original settings. Keep the selected attempt's response/tool suffix separate as evidence. | Export the second turn; check identities and instruction bytes; verify the suffix is absent from the regenerated active input. |
| S4-R2 | Validate the exact required folder layout, metadata schema, file references, runtime locks, and complete object inventory. Include every required object. Reject path escapes, corrupt objects, and dangling local references. Credentials must not be included. | A valid export passes; missing/misplaced required files, missing/corrupt objects, invalid schema, and forbidden secret fixture fail. Verify input store remains unchanged. |
| S4-R3 | Restore from an independent location with no access to the source store or original workspace. Runtime images/dependencies may come from declared pinned registries; document those dependencies. Do not claim offline execution unless tested. | Export, disconnect the original store from the worker, and run Step 3 restore checks in a fresh container. Compare files/context/input. Scan metadata for undeclared source-host references. |
| S4-R4 | Record verifier status explicitly: unvalidated candidate or validated task-specific reward. Distinguish tests/test.sh runtime health checks from task-success evaluation. Never invent a generic success reward for arbitrary captures. | Export an unvalidated candidate and check its label. For the known fixture verifier, correct and incorrect outputs receive the expected result. Do not expose verifier/reference answers to the retrying agent unless originally present. |
| S4-R5 | Export without changing the source store. Publish a complete package atomically, or mark partial output unusable. Fail clearly and return nonzero on invalid/incomplete export. Print a fixed task ID and evidence path on success. | Inject an export-write failure; no partial folder is accepted as valid. Repeat export and check independent valid outputs, source integrity, explicit status, and retained diagnostic evidence. |

## Completion gate

S4-R1–R5 pass. The portable folder passes the Step 3 restoration gate from its new location. Existing checks still pass. Append revision, commands, package path, image identity, and the result table to agent-log.md.

Output: portable task candidate and export/layout-validation commands. Next: Step 5 user command and bounded live attempt. Full arbitrary-task reward design remains separate from runtime readiness.
