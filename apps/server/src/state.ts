import type {
  AgentCommand,
  ChangeProgress,
  HumanObservation,
  ObservedPatch,
  Plan,
  PlanNode,
  ProtocolEvent,
  ProtocolState,
  ReplanProposal,
  ReviewPolicyChange,
  ReviewRequest,
  VerificationResult,
  WorkspaceSnapshot,
} from "@human-review/protocol";
import { PROTOCOL_VERSION } from "@human-review/protocol";

function clonePlan(plan: Plan): Plan {
  return {
    ...plan,
    nodes: plan.nodes.map((node) => ({
      ...node,
      changes: (node.changes ?? []).map((change) => ({
        ...change,
        dependencies: [...change.dependencies],
        operations: change.operations.map((operation) => ({ ...operation })),
      })),
    })),
  };
}

function rebuildChangeProgress(state: ProtocolState): void {
  state.changeProgressByNode = {};
  for (const plan of state.plans) {
    for (const node of plan.nodes) {
      if (!node.changes?.length) continue;
      const patches = state.patchesByNode[node.id] ?? [];
      const verifications = state.verificationsByNode[node.id] ?? [];
      state.changeProgressByNode[node.id] = node.changes.map((change): ChangeProgress => {
        const changePatches = patches.filter((patch) => patch.changeId === change.id);
        const observedOperationIds = [...new Set(changePatches.flatMap((patch) =>
          patch.operations.flatMap((operation) => operation.operationIds),
        ))];
        const passing = verifications.filter((verification) => verification.passed);
        const verifiedOperationIds = [...new Set(passing.flatMap((verification) =>
          verification.coversOperationIds ?? [],
        ).filter((operationId) => change.operations.some((operation) => operation.id === operationId)))];
        const verifiedByChange = passing.some((verification) =>
          (verification.coversChangeIds ?? []).includes(change.id),
        );
        const verifiedByPatches = changePatches.length > 0 && changePatches.every((patch) =>
          passing.some((verification) => (verification.coversPatchIds ?? []).includes(patch.patchId)),
        );
        const missingOperationIds = change.operations
          .map((operation) => operation.id)
          .filter((operationId) => !observedOperationIds.includes(operationId));
        const fullyVerified = missingOperationIds.length === 0 && (
          verifiedByChange
          || verifiedByPatches
          || change.operations.every((operation) => verifiedOperationIds.includes(operation.id))
        );
        return {
          nodeId: node.id,
          changeId: change.id,
          status: fullyVerified ? "verified" : changePatches.length ? "observed" : "planned",
          patchIds: changePatches.map((patch) => patch.patchId),
          observedOperationIds,
          verifiedOperationIds,
          missingOperationIds,
        };
      });
    }
  }
}

function updateNode(
  plans: Plan[],
  planId: string | undefined,
  nodeId: string,
  status: PlanNode["status"],
): void {
  const node = plans.find((plan) => plan.id === planId)?.nodes.find((candidate) => candidate.id === nodeId);
  if (node) node.status = status;
}

