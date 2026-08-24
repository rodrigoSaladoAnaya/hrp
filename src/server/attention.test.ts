import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { attentionKinds, attentionRank, auditableNodes, computeAttention } from "./attention.js";
import { HrpStore } from "./store.js";
import type { ChangeNode, Finding, RunDetail, RunSummary } from "../shared/protocol.js";

// El resolutor decide cuándo se molesta a un agente y cuándo se le deja en paz.
// Sus pruebas trabajan sobre RunDetail armados a mano porque es una función
// pura: lo que se fija aquí es la prioridad y el contenido de la directiva.
const timestamp = "2026-08-21T00:00:00.000Z";

function node(partial: Partial<ChangeNode> & { id: string }): ChangeNode {
  return {
    runId: "run",
    file: `${partial.id}.ts`,
    symbol: partial.id,
    title: partial.id,
    description: "d",
    rationale: "r",
    status: "pending",
    discovered: false,
    approved: true,
    dependencies: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...partial,
  };
}

function detail(partial: { nodes?: ChangeNode[]; run?: Partial<RunSummary>; findings?: Partial<Finding>[]; agentStates?: RunDetail["agentStates"] } = {}): RunDetail {
  const nodes = partial.nodes ?? [];
  const run: RunSummary = {
    id: "run",
    projectId: "project",
    title: "t",
    requirement: "r",
    status: "pending",
    control: "active",
    graphVersion: 1,
    baseAgent: "claude",
    seenAgents: ["claude"],
    auditors: [],
    pendingAuditorCount: partial.run?.auditors?.length ?? 0,
    nodeCount: nodes.length,
    completedCount: nodes.filter((candidate) => candidate.status === "completed").length,
    awaitingApproval: nodes.filter((candidate) => !candidate.approved).length,
    openFindings: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...partial.run,
  };
  return {
    run,
    nodes,
    activity: [],
    agentStates: partial.agentStates ?? [],
    findings: (partial.findings ?? []).map((finding, index) => ({
      id: `f${index}`,
      runId: run.id,
      reviewer: "codex",
      severity: "major",
      title: "t",
      body: "b",
      status: "open",
      messages: [],
      agreements: [],
      requiredAgreementAgents: [],
      unanimous: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...finding,
    })),
  };
}

