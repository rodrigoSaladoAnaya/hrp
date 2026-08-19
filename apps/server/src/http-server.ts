import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { changeOperationKinds, nodeStatuses, PROTOCOL_VERSION, reviewModes, type ProtocolConfig, type ProtocolEvent } from "@human-review/protocol";
import type { ProjectContext, ProjectManager } from "./project-manager.js";

const alternativeSchema = z.object({ option: z.string().min(1), reasonRejected: z.string().min(1) }).strict();
const operationSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  file: z.string().min(1),
  symbol: z.string().min(1).optional(),
  kind: z.enum(changeOperationKinds),
  summary: z.string().min(1),
  rationale: z.string().min(1),
}).strict();
const semanticChangeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  title: z.string().min(1),
  intent: z.string().min(1),
  rationale: z.string().min(1),
  dependencies: z.array(z.string()),
  operations: z.array(operationSchema).min(1),
}).strict();
const planNodeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  title: z.string().min(1),
  objective: z.string().min(1),
  dependencies: z.array(z.string()),
  affectedFiles: z.array(z.string()).min(1),
  rationale: z.string().min(1),
  alternatives: z.array(alternativeSchema).optional(),
  verificationCriteria: z.array(z.string().min(1)).min(1),
  changes: z.array(semanticChangeSchema).min(1).optional(),
  supersedes: z.array(z.string()).optional(),
}).strict();
const planSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  nodes: z.array(planNodeSchema).min(1),
}).strict();
const reviewResolutionSchema = z.object({
  decision: z.enum(["approved", "rejected", "paused", "redirected"]),
  direction: z.string().trim().min(1).max(4000).optional(),
}).strict();
const targetSchema = z.object({
  planId: z.string().optional(),
  nodeId: z.string().optional(),
  changeId: z.string().optional(),
  operationId: z.string().optional(),
  file: z.string().optional(),
  symbol: z.string().optional(),
  line: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  patchId: z.string().optional(),
}).strict();

function context(response: Response): ProjectContext {
  return response.locals.projectContext as ProjectContext;
}

