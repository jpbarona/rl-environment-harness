import { describe, expect, it } from "vitest";
import { TurnBoundaryError, TurnRegistry } from "../src/index.js";

describe("TurnRegistry", () => {
  it("registers a turn with capture uncommitted", () => {
    const reg = new TurnRegistry();
    const id = reg.beginUserTurn({ isCheckpointCommand: false });
    expect(id).toMatch(/^turn-\d{8}$/);
    expect(reg.currentTurn).toBe(id);
  });

  it("rejects activity before capture commits (fail closed)", () => {
    const reg = new TurnRegistry();
    const id = reg.beginUserTurn({ isCheckpointCommand: false });
    expect(() => reg.recordActivity(id, "model-call-1")).toThrow(
      TurnBoundaryError,
    );
  });

  it("accepts activity after capture commits, in order", () => {
    const reg = new TurnRegistry();
    const id = reg.beginUserTurn({ isCheckpointCommand: false });
    reg.commitCapture(id);
    reg.recordActivity(id, "model-call-1");
    reg.recordActivity(id, "tool-action-1");
    expect(reg.activityOf(id)).toEqual(["model-call-1", "tool-action-1"]);
  });

  it("refuses to register the checkpoint command as a turn", () => {
    const reg = new TurnRegistry();
    expect(() =>
      reg.beginUserTurn({ isCheckpointCommand: true }),
    ).toThrow(TurnBoundaryError);
  });

  it("seals a turn and rejects later activity", () => {
    const reg = new TurnRegistry();
    const id = reg.beginUserTurn({ isCheckpointCommand: false });
    reg.commitCapture(id);
    reg.recordActivity(id, "model-call-1");
    reg.sealTurn(id, "checkpoint");
    expect(reg.currentTurn).toBeNull();
    expect(() => reg.recordActivity(id, "model-call-2")).toThrow(
      /sealed \(checkpoint\)/,
    );
  });

  it("sealing for capture failure blocks the turn permanently", () => {
    const reg = new TurnRegistry();
    const id = reg.beginUserTurn({ isCheckpointCommand: false });
    reg.sealTurn(id, "capture-failed");
    expect(() => reg.commitCapture(id)).toThrow(/sealed/);
    expect(() => reg.recordActivity(id, "model-call-1")).toThrow(
      /sealed/,
    );
  });

  it("throws on unknown turn IDs", () => {
    const reg = new TurnRegistry();
    expect(() => reg.commitCapture("turn-99999999")).toThrow(
      /unknown turn/,
    );
    expect(() => reg.activityOf("turn-99999999")).toThrow(/unknown turn/);
  });

  it("activity snapshot is isolated from internal state", () => {
    const reg = new TurnRegistry();
    const id = reg.beginUserTurn({ isCheckpointCommand: false });
    reg.commitCapture(id);
    const snapshot = reg.activityOf(id);
    reg.recordActivity(id, "model-call-1");
    expect(snapshot).toEqual([]);
  });

  it("tracks each turn independently", () => {
    const reg = new TurnRegistry();
    const a = reg.beginUserTurn({ isCheckpointCommand: false });
    reg.commitCapture(a);
    reg.recordActivity(a, "model-call-1");
    const b = reg.beginUserTurn({ isCheckpointCommand: false });
    expect(reg.currentTurn).toBe(b);
    expect(() => reg.recordActivity(b, "model-call-2")).toThrow(
      /capture has not committed/,
    );
    reg.commitCapture(b);
    reg.recordActivity(b, "model-call-2");
    expect(reg.activityOf(a)).toEqual(["model-call-1"]);
    expect(reg.activityOf(b)).toEqual(["model-call-2"]);
  });
});