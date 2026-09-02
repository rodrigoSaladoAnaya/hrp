import { describe, expect, it } from "vitest";
import { branchSelection, fileSelection, isAssignable, toggleSelection, type SelectableNode } from "./node-selection";

function node(id: string, file: string, dependencies: string[] = [], status: SelectableNode["status"] = "pending"): SelectableNode {
  return { id, file, status, dependencies };
}

// a → b → d, y a → c → d: 'd' es alcanzable por dos caminos.
const graph: SelectableNode[] = [
  node("a", "src/a.ts"),
  node("b", "src/b.ts", ["a"]),
  node("c", "src/b.ts", ["a"]),
  node("d", "src/d.ts", ["b", "c"]),
];

describe("node-selection", () => {
  it("takes the root and every transitive dependent once when branches converge", () => {
    expect(branchSelection(graph, "a", false)).toEqual(["a", "b", "c", "d"]);
  });

  it("does not drag ancestors into a branch", () => {
    expect(branchSelection(graph, "b", false)).toEqual(["b", "d"]);
  });

  it("returns the branch in graph order regardless of traversal order", () => {
    const shuffled = [graph[3], graph[1], graph[0], graph[2]];
    expect(branchSelection(shuffled, "a", false)).toEqual(["d", "b", "a", "c"]);
  });

  it("does not hang on a dependency cycle declared by mistake", () => {
    const cyclic = [node("p", "src/p.ts", ["q"]), node("q", "src/q.ts", ["p"])];
    expect(branchSelection(cyclic, "p", false)).toEqual(["p", "q"]);
  });

  it("never returns a reached id that names no node in the graph", () => {
    // 'fantasma' es una dependencia declarada hacia un nodo que no existe: el
    // recorrido la alcanza, pero sólo salen ids de nodos reales.
    expect(branchSelection([node("solo", "src/solo.ts", ["fantasma"])], "fantasma", false)).toEqual(["solo"]);
    expect(branchSelection(graph, "fantasma", false)).toEqual([]);
  });

  it("leaves completed nodes out of every selection", () => {
    const withCompleted = [node("a", "src/a.ts"), node("b", "src/a.ts", ["a"], "completed")];
    expect(fileSelection(withCompleted, "src/a.ts", true)).toEqual(["a"]);
    expect(branchSelection(withCompleted, "a", true)).toEqual(["a"]);
    expect(isAssignable(node("b", "src/a.ts", [], "completed"), true)).toBe(false);
  });

  it("takes a running node only while the execution is paused", () => {
    const running = [node("a", "src/a.ts", [], "running")];
    expect(fileSelection(running, "src/a.ts", false)).toEqual([]);
    expect(fileSelection(running, "src/a.ts", true)).toEqual(["a"]);
  });

  it("keeps failed nodes, which the store still lets the human reassign", () => {
    expect(fileSelection([node("a", "src/a.ts", [], "failed")], "src/a.ts", false)).toEqual(["a"]);
  });

  it("selects every assignable node of one file", () => {
    expect(fileSelection(graph, "src/b.ts", false)).toEqual(["b", "c"]);
    expect(fileSelection(graph, "src/ninguno.ts", false)).toEqual([]);
  });

  it("removes a group that was already selected whole", () => {
    expect(toggleSelection(["a", "b", "z"], ["a", "b"])).toEqual(["z"]);
  });

  it("completes a group that was selected only in part", () => {
    expect(toggleSelection(["a"], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("never repeats an id already selected", () => {
    expect(toggleSelection(["b"], ["a", "b", "c"])).toEqual(["b", "a", "c"]);
  });

  it("leaves the selection untouched when the group is empty", () => {
    const current = ["a"];
    expect(toggleSelection(current, [])).toBe(current);
  });
});
