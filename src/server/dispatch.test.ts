import { describe, expect, it } from "vitest";
import { planDispatch } from "./dispatch.js";
import type { ChangeNode, RunDetail } from "../shared/protocol.js";

// El lote decide qué archivos se editan a la vez, así que sus reglas se prueban
// sobre RunDetail armados a mano: planDispatch es puro y no gasta una sola
// llamada al proveedor para demostrar lo que acepta y lo que descarta.
const stamp = "2026-08-23T00:00:00.000Z";

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
    assignee: "ollama",
    dependencies: [],
    createdAt: stamp,
    updatedAt: stamp,
    ...partial,
  };
}

function detail(nodes: ChangeNode[], control: RunDetail["run"]["control"] = "active"): RunDetail {
  return {
    run: {
      id: "run",
      projectId: "project",
      title: "t",
      requirement: "r",
      status: "pending",
      control,
      graphVersion: 1,
      baseAgent: "claude",
      seenAgents: [],
      auditors: [],
      pendingAuditorCount: 0,
      nodeCount: nodes.length,
      completedCount: 0,
      awaitingApproval: 0,
      openFindings: 0,
      createdAt: stamp,
      updatedAt: stamp,
    },
    nodes,
    activity: [],
    findings: [],
    agentStates: [],
  };
}

const settings = { model: "base", tiers: { trivial: "cheap" } };
const reasonFor = (plan: ReturnType<typeof planDispatch>, nodeId: string) =>
  plan.skipped.find((item) => item.nodeId === nodeId)?.reason ?? "";

describe("planDispatch", () => {
  it("da un carril propio a cada modelo y resuelve el modelo por dificultad", () => {
    const plan = planDispatch(detail([
      node({ id: "a", difficulty: "trivial" }),
      node({ id: "b", difficulty: "standard" }),
    ]), { settings });

    expect(plan.batch).toEqual([
      { nodeId: "a", lane: "ollama:cheap", model: "cheap" },
      { nodeId: "b", lane: "ollama:base", model: "base" },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it("respeta el carril declarado en la asignación por encima de la dificultad", () => {
    const plan = planDispatch(detail([
      node({ id: "a", assignee: "ollama:elegido", difficulty: "trivial" }),
    ]), { settings });

    expect(plan.batch).toEqual([{ nodeId: "a", lane: "ollama:elegido", model: "elegido" }]);
  });

  it("no pone dos nodos en el mismo carril: una identidad sostiene un solo nodo", () => {
    const plan = planDispatch(detail([node({ id: "a" }), node({ id: "b" })]), { settings });

    expect(plan.batch.map((item) => item.nodeId)).toEqual(["a"]);
    expect(reasonFor(plan, "b")).toMatch(/carril ollama:base ya sostiene/);
  });

  it("descarta el nodo que chocaría con otro del mismo lote", () => {
    const plan = planDispatch(detail([
      node({ id: "a", difficulty: "trivial" }),
      node({ id: "b", file: "a.ts", difficulty: "standard" }),
    ]), { settings });

    expect(plan.batch.map((item) => item.nodeId)).toEqual(["a"]);
    expect(reasonFor(plan, "b")).toMatch(/ambos modifican a\.ts/);
  });

  it("descarta el nodo que chocaría con uno ya en curso y respeta su carril ocupado", () => {
    const plan = planDispatch(detail([
      node({ id: "corriendo", status: "running", executedBy: "ollama:cheap" }),
      node({ id: "hermano", file: "corriendo.ts", difficulty: "standard" }),
      node({ id: "mismo-carril", difficulty: "trivial" }),
    ]), { settings });

    expect(plan.batch).toEqual([]);
    expect(reasonFor(plan, "hermano")).toMatch(/conflicto con el nodo en curso corriendo/);
    expect(reasonFor(plan, "mismo-carril")).toMatch(/carril ollama:cheap ya sostiene/);
  });

  it("descarta lo no aprobado y lo que aún depende de otro nodo", () => {
    const plan = planDispatch(detail([
      node({ id: "a", difficulty: "trivial" }),
      node({ id: "dependiente", dependencies: ["a"], difficulty: "standard" }),
      node({ id: "sin-aprobar", approved: false, difficulty: "hard" }),
    ]), { settings });

    expect(plan.batch.map((item) => item.nodeId)).toEqual(["a"]);
    expect(reasonFor(plan, "dependiente")).toMatch(/dependencias incompletas: a/);
    expect(reasonFor(plan, "sin-aprobar")).toMatch(/aprobación humana/);
  });

  it("ignora el trabajo que no es delegado", () => {
    const plan = planDispatch(detail([
      node({ id: "propio", assignee: "claude" }),
      node({ id: "sin-dueno", assignee: undefined }),
    ]), { settings });

    expect(plan.batch).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it("recorta el lote con el tope de carriles", () => {
    const plan = planDispatch(detail([
      node({ id: "a", difficulty: "trivial" }),
      node({ id: "b", assignee: "ollama:otro" }),
    ]), { settings, maxLanes: 1 });

    expect(plan.batch.map((item) => item.nodeId)).toEqual(["a"]);
    expect(reasonFor(plan, "b")).toMatch(/tope de 1 carril/);
  });

  it("no despacha nada mientras el humano tiene la ejecución detenida", () => {
    for (const [control, expected] of [["paused", /pausada/], ["stopped", /detenida/]] as const) {
      const plan = planDispatch(detail([node({ id: "a" })], control), { settings });
      expect(plan.batch).toEqual([]);
      expect(reasonFor(plan, "a")).toMatch(expected);
    }
  });

  it("hereda el modelo por defecto cuando la dificultad no tiene nivel configurado", () => {
    const plan = planDispatch(detail([node({ id: "a", difficulty: "hard" })]), { settings: { model: "base" } });

    expect(plan.batch).toEqual([{ nodeId: "a", lane: "ollama:base", model: "base" }]);
  });
});
