import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type PlanNodeInput, type ProtocolConfig, type ProtocolEvent } from "@human-review/protocol";
import { JsonlEventStore } from "./event-store.js";
import { ProtocolOrchestrator } from "./orchestrator.js";
import { ProjectManager } from "./project-manager.js";
import { ProjectRegistry, projectStorageKey } from "./project-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function buildOrchestrator() {
  const root = await mkdtemp(path.join(os.tmpdir(), "human-review-protocol-"));
  temporaryDirectories.push(root);
  const orchestrator = new ProtocolOrchestrator(new JsonlEventStore(path.join(root, "events")));
  await orchestrator.initialize();
  return { root, orchestrator };
}

function node(overrides: Partial<PlanNodeInput> = {}): PlanNodeInput {
  return {
    id: "contract",
    title: "Define the contract",
    objective: "Make the intended behavior explicit",
    dependencies: [],
    affectedFiles: ["src/contract.ts"],
    rationale: "Downstream work depends on a stable contract.",
    verificationCriteria: ["Contract tests pass."],
    ...overrides,
  };
}

describe("ProtocolOrchestrator", () => {
  it("runs an auto-reviewed branch, records evidence and recovers the neutral event log", async () => {
    const { root, orchestrator } = await buildOrchestrator();
    const implementation = node({
      id: "implementation",
      title: "Implement the contract",
      objective: "Ship the behavior",
      dependencies: ["contract"],
      affectedFiles: ["src/implementation.ts"],
    });
    const { plan, review } = await orchestrator.createPlan({
      title: "Neutral protocol demo",
      summary: "A reviewable two-node graph",
      nodes: [node(), implementation],
    });
    await orchestrator.resolveReview(review.id, "approved");
    const policy = await orchestrator.setReviewPolicy({
      nodeId: "contract",
      scope: "subtree",
      mode: "auto",
      reason: "Low-risk fixture",
    });
    expect(policy.targetNodeIds).toEqual(["contract", "implementation"]);

    await orchestrator.startNode("contract", "Record the contract change", ["src/contract.ts"]);
    await orchestrator.observePatch({
      nodeId: "contract",
      summary: "Add explicit contract",
      files: ["src/contract.ts"],
      diff: "--- a/src/contract.ts\n+++ b/src/contract.ts\n@@ -0,0 +1 @@\n+export type Contract = string;\n",
      beforeCode: "",
      afterCode: "export type Contract = string;\n",
    });
    await orchestrator.observeVerification({
      nodeId: "contract",
      commandId: "contract-test",
      command: "npm test",
      output: "1 test passed",
      exitCode: 0,
    });
    await orchestrator.completeNode("contract", "Contract recorded and verified");
    const observation = await orchestrator.recordObservation({
      target: { planId: plan.id, nodeId: "implementation", file: "src/implementation.ts", line: 12 },
      kind: "constraint",
      message: "Keep the public return type stable.",
      blocking: true,
    });
    expect(observation.target.line).toBe(12);
    expect(orchestrator.getState().paused).toBe(true);
    expect(orchestrator.getState().commands.some((command) => command.type === "observation")).toBe(true);

    const recovered = new ProtocolOrchestrator(new JsonlEventStore(path.join(root, "events")));
    await recovered.initialize();
    const state = recovered.getState();
    expect(state.plans[0]?.nodes[0]?.status).toBe("completed");
    expect(state.plans[0]?.nodes[1]?.reviewMode).toBe("auto");
    expect(state.events.map((event) => event.type)).toContain("patch_observed");
    expect(state.observations[0]?.message).toContain("return type");
    expect(state.events.every((event, index) => event.sequence === index + 1)).toBe(true);
  });

  it("requires review by default and accepts approval for the exact node fingerprint", async () => {
    const { orchestrator } = await buildOrchestrator();
    const { review } = await orchestrator.createPlan({ title: "Plan", summary: "Summary", nodes: [node()] });
    await orchestrator.resolveReview(review.id, "approved");
    await expect(orchestrator.startNode("contract", "Intent", ["src/contract.ts"])).rejects.toThrow(/requires review/);
    const nodeReview = await orchestrator.requestReview({ kind: "node", nodeId: "contract", summary: "Review contract" });
    await orchestrator.resolveReview(nodeReview.id, "approved");
    await expect(orchestrator.startNode("contract", "Intent", ["src/contract.ts"])).resolves.toBeUndefined();
  });

  it("requires per-change diffs and mapped verification before completing a granular node", async () => {
    const { orchestrator } = await buildOrchestrator();
    const granular = node({
      affectedFiles: ["src/event-store.ts", "src/event-store.test.ts"],
      changes: [
        {
          id: "project-scoping",
          title: "Scope persisted events by project",
          intent: "Prevent events from leaking across project folders",
          rationale: "A shared database needs an explicit project boundary.",
          dependencies: [],
          operations: [{
            id: "scope-event-writes",
            file: "src/event-store.ts",
            symbol: "append",
            kind: "modify",
            summary: "Persist project_id with each event",
            rationale: "Every event must retain its owning workspace.",
          }],
        },
        {
          id: "isolation-proof",
          title: "Prove cross-project isolation",
          intent: "Exercise two projects against the same database",
          rationale: "The boundary needs executable evidence.",
          dependencies: ["project-scoping"],
          operations: [{
            id: "test-project-isolation",
            file: "src/event-store.test.ts",
            kind: "create",
            summary: "Add a two-project isolation test",
            rationale: "A regression test makes the storage guarantee observable.",
          }],
        },
      ],
    });
    const { review } = await orchestrator.createPlan({ title: "Granular plan", summary: "Trace every operation", nodes: [granular] });
    await orchestrator.resolveReview(review.id, "approved");
    await orchestrator.setReviewPolicy({ nodeId: "contract", scope: "node", mode: "auto" });
    await orchestrator.startNode("contract", "Implement project isolation", granular.affectedFiles);

    const firstPatch = await orchestrator.observePatch({
      nodeId: "contract",
      changeId: "project-scoping",
      summary: "Attach every event to its project",
      files: ["src/event-store.ts"],
      diff: "diff --git a/src/event-store.ts b/src/event-store.ts\n--- a/src/event-store.ts\n+++ b/src/event-store.ts\n@@ -1 +1 @@\n-append(event)\n+append(projectId, event)\n",
    });
    expect(firstPatch.evidence?.operations?.[0]).toMatchObject({
      operationIds: ["scope-event-writes"],
      file: "src/event-store.ts",
      addedLines: 1,
      removedLines: 1,
    });
    await orchestrator.observeVerification({
      nodeId: "contract",
      commandId: "storage-test",
      command: "npm test",
      output: "storage test passed",
      exitCode: 0,
      coversChangeIds: ["project-scoping"],
      coversOperationIds: ["scope-event-writes"],
      coversPatchIds: [firstPatch.evidence!.patchId!],
    });
    await expect(orchestrator.completeNode("contract", "Only storage implemented")).rejects.toThrow(/isolation-proof/);

    const secondPatch = await orchestrator.observePatch({
      nodeId: "contract",
      changeId: "isolation-proof",
      summary: "Add executable isolation proof",
      files: ["src/event-store.test.ts"],
      diff: "diff --git a/src/event-store.test.ts b/src/event-store.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/event-store.test.ts\n@@ -0,0 +1 @@\n+it('isolates projects', () => {})\n",
    });
    await orchestrator.observeVerification({
      nodeId: "contract",
      commandId: "isolation-test",
      command: "npm test",
      output: "isolation test passed",
      exitCode: 0,
      coversChangeIds: ["isolation-proof"],
      coversOperationIds: ["test-project-isolation"],
      coversPatchIds: [secondPatch.evidence!.patchId!],
    });
    await expect(orchestrator.completeNode("contract", "All granular evidence is mapped")).resolves.toBeUndefined();
    expect(orchestrator.getState().changeProgressByNode.contract?.map((change) => change.status)).toEqual(["verified", "verified"]);
  });

  it("preserves review waivers only for unchanged nodes across replans", async () => {
    const { orchestrator } = await buildOrchestrator();
    const second = node({
      id: "tests",
      title: "Add tests",
      objective: "Cover the contract",
      dependencies: ["contract"],
      affectedFiles: ["test/contract.test.ts"],
    });
    const { review } = await orchestrator.createPlan({ title: "Plan", summary: "Summary", nodes: [node(), second] });
    await orchestrator.resolveReview(review.id, "approved");
    await orchestrator.setReviewPolicy({ nodeId: "contract", scope: "subtree", mode: "auto" });

    const { proposal } = await orchestrator.proposeReplan({
      title: "Plan revised",
      summary: "Change only the tests node",
      changedAssumption: "The test boundary moved",
      retainedNodeIds: ["contract"],
      supersededNodeIds: ["tests"],
      newNodeIds: ["tests"],
      nodes: [node(), { ...second, objective: "Cover public and failure contracts" }],
    });
    expect(proposal.proposedPlan.nodes.find((candidate) => candidate.id === "contract")?.reviewMode).toBe("auto");
    expect(proposal.proposedPlan.nodes.find((candidate) => candidate.id === "tests")?.reviewMode).toBe("required");
  });

  it("rejects cyclic plans", async () => {
    const { orchestrator } = await buildOrchestrator();
    await expect(orchestrator.createPlan({
      title: "Cycle",
      summary: "Invalid",
      nodes: [
        node({ id: "a", dependencies: ["b"], affectedFiles: ["a.ts"] }),
        node({ id: "b", dependencies: ["a"], affectedFiles: ["b.ts"] }),
      ],
    })).rejects.toThrow(/cycle/);
  });

  it("keeps a unique monotonic sequence under concurrent publishers", async () => {
    const { orchestrator } = await buildOrchestrator();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => orchestrator.recordObservation({
        kind: "note",
        message: `Concurrent observation ${index}`,
        blocking: false,
      })),
    );
    const sequences = orchestrator.getState().events.map((event) => event.sequence);
    expect(sequences).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
    expect(new Set(sequences).size).toBe(sequences.length);
  });
});

