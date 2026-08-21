import type { Viewport } from "@xyflow/react";

export type GraphView = "map" | "activity" | "findings";

export type StoredGraphViewport = {
  nodeSetKey: string;
  viewport: Viewport;
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
