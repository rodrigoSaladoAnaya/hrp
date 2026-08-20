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
  nodeCount: number;
  completedCount: number;
  // Nodos que aún esperan la aprobación humana: alimenta los avisos del árbol
  // de proyectos sin obligar al panel a cargar el detalle de cada ejecución.
  awaitingApproval: number;
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
  createdAt: string;
};

export type RunDetail = {
  run: RunSummary;
  nodes: ChangeNode[];
  activity: Activity[];
};

export type ChangeNodeInput = Pick<ChangeNode, "id" | "file" | "symbol" | "title" | "description" | "rationale" | "dependencies" | "suggestedAgent"> & {
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

export const PROTOCOL_VERSION = "2.5";
