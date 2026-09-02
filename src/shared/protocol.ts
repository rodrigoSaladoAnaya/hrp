// Contrato de Human Review Protocol v4. La mecánica está en docs/protocol.md;
// este archivo es su traducción a tipos y a las reglas puras que comparten el
// servidor, el MCP, el runner y el panel.

export const PROTOCOL_VERSION = "4.0";

// Estado persistido del run. 'hold' no se guarda: se deriva de un hallazgo
// crítico vivo (ver runIsOnHold) para que no pueda desincronizarse.
export const runStatuses = ["open", "implemented", "closed"] as const;
export type RunStatus = (typeof runStatuses)[number];

export const runPhases = ["open", "hold", "implemented", "closed"] as const;
export type RunPhase = (typeof runPhases)[number];

// Control humano: pausada/detenida bloquean todo inicio de nodo en el servidor.
export const runControls = ["active", "paused", "stopped"] as const;
export type RunControl = (typeof runControls)[number];

// Un nodo existe desde que el base lo abre: no hay 'pending'.
export const nodeStatuses = ["running", "completed", "failed"] as const;
export type NodeStatus = (typeof nodeStatuses)[number];

export const activityTypes = ["run", "session", "node", "verify", "finding", "audit", "note"] as const;
export type ActivityType = (typeof activityTypes)[number];

export const sessionRoles = ["base", "auditor"] as const;
export type SessionRole = (typeof sessionRoles)[number];

export const sessionStatuses = ["attached", "released"] as const;
export type SessionStatus = (typeof sessionStatuses)[number];

// Familias con adaptador propio. 'ollama' no abre sesión de chat: es un runner.
export const agentFamilies = ["claude", "codex", "antigravity", "ollama"] as const;
export type AgentFamily = (typeof agentFamilies)[number];

export const findingStatuses = ["open", "debating", "accepted", "rejected", "escalated"] as const;
export type FindingStatus = (typeof findingStatuses)[number];

export const findingSeverities = ["critical", "major", "minor", "question"] as const;
export type FindingSeverity = (typeof findingSeverities)[number];

// 'requirement' audita el issue contra el requerimiento literal; 'node' un
// cambio concreto; 'integration' cruza varios nodos al cierre.
export const findingScopes = ["requirement", "node", "integration"] as const;
export type FindingScope = (typeof findingScopes)[number];

export const auditVotes = ["ok", "reject"] as const;
export type AuditVote = (typeof auditVotes)[number];

export type Project = {
  id: string;
  name: string;
  workspaceRoot: string;
  createdAt: string;
  lastOpenedAt: string;
};

export type Verification = {
  command: string;
  output: string;
  exitCode: number;
  passed: boolean;
  observedAt: string;
};

// Criterio de aceptación del issue. Con 'command' lo ejecuta la máquina al
// cerrar; sin él sólo se lista para los auditores.
export type AcceptanceCriterion = {
  text: string;
  command?: string;
  result?: Verification;
};

// Identidad de una sesión enganchada: 'familia:N', acuñada por el servicio al
// engancharse. Es la unidad de independencia: nadie audita lo propio y el base
// nunca es el único voto.
export type Session = {
  id: string;
  runId: string;
  family: string;
  role: SessionRole;
  status: SessionStatus;
  // Nodos completados que esta sesión ya auditó (con hallazgos o sin ellos).
  reviewedNodeIds: string[];
  requirementReviewed: boolean;
  integrationReviewed: boolean;
  vote?: AuditVote;
  voteDetail?: string;
  votedAt?: string;
  attachedAt: string;
  releasedAt?: string;
  lastSeenAt: string;
};

export type ChangeNode = {
  id: string;
  runId: string;
  file: string;
  symbol: string;
  title: string;
  description: string;
  rationale: string;
  status: NodeStatus;
  // Sesión base que lo abrió.
  author: string;
  dependencies: string[];
  // Evidencia: el diff lo calcula el servidor con git al completar, el commit
  // es el que deja en la rama del run.
  diff?: string;
  patchSummary?: string;
  patchRationale?: string;
  verification?: Verification;
  commit?: string;
  failure?: string;
  tokens?: number;
  // Sesiones que auditaron este nodo; sale de las sesiones, no se guarda aquí.
  auditedBy: string[];
  createdAt: string;
  updatedAt: string;
};

