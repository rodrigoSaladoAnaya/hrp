import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { activityTypes, agentWorkPhases, findingScopes, findingSeverities, findingStatuses, isValidAgentId, nodeDifficulties, PROTOCOL_VERSION, runControls, type RunDetail } from "../shared/protocol.js";
import { attentionRank, auditableNodes, computeAttention, type Attention } from "./attention.js";
import { buildPlanReviewPack, buildReviewPack, runAutoReview, runPlanReview, upstreamJson } from "./review.js";
import { HrpStore } from "./store.js";

// Identidad escrita a mano por el humano en el panel. Una errata crea un
// agente fantasma al que se le asignan nodos que nadie ejecutará, así que se
// rechaza aquí en vez de dejarla entrar al censo de la ejecución.
const agentId = z.string().trim().superRefine((agent, ctx) => {
  if (isValidAgentId(agent)) return;
  ctx.addIssue({
    code: "custom",
    message: `Identidad de agente inválida: ${JSON.stringify(agent)}. Usa 'familia' o 'familia:sesion' (letras, dígitos, punto, guion o guion bajo), por ejemplo claude o claude:opus.`,
  });
});

const nodeInput = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  file: z.string().min(1),
  symbol: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  rationale: z.string().min(1),
  dependencies: z.array(z.string()),
  discovered: z.boolean().optional(),
  // Recomendación del modelo base sobre quién debería implementar el nodo
  // (p. ej. "ollama" para trabajo mecánico); el humano decide al aprobar.
  suggestedAgent: z.string().min(1).optional(),
  // Dificultad declarada: con ella el enrutado elige el modelo delegado.
  difficulty: z.enum(nodeDifficulties).optional(),
  // Archivos de solo lectura que 'hrp ollama exec' adjunta como referencia al delegar.
  contextFiles: z.array(z.string().min(1)).optional(),
}).strict();

function buildFiles(target: string): string[] {
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const child = path.join(target, entry.name);
      return entry.isDirectory() ? buildFiles(child) : [child];
    });
}

