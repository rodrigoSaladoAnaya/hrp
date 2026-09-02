// Evolución del run: la línea de tiempo del panel sobre el árbol de archivos.
// Un cuadro por nodo completado; el estado de cada archivo sale del diff que
// git midió al completar, así que no hay columna nueva ni migración.

export const evolutionFileStatuses = ["A", "M", "D", "R"] as const;
export type EvolutionFileStatus = (typeof evolutionFileStatuses)[number];

export type EvolutionFileChange = {
  path: string;
  status: EvolutionFileStatus;
  // Ruta anterior en un renombre.
  from?: string;
};

export type EvolutionFrame = {
  nodeId: string;
  commit?: string;
  committedAt?: string;
  files: EvolutionFileChange[];
};

export type EvolutionData = {
  // Commit del que parte el run (padre del primer commit de nodo). Ausente si
  // no hay nodos completados o el commit ya no es alcanzable.
  baseCommit?: string;
  baseFiles: string[];
  frames: EvolutionFrame[];
  // El árbol base se reconstruyó sólo con los archivos de los nodos.
  partial: boolean;
};

const sectionStart = /^diff --git a\/(.+) b\/(.+)$/;

// Recorre los encabezados de cada sección del diff. Las rutas salen de
// `rename from/to` cuando existen (son inequívocas) y de `--- a/` `+++ b/`
// en el resto; el encabezado `diff --git` sólo se usa de respaldo.
export function fileChangesFromDiff(diff: string): EvolutionFileChange[] {
  const changes: EvolutionFileChange[] = [];
  const lines = diff.split("\n");
  let index = 0;
  while (index < lines.length) {
    const start = sectionStart.exec(lines[index]);
    if (!start) { index += 1; continue; }
    let status: EvolutionFileStatus = "M";
    let from: string | undefined;
    let to: string | undefined;
    let oldPath: string | undefined;
    let newPath: string | undefined;
    index += 1;
    while (index < lines.length && !sectionStart.test(lines[index])) {
      const line = lines[index];
      if (line.startsWith("new file mode") || line.startsWith("copy to ")) status = "A";
      else if (line.startsWith("deleted file mode")) status = "D";
      else if (line.startsWith("rename from ")) { status = "R"; from = line.slice("rename from ".length); }
      else if (line.startsWith("rename to ")) to = line.slice("rename to ".length);
      else if (line.startsWith("--- a/")) oldPath = line.slice("--- a/".length);
      else if (line.startsWith("+++ b/")) newPath = line.slice("+++ b/".length);
      else if (line.startsWith("@@")) { index += 1; break; }
      index += 1;
    }
    // Saltar el cuerpo de los hunks hasta la siguiente sección.
    while (index < lines.length && !sectionStart.test(lines[index])) index += 1;
    const path = to ?? (status === "D" ? oldPath : newPath) ?? (status === "D" ? start[1] : start[2]);
    changes.push(status === "R" ? { path, status, from: from ?? oldPath ?? start[1] } : { path, status });
  }
  return changes;
}
