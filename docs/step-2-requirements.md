# Step 2 acceptance requirements — frozen baseline

## Goal

Capture a coding agent's starting state during normal OpenCode work. Save enough information to make a later replay use the same files and supplied model context. Prove that execution cannot outrun required saving.

**Step 2 delivers capture, not replay.** Container restoration, `!checkpoint` packaging, model-backed package smoke tests, and RL reward validation belong to later steps.

## Authority and change control

This document is the acceptance gate for Step 2. It takes precedence over conflicting Step 2 wording in `design.md` and `docs/acceptance.md`.

There are six requirements: R1–R6. The tests below define their evidence. They do not introduce separate features.

- Do not add requirements during review without explicit user approval.
- Do not weaken a requirement to match the implementation.
- A new finding blocks completion only if it demonstrates a violation of R1–R6. Identify the requirement and the failing scenario.
- Other improvements go into a backlog and do not block Step 3.
- Preserve existing passing evidence. Rerun affected tests after changes, then run the full suite once for final acceptance.
- No required test may be skipped and reported as passed.

## Scope and terms

- **Runtime:** pinned OpenCode v2.0.18, one session, one declared coding workspace, idle user-turn admission.
- **User turn:** one user request and its resulting model/tool attempt. Repeating the same words creates a different turn.
- **Starting checkpoint:** files and prior conversation at the selected request boundary, before its agent actions.
- **Model request:** the effective serialized input sent to the provider, including instructions, messages, tool schemas, and model settings.
- **Required artifact:** a separate file referenced by the supplied context or tool output, including full output saved after truncation.
- **Sealed failure:** that turn cannot execute further model/tool actions. Automatic retries do not reopen it. A new explicit user turn can recover.

The guarantee concerns saved state and supplied model input. It does not guarantee identical model answers. Running process memory, live browser state, external services, queued turns, and simultaneous sessions are outside this gate. The MVP must reject unsupported execution scope clearly.

## R1 — Distinct, explicit turn identity

**Requirement:** Associate each capture and request with a session ID, user-message ID, and checkpoint ID. Use authoritative identity. Do not infer a new turn from request text or a waiting-window expiry. Continuations and retries must remain associated with their original turn.

**Required evidence:**

- Two identical user requests have different message and checkpoint IDs.
- A continuation remains in the original turn without a new checkpoint.
- Delay identity beyond the former 400 ms window. The request waits or fails; it never joins the prior turn by guessing.
- Missing or conflicting identity produces a bounded, explicit error and no upstream execution.

## R2 — Saving precedes execution; failed turns stay sealed

**Requirement:** Save starting files and prior context before the turn's first model/tool action. Save each effective model request before forwarding that request. A required saving failure permanently seals the turn. Do not advance on guessed success or swallowed errors.

**Required evidence:**

- Real OpenCode is connected to an awaited admission/tool gate.
- Delay saving deliberately. Compare capture completion with actual upstream receipt and actual tool-start evidence. A trace emitted after a response is not sufficient.
- Inject snapshot, context-write, and request-write failures. No affected action proceeds.
- Repair the injected failure and retry the same turn. It remains blocked.
- Show that a distinct new user turn can recover through a new checkpoint.

## R3 — Correct starting files and supplied context

**Requirement:** Save the selected request's workspace contents and required file metadata. Save prior session information and the effective model request without substituting a later state. Store the original failed attempt separately as evidence for future replay.

**Required evidence:** Use a real two-turn OpenCode fixture.

1. Establish tracked files in Git. Turn one edits a tracked file, creates an untracked file and a required ignored file, deletes another file, and preserves a symbolic link and executable file.
2. Capture turn two before it changes files.
3. Compare saved contents, absence of deleted files, symbolic-link target, and executable permission with the actual pre-turn state.
4. Check that saved prior context includes turn one and excludes turn two's response/tool suffix.
5. Check that the first saved effective request contains the selected request exactly as sent, with its resolved instructions, tools, and model settings.
6. Confirm unchanged file contents reuse the shared store across checkpoints.

Full restore and comparison of regenerated requests are Step 3 work.

## R4 — Compacted context is captured correctly

**Requirement:** When OpenCode compacts conversation history, retain the actual effective summary/context and model-request records used after compaction. Compaction calls must have authoritative purpose metadata. An empty placeholder record or proof that compaction occurred is insufficient.

**Required evidence:**

- Trigger compaction in real OpenCode, then issue a subsequent user turn so compacted history is part of its starting context.
- Inspect the actual summary produced and accepted by OpenCode.
- Assert that the saved checkpoint/model-input records contain that summary and the relevant effective context, with matching content.
- Check that later failed-attempt content is not included in the starting context.

A deterministic provider may supply the summary. OpenCode itself must perform compaction. The summary need not be semantically excellent; the test concerns faithful capture of what was used.

## R5 — Referenced tool-output files are saved before dependent execution

**Requirement:** When real tool output is truncated into a separate file, capture the referenced file and its contents. Complete this required capture before a dependent model/tool action consumes that output or the checkpoint is treated as ready. Missing, unreadable, or disallowed required files must cause a clear sealed failure. Do not swallow asynchronous errors.

**Required evidence:**

- Use real OpenCode to run a tool that produces enough output to trigger truncation.
- Assert the captured artifact bytes or hash match the actual full-output file. File existence alone is insufficient.
- Continue to a later user turn. Verify its starting record contains the required artifact reference.
- Delay artifact capture. Prove the dependent provider/tool action waits.
- Remove, deny access to, or inject failure for the required artifact. Prove dependent execution stops and the failure is reported.
- Bind the artifact to the producing turn explicitly; late events must not attach it to a different turn.

The existing declared artifact-root policy remains in effect. This gate does not require arbitrary filesystem capture.

## R6 — Reusable integration and secure forwarding

**Requirement:** The real OpenCode tests use the same reusable project-local plugin source intended for normal sessions. Forward provider requests to the configured destination securely. Do not persist API credentials.

**Required evidence:**

- Install/load the reusable plugin in an isolated workspace through its documented installation function. Do not use a different inline test-only implementation.
- Forward a request through an HTTPS test endpoint. Check the actual destination, base path, and authentication received.
- Reject destination-escape requests and insecure remote credential forwarding.
- Scan persisted traces, capture records, and fixture logs for the test credential. It must be absent.
- Purpose/session metadata identifies task, title, and compaction calls without model-name or prompt-string guesses.

No paid provider call or production deployment is required for this gate.

## Test method

Use real OpenCode for admission, tool execution, compaction, and truncation integration tests. A deterministic fake provider is permitted to control responses and avoid paid calls. Small unit tests may isolate storage and failure handling. They do not replace required integration evidence.

Tests must assert outcomes and execution ordering, not source-code strings or comments. Save logs and structured evidence under ignored `work/`. Reference exact files and test names in the append-only agent log.

## Completion rule

Step 2 is complete when:

1. R1–R6 each have passing evidence at the current revision.
2. Type checking, unit tests, and required real OpenCode integration tests pass.
3. The agent log records the revision, command results, evidence paths, and an R1–R6 result table.
4. There are no known violations of these six requirements.

Use PASS, FAIL, or NOT VERIFIED for each requirement. A test-count total alone is not acceptance. Any FAIL or NOT VERIFIED keeps Step 2 open.

**Once these conditions pass, move to Step 3.** Do not add new completion conditions without user approval.

## Current review focus

The latest review identified two unproven conditions: R4's saved-summary equality assertion and R5's awaited artifact-saving/failure barrier. Existing evidence for other requirements is retained, subject to regression results. This statement is a review finding, not a new verified acceptance report.
