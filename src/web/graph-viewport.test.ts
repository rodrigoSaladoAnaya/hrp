import { describe, expect, it } from "vitest";
import type { Viewport } from "@xyflow/react";
import {
  decideGraphViewportAction,
  graphViewportKey,
  isGraphFlowMounted,
  shouldPersistGraphViewport,
  type StoredGraphViewport,
} from "./graph-viewport";

describe("graphViewportKey", () => {
  it("combines runId and nodeSetKey", () => {
    expect(graphViewportKey("run-1", "node-a|node-b")).toBe("run-1:node-a|node-b");
  });
});

describe("decideGraphViewportAction", () => {
  const sampleViewport: Viewport = { x: 120, y: -45, zoom: 0.85 };
  const savedState: StoredGraphViewport = {
    nodeSetKey: "node-1|node-2",
    viewport: sampleViewport,
  };

  it("skips action when runId or nodeSetKey is missing", () => {
    expect(
      decideGraphViewportAction({
        appliedKey: "",
        nodeSetKey: "",
        runId: "run-1",
      }),
    ).toEqual({ kind: "skip" });

    expect(
      decideGraphViewportAction({
        appliedKey: "",
        nodeSetKey: "node-1",
        runId: "",
      }),
    ).toEqual({ kind: "skip" });
  });

  it("skips action when the viewport for this graph key is already applied (state refresh)", () => {
    expect(
      decideGraphViewportAction({
        appliedKey: "run-1:node-1|node-2",
        nodeSetKey: "node-1|node-2",
        runId: "run-1",
        saved: savedState,
      }),
    ).toEqual({ kind: "skip" });
  });

  it("restores saved viewport when nodeSetKey matches saved viewport", () => {
    expect(
      decideGraphViewportAction({
        appliedKey: "",
        nodeSetKey: "node-1|node-2",
        runId: "run-1",
        saved: savedState,
      }),
    ).toEqual({
      kind: "restore",
      graphKey: "run-1:node-1|node-2",
      viewport: sampleViewport,
    });
  });

  it("fits view when there is no saved viewport for the run", () => {
    expect(
      decideGraphViewportAction({
        appliedKey: "",
        nodeSetKey: "node-1|node-2",
        runId: "run-1",
      }),
    ).toEqual({
      kind: "fit",
      graphKey: "run-1:node-1|node-2",
    });
  });

  it("fits view when the structural nodes change even if an older viewport was saved", () => {
    expect(
      decideGraphViewportAction({
        appliedKey: "run-1:node-1",
        nodeSetKey: "node-1|node-2|node-3",
        runId: "run-1",
        saved: savedState,
      }),
    ).toEqual({
      kind: "fit",
      graphKey: "run-1:node-1|node-2|node-3",
    });
  });
});

describe("shouldPersistGraphViewport", () => {
  it("persists viewport only when movement was initiated by the user", () => {
    expect(
      shouldPersistGraphViewport({
        nodeSetKey: "node-1",
        runId: "run-1",
        userMoved: true,
      }),
    ).toBe(true);

    expect(
      shouldPersistGraphViewport({
        nodeSetKey: "node-1",
        runId: "run-1",
        userMoved: false,
      }),
    ).toBe(false);
  });

  it("does not persist when runId or nodeSetKey is missing", () => {
    expect(
      shouldPersistGraphViewport({
        nodeSetKey: "",
        runId: "run-1",
        userMoved: true,
      }),
    ).toBe(false);

    expect(
      shouldPersistGraphViewport({
        nodeSetKey: "node-1",
        runId: "",
        userMoved: true,
      }),
    ).toBe(false);
  });
});

describe("isGraphFlowMounted", () => {
  it("returns true only when map view is active and there is at least one node", () => {
    expect(isGraphFlowMounted("map", 1)).toBe(true);
    expect(isGraphFlowMounted("map", 5)).toBe(true);
  });

  it("returns false when view is not map", () => {
    expect(isGraphFlowMounted("activity", 3)).toBe(false);
    expect(isGraphFlowMounted("findings", 3)).toBe(false);
  });

  it("returns false when node count is 0 or undefined", () => {
    expect(isGraphFlowMounted("map", 0)).toBe(false);
    expect(isGraphFlowMounted("map", undefined)).toBe(false);
  });
});
