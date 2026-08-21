import { computeAuditorConsensus, type RunDetail } from "../shared/protocol.js";

// Señales que una ejecución puede dar a un agente concreto, declaradas en
// orden de prioridad: las cuatro primeras exigen acción inmediata, las
// siguientes explican por qué conviene seguir atento, y las últimas cierran la
// espera. El orden ES la prioridad (attentionRank), así que una señal nueva
// obliga a elegir su lugar aquí en vez de heredar un rango por omisión en otro
// archivo.
export const attentionKinds = [
  "findings", "work", "audit", "gate",
  "paused", "blocked", "busy", "implementation", "auditors", "review-pass",
  "stopped", "done", "idle",
] as const;
export type AttentionKind = (typeof attentionKinds)[number];

export function attentionRank(kind: AttentionKind): number {
  return attentionKinds.indexOf(kind);
}

// Resolutor único de "qué debe hacer este agente ahora". Vive en el servidor
// porque las tres vías de aviso —el CLI, los hooks nativos de cada modelo y la
// herramienta MCP— deben responder exactamente lo mismo; cuando esta regla
// vivía dentro del bucle del CLI, ningún despertador podía reutilizarla.
export type Attention = {
  runId: string;
  projectId: string;
  agent: string;
  kind: AttentionKind;
  // Hay trabajo que el agente debe hacer ahora mismo.
  actionable: boolean;
  // La ejecución ya no producirá más señales para él: dejar de esperar.
  terminal: boolean;
  // Sigue viva y volverá a tener trabajo para él: conviene seguir atento.
  waiting: boolean;
  directive: string;
  // Auditores que aún no cierran su pasada; lista informativa completa.
  pendingAuditors: string[];
  // Votos OK que faltan para alcanzar mayoría; este número bloquea el cierre.
  pendingAuditorVotes: number;
};

const flags: Record<AttentionKind, { actionable: boolean; terminal: boolean; waiting: boolean }> = {
  findings: { actionable: true, terminal: false, waiting: false },
  work: { actionable: true, terminal: false, waiting: false },
  audit: { actionable: true, terminal: false, waiting: false },
  gate: { actionable: true, terminal: false, waiting: false },
  stopped: { actionable: false, terminal: true, waiting: false },
  done: { actionable: false, terminal: true, waiting: false },
  paused: { actionable: false, terminal: false, waiting: true },
  blocked: { actionable: false, terminal: false, waiting: true },
  busy: { actionable: false, terminal: false, waiting: true },
  implementation: { actionable: false, terminal: false, waiting: true },
  auditors: { actionable: false, terminal: false, waiting: true },
  "review-pass": { actionable: false, terminal: false, waiting: true },
  idle: { actionable: false, terminal: false, waiting: false },
};

// Los nodos sin asignación pertenecen exclusivamente al modelo base. Los
// asignados a ollama también los administra el base porque no abren sesión.
export function nodesForAgent(detail: RunDetail, agent: string) {
  return detail.nodes.filter((node) => node.assignee === agent
    || (detail.run.baseAgent === agent && !node.assignee)
    || (node.assignee === "ollama" && detail.run.baseAgent === agent));
}

// Lo que un auditor debe revisar es el trabajo de los demás: el contrato le
// prohíbe auditarse a sí mismo. Un agente que implementa y audita en la misma
// ejecución cierra su pasada sobre este subconjunto, no sobre el run entero.
export function auditableNodes(detail: RunDetail, agent: string) {
  return detail.nodes.filter((node) => (node.executedBy ?? node.assignee) !== agent);
}

