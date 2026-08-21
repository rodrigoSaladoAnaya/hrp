import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ActivityType, ChangeNodeInput, FindingInput, FindingStatus } from "../shared/protocol.js";

function findHrpRoot(start: string): string {
  let current = start;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(current, "package.json")) && existsSync(path.join(current, "bin/hrp.mjs"))) {
      return current;
    }
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
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

export class HrpMcpClient {
  constructor(
    readonly baseUrl: string = process.env.HRP_URL ?? "http://127.0.0.1:4317",
    readonly dataDir: string = path.resolve(process.env.HRP_DATA_DIR ?? path.join(os.homedir(), ".hrp-v2")),
    readonly port: number = Number(process.env.HRP_PORT ?? 4317),
  ) {}

  async request<T = unknown>(endpoint: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    }).catch((error: Error) => {
      throw new Error(`HRP no responde en ${this.baseUrl}: ${error.message}`);
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `${response.status} ${response.statusText}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  async isHealthy(): Promise<boolean> {
    return fetch(`${this.baseUrl}/api/health`)
      .then((res) => res.ok)
      .catch(() => false);
  }

  async startService(workspace?: string): Promise<{ status: string; url: string; dataDir: string }> {
    if (await this.isHealthy()) {
      if (workspace) {
        await this.request("/api/projects", {
          method: "POST",
          body: JSON.stringify({ workspaceRoot: path.resolve(workspace) }),
        });
      }
      return { status: "already_running", url: this.baseUrl, dataDir: this.dataDir };
    }

    const entry = path.join(root, "dist/server/server/index.js");
    if (!existsSync(entry)) {
      throw new Error(`Falta el build del servidor HRP en ${entry}. Ejecuta npm run build.`);
    }

    const runtime = path.join(this.dataDir, "runtime");
    mkdirSync(runtime, { recursive: true });
    const logPath = path.join(runtime, "server.log");
    const log = openSync(logPath, "a");
    const args = [entry, "--port", String(this.port), "--data-dir", this.dataDir];
    if (workspace) {
      args.push("--workspace", path.resolve(workspace));
    }

    const child = spawn(process.execPath, args, {
      cwd: root,
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    writeFileSync(path.join(runtime, "server.pid"), String(child.pid));

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await this.isHealthy()) {
        return { status: "started", url: this.baseUrl, dataDir: this.dataDir };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`HRP no pudo iniciar. Revisa ${logPath}`);
  }

  async getStatus(): Promise<Record<string, unknown>> {
    const isHealthy = await this.isHealthy();
    if (!isHealthy) {
      return { status: "stopped", url: this.baseUrl, dataDir: this.dataDir };
    }
    const projectsResponse = await this.request<{ projects: unknown[] }>("/api/projects");
    return {
      status: "running",
      url: this.baseUrl,
      dataDir: this.dataDir,
      projectCount: projectsResponse.projects.length,
    };
  }

  // Un servidor MCP lo lanza el host, no el usuario: su process.cwd() puede ser
  // el directorio del plugin en caché en vez del proyecto observado. Registrar
  // eso como workspace crearía un proyecto fantasma y correría las
  // verificaciones fuera del repo, en silencio. La ruta explícita del agente
  // siempre se respeta; el guardia sólo cubre el valor por omisión.
  private defaultWorkspace(): string {
    const cwd = process.cwd();
    if (cwd.split(path.sep).join("/").includes("/plugins/cache/")) {
      throw new Error(`El servidor MCP está corriendo desde la caché de un plugin (${cwd}); indica workspaceRoot explícitamente con la carpeta del proyecto observado`);
    }
    return cwd;
  }

  async attach(workspaceRoot?: string): Promise<unknown> {
    return this.request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ workspaceRoot: path.resolve(workspaceRoot ?? this.defaultWorkspace()) }),
    });
  }

  async resolveProjectId(projectId?: string, workspaceRoot?: string): Promise<string> {
    if (projectId) return projectId;
    const project = (await this.attach(workspaceRoot)) as { id: string };
    return project.id;
  }

  async listProjects(): Promise<unknown> {
    return this.request("/api/projects");
  }

  async createRun(params: { title: string; requirement: string; projectId?: string; workspaceRoot?: string; agent?: string }): Promise<unknown> {
    const projectId = await this.resolveProjectId(params.projectId, params.workspaceRoot);
    const body: Record<string, string> = { title: params.title, requirement: params.requirement };
    if (params.agent) body.agent = params.agent;
    return this.request(`/api/projects/${projectId}/runs`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async listRuns(params: { projectId?: string; workspaceRoot?: string }): Promise<unknown> {
    const projectId = await this.resolveProjectId(params.projectId, params.workspaceRoot);
    return this.request(`/api/projects/${projectId}/runs`);
  }

  async getRunState(runId: string): Promise<unknown> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}`);
  }

  // Espera bloqueante: el servidor no responde hasta tener algo que decirle a
  // este agente. Es el despertador de los entornos sin hooks nativos. La espera
  // se parte en tramos porque el fetch de Node aborta a los 300s de espera de
  // cabeceras, no porque el protocolo lo exija.
  async attention(params: { agent: string; runId?: string; workspace?: string; waitSeconds?: number }): Promise<Record<string, unknown>> {
    const chunkMs = 240_000;
    const deadline = Date.now() + Math.min(Math.max(params.waitSeconds ?? 0, 0), 600) * 1000;
    for (;;) {
      const remaining = Math.max(deadline - Date.now(), 0);
      const query = new URLSearchParams({ agent: params.agent });
      if (params.runId) query.set("runId", params.runId);
      if (params.workspace) query.set("workspace", path.resolve(params.workspace));
      if (remaining > 0) query.set("waitMs", String(Math.min(remaining, chunkMs)));
      const signal = await this.request<Record<string, unknown>>(`/api/attention?${query}`);
      if (signal.actionable || signal.terminal || Date.now() >= deadline) return signal;
    }
  }

  async publishGraph(runId: string, nodes: ChangeNodeInput[]): Promise<unknown> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/graph`, {
      method: "POST",
      body: JSON.stringify({ nodes }),
    });
  }

  async discoverNode(runId: string, node: ChangeNodeInput): Promise<unknown> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/nodes`, {
      method: "POST",
      body: JSON.stringify(node),
    });
  }

  async approveNodes(runId: string, nodeIds?: string[]): Promise<unknown> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/approve`, {
      method: "POST",
      body: JSON.stringify(nodeIds && nodeIds.length > 0 ? { nodeIds } : {}),
    });
  }

  async assignNode(runId: string, nodeId: string, assignee: string | null): Promise<unknown> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/assign`, {
      method: "POST",
      body: JSON.stringify({ assignee }),
    });
  }

  async startNode(runId: string, nodeId: string, agent?: string): Promise<unknown> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/start`, {
      method: "POST",
      body: JSON.stringify(agent ? { agent } : {}),
    });
  }

  async publishPatch(runId: string, nodeId: string, params: { summary: string; diff: string; rationale?: string }): Promise<unknown> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/patch`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async verifyRun(runId: string, nodeId: string, params: { command: string; args?: string[]; cwd?: string }): Promise<unknown> {
    const cwd = params.cwd ? path.resolve(params.cwd) : this.defaultWorkspace();
    const commandArgs = params.args ?? [];
    const execution = spawnSync(params.command, commandArgs, {
      cwd,
      encoding: "utf8",
      shell: false,
    });

    const output = `${execution.stdout ?? ""}${execution.stderr ?? ""}`;
    const exitCode = execution.status ?? (execution.error ? 1 : 0);

    const recorded = await this.request(`/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/verify`, {
      method: "POST",
      body: JSON.stringify({
        command: [params.command, ...commandArgs].join(" "),
        output,
        exitCode,
      }),
    });

    return {
      recorded,
      command: [params.command, ...commandArgs].join(" "),
      output,
      exitCode,
      passed: exitCode === 0,
    };
  }

  async completeNode(runId: string, nodeId: string): Promise<unknown> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/complete`, {
      method: "POST",
      body: "{}",
    });
  }

  async publishActivity(runId: string, params: { type: ActivityType; message: string; detail?: string; nodeId?: string; agent?: string }): Promise<unknown> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/activity`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async reviewPack(runId: string, nodeId?: string, agent?: string): Promise<string> {
    const params = new URLSearchParams();
    if (nodeId) params.set("nodeId", nodeId);
    if (agent) params.set("agent", agent);
    const query = params.toString() ? `?${params}` : "";
    const response = await fetch(`${this.baseUrl}/api/runs/${encodeURIComponent(runId)}/review-pack${query}`)
      .catch((error: Error) => {
        throw new Error(`HRP no responde en ${this.baseUrl}: ${error.message}`);
      });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `${response.status} ${response.statusText}`);
    }
    return response.text();
  }

  async reviewGate(runId: string): Promise<unknown> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/review-gate`);
  }

  async listFindings(runId: string): Promise<unknown> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/findings`);
  }

  async getFinding(findingId: string): Promise<unknown> {
    return this.request(`/api/findings/${encodeURIComponent(findingId)}`);
  }

  async addFinding(runId: string, input: FindingInput): Promise<unknown> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/findings`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async replyFinding(findingId: string, author: string, body: string): Promise<unknown> {
    return this.request(`/api/findings/${encodeURIComponent(findingId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ author, body }),
    });
  }

  async setFindingStatus(findingId: string, status: FindingStatus, resolutionNodeId?: string): Promise<unknown> {
    return this.request(`/api/findings/${encodeURIComponent(findingId)}/status`, {
      method: "POST",
      body: JSON.stringify({ status, ...(resolutionNodeId ? { resolutionNodeId } : {}) }),
    });
  }

  async reopenFinding(findingId: string, author: string, body: string): Promise<unknown> {
    await this.replyFinding(findingId, author, body);
    return this.setFindingStatus(findingId, "open");
  }
}

