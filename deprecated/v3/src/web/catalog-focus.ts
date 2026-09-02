import type { RunSummary } from "../shared/protocol";

export type CatalogProjectWithRuns = { id: string; runs: RunSummary[] };
export type CatalogRunFocus = { projectId: string; runId: string };
export type CatalogChange = CatalogRunFocus & { type?: string; observedAt?: string };

export type CatalogFocusOptions = {
  focus?: CatalogRunFocus;
  currentProjectId?: string;
  knownRunIds?: ReadonlySet<string>;
};

export type CatalogChangeContext = {
  change: CatalogChange;
  visibleProjectId: string;
  visibleRunId: string;
};

export type CatalogChangeResolution = {
  focus?: CatalogRunFocus;
  shouldReloadDetail: boolean;
};

export function collectCatalogRunIds(projects: CatalogProjectWithRuns[]): Set<string> {
  return new Set(projects.flatMap((project) => project.runs.map((run) => run.id)));
}

export function resolveCatalogRunFocus(projects: CatalogProjectWithRuns[], { focus, currentProjectId, knownRunIds }: CatalogFocusOptions): CatalogRunFocus | undefined {
  let detectedNewRun: CatalogRunFocus | undefined;
  let detectedNewRunCreatedAt = -Infinity;
  let explicitFocus: CatalogRunFocus | undefined;
  for (const project of projects) {
    for (const run of project.runs) {
      if (focus?.runId === run.id && project.id === currentProjectId) explicitFocus = { projectId: project.id, runId: run.id };
      if (project.id === currentProjectId && knownRunIds && !knownRunIds.has(run.id)) {
        const createdAt = Date.parse(run.createdAt);
        if (createdAt > detectedNewRunCreatedAt) {
          detectedNewRun = { projectId: project.id, runId: run.id };
          detectedNewRunCreatedAt = createdAt;
        }
      }
    }
  }
  return explicitFocus ?? detectedNewRun;
}

export function resolveCatalogChange({ change, visibleProjectId, visibleRunId }: CatalogChangeContext): CatalogChangeResolution {
  return {
    focus: change.type === "run-created" && change.runId && change.projectId === visibleProjectId
      ? { projectId: change.projectId, runId: change.runId }
      : undefined,
    shouldReloadDetail: Boolean(visibleRunId && change.runId === visibleRunId),
  };
}
