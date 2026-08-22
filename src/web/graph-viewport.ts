import type { Viewport } from "@xyflow/react";

export type GraphView = "map" | "activity" | "findings";

export type StoredGraphViewport = {
  nodeSetKey: string;
  viewport: Viewport;
};

export type MagnifierContentTransform = {
  width: number;
  height: number;
  scale: number;
  transform: string;
};

export type GraphViewportAction =
  | { kind: "fit"; graphKey: string }
  | { kind: "restore"; graphKey: string; viewport: Viewport }
  | { kind: "skip" };

export function graphViewportKey(runId: string, nodeSetKey: string): string {
  return `${runId}:${nodeSetKey}`;
}

export function decideGraphViewportAction({
  appliedKey,
  nodeSetKey,
  runId,
  saved,
}: {
  appliedKey: string;
  nodeSetKey: string;
  runId: string;
  saved?: StoredGraphViewport;
}): GraphViewportAction {
  if (!runId || !nodeSetKey) return { kind: "skip" };
  const graphKey = graphViewportKey(runId, nodeSetKey);
  if (appliedKey === graphKey) return { kind: "skip" };
  if (saved?.nodeSetKey === nodeSetKey) return { kind: "restore", graphKey, viewport: saved.viewport };
  return { kind: "fit", graphKey };
}

export function shouldPersistGraphViewport({
  nodeSetKey,
  runId,
  userMoved,
}: {
  nodeSetKey: string;
  runId: string;
  userMoved: boolean;
}): boolean {
  return userMoved && Boolean(runId) && Boolean(nodeSetKey);
}

export function isGraphFlowMounted(view: GraphView, nodeCount: number | undefined): boolean {
  return view === "map" && Boolean(nodeCount);
}

export function magnifierContentTransform({
  height,
  lensSize,
  pointerX,
  pointerY,
  viewport,
  width,
  targetScale = 1.45,
  minScale = 1.15,
}: {
  height: number;
  lensSize: number;
  pointerX: number;
  pointerY: number;
  viewport: Viewport;
  width: number;
  targetScale?: number;
  minScale?: number;
}): MagnifierContentTransform {
  const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
  const scale = Math.max(targetScale / zoom, minScale);
  return {
    width,
    height,
    scale,
    transform: `translate(${lensSize / 2 - pointerX * scale}px, ${lensSize / 2 - pointerY * scale}px) scale(${scale})`,
  };
}
