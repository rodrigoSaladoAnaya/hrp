import type { RunSummary } from "../shared/protocol";

export const projectTreeRunPreviewLimit = 5;

export function shouldShowProjectRunToggle(hiddenRuns: number): boolean {
  return hiddenRuns > 0;
}

export function resolveVisibleProjectRuns(
  runs: RunSummary[],
  options: { runId: string; expanded: boolean; limit?: number },
): { visibleRuns: RunSummary[]; hiddenRuns: number } {
  const limit = options.limit ?? projectTreeRunPreviewLimit;
  if (options.expanded || runs.length <= limit) return { visibleRuns: runs, hiddenRuns: 0 };
  const visibleRuns = runs.filter((run, index) => index < limit || run.id === options.runId);
  return { visibleRuns, hiddenRuns: Math.max(0, runs.length - visibleRuns.length) };
}

export function resolveProjectRunListState(
  runs: RunSummary[],
  options: { runId: string; expanded: boolean; limit?: number },
): { visibleRuns: RunSummary[]; hiddenRuns: number; collapsedHiddenRuns: number; canToggleRuns: boolean } {
  const current = resolveVisibleProjectRuns(runs, options);
  const collapsedHiddenRuns = options.expanded
    ? resolveVisibleProjectRuns(runs, { ...options, expanded: false }).hiddenRuns
    : current.hiddenRuns;
  return {
    ...current,
    collapsedHiddenRuns,
    canToggleRuns: shouldShowProjectRunToggle(collapsedHiddenRuns),
  };
}