describe("computeAttention", () => {
  it("antepone un debate sin responder al trabajo disponible", () => {
    const signal = computeAttention(detail({
      nodes: [node({ id: "libre" })],
      findings: [{ id: "hallazgo", status: "open", messages: [] }],
    }), "claude");
    expect(signal.kind).toBe("findings");
    expect(signal.actionable).toBe(true);
    expect(signal.directive).toContain("hallazgo");
  });

  it("no reclama un debate cuyo último turno ya es del agente base", () => {
    const signal = computeAttention(detail({
      nodes: [node({ id: "libre" })],
      findings: [{ status: "debating", messages: [{ id: "m", findingId: "f0", author: "claude", body: "respondido", createdAt: timestamp }] }],
    }), "claude");
    expect(signal.kind).toBe("work");
  });

  it("pide a cada auditor el acuerdo que aún falta en un hallazgo", () => {
    const signal = computeAttention(detail({
      nodes: [node({ id: "correccion", status: "pending" })],
      run: { baseAgent: "codex", auditors: ["claude", "antigravity"] },
      findings: [{
        id: "hallazgo",
        reviewer: "claude",
        status: "accepted",
        resolutionNodeId: "correccion",
        agreements: [{ agent: "claude", createdAt: timestamp }, { agent: "codex", createdAt: timestamp }],
        requiredAgreementAgents: ["codex", "claude", "antigravity"],
      }],
    }), "antigravity");

    expect(signal.kind).toBe("findings");
    expect(signal.directive).toContain("hallazgo");
    expect(signal.directive).toContain("hrp finding agree <id> --author antigravity");
  });

  it("deja de pedir colaboración cuando el auditor ya registró su acuerdo", () => {
    const signal = computeAttention(detail({
      nodes: [node({ id: "correccion", status: "pending", assignee: "claude" })],
      run: { baseAgent: "codex", auditors: ["claude", "antigravity"] },
      findings: [{
        reviewer: "claude",
        status: "accepted",
        resolutionNodeId: "correccion",
        agreements: ["claude", "codex", "antigravity"].map((agent) => ({ agent, createdAt: timestamp })),
        requiredAgreementAgents: ["codex", "claude", "antigravity"],
        unanimous: true,
      }],
    }), "antigravity");

    expect(signal.kind).not.toBe("findings");
  });

  it("permite auditar y no vuelve a pedir un acuerdo cuando la corrección terminó", () => {
    const nodes = [node({ id: "correccion", status: "completed", executedBy: "codex" })];
    const finding = {
      reviewer: "claude",
      status: "accepted" as const,
      resolutionNodeId: "correccion",
      agreements: ["claude", "codex"].map((agent) => ({ agent, createdAt: timestamp })),
      requiredAgreementAgents: ["codex", "claude", "antigravity"],
    };
    const run = { baseAgent: "codex", auditors: ["claude", "antigravity"] };

    const beforeVote = computeAttention(detail({ nodes, run, findings: [finding] }), "antigravity");
    expect(beforeVote.kind).toBe("audit");
    expect(beforeVote.directive).toContain("Auditoría disponible");

    const agentStates = [{
      agent: "antigravity",
      phase: "completed" as const,
      summary: "Auditoría terminada",
      completed: 1,
      total: 1,
      reviewedNodeIds: ["correccion"],
      remainingNodeIds: [],
      startedAt: timestamp,
      updatedAt: timestamp,
    }];
    const afterVote = computeAttention(detail({ nodes, run, findings: [finding], agentStates }), "antigravity");
    expect(afterVote.kind).toBe("review-pass");
    expect(afterVote.directive).not.toContain("hrp finding agree");
  });

  it("considera atendido el acuerdo cuando el auditor ya respondió en el hilo", () => {
    const signal = computeAttention(detail({
      nodes: [node({ id: "correccion", status: "pending" })],
      run: { baseAgent: "codex", auditors: ["claude", "antigravity"] },
      findings: [{
        reviewer: "claude",
        status: "accepted",
        resolutionNodeId: "correccion",
        agreements: ["claude", "codex"].map((agent) => ({ agent, createdAt: timestamp })),
        requiredAgreementAgents: ["codex", "claude", "antigravity"],
        messages: [{ id: "m", findingId: "f0", author: "antigravity", body: "No estoy de acuerdo", createdAt: timestamp }],
      }],
    }), "antigravity");

    expect(signal.kind).toBe("implementation");
    expect(signal.directive).not.toContain("hrp finding agree");
  });

  it("mantiene el debate del modelo base por encima de los acuerdos pendientes", () => {
    const signal = computeAttention(detail({
      nodes: [node({ id: "correccion" })],
      run: { baseAgent: "codex", auditors: ["claude", "antigravity"] },
      findings: [{
        id: "hallazgo",
        reviewer: "claude",
        agreements: [{ agent: "claude", createdAt: timestamp }],
        requiredAgreementAgents: ["codex", "claude", "antigravity"],
      }],
    }), "codex");

    expect(signal.kind).toBe("findings");
    expect(signal.directive).toContain("hrp finding accept");
    expect(signal.directive).not.toContain("hrp finding agree");
  });

  it("sólo anuncia nodos que el servidor aceptaría iniciar", () => {
    const signal = computeAttention(detail({
      nodes: [
        node({ id: "prerrequisito", status: "pending" }),
        node({ id: "dependiente", dependencies: ["prerrequisito"] }),
        node({ id: "listo" }),
      ],
    }), "claude");
    expect(signal.kind).toBe("work");
    expect(signal.directive).toContain("listo");
    expect(signal.directive).not.toContain("dependiente");
  });

  it("pide seguir atento, sin orden imposible, cuando todo lo aprobado espera prerrequisitos", () => {
    const signal = computeAttention(detail({
      nodes: [
        node({ id: "ajeno", assignee: "codex", status: "pending" }),
        node({ id: "mio", assignee: "claude", dependencies: ["ajeno"] }),
      ],
    }), "claude");
    expect(signal.kind).toBe("blocked");
    expect(signal.actionable).toBe(false);
    expect(signal.waiting).toBe(true);
    expect(signal.directive).toContain("ajeno");
  });

  it("el modelo base también administra los nodos sin asignar y los de ollama", () => {
    const signal = computeAttention(detail({
      nodes: [node({ id: "sin-dueno" }), node({ id: "delegado", assignee: "ollama" })],
    }), "claude");
    expect(signal.directive).toContain("sin-dueno");
    expect(signal.directive).toContain("delegado");
  });

  it("el modelo base administra cada carril delegado ollama:<modelo>", () => {
    // Un carril no abre sesión propia: si la señal no se lo atribuye al base,
    // el nodo queda sin dueño y la ejecución se cuelga esperando a nadie.
    const signal = computeAttention(detail({
      nodes: [node({ id: "carril-uno", assignee: "ollama:modelo-uno" })],
    }), "claude");
    expect(signal.actionable).toBe(true);
    expect(signal.directive).toContain("carril-uno");
  });

  it("un carril delegado no es trabajo de un agente que no es el base", () => {
    const signal = computeAttention(detail({
      nodes: [node({ id: "carril-uno", assignee: "ollama:modelo-uno" })],
    }), "antigravity");
    expect(signal.actionable).toBe(false);
    expect(signal.kind).toBe("idle");
  });

  it("un nodo de otro agente no genera señal para quien no es su dueño", () => {
    const signal = computeAttention(detail({
      nodes: [node({ id: "de-codex", assignee: "codex" })],
    }), "antigravity");
    expect(signal.actionable).toBe(false);
    expect(signal.kind).toBe("idle");
  });

  it("ofrece la auditoría sólo cuando la implementación terminó", () => {
    const nodes = [node({ id: "uno", status: "completed" })];
    const pendiente = computeAttention(detail({ nodes: [...nodes, node({ id: "dos" })], run: { auditors: ["codex"] } }), "codex");
    expect(pendiente.kind).toBe("implementation");
    const disponible = computeAttention(detail({ nodes, run: { auditors: ["codex"] } }), "codex");
    expect(disponible.kind).toBe("audit");
    expect(disponible.actionable).toBe(true);
    expect(disponible.directive).toContain("review pack");
  });

  it("el base espera a los auditores y sólo cierra cuando queda algo que cerrar", () => {
    const nodes = [node({ id: "uno", status: "completed" })];
    const esperando = computeAttention(detail({ nodes, run: { auditors: ["codex"] } }), "claude");
    expect(esperando.kind).toBe("auditors");
    expect(esperando.pendingAuditors).toEqual(["codex"]);

    const agentStates = [{ agent: "codex", phase: "completed" as const, summary: "listo", completed: 1, total: 1, reviewedNodeIds: ["uno"], remainingNodeIds: [], updatedAt: timestamp }];
    const cerrada = computeAttention(detail({ nodes, run: { auditors: ["codex"] }, agentStates }), "claude");
    expect(cerrada.kind).toBe("done");
    expect(cerrada.terminal).toBe(true);
    expect(cerrada.actionable).toBe(false);

    const conHallazgo = computeAttention(detail({
      nodes,
      run: { auditors: ["codex"] },
      agentStates,
      findings: [{ status: "escalated", messages: [{ id: "m", findingId: "f0", author: "claude", body: "x", createdAt: timestamp }] }],
    }), "claude");
    expect(conHallazgo.kind).toBe("gate");
    expect(conHallazgo.actionable).toBe(true);
  });

  it("el base no espera al auditor minoritario cuando ya hay mayoría", () => {
    const nodes = [node({ id: "uno", status: "completed" })];
    const agentStates = ["claude", "antigravity"].map((agent) => ({
      agent,
      phase: "completed" as const,
      summary: "listo",
      completed: 1,
      total: 1,
      reviewedNodeIds: ["uno"],
      remainingNodeIds: [],
      updatedAt: timestamp,
    }));
    const signal = computeAttention(detail({
      nodes,
      run: { auditors: ["claude", "antigravity", "ollama"], baseAgent: "codex" },
      agentStates,
    }), "codex");
    expect(signal.kind).toBe("done");
    expect(signal.pendingAuditors).toEqual(["ollama"]);
    expect(signal.pendingAuditorVotes).toBe(0);
    expect(signal.directive).not.toContain("ollama");
  });

  it("el base ve todos los auditores sin voto cuando aún falta mayoría", () => {
    const nodes = [node({ id: "uno", status: "completed" })];
    const agentStates = [{
      agent: "claude",
      phase: "completed" as const,
      summary: "listo",
      completed: 1,
      total: 1,
      reviewedNodeIds: ["uno"],
      remainingNodeIds: [],
      updatedAt: timestamp,
    }];
    const signal = computeAttention(detail({
      nodes,
      run: { auditors: ["claude", "antigravity", "ollama"], baseAgent: "codex" },
      agentStates,
    }), "codex");

    expect(signal.kind).toBe("auditors");
    expect(signal.pendingAuditors).toEqual(["antigravity", "ollama"]);
    expect(signal.pendingAuditorVotes).toBe(1);
    expect(signal.directive).toContain("faltan 1 voto");
    expect(signal.directive).toContain("antigravity, ollama");
  });

  it("no cierra con votos auditores anteriores a un nodo auditable más reciente", () => {
    const nodes = [
      node({ id: "uno", status: "completed", executedBy: "codex", updatedAt: "2026-08-21T00:00:00.000Z" }),
      node({ id: "dos", status: "completed", executedBy: "codex", updatedAt: "2026-08-21T01:00:00.000Z" }),
    ];
    const agentStates = ["claude", "antigravity"].map((agent) => ({
      agent,
      phase: "completed" as const,
      summary: "listo",
      completed: 1,
      total: 1,
      reviewedNodeIds: ["uno"],
      remainingNodeIds: [],
      startedAt: "2026-08-21T00:30:00.000Z",
      updatedAt: "2026-08-21T00:45:00.000Z",
    }));

    const baseSignal = computeAttention(detail({
      nodes,
      run: { auditors: ["claude", "antigravity", "ollama"], baseAgent: "codex" },
      agentStates,
    }), "codex");
    expect(baseSignal.kind).toBe("auditors");
    expect(baseSignal.pendingAuditors).toEqual(["claude", "antigravity", "ollama"]);
    expect(baseSignal.pendingAuditorVotes).toBe(2);

    const auditorSignal = computeAttention(detail({
      nodes,
      run: { auditors: ["claude", "antigravity", "ollama"], baseAgent: "codex" },
      agentStates,
    }), "claude");
    expect(auditorSignal.kind).toBe("audit");
    expect(auditorSignal.directive).toContain("--reviewed uno");
    expect(auditorSignal.directive).toContain("--remaining dos");
  });

  it("conserva cobertura parcial vigente mientras el auditor sigue reviewing", () => {
    const nodes = [
      node({ id: "uno", status: "completed", executedBy: "codex", updatedAt: "2026-08-21T00:00:00.000Z" }),
      node({ id: "dos", status: "completed", executedBy: "codex", updatedAt: "2026-08-21T00:10:00.000Z" }),
      node({ id: "tres", status: "completed", executedBy: "codex", updatedAt: "2026-08-21T00:20:00.000Z" }),
      node({ id: "cuatro", status: "completed", executedBy: "codex", updatedAt: "2026-08-21T00:30:00.000Z" }),
    ];
    const agentStates = [{
      agent: "claude",
      phase: "reviewing" as const,
      summary: "pasada parcial",
      completed: 3,
      total: 4,
      reviewedNodeIds: ["uno", "dos", "tres"],
      remainingNodeIds: ["cuatro"],
      startedAt: "2026-08-21T00:25:00.000Z",
      updatedAt: "2026-08-21T00:26:00.000Z",
    }];

    const signal = computeAttention(detail({
      nodes,
      run: { auditors: ["claude"], baseAgent: "codex" },
      agentStates,
    }), "claude");

    expect(signal.kind).toBe("audit");
    expect(signal.directive).toContain("--completed 3");
    expect(signal.directive).toContain("--total 4");
    expect(signal.directive).toContain("--reviewed uno,dos,tres");
    expect(signal.directive).toContain("--remaining cuatro");
    expect(signal.directive).not.toContain("--remaining cuatro,uno,dos,tres");
  });

  it("conserva cobertura preservada por el reset aunque el auditor vuelva a waiting", () => {
    const nodes = [
      node({ id: "uno", status: "completed", executedBy: "codex", updatedAt: "2026-08-21T00:00:00.000Z" }),
      node({ id: "dos", status: "completed", executedBy: "codex", updatedAt: "2026-08-21T00:10:00.000Z" }),
      node({ id: "tres", status: "completed", executedBy: "codex", updatedAt: "2026-08-21T00:20:00.000Z" }),
      node({ id: "cuatro", status: "completed", executedBy: "codex", updatedAt: "2026-08-21T00:30:00.000Z" }),
    ];
    const agentStates = [{
      agent: "claude",
      phase: "waiting" as const,
      summary: "Nueva pasada de auditoría pendiente",
      completed: 3,
      total: 4,
      reviewedNodeIds: ["uno", "dos", "tres"],
      remainingNodeIds: ["cuatro"],
      startedAt: "2026-08-21T00:25:00.000Z",
      updatedAt: "2026-08-21T00:31:00.000Z",
    }];

    const signal = computeAttention(detail({
      nodes,
      run: { auditors: ["claude"], baseAgent: "codex" },
      agentStates,
    }), "claude");

    expect(signal.kind).toBe("audit");
    expect(signal.directive).toContain("--completed 3");
    expect(signal.directive).toContain("--reviewed uno,dos,tres");
    expect(signal.directive).toContain("--remaining cuatro");
    expect(signal.directive).not.toContain("--remaining cuatro,uno,dos,tres");
  });

  it("la directiva de auditoría pide cobertura sólo sobre los nodos ajenos", () => {
    const signal = computeAttention(detail({
      nodes: [
        node({ id: "ajeno-uno", status: "completed", executedBy: "claude" }),
        node({ id: "ajeno-dos", status: "completed", executedBy: "claude" }),
        node({ id: "propio", status: "completed", executedBy: "codex", assignee: "codex" }),
      ],
      run: { auditors: ["codex"], baseAgent: "claude" },
    }), "codex");
    expect(signal.kind).toBe("audit");
    expect(signal.directive).toContain("--total 2");
    expect(signal.directive).toContain("--remaining ajeno-uno,ajeno-dos");
    expect(signal.directive).not.toContain("--remaining propio");
    expect(signal.directive).toContain("1 nodos propios quedan fuera");
  });

  it("una ejecución pausada o detenida nunca ordena trabajar", () => {
    const nodes = [node({ id: "listo" })];
    const pausada = computeAttention(detail({ nodes, run: { control: "paused" } }), "claude");
    expect(pausada.kind).toBe("paused");
    expect(pausada.actionable).toBe(false);
    expect(pausada.waiting).toBe(true);

    const detenida = computeAttention(detail({ nodes, run: { control: "stopped" } }), "claude");
    expect(detenida.kind).toBe("stopped");
    expect(detenida.terminal).toBe(true);
    expect(detenida.actionable).toBe(false);
  });

  // La recuperación no se simula: se ejecuta contra HrpStore y se le pregunta a
  // computeAttention sobre el RunDetail resultante. Así la prueba cubre la
  // integración recuperación -> estado -> señal, que es donde puede romperse.
  it("despierta al nuevo dueño de un nodo recuperado sólo después de reanudar", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "hrp-attention-"));
    try {
      const workspace = path.join(root, "workspace");
      mkdirSync(workspace);
      const store = new HrpStore(path.join(root, "data"));
      const project = store.attachProject(workspace);
      const run = store.createRun(project.id, "Recuperación", "Recuperar un nodo en curso");
      store.setRunAuditors(run.id, ["antigravity"]);
      store.publishGraph(run.id, { nodes: [
        { id: "uno", file: "A.ts", symbol: "A.method", title: "Uno", description: "Work", rationale: "Required", dependencies: [] },
      ] }, "codex");
      store.recordPlanPass(run.id, "antigravity", 0);
      store.approveNodes(run.id);
      store.startNode(run.id, "uno", "codex");
      store.setRunControl(run.id, "paused");
      store.assignNode(run.id, "uno", "claude");

      const paused = computeAttention(store.getRunDetail(run.id)!, "claude");
      expect(paused.kind).toBe("paused");
      expect(paused.actionable).toBe(false);

      store.setRunControl(run.id, "active");
      const resumed = store.getRunDetail(run.id)!;

      const previousOwner = computeAttention(resumed, "codex");
      expect(previousOwner.actionable).toBe(false);
      expect(previousOwner.directive).not.toContain("uno");

      const newOwner = computeAttention(resumed, "claude");
      expect(newOwner.kind).toBe("work");
      expect(newOwner.actionable).toBe(true);
      expect(newOwner.directive).toBe("Aprobado: 1 nodo disponible (uno)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tras reemplazar un auditor sólo el auditor vigente recibe la pasada", () => {
    const nodes = [node({ id: "uno", status: "completed", executedBy: "codex" })];
    const agentStates = [{
      agent: "claude",
      phase: "waiting" as const,
      summary: "Retirado de auditoría por el humano",
      completed: 1,
      total: 1,
      reviewedNodeIds: ["uno"],
      remainingNodeIds: [],
      updatedAt: timestamp,
    }];

    const removed = computeAttention(detail({
      nodes,
      run: { auditors: ["antigravity"], baseAgent: "codex" },
      agentStates,
    }), "claude");
    expect(removed.kind).toBe("done");
    expect(removed.actionable).toBe(false);

    const replacement = computeAttention(detail({
      nodes,
      run: { auditors: ["antigravity"], baseAgent: "codex" },
      agentStates,
    }), "antigravity");
    expect(replacement.kind).toBe("audit");
    // La cobertura arranca vacía para el reemplazo y el nodo ajeno le queda
    // pendiente: eso es lo que se afirma, no que el texto lleve cierto id.
    expect(replacement.directive).toContain("--completed 0 --total 1");
    expect(replacement.directive).toContain("--remaining uno");
  });

  it("ofrece trabajo compatible aunque haya un nodo ajeno en vuelo", () => {
    const signal = computeAttention(detail({
      nodes: [
        node({ id: "en-vuelo", assignee: "codex", executedBy: "codex", status: "running" }),
        node({ id: "mio", assignee: "claude" }),
      ],
    }), "claude");
    expect(signal.kind).toBe("work");
    expect(signal.actionable).toBe(true);
    expect(signal.directive).toContain("mio");
    expect(signal.directive).not.toContain("en-vuelo");
  });

  it("pide esperar cuando el trabajo listo choca con un nodo ajeno en vuelo", () => {
    const signal = computeAttention(detail({
      nodes: [
        node({ id: "en-vuelo", file: "A.ts", assignee: "codex", executedBy: "codex", status: "running" }),
        node({ id: "mio", file: "A.ts", assignee: "claude" }),
      ],
    }), "claude");
    expect(signal.kind).toBe("busy");
    expect(signal.actionable).toBe(false);
    expect(signal.waiting).toBe(true);
    expect(signal.directive).toContain("en-vuelo");
    expect(signal.directive).toContain("ambos modifican A.ts");
  });

  it("al dueño del nodo en vuelo se le ordena cerrarlo, que es justo a quien hay que despertar", () => {
    const signal = computeAttention(detail({
      nodes: [
        node({ id: "en-vuelo", assignee: "claude", executedBy: "claude", status: "running" }),
        node({ id: "pendiente", assignee: "claude" }),
      ],
    }), "claude");
    expect(signal.kind).toBe("work");
    expect(signal.actionable).toBe(true);
    expect(signal.directive).toContain("en-vuelo");
    // No debe ofrecerle un nodo nuevo mientras arrastra uno a medias.
    expect(signal.directive).not.toContain("pendiente");
  });

  // La regla de compatibilidad vive dos veces: en computeAttention y en
  // HrpStore.startNode. Esta prueba no las simula con fixtures: corre el mismo
  // grafo contra el store real y comprueba que la señal sólo ofrece lo que el
  // servidor aceptaría iniciar. Si una copia cambia sin la otra, falla aquí.
  it("no ofrece un segundo nodo al mismo agente porque el servidor lo rechazaría", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "hrp-attention-"));
    try {
      const workspace = path.join(root, "workspace");
      mkdirSync(workspace);
      const store = new HrpStore(path.join(root, "data"));
      const project = store.attachProject(workspace);
      const run = store.createRun(project.id, "Concurrencia", "Nodos compatibles en paralelo");
      store.setRunAuditors(run.id, ["antigravity"]);
      store.publishGraph(run.id, { nodes: [
        { id: "mio-uno", file: "A.ts", symbol: "A.first", title: "Uno", description: "Work", rationale: "Required", dependencies: [] },
        { id: "mio-dos", file: "B.ts", symbol: "B.second", title: "Dos", description: "Work", rationale: "Required", dependencies: [] },
        { id: "ajeno", file: "C.ts", symbol: "C.third", title: "Ajeno", description: "Work", rationale: "Required", dependencies: [], suggestedAgent: "codex" },
      ] }, "claude");
      store.recordPlanPass(run.id, "antigravity", 0);
      store.approveNodes(run.id);
      store.startNode(run.id, "mio-uno", "claude");

      const propia = computeAttention(store.getRunDetail(run.id)!, "claude");
      expect(propia.directive).toContain("mio-uno");
      expect(propia.directive).not.toContain("mio-dos");
      expect(() => store.startNode(run.id, "mio-dos", "claude")).toThrow(/already running mio-uno/);

      // La otra mitad del invariante: al agente distinto sí se le ofrece su
      // nodo compatible, y el servidor lo acepta.
      const ajena = computeAttention(store.getRunDetail(run.id)!, "codex");
      expect(ajena.kind).toBe("work");
      expect(ajena.directive).toContain("ajeno");
      expect(store.startNode(run.id, "ajeno", "codex").status).toBe("running");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("un nodo sin aprobar no es trabajo disponible", () => {
    const signal = computeAttention(detail({ nodes: [node({ id: "sin-aprobar", approved: false })] }), "claude");
    expect(signal.actionable).toBe(false);
    expect(signal.waiting).toBe(true);
  });
});

