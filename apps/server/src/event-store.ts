import { EventEmitter } from "node:events";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { ProtocolEvent } from "@human-review/protocol";

export class JsonlEventStore extends EventEmitter {
  readonly filePath: string;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    super();
    this.filePath = path.join(dataDirectory, "events.jsonl");
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, "", "utf8");
  }

  async readAll(): Promise<ProtocolEvent[]> {
    const raw = await readFile(this.filePath, "utf8");
    if (!raw.trim()) return [];

    return raw
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line) as ProtocolEvent;
        } catch (error) {
          throw new Error(`Invalid JSONL event at line ${index + 1}: ${String(error)}`);
        }
      });
  }

  async append(event: ProtocolEvent): Promise<void> {
    this.#writeChain = this.#writeChain.then(() => appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8"));
    await this.#writeChain;
    this.emit("event", event);
  }
}

type EventRow = { payload_json: string };

export class SqliteEventStore extends JsonlEventStore {
  #writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly database: Database.Database,
    readonly projectId: string,
  ) {
    super(":sqlite:");
  }

  override async initialize(): Promise<void> {
    // The registry owns the database lifecycle and schema migration.
  }

  override async readAll(): Promise<ProtocolEvent[]> {
    const rows = this.database
      .prepare("SELECT payload_json FROM events WHERE project_id = ? ORDER BY sequence")
      .all(this.projectId) as EventRow[];
    return rows.map((row, index) => {
      try {
        return JSON.parse(row.payload_json) as ProtocolEvent;
      } catch (error) {
        throw new Error(`Invalid SQLite event at row ${index + 1} for project ${this.projectId}: ${String(error)}`);
      }
    });
  }

  override async append(event: ProtocolEvent): Promise<void> {
    this.#writeChain = this.#writeChain.then(() => {
      this.database.prepare(`
        INSERT INTO events (project_id, sequence, event_id, timestamp, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(this.projectId, event.sequence, event.id, event.timestamp, JSON.stringify(event));
    });
    await this.#writeChain;
    this.emit("event", event);
  }
}
