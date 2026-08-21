import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { findingSeverities, PROTOCOL_VERSION, type ChangeNode, type FindingSeverity } from "../shared/protocol.js";
import { auditableNodes } from "./attention.js";
import { HrpStore } from "./store.js";

// La respuesta de Ollama Cloud puede tardar minutos con paquetes grandes; el
// fetch global corta a ~300s (headersTimeout de undici), así que el servidor usa
// el cliente http de Node con un tope explícito de 30 minutos.
export function upstreamJson(target: string, headers: Record<string, string>, payload: string): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const parsed = new URL(target);
  const requestFn = parsed.protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const clientRequest = requestFn(parsed, {
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(payload)) },
      timeout: 1_800_000,
    }, (upstreamResponse) => {
      let raw = "";
      upstreamResponse.setEncoding("utf8");
      upstreamResponse.on("data", (chunk) => { raw += chunk; });
      upstreamResponse.on("end", () => {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* cuerpo no JSON: el status decide */ }
        resolve({ statusCode: upstreamResponse.statusCode ?? 500, body });
      });
    });
    clientRequest.on("timeout", () => clientRequest.destroy(new Error("Ollama no respondió en 30 minutos")));
    clientRequest.on("error", reject);
    clientRequest.end(payload);
  });
}

// Un fence más largo que cualquier racha de backticks del contenido: un diff
// que incluya ``` no cierra el bloque prematuramente ni corrompe el pack.
// ```json … ``` (o ``` … ```) alrededor de toda la respuesta: se devuelve el
// interior. Si no hay fence envolvente, el texto vuelve intacto.
function unwrapFence(answer: string): string {
  const match = /^`{3,}[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?`{3,}$/.exec(answer.trim());
  return match ? match[1].trim() : answer;
}

function fenceFor(content: string): string {
  const longestRun = content.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  return "`".repeat(Math.max(3, longestRun + 1));
}