export type FindingMessage = {
  id: string;
  findingId: string;
  // Sesión, o el literal "human".
  author: string;
  body: string;
  createdAt: string;
};

export type Finding = {
  id: string;
  runId: string;
  nodeId?: string;
  scope: FindingScope;
  reviewer: string;
  severity: FindingSeverity;
  title: string;
  body: string;
  status: FindingStatus;
  // Nodo que corrige el hallazgo aceptado.
  resolutionNodeId?: string;
  messages: FindingMessage[];
  createdAt: string;
  updatedAt: string;
};

export type FindingInput = Pick<Finding, "reviewer" | "severity" | "title" | "body"> & {
  nodeId?: string;
  scope?: FindingScope;
};

export type Activity = {
  id: number;
  runId: string;
  nodeId?: string;
  type: ActivityType;
  message: string;
  detail?: string;
  agent?: string;
  createdAt: string;
};

export type AuditStatus = {
  // Nodos completados sin auditoría de una sesión ajena a su autor.
  unauditedNodeIds: string[];
  okVotes: string[];
  rejectVotes: string[];
  // Sesiones auditoras enganchadas que aún no votan (o cuyo voto caducó).
  pendingVoters: string[];
  liveFindings: number;
  distinctFamilies: string[];
  canClose: boolean;
  blockers: string[];
};

export type RunSummary = {
  id: string;
  projectId: string;
  title: string;
  status: RunStatus;
  phase: RunPhase;
  control: RunControl;
  branch: string;
  base?: string;
  issuePath: string;
  attachments: string[];
  acceptance: AcceptanceCriterion[];
  nodeCount: number;
  completedCount: number;
  runningCount: number;
  failedCount: number;
  openFindings: number;
  attachedSessions: string[];
  audit: AuditStatus;
  createdAt: string;
  updatedAt: string;
  implementedAt?: string;
  closedAt?: string;
};

export type RunDetail = {
  run: RunSummary;
  project: Project;
  nodes: ChangeNode[];
  findings: Finding[];
  sessions: Session[];
  activity: Activity[];
  issue: string;
};

export type ChangeNodeInput = Pick<ChangeNode, "file" | "symbol" | "title" | "description" | "rationale"> & {
  id?: string;
  dependencies?: string[];
};

export type RunInput = {
  title: string;
  requirement: string;
  interpretation: string;
  scopeIncludes?: string[];
  scopeExcludes?: string[];
  acceptance: Array<{ text: string; command?: string }>;
  risks?: string[];
  attachments?: Array<{ path: string; note?: string }>;
};

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*:[0-9]+$/;
const FAMILY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function isValidFamily(family: string | undefined): boolean {
  return typeof family === "string" && FAMILY_PATTERN.test(family);
}

export function isValidSessionId(session: string | undefined): boolean {
  return typeof session === "string" && SESSION_ID_PATTERN.test(session);
}

export function sessionFamily(session: string): string {
  const separator = session.indexOf(":");
  return separator === -1 ? session : session.slice(0, separator);
}

export const liveFindingStatuses: readonly FindingStatus[] = ["open", "debating", "escalated"];

export function isLiveFinding(finding: Pick<Finding, "status">): boolean {
  return liveFindingStatuses.includes(finding.status);
}

// Un hallazgo aceptado sigue reclamando cierre hasta que su nodo de corrección
// termina: aceptar sin corregir no cierra nada.
export function isUnresolvedAcceptance(finding: Pick<Finding, "status" | "resolutionNodeId">, nodes: Pick<ChangeNode, "id" | "status">[]): boolean {
  if (finding.status !== "accepted") return false;
  if (!finding.resolutionNodeId) return true;
  return nodes.find((node) => node.id === finding.resolutionNodeId)?.status !== "completed";
}

export function runIsOnHold(findings: Pick<Finding, "status" | "severity">[]): boolean {
  return findings.some((finding) => finding.severity === "critical" && isLiveFinding(finding));
}