describe("auditableNodes", () => {
  it("deja fuera lo que el propio auditor escribió, que es lo que el contrato le prohíbe revisar", () => {
    const detalle = detail({
      nodes: [
        node({ id: "ajeno", status: "completed", executedBy: "claude" }),
        node({ id: "propio-ejecutado", status: "completed", executedBy: "codex", assignee: "codex" }),
        node({ id: "propio-asignado", status: "completed", assignee: "codex" }),
      ],
    });
    expect(auditableNodes(detalle, "codex").map((candidate) => candidate.id)).toEqual(["ajeno"]);
    // Quien no implementó nada audita la ejecución completa.
    expect(auditableNodes(detalle, "revisor-puro")).toHaveLength(3);
  });
});

describe("attentionRank", () => {
  it("ordena las señales accionables antes que las de espera y el cierre al final", () => {
    expect(attentionRank("findings")).toBeLessThan(attentionRank("work"));
    expect(attentionRank("work")).toBeLessThan(attentionRank("blocked"));
    expect(attentionRank("gate")).toBeLessThan(attentionRank("released"));
    expect(attentionRank("released")).toBeLessThan(attentionRank("stopped"));
    expect(attentionRank("blocked")).toBeLessThan(attentionRank("busy"));
    expect(attentionRank("busy")).toBeLessThan(attentionRank("stopped"));
    expect(attentionRank("stopped")).toBeLessThan(attentionRank("idle"));
  });

  it("cubre todos los tipos declarados, para que ninguno herede una prioridad por omisión", () => {
    for (const kind of attentionKinds) expect(attentionRank(kind)).toBeGreaterThanOrEqual(0);
    expect(new Set(attentionKinds.map(attentionRank)).size).toBe(attentionKinds.length);
  });
  describe("gate del plan", () => {
    const gate = (pending: string[]) => ({
      planGate: { graphVersion: 1, auditors: ["codex", "ollama"], reviewed: ["codex", "ollama"].filter((auditor) => !pending.includes(auditor)), pending, open: pending.length > 0 },
      auditors: ["codex", "ollama"],
      baseAgent: "claude",
    });

    it("despierta al auditor que todavía no opinó sobre el grafo", () => {
      const signal = computeAttention(detail({ nodes: [node({ id: "uno", approved: false })], run: gate(["codex"]) }), "codex");
      expect(signal.kind).toBe("plan");
      expect(signal.actionable).toBe(true);
      expect(signal.directive).toContain("hrp graph review run --agent codex");
      expect(signal.directive).toContain("hrp graph review done");
    });

    it("no retiene al modelo base mientras faltan pasadas de plan", () => {
      const signal = computeAttention(detail({ nodes: [node({ id: "uno", approved: false })], run: gate(["codex"]) }), "claude");
      expect(signal.kind).toBe("idle");
      expect(signal.actionable).toBe(false);
      expect(signal.directive).not.toContain("codex");
    });

    it("deja de reclamarle al auditor que ya publicó su pasada", () => {
      const signal = computeAttention(detail({ nodes: [node({ id: "uno", approved: false })], run: gate(["ollama"]) }), "codex");
      expect(signal.kind).not.toBe("plan");
    });

    it("prioriza la auditoría del plan sobre tomar trabajo", () => {
      expect(attentionRank("plan")).toBeLessThan(attentionRank("work"));
    });
  });
});