export const hrpToolDefinitions: McpToolDefinition[] = [
  {
    name: "hrp_service_start",
    description: "Inicia el servicio local HRP si no está activo.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Ruta opcional de workspace a vincular al iniciar.",
        },
      },
    },
  },
  {
    name: "hrp_service_status",
    description: "Consulta el estado del servicio local HRP (URL, carpeta de datos y proyectos).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "hrp_attach",
    description: "Registra la carpeta del workspace en HRP y devuelve el proyecto canónico.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: {
          type: "string",
          description: "Ruta absoluta o relativa del proyecto. Por defecto usa la carpeta actual.",
        },
      },
    },
  },
  {
    name: "hrp_list_projects",
    description: "Lista todos los proyectos registrados en HRP.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "hrp_create_run",
    description: "Crea una ejecución (run) para un requerimiento humano en HRP.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Título conciso de la ejecución.",
        },
        requirement: {
          type: "string",
          description: "Requerimiento humano original completo o resumido fielmente.",
        },
        projectId: {
          type: "string",
          description: "ID del proyecto. Si se omite, se deduce del workspace actual.",
        },
        agent: {
          type: "string",
          description: "Identidad del agente creador (opcional).",
        },
      },
      required: ["title", "requirement"],
    },
  },
  {
    name: "hrp_list_runs",
    description: "Lista las ejecuciones existentes de un proyecto.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "ID opcional del proyecto. Si se omite, se deduce del workspace actual.",
        },
      },
    },
  },
  {
    name: "hrp_get_state",
    description: "Obtiene el estado completo de una ejecución (resumen, nodos, aprobaciones, diffs, verificaciones y actividad).",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Identificador de la ejecución.",
        },
      },
      required: ["runId"],
    },
  },
  {
    name: "hrp_attention",
    description: "Espera bloqueante hasta que HRP tenga trabajo para este agente: nodos aprobados que ya puede iniciar, hallazgos que debe responder, auditoría disponible o cierre pendiente. Úsala en lugar de terminar el turno cuando la ejecución sigue viva; es la forma de no quedarse ciego sin que el humano tenga que avisar. Devuelve la señal con su directiva accionable.",
    inputSchema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: "Identidad del agente que espera (claude, codex, antigravity...).",
        },
        runId: {
          type: "string",
          description: "Ejecución concreta. Si se omite, vigila todas las ejecuciones donde participa el agente.",
        },
        workspace: {
          type: "string",
          description: "Carpeta del proyecto observado para acotar la espera a sus ejecuciones.",
        },
        waitSeconds: {
          type: "number",
          description: "Segundos máximos de espera (0 a 600; por omisión 300). Con 0 responde de inmediato con la señal actual.",
        },
      },
      required: ["agent"],
    },
  },
  {
    name: "hrp_publish_graph",
    description: "Publica el grafo de nodos de cambio semánticos para una ejecución antes de editar código.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Identificador de la ejecución.",
        },
        nodes: {
          type: "array",
          description: "Lista de nodos semánticos (un nodo por archivo + símbolo/sección + intención).",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "ID único y alfanumérico del nodo (ej: theme-config)." },
              file: { type: "string", description: "Ruta del archivo relativa al workspace." },
              symbol: { type: "string", description: "Símbolo, función, componente o sección lógica a modificar." },
              title: { type: "string", description: "Título breve de la operación." },
              description: { type: "string", description: "Qué hará esta operación." },
              rationale: { type: "string", description: "Por qué es necesaria para el requerimiento." },
              dependencies: {
                type: "array",
                items: { type: "string" },
                description: "IDs de nodos previos que deben completarse antes de este nodo.",
              },
            },
            required: ["id", "file", "symbol", "title", "description", "rationale", "dependencies"],
          },
        },
      },
      required: ["runId", "nodes"],
    },
  },
  {
    name: "hrp_discover_node",
    description: "Publica un nuevo nodo descubierto durante la implementación que no estaba en el grafo inicial. Queda aprobado automáticamente y asignado (al modelo base o al agente sugerido), así que puede iniciarse de inmediato: el gate humano solo rige para el grafo inicial.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Identificador de la ejecución.",
        },
        node: {
          type: "object",
          description: "Nodo semántico descubierto.",
          properties: {
            id: { type: "string", description: "ID único del nodo descubierto." },
            file: { type: "string", description: "Ruta relativa del archivo." },
            symbol: { type: "string", description: "Símbolo o sección lógica." },
            title: { type: "string", description: "Título breve." },
            description: { type: "string", description: "Qué hará la operación descubierta." },
            rationale: { type: "string", description: "Por qué fue descubierta y por qué es necesaria." },
            dependencies: {
              type: "array",
              items: { type: "string" },
              description: "IDs de prerrequisitos.",
            },
          },
          required: ["id", "file", "symbol", "title", "description", "rationale", "dependencies"],
        },
      },
      required: ["runId", "node"],
    },
  },
  {
    name: "hrp_approve_nodes",
    description: "Aprueba todos los nodos pendientes de una ejecución o una lista específica de IDs.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Identificador de la ejecución.",
        },
        nodeIds: {
          type: "array",
          items: { type: "string" },
          description: "IDs específicos de nodos a aprobar. Si no se especifica, aprueba todos los pendientes.",
        },
      },
      required: ["runId"],
    },
  },
  {
    name: "hrp_assign_node",
    description: "Asigna un nodo a un agente o elimina la asignación actual.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Identificador de la ejecución.",
        },
        nodeId: {
          type: "string",
          description: "Identificador del nodo.",
        },
        assignee: {
          type: ["string", "null"],
          description: "Nombre del agente asignado o null para desasignar.",
        },
      },
      required: ["runId", "nodeId", "assignee"],
    },
  },
  {
    name: "hrp_start_node",
    description: "Inicia la ejecución de un nodo. Requiere que sus dependencias estén completadas y que esté aprobado.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Identificador de la ejecución.",
        },
        nodeId: {
          type: "string",
          description: "Identificador del nodo a iniciar.",
        },
        agent: {
          type: "string",
          description: "Identidad del agente que realiza el trabajo; si se omite, HRP usa la asignación del nodo o el modelo base.",
        },
      },
      required: ["runId", "nodeId"],
    },
  },
  {
    name: "hrp_publish_patch",
    description: "Publica el diff atribuible exclusivamente a este nodo, con resumen y rationale del cambio.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Identificador de la ejecución.",
        },
        nodeId: {
          type: "string",
          description: "Identificador del nodo.",
        },
        summary: {
          type: "string",
          description: "Resumen factual de lo que se modificó.",
        },
        diff: {
          type: "string",
          description: "Contenido del diff unificado atribuible exclusivamente a este nodo.",
        },
        rationale: {
          type: "string",
          description: "Explicación operativa de por qué el cambio tomó esta forma específica.",
        },
      },
      required: ["runId", "nodeId", "summary", "diff"],
    },
  },
  {
    name: "hrp_verify_run",
    description: "Ejecuta un comando de verificación en el workspace, captura salida y código de salida y lo publica en HRP.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Identificador de la ejecución.",
        },
        nodeId: {
          type: "string",
          description: "Identificador del nodo.",
        },
        command: {
          type: "string",
          description: "Comando a ejecutar (ej: 'npm', 'vitest', 'cargo').",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Argumentos del comando (ej: ['test', 'src/my.test.ts']).",
        },
        cwd: {
          type: "string",
          description: "Directorio de trabajo opcional.",
        },
      },
      required: ["runId", "nodeId", "command"],
    },
  },
  {
    name: "hrp_complete_node",
    description: "Completa un nodo. Requiere que tenga un parche publicado y una verificación aprobada (exitCode 0).",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Identificador de la ejecución.",
        },
        nodeId: {
          type: "string",
          description: "Identificador del nodo a completar.",
        },
      },
      required: ["runId", "nodeId"],
    },
  },
  {
    name: "hrp_retry_node",
    description: "Reintenta un nodo que haya fallado tras investigar y corregir el problema.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Identificador de la ejecución.",
        },
        nodeId: {
          type: "string",
          description: "Identificador del nodo a reintentar.",
        },
        agent: {
          type: "string",
          description: "Identidad del agente; si se omite, HRP usa la asignación del nodo o el modelo base.",
        },
      },
      required: ["runId", "nodeId"],
    },
  },
  {
    name: "hrp_publish_activity",
    description: "Publica una entrada en la línea de tiempo de actividad de HRP (inspección, nota técnica o decisión).",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Identificador de la ejecución.",
        },
        type: {
          type: "string",
          enum: ["run", "graph", "inspect", "node", "patch", "verify", "note"],
          description: "Tipo de actividad.",
        },
        message: {
          type: "string",
          description: "Resumen breve y directo de la observación.",
        },
        detail: {
          type: "string",
          description: "Detalle técnico adicional opcional.",
        },
        nodeId: {
          type: "string",
          description: "ID opcional del nodo relacionado.",
        },
        agent: {
          type: "string",
          description: "Identidad del agente que registra la actividad (opcional).",
        },
      },
      required: ["runId", "type", "message"],
    },
  },
  {
    name: "hrp_review_pack",
    description: "Genera el paquete Markdown para auditar una ejecución completa o el subárbol de un nodo.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Identificador de la ejecución." },
        nodeId: { type: "string", description: "Nodo raíz opcional para limitar el paquete." },
        agent: { type: "string", description: "Identidad del auditor que solicita el paquete (opcional)." },
      },
      required: ["runId"],
    },
  },
  {
    name: "hrp_review_gate",
    description: "Consulta los hallazgos vivos y auditores pendientes que impiden cerrar una ejecución.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Identificador de la ejecución." },
      },
      required: ["runId"],
    },
  },
  {
    name: "hrp_finding_add",
    description: "Registra un hallazgo de auditoría con severidad, evidencia y nodo opcional.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Identificador de la ejecución." },
        reviewer: { type: "string", description: "Agente que registra el hallazgo." },
        severity: { type: "string", enum: ["critical", "major", "minor", "question"] },
        title: { type: "string", description: "Título concreto del problema." },
        body: { type: "string", description: "Evidencia y efecto técnico del problema." },
        nodeId: { type: "string", description: "Nodo relacionado opcional." },
      },
      required: ["runId", "reviewer", "severity", "title", "body"],
    },
  },
  {
    name: "hrp_finding_list",
    description: "Lista los hallazgos de una ejecución.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Identificador de la ejecución." },
      },
      required: ["runId"],
    },
  },
  {
    name: "hrp_finding_show",
    description: "Obtiene un hallazgo y su hilo completo de debate.",
    inputSchema: {
      type: "object",
      properties: {
        findingId: { type: "string", description: "Identificador del hallazgo." },
      },
      required: ["findingId"],
    },
  },
  {
    name: "hrp_finding_reply",
    description: "Añade una respuesta auditable al debate de un hallazgo.",
    inputSchema: {
      type: "object",
      properties: {
        findingId: { type: "string", description: "Identificador del hallazgo." },
        author: { type: "string", description: "Agente que responde." },
        body: { type: "string", description: "Respuesta técnica." },
      },
      required: ["findingId", "author", "body"],
    },
  },
  {
    name: "hrp_finding_accept",
    description: "Acepta un hallazgo y lo vincula opcionalmente con su nodo de corrección.",
    inputSchema: {
      type: "object",
      properties: {
        findingId: { type: "string", description: "Identificador del hallazgo." },
        resolutionNodeId: { type: "string", description: "Nodo que resuelve el hallazgo." },
      },
      required: ["findingId"],
    },
  },
  {
    name: "hrp_finding_reject",
    description: "Rechaza un hallazgo después de publicar una razón técnica en su hilo.",
    inputSchema: {
      type: "object",
      properties: {
        findingId: { type: "string", description: "Identificador del hallazgo." },
        author: { type: "string", description: "Agente que rechaza." },
        body: { type: "string", description: "Razón técnica obligatoria." },
      },
      required: ["findingId", "author", "body"],
    },
  },
  {
    name: "hrp_finding_reopen",
    description: "Reabre un hallazgo cerrado con autor y razón técnica para reiniciar el consenso de auditoría.",
    inputSchema: {
      type: "object",
      properties: {
        findingId: { type: "string", description: "Identificador del hallazgo." },
        author: { type: "string", description: "Agente que reabre el debate." },
        body: { type: "string", description: "Razón técnica de la reapertura." },
      },
      required: ["findingId", "author", "body"],
    },
  },
  {
    name: "hrp_finding_escalate",
    description: "Escala al humano un hallazgo que los agentes no pueden resolver.",
    inputSchema: {
      type: "object",
      properties: {
        findingId: { type: "string", description: "Identificador del hallazgo." },
      },
      required: ["findingId"],
    },
  },
];

