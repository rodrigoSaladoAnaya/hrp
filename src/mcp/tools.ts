import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attentionCommand, panelUrl, runnerCommand,
  type Finding, type RunDetail, type RunSummary, type Session,
} from "../shared/protocol.js";

function findHrpRoot(start: string): string {
  let current = start;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(current, "package.json")) && existsSync(path.join(current, "bin/hrp.mjs"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`No se encontró la raíz de HRP desde ${start}`);
}

const root = findHrpRoot(path.dirname(fileURLToPath(import.meta.url)));

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
};

// Cadena de procesos padres: el servidor MCP lo lanza la sesión del agente, así
// que su ancestro es el proceso de esa sesión; el hook Stop de la misma sesión
// comparte ese ancestro y con él encuentra su identidad sin que nadie la escriba.
export function ancestorPids(limit = 6): number[] {
  const pids: number[] = [];
  let pid = process.ppid;
  for (let depth = 0; depth < limit && pid > 1; depth += 1) {
    pids.push(pid);
    try {
      const parent = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
      if (!Number.isInteger(parent) || parent <= 1 || parent === pid) break;
      pid = parent;
    } catch {
      break;
    }
  }
  return pids;
}

export class HrpMcpClient {
  // Identidad por run, fijada al iniciar un run o engancharse: es lo que evita
  // que dos sesiones del mismo modelo publiquen a nombre de la otra.
  readonly identities = new Map<string, string>();

  constructor(
    readonly family: string = process.env.HRP_FAMILY ?? "claude",
    readonly baseUrl: string = process.env.HRP_URL ?? "http://127.0.0.1:4317",
    readonly dataDir: string = path.resolve(process.env.HRP_DATA_DIR ?? path.join(os.homedir(), ".hrp")),
    readonly port: number = Number(process.env.HRP_PORT ?? 4317),
  ) {}

  async request<T = unknown>(endpoint: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    }).catch((error: Error) => {
      throw new Error(`HRP no responde en ${this.baseUrl}: ${error.message}. Arranca el servicio con hrp_service_start.`);
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `${response.status} ${response.statusText}`);
    }
    if (response.status === 204) return undefined as T;
    const type = response.headers.get("content-type") ?? "";
    return (type.includes("json") ? await response.json() : await response.text()) as T;
  }

  async isHealthy(): Promise<boolean> {
    return fetch(`${this.baseUrl}/api/health`).then((res) => res.ok).catch(() => false);
  }

  async startService(workspace?: string): Promise<{ status: string; url: string; dataDir: string }> {
    if (await this.isHealthy()) {
      if (workspace) await this.request("/api/projects", { method: "POST", body: JSON.stringify({ workspaceRoot: path.resolve(workspace) }) });
      return { status: "already_running", url: this.baseUrl, dataDir: this.dataDir };
    }
    const entry = path.join(root, "dist/server/server/index.js");
    if (!existsSync(entry)) throw new Error(`Falta el build del servidor HRP en ${entry}. Ejecuta npm run build en ${root}.`);
    const runtime = path.join(this.dataDir, "runtime");
    mkdirSync(runtime, { recursive: true });
    const logPath = path.join(runtime, "server.log");
    const log = openSync(logPath, "a");
    const args = [entry, "--port", String(this.port), "--data-dir", this.dataDir];
    if (workspace) args.push("--workspace", path.resolve(workspace));
    const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ["ignore", log, log] });
    child.unref();
    writeFileSync(path.join(runtime, "server.pid"), String(child.pid));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await this.isHealthy()) return { status: "started", url: this.baseUrl, dataDir: this.dataDir };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`HRP no pudo iniciar. Revisa ${logPath}`);
  }

  async getStatus(): Promise<Record<string, unknown>> {
    if (!(await this.isHealthy())) return { status: "stopped", url: this.baseUrl, dataDir: this.dataDir };
    const health = await this.request<Record<string, unknown>>("/api/health");
    const { projects } = await this.request<{ projects: unknown[] }>("/api/projects");
    return { status: "running", url: this.baseUrl, dataDir: this.dataDir, buildStale: health.buildStale, projects: projects.length, identities: Object.fromEntries(this.identities) };
  }

  sessionFor(args: Record<string, unknown>, runId: string): string {
    const explicit = typeof args.session === "string" && args.session.trim() ? args.session.trim() : undefined;
    const known = explicit ?? this.identities.get(runId);
    if (!known) throw new Error(`Esta sesión no está enganchada al run ${runId}: usa hrp_attach (auditor) o hrp_run_start (base) primero, o pasa session explícitamente.`);
    return known;
  }
}