// Paquete autocontenido para convertir a cualquier modelo en revisor: el humano
// lo copia a la otra sesión y esta obtiene todo el contexto del run con la
// evidencia por nodo, sin acceso previo al proyecto.
export function buildReviewPack(store: HrpStore, runId: string, nodeId?: string, nodeIds?: string[]): string {
  const detail = store.getRunDetail(runId);
  if (!detail) throw new Error(`Unknown run: ${runId}`);
  const byId = new Map(detail.nodes.map((node) => [node.id, node]));
  let scope = detail.nodes;
  if (nodeIds) {
    const unknown = nodeIds.filter((id) => !byId.has(id));
    if (unknown.length) throw new Error(`Unknown nodes: ${unknown.join(", ")}`);
    const keep = new Set(nodeIds);
    scope = detail.nodes.filter((node) => keep.has(node.id));
  } else if (nodeId) {
    if (!byId.has(nodeId)) throw new Error(`Unknown node: ${nodeId}`);
    const keep = new Set<string>();
    const visit = (id: string) => {
      if (keep.has(id)) return;
      keep.add(id);
      for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    };
    visit(nodeId);
    scope = detail.nodes.filter((node) => keep.has(node.id));
  }
  const lines: string[] = [
    `# Paquete de revisión HRP v${PROTOCOL_VERSION}`,
    "",
    `- Run: ${detail.run.id}`,
    `- Título: ${detail.run.title}`,
    `- Requisito: ${detail.run.requirement}`,
    `- Agente base: ${detail.run.baseAgent ?? "(sin registrar)"}`,
    "",
    "## Tu rol: modelo revisor",
    "",
    "Eres auditor de este run. Busca errores de integración entre nodos, contratos rotos,",
    "casos borde sin cubrir y desviaciones entre la spec aprobada y el diff aplicado.",
    "No edites código: tu salida son hallazgos y debate.",
    "",
    `- Reporta: \`hrp finding add ${detail.run.id} --title T --body B --severity critical|major|minor|question [--node ID] --reviewer TU_NOMBRE\``,
    "- Debate una respuesta del base: `hrp finding reply <finding-id> --body B --author TU_NOMBRE`",
    "- Si aceptas una corrección vinculada: `hrp finding agree <finding-id> --author TU_NOMBRE`",
    "- Reabre un cierre con evidencia: `hrp finding reopen <finding-id> --author TU_NOMBRE --body RAZON`",
    `- Si estás conforme, vota OK con \`hrp agent status ${detail.run.id} --agent TU_NOMBRE --phase completed --summary \"Auditoría terminada\" --completed N --total N --reviewed ID,ID --remaining \"\"\`; el gate cierra con mayoría simple de auditores.`,
    "- Si no encuentras nada, dilo explícitamente; no inventes hallazgos.",
    "",
    // El listado respeta el subárbol pedido: un pack limitado no expone nodos
    // ajenos, y el título avisa al revisor que existe grafo fuera de su alcance.
    nodeIds ? "## Grafo del alcance de auditoría (hay más nodos en el run, fuera de tu alcance)"
      : nodeId ? "## Grafo del subárbol (hay más nodos en el run, fuera de tu alcance)" : "## Grafo del run",
    "",
    ...scope.map((node) => `- ${node.id} [${node.status}] ${node.file} · ${node.symbol}${node.dependencies.length ? ` ← depende de: ${node.dependencies.join(", ")}` : ""}`),
  ];
  if (detail.findings.length > 0) {
    lines.push("", "## Hallazgos ya reportados (no los dupliques)", "");
    for (const finding of detail.findings) {
      const agreed = new Set(finding.agreements.map((agreement) => agreement.agent));
      const pending = finding.requiredAgreementAgents.filter((agent) => !agreed.has(agent));
      const agreementCount = finding.requiredAgreementAgents.length - pending.length;
      const consensus = `acuerdos ${agreementCount}/${finding.requiredAgreementAgents.length}${finding.unanimous ? " · unanimidad" : pending.length ? ` · faltan ${pending.join(", ")}` : ""}`;
      lines.push(`- [${finding.status}/${finding.severity}] ${finding.title} (${finding.reviewer}${finding.nodeId ? ` · nodo ${finding.nodeId}` : ""} · ${consensus})`);
    }
  }
  const completed = scope.filter((node): node is ChangeNode & { diff: string } => node.status === "completed" && Boolean(node.diff));
  for (const node of completed) {
    const diffFence = fenceFor(node.diff);
    lines.push(
      "",
      `## Nodo ${node.id}: ${node.title}`,
      "",
      `- Archivo: ${node.file} · ${node.symbol}`,
      `- Spec aprobada: ${node.description}`,
      `- Resumen del parche: ${node.patchSummary ?? "(sin resumen)"}`,
      "",
      `${diffFence}diff`,
      node.diff,
      diffFence,
    );
    if (node.verification) {
      const output = node.verification.output.slice(0, 2000);
      const outputFence = fenceFor(output);
      lines.push(
        "",
        `Verificación (exit ${node.verification.exitCode}, ${node.verification.passed ? "pasó" : "falló"}): \`${node.verification.command}\``,
        "",
        outputFence,
        output,
        outputFence,
      );
    }
  }
  return lines.join("\n");
}

// El candado registra el desenlace, no solo el intento: { state, startedAt,
// done }. Un proceso que muere con la auditoría en vuelo deja done: false y el
// siguiente disparo (o el rescate del arranque) puede reintentarla.
export type AutoReviewMarker = { state: string; startedAt: string; done: boolean };

// Parseo defensivo: un marcador podrido (JSON inválido, primitivo inesperado)
// nunca lanza — se trata como cerrado o se descarta, para que el rescate del
// arranque y el hook sigan funcionando para los demás runs.
function parseMarker(raw: string): AutoReviewMarker | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  // Compatibilidad con el formato viejo (string de estado): aquellas auditorías
  // terminaron o se perdieron antes de este cambio; se tratan como cerradas.
  if (typeof parsed === "string") return { state: parsed, startedAt: "", done: true };
  if (parsed && typeof parsed === "object" && typeof (parsed as AutoReviewMarker).state === "string") {
    const candidate = parsed as AutoReviewMarker;
    return { state: candidate.state, startedAt: typeof candidate.startedAt === "string" ? candidate.startedAt : "", done: Boolean(candidate.done) };
  }
  return undefined;
}

export function autoReviewMarker(store: HrpStore, runId: string): AutoReviewMarker | undefined {
  const row = store.database.prepare("SELECT value_json FROM settings WHERE key = ?").get(`autoReview:${runId}`) as { value_json?: string } | undefined;
  if (!row?.value_json) return undefined;
  const marker = parseMarker(row.value_json);
  // Marcador podrido: tratarlo como cerrado evita bucles; el estado distinto de
  // cualquier real permite que un cambio futuro re-audite con normalidad.
  return marker ?? { state: "<corrupto>", startedAt: "", done: true };
}

