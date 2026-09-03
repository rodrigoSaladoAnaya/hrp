import type { RunSummary } from "./protocol.js";

type LinkedRun = Pick<RunSummary, "id" | "continues">;

// Antecesores de un run, del más antiguo al propio run. Un enlace roto o un
// ciclo corta la cadena en vez de colgar el panel.
export function runAncestors<T extends LinkedRun>(runs: T[], runId: string): T[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const chain: T[] = [];
  const seen = new Set<string>();
  let current = byId.get(runId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.continues ? byId.get(current.continues) : undefined;
  }
  return chain;
}

// Descendientes de un run en orden de creación (anchura primero): un run
// cerrado puede tener más de una continuación.
export function runDescendants<T extends LinkedRun>(runs: T[], runId: string): T[] {
  const result: T[] = [];
  const seen = new Set<string>([runId]);
  let frontier = [runId];
  while (frontier.length) {
    const next: string[] = [];
    for (const parent of frontier) {
      for (const run of runs) {
        if (run.continues !== parent || seen.has(run.id)) continue;
        seen.add(run.id);
        result.push(run);
        next.push(run.id);
      }
    }
    frontier = next;
  }
  return result;
}

// La historia completa de una implementación vista desde un run: sus
// antecesores, él mismo y lo que vino después.
export function runLineage<T extends LinkedRun>(runs: T[], runId: string): T[] {
  return [...runAncestors(runs, runId), ...runDescendants(runs, runId)];
}
