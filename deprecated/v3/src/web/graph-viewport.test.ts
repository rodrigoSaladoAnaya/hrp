import { describe, expect, it } from "vitest";
import { getViewportForBounds, type Viewport } from "@xyflow/react";
import {
  decideGraphFit,
  decideGraphViewportAction,
  graphFitDuration,
  graphFitRetryDelay,
  graphFitMaxZoom,
  graphFitPadding,
  graphMinZoom,
  graphNodesMeasured,
  graphViewportKey,
  isGraphFlowMounted,
  magnifierContentTransform,
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

describe("magnifierContentTransform", () => {
  it("keeps the final node size stable while the graph is zoomed out", () => {
    const lowZoom = magnifierContentTransform({
      height: 480,
      lensSize: 236,
      pointerX: 120,
      pointerY: 90,
      viewport: { x: 0, y: 0, zoom: 0.35 },
      width: 640,
    });
    const highZoom = magnifierContentTransform({
      height: 480,
      lensSize: 236,
      pointerX: 120,
      pointerY: 90,
      viewport: { x: 0, y: 0, zoom: 1 },
      width: 640,
    });

    expect(lowZoom.scale * 0.35).toBeCloseTo(highZoom.scale);
    expect(lowZoom.scale * 0.35).toBeCloseTo(1.45);
  });

  it("keeps a real magnification at the graph max zoom", () => {
    const maxZoom = magnifierContentTransform({
      height: 480,
      lensSize: 236,
      pointerX: 120,
      pointerY: 90,
      viewport: { x: 0, y: 0, zoom: 1.8 },
      width: 640,
    });

    expect(maxZoom.scale).toBeGreaterThan(1);
    expect(maxZoom.scale).toBe(1.15);
  });

  it("centers the lens around the pointer with the normalized scale", () => {
    const result = magnifierContentTransform({
      height: 400,
      lensSize: 200,
      pointerX: 50,
      pointerY: 80,
      viewport: { x: 0, y: 0, zoom: 2 },
      width: 300,
    });

    expect(result.width).toBe(300);
    expect(result.height).toBe(400);
    expect(result.scale).toBe(1.15);
    expect(result.transform).toContain("translate(42.5");
    expect(result.transform).toContain(", 8px) scale(1.15)");
  });
});

describe("graphNodesMeasured", () => {
  it("reports false while no node carries both measures", () => {
    expect(graphNodesMeasured([])).toBe(false);
    expect(graphNodesMeasured([{}, { measured: {} }])).toBe(false);
    expect(graphNodesMeasured([{ measured: { width: 272 } }])).toBe(false);
    expect(graphNodesMeasured([{ measured: { width: 272, height: 0 } }])).toBe(false);
  });

  it("reports true as soon as one visible node is measured", () => {
    expect(graphNodesMeasured([{}, { measured: { width: 272, height: 196 } }])).toBe(true);
  });

  it("ignores hidden nodes, like the fitView filter does", () => {
    expect(graphNodesMeasured([{ hidden: true, measured: { width: 272, height: 196 } }])).toBe(false);
  });
});

describe("graphFitRetryDelay", () => {
  it("starts immediately and backs off", () => {
    expect(graphFitRetryDelay(0)).toBe(0);
    const delays = [0, 1, 2, 3, 4, 5].map((attempt) => graphFitRetryDelay(attempt) ?? -1);
    expect(delays.every((delay, index) => index === 0 || delay > delays[index - 1])).toBe(true);
  });

  it("gives up after the last attempt", () => {
    expect(graphFitRetryDelay(6)).toBeUndefined();
    expect(graphFitRetryDelay(99)).toBeUndefined();
  });
});

describe("graphFitDuration", () => {
  it("keeps the requested duration while the document paints", () => {
    expect(graphFitDuration(320, false)).toBe(320);
    expect(graphFitDuration(0, false)).toBe(0);
  });

  it("drops the animation when the document is hidden", () => {
    expect(graphFitDuration(320, true)).toBe(0);
  });
});

describe("decideGraphFit", () => {
  const bounds = { x: 0, y: 0, width: 1000, height: 500 };
  const size = { width: 500, height: 400 };
  const fit = (overrides: Partial<Parameters<typeof decideGraphFit>[0]> = {}) => decideGraphFit({
    attempt: 0,
    bounds,
    documentHidden: false,
    duration: 320,
    measured: true,
    size,
    ...overrides,
  });

  it("frames the graph with the shared zoom and padding limits", () => {
    const decision = fit();
    expect(decision).toEqual({
      kind: "apply",
      viewport: getViewportForBounds(bounds, size.width, size.height, graphMinZoom, graphFitMaxZoom, graphFitPadding),
      duration: 320,
    });
    if (decision.kind !== "apply") throw new Error("expected an applied fit");
    expect(decision.viewport.zoom).toBeGreaterThanOrEqual(graphMinZoom);
    expect(decision.viewport.zoom).toBeLessThanOrEqual(graphFitMaxZoom);
    const centerX = decision.viewport.x + (bounds.x + bounds.width / 2) * decision.viewport.zoom;
    const centerY = decision.viewport.y + (bounds.y + bounds.height / 2) * decision.viewport.zoom;
    expect(centerX).toBeCloseTo(size.width / 2, 6);
    expect(centerY).toBeCloseTo(size.height / 2, 6);
  });

  it("clamps a tiny graph to the fit zoom, not to the interactive maximum", () => {
    const decision = fit({ bounds: { x: 0, y: 0, width: 100, height: 50 } });
    if (decision.kind !== "apply") throw new Error("expected an applied fit");
    expect(decision.viewport.zoom).toBe(graphFitMaxZoom);
  });

  it("clamps a huge graph to the minimum zoom", () => {
    const decision = fit({ bounds: { x: 0, y: 0, width: 20000, height: 9000 } });
    if (decision.kind !== "apply") throw new Error("expected an applied fit");
    expect(decision.viewport.zoom).toBe(graphMinZoom);
  });

  it("drops the animation while the document is hidden", () => {
    const decision = fit({ documentHidden: true });
    expect(decision.kind).toBe("apply");
    if (decision.kind !== "apply") return;
    expect(decision.duration).toBe(0);
  });

  it("retries instead of framing while nothing is measured", () => {
    expect(fit({ measured: false })).toEqual({ kind: "retry", delay: graphFitRetryDelay(1) });
  });

  it("retries while the container or the bounds are still empty", () => {
    expect(fit({ size: { width: 0, height: 0 } })).toEqual({ kind: "retry", delay: graphFitRetryDelay(1) });
    expect(fit({ size: undefined })).toEqual({ kind: "retry", delay: graphFitRetryDelay(1) });
    expect(fit({ bounds: { x: 0, y: 0, width: 0, height: 0 } })).toEqual({ kind: "retry", delay: graphFitRetryDelay(1) });
    expect(fit({ bounds: undefined })).toEqual({ kind: "retry", delay: graphFitRetryDelay(1) });
    expect(fit({ attempt: 2, measured: false })).toEqual({ kind: "retry", delay: graphFitRetryDelay(3) });
  });

  it("abandons the fit once the ladder runs out, so no key is marked as applied", () => {
    expect(fit({ attempt: 5, measured: false })).toEqual({ kind: "abandon" });
    expect(fit({ attempt: 99, measured: false })).toEqual({ kind: "abandon" });
  });
});
