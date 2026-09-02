import { describe, expect, it } from "vitest";
import { fileChangesFromDiff } from "./evolution.js";

const created = [
  "diff --git a/src/tetris/pieces.ts b/src/tetris/pieces.ts",
  "new file mode 100644",
  "index 0000000..e2df66a",
  "--- /dev/null",
  "+++ b/src/tetris/pieces.ts",
  "@@ -0,0 +1,2 @@",
  "+export const a = 1;",
  "+export const b = 2;",
].join("\n");

const modified = [
  "diff --git a/tsconfig.json b/tsconfig.json",
  "index 1fefcda..4b8483b 100644",
  "--- a/tsconfig.json",
  "+++ b/tsconfig.json",
  "@@ -17,6 +17,6 @@",
  "-    \"jsx\": \"react\",",
  "+    \"jsx\": \"react-jsx\",",
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

const deleted = [
  "diff --git a/src/old.ts b/src/old.ts",
  "deleted file mode 100644",
  "index e2df66a..0000000",
  "--- a/src/old.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-export const a = 1;",
  "-export const b = 2;",
].join("\n");

const renamedClean = [
  "diff --git a/src/a b.ts b/src/c d.ts",
  "similarity index 100%",
  "rename from src/a b.ts",
  "rename to src/c d.ts",
].join("\n");

const renamedEdited = [
  "diff --git a/src/web/old-name.ts b/src/web/new-name.ts",
  "similarity index 88%",
  "rename from src/web/old-name.ts",
  "rename to src/web/new-name.ts",
  "index 1111111..2222222 100644",
  "--- a/src/web/old-name.ts",
  "+++ b/src/web/new-name.ts",
  "@@ -1 +1 @@",
  "-diff --git a/x b/x",
  "+new file mode 100644",
].join("\n");

describe("fileChangesFromDiff", () => {
  it("distingue creación, modificación y borrado", () => {
    expect(fileChangesFromDiff(created)).toEqual([{ path: "src/tetris/pieces.ts", status: "A" }]);
    expect(fileChangesFromDiff(modified)).toEqual([
      { path: "tsconfig.json", status: "M" },
      { path: "README.md", status: "M" },
    ]);
    expect(fileChangesFromDiff(deleted)).toEqual([{ path: "src/old.ts", status: "D" }]);
  });

  it("lee los renombres de rename from/to, con espacios y sin hunks", () => {
    expect(fileChangesFromDiff(renamedClean)).toEqual([{ path: "src/c d.ts", status: "R", from: "src/a b.ts" }]);
    expect(fileChangesFromDiff(renamedEdited)).toEqual([{ path: "src/web/new-name.ts", status: "R", from: "src/web/old-name.ts" }]);
  });

  it("no confunde el contenido de los hunks con encabezados", () => {
    // El cuerpo de renamedEdited contiene líneas que parecen encabezados.
    expect(fileChangesFromDiff(renamedEdited)).toHaveLength(1);
    expect(fileChangesFromDiff([created, deleted, modified].join("\n"))).toEqual([
      { path: "src/tetris/pieces.ts", status: "A" },
      { path: "src/old.ts", status: "D" },
      { path: "tsconfig.json", status: "M" },
      { path: "README.md", status: "M" },
    ]);
  });

  it("devuelve vacío sin diff", () => {
    expect(fileChangesFromDiff("")).toEqual([]);
    expect(fileChangesFromDiff("sin secciones\n")).toEqual([]);
  });
});
