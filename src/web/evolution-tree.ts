import type { EvolutionFileStatus, EvolutionFrame } from "../shared/evolution.js";

// Línea de tiempo del run sobre el árbol de archivos. El índice del cuadro es
// la posición del nodo completado; el árbol de cada cuadro se obtiene
// aplicando los cambios de los cuadros anteriores al árbol base.

export type EvolutionTreeNode = {
  name: string;
  path: string;
  kind: "dir" | "file";
  children: EvolutionTreeNode[];
};

export type EvolutionHighlight = {
  kind: "current" | "past";
  // Cuadros transcurridos desde la última vez que se tocó la ruta.
  age: number;
  status: EvolutionFileStatus;
};

// Niveles de decaimiento del resaltado pasado; a partir del último todo se
// ve igual de tenue.
export const evolutionHighlightLevels = 4;

export function highlightLevel(age: number): number {
  return Math.min(Math.max(age, 0), evolutionHighlightLevels);
}

export function filesAtFrame(baseFiles: string[], frames: EvolutionFrame[], index: number): string[] {
  const live = new Set(baseFiles);
  for (const frame of frames.slice(0, index + 1)) {
    for (const change of frame.files) {
      if (change.status === "D") { live.delete(change.path); continue; }
      if (change.status === "R" && change.from) live.delete(change.from);
      live.add(change.path);
    }
  }
  return [...live].sort();
}

export function evolutionHighlights(frames: EvolutionFrame[], index: number): Map<string, EvolutionHighlight> {
  const highlights = new Map<string, EvolutionHighlight>();
  for (let position = 0; position <= index && position < frames.length; position += 1) {
    for (const change of frames[position].files) {
      if (change.status === "R" && change.from) highlights.delete(change.from);
      highlights.set(change.path, { kind: position === index ? "current" : "past", age: index - position, status: change.status });
    }
  }
  return highlights;
}

export function buildEvolutionTree(paths: string[]): EvolutionTreeNode[] {
  const root: EvolutionTreeNode = { name: "", path: "", kind: "dir", children: [] };
  const directories = new Map<string, EvolutionTreeNode>([["", root]]);
  for (const path of paths) {
    const segments = path.split("/").filter(Boolean);
    let parent = root;
    segments.forEach((segment, position) => {
      const current = segments.slice(0, position + 1).join("/");
      const isFile = position === segments.length - 1;
      if (isFile) { parent.children.push({ name: segment, path: current, kind: "file", children: [] }); return; }
      let directory = directories.get(current);
      if (!directory) {
        directory = { name: segment, path: current, kind: "dir", children: [] };
        directories.set(current, directory);
        parent.children.push(directory);
      }
      parent = directory;
    });
  }
  const sort = (node: EvolutionTreeNode) => {
    node.children.sort((left, right) => (left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "dir" ? -1 : 1));
    node.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

// Carpetas que hay que abrir para que se vean las rutas dadas.
export function expandedDirectories(paths: string[]): Set<string> {
  const expanded = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/").filter(Boolean);
    for (let depth = 1; depth < segments.length; depth += 1) expanded.add(segments.slice(0, depth).join("/"));
  }
  return expanded;
}

export function frameIndexForNode(frames: EvolutionFrame[], nodeId: string | undefined): number {
  if (!nodeId) return -1;
  return frames.findIndex((frame) => frame.nodeId === nodeId);
}