describe("identidad de sesión en la directiva", () => {
  // El comando se pega en una sesión ya abierta y la bandera sólo vale para esa
  // invocación: sin este recordatorio, el comando siguiente vuelve a publicar
  // como la familia y pisa el estado de la otra sesión.
  const base = detail({ nodes: [node({ id: "uno" })] });

  it("declara la identidad cuando quien pregunta es una sesión", () => {
    const { directive } = computeAttention(base, "claude:2");
    expect(directive.startsWith("Tu identidad en HRP es claude:2:")).toBe(true);
    expect(directive).toContain("--agent");
  });

  it("no la declara para la familia pelada", () => {
    expect(computeAttention(base, "claude").directive).not.toContain("Tu identidad en HRP es");
  });

  it("ni para un carril delegado, que no abre sesión", () => {
    expect(computeAttention(base, "ollama:glm-5.2").directive).not.toContain("Tu identidad en HRP es");
  });

  it("conserva la señal original detrás del preámbulo", () => {
    // Se compara con otro agente ajeno a la ejecución —no con el modelo base,
    // que sí tiene trabajo— para que la única diferencia sea el preámbulo.
    const conSesion = computeAttention(base, "claude:2");
    const ajeno = computeAttention(base, "codex");
    expect(conSesion.kind).toBe(ajeno.kind);
    expect(conSesion.directive.replace(/^Tu identidad en HRP es claude:2:[^.]*\. /, ""))
      .toBe(ajeno.directive.replaceAll("codex", "claude:2"));
  });
});