function artifactBuildId(target: string) {
  try {
    const hash = createHash("sha256");
    for (const file of buildFiles(target)) {
      hash.update(path.relative(target, file));
      hash.update("\0");
      hash.update(readFileSync(file));
      hash.update("\0");
    }
    return hash.digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

function defaultBuildTarget() {
  const moduleFile = fileURLToPath(import.meta.url);
  const marker = `${path.sep}dist${path.sep}server${path.sep}`;
  const markerIndex = moduleFile.lastIndexOf(marker);
  return markerIndex === -1 ? moduleFile : moduleFile.slice(0, markerIndex + `${path.sep}dist`.length);
}

export function createBuildIdentity(target = defaultBuildTarget()) {
  const buildId = artifactBuildId(target);
  return () => {
    const currentBuildId = artifactBuildId(target);
    return {
      buildId: buildId ?? null,
      currentBuildId: currentBuildId ?? null,
      buildStale: Boolean(buildId && buildId !== currentBuildId),
    };
  };
}

const readBuildIdentity = createBuildIdentity();

// El store guarda el workspace ya canonicalizado (realpath), y el cwd que
// entrega un hook suele atravesar un enlace simbólico: en macOS /tmp apunta a
// /private/tmp. Comparar rutas sin canonicalizar dejaba mudo al despertador
// justo donde debía avisar.
function canonicalPath(target: string): string {
  const resolved = path.resolve(target);
  try { return realpathSync(resolved); } catch { return resolved; }
}

export function createApp(store: HrpStore) {
  const app = express();
  const events = new EventEmitter();
  events.setMaxListeners(100);

  app.use(cors());
  app.use(express.json({ limit: "8mb" }));

  const broadcast = (projectId: string, runId: string, type: string) => {
    events.emit("change", { projectId, runId, type, observedAt: new Date().toISOString() });
  };

  const projectForRun = (runId: string) => {
    const run = store.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    return run.projectId;
  };

  // El pid viaja en health porque es la única identidad del demonio que el CLI
  // puede obtener sin haberlo arrancado él: sin esto, un servicio cuyo pidfile
  // se perdió queda fuera del alcance de 'hrp service stop'.
  app.get("/api/health", (_request, response) => response.json({
    ok: true,
    product: "hrp",
    protocolVersion: PROTOCOL_VERSION,
    pid: process.pid,
    ...readBuildIdentity(),
  }));

  // La configuración viaja siempre enmascarada hacia los clientes; la key
  // completa solo se recibe en el PUT y queda en el almacén del servicio.
  app.get("/api/settings/ollama", (_request, response) => response.json(store.getOllamaSettingsView()));

  app.put("/api/settings/ollama", (request, response, next) => {
    try {
      const input = z.object({
        apiKey: z.string().min(1).nullable().optional(),
        model: z.string().min(1).optional(),
        baseUrl: z.url().optional(),
        // Modelo delegado por dificultad. La cadena vacía borra ese nivel para
        // que vuelva a heredar el modelo por defecto.
        // partialRecord, no record: en zod 4 una clave de enum exige el registro
        // completo, y aquí cada nivel es opcional e independiente.
        tiers: z.partialRecord(z.enum(nodeDifficulties), z.string()).optional(),
      }).strict().parse(request.body ?? {});
      response.json(store.setOllamaSettings(input));
    } catch (error) { next(error); }
  });

  app.get("/api/settings/ui", (_request, response) => response.json(store.getUiPreferences()));

  app.put("/api/settings/ui", (request, response, next) => {
    try {
      const input = z.object({
        viewShortcuts: z.object({
          enabled: z.boolean().optional(),
          modifier: z.enum(["meta", "ctrl", "either"]).optional(),
        }).strict().optional(),
      }).strict().parse(request.body ?? {});
      response.json(store.setUiPreferences(input));
    } catch (error) { next(error); }
  });

  // Proxy hacia Ollama Cloud: los agentes delegan sin conocer la key, que
  // se adjunta aquí como Bearer y nunca sale del servicio hacia los clientes.
  app.post("/api/ollama/chat", async (request, response, next) => {
    try {
      const input = z.object({
        prompt: z.string().min(1),
        system: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        // Contexto opcional de auditoría: liga la consulta a una ejecución y
        // nodo para que el humano vea en Actividad qué corrió ollama y cuánto costó.
        runId: z.string().min(1).optional(),
        nodeId: z.string().min(1).optional(),
      }).strict().parse(request.body);
      const settings = store.getOllamaSettings();
      if (!settings.apiKey) throw new Error("Ollama no está configurado: guarda la API key desde el panel o con 'hrp ollama config --api-key ...'");
      const model = input.model ?? settings.model;
      const upstream = await upstreamJson(
        `${settings.baseUrl}/api/chat`,
        { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
        JSON.stringify({
          model,
          stream: false,
          // Trabajo mecánico delegado: determinismo antes que creatividad.
          options: { temperature: 0 },
          messages: [
            ...(input.system ? [{ role: "system", content: input.system }] : []),
            { role: "user", content: input.prompt },
          ],
        }),
      );
      const body = upstream.body as {
        model?: string; message?: { content?: string }; error?: string;
        prompt_eval_count?: number; eval_count?: number;
      };
      if (upstream.statusCode >= 400) throw new Error(`Ollama respondió ${upstream.statusCode}: ${body.error ?? "error upstream"}`);
      if (input.runId && store.getRun(input.runId)) {
        try {
          const tokens = body.prompt_eval_count != null || body.eval_count != null
            ? ` · ${body.prompt_eval_count ?? "?"} prompt + ${body.eval_count ?? "?"} respuesta tokens` : "";
          store.addActivity(input.runId, "note", `Consulta a ollama (${body.model ?? model})${tokens}`, undefined, input.nodeId, "ollama");
          broadcast(store.getRun(input.runId)!.projectId, input.runId, "activity-published");
        } catch { /* la auditoría nunca debe tumbar la consulta */ }
      }
      response.json({
        model: body.model ?? model,
        content: body.message?.content ?? "",
        promptTokens: body.prompt_eval_count,
        completionTokens: body.eval_count,
      });
    } catch (error) { next(error); }
  });

  app.get("/api/projects", (_request, response) => {
    const projects = store.listProjects().map((project) => ({ ...project, runs: store.listRuns(project.id) }));
    response.json({ projects });
  });

  app.post("/api/projects", (request, response, next) => {
    try {
      const { workspaceRoot } = z.object({ workspaceRoot: z.string().min(1) }).strict().parse(request.body);
      const project = store.attachProject(workspaceRoot);
      broadcast(project.id, "", "project-attached");
      response.status(201).json(project);
    } catch (error) { next(error); }
  });

  app.delete("/api/projects/:projectId", (request, response) => {
    const deleted = store.deleteProject(request.params.projectId);
    if (deleted) broadcast(request.params.projectId, "", "project-deleted");
    response.status(deleted ? 204 : 404).end();
  });

  // Censo de sesiones acuñadas del proyecto: el árbol del dock lo carga al
  // abrir y acuña desde él, para que el humano no teclee identidades.
  app.get("/api/projects/:projectId/sessions", (request, response) => {
    if (!store.getProject(request.params.projectId)) return response.status(404).json({ error: `Unknown project: ${request.params.projectId}` });
    response.json({ sessions: store.listProjectSessions(request.params.projectId) });
  });

  app.post("/api/projects/:projectId/sessions", (request, response, next) => {
    try {
      if (!store.getProject(request.params.projectId)) return response.status(404).json({ error: `Unknown project: ${request.params.projectId}` });
      const input = z.object({ family: agentId }).strict().parse(request.body);
      const agent = store.mintProjectSession(request.params.projectId, input.family);
      broadcast(request.params.projectId, "", "session-minted");
      response.status(201).json({ agent, sessions: store.listProjectSessions(request.params.projectId) });
    } catch (error) { next(error); }
  });

  app.delete("/api/projects/:projectId/sessions/:agent", (request, response, next) => {
    try {
      if (!store.getProject(request.params.projectId)) return response.status(404).json({ error: `Unknown project: ${request.params.projectId}` });
      // El store decide si la identidad puede retirarse; su mensaje es el que
      // el panel enseña, así que se deja pasar tal cual como error 400.
      const agent = agentId.parse(request.params.agent);
      const sessions = store.retireProjectSession(request.params.projectId, agent);
      broadcast(request.params.projectId, "", "session-retired");
      response.json({ sessions });
    } catch (error) { next(error); }
  });

  app.get("/api/projects/:projectId/runs", (request, response) => response.json({ runs: store.listRuns(request.params.projectId) }));

  app.post("/api/projects/:projectId/runs", (request, response, next) => {
    try {
      const input = z.object({ title: z.string().min(1), requirement: z.string().min(1), agent: z.string().min(1).optional() }).strict().parse(request.body);
      const run = store.createRun(request.params.projectId, input.title, input.requirement, input.agent);
      broadcast(run.projectId, run.id, "run-created");
      response.status(201).json(run);
    } catch (error) { next(error); }
  });

  app.delete("/api/runs/:runId", (request, response) => {
    const run = store.getRun(request.params.runId);
    const deleted = store.deleteRun(request.params.runId);
    if (deleted && run) broadcast(run.projectId, run.id, "run-deleted");
    response.status(deleted ? 204 : 404).end();
  });

  app.get("/api/runs/:runId", (request, response) => {
    const detail = store.getRunDetail(request.params.runId);
    if (!detail) response.status(404).json({ error: "Run not found" });
    else response.json(detail);
  });

  app.post("/api/runs/:runId/graph", (request, response, next) => {
    try {
      const input = z.object({ nodes: z.array(nodeInput).min(1), agent: z.string().min(1).optional() }).strict().parse(request.body);
      const run = store.getRun(request.params.runId);
      if (!run) throw new Error(`Unknown run: ${request.params.runId}`);
      if (!run.baseAgent && !input.agent) {
        throw new Error("Publishing the initial graph requires agent to establish the base model");
      }
      const nodes = store.publishGraph(request.params.runId, { nodes: input.nodes }, input.agent);
      broadcast(projectForRun(request.params.runId), request.params.runId, "graph-published");
      // Auditoría del plan: corre en segundo plano para que publicar el grafo
      // no espere al revisor, y su fallo nunca invalida la publicación. Sus
      // hallazgos llegan al humano antes de que apruebe, no después.
      void runPlanReview(store, request.params.runId, {
        onProgress: () => broadcast(projectForRun(request.params.runId), request.params.runId, "agent-status"),
      }).then((result) => {
        if (result && result.created > 0) broadcast(projectForRun(request.params.runId), request.params.runId, "finding-created");
      });
      response.status(201).json({ nodes });
    } catch (error) { next(error); }
  });

  app.post("/api/runs/:runId/nodes", (request, response, next) => {
    try {
      // La identidad viaja aparte de la spec del nodo: es quien descubre, no
      // parte de lo que el humano aprobó. Sin ella el descubierto sigue
      // cayendo en el modelo base, como antes.
      const { agent, ...body } = z.object({ agent: agentId.optional() }).loose().parse(request.body ?? {});
      const input = nodeInput.parse({ ...body, discovered: true });
      const node = store.addDiscoveredNode(request.params.runId, input, agent);
      broadcast(projectForRun(request.params.runId), request.params.runId, "node-discovered");
      response.status(201).json(node);
    } catch (error) { next(error); }
  });

  app.post("/api/runs/:runId/control", (request, response, next) => {
    try {
      const input = z.object({ control: z.enum(runControls) }).strict().parse(request.body);
      const run = store.setRunControl(request.params.runId, input.control);
      broadcast(run.projectId, run.id, "run-control");
      response.json(run);
    } catch (error) { next(error); }
  });

  app.post("/api/runs/:runId/agents", (request, response, next) => {
    try {
      const input = z.object({ agent: z.string().min(1) }).strict().parse(request.body);
      const run = store.helloAgent(request.params.runId, input.agent);
      broadcast(run.projectId, run.id, "agent-seen");
      response.json(run);
    } catch (error) { next(error); }
  });

  app.post("/api/runs/:runId/agents/:agent/attention/release", (request, response, next) => {
    try {
      const state = store.releaseAttention(request.params.runId, request.params.agent);
      const run = store.getRun(request.params.runId)!;
      broadcast(run.projectId, run.id, "attention-released");
      response.json(state);
    } catch (error) { next(error); }
  });

  app.put("/api/runs/:runId/auditors", (request, response, next) => {
    try {
      const input = z.object({ auditors: z.array(agentId).max(16) }).strict().parse(request.body);
      const run = store.setRunAuditors(request.params.runId, input.auditors);
      broadcast(run.projectId, run.id, "auditors-selected");
      response.json(run);
    } catch (error) { next(error); }
  });

  // Adaptador neutral para que cualquier agente publique una fase observable
  // sin exponer cadena de pensamiento. Los nodos ejecutados ya actualizan este
  // estado automáticamente; la ruta cubre auditorías y herramientas externas.
  app.put("/api/runs/:runId/agents/:agent/status", (request, response, next) => {
    try {
      const input = z.object({
        phase: z.enum(agentWorkPhases),
        summary: z.string().min(1),
        detail: z.string().optional(),
        currentNodeId: z.string().min(1).optional(),
        completed: z.number().int().nonnegative().optional(),
        total: z.number().int().nonnegative().optional(),
        reviewedNodeIds: z.array(z.string()).optional(),
        remainingNodeIds: z.array(z.string()).optional(),
        startedAt: z.iso.datetime().optional(),
      }).strict().parse(request.body);
      const run = store.helloAgent(request.params.runId, request.params.agent);
      const detail = store.getRunDetail(request.params.runId)!;
      const previous = detail.agentStates.find((state) => state.agent === request.params.agent);
      const startedAt = input.startedAt ?? (input.phase === "reviewing"
        ? (previous?.phase === "reviewing" ? previous.startedAt : undefined) ?? new Date().toISOString()
        : input.phase === "completed" ? previous?.startedAt : undefined);
      // Un campo ausente no declara cobertura cero: la que cuenta es la
      // efectiva, ya fusionada con lo que el agente publicó antes.
      const coverage = {
        completed: input.completed ?? previous?.completed ?? 0,
        total: input.total ?? previous?.total ?? 0,
        reviewedNodeIds: input.reviewedNodeIds ?? previous?.reviewedNodeIds ?? [],
        remainingNodeIds: input.remainingNodeIds ?? previous?.remainingNodeIds ?? [],
      };
      if (run.auditors.includes(request.params.agent) && input.phase === "completed") {
        // La cobertura exigida es la del trabajo ajeno: el contrato prohíbe al
        // auditor revisar sus propios nodos, así que pedírselos volvía
        // imposible el cierre para quien implementa y audita en el mismo run.
        const auditable = auditableNodes(detail, request.params.agent);
        const expected = new Set(auditable.map((node) => node.id));
        const propios = detail.nodes.length - expected.size;
        const reviewed = new Set(coverage.reviewedNodeIds);
        const unreviewed = [...expected].filter((nodeId) => !reviewed.has(nodeId));
        const stillRemaining = coverage.remainingNodeIds.filter((nodeId) => expected.has(nodeId));
        const gaps = [
          unreviewed.length ? `unreviewed nodes: ${unreviewed.join(", ")}` : "",
          stillRemaining.length ? `still marked remaining: ${stillRemaining.join(", ")}` : "",
          coverage.completed !== expected.size ? `completed is ${coverage.completed}, expected ${expected.size}` : "",
          coverage.total !== expected.size ? `total is ${coverage.total}, expected ${expected.size}` : "",
        ].filter(Boolean);
        if (gaps.length) {
          throw new Error(`An auditor can only complete with full coverage of the ${expected.size} nodes authored by others${propios ? ` (its own ${propios} are excluded)` : ""} (${gaps.join("; ")})`);
        }
        if (!startedAt || auditable.some((node) => node.updatedAt > startedAt)) {
          throw new Error("Auditor coverage predates the latest node change; publish phase reviewing again before completion");
        }
        // Un auditor que implementó todo no revisó nada: el cierre se acepta
        // para no bloquear el run, pero el humano debe verlo escrito.
        if (!expected.size) {
          store.addActivity(request.params.runId, "note", `Auditoría sin alcance: ${request.params.agent} implementó todos los nodos y no tenía trabajo ajeno que revisar`, "Elige otro auditor si esta ejecución necesita una revisión independiente.", undefined, request.params.agent);
        }
      }
      const state = store.setAgentState(request.params.runId, {
        agent: request.params.agent,
        ...input,
        ...coverage,
        startedAt,
      });
      broadcast(run.projectId, run.id, "agent-status");
      response.json(state);
    } catch (error) { next(error); }
  });

  app.post("/api/runs/:runId/approve", (request, response, next) => {
    try {
      // force queda aceptado por compatibilidad con clientes antiguos; aprobar
      // ya no espera la auditoría del plan.
      const input = z.object({ nodeIds: z.array(z.string()).min(1).optional(), force: z.boolean().optional() }).strict().parse(request.body ?? {});
      const nodes = store.approveNodes(request.params.runId, input.nodeIds);
      broadcast(projectForRun(request.params.runId), request.params.runId, "graph-approved");
      response.json({ nodes });
    } catch (error) { next(error); }
  });

  app.post("/api/runs/:runId/nodes/:nodeId/assign", (request, response, next) => {
    try {
      const input = z.object({ assignee: agentId.nullable() }).strict().parse(request.body);
      const node = store.assignNode(request.params.runId, request.params.nodeId, input.assignee);
      // Una sola señal basta: ni el long-poll de /api/attention ni el cliente
      // de /api/events miran el tipo del evento —el primero reevalúa con
      // cualquier cambio y el segundo sólo distingue 'run-created'—, así que
      // distinguir la recuperación aquí no cambiaba comportamiento y costaba un
      // getRunDetail completo (nodos, actividad y hallazgos) en cada asignación.
      broadcast(projectForRun(request.params.runId), request.params.runId, "node-assigned");
      response.json(node);
    } catch (error) { next(error); }
  });

  // La asignación por lote existe por el conteo de eventos: doce nodos por la
  // ruta de uno en uno serían doce peticiones y doce broadcasts, y el panel
  // recargaría el detalle completo de la ejecución doce veces. Aquí es una
  // petición y, si algo cambió, un solo evento.
  app.post("/api/runs/:runId/assign", (request, response, next) => {
    try {
      const input = z.object({ nodeIds: z.array(z.string().min(1)).min(1), assignee: agentId.nullable() }).strict().parse(request.body);
      const result = store.assignNodes(request.params.runId, input.nodeIds, input.assignee);
      if (result.assigned.length) broadcast(projectForRun(request.params.runId), request.params.runId, "node-assigned");
      response.json(result);
    } catch (error) { next(error); }
  });

  app.post("/api/runs/:runId/nodes/:nodeId/start", (request, response, next) => {
    try {
      const input = z.object({ agent: z.string().min(1).optional() }).strict().parse(request.body ?? {});
      const node = store.startNode(request.params.runId, request.params.nodeId, input.agent);
      broadcast(projectForRun(request.params.runId), request.params.runId, "node-started");
      response.json(node);
    } catch (error) { next(error); }
  });

  app.post("/api/runs/:runId/nodes/:nodeId/patch", (request, response, next) => {
    try {
      const input = z.object({ summary: z.string().min(1), rationale: z.string().min(1).optional(), diff: z.string().min(1) }).strict().parse(request.body);
      const node = store.publishPatch(request.params.runId, request.params.nodeId, input.summary, input.diff, input.rationale);
      broadcast(projectForRun(request.params.runId), request.params.runId, "patch-published");
      response.status(201).json(node);
    } catch (error) { next(error); }
  });

  app.post("/api/runs/:runId/nodes/:nodeId/verify", (request, response, next) => {
    try {
      const input = z.object({ command: z.string().min(1), output: z.string(), exitCode: z.number().int() }).strict().parse(request.body);
      const node = store.publishVerification(request.params.runId, request.params.nodeId, input);
      broadcast(projectForRun(request.params.runId), request.params.runId, "verification-published");
      response.status(201).json(node);
    } catch (error) { next(error); }
  });

  app.post("/api/runs/:runId/nodes/:nodeId/complete", (request, response, next) => {
    try {
      const input = z.object({ tokens: z.number().int().positive().optional() }).strict().parse(request.body ?? {});
      const node = store.completeNode(request.params.runId, request.params.nodeId, input.tokens);
      // El evento se emite más abajo, cuando el estado ya está asentado: un
      // long-poll de /api/attention despertado aquí vería todos los nodos
      // completos y a los auditores aún con la cobertura de la pasada anterior,
      // y concluiría que la ejecución terminó cuando falta la revisión.
      // Política v3.1: terminar el trabajo dispara la revisión sola. Corre en
      // segundo plano (no bloquea la respuesta) y con candado por estado, así
      // que los descubiertos que se completen después re-disparan otra pasada.
      const run = store.getRun(request.params.runId);
      if (run && run.nodeCount > 0 && run.completedCount === run.nodeCount) {
        const detail = store.getRunDetail(request.params.runId)!;
        for (const auditor of run.auditors.filter((agent) => agent !== "ollama")) {
          const previous = detail.agentStates.find((state) => state.agent === auditor);
          // Su alcance es el trabajo ajeno, igual que en la directiva y en la
          // validación del cierre: contar el run entero le mostraría al humano
          // una cobertura imposible y le pediría al auditor nodos suyos.
          const auditable = auditableNodes(detail, auditor);
          const validNodeIds = new Set(auditable.map((candidate) => candidate.id));
          const reviewedNodeIds = (previous?.reviewedNodeIds ?? [])
            .filter((candidateId) => candidateId !== node.id && validNodeIds.has(candidateId));
          const reviewed = new Set(reviewedNodeIds);
          const remainingNodeIds = auditable
            .map((candidate) => candidate.id)
            .filter((candidateId) => !reviewed.has(candidateId));
          store.setAgentState(run.id, {
            agent: auditor,
            phase: "waiting",
            summary: reviewedNodeIds.length ? "Nueva pasada de auditoría pendiente" : "Auditoría pendiente de iniciar",
            detail: `Se invalidó la cobertura de ${node.id}; conserva ${reviewedNodeIds.length} operaciones ya revisadas.`,
            completed: reviewedNodeIds.length,
            total: auditable.length,
            reviewedNodeIds,
            remainingNodeIds,
            startedAt: reviewedNodeIds.length ? previous?.startedAt : undefined,
          });
        }
        broadcast(run.projectId, run.id, "node-completed");
        void runAutoReview(store, request.params.runId, {
          onProgress: () => broadcast(run.projectId, run.id, "agent-status"),
        }).then((result) => {
          const audited = store.getRun(request.params.runId);
          if (audited) broadcast(audited.projectId, audited.id, result && result.created > 0 ? "finding-created" : "audit-finished");
        });
      } else {
        broadcast(projectForRun(request.params.runId), request.params.runId, "node-completed");
      }
      response.json(node);
    } catch (error) { next(error); }
  });

  app.post("/api/runs/:runId/activity", (request, response, next) => {
    try {
      const input = z.object({
        type: z.enum(activityTypes), message: z.string().min(1), detail: z.string().optional(), nodeId: z.string().optional(),
        agent: z.string().min(1).optional(),
      }).strict().parse(request.body);
      const activity = store.addActivity(request.params.runId, input.type, input.message, input.detail, input.nodeId, input.agent);
      broadcast(projectForRun(request.params.runId), request.params.runId, "activity-published");
      response.status(201).json(activity);
    } catch (error) { next(error); }
  });

  app.get("/api/runs/:runId/findings", (request, response, next) => {
    try {
      response.json({ findings: store.listFindings(request.params.runId) });
    } catch (error) { next(error); }
  });

  app.post("/api/runs/:runId/findings", (request, response, next) => {
    try {
      const input = z.object({
        reviewer: z.string().min(1),
        severity: z.enum(findingSeverities),
        title: z.string().min(1),
        body: z.string().min(1),
        nodeId: z.string().min(1).optional(),
        // Omitido, el store lo deriva de nodeId; sólo la auditoría del plan
        // necesita declararlo, y entonces el store rechaza que traiga nodeId.
        scope: z.enum(findingScopes).optional(),
      }).strict().parse(request.body);
      const finding = store.createFinding(request.params.runId, input);
      broadcast(projectForRun(request.params.runId), request.params.runId, "finding-created");
      response.status(201).json(finding);
    } catch (error) { next(error); }
  });

  app.get("/api/findings/:findingId", (request, response, next) => {
    try {
      const finding = store.getFinding(request.params.findingId);
      if (!finding) return response.status(404).json({ error: `Unknown finding: ${request.params.findingId}` });
      response.json(finding);
    } catch (error) { next(error); }
  });

  app.post("/api/findings/:findingId/messages", (request, response, next) => {
    try {
      const input = z.object({ author: z.string().min(1), body: z.string().min(1) }).strict().parse(request.body);
      const finding = store.addFindingMessage(request.params.findingId, input.author, input.body);
      broadcast(projectForRun(finding.runId), finding.runId, "finding-updated");
      response.status(201).json(finding);
    } catch (error) { next(error); }
  });

  app.post("/api/findings/:findingId/agreements", (request, response, next) => {
    try {
      const input = z.object({ agent: z.string().min(1) }).strict().parse(request.body);
      const finding = store.agreeFinding(request.params.findingId, input.agent);
      broadcast(projectForRun(finding.runId), finding.runId, "finding-updated");
      response.json(finding);
    } catch (error) { next(error); }
  });

  app.post("/api/findings/:findingId/status", (request, response, next) => {
    try {
      const input = z.object({
        status: z.enum(findingStatuses),
        resolutionNodeId: z.string().min(1).optional(),
      }).strict().parse(request.body);
      const finding = store.setFindingStatus(request.params.findingId, input.status, input.resolutionNodeId);
      broadcast(projectForRun(finding.runId), finding.runId, "finding-updated");
      response.json(finding);
    } catch (error) { next(error); }
  });

  app.get("/api/runs/:runId/review-pack", (request, response, next) => {
    try {
      const nodeId = typeof request.query.nodeId === "string" ? request.query.nodeId : undefined;
      const agent = typeof request.query.agent === "string" ? request.query.agent : (typeof request.headers["x-agent"] === "string" ? request.headers["x-agent"] : undefined);
      const pack = buildReviewPack(store, request.params.runId, nodeId);
      store.addActivity(request.params.runId, "note", `Paquete de revisión generado${nodeId ? ` · subárbol ${nodeId}` : ""}`, undefined, nodeId, agent);
      broadcast(projectForRun(request.params.runId), request.params.runId, "activity-published");
      response.type("text/markdown").send(pack);
    } catch (error) { next(error); }
  });

  // Paquete de auditoría del PLAN para un auditor con sesión: el humano lo
  // copia a la otra sesión antes de aprobar el grafo.
  app.get("/api/runs/:runId/plan-pack", (request, response, next) => {
    try {
      const agent = typeof request.query.agent === "string" ? request.query.agent : (typeof request.headers["x-agent"] === "string" ? request.headers["x-agent"] : undefined);
      const pack = buildPlanReviewPack(store, request.params.runId);
      store.addActivity(request.params.runId, "note", "Paquete de auditoría del plan generado", undefined, undefined, agent);
      broadcast(projectForRun(request.params.runId), request.params.runId, "activity-published");
      response.type("text/markdown").send(pack);
    } catch (error) { next(error); }
  });

  // Relanzar la ronda: sirve cuando falló, cuando el humano eligió auditores
  // después de publicar, o para forzar otra pasada sobre la misma versión.
  app.post("/api/runs/:runId/plan-review", (request, response, next) => {
    try {
      if (!store.getRun(request.params.runId)) throw new Error(`Unknown run: ${request.params.runId}`);
      void runPlanReview(store, request.params.runId, {
        force: true,
        onProgress: () => broadcast(projectForRun(request.params.runId), request.params.runId, "agent-status"),
      }).then((result) => {
        if (result && result.created > 0) broadcast(projectForRun(request.params.runId), request.params.runId, "finding-created");
      });
      response.status(202).json({ started: true });
    } catch (error) { next(error); }
  });

  // Un auditor declara que ya opinó sobre esta versión del plan. La aprobación
  // humana no espera esta ruta; sirve para registrar la ronda y sus hallazgos.
  app.post("/api/runs/:runId/plan-pass", (request, response, next) => {
    try {
      const input = z.object({
        agent: z.string().min(1),
        findings: z.number().int().min(0).optional(),
      }).strict().parse(request.body);
      const planGate = store.recordPlanPass(request.params.runId, input.agent, input.findings ?? 0);
      broadcast(projectForRun(request.params.runId), request.params.runId, "plan-pass");
      response.json({ planGate });
    } catch (error) { next(error); }
  });

  // Lectura pura: qué del árbol observado respalda un nodo completado y qué se
  // movió después. No emite broadcast porque no cambia nada.
  app.get("/api/runs/:runId/attribution", (request, response, next) => {
    try {
      response.json({ files: store.workspaceAttribution(request.params.runId) });
    } catch (error) { next(error); }
  });

  app.get("/api/runs/:runId/review-gate", (request, response, next) => {
    try {
      response.json({
        pending: store.runReviewGate(request.params.runId),
        pendingAuditors: store.pendingAuditors(request.params.runId),
        pendingAuditorVotes: store.pendingAuditorVotes(request.params.runId),
      });
    } catch (error) { next(error); }
  });

  // Punto único desde el que cualquier agente se entera de que HRP tiene algo
  // para él: el CLI, los hooks nativos de Claude Code y Codex, y la herramienta
  // MCP consumen esta misma respuesta. Con waitMs se convierte en long-poll
  // sobre el mismo emisor que alimenta /api/events, así que la señal llega en
  // cuanto ocurre en vez de depender de que alguien sondee.
  app.get("/api/attention", (request, response) => {
    const agent = typeof request.query.agent === "string" ? request.query.agent.trim() : "";
    if (!agent) return response.status(400).json({ error: "Falta ?agent=<nombre> en /api/attention" });
    const runId = typeof request.query.runId === "string" ? request.query.runId : undefined;
    const workspace = typeof request.query.workspace === "string" ? canonicalPath(request.query.workspace) : undefined;
    const requestedWait = Number(request.query.waitMs ?? 0);
    const waitMs = Math.min(Math.max(Number.isFinite(requestedWait) ? requestedWait : 0, 0), 600_000);

    const scopedRunIds = (): string[] => {
      if (runId) return store.getRun(runId) ? [runId] : [];
      const projects = workspace
        ? store.listProjects().filter((project) => canonicalPath(project.workspaceRoot) === workspace)
        : store.listProjects();
      return projects.flatMap((project) => store.listRuns(project.id).map((run) => run.id));
    };

    // Una sesión acuñada en el panel pertenece al proyecto aunque todavía no
    // haya tocado ninguna ejecución: es lo que permite pegar su comando en una
    // sesión abierta y que empiece a recibir señal en el acto.
    const mintedIn = (projectId: string): boolean => store.listProjectSessions(projectId).includes(agent);

    if (waitMs > 0) {
      for (const id of scopedRunIds()) {
        store.clearAttentionRelease(id, agent);
        // Estacionarse es presentarse. Sólo en la espera: el panel sondea con
        // waitMs=0 por cada identidad del censo, y registrar presencia ahí
        // pintaría de verde a sesiones acuñadas que nadie ha abierto todavía.
        const run = store.getRun(id);
        if (run && run.status !== "completed" && run.control !== "stopped" && mintedIn(run.projectId)) {
          const yaPresente = run.seenAgents.includes(agent);
          store.helloAgent(id, agent);
          // Un panel abierto sólo se entera por /api/events, así que presentarse
          // tiene que difundirse igual que en POST /runs/:runId/agents; si no, el
          // árbol no pinta la presencia hasta el siguiente evento ajeno. Sólo la
          // primera vez: las esperas sucesivas de la misma sesión no son novedad.
          if (!yaPresente) broadcast(run.projectId, id, "agent-seen");
        }
      }
    }

    // Sin un run explícito solo cuentan las ejecuciones donde ese agente
    // participa: ser base, auditor, tener nodos asignados, haber aparecido o
    // ser una sesión acuñada en el proyecto de esa ejecución.
    const involves = (detail: RunDetail): boolean => runId !== undefined
      || detail.run.baseAgent === agent
      || detail.run.auditors.includes(agent)
      || detail.run.seenAgents.includes(agent)
      || detail.nodes.some((node) => node.assignee === agent)
      || mintedIn(detail.run.projectId);

    const evaluate = (): { best?: Attention; runs: Attention[] } => {
      const runs = scopedRunIds()
        .map((candidate) => store.getRunDetail(candidate))
        .filter((detail): detail is RunDetail => Boolean(detail) && involves(detail!))
        .map((detail) => {
          const signal = computeAttention(detail, agent);
          const release = store.getAttentionRelease(detail.run.id, agent);
          return release && release.createdAt >= detail.run.updatedAt
            ? {
                ...signal,
                kind: "released" as const,
                actionable: false,
                terminal: true,
                waiting: false,
                directive: `Atención liberada para ${agent} en ${detail.run.title}; deja de esperar HRP hasta reactivar con 'hrp attention --agent ${agent} --run ${detail.run.id} --wait 600'.`,
              }
            : signal;
        })
        .sort((left, right) => attentionRank(left.kind) - attentionRank(right.kind));
      return { best: runs[0], runs };
    };

    const settle = (): boolean => {
      const { best, runs } = evaluate();
      // Un run explícito también termina la espera cuando ya no dará señales
      // (detenido o completo); en el barrido global eso no es una novedad.
      const resolved = best && (best.actionable || (runId !== undefined && best.terminal));
      if (!resolved) return false;
      response.json({ ...best, runs });
      return true;
    };

    if (settle()) return;
    if (waitMs === 0) {
      const { best, runs } = evaluate();
      return response.json(best
        ? { ...best, runs }
        : { runId: null, projectId: null, agent, kind: "idle", actionable: false, terminal: false, waiting: false, directive: `Sin ejecuciones de HRP para ${agent}.`, pendingAuditors: [], runs: [] });
    }

    let finished = false;
    const finish = (respond: () => void) => {
      if (finished) return;
      finished = true;
      events.off("change", onChange);
      clearInterval(safety);
      clearTimeout(deadline);
      respond();
    };
    const onChange = () => { if (!finished) { const done = settle(); if (done) finish(() => undefined); } };
    // Red de seguridad: hay señales que dependen del reloj de otro proceso
    // (una auditoría automática en vuelo), no de un evento local.
    const safety = setInterval(onChange, 5_000);
    const deadline = setTimeout(() => finish(() => {
      const { best, runs } = evaluate();
      response.json(best
        ? { ...best, runs }
        : { runId: null, projectId: null, agent, kind: "idle", actionable: false, terminal: false, waiting: false, directive: `Sin ejecuciones de HRP para ${agent}.`, pendingAuditors: [], runs: [] });
    }), waitMs);
    events.on("change", onChange);
    request.on("close", () => finish(() => undefined));
  });

  app.get("/api/events", (request, response) => {
    const projectId = typeof request.query.projectId === "string" ? request.query.projectId : undefined;
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    response.write(`event: ready\ndata: ${JSON.stringify({ protocolVersion: PROTOCOL_VERSION })}\n\n`);
    const send = (event: { projectId: string }) => {
      if (!projectId || event.projectId === projectId) response.write(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20_000);
    events.on("change", send);
    request.on("close", () => {
      clearInterval(heartbeat);
      events.off("change", send);
    });
  });

  const webRoot = path.resolve(process.cwd(), "dist/web");
  app.use(express.static(webRoot));
  app.get("*splat", (request, response, next) => {
    if (request.path.startsWith("/api/")) return next();
    response.sendFile(path.join(webRoot, "index.html"));
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    response.status(400).json({ error: message });
  });

  return app;
}
