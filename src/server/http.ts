import { EventEmitter } from "node:events";
import path from "node:path";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { activityTypes, PROTOCOL_VERSION } from "../shared/protocol.js";
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
}).strict();

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

  app.get("/api/health", (_request, response) => response.json({ ok: true, product: "hrp", protocolVersion: PROTOCOL_VERSION }));

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
      const input = z.object({ title: z.string().min(1), requirement: z.string().min(1) }).strict().parse(request.body);
      const run = store.createRun(request.params.projectId, input.title, input.requirement);
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
      response.json(node);
    } catch (error) { next(error); }
  });

  app.post("/api/runs/:runId/activity", (request, response, next) => {
    try {
      const input = z.object({
        type: z.enum(activityTypes), message: z.string().min(1), detail: z.string().optional(), nodeId: z.string().optional(),
      }).strict().parse(request.body);
      const activity = store.addActivity(request.params.runId, input.type, input.message, input.detail, input.nodeId);
      broadcast(projectForRun(request.params.runId), request.params.runId, "activity-published");
      response.status(201).json(activity);
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
