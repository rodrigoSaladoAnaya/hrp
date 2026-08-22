import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  auditorIdentity,
  computeAuditorConsensus,
  type AgentWorkState,
  type AgentWorkPhase,
  type Activity,
  type ActivityType,
  findingScopeFor,
  findingScopes,
  findingSeverities,
  findingStatuses,
  type ChangeNode,
  type ChangeNodeInput,
  type Finding,
  type FindingScope,
  type FindingAgreement,
  type FindingInput,
  type FindingMessage,
  type FindingStatus,
  type GraphInput,
  type NodeStatus,
  type OllamaSettings,
  type OllamaSettingsView,
  type PlanGateStatus,
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

export type AttentionRelease = {
  runId: string;
  agent: string;
  createdAt: string;
};

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

// El estado de un archivo del run frente al disco. 'attributed': el contenido
// sigue siendo el que su nodo publicó. 'drifted': cambió después. 'unknown': no
// hay huella con la que comparar, porque el archivo no existe o ningún nodo
// suyo ha completado todavía.
export type AttributionStatus = "attributed" | "drifted" | "unknown";

export interface FileAttribution {
  file: string;
  nodeId?: string;
  status: AttributionStatus;
  publishedHash?: string;
  currentHash?: string;
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
        scope TEXT NOT NULL DEFAULT 'integration' CHECK(scope IN ('node','integration','plan')),
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
      CREATE TABLE IF NOT EXISTS finding_agreements (
        finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
        agent TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (finding_id, agent)
      );
      -- Pasada de auditoría del plan: una fila significa que ese auditor ya
      -- opinó sobre esa versión del grafo, con hallazgos o declarándolo sano.
      -- La versión es parte de la clave porque republicar el plan invalida lo
      -- opinado sobre el anterior: lo que se revisó ya no es lo que se aprueba.
      CREATE TABLE IF NOT EXISTS plan_passes (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        auditor TEXT NOT NULL,
        graph_version INTEGER NOT NULL,
        findings INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, auditor, graph_version)
      );
      CREATE TABLE IF NOT EXISTS attention_releases (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        agent TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, agent)
      );
      CREATE INDEX IF NOT EXISTS runs_project_updated ON runs(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS activity_run_id ON activity(run_id, id DESC);
      CREATE INDEX IF NOT EXISTS findings_run ON findings(run_id, created_at);
      CREATE INDEX IF NOT EXISTS finding_messages_finding ON finding_messages(finding_id, created_at);
      CREATE INDEX IF NOT EXISTS finding_agreements_finding ON finding_agreements(finding_id, created_at);
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
    // Antes de v3.2 el alcance del hallazgo se leía de la ausencia de node_id;
    // el backfill conserva esa lectura y deja 'plan' sólo para los que nazcan
    // de la auditoría del grafo, que declara su scope de forma explícita.
    const findingColumns = this.database.pragma("table_info(findings)") as Row[];
    if (!findingColumns.some((column) => String(column.name) === "scope")) {
      this.database.exec("ALTER TABLE findings ADD COLUMN scope TEXT NOT NULL DEFAULT 'integration'");
      this.database.exec("UPDATE findings SET scope = CASE WHEN node_id IS NULL THEN 'integration' ELSE 'node' END");
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
    // Huellas del archivo del nodo: baseline_hash es lo que había cuando el
    // agente arrancó, published_hash lo que había cuando publicó su diff. Con
    // las dos se distingue lo que cambió el nodo de lo que cambió otra sesión
    // editando el mismo archivo al mismo tiempo. Los nodos anteriores quedan en
    // NULL, que es la forma de decir "de este no hay huella".
    if (!nodeColumns.some((column) => String(column.name) === "baseline_hash")) {
      this.database.exec("ALTER TABLE nodes ADD COLUMN baseline_hash TEXT");
    }
    if (!nodeColumns.some((column) => String(column.name) === "published_hash")) {
      this.database.exec("ALTER TABLE nodes ADD COLUMN published_hash TEXT");
    }
    // La huella prueba que el archivo cambió; el texto anterior es lo único que
    // permite comparar en qué cambió contra lo que el diff declara. Pesa lo
    // mismo, en orden de magnitud, que el diff que ya se guarda por nodo.
    if (!nodeColumns.some((column) => String(column.name) === "baseline_content")) {
      this.database.exec("ALTER TABLE nodes ADD COLUMN baseline_content TEXT");
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
    if (!runColumns.some((column) => String(column.name) === "change_branch")) {
      this.database.exec("ALTER TABLE runs ADD COLUMN change_branch TEXT");
    }
    // Compatibilidad con runs antiguos que registraron una aprobación con
    // override cuando la auditoría del plan sí bloqueaba.
    // NULL es lo normal: nadie se saltó la ronda. Las ejecuciones anteriores a
    // v3.3 quedan en NULL y sin filas en plan_passes, que es lo correcto porque
    // su gate ya se decidió cuando la ronda todavía no bloqueaba nada.
    if (!runColumns.some((column) => String(column.name) === "plan_override_version")) {
      this.database.exec("ALTER TABLE runs ADD COLUMN plan_override_version INTEGER");
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

  // La huella se calcula sobre el archivo real del workspace, no sobre el diff:
  // el diff es lo que el agente dice haber hecho y el archivo es lo que de
  // verdad hay en disco. Devuelve undefined cuando no hay archivo que medir
  // —un nodo que crea un archivo nuevo, o un workspace que ya no existe—
  // porque la ausencia de huella no es un error, es "todavía no hay nada".
  private readWorkspaceFile(runId: string, file: string): string | undefined {
    const run = this.getRun(runId);
    const project = run ? this.getProject(run.projectId) : undefined;
    if (!project) return undefined;
    const resolved = path.resolve(project.workspaceRoot, file);
    // Un 'file' con .. sacaría la lectura fuera del workspace observado.
    if (resolved !== project.workspaceRoot && !resolved.startsWith(project.workspaceRoot + path.sep)) return undefined;
    try {
      if (!existsSync(resolved) || !statSync(resolved).isFile()) return undefined;
      return readFileSync(resolved, "utf8");
    } catch {
      return undefined;
    }
  }

  private hashWorkspaceFile(runId: string, file: string): string | undefined {
    const content = this.readWorkspaceFile(runId, file);
    return content === undefined ? undefined : createHash("sha256").update(content).digest("hex");
  }

  private gitOutput(project: Project, args: string[]): string | undefined {
    try {
      return execFileSync("git", args, {
        cwd: project.workspaceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return undefined;
    }
  }

  private requireGit(project: Project, args: string[]): string {
    try {
      return execFileSync("git", args, {
        cwd: project.workspaceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Git could not prepare the HRP safeguard branch: ${detail}`);
    }
  }

  private runBranchName(runId: string): string {
    return `hrp/run-${runId}`;
  }

  private activeRunOwningBranch(branch: string, run: RunSummary): RunSummary | undefined {
    const row = this.database.prepare(
      "SELECT id FROM runs WHERE change_branch = ? AND project_id = ? AND id != ?",
    ).get(branch, run.projectId, run.id) as Row | undefined;
    if (!row) return undefined;
    const other = this.getRun(String(row.id));
    if (!other) return undefined;
    // Una ejecución terminada o detenida ya no reclama el workspace: su branch
    // es un punto de partida legítimo para la siguiente.
    return other.status === "completed" || other.control === "stopped" ? undefined : other;
  }

  private ensureRunBranchForPendingChanges(run: RunSummary, nodeId: string, agent?: string): void {
    const project = this.getProject(run.projectId);
    if (!project) return;
    // Los archivos sin seguimiento no pertenecen a ninguna rama: viajan con el
    // working tree se cambie o no de branch, así que contarlos sólo produciría
    // ramas que no resguardan nada.
    const status = this.gitOutput(project, ["status", "--porcelain", "--untracked-files=no"]);
    if (status === undefined) return;
    const hasPendingChanges = status.trim().length > 0;
    const currentBranch = this.gitOutput(project, ["branch", "--show-current"])?.trim();
    const actor = agent ?? run.baseAgent;

    if (run.changeBranch) {
      if (currentBranch === run.changeBranch) return;
      if (!hasPendingChanges) {
        this.requireGit(project, ["switch", run.changeBranch]);
        this.addActivity(run.id, "note", `Branch de salvaguarda reutilizado: ${run.changeBranch}`,
          `El árbol estaba limpio; HRP volvió al branch registrado para esta ejecución antes de iniciar ${nodeId}.`,
          nodeId, actor);
        return;
      }
      throw new Error(`Run ${run.id} already uses safeguard branch ${run.changeBranch}, but the workspace is on ${currentBranch || "detached HEAD"} with pending changes. Save or switch those changes before starting ${nodeId}`);
    }

    if (!hasPendingChanges) return;

    // Otra ejecución viva puede haber dejado el workspace sobre su propio branch
    // de salvaguarda con trabajo sin commitear. Crear aquí el branch de este run
    // arrastraría esos cambios ajenos a la rama nueva, que es exactamente la
    // mezcla entre ejecuciones que la salvaguarda existe para impedir.
    const owner = currentBranch ? this.activeRunOwningBranch(currentBranch, run) : undefined;
    if (owner) {
      throw new Error(`Run ${run.id} cannot create its safeguard branch: the workspace is on ${currentBranch} with pending changes that belong to run ${owner.id}. Let that run finish or commit its work before starting ${nodeId}`);
    }

    const branch = this.runBranchName(run.id);
    const exists = this.gitOutput(project, ["show-ref", "--verify", `refs/heads/${branch}`]) !== undefined;
    if (currentBranch !== branch) {
      this.requireGit(project, exists ? ["switch", branch] : ["switch", "-c", branch]);
    }
    const timestamp = now();
    this.database.prepare("UPDATE runs SET change_branch = ?, updated_at = ? WHERE id = ?")
      .run(branch, timestamp, run.id);
    this.addActivity(run.id, "note", `${exists ? "Branch de salvaguarda reutilizado" : "Branch de salvaguarda creado"}: ${branch}`,
      `HRP detectó cambios pendientes antes de iniciar ${nodeId} y dejó la ejecución en ${branch}.`,
      nodeId, actor);
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
    // La pausa habilita reemplazar auditores agotados, no quedarse sin ninguno.
    // approveNodes exige al menos uno para dejar arrancar el grafo; si la
    // reconfiguración pudiera vaciar la lista, auditMajority(0) daría cero votos
    // requeridos y 'hrp review gate' declararía revisión limpia sobre una
    // ejecución que nadie revisó. La garantía se sostiene o no se sostiene.
    if (approved && normalized.length === 0) {
      throw new Error("A run with approved nodes cannot be left without auditors; replace them instead of removing the last one");
    }
    const reconfiguring = Boolean(approved);
    const timestamp = now();
    const previousDetail = this.getRunDetail(runId)!;
    this.database.prepare("UPDATE runs SET auditors_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(normalized), timestamp, runId);
    for (const removed of run.auditors.filter((agent) => !normalized.includes(agent))) {
      const previous = previousDetail.agentStates.find((state) => state.agent === removed);
      if (!previous || previous.summary === "Seleccionado para auditar") {
        this.database.prepare("DELETE FROM agent_states WHERE run_id = ? AND agent = ? AND summary = 'Seleccionado para auditar'")
          .run(runId, removed);
      } else {
        this.setAgentState(runId, {
          agent: removed,
          phase: "waiting",
          summary: "Retirado de auditoría por el humano",
          detail: "La ejecución estaba pausada al reconfigurar auditores; no cierres una auditoría con la lista anterior.",
          completed: previous.completed,
          total: previous.total,
          reviewedNodeIds: previous.reviewedNodeIds,
          remainingNodeIds: previous.remainingNodeIds,
        });
      }
    }
    const nodeIds = previousDetail.nodes.map((node) => node.id);
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
      // startedAt es el reloj contra el que auditorVoteIsCurrent decide si una
      // pasada sigue vigente. Escribirlo sin fusionar dejaba que cualquier
      // llamada del ciclo de implementación lo pusiera en NULL, y entonces el
      // voto caía en updatedAt = ahora y revalidaba cobertura vieja sola.
      startedAt: state.startedAt ?? previous?.startedAt,
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
    const effectiveBaseAgent = run.baseAgent ?? agent;
    if (agent) {
      if (!run.baseAgent) this.database.prepare("UPDATE runs SET base_agent = ? WHERE id = ?").run(effectiveBaseAgent, runId);
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
    // Si no hay una delegación sugerida, el nodo pertenece explícitamente al
    // modelo base. La asignación humana existente siempre gana.
    const defaultAssign = this.database.prepare(`
      UPDATE nodes SET assignee = @assignee
      WHERE run_id = @runId AND id = @id AND assignee IS NULL AND status IN ('pending','failed')
    `);
    const timestamp = now();
    this.database.transaction((nodes: ChangeNodeInput[]) => {
      for (const node of nodes) {
        // contextFiles se separa del spread: el binding nombrado no admite claves sobrantes.
        const { contextFiles, ...fields } = node;
        upsert.run({ ...fields, runId, discovered: node.discovered ? 1 : 0, suggestedAgent: node.suggestedAgent ?? null, contextJson: contextFiles?.length ? JSON.stringify(contextFiles) : null, dependencies: JSON.stringify(node.dependencies), timestamp });
        const assignee = node.suggestedAgent ?? effectiveBaseAgent;
        if (assignee) defaultAssign.run({ runId, id: node.id, assignee });
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
    this.clearAttentionRelease(runId, agent);
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

  releaseAttention(runId: string, agent: string): AttentionRelease {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    this.registerAgent(runId, agent);
    this.addActivity(runId, "note", `Atención liberada para ${agent}`, "El comando hrp attention release despierta cualquier espera activa de ese agente en esta ejecución.", undefined, agent);
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO attention_releases (run_id, agent, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(run_id, agent) DO UPDATE SET created_at = excluded.created_at
    `).run(runId, agent, timestamp);
    return { runId, agent, createdAt: timestamp };
  }

  getAttentionRelease(runId: string, agent: string): AttentionRelease | undefined {
    const row = this.database.prepare("SELECT * FROM attention_releases WHERE run_id = ? AND agent = ?").get(runId, agent) as Row | undefined;
    return row ? { runId: String(row.run_id), agent: String(row.agent), createdAt: String(row.created_at) } : undefined;
  }

  clearAttentionRelease(runId: string, agent: string): void {
    this.database.prepare("DELETE FROM attention_releases WHERE run_id = ? AND agent = ?").run(runId, agent);
  }

  // Ronda de plan: quién ya opinó sobre la versión vigente del grafo. 'open'
  // sólo significa "hay auditores pendientes antes de que arranque"; no retiene
  // la aprobación humana.
  planGateStatus(runId: string): PlanGateStatus {
    const row = this.database.prepare("SELECT graph_version, auditors_json, plan_override_version FROM runs WHERE id = ?").get(runId) as Row | undefined;
    if (!row) throw new Error(`Unknown run: ${runId}`);
    const graphVersion = Number(row.graph_version);
    const auditors = row.auditors_json ? JSON.parse(String(row.auditors_json)) as string[] : [];
    const overriddenVersion = row.plan_override_version == null ? undefined : Number(row.plan_override_version);
    const passed = new Set((this.database.prepare("SELECT auditor FROM plan_passes WHERE run_id = ? AND graph_version = ?").all(runId, graphVersion) as Row[])
      .map((pass) => String(pass.auditor)));
    const reviewed = auditors.filter((auditor) => passed.has(auditor));
    const pending = auditors.filter((auditor) => !passed.has(auditor));
    const counts = this.database.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN approved = 1 THEN 1 ELSE 0 END) AS approved FROM nodes WHERE run_id = ?").get(runId) as Row;
    const open = Number(counts.total ?? 0) > 0
      && Number(counts.approved ?? 0) === 0
      && auditors.length > 0
      && pending.length > 0
      && overriddenVersion !== graphVersion;
    return { graphVersion, auditors, reviewed, pending, open, overriddenVersion };
  }

  // Un auditor declara que ya revisó ESTA versión del plan. Vale igual con
  // hallazgos que sin ellos: lo que la ronda exige es su opinión, no su
  // conformidad, porque quien decide sobre los hallazgos es el humano.
  recordPlanPass(runId: string, auditor: string, findings = 0): PlanGateStatus {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (!run.auditors.includes(auditor)) {
      throw new Error(`${auditor} is not an auditor of run ${runId}; the human chooses the auditors in the panel`);
    }
    if (run.nodeCount === 0) throw new Error(`Run has no published graph yet: ${runId}`);
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO plan_passes (run_id, auditor, graph_version, findings, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, auditor, graph_version) DO UPDATE SET findings = excluded.findings, created_at = excluded.created_at
    `).run(runId, auditor, run.graphVersion, findings, timestamp);
    this.touchRun(runId, timestamp);
    const status = this.planGateStatus(runId);
    this.addActivity(runId, "graph",
      `Auditoría del plan cerrada por ${auditor} · ${findings === 0 ? "sin hallazgos" : `${findings} ${findings === 1 ? "hallazgo" : "hallazgos"}`} sobre la versión ${run.graphVersion}`,
      status.pending.length ? `Faltan por opinar: ${status.pending.join(", ")}` : "Ronda completa.",
      undefined, auditor);
    return status;
  }

  // La auditoría del plan es paralela al flujo humano: los auditores pueden
  // publicar hallazgos de grafo cuando despierten, pero no retienen la aprobación
  // inicial. El parámetro force queda en la API por compatibilidad y ya no cambia
  // el comportamiento.
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
    const run = this.getRun(runId);
    const paused = run?.control === "paused";
    // Un agente que se queda sin presupuesto deja su nodo en vuelo. Aunque
    // puedan correr otros nodos compatibles, el humano sólo puede recuperarlo
    // con la ejecución pausada: vuelve a 'pending' y pierde su ejecutor, pero
    // conserva el diff y la verificación del intento como evidencia.
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
      const previousAgent = node.executedBy ?? node.assignee;
      if (previousAgent) {
        // El estado de un agente es uno solo para sus dos papeles. Recuperarle
        // un nodo propio actualiza lo que ejecuta, pero no puede tocar lo que
        // audita: reviewedNodeIds y un voto ya emitido son trabajo publicado
        // sobre nodos ajenos, y startedAt es el reloj contra el que ese voto se
        // declara vigente. Borrarlos aquí obligaría al auditor a rehacer una
        // pasada que sigue siendo válida.
        const previousState = this.getRunDetail(runId)?.agentStates.find((state) => state.agent === previousAgent);
        const assigned = this.nodesForAgent(runId, previousAgent);
        const reviewed = previousState?.reviewedNodeIds ?? [];
        const alreadyReviewed = new Set(reviewed);
        const keepsVote = Boolean(run?.auditors.includes(previousAgent)) && previousState?.phase === "completed";
        this.setAgentState(runId, {
          agent: previousAgent,
          phase: keepsVote ? "completed" : "waiting",
          summary: `Nodo recuperado por el humano: ${node.file} · ${node.symbol}`,
          detail: "La ejecución estaba pausada; relee el estado antes de retomar porque el nodo en curso pudo cambiar de dueño.",
          completed: assigned.filter((candidate) => candidate.status === "completed").length,
          total: assigned.length,
          reviewedNodeIds: reviewed,
          // El almacén prohíbe que un nodo esté a la vez revisado y pendiente.
          remainingNodeIds: assigned
            .filter((candidate) => candidate.status !== "completed" && !alreadyReviewed.has(candidate.id))
            .map((candidate) => candidate.id),
          startedAt: previousState?.startedAt,
        });
      }
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

  private dependsOn(nodesById: Map<string, ChangeNode>, nodeId: string, dependencyId: string, seen = new Set<string>()): boolean {
    if (nodeId === dependencyId) return true;
    if (seen.has(nodeId)) return false;
    seen.add(nodeId);
    const node = nodesById.get(nodeId);
    if (!node) return false;
    return node.dependencies.some((dependency) => this.dependsOn(nodesById, dependency, dependencyId, seen));
  }

  private concurrentConflict(candidate: ChangeNode, running: ChangeNode, nodesById: Map<string, ChangeNode>): string | undefined {
    if (candidate.file === running.file) return `both modify ${candidate.file}`;
    if (running.contextFiles?.includes(candidate.file)) return `${running.id} is using ${candidate.file} as approved context`;
    if (candidate.contextFiles?.includes(running.file)) return `${candidate.id} would read ${running.file} while ${running.id} is changing it`;
    if (this.dependsOn(nodesById, candidate.id, running.id)) return `${candidate.id} depends on running node ${running.id}`;
    if (this.dependsOn(nodesById, running.id, candidate.id)) return `running node ${running.id} depends on ${candidate.id}`;
    return undefined;
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
    const detail = this.getRunDetail(runId);
    const nodesById = new Map((detail?.nodes ?? []).map((candidate) => [candidate.id, candidate]));
    const inFlight = (detail?.nodes ?? []).filter((candidate) => candidate.status === "running" && candidate.id !== nodeId);
    // El estado por agente modela un solo nodo actual (currentNodeId), así que
    // un agente con dos nodos en vuelo perdería el rastro de uno: el panel y la
    // señal de atención sólo pueden nombrar el último. La concurrencia se abre
    // entre agentes distintos, no dentro del mismo.
    const executor = agent ?? node.assignee;
    const busy = executor
      ? inFlight.find((candidate) => (candidate.executedBy ?? candidate.assignee) === executor)
      : undefined;
    if (busy) {
      throw new Error(`Agent ${executor} is already running ${busy.id}; close it with patch, verify and complete before starting ${nodeId}`);
    }
    const conflict = inFlight
      .map((running) => ({ running, reason: this.concurrentConflict(node, running, nodesById) }))
      .find((item) => item.reason);
    if (conflict) {
      throw new Error(`Node ${nodeId} cannot run concurrently with ${conflict.running.id}: ${conflict.reason}. Wait for the conflicting node to finish`);
    }
    this.ensureRunBranchForPendingChanges(run, nodeId, agent);
    this.updateNodeStatus(runId, nodeId, "running");
    // El arranque es el único instante en que HRP sabe qué contenía el archivo
    // antes de que el agente lo tocara. Sin esa foto no hay forma posterior de
    // separar lo que hizo este nodo de lo que hizo otra sesión en paralelo.
    const baselineContent = this.readWorkspaceFile(runId, node.file);
    const baseline = baselineContent === undefined
      ? undefined
      : createHash("sha256").update(baselineContent).digest("hex");
    this.database.prepare("UPDATE nodes SET baseline_hash = ?, baseline_content = ? WHERE run_id = ? AND id = ?")
      .run(baseline ?? null, baselineContent ?? null, runId, nodeId);
    const lastPublished = this.database.prepare(`
      SELECT id, published_hash FROM nodes
      WHERE run_id = ? AND file = ? AND id != ? AND published_hash IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1
    `).get(runId, node.file, nodeId) as Row | undefined;
    if (baseline && lastPublished && String(lastPublished.published_hash) !== baseline) {
      this.addActivity(runId, "note",
        `El archivo cambió fuera de HRP antes de este nodo: ${node.file}`,
        `El último nodo del run que publicó sobre este archivo (${String(lastPublished.id)}) lo dejó con otro contenido. Alguien lo editó entre aquella publicación y este arranque, así que el diff que publiques aquí no describirá todo lo que hay en el archivo.`,
        nodeId, agent ?? node.assignee ?? run.baseAgent);
    }
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

  // Compara el cambio real del archivo (base guardada al arrancar contra lo que
  // hay ahora) con el que el diff declara. Trabaja con multiconjuntos de líneas
  // en vez de aplicar el parche: si el archivo ganó o perdió líneas que el diff
  // no menciona, alguien más lo editó mientras este nodo estaba en curso.
  // Devuelve undefined cuando no hay nada que reprochar o nada con qué comparar.
  private undeclaredChange(runId: string, nodeId: string, diff: string, current: string | undefined): string | undefined {
    if (current === undefined) return undefined;
    const row = this.database.prepare("SELECT baseline_content FROM nodes WHERE run_id = ? AND id = ?")
      .get(runId, nodeId) as Row | undefined;
    if (!row || row.baseline_content === null || row.baseline_content === undefined) return undefined;
    const tally = (lines: string[]): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
      return counts;
    };
    const surplus = (left: Map<string, number>, right: Map<string, number>): string[] => {
      const extra: string[] = [];
      for (const [line, count] of left) {
        const spare = count - (right.get(line) ?? 0);
        for (let index = 0; index < spare; index += 1) extra.push(line);
      }
      return extra;
    };
    const baselineLines = tally(String(row.baseline_content).split("\n"));
    const currentLines = tally(current.split("\n"));
    const realAdded = tally(surplus(currentLines, baselineLines));
    const realRemoved = tally(surplus(baselineLines, currentLines));
    const declaredAdded = tally(diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)));
    const declaredRemoved = tally(diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).map((line) => line.slice(1)));
    const addedGap = surplus(realAdded, declaredAdded);
    const removedGap = surplus(realRemoved, declaredRemoved);
    if (!addedGap.length && !removedGap.length) return undefined;
    const sample = (lines: string[], mark: string) => lines
      .filter((line) => line.trim())
      .slice(0, 3)
      .map((line) => `${mark} ${line.trim().slice(0, 120)}`);
    const detail = [
      `El diff publicado no explica todo el cambio del archivo: ${addedGap.length} ${addedGap.length === 1 ? "línea añadida" : "líneas añadidas"} y ${removedGap.length} ${removedGap.length === 1 ? "línea eliminada" : "líneas eliminadas"} sin declarar.`,
      "Lo más probable es que otra sesión esté editando el mismo archivo. El diff sigue siendo evidencia válida de lo que hizo este nodo, pero no describe el archivo completo, y un commit por nombre de archivo se llevaría también lo ajeno.",
      ...sample(addedGap, "sin declarar +"),
      ...sample(removedGap, "sin declarar -"),
    ].join("\n");
    return detail;
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
    const current = this.readWorkspaceFile(runId, node.file);
    const publishedHash = current === undefined
      ? undefined
      : createHash("sha256").update(current).digest("hex");
    this.database.prepare("UPDATE nodes SET diff = ?, patch_summary = ?, patch_rationale = ?, published_hash = ?, updated_at = ? WHERE run_id = ? AND id = ?")
      .run(diff, summary, rationale?.trim() || null, publishedHash ?? null, timestamp, runId, nodeId);
    this.touchRun(runId, timestamp);
    const nodeAgent = node.executedBy ?? node.assignee ?? this.getRun(runId)?.baseAgent;
    this.addActivity(runId, "patch", `Diff aplicado: ${node.file} · ${node.symbol}`, summary, nodeId, nodeAgent);
    const undeclared = this.undeclaredChange(runId, nodeId, diff, current);
    if (undeclared) {
      // Aviso, no rechazo. El trabajo concurrente legítimo existe, y bloquear la
      // publicación dejaría al agente sin poder registrar la evidencia de lo que
      // sí hizo. Lo que no puede pasar es que nadie se entere.
      this.addActivity(runId, "note",
        `El archivo cambió más de lo que declara este diff: ${node.file}`,
        undeclared, nodeId, nodeAgent);
    }
    return this.requireNode(runId, nodeId);
  }

  // Qué del árbol observado está respaldado por evidencia y qué no. No ejecuta
  // git: compara la huella que dejó el último nodo completado de cada archivo
  // contra lo que hay en disco ahora. 'drifted' es el caso que importa —el
  // archivo se movió después de que su nodo publicó, así que el diff revisado
  // ya no lo describe— y es justo lo que un commit por nombre se llevaría.
  workspaceAttribution(runId: string): FileAttribution[] {
    if (!this.getRun(runId)) throw new Error(`Unknown run: ${runId}`);
    const rows = this.database.prepare("SELECT id, file, status, published_hash FROM nodes WHERE run_id = ? ORDER BY updated_at")
      .all(runId) as Row[];
    const lastCompleted = new Map<string, Row>();
    for (const row of rows) {
      // El ORDER BY deja ganar al más reciente de cada archivo.
      if (String(row.status) === "completed") lastCompleted.set(String(row.file), row);
    }
    return [...new Set(rows.map((row) => String(row.file)))].sort().map((file) => {
      const last = lastCompleted.get(file);
      const nodeId = last ? String(last.id) : undefined;
      const currentHash = this.hashWorkspaceFile(runId, file);
      if (currentHash === undefined) return { file, nodeId, status: "unknown" as const };
      const publishedHash = last?.published_hash == null ? undefined : String(last.published_hash);
      if (!publishedHash) return { file, nodeId, status: "unknown" as const, currentHash };
      return {
        file,
        nodeId,
        status: publishedHash === currentHash ? ("attributed" as const) : ("drifted" as const),
        publishedHash,
        currentHash,
      };
    });
  }

  // Con varios nodos en vuelo el workspace deja de ser estable: un comando que
  // recorre todo el proyecto lee también los archivos que otro nodo tiene a
  // medio editar, así que su verde o su rojo no dicen nada sobre este nodo. La
  // concurrencia protege la escritura; el alcance del comando protege la
  // lectura, y sólo el propio comando puede declararlo.
  private verificationScopeTerms(node: ChangeNode): string[] {
    const terms = [node.id, node.file, ...node.symbol.split(/[^A-Za-z0-9_-]+/)];
    const stem = node.file.split("/").pop()?.replace(/\.[^.]+$/, "");
    if (stem) terms.push(stem);
    return terms.filter((term) => term && term.length >= 3);
  }

  publishVerification(runId: string, nodeId: string, verification: Omit<Verification, "passed" | "observedAt">): ChangeNode {
    const node = this.requireNode(runId, nodeId);
    const inFlight = (this.getRunDetail(runId)?.nodes ?? [])
      .filter((candidate) => candidate.status === "running" && candidate.id !== nodeId);
    if (inFlight.length) {
      const terms = this.verificationScopeTerms(node);
      const scoped = terms.some((term) => verification.command.includes(term));
      if (!scoped) {
        throw new Error(`Verification of ${nodeId} does not declare its scope while ${inFlight.map((candidate) => candidate.id).join(", ")} ${inFlight.length === 1 ? "is" : "are"} running: '${verification.command}' would also read files those nodes are editing. Name the node's file, symbol or id in the command, or wait for them to finish before running a project-wide check`);
      }
    }
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
      const previousState = this.getRunDetail(runId)?.agentStates.find((state) => state.agent === node.executedBy);
      const reviewed = previousState?.reviewedNodeIds ?? [];
      const alreadyReviewed = new Set(reviewed);
      const remaining = assigned
        .filter((candidate) => candidate.status !== "completed" && !alreadyReviewed.has(candidate.id))
        .map((candidate) => candidate.id);
      // Terminar de implementar no es haber auditado. Para un agente que
      // también está en run.auditors, escribir 'completed' aquí equivalía a un
      // voto: auditorVoteIsCurrent solo mira la fase y el reloj, y esta ruta no
      // pasa por la validación de cobertura de /api/runs/:id/agents/:agent/status.
      // El voto tiene que venir de una pasada declarada, no de un efecto lateral.
      const audits = Boolean(this.getRun(runId)?.auditors.includes(node.executedBy));
      this.setAgentState(runId, {
        agent: node.executedBy,
        phase: remaining.length || audits ? "waiting" : "completed",
        summary: remaining.length
          ? `Esperando la siguiente operación · ${remaining.length} pendiente${remaining.length === 1 ? "" : "s"}`
          : audits ? "Implementación asignada terminada; falta declarar la pasada de auditoría" : "Implementación asignada terminada",
        completed,
        total: assigned.length,
        reviewedNodeIds: reviewed,
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
    const agreements = (this.database.prepare("SELECT * FROM finding_agreements WHERE finding_id = ? ORDER BY created_at, agent").all(String(row.id)) as Row[]).map((agreement) => ({
      agent: String(agreement.agent),
      createdAt: String(agreement.created_at),
    } satisfies FindingAgreement));
    const requiredAgreementAgents = this.findingAgreementAgents(String(row.run_id));
    const agreed = new Set(agreements.map((agreement) => auditorIdentity(agreement.agent)));
    return {
      id: String(row.id),
      runId: String(row.run_id),
      nodeId: row.node_id ? String(row.node_id) : undefined,
      scope: (row.scope ? String(row.scope) : findingScopeFor(row.node_id ? String(row.node_id) : undefined)) as FindingScope,
      reviewer: String(row.reviewer),
      severity: String(row.severity) as Finding["severity"],
      title: String(row.title),
      body: String(row.body),
      status: String(row.status) as FindingStatus,
      resolutionNodeId: row.resolution_node_id ? String(row.resolution_node_id) : undefined,
      agreements,
      requiredAgreementAgents,
      unanimous: requiredAgreementAgents.length > 0 && requiredAgreementAgents.every((agent) => agreed.has(agent)),
      messages,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  createFinding(runId: string, input: FindingInput): Finding {
    if (!this.getRun(runId)) throw new Error(`Unknown run: ${runId}`);
    if (!findingSeverities.includes(input.severity)) throw new Error(`Unknown severity: ${input.severity}`);
    const scope: FindingScope = input.scope ?? findingScopeFor(input.nodeId);
    if (!findingScopes.includes(scope)) throw new Error(`Unknown finding scope: ${scope}`);
    // El hallazgo de plan audita el grafo, no un cambio: aceptar un node_id lo
    // haría contar como revisión de ese nodo en la cobertura del auditor.
    if (scope === "plan" && input.nodeId) throw new Error("A plan finding reviews the graph, not a node: cite the node id in the body instead of nodeId");
    if (scope !== "plan" && scope !== findingScopeFor(input.nodeId)) {
      throw new Error(`Finding scope '${scope}' contradicts nodeId: ${input.nodeId ? "a finding with nodeId is 'node'" : "a finding without nodeId is 'integration'"}`);
    }
    if (input.nodeId) this.requireNode(runId, input.nodeId);
    const id = randomUUID();
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO findings (id, run_id, node_id, reviewer, severity, title, body, status, scope, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
    `).run(id, runId, input.nodeId ?? null, input.reviewer, input.severity, input.title, input.body, scope, timestamp, timestamp);
    this.recordFindingAgreement(id, input.reviewer, timestamp);
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

  agreeFinding(findingId: string, agent: string): Finding {
    const finding = this.requireFinding(findingId);
    if (finding.status === "rejected" || finding.status === "escalated") {
      throw new Error(`Finding ${findingId} is ${finding.status}; reopen it before agreeing`);
    }
    const identity = auditorIdentity(agent.trim());
    if (!identity || !finding.requiredAgreementAgents.includes(identity)) {
      throw new Error(`Agent ${agent} is not the base model or a selected auditor for this finding`);
    }
    const timestamp = now();
    const inserted = this.recordFindingAgreement(findingId, identity, timestamp);
    if (inserted) {
      this.database.prepare("UPDATE findings SET updated_at = ? WHERE id = ?").run(timestamp, findingId);
      this.addActivity(finding.runId, "note", `Acuerdo de ${identity}: ${finding.title}`, "Aprueba que el reportero implemente la corrección vinculada si el consenso llega a unanimidad.", finding.nodeId, identity);
    }
    this.assignCorrectionToReporterIfUnanimous(findingId);
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
      if (status === "open" && finding.status !== "open" && finding.status !== "debating") {
        this.database.prepare("DELETE FROM finding_agreements WHERE finding_id = ?").run(findingId);
        this.recordFindingAgreement(findingId, finding.reviewer);
      }
      if (status === "accepted" && baseAgent) this.recordFindingAgreement(findingId, baseAgent);
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
        this.assignCorrectionToReporterIfUnanimous(findingId);
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

  private findingAgreementAgents(runId: string): string[] {
    const run = this.getRun(runId);
    if (!run) return [];
    return [...new Set([run.baseAgent, ...run.auditors]
      .map((agent) => auditorIdentity(agent))
      .filter((agent): agent is string => Boolean(agent)))];
  }

  private recordFindingAgreement(findingId: string, agent: string, createdAt = now()): boolean {
    const identity = auditorIdentity(agent.trim());
    if (!identity) return false;
    return this.database.prepare("INSERT OR IGNORE INTO finding_agreements (finding_id, agent, created_at) VALUES (?, ?, ?)")
      .run(findingId, identity, createdAt).changes > 0;
  }

  private assignCorrectionToReporterIfUnanimous(findingId: string): void {
    const finding = this.requireFinding(findingId);
    if (finding.status !== "accepted" || !finding.unanimous || !finding.resolutionNodeId) return;
    const reporter = auditorIdentity(finding.reviewer);
    if (!reporter || !finding.requiredAgreementAgents.includes(reporter)) return;
    const run = this.getRun(finding.runId);
    if (!run?.auditors.some((auditor) => auditorIdentity(auditor) !== reporter)) return;
    const node = this.getNode(finding.runId, finding.resolutionNodeId);
    if (!run || !node?.discovered || (node.status !== "pending" && node.status !== "failed")) return;
    if (node.suggestedAgent && auditorIdentity(node.suggestedAgent) !== reporter) return;
    if (node.assignee && auditorIdentity(node.assignee) !== auditorIdentity(run.baseAgent) && auditorIdentity(node.assignee) !== reporter) return;
    if (auditorIdentity(node.assignee) === reporter) return;
    const timestamp = now();
    this.database.prepare("UPDATE nodes SET assignee = ?, updated_at = ? WHERE run_id = ? AND id = ?")
      .run(reporter, timestamp, finding.runId, node.id);
    this.touchRun(finding.runId, timestamp);
    this.addActivity(finding.runId, "node", `Corrección asignada por unanimidad a ${reporter}: ${node.file} · ${node.symbol}`, `El modelo base y todos los auditores acordaron el hallazgo reportado por ${finding.reviewer}; el reportero conserva el contexto y su propio nodo queda fuera de su cobertura auditora.`, node.id, run.baseAgent);
  }

  // Hallazgos que impiden dar por cerrado el run: vivos u olvidados sin arbitrar.
  runReviewGate(runId: string): Finding[] {
    if (!this.getRun(runId)) throw new Error(`Unknown run: ${runId}`);
    // Los hallazgos de plan auditan el grafo antes de implementar: el humano ya
    // los vio al aprobar, así que no retienen la entrega del trabajo terminado.
    return this.listFindings(runId)
      .filter((finding) => finding.scope !== "plan")
      .filter((finding) => ["open", "debating", "escalated"].includes(finding.status));
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
      "SELECT COUNT(*) AS open FROM findings WHERE run_id = ? AND scope != 'plan' AND status IN ('open','debating','escalated')",
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
      changeBranch: row.change_branch ? String(row.change_branch) : undefined,
      seenAgents: row.seen_agents_json ? JSON.parse(String(row.seen_agents_json)) as string[] : [],
      auditors,
      pendingAuditorCount: auditorConsensus.pendingAuditors.length,
      pendingAuditorVotes: auditorConsensus.pendingAuditorVotes,
      // El panel decide con este dato si el botón de aprobar está disponible; sale
      // del mismo cálculo que approveNodes usa para rechazar, así que no pueden
      // discrepar sobre si la ronda del plan sigue abierta.
      planGate: this.planGateStatus(runId),
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