describe("multi-project persistence", () => {
  it("reconstructs isolated sessions for two workspace folders from one SQLite database", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "human-review-projects-"));
    temporaryDirectories.push(root);
    const alpha = path.join(root, "alpha");
    const beta = path.join(root, "beta");
    const dataDirectory = path.join(root, "data");
    await Promise.all([mkdir(alpha), mkdir(beta)]);
    const canonicalAlpha = await realpath(alpha);
    const canonicalBeta = await realpath(beta);
    const config: ProtocolConfig = {
      workspaceRoot: alpha,
      dataDirectory,
      http: { host: "127.0.0.1", port: 4317 },
      workspaceObserver: { enabled: false, pollIntervalMs: 900, maxDiffBytes: 512 * 1024 },
    };

    const first = new ProjectManager(config, new ProjectRegistry(dataDirectory));
    const alphaContext = await first.initialize();
    const betaContext = await first.attach(beta);
    await alphaContext.orchestrator.recordObservation({ kind: "note", message: "Alpha only", blocking: false });
    await betaContext.orchestrator.recordObservation({ kind: "note", message: "Beta only", blocking: false });
    expect(first.list().map((project) => project.workspaceRoot).sort()).toEqual([canonicalAlpha, canonicalBeta].sort());
    await first.close();

    const recovered = new ProjectManager(config, new ProjectRegistry(dataDirectory));
    const recoveredAlpha = await recovered.initialize();
    const recoveredBeta = await recovered.attach(beta);
    expect(recoveredAlpha.orchestrator.getState().observations.map((item) => item.message)).toEqual(["Alpha only"]);
    expect(recoveredBeta.orchestrator.getState().observations.map((item) => item.message)).toEqual(["Beta only"]);
    await recovered.close();
  });

  it("imports the legacy per-workspace JSONL log once", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "human-review-import-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "legacy-app");
    const dataDirectory = path.join(root, "data");
    await mkdir(workspace);
    const canonicalWorkspace = await realpath(workspace);
    const legacyDirectory = path.join(dataDirectory, "workspaces", projectStorageKey(canonicalWorkspace));
    await mkdir(legacyDirectory, { recursive: true });
    const event: ProtocolEvent = {
      schemaVersion: PROTOCOL_VERSION,
      sequence: 1,
      id: "legacy-event",
      timestamp: "2026-08-18T00:00:00.000Z",
      type: "human_observation_recorded",
      source: "human",
      summary: "Imported legacy event",
      data: {
        sessionId: "legacy-session",
        observation: {
          id: "legacy-observation",
          target: {},
          kind: "note",
          message: "Recovered from JSONL",
          blocking: false,
          createdAt: "2026-08-18T00:00:00.000Z",
          createdBy: "human",
        },
      },
    };
    await writeFile(path.join(legacyDirectory, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");

    const registry = new ProjectRegistry(dataDirectory);
    await registry.initialize();
    const project = await registry.register(workspace);
    const events = await registry.createEventStore(project.id).readAll();
    expect(events).toEqual([event]);
    await registry.register(workspace);
    expect(await registry.createEventStore(project.id).readAll()).toHaveLength(1);
    registry.close();
  });
});