const str = (description: string) => ({ type: "string", description });
const bool = (description: string) => ({ type: "boolean", description });
const strList = (description: string) => ({ type: "array", items: { type: "string" }, description });
const runIdProp = str("Id del run (8 caracteres).");
const sessionProp = str("Identidad de sesión (familia:N). Normalmente se omite: la fija hrp_run_start o hrp_attach.");

export const hrpToolDefinitions: McpToolDefinition[] = [
  { name: "hrp_service_start", description: "Arranca el servicio HRP local si no corre y registra el workspace. Idempotente.",
    inputSchema: { type: "object", properties: { workspace: str("Ruta del proyecto (por defecto, el directorio actual).") } } },
  { name: "hrp_service_status", description: "Estado del servicio HRP y las identidades de esta sesión.",
    inputSchema: { type: "object", properties: {} } },
  { name: "hrp_run_start", description: "Inicia un run como modelo base: escribe el issue en ~/.hrp/runs/<id>/, copia adjuntos, crea la rama hrp/run-<id> y devuelve el comando de enganche (/hrp attention <id>), el comando del runner y la URL del panel. Responde al humano con esas tres cosas una sola vez y empieza a implementar.",
    inputSchema: { type: "object", required: ["title", "requirement", "interpretation", "acceptance"], properties: {
      workspace: str("Ruta del proyecto (por defecto, el directorio actual)."),
      title: str("Título corto del run."),
      requirement: str("Requerimiento LITERAL del humano, sin editar ni resumir."),
      interpretation: str("Qué entendiste que hay que hacer."),
      scopeIncludes: strList("Qué entra en el alcance (archivos, áreas)."),
      scopeExcludes: strList("Qué queda fuera."),
      acceptance: { type: "array", description: "Criterios de aceptación. Con command los ejecuta la máquina al cerrar.", items: { type: "object", required: ["text"], properties: { text: str("Criterio."), command: str("Comando que lo verifica (exit 0 = cumplido).") } } },
      risks: strList("Riesgos conocidos."),
      attachments: { type: "array", description: "Imágenes o archivos que envió el humano; se COPIAN al run.", items: { type: "object", required: ["path"], properties: { path: str("Ruta local del archivo."), note: str("Para qué sirve.") } } },
    } } },
  { name: "hrp_attach", description: "Engancha esta sesión como auditora de un run (/hrp attention <id>). Devuelve la identidad acuñada y la primera directiva. La sesión debe seguir atenta hasta que hrp_attention responda released.",
    inputSchema: { type: "object", required: ["runId"], properties: { runId: runIdProp } } },
  { name: "hrp_attention", description: "Qué debe hacer esta sesión ahora en el run. Con waitMs se bloquea hasta que haya una directiva accionable o terminal (máximo 600000). Úsalo en vez de terminar el turno mientras el run siga vivo.",
    inputSchema: { type: "object", required: ["runId"], properties: { runId: runIdProp, session: sessionProp, waitMs: { type: "number", description: "Milisegundos de espera (0 = respuesta inmediata)." } } } },
  { name: "hrp_release", description: "Suelta la atención de esta sesión en el run (antes de que cierre).",
    inputSchema: { type: "object", required: ["runId"], properties: { runId: runIdProp, session: sessionProp } } },
  { name: "hrp_list_runs", description: "Runs registrados, opcionalmente filtrados por workspace.",
    inputSchema: { type: "object", properties: { workspace: str("Ruta del proyecto.") } } },
  { name: "hrp_run_state", description: "Estado del run: fase, nodos, sesiones enganchadas, hallazgos y regla de cierre.",
    inputSchema: { type: "object", required: ["runId"], properties: { runId: runIdProp } } },
  { name: "hrp_run_issue", description: "El issue del run (requerimiento literal, interpretación, alcance, criterios, riesgos, adjuntos) con las rutas de los adjuntos.",
    inputSchema: { type: "object", required: ["runId"], properties: { runId: runIdProp } } },
  { name: "hrp_run_close", description: "Cierre del base: la máquina ejecuta los criterios de aceptación; si pasan, el run queda implementado y se avisa a los auditores para la pasada final.",
    inputSchema: { type: "object", required: ["runId"], properties: { runId: runIdProp, session: sessionProp } } },
  { name: "hrp_node_open", description: "Abre un nodo (archivo + símbolo + intención) ANTES de editar. Sólo el base. Con resolves enlaza el nodo como corrección de un hallazgo aceptado.",
    inputSchema: { type: "object", required: ["runId", "file", "symbol", "title", "description", "rationale"], properties: {
      runId: runIdProp, session: sessionProp, id: str("Id opcional (por defecto n1, n2, …)."),
      file: str("Ruta relativa al workspace."), symbol: str("Símbolo o sección lógica."), title: str("Qué hace, corto."),
      description: str("Qué hará exactamente."), rationale: str("Por qué es necesario."),
      dependencies: strList("Ids de nodos prerrequisito reales."), resolves: str("Id del hallazgo aceptado que corrige."),
    } } },
  { name: "hrp_node_verify", description: "La máquina ejecuta el comando de verificación en el workspace y guarda salida y exit code como evidencia del nodo.",
    inputSchema: { type: "object", required: ["runId", "nodeId", "command"], properties: { runId: runIdProp, session: sessionProp, nodeId: str("Id del nodo."), command: str("Comando de shell (exit 0 = aprobado).") } } },
  { name: "hrp_node_complete", description: "Completa el nodo: exige verificación aprobada, mide el diff del archivo con git y deja un commit en la rama del run.",
    inputSchema: { type: "object", required: ["runId", "nodeId", "summary"], properties: { runId: runIdProp, session: sessionProp, nodeId: str("Id del nodo."), summary: str("Qué hizo el parche."), rationale: str("Por qué se hizo así."), tokens: { type: "number", description: "Tokens aproximados gastados en el nodo." } } } },
  { name: "hrp_node_fail", description: "Marca un nodo en curso como fallido con su razón; abre otro que lo reemplace si hace falta.",
    inputSchema: { type: "object", required: ["runId", "nodeId", "reason"], properties: { runId: runIdProp, session: sessionProp, nodeId: str("Id del nodo."), reason: str("Qué falló.") } } },
  { name: "hrp_review_pack", description: "Paquete de auditoría: diffs, verificaciones y hallazgos previos. Con nodeIds se limita a esos nodos; sin ellos es la pasada de integración.",
    inputSchema: { type: "object", required: ["runId"], properties: { runId: runIdProp, nodeIds: strList("Nodos a auditar.") } } },
  { name: "hrp_finding_add", description: "Reporta un hallazgo. nodeId para un nodo concreto; scope=requirement para el issue; scope=integration para problemas entre nodos. Un hallazgo critical pone el run en hold.",
    inputSchema: { type: "object", required: ["runId", "severity", "title", "body"], properties: {
      runId: runIdProp, session: sessionProp, severity: { type: "string", enum: ["critical", "major", "minor", "question"] },
      title: str("Título."), body: str("Evidencia concreta: archivo, línea, qué falla y cómo reproducirlo."),
      nodeId: str("Nodo auditado."), scope: { type: "string", enum: ["requirement", "node", "integration"] },
    } } },
  { name: "hrp_finding_list", description: "Hallazgos del run, opcionalmente por estado.",
    inputSchema: { type: "object", required: ["runId"], properties: { runId: runIdProp, status: { type: "string", enum: ["open", "debating", "accepted", "rejected", "escalated"] } } } },
  { name: "hrp_finding_show", description: "Un hallazgo con su hilo completo.",
    inputSchema: { type: "object", required: ["findingId"], properties: { findingId: str("Id del hallazgo.") } } },
  { name: "hrp_finding_reply", description: "Responde en el hilo de un hallazgo (rebatir con evidencia, pedir precisión o aceptar la respuesta del otro).",
    inputSchema: { type: "object", required: ["findingId", "body"], properties: { findingId: str("Id del hallazgo."), body: str("Mensaje."), session: sessionProp } } },
  { name: "hrp_finding_accept", description: "El base acepta el hallazgo. Abre después el nodo de corrección con hrp_node_open (resolves) o pásalo aquí si ya existe.",
    inputSchema: { type: "object", required: ["findingId"], properties: { findingId: str("Id del hallazgo."), resolutionNodeId: str("Nodo que lo corrige, si ya existe."), note: str("Comentario para el hilo."), session: sessionProp } } },
  { name: "hrp_finding_reject", description: "El base rechaza el hallazgo con una razón técnica que queda en el hilo.",
    inputSchema: { type: "object", required: ["findingId", "reason"], properties: { findingId: str("Id del hallazgo."), reason: str("Razón verificable."), session: sessionProp } } },
  { name: "hrp_finding_escalate", description: "Escala al humano una duda genuina tras dos rondas sin evidencia nueva.",
    inputSchema: { type: "object", required: ["findingId", "reason"], properties: { findingId: str("Id del hallazgo."), reason: str("Qué no se puede decidir sin el humano."), session: sessionProp } } },
  { name: "hrp_finding_reopen", description: "Reabre un hallazgo cerrado aportando evidencia nueva.",
    inputSchema: { type: "object", required: ["findingId", "reason"], properties: { findingId: str("Id del hallazgo."), reason: str("Evidencia nueva."), session: sessionProp } } },
  { name: "hrp_audit_done", description: "Declara cobertura de auditoría: nodos revisados (aunque no hubiera hallazgos), requerimiento revisado, integración revisada.",
    inputSchema: { type: "object", required: ["runId"], properties: { runId: runIdProp, session: sessionProp, nodeIds: strList("Nodos revisados."), requirement: bool("Pasada del requerimiento hecha."), integration: bool("Pasada de integración hecha.") } } },
  { name: "hrp_audit_vote", description: "Voto final del auditor sobre un run implementado. Exige haber declarado la auditoría de todos los nodos ajenos. Con mayoría OK y sin hallazgos vivos el run cierra solo.",
    inputSchema: { type: "object", required: ["runId", "vote"], properties: { runId: runIdProp, session: sessionProp, vote: { type: "string", enum: ["ok", "reject"] }, detail: str("Qué quedó sin auditor independiente o por qué rechazas.") } } },
  { name: "hrp_activity", description: "Anota actividad operativa (inspección, comando, nota) visible en el panel. Nunca razonamiento privado.",
    inputSchema: { type: "object", required: ["runId", "message"], properties: { runId: runIdProp, session: sessionProp, type: { type: "string", enum: ["run", "session", "node", "verify", "finding", "audit", "note"] }, message: str("Mensaje corto."), detail: str("Detalle."), nodeId: str("Nodo relacionado.") } } },
];

