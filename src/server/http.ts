import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { PROTOCOL_VERSION, activityTypes, auditVotes, findingScopes, findingSeverities, runControls, type RunDetail } from "../shared/protocol.js";
import { attentionRank, computeAttention, type Attention } from "./attention.js";
import { buildReviewPack } from "./review.js";
import { HrpStore } from "./store.js";

const family = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "familia inválida");
const sessionId = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*:[0-9]+$/, "sesión inválida (familia:N)");
const actor = z.union([sessionId, z.literal("human")]);
const pids = z.array(z.number().int().positive()).max(32).optional();

const runInput = z.object({
  title: z.string().trim().min(1),
  requirement: z.string().trim().min(1),
  interpretation: z.string().trim().min(1),
  scopeIncludes: z.array(z.string().trim().min(1)).optional(),
  scopeExcludes: z.array(z.string().trim().min(1)).optional(),
  acceptance: z.array(z.object({ text: z.string().trim().min(1), command: z.string().trim().min(1).optional() })).min(1),
  risks: z.array(z.string().trim().min(1)).optional(),
  attachments: z.array(z.object({ path: z.string().trim().min(1), note: z.string().trim().optional() })).optional(),
}).strict();

const nodeInput = z.object({
  actor: sessionId,
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).optional(),
  file: z.string().trim().min(1),
  symbol: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  dependencies: z.array(z.string()).optional(),
  resolves: z.string().trim().min(1).optional(),
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

// El panel y el CLI comparan este id para avisar cuando el servicio corre un
// build viejo tras un update.
export function createBuildIdentity(target = defaultBuildTarget()) {
  const buildId = artifactBuildId(target);
  return () => {
    const currentBuildId = artifactBuildId(target);
    return { buildId: buildId ?? null, currentBuildId: currentBuildId ?? null, buildStale: Boolean(buildId && buildId !== currentBuildId) };
  };
}

const readBuildIdentity = createBuildIdentity();

function canonicalPath(target: string): string {
  const resolved = path.resolve(target);
  try { return realpathSync(resolved); } catch { return resolved; }
}

function idle(directive: string): Omit<Attention, "runId" | "projectId" | "workspaceRoot" | "branch" | "role"> & { runId: null; projectId: null } {
  return { runId: null, projectId: null, session: "", kind: "idle", actionable: false, terminal: false, waiting: false, directive };
}

export function createApp(store: HrpStore, options: { webRoot?: string } = {}) {
  const app = express();
  const events = new EventEmitter();
  events.setMaxListeners(200);

  app.use(cors());
  app.use(express.json({ limit: "8mb" }));

  const broadcast = (runId: string, type: string) => {
    const run = store.getRun(runId);
    events.emit("change", { projectId: run?.projectId ?? null, runId, type, observedAt: new Date().toISOString() });
  };

  const parse = <T,>(schema: z.ZodType<T>, body: unknown): T => {
    const result = schema.safeParse(body);
    if (!result.success) throw new Error(result.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
    return result.data;
  };

  const handle = (fn: (request: Request<Record<string, string>>, response: Response) => void | Promise<void>) =>
    (request: Request, response: Response, next: NextFunction) => {
      Promise.resolve(fn(request as Request<Record<string, string>>, response)).catch(next);
    };

  app.get("/api/health", (_request, response) => response.json({
    status: "ok",
    protocolVersion: PROTOCOL_VERSION,
    pid: process.pid,
    dataDir: store.dataDirectory,
    ...readBuildIdentity(),
  }));

  // --- Proyectos ---
  app.get("/api/projects", (_request, response) => response.json({
    projects: store.listProjects().map((project) => ({ ...project, runs: store.listRuns(project.id) })),
  }));
  app.post("/api/projects", handle((request, response) => {
    const { workspaceRoot } = parse(z.object({ workspaceRoot: z.string().min(1) }), request.body);
    response.json(store.attachProject(workspaceRoot));
  }));
  app.delete("/api/projects/:projectId", (request, response) => {
    response.status(store.deleteProject(request.params.projectId) ? 204 : 404).end();
  });
  app.get("/api/projects/:projectId/runs", (request, response) => response.json({ runs: store.listRuns(request.params.projectId) }));
  app.get("/api/runs", (_request, response) => response.json({ runs: store.listAllRuns() }));

  // --- Runs ---
  app.post("/api/projects/:projectId/runs", handle((request, response) => {
    const body = parse(z.object({ family, hostPids: pids, input: runInput }), request.body);
    const started = store.createRun(request.params.projectId, body.input, body.family);
    if (body.hostPids?.length) store.bindSessionHost(started.run.id, started.session.id, body.hostPids);
    broadcast(started.run.id, "run-created");
    response.status(201).json(started);
  }));
  app.get("/api/runs/:runId", handle((request, response) => {
    const detail = store.getRunDetail(request.params.runId);
    if (!detail) { response.status(404).json({ error: `Unknown run: ${request.params.runId}` }); return; }
    response.json(detail);
  }));
  app.delete("/api/runs/:runId", (request, response) => {
    const run = store.getRun(request.params.runId);
    const deleted = store.deleteRun(request.params.runId);
    if (deleted && run) events.emit("change", { projectId: run.projectId, runId: run.id, type: "run-deleted", observedAt: new Date().toISOString() });
    response.status(deleted ? 204 : 404).end();
  });
  app.get("/api/runs/:runId/issue", handle((request, response) => {
    store.requireRun(request.params.runId);
    response.type("text/markdown").send(store.readIssue(request.params.runId));
  }));
  app.get("/api/runs/:runId/attachments/:file", handle((request, response) => {
    const run = store.requireRun(request.params.runId);
    const directory = path.join(path.dirname(run.issuePath), "attachments");
    const target = path.resolve(directory, request.params.file);
    if (!target.startsWith(directory + path.sep) || !existsSync(target)) { response.status(404).end(); return; }
    response.sendFile(target);
  }));
  app.post("/api/runs/:runId/control", handle((request, response) => {
    const body = parse(z.object({ control: z.enum(runControls), actor: actor.optional() }), request.body);
    const run = store.setRunControl(request.params.runId, body.control, body.actor ?? "human");
    broadcast(run.id, "control");
    response.json(run);
  }));
  app.post("/api/runs/:runId/close", handle((request, response) => {
    const body = parse(z.object({ actor }), request.body);
    const result = store.closeRun(request.params.runId, body.actor);
    broadcast(request.params.runId, "run-close");
    response.json(result);
  }));
  app.post("/api/runs/:runId/activity", handle((request, response) => {
    const body = parse(z.object({
      type: z.enum(activityTypes), message: z.string().trim().min(1), detail: z.string().optional(), nodeId: z.string().optional(), agent: actor.optional(),
    }), request.body);
    store.requireRun(request.params.runId);
    const activity = store.addActivity(request.params.runId, body.type, body.message, body.detail, body.nodeId, body.agent);
    broadcast(request.params.runId, "activity");
    response.status(201).json(activity);
  }));

  // --- Sesiones ---
  app.post("/api/runs/:runId/sessions", handle((request, response) => {
    const body = parse(z.object({ family, hostPids: pids }), request.body);
    const session = store.attachSession(request.params.runId, body.family, body.hostPids ?? []);
    broadcast(request.params.runId, "session");
    response.status(201).json(session);
  }));
  app.post("/api/runs/:runId/sessions/:session/host", handle((request, response) => {
    const body = parse(z.object({ hostPids: z.array(z.number().int().positive()).max(32) }), request.body);
    response.json(store.bindSessionHost(request.params.runId, request.params.session, body.hostPids));
  }));
  app.post("/api/runs/:runId/sessions/:session/release", handle((request, response) => {
    const session = store.releaseSession(request.params.runId, request.params.session, "a petición de la sesión");
    broadcast(request.params.runId, "session");
    response.json(session);
  }));
  app.post("/api/runs/:runId/sessions/:session/audit", handle((request, response) => {
    const body = parse(z.object({ nodeIds: z.array(z.string()).optional(), requirement: z.boolean().optional(), integration: z.boolean().optional() }), request.body);
    const session = store.markAudited(request.params.runId, request.params.session, body);
    broadcast(request.params.runId, "audit");
    response.json(session);
  }));
  app.post("/api/runs/:runId/sessions/:session/vote", handle((request, response) => {
    const body = parse(z.object({ vote: z.enum(auditVotes), detail: z.string().optional() }), request.body);
    const session = store.vote(request.params.runId, request.params.session, body.vote, body.detail);
    broadcast(request.params.runId, "vote");
    response.json({ session, run: store.getRun(request.params.runId) });
  }));

  // --- Nodos ---
  app.post("/api/runs/:runId/nodes", handle((request, response) => {
    const body = parse(nodeInput, request.body);
    const { actor: author, ...input } = body;
    const node = store.openNode(request.params.runId, author, input);
    broadcast(request.params.runId, "node");
    response.status(201).json(node);
  }));
  app.post("/api/runs/:runId/nodes/:nodeId/verify", handle((request, response) => {
    const body = parse(z.object({ actor: sessionId, command: z.string().trim().min(1) }), request.body);
    const node = store.verifyNode(request.params.runId, request.params.nodeId, body.command, body.actor);
    broadcast(request.params.runId, "verify");
    response.json(node);
  }));
  app.post("/api/runs/:runId/nodes/:nodeId/complete", handle((request, response) => {
    const body = parse(z.object({ actor: sessionId, summary: z.string().trim().min(1), rationale: z.string().optional(), tokens: z.number().int().positive().optional() }), request.body);
    const node = store.completeNode(request.params.runId, request.params.nodeId, body.actor, body);
    broadcast(request.params.runId, "node");
    response.json(node);
  }));
  app.post("/api/runs/:runId/nodes/:nodeId/fail", handle((request, response) => {
    const body = parse(z.object({ actor: sessionId, reason: z.string().trim().min(1) }), request.body);
    const node = store.failNode(request.params.runId, request.params.nodeId, body.actor, body.reason);
    broadcast(request.params.runId, "node");
    response.json(node);
  }));

  // --- Hallazgos ---
  app.get("/api/runs/:runId/findings", handle((request, response) => {
    store.requireRun(request.params.runId);
    response.json({ findings: store.listFindings(request.params.runId) });
  }));
  app.post("/api/runs/:runId/findings", handle((request, response) => {
    const body = parse(z.object({
      reviewer: actor, severity: z.enum(findingSeverities), title: z.string().trim().min(1), body: z.string().trim().min(1),
      nodeId: z.string().optional(), scope: z.enum(findingScopes).optional(),
    }), request.body);
    const finding = store.createFinding(request.params.runId, body);
    broadcast(request.params.runId, "finding");
    response.status(201).json(finding);
  }));
  app.get("/api/findings/:findingId", handle((request, response) => {
    response.json(store.requireFinding(request.params.findingId));
  }));
  const findingAction = (
    route: string,
    schema: z.ZodType<Record<string, unknown>>,
    apply: (findingId: string, body: Record<string, unknown>) => ReturnType<HrpStore["requireFinding"]>,
  ) => {
    app.post(`/api/findings/:findingId/${route}`, handle((request, response) => {
      const body = parse(schema, request.body);
      const finding = apply(request.params.findingId, body);
      broadcast(finding.runId, "finding");
      response.json(finding);
    }));
  };
  findingAction("messages", z.object({ author: actor, body: z.string().trim().min(1) }), (id, body) => store.addFindingMessage(id, String(body.author), String(body.body)));
  findingAction("accept", z.object({ actor, resolutionNodeId: z.string().optional(), note: z.string().optional() }),
    (id, body) => store.acceptFinding(id, String(body.actor), body.resolutionNodeId as string | undefined, body.note as string | undefined));
  findingAction("reject", z.object({ actor, reason: z.string().trim().min(1) }), (id, body) => store.rejectFinding(id, String(body.actor), String(body.reason)));
  findingAction("escalate", z.object({ actor, reason: z.string().trim().min(1) }), (id, body) => store.escalateFinding(id, String(body.actor), String(body.reason)));
  findingAction("reopen", z.object({ author: actor, reason: z.string().trim().min(1) }), (id, body) => store.reopenFinding(id, String(body.author), String(body.reason)));

  app.get("/api/runs/:runId/review-pack", handle((request, response) => {
    const raw = typeof request.query.nodeIds === "string" ? request.query.nodeIds : "";
    const nodeIds = raw.split(",").map((id) => id.trim()).filter(Boolean);
    response.type("text/markdown").send(buildReviewPack(store, request.params.runId, nodeIds.length ? nodeIds : undefined));
  }));

  // --- Atención ---
  // Tres formas de preguntar: sesión concreta (session+runId), proceso
  // anfitrión (pids, lo usan los hooks) o familia en un workspace (respaldo
  // cuando el hook no encuentra su proceso). Siempre devuelve la mejor
  // directiva y la lista completa, ordenada por prioridad.
  app.get("/api/attention", (request, response) => {
    const query = request.query as Record<string, unknown>;
    const session = typeof query.session === "string" ? query.session.trim() : "";
    const runId = typeof query.runId === "string" ? query.runId.trim() : "";
    const familyName = typeof query.family === "string" ? query.family.trim() : "";
    const workspace = typeof query.workspace === "string" ? canonicalPath(query.workspace) : undefined;
    const hostPids = typeof query.pids === "string" ? query.pids.split(",").map(Number).filter((pid) => Number.isInteger(pid) && pid > 0) : [];
    const requestedWait = Number(query.waitMs ?? 0);
    const waitMs = Math.min(Math.max(Number.isFinite(requestedWait) ? requestedWait : 0, 0), 600_000);
    if (!session && !hostPids.length && !familyName) {
      response.status(400).json({ error: "Indica session+runId, pids o family en /api/attention" });
      return;
    }

    // Cómo se encontró a la sesión: por identidad, por proceso anfitrión o
    // por familia. El hook lo necesita: una coincidencia por familia es
    // ambigua (puede ser la sesión de al lado) y no debe retener el turno.
    let matchedBy: "session" | "host" | "family" | "none" = "none";
    const targets = (): Array<{ runId: string; session: string }> => {
      if (session) {
        if (!runId) throw new Error("Una sesión se consulta con su runId");
        matchedBy = "session";
        return [{ runId, session }];
      }
      const byHost = store.sessionsForHostPids(hostPids).map((candidate) => ({ runId: candidate.runId, session: candidate.id }));
      if (byHost.length) { matchedBy = "host"; return byHost; }
      if (!familyName) return [];
      matchedBy = "family";
      const projects = workspace
        ? store.listProjects().filter((project) => canonicalPath(project.workspaceRoot) === workspace)
        : store.listProjects();
      return projects
        .flatMap((project) => store.listRuns(project.id))
        .filter((run) => run.status !== "closed" && run.control !== "stopped")
        .flatMap((run) => store.listSessions(run.id)
          .filter((candidate) => candidate.status === "attached" && candidate.family === familyName)
          .map((candidate) => ({ runId: run.id, session: candidate.id })));
    };

    const evaluate = (): { best?: Attention; runs: Attention[] } => {
      const runs = targets()
        .map((target) => ({ target, detail: store.getRunDetail(target.runId) }))
        .filter((entry): entry is { target: { runId: string; session: string }; detail: RunDetail } => Boolean(entry.detail))
        .map(({ target, detail }) => computeAttention(detail, target.session))
        .sort((left, right) => attentionRank(left.kind) - attentionRank(right.kind));
      return { best: runs[0], runs };
    };

    const respond = () => {
      const { best, runs } = evaluate();
      response.json(best ? { ...best, matchedBy, runs } : { ...idle(session ? `${session} no tiene atención en ${runId}.` : "Sin runs de HRP para esta sesión."), matchedBy, runs });
    };

    let evaluated: { best?: Attention; runs: Attention[] };
    try {
      evaluated = evaluate();
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (waitMs > 0) {
      for (const signal of evaluated.runs) {
        if (!signal.terminal) store.touchSession(signal.runId, signal.session);
      }
    }
    const settled = (best?: Attention) => Boolean(best && (best.actionable || best.terminal));
    if (waitMs === 0 || settled(evaluated.best)) { respond(); return; }

    let finished = false;
    const finish = (fn: () => void) => {
      if (finished) return;
      finished = true;
      events.off("change", onChange);
      clearInterval(safety);
      clearTimeout(deadline);
      fn();
    };
    const onChange = () => {
      if (finished) return;
      try {
        if (settled(evaluate().best)) finish(respond);
      } catch (error) {
        finish(() => response.status(400).json({ error: error instanceof Error ? error.message : String(error) }));
      }
    };
    const safety = setInterval(onChange, 5_000);
    const deadline = setTimeout(() => finish(respond), waitMs);
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
    const send = (event: { projectId: string | null }) => {
      if (!projectId || event.projectId === projectId) response.write(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20_000);
    events.on("change", send);
    request.on("close", () => {
      clearInterval(heartbeat);
      events.off("change", send);
    });
  });

  const webRoot = options.webRoot ?? path.resolve(process.cwd(), "dist/web");
  app.use(express.static(webRoot));
  app.get("*splat", (request, response, next) => {
    if (request.path.startsWith("/api/")) return next();
    response.sendFile(path.join(webRoot, "index.html"), (error) => { if (error) next(); });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    response.status(400).json({ error: message });
  });

  return app;
}
