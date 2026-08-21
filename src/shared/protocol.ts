export const nodeStatuses = ["pending", "running", "completed", "failed"] as const;
export type NodeStatus = (typeof nodeStatuses)[number];

export const activityTypes = ["run", "graph", "inspect", "node", "patch", "verify", "note"] as const;
export type ActivityType = (typeof activityTypes)[number];

// Control humano de la ejecución: pausada/detenida bloquean todo inicio de
// nodo en el servidor, por lo que aplica a cualquier agente por igual.
export const runControls = ["active", "paused", "stopped"] as const;
export type RunControl = (typeof runControls)[number];

export type Project = {
  id: string;
  name: string;
  workspaceRoot: string;
  createdAt: string;
  lastOpenedAt: string;
};

export type RunSummary = {
  id: string;
  projectId: string;
  title: string;
  requirement: string;
  status: NodeStatus;
  control: RunControl;
  graphVersion: number;
  baseAgent?: string;
  seenAgents: string[];
  // Auditores elegidos por el humano antes de autorizar el grafo. La lista se
  // congela al comenzar para que la política de revisión no cambie a mitad.
  auditors: string[];
  // Auditores seleccionados que aún no publican phase completed.
  pendingAuditorCount: number;
  // Votos OK que aún faltan para alcanzar la mayoría simple del censo auditor.
  // Este es el dato que bloquea el cierre; pendingAuditorCount es informativo.
  pendingAuditorVotes?: number;
  nodeCount: number;
  completedCount: number;
  // Nodos que aún esperan la aprobación humana: alimenta los avisos del árbol
  // de proyectos sin obligar al panel a cargar el detalle de cada ejecución.
  awaitingApproval: number;
  // Hallazgos vivos (open, debating o escalated): alimentan la insignia del
  // árbol y bloquean el cierre del run hasta resolverse.
  openFindings: number;
  createdAt: string;
  updatedAt: string;
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
  discovered: boolean;
  approved: boolean;
  assignee?: string;
  suggestedAgent?: string;
  // Archivos de solo lectura que 'hrp ollama exec' adjunta como referencia al
  // delegar: el humano aprueba junto con la spec qué material verá el modelo.
  contextFiles?: string[];
  executedBy?: string;
  dependencies: string[];
  diff?: string;
  patchSummary?: string;
  patchRationale?: string;
  verification?: Verification;
  tokens?: number;
  createdAt: string;
  updatedAt: string;
};

// Ciclo de revisión multi-modelo (v3): un hallazgo nace open, pasa a debating
// cuando hay respuestas, y termina accepted (con nodo de corrección), rejected
// (con razón en el hilo) o escalated (queda en manos del humano en el panel).
export const findingStatuses = ["open", "debating", "accepted", "rejected", "escalated"] as const;
export type FindingStatus = (typeof findingStatuses)[number];

export const findingSeverities = ["critical", "major", "minor", "question"] as const;
export type FindingSeverity = (typeof findingSeverities)[number];

export type Finding = {
  id: string;
  runId: string;
  // Sin nodeId el hallazgo es de integración: cruza varios nodos del run.
  nodeId?: string;
  reviewer: string;
  severity: FindingSeverity;
  title: string;
  body: string;
  status: FindingStatus;
  // Nodo descubierto que corrige el hallazgo aceptado; pasa por el gate humano.
  resolutionNodeId?: string;
  messages: FindingMessage[];
  createdAt: string;
  updatedAt: string;
};

// Un turno del debate; author es un nombre de agente o el literal "human".
export type FindingMessage = {
  id: string;
  findingId: string;
  author: string;
  body: string;
  createdAt: string;
};

export type FindingInput = Pick<Finding, "reviewer" | "severity" | "title" | "body"> & {
  nodeId?: string;
};

export type Verification = {
  command: string;
  output: string;
  exitCode: number;
  passed: boolean;
  observedAt: string;
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

export const agentWorkPhases = ["idle", "waiting", "executing", "reviewing", "completed", "failed"] as const;
export type AgentWorkPhase = (typeof agentWorkPhases)[number];

// Estado observable, deliberadamente operacional: comunica qué etapa externa
// ejecuta un agente y qué evidencia está cubierta, nunca su razonamiento privado.
export type AgentWorkState = {
  agent: string;
  phase: AgentWorkPhase;
  summary: string;
  detail?: string;
  currentNodeId?: string;
  completed: number;
  total: number;
  reviewedNodeIds: string[];
  remainingNodeIds: string[];
  startedAt?: string;
  updatedAt: string;
};

export type AuditorConsensus = {
  requiredVotes: number;
  completedVotes: number;
  pendingAuditors: string[];
  pendingAuditorVotes: number;
};

export function auditMajority(total: number): number {
  return total > 0 ? Math.floor(total / 2) + 1 : 0;
}

export function computeAuditorConsensus(
  auditors: string[],
  agentStates: Pick<AgentWorkState, "agent" | "phase">[],
): AuditorConsensus {
  const completed = new Set(agentStates
    .filter((state) => state.phase === "completed")
    .map((state) => state.agent));
  const pendingAuditors = auditors.filter((auditor) => !completed.has(auditor));
  const completedVotes = auditors.length - pendingAuditors.length;
  const requiredVotes = auditMajority(auditors.length);
  return {
    requiredVotes,
    completedVotes,
    pendingAuditors,
    pendingAuditorVotes: Math.max(requiredVotes - completedVotes, 0),
  };
}

export type RunDetail = {
  run: RunSummary;
  nodes: ChangeNode[];
  activity: Activity[];
  findings: Finding[];
  agentStates: AgentWorkState[];
};

export type ChangeNodeInput = Pick<ChangeNode, "id" | "file" | "symbol" | "title" | "description" | "rationale" | "dependencies" | "suggestedAgent" | "contextFiles"> & {
  discovered?: boolean;
};

export type GraphInput = {
  nodes: ChangeNodeInput[];
};

// Configuración persistida de Ollama Cloud; la key solo vive en el servidor.
export type OllamaSettings = {
  apiKey: string;
  model: string;
  baseUrl: string;
};

// Vista para la web: nunca incluye la key completa, solo su terminación.
export type OllamaSettingsView = {
  configured: boolean;
  model: string;
  baseUrl: string;
  keyMask?: string;
};

export const DEFAULT_OLLAMA_MODEL = "kimi-k2.7-code";
export const DEFAULT_OLLAMA_BASE_URL = "https://ollama.com";

export const PROTOCOL_VERSION = "3.0";
