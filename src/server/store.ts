import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  computeAuditorConsensus,
  type AgentWorkState,
  type AgentWorkPhase,
  type Activity,
  type ActivityType,
  findingSeverities,
  findingStatuses,
  type ChangeNode,
  type ChangeNodeInput,
  type Finding,
  type FindingInput,
  type FindingMessage,
  type FindingStatus,
  type GraphInput,
  type NodeStatus,
  type OllamaSettings,
  type OllamaSettingsView,
  type Project,
  type RunControl,
  type RunDetail,
  type RunSummary,
  type Verification,
} from "../shared/protocol.js";

type Row = Record<string, unknown>;

// La cobertura es opcional al publicar: omitirla conserva la ya registrada, y
// sólo un valor explícito la reemplaza.
export type AgentStateInput =
  Omit<AgentWorkState, "updatedAt" | "completed" | "total" | "reviewedNodeIds" | "remainingNodeIds">
  & Partial<Pick<AgentWorkState, "completed" | "total" | "reviewedNodeIds" | "remainingNodeIds">>;

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
    contextFiles: row.context_json ? JSON.parse(String(row.context_json)) as string[] : undefined,
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

function agentStateFromRow(row: Row): AgentWorkState {
  return {
    agent: String(row.agent),
    phase: String(row.phase) as AgentWorkPhase,
    summary: String(row.summary),
    detail: row.detail ? String(row.detail) : undefined,
    currentNodeId: row.current_node_id ? String(row.current_node_id) : undefined,
    completed: Number(row.completed),
    total: Number(row.total),
    reviewedNodeIds: JSON.parse(String(row.reviewed_json)) as string[],
    remainingNodeIds: JSON.parse(String(row.remaining_json)) as string[],
    startedAt: row.started_at ? String(row.started_at) : undefined,
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
        agent TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_states (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        agent TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('idle','waiting','executing','reviewing','completed','failed')),
        summary TEXT NOT NULL,
        detail TEXT,
        current_node_id TEXT,
        completed INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        reviewed_json TEXT NOT NULL DEFAULT '[]',
        remaining_json TEXT NOT NULL DEFAULT '[]',
        started_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, agent)
      );
      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        node_id TEXT,
        reviewer TEXT NOT NULL,
        severity TEXT NOT NULL CHECK(severity IN ('critical','major','minor','question')),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open','debating','accepted','rejected','escalated')),
        resolution_node_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS finding_messages (
        id TEXT PRIMARY KEY,
        finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_project_updated ON runs(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS activity_run_id ON activity(run_id, id DESC);
      CREATE INDEX IF NOT EXISTS findings_run ON findings(run_id, created_at);
      CREATE INDEX IF NOT EXISTS finding_messages_finding ON finding_messages(finding_id, created_at);
    `);
    const activityColumns = this.database.pragma("table_info(activity)") as Row[];
    if (!activityColumns.some((column) => String(column.name) === "agent")) {
      this.database.exec("ALTER TABLE activity ADD COLUMN agent TEXT");
      this.database.exec(`
        UPDATE activity SET agent = 'human'
        WHERE agent IS NULL AND (
          message LIKE 'Aprobado por el humano%'
          OR message LIKE 'Grafo aprobado por el humano%'
          OR message LIKE 'Asignado a %'
          OR message LIKE 'Desasignado%'
          OR message LIKE 'Auditores elegidos%'
          OR message LIKE 'Ejecución pausada%'
          OR message LIKE 'Ejecución reanudada%'
          OR message LIKE 'Ejecución detenida%'
        )
      `);
      this.database.exec(`
        UPDATE activity SET agent = 'ollama'
        WHERE agent IS NULL AND (
          message LIKE 'Consulta a ollama%'
          OR message LIKE 'Auditoría automática%'
        )
      `);
      this.database.exec(`
        UPDATE activity SET agent = substr(message, 11, instr(message, ')') - 11)
        WHERE agent IS NULL AND type = 'node' AND message LIKE 'En curso (%'
      `);
    }
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
    if (!nodeColumns.some((column) => String(column.name) === "context_json")) {
      this.database.exec("ALTER TABLE nodes ADD COLUMN context_json TEXT");
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
    const backfillMigrationDone = this.database.prepare("SELECT 1 FROM settings WHERE key = 'activity_agent_backfill_v1'").get();
    if (!backfillMigrationDone) {
      this.database.exec(`
        UPDATE activity SET agent = (
          SELECT n.executed_by FROM nodes n
          WHERE n.run_id = activity.run_id AND n.id = activity.node_id AND n.executed_by IS NOT NULL
        )
        WHERE agent IS NULL AND node_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = activity.run_id AND n.id = activity.node_id AND n.executed_by IS NOT NULL)
      `);
      this.database.prepare("INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES ('activity_agent_backfill_v1', '\"done\"', ?)")
        .run(new Date().toISOString());
    }
    const runColumns = this.database.pragma("table_info(runs)") as Row[];
    if (!runColumns.some((column) => String(column.name) === "base_agent")) {
      this.database.exec("ALTER TABLE runs ADD COLUMN base_agent TEXT");
    }
    if (!runColumns.some((column) => String(column.name) === "seen_agents_json")) {
      this.database.exec("ALTER TABLE runs ADD COLUMN seen_agents_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!runColumns.some((column) => String(column.name) === "control")) {
      this.database.exec("ALTER TABLE runs ADD COLUMN control TEXT NOT NULL DEFAULT 'active'");
    }
    if (!runColumns.some((column) => String(column.name) === "auditors_json")) {
      this.database.exec("ALTER TABLE runs ADD COLUMN auditors_json TEXT NOT NULL DEFAULT '[]'");
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

  createRun(projectId: string, title: string, requirement: string, agent?: string): RunSummary {
    if (!this.getProject(projectId)) throw new Error(`Unknown project: ${projectId}`);
    const id = randomUUID();
    const timestamp = now();
    this.database.prepare(`INSERT INTO runs (id, project_id, title, requirement, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, title, requirement, timestamp, timestamp);
    this.addActivity(id, "run", "Ejecución creada", requirement, undefined, agent ?? "human");
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
      agent: row.agent ? String(row.agent) : undefined,
      createdAt: String(row.created_at),
    } satisfies Activity));
    const agentStates = (this.database.prepare("SELECT * FROM agent_states WHERE run_id = ? ORDER BY updated_at DESC, agent").all(id) as Row[])
      .map(agentStateFromRow);
    return { run, nodes, activity, findings: this.listFindings(id), agentStates };
  }

  setRunAuditors(runId: string, auditors: string[]): RunSummary {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const normalized = [...new Set(auditors.map((agent) => agent.trim()).filter(Boolean))];
    const approved = this.database.prepare("SELECT 1 FROM nodes WHERE run_id = ? AND approved = 1 LIMIT 1").get(runId);
    // La lista se congela mientras la ejecución corre para que la política de
    // revisión no cambie a mitad, pero la pausa es una decisión deliberada del
    // humano que ya detiene todo inicio de nodo: ahí sí puede reconfigurarla.
    // Sin esto, un auditor que se queda sin presupuesto bloquea el cierre para
    // siempre, porque nadie puede retirarlo.
    if (approved && run.control !== "paused") {
      throw new Error("Auditors are locked while the execution runs; pause it with 'hrp run pause' to reconfigure them");
    }
    const reconfiguring = Boolean(approved);
    const timestamp = now();
    this.database.prepare("UPDATE runs SET auditors_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(normalized), timestamp, runId);
    for (const removed of run.auditors.filter((agent) => !normalized.includes(agent))) {
      this.database.prepare("DELETE FROM agent_states WHERE run_id = ? AND agent = ? AND summary = 'Seleccionado para auditar'")
        .run(runId, removed);
    }
    const nodeIds = this.getRunDetail(runId)!.nodes.map((node) => node.id);
    // Sólo se anuncia a los auditores nuevos. Reinicializar a los que ya
    // estaban borraría la cobertura real de quien lleva media auditoría hecha,
    // que es justo el caso al retirar a un compañero a mitad de la ejecución.
    for (const agent of normalized.filter((candidate) => !run.auditors.includes(candidate))) {
      this.setAgentState(runId, {
        agent,
        phase: "waiting",
        summary: "Seleccionado para auditar",
        detail: "La auditoría comenzará cuando termine la implementación del grafo.",
        completed: 0,
        total: nodeIds.length,
        reviewedNodeIds: [],
        remainingNodeIds: nodeIds,
      });
    }
    if (reconfiguring) {
      // Un cambio de política a mitad del run se explica solo en el historial:
      // quién auditaba antes, quién audita ahora.
      this.addActivity(runId, "run", normalized.length
        ? `Auditores reconfigurados por el humano: ${normalized.join(", ")}`
        : "Auditoría desactivada por el humano durante la ejecución",
      `Antes: ${run.auditors.length ? run.auditors.join(", ") : "sin auditores"}. La ejecución estaba pausada al reconfigurar.`, undefined, "human");
    } else {
      this.addActivity(runId, "run", normalized.length
        ? `Auditores elegidos: ${normalized.join(", ")}`
        : "Auditoría desactivada para esta ejecución", undefined, undefined, "human");
    }
    return this.getRun(runId)!;
  }

  setAgentState(runId: string, state: AgentStateInput): AgentWorkState {
    const detail = this.getRunDetail(runId);
    if (!detail) throw new Error(`Unknown run: ${runId}`);
    // Publicar una fase sin cobertura no la niega: la conserva. Distinguir
    // "omitida" de "cero" evita que anunciar una etapa borre lo ya revisado.
    const previous = detail.agentStates.find((candidate) => candidate.agent === state.agent);
    const merged: Omit<AgentWorkState, "updatedAt"> = {
      ...state,
      completed: state.completed ?? previous?.completed ?? 0,
      total: state.total ?? previous?.total ?? 0,
      reviewedNodeIds: state.reviewedNodeIds ?? previous?.reviewedNodeIds ?? [],
      remainingNodeIds: state.remainingNodeIds ?? previous?.remainingNodeIds ?? [],
    };
    if (merged.completed > merged.total) throw new Error("Agent progress cannot exceed its total");
    const validNodeIds = new Set(detail.nodes.map((node) => node.id));
    const referenced = [merged.currentNodeId, ...merged.reviewedNodeIds, ...merged.remainingNodeIds].filter(Boolean) as string[];
    const unknown = [...new Set(referenced.filter((id) => !validNodeIds.has(id)))];
    if (unknown.length) throw new Error(`Agent status references unknown nodes: ${unknown.join(", ")}`);
    const reviewed = new Set(merged.reviewedNodeIds);
    const overlap = merged.remainingNodeIds.filter((id) => reviewed.has(id));
    if (overlap.length) throw new Error(`Agent status cannot mark nodes as reviewed and remaining: ${[...new Set(overlap)].join(", ")}`);
    const updatedAt = now();
    this.database.prepare(`
      INSERT INTO agent_states (
        run_id, agent, phase, summary, detail, current_node_id, completed, total,
        reviewed_json, remaining_json, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, agent) DO UPDATE SET
        phase = excluded.phase, summary = excluded.summary, detail = excluded.detail,
        current_node_id = excluded.current_node_id, completed = excluded.completed,
        total = excluded.total, reviewed_json = excluded.reviewed_json,
        remaining_json = excluded.remaining_json, started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `).run(
      runId, merged.agent, merged.phase, merged.summary, merged.detail ?? null,
      merged.currentNodeId ?? null, merged.completed, merged.total,
      JSON.stringify(merged.reviewedNodeIds), JSON.stringify(merged.remainingNodeIds),
      merged.startedAt ?? null, updatedAt,
    );
    return { ...merged, updatedAt };
  }

  private nodesForAgent(runId: string, agent: string): ChangeNode[] {
    const detail = this.getRunDetail(runId);
    if (!detail) return [];
    return detail.nodes.filter((node) => node.assignee === agent || node.executedBy === agent || (agent === detail.run.baseAgent && !node.assignee));
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
      INSERT INTO nodes (id, run_id, file, symbol, title, description, rationale, status, discovered, suggested_agent, context_json, dependencies_json, created_at, updated_at)
      VALUES (@id, @runId, @file, @symbol, @title, @description, @rationale, 'pending', @discovered, @suggestedAgent, @contextJson, @dependencies, @timestamp, @timestamp)
      ON CONFLICT(run_id, id) DO UPDATE SET
        file = excluded.file, symbol = excluded.symbol, title = excluded.title,
        description = excluded.description, rationale = excluded.rationale,
        discovered = excluded.discovered, suggested_agent = excluded.suggested_agent,
        context_json = excluded.context_json,
        dependencies_json = excluded.dependencies_json,
        -- La aprobación humana solo se invalida si el contenido semántico del
        -- nodo cambió: una republicación idéntica (reintento/reanudación) la conserva.
        approved = CASE
          WHEN nodes.status = 'completed' THEN nodes.approved
          WHEN nodes.file = excluded.file AND nodes.symbol = excluded.symbol AND nodes.title = excluded.title
            AND nodes.description = excluded.description AND nodes.rationale = excluded.rationale
            AND nodes.dependencies_json = excluded.dependencies_json
            AND COALESCE(nodes.suggested_agent, '') = COALESCE(excluded.suggested_agent, '')
            -- El contexto es parte de lo aprobado: cambiarlo altera lo que el
            -- modelo delegado vera, asi que exige re-aprobacion.
            AND COALESCE(nodes.context_json, '') = COALESCE(excluded.context_json, '')
          THEN nodes.approved
          ELSE 0 END,
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
        // contextFiles se separa del spread: el binding nombrado no admite claves sobrantes.
        const { contextFiles, ...fields } = node;
        upsert.run({ ...fields, runId, discovered: node.discovered ? 1 : 0, suggestedAgent: node.suggestedAgent ?? null, contextJson: contextFiles?.length ? JSON.stringify(contextFiles) : null, dependencies: JSON.stringify(node.dependencies), timestamp });
        if (node.suggestedAgent) suggestAssign.run({ runId, id: node.id, suggestedAgent: node.suggestedAgent });
      }
      this.database.prepare("UPDATE runs SET graph_version = graph_version + 1, updated_at = ? WHERE id = ?").run(timestamp, runId);
    })(input.nodes);
    this.addActivity(runId, "graph", `Mapa actualizado · ${input.nodes.length} operaciones`, `Versión ${run.graphVersion + 1}`, undefined, agent ?? run.baseAgent);
    const updated = this.getRunDetail(runId)!;
    for (const state of updated.agentStates.filter((candidate) => candidate.summary === "Seleccionado para auditar")) {
      const { updatedAt: _updatedAt, ...observable } = state;
      this.setAgentState(runId, {
        ...observable,
        total: updated.nodes.length,
        reviewedNodeIds: [],
        remainingNodeIds: updated.nodes.map((node) => node.id),
      });
    }
    return updated.nodes;
  }

  addDiscoveredNode(runId: string, node: ChangeNodeInput): ChangeNode {
    this.publishGraph(runId, { nodes: [{ ...node, discovered: true }] });
    const run = this.getRun(runId);
    this.addActivity(runId, "inspect", `Cambio descubierto: ${node.file} · ${node.symbol}`, node.rationale, node.id, run?.baseAgent);
    // Un descubierto sugerido para otro modelo (p. ej. ollama) respeta esa
    // sugerencia; el resto vuelve al modelo base para no esperar a nadie.
    const baseAgent = this.getRun(runId)?.baseAgent;
    const assignee = node.suggestedAgent ?? baseAgent;
    if (assignee) this.assignNode(runId, node.id, assignee);
    // El humano ya aprobó la intención de esta ejecución: frenar cada
    // descubrimiento en un clic es lo que dejaba a los agentes bloqueados y
    // obligaba al humano a estar presente. El gate humano sigue vigente para
    // el grafo inicial, que es donde se decide el plan.
    this.database.prepare("UPDATE nodes SET approved = 1, updated_at = ? WHERE run_id = ? AND id = ?")
      .run(now(), runId, node.id);
    this.addActivity(runId, "node", `Aprobado automáticamente por ser trabajo descubierto: ${node.file} · ${node.symbol}`, "El grafo inicial conserva el gate humano; lo descubierto durante una ejecución ya aprobada no lo requiere.", node.id, assignee ?? baseAgent);
    return this.getNode(runId, node.id)!;
  }

  helloAgent(runId: string, agent: string): RunSummary {
    if (!this.getRun(runId)) throw new Error(`Unknown run: ${runId}`);
    this.registerAgent(runId, agent);
    const existing = this.database.prepare("SELECT 1 FROM agent_states WHERE run_id = ? AND agent = ?").get(runId, agent);
    if (!existing) {
      const assigned = this.nodesForAgent(runId, agent);
      const completed = assigned.filter((node) => node.status === "completed").length;
      this.setAgentState(runId, {
        agent,
        phase: "waiting",
        summary: completed === assigned.length && assigned.length > 0 ? "Implementación terminada; disponible para revisión" : "Conectado y esperando trabajo",
        completed,
        total: assigned.length,
        reviewedNodeIds: [],
        remainingNodeIds: assigned.filter((node) => node.status !== "completed").map((node) => node.id),
      });
    }
    return this.getRun(runId)!;
  }

  approveNodes(runId: string, nodeIds?: string[]): ChangeNode[] {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (run.auditors.length === 0) throw new Error("Choose at least one auditor before approving the graph");
    if (run.auditors.includes("ollama") && !this.getOllamaSettings().apiKey) {
      throw new Error("Ollama is selected as auditor but is not configured; configure its API key or choose another auditor");
    }
    const targets = nodeIds?.length
      ? nodeIds.map((id) => this.requireNode(runId, id))
      : (this.getRunDetail(runId)?.nodes ?? []).filter((node) => !node.approved);
    const pending = targets.filter((node) => !node.approved);
    if (!pending.length) throw new Error("No nodes are awaiting approval");
    const timestamp = now();
    const update = this.database.prepare("UPDATE nodes SET approved = 1, updated_at = ? WHERE run_id = ? AND id = ?");
    for (const node of pending) update.run(timestamp, runId, node.id);
    this.touchRun(runId, timestamp);
    if (pending.length === 1) this.addActivity(runId, "node", `Aprobado por el humano: ${pending[0].file} · ${pending[0].symbol}`, undefined, pending[0].id, "human");
    else this.addActivity(runId, "graph", `Grafo aprobado por el humano · ${pending.length} operaciones`, undefined, undefined, "human");
    return pending.map((node) => this.requireNode(runId, node.id));
  }

  assignNode(runId: string, nodeId: string, assignee: string | null): ChangeNode {
    const node = this.requireNode(runId, nodeId);
    if (node.status === "completed") throw new Error("Completed nodes cannot be reassigned");
    const paused = this.getRun(runId)?.control === "paused";
    // Un agente que se queda sin presupuesto deja su nodo en vuelo y bloquea la
    // ejecución entera, porque sólo puede haber uno a la vez. Con la ejecución
    // pausada el humano puede recuperarlo: el nodo vuelve a 'pending' y pierde
    // su ejecutor, pero conserva el diff y la verificación del intento como
    // evidencia de lo que alcanzó a hacer.
    const recovering = node.status === "running";
    if (recovering && !paused) {
      throw new Error("Running nodes cannot be reassigned while the execution runs; pause it with 'hrp run pause' to take the node back");
    }
    const normalized = assignee?.trim() || null;
    const timestamp = now();
    this.database.prepare("UPDATE nodes SET assignee = ?, updated_at = ? WHERE run_id = ? AND id = ?").run(normalized, timestamp, runId, nodeId);
    if (recovering) {
      this.database.prepare("UPDATE nodes SET status = 'pending', executed_by = NULL, updated_at = ? WHERE run_id = ? AND id = ?")
        .run(timestamp, runId, nodeId);
    }
    this.touchRun(runId, timestamp);
    this.addActivity(runId, "node", normalized
      ? `Asignado a ${normalized}: ${node.file} · ${node.symbol}`
      : `Asignación retirada: ${node.file} · ${node.symbol}`,
    recovering
      ? `Estaba en curso con ${node.executedBy ?? node.assignee ?? "otro agente"} y el humano lo recuperó con la ejecución pausada: vuelve a pendiente conservando el diff y la verificación del intento.`
      : undefined, nodeId, "human");
    return this.requireNode(runId, nodeId);
  }

  // El control es del humano: pausar/detener bloquea el inicio de nodos para
  // todos los agentes por igual, porque todos inician a través del servidor.
  setRunControl(runId: string, control: RunControl): RunSummary {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (run.control === control) return run;
    const timestamp = now();
    this.database.prepare("UPDATE runs SET control = ?, updated_at = ? WHERE id = ?").run(control, timestamp, runId);
    const copy: Record<RunControl, string> = {
      active: "Ejecución reanudada por el humano",
      paused: "Ejecución pausada por el humano: ningún agente puede iniciar nodos hasta reanudar",
      stopped: "Ejecución detenida por el humano: los agentes deben cerrar ordenadamente",
    };
    this.addActivity(runId, "run", copy[control], undefined, undefined, "human");
    return this.getRun(runId)!;
  }

  startNode(runId: string, nodeId: string, agent?: string): ChangeNode {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (run.control === "paused") throw new Error("Run is paused by the human; poll 'hrp state' and start again once it resumes");
    if (run.control === "stopped") throw new Error("Run was stopped by the human; do not start more nodes and report your progress");
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
      const assigned = this.nodesForAgent(runId, agent);
      this.setAgentState(runId, {
        agent,
        phase: "executing",
        summary: `Implementando ${node.file} · ${node.symbol}`,
        detail: node.description,
        currentNodeId: nodeId,
        completed: assigned.filter((candidate) => candidate.status === "completed").length,
        total: assigned.length,
        reviewedNodeIds: [],
        remainingNodeIds: assigned.filter((candidate) => candidate.status !== "completed" && candidate.id !== nodeId).map((candidate) => candidate.id),
        startedAt: now(),
      });
    }
    const effectiveAgent = agent ?? node.assignee ?? run.baseAgent;
    this.addActivity(runId, "node", `En curso${agent ? ` (${agent})` : ""}: ${node.file} · ${node.symbol}`, node.description, nodeId, effectiveAgent);
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
    const nodeAgent = node.executedBy ?? node.assignee ?? this.getRun(runId)?.baseAgent;
    this.addActivity(runId, "patch", `Diff aplicado: ${node.file} · ${node.symbol}`, summary, nodeId, nodeAgent);
    return this.requireNode(runId, nodeId);
  }

  publishVerification(runId: string, nodeId: string, verification: Omit<Verification, "passed" | "observedAt">): ChangeNode {
    const node = this.requireNode(runId, nodeId);
    const result: Verification = { ...verification, passed: verification.exitCode === 0, observedAt: now() };
    this.database.prepare("UPDATE nodes SET verification_json = ?, status = ?, updated_at = ? WHERE run_id = ? AND id = ?")
      .run(JSON.stringify(result), result.passed ? node.status : "failed", result.observedAt, runId, nodeId);
    this.touchRun(runId, result.observedAt);
    const nodeAgent = node.executedBy ?? node.assignee ?? this.getRun(runId)?.baseAgent;
    this.addActivity(runId, "verify", `${result.passed ? "Verificación aprobada" : "Verificación fallida"}: ${verification.command}`, verification.output, nodeId, nodeAgent);
    if (!result.passed && node.executedBy) {
      const assigned = this.nodesForAgent(runId, node.executedBy);
      this.setAgentState(runId, {
        agent: node.executedBy,
        phase: "failed",
        summary: `Falló la verificación de ${node.file} · ${node.symbol}`,
        detail: verification.command,
        currentNodeId: nodeId,
        completed: assigned.filter((candidate) => candidate.status === "completed").length,
        total: assigned.length,
        reviewedNodeIds: [],
        remainingNodeIds: assigned.filter((candidate) => candidate.status !== "completed").map((candidate) => candidate.id),
        startedAt: node.updatedAt,
      });
    }
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
    const nodeAgent = node.executedBy ?? node.assignee ?? this.getRun(runId)?.baseAgent;
    this.addActivity(runId, "node", `Terminado: ${node.file} · ${node.symbol}${tokensNote}`, node.patchSummary, nodeId, nodeAgent);
    if (node.executedBy) {
      const assigned = this.nodesForAgent(runId, node.executedBy);
      const completed = assigned.filter((candidate) => candidate.status === "completed").length;
      const remaining = assigned.filter((candidate) => candidate.status !== "completed").map((candidate) => candidate.id);
      this.setAgentState(runId, {
        agent: node.executedBy,
        phase: remaining.length ? "waiting" : "completed",
        summary: remaining.length ? `Esperando la siguiente operación · ${remaining.length} pendiente${remaining.length === 1 ? "" : "s"}` : "Implementación asignada terminada",
        completed,
        total: assigned.length,
        reviewedNodeIds: [],
        remainingNodeIds: remaining,
      });
    }
    return this.requireNode(runId, nodeId);
  }

  private findingFromRow(row: Row): Finding {
    const messages = (this.database.prepare("SELECT * FROM finding_messages WHERE finding_id = ? ORDER BY created_at, rowid").all(String(row.id)) as Row[]).map((message) => ({
      id: String(message.id),
      findingId: String(message.finding_id),
      author: String(message.author),
      body: String(message.body),
      createdAt: String(message.created_at),
    } satisfies FindingMessage));
    return {
      id: String(row.id),
      runId: String(row.run_id),
      nodeId: row.node_id ? String(row.node_id) : undefined,
      reviewer: String(row.reviewer),
      severity: String(row.severity) as Finding["severity"],
      title: String(row.title),
      body: String(row.body),
      status: String(row.status) as FindingStatus,
      resolutionNodeId: row.resolution_node_id ? String(row.resolution_node_id) : undefined,
      messages,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  createFinding(runId: string, input: FindingInput): Finding {
    if (!this.getRun(runId)) throw new Error(`Unknown run: ${runId}`);
    if (!findingSeverities.includes(input.severity)) throw new Error(`Unknown severity: ${input.severity}`);
    if (input.nodeId) this.requireNode(runId, input.nodeId);
    const id = randomUUID();
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO findings (id, run_id, node_id, reviewer, severity, title, body, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(id, runId, input.nodeId ?? null, input.reviewer, input.severity, input.title, input.body, timestamp, timestamp);
    this.addActivity(runId, "note", `Hallazgo de ${input.reviewer} (${input.severity}): ${input.title}`, input.body, input.nodeId, input.reviewer);
    return this.requireFinding(id);
  }

  listFindings(runId: string): Finding[] {
    return (this.database.prepare("SELECT * FROM findings WHERE run_id = ? ORDER BY created_at, rowid").all(runId) as Row[])
      .map((row) => this.findingFromRow(row));
  }

  getFinding(id: string): Finding | undefined {
    const row = this.database.prepare("SELECT * FROM findings WHERE id = ?").get(id) as Row | undefined;
    return row ? this.findingFromRow(row) : undefined;
  }

  private requireFinding(id: string): Finding {
    const finding = this.getFinding(id);
    if (!finding) throw new Error(`Unknown finding: ${id}`);
    return finding;
  }

  addFindingMessage(findingId: string, author: string, body: string): Finding {
    const finding = this.requireFinding(findingId);
    const timestamp = now();
    this.database.prepare("INSERT INTO finding_messages (id, finding_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), findingId, author, body, timestamp);
    // El primer intercambio convierte el hallazgo en debate; los estados
    // terminales y escalated no retroceden por seguir conversando.
    const status = finding.status === "open" ? "debating" : finding.status;
    this.database.prepare("UPDATE findings SET status = ?, updated_at = ? WHERE id = ?").run(status, timestamp, findingId);
    this.addActivity(finding.runId, "note", `Debate (${author}): ${finding.title}`, body, finding.nodeId, author);
    return this.requireFinding(findingId);
  }

  setFindingStatus(findingId: string, status: FindingStatus, resolutionNodeId?: string): Finding {
    const finding = this.requireFinding(findingId);
    if (!findingStatuses.includes(status)) throw new Error(`Unknown finding status: ${status}`);
    if (resolutionNodeId) this.requireNode(finding.runId, resolutionNodeId);
    // Sin nodo de corrección ni un solo turno que documente la resolución, la
    // aceptación sería silenciosa: el gate la daría por resuelta sin reparación.
    if (status === "accepted" && !resolutionNodeId && !finding.resolutionNodeId && finding.messages.length === 0) {
      throw new Error("Accepting requires a resolution: link a correction node (--resolution-node) or reply in the thread documenting why none is needed");
    }
    // Aceptar la corrección ES autorizarla (política v3.1): el nodo nacido del
    // debate no espera el clic humano; el monitor puede objetar en una segunda
    // corrida. Los nodos ajenos al debate conservan el gate humano intacto.
    // Todo dentro de una transacción: el hallazgo no puede quedar accepted con
    // su nodo sin aprobar si algo falla a la mitad.
    const baseAgent = this.getRun(finding.runId)?.baseAgent;
    this.database.transaction(() => {
      this.database.prepare("UPDATE findings SET status = ?, resolution_node_id = COALESCE(?, resolution_node_id), updated_at = ? WHERE id = ?")
        .run(status, resolutionNodeId ?? null, now(), findingId);
      const resolvedNodeId = resolutionNodeId ?? finding.resolutionNodeId;
      if (status === "accepted" && resolvedNodeId) {
        const resolutionNode = this.getNode(finding.runId, resolvedNodeId);
        if (resolutionNode && !resolutionNode.approved) {
          // La autoridad del base cubre solo las correcciones nacidas del
          // debate (nodos descubiertos); un nodo del plan inicial vinculado
          // como resolución conserva el gate humano intacto.
          if (resolutionNode.discovered) {
            this.database.prepare("UPDATE nodes SET approved = 1, updated_at = ? WHERE run_id = ? AND id = ?")
              .run(now(), finding.runId, resolvedNodeId);
            this.addActivity(finding.runId, "node", `Corrección autorizada por la aceptación del hallazgo (agente base): ${resolvedNodeId}`, finding.title, resolvedNodeId, baseAgent);
          } else {
            this.addActivity(finding.runId, "node", `La corrección vinculada pertenece al plan inicial y conserva el gate humano: ${resolvedNodeId}`, finding.title, resolvedNodeId, "human");
          }
        }
      }
      const labels: Record<FindingStatus, string> = {
        open: "Hallazgo reabierto",
        debating: "Hallazgo en debate",
        accepted: "Hallazgo aceptado",
        rejected: "Hallazgo rechazado",
        escalated: "Hallazgo escalado al humano",
      };
      const resolutionNote = resolutionNodeId ? ` · corrección: ${resolutionNodeId}` : "";
      this.addActivity(finding.runId, "note", `${labels[status]}: ${finding.title}${resolutionNote}`, undefined, finding.nodeId, baseAgent);
    })();
    return this.requireFinding(findingId);
  }

  // Hallazgos que impiden dar por cerrado el run: vivos u olvidados sin arbitrar.
  runReviewGate(runId: string): Finding[] {
    if (!this.getRun(runId)) throw new Error(`Unknown run: ${runId}`);
    return this.listFindings(runId).filter((finding) => ["open", "debating", "escalated"].includes(finding.status));
  }

  // Lista informativa de auditores seleccionados que aún no votan OK. El dato
  // que bloquea el cierre es pendingAuditorVotes: la mayoría puede estar lista
  // aunque esta lista aún tenga minoría sin votar.
  pendingAuditors(runId: string): AgentWorkState[] {
    const detail = this.getRunDetail(runId);
    if (!detail) throw new Error(`Unknown run: ${runId}`);
    const pendingNames = new Set(computeAuditorConsensus(detail.run.auditors, detail.agentStates, detail.nodes).pendingAuditors);
    return detail.run.auditors.flatMap((agent) => {
      const state = detail.agentStates.find((candidate) => candidate.agent === agent);
      if (!pendingNames.has(agent)) return [];
      const synthetic: AgentWorkState = state ?? {
        agent,
        phase: "waiting",
        summary: "Auditoría pendiente de iniciar",
        completed: 0,
        total: detail.nodes.length,
        reviewedNodeIds: [],
        remainingNodeIds: detail.nodes.map((node) => node.id),
        updatedAt: detail.run.updatedAt,
      };
      return [synthetic];
    });
  }

  pendingAuditorVotes(runId: string): number {
    const detail = this.getRunDetail(runId);
    if (!detail) throw new Error(`Unknown run: ${runId}`);
    return computeAuditorConsensus(detail.run.auditors, detail.agentStates, detail.nodes).pendingAuditorVotes;
  }

  addActivity(runId: string, type: ActivityType, message: string, detail?: string, nodeId?: string, agent?: string): Activity {
    const createdAt = now();
    const result = this.database.prepare("INSERT INTO activity (run_id, node_id, type, message, detail, agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(runId, nodeId ?? null, type, message, detail ?? null, agent ?? null, createdAt);
    this.touchRun(runId, createdAt);
    return { id: Number(result.lastInsertRowid), runId, nodeId, type, message, detail, agent: agent ?? undefined, createdAt };
  }

  private runFromRow(row: Row): RunSummary {
    const counts = this.database.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) AS awaitingApproval
      FROM nodes WHERE run_id = ?
    `).get(String(row.id)) as Row;
    const findingCounts = this.database.prepare(
      "SELECT COUNT(*) AS open FROM findings WHERE run_id = ? AND status IN ('open','debating','escalated')",
    ).get(String(row.id)) as Row;
    const total = Number(counts.total ?? 0);
    const completed = Number(counts.completed ?? 0);
    const status: NodeStatus = Number(counts.failed ?? 0) > 0 ? "failed"
      : Number(counts.running ?? 0) > 0 ? "running"
        : total > 0 && total === completed ? "completed" : "pending";
    const runId = String(row.id);
    const auditors = row.auditors_json ? JSON.parse(String(row.auditors_json)) as string[] : [];
    const auditorStates = (this.database.prepare("SELECT agent, phase, started_at, updated_at FROM agent_states WHERE run_id = ?").all(runId) as Row[])
      .map((state) => ({
        agent: String(state.agent),
        phase: String(state.phase) as AgentWorkPhase,
        startedAt: state.started_at ? String(state.started_at) : undefined,
        updatedAt: state.updated_at ? String(state.updated_at) : undefined,
      }));
    const nodeChanges = (this.database.prepare("SELECT assignee, executed_by, updated_at FROM nodes WHERE run_id = ?").all(runId) as Row[])
      .map((node) => ({
        assignee: node.assignee ? String(node.assignee) : undefined,
        executedBy: node.executed_by ? String(node.executed_by) : undefined,
        updatedAt: String(node.updated_at),
      }));
    const auditorConsensus = computeAuditorConsensus(auditors, auditorStates, nodeChanges);
    return {
      id: runId, projectId: String(row.project_id), title: String(row.title), requirement: String(row.requirement),
      status, control: (row.control ? String(row.control) : "active") as RunControl,
      graphVersion: Number(row.graph_version),
      baseAgent: row.base_agent ? String(row.base_agent) : undefined,
      seenAgents: row.seen_agents_json ? JSON.parse(String(row.seen_agents_json)) as string[] : [],
      auditors,
      pendingAuditorCount: auditorConsensus.pendingAuditors.length,
      pendingAuditorVotes: auditorConsensus.pendingAuditorVotes,
      nodeCount: total, completedCount: completed, awaitingApproval: Number(counts.awaitingApproval ?? 0),
      openFindings: Number(findingCounts.open ?? 0),
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
