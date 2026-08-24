import type { ChangeNode } from "../shared/protocol.js";

// La selección para asignar por lote se calcula sobre estos cuatro campos, no
// sobre el nodo entero: así las pruebas describen grafos completos sin fabricar
// diffs, verificaciones ni marcas de tiempo que no participan en la decisión.
export type SelectableNode = Pick<ChangeNode, "id" | "file" | "status" | "dependencies">;

// El store rechaza reasignar un nodo completado, y uno en vuelo sólo lo devuelve
// con la ejecución pausada. Filtramos aquí con la misma regla para que el conteo
// que ve el humano en la barra sea el que el servidor va a aceptar.
export function isAssignable(node: SelectableNode, paused: boolean): boolean {
  if (node.status === "running") return paused;
  return node.status === "pending" || node.status === "failed";
}

export function fileSelection(nodes: SelectableNode[], file: string, paused: boolean): string[] {
  return nodes.filter((node) => node.file === file && isAssignable(node, paused)).map((node) => node.id);
}

// Una rama son los descendientes: la raíz y todo lo que depende de ella, directa
// o transitivamente. No arrastra ancestros —un prerrequisito no es parte de lo
// que se decidió mover—, y como las ramas de un DAG convergen, un nodo puede
// pertenecer a dos: el gesto extiende la selección, no particiona el grafo.
export function branchSelection(nodes: SelectableNode[], rootId: string, paused: boolean): string[] {
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      const list = dependents.get(dependency);
      if (list) list.push(node.id);
      else dependents.set(dependency, [node.id]);
    }
  }
  // El recorrido lleva vistos, no sólo por eficiencia: un grafo publicado puede
  // declarar una dependencia circular por error y HRP no la rechaza al publicar,
  // así que sin esta marca el panel se colgaría al seleccionar esa rama.
  const reached = new Set<string>();
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift()!;
    if (reached.has(current)) continue;
    reached.add(current);
    for (const next of dependents.get(current) ?? []) queue.push(next);
  }
  // Recorremos 'nodes' en vez de 'reached' para que el orden del resultado sea
  // el del grafo y no el del recorrido, y para descartar de paso un id alcanzado
  // que no corresponde a ningún nodo.
  return nodes.filter((node) => reached.has(node.id) && isAssignable(node, paused)).map((node) => node.id);
}

// Un gesto que sólo suma obliga a limpiar toda la selección para corregir un
// clic. Si el grupo ya está entero dentro, el mismo gesto lo retira; si entró a
// medias —por convergencia de ramas o por un archivo ya parcialmente elegido—,
// completarlo es lo que el humano pidió.
export function toggleSelection(current: string[], group: string[]): string[] {
  if (!group.length) return current;
  const selected = new Set(current);
  const grouped = new Set(group);
  if (group.every((id) => selected.has(id))) return current.filter((id) => !grouped.has(id));
  return [...current, ...group.filter((id) => !selected.has(id))];
}
