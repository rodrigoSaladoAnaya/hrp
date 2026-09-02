import { getViewportForBounds, type Rect, type Viewport } from "@xyflow/react";

// Vistas principales del run, en el orden en que las recorren los atajos.
export type GraphView = "issue" | "map" | "activity" | "findings";

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

export const graphMinZoom = 0.25;
export const graphMaxZoom = 1.8;
export const graphFitMaxZoom = 1;
export const graphFitPadding = 0.22;

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

export type MeasurableNode = {
  hidden?: boolean;
  measured?: { width?: number; height?: number };
};

const graphFitRetryDelays = [0, 60, 150, 400, 1000, 2000];

export function graphNodesMeasured(nodes: MeasurableNode[]): boolean {
  return nodes.some((node) => !node.hidden && Boolean(node.measured?.width) && Boolean(node.measured?.height));
}

export function graphFitRetryDelay(attempt: number): number | undefined {
  return graphFitRetryDelays[attempt];
}

export function graphFitDuration(requested: number, documentHidden: boolean): number {
  return documentHidden ? 0 : requested;
}

export type GraphFitDecision =
  | { kind: "apply"; viewport: Viewport; duration: number }
  | { kind: "retry"; delay: number }
  | { kind: "abandon" };

export function decideGraphFit({
  attempt,
  bounds,
  documentHidden,
  duration,
  measured,
  size,
}: {
  attempt: number;
  bounds?: Rect;
  documentHidden: boolean;
  duration: number;
  measured: boolean;
  size?: { width?: number; height?: number };
}): GraphFitDecision {
  if (measured && size?.width && size.height && bounds?.width && bounds.height) {
    return {
      kind: "apply",
      viewport: getViewportForBounds(bounds, size.width, size.height, graphMinZoom, graphFitMaxZoom, graphFitPadding),
      duration: graphFitDuration(duration, documentHidden),
    };
  }
  const delay = graphFitRetryDelay(attempt + 1);
  return delay === undefined ? { kind: "abandon" } : { kind: "retry", delay };
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
