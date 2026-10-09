# Step 3 acceptance requirements — baseline

## Goal and authority

Restore one selected checkpoint in a fresh Linux container. Prove that its starting workspace and regenerated OpenCode model input match the capture. Do not forward that input to a model.

This document defines the Step 3 finish line and takes precedence over conflicting Step 3 text in design.md and docs/acceptance.md. Requirements S3-R1 through S3-R7 are the complete baseline. The scenarios below are evidence for those requirements, not additional features.

- A new finding blocks this step only when it demonstrates a baseline violation. Name the requirement and failing scenario.
- New requirements need explicit user approval. Do not weaken this baseline to fit the implementation.
- Improvements outside this scope go in a backlog. Do not reopen Step 2 without a demonstrated capture defect that prevents restoration.
- No required test may be skipped and called a pass. Record a missing runtime or unsupported restore as BLOCKED with its reason.

## Scope and boundaries

Use pinned OpenCode v2.0.18, one idle session, one declared coding workspace, and one explicitly selected user message/checkpoint. Reuse Step 2 storage and integration. Implement only missing restore capabilities.

The comparison concerns files and effective model input, not identical model answers. Browser/process memory, remote services, concurrent sessions, full arbitrary host replication, live-model retry, RL reward validation, and portable Harbor packaging are outside this step. Step 4 adds portable packaging. Step 5 connects !checkpoint and the live-model smoke test.

## Source, capture, and report layout

These are implementation targets; they do not claim that the files already exist. Keep the current capture schema. If a required record is missing, report the gap instead of inventing it.

```text
src/restore/                  # restore command, input adapter, comparison, reports
containers/restore/           # Dockerfile and pinned runtime/dependency lock
tests/restore/                # deterministic integrity and comparator tests
tests/e2e/restore.e2e.test.ts  # real Linux container + real OpenCode proof
docs/step-3-requirements.md    # this acceptance authority
docs/restore.md               # exact commands and supported capture policy

<capture-store>/              # existing store; read-only to restore workers
  objects/<sha256>
  checkpoints/<checkpoint-id>/
    manifest.json
    prior_context.json
    session_state.json
    runtime.json
    model_requests.jsonl
    compaction.json           # when required by the selected input
    compaction_requests.jsonl # when required
    referenced_artifacts.json # when required
    tool_outputs.jsonl        # retained evidence; not blindly inserted into replay

work/restore/<run-id>/        # disposable, never tracked in Git
  selection.json             # checkpoint, session, selected message/request
  runtime.json               # image digest, versions, dependency identities
  comparison.json            # structured differences and allowed volatile fields
  result.json                # PASS / FAIL / BLOCKED, checks, evidence paths
  regenerated-request.json   # intercepted before forwarding
  trace.jsonl
```

Container workspace and OpenCode session data must be private writable copies/volumes. The capture store must remain read-only. Do not mount the live host workspace as the retry workspace. Host paths under work/restore are evidence paths; documented container paths may differ only under S3-R4's explicit path rules.

## S3-R1 — Explicit selection and complete stored input

Select by checkpoint ID and the associated authoritative session/message IDs. Identify the selected first primary request. Never choose the newest session globally or infer identity from prompt text. Validate required records and all referenced object hashes before starting OpenCode. Preserve shared object reuse.

Evidence: select the second turn from a two-turn fixture; distinguish identical prompt text by identity; reject unknown/conflicting selection, a missing object, and a corrupted object. Repeated restores must not create duplicate stored copies of unchanged source objects.

## S3-R2 — Exact workspace and safe inclusion policy

Restore the complete captured workspace tree: directories, files, relative paths, file types, bytes, executable permissions, and symbolic-link targets. Deleted files stay absent. Compare the actual tree in the container against the manifest; a missing, misplaced, or unexpected entry fails. Keep harness/runtime files outside the compared workspace, or list their exact reserved paths in the inclusion policy. Do not allow broad exclusion patterns to hide differences. Include required untracked and ignored fixture files. Publish the inclusion policy. Do not silently omit required state. Exclude the store and credentials; if required secret-bearing state has no documented safe reconstruction, report BLOCKED.

Reject unsupported file types, escaping paths, links outside the declared workspace, and writes through unsafe symlink parents. Validation failure must not write outside the private restore root.

