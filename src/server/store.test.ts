import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HrpStore } from "./store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "hrp-v2-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const store = new HrpStore(path.join(root, "data"));
  const project = store.attachProject(workspace);
  const run = store.createRun(project.id, "Theme", "Add a persistent theme");
  return { store, run };
}

describe("HrpStore", () => {
  it("keeps one node per symbol and enforces dependency order", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "config", file: "config.json", symbol: "theme", title: "Declare theme", description: "Add the preference", rationale: "Shared contract", dependencies: [] },
      { id: "resolve", file: "A.ts", symbol: "A.method2", title: "Resolve theme", description: "Read the preference", rationale: "Centralize behavior", dependencies: ["config"] },
      { id: "save", file: "A.ts", symbol: "A.method1", title: "Save theme", description: "Persist the preference", rationale: "Keep it across launches", dependencies: [] },
    ] });
    store.approveNodes(run.id);
    expect(() => store.startNode(run.id, "resolve")).toThrow(/Incomplete dependencies/);
    store.startNode(run.id, "config");
    store.publishPatch(run.id, "config", "Declared theme", "@@ config.json\n+  \"theme\": \"system\"", "The existing config is the shared source of truth");
    store.publishVerification(run.id, "config", { command: "npm test", output: "ok", exitCode: 0 });
    store.completeNode(run.id, "config");
    expect(store.getRunDetail(run.id)?.nodes.find((node) => node.id === "config")?.patchRationale).toBe("The existing config is the shared source of truth");
    expect(store.startNode(run.id, "resolve").status).toBe("running");
  });

  it("does not complete without diff and passing verification", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change method", description: "Do work", rationale: "Required", dependencies: [] },
    ] });
    store.approveNodes(run.id);
    store.startNode(run.id, "change");
    expect(() => store.completeNode(run.id, "change")).toThrow(/diff/i);
    store.publishPatch(run.id, "change", "Changed method", "@@ A.ts\n+return true");
    store.publishVerification(run.id, "change", { command: "npm test", output: "failed", exitCode: 1 });
    expect(() => store.completeNode(run.id, "change")).toThrow(/passing verification/i);
    expect(store.startNode(run.id, "change").status).toBe("running");
    expect(store.getRunDetail(run.id)?.activity.filter((event) => event.nodeId === "change" && event.type === "verify")).toHaveLength(1);
  });

  it("rejects diffs that never reference the node file", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "src/A.ts", symbol: "A.method", title: "Change method", description: "Do work", rationale: "Required", dependencies: [] },
    ] });
    store.approveNodes(run.id);
    store.startNode(run.id, "change");
    expect(() => store.publishPatch(run.id, "change", "Changed method", "+return true")).toThrow(/not attributable/i);
    store.publishPatch(run.id, "change", "Changed method", "--- /tmp/A.ts.before\n+++ src/A.ts\n+return true");
    expect(store.getRunDetail(run.id)?.nodes.find((node) => node.id === "change")?.diff).toContain("src/A.ts");
  });

  it("rejects diffs that mix files from other operations", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "src/A.ts", symbol: "A.method", title: "Change method", description: "Do work", rationale: "Required", dependencies: [] },
      { id: "created", file: "src/New.ts", symbol: "New", title: "New module", description: "Create it", rationale: "Required", dependencies: [] },
    ] });
    store.approveNodes(run.id);
    store.startNode(run.id, "change");
    const mixed = "diff --git a/src/A.ts b/src/A.ts\n+++ b/src/A.ts\n+return true\ndiff --git a/src/Server.ts b/src/Server.ts\n+++ b/src/Server.ts\n+wire()";
    expect(() => store.publishPatch(run.id, "change", "Changed method", mixed)).toThrow(/src\/Server\.ts/);
    store.publishPatch(run.id, "change", "Changed method", "@@ src/A.ts\n+return true");
    store.publishVerification(run.id, "change", { command: "npm test", output: "ok", exitCode: 0 });
    store.completeNode(run.id, "change");
    store.startNode(run.id, "created");
    store.publishPatch(run.id, "created", "Created module", "diff --git a/src/New.ts b/src/New.ts\n--- /dev/null\n+++ b/src/New.ts\n+export const value = 1;");
    expect(store.getRunDetail(run.id)?.nodes.find((node) => node.id === "created")?.diff).toContain("/dev/null");
  });

  it("gates node starts behind human approval", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change method", description: "Do work", rationale: "Required", dependencies: [] },
    ] });
    expect(() => store.startNode(run.id, "change")).toThrow(/human approval/i);
    store.approveNodes(run.id, ["change"]);
    expect(store.startNode(run.id, "change").status).toBe("running");
    expect(() => store.approveNodes(run.id)).toThrow(/No nodes are awaiting approval/);
  });

  it("runs one node at a time per execution", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "first", file: "A.ts", symbol: "A.first", title: "First", description: "Work", rationale: "Required", dependencies: [] },
      { id: "second", file: "B.ts", symbol: "B.second", title: "Second", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    store.approveNodes(run.id);
    store.startNode(run.id, "first");
    expect(() => store.startNode(run.id, "second")).toThrow(/one node at a time/i);
  });

  it("enforces the human assignment when the agent declares itself", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change method", description: "Do work", rationale: "Required", dependencies: [] },
    ] });
    store.approveNodes(run.id);
    expect(store.assignNode(run.id, "change", "codex").assignee).toBe("codex");
    expect(() => store.startNode(run.id, "change", "claude")).toThrow(/assigned to codex/);
    expect(store.startNode(run.id, "change", "codex").status).toBe("running");
    expect(store.assignNode(run.id, "change", null).assignee).toBeUndefined();
  });

  it("labels operations discovered during execution", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "base", file: "A.ts", symbol: "A.base", title: "Base", description: "Base work", rationale: "Start", dependencies: [] },
    ] });
    const node = store.addDiscoveredNode(run.id, {
      id: "extra", file: "config.json", symbol: "feature.enabled", title: "Enable feature", description: "Add config", rationale: "Discovered constraint", dependencies: ["base"],
    });
    expect(node.discovered).toBe(true);
    expect(node.approved).toBe(false);
    expect(store.getRunDetail(run.id)?.activity.some((event) => event.type === "inspect")).toBe(true);
  });

  it("records the graph publisher as base agent and assigns discovered work to it", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "base", file: "A.ts", symbol: "A.base", title: "Base", description: "Base work", rationale: "Start", dependencies: [] },
    ] }, "claude");
    expect(store.getRun(run.id)?.baseAgent).toBe("claude");
    expect(store.getRun(run.id)?.seenAgents).toContain("claude");
    store.publishGraph(run.id, { nodes: [
      { id: "other", file: "B.ts", symbol: "B.other", title: "Other", description: "Work", rationale: "Required", dependencies: [] },
    ] }, "codex");
    expect(store.getRun(run.id)?.baseAgent).toBe("claude");
    const discovered = store.addDiscoveredNode(run.id, {
      id: "extra", file: "C.ts", symbol: "C.extra", title: "Extra", description: "Add", rationale: "Found", dependencies: [],
    });
    expect(discovered.assignee).toBe("claude");
  });

  it("registers agent presence on successful starts", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [] },
    ] }, "claude");
    store.approveNodes(run.id);
    expect(store.getRun(run.id)?.seenAgents).not.toContain("codex");
    store.startNode(run.id, "change", "codex");
    expect(store.getRun(run.id)?.seenAgents).toEqual(expect.arrayContaining(["claude", "codex"]));
  });

  it("rejects dependency cycles before persisting the graph", () => {
    const { store, run } = fixture();
    expect(() => store.publishGraph(run.id, { nodes: [
      { id: "first", file: "A.ts", symbol: "A.first", title: "First", description: "First change", rationale: "Required", dependencies: ["second"] },
      { id: "second", file: "B.ts", symbol: "B.second", title: "Second", description: "Second change", rationale: "Required", dependencies: ["first"] },
    ] })).toThrow(/Dependency cycle/);
    expect(store.getRunDetail(run.id)?.nodes).toHaveLength(0);
  });
});
