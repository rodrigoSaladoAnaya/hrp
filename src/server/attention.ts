import { isLiveFinding, isUnresolvedAcceptance, runIsOnHold, type Finding, type RunDetail, type Session } from "../shared/protocol.js";

// Directivas que puede recibir una sesión, en orden de prioridad. Las cinco
// primeras exigen acción; 'resume' recuerda al base que el run sigue abierto;
// las de espera explican por qué conviene seguir atento; 'released' cierra la
// espera. El orden ES la prioridad (attentionRank).
export const attentionKinds = [
  "hold", "finding", "requirement", "node", "close",
  "resume",
  "wait", "paused",
  "released", "idle",
] as const;
export type AttentionKind = (typeof attentionKinds)[number];

export function attentionRank(kind: AttentionKind): number {
  return attentionKinds.indexOf(kind);
}

export type Attention = {
  runId: string;
  projectId: string;
  workspaceRoot: string;
  branch: string;
  session: string;
  role: Session["role"];
  kind: AttentionKind;
  actionable: boolean;
  terminal: boolean;
  waiting: boolean;
  directive: string;
};

const flags: Record<AttentionKind, { actionable: boolean; terminal: boolean; waiting: boolean }> = {
  hold: { actionable: true, terminal: false, waiting: false },
  finding: { actionable: true, terminal: false, waiting: false },
  requirement: { actionable: true, terminal: false, waiting: false },
  node: { actionable: true, terminal: false, waiting: false },
  close: { actionable: true, terminal: false, waiting: false },
  resume: { actionable: true, terminal: false, waiting: false },
  wait: { actionable: false, terminal: false, waiting: true },
  paused: { actionable: false, terminal: false, waiting: true },
  released: { actionable: false, terminal: true, waiting: false },
  idle: { actionable: false, terminal: false, waiting: false },
};

function lastAuthor(finding: Finding): string | undefined {
  return finding.messages[finding.messages.length - 1]?.author;
}

function list(ids: string[]): string {
  return ids.join(", ");
}

