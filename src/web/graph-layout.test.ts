import { describe, expect, it } from "vitest";
import { layoutGraph } from "./App";
import type { ChangeNode } from "../shared/protocol";

function change(id: string, dependencies: string[] = []): ChangeNode {
  return {
    id,
    runId: "run-1",
    file: `src/${id}.ts`,
    symbol: id,
    title: id,
    description: "",
    rationale: "",
    status: "pending",
    discovered: false,
    approved: true,
    dependencies,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

describe("layoutGraph", () => {
  const noop = () => undefined;
  const { nodes, edges } = layoutGraph(
    [change("uno"), change("dos", ["uno"])],
    undefined,
    undefined,
    false,
    [],
    noop,
    noop,
  );

  it("declares measures on every node so ReactFlow renders without measuring", () => {
    expect(nodes).toHaveLength(2);
    for (const node of nodes) {
      expect(node.measured?.width).toBeGreaterThan(0);
      expect(node.measured?.height).toBeGreaterThan(0);
    }
  });

  it("keeps positions finite and links dependencies", () => {
    for (const node of nodes) {
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([["uno", "dos"]]);
  });

  it("leaves width and height undeclared so the card is not clipped by inline styles", () => {
    for (const node of nodes) {
      expect(node.width).toBeUndefined();
      expect(node.height).toBeUndefined();
    }
  });
});
