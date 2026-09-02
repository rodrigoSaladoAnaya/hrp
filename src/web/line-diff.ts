// Alineado línea a línea del antes y el después de un archivo, para pintarlos
// lado a lado con una sola barra de scroll. Se recortan el prefijo y el sufijo
// comunes y se calcula la subsecuencia común más larga sólo sobre el centro,
// con un tope de celdas: por encima, el centro entero se trata como reemplazo.

export type DiffRowKind = "same" | "add" | "del" | "mod";

export type DiffLine = { number: number; text: string };

export type DiffRow = {
  kind: DiffRowKind;
  left?: DiffLine;
  right?: DiffLine;
};

export const lcsCellLimit = 4_000_000;

function splitLines(content: string | undefined): string[] {
  if (content === undefined) return [];
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Operaciones del centro en orden: 'same', 'del' (sólo antes), 'add' (sólo después).
type Edit = { kind: "same" | "del" | "add"; leftIndex?: number; rightIndex?: number };

function lcsEdits(left: string[], right: string[], leftOffset: number, rightOffset: number): Edit[] {
  const rows = left.length;
  const columns = right.length;
  if (!rows || !columns) {
    return [
      ...left.map((_, index) => ({ kind: "del", leftIndex: leftOffset + index } satisfies Edit)),
      ...right.map((_, index) => ({ kind: "add", rightIndex: rightOffset + index } satisfies Edit)),
    ];
  }
  const width = columns + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row * width + column] = left[row] === right[column]
        ? table[(row + 1) * width + column + 1] + 1
        : Math.max(table[(row + 1) * width + column], table[row * width + column + 1]);
    }
  }
  const edits: Edit[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (left[row] === right[column]) {
      edits.push({ kind: "same", leftIndex: leftOffset + row, rightIndex: rightOffset + column });
      row += 1; column += 1;
    } else if (table[(row + 1) * width + column] >= table[row * width + column + 1]) {
      edits.push({ kind: "del", leftIndex: leftOffset + row });
      row += 1;
    } else {
      edits.push({ kind: "add", rightIndex: rightOffset + column });
      column += 1;
    }
  }
  while (row < rows) { edits.push({ kind: "del", leftIndex: leftOffset + row }); row += 1; }
  while (column < columns) { edits.push({ kind: "add", rightIndex: rightOffset + column }); column += 1; }
  return edits;
}

// Un tramo de borradas seguido de añadidas se empareja en filas 'mod'; lo que
// sobra de uno u otro lado queda como 'del' o 'add'.
function pairRuns(edits: Edit[], left: string[], right: string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let index = 0;
  const line = (source: string[], at: number): DiffLine => ({ number: at + 1, text: source[at] });
  while (index < edits.length) {
    const edit = edits[index];
    if (edit.kind === "same") {
      rows.push({ kind: "same", left: line(left, edit.leftIndex!), right: line(right, edit.rightIndex!) });
      index += 1;
      continue;
    }
    const deleted: number[] = [];
    const added: number[] = [];
    while (index < edits.length && edits[index].kind !== "same") {
      const current = edits[index];
      if (current.kind === "del") deleted.push(current.leftIndex!);
      else added.push(current.rightIndex!);
      index += 1;
    }
    const paired = Math.min(deleted.length, added.length);
    for (let position = 0; position < paired; position += 1) {
      rows.push({ kind: "mod", left: line(left, deleted[position]), right: line(right, added[position]) });
    }
    for (let position = paired; position < deleted.length; position += 1) rows.push({ kind: "del", left: line(left, deleted[position]) });
    for (let position = paired; position < added.length; position += 1) rows.push({ kind: "add", right: line(right, added[position]) });
  }
  return rows;
}

export function alignLines(before: string | undefined, after: string | undefined, cellLimit = lcsCellLimit): DiffRow[] {
  const left = splitLines(before);
  const right = splitLines(after);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  const leftMiddle = left.slice(prefix, left.length - suffix);
  const rightMiddle = right.slice(prefix, right.length - suffix);
  const cells = (leftMiddle.length + 1) * (rightMiddle.length + 1);
  const middle = cells > cellLimit
    ? [
      ...leftMiddle.map((_, index) => ({ kind: "del", leftIndex: prefix + index } satisfies Edit)),
      ...rightMiddle.map((_, index) => ({ kind: "add", rightIndex: prefix + index } satisfies Edit)),
    ]
    : lcsEdits(leftMiddle, rightMiddle, prefix, prefix);
  const edits: Edit[] = [
    ...Array.from({ length: prefix }, (_, index) => ({ kind: "same", leftIndex: index, rightIndex: index } satisfies Edit)),
    ...middle,
    ...Array.from({ length: suffix }, (_, index) => ({ kind: "same", leftIndex: left.length - suffix + index, rightIndex: right.length - suffix + index } satisfies Edit)),
  ];
  return pairRuns(edits, left, right);
}

export function diffRowCounts(rows: DiffRow[]): { added: number; deleted: number; modified: number } {
  let added = 0;
  let deleted = 0;
  let modified = 0;
  for (const row of rows) {
    if (row.kind === "add") added += 1;
    else if (row.kind === "del") deleted += 1;
    else if (row.kind === "mod") modified += 1;
  }
  return { added, deleted, modified };
}
