export const nodeStatuses = ["pending", "running", "completed", "failed"] as const;
export type NodeStatus = (typeof nodeStatuses)[number];

export const activityTypes = ["run", "graph", "inspect", "node", "patch", "verify", "note"] as const;
export type ActivityType = (typeof activityTypes)[number];

// Control humano de la ejecución: pausada/detenida bloquean todo inicio de
// nodo en el servidor, por lo que aplica a cualquier agente por igual.
export const runControls = ["active", "paused", "stopped"] as const;
export type RunControl = (typeof runControls)[number];

// Dificultad declarada de una operación. La publica el modelo base junto con el
// resto de la spec, así que el humano la aprueba y puede corregirla: es la
// semántica con la que se decide qué modelo ataca el nodo, no una heurística
// que el despachador infiera del diff. Un nodo sin dificultad declarada vale
// como "standard"; esa resolución vive donde se consulta, no en el dato.
export const nodeDifficulties = ["trivial", "standard", "hard"] as const;
export type NodeDifficulty = (typeof nodeDifficulties)[number];

export type Project = {
  id: string;
  name: string;
  workspaceRoot: string;
  createdAt: string;
  lastOpenedAt: string;
};

// Estado de la ronda de auditoría del plan sobre la versión vigente del grafo.
// 'open' significa que aún faltan pasadas de auditores antes de que arranque la
// implementación; ya no retiene la aprobación humana inicial.
export type PlanGateStatus = {
  graphVersion: number;
  auditors: string[];
  // Auditores con pasada publicada sobre graphVersion.
  reviewed: string[];
  // Auditores elegidos que aún no opinan sobre esta versión.
  pending: string[];
  open: boolean;
  // Compatibilidad con runs antiguos que guardaron una aprobación con override.
  overriddenVersion?: number;
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
  // Branch Git creado como salvaguarda cuando la ejecución encuentra cambios pendientes.
  changeBranch?: string;
  seenAgents: string[];
  // Auditores elegidos por el humano antes de autorizar el grafo. La lista se
  // congela al comenzar para que la política de revisión no cambie a mitad.
  auditors: string[];
  // Auditores seleccionados que aún no publican phase completed.
  pendingAuditorCount: number;
  // Votos OK que aún faltan para alcanzar la mayoría simple del censo auditor.
  // Este es el dato que bloquea el cierre; pendingAuditorCount es informativo.
  pendingAuditorVotes?: number;
  // Ronda de auditoría del plan sobre el grafo vigente. Es informativa para el
  // panel y accionable para auditores, pero no bloquea aprobar el grafo.
  planGate?: PlanGateStatus;
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
  // Dificultad declarada de la operación: gobierna a qué modelo se enruta.
  difficulty?: NodeDifficulty;
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

// Alcance de lo que audita el hallazgo. 'node' revisa el cambio de un nodo,
// 'integration' cruza varios nodos del run, y 'plan' revisa el grafo publicado
// antes de que exista código: nace de la auditoría previa a la aprobación
// humana y por eso nunca lleva nodeId aunque cite un nodo por su id.
export const findingScopes = ["node", "integration", "plan"] as const;
export type FindingScope = (typeof findingScopes)[number];

// Regla de compatibilidad para los hallazgos que no declaran scope: hasta v3.1
// la ausencia de nodeId era exactamente "de integración". Un hallazgo de plan
// debe declarar su scope de forma explícita; esta derivación nunca lo produce.
export function findingScopeFor(nodeId?: string): FindingScope {
  return nodeId ? "node" : "integration";
}

export type FindingAgreement = {
  agent: string;
  createdAt: string;
};

export type Finding = {
  id: string;
  runId: string;
  // Sin nodeId el hallazgo es de integración o de plan; scope lo distingue.
  nodeId?: string;
  scope: FindingScope;
  reviewer: string;
  severity: FindingSeverity;
  title: string;
  body: string;
  status: FindingStatus;
  // Nodo que corrige el hallazgo aceptado. Si es descubierto, la aceptación lo
  // autoriza y la unanimidad puede transferirlo al modelo que lo reportó.
  resolutionNodeId?: string;
  agreements: FindingAgreement[];
  // Modelo base + auditores elegidos. La unanimidad de este conjunto autoriza
  // al reportero a implementar; no sustituye la mayoría del gate final.
  requiredAgreementAgents: string[];
  unanimous: boolean;
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
  // Omitido, se deriva con findingScopeFor: sólo la auditoría del plan lo fija.
  scope?: FindingScope;
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

type AuditableChange = Pick<ChangeNode, "assignee" | "executedBy" | "updatedAt">;
type ConsensusAgentState =
  Pick<AgentWorkState, "agent" | "phase">
  & Partial<Pick<AgentWorkState, "startedAt" | "updatedAt">>;

export function auditMajority(total: number): number {
  return total > 0 ? Math.floor(total / 2) + 1 : 0;
}

export function auditorIdentity(agent: string | undefined): string | undefined {
  return agent?.startsWith("ollama:") ? "ollama" : agent;
}

export function nodeCoverageIsCurrent(auditor: string, startedAt: string | undefined, node: AuditableChange): boolean {
  if (!startedAt) return false;
  return auditorIdentity(node.executedBy ?? node.assignee) === auditorIdentity(auditor) || node.updatedAt <= startedAt;
}

export function auditorVoteIsCurrent(
  auditor: string,
  state: ConsensusAgentState | undefined,
  nodes: AuditableChange[] = [],
): boolean {
  if (state?.phase !== "completed") return false;
  const startedAt = state.startedAt ?? state.updatedAt;
  return nodes.every((node) => nodeCoverageIsCurrent(auditor, startedAt, node));
}

export function computeAuditorConsensus(
  auditors: string[],
  agentStates: ConsensusAgentState[],
  nodes: AuditableChange[] = [],
): AuditorConsensus {
  const completed = new Set(agentStates
    .filter((state) => auditorVoteIsCurrent(state.agent, state, nodes))
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

export type ChangeNodeInput = Pick<ChangeNode, "id" | "file" | "symbol" | "title" | "description" | "rationale" | "dependencies" | "suggestedAgent" | "difficulty" | "contextFiles"> & {
  discovered?: boolean;
};

export type GraphInput = {
  nodes: ChangeNodeInput[];
};

// Configuración persistida de Ollama Cloud; la key solo vive en el servidor.
// 'tiers' asigna un modelo delegado a cada dificultad; un nivel ausente hereda
// 'model', de modo que una instalación con un solo modelo sigue funcionando.
export type OllamaSettings = {
  apiKey: string;
  model: string;
  baseUrl: string;
  tiers: DelegateTiers;
};

// Vista para la web: nunca incluye la key completa, solo su terminación.
export type OllamaSettingsView = {
  configured: boolean;
  model: string;
  baseUrl: string;
  tiers: DelegateTiers;
  keyMask?: string;
};

export type DelegateTiers = Partial<Record<NodeDifficulty, string>>;

// Identidad de un agente. Una identidad es "familia" ("claude") o
// "familia:sesión" ("claude:opus"), y es la unidad con la que HRP cuenta todo:
// sostiene un nodo en vuelo y un estado de agente por identidad, y dirige a
// ella la señal de atención. Por eso dos sesiones del mismo modelo deben usar
// identidades distintas —"claude:fable" que planea y audita, "claude:opus" que
// implementa—: compartir identidad es compartir estado y pisárselo. La familia
// sigue siendo una identidad válida por sí sola, que es lo que usa una sesión
// única. El carril delegado "ollama:<modelo>" comparte esta forma pero no es
// una sesión: lo administra el modelo base (isDelegateAgent lo distingue).
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*(:[A-Za-z0-9][A-Za-z0-9_.-]*)?$/;

export function agentFamily(agent: string): string {
  const separator = agent.indexOf(":");
  return separator === -1 ? agent : agent.slice(0, separator);
}

export function agentSessionLabel(agent: string): string | undefined {
  const separator = agent.indexOf(":");
  return separator === -1 ? undefined : agent.slice(separator + 1) || undefined;
}

export function isValidAgentId(agent: string | undefined): boolean {
  return typeof agent === "string" && AGENT_ID_PATTERN.test(agent);
}

// Identidad del ejecutor delegado. HRP permite un solo nodo en vuelo por
// identidad, así que mientras toda la delegación se llamara "ollama" el trabajo
// delegado se ejecutaba en serie por construcción. Un carril "ollama:<modelo>"
// es una identidad ejecutora distinta: dos carriles corren a la vez sin relajar
// ninguna regla de compatibilidad entre nodos (archivo, contexto, dependencias).
export const DELEGATE_AGENT = "ollama";
const LANE_PREFIX = `${DELEGATE_AGENT}:`;

export function delegateLane(model: string): string {
  return `${LANE_PREFIX}${model.trim()}`;
}

// Modelo declarado por un carril, o undefined si el agente no es un carril con
// modelo (incluido el "ollama" pelado, que hereda el modelo por dificultad).
export function laneModel(agent: string | undefined): string | undefined {
  if (!agent?.startsWith(LANE_PREFIX)) return undefined;
  return agent.slice(LANE_PREFIX.length).trim() || undefined;
}

// Un agente delegado no abre sesión propia: lo administra el modelo base.
export function isDelegateAgent(agent: string | undefined): boolean {
  return agent === DELEGATE_AGENT || Boolean(agent?.startsWith(LANE_PREFIX));
}

// Familias con adaptador propio: son las que el panel ofrece siempre, aunque
// todavía no hayan aparecido en la ejecución.
export const agentFamilies = ["claude", "codex", "antigravity", DELEGATE_AGENT] as const;

// Censo de identidades de una ejecución: el modelo base primero, después las
// familias con adaptador, después toda identidad que la ejecución ya nombra
// (auditores, presencias, asignaciones y sugerencias) y al final los carriles
// delegados configurados. Se deriva del run en vez de fijarse en una constante
// porque una sesión —"claude:opus"— sólo existe si alguien la nombró: sin este
// censo el panel no puede asignarle nodos ni elegirla auditora.
export function runRoster(
  run: Pick<RunSummary, "baseAgent" | "auditors" | "seenAgents">,
  nodes: Pick<ChangeNode, "assignee" | "suggestedAgent">[] = [],
  delegateLanes: string[] = [],
): string[] {
  const referenced = [
    ...run.auditors,
    ...run.seenAgents,
    ...nodes.flatMap((node) => [node.assignee, node.suggestedAgent]),
  ];
  const ordered = [run.baseAgent, ...agentFamilies, ...referenced, ...delegateLanes];
  return [...new Set(ordered.filter((agent): agent is string => isValidAgentId(agent)))];
}

// Enrutado por dificultad: el nivel decide el modelo y el modelo base decide el
// nivel al publicar el grafo. Sin nivel declarado el nodo vale como "standard".
export function modelForDifficulty(
  settings: Pick<OllamaSettings, "model" | "tiers">,
  difficulty?: NodeDifficulty,
): string {
  return settings.tiers?.[difficulty ?? "standard"]?.trim() || settings.model;
}

export type ViewShortcutModifier = "meta" | "ctrl" | "either";

export type UiPreferences = {
  viewShortcuts: {
    enabled: boolean;
    modifier: ViewShortcutModifier;
  };
};

export const DEFAULT_OLLAMA_MODEL = "kimi-k2.7-code";
export const DEFAULT_OLLAMA_BASE_URL = "https://ollama.com";
export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  viewShortcuts: {
    enabled: true,
    modifier: "meta",
  },
};

export const PROTOCOL_VERSION = "3.0";