function text(args: Record<string, unknown>, key: string, required = true): string {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (required) throw new Error(`Falta ${key}`);
  return "";
}

function optionalList(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  return Array.isArray(value) ? value.map(String) : undefined;
}

function summarizeRun(detail: RunDetail): Record<string, unknown> {
  const { run } = detail;
  return {
    id: run.id, title: run.title, phase: run.phase, control: run.control, branch: run.branch, base: run.base,
    workspaceRoot: detail.project.workspaceRoot, issuePath: run.issuePath, attachments: run.attachments,
    nodes: detail.nodes.map((node) => ({ id: node.id, status: node.status, file: node.file, symbol: node.symbol, title: node.title, author: node.author, dependencies: node.dependencies, auditedBy: node.auditedBy, commit: node.commit?.slice(0, 10), failure: node.failure })),
    sessions: detail.sessions.map((session) => ({ id: session.id, role: session.role, status: session.status, reviewed: session.reviewedNodeIds, requirementReviewed: session.requirementReviewed, vote: session.vote })),
    findings: detail.findings.map((finding) => ({ id: finding.id, status: finding.status, severity: finding.severity, scope: finding.scope, nodeId: finding.nodeId, title: finding.title, reviewer: finding.reviewer, resolutionNodeId: finding.resolutionNodeId })),
    acceptance: run.acceptance,
    audit: run.audit,
    attentionCommand: attentionCommand(run.id),
  };
}

