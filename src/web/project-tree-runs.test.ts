import { describe, expect, it } from "vitest";
import type { RunSummary } from "../shared/protocol";
import { resolveProjectRunListState, resolveVisibleProjectRuns, shouldShowProjectRunToggle } from "./project-tree-runs";

function run(index: number): RunSummary {
  return {
    id: `run-${index}`,
    projectId: "project-1",
    title: `Run ${index}`,
    status: "closed",
    phase: "closed",
    control: "active",
    branch: "hrp/run-x",
    issuePath: "/tmp/issue.md",
    attachments: [],
    acceptance: [],
    continuedBy: [],
    extensions: [],
    nodeCount: 1,
    completedCount: 1,
    runningCount: 0,
    failedCount: 0,
    openFindings: 0,
    attachedSessions: [],
    audit: { unauditedNodeIds: [], okVotes: [], rejectVotes: [], pendingVoters: [], liveFindings: 0, distinctFamilies: [], canClose: false, blockers: [] },
    createdAt: `2026-08-21T00:${String(index).padStart(2, "0")}:00.000Z`,
    updatedAt: `2026-08-21T00:${String(index).padStart(2, "0")}:00.000Z`,
  };
}

describe("resolveVisibleProjectRuns", () => {
  it("shows short lists without hidden runs", () => {
    const runs = [run(1), run(2), run(3)];

    const result = resolveVisibleProjectRuns(runs, { runId: "", expanded: false, limit: 5 });

    expect(result.visibleRuns.map((item) => item.id)).toEqual(["run-1", "run-2", "run-3"]);
    expect(result.hiddenRuns).toBe(0);
  });

  it("limits long collapsed lists to the preview size", () => {
    const runs = Array.from({ length: 8 }, (_, index) => run(index + 1));

    const result = resolveVisibleProjectRuns(runs, { runId: "", expanded: false, limit: 5 });

    expect(result.visibleRuns.map((item) => item.id)).toEqual(["run-1", "run-2", "run-3", "run-4", "run-5"]);
    expect(result.hiddenRuns).toBe(3);
  });

  it("uses the production preview limit by default", () => {
    const runs = Array.from({ length: 8 }, (_, index) => run(index + 1));

    const result = resolveVisibleProjectRuns(runs, { runId: "", expanded: false });

    expect(result.visibleRuns.map((item) => item.id)).toEqual(["run-1", "run-2", "run-3", "run-4", "run-5"]);
    expect(result.hiddenRuns).toBe(3);
  });

  it("shows every run when expanded", () => {
    const runs = Array.from({ length: 8 }, (_, index) => run(index + 1));

    const result = resolveVisibleProjectRuns(runs, { runId: "", expanded: true, limit: 5 });

    expect(result.visibleRuns.map((item) => item.id)).toEqual(runs.map((item) => item.id));
    expect(result.hiddenRuns).toBe(0);
  });

  it("keeps a selected run visible without changing the source order", () => {
    const runs = Array.from({ length: 8 }, (_, index) => run(index + 1));

    const result = resolveVisibleProjectRuns(runs, { runId: "run-7", expanded: false, limit: 5 });

    expect(result.visibleRuns.map((item) => item.id)).toEqual(["run-1", "run-2", "run-3", "run-4", "run-5", "run-7"]);
    expect(result.hiddenRuns).toBe(2);
  });
});

describe("shouldShowProjectRunToggle", () => {
  it("shows the toggle only when the run count exceeds the default limit", () => {
    expect(shouldShowProjectRunToggle(0)).toBe(false);
    expect(shouldShowProjectRunToggle(1)).toBe(true);
  });

  it("hides the toggle when a selected run leaves nothing hidden", () => {
    const runs = Array.from({ length: 6 }, (_, index) => run(index + 1));
    const result = resolveVisibleProjectRuns(runs, { runId: "run-6", expanded: false });

    expect(result.hiddenRuns).toBe(0);
    expect(shouldShowProjectRunToggle(result.hiddenRuns)).toBe(false);
  });
});

describe("resolveProjectRunListState", () => {
  it("keeps the expanded toggle only when collapsed state would hide runs", () => {
    const runs = Array.from({ length: 8 }, (_, index) => run(index + 1));

    const result = resolveProjectRunListState(runs, { runId: "", expanded: true });

    expect(result.visibleRuns).toHaveLength(8);
    expect(result.hiddenRuns).toBe(0);
    expect(result.collapsedHiddenRuns).toBe(3);
    expect(result.canToggleRuns).toBe(true);
  });

  it("hides the expanded toggle when the selected run leaves nothing to hide", () => {
    const runs = Array.from({ length: 6 }, (_, index) => run(index + 1));

    const result = resolveProjectRunListState(runs, { runId: "run-6", expanded: true });

    expect(result.visibleRuns).toHaveLength(6);
    expect(result.hiddenRuns).toBe(0);
    expect(result.collapsedHiddenRuns).toBe(0);
    expect(result.canToggleRuns).toBe(false);
  });
});