export function computeAttention(detail: RunDetail, sessionId: string): Attention {
  const { run, project } = detail;
  const session = detail.sessions.find((candidate) => candidate.id === sessionId);
  const decide = (kind: AttentionKind, directive: string): Attention => ({
    runId: run.id,
    projectId: run.projectId,
    workspaceRoot: project.workspaceRoot,
    branch: run.branch,
    session: sessionId,
    role: session?.role ?? "auditor",
    kind,
    directive,
    ...flags[kind],
  });

  if (!session) return decide("idle", `${sessionId} no está enganchada a ${run.id}.`);
  if (session.status === "released" || run.status === "closed" || run.control === "stopped") {
    const why = run.status === "closed" ? "el run cerró" : run.control === "stopped" ? "el humano detuvo el run" : "tu atención fue liberada";
    return decide("released", `Suelta ${run.id}: ${why}. No queda nada que hacer en él.`);
  }
  if (run.control === "paused") {
    return decide("paused", `El humano pausó ${run.id}; espera a que lo reanude.`);
  }

  const live = detail.findings.filter(isLiveFinding);
  const where = `(${project.workspaceRoot}, rama ${run.branch})`;

  if (session.role === "base") {
    if (runIsOnHold(detail.findings)) {
      const critical = live.filter((finding) => finding.severity === "critical").map((finding) => finding.id);
      return decide("hold", `Run en hold por hallazgo crítico: ${list(critical)}. Léelo con hrp_finding_show y resuélvelo antes de abrir otro nodo: acéptalo con hrp_finding_accept y abre el nodo de corrección con hrp_node_open (resolves), o recházalo con razón con hrp_finding_reject.`);
    }
    const awaiting = live.filter((finding) => finding.status !== "escalated" && lastAuthor(finding) !== sessionId);
    if (awaiting.length) {
      return decide("finding", `Hallazgos por atender (${awaiting.length}): ${list(awaiting.map((finding) => finding.id))}. Lee cada uno con hrp_finding_show; acepta con hrp_finding_accept y corrige en un nodo (hrp_node_open con resolves), rebate con hrp_finding_reply o rechaza con razón con hrp_finding_reject. Tras dos rondas sin evidencia nueva, hrp_finding_escalate.`);
    }
    const pendingCorrections = detail.findings.filter((finding) => isUnresolvedAcceptance(finding, detail.nodes) && !finding.resolutionNodeId);
    if (pendingCorrections.length) {
      return decide("resume", `Aceptaste ${list(pendingCorrections.map((finding) => finding.id))} sin nodo de corrección: abre uno con hrp_node_open indicando resolves.`);
    }
    const running = detail.nodes.filter((node) => node.status === "running");
    if (running.length) {
      return decide("resume", `Tienes ${running.length === 1 ? "un nodo" : `${running.length} nodos`} en curso (${list(running.map((node) => node.id))}) ${where}: verifica con hrp_node_verify y completa con hrp_node_complete, o márcalo con hrp_node_fail.`);
    }
    if (run.status === "implemented") {
      const audit = run.audit;
      return decide("wait", `Implementación cerrada; esperando auditoría. ${audit.blockers.length ? `Bloquea: ${audit.blockers.join("; ")}.` : ""} Sesiones enganchadas: ${list(run.attachedSessions)}.`);
    }
    return decide("resume", `El run ${run.id} sigue abierto ${where}. Si falta trabajo, abre el siguiente nodo con hrp_node_open; si terminaste, cierra con hrp_run_close (corre los criterios de aceptación). Si necesitas al humano, dilo y termina el turno.`);
  }

  // Auditor.
  const mine = live.filter((finding) => (finding.reviewer === sessionId || finding.messages.some((message) => message.author === sessionId))
    && finding.status !== "escalated"
    && lastAuthor(finding) !== undefined
    && lastAuthor(finding) !== sessionId);
  if (mine.length) {
    return decide("finding", `El base respondió en ${list(mine.map((finding) => finding.id))}. Lee el hilo con hrp_finding_show y contesta con hrp_finding_reply: rebate con evidencia o di explícitamente que aceptas la respuesta. Si el desacuerdo es genuino tras dos rondas, hrp_finding_escalate.`);
  }
  if (!session.requirementReviewed) {
    return decide("requirement", `Audita el requerimiento de ${run.id} ${where}: lee el issue con hrp_run_issue (requerimiento literal, interpretación del base, alcance, criterios y adjuntos). Reporta desviaciones con hrp_finding_add scope=requirement y, con hallazgos o sin ellos, declara la pasada con hrp_audit_done requirement=true.`);
  }
  const pendingNodes = detail.nodes.filter((node) => node.status === "completed" && node.author !== sessionId && !node.auditedBy.includes(sessionId));
  if (pendingNodes.length) {
    return decide("node", `Nodos por auditar (${pendingNodes.length}): ${list(pendingNodes.map((node) => node.id))} ${where}. Obtén diff y verificación con hrp_review_pack (nodeIds), reporta con hrp_finding_add nodeId=… y declara cada nodo revisado con hrp_audit_done nodeIds=[…] aunque no encuentres nada.`);
  }
  if (run.status === "implemented") {
    const voted = session.vote && session.votedAt && detail.nodes.every((node) => node.status !== "completed" || node.updatedAt <= session.votedAt!);
    if (!voted) {
      return decide("close", `El base cerró la implementación de ${run.id}. Haz la pasada de integración con hrp_review_pack (sin nodeIds), reporta hallazgos de integración con hrp_finding_add scope=integration y vota con hrp_audit_vote ok|reject. ${session.vote ? "Tu voto anterior caducó porque hubo correcciones." : ""}`);
    }
    return decide("wait", `Ya votaste ${session.vote} en ${run.id}. ${run.audit.blockers.length ? `Cierre bloqueado por: ${run.audit.blockers.join("; ")}.` : "El cierre es inminente."} Sigue atento por si el base corrige algo.`);
  }
  const runningCount = run.runningCount;
  return decide("wait", `Auditor enganchado a ${run.id}; el base sigue implementando${runningCount ? ` (${runningCount} en curso)` : ""}. Se te avisará al completarse cada nodo.`);
}
