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
  store.setRunAuditors(run.id, ["codex"]);
  return { store, run };
}

describe("HrpStore", () => {
  it("persists the selected auditors and locks them when the graph is approved", () => {
    const { store, run } = fixture();
    store.setRunAuditors(run.id, []);
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    expect(() => store.approveNodes(run.id)).toThrow(/auditor/i);
    expect(store.setRunAuditors(run.id, ["claude", "antigravity", "claude"]).auditors).toEqual(["claude", "antigravity"]);
    expect(store.getRunDetail(run.id)?.agentStates.map((state) => state.agent).sort()).toEqual(["antigravity", "claude"]);
    store.approveNodes(run.id);
    expect(() => store.setRunAuditors(run.id, ["codex"])).toThrow(/locked/i);
  });

  it("does not authorize an Ollama auditor without a configured API key", () => {
    const { store, run } = fixture();
    store.setRunAuditors(run.id, ["ollama"]);
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    expect(() => store.approveNodes(run.id)).toThrow(/not configured/i);
    store.setOllamaSettings({ apiKey: "qa-key" });
    expect(store.approveNodes(run.id)).toHaveLength(1);
  });

  it("reports observable agent work without exposing private reasoning", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [], suggestedAgent: "codex" },
    ] });
    store.approveNodes(run.id);
    store.startNode(run.id, "change", "codex");
    expect(store.getRunDetail(run.id)?.agentStates.find((state) => state.agent === "codex")).toMatchObject({
      phase: "executing", currentNodeId: "change", completed: 0, total: 1,
    });
    store.publishPatch(run.id, "change", "Changed method", "@@ A.ts\n+return true");
    store.publishVerification(run.id, "change", { command: "npm test", output: "ok", exitCode: 0 });
    store.completeNode(run.id, "change");
    expect(store.getRunDetail(run.id)?.agentStates.find((state) => state.agent === "codex")).toMatchObject({
      phase: "completed", completed: 1, total: 1, remainingNodeIds: [],
    });
  });

  it("rejects attaching the filesystem root or the home directory", () => {
    const { store } = fixture();
    expect(() => store.attachProject("/")).toThrow(/filesystem root or the home directory/);
    expect(() => store.attachProject(os.homedir())).toThrow(/filesystem root or the home directory/);
  });

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
    expect(() => store.completeNode(run.id, "change")).toThrow(/retry first/i);
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

  it("freezes assignment while a node runs and stores reported tokens", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    store.approveNodes(run.id);
    store.startNode(run.id, "change", "codex");
    expect(() => store.assignNode(run.id, "change", "claude")).toThrow(/cannot be reassigned/i);
    store.publishPatch(run.id, "change", "Changed method", "@@ A.ts\n+return true");
    store.publishVerification(run.id, "change", { command: "npm test", output: "ok", exitCode: 0 });
    const completed = store.completeNode(run.id, "change", 48000);
    expect(completed.tokens).toBe(48000);
    expect(store.getRunDetail(run.id)?.activity.some((event) => event.message.includes("~48k tokens"))).toBe(true);
  });

  it("enforces the human assignment when the agent declares itself", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change method", description: "Do work", rationale: "Required", dependencies: [] },
    ] });
    store.approveNodes(run.id);
    expect(store.assignNode(run.id, "change", "codex").assignee).toBe("codex");
    expect(() => store.startNode(run.id, "change", "claude")).toThrow(/assigned to codex/);
    expect(store.assignNode(run.id, "change", null).assignee).toBeUndefined();
    store.assignNode(run.id, "change", "codex");
    expect(store.startNode(run.id, "change", "codex").status).toBe("running");
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

  it("approves discovered work on the spot while the initial graph keeps the human gate", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "base", file: "A.ts", symbol: "A.base", title: "Base", description: "Base work", rationale: "Start", dependencies: [] },
    ] }, "claude");
    // El plan lo aprueba el humano; lo que aparece mientras se implementa, no:
    // frenar cada descubrimiento en un clic es lo que dejaba ciegos a los agentes.
    expect(store.getRunDetail(run.id)?.nodes[0].approved).toBe(false);
    expect(() => store.startNode(run.id, "base", "claude")).toThrow(/approval/i);

    const discovered = store.addDiscoveredNode(run.id, {
      id: "extra", file: "B.ts", symbol: "B.extra", title: "Extra", description: "Add", rationale: "Found", dependencies: [],
    });
    expect(discovered.approved).toBe(true);
    expect(discovered.assignee).toBe("claude");
    expect(store.getRunDetail(run.id)?.activity.some((event) => event.message.includes("Aprobado automáticamente"))).toBe(true);
    expect(store.startNode(run.id, "extra", "claude").status).toBe("running");
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

  it("persists the executing agent on start", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "a", file: "A.ts", symbol: "A.a", title: "A", description: "Work", rationale: "Required", dependencies: [] },
      { id: "b", file: "B.ts", symbol: "B.b", title: "B", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    store.approveNodes(run.id);
    expect(store.startNode(run.id, "a", "codex").executedBy).toBe("codex");
    store.publishPatch(run.id, "a", "done", "@@ A.ts\n+x");
    store.publishVerification(run.id, "a", { command: "true", output: "", exitCode: 0 });
    store.completeNode(run.id, "a");
    expect(store.startNode(run.id, "b").executedBy).toBeUndefined();
  });

  it("registers agent presence from an explicit hello", () => {
    const { store, run } = fixture();
    expect(store.helloAgent(run.id, "codex").seenAgents).toContain("codex");
    expect(store.helloAgent(run.id, "codex").seenAgents).toEqual(["codex"]);
    expect(() => store.helloAgent("missing-run", "codex")).toThrow(/Unknown run/);
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

  it("persists ollama settings, updates the model without resending the key, and clears it", () => {
    const { store } = fixture();
    expect(store.getOllamaSettingsView()).toMatchObject({ configured: false, model: "kimi-k2.7-code", baseUrl: "https://ollama.com" });
    store.setOllamaSettings({ apiKey: "sk-secreta-9876" });
    expect(store.getOllamaSettingsView()).toMatchObject({ configured: true, keyMask: "…9876" });
    store.setOllamaSettings({ model: "otro-modelo", baseUrl: "https://ollama.example/" });
    expect(store.getOllamaSettings()).toMatchObject({ apiKey: "sk-secreta-9876", model: "otro-modelo", baseUrl: "https://ollama.example" });
    store.setOllamaSettings({ apiKey: null });
    expect(store.getOllamaSettingsView().configured).toBe(false);
  });

  it("keeps ollama settings across store reopenings", () => {
    const { store } = fixture();
    store.setOllamaSettings({ apiKey: "sk-persistente-4321" });
    const dataDirectory = store.dataDirectory;
    store.close();
    const reopened = new HrpStore(dataDirectory);
    expect(reopened.getOllamaSettingsView()).toMatchObject({ configured: true, keyMask: "…4321" });
    reopened.close();
  });

  it("stores the suggested agent and pre-assigns it without overriding human choices", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "delegable", file: "A.ts", symbol: "A.a", title: "Delegable", description: "Mechanical work", rationale: "Cheap model suffices", dependencies: [], suggestedAgent: "ollama" },
      { id: "propio", file: "B.ts", symbol: "B.b", title: "Propio", description: "Core work", rationale: "Needs the base model", dependencies: [] },
    ] });
    const nodes = store.getRunDetail(run.id)!.nodes;
    expect(nodes.find((node) => node.id === "delegable")).toMatchObject({ suggestedAgent: "ollama", assignee: "ollama" });
    expect(nodes.find((node) => node.id === "propio")?.assignee).toBeUndefined();
    store.assignNode(run.id, "delegable", "claude");
    store.publishGraph(run.id, { nodes: [
      { id: "delegable", file: "A.ts", symbol: "A.a", title: "Delegable", description: "Mechanical work", rationale: "Cheap model suffices", dependencies: [], suggestedAgent: "ollama" },
    ] });
    expect(store.getRunDetail(run.id)!.nodes.find((node) => node.id === "delegable")?.assignee).toBe("claude");
  });

  it("assigns discovered nodes to their suggested agent instead of the base agent", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "seed", file: "A.ts", symbol: "A.seed", title: "Seed", description: "Work", rationale: "Required", dependencies: [] },
    ] }, "claude");
    const discovered = store.addDiscoveredNode(run.id, { id: "extra", file: "B.ts", symbol: "B.extra", title: "Extra", description: "Follow-up", rationale: "Found later", dependencies: [], suggestedAgent: "ollama" });
    expect(discovered.assignee).toBe("ollama");
    const fallback = store.addDiscoveredNode(run.id, { id: "extra2", file: "C.ts", symbol: "C.extra", title: "Extra 2", description: "Follow-up", rationale: "Found later", dependencies: [] });
    expect(fallback.assignee).toBe("claude");
  });

  it("persists contextFiles and treats them as approved semantics", () => {
    const { store, run } = fixture();
    const nodes = [
      { id: "uno", file: "A.ts", symbol: "A.a", title: "Uno", description: "Cambio uno", rationale: "Prueba", dependencies: [], contextFiles: ["contracts.ts"] },
      { id: "dos", file: "B.ts", symbol: "B.b", title: "Dos", description: "Cambio dos", rationale: "Prueba", dependencies: [] },
    ];
    store.publishGraph(run.id, { nodes });
    expect(store.getRunDetail(run.id)?.nodes.find((node) => node.id === "uno")?.contextFiles).toEqual(["contracts.ts"]);
    store.approveNodes(run.id);
    store.publishGraph(run.id, { nodes });
    expect(store.getRunDetail(run.id)?.nodes.every((node) => node.approved)).toBe(true);
    // Cambiar solo el contexto altera lo que verá el modelo delegado: re-aprobación.
    store.publishGraph(run.id, { nodes: [{ ...nodes[0], contextFiles: ["contracts.ts", "extra.ts"] }, nodes[1]] });
    const after = store.getRunDetail(run.id)!.nodes;
    expect(after.find((node) => node.id === "uno")?.approved).toBe(false);
    expect(after.find((node) => node.id === "dos")?.approved).toBe(true);
  });

  it("republishing an identical graph keeps human approval; a real change resets it", () => {
    const { store, run } = fixture();
    const nodes = [
      { id: "uno", file: "A.ts", symbol: "A.a", title: "Uno", description: "Cambio uno", rationale: "Prueba", dependencies: [] },
      { id: "dos", file: "B.ts", symbol: "B.b", title: "Dos", description: "Cambio dos", rationale: "Prueba", dependencies: [] },
    ];
    store.publishGraph(run.id, { nodes });
    store.approveNodes(run.id);
    store.publishGraph(run.id, { nodes });
    expect(store.getRunDetail(run.id)?.nodes.every((node) => node.approved)).toBe(true);
    store.publishGraph(run.id, { nodes: [nodes[0], { ...nodes[1], description: "Cambio dos ajustado" }] });
    const after = store.getRunDetail(run.id)!.nodes;
    expect(after.find((node) => node.id === "uno")?.approved).toBe(true);
    expect(after.find((node) => node.id === "dos")?.approved).toBe(false);
  });

  it("pausing and stopping block node starts for every agent until resumed", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "uno", file: "A.ts", symbol: "A.a", title: "Uno", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    store.approveNodes(run.id);
    expect(store.getRun(run.id)?.control).toBe("active");
    store.setRunControl(run.id, "paused");
    expect(() => store.startNode(run.id, "uno", "claude")).toThrow(/paused by the human/);
    expect(() => store.startNode(run.id, "uno", "ollama")).toThrow(/paused by the human/);
    store.setRunControl(run.id, "active");
    expect(store.startNode(run.id, "uno", "claude").status).toBe("running");
    store.setRunControl(run.id, "stopped");
    expect(() => store.startNode(run.id, "uno")).toThrow(/stopped by the human/);
    expect(store.getRun(run.id)?.control).toBe("stopped");
    expect(store.getRunDetail(run.id)?.activity.some((event) => event.message.includes("detenida por el humano"))).toBe(true);
  });

  it("rejects dependency cycles before persisting the graph", () => {
    const { store, run } = fixture();
    expect(() => store.publishGraph(run.id, { nodes: [
      { id: "first", file: "A.ts", symbol: "A.first", title: "First", description: "First change", rationale: "Required", dependencies: ["second"] },
      { id: "second", file: "B.ts", symbol: "B.second", title: "Second", description: "Second change", rationale: "Required", dependencies: ["first"] },
    ] })).toThrow(/Dependency cycle/);
    expect(store.getRunDetail(run.id)?.nodes).toHaveLength(0);
  });

  describe("findings (revisión multi-modelo)", () => {
    function reviewFixture() {
      const { store, run } = fixture();
      store.publishGraph(run.id, { nodes: [
        { id: "uno", file: "A.ts", symbol: "A.a", title: "Uno", description: "Work", rationale: "Required", dependencies: [] },
      ] });
      return { store, run };
    }

    it("creates findings as open and validates severity and node", () => {
      const { store, run } = reviewFixture();
      expect(() => store.createFinding(run.id, { reviewer: "codex", severity: "grave" as never, title: "x", body: "y" })).toThrow(/severity/i);
      expect(() => store.createFinding(run.id, { reviewer: "codex", severity: "major", title: "x", body: "y", nodeId: "fantasma" })).toThrow(/Unknown node/);
      const finding = store.createFinding(run.id, { reviewer: "codex", severity: "major", title: "Contrato roto", body: "Detalle", nodeId: "uno" });
      expect(finding.status).toBe("open");
      expect(finding.messages).toHaveLength(0);
      expect(store.getRunDetail(run.id)?.findings).toHaveLength(1);
    });

    it("replies promote open to debating without regressing terminal states", () => {
      const { store, run } = reviewFixture();
      const finding = store.createFinding(run.id, { reviewer: "codex", severity: "minor", title: "Duda", body: "Detalle" });
      const debated = store.addFindingMessage(finding.id, "claude", "No coincido");
      expect(debated.status).toBe("debating");
      expect(debated.messages.map((message) => message.author)).toEqual(["claude"]);
      store.setFindingStatus(finding.id, "rejected");
      expect(store.addFindingMessage(finding.id, "human", "De acuerdo con el rechazo").status).toBe("rejected");
    });

    it("accept links an existing resolution node and clears the gate", () => {
      const { store, run } = reviewFixture();
      const finding = store.createFinding(run.id, { reviewer: "codex", severity: "critical", title: "Falla", body: "Detalle", nodeId: "uno" });
      store.setFindingStatus(finding.id, "escalated");
      expect(store.runReviewGate(run.id).map((pending) => pending.id)).toEqual([finding.id]);
      expect(store.getRun(run.id)?.openFindings).toBe(1);
      expect(() => store.setFindingStatus(finding.id, "accepted", "fantasma")).toThrow(/Unknown node/);
      const accepted = store.setFindingStatus(finding.id, "accepted", "uno");
      expect(accepted.resolutionNodeId).toBe("uno");
      expect(store.runReviewGate(run.id)).toHaveLength(0);
      expect(store.getRun(run.id)?.openFindings).toBe(0);
    });

    it("counts only live statuses in openFindings and orders thread messages", () => {
      const { store, run } = reviewFixture();
      const abierto = store.createFinding(run.id, { reviewer: "codex", severity: "major", title: "Abierto", body: "a" });
      store.createFinding(run.id, { reviewer: "gemini", severity: "question", title: "Rechazado", body: "b" });
      const rechazado = store.getRunDetail(run.id)!.findings[1];
      store.setFindingStatus(rechazado.id, "rejected");
      store.addFindingMessage(abierto.id, "claude", "primera");
      store.addFindingMessage(abierto.id, "human", "segunda");
      expect(store.getRun(run.id)?.openFindings).toBe(1);
      expect(store.runReviewGate(run.id).map((pending) => pending.title)).toEqual(["Abierto"]);
      expect(store.getFinding(abierto.id)?.messages.map((message) => message.body)).toEqual(["primera", "segunda"]);
    });

    it("keeps selected auditors in the gate until they complete their coverage", () => {
      const { store, run } = reviewFixture();
      store.setRunAuditors(run.id, ["claude"]);
      const progress = (phase: "reviewing" | "failed" | "completed") => store.setAgentState(run.id, {
        agent: "claude",
        phase,
        summary: phase === "completed" ? "Auditoría terminada" : "Auditando el run",
        completed: phase === "completed" ? 1 : 0,
        total: 1,
        reviewedNodeIds: phase === "completed" ? ["uno"] : [],
        remainingNodeIds: phase === "completed" ? [] : ["uno"],
      });

      expect(store.pendingAuditors(run.id).map((state) => state.phase)).toEqual(["waiting"]);
      expect(store.getRun(run.id)?.pendingAuditorCount).toBe(1);
      progress("reviewing");
      expect(store.pendingAuditors(run.id).map((state) => state.phase)).toEqual(["reviewing"]);
      expect(store.getRun(run.id)?.pendingAuditorCount).toBe(1);
      progress("failed");
      expect(store.pendingAuditors(run.id).map((state) => state.phase)).toEqual(["failed"]);
      expect(store.getRun(run.id)?.pendingAuditorCount).toBe(1);
      progress("completed");
      expect(store.pendingAuditors(run.id)).toHaveLength(0);
      expect(store.getRun(run.id)?.pendingAuditorCount).toBe(0);

      store.createFinding(run.id, { reviewer: "claude", severity: "major", title: "Contrato roto", body: "Detalle" });
      expect(store.runReviewGate(run.id)).toHaveLength(1);
      expect(store.pendingAuditors(run.id)).toHaveLength(0);
    });

    it("separates auditors without a vote from votes needed for majority", () => {
      const { store, run } = reviewFixture();
      store.setRunAuditors(run.id, ["claude", "codex", "antigravity"]);
      const complete = (agent: string) => store.setAgentState(run.id, {
        agent,
        phase: "completed",
        summary: "Auditoría terminada",
        completed: 1,
        total: 1,
        reviewedNodeIds: ["uno"],
        remainingNodeIds: [],
      });

      expect(store.pendingAuditors(run.id).map((state) => state.agent)).toEqual(["claude", "codex", "antigravity"]);
      expect(store.getRun(run.id)).toMatchObject({ pendingAuditorCount: 3, pendingAuditorVotes: 2 });
      expect(store.pendingAuditorVotes(run.id)).toBe(2);

      complete("claude");
      expect(store.pendingAuditors(run.id).map((state) => state.agent)).toEqual(["codex", "antigravity"]);
      expect(store.getRun(run.id)).toMatchObject({ pendingAuditorCount: 2, pendingAuditorVotes: 1 });
      expect(store.pendingAuditorVotes(run.id)).toBe(1);

      complete("antigravity");
      expect(store.pendingAuditors(run.id).map((state) => state.agent)).toEqual(["codex"]);
      expect(store.getRun(run.id)).toMatchObject({ pendingAuditorCount: 1, pendingAuditorVotes: 0 });
      expect(store.pendingAuditorVotes(run.id)).toBe(0);
    });

    it("keeps auditor coverage when a finding is rejected or reopened", () => {
      const { store, run } = reviewFixture();
      store.setRunAuditors(run.id, ["claude", "codex", "antigravity"]);
      for (const agent of ["claude", "codex", "antigravity"]) {
        store.setAgentState(run.id, {
          agent,
          phase: "completed",
          summary: "Auditoría terminada",
          completed: 1,
          total: 1,
          reviewedNodeIds: ["uno"],
          remainingNodeIds: [],
        });
      }
      const finding = store.createFinding(run.id, { reviewer: "claude", severity: "major", title: "Contrato roto", body: "Detalle" });
      expect(store.pendingAuditors(run.id)).toHaveLength(0);
      expect(store.pendingAuditorVotes(run.id)).toBe(0);

      store.addFindingMessage(finding.id, "codex", "No procede por contrato X.");
      const rejected = store.setFindingStatus(finding.id, "rejected");
      expect(rejected.status).toBe("rejected");
      expect(store.runReviewGate(run.id)).toHaveLength(0);
      expect(store.pendingAuditors(run.id)).toHaveLength(0);
      expect(store.pendingAuditorVotes(run.id)).toBe(0);
      expect(store.getRunDetail(run.id)?.agentStates.filter((state) => state.phase === "completed")).toHaveLength(3);

      store.addFindingMessage(finding.id, "antigravity", "Reabro: falta cubrir el caso Y.");
      const reopened = store.setFindingStatus(finding.id, "open");
      expect(reopened.status).toBe("open");
      expect(store.runReviewGate(run.id).map((pending) => pending.id)).toEqual([finding.id]);
      expect(store.getRun(run.id)?.openFindings).toBe(1);
      expect(store.pendingAuditors(run.id)).toHaveLength(0);
      expect(store.pendingAuditorVotes(run.id)).toBe(0);
    });

    it("keeps the published coverage when a later status omits it", () => {
      const { store, run } = reviewFixture();
      store.setRunAuditors(run.id, ["claude"]);
      store.setAgentState(run.id, {
        agent: "claude",
        phase: "reviewing",
        summary: "Auditando el run",
        completed: 1,
        total: 1,
        reviewedNodeIds: ["uno"],
        remainingNodeIds: [],
      });

      const closed = store.setAgentState(run.id, { agent: "claude", phase: "completed", summary: "Auditoría terminada" });
      expect(closed).toMatchObject({ completed: 1, total: 1, reviewedNodeIds: ["uno"], remainingNodeIds: [] });
      expect(store.getRunDetail(run.id)?.agentStates.find((state) => state.agent === "claude")?.reviewedNodeIds).toEqual(["uno"]);
      expect(store.pendingAuditors(run.id)).toHaveLength(0);

      const reopened = store.setAgentState(run.id, {
        agent: "claude", phase: "reviewing", summary: "Nueva pasada", completed: 0, reviewedNodeIds: [], remainingNodeIds: ["uno"],
      });
      expect(reopened).toMatchObject({ completed: 0, total: 1, reviewedNodeIds: [], remainingNodeIds: ["uno"] });

      // Las validaciones miran la cobertura fusionada, no sólo lo recibido.
      expect(() => store.setAgentState(run.id, { agent: "claude", phase: "reviewing", summary: "Solape", reviewedNodeIds: ["uno"] }))
        .toThrow(/reviewed and remaining/);
      expect(() => store.setAgentState(run.id, { agent: "claude", phase: "reviewing", summary: "Exceso", completed: 5 }))
        .toThrow(/exceed its total/);
    });

    it("persists and returns the agent associated with activity events", () => {
      const { store, run } = reviewFixture();
      const activity = store.addActivity(run.id, "note", "Prueba de autor", "Detalle de prueba", undefined, "antigravity");
      expect(activity.agent).toBe("antigravity");

      const detail = store.getRunDetail(run.id);
      const found = detail?.activity.find((item) => item.id === activity.id);
      expect(found?.agent).toBe("antigravity");
      expect(found?.message).toBe("Prueba de autor");
    });

    it("attributes node lifecycle and human actions to the corresponding agent in activity", () => {
      const { store, run } = reviewFixture();
      store.publishGraph(run.id, { nodes: [
        { id: "uno", file: "A.ts", symbol: "A.a", title: "Uno", description: "Work", rationale: "Required", dependencies: [] },
        { id: "dos", file: "B.ts", symbol: "B.b", title: "Dos", description: "Work", rationale: "Required", dependencies: [] },
      ] }, "base-model");
      store.approveNodes(run.id);

      // Human actions (approval, assign, control, set auditors)
      expect(store.getRunDetail(run.id)?.activity.some((item) => item.agent === "human" && item.message.toLowerCase().includes("aprobado"))).toBe(true);

      // Node executed with explicit agent
      store.startNode(run.id, "uno", "worker-1");
      store.publishPatch(run.id, "uno", "Parche worker", "@@ A.ts\n+1");
      store.publishVerification(run.id, "uno", { command: "test", output: "ok", exitCode: 0 });
      store.completeNode(run.id, "uno");

      const detail = store.getRunDetail(run.id)!;
      const workerEvents = detail.activity.filter((item) => item.nodeId === "uno" && !item.message.includes("Aprobado"));
      expect(workerEvents.length).toBeGreaterThanOrEqual(4);
      for (const event of workerEvents) {
        expect(event.agent).toBe("worker-1");
      }

      // Node executed without explicit agent (should fallback to baseAgent)
      store.startNode(run.id, "dos");
      store.publishPatch(run.id, "dos", "Parche base", "@@ B.ts\n+2");
      store.publishVerification(run.id, "dos", { command: "test2", output: "ok", exitCode: 0 });
      store.completeNode(run.id, "dos");

      const detail2 = store.getRunDetail(run.id)!;
      const baseEvents = detail2.activity.filter((item) => item.nodeId === "dos" && !item.message.includes("Aprobado"));
      expect(baseEvents.length).toBeGreaterThanOrEqual(4);
      for (const event of baseEvents) {
        expect(event.agent).toBe("base-model");
      }
    });
  });
});
