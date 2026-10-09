/**
 * Core capture-boundary primitives.
 *
 * Scope note: this is scaffold code for Step 1. It encodes the acceptance
 * contract in executable form (see docs/acceptance.md):
 *
 *   1. Every model call must map to exactly one open user turn.
 *   2. Capture must fail closed: with a failed checkpoint barrier, no
 *      model call or tool action may proceed.
 *   3. The checkpoint command itself must never become the selected turn.
 */

/** Unique identifier for one user turn (one request + its attempt). */
export type TurnID = string;

/** Reason a turn is sealed and can no longer accept activity. */
export type SealReason = "checkpoint" | "capture-failed" | "completed";

export class TurnBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnBoundaryError";
  }
}

let nextTurnSeq = 0;

/** One user turn. Created sealed-future; opened only after capture commits. */
interface TurnState {
  readonly id: TurnID;
  /** Whether the pre-execution capture barrier has committed. */
  captureCommitted: boolean;
  /** Set once the turn may no longer accept model calls or tool actions. */
  sealed: SealReason | null;
  /** Ordered record of activity bound to this turn. */
  readonly activity: string[];
}

/**
 * Tracks user turns and enforces the capture barrier.
 *
 * Invariant: a model call or tool action is accepted only when the turn's
 * capture has committed and the turn is not sealed. Violations throw.
 */
export class TurnRegistry {
  private readonly turns = new Map<TurnID, TurnState>();
  private current: TurnID | null = null;

  /**
   * Register a new user turn. Capture has not yet committed; the turn
   * rejects activity until `commitCapture` is called.
   */
  beginUserTurn(input: { readonly isCheckpointCommand: boolean }): TurnID {
    if (input.isCheckpointCommand) {
      // The checkpoint command is excluded from task selection and never
      // becomes a turn of its own.
      throw new TurnBoundaryError(
        "checkpoint command must not be registered as a user turn",
      );
    }
    nextTurnSeq += 1;
    const id: TurnID = `turn-${String(nextTurnSeq).padStart(8, "0")}`;
    this.turns.set(id, {
      id,
      captureCommitted: false,
      sealed: null,
      activity: [],
    });
    this.current = id;
    return id;
  }

  /** Mark the capture barrier as committed for the turn. */
  commitCapture(id: TurnID): void {
    const turn = this.#requireOpenTurn(id);
    turn.captureCommitted = true;
  }

  /**
   * Seal the turn. Sealed turns reject all further activity.
   * `capture-failed` seals fail closed: the turn can never be opened.
   */
  sealTurn(id: TurnID, reason: SealReason): void {
    const turn = this.#requireTurn(id);
    turn.sealed = reason;
    if (this.current === id) {
      this.current = null;
    }
  }

  /** Bind one ordered activity record (a model call or tool action). */
  recordActivity(id: TurnID, activity: string): void {
    const turn = this.#requireTurn(id);
    if (turn.sealed !== null) {
      throw new TurnBoundaryError(
        `turn ${id} is sealed (${turn.sealed}); activity rejected`,
      );
    }
    if (!turn.captureCommitted) {
      throw new TurnBoundaryError(
        `capture has not committed for turn ${id}; fail closed`,
      );
    }
    turn.activity.push(activity);
  }

  /** The turn currently receiving the user's request, if any. */
  get currentTurn(): TurnID | null {
    return this.current;
  }

  /** Read-only snapshot of a turn's recorded activity order. */
  activityOf(id: TurnID): readonly string[] {
    const turn = this.#requireTurn(id);
    return [...turn.activity];
  }

  #requireTurn(id: TurnID): TurnState {
    const turn = this.turns.get(id);
    if (turn === undefined) {
      throw new TurnBoundaryError(`unknown turn: ${id}`);
    }
    return turn;
  }

  #requireOpenTurn(id: TurnID): TurnState {
    const turn = this.#requireTurn(id);
    if (turn.sealed !== null) {
      throw new TurnBoundaryError(
        `turn ${id} is sealed (${turn.sealed})`,
      );
    }
    return turn;
  }
}