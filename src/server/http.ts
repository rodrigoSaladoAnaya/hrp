import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { activityTypes, agentWorkPhases, findingSeverities, findingStatuses, PROTOCOL_VERSION, runControls } from "../shared/protocol.js";
import { buildReviewPack, runAutoReview, upstreamJson } from "./review.js";
import { HrpStore } from "./store.js";

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

  app.get("/api/health", (_request, response) => response.json({
    ok: true,
    product: "hrp",
    protocolVersion: PROTOCOL_VERSION,
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
      }).strict().parse(request.body ?? {});
      response.json(store.setOllamaSettings(input));
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
      const nodes = store.publishGraph(request.params.runId, { nodes: input.nodes }, input.agent);
      broadcast(projectForRun(request.params.runId), request.params.runId, "graph-published");
      response.status(201).json({ nodes });
    } catch (error) { next(error); }
  });

  app.post("/api/runs/:runId/nodes", (request, response, next) => {
    try {
      const input = nodeInput.parse({ ...request.body, discovered: true });
      const node = store.addDiscoveredNode(request.params.runId, input);
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

  app.put("/api/runs/:runId/auditors", (request, response, next) => {
    try {
      const input = z.object({ auditors: z.array(z.string().trim().min(1)).max(16) }).strict().parse(request.body);
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
        const expected = new Set(detail.nodes.map((node) => node.id));
        const reviewed = new Set(coverage.reviewedNodeIds);
        const unreviewed = [...expected].filter((nodeId) => !reviewed.has(nodeId));
        const gaps = [
          unreviewed.length ? `unreviewed nodes: ${unreviewed.join(", ")}` : "",
          coverage.remainingNodeIds.length ? `still marked remaining: ${coverage.remainingNodeIds.join(", ")}` : "",
          coverage.completed !== expected.size ? `completed is ${coverage.completed}, expected ${expected.size}` : "",
          coverage.total !== expected.size ? `total is ${coverage.total}, expected ${expected.size}` : "",
        ].filter(Boolean);
        if (gaps.length) throw new Error(`An auditor can only complete with full coverage of the ${expected.size} current nodes (${gaps.join("; ")})`);
        if (!startedAt || detail.nodes.some((node) => node.updatedAt > startedAt)) {
          throw new Error("Auditor coverage predates the latest node change; publish phase reviewing again before completion");
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
      const input = z.object({ nodeIds: z.array(z.string()).min(1).optional() }).strict().parse(request.body ?? {});
      const nodes = store.approveNodes(request.params.runId, input.nodeIds);
      broadcast(projectForRun(request.params.runId), request.params.runId, "graph-approved");
      response.json({ nodes });
    } catch (error) { next(error); }
  });

  app.post("/api/runs/:runId/nodes/:nodeId/assign", (request, response, next) => {
    try {
      const input = z.object({ assignee: z.string().min(1).nullable() }).strict().parse(request.body);
      const node = store.assignNode(request.params.runId, request.params.nodeId, input.assignee);
      broadcast(projectForRun(request.params.runId), request.params.runId, "node-assigned");
      response.json(node);
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
      broadcast(projectForRun(request.params.runId), request.params.runId, "node-completed");
      // Política v3.1: terminar el trabajo dispara la revisión sola. Corre en
      // segundo plano (no bloquea la respuesta) y con candado por estado, así
      // que los descubiertos que se completen después re-disparan otra pasada.
      const run = store.getRun(request.params.runId);
      if (run && run.nodeCount > 0 && run.completedCount === run.nodeCount) {
        const detail = store.getRunDetail(request.params.runId)!;
        for (const auditor of run.auditors.filter((agent) => agent !== "ollama")) {
          const previous = detail.agentStates.find((state) => state.agent === auditor);
          const validNodeIds = new Set(detail.nodes.map((candidate) => candidate.id));
          const reviewedNodeIds = (previous?.reviewedNodeIds ?? [])
            .filter((candidateId) => candidateId !== node.id && validNodeIds.has(candidateId));
          const reviewed = new Set(reviewedNodeIds);
          const remainingNodeIds = detail.nodes
            .map((candidate) => candidate.id)
            .filter((candidateId) => !reviewed.has(candidateId));
          store.setAgentState(run.id, {
            agent: auditor,
            phase: "waiting",
            summary: reviewedNodeIds.length ? "Nueva pasada de auditoría pendiente" : "Auditoría pendiente de iniciar",
            detail: `Se invalidó la cobertura de ${node.id}; conserva ${reviewedNodeIds.length} operaciones ya revisadas.`,
            completed: reviewedNodeIds.length,
            total: detail.nodes.length,
            reviewedNodeIds,
            remainingNodeIds,
          });
        }
        void runAutoReview(store, request.params.runId, {
          onProgress: () => broadcast(run.projectId, run.id, "agent-status"),
        }).then((result) => {
          const audited = store.getRun(request.params.runId);
          if (audited) broadcast(audited.projectId, audited.id, result && result.created > 0 ? "finding-created" : "audit-finished");
        });
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

  app.get("/api/runs/:runId/review-gate", (request, response, next) => {
    try {
      response.json({
        pending: store.runReviewGate(request.params.runId),
        pendingAuditors: store.pendingAuditors(request.params.runId),
      });
    } catch (error) { next(error); }
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
