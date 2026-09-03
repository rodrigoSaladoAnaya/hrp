import { describe, expect, it } from "vitest";
import { runAncestors, runDescendants, runLineage } from "./lineage";

const runs = [
  { id: "a" },
  { id: "b", continues: "a" },
  { id: "c", continues: "b" },
  { id: "d", continues: "a" },
  { id: "x" },
];

describe("linaje", () => {
  it("recorre los antecesores del más antiguo al propio run", () => {
    expect(runAncestors(runs, "c").map((run) => run.id)).toEqual(["a", "b", "c"]);
    expect(runAncestors(runs, "a").map((run) => run.id)).toEqual(["a"]);
    expect(runAncestors(runs, "nope")).toEqual([]);
  });

  it("lista los descendientes por niveles, con bifurcaciones", () => {
    expect(runDescendants(runs, "a").map((run) => run.id)).toEqual(["b", "d", "c"]);
    expect(runDescendants(runs, "x")).toEqual([]);
  });

  it("la historia junta antes y después sin repetir el run", () => {
    expect(runLineage(runs, "b").map((run) => run.id)).toEqual(["a", "b", "c"]);
  });

  it("un enlace roto o un ciclo cortan la cadena", () => {
    expect(runAncestors([{ id: "b", continues: "gone" }], "b").map((run) => run.id)).toEqual(["b"]);
    const cyclic = [{ id: "p", continues: "q" }, { id: "q", continues: "p" }];
    expect(runAncestors(cyclic, "p").map((run) => run.id)).toEqual(["q", "p"]);
  });
});
