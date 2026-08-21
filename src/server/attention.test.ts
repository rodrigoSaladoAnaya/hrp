import { describe, expect, it } from "vitest";
import { attentionKinds, attentionRank, auditableNodes, computeAttention } from "./attention.js";
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

  it("con un nodo ajeno en vuelo pide esperar, porque el workspace ejecuta uno a la vez", () => {
    const signal = computeAttention(detail({
      nodes: [
        node({ id: "en-vuelo", assignee: "codex", executedBy: "codex", status: "running" }),
        node({ id: "mio", assignee: "claude" }),
      ],
    }), "claude");
    expect(signal.kind).toBe("busy");
    expect(signal.actionable).toBe(false);
    expect(signal.waiting).toBe(true);
    expect(signal.directive).toContain("en-vuelo");
    expect(signal.directive).toContain("codex");
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
    expect(attentionRank("blocked")).toBeLessThan(attentionRank("busy"));
    expect(attentionRank("busy")).toBeLessThan(attentionRank("stopped"));
    expect(attentionRank("stopped")).toBeLessThan(attentionRank("idle"));
  });

  it("cubre todos los tipos declarados, para que ninguno herede una prioridad por omisión", () => {
    for (const kind of attentionKinds) expect(attentionRank(kind)).toBeGreaterThanOrEqual(0);
    expect(new Set(attentionKinds.map(attentionRank)).size).toBe(attentionKinds.length);
  });
});
