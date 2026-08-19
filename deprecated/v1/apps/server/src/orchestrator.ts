import { createHash, randomUUID } from "node:crypto";
import type {
  AgentCommand,
  AgentCommandType,
  ChangeOperationEvidence,
  CreatePlanInput,
  EventEvidence,
  EventSource,
  HumanObservation,
  ObservationKind,
  ObservationTarget,
  Plan,
  PlanNode,
  PlanNodeInput,
  ProtocolEvent,
  ProtocolState,
  ReplanProposal,
  ReviewDecision,
  ReviewKind,
  ReviewMode,
  ReviewPolicyChange,
  ReviewRequest,
  SemanticChange,
  SemanticChangeInput,
  VerificationResult,
} from "@human-review/protocol";
import { PROTOCOL_VERSION } from "@human-review/protocol";
import { JsonlEventStore } from "./event-store.js";
import { foldEvents } from "./state.js";

type EventInput = Omit<ProtocolEvent, "schemaVersion" | "sequence" | "id" | "timestamp">;

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
}

function nodeFingerprint(node: PlanNodeInput): string {
  return fingerprint({
    id: node.id,
    title: node.title,
    objective: node.objective,
    dependencies: [...node.dependencies].sort(),
    affectedFiles: [...node.affectedFiles].sort(),
    rationale: node.rationale,
    alternatives: node.alternatives ?? [],
    verificationCriteria: node.verificationCriteria,
    changes: node.changes ?? [],
    supersedes: [...(node.supersedes ?? [])].sort(),
  });
}

