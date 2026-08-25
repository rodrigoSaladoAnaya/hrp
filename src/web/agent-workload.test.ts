import { describe, expect, it } from "vitest";
import { agentWorkload } from "./agent-workload";

const node = (fields: Partial<Parameters<typeof agentWorkload>[0][number]>) => ({ status: "pending" as const, ...fields });

describe("agent-workload", () => {
  it("counts as pending only what is still assigned and unfinished", () => {
    const nodes = [
      node({ assignee: "codex" }),
      node({ assignee: "codex", status: "running" }),
      node({ assignee: "codex", status: "completed", executedBy: "codex" }),
    ];
    expect(agentWorkload(nodes, "codex", "claude").pending).toBe(2);
  });

  it("gives the base agent whatever nobody claimed", () => {
    const nodes = [node({}), node({ assignee: "codex" })];
    expect(agentWorkload(nodes, "claude", "claude").pending).toBe(1);
    expect(agentWorkload(nodes, "codex", "claude").pending).toBe(1);
  });

  it("credits a finished operation to whoever executed it", () => {
    // El implementador termina su reparto con cero pendientes: sin la cuenta de
    // lo implementado su fila se leía como si no hubiera hecho nada.
    const nodes = [
      node({ assignee: "claude", status: "completed", executedBy: "claude" }),
      node({ assignee: "claude", status: "completed", executedBy: "claude" }),
    ];
    expect(agentWorkload(nodes, "claude", "claude")).toEqual({ pending: 0, implemented: 2 });
  });

  it("follows the executor when it is not who had the operation assigned", () => {
    // Un nodo delegado o retomado lo cuenta quien lo ejecutó, igual que la
    // tarjeta del grafo, no quien lo tenía asignado.
    const nodes = [node({ assignee: "ollama", status: "completed", executedBy: "ollama:glm-5.2" })];
    expect(agentWorkload(nodes, "ollama:glm-5.2", "claude").implemented).toBe(1);
    expect(agentWorkload(nodes, "ollama", "claude").implemented).toBe(0);
  });

  it("credits the base agent for finished operations nobody claimed", () => {
    const nodes = [node({ status: "completed" })];
    expect(agentWorkload(nodes, "claude", "claude").implemented).toBe(1);
    expect(agentWorkload(nodes, "codex", "claude").implemented).toBe(0);
  });

  it("credits nobody for unclaimed operations when there is no base agent", () => {
    const nodes = [node({}), node({ status: "completed" })];
    expect(agentWorkload(nodes, "claude", undefined)).toEqual({ pending: 0, implemented: 0 });
  });

  it("leaves a failed operation in the pending count, not in the implemented one", () => {
    const nodes = [node({ assignee: "codex", status: "failed", executedBy: "codex" })];
    expect(agentWorkload(nodes, "codex", "claude")).toEqual({ pending: 1, implemented: 0 });
  });
});
