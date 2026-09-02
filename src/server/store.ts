import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  computeAuditStatus,
  findingScopes,
  isLiveFinding,
  isValidFamily,
  nodeFilesOf,
  runBranchName,
  runIsOnHold,
  type AcceptanceCriterion,
  type Activity,
  type ActivityType,
  type AuditVote,
  type ChangeNode,
  type ChangeNodeInput,
  type Finding,
  type FindingInput,
  type FindingMessage,
  type FindingScope,
  type FindingSeverity,
  type FindingStatus,
  type NodeStatus,
  type Project,
  type RunControl,
  type RunDetail,
  type RunInput,
  type RunStatus,
  type RunSummary,
  type Session,
  type SessionRole,
  type SessionStatus,
  type Verification,
} from "../shared/protocol.js";
import { evolutionFileContentLimit, fileChangesFromDiff, type EvolutionData, type EvolutionFileContent, type EvolutionFrame } from "../shared/evolution.js";

type Row = Record<string, unknown>;

export type CloseResult = {
  run: RunSummary;
  acceptance: AcceptanceCriterion[];
  passed: boolean;
};

// Lo que el base observó al ejercitar un criterio de aceptación; se casa con
// el criterio por su texto.
export type ExerciseReport = { text: string; observed: string };

export type RunStart = {
  run: RunSummary;
  session: Session;
};

// Árbol de partida cuando git ya no alcanza el commit base: los archivos que
// los cuadros tocaron y que no nacieron en el run.
export function reconstructBaseFiles(frames: EvolutionFrame[]): string[] {
  const born = new Set<string>();
  const before = new Set<string>();
  for (const frame of frames) {
    for (const change of frame.files) {
      if (change.status === "A") { born.add(change.path); continue; }
      const previous = change.status === "R" ? change.from ?? change.path : change.path;
      if (!born.has(previous)) before.add(previous);
      if (change.status === "R") born.add(change.path);
    }
  }
  return [...before].sort();
}

// Tiempo máximo de un comando de verificación o de un criterio de aceptación.
export const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

function shortId(): string {
  return randomBytes(4).toString("hex");
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

function sessionFromRow(row: Row): Session {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    family: String(row.family),
    role: String(row.role) as SessionRole,
    status: String(row.status) as SessionStatus,
    reviewedNodeIds: JSON.parse(String(row.reviewed_json ?? "[]")) as string[],
    requirementReviewed: Boolean(row.requirement_reviewed),
    integrationReviewed: Boolean(row.integration_reviewed),
    vote: row.vote ? (String(row.vote) as AuditVote) : undefined,
    voteDetail: row.vote_detail ? String(row.vote_detail) : undefined,
    votedAt: row.voted_at ? String(row.voted_at) : undefined,
    attachedAt: String(row.attached_at),
    releasedAt: row.released_at ? String(row.released_at) : undefined,
    lastSeenAt: String(row.last_seen_at),
  };
}

function parseVerification(raw: unknown): Verification | undefined {
  return raw ? JSON.parse(String(raw)) as Verification : undefined;
}

// Escapes ANSI (colores, cursor, títulos de terminal) y retornos de carro de
// barras de progreso: en un run real eran el 74% de lo almacenado.
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\r(?!\n)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

// Si pasó, basta la cola para leer el resumen; si falló hace falta ver dónde
// empezó a romperse y cómo terminó.
export const PASSED_OUTPUT_LIMIT = 4_000;
export const FAILED_OUTPUT_HEAD = 6_000;
export const FAILED_OUTPUT_TAIL = 10_000;

export function trimVerificationOutput(output: string, passed: boolean): string {
  if (passed) return output.length > PASSED_OUTPUT_LIMIT ? `…\n${output.slice(-PASSED_OUTPUT_LIMIT)}` : output;
  return output.length > FAILED_OUTPUT_HEAD + FAILED_OUTPUT_TAIL
    ? `${output.slice(0, FAILED_OUTPUT_HEAD)}\n…\n${output.slice(-FAILED_OUTPUT_TAIL)}`
    : output;
}

// Ejecuta un comando en el workspace y devuelve la evidencia: salida sin
// color y recortada según el resultado, código de salida y hora. La máquina
// es quien verifica.
export function runVerification(workspaceRoot: string, command: string): Verification {
  const result = spawnSync("/bin/sh", ["-lc", command], {
    cwd: workspaceRoot,
    encoding: "utf8",
    timeout: VERIFY_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, HRP_VERIFYING: "1", NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
  });
  const output = stripAnsi(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  const timedOut = result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  const exitCode = timedOut ? 124 : result.status ?? 1;
  const passed = exitCode === 0;
  return { command, output: trimVerificationOutput(output, passed), exitCode, passed, observedAt: now() };
}

function frontMatter(fields: Record<string, string>): string {
  return ["---", ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), "---"].join("\n");
}

