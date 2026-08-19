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
    store.startNode(run.id, "change");
    expect(() => store.publishPatch(run.id, "change", "Changed method", "+return true")).toThrow(/not attributable/i);
    store.publishPatch(run.id, "change", "Changed method", "--- /tmp/A.ts.before\n+++ src/A.ts\n+return true");
    expect(store.getRunDetail(run.id)?.nodes.find((node) => node.id === "change")?.diff).toContain("src/A.ts");
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
    expect(store.getRunDetail(run.id)?.activity.some((event) => event.type === "inspect")).toBe(true);
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