function projectRouter(manager: ProjectManager) {
  const router = express.Router({ mergeParams: true });

  router.use(async (request, response, next) => {
    try {
      const projectId = typeof request.params.projectId === "string" ? request.params.projectId : undefined;
      const workspaceRoot = request.header("x-hrp-workspace-root");
      response.locals.projectContext = projectId
        ? await manager.get(projectId)
        : workspaceRoot
          ? await manager.attach(workspaceRoot)
          : await manager.get();
      next();
    } catch (error) { next(error); }
  });

  router.get("/state", (_request, response) => response.json(context(response).orchestrator.getState()));
  router.get("/config", (_request, response) => {
    const selected = context(response);
    response.json({
      project: selected.project,
      workspaceRoot: selected.config.workspaceRoot,
      observer: selected.observer.getStatus(),
    });
  });
  router.get("/protocol/commands", (request, response) => {
    const pendingOnly = request.query.pending !== "false";
    const commands = context(response).orchestrator.getState().commands
      .filter((command) => !pendingOnly || command.status === "pending");
    response.json({ commands });
  });
  router.get("/events", (request, response) => {
    const selected = context(response);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    response.write(`event: ready\ndata: ${JSON.stringify({
      projectId: selected.project.id,
      sessionId: selected.orchestrator.getState().sessionId,
      protocolVersion: PROTOCOL_VERSION,
    })}\n\n`);
    const send = (event: ProtocolEvent) => response.write(`event: protocol-event\ndata: ${JSON.stringify(event)}\n\n`);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20_000);
    selected.store.on("event", send);
    request.on("close", () => {
      clearInterval(heartbeat);
      selected.store.off("event", send);
    });
  });

  router.post("/protocol/plans", async (request, response, next) => {
    try {
      response.status(201).json(await context(response).orchestrator.createPlan(planSchema.parse(request.body)));
    } catch (error) { next(error); }
  });
  router.post("/protocol/reviews", async (request, response, next) => {
    try {
      const input = z.object({
        kind: z.enum(["plan", "node"]),
        planId: z.string().optional(),
        nodeId: z.string().optional(),
        summary: z.string().min(1),
      }).strict().parse(request.body);
      response.status(201).json(await context(response).orchestrator.requestReview(input));
    } catch (error) { next(error); }
  });
  router.post("/reviews/:reviewId/resolve", async (request, response, next) => {
    try {
      const { decision, direction } = reviewResolutionSchema.parse(request.body);
      await context(response).orchestrator.resolveReview(request.params.reviewId, decision, direction);
      response.status(204).end();
    } catch (error) { next(error); }
  });
  router.put("/review-policy", async (request, response, next) => {
    try {
      const input = z.object({
        planId: z.string().optional(),
        nodeId: z.string().min(1),
        scope: z.enum(["node", "subtree"]),
        mode: z.enum(reviewModes),
        reason: z.string().trim().max(500).optional(),
      }).strict().parse(request.body);
      response.json(await context(response).orchestrator.setReviewPolicy(input));
    } catch (error) { next(error); }
  });
  router.post("/protocol/nodes/:nodeId/start", async (request, response, next) => {
    try {
      const input = z.object({ intent: z.string().min(1), affectedFiles: z.array(z.string()).min(1) }).strict().parse(request.body);
      await context(response).orchestrator.startNode(request.params.nodeId, input.intent, input.affectedFiles);
      response.status(204).end();
    } catch (error) { next(error); }
  });
  router.post("/protocol/nodes/:nodeId/patches", async (request, response, next) => {
    try {
      const input = z.object({
        changeId: z.string().min(1).optional(),
        operationIds: z.array(z.string().min(1)).optional(),
        summary: z.string().min(1).max(1000),
        files: z.array(z.string()).min(1),
        diff: z.string().min(1),
        beforeCode: z.string().optional(),
        afterCode: z.string().optional(),
        actor: z.string().optional(),
      }).strict().parse(request.body);
      response.status(201).json(await context(response).orchestrator.observePatch({ nodeId: request.params.nodeId, ...input }));
    } catch (error) { next(error); }
  });
  router.post("/protocol/nodes/:nodeId/verifications", async (request, response, next) => {
    try {
      const input = z.object({
        commandId: z.string().min(1),
        command: z.string().min(1),
        output: z.string(),
        exitCode: z.number().int(),
        coversChangeIds: z.array(z.string().min(1)).optional(),
        coversOperationIds: z.array(z.string().min(1)).optional(),
        coversPatchIds: z.array(z.string().min(1)).optional(),
      }).strict().parse(request.body);
      response.status(201).json(await context(response).orchestrator.observeVerification({ nodeId: request.params.nodeId, ...input }));
    } catch (error) { next(error); }
  });
  router.post("/protocol/nodes/:nodeId/complete", async (request, response, next) => {
    try {
      const { summary } = z.object({ summary: z.string().min(1) }).strict().parse(request.body);
      await context(response).orchestrator.completeNode(request.params.nodeId, summary);
      response.status(204).end();
    } catch (error) { next(error); }
  });
  router.post("/observations", async (request, response, next) => {
    try {
      const input = z.object({
        target: targetSchema.optional(),
        kind: z.enum(["change", "question", "constraint", "note"]),
        message: z.string().trim().min(1).max(4000),
        blocking: z.boolean().default(false),
      }).strict().parse(request.body);
      response.status(201).json(await context(response).orchestrator.recordObservation(input));
    } catch (error) { next(error); }
  });
  router.post("/control/:action", async (request, response, next) => {
    try {
      const action = z.enum(["pause", "resume"]).parse(request.params.action);
      const { reason } = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict().parse(request.body ?? {});
      await context(response).orchestrator.setControl(action, reason ?? `${action === "pause" ? "Paused" : "Resumed"} from the review panel`);
      response.status(204).end();
    } catch (error) { next(error); }
  });
  router.post("/protocol/commands/:commandId/ack", async (request, response, next) => {
    try {
      await context(response).orchestrator.acknowledgeCommand(request.params.commandId);
      response.status(204).end();
    } catch (error) { next(error); }
  });
  router.post("/protocol/replans", async (request, response, next) => {
    try {
      const input = planSchema.extend({
        changedAssumption: z.string().min(1),
        retainedNodeIds: z.array(z.string()),
        supersededNodeIds: z.array(z.string()),
        newNodeIds: z.array(z.string()),
      }).strict().parse(request.body);
      response.status(201).json(await context(response).orchestrator.proposeReplan(input));
    } catch (error) { next(error); }
  });

  return router;
}

export function createHttpServer(config: ProtocolConfig, manager: ProjectManager) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/ }));
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/protocol", (_request, response) => response.json({
    name: "human-review-protocol",
    version: PROTOCOL_VERSION,
    transport: "http+sse",
    multiProject: true,
    semanticChanges: true,
    mappedVerification: true,
    eventSources: ["agent", "human", "workspace", "orchestrator", "verification"],
    nodeStatuses,
    reviewModes,
  }));
  app.get("/api/projects", (_request, response) => response.json({
    defaultProjectId: manager.defaultProjectId,
    projects: manager.list(),
  }));
  app.post("/api/projects", async (request, response, next) => {
    try {
      const { workspaceRoot } = z.object({ workspaceRoot: z.string().min(1) }).strict().parse(request.body);
      const selected = await manager.attach(workspaceRoot);
      response.status(201).json({ project: manager.list().find((project) => project.id === selected.project.id) });
    } catch (error) { next(error); }
  });

  app.use("/api/projects/:projectId", projectRouter(manager));
  app.use("/api", projectRouter(manager));

  const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get("/{*path}", (_request, response) => response.sendFile(path.join(webDist, "index.html")));
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    const status = error instanceof z.ZodError ? 400 : message.startsWith("Unknown project") ? 404 : 409;
    response.status(status).json({ error: message });
  });

  return app.listen(config.http.port, config.http.host, () => {
    process.stderr.write(`Human Review Protocol: http://${config.http.host}:${config.http.port}\n`);
  });
}
