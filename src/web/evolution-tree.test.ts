import { describe, expect, it } from "vitest";
import type { EvolutionFrame } from "../shared/evolution.js";
import { buildEvolutionTree, evolutionHighlights, expandedDirectories, filesAtFrame, frameIndexForNode, highlightLevel } from "./evolution-tree.js";

const base = ["README.md", "src/app.ts", "src/old.ts", "docs/guide.md"];
const frames: EvolutionFrame[] = [
  { nodeId: "n1", files: [{ path: "src/new.ts", status: "A" }, { path: "src/app.ts", status: "M" }] },
  { nodeId: "n2", files: [{ path: "src/moved.ts", status: "R", from: "src/old.ts" }] },
  { nodeId: "n3", files: [{ path: "docs/guide.md", status: "D" }] },
  { nodeId: "n4", files: [{ path: "src/new.ts", status: "M" }] },
];

describe("filesAtFrame", () => {
  it("aplica creaciones, renombres y borrados hasta el cuadro dado", () => {
    expect(filesAtFrame(base, frames, -1)).toEqual([...base].sort());
    expect(filesAtFrame(base, frames, 0)).toEqual(["README.md", "docs/guide.md", "src/app.ts", "src/new.ts", "src/old.ts"]);
    expect(filesAtFrame(base, frames, 1)).toEqual(["README.md", "docs/guide.md", "src/app.ts", "src/moved.ts", "src/new.ts"]);
    expect(filesAtFrame(base, frames, 2)).toEqual(["README.md", "src/app.ts", "src/moved.ts", "src/new.ts"]);
    expect(filesAtFrame(base, frames, 99)).toEqual(["README.md", "src/app.ts", "src/moved.ts", "src/new.ts"]);
  });
});

describe("evolutionHighlights", () => {
  it("marca el cuadro actual y acumula los anteriores con su antigüedad", () => {
    const highlights = evolutionHighlights(frames, 3);
    expect(highlights.get("src/new.ts")).toEqual({ kind: "current", age: 0, status: "M" });
    expect(highlights.get("src/app.ts")).toEqual({ kind: "past", age: 3, status: "M" });
    expect(highlights.get("src/moved.ts")).toEqual({ kind: "past", age: 2, status: "R" });
    expect(highlights.get("src/old.ts")).toBeUndefined();
    expect(highlights.get("docs/guide.md")).toEqual({ kind: "past", age: 1, status: "D" });
  });

  it("no mira más allá del cuadro actual", () => {
    const highlights = evolutionHighlights(frames, 0);
    expect([...highlights.keys()]).toEqual(["src/new.ts", "src/app.ts"]);
    expect(highlights.get("src/new.ts")?.kind).toBe("current");
    expect(evolutionHighlights(frames, -1).size).toBe(0);
  });

  it("acota el nivel de decaimiento", () => {
    expect(highlightLevel(0)).toBe(0);
    expect(highlightLevel(3)).toBe(3);
    expect(highlightLevel(40)).toBe(4);
  });
});

describe("buildEvolutionTree", () => {
  it("arma carpetas antes que archivos, ordenadas por nombre", () => {
    const tree = buildEvolutionTree(["src/web/App.tsx", "README.md", "src/app.ts", "docs/guide.md", "src/web/main.tsx"]);
    expect(tree.map((node) => `${node.kind}:${node.path}`)).toEqual(["dir:docs", "dir:src", "file:README.md"]);
    const src = tree[1];
    expect(src.children.map((node) => `${node.kind}:${node.path}`)).toEqual(["dir:src/web", "file:src/app.ts"]);
    expect(src.children[0].children.map((node) => node.name)).toEqual(["App.tsx", "main.tsx"]);
  });

  it("devuelve vacío sin rutas", () => {
    expect(buildEvolutionTree([])).toEqual([]);
  });
});

describe("expandedDirectories y frameIndexForNode", () => {
  it("lista las carpetas que llevan a cada ruta", () => {
    expect([...expandedDirectories(["src/web/App.tsx", "README.md", "docs/a/b/c.md"])].sort()).toEqual(["docs", "docs/a", "docs/a/b", "src", "src/web"]);
  });

  it("encuentra el cuadro de un nodo", () => {
    expect(frameIndexForNode(frames, "n3")).toBe(2);
    expect(frameIndexForNode(frames, "n9")).toBe(-1);
    expect(frameIndexForNode(frames, undefined)).toBe(-1);
  });
});