function setAutoReviewMarker(store: HrpStore, runId: string, marker: AutoReviewMarker): void {
  store.database.prepare(`
    INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(`autoReview:${runId}`, JSON.stringify(marker), new Date().toISOString());
}

// Ejecuciones cuyo marcador quedó pendiente: candidatas al rescate del arranque.
export function pendingAuditRunIds(store: HrpStore): string[] {
  const rows = store.database.prepare("SELECT key, value_json FROM settings WHERE key LIKE 'autoReview:%'").all() as Array<{ key: string; value_json: string }>;
  const result: string[] = [];
  for (const row of rows) {
    const marker = parseMarker(row.value_json);
    if (marker && !marker.done) result.push(row.key.slice("autoReview:".length));
  }
  return result;
}

// Auditorías en vuelo de ESTE proceso: dos completes simultáneos no disparan doble.
const inFlightAudits = new Set<string>();
const RETRY_AFTER_MS = 45 * 60 * 1000;

// Auditoría automática (política v3.1): al completarse el run, el servidor pide
// la revisión al modelo de ollama sin intervención humana ni del base. Nunca
// propaga excepciones: todo desenlace queda como actividad del run.
export async function runAutoReview(store: HrpStore, runId: string, options: { force?: boolean; onProgress?: () => void } = {}): Promise<{ created: number } | undefined> {
  if (inFlightAudits.has(runId)) return undefined;
  inFlightAudits.add(runId);
  const finish = (marker: AutoReviewMarker) => setAutoReviewMarker(store, runId, { ...marker, done: true });
  let marker: AutoReviewMarker | undefined;
  try {
    const settings = store.getOllamaSettings();
    const detail = store.getRunDetail(runId);
    if (!detail) return undefined;
    // La selección es por ejecución: configurar Ollama no lo convierte en
    // auditor global ni dispara trabajo que el humano no eligió.
    if (!detail.run.auditors.includes("ollama")) return undefined;
    const coveredNodeIds = auditableNodes(detail, "ollama").filter((node) => node.status === "completed").map((node) => node.id);
    const auditStartedAt = new Date().toISOString();
    const publishProgress = (
      phase: "waiting" | "reviewing" | "completed" | "failed",
      summary: string,
      update: { detail?: string; completed?: number; reviewedNodeIds?: string[]; remainingNodeIds?: string[] } = {},
    ) => {
      store.setAgentState(runId, {
        agent: "ollama",
        phase,
        summary,
        detail: update.detail,
        completed: update.completed ?? 0,
        total: coveredNodeIds.length,
        reviewedNodeIds: update.reviewedNodeIds ?? [],
        remainingNodeIds: update.remainingNodeIds ?? coveredNodeIds,
        startedAt: auditStartedAt,
      });
      options.onProgress?.();
    };
    const state = detail.nodes.filter((node) => node.status === "completed").map((node) => node.id).sort().join(",");
    const previous = autoReviewMarker(store, runId);
    if (previous && previous.state === state) {
      if (previous.done) return undefined;
      // Pendiente del mismo estado: otro proceso la tenía en vuelo. Se reintenta
      // solo si aquella quedó vieja, o cuando el rescate del arranque fuerza
      // (al arrancar es seguro que ninguna auditoría previa sigue viva).
      if (!options.force && Date.now() - Date.parse(previous.startedAt) < RETRY_AFTER_MS) return undefined;
    }
    marker = { state, startedAt: new Date().toISOString(), done: false };
    setAutoReviewMarker(store, runId, marker);
    // Una omisión no puede ser silenciosa: registra un hallazgo bloqueante de
    // reviewer "hrp" para que el gate impida cerrar el run sin auditoría real.
    // Devuelve cuántos hallazgos registró para que el llamador emita el SSE: un
    // hallazgo que bloquea el cierre debe despertar al panel y al wait del base.
    const blockingOmission = (title: string, body: string): number => {
      const already = store.listFindings(runId).some((finding) => finding.title === title && ["open", "debating", "escalated"].includes(finding.status));
      if (already) return 0;
      store.createFinding(runId, { reviewer: "hrp", severity: "major", title, body });
      return 1;
    };
    if (coveredNodeIds.length === 0) {
      store.addActivity(runId, "note", "Auditoría sin alcance para ollama: no hay operaciones ajenas que revisar", undefined, undefined, "ollama");
      publishProgress("completed", "Auditoría terminada sin alcance", {
        detail: "Ollama coincide con el agente que ejecutó las operaciones completadas; HRP no envió sus propios diffs como auditoría.",
        completed: 0,
        reviewedNodeIds: [],
        remainingNodeIds: [],
      });
      finish(marker);
      return { created: 0 };
    }
    if (!settings.apiKey) {
      store.addActivity(runId, "note", "Auditoría automática omitida: ollama no está configurado", undefined, undefined, "ollama");
      publishProgress("failed", "No se pudo iniciar la auditoría", { detail: "Falta configurar la API key de Ollama Cloud." });
      finish(marker);
      return undefined;
    }
    const pack = buildReviewPack(store, runId, undefined, coveredNodeIds);
    if (pack.length > 200_000) {
      store.addActivity(runId, "note", "Auditoría automática omitida: el paquete excede 200KB; audita por subárbol con 'hrp ollama review --node'", undefined, undefined, "ollama");
      publishProgress("failed", "El paquete excede el límite de Ollama", { detail: "Divide la auditoría por subárboles para cubrir el grafo completo." });
      const created = blockingOmission(
        "Auditoría pendiente: el paquete excede 200KB",
        "La auditoría automática no puede enviar el run completo. Audita por subárboles con 'hrp ollama review <run-id> --node <nodo-hoja>' hasta cubrir el grafo y resuelve este hallazgo citando esas pasadas.",
      );
      finish(marker);
      return { created };
    }
    const prompt = [
      "Eres un modelo revisor de código dentro del protocolo HRP. Audita el paquete de revisión que sigue.",
      "Busca únicamente problemas reales y verificables en los diffs aplicados: errores de integración entre nodos, contratos rotos, desviaciones respecto a la spec aprobada y casos borde sin cubrir.",
      "Si el paquete no incluye algo que necesitas para afirmar un problema, NO lo supongas: responde únicamente una línea que empiece con 'NECESITO: ' describiendo qué falta.",
      `Responde ÚNICAMENTE con un arreglo JSON, sin explicaciones, sin markdown y sin fences: cada elemento es {"severity":"critical|major|minor|question","title":"...","body":"...","node":"id-del-nodo"} y "node" es opcional.`,
      "Si no encuentras ningún problema real, responde exactamente el literal SIN-HALLAZGOS.",
      "No inventes hallazgos para rellenar: SIN-HALLAZGOS es una respuesta válida y valiosa.",
      "",
      pack,
    ].join("\n");
    publishProgress("reviewing", `Esperando a ${settings.model}`, {
      detail: `Paquete enviado con ${coveredNodeIds.length} ${coveredNodeIds.length === 1 ? "operación" : "operaciones"}. HRP confirmará la cobertura cuando el modelo responda.`,
    });
    store.addActivity(runId, "note", `Auditoría automática iniciada (${settings.model}) · ${coveredNodeIds.length} operaciones en el paquete`, undefined, undefined, "ollama");
    const upstream = await upstreamJson(
      `${settings.baseUrl}/api/chat`,
      { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
      JSON.stringify({
        model: settings.model,
        stream: false,
        options: { temperature: 0 },
        messages: [{ role: "user", content: prompt }],
      }),
    );
    const body = upstream.body as { model?: string; message?: { content?: string }; error?: string; prompt_eval_count?: number; eval_count?: number };
    if (upstream.statusCode >= 400) throw new Error(`Ollama respondió ${upstream.statusCode}: ${body.error ?? "error upstream"}`);
    const model = body.model ?? settings.model;
    const tokens = body.prompt_eval_count != null || body.eval_count != null
      ? ` · ${body.prompt_eval_count ?? "?"} prompt + ${body.eval_count ?? "?"} respuesta tokens` : "";
    store.addActivity(runId, "note", `Consulta a ollama (${model}) · auditoría automática${tokens}`, undefined, undefined, "ollama");
    publishProgress("reviewing", `Procesando la respuesta de ${model}`, {
      detail: "La respuesta llegó; HRP está validando el formato y registrando los hallazgos.",
    });
    // El prompt prohíbe los fences, pero la costumbre de los modelos pesa más
    // que la instrucción: se desenvuelve el bloque antes de interpretar, sin
    // relajar lo que se acepta como contenido.
    const answer = unwrapFence(String(body.message?.content ?? "").trim());
    if (answer.startsWith("NECESITO:")) {
      store.addActivity(runId, "note", `Auditoría automática detenida — ${answer.split("\n")[0]}`, undefined, undefined, "ollama");
      publishProgress("failed", `${model} pidió más contexto`, { detail: answer.split("\n")[0] });
      finish(marker);
      return undefined;
    }
    if (answer === "SIN-HALLAZGOS") {
      store.addActivity(runId, "note", `Auditoría automática (${model}): sin hallazgos`, undefined, undefined, "ollama");
      publishProgress("completed", `Auditoría terminada por ${model}`, {
        detail: "El modelo cubrió el paquete completo y no reportó problemas reales.",
        completed: coveredNodeIds.length,
        reviewedNodeIds: coveredNodeIds,
        remainingNodeIds: [],
      });
      finish(marker);
      return { created: 0 };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(answer); } catch {
      throw new Error(`la respuesta del revisor no es JSON ni SIN-HALLAZGOS: ${answer.slice(0, 160)}`);
    }
    if (!Array.isArray(parsed)) throw new Error("la respuesta del revisor no es un arreglo");
    // Todo-o-nada: el lote completo se valida antes de registrar el primero.
    const allNodeIds = new Set(detail.nodes.map((node) => node.id));
    const validNodes = new Set(coveredNodeIds);
    for (const item of parsed as Array<{ severity?: string; title?: string; body?: string; node?: string }>) {
      if (!item || typeof item.title !== "string" || !item.title || typeof item.body !== "string" || !item.body || !findingSeverities.includes(item.severity as FindingSeverity)) {
        throw new Error(`hallazgo con formato inválido: ${JSON.stringify(item).slice(0, 160)}`);
      }
    }
    // El registro del lote va en una transacción: un fallo de DB a mitad no
    // deja un subconjunto parcial de los hallazgos de la auditoría.
    let created = 0;
    store.database.transaction(() => {
      for (const item of parsed as Array<{ severity: FindingSeverity; title: string; body: string; node?: string }>) {
        const nodeInScope = item.node ? validNodes.has(item.node) : false;
        const findingBody = item.node && !nodeInScope
          ? allNodeIds.has(item.node)
            ? `${item.body}\n(El revisor refirió el nodo "${item.node}", que existe en el run pero queda fuera del alcance auditable de ollama.)`
            : `${item.body}\n(El revisor refirió el nodo "${item.node}", que no existe en el run.)`
          : item.body;
        store.createFinding(runId, {
          reviewer: `ollama:${model}`,
          severity: item.severity,
          title: item.title,
          body: findingBody,
          nodeId: nodeInScope ? item.node : undefined,
        });
        created += 1;
      }
      store.addActivity(runId, "note", `Auditoría automática (${model}): ${created} ${created === 1 ? "hallazgo registrado" : "hallazgos registrados"}`, undefined, undefined, "ollama");
    })();
    publishProgress("completed", `Auditoría terminada por ${model}`, {
      detail: `${created} ${created === 1 ? "hallazgo registrado" : "hallazgos registrados"}.`,
      completed: coveredNodeIds.length,
      reviewedNodeIds: coveredNodeIds,
      remainingNodeIds: [],
    });
    finish(marker);
    return { created };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      store.addActivity(runId, "note", `Auditoría automática falló: ${message}`, undefined, undefined, "ollama");
      if (store.getRun(runId)?.auditors.includes("ollama")) {
        const failedDetail = store.getRunDetail(runId);
        const remaining = failedDetail ? auditableNodes(failedDetail, "ollama").filter((node) => node.status === "completed").map((node) => node.id) : [];
        store.setAgentState(runId, {
          agent: "ollama",
          phase: "failed",
          summary: "La auditoría automática falló",
          detail: message,
          completed: 0,
          total: remaining.length,
          reviewedNodeIds: [],
          remainingNodeIds: remaining,
          startedAt: marker?.startedAt,
        });
        options.onProgress?.();
      }
      // Un fallo anotado es un desenlace conocido: el humano o el base pueden
      // relanzar manualmente; el rescate no debe repetirla en bucle.
      if (marker) finish(marker);
    } catch { /* run borrado: nada que anotar */ }
    return undefined;
  } finally {
    inFlightAudits.delete(runId);
  }
}