export async function executeHrpTool(
  client: HrpMcpClient,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  switch (toolName) {
    case "hrp_service_start":
      return client.startService(typeof args.workspace === "string" ? args.workspace : undefined);

    case "hrp_service_status":
      return client.getStatus();

    case "hrp_attach":
      return client.attach(typeof args.workspaceRoot === "string" ? args.workspaceRoot : undefined);

    case "hrp_list_projects":
      return client.listProjects();

    case "hrp_create_run":
      return client.createRun({
        title: String(args.title),
        requirement: String(args.requirement),
        projectId: typeof args.projectId === "string" ? args.projectId : undefined,
        agent: typeof args.agent === "string" ? args.agent : undefined,
      });

    case "hrp_list_runs":
      return client.listRuns({
        projectId: typeof args.projectId === "string" ? args.projectId : undefined,
      });

    case "hrp_get_state":
      return client.getRunState(String(args.runId));

    case "hrp_attention":
      return client.attention({
        agent: String(args.agent),
        runId: typeof args.runId === "string" ? args.runId : undefined,
        workspace: typeof args.workspace === "string" ? args.workspace : undefined,
        waitSeconds: typeof args.waitSeconds === "number" ? args.waitSeconds : 300,
      });

    case "hrp_publish_graph":
      return client.publishGraph(String(args.runId), args.nodes as ChangeNodeInput[]);

    case "hrp_discover_node":
      return client.discoverNode(String(args.runId), args.node as ChangeNodeInput);

    case "hrp_approve_nodes":
      return client.approveNodes(
        String(args.runId),
        Array.isArray(args.nodeIds) ? (args.nodeIds as string[]) : undefined,
      );

    case "hrp_assign_node":
      return client.assignNode(
        String(args.runId),
        String(args.nodeId),
        args.assignee === null ? null : String(args.assignee),
      );

    case "hrp_start_node":
      return client.startNode(
        String(args.runId),
        String(args.nodeId),
        typeof args.agent === "string" ? args.agent : undefined,
      );

    case "hrp_publish_patch":
      return client.publishPatch(String(args.runId), String(args.nodeId), {
        summary: String(args.summary),
        diff: String(args.diff),
        rationale: typeof args.rationale === "string" ? args.rationale : undefined,
      });

    case "hrp_verify_run":
      return client.verifyRun(String(args.runId), String(args.nodeId), {
        command: String(args.command),
        args: Array.isArray(args.args) ? (args.args as string[]) : undefined,
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
      });

    case "hrp_complete_node":
      return client.completeNode(String(args.runId), String(args.nodeId));

    case "hrp_retry_node":
      return client.startNode(
        String(args.runId),
        String(args.nodeId),
        typeof args.agent === "string" ? args.agent : undefined,
      );

    case "hrp_publish_activity":
      return client.publishActivity(String(args.runId), {
        type: args.type as ActivityType,
        message: String(args.message),
        detail: typeof args.detail === "string" ? args.detail : undefined,
        nodeId: typeof args.nodeId === "string" ? args.nodeId : undefined,
        agent: typeof args.agent === "string" ? args.agent : undefined,
      });

    case "hrp_review_pack":
      return client.reviewPack(
        String(args.runId),
        typeof args.nodeId === "string" ? args.nodeId : undefined,
        typeof args.agent === "string" ? args.agent : undefined,
      );

    case "hrp_review_gate":
      return client.reviewGate(String(args.runId));

    case "hrp_finding_add":
      return client.addFinding(String(args.runId), {
        reviewer: String(args.reviewer),
        severity: args.severity as FindingInput["severity"],
        title: String(args.title),
        body: String(args.body),
        nodeId: typeof args.nodeId === "string" ? args.nodeId : undefined,
      });

    case "hrp_finding_list":
      return client.listFindings(String(args.runId));

    case "hrp_finding_show":
      return client.getFinding(String(args.findingId));

    case "hrp_finding_reply":
      return client.replyFinding(String(args.findingId), String(args.author), String(args.body));

    case "hrp_finding_accept":
      return client.setFindingStatus(
        String(args.findingId),
        "accepted",
        typeof args.resolutionNodeId === "string" ? args.resolutionNodeId : undefined,
      );

    case "hrp_finding_reject":
      await client.replyFinding(String(args.findingId), String(args.author), String(args.body));
      return client.setFindingStatus(String(args.findingId), "rejected");

    case "hrp_finding_reopen":
      return client.reopenFinding(String(args.findingId), String(args.author), String(args.body));

    case "hrp_finding_escalate":
      return client.setFindingStatus(String(args.findingId), "escalated");

    default:
      throw new Error(`Herramienta no reconocida: ${toolName}`);
  }
}