// Un voto vale mientras no se complete ningún nodo después de emitirlo: una
// corrección posterior exige volver a mirar.
export function voteIsCurrent(session: Pick<Session, "vote" | "votedAt">, nodes: Pick<ChangeNode, "status" | "updatedAt">[]): boolean {
  if (!session.vote || !session.votedAt) return false;
  const votedAt = session.votedAt;
  return nodes.every((node) => node.status !== "completed" || node.updatedAt <= votedAt);
}

export function auditorsOf(sessions: Pick<Session, "id" | "role" | "status">[]): string[] {
  return sessions.filter((session) => session.role === "auditor" && session.status === "attached").map((session) => session.id);
}

// Regla del gate, en un solo sitio para que el servidor, la señal de atención
// y el panel no puedan discrepar sobre si un run puede cerrarse.
export function computeAuditStatus(
  run: Pick<RunSummary, "status" | "base">,
  nodes: Pick<ChangeNode, "id" | "status" | "author" | "auditedBy" | "updatedAt">[],
  sessions: Pick<Session, "id" | "family" | "role" | "status" | "vote" | "votedAt">[],
  findings: Pick<Finding, "status" | "severity" | "resolutionNodeId">[],
): AuditStatus {
  const completed = nodes.filter((node) => node.status === "completed");
  const unauditedNodeIds = completed
    .filter((node) => !node.auditedBy.some((session) => session !== node.author))
    .map((node) => node.id);
  const auditors = sessions.filter((session) => session.role === "auditor" && session.id !== run.base);
  const current = auditors.filter((session) => voteIsCurrent(session, nodes));
  const okVotes = current.filter((session) => session.vote === "ok").map((session) => session.id);
  const rejectVotes = current.filter((session) => session.vote === "reject").map((session) => session.id);
  const pendingVoters = auditors
    .filter((session) => session.status === "attached" && !current.includes(session))
    .map((session) => session.id);
  const liveFindings = findings.filter((finding) => isLiveFinding(finding) || isUnresolvedAcceptance(finding, nodes)).length;
  const distinctFamilies = [...new Set(sessions.map((session) => session.family))];
  const blockers: string[] = [];
  if (run.status !== "implemented") blockers.push(run.status === "closed" ? "el run ya está cerrado" : "el base no ha cerrado la implementación");
  if (completed.length === 0) blockers.push("no hay nodos completados");
  if (unauditedNodeIds.length) blockers.push(`nodos sin auditoría ajena: ${unauditedNodeIds.join(", ")}`);
  if (liveFindings) blockers.push(`${liveFindings} ${liveFindings === 1 ? "hallazgo vivo" : "hallazgos vivos"}`);
  if (okVotes.length === 0) blockers.push("falta al menos un voto OK de un auditor distinto del base");
  if (okVotes.length <= rejectVotes.length && okVotes.length > 0) blockers.push(`sin mayoría: ${okVotes.length} OK contra ${rejectVotes.length} rechazos`);
  return {
    unauditedNodeIds,
    okVotes,
    rejectVotes,
    pendingVoters,
    liveFindings,
    distinctFamilies,
    canClose: blockers.length === 0,
    blockers,
  };
}

export function runBranchName(runId: string): string {
  return `hrp/run-${runId}`;
}

export function attentionCommand(runId: string): string {
  return `/hrp attention ${runId}`;
}

export function runnerCommand(runId: string, family = "ollama"): string {
  return `hrp attend ${runId} --agent ${family}`;
}

export function panelUrl(baseUrl: string, projectId: string, runId: string): string {
  return `${baseUrl}/?project=${encodeURIComponent(projectId)}&run=${encodeURIComponent(runId)}`;
}

// Preferencias de interfaz. Viven en el navegador (localStorage): son por
// persona, no por servicio.
export type ViewShortcutModifier = "meta" | "ctrl" | "either";

export type UiPreferences = {
  viewShortcuts: {
    enabled: boolean;
    modifier: ViewShortcutModifier;
  };
};

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  viewShortcuts: { enabled: true, modifier: "meta" },
};
