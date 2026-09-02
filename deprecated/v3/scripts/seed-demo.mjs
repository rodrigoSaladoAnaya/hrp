const url = process.env.HRP_URL ?? "http://127.0.0.1:4317";

async function api(path, init = {}) {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = response.status === 204 ? undefined : await response.json();
  if (!response.ok) throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  return body;
}

const project = await api("/api/projects", {
  method: "POST",
  body: JSON.stringify({ workspaceRoot: process.cwd() }),
});

const run = await api(`/api/projects/${project.id}/runs`, {
  method: "POST",
  body: JSON.stringify({
    title: "Construir el mapa semántico de HRP v3",
    requirement: "Representar operaciones por archivo y símbolo, sus dependencias, el diff aplicado y la evidencia de verificación.",
  }),
});

const nodes = [
  { id: "node-contract", file: "src/shared/protocol.ts", symbol: "ChangeNodeInput", title: "Definir la unidad semántica", description: "Declarar archivo, símbolo, intención, justificación y dependencias como contrato neutral.", rationale: "El grafo necesita una identidad estable que no dependa del proveedor del agente.", dependencies: [] },
  { id: "graph-store", file: "src/server/store.ts", symbol: "HrpStore.publishGraph", title: "Persistir el mapa evolutivo", description: "Guardar y actualizar nodos sin perder evidencia ya observada.", rationale: "El mapa debe sobrevivir reinicios y aceptar trabajo descubierto durante la ejecución.", dependencies: ["node-contract"] },
  { id: "graph-api", file: "src/server/http.ts", symbol: "POST /api/runs/:runId/graph", title: "Publicar el mapa por HTTP", description: "Exponer una ruta neutral para planes iniciales y expansiones posteriores.", rationale: "Codex, Claude y Gemini deben poder usar el mismo contrato mediante adaptadores mínimos.", dependencies: ["graph-store"] },
  { id: "graph-cli", file: "bin/hrp.mjs", symbol: "graph publish", title: "Añadir el comando de publicación", description: "Permitir que un agente publique un archivo JSON desde cualquier carpeta registrada.", rationale: "El CLI es el adaptador universal cuando no existe una integración nativa.", dependencies: ["graph-api"] },
  { id: "layout", file: "src/web/App.tsx", symbol: "layoutGraph", title: "Ordenar dependencias y ramas", description: "Transformar operaciones y dependencias en una topología dirigida legible.", rationale: "La vista global debe explicar el orden de ejecución antes de mostrar detalles.", dependencies: ["node-contract"] },
  { id: "node-card", file: "src/web/App.tsx", symbol: "ChangeNodeCard", title: "Representar cada operación", description: "Mostrar archivo, símbolo, intención breve y estado escrito en cada nodo.", rationale: "Dos métodos del mismo archivo necesitan identidad y progreso independientes.", dependencies: ["layout"] },
  { id: "inspector", file: "src/web/App.tsx", symbol: "Inspector", title: "Explicar intención y evidencia", description: "Mostrar qué hará, por qué, dependencias, diff y verificación al seleccionar un nodo.", rationale: "El desarrollador debe entender un cambio sin reconstruirlo desde logs.", dependencies: ["node-card"] },
  { id: "node-style", file: "src/web/styles.css", symbol: ".change-node", title: "Distinguir estados del recorrido", description: "Separar pendiente, activo, terminado y fallido mediante forma, texto y color.", rationale: "La red debe poder leerse de un vistazo y seguir siendo accesible sin color.", dependencies: ["node-card"] },
  { id: "dependency-test", file: "src/server/store.test.ts", symbol: "dependency order", title: "Probar el orden causal", description: "Impedir que una operación comience cuando sus dependencias no terminaron.", rationale: "Las conexiones del mapa deben representar una restricción real, no decoración.", dependencies: ["graph-store"] },
];

await api(`/api/runs/${run.id}/graph`, { method: "POST", body: JSON.stringify({ nodes, agent: "claude" }) });
await api(`/api/runs/${run.id}/approve`, { method: "POST", body: "{}" });

for (const completed of [
  { id: "node-contract", summary: "Se definió el contrato neutral de una operación semántica.", rationale: "Un contrato común mantiene la integración independiente del proveedor del agente.", diff: "@@ protocol contract\n+export type ChangeNodeInput = {\n+  file: string;\n+  symbol: string;\n+  rationale: string;\n+  dependencies: string[];\n+};" },
  { id: "graph-store", summary: "SQLite ahora conserva nodos, dependencias y evidencia por ejecución.", rationale: "La persistencia local permite reconstruir el mapa después de reiniciar el servicio.", diff: "@@ publishGraph\n+for (const node of input.nodes) {\n+  upsert.run(node);\n+}\n+touchRun(runId);" },
  { id: "graph-api", summary: "El servidor expone publicación inicial y nodos descubiertos.", rationale: "HTTP ofrece el mismo contrato a adaptadores con capacidades distintas.", diff: "@@ graph route\n+app.post('/api/runs/:runId/graph', publishGraph);\n+app.post('/api/runs/:runId/nodes', addDiscoveredNode);" },
]) {
  await api(`/api/runs/${run.id}/nodes/${completed.id}/start`, { method: "POST", body: "{}" });
  await api(`/api/runs/${run.id}/nodes/${completed.id}/patch`, { method: "POST", body: JSON.stringify({ summary: completed.summary, rationale: completed.rationale, diff: completed.diff }) });
  await api(`/api/runs/${run.id}/nodes/${completed.id}/verify`, { method: "POST", body: JSON.stringify({ command: "npm test", output: "3 tests passed", exitCode: 0 }) });
  await api(`/api/runs/${run.id}/nodes/${completed.id}/complete`, { method: "POST", body: "{}" });
}

await api(`/api/runs/${run.id}/nodes/graph-cli/start`, { method: "POST", body: "{}" });
await api(`/api/runs/${run.id}/nodes/graph-cli/patch`, {
  method: "POST",
  body: JSON.stringify({ summary: "El comando ya publica mapas JSON; falta completar su verificación integral.", rationale: "El CLI funciona como adaptador universal cuando no existe una integración nativa.", diff: "@@ cli commands\n+hrp graph publish <run-id> <graph.json>" }),
});
await api(`/api/runs/${run.id}/activity`, {
  method: "POST",
  body: JSON.stringify({ type: "inspect", nodeId: "inspector", message: "Se confirmó que el inspector necesita una vista de diff por operación", detail: "La evidencia de un archivo completo ocultaría la granularidad por símbolo." }),
});

console.log(`${url}/?project=${project.id}&run=${run.id}`);
