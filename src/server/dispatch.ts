import { delegateLane, isDelegateAgent, laneModel, modelForDifficulty, type ChangeNode, type DelegateTiers, type RunDetail } from "../shared/protocol.js";
import { concurrentConflict } from "./attention.js";

// Cuántos carriles delegados se lanzan de una vez. El tope no es una regla de
// seguridad —de eso se ocupan las reglas de conflicto— sino un límite práctico:
// un lote enorme satura la cuota del proveedor y vuelve ilegible la revisión.
export const DEFAULT_MAX_LANES = 3;

export type DispatchAssignment = {
  nodeId: string;
  // Identidad ejecutora con la que se arranca el nodo: 'ollama:<modelo>'.
  lane: string;
  model: string;
};

export type DispatchSkip = {
  nodeId: string;
  reason: string;
};

export type DispatchPlan = {
  batch: DispatchAssignment[];
  skipped: DispatchSkip[];
};

export type DispatchOptions = {
  settings: { model: string; tiers?: DelegateTiers };
  maxLanes?: number;
};

// Decide qué nodos delegados pueden generarse a la vez. Es una función pura: no
// habla con la red ni con el store, así que el lote se puede probar sin gastar
// una sola llamada al proveedor. El servidor sigue siendo la autoridad —vuelve
// a validar cada 'start'—, pero planear con la misma regla evita proponer un
// par que se pisaría sobre el mismo archivo.
export function planDispatch(detail: RunDetail, options: DispatchOptions): DispatchPlan {
  const maxLanes = Math.max(1, options.maxLanes ?? DEFAULT_MAX_LANES);
  const nodesById = new Map(detail.nodes.map((node) => [node.id, node]));
  const inFlight = detail.nodes.filter((node) => node.status === "running");
  const busyLanes = new Set(inFlight
    .map((node) => node.executedBy ?? node.assignee)
    .filter((agent): agent is string => Boolean(agent)));
  const batch: DispatchAssignment[] = [];
  const skipped: DispatchSkip[] = [];
  const chosen: ChangeNode[] = [];

  for (const node of detail.nodes) {
    if (!isDelegateAgent(node.assignee)) continue;
    if (node.status === "completed" || node.status === "running") continue;
    const skip = (reason: string) => skipped.push({ nodeId: node.id, reason });

    if (detail.run.control !== "active") {
      skip(detail.run.control === "paused"
        ? "la ejecución está pausada por el humano"
        : "la ejecución fue detenida por el humano");
      continue;
    }
    if (!node.approved) {
      skip("espera la aprobación humana");
      continue;
    }
    const blockers = node.dependencies.filter((id) => nodesById.get(id)?.status !== "completed");
    if (blockers.length) {
      skip(`dependencias incompletas: ${blockers.join(", ")}`);
      continue;
    }
    const running = inFlight
      .map((candidate) => ({ candidate, reason: concurrentConflict(node, candidate, nodesById) }))
      .find((item) => item.reason);
    if (running) {
      skip(`conflicto con el nodo en curso ${running.candidate.id}: ${running.reason}`);
      continue;
    }
    const sibling = chosen
      .map((candidate) => ({ candidate, reason: concurrentConflict(node, candidate, nodesById) }))
      .find((item) => item.reason);
    if (sibling) {
      skip(`conflicto con ${sibling.candidate.id}, ya elegido en este lote: ${sibling.reason}`);
      continue;
    }
    // El carril declarado manda; si el nodo sólo dice 'ollama', lo decide su
    // dificultad. Dos niveles con el mismo modelo comparten carril, y por eso
    // el paralelismo real lo da el número de modelos configurados.
    const declared = laneModel(node.assignee);
    const model = declared ?? modelForDifficulty({ model: options.settings.model, tiers: options.settings.tiers ?? {} }, node.difficulty);
    const lane = declared ? node.assignee! : delegateLane(model);
    if (busyLanes.has(lane)) {
      skip(`el carril ${lane} ya sostiene un nodo; sólo un nodo por identidad ejecutora`);
      continue;
    }
    if (batch.length >= maxLanes) {
      skip(`tope de ${maxLanes} ${maxLanes === 1 ? "carril simultáneo" : "carriles simultáneos"}`);
      continue;
    }
    batch.push({ nodeId: node.id, lane, model });
    chosen.push(node);
    busyLanes.add(lane);
  }

  return { batch, skipped };
}
