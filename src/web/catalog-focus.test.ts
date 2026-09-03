import { describe, expect, it } from "vitest";
import type { RunSummary } from "../shared/protocol";
import { collectCatalogRunIds, resolveCatalogChange, resolveCatalogRunFocus, type CatalogProjectWithRuns } from "./catalog-focus";

function run(id: string, createdAt: string): RunSummary {
  return {
    id,
    projectId: "project",
    title: id,
    status: "open",
    phase: "open",
    control: "active",
    branch: "hrp/run-x",
    issuePath: "/tmp/issue.md",
    attachments: [],
    acceptance: [],
    continuedBy: [],
    extensions: [],
    nodeCount: 0,
    completedCount: 0,
    runningCount: 0,
    failedCount: 0,
    openFindings: 0,
    attachedSessions: [],
    audit: { unauditedNodeIds: [], okVotes: [], rejectVotes: [], pendingVoters: [], liveFindings: 0, distinctFamilies: [], canClose: false, blockers: [] },
    createdAt,
    updatedAt: createdAt,
  };
}

describe("resolveCatalogRunFocus", () => {
  const projects: CatalogProjectWithRuns[] = [
    { id: "current", runs: [run("newer", "2026-08-21T05:00:02.000Z"), run("known", "2026-08-21T05:00:00.000Z"), run("older", "2026-08-21T05:00:01.000Z")] },
    { id: "other", runs: [run("other-new", "2026-08-21T05:00:03.000Z")] },
  ];

  it("does not focus every run during the initial catalog load", () => {
    expect(resolveCatalogRunFocus(projects, { currentProjectId: "current" })).toBeUndefined();
  });

  it("uses an explicit run-created focus when it belongs to the visible project", () => {
    expect(resolveCatalogRunFocus(projects, {
      currentProjectId: "current",
      focus: { projectId: "current", runId: "older" },
      knownRunIds: new Set(["known"]),
    })).toEqual({ projectId: "current", runId: "older" });
  });

  it("does not move the panel to a new run from another project", () => {
    expect(resolveCatalogRunFocus(projects, {
      currentProjectId: "current",
      focus: { projectId: "other", runId: "other-new" },
      knownRunIds: new Set(["known", "newer", "older"]),
    })).toBeUndefined();
  });

  it("chooses the newest newly detected run in the visible project", () => {
    expect(resolveCatalogRunFocus(projects, {
      currentProjectId: "current",
      knownRunIds: new Set(["known"]),
    })).toEqual({ projectId: "current", runId: "newer" });
  });

  it("collects the current catalog run IDs for the next comparison", () => {
    expect([...collectCatalogRunIds(projects)].sort()).toEqual(["known", "newer", "older", "other-new"]);
  });
});

describe("resolveCatalogChange", () => {
  it("focuses a run-created event from the visible project", () => {
    expect(resolveCatalogChange({
      change: { type: "run-created", projectId: "current", runId: "new-run" },
      visibleProjectId: "current",
      visibleRunId: "old-run",
    })).toEqual({
      focus: { projectId: "current", runId: "new-run" },
      shouldReloadDetail: false,
    });
  });

  it("does not focus a run-created event from another project", () => {
    expect(resolveCatalogChange({
      change: { type: "run-created", projectId: "other", runId: "new-run" },
      visibleProjectId: "current",
      visibleRunId: "old-run",
    })).toEqual({ focus: undefined, shouldReloadDetail: false });
  });

  it("reloads detail only when the changed run is visible", () => {
    expect(resolveCatalogChange({
      change: { type: "graph-published", projectId: "current", runId: "visible-run" },
      visibleProjectId: "current",
      visibleRunId: "visible-run",
    })).toEqual({ focus: undefined, shouldReloadDetail: true });

    expect(resolveCatalogChange({
      change: { type: "graph-published", projectId: "current", runId: "other-run" },
      visibleProjectId: "current",
      visibleRunId: "visible-run",
    })).toEqual({ focus: undefined, shouldReloadDetail: false });
  });

  it("does not reload detail for project events when no run is visible", () => {
    expect(resolveCatalogChange({
      change: { type: "project-attached", projectId: "current", runId: "" },
      visibleProjectId: "current",
      visibleRunId: "",
    })).toEqual({ focus: undefined, shouldReloadDetail: false });
  });
});
