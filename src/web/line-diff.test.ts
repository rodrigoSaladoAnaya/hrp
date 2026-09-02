import { describe, expect, it } from "vitest";
import { alignLines, diffRowCounts } from "./line-diff.js";

const kinds = (rows: ReturnType<typeof alignLines>) => rows.map((row) => `${row.kind}:${row.left?.number ?? "-"}/${row.right?.number ?? "-"}`);

describe("alignLines", () => {
  it("empareja líneas iguales con sus dos numeraciones", () => {
    expect(kinds(alignLines("a\nb\n", "a\nb\n"))).toEqual(["same:1/1", "same:2/2"]);
    expect(alignLines("", "")).toEqual([]);
    expect(alignLines(undefined, undefined)).toEqual([]);
  });

  it("marca añadidas y borradas sin contraparte", () => {
    expect(kinds(alignLines("a\nc\n", "a\nb\nc\n"))).toEqual(["same:1/1", "add:-/2", "same:2/3"]);
    expect(kinds(alignLines("a\nb\nc\n", "a\nc\n"))).toEqual(["same:1/1", "del:2/-", "same:3/2"]);
  });

  it("empareja borradas y añadidas consecutivas como modificadas y deja el resto", () => {
    const rows = alignLines("a\nb\nc\nd\n", "a\nB\nC2\nC3\nd\n");
    expect(kinds(rows)).toEqual(["same:1/1", "mod:2/2", "mod:3/3", "add:-/4", "same:4/5"]);
    expect(rows[1]).toEqual({ kind: "mod", left: { number: 2, text: "b" }, right: { number: 2, text: "B" } });
    expect(diffRowCounts(rows)).toEqual({ added: 1, deleted: 0, modified: 2 });
  });

  it("trata creación y borrado como sólo un lado", () => {
    expect(kinds(alignLines(undefined, "x\ny\n"))).toEqual(["add:-/1", "add:-/2"]);
    expect(kinds(alignLines("x\ny\n", undefined))).toEqual(["del:1/-", "del:2/-"]);
  });

  it("respeta el prefijo y el sufijo comunes aunque el centro se repita", () => {
    const rows = alignLines("h\nx\nx\nt\n", "h\nx\nt\n");
    // El prefijo común absorbe la primera x; la segunda queda borrada.
    expect(kinds(rows)).toEqual(["same:1/1", "same:2/2", "del:3/-", "same:4/3"]);
    expect(rows.filter((row) => row.kind === "same").every((row) => row.left?.text === row.right?.text)).toBe(true);
  });

  it("por encima del tope trata el centro como reemplazo completo", () => {
    const rows = alignLines("h\na\nb\nc\nt\n", "h\nb\nz\nt\n", 4);
    expect(kinds(rows)).toEqual(["same:1/1", "mod:2/2", "mod:3/3", "del:4/-", "same:5/4"]);
  });

  it("no pierde la última línea sin salto final", () => {
    expect(alignLines("a\nb", "a\nb")).toHaveLength(2);
    expect(kinds(alignLines("a", "a\nb"))).toEqual(["same:1/1", "add:-/2"]);
  });
});