Evidence: tracked edit, untracked file, required ignored fixture file, deleted file, executable file, and symlink. Compare the complete expected directory/file set, hashes, and metadata inside the real container. Add negative fixtures for a missing file, a misplaced file, an unexpected file/directory, and an incorrect permission or link target. Test unsafe path/link and unsupported-type fixtures. Secret fixtures use synthetic values, never personal credentials.

## S3-R3 — Pinned container runtime

Use a Linux image pinned by digest, a pinned Linux OpenCode build, and exact required dependency versions/lockfiles. Record resolved versions and image identity in each report. Define build and run commands. A mutable tag or a macOS binary copied into Linux does not satisfy this requirement.

Evidence: build/start the image, verify versions inside it, and run a deterministic read/write/read/delete probe in its private workspace. Missing engine/image/dependency is an explicit failure or BLOCKED prerequisite. No external model key is needed for this step.

## S3-R4 — Context and effective input reconstruction

Restore only the conversation prefix before the selected request, including required compaction summaries and referenced tool-output contents. Submit the selected request once. Keep its original response and subsequent tool actions out of active context.

Run real OpenCode in the container. Intercept its regenerated primary request before forwarding. Compare instructions, ordered messages, tool schemas, model ID/settings, and file metadata with the selected original input. Do not substitute the saved HTTP request for actual OpenCode regeneration.

List every allowed volatile field in a checked-in comparison policy, with a reason and an exact scope. Preserve original absolute paths when input depends on them. If host-to-container path translation is necessary, report original and regenerated values and the precise declared mapping. Unexplained differences fail; do not normalize away semantic content, tool definitions, or settings.

Evidence: ordinary two-turn context, a compacted-context fixture, and a truncated-output reference fixture from real OpenCode. Verify the selected prompt occurs once and its own later response/tool suffix is absent. Comparator negative tests must detect changed instructions, missing prior/tool content, changed tool schemas/settings, and an undeclared path difference. Outbound inference count must be zero.

## S3-R5 — Independent repeated restoration

Restore the same checkpoint twice into fresh containers and isolated OpenCode stores. Both starting states and regenerated inputs must pass comparison. A mutation in restore A must not change the stored objects, restore B, or the original workspace.

Evidence: change/create/delete files in A after its initial comparison; restore B from the same selection; compare B and the source store with the captured state. Confirm independent session storage.

## S3-R6 — Bounded, explicit failures

Validate before execution. Stop on missing/corrupt records, unsafe filesystem state, unsupported scope, runtime startup failure, context import failure, timeout, or input mismatch. Do not fall back to a guessed session or partial replay. On failure, do not forward model requests or proceed with agent tools. Use bounded startup/import/interception timeouts and clean up the run's container resources while retaining evidence.

Evidence: missing/corrupt-object fixtures; invalid context; runtime launch failure; a model-input mismatch; and an interception timeout. Assert a nonzero exit, specific failed check, no provider forwarding, and no leaked run-owned containers. A later clean restore may succeed; it must be a distinct run.

## S3-R7 — Usable command and machine-readable result

Expose `npm run restore -- --store <path> --checkpoint <id> --output <run-directory>` as the restore-check command. Specify its argument semantics in docs/restore.md and add its implementation entry point in package.json during the coding step. It must return a nonzero exit on FAIL or BLOCKED and zero only after all Step 3 checks pass. Print a short script-generated status with the checkpoint/run ID and report location. Never ask a model to judge correctness.

Evidence: run the documented command against a valid checkpoint and a negative fixture. Confirm result.json lists each requirement/check and the comparison differences. Verify the required report layout shown above: missing report files or broken references fail acceptance. Preserve enough evidence for another agent to repeat the same test without personal OpenCode state.

## Completion gate and implementation sequence

1. Inspect existing capture records and restore helpers; reuse them. Record inclusion, runtime-lock, and comparison policies in docs/restore.md.
2. Implement preflight and materialization; pass S3-R1/R2 negative fixtures.
3. Build the pinned runtime and isolated restore command; pass S3-R3.
4. Implement context restoration and request interception; pass S3-R4 without provider forwarding.
5. Run repeated restoration and failure checks; pass S3-R5/R6/R7.
6. Run existing verification and the real container restore suite. Append a cited S3-R1–R7 result table to agent-log.md, including revision, exact commands, image digest, evidence paths, and limitations.

Step 3 is complete only when all seven requirements have passing evidence. A passing process exit alone is insufficient. If exact reconstruction cannot be achieved with the current capture/interfaces, identify the missing capability and stop before packaging. Do not change the acceptance target to make the result pass.
