import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import type { ProtocolEvent } from "@human-review/protocol";
import { SqliteEventStore } from "./event-store.js";

export type ProjectRecord = {
  id: string;
  name: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
};

type ProjectRow = {
  id: string;
  name: string;
  workspace_root: string;
  created_at: string;
  updated_at: string;
  last_opened_at: string;
};

function projectFromRow(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    workspaceRoot: row.workspace_root,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
  };
}

export function projectStorageKey(workspaceRoot: string): string {
  const slug = path.basename(workspaceRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
  const hash = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

export class ProjectRegistry {
  readonly filePath: string;
  #database?: Database.Database;

  constructor(readonly dataDirectory: string) {
    this.filePath = path.join(dataDirectory, "hrp.sqlite");
  }

  get database(): Database.Database {
    if (!this.#database) throw new Error("Project registry has not been initialized");
    return this.#database;
  }

  async initialize(): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    this.#database = new Database(this.filePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_root TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (project_id, sequence),
        UNIQUE (project_id, event_id)
      );

      CREATE INDEX IF NOT EXISTS events_project_timestamp
      ON events(project_id, timestamp);
    `);
  }

  async register(workspaceRoot: string): Promise<ProjectRecord> {
    const requested = path.resolve(workspaceRoot);
    const metadata = await stat(requested).catch(() => undefined);
    if (!metadata?.isDirectory()) throw new Error(`Workspace does not exist or is not a directory: ${requested}`);
    const canonicalRoot = await realpath(requested);
    const now = new Date().toISOString();
    const id = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 20);
    const name = path.basename(canonicalRoot) || canonicalRoot;

    this.database.prepare(`
      INSERT INTO projects (id, name, workspace_root, created_at, updated_at, last_opened_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_root) DO UPDATE SET
        name = excluded.name,
        updated_at = excluded.updated_at,
        last_opened_at = excluded.last_opened_at
    `).run(id, name, canonicalRoot, now, now, now);

    const project = this.findByWorkspace(canonicalRoot)!;
    await this.#importLegacyEvents(project);
    return project;
  }

  list(): ProjectRecord[] {
    return (this.database.prepare(`
      SELECT id, name, workspace_root, created_at, updated_at, last_opened_at
      FROM projects
      ORDER BY last_opened_at DESC, name COLLATE NOCASE
    `).all() as ProjectRow[]).map(projectFromRow);
  }

  findById(id: string): ProjectRecord | undefined {
    const row = this.database.prepare(`
      SELECT id, name, workspace_root, created_at, updated_at, last_opened_at
      FROM projects WHERE id = ?
    `).get(id) as ProjectRow | undefined;
    return row ? projectFromRow(row) : undefined;
  }

  findByWorkspace(workspaceRoot: string): ProjectRecord | undefined {
    const row = this.database.prepare(`
      SELECT id, name, workspace_root, created_at, updated_at, last_opened_at
      FROM projects WHERE workspace_root = ?
    `).get(path.resolve(workspaceRoot)) as ProjectRow | undefined;
    return row ? projectFromRow(row) : undefined;
  }

  touch(id: string): void {
    const now = new Date().toISOString();
    this.database.prepare("UPDATE projects SET updated_at = ?, last_opened_at = ? WHERE id = ?").run(now, now, id);
  }

  createEventStore(projectId: string): SqliteEventStore {
    if (!this.findById(projectId)) throw new Error(`Unknown project: ${projectId}`);
    return new SqliteEventStore(this.database, projectId);
  }

  close(): void {
    this.#database?.close();
    this.#database = undefined;
  }

  async #importLegacyEvents(project: ProjectRecord): Promise<void> {
    const count = this.database.prepare("SELECT COUNT(*) AS count FROM events WHERE project_id = ?")
      .get(project.id) as { count: number };
    if (count.count > 0) return;

    const candidates = [
      path.join(this.dataDirectory, "workspaces", projectStorageKey(project.workspaceRoot), "events.jsonl"),
      path.join(this.dataDirectory, "events.jsonl"),
    ];
    const legacyFile = candidates.find((candidate) => existsSync(candidate));
    if (!legacyFile) return;
    const raw = await readFile(legacyFile, "utf8");
    const events = raw.split("\n").filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line) as ProtocolEvent;
      } catch (error) {
        throw new Error(`Invalid legacy JSONL event at ${legacyFile}:${index + 1}: ${String(error)}`);
      }
    });
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO events (project_id, sequence, event_id, timestamp, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.database.transaction((items: ProtocolEvent[]) => {
      for (const event of items) insert.run(project.id, event.sequence, event.id, event.timestamp, JSON.stringify(event));
    })(events);
  }
}