export function computeAttention(detail: RunDetail, agent: string): Attention {
  const { run } = detail;
  const isAuditor = run.auditors.includes(agent);
  const allCompleted = detail.nodes.length > 0 && detail.nodes.every((node) => node.status === "completed");
  const auditorState = isAuditor ? detail.agentStates.find((state) => state.agent === agent) : undefined;
  // Hallazgos que impiden cerrar: los mismos que bloquean 'hrp review gate'.
  const liveFindings = detail.findings.filter((finding) => finding.status === "open" || finding.status === "debating" || finding.status === "escalated");
  const auditorConsensus = computeAuditorConsensus(detail.run.auditors, allCompleted ? detail.agentStates : []);
  const pendingAuditors = auditorConsensus.pendingAuditors;
  const pendingAuditorVotes = auditorConsensus.pendingAuditorVotes;
  const decide = (kind: AttentionKind, directive: string): Attention => ({
    runId: run.id,
    projectId: run.projectId,
    agent,
    kind,
    directive,
    pendingAuditors,
    pendingAuditorVotes,
    ...flags[kind],
  });

  if (run.control === "stopped") {
    return decide("stopped", "La ejecución fue detenida por el humano; no inicies más nodos y reporta tu avance.");
  }

  // Un debate donde el último turno no es del base le exige respuesta antes
  // que cualquier otro trabajo: la calidad del run depende de cerrarlo.
  const debates = run.baseAgent === agent
    ? detail.findings.filter((finding) => {
      if (finding.status !== "open" && finding.status !== "debating") return false;
      const lastMessage = finding.messages[finding.messages.length - 1];
      return !lastMessage || lastMessage.author !== agent;
    })
    : [];
  if (debates.length && run.control === "active") {
    return decide("findings", `Hallazgos por atender (${debates.length}): ${debates.map((finding) => finding.id).join(", ")}. Lee cada uno con 'hrp finding show <id>' y responde con 'hrp finding reply <id> --author ${agent} --body ...'; acepta creando un nodo de corrección (hrp node discover + hrp finding accept --resolution-node ID), rebate con argumentos técnicos o reabre un cierre con 'hrp finding reopen <id> --author ${agent} --body RAZON'. Tras dos rondas sin evidencia nueva, 'hrp finding escalate <id>'.`);
  }

  // Al terminar la implementación, una sesión revisora que estaba bloqueada
  // recibe una instrucción accionable. No se apropia de nodos del agente base.
  if (allCompleted && isAuditor && auditorState?.phase !== "completed") {
    // La cobertura se declara sobre lo ajeno: pedirle los propios sería pedirle
    // que se autoaudite, y el gate luego rechazaría ese cierre.
    const auditable = auditableNodes(detail, agent);
    const auditableIds = new Set(auditable.map((node) => node.id));
    const reviewed = (auditorState?.reviewedNodeIds ?? []).filter((nodeId) => auditableIds.has(nodeId));
    const reviewedFlag = reviewed.length ? ` --reviewed ${reviewed.join(",")}` : "";
    const remaining = (auditorState?.remainingNodeIds ?? []).filter((nodeId) => auditableIds.has(nodeId));
    const pendientes = remaining.length ? remaining : auditable.map((node) => node.id);
    const propios = detail.nodes.length - auditable.length;
    return decide("audit", `Auditoría disponible para ${agent}. Publica el inicio con 'hrp agent status ${run.id} --agent ${agent} --phase reviewing --summary "Auditando la ejecución" --completed ${reviewed.length} --total ${auditable.length}${reviewedFlag} --remaining ${pendientes.join(",")}', obtén el contexto con 'hrp review pack ${run.id}', registra o debate hallazgos y, si estás conforme, vota OK cerrando con phase completed llevando --reviewed con ellos y --remaining vacío. Si un cierre previo no te convence, usa 'hrp finding reopen <id> --author ${agent} --body RAZON'.${propios ? ` Tus ${propios} nodos propios quedan fuera: no te autoaudites.` : ""}`);
  }

  // El workspace ejecuta un nodo a la vez, así que mientras haya uno en vuelo
  // 'hrp node start' rechaza cualquier otro. Para su dueño eso sí es trabajo
  // accionable —es el agente que lo dejó a medias y hay que despertarlo para
  // que lo cierre—; para el resto es una espera, no una orden imposible.
  const running = detail.nodes.find((node) => node.status === "running");
  if (running && run.control === "active") {
    const owners = new Set(nodesForAgent(detail, agent).map((node) => node.id));
    if (running.executedBy === agent && !owners.has(running.id)) {
      return decide("busy", `Apareces como ejecutor de ${running.id}, pero ese nodo ya no está asignado a ${agent}. Deja de trabajarlo, relee 'hrp state ${run.id} --json' y espera la nueva señal de HRP.`);
    }
    if (owners.has(running.id) || running.executedBy === agent) {
      return decide("work", `Tienes ${running.id} en curso (${running.file} · ${running.symbol}): ciérralo con patch, verify y complete antes de tomar otro nodo.`);
    }
    return decide("busy", `La ejecución trabaja un nodo a la vez y ahora corre ${running.id} con ${running.executedBy ?? running.assignee ?? "otro agente"}. Permanece atento: la señal llegará sola cuando termine.`);
  }

  const orphanedExecution = detail.nodes.find((node) => node.executedBy === agent
    && node.status !== "completed"
    && !nodesForAgent(detail, agent).some((candidate) => candidate.id === node.id));
  if (orphanedExecution && run.control === "active") {
    return decide("busy", `Apareces como ejecutor previo de ${orphanedExecution.id}, pero ya no te pertenece. No sigas trabajando en ese nodo: relee 'hrp state ${run.id} --json' y espera la señal actualizada de HRP.`);
  }

  // Anunciar un nodo cuyas dependencias siguen abiertas es una orden imposible:
  // 'hrp node start' lo rechaza con la misma regla, así que la señal aplica ese
  // filtro y solo nombra trabajo que el servidor aceptará iniciar.
  const completedIds = new Set(detail.nodes.filter((node) => node.status === "completed").map((node) => node.id));
  const pendingForAgent = nodesForAgent(detail, agent).filter((node) => node.approved && node.status !== "completed");
  const ready = pendingForAgent.filter((node) => node.dependencies.every((dependency) => completedIds.has(dependency)));
  if (ready.length && run.control === "active") {
    return decide("work", `Aprobado: ${ready.length} ${ready.length === 1 ? "nodo disponible" : "nodos disponibles"} (${ready.map((node) => node.id).join(", ")})`);
  }
  if (pendingForAgent.length && run.control === "active") {
    // Solo interesan los prerrequisitos ajenos: los que el propio agente tiene
    // pendientes se resolverán con su siguiente nodo, no son la causa de la espera.
    const ownIds = new Set(pendingForAgent.map((node) => node.id));
    const missing = [...new Set(pendingForAgent.flatMap((node) => node.dependencies.filter((dependency) => !completedIds.has(dependency))))];
    const blockers = missing.filter((dependency) => !ownIds.has(dependency));
    return decide("blocked", `Tu trabajo aprobado (${pendingForAgent.map((node) => node.id).join(", ")}) espera prerrequisitos sin terminar: ${(blockers.length ? blockers : missing).join(", ")}. Permanece atento: la señal llegará sola cuando cierren.`);
  }

  if (run.control === "paused") {
    return decide("paused", "Ejecución pausada por el humano; puede estar reconfigurando asignaciones o auditores. Al reanudar, relee 'hrp state' antes de retomar porque tu nodo en curso puede haber cambiado de dueño.");
  }

  if (isAuditor && !allCompleted) {
    return decide("implementation", "Auditor conectado; esperando que el agente base complete la implementación.");
  }

  if (allCompleted && run.baseAgent === agent) {
    if (pendingAuditorVotes > 0) {
      return decide("auditors", `Implementación terminada; faltan ${pendingAuditorVotes} ${pendingAuditorVotes === 1 ? "voto" : "votos"} de auditoría para mayoría. Sin voto todavía: ${pendingAuditors.join(", ")}.`);
    }
    // 'gate' es una orden accionable, así que solo se emite mientras quede algo
    // que cerrar. Una ejecución terminada sin hallazgos vivos ya no reclama
    // nada: si siguiera pidiendo el gate, el despertador nunca dejaría en paz
    // al agente por trabajo que no existe.
    if (liveFindings.length) {
      return decide("gate", "Implementación terminada; ejecuta 'hrp review gate' para ver los hallazgos vivos que aún bloquean el cierre.");
    }
    return decide("done", "La ejecución ya está completa.");
  }

  if (allCompleted && isAuditor) {
    return decide("review-pass", "Auditoría terminada; esperando una corrección que requiera otra pasada.");
  }

  if (allCompleted) {
    return decide("done", "La ejecución ya está completa.");
  }

  // Sin nada asignado ahora mismo, pero la ejecución sigue viva: el agente
  // debe permanecer atento porque otro nodo o un hallazgo puede liberarle
  // trabajo sin que nadie se lo pida.
  const pendingWork = detail.nodes.some((node) => node.status !== "completed");
  return {
    ...decide("idle", pendingWork
      ? `Sin trabajo disponible para ${agent} por ahora; la ejecución sigue activa.`
      : `Sin trabajo disponible para ${agent} en esta ejecución.`),
    waiting: pendingWork,
  };
}
