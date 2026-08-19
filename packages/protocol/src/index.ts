export const PROTOCOL_VERSION = "1.1" as const;

export const nodeStatuses = [
  "pending",
  "awaiting_review",
  "running",
  "paused",
  "completed",
  "superseded",
  "failed",
] as const;

export type NodeStatus = (typeof nodeStatuses)[number];

export const reviewModes = ["required", "watch", "auto"] as const;
export type ReviewMode = (typeof reviewModes)[number];

export const changeStatuses = ["planned", "observed", "verified"] as const;
export type ChangeStatus = (typeof changeStatuses)[number];

export const changeOperationKinds = ["create", "modify", "delete", "move", "generate"] as const;
export type ChangeOperationKind = (typeof changeOperationKinds)[number];

export type ChangeOperationInput = {
  id: string;
  file: string;
  symbol?: string;
  kind: ChangeOperationKind;
  summary: string;
  rationale: string;
};

export type SemanticChangeInput = {
  id: string;
  title: string;
  intent: string;
  rationale: string;
  dependencies: string[];
  operations: ChangeOperationInput[];
};

export type SemanticChange = SemanticChangeInput & {
  fingerprint: string;
};

export type PlanNodeInput = {
  id: string;
  title: string;
  objective: string;
  dependencies: string[];
  affectedFiles: string[];
  rationale: string;
  alternatives?: Array<{ option: string; reasonRejected: string }>;
  verificationCriteria: string[];
  changes?: SemanticChangeInput[];
  supersedes?: string[];
};

export type PlanNode = Omit<PlanNodeInput, "changes"> & {
  changes: SemanticChange[];
  status: NodeStatus;
  fingerprint: string;
  reviewMode: ReviewMode;
  reviewReason?: string;
};

export type Plan = {
  id: string;
  title: string;
  summary: string;
  version: number;
  fingerprint: string;
  createdAt: string;
  nodes: PlanNode[];
};

export const eventTypes = [
  "plan_created",
  "review_requested",
  "review_resolved",
  "review_policy_changed",
  "node_started",
  "intent_declared",
  "patch_observed",
  "verification_observed",
  "node_completed",
  "human_observation_recorded",
  "control_changed",
  "command_issued",
  "command_acknowledged",
  "replan_proposed",
  "replan_approved",
  "workspace_snapshot_observed",
] as const;

export type EventType = (typeof eventTypes)[number];
export type EventSource = "agent" | "human" | "workspace" | "orchestrator" | "verification";

export type EventEvidence = {
  files?: string[];
  beforeCode?: string;
  afterCode?: string;
  diff?: string;
  command?: string;
  output?: string;
  exitCode?: number;
  patchId?: string;
  changeId?: string;
  operations?: ChangeOperationEvidence[];
};

export type ChangeOperationEvidence = {
  operationIds: string[];
  file: string;
  symbol?: string;
  summary: string;
  rationale: string;
  diff: string;
  beforeCode?: string;
  afterCode?: string;
  addedLines: number;
  removedLines: number;
};

export type ProtocolEvent = {
  schemaVersion: typeof PROTOCOL_VERSION;
  sequence: number;
  id: string;
  timestamp: string;
  type: EventType;
  source: EventSource;
  actor?: string;
  planId?: string;
  nodeId?: string;
  changeId?: string;
  correlationId?: string;
  causationId?: string;
  summary: string;
  evidence?: EventEvidence;
  data?: Record<string, unknown>;
};

export type ReviewKind = "plan" | "node" | "replan";
export type ReviewDecision = "approved" | "rejected" | "paused" | "redirected";

export type ReviewRequest = {
  id: string;
  kind: ReviewKind;
  subjectId: string;
  planId: string;
  nodeId?: string;
  nodeFingerprint?: string;
  summary: string;
  status: "pending" | ReviewDecision;
  requestedAt: string;
  resolvedAt?: string;
  direction?: string;
};

