import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  Activity,
  ActivityType,
  ChangeNode,
  ChangeNodeInput,
  GraphInput,
  NodeStatus,
  Project,
  RunDetail,
  RunSummary,
  Verification,
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
    dependencies: JSON.parse(String(row.dependencies_json)) as string[],
    diff: row.diff ? String(row.diff) : undefined,
    patchSummary: row.patch_summary ? String(row.patch_summary) : undefined,
    verification,
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
        dependencies_json TEXT NOT NULL,
        diff TEXT,
        patch_summary TEXT,
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
      CREATE INDEX IF NOT EXISTS runs_project_updated ON runs(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS activity_run_id ON activity(run_id, id DESC);
    `);
  }

  close(): void {
    this.database.close();
  }

  attachProject(workspaceRoot: string): Project {
    const resolved = path.resolve(workspaceRoot);
    if (!statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Workspace does not exist or is not a directory: ${resolved}`);
    }
    const canonical = realpathSync(resolved);
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

  publishGraph(runId: string, input: GraphInput): ChangeNode[] {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
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
      INSERT INTO nodes (id, run_id, file, symbol, title, description, rationale, status, discovered, dependencies_json, created_at, updated_at)
      VALUES (@id, @runId, @file, @symbol, @title, @description, @rationale, 'pending', @discovered, @dependencies, @timestamp, @timestamp)
      ON CONFLICT(run_id, id) DO UPDATE SET
        file = excluded.file, symbol = excluded.symbol, title = excluded.title,
        description = excluded.description, rationale = excluded.rationale,
        discovered = excluded.discovered, dependencies_json = excluded.dependencies_json,
        updated_at = excluded.updated_at
    `);
    const timestamp = now();
    this.database.transaction((nodes: ChangeNodeInput[]) => {
      for (const node of nodes) upsert.run({ ...node, runId, discovered: node.discovered ? 1 : 0, dependencies: JSON.stringify(node.dependencies), timestamp });
      this.database.prepare("UPDATE runs SET graph_version = graph_version + 1, updated_at = ? WHERE id = ?").run(timestamp, runId);
    })(input.nodes);
    this.addActivity(runId, "graph", `Mapa actualizado · ${input.nodes.length} operaciones`, `Versión ${run.graphVersion + 1}`);
    return this.getRunDetail(runId)!.nodes;
  }

  addDiscoveredNode(runId: string, node: ChangeNodeInput): ChangeNode {
    this.publishGraph(runId, { nodes: [{ ...node, discovered: true }] });
    this.addActivity(runId, "inspect", `Cambio descubierto: ${node.file} · ${node.symbol}`, node.rationale, node.id);
    return this.getNode(runId, node.id)!;
  }

  startNode(runId: string, nodeId: string): ChangeNode {
    const node = this.requireNode(runId, nodeId);
    const blockers = node.dependencies.map((id) => this.getNode(runId, id)).filter((item) => item?.status !== "completed");
    if (blockers.length) throw new Error(`Incomplete dependencies: ${blockers.map((item) => item?.id).join(", ")}`);
    if (node.status === "completed") throw new Error("Completed nodes cannot be restarted");
    this.updateNodeStatus(runId, nodeId, "running");
    this.addActivity(runId, "node", `En curso: ${node.file} · ${node.symbol}`, node.description, nodeId);
    return this.requireNode(runId, nodeId);
  }

  publishPatch(runId: string, nodeId: string, summary: string, diff: string): ChangeNode {
    const node = this.requireNode(runId, nodeId);
    if (node.status !== "running") throw new Error("Node must be running before publishing a patch");
    if (!diff.trim()) throw new Error("A real diff is required");
    const timestamp = now();
    this.database.prepare("UPDATE nodes SET diff = ?, patch_summary = ?, updated_at = ? WHERE run_id = ? AND id = ?")
      .run(diff, summary, timestamp, runId, nodeId);
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

  completeNode(runId: string, nodeId: string): ChangeNode {
    const node = this.requireNode(runId, nodeId);
    if (!node.diff) throw new Error("A diff is required before completion");
    if (!node.verification?.passed) throw new Error("A passing verification is required before completion");
    this.updateNodeStatus(runId, nodeId, "completed");
    this.addActivity(runId, "node", `Terminado: ${node.file} · ${node.symbol}`, node.patchSummary, nodeId);
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
      status, graphVersion: Number(row.graph_version), nodeCount: total, completedCount: completed,
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
