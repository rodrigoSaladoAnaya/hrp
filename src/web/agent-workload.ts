import type { ChangeNode } from "../shared/protocol.js";

type WorkloadNode = Pick<ChangeNode, "status" | "assignee" | "executedBy">;

// Lo que una identidad tiene por delante y lo que ya dejó hecho. Son dos cuentas
// distintas a propósito: la asignación dice qué falta y el ejecutor dice quién
// lo hizo, y un agente que terminó todo su reparto tiene cero de lo primero
// aunque haya implementado el grafo entero.
export type AgentWorkload = { pending: number; implemented: number };

// Quién hizo la operación: el ejecutor real manda sobre la asignación, y lo que
// nadie reclamó es del modelo base. Es la misma atribución que pinta la tarjeta
// del grafo, para que el dock no cuente otra historia que el mapa.
// Una ejecución sin modelo base declarado no le regala a nadie lo que nadie
// reclamó: sin base, esas operaciones no cuentan para ninguna identidad.
function executorOf(node: WorkloadNode, baseAgent?: string): string | undefined {
  return node.executedBy ?? node.assignee ?? baseAgent;
}

export function agentWorkload(nodes: WorkloadNode[], agent: string, baseAgent?: string): AgentWorkload {
  let pending = 0;
  let implemented = 0;
  for (const node of nodes) {
    // Una operación terminada ya no está asignada a nadie: pasa a la cuenta de
    // quien la ejecutó y sale del reparto pendiente.
    if (node.status === "completed") {
      if (executorOf(node, baseAgent) === agent) implemented += 1;
      continue;
    }
    if (node.assignee === agent || (agent === baseAgent && !node.assignee)) pending += 1;
  }
  return { pending, implemented };
}
