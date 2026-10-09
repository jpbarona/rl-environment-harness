# Two-turn acceptance fixture

Scope: fixture specification for capture and restore validation. The
fixture is created and exercised in Step 2 (Step 3 for restore).
No personal data is permitted.

## Layout

A declared workspace (Git repository) containing, at capture time:

| Element | Purpose |
|---|---|
| Tracked file `notes.md` | Modified in turn 1; modification must be captured. |
| Untracked file `scratch.tmp` | Created in turn 1; must be captured despite being untracked. |
| Ignored file `.env.local` | Required for the task (e.g. a local test config); must be captured even though Git ignores it. |
| Deleted file `obsolete.txt` | Deleted in turn 1; restore must keep it absent. |
| Symbolic link `link -> notes.md` | Restore must reproduce the link target. |
| Executable file `run.sh` | Restore must preserve the executable bit. |

## Conversation

- **Turn 1:** request produces `scratch.tmp` with known contents and
  modifies `notes.md`. Establishes workspace deltas and the required
  ignored file.
- **Turn 2 (mid-conversation, the selected turn):** request writes a
  file with known contents to a fixed path. This is the request that
  capture and restore must reproduce exactly.

## Expected evidence

- Capture for turn 2 finishes before turn 2's first model call or tool
  action.
- Restore of turn 2 twice yields starting states identical to the
  capture, including the absent `obsolete.txt`, the link, the
  executable bit, and `.env.local`.
- The original failed attempt suffix after turn 2's request does not
  appear in replay input.