export type ReviewPolicyChange = {
  id: string;
  planId: string;
  planVersion: number;
  rootNodeId: string;
  scope: "node" | "subtree";
  mode: ReviewMode;
  targetNodeIds: string[];
  nodeFingerprints: Record<string, string>;
  reason?: string;
  changedAt: string;
  changedBy: "human";
};

export type ObservationKind = "change" | "question" | "constraint" | "note";

export type ObservationTarget = {
  planId?: string;
  nodeId?: string;
  changeId?: string;
  operationId?: string;
  file?: string;
  symbol?: string;
  line?: number;
  endLine?: number;
  patchId?: string;
};

export type HumanObservation = {
  id: string;
  target: ObservationTarget;
  kind: ObservationKind;
  message: string;
  blocking: boolean;
  createdAt: string;
  createdBy: "human";
};

export type AgentCommandType = "observation" | "review_resolution" | "review_policy" | "control";

export type AgentCommand = {
  id: string;
  type: AgentCommandType;
  status: "pending" | "acknowledged";
  createdAt: string;
  acknowledgedAt?: string;
  causationId: string;
  target?: ObservationTarget;
  payload: Record<string, unknown>;
};

export type ReplanProposal = {
  id: string;
  previousPlanId: string;
  proposedPlan: Plan;
  changedAssumption: string;
  retainedNodeIds: string[];
  supersededNodeIds: string[];
  newNodeIds: string[];
  status: "pending" | "approved" | "rejected";
};

export type VerificationResult = {
  eventId: string;
  nodeId: string;
  commandId: string;
  command: string;
  output: string;
  exitCode: number;
  passed: boolean;
  completedAt: string;
  coversChangeIds: string[];
  coversOperationIds: string[];
  coversPatchIds: string[];
};

export type ObservedPatch = {
  eventId: string;
  patchId: string;
  nodeId: string;
  changeId?: string;
  source: EventSource;
  actor?: string;
  summary: string;
  files: string[];
  operations: ChangeOperationEvidence[];
  observedAt: string;
};

export type ChangeProgress = {
  nodeId: string;
  changeId: string;
  status: ChangeStatus;
  patchIds: string[];
  observedOperationIds: string[];
  verifiedOperationIds: string[];
  missingOperationIds: string[];
};

export type WorkspaceSnapshot = {
  eventId: string;
  files: string[];
  diff: string;
  observedAt: string;
  truncated: boolean;
};

export type ProtocolState = {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  plans: Plan[];
  activePlanId?: string;
  activeNodeId?: string;
  reviews: ReviewRequest[];
  pendingReview?: ReviewRequest;
  reviewPolicyChanges: ReviewPolicyChange[];
  observations: HumanObservation[];
  commands: AgentCommand[];
  replanProposals: ReplanProposal[];
  events: ProtocolEvent[];
  actualFilesByNode: Record<string, string[]>;
  patchesByNode: Record<string, ObservedPatch[]>;
  changeProgressByNode: Record<string, ChangeProgress[]>;
  verificationsByNode: Record<string, VerificationResult[]>;
  latestWorkspaceSnapshot?: WorkspaceSnapshot;
  paused: boolean;
  lastUpdatedAt?: string;
};

export type ProtocolConfig = {
  workspaceRoot: string;
  dataDirectory: string;
  http: { host: "127.0.0.1" | "localhost"; port: number };
  workspaceObserver: {
    enabled: boolean;
    pollIntervalMs: number;
    maxDiffBytes: number;
  };
};

export type CreatePlanInput = Pick<Plan, "title" | "summary"> & { nodes: PlanNodeInput[] };

export type AdapterCapabilities = {
  liveEvents: boolean;
  midTurnSteering: boolean;
  approvalGates: boolean;
  sessionResume: boolean;
  workspaceDiffs: boolean;
};

export interface AgentAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(command: AgentCommand): Promise<void>;
  onEvent(listener: (event: Omit<ProtocolEvent, "id" | "sequence" | "timestamp" | "schemaVersion">) => void): () => void;
}