function bulletList(items: string[] | undefined, empty: string): string {
  return items && items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${empty}`;
}

export function renderIssue(fields: {
  id: string; project: string; workspaceRoot: string; branch: string; base: string; createdAt: string;
}, input: RunInput, attachments: Array<{ file: string; note?: string }>): string {
  return [
    frontMatter({
      id: fields.id,
      project: fields.project,
      workspaceRoot: fields.workspaceRoot,
      branch: fields.branch,
      base: fields.base,
      createdAt: fields.createdAt,
    }),
    "",
    `# ${input.title}`,
    "",
    "## Requerimiento literal",
    input.requirement.trim(),
    "",
    "## Interpretación del base",
    input.interpretation.trim(),
    "",
    "## Alcance",
    `- Incluye: ${input.scopeIncludes?.length ? input.scopeIncludes.join("; ") : "(sin declarar)"}`,
    `- Excluye: ${input.scopeExcludes?.length ? input.scopeExcludes.join("; ") : "(sin declarar)"}`,
    "",
    "## Criterios de aceptación",
    input.acceptance.map((criterion) => `- ${criterion.exercise ? "[ejercicio] " : ""}${criterion.command ? `\`${criterion.command}\` — ` : ""}${criterion.text}`).join("\n"),
    "",
    "## Riesgos",
    bulletList(input.risks, "ninguno declarado"),
    "",
    "## Adjuntos",
    attachments.length ? attachments.map((attachment) => `- attachments/${attachment.file}${attachment.note ? ` — ${attachment.note}` : ""}`).join("\n") : "- ninguno",
    "",
  ].join("\n");
}

export class HrpStore {
  readonly database: Database.Database;
  readonly runsDirectory: string;

  constructor(readonly dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true });
    this.runsDirectory = path.join(dataDirectory, "runs");
    mkdirSync(this.runsDirectory, { recursive: true });
    this.database = new Database(path.join(dataDirectory, "hrp.db"));
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
        status TEXT NOT NULL CHECK(status IN ('open','implemented','closed')),
        control TEXT NOT NULL DEFAULT 'active' CHECK(control IN ('active','paused','stopped')),
        branch TEXT NOT NULL,
        base TEXT,
        issue_path TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        acceptance_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        implemented_at TEXT,
        closed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        family TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('base','auditor')),
        status TEXT NOT NULL CHECK(status IN ('attached','released')),
        host_pids_json TEXT NOT NULL DEFAULT '[]',
        requirement_reviewed INTEGER NOT NULL DEFAULT 0,
        integration_reviewed INTEGER NOT NULL DEFAULT 0,
        vote TEXT CHECK(vote IN ('ok','reject')),
        vote_detail TEXT,
        voted_at TEXT,
        attached_at TEXT NOT NULL,
        released_at TEXT,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (run_id, id)
      );
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        file TEXT NOT NULL,
        symbol TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        rationale TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
        author TEXT NOT NULL,
        files_json TEXT NOT NULL DEFAULT '[]',
        dependencies_json TEXT NOT NULL DEFAULT '[]',
        diff TEXT,
        patch_summary TEXT,
        patch_rationale TEXT,
        verification_json TEXT,
        commit_sha TEXT,
        failure TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, id)
      );
      CREATE TABLE IF NOT EXISTS node_audits (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        session TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, node_id, session)
      );
      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        node_id TEXT,
        scope TEXT NOT NULL CHECK(scope IN ('requirement','node','integration')),
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
      CREATE INDEX IF NOT EXISTS runs_project_updated ON runs(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS activity_run_id ON activity(run_id, id DESC);
      CREATE INDEX IF NOT EXISTS findings_run ON findings(run_id, created_at);
      CREATE INDEX IF NOT EXISTS finding_messages_finding ON finding_messages(finding_id, created_at);
    `);
    // Bases anteriores a los nodos multiarchivo: el único archivo pasa a la lista.
    const nodeColumns = this.database.pragma("table_info(nodes)") as Row[];
    if (!nodeColumns.some((column) => String(column.name) === "files_json")) {
      this.database.exec("ALTER TABLE nodes ADD COLUMN files_json TEXT NOT NULL DEFAULT '[]'");
      this.database.exec("UPDATE nodes SET files_json = json_array(file)");
    }
  }

  close(): void {
    this.database.close();
  }

  // --- Ajustes ------------------------------------------------------------

  getSetting<T>(key: string, fallback: T): T {
    const row = this.database.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as Row | undefined;
    return row ? JSON.parse(String(row.value_json)) as T : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.database.prepare("INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(value), now());
  }

  // --- Proyectos ----------------------------------------------------------

  attachProject(workspaceRoot: string): Project {
    const resolved = path.resolve(workspaceRoot);
    if (!statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Workspace does not exist or is not a directory: ${resolved}`);
    }
    const canonical = realpathSync(resolved);
    if (canonical === path.parse(canonical).root || canonical === os.homedir()) {
      throw new Error(`Workspace cannot be the filesystem root or the home directory: ${canonical}`);
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

  findProjectByWorkspace(workspaceRoot: string): Project | undefined {
    let canonical = path.resolve(workspaceRoot);
    try { canonical = realpathSync(canonical); } catch { /* se compara tal cual */ }
    return this.listProjects().find((project) => project.workspaceRoot === canonical);
  }

  deleteProject(id: string): boolean {
    return this.database.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }

  // --- Git ----------------------------------------------------------------

  private git(project: Project, args: string[]): string | undefined {
    try {
      return execFileSync("git", args, { cwd: project.workspaceRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return undefined;
    }
  }

  private gitBytes(project: Project, args: string[]): Buffer | undefined {
    try {
      return execFileSync("git", args, { cwd: project.workspaceRoot, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return undefined;
    }
  }

  private requireGit(project: Project, args: string[], why: string): string {
    try {
      return execFileSync("git", args, { cwd: project.workspaceRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${why}: git ${args.join(" ")} falló: ${detail.split("\n").slice(-3).join(" ").trim()}`);
    }
  }

  private currentBranch(project: Project): string | undefined {
    return this.git(project, ["branch", "--show-current"])?.trim() || undefined;
  }

  // --- Runs ---------------------------------------------------------------

  createRun(projectId: string, input: RunInput, family: string): RunStart {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    if (!isValidFamily(family)) throw new Error(`Familia de agente inválida: ${JSON.stringify(family)}`);
    if (!input.title?.trim()) throw new Error("El run necesita título");
    if (!input.requirement?.trim()) throw new Error("El requerimiento literal del humano es obligatorio");
    if (!input.interpretation?.trim()) throw new Error("La interpretación del base es obligatoria");
    if (!input.acceptance?.length) throw new Error("Declara al menos un criterio de aceptación");
    if (!input.acceptance.some((criterion) => criterion.exercise)) {
      throw new Error("Declara al menos un criterio con exercise: true, que exija abrir y usar el artefacto (panel, juego, CLI…); un exit 0 no demuestra que funciona");
    }
    const live = this.listRuns(projectId).find((run) => run.status === "open" && run.control !== "stopped");
    if (live) throw new Error(`El proyecto ya tiene un run abierto (${live.id}: ${live.title}); ciérralo o deténlo antes de abrir otro`);
    if (this.git(project, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") {
      throw new Error(`${project.workspaceRoot} no es un repositorio git; HRP v4 deja cada nodo como commit en una rama del run`);
    }

    const id = shortId();
    const branch = runBranchName(id);
    const createdAt = now();
    const baseId = `${family}:1`;
    const runDirectory = path.join(this.runsDirectory, id);
    const attachmentsDirectory = path.join(runDirectory, "attachments");
    mkdirSync(attachmentsDirectory, { recursive: true });

    // Los adjuntos se copian: las rutas que recibe una sesión son temporales.
    const copied: Array<{ file: string; note?: string }> = [];
    const taken = new Set<string>();
    for (const attachment of input.attachments ?? []) {
      const source = path.resolve(attachment.path);
      if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Adjunto no encontrado: ${source}`);
      let file = path.basename(source);
      let ordinal = 2;
      while (taken.has(file)) {
        const parsed = path.parse(path.basename(source));
        file = `${parsed.name}-${ordinal}${parsed.ext}`;
        ordinal += 1;
      }
      taken.add(file);
      copyFileSync(source, path.join(attachmentsDirectory, file));
      copied.push({ file, note: attachment.note });
    }

    const issuePath = path.join(runDirectory, "issue.md");
    writeFileSync(issuePath, renderIssue({
      id, project: project.name, workspaceRoot: project.workspaceRoot, branch, base: baseId, createdAt,
    }, input, copied));
    const acceptance: AcceptanceCriterion[] = input.acceptance.map((criterion) => ({ text: criterion.text, command: criterion.command || undefined, exercise: criterion.exercise || undefined }));
    writeFileSync(path.join(runDirectory, "run.json"), `${JSON.stringify({
      id, project: project.name, projectId, workspaceRoot: project.workspaceRoot, branch, base: baseId, createdAt,
      title: input.title, attachments: copied.map((attachment) => `attachments/${attachment.file}`), acceptance,
    }, null, 2)}\n`);

    if (this.git(project, ["show-ref", "--verify", `refs/heads/${branch}`]) !== undefined) {
      throw new Error(`La rama ${branch} ya existe`);
    }
    this.requireGit(project, ["switch", "-c", branch], "No se pudo crear la rama del run");

    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO runs (id, project_id, title, status, control, branch, base, issue_path, attachments_json, acceptance_json, created_at, updated_at)
        VALUES (?, ?, ?, 'open', 'active', ?, ?, ?, ?, ?, ?, ?)
      `).run(id, projectId, input.title.trim(), branch, baseId, issuePath,
        JSON.stringify(copied.map((attachment) => `attachments/${attachment.file}`)), JSON.stringify(acceptance), createdAt, createdAt);
      this.database.prepare(`
        INSERT INTO sessions (id, run_id, family, role, status, attached_at, last_seen_at)
        VALUES (?, ?, ?, 'base', 'attached', ?, ?)
      `).run(baseId, id, family, createdAt, createdAt);
      this.database.prepare("UPDATE projects SET last_opened_at = ? WHERE id = ?").run(createdAt, projectId);
    })();
    this.addActivity(id, "run", `Run abierto por ${baseId}: ${input.title.trim()}`, `Issue en ${issuePath} · rama ${branch}`, undefined, baseId);
    return { run: this.getRun(id)!, session: this.getSession(id, baseId)! };
  }

  listRuns(projectId: string): RunSummary[] {
    return (this.database.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as Row[])
      .map((row) => this.runFromRow(row));
  }

  listAllRuns(): RunSummary[] {
    return (this.database.prepare("SELECT * FROM runs ORDER BY updated_at DESC").all() as Row[]).map((row) => this.runFromRow(row));
  }

  getRun(id: string): RunSummary | undefined {
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  requireRun(id: string): RunSummary {
    const run = this.getRun(id);
    if (!run) throw new Error(`Unknown run: ${id}`);
    return run;
  }

  deleteRun(id: string): boolean {
    return this.database.prepare("DELETE FROM runs WHERE id = ?").run(id).changes > 0;
  }

  readIssue(runId: string): string {
    const run = this.requireRun(runId);
    try { return readFileSync(run.issuePath, "utf8"); } catch { return ""; }
  }

  getRunDetail(id: string): RunDetail | undefined {
    const run = this.getRun(id);
    if (!run) return undefined;
    const project = this.getProject(run.projectId);
    if (!project) return undefined;
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
    return {
      run, project,
      nodes: this.listNodes(id),
      findings: this.listFindings(id),
      sessions: this.listSessions(id),
      activity,
      issue: this.readIssue(id),
    };
  }

  // Evolución: un cuadro por nodo completado, en el orden de sus commits (la
  // fecha de updatedAt cambia con las auditorías). El árbol de partida es el
  // padre del primer commit: run.base es una sesión, no un commit.
  getRunEvolution(runId: string): EvolutionData {
    const run = this.requireRun(runId);
    const project = this.getProject(run.projectId)!;
    const completed = this.listNodes(runId).filter((node) => node.status === "completed" && node.commit);
    const dates = new Map<string, string>();
    if (completed.length) {
      const raw = this.git(project, ["show", "-s", "--format=%H %cI", ...completed.map((node) => node.commit!)]) ?? "";
      for (const line of raw.split("\n")) {
        const [sha, date] = line.trim().split(" ");
        if (sha && date) dates.set(sha, date);
      }
    }
    const frames = completed
      .map((node) => ({
        frame: { nodeId: node.id, commit: node.commit, committedAt: dates.get(node.commit!), files: fileChangesFromDiff(node.diff ?? "") } satisfies EvolutionFrame,
        order: Date.parse(dates.get(node.commit!) ?? "") || Date.parse(node.createdAt),
      }))
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.frame);
    const baseRef = frames[0]?.commit ? `${frames[0].commit}^` : `refs/heads/${run.branch}`;
    const baseCommit = this.git(project, ["rev-parse", "--verify", `${baseRef}^{commit}`])?.trim() || undefined;
    const listed = baseCommit ? this.git(project, ["ls-tree", "-r", "--name-only", "-z", baseCommit]) : undefined;
    if (listed === undefined) return { baseCommit, baseFiles: reconstructBaseFiles(frames), frames, partial: true };
    return { baseCommit, baseFiles: listed.split("\0").filter(Boolean), frames, partial: false };
  }

  // El archivo completo en las dos versiones que separa el nodo, leído de git.
  getRunEvolutionFile(runId: string, nodeId: string, file: string): EvolutionFileContent {
    const run = this.requireRun(runId);
    const node = this.requireNode(runId, nodeId);
    const project = this.getProject(run.projectId)!;
    if (node.status !== "completed" || !node.commit) throw new Error(`${nodeId} no tiene commit: sólo un nodo completado tiene antes y después`);
    const relative = this.relativeInWorkspace(project, file).split(path.sep).join("/");
    if (this.git(project, ["cat-file", "-e", `${node.commit}^{commit}`]) === undefined) {
      throw new Error(`git ya no alcanza el commit ${node.commit.slice(0, 10)} del nodo ${nodeId}`);
    }
    const read = (ref: string) => this.gitBytes(project, ["show", `${ref}:${relative}`]);
    const versions = [read(`${node.commit}^`), read(node.commit)];
    const binary = versions.some((bytes) => bytes?.subarray(0, 8000).includes(0));
    const truncated = versions.some((bytes) => (bytes?.length ?? 0) > evolutionFileContentLimit);
    const text = (bytes: Buffer | undefined) => (bytes === undefined || binary ? undefined : bytes.subarray(0, evolutionFileContentLimit).toString("utf8"));
    return { path: relative, before: text(versions[0]), after: text(versions[1]), binary, truncated };
  }

  setRunControl(runId: string, control: RunControl, actor = "human"): RunSummary {
    const run = this.requireRun(runId);
    if (run.status === "closed") throw new Error("El run ya está cerrado");
    if (run.control === control) return run;
    const timestamp = now();
    this.database.prepare("UPDATE runs SET control = ?, updated_at = ? WHERE id = ?").run(control, timestamp, runId);
    const message = control === "paused" ? "Ejecución pausada" : control === "stopped" ? "Ejecución detenida" : "Ejecución reanudada";
    this.addActivity(runId, "run", `${message} por ${actor}`, undefined, undefined, actor);
    if (control === "stopped") this.releaseAll(runId, "run detenido");
    return this.requireRun(runId);
  }

  private setRunStatus(runId: string, status: RunStatus): void {
    const timestamp = now();
    const extra = status === "implemented" ? ", implemented_at = ?" : status === "closed" ? ", closed_at = ?" : "";
    const params = extra ? [status, timestamp, timestamp, runId] : [status, timestamp, runId];
    this.database.prepare(`UPDATE runs SET status = ?, updated_at = ?${extra} WHERE id = ?`).run(...params);
  }

  // Cierre del base: la máquina corre los criterios de aceptación ejecutables.
  closeRun(runId: string, actor: string, exercised: ExerciseReport[] = []): CloseResult {
    const run = this.requireRun(runId);
    const project = this.getProject(run.projectId)!;
    if (run.status === "closed") throw new Error("El run ya está cerrado");
    if (run.base !== actor && actor !== "human") throw new Error(`Sólo el base (${run.base}) cierra la implementación`);
    if (run.control !== "active") throw new Error(`El run está ${run.control === "paused" ? "pausado" : "detenido"}`);
    const nodes = this.listNodes(runId);
    const running = nodes.filter((node) => node.status === "running");
    if (running.length) throw new Error(`Hay nodos en curso: ${running.map((node) => node.id).join(", ")}. Complétalos o márcalos fallidos antes de cerrar`);
    if (!nodes.some((node) => node.status === "completed")) throw new Error("No hay ningún nodo completado; no hay nada que cerrar");
    const findings = this.listFindings(runId);
    if (runIsOnHold(findings)) throw new Error("Hay un hallazgo crítico vivo: resuélvelo antes de cerrar");
    const unresolved = findings.filter((finding) => finding.status === "accepted"
      && (!finding.resolutionNodeId || nodes.find((node) => node.id === finding.resolutionNodeId)?.status !== "completed"));
    if (unresolved.length) throw new Error(`Hallazgos aceptados sin corrección terminada: ${unresolved.map((finding) => finding.id).join(", ")}`);

    // Los criterios de ejercicio no los corre la máquina: el base tiene que
    // haber usado el artefacto y decir qué vio. Sin ese reporte no hay cierre.
    const reports = new Map(exercised.map((report) => [report.text.trim(), report.observed.trim()]));
    const missing = run.acceptance.filter((criterion) => criterion.exercise && !reports.get(criterion.text.trim()));
    if (missing.length) {
      throw new Error(`Ejercita el artefacto antes de cerrar y reporta lo observado (exercised) para: ${missing.map((criterion) => `"${criterion.text}"`).join("; ")}`);
    }
    const acceptance = run.acceptance.map((criterion) => ({
      ...criterion,
      observed: criterion.exercise ? reports.get(criterion.text.trim()) : undefined,
      result: criterion.command ? runVerification(project.workspaceRoot, criterion.command) : undefined,
    }));
    const passed = acceptance.every((criterion) => !criterion.command || criterion.result?.passed);
    this.database.prepare("UPDATE runs SET acceptance_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(acceptance), now(), runId);
    for (const criterion of acceptance) {
      if (criterion.observed) this.addActivity(runId, "verify", `Ejercitado: ${criterion.text}`, criterion.observed, undefined, actor);
      if (!criterion.result) continue;
      this.addActivity(runId, "verify", `${criterion.result.passed ? "Criterio cumplido" : "Criterio fallido"}: ${criterion.text}`,
        `${criterion.result.command}\nexit ${criterion.result.exitCode}\n${criterion.result.output.slice(-2000)}`, undefined, actor);
    }
    if (passed) {
      this.setRunStatus(runId, "implemented");
      this.addActivity(runId, "run", "Implementación cerrada por el base; pendiente de auditoría", undefined, undefined, actor);
      this.tryClose(runId);
    } else {
      this.addActivity(runId, "run", "El cierre no procede: hay criterios de aceptación fallidos", undefined, undefined, actor);
    }
    return { run: this.requireRun(runId), acceptance, passed };
  }

  // Gate: cierra solo cuando la regla del contrato lo permite, y libera a todos.
  tryClose(runId: string): boolean {
    const run = this.requireRun(runId);
    if (run.status !== "implemented" || !run.audit.canClose) return false;
    this.setRunStatus(runId, "closed");
    this.addActivity(runId, "run", `Run cerrado: auditoría completa con ${run.audit.okVotes.length} ${run.audit.okVotes.length === 1 ? "voto OK" : "votos OK"} (${run.audit.distinctFamilies.join(", ")})`);
    this.releaseAll(runId, "run cerrado");
    return true;
  }

  // --- Sesiones -----------------------------------------------------------

  listSessions(runId: string): Session[] {
    const rows = this.database.prepare("SELECT * FROM sessions WHERE run_id = ? ORDER BY attached_at, id").all(runId) as Row[];
    const audits = this.database.prepare("SELECT node_id, session FROM node_audits WHERE run_id = ?").all(runId) as Row[];
    return rows.map((row) => {
      const session = sessionFromRow(row);
      session.reviewedNodeIds = audits.filter((audit) => String(audit.session) === session.id).map((audit) => String(audit.node_id));
      return session;
    });
  }

  getSession(runId: string, sessionId: string): Session | undefined {
    return this.listSessions(runId).find((session) => session.id === sessionId);
  }

  requireSession(runId: string, sessionId: string): Session {
    const session = this.getSession(runId, sessionId);
    if (!session) throw new Error(`${sessionId} no es una sesión del run ${runId}; engánchate primero con /hrp attention ${runId}`);
    return session;
  }

  // Acuña 'familia:N' para el run. El base es siempre N=1 de su familia.
  attachSession(runId: string, family: string, hostPids: number[] = []): Session {
    const run = this.requireRun(runId);
    if (!isValidFamily(family)) throw new Error(`Familia de agente inválida: ${JSON.stringify(family)}`);
    if (run.status === "closed") throw new Error(`El run ${runId} ya está cerrado; no hay nada que auditar`);
    if (run.control === "stopped") throw new Error(`El run ${runId} fue detenido por el humano`);
    const taken = new Set(this.listSessions(runId).filter((session) => session.family === family).map((session) => session.id));
    let ordinal = 1;
    while (taken.has(`${family}:${ordinal}`)) ordinal += 1;
    const id = `${family}:${ordinal}`;
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO sessions (id, run_id, family, role, status, host_pids_json, attached_at, last_seen_at)
      VALUES (?, ?, ?, 'auditor', 'attached', ?, ?, ?)
    `).run(id, runId, family, JSON.stringify(hostPids), timestamp, timestamp);
    this.touchRun(runId, timestamp);
    this.addActivity(runId, "session", `Auditor enganchado: ${id}`, undefined, undefined, id);
    return this.getSession(runId, id)!;
  }

  bindSessionHost(runId: string, sessionId: string, hostPids: number[]): Session {
    this.requireSession(runId, sessionId);
    this.database.prepare("UPDATE sessions SET host_pids_json = ?, last_seen_at = ? WHERE run_id = ? AND id = ?")
      .run(JSON.stringify(hostPids), now(), runId, sessionId);
    return this.getSession(runId, sessionId)!;
  }

  // Sesiones enganchadas cuyo proceso anfitrión coincide con alguno de los pids
  // dados: es como un hook, que no conoce la identidad, encuentra la suya.
  sessionsForHostPids(pids: number[]): Session[] {
    if (!pids.length) return [];
    const rows = this.database.prepare("SELECT * FROM sessions WHERE status = 'attached'").all() as Row[];
    const wanted = new Set(pids);
    return rows
      .filter((row) => (JSON.parse(String(row.host_pids_json ?? "[]")) as number[]).some((pid) => wanted.has(pid)))
      .map((row) => this.getSession(String(row.run_id), String(row.id))!)
      .filter(Boolean);
  }

  touchSession(runId: string, sessionId: string): void {
    this.database.prepare("UPDATE sessions SET last_seen_at = ? WHERE run_id = ? AND id = ?").run(now(), runId, sessionId);
  }

  releaseSession(runId: string, sessionId: string, reason?: string): Session {
    const session = this.requireSession(runId, sessionId);
    if (session.status === "released") return session;
    const timestamp = now();
    this.database.prepare("UPDATE sessions SET status = 'released', released_at = ?, last_seen_at = ? WHERE run_id = ? AND id = ?")
      .run(timestamp, timestamp, runId, sessionId);
    this.touchRun(runId, timestamp);
    this.addActivity(runId, "session", `Atención liberada: ${sessionId}${reason ? ` (${reason})` : ""}`, undefined, undefined, sessionId);
    return this.getSession(runId, sessionId)!;
  }

  private releaseAll(runId: string, reason: string): void {
    for (const session of this.listSessions(runId)) {
      if (session.status === "attached") this.releaseSession(runId, session.id, reason);
    }
  }

  // Cobertura declarada por un auditor. Los nodos deben estar completados y no
  // ser suyos: auditarse a uno mismo no cuenta y por eso se rechaza.
  markAudited(runId: string, sessionId: string, coverage: { nodeIds?: string[]; requirement?: boolean; integration?: boolean }): Session {
    const session = this.requireSession(runId, sessionId);
    if (session.role !== "auditor") throw new Error(`${sessionId} es el base: no audita su propio run`);
    const nodes = this.listNodes(runId);
    const timestamp = now();
    for (const nodeId of coverage.nodeIds ?? []) {
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (!node) throw new Error(`Unknown node: ${nodeId}`);
      if (node.status !== "completed") throw new Error(`${nodeId} no está completado; sólo se audita evidencia terminada`);
      if (node.author === sessionId) throw new Error(`${nodeId} es tuyo; nadie audita lo propio`);
      this.database.prepare("INSERT OR IGNORE INTO node_audits (run_id, node_id, session, created_at) VALUES (?, ?, ?, ?)")
        .run(runId, nodeId, sessionId, timestamp);
    }
    if (coverage.requirement) {
      this.database.prepare("UPDATE sessions SET requirement_reviewed = 1 WHERE run_id = ? AND id = ?").run(runId, sessionId);
    }
    if (coverage.integration) {
      this.database.prepare("UPDATE sessions SET integration_reviewed = 1 WHERE run_id = ? AND id = ?").run(runId, sessionId);
    }
    this.database.prepare("UPDATE sessions SET last_seen_at = ? WHERE run_id = ? AND id = ?").run(timestamp, runId, sessionId);
    this.touchRun(runId, timestamp);
    const parts = [
      coverage.nodeIds?.length ? `${coverage.nodeIds.length} ${coverage.nodeIds.length === 1 ? "nodo" : "nodos"} (${coverage.nodeIds.join(", ")})` : "",
      coverage.requirement ? "requerimiento" : "",
      coverage.integration ? "integración" : "",
    ].filter(Boolean);
    if (parts.length) this.addActivity(runId, "audit", `Auditado por ${sessionId}: ${parts.join(" · ")}`, undefined, undefined, sessionId);
    return this.getSession(runId, sessionId)!;
  }

  vote(runId: string, sessionId: string, vote: AuditVote, detail?: string): Session {
    const run = this.requireRun(runId);
    const session = this.requireSession(runId, sessionId);
    if (session.role !== "auditor") throw new Error("El base no vota: su cierre es hrp_run_close");
    if (run.status !== "implemented") throw new Error(`El run está ${run.status}; se vota cuando el base cierra la implementación`);
    const pending = this.listNodes(runId)
      .filter((node) => node.status === "completed" && node.author !== sessionId && !node.auditedBy.includes(sessionId))
      .map((node) => node.id);
    if (pending.length) throw new Error(`Antes de votar declara la auditoría de ${pending.join(", ")} con hrp_audit_done`);
    const timestamp = now();
    this.database.prepare("UPDATE sessions SET vote = ?, vote_detail = ?, voted_at = ?, integration_reviewed = 1, last_seen_at = ? WHERE run_id = ? AND id = ?")
      .run(vote, detail ?? null, timestamp, timestamp, runId, sessionId);
    this.touchRun(runId, timestamp);
    this.addActivity(runId, "audit", `Voto ${vote === "ok" ? "OK" : "de rechazo"} de ${sessionId}`, detail, undefined, sessionId);
    this.tryClose(runId);
    return this.getSession(runId, sessionId)!;
  }

  // --- Nodos --------------------------------------------------------------

  listNodes(runId: string): ChangeNode[] {
    const audits = this.database.prepare("SELECT node_id, session FROM node_audits WHERE run_id = ? ORDER BY created_at").all(runId) as Row[];
    return (this.database.prepare("SELECT * FROM nodes WHERE run_id = ? ORDER BY created_at, id").all(runId) as Row[])
      .map((row) => this.nodeFromRow(row, audits));
  }

  private nodeFromRow(row: Row, audits?: Row[]): ChangeNode {
    const id = String(row.id);
    const runId = String(row.run_id);
    const auditRows = audits ?? this.database.prepare("SELECT node_id, session FROM node_audits WHERE run_id = ? AND node_id = ?").all(runId, id) as Row[];
    const files = JSON.parse(String(row.files_json ?? "[]")) as string[];
    return {
      id, runId,
      files: files.length ? files : [String(row.file)],
      file: files[0] ?? String(row.file),
      symbol: String(row.symbol),
      title: String(row.title),
      description: String(row.description),
      rationale: String(row.rationale),
      status: String(row.status) as NodeStatus,
      author: String(row.author),
      dependencies: JSON.parse(String(row.dependencies_json ?? "[]")) as string[],
      diff: row.diff ? String(row.diff) : undefined,
      patchSummary: row.patch_summary ? String(row.patch_summary) : undefined,
      patchRationale: row.patch_rationale ? String(row.patch_rationale) : undefined,
      verification: parseVerification(row.verification_json),
      commit: row.commit_sha ? String(row.commit_sha) : undefined,
      failure: row.failure ? String(row.failure) : undefined,
      auditedBy: auditRows.filter((audit) => String(audit.node_id) === id).map((audit) => String(audit.session)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  getNode(runId: string, nodeId: string): ChangeNode | undefined {
    const row = this.database.prepare("SELECT * FROM nodes WHERE run_id = ? AND id = ?").get(runId, nodeId) as Row | undefined;
    return row ? this.nodeFromRow(row) : undefined;
  }

  requireNode(runId: string, nodeId: string): ChangeNode {
    const node = this.getNode(runId, nodeId);
    if (!node) throw new Error(`Unknown node: ${nodeId}`);
    return node;
  }

  private nextNodeId(runId: string): string {
    const row = this.database.prepare("SELECT COUNT(*) AS total FROM nodes WHERE run_id = ?").get(runId) as Row;
    let ordinal = Number(row.total ?? 0) + 1;
    while (this.getNode(runId, `n${ordinal}`)) ordinal += 1;
    return `n${ordinal}`;
  }

  openNode(runId: string, actor: string, input: ChangeNodeInput & { resolves?: string }): ChangeNode {
    const run = this.requireRun(runId);
    const session = this.requireSession(runId, actor);
    if (session.role !== "base") throw new Error(`${actor} es auditor: sólo el base (${run.base}) implementa`);
    if (run.status === "closed") throw new Error("El run ya está cerrado");
    if (run.control !== "active") throw new Error(`El run está ${run.control === "paused" ? "pausado" : "detenido"} por el humano`);
    const findings = this.listFindings(runId);
    if (runIsOnHold(findings)) {
      const critical = findings.filter((finding) => finding.severity === "critical" && isLiveFinding(finding)).map((finding) => finding.id);
      throw new Error(`Run en hold por hallazgo crítico (${critical.join(", ")}): acéptalo o recházalo antes de abrir otro nodo`);
    }
    for (const field of ["symbol", "title", "description", "rationale"] as const) {
      if (!input[field]?.trim()) throw new Error(`El nodo necesita ${field}`);
    }
    const files = nodeFilesOf(input);
    if (!files.length) throw new Error("El nodo necesita al menos un archivo (files)");
    const project = this.getProject(run.projectId)!;
    for (const file of files) this.relativeInWorkspace(project, file);
    const id = input.id?.trim() || this.nextNodeId(runId);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new Error(`Id de nodo inválido: ${id}`);
    if (this.getNode(runId, id)) throw new Error(`El nodo ${id} ya existe`);
    const known = new Set(this.listNodes(runId).map((node) => node.id));
    const dependencies = [...new Set(input.dependencies ?? [])];
    const unknown = dependencies.filter((dependency) => !known.has(dependency));
    if (unknown.length) throw new Error(`Dependencias desconocidas: ${unknown.join(", ")}`);
    let resolvedFinding: Finding | undefined;
    if (input.resolves) {
      resolvedFinding = this.getFinding(input.resolves);
      if (!resolvedFinding || resolvedFinding.runId !== runId) throw new Error(`Unknown finding: ${input.resolves}`);
      if (resolvedFinding.status !== "accepted") throw new Error(`El hallazgo ${input.resolves} está ${resolvedFinding.status}; sólo un hallazgo aceptado tiene nodo de corrección`);
    }
    const timestamp = now();
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO nodes (id, run_id, file, files_json, symbol, title, description, rationale, status, author, dependencies_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
      `).run(id, runId, files[0], JSON.stringify(files), input.symbol.trim(), input.title.trim(), input.description.trim(), input.rationale.trim(),
        actor, JSON.stringify(dependencies), timestamp, timestamp);
      if (resolvedFinding) {
        this.database.prepare("UPDATE findings SET resolution_node_id = ?, updated_at = ? WHERE id = ?").run(id, timestamp, resolvedFinding.id);
      }
      // Volver a implementar reabre: la auditoría se repetirá sobre lo nuevo.
      if (run.status === "implemented") this.setRunStatus(runId, "open");
    })();
    this.addActivity(runId, "node", `En curso (${actor}): ${files.join(", ")} · ${input.symbol.trim()}`,
      resolvedFinding ? `Corrige el hallazgo ${resolvedFinding.id}: ${resolvedFinding.title}` : input.description.trim(), id, actor);
    if (run.status === "implemented") this.addActivity(runId, "run", "Run reabierto: el base implementa una corrección", undefined, id, actor);
    return this.requireNode(runId, id);
  }

  verifyNode(runId: string, nodeId: string, command: string, actor: string): ChangeNode {
    const run = this.requireRun(runId);
    const node = this.requireNode(runId, nodeId);
    if (node.status !== "running") throw new Error(`${nodeId} está ${node.status}; sólo se verifica un nodo en curso`);
    if (!command.trim()) throw new Error("Falta el comando de verificación");
    const project = this.getProject(run.projectId)!;
    const verification = runVerification(project.workspaceRoot, command.trim());
    const timestamp = now();
    this.database.prepare("UPDATE nodes SET verification_json = ?, updated_at = ? WHERE run_id = ? AND id = ?")
      .run(JSON.stringify(verification), timestamp, runId, nodeId);
    this.touchRun(runId, timestamp);
    this.addActivity(runId, "verify", `${verification.passed ? "Verificación aprobada" : "Verificación fallida"}: ${command.trim()}`,
      `exit ${verification.exitCode}\n${verification.output.slice(-2000)}`, nodeId, actor);
    return this.requireNode(runId, nodeId);
  }

  // Completar es commitear: el diff lo mide git sobre el archivo del nodo, no
  // lo declara el modelo, y el commit queda en la rama del run.
  // Ruta relativa segura de un archivo del nodo: dentro del workspace o nada.
  private relativeInWorkspace(project: Project, file: string): string {
    const relative = path.relative(project.workspaceRoot, path.resolve(project.workspaceRoot, file));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${file} queda fuera del workspace`);
    return relative;
  }

  completeNode(runId: string, nodeId: string, actor: string, patch: { summary: string; rationale?: string }): ChangeNode {
    const run = this.requireRun(runId);
    const node = this.requireNode(runId, nodeId);
    const project = this.getProject(run.projectId)!;
    if (node.status !== "running") throw new Error(`${nodeId} está ${node.status}; sólo se completa un nodo en curso`);
    if (node.author !== actor) throw new Error(`${nodeId} lo abrió ${node.author}`);
    if (!node.verification?.passed) throw new Error("Falta una verificación aprobada (hrp_node_verify) antes de completar");
    if (!patch.summary?.trim()) throw new Error("Resume qué hizo el parche");
    const branch = this.currentBranch(project);
    if (branch !== run.branch) throw new Error(`El workspace está en ${branch ?? "HEAD suelto"} y el run vive en ${run.branch}; vuelve a la rama del run`);
    // Todos los archivos del nodo van en un solo commit: son una operación.
    const relatives = node.files.map((file) => this.relativeInWorkspace(project, file));
    this.requireGit(project, ["add", "--", ...relatives], "No se pudieron preparar los archivos del nodo");
    const diff = this.requireGit(project, ["diff", "--cached", "--", ...relatives], "No se pudo medir el diff del nodo");
    if (!diff.trim()) throw new Error(`git no ve cambios en ${node.files.join(", ")}; un nodo completado necesita diff real`);
    const message = `hrp(${run.id}) ${node.id}: ${node.title}\n\n${patch.summary.trim()}${patch.rationale ? `\n\n${patch.rationale.trim()}` : ""}\n\nHRP-Run: ${run.id}\nHRP-Node: ${node.id}\nHRP-Author: ${actor}`;
    this.requireGit(project, ["commit", "--only", "-q", "-m", message, "--", ...relatives], "No se pudo commitear el nodo");
    const commit = this.requireGit(project, ["rev-parse", "HEAD"], "No se pudo leer el commit").trim();
    const timestamp = now();
    this.database.prepare(`
      UPDATE nodes SET status = 'completed', diff = ?, patch_summary = ?, patch_rationale = ?, commit_sha = ?, updated_at = ?
      WHERE run_id = ? AND id = ?
    `).run(diff, patch.summary.trim(), patch.rationale?.trim() || null, commit, timestamp, runId, nodeId);
    this.touchRun(runId, timestamp);
    this.addActivity(runId, "node", `Terminado: ${node.files.join(", ")} · ${node.symbol}`, `${patch.summary.trim()}\ncommit ${commit.slice(0, 10)}`, nodeId, actor);
    return this.requireNode(runId, nodeId);
  }

  failNode(runId: string, nodeId: string, actor: string, reason: string): ChangeNode {
    const node = this.requireNode(runId, nodeId);
    if (node.status !== "running") throw new Error(`${nodeId} está ${node.status}`);
    if (!reason.trim()) throw new Error("Explica por qué falló el nodo");
    const timestamp = now();
    this.database.prepare("UPDATE nodes SET status = 'failed', failure = ?, updated_at = ? WHERE run_id = ? AND id = ?")
      .run(reason.trim(), timestamp, runId, nodeId);
    this.touchRun(runId, timestamp);
    this.addActivity(runId, "node", `Falló: ${node.files.join(", ")} · ${node.symbol}`, reason.trim(), nodeId, actor);
    return this.requireNode(runId, nodeId);
  }

  // --- Hallazgos ----------------------------------------------------------

  private findingFromRow(row: Row): Finding {
    const messages = (this.database.prepare("SELECT * FROM finding_messages WHERE finding_id = ? ORDER BY created_at, rowid").all(String(row.id)) as Row[])
      .map((message) => ({
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
      scope: String(row.scope) as FindingScope,
      reviewer: String(row.reviewer),
      severity: String(row.severity) as FindingSeverity,
      title: String(row.title),
      body: String(row.body),
      status: String(row.status) as FindingStatus,
      resolutionNodeId: row.resolution_node_id ? String(row.resolution_node_id) : undefined,
      messages,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  listFindings(runId: string): Finding[] {
    return (this.database.prepare("SELECT * FROM findings WHERE run_id = ? ORDER BY created_at, id").all(runId) as Row[])
      .map((row) => this.findingFromRow(row));
  }

  getFinding(id: string): Finding | undefined {
    const row = this.database.prepare("SELECT * FROM findings WHERE id = ?").get(id) as Row | undefined;
    return row ? this.findingFromRow(row) : undefined;
  }

  requireFinding(id: string): Finding {
    const finding = this.getFinding(id);
    if (!finding) throw new Error(`Unknown finding: ${id}`);
    return finding;
  }

  createFinding(runId: string, input: FindingInput): Finding {
    const run = this.requireRun(runId);
    if (run.status === "closed") throw new Error("El run ya está cerrado");
    const reviewer = input.reviewer?.trim();
    if (!reviewer) throw new Error("Falta el reviewer");
    const session = reviewer === "human" ? undefined : this.requireSession(runId, reviewer);
    if (!input.title?.trim() || !input.body?.trim()) throw new Error("El hallazgo necesita título y cuerpo");
    const scope: FindingScope = input.scope ?? (input.nodeId ? "node" : "integration");
    if (!findingScopes.includes(scope)) throw new Error(`Alcance inválido: ${scope}`);
    if (scope === "node" && !input.nodeId) throw new Error("Un hallazgo de nodo necesita nodeId");
    if (scope !== "node" && input.nodeId) throw new Error(`Un hallazgo de ${scope} no lleva nodeId`);
    let node: ChangeNode | undefined;
    if (input.nodeId) {
      node = this.requireNode(runId, input.nodeId);
      if (session && node.author === session.id) throw new Error("Nadie audita lo propio: el nodo es tuyo");
    }
    const id = randomUUID().slice(0, 8);
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO findings (id, run_id, node_id, scope, reviewer, severity, title, body, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(id, runId, input.nodeId ?? null, scope, reviewer, input.severity, input.title.trim(), input.body.trim(), timestamp, timestamp);
    // Reportar sobre un nodo es haberlo auditado.
    if (session && node?.status === "completed") {
      this.database.prepare("INSERT OR IGNORE INTO node_audits (run_id, node_id, session, created_at) VALUES (?, ?, ?, ?)")
        .run(runId, node.id, session.id, timestamp);
    }
    if (session && scope === "requirement") {
      this.database.prepare("UPDATE sessions SET requirement_reviewed = 1 WHERE run_id = ? AND id = ?").run(runId, session.id);
    }
    this.touchRun(runId, timestamp);
    this.addActivity(runId, "finding", `Hallazgo ${input.severity} de ${reviewer}: ${input.title.trim()}`, input.body.trim(), input.nodeId, reviewer);
    return this.requireFinding(id);
  }

  addFindingMessage(findingId: string, author: string, body: string): Finding {
    const finding = this.requireFinding(findingId);
    if (!author.trim() || !body.trim()) throw new Error("El mensaje necesita autor y cuerpo");
    if (author !== "human") this.requireSession(finding.runId, author);
    const timestamp = now();
    this.database.prepare("INSERT INTO finding_messages (id, finding_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), findingId, author, body.trim(), timestamp);
    const status = finding.status === "open" ? "debating" : finding.status;
    this.database.prepare("UPDATE findings SET status = ?, updated_at = ? WHERE id = ?").run(status, timestamp, findingId);
    this.touchRun(finding.runId, timestamp);
    this.addActivity(finding.runId, "finding", `${author} responde en ${findingId}: ${finding.title}`, body.trim(), finding.nodeId, author);
    return this.requireFinding(findingId);
  }

  // Quien autoriza el resultado del debate es el base (o el humano).
  private requireArbiter(finding: Finding, actor: string, verb: string): void {
    const run = this.requireRun(finding.runId);
    if (actor !== "human" && actor !== run.base) throw new Error(`Sólo el base (${run.base}) o el humano puede ${verb} un hallazgo`);
  }

  acceptFinding(findingId: string, actor: string, resolutionNodeId?: string, note?: string): Finding {
    const finding = this.requireFinding(findingId);
    this.requireArbiter(finding, actor, "aceptar");
    if (finding.status === "accepted" || finding.status === "rejected") throw new Error(`El hallazgo ya está ${finding.status}`);
    if (resolutionNodeId) this.requireNode(finding.runId, resolutionNodeId);
    const timestamp = now();
    if (note?.trim()) this.addFindingMessage(findingId, actor, note);
    this.database.prepare("UPDATE findings SET status = 'accepted', resolution_node_id = ?, updated_at = ? WHERE id = ?")
      .run(resolutionNodeId ?? null, timestamp, findingId);
    this.touchRun(finding.runId, timestamp);
    this.addActivity(finding.runId, "finding", `Aceptado por ${actor}: ${finding.title}`,
      resolutionNodeId ? `Corrección en ${resolutionNodeId}` : "Pendiente de abrir el nodo de corrección (hrp_node_open con resolves)", finding.nodeId, actor);
    return this.requireFinding(findingId);
  }

  rejectFinding(findingId: string, actor: string, reason: string): Finding {
    const finding = this.requireFinding(findingId);
    this.requireArbiter(finding, actor, "rechazar");
    if (finding.status === "accepted" || finding.status === "rejected") throw new Error(`El hallazgo ya está ${finding.status}`);
    if (!reason.trim()) throw new Error("Un rechazo lleva razón en el hilo");
    this.addFindingMessage(findingId, actor, reason);
    const timestamp = now();
    this.database.prepare("UPDATE findings SET status = 'rejected', updated_at = ? WHERE id = ?").run(timestamp, findingId);
    this.addActivity(finding.runId, "finding", `Rechazado por ${actor}: ${finding.title}`, reason.trim(), finding.nodeId, actor);
    this.tryClose(finding.runId);
    return this.requireFinding(findingId);
  }

  escalateFinding(findingId: string, actor: string, reason: string): Finding {
    const finding = this.requireFinding(findingId);
    if (actor !== "human") this.requireSession(finding.runId, actor);
    if (!reason.trim()) throw new Error("Explica qué duda genuina se escala al humano");
    this.addFindingMessage(findingId, actor, reason);
    const timestamp = now();
    this.database.prepare("UPDATE findings SET status = 'escalated', updated_at = ? WHERE id = ?").run(timestamp, findingId);
    this.addActivity(finding.runId, "finding", `Escalado al humano por ${actor}: ${finding.title}`, reason.trim(), finding.nodeId, actor);
    return this.requireFinding(findingId);
  }

  reopenFinding(findingId: string, author: string, reason: string): Finding {
    const finding = this.requireFinding(findingId);
    if (finding.status === "open" || finding.status === "debating") throw new Error("El hallazgo sigue abierto");
    if (this.requireRun(finding.runId).status === "closed") throw new Error("El run ya está cerrado; una objeción tardía es un run nuevo");
    if (!reason.trim()) throw new Error("Reabrir exige evidencia nueva en el hilo");
    this.addFindingMessage(findingId, author, reason);
    const timestamp = now();
    this.database.prepare("UPDATE findings SET status = 'debating', resolution_node_id = NULL, updated_at = ? WHERE id = ?").run(timestamp, findingId);
    this.addActivity(finding.runId, "finding", `Reabierto por ${author}: ${finding.title}`, reason.trim(), finding.nodeId, author);
    return this.requireFinding(findingId);
  }

  // --- Actividad ----------------------------------------------------------

  addActivity(runId: string, type: ActivityType, message: string, detail?: string, nodeId?: string, agent?: string): Activity {
    const createdAt = now();
    const result = this.database.prepare("INSERT INTO activity (run_id, node_id, type, message, detail, agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(runId, nodeId ?? null, type, message, detail ?? null, agent ?? null, createdAt);
    this.touchRun(runId, createdAt);
    return { id: Number(result.lastInsertRowid), runId, nodeId, type, message, detail, agent: agent ?? undefined, createdAt };
  }

  private touchRun(runId: string, timestamp = now()): void {
    this.database.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run(timestamp, runId);
  }

  private runFromRow(row: Row): RunSummary {
    const id = String(row.id);
    const nodes = this.listNodes(id);
    const findings = this.listFindings(id);
    const sessions = this.listSessions(id);
    const status = String(row.status) as RunStatus;
    const base = row.base ? String(row.base) : undefined;
    const liveFindings = findings.filter(isLiveFinding).length;
    const phase = status === "open" && runIsOnHold(findings) ? "hold" : status;
    return {
      id,
      projectId: String(row.project_id),
      title: String(row.title),
      status,
      phase,
      control: String(row.control) as RunControl,
      branch: String(row.branch),
      base,
      issuePath: String(row.issue_path),
      attachments: JSON.parse(String(row.attachments_json ?? "[]")) as string[],
      acceptance: JSON.parse(String(row.acceptance_json ?? "[]")) as AcceptanceCriterion[],
      nodeCount: nodes.length,
      completedCount: nodes.filter((node) => node.status === "completed").length,
      runningCount: nodes.filter((node) => node.status === "running").length,
      failedCount: nodes.filter((node) => node.status === "failed").length,
      openFindings: liveFindings,
      attachedSessions: sessions.filter((session) => session.status === "attached").map((session) => session.id),
      audit: computeAuditStatus({ status, base }, nodes, sessions, findings),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      implementedAt: row.implemented_at ? String(row.implemented_at) : undefined,
      closedAt: row.closed_at ? String(row.closed_at) : undefined,
    };
  }
}