export async function executeHrpTool(client: HrpMcpClient, toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const runId = () => text(args, "runId");
  const encoded = (value: string) => encodeURIComponent(value);
  const post = <T,>(endpoint: string, body: unknown) => client.request<T>(endpoint, { method: "POST", body: JSON.stringify(body) });

  switch (toolName) {
    case "hrp_service_start":
      return client.startService(text(args, "workspace", false) || process.cwd());
    case "hrp_service_status":
      return client.getStatus();

    case "hrp_run_start": {
      const workspace = path.resolve(text(args, "workspace", false) || process.cwd());
      await client.startService(workspace);
      const project = await post<{ id: string }>("/api/projects", { workspaceRoot: workspace });
      const input = {
        title: text(args, "title"),
        requirement: text(args, "requirement"),
        interpretation: text(args, "interpretation"),
        scopeIncludes: optionalList(args, "scopeIncludes"),
        scopeExcludes: optionalList(args, "scopeExcludes"),
        acceptance: Array.isArray(args.acceptance) ? args.acceptance : [],
        risks: optionalList(args, "risks"),
        attachments: Array.isArray(args.attachments) ? args.attachments : undefined,
      };
      const started = await post<{ run: RunSummary; session: Session }>(`/api/projects/${encoded(project.id)}/runs`, { family: client.family, hostPids: ancestorPids(), input });
      client.identities.set(started.run.id, started.session.id);
      const url = panelUrl(client.baseUrl, project.id, started.run.id);
      return [
        `Run ${started.run.id} abierto. Tu identidad en este run es ${started.session.id} (base). Rama: ${started.run.branch}.`,
        "",
        "Dile al humano, una sola vez y tal cual:",
        `- Para enganchar otra sesión (Claude, Codex, Antigravity): ${attentionCommand(started.run.id)}`,
        `- Para un runner sin sesión (ollama): ${runnerCommand(started.run.id)}`,
        `- Panel: ${url}`,
        "",
        `Issue: ${started.run.issuePath}. Ahora implementa: abre cada nodo con hrp_node_open antes de editar, verifica con hrp_node_verify, completa con hrp_node_complete. Entre nodos revisa hrp_attention (waitMs 0). Al terminar, hrp_run_close.`,
      ].join("\n");
    }

    case "hrp_attach": {
      const id = runId();
      const session = await post<Session>(`/api/runs/${encoded(id)}/sessions`, { family: client.family, hostPids: ancestorPids() });
      client.identities.set(id, session.id);
      const signal = await client.request<{ kind: string; directive: string; workspaceRoot: string; branch: string }>(`/api/attention?session=${encoded(session.id)}&runId=${encoded(id)}`);
      return [
        `Enganchado a ${id} como ${session.id} (auditor). Workspace: ${signal.workspaceRoot} · rama ${signal.branch}.`,
        `Mantente atento hasta que hrp_attention responda released: entre pasadas llama hrp_attention con waitMs 600000 en vez de terminar el turno.`,
        "",
        `Directiva actual [${signal.kind}]: ${signal.directive}`,
      ].join("\n");
    }

    case "hrp_attention": {
      const id = runId();
      const session = client.sessionFor(args, id);
      const waitMs = Math.min(Math.max(Number(args.waitMs ?? 0) || 0, 0), 600_000);
      return client.request(`/api/attention?session=${encoded(session)}&runId=${encoded(id)}&waitMs=${waitMs}`);
    }

    case "hrp_release": {
      const id = runId();
      const session = client.sessionFor(args, id);
      const released = await post<Session>(`/api/runs/${encoded(id)}/sessions/${encoded(session)}/release`, {});
      client.identities.delete(id);
      return released;
    }

    case "hrp_list_runs": {
      const workspace = text(args, "workspace", false);
      const { runs } = await client.request<{ runs: RunSummary[] }>("/api/runs");
      const { projects } = await client.request<{ projects: Array<{ id: string; workspaceRoot: string }> }>("/api/projects");
      const filtered = workspace ? runs.filter((run) => projects.find((project) => project.id === run.projectId)?.workspaceRoot === path.resolve(workspace)) : runs;
      return filtered.map((run) => ({ id: run.id, title: run.title, phase: run.phase, control: run.control, workspaceRoot: projects.find((project) => project.id === run.projectId)?.workspaceRoot, sessions: run.attachedSessions, updatedAt: run.updatedAt }));
    }

    case "hrp_run_state":
      return summarizeRun(await client.request<RunDetail>(`/api/runs/${encoded(runId())}`));

    case "hrp_run_issue": {
      const detail = await client.request<RunDetail>(`/api/runs/${encoded(runId())}`);
      const directory = path.dirname(detail.run.issuePath);
      return [
        detail.issue,
        "",
        detail.run.attachments.length ? `Adjuntos (rutas locales legibles por cualquier modelo):\n${detail.run.attachments.map((file) => `- ${path.join(directory, file)}`).join("\n")}` : "Sin adjuntos.",
        `Workspace: ${detail.project.workspaceRoot} · rama ${detail.run.branch}`,
      ].join("\n");
    }

    case "hrp_run_close": {
      const id = runId();
      const result = await post<{ run: RunSummary; acceptance: RunSummary["acceptance"]; passed: boolean }>(`/api/runs/${encoded(id)}/close`, { actor: client.sessionFor(args, id) });
      const lines = result.acceptance.map((criterion) => `- ${criterion.text}${criterion.result ? ` → ${criterion.result.passed ? "pasó" : `FALLÓ (exit ${criterion.result.exitCode})\n${criterion.result.output.slice(-1500)}`}` : ""}`);
      return result.passed
        ? `Implementación cerrada; el run está ${result.run.phase}. Los auditores harán la pasada final. ${result.run.audit.blockers.length ? `Bloquea el cierre: ${result.run.audit.blockers.join("; ")}.` : ""}\n${lines.join("\n")}\nQuédate atento con hrp_attention (waitMs 600000): los hallazgos de integración llegan por ahí.`
        : `El cierre no procede: hay criterios fallidos. Corrige en nodos nuevos y vuelve a cerrar.\n${lines.join("\n")}`;
    }

    case "hrp_node_open": {
      const id = runId();
      return post(`/api/runs/${encoded(id)}/nodes`, {
        actor: client.sessionFor(args, id),
        id: text(args, "id", false) || undefined,
        file: text(args, "file"), symbol: text(args, "symbol"), title: text(args, "title"),
        description: text(args, "description"), rationale: text(args, "rationale"),
        dependencies: optionalList(args, "dependencies"), resolves: text(args, "resolves", false) || undefined,
      });
    }
    case "hrp_node_verify": {
      const id = runId();
      return post(`/api/runs/${encoded(id)}/nodes/${encoded(text(args, "nodeId"))}/verify`, { actor: client.sessionFor(args, id), command: text(args, "command") });
    }
    case "hrp_node_complete": {
      const id = runId();
      return post(`/api/runs/${encoded(id)}/nodes/${encoded(text(args, "nodeId"))}/complete`, {
        actor: client.sessionFor(args, id), summary: text(args, "summary"), rationale: text(args, "rationale", false) || undefined,
        tokens: typeof args.tokens === "number" ? args.tokens : undefined,
      });
    }
    case "hrp_node_fail": {
      const id = runId();
      return post(`/api/runs/${encoded(id)}/nodes/${encoded(text(args, "nodeId"))}/fail`, { actor: client.sessionFor(args, id), reason: text(args, "reason") });
    }

    case "hrp_review_pack": {
      const nodeIds = optionalList(args, "nodeIds") ?? [];
      return client.request<string>(`/api/runs/${encoded(runId())}/review-pack${nodeIds.length ? `?nodeIds=${encoded(nodeIds.join(","))}` : ""}`);
    }

    case "hrp_finding_add": {
      const id = runId();
      return post(`/api/runs/${encoded(id)}/findings`, {
        reviewer: client.sessionFor(args, id), severity: text(args, "severity"), title: text(args, "title"), body: text(args, "body"),
        nodeId: text(args, "nodeId", false) || undefined, scope: text(args, "scope", false) || undefined,
      });
    }
    case "hrp_finding_list": {
      const { findings } = await client.request<{ findings: Finding[] }>(`/api/runs/${encoded(runId())}/findings`);
      const status = text(args, "status", false);
      return (status ? findings.filter((finding) => finding.status === status) : findings)
        .map((finding) => ({ id: finding.id, status: finding.status, severity: finding.severity, scope: finding.scope, nodeId: finding.nodeId, title: finding.title, reviewer: finding.reviewer, messages: finding.messages.length, resolutionNodeId: finding.resolutionNodeId }));
    }
    case "hrp_finding_show":
      return client.request(`/api/findings/${encoded(text(args, "findingId"))}`);

    case "hrp_finding_reply":
    case "hrp_finding_accept":
    case "hrp_finding_reject":
    case "hrp_finding_escalate":
    case "hrp_finding_reopen": {
      const findingId = text(args, "findingId");
      const finding = await client.request<Finding>(`/api/findings/${encoded(findingId)}`);
      const session = client.sessionFor(args, finding.runId);
      switch (toolName) {
        case "hrp_finding_reply": return post(`/api/findings/${encoded(findingId)}/messages`, { author: session, body: text(args, "body") });
        case "hrp_finding_accept": return post(`/api/findings/${encoded(findingId)}/accept`, { actor: session, resolutionNodeId: text(args, "resolutionNodeId", false) || undefined, note: text(args, "note", false) || undefined });
        case "hrp_finding_reject": return post(`/api/findings/${encoded(findingId)}/reject`, { actor: session, reason: text(args, "reason") });
        case "hrp_finding_escalate": return post(`/api/findings/${encoded(findingId)}/escalate`, { actor: session, reason: text(args, "reason") });
        default: return post(`/api/findings/${encoded(findingId)}/reopen`, { author: session, reason: text(args, "reason") });
      }
    }

    case "hrp_audit_done": {
      const id = runId();
      return post(`/api/runs/${encoded(id)}/sessions/${encoded(client.sessionFor(args, id))}/audit`, {
        nodeIds: optionalList(args, "nodeIds"), requirement: args.requirement === true, integration: args.integration === true,
      });
    }
    case "hrp_audit_vote": {
      const id = runId();
      const result = await post<{ session: Session; run: RunSummary }>(`/api/runs/${encoded(id)}/sessions/${encoded(client.sessionFor(args, id))}/vote`, { vote: text(args, "vote"), detail: text(args, "detail", false) || undefined });
      return result.run.status === "closed"
        ? `Voto registrado. El run ${id} cerró: auditoría completa. Suelta la atención; no queda nada que hacer.`
        : `Voto registrado. El run sigue ${result.run.phase}; bloquea el cierre: ${result.run.audit.blockers.join("; ") || "nada"}. Sigue atento con hrp_attention (waitMs 600000).`;
    }

    case "hrp_activity": {
      const id = runId();
      return post(`/api/runs/${encoded(id)}/activity`, {
        type: text(args, "type", false) || "note", message: text(args, "message"), detail: text(args, "detail", false) || undefined,
        nodeId: text(args, "nodeId", false) || undefined, agent: client.identities.get(id),
      });
    }

    default:
      throw new Error(`Herramienta desconocida: ${toolName}`);
  }
}
