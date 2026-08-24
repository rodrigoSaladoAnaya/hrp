import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./http.js";
import { HrpStore } from "./store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function approveGraph(store: HrpStore, runId: string, nodeIds?: string[]) {
  return store.approveNodes(runId, nodeIds);
}

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

function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initGitWorkspace(workspace: string): string {
  git(workspace, ["init", "-b", "main"]);
  git(workspace, ["config", "user.email", "hrp@example.test"]);
  git(workspace, ["config", "user.name", "HRP Test"]);
  writeFileSync(path.join(workspace, "README.md"), "baseline\n");
  git(workspace, ["add", "README.md"]);
  git(workspace, ["commit", "-m", "initial"]);
  return git(workspace, ["branch", "--show-current"]);
}

describe("HrpStore", () => {
  it("persists the selected auditors and locks them when the graph is approved", () => {
    const { store, run } = fixture();
    store.setRunAuditors(run.id, []);
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    expect(() => approveGraph(store, run.id)).toThrow(/auditor/i);
    expect(store.setRunAuditors(run.id, ["claude", "antigravity", "claude"]).auditors).toEqual(["claude", "antigravity"]);
    expect(store.getRunDetail(run.id)?.agentStates.map((state) => state.agent).sort()).toEqual(["antigravity", "claude"]);
    approveGraph(store, run.id);
    expect(() => store.setRunAuditors(run.id, ["codex"])).toThrow(/locked/i);
  });

  it("does not authorize an Ollama auditor without a configured API key", () => {
    const { store, run } = fixture();
    store.setRunAuditors(run.id, ["ollama"]);
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    expect(() => approveGraph(store, run.id)).toThrow(/not configured/i);
    store.setOllamaSettings({ apiKey: "qa-key" });
    expect(approveGraph(store, run.id)).toHaveLength(1);
  });

  it("returns UI preference defaults before any value is persisted", () => {
    const { store } = fixture();
    expect(store.getUiPreferences()).toEqual({
      viewShortcuts: {
        enabled: true,
        modifier: "meta",
      },
    });
  });

  it("persists UI preferences while merging partial updates", () => {
    const { store } = fixture();
    expect(store.setUiPreferences({ viewShortcuts: { enabled: false, modifier: "ctrl" } })).toEqual({
      viewShortcuts: {
        enabled: false,
        modifier: "ctrl",
      },
    });
    expect(store.setUiPreferences({ viewShortcuts: { enabled: true } })).toEqual({
      viewShortcuts: {
        enabled: true,
        modifier: "ctrl",
      },
    });
    expect(store.getUiPreferences()).toEqual({
      viewShortcuts: {
        enabled: true,
        modifier: "ctrl",
      },
    });
  });

  it("reports observable agent work without exposing private reasoning", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [], suggestedAgent: "codex" },
    ] });
    approveGraph(store, run.id);
    store.startNode(run.id, "change", "codex");
    expect(store.getRunDetail(run.id)?.agentStates.find((state) => state.agent === "codex")).toMatchObject({
      phase: "executing", currentNodeId: "change", completed: 0, total: 1,
    });
    store.publishPatch(run.id, "change", "Changed method", "@@ A.ts\n+return true");
    store.publishVerification(run.id, "change", { command: "npm test", output: "ok", exitCode: 0 });
    store.completeNode(run.id, "change");
    // La fixture elige a codex como auditor, así que terminar de implementar no
    // puede dejarlo en 'completed': esa fase cuenta como voto de auditoría y
    // aquí no ha revisado nada. El voto se declara aparte, con cobertura.
    expect(store.getRunDetail(run.id)?.agentStates.find((state) => state.agent === "codex")).toMatchObject({
      phase: "waiting", completed: 1, total: 1, remainingNodeIds: [],
    });
  });

  it("closes an implementer that does not audit in the completed phase", () => {
    const { store, run } = fixture();
    store.setRunAuditors(run.id, ["claude"]);
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    approveGraph(store, run.id);
    store.startNode(run.id, "change", "codex");
    store.publishPatch(run.id, "change", "Changed method", "@@ A.ts\n+return true");
    store.publishVerification(run.id, "change", { command: "npm test", output: "ok", exitCode: 0 });
    store.completeNode(run.id, "change");
    expect(store.getRunDetail(run.id)?.agentStates.find((state) => state.agent === "codex")).toMatchObject({
      phase: "completed", completed: 1, total: 1, remainingNodeIds: [],
    });
  });

  it("keeps startedAt when a later status omits it", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    store.setAgentState(run.id, {
      agent: "codex",
      phase: "reviewing",
      summary: "Auditando",
      completed: 0,
      total: 1,
      reviewedNodeIds: [],
      remainingNodeIds: ["change"],
      startedAt: "2026-08-21T00:30:00.000Z",
    });
    store.setAgentState(run.id, { agent: "codex", phase: "waiting", summary: "En espera" });
    expect(store.getRunDetail(run.id)?.agentStates.find((state) => state.agent === "codex")).toMatchObject({
      startedAt: "2026-08-21T00:30:00.000Z",
      reviewedNodeIds: [],
      remainingNodeIds: ["change"],
    });
  });

  // Estas pruebas escriben archivos de verdad en el workspace temporal: toda la
  // detección compara huellas contra el disco, así que simularla no probaría nada.
  const workspaceOf = (store: HrpStore, projectId: string) => store.getProject(projectId)!.workspaceRoot;

  it("does not create a safeguard branch when the Git workspace is clean", () => {
    const { store, run } = fixture();
    const workspace = workspaceOf(store, run.projectId);
    const initialBranch = initGitWorkspace(workspace);
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    approveGraph(store, run.id);
    store.startNode(run.id, "change", "codex");

    expect(git(workspace, ["branch", "--show-current"])).toBe(initialBranch);
    expect(store.getRun(run.id)?.changeBranch).toBeUndefined();
    expect(store.getRunDetail(run.id)?.activity.some((event) => event.message.includes("Branch de salvaguarda"))).toBe(false);
  });

  it("creates and reuses a safeguard branch when a run has pending Git changes", () => {
    const { store, run } = fixture();
    const workspace = workspaceOf(store, run.projectId);
    initGitWorkspace(workspace);
    store.publishGraph(run.id, { nodes: [
      { id: "first", file: "A.ts", symbol: "A.first", title: "First", description: "Work", rationale: "Required", dependencies: [] },
      { id: "second", file: "B.ts", symbol: "B.second", title: "Second", description: "Work", rationale: "Required", dependencies: ["first"] },
    ] });
    approveGraph(store, run.id);

    // El cambio pendiente tiene que ser rastreado: los archivos sin seguimiento
    // no producen branch porque cambiar de rama no los resguarda.
    writeFileSync(path.join(workspace, "A.ts"), "baseline\n");
    git(workspace, ["add", "A.ts"]);
    git(workspace, ["commit", "-m", "track A"]);
    writeFileSync(path.join(workspace, "A.ts"), "pending\n");
    store.startNode(run.id, "first", "codex");

    const branch = `hrp/run-${run.id}`;
    expect(git(workspace, ["branch", "--show-current"])).toBe(branch);
    expect(store.getRun(run.id)?.changeBranch).toBe(branch);
    expect(git(workspace, ["status", "--porcelain"])).toContain("A.ts");

    store.publishPatch(run.id, "first", "Created A", "diff --git a/A.ts b/A.ts\n--- /dev/null\n+++ b/A.ts\n+pending\n");
    store.publishVerification(run.id, "first", { command: "npm test -- A.ts", output: "ok", exitCode: 0 });
    store.completeNode(run.id, "first");
    git(workspace, ["add", "A.ts"]);
    git(workspace, ["commit", "-m", "save first node"]);
    git(workspace, ["switch", "main"]);

    store.startNode(run.id, "second", "codex");
    expect(git(workspace, ["branch", "--show-current"])).toBe(branch);
    expect(store.getRunDetail(run.id)?.activity.filter((event) => event.message.includes("Branch de salvaguarda"))).toHaveLength(2);
  });

  it("ignores untracked files when deciding whether the run needs a safeguard branch", () => {
    const { store, run } = fixture();
    const workspace = workspaceOf(store, run.projectId);
    const initialBranch = initGitWorkspace(workspace);
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    approveGraph(store, run.id);

    writeFileSync(path.join(workspace, "scratch.tmp"), "untracked\n");
    store.startNode(run.id, "change", "codex");

    expect(git(workspace, ["branch", "--show-current"])).toBe(initialBranch);
    expect(store.getRun(run.id)?.changeBranch).toBeUndefined();
    expect(store.getRunDetail(run.id)?.activity.some((event) => event.message.includes("Branch de salvaguarda"))).toBe(false);
  });

  it("refuses to open a safeguard branch over another live run's pending changes", () => {
    const { store, run } = fixture();
    const workspace = workspaceOf(store, run.projectId);
    initGitWorkspace(workspace);
    writeFileSync(path.join(workspace, "A.ts"), "baseline\n");
    git(workspace, ["add", "A.ts"]);
    git(workspace, ["commit", "-m", "track A"]);

    store.publishGraph(run.id, { nodes: [
      { id: "first", file: "A.ts", symbol: "A.first", title: "First", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    approveGraph(store, run.id);
    writeFileSync(path.join(workspace, "A.ts"), "pending\n");
    store.startNode(run.id, "first", "codex");

    const branch = `hrp/run-${run.id}`;
    expect(git(workspace, ["branch", "--show-current"])).toBe(branch);

    // Segunda ejecución del mismo workspace mientras la primera sigue viva y sin
    // commitear: su branch no debe nacer llevándose el trabajo ajeno.
    const other = store.createRun(run.projectId, "Otro", "Otro requerimiento");
    store.setRunAuditors(other.id, ["codex"]);
    store.publishGraph(other.id, { nodes: [
      { id: "second", file: "B.ts", symbol: "B.second", title: "Second", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    approveGraph(store, other.id);

    expect(() => store.startNode(other.id, "second", "codex")).toThrow(/belong to run/);
    expect(git(workspace, ["branch", "--list", `hrp/run-${other.id}`])).toBe("");
    expect(store.getRun(other.id)?.changeBranch).toBeUndefined();
    expect(git(workspace, ["branch", "--show-current"])).toBe(branch);
    expect(git(workspace, ["status", "--porcelain"])).toContain("A.ts");
  });

  it("warns when the file changed beyond what the published diff declares", () => {
    const { store, run } = fixture();
    const workspace = workspaceOf(store, run.projectId);
    writeFileSync(path.join(workspace, "A.ts"), "uno\ndos\n");
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    approveGraph(store, run.id);
    store.startNode(run.id, "change", "codex");
    // El nodo añade 'mia'; otra sesión añade 'ajena' en el mismo archivo.
    writeFileSync(path.join(workspace, "A.ts"), "uno\ndos\nmia\najena\n");
    store.publishPatch(run.id, "change", "Añade mia", "--- a/A.ts\n+++ b/A.ts\n@@\n uno\n dos\n+mia\n");

    const warning = store.getRunDetail(run.id)?.activity
      .find((event) => event.type === "note" && event.message.includes("más de lo que declara"));
    expect(warning).toBeDefined();
    expect(warning?.detail).toContain("ajena");
    expect(warning?.detail).not.toContain("sin declarar + mia");
  });

  it("does not warn when the diff explains the whole change", () => {
    const { store, run } = fixture();
    const workspace = workspaceOf(store, run.projectId);
    writeFileSync(path.join(workspace, "A.ts"), "uno\ndos\n");
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    approveGraph(store, run.id);
    store.startNode(run.id, "change", "codex");
    writeFileSync(path.join(workspace, "A.ts"), "uno\ndos\nmia\n");
    store.publishPatch(run.id, "change", "Añade mia", "--- a/A.ts\n+++ b/A.ts\n@@\n uno\n dos\n+mia\n");

    expect(store.getRunDetail(run.id)?.activity.some((event) => event.type === "note")).toBe(false);
  });

  it("warns when the file moved between one node and the next on the same file", () => {
    const { store, run } = fixture();
    const workspace = workspaceOf(store, run.projectId);
    writeFileSync(path.join(workspace, "A.ts"), "uno\n");
    store.publishGraph(run.id, { nodes: [
      { id: "primero", file: "A.ts", symbol: "A.uno", title: "Uno", description: "Work", rationale: "Required", dependencies: [] },
      { id: "segundo", file: "A.ts", symbol: "A.dos", title: "Dos", description: "Work", rationale: "Required", dependencies: ["primero"] },
    ] });
    approveGraph(store, run.id);
    store.startNode(run.id, "primero", "codex");
    writeFileSync(path.join(workspace, "A.ts"), "uno\ndos\n");
    store.publishPatch(run.id, "primero", "Añade dos", "--- a/A.ts\n+++ b/A.ts\n@@\n uno\n+dos\n");
    store.publishVerification(run.id, "primero", { command: "npm test", output: "ok", exitCode: 0 });
    store.completeNode(run.id, "primero");

    // Entre un nodo y el siguiente, alguien más toca el archivo.
    writeFileSync(path.join(workspace, "A.ts"), "uno\ndos\najena\n");
    store.startNode(run.id, "segundo", "codex");

    const warning = store.getRunDetail(run.id)?.activity
      .find((event) => event.type === "note" && event.message.includes("fuera de HRP antes de este nodo"));
    expect(warning).toBeDefined();
    expect(warning?.detail).toContain("primero");
  });

  it("reports each file as attributed, drifted or unknown", () => {
    const { store, run } = fixture();
    const workspace = workspaceOf(store, run.projectId);
    writeFileSync(path.join(workspace, "A.ts"), "uno\n");
    store.publishGraph(run.id, { nodes: [
      { id: "hecho", file: "A.ts", symbol: "A.uno", title: "Uno", description: "Work", rationale: "Required", dependencies: [] },
      { id: "sinhacer", file: "B.ts", symbol: "B.uno", title: "Dos", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    approveGraph(store, run.id);
    store.startNode(run.id, "hecho", "codex");
    writeFileSync(path.join(workspace, "A.ts"), "uno\ndos\n");
    store.publishPatch(run.id, "hecho", "Añade dos", "--- a/A.ts\n+++ b/A.ts\n@@\n uno\n+dos\n");
    store.publishVerification(run.id, "hecho", { command: "npm test", output: "ok", exitCode: 0 });
    store.completeNode(run.id, "hecho");

    expect(store.workspaceAttribution(run.id)).toMatchObject([
      { file: "A.ts", nodeId: "hecho", status: "attributed" },
      { file: "B.ts", status: "unknown" },
    ]);

    writeFileSync(path.join(workspace, "A.ts"), "uno\ndos\najena\n");
    expect(store.workspaceAttribution(run.id)[0]).toMatchObject({ file: "A.ts", nodeId: "hecho", status: "drifted" });
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
    approveGraph(store, run.id);
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
    approveGraph(store, run.id);
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
    approveGraph(store, run.id);
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
    approveGraph(store, run.id);
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
    approveGraph(store, run.id, ["change"]);
    expect(store.startNode(run.id, "change").status).toBe("running");
    expect(() => approveGraph(store, run.id)).toThrow(/No nodes are awaiting approval/);
  });

  it("allows independent nodes to run concurrently", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "first", file: "A.ts", symbol: "A.first", title: "First", description: "Work", rationale: "Required", dependencies: [] },
      { id: "second", file: "B.ts", symbol: "B.second", title: "Second", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    approveGraph(store, run.id);
    store.startNode(run.id, "first");
    expect(store.startNode(run.id, "second").status).toBe("running");
  });

  it("prevents the same agent from running two independent nodes", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "uno", file: "A.ts", symbol: "A.uno", title: "Uno", description: "Work", rationale: "Required", dependencies: [] },
      { id: "dos", file: "B.ts", symbol: "B.dos", title: "Dos", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    approveGraph(store, run.id);
    store.startNode(run.id, "uno", "claude");
    expect(() => store.startNode(run.id, "dos", "claude")).toThrow(/already running uno/i);
    expect(store.startNode(run.id, "dos", "codex").status).toBe("running");
  });

  it("blocks concurrent nodes that touch the same file or branch", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "first", file: "A.ts", symbol: "A.first", title: "First", description: "Work", rationale: "Required", dependencies: [] },
      { id: "same-file", file: "A.ts", symbol: "A.second", title: "Same file", description: "Work", rationale: "Required", dependencies: [] },
      { id: "depends", file: "B.ts", symbol: "B.second", title: "Depends", description: "Work", rationale: "Required", dependencies: ["first"] },
    ] });
    approveGraph(store, run.id);
    store.startNode(run.id, "first");
    expect(() => store.startNode(run.id, "same-file")).toThrow(/cannot run concurrently.*both modify A\.ts/i);
    expect(() => store.startNode(run.id, "depends")).toThrow(/Incomplete dependencies: first/);
  });

  it("blocks concurrent changes to files used as approved context", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "reader", file: "A.ts", symbol: "A.first", title: "Reader", description: "Work", rationale: "Required", dependencies: [], contextFiles: ["contract.ts"] },
      { id: "contract", file: "contract.ts", symbol: "Contract", title: "Contract", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    approveGraph(store, run.id);
    store.startNode(run.id, "reader");
    expect(() => store.startNode(run.id, "contract")).toThrow(/approved context/i);
  });

  it("requires scoped verification while another node is running", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "uno", file: "A.ts", symbol: "A.uno", title: "Uno", description: "Work", rationale: "Required", dependencies: [] },
      { id: "dos", file: "B.ts", symbol: "B.dos", title: "Dos", description: "Work", rationale: "Required", dependencies: [] },
      { id: "solo", file: "C.ts", symbol: "C.solo", title: "Solo", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    approveGraph(store, run.id);
    store.startNode(run.id, "uno", "claude");
    store.startNode(run.id, "dos", "codex");
    expect(() => store.publishVerification(run.id, "dos", { command: "npm test", output: "ok", exitCode: 0 })).toThrow(/does not declare its scope/);
    expect(store.publishVerification(run.id, "dos", { command: "npm test -- B.ts", output: "ok", exitCode: 0 }).verification?.passed).toBe(true);

    store.publishPatch(run.id, "uno", "Changed A", "@@ A.ts\n+return true");
    store.publishVerification(run.id, "uno", { command: "npm test -- A.ts", output: "ok", exitCode: 0 });
    store.completeNode(run.id, "uno");
    store.publishPatch(run.id, "dos", "Changed B", "@@ B.ts\n+return true");
    store.completeNode(run.id, "dos");

    store.startNode(run.id, "solo", "claude");
    expect(store.publishVerification(run.id, "solo", { command: "npm test", output: "ok", exitCode: 0 }).verification?.passed).toBe(true);
  });

  it("freezes assignment while a node runs and stores reported tokens", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    approveGraph(store, run.id);
    store.startNode(run.id, "change", "codex");
    expect(() => store.assignNode(run.id, "change", "claude")).toThrow(/cannot be reassigned/i);
    store.publishPatch(run.id, "change", "Changed method", "@@ A.ts\n+return true");
    store.publishVerification(run.id, "change", { command: "npm test", output: "ok", exitCode: 0 });
    const completed = store.completeNode(run.id, "change", 48000);
    expect(completed.tokens).toBe(48000);
    expect(store.getRunDetail(run.id)?.activity.some((event) => event.message.includes("~48k tokens"))).toBe(true);
  });

  it("recovers a running node while paused without losing attempt evidence", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    approveGraph(store, run.id);
    store.startNode(run.id, "change", "codex");
    store.publishPatch(run.id, "change", "Partial change", "@@ A.ts\n+return maybe");
    store.publishVerification(run.id, "change", { command: "npm test", output: "partial check", exitCode: 0 });

    store.setRunControl(run.id, "paused");
    const recovered = store.assignNode(run.id, "change", "claude");
    expect(recovered).toMatchObject({ status: "pending", assignee: "claude", executedBy: undefined });
    expect(recovered.diff).toContain("return maybe");
    expect(recovered.verification).toMatchObject({ command: "npm test", passed: true });
    const codexState = store.getRunDetail(run.id)?.agentStates.find((state) => state.agent === "codex");
    expect(codexState).toMatchObject({ phase: "waiting", currentNodeId: undefined, total: 0, remainingNodeIds: [] });
    expect(codexState?.summary).toMatch(/recuperado por el humano/i);
  });

  it("keeps the auditor coverage and vote of the agent whose node is recovered", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "ajeno", file: "A.ts", symbol: "A.method", title: "Ajeno", description: "Work", rationale: "Required", dependencies: [] },
      { id: "propio", file: "B.ts", symbol: "B.method", title: "Propio", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    approveGraph(store, run.id);
    store.startNode(run.id, "ajeno", "claude");
    store.publishPatch(run.id, "ajeno", "Changed method", "@@ A.ts\n+return true");
    store.publishVerification(run.id, "ajeno", { command: "npm test", output: "ok", exitCode: 0 });
    store.completeNode(run.id, "ajeno");

    // codex es auditor de la ejecución y además implementa: publica su pasada
    // sobre el nodo ajeno y arranca el suyo. Recuperárselo no puede costarle
    // una auditoría que ya hizo sobre trabajo de otro.
    store.startNode(run.id, "propio", "codex");
    store.setAgentState(run.id, {
      agent: "codex",
      phase: "completed",
      summary: "Auditoría terminada",
      completed: 1,
      total: 1,
      reviewedNodeIds: ["ajeno"],
      remainingNodeIds: [],
      startedAt: "2026-08-21T00:30:00.000Z",
    });

    store.setRunControl(run.id, "paused");
    store.assignNode(run.id, "propio", "claude");

    const codexState = store.getRunDetail(run.id)?.agentStates.find((state) => state.agent === "codex");
    expect(codexState).toMatchObject({
      phase: "completed",
      reviewedNodeIds: ["ajeno"],
      startedAt: "2026-08-21T00:30:00.000Z",
    });
    expect(codexState?.summary).toMatch(/recuperado por el humano/i);
    // Lo que sí se recalcula es su cobertura de ejecución: ya no le queda nada.
    expect(codexState).toMatchObject({ completed: 0, total: 0, remainingNodeIds: [] });
  });

  it("enforces the human assignment when the agent declares itself", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "change", file: "A.ts", symbol: "A.method", title: "Change method", description: "Do work", rationale: "Required", dependencies: [] },
    ] });
    approveGraph(store, run.id);
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
    expect(store.getRunDetail(run.id)?.nodes.find((node) => node.id === "base")?.assignee).toBe("claude");
    store.publishGraph(run.id, { nodes: [
      { id: "other", file: "B.ts", symbol: "B.other", title: "Other", description: "Work", rationale: "Required", dependencies: [] },
    ] }, "codex");
    expect(store.getRun(run.id)?.baseAgent).toBe("claude");
    expect(store.getRunDetail(run.id)?.nodes.find((node) => node.id === "other")?.assignee).toBe("claude");
    const discovered = store.addDiscoveredNode(run.id, {
      id: "extra", file: "C.ts", symbol: "C.extra", title: "Extra", description: "Add", rationale: "Found", dependencies: [],
    });
    expect(discovered.assignee).toBe("claude");
  });

  it("rejects an anonymous initial graph through HTTP", async () => {
    const { store, run } = fixture();
    const server = createApp(store).listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const { port } = server.address() as AddressInfo;
    const graph = { nodes: [
      { id: "orphan", file: "A.ts", symbol: "A.orphan", title: "Orphan", description: "Base work", rationale: "Needed", dependencies: [] },
      { id: "delegated", file: "B.ts", symbol: "B.delegated", title: "Delegated", description: "Delegate work", rationale: "Cheap model suffices", dependencies: [], suggestedAgent: "ollama" },
    ] };

    try {
      const anonymous = await fetch(`http://127.0.0.1:${port}/api/runs/${run.id}/graph`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(graph),
      });
      expect(anonymous.status).toBe(400);
      expect(await anonymous.json()).toMatchObject({ error: expect.stringMatching(/requires agent/i) });
      expect(store.getRun(run.id)?.baseAgent).toBeUndefined();
      expect(store.getRunDetail(run.id)?.nodes).toEqual([]);

      const identified = await fetch(`http://127.0.0.1:${port}/api/runs/${run.id}/graph`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...graph, agent: "claude" }),
      });
      expect(identified.status).toBe(201);
      expect(store.getRun(run.id)?.baseAgent).toBe("claude");
      expect(store.getRunDetail(run.id)!.nodes.find((node) => node.id === "orphan")?.assignee).toBe("claude");
      expect(store.getRunDetail(run.id)!.nodes.find((node) => node.id === "delegated")?.assignee).toBe("ollama");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("persists the executing agent on start", () => {
    const { store, run } = fixture();
    store.publishGraph(run.id, { nodes: [
      { id: "a", file: "A.ts", symbol: "A.a", title: "A", description: "Work", rationale: "Required", dependencies: [] },
      { id: "b", file: "B.ts", symbol: "B.b", title: "B", description: "Work", rationale: "Required", dependencies: [] },
    ] });
    approveGraph(store, run.id);
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
    approveGraph(store, run.id);
    expect(store.getRun(run.id)?.seenAgents).not.toContain("codex");
    store.assignNode(run.id, "change", "codex");
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
    ] }, "codex");
    const nodes = store.getRunDetail(run.id)!.nodes;
    expect(nodes.find((node) => node.id === "delegable")).toMatchObject({ suggestedAgent: "ollama", assignee: "ollama" });
    expect(nodes.find((node) => node.id === "propio")?.assignee).toBe("codex");
    store.assignNode(run.id, "propio", "claude");
    store.assignNode(run.id, "delegable", "claude");
    store.publishGraph(run.id, { nodes: [
      { id: "delegable", file: "A.ts", symbol: "A.a", title: "Delegable", description: "Mechanical work", rationale: "Cheap model suffices", dependencies: [], suggestedAgent: "ollama" },
      { id: "propio", file: "B.ts", symbol: "B.b", title: "Propio", description: "Core work", rationale: "Needs the base model", dependencies: [] },
    ] });
    expect(store.getRunDetail(run.id)!.nodes.find((node) => node.id === "delegable")?.assignee).toBe("claude");
    expect(store.getRunDetail(run.id)!.nodes.find((node) => node.id === "propio")?.assignee).toBe("claude");
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
    approveGraph(store, run.id);
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
    approveGraph(store, run.id);
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
    approveGraph(store, run.id);
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
      expect(finding.agreements.map((agreement) => agreement.agent)).toEqual(["codex"]);
      expect(finding.messages).toHaveLength(0);
      expect(store.getRunDetail(run.id)?.findings).toHaveLength(1);
    });

    it("derives the finding scope from nodeId and only accepts 'plan' without one", () => {
      const { store, run } = reviewFixture();
      expect(store.createFinding(run.id, { reviewer: "codex", severity: "major", title: "Nodo", body: "d", nodeId: "uno" }).scope).toBe("node");
      expect(store.createFinding(run.id, { reviewer: "codex", severity: "major", title: "Integración", body: "d" }).scope).toBe("integration");

      const plan = store.createFinding(run.id, { reviewer: "codex", severity: "major", title: "Falta un nodo", body: "Cita uno en el cuerpo", scope: "plan" });
      expect(plan.scope).toBe("plan");
      expect(plan.nodeId).toBeUndefined();

      // Un hallazgo de plan audita el grafo: con nodeId contaría como revisión
      // de ese nodo en la cobertura del auditor.
      expect(() => store.createFinding(run.id, { reviewer: "codex", severity: "major", title: "x", body: "y", scope: "plan", nodeId: "uno" })).toThrow(/plan finding reviews the graph/i);
      expect(() => store.createFinding(run.id, { reviewer: "codex", severity: "major", title: "x", body: "y", scope: "node" })).toThrow(/contradicts nodeId/i);
      expect(() => store.createFinding(run.id, { reviewer: "codex", severity: "major", title: "x", body: "y", scope: "integration", nodeId: "uno" })).toThrow(/contradicts nodeId/i);
      expect(() => store.createFinding(run.id, { reviewer: "codex", severity: "major", title: "x", body: "y", scope: "grafo" as never })).toThrow(/scope/i);
    });

    it("keeps plan findings out of the closing gate", () => {
      const { store, run } = reviewFixture();
      store.createFinding(run.id, { reviewer: "codex", severity: "critical", title: "Falta un nodo", body: "Cita uno", scope: "plan" });
      expect(store.getRun(run.id)?.openFindings).toBe(0);
      expect(store.runReviewGate(run.id)).toHaveLength(0);

      // Los otros dos alcances sí retienen el cierre, como antes de la fase.
      store.createFinding(run.id, { reviewer: "codex", severity: "major", title: "Contrato roto", body: "d", nodeId: "uno" });
      store.createFinding(run.id, { reviewer: "codex", severity: "minor", title: "Integración", body: "d" });
      expect(store.getRun(run.id)?.openFindings).toBe(2);
      expect(store.runReviewGate(run.id).map((finding) => finding.title)).toEqual(["Contrato roto", "Integración"]);
    });

    it("backfills the scope of findings stored before the column existed", () => {
      const { store, run } = reviewFixture();
      store.createFinding(run.id, { reviewer: "codex", severity: "major", title: "Con nodo", body: "d", nodeId: "uno" });
      store.createFinding(run.id, { reviewer: "codex", severity: "minor", title: "Sin nodo", body: "d" });
      const dataDirectory = store.dataDirectory;
      store.close();

      // Simula una base anterior a la columna: al reabrir, la migración debe
      // reconstruir el mismo significado que antes daba la ausencia de node_id.
      const raw = new Database(path.join(dataDirectory, "hrp-v2.sqlite"));
      raw.exec("ALTER TABLE findings DROP COLUMN scope");
      raw.close();

      const reopened = new HrpStore(dataDirectory);
      const findings = reopened.listFindings(run.id);
      expect(findings.map((finding) => [finding.title, finding.scope])).toEqual([["Con nodo", "node"], ["Sin nodo", "integration"]]);
      reopened.close();
    });

    it("assigns an accepted discovered correction to its reporter only after unanimous agreement", () => {
      const { store, run } = fixture();
      store.setRunAuditors(run.id, ["claude", "antigravity"]);
      store.publishGraph(run.id, { nodes: [
        { id: "original", file: "A.ts", symbol: "A.original", title: "Original", description: "Work", rationale: "Required", dependencies: [] },
      ] }, "codex");
      const finding = store.createFinding(run.id, { reviewer: "claude", severity: "major", title: "Contrato roto", body: "Detalle", nodeId: "original" });
      const correction = store.addDiscoveredNode(run.id, {
        id: "correction", file: "A.ts", symbol: "A.correction", title: "Correction", description: "Fix the contract", rationale: "Accepted finding", dependencies: ["original"],
      });
      expect(correction).toMatchObject({ approved: true, assignee: "codex" });
      expect(finding.requiredAgreementAgents).toEqual(["codex", "claude", "antigravity"]);
      expect(finding.agreements.map((agreement) => agreement.agent)).toEqual(["claude"]);

      const accepted = store.setFindingStatus(finding.id, "accepted", "correction");
      expect(accepted.agreements.map((agreement) => agreement.agent)).toEqual(["claude", "codex"]);
      expect(accepted.unanimous).toBe(false);
      expect(store.getRunDetail(run.id)?.nodes.find((node) => node.id === "correction")?.assignee).toBe("codex");
      expect(() => store.agreeFinding(finding.id, "outsider")).toThrow(/not the base model or a selected auditor/);

      const unanimous = store.agreeFinding(finding.id, "antigravity");
      expect(unanimous.unanimous).toBe(true);
      expect(store.getRunDetail(run.id)?.nodes.find((node) => node.id === "correction")?.assignee).toBe("claude");
      expect(store.getRunDetail(run.id)?.activity.some((item) => item.message.includes("Corrección asignada por unanimidad a claude"))).toBe(true);

      const reopened = store.setFindingStatus(finding.id, "open");
      expect(reopened.unanimous).toBe(false);
      expect(reopened.agreements.map((agreement) => agreement.agent)).toEqual(["claude"]);
    });

    it("keeps the correction with the base model when the reporter is the only auditor", () => {
      const { store, run } = fixture();
      store.setRunAuditors(run.id, ["claude"]);
      store.publishGraph(run.id, { nodes: [
        { id: "original", file: "A.ts", symbol: "A.original", title: "Original", description: "Work", rationale: "Required", dependencies: [] },
      ] }, "codex");
      const finding = store.createFinding(run.id, { reviewer: "claude", severity: "major", title: "Contrato roto", body: "Detalle", nodeId: "original" });
      store.addDiscoveredNode(run.id, {
        id: "correction", file: "A.ts", symbol: "A.correction", title: "Correction", description: "Fix the contract", rationale: "Accepted finding", dependencies: ["original"],
      });

      const accepted = store.setFindingStatus(finding.id, "accepted", "correction");

      expect(accepted.unanimous).toBe(true);
      expect(store.getRunDetail(run.id)?.nodes.find((node) => node.id === "correction")?.assignee).toBe("codex");
      expect(store.getRunDetail(run.id)?.activity.some((item) => item.message.includes("Corrección asignada por unanimidad"))).toBe(false);
    });

    it("preserves a correction assignment to another agent when agreement becomes unanimous", () => {
      const { store, run } = fixture();
      store.setRunAuditors(run.id, ["claude", "antigravity"]);
      store.publishGraph(run.id, { nodes: [
        { id: "original", file: "A.ts", symbol: "A.original", title: "Original", description: "Work", rationale: "Required", dependencies: [] },
      ] }, "codex");
      const finding = store.createFinding(run.id, { reviewer: "claude", severity: "minor", title: "Detalle", body: "Corregir" });
      store.addDiscoveredNode(run.id, {
        id: "manual", file: "B.ts", symbol: "B.manual", title: "Manual", description: "Fix", rationale: "Accepted finding", dependencies: [],
      });
      store.assignNode(run.id, "manual", "antigravity");
      store.setFindingStatus(finding.id, "accepted", "manual");
      store.agreeFinding(finding.id, "antigravity");
      expect(store.getFinding(finding.id)?.unanimous).toBe(true);
      expect(store.getRunDetail(run.id)?.nodes.find((node) => node.id === "manual")?.assignee).toBe("antigravity");
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

    it("does not count auditor votes that predate a later auditable node", () => {
      const { store, run } = fixture();
      store.setRunAuditors(run.id, ["claude", "codex", "antigravity"]);
      store.publishGraph(run.id, { nodes: [
        { id: "uno", file: "A.ts", symbol: "A.a", title: "Uno", description: "Work", rationale: "Required", dependencies: [] },
        { id: "dos", file: "B.ts", symbol: "B.b", title: "Dos", description: "Correction", rationale: "Required", dependencies: ["uno"] },
      ] });
      approveGraph(store, run.id);
      for (const [id, file] of [["uno", "A.ts"], ["dos", "B.ts"]] as const) {
        store.startNode(run.id, id, "codex");
        store.publishPatch(run.id, id, "Cambio", `diff --git a/${file} b/${file}\n@@\n+ok`);
        store.publishVerification(run.id, id, { command: "npm test", output: "ok", exitCode: 0 });
        store.completeNode(run.id, id);
      }
      store.database.prepare("UPDATE nodes SET updated_at = ? WHERE run_id = ? AND id = ?").run("2026-08-21T00:00:00.000Z", run.id, "uno");
      store.database.prepare("UPDATE nodes SET updated_at = ? WHERE run_id = ? AND id = ?").run("2026-08-21T01:00:00.000Z", run.id, "dos");
      for (const agent of ["claude", "antigravity"]) {
        store.setAgentState(run.id, {
          agent,
          phase: "completed",
          summary: "Auditoría terminada antes de la corrección",
          completed: 1,
          total: 1,
          reviewedNodeIds: ["uno"],
          remainingNodeIds: [],
          startedAt: "2026-08-21T00:30:00.000Z",
        });
      }

      // claude y antigravity votaron con un reloj anterior al cambio de 'dos',
      // así que su voto no cuenta; codex tampoco cuenta, porque implementó pero
      // nunca declaró una pasada: terminar de implementar no vota.
      expect(store.pendingAuditors(run.id).map((state) => state.agent)).toEqual(["claude", "codex", "antigravity"]);
      expect(store.getRun(run.id)).toMatchObject({ pendingAuditorCount: 3, pendingAuditorVotes: 2 });
      expect(store.pendingAuditorVotes(run.id)).toBe(2);
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

    it("marks a removed active auditor as waiting while preserving its published coverage", () => {
      const { store, run } = reviewFixture();
      store.setRunAuditors(run.id, ["claude", "antigravity"]);
      store.setAgentState(run.id, {
        agent: "claude",
        phase: "reviewing",
        summary: "Auditando el run",
        completed: 1,
        total: 1,
        reviewedNodeIds: ["uno"],
        remainingNodeIds: [],
      });

      store.setRunControl(run.id, "paused");
      store.setRunAuditors(run.id, ["antigravity"]);

      const removed = store.getRunDetail(run.id)?.agentStates.find((state) => state.agent === "claude");
      expect(removed).toMatchObject({
        phase: "waiting",
        summary: "Retirado de auditoría por el humano",
        reviewedNodeIds: ["uno"],
        remainingNodeIds: [],
      });
      expect(store.pendingAuditors(run.id).map((state) => state.agent)).toEqual(["antigravity"]);
    });

    it("records and clears a formal attention release for one agent", () => {
      const { store, run } = reviewFixture();
      const released = store.releaseAttention(run.id, "claude");

      expect(released).toMatchObject({ runId: run.id, agent: "claude", createdAt: expect.any(String) });
      expect(store.getAttentionRelease(run.id, "claude")?.createdAt).toEqual(expect.any(String));
      expect(store.getAttentionRelease(run.id, "codex")).toBeUndefined();

      store.helloAgent(run.id, "claude");
      expect(store.getAttentionRelease(run.id, "claude")).toBeUndefined();
    });

    it("does not invalidate completed auditor coverage when releasing attention", () => {
      const { store, run } = reviewFixture();
      store.setRunAuditors(run.id, ["claude"]);
      store.setAgentState(run.id, {
        agent: "claude",
        phase: "completed",
        summary: "Auditoría terminada",
        completed: 1,
        total: 1,
        reviewedNodeIds: ["uno"],
        remainingNodeIds: [],
        startedAt: new Date().toISOString(),
      });

      store.releaseAttention(run.id, "claude");

      expect(store.pendingAuditors(run.id)).toHaveLength(0);
      expect(store.getRunDetail(run.id)?.agentStates.find((state) => state.agent === "claude")?.phase).toBe("completed");
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
      approveGraph(store, run.id);

      // Human actions (approval, assign, control, set auditors)
      expect(store.getRunDetail(run.id)?.activity.some((item) => item.agent === "human" && item.message.toLowerCase().includes("aprobado"))).toBe(true);

      // Node executed with explicit agent
      store.assignNode(run.id, "uno", "worker-1");
      store.startNode(run.id, "uno", "worker-1");
      store.publishPatch(run.id, "uno", "Parche worker", "@@ A.ts\n+1");
      store.publishVerification(run.id, "uno", { command: "test", output: "ok", exitCode: 0 });
      store.completeNode(run.id, "uno");

      const detail = store.getRunDetail(run.id)!;
      const workerEvents = detail.activity.filter((item) => item.nodeId === "uno" && !item.message.includes("Aprobado") && !item.message.includes("Asignado"));
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
  describe("gate del plan", () => {
    const plan = [{ id: "uno", file: "A.ts", symbol: "A.a", title: "Uno", description: "Work", rationale: "Required", dependencies: [] }];

    it("lets the human approve while plan auditors are still pending", () => {
      const { store, run } = fixture();
      store.setRunAuditors(run.id, ["codex", "antigravity"]);
      store.publishGraph(run.id, { nodes: plan }, "claude");
      store.recordPlanPass(run.id, "codex", 2);

      const gate = store.getRun(run.id)?.planGate;
      expect(gate?.reviewed).toEqual(["codex"]);
      expect(gate?.pending).toEqual(["antigravity"]);
      expect(gate?.open).toBe(true);
      expect(store.approveNodes(run.id).every((node) => node.approved)).toBe(true);
      expect(store.getRun(run.id)?.planGate?.open).toBe(false);
    });

    it("lets the human approve once every auditor published its pass", () => {
      const { store, run } = fixture();
      store.setRunAuditors(run.id, ["codex", "antigravity"]);
      store.publishGraph(run.id, { nodes: plan }, "claude");
      store.recordPlanPass(run.id, "codex", 0);
      store.recordPlanPass(run.id, "antigravity", 1);

      expect(store.getRun(run.id)?.planGate?.open).toBe(false);
      expect(store.approveNodes(run.id).every((node) => node.approved)).toBe(true);
    });

    it("does not surface plan-audit waiting as a separate human action", () => {
      const { store, run } = fixture();
      store.publishGraph(run.id, { nodes: plan }, "claude");

      store.approveNodes(run.id);
      const detail = store.getRunDetail(run.id)!;
      expect(detail.nodes.every((node) => node.approved)).toBe(true);
      expect(detail.activity.some((item) => item.message.includes("sin esperar la auditoría del plan"))).toBe(false);
    });

    it("asks for the round again when the graph is republished before starting", () => {
      const { store, run } = fixture();
      store.publishGraph(run.id, { nodes: plan }, "claude");
      store.recordPlanPass(run.id, "codex", 0);
      expect(store.getRun(run.id)?.planGate?.open).toBe(false);

      store.publishGraph(run.id, { nodes: [{ ...plan[0], description: "Otro alcance" }] }, "claude");
      const gate = store.getRun(run.id)?.planGate;
      expect(gate?.pending).toEqual(["codex"]);
      expect(gate?.open).toBe(true);
    });

    it("does not block the run once implementation started: discovered nodes keep the informative round", () => {
      const { store, run } = fixture();
      store.publishGraph(run.id, { nodes: plan }, "claude");
      store.recordPlanPass(run.id, "codex", 0);
      store.approveNodes(run.id);

      const discovered = store.addDiscoveredNode(run.id, { id: "dos", file: "B.ts", symbol: "B.b", title: "Dos", description: "Found", rationale: "Required", dependencies: ["uno"] });
      expect(discovered.approved).toBe(true);
      const gate = store.getRun(run.id)?.planGate;
      expect(gate?.pending).toEqual(["codex"]);
      expect(gate?.open).toBe(false);
    });

    it("only accepts a plan pass from an auditor of the run", () => {
      const { store, run } = fixture();
      store.publishGraph(run.id, { nodes: plan }, "claude");
      expect(() => store.recordPlanPass(run.id, "antigravity", 0)).toThrow(/not an auditor/);
    });
  });
  // Carriles de ejecución delegada: la concurrencia sale de que 'ollama:<modelo>'
  // sea una identidad ejecutora distinta, no de relajar ninguna exclusión.
  describe("delegated lanes", () => {
    const delegated = (id: string) => ({
      id, file: `${id}.ts`, symbol: id, title: id, description: "Work", rationale: "Required",
      dependencies: [], suggestedAgent: "ollama", difficulty: "trivial" as const,
    });

    it("keeps the declared difficulty across republications and requires re-approval when it changes", () => {
      const { store, run } = fixture();
      store.publishGraph(run.id, { nodes: [delegated("a")] }, "claude");
      expect(store.getNode(run.id, "a")?.difficulty).toBe("trivial");
      approveGraph(store, run.id);

      store.publishGraph(run.id, { nodes: [delegated("a")] }, "claude");
      expect(store.getNode(run.id, "a")?.approved).toBe(true);

      store.publishGraph(run.id, { nodes: [{ ...delegated("a"), difficulty: "hard" }] }, "claude");
      expect(store.getNode(run.id, "a")?.difficulty).toBe("hard");
      // La dificultad decide a qué modelo se enruta: cambiarla cambia quién implementa.
      expect(store.getNode(run.id, "a")?.approved).toBe(false);
    });

    it("runs compatible nodes in different lanes at the same time", () => {
      const { store, run } = fixture();
      store.publishGraph(run.id, { nodes: [delegated("a"), delegated("b")] }, "claude");
      approveGraph(store, run.id);

      store.startNode(run.id, "a", "ollama:modelo-uno");
      store.startNode(run.id, "b", "ollama:modelo-dos");

      expect(store.getNode(run.id, "a")?.executedBy).toBe("ollama:modelo-uno");
      expect(store.getNode(run.id, "b")?.executedBy).toBe("ollama:modelo-dos");
    });

    it("still refuses two nodes in the same lane and foreign work for a session agent", () => {
      const { store, run } = fixture();
      store.publishGraph(run.id, { nodes: [delegated("a"), delegated("b")] }, "claude");
      approveGraph(store, run.id);
      store.startNode(run.id, "a", "ollama:modelo-uno");

      expect(() => store.startNode(run.id, "b", "ollama:modelo-uno")).toThrow(/already running a/);
      expect(() => store.startNode(run.id, "b", "codex")).toThrow(/assigned to ollama/);
    });

    it("keeps rejecting lanes that would edit the same file", () => {
      const { store, run } = fixture();
      store.publishGraph(run.id, { nodes: [
        { ...delegated("a"), file: "shared.ts" },
        { ...delegated("b"), file: "shared.ts" },
      ] }, "claude");
      approveGraph(store, run.id);
      store.startNode(run.id, "a", "ollama:modelo-uno");

      expect(() => store.startNode(run.id, "b", "ollama:modelo-dos")).toThrow(/both modify shared.ts/);
    });

    it("counts every delegated lane as work of the base model", () => {
      const { store, run } = fixture();
      store.publishGraph(run.id, { nodes: [delegated("a"), delegated("b")] }, "claude");
      approveGraph(store, run.id);
      store.startNode(run.id, "a", "ollama:modelo-uno");

      store.helloAgent(run.id, "claude");
      const base = store.getRunDetail(run.id)?.agentStates.find((state) => state.agent === "claude");
      expect(base?.total).toBe(2);
    });

    it("merges and clears delegate tiers without losing the API key", () => {
      const { store } = fixture();
      store.setOllamaSettings({ apiKey: "secreto", model: "base-model" });
      store.setOllamaSettings({ tiers: { trivial: "cheap" } });
      store.setOllamaSettings({ tiers: { standard: "mid" } });
      expect(store.getOllamaSettings().tiers).toEqual({ trivial: "cheap", standard: "mid" });

      store.setOllamaSettings({ tiers: { trivial: "" } });
      expect(store.getOllamaSettings().tiers).toEqual({ standard: "mid" });
      expect(store.getOllamaSettings().apiKey).toBe("secreto");
      expect(store.getOllamaSettingsView().tiers).toEqual({ standard: "mid" });
    });
  });
});
