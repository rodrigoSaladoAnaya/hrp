export const nodeStatuses = ["pending", "running", "completed", "failed"] as const;
export type NodeStatus = (typeof nodeStatuses)[number];

export const activityTypes = ["run", "graph", "inspect", "node", "patch", "verify", "note"] as const;
export type ActivityType = (typeof activityTypes)[number];

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
  graphVersion: number;
  baseAgent?: string;
  seenAgents: string[];
  nodeCount: number;
  completedCount: number;
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

export type ChangeNodeInput = Pick<ChangeNode, "id" | "file" | "symbol" | "title" | "description" | "rationale" | "dependencies"> & {
  discovered?: boolean;
};

export type GraphInput = {
  nodes: ChangeNodeInput[];
};

export const PROTOCOL_VERSION = "2.3";
