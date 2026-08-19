import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  type Activity,
  type ActivityType,
  type ChangeNode,
  type ChangeNodeInput,
  type GraphInput,
  type NodeStatus,
  type OllamaSettings,
  type OllamaSettingsView,
  type Project,
  type RunDetail,
  type RunSummary,
  type Verification,
} from "../shared/protocol.js";

type Row = Record<string, unknown>;

function now(): string {
  return new Date().toISOString();
}

function projectFromRow(row: Row): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    workspaceRoot: String(row.workspace_root),
    createdAt: String(row.created_at),
    lastOpenedAt: String(row.last_opened_at),
  };
}

function nodeFromRow(row: Row): ChangeNode {
  const verification = row.verification_json ? JSON.parse(String(row.verification_json)) as Verification : undefined;
  return {
    id: String(row.id),
    runId: String(row.run_id),
    file: String(row.file),
    symbol: String(row.symbol),
    title: String(row.title),
    description: String(row.description),
    rationale: String(row.rationale),
    status: String(row.status) as NodeStatus,
    discovered: Number(row.discovered) === 1,
    approved: Number(row.approved) === 1,
    assignee: row.assignee ? String(row.assignee) : undefined,
    suggestedAgent: row.suggested_agent ? String(row.suggested_agent) : undefined,
    executedBy: row.executed_by ? String(row.executed_by) : undefined,
    dependencies: JSON.parse(String(row.dependencies_json)) as string[],
    diff: row.diff ? String(row.diff) : undefined,
    patchSummary: row.patch_summary ? String(row.patch_summary) : undefined,
    patchRationale: row.patch_rationale ? String(row.patch_rationale) : undefined,
    verification,
    tokens: row.tokens == null ? undefined : Number(row.tokens),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class HrpStore {
  readonly database: Database.Database;

  constructor(readonly dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true });
    this.database = new Database(path.join(dataDirectory, "hrp-v2.sqlite"));
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_root TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        requirement TEXT NOT NULL,
        graph_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        file TEXT NOT NULL,
        symbol TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        rationale TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
        discovered INTEGER NOT NULL DEFAULT 0,
        approved INTEGER NOT NULL DEFAULT 0,
        assignee TEXT,
        dependencies_json TEXT NOT NULL,
        diff TEXT,
        patch_summary TEXT,
        patch_rationale TEXT,
        verification_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, id)
      );
      CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        node_id TEXT,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_project_updated ON runs(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS activity_run_id ON activity(run_id, id DESC);
    `);
    const nodeColumns = this.database.pragma("table_info(nodes)") as Row[];
    if (!nodeColumns.some((column) => String(column.name) === "patch_rationale")) {
      this.database.exec("ALTER TABLE nodes ADD COLUMN patch_rationale TEXT");
    }
    if (!nodeColumns.some((column) => String(column.name) === "approved")) {
      // Los nodos previos al gate quedan aprobados para no bloquear ejecuciones ya observadas.
      this.database.exec("ALTER TABLE nodes ADD COLUMN approved INTEGER NOT NULL DEFAULT 0");
      this.database.exec("UPDATE nodes SET approved = 1");
    }
    if (!nodeColumns.some((column) => String(column.name) === "assignee")) {
      this.database.exec("ALTER TABLE nodes ADD COLUMN assignee TEXT");
    }
    if (!nodeColumns.some((column) => String(column.name) === "suggested_agent")) {
      this.database.exec("ALTER TABLE nodes ADD COLUMN suggested_agent TEXT");
    }
    if (!nodeColumns.some((column) => String(column.name) === "tokens")) {
      this.database.exec("ALTER TABLE nodes ADD COLUMN tokens INTEGER");
    }
    if (!nodeColumns.some((column) => String(column.name) === "executed_by")) {
      this.database.exec("ALTER TABLE nodes ADD COLUMN executed_by TEXT");
      // Backfill único desde la actividad: los start con identidad quedaron como
      // "En curso (agente): archivo · símbolo" antes de que el nodo persistiera al ejecutor.
      this.database.exec(`
        UPDATE nodes SET executed_by = (
          SELECT substr(a.message, 11, instr(a.message, ')') - 11)
          FROM activity a
          WHERE a.run_id = nodes.run_id AND a.node_id = nodes.id
            AND a.type = 'node' AND a.message LIKE 'En curso (%'
          ORDER BY a.id DESC LIMIT 1
        )
        WHERE executed_by IS NULL
      `);
    }
    const runColumns = this.database.pragma("table_info(runs)") as Row[];
    if (!runColumns.some((column) => String(column.name) === "base_agent")) {
      this.database.exec("ALTER TABLE runs ADD COLUMN base_agent TEXT");
    }
    if (!runColumns.some((column) => String(column.name) === "seen_agents_json")) {
      this.database.exec("ALTER TABLE runs ADD COLUMN seen_agents_json TEXT NOT NULL DEFAULT '[]'");
    }
  }

  private registerAgent(runId: string, agent: string): void {
    const run = this.getRun(runId);
    if (!run || run.seenAgents.includes(agent)) return;
    this.database.prepare("UPDATE runs SET seen_agents_json = ? WHERE id = ?")
      .run(JSON.stringify([...run.seenAgents, agent]), runId);
  }

  close(): void {
    this.database.close();
  }

  getOllamaSettings(): OllamaSettings {
    const row = this.database.prepare("SELECT value_json FROM settings WHERE key = 'ollama'").get() as Row | undefined;
    const stored = row ? JSON.parse(String(row.value_json)) as Partial<OllamaSettings> : {};
    return {
      apiKey: stored.apiKey ?? "",
      model: stored.model?.trim() || DEFAULT_OLLAMA_MODEL,
      baseUrl: stored.baseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL,
    };
  }

  // apiKey omitida conserva la key actual; null la borra. Así la web puede
  // actualizar el modelo sin obligar al humano a reingresar la credencial.
  setOllamaSettings(update: { apiKey?: string | null; model?: string; baseUrl?: string }): OllamaSettingsView {
    const current = this.getOllamaSettings();
    const next: OllamaSettings = {
      apiKey: update.apiKey === null ? "" : update.apiKey?.trim() || current.apiKey,
      model: update.model?.trim() || current.model,
      baseUrl: (update.baseUrl?.trim() || current.baseUrl).replace(/\/+$/, ""),
    };
    this.database.prepare(`
      INSERT INTO settings (key, value_json, updated_at) VALUES ('ollama', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(JSON.stringify(next), now());
    return this.getOllamaSettingsView();
  }

  getOllamaSettingsView(): OllamaSettingsView {
    const settings = this.getOllamaSettings();
    return {
      configured: Boolean(settings.apiKey),
      model: settings.model,
      baseUrl: settings.baseUrl,
      keyMask: settings.apiKey ? `…${settings.apiKey.slice(-4)}` : undefined,
    };
  }

  attachProject(workspaceRoot: string): Project {
    const resolved = path.resolve(workspaceRoot);
    if (!statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Workspace does not exist or is not a directory: ${resolved}`);
    }
    const canonical = realpathSync(resolved);
    if (canonical === path.parse(canonical).root || canonical === os.homedir()) {
      throw new Error(`Workspace cannot be the filesystem root or the home directory: ${canonical}. Run hrp from the project folder`);
    }
    const id = createHash("sha256").update(canonical).digest("hex").slice(0, 20);
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO projects (id, name, workspace_root, created_at, last_opened_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_root) DO UPDATE SET name = excluded.name, last_opened_at = excluded.last_opened_at
    `).run(id, path.basename(canonical) || canonical, canonical, timestamp, timestamp);
    return this.getProject(id)!;
  }

  listProjects(): Project[] {
    return (this.database.prepare("SELECT * FROM projects ORDER BY last_opened_at DESC").all() as Row[]).map(projectFromRow);
  }

  getProject(id: string): Project | undefined {
    const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    return row ? projectFromRow(row) : undefined;
  }

  deleteProject(id: string): boolean {
    return this.database.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }

  createRun(projectId: string, title: string, requirement: string): RunSummary {
    if (!this.getProject(projectId)) throw new Error(`Unknown project: ${projectId}`);
    const id = randomUUID();
    const timestamp = now();
    this.database.prepare(`INSERT INTO runs (id, project_id, title, requirement, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, title, requirement, timestamp, timestamp);
    this.addActivity(id, "run", "Ejecución creada", requirement);
    return this.getRun(id)!;
  }

  listRuns(projectId: string): RunSummary[] {
    const rows = this.database.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as Row[];
    return rows.map((row) => this.runFromRow(row));
  }

  getRun(id: string): RunSummary | undefined {
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  deleteRun(id: string): boolean {
    return this.database.prepare("DELETE FROM runs WHERE id = ?").run(id).changes > 0;
  }

  getRunDetail(id: string): RunDetail | undefined {
    const run = this.getRun(id);
    if (!run) return undefined;
    const nodes = (this.database.prepare("SELECT * FROM nodes WHERE run_id = ? ORDER BY created_at, id").all(id) as Row[]).map(nodeFromRow);
    const activity = (this.database.prepare("SELECT * FROM activity WHERE run_id = ? ORDER BY id DESC").all(id) as Row[]).map((row) => ({
      id: Number(row.id),
      runId: String(row.run_id),
      nodeId: row.node_id ? String(row.node_id) : undefined,
      type: String(row.type) as ActivityType,
      message: String(row.message),
      detail: row.detail ? String(row.detail) : undefined,
      createdAt: String(row.created_at),
    } satisfies Activity));
    return { run, nodes, activity };
  }

  publishGraph(runId: string, input: GraphInput, agent?: string): ChangeNode[] {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (agent) {
      if (!run.baseAgent) this.database.prepare("UPDATE runs SET base_agent = ? WHERE id = ?").run(agent, runId);
      this.registerAgent(runId, agent);
    }
    const ids = new Set(input.nodes.map((node) => node.id));
    if (ids.size !== input.nodes.length) throw new Error("Node ids must be unique");
    for (const node of input.nodes) {
      const missing = node.dependencies.filter((dependency) => !ids.has(dependency) && !this.getNode(runId, dependency));
      if (missing.length) throw new Error(`Unknown dependencies for ${node.id}: ${missing.join(", ")}`);
    }
    const dependencyGraph = new Map(
      (this.getRunDetail(runId)?.nodes ?? []).map((node) => [node.id, node.dependencies]),
    );
    for (const node of input.nodes) dependencyGraph.set(node.id, node.dependencies);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (nodeId: string, trail: string[]): void => {
      if (visiting.has(nodeId)) throw new Error(`Dependency cycle: ${[...trail, nodeId].join(" -> ")}`);
      if (visited.has(nodeId)) return;
      visiting.add(nodeId);
      for (const dependency of dependencyGraph.get(nodeId) ?? []) visit(dependency, [...trail, nodeId]);
      visiting.delete(nodeId);
      visited.add(nodeId);
    };
    for (const nodeId of dependencyGraph.keys()) visit(nodeId, []);
    const upsert = this.database.prepare(`
      INSERT INTO nodes (id, run_id, file, symbol, title, description, rationale, status, discovered, suggested_agent, dependencies_json, created_at, updated_at)
      VALUES (@id, @runId, @file, @symbol, @title, @description, @rationale, 'pending', @discovered, @suggestedAgent, @dependencies, @timestamp, @timestamp)
      ON CONFLICT(run_id, id) DO UPDATE SET
        file = excluded.file, symbol = excluded.symbol, title = excluded.title,
        description = excluded.description, rationale = excluded.rationale,
        discovered = excluded.discovered, suggested_agent = excluded.suggested_agent,
        dependencies_json = excluded.dependencies_json,
        approved = CASE WHEN nodes.status = 'completed' THEN nodes.approved ELSE 0 END,
        updated_at = excluded.updated_at
    `);
    // La sugerencia del modelo base pre-asigna el nodo solo si el humano no
    // decidió ya un ejecutor; la asignación sigue siendo editable hasta aprobar.
    const suggestAssign = this.database.prepare(`
      UPDATE nodes SET assignee = @suggestedAgent
      WHERE run_id = @runId AND id = @id AND assignee IS NULL AND status IN ('pending','failed')
    `);
    const timestamp = now();
    this.database.transaction((nodes: ChangeNodeInput[]) => {
      for (const node of nodes) {
        upsert.run({ ...node, runId, discovered: node.discovered ? 1 : 0, suggestedAgent: node.suggestedAgent ?? null, dependencies: JSON.stringify(node.dependencies), timestamp });
        if (node.suggestedAgent) suggestAssign.run({ runId, id: node.id, suggestedAgent: node.suggestedAgent });
      }
      this.database.prepare("UPDATE runs SET graph_version = graph_version + 1, updated_at = ? WHERE id = ?").run(timestamp, runId);
    })(input.nodes);
    this.addActivity(runId, "graph", `Mapa actualizado · ${input.nodes.length} operaciones`, `Versión ${run.graphVersion + 1}`);
    return this.getRunDetail(runId)!.nodes;
  }

  addDiscoveredNode(runId: string, node: ChangeNodeInput): ChangeNode {
    this.publishGraph(runId, { nodes: [{ ...node, discovered: true }] });
    this.addActivity(runId, "inspect", `Cambio descubierto: ${node.file} · ${node.symbol}`, node.rationale, node.id);
    // Un descubierto sugerido para otro modelo (p. ej. ollama) respeta esa
    // sugerencia; el resto vuelve al modelo base para no esperar a nadie.
    const baseAgent = this.getRun(runId)?.baseAgent;
    const assignee = node.suggestedAgent ?? baseAgent;
    if (assignee) this.assignNode(runId, node.id, assignee);
    return this.getNode(runId, node.id)!;
  }

  helloAgent(runId: string, agent: string): RunSummary {
    if (!this.getRun(runId)) throw new Error(`Unknown run: ${runId}`);
    this.registerAgent(runId, agent);
    return this.getRun(runId)!;
  }

  approveNodes(runId: string, nodeIds?: string[]): ChangeNode[] {
    if (!this.getRun(runId)) throw new Error(`Unknown run: ${runId}`);
    const targets = nodeIds?.length
      ? nodeIds.map((id) => this.requireNode(runId, id))
      : (this.getRunDetail(runId)?.nodes ?? []).filter((node) => !node.approved);
    const pending = targets.filter((node) => !node.approved);
    if (!pending.length) throw new Error("No nodes are awaiting approval");
    const timestamp = now();
    const update = this.database.prepare("UPDATE nodes SET approved = 1, updated_at = ? WHERE run_id = ? AND id = ?");
    for (const node of pending) update.run(timestamp, runId, node.id);
    this.touchRun(runId, timestamp);
    if (pending.length === 1) this.addActivity(runId, "node", `Aprobado por el humano: ${pending[0].file} · ${pending[0].symbol}`, undefined, pending[0].id);
    else this.addActivity(runId, "graph", `Grafo aprobado por el humano · ${pending.length} operaciones`);
    return pending.map((node) => this.requireNode(runId, node.id));
  }

  assignNode(runId: string, nodeId: string, assignee: string | null): ChangeNode {
    const node = this.requireNode(runId, nodeId);
    if (node.status === "completed") throw new Error("Completed nodes cannot be reassigned");
    if (node.status === "running") throw new Error("Running nodes cannot be reassigned; wait for the node to finish or fail");
    const normalized = assignee?.trim() || null;
    const timestamp = now();
    this.database.prepare("UPDATE nodes SET assignee = ?, updated_at = ? WHERE run_id = ? AND id = ?").run(normalized, timestamp, runId, nodeId);
    this.touchRun(runId, timestamp);
    this.addActivity(runId, "node", normalized
      ? `Asignado a ${normalized}: ${node.file} · ${node.symbol}`
      : `Asignación retirada: ${node.file} · ${node.symbol}`, undefined, nodeId);
    return this.requireNode(runId, nodeId);
  }

  startNode(runId: string, nodeId: string, agent?: string): ChangeNode {
    const node = this.requireNode(runId, nodeId);
    if (!node.approved) throw new Error(`Node awaits human approval: ${nodeId}. Ask the human to approve it in the HRP panel or with 'hrp node approve'`);
    if (node.assignee && agent && agent !== node.assignee) {
      throw new Error(`Node ${nodeId} is assigned to ${node.assignee}; agent ${agent} must not start it`);
    }
    const blockers = node.dependencies.map((id) => this.getNode(runId, id)).filter((item) => item?.status !== "completed");
    if (blockers.length) throw new Error(`Incomplete dependencies: ${blockers.map((item) => item?.id).join(", ")}`);
    if (node.status === "completed") throw new Error("Completed nodes cannot be restarted");
    const inFlight = this.database.prepare("SELECT id FROM nodes WHERE run_id = ? AND status = 'running' AND id != ?").get(runId, nodeId) as Row | undefined;
    if (inFlight) throw new Error(`Another node is already running: ${String(inFlight.id)}. The workspace executes one node at a time`);
    this.updateNodeStatus(runId, nodeId, "running");
    if (agent) {
      this.registerAgent(runId, agent);
      this.database.prepare("UPDATE nodes SET executed_by = ? WHERE run_id = ? AND id = ?").run(agent, runId, nodeId);
    }
    this.addActivity(runId, "node", `En curso${agent ? ` (${agent})` : ""}: ${node.file} · ${node.symbol}`, node.description, nodeId);
    return this.requireNode(runId, nodeId);
  }

  publishPatch(runId: string, nodeId: string, summary: string, diff: string, rationale?: string): ChangeNode {
    const node = this.requireNode(runId, nodeId);
    if (node.status !== "running") throw new Error("Node must be running before publishing a patch");
    if (!diff.trim()) throw new Error("A real diff is required");
    const fileName = node.file.split("/").pop() ?? node.file;
    if (!diff.includes(node.file) && !diff.includes(fileName)) {
      throw new Error(`Diff is not attributable to this node: it never references ${node.file}`);
    }
    const foreignFiles = new Set<string>();
    for (const line of diff.split("\n")) {
      const gitHeader = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      const markerHeader = !gitHeader && /^(\+\+\+|---) /.test(line) ? [line.slice(4)] : [];
      for (const raw of gitHeader ? [gitHeader[1], gitHeader[2]] : markerHeader) {
        const candidate = raw.split("\t")[0].trim().replace(/^[ab]\//, "");
        if (!candidate || candidate === "/dev/null" || candidate.includes(fileName)) continue;
        foreignFiles.add(candidate);
      }
    }
    if (foreignFiles.size) {
      throw new Error(`Diff mixes files that belong to other operations: ${[...foreignFiles].join(", ")}. Publish them as their own nodes or discover them`);
    }
    const timestamp = now();
    this.database.prepare("UPDATE nodes SET diff = ?, patch_summary = ?, patch_rationale = ?, updated_at = ? WHERE run_id = ? AND id = ?")
      .run(diff, summary, rationale?.trim() || null, timestamp, runId, nodeId);
    this.touchRun(runId, timestamp);
    this.addActivity(runId, "patch", `Diff aplicado: ${node.file} · ${node.symbol}`, summary, nodeId);
    return this.requireNode(runId, nodeId);
  }

  publishVerification(runId: string, nodeId: string, verification: Omit<Verification, "passed" | "observedAt">): ChangeNode {
    const node = this.requireNode(runId, nodeId);
    const result: Verification = { ...verification, passed: verification.exitCode === 0, observedAt: now() };
    this.database.prepare("UPDATE nodes SET verification_json = ?, status = ?, updated_at = ? WHERE run_id = ? AND id = ?")
      .run(JSON.stringify(result), result.passed ? node.status : "failed", result.observedAt, runId, nodeId);
    this.touchRun(runId, result.observedAt);
    this.addActivity(runId, "verify", `${result.passed ? "Verificación aprobada" : "Verificación fallida"}: ${verification.command}`, verification.output, nodeId);
    return this.requireNode(runId, nodeId);
  }

  completeNode(runId: string, nodeId: string, tokens?: number): ChangeNode {
    const node = this.requireNode(runId, nodeId);
    if (node.status !== "running") throw new Error("Node must be running before completion; a failed node needs a retry first");
    if (!node.diff) throw new Error("A diff is required before completion");
    if (!node.verification?.passed) throw new Error("A passing verification is required before completion");
    if (tokens != null) {
      if (!Number.isInteger(tokens) || tokens <= 0) throw new Error("tokens must be a positive integer");
      this.database.prepare("UPDATE nodes SET tokens = ? WHERE run_id = ? AND id = ?").run(tokens, runId, nodeId);
    }
    this.updateNodeStatus(runId, nodeId, "completed");
    const tokensNote = tokens != null ? ` · ~${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tokens` : "";
    this.addActivity(runId, "node", `Terminado: ${node.file} · ${node.symbol}${tokensNote}`, node.patchSummary, nodeId);
    return this.requireNode(runId, nodeId);
  }

  addActivity(runId: string, type: ActivityType, message: string, detail?: string, nodeId?: string): Activity {
    const createdAt = now();
    const result = this.database.prepare("INSERT INTO activity (run_id, node_id, type, message, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(runId, nodeId ?? null, type, message, detail ?? null, createdAt);
    this.touchRun(runId, createdAt);
    return { id: Number(result.lastInsertRowid), runId, nodeId, type, message, detail, createdAt };
  }

  private runFromRow(row: Row): RunSummary {
    const counts = this.database.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM nodes WHERE run_id = ?
    `).get(String(row.id)) as Row;
    const total = Number(counts.total ?? 0);
    const completed = Number(counts.completed ?? 0);
    const status: NodeStatus = Number(counts.failed ?? 0) > 0 ? "failed"
      : Number(counts.running ?? 0) > 0 ? "running"
        : total > 0 && total === completed ? "completed" : "pending";
    return {
      id: String(row.id), projectId: String(row.project_id), title: String(row.title), requirement: String(row.requirement),
      status, graphVersion: Number(row.graph_version),
      baseAgent: row.base_agent ? String(row.base_agent) : undefined,
      seenAgents: row.seen_agents_json ? JSON.parse(String(row.seen_agents_json)) as string[] : [],
      nodeCount: total, completedCount: completed,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  private getNode(runId: string, nodeId: string): ChangeNode | undefined {
    const row = this.database.prepare("SELECT * FROM nodes WHERE run_id = ? AND id = ?").get(runId, nodeId) as Row | undefined;
    return row ? nodeFromRow(row) : undefined;
  }

  private requireNode(runId: string, nodeId: string): ChangeNode {
    const node = this.getNode(runId, nodeId);
    if (!node) throw new Error(`Unknown node: ${nodeId}`);
    return node;
  }

  private updateNodeStatus(runId: string, nodeId: string, status: NodeStatus): void {
    const timestamp = now();
    this.database.prepare("UPDATE nodes SET status = ?, updated_at = ? WHERE run_id = ? AND id = ?").run(status, timestamp, runId, nodeId);
    this.touchRun(runId, timestamp);
  }

  private touchRun(runId: string, timestamp = now()): void {
    this.database.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run(timestamp, runId);
  }
}