export function assertPlanGraph(nodes: PlanNodeInput[]): void {
  if (nodes.length === 0) throw new Error("A plan needs at least one node");
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length) throw new Error("Plan node ids must be unique");

  for (const node of nodes) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(node.id)) throw new Error(`Invalid node id: ${node.id}`);
    if (node.dependencies.includes(node.id)) throw new Error(`Node ${node.id} cannot depend on itself`);
    for (const dependency of node.dependencies) {
      if (!ids.has(dependency)) throw new Error(`Node ${node.id} has unknown dependency ${dependency}`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`Plan contains a dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);

  const changes = nodes.flatMap((node) => node.changes ?? []);
  const changeIds = new Set(changes.map((change) => change.id));
  if (changeIds.size !== changes.length) throw new Error("Semantic change ids must be unique across the plan");
  const operationIds = new Set<string>();
  for (const node of nodes) {
    for (const change of node.changes ?? []) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(change.id)) throw new Error(`Invalid change id: ${change.id}`);
      if (!change.operations.length) throw new Error(`Semantic change ${change.id} needs at least one operation`);
      if (change.dependencies.includes(change.id)) throw new Error(`Change ${change.id} cannot depend on itself`);
      for (const dependency of change.dependencies) {
        if (!changeIds.has(dependency)) throw new Error(`Change ${change.id} has unknown dependency ${dependency}`);
      }
      for (const operation of change.operations) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(operation.id)) throw new Error(`Invalid operation id: ${operation.id}`);
        if (operationIds.has(operation.id)) throw new Error(`Operation ids must be unique across the plan: ${operation.id}`);
        operationIds.add(operation.id);
        if (!node.affectedFiles.includes(operation.file)) {
          throw new Error(`Operation ${operation.id} uses undeclared file ${operation.file}`);
        }
      }
    }
  }

  const changeById = new Map(changes.map((change) => [change.id, change]));
  const visitingChanges = new Set<string>();
  const visitedChanges = new Set<string>();
  const visitChange = (id: string) => {
    if (visitingChanges.has(id)) throw new Error(`Plan contains a semantic-change cycle at ${id}`);
    if (visitedChanges.has(id)) return;
    visitingChanges.add(id);
    for (const dependency of changeById.get(id)?.dependencies ?? []) visitChange(dependency);
    visitingChanges.delete(id);
    visitedChanges.add(id);
  };
  for (const id of changeIds) visitChange(id);
}

function changeFingerprint(change: SemanticChangeInput): string {
  return fingerprint(change);
}

function countChangedLines(diff: string): { addedLines: number; removedLines: number } {
  let addedLines = 0;
  let removedLines = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) addedLines += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removedLines += 1;
  }
  return { addedLines, removedLines };
}

function normalizeDiffPath(value: string): string {
  return value.replace(/^[ab]\//, "").replace(/^"|"$/g, "");
}

export function splitUnifiedDiff(diff: string, files: string[]): Map<string, string> {
  const chunks = new Map<string, string>();
  const starts = [...diff.matchAll(/^diff --git\s+(.+?)\s+(.+)$/gm)];
  for (let index = 0; index < starts.length; index += 1) {
    const match = starts[index]!;
    const start = match.index ?? 0;
    const end = starts[index + 1]?.index ?? diff.length;
    const file = normalizeDiffPath(match[2] ?? match[1] ?? "");
    if (file) chunks.set(file, diff.slice(start, end).trimEnd());
  }
  if (!chunks.size && files.length === 1 && diff.trim()) chunks.set(files[0]!, diff.trimEnd());
  return chunks;
}

function descendants(nodes: PlanNode[], rootNodeId: string): string[] {
  const selected = new Set([rootNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (!selected.has(node.id) && node.dependencies.some((dependency) => selected.has(dependency))) {
        selected.add(node.id);
        changed = true;
      }
    }
  }
  return [...selected];
}

export class ProtocolOrchestrator {
  #events: ProtocolEvent[] = [];
  #sessionId: string = randomUUID();
  #appendChain: Promise<void> = Promise.resolve();

  constructor(private readonly store: JsonlEventStore) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    this.#events = await this.store.readAll();
    const recovered = foldEvents(this.#events, this.#sessionId);
    this.#sessionId = recovered.sessionId;
  }

  getState(): ProtocolState {
    return foldEvents(this.#events, this.#sessionId);
  }

  async #append(input: EventInput): Promise<ProtocolEvent> {
    let created: ProtocolEvent | undefined;
    const operation = this.#appendChain.then(async () => {
      const event: ProtocolEvent = {
        ...input,
        schemaVersion: PROTOCOL_VERSION,
        sequence: (this.#events.at(-1)?.sequence ?? 0) + 1,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        data: { ...input.data, sessionId: this.#sessionId },
      };
      await this.store.append(event);
      this.#events.push(event);
      created = event;
    });
    this.#appendChain = operation.catch(() => undefined);
    await operation;
    return created!;
  }

  #buildPlan(input: CreatePlanInput, version: number, previousPlan?: Plan): Plan {
    assertPlanGraph(input.nodes);
    const previousNodes = new Map(previousPlan?.nodes.map((node) => [node.id, node]) ?? []);
    const nodes: PlanNode[] = input.nodes.map((node) => {
      const currentFingerprint = nodeFingerprint(node);
      const previous = previousNodes.get(node.id);
      const preservesPolicy = previous?.fingerprint === currentFingerprint;
      const changes: SemanticChange[] = (node.changes ?? []).map((change) => ({
        ...change,
        dependencies: [...change.dependencies],
        operations: change.operations.map((operation) => ({ ...operation })),
        fingerprint: changeFingerprint(change),
      }));
      return {
        ...node,
        changes,
        status: "pending",
        fingerprint: currentFingerprint,
        reviewMode: preservesPolicy ? previous.reviewMode : "required",
        reviewReason: preservesPolicy ? previous.reviewReason : undefined,
      };
    });
    return {
      id: randomUUID(),
      title: input.title,
      summary: input.summary,
      version,
      fingerprint: fingerprint(nodes.map((node) => node.fingerprint)),
      createdAt: new Date().toISOString(),
      nodes,
    };
  }

  async createPlan(input: CreatePlanInput): Promise<{ plan: Plan; review: ReviewRequest }> {
    const state = this.getState();
    if (state.pendingReview || state.activeNodeId) {
      throw new Error("Resolve the current review or node before creating another plan");
    }
    const plan = this.#buildPlan(input, state.plans.length + 1);
    await this.#append({
      type: "plan_created",
      source: "agent",
      planId: plan.id,
      correlationId: plan.id,
      summary: `Plan created: ${plan.title}`,
      data: { plan },
    });
    const review = await this.requestReview({
      kind: "plan",
      planId: plan.id,
      summary: `Review plan v${plan.version}: ${plan.summary}`,
    });
    return { plan, review };
  }

  async requestReview(input: {
    kind: ReviewKind;
    planId?: string;
    summary: string;
    nodeId?: string;
    subjectId?: string;
  }): Promise<ReviewRequest> {
    const state = this.getState();
    if (state.pendingReview) throw new Error(`Review ${state.pendingReview.id} is already pending`);
    const plan = state.plans.find((candidate) => candidate.id === (input.planId ?? state.activePlanId));
    if (!plan) throw new Error("Create a plan before requesting review");
    const node = input.nodeId ? plan.nodes.find((candidate) => candidate.id === input.nodeId) : undefined;
    if (input.kind === "node" && !node) throw new Error(`Unknown node: ${input.nodeId ?? "missing"}`);

    const review: ReviewRequest = {
      id: randomUUID(),
      kind: input.kind,
      subjectId: input.subjectId ?? node?.id ?? plan.id,
      planId: plan.id,
      nodeId: node?.id,
      nodeFingerprint: node?.fingerprint,
      summary: input.summary,
      status: "pending",
      requestedAt: new Date().toISOString(),
    };
    await this.#append({
      type: "review_requested",
      source: "agent",
      planId: plan.id,
      nodeId: node?.id,
      correlationId: review.id,
      summary: input.summary,
      data: { review },
    });
    return review;
  }

  async #issueCommand(
    type: AgentCommandType,
    causationId: string,
    payload: Record<string, unknown>,
    target?: ObservationTarget,
  ): Promise<AgentCommand> {
    const command: AgentCommand = {
      id: randomUUID(),
      type,
      status: "pending",
      createdAt: new Date().toISOString(),
      causationId,
      target,
      payload,
    };
    await this.#append({
      type: "command_issued",
      source: "orchestrator",
      causationId,
      planId: target?.planId,
      nodeId: target?.nodeId,
      summary: `Command issued: ${type}`,
      data: { command },
    });
    return command;
  }

  async resolveReview(reviewId: string, decision: ReviewDecision, direction?: string): Promise<void> {
    const review = this.getState().reviews.find((candidate) => candidate.id === reviewId);
    if (!review || review.status !== "pending") throw new Error(`Review is not pending: ${reviewId}`);
    if (decision === "redirected" && !direction?.trim()) throw new Error("A redirected review requires direction text");

    const event = await this.#append({
      type: "review_resolved",
      source: "human",
      planId: review.planId,
      nodeId: review.nodeId,
      correlationId: review.id,
      summary: `Review ${decision}: ${review.summary}`,
      data: { reviewId, decision, direction },
    });

    if (review.kind === "replan" && decision === "approved") {
      await this.#append({
        type: "replan_approved",
        source: "orchestrator",
        planId: review.planId,
        causationId: event.id,
        summary: "The reviewed graph revision is now active",
        data: { proposalId: review.subjectId },
      });
    }

    await this.#issueCommand(
      "review_resolution",
      event.id,
      { reviewId, decision, direction, kind: review.kind, subjectId: review.subjectId },
      { planId: review.planId, nodeId: review.nodeId },
    );
  }

  async setReviewPolicy(input: {
    planId?: string;
    nodeId: string;
    scope: "node" | "subtree";
    mode: ReviewMode;
    reason?: string;
  }): Promise<ReviewPolicyChange> {
    const state = this.getState();
    const plan = state.plans.find((candidate) => candidate.id === (input.planId ?? state.activePlanId));
    const root = plan?.nodes.find((node) => node.id === input.nodeId);
    if (!plan || !root) throw new Error(`Unknown active-plan node: ${input.nodeId}`);
    const targetNodeIds = input.scope === "subtree" ? descendants(plan.nodes, root.id) : [root.id];
    const change: ReviewPolicyChange = {
      id: randomUUID(),
      planId: plan.id,
      planVersion: plan.version,
      rootNodeId: root.id,
      scope: input.scope,
      mode: input.mode,
      targetNodeIds,
      nodeFingerprints: Object.fromEntries(
        targetNodeIds.map((nodeId) => [nodeId, plan.nodes.find((node) => node.id === nodeId)!.fingerprint]),
      ),
      reason: input.reason?.trim() || undefined,
      changedAt: new Date().toISOString(),
      changedBy: "human",
    };
    const event = await this.#append({
      type: "review_policy_changed",
      source: "human",
      planId: plan.id,
      nodeId: root.id,
      correlationId: change.id,
      summary: `${targetNodeIds.length} node${targetNodeIds.length === 1 ? "" : "s"} set to ${input.mode}`,
      data: { change },
    });
    await this.#issueCommand(
      "review_policy",
      event.id,
      { change },
      { planId: plan.id, nodeId: root.id },
    );

    const pending = this.getState().pendingReview;
    if (pending?.nodeId && targetNodeIds.includes(pending.nodeId) && input.mode !== "required") {
      await this.resolveReview(pending.id, "approved", `Review bypassed by ${input.mode} policy`);
    }
    return change;
  }

  async startNode(nodeId: string, intent: string, affectedFiles: string[]): Promise<void> {
    const state = this.getState();
    if (state.paused) throw new Error("The session is paused");
    const plan = state.plans.find((candidate) => candidate.id === state.activePlanId);
    const node = plan?.nodes.find((candidate) => candidate.id === nodeId);
    if (!plan || !node) throw new Error(`Unknown active-plan node: ${nodeId}`);
    if (state.activeNodeId) throw new Error(`Node ${state.activeNodeId} is already active`);
    const planApproved = state.reviews.some(
      (review) => review.kind === "plan" && review.subjectId === plan.id && review.status === "approved",
    );
    if (!planApproved && plan.version === 1) throw new Error("The active plan has not been reviewed");
    if (node.reviewMode === "required") {
      const nodeApproved = state.reviews.some(
        (review) =>
          review.kind === "node" &&
          review.nodeId === nodeId &&
          review.nodeFingerprint === node.fingerprint &&
          review.status === "approved",
      );
      if (!nodeApproved) throw new Error(`Node ${nodeId} requires review`);
    }
    const incomplete = node.dependencies.filter(
      (dependency) => plan.nodes.find((candidate) => candidate.id === dependency)?.status !== "completed",
    );
    if (incomplete.length) throw new Error(`Incomplete dependencies: ${incomplete.join(", ")}`);
    const undeclared = affectedFiles.filter((file) => !node.affectedFiles.includes(file));
    if (undeclared.length) throw new Error(`Intent includes undeclared files: ${undeclared.join(", ")}`);

    const started = await this.#append({
      type: "node_started",
      source: "agent",
      planId: plan.id,
      nodeId,
      correlationId: node.fingerprint,
      summary: `Started: ${node.title}`,
      data: { reviewMode: node.reviewMode },
    });
    await this.#append({
      type: "intent_declared",
      source: "agent",
      planId: plan.id,
      nodeId,
      correlationId: node.fingerprint,
      causationId: started.id,
      summary: intent,
      evidence: { files: affectedFiles },
    });
  }

  async observePatch(input: {
    nodeId: string;
    changeId?: string;
    operationIds?: string[];
    summary: string;
    files: string[];
    diff: string;
    beforeCode?: string;
    afterCode?: string;
    source?: EventSource;
    actor?: string;
  }): Promise<ProtocolEvent> {
    const state = this.getState();
    if (state.activeNodeId !== input.nodeId) throw new Error(`Node ${input.nodeId} is not active`);
    const plan = state.plans.find((candidate) => candidate.id === state.activePlanId);
    const node = plan?.nodes.find((candidate) => candidate.id === input.nodeId);
    if (!plan || !node) throw new Error(`Unknown node: ${input.nodeId}`);
    const undeclared = input.files.filter((file) => !node.affectedFiles.includes(file));
    if (undeclared.length) throw new Error(`Patch contains undeclared files: ${undeclared.join(", ")}`);
    const change = input.changeId ? node.changes.find((candidate) => candidate.id === input.changeId) : undefined;
    if (node.changes.length && !change) {
      throw new Error(`Patch must identify one declared semantic change for node ${node.id}`);
    }
    const selectedOperationIds = input.operationIds ?? change?.operations
      .filter((operation) => input.files.includes(operation.file))
      .map((operation) => operation.id) ?? [];
    const selectedOperations = change?.operations.filter((operation) => selectedOperationIds.includes(operation.id)) ?? [];
    const unknownOperationIds = selectedOperationIds.filter((operationId) =>
      !change?.operations.some((operation) => operation.id === operationId),
    );
    if (unknownOperationIds.length) throw new Error(`Unknown operations for change ${change?.id}: ${unknownOperationIds.join(", ")}`);
    const unmatchedFiles = input.files.filter((file) =>
      change && !selectedOperations.some((operation) => operation.file === file),
    );
    if (unmatchedFiles.length) throw new Error(`Patch files are not mapped to declared operations: ${unmatchedFiles.join(", ")}`);
    const fileDiffs = splitUnifiedDiff(input.diff, input.files);
    if (change) {
      const missingDiffs = input.files.filter((file) => !fileDiffs.get(file)?.trim());
      if (missingDiffs.length) {
        throw new Error(`A real per-file diff is required for: ${missingDiffs.join(", ")}`);
      }
    }
    const operationEvidence: ChangeOperationEvidence[] = input.files.map((file) => {
      const operations = selectedOperations.filter((operation) => operation.file === file);
      const fileDiff = fileDiffs.get(file) ?? (input.files.length === 1 ? input.diff : "");
      return {
        operationIds: operations.map((operation) => operation.id),
        file,
        symbol: operations.length === 1 ? operations[0]?.symbol : undefined,
        summary: operations.map((operation) => operation.summary).join(" · ") || input.summary,
        rationale: operations.map((operation) => operation.rationale).join(" · ") || input.summary,
        diff: fileDiff,
        beforeCode: input.files.length === 1 ? input.beforeCode : undefined,
        afterCode: input.files.length === 1 ? input.afterCode : undefined,
        ...countChangedLines(fileDiff),
      };
    });
    const patchId = randomUUID();
    return await this.#append({
      type: "patch_observed",
      source: input.source ?? "agent",
      actor: input.actor,
      planId: plan.id,
      nodeId: node.id,
      changeId: change?.id,
      correlationId: node.fingerprint,
      summary: input.summary,
      evidence: {
        files: input.files,
        diff: input.diff,
        beforeCode: input.beforeCode,
        afterCode: input.afterCode,
        patchId,
        changeId: change?.id,
        operations: operationEvidence,
      },
      data: { patchId, changeId: change?.id, operationIds: selectedOperationIds },
    });
  }

  async observeVerification(input: {
    nodeId: string;
    commandId: string;
    command: string;
    output: string;
    exitCode: number;
    coversChangeIds?: string[];
    coversOperationIds?: string[];
    coversPatchIds?: string[];
  }): Promise<VerificationResult> {
    const state = this.getState();
    if (state.activeNodeId !== input.nodeId) throw new Error(`Node ${input.nodeId} is not active`);
    const plan = state.plans.find((candidate) => candidate.id === state.activePlanId);
    const node = plan?.nodes.find((candidate) => candidate.id === input.nodeId);
    if (!node) throw new Error(`Unknown node: ${input.nodeId}`);
    const coversChangeIds = [...new Set(input.coversChangeIds ?? [])];
    const coversOperationIds = [...new Set(input.coversOperationIds ?? [])];
    const coversPatchIds = [...new Set(input.coversPatchIds ?? [])];
    if (node.changes.length && !coversChangeIds.length && !coversOperationIds.length && !coversPatchIds.length) {
      throw new Error("Granular plans require explicit verification coverage");
    }
    const declaredChanges = new Set(node.changes.map((change) => change.id));
    const declaredOperations = new Set(node.changes.flatMap((change) => change.operations.map((operation) => operation.id)));
    const observedPatches = new Set((state.patchesByNode[node.id] ?? []).map((patch) => patch.patchId));
    const unknownChanges = coversChangeIds.filter((id) => !declaredChanges.has(id));
    const unknownOperations = coversOperationIds.filter((id) => !declaredOperations.has(id));
    const unknownPatches = coversPatchIds.filter((id) => !observedPatches.has(id));
    if (unknownChanges.length) throw new Error(`Unknown covered changes: ${unknownChanges.join(", ")}`);
    if (unknownOperations.length) throw new Error(`Unknown covered operations: ${unknownOperations.join(", ")}`);
    if (unknownPatches.length) throw new Error(`Unknown covered patches: ${unknownPatches.join(", ")}`);
    const result: VerificationResult = {
      eventId: "pending",
      nodeId: input.nodeId,
      commandId: input.commandId,
      command: input.command,
      output: input.output,
      exitCode: input.exitCode,
      passed: input.exitCode === 0,
      completedAt: new Date().toISOString(),
      coversChangeIds,
      coversOperationIds,
      coversPatchIds,
    };
    const event = await this.#append({
      type: "verification_observed",
      source: "verification",
      planId: state.activePlanId,
      nodeId: input.nodeId,
      summary: `${result.passed ? "Verification passed" : "Verification failed"}: ${input.commandId}`,
      evidence: { command: input.command, output: input.output, exitCode: input.exitCode },
      data: { result, coversChangeIds, coversOperationIds, coversPatchIds },
    });
    result.eventId = event.id;
    return result;
  }

  async completeNode(nodeId: string, summary: string): Promise<void> {
    const state = this.getState();
    if (state.activeNodeId !== nodeId) throw new Error(`Node ${nodeId} is not active`);
    const verifications = state.verificationsByNode[nodeId] ?? [];
    if (!verifications.length || !verifications.at(-1)?.passed) {
      throw new Error("A passing observed verification is required before completion");
    }
    const plan = state.plans.find((candidate) => candidate.id === state.activePlanId);
    const node = plan?.nodes.find((candidate) => candidate.id === nodeId);
    if (node?.changes.length) {
      const progress = state.changeProgressByNode[nodeId] ?? [];
      const incomplete = progress.filter((change) => change.status !== "verified");
      if (incomplete.length) {
        const details = incomplete.map((change) => {
          const missing = change.missingOperationIds.length ? `missing diff: ${change.missingOperationIds.join(", ")}` : "missing verification coverage";
          return `${change.changeId} (${missing})`;
        });
        throw new Error(`Every semantic change needs real diff evidence and mapped passing verification: ${details.join("; ")}`);
      }
    }
    await this.#append({
      type: "node_completed",
      source: "agent",
      planId: state.activePlanId,
      nodeId,
      summary,
    });
  }

  async recordObservation(input: {
    target?: ObservationTarget;
    kind: ObservationKind;
    message: string;
    blocking: boolean;
  }): Promise<HumanObservation> {
    const state = this.getState();
    const target = { planId: state.activePlanId, nodeId: state.activeNodeId, ...input.target };
    if (target.nodeId) {
      const plan = state.plans.find((candidate) => candidate.id === target.planId);
      const node = plan?.nodes.find((candidate) => candidate.id === target.nodeId);
      if (!node) throw new Error(`Unknown target node: ${target.nodeId}`);
      const change = target.changeId ? node.changes.find((candidate) => candidate.id === target.changeId) : undefined;
      if (target.changeId && !change) throw new Error(`Unknown target change: ${target.changeId}`);
      if (target.operationId && !change?.operations.some((operation) => operation.id === target.operationId)) {
        throw new Error(`Unknown target operation: ${target.operationId}`);
      }
      if (target.patchId && !(state.patchesByNode[target.nodeId] ?? []).some((patch) => patch.patchId === target.patchId)) {
        throw new Error(`Unknown target patch: ${target.patchId}`);
      }
    }
    const observation: HumanObservation = {
      id: randomUUID(),
      target,
      kind: input.kind,
      message: input.message.trim(),
      blocking: input.blocking,
      createdAt: new Date().toISOString(),
      createdBy: "human",
    };
    const event = await this.#append({
      type: "human_observation_recorded",
      source: "human",
      planId: target.planId,
      nodeId: target.nodeId,
      correlationId: observation.id,
      summary: observation.message,
      data: { observation },
    });
    await this.#issueCommand("observation", event.id, { observation }, target);
    if (observation.blocking && !state.paused) await this.setControl("pause", "Blocking human observation");
    return observation;
  }

  async setControl(action: "pause" | "resume", reason: string): Promise<void> {
    const state = this.getState();
    if ((action === "pause") === state.paused) return;
    const event = await this.#append({
      type: "control_changed",
      source: "human",
      planId: state.activePlanId,
      nodeId: state.activeNodeId,
      summary: reason,
      data: { action },
    });
    await this.#issueCommand(
      "control",
      event.id,
      { action, reason },
      { planId: state.activePlanId, nodeId: state.activeNodeId },
    );
  }

  async acknowledgeCommand(commandId: string): Promise<void> {
    const command = this.getState().commands.find((candidate) => candidate.id === commandId);
    if (!command || command.status !== "pending") throw new Error(`Command is not pending: ${commandId}`);
    await this.#append({
      type: "command_acknowledged",
      source: "agent",
      causationId: command.causationId,
      summary: `Command acknowledged: ${command.type}`,
      data: { commandId },
    });
  }

  async proposeReplan(input: CreatePlanInput & {
    changedAssumption: string;
    retainedNodeIds: string[];
    supersededNodeIds: string[];
    newNodeIds: string[];
  }): Promise<{ proposal: ReplanProposal; review: ReviewRequest }> {
    const state = this.getState();
    const previousPlan = state.plans.find((candidate) => candidate.id === state.activePlanId);
    if (!previousPlan) throw new Error("There is no active plan to replace");
    if (state.activeNodeId) throw new Error("Pause or complete the active node before proposing a replan");
    const proposedPlan = this.#buildPlan(input, previousPlan.version + 1, previousPlan);
    const proposal: ReplanProposal = {
      id: randomUUID(),
      previousPlanId: previousPlan.id,
      proposedPlan,
      changedAssumption: input.changedAssumption,
      retainedNodeIds: input.retainedNodeIds,
      supersededNodeIds: input.supersededNodeIds,
      newNodeIds: input.newNodeIds,
      status: "pending",
    };
    await this.#append({
      type: "replan_proposed",
      source: "agent",
      planId: previousPlan.id,
      correlationId: proposal.id,
      summary: input.changedAssumption,
      data: { proposal },
    });
    const review = await this.requestReview({
      kind: "replan",
      planId: previousPlan.id,
      subjectId: proposal.id,
      summary: `Review plan v${proposedPlan.version}: ${input.summary}`,
    });
    return { proposal, review };
  }

  async observeWorkspaceSnapshot(input: {
    files: string[];
    diff: string;
    truncated: boolean;
  }): Promise<void> {
    const fileDiffs = splitUnifiedDiff(input.diff, input.files);
    const operations: ChangeOperationEvidence[] = input.files.map((file) => {
      const fileDiff = fileDiffs.get(file) ?? "";
      return {
        operationIds: [],
        file,
        summary: "Cambio detectado directamente en el workspace",
        rationale: "Evidencia independiente observada por HRP; no declara intención del agente.",
        diff: fileDiff,
        ...countChangedLines(fileDiff),
      };
    });
    const patchId = randomUUID();
    await this.#append({
      type: "workspace_snapshot_observed",
      source: "workspace",
      planId: this.getState().activePlanId,
      nodeId: this.getState().activeNodeId,
      summary: `${input.files.length} workspace file${input.files.length === 1 ? "" : "s"} changed`,
      evidence: { files: input.files, diff: input.diff, patchId, operations },
      data: { truncated: input.truncated, patchId },
    });
  }
}