export function foldEvents(events: ProtocolEvent[], fallbackSessionId: string): ProtocolState {
  const state: ProtocolState = {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: fallbackSessionId,
    plans: [],
    reviews: [],
    reviewPolicyChanges: [],
    observations: [],
    commands: [],
    replanProposals: [],
    events: [],
    actualFilesByNode: {},
    patchesByNode: {},
    changeProgressByNode: {},
    verificationsByNode: {},
    paused: false,
  };

  for (const event of events) {
    state.events.push(event);
    state.lastUpdatedAt = event.timestamp;
    if (typeof event.data?.sessionId === "string") state.sessionId = event.data.sessionId;

    switch (event.type) {
      case "plan_created": {
        const plan = event.data?.plan as Plan | undefined;
        if (plan) {
          state.plans.push(clonePlan(plan));
          state.activePlanId = plan.id;
        }
        break;
      }
      case "review_requested": {
        const review = event.data?.review as ReviewRequest | undefined;
        if (review) {
          state.reviews.push({ ...review });
          state.pendingReview = { ...review };
          if (review.nodeId) updateNode(state.plans, review.planId, review.nodeId, "awaiting_review");
        }
        break;
      }
      case "review_resolved": {
        const reviewId = event.data?.reviewId as string | undefined;
        const decision = event.data?.decision as ReviewRequest["status"] | undefined;
        const review = state.reviews.find((candidate) => candidate.id === reviewId);
        if (review && decision) {
          review.status = decision;
          review.resolvedAt = event.timestamp;
          review.direction = event.data?.direction as string | undefined;
          if (review.nodeId) updateNode(state.plans, review.planId, review.nodeId, "pending");
          if (review.kind === "replan" && decision !== "approved") {
            const proposal = state.replanProposals.find((candidate) => candidate.id === review.subjectId);
            if (proposal) proposal.status = "rejected";
          }
        }
        if (state.pendingReview?.id === reviewId) state.pendingReview = undefined;
        break;
      }
      case "review_policy_changed": {
        const change = event.data?.change as ReviewPolicyChange | undefined;
        if (!change) break;
        state.reviewPolicyChanges.push(structuredClone(change));
        const plan = state.plans.find((candidate) => candidate.id === change.planId);
        for (const nodeId of change.targetNodeIds) {
          const node = plan?.nodes.find((candidate) => candidate.id === nodeId);
          if (node && node.fingerprint === change.nodeFingerprints[nodeId]) {
            node.reviewMode = change.mode;
            node.reviewReason = change.reason;
          }
        }
        break;
      }
      case "node_started":
        if (event.nodeId) {
          updateNode(state.plans, event.planId ?? state.activePlanId, event.nodeId, "running");
          state.activeNodeId = event.nodeId;
          state.paused = false;
        }
        break;
      case "patch_observed":
        if (event.nodeId) {
          const existing = state.actualFilesByNode[event.nodeId] ?? [];
          state.actualFilesByNode[event.nodeId] = [...new Set([...existing, ...(event.evidence?.files ?? [])])];
          const patch: ObservedPatch = {
            eventId: event.id,
            patchId: event.evidence?.patchId ?? event.id,
            nodeId: event.nodeId,
            changeId: event.changeId ?? event.evidence?.changeId,
            source: event.source,
            actor: event.actor,
            summary: event.summary,
            files: event.evidence?.files ?? [],
            operations: event.evidence?.operations ?? [],
            observedAt: event.timestamp,
          };
          state.patchesByNode[event.nodeId] = [...(state.patchesByNode[event.nodeId] ?? []), patch];
        }
        break;
      case "verification_observed": {
        const result = event.data?.result as VerificationResult | undefined;
        if (event.nodeId && result) {
          const recoveredResult = { ...result, eventId: event.id };
          state.verificationsByNode[event.nodeId] = [...(state.verificationsByNode[event.nodeId] ?? []), recoveredResult];
          if (!result.passed) updateNode(state.plans, event.planId ?? state.activePlanId, event.nodeId, "failed");
        }
        break;
      }
      case "node_completed":
        if (event.nodeId) {
          updateNode(state.plans, event.planId ?? state.activePlanId, event.nodeId, "completed");
          if (state.activeNodeId === event.nodeId) state.activeNodeId = undefined;
        }
        break;
      case "human_observation_recorded": {
        const observation = event.data?.observation as HumanObservation | undefined;
        if (observation) state.observations.push(structuredClone(observation));
        break;
      }
      case "control_changed": {
        const action = event.data?.action;
        state.paused = action === "pause";
        if (state.activeNodeId) {
          updateNode(
            state.plans,
            state.activePlanId,
            state.activeNodeId,
            state.paused ? "paused" : "running",
          );
        }
        break;
      }
      case "command_issued": {
        const command = event.data?.command as AgentCommand | undefined;
        if (command) state.commands.push(structuredClone(command));
        break;
      }
      case "command_acknowledged": {
        const command = state.commands.find((candidate) => candidate.id === event.data?.commandId);
        if (command) {
          command.status = "acknowledged";
          command.acknowledgedAt = event.timestamp;
        }
        break;
      }
      case "replan_proposed": {
        const proposal = event.data?.proposal as ReplanProposal | undefined;
        if (proposal) state.replanProposals.push(structuredClone(proposal));
        break;
      }
      case "replan_approved": {
        const proposal = state.replanProposals.find((candidate) => candidate.id === event.data?.proposalId);
        if (proposal) {
          proposal.status = "approved";
          const oldPlan = state.plans.find((candidate) => candidate.id === proposal.previousPlanId);
          for (const nodeId of proposal.supersededNodeIds) {
            const oldNode = oldPlan?.nodes.find((candidate) => candidate.id === nodeId);
            if (oldNode) oldNode.status = "superseded";
          }
          state.plans.push(clonePlan(proposal.proposedPlan));
          state.activePlanId = proposal.proposedPlan.id;
          state.activeNodeId = undefined;
        }
        break;
      }
      case "workspace_snapshot_observed": {
        if (event.nodeId) {
          const existing = state.actualFilesByNode[event.nodeId] ?? [];
          state.actualFilesByNode[event.nodeId] = [...new Set([...existing, ...(event.evidence?.files ?? [])])];
        }
        state.latestWorkspaceSnapshot = {
          eventId: event.id,
          files: event.evidence?.files ?? [],
          diff: event.evidence?.diff ?? "",
          observedAt: event.timestamp,
          truncated: event.data?.truncated === true,
        } satisfies WorkspaceSnapshot;
        break;
      }
    }
  }

  rebuildChangeProgress(state);

  return state;
}
