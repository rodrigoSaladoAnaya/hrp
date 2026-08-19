import { existsSync } from "node:fs";
import type { ProtocolConfig, ProtocolState } from "@human-review/protocol";
import { ProtocolOrchestrator } from "./orchestrator.js";
import { ProjectRegistry, type ProjectRecord } from "./project-registry.js";
import { WorkspaceObserver, type ObserverStatus } from "./workspace-observer.js";

export type ProjectContext = {
  project: ProjectRecord;
  config: ProtocolConfig;
  orchestrator: ProtocolOrchestrator;
  observer: WorkspaceObserver;
  store: ReturnType<ProjectRegistry["createEventStore"]>;
};

export type ProjectSummary = ProjectRecord & {
  available: boolean;
  loaded: boolean;
  observer?: ObserverStatus;
  sessionId?: string;
  activeNodeId?: string;
  pendingReview: boolean;
  lastActivityAt?: string;
};

export class ProjectManager {
  #contexts = new Map<string, ProjectContext>();
  #loading = new Map<string, Promise<ProjectContext>>();
  #defaultProjectId?: string;

  constructor(
    readonly config: ProtocolConfig,
    readonly registry: ProjectRegistry,
  ) {}

  get defaultProjectId(): string {
    if (!this.#defaultProjectId) throw new Error("Project manager has not been initialized");
    return this.#defaultProjectId;
  }

  async initialize(): Promise<ProjectContext> {
    await this.registry.initialize();
    const context = await this.attach(this.config.workspaceRoot);
    this.#defaultProjectId = context.project.id;
    return context;
  }

  async attach(workspaceRoot: string): Promise<ProjectContext> {
    const project = await this.registry.register(workspaceRoot);
    const current = this.#contexts.get(project.id);
    if (current) {
      this.registry.touch(project.id);
      return current;
    }
    const pending = this.#loading.get(project.id);
    if (pending) return await pending;

    const loading = this.#load(project);
    this.#loading.set(project.id, loading);
    try {
      return await loading;
    } finally {
      this.#loading.delete(project.id);
    }
  }

  async get(projectId?: string): Promise<ProjectContext> {
    const id = projectId ?? this.defaultProjectId;
    const current = this.#contexts.get(id);
    if (current) return current;
    const project = this.registry.findById(id);
    if (!project) throw new Error(`Unknown project: ${id}`);
    return await this.attach(project.workspaceRoot);
  }

  list(): ProjectSummary[] {
    return this.registry.list().map((project) => {
      const context = this.#contexts.get(project.id);
      const state: ProtocolState | undefined = context?.orchestrator.getState();
      return {
        ...project,
        available: existsSync(project.workspaceRoot),
        loaded: Boolean(context),
        observer: context?.observer.getStatus(),
        sessionId: state?.sessionId,
        activeNodeId: state?.activeNodeId,
        pendingReview: Boolean(state?.pendingReview),
        lastActivityAt: state?.lastUpdatedAt,
      };
    });
  }

  async close(): Promise<void> {
    for (const context of this.#contexts.values()) context.observer.stop();
    this.#contexts.clear();
    this.registry.close();
  }

  async #load(project: ProjectRecord): Promise<ProjectContext> {
    const projectConfig: ProtocolConfig = { ...this.config, workspaceRoot: project.workspaceRoot };
    const store = this.registry.createEventStore(project.id);
    const orchestrator = new ProtocolOrchestrator(store);
    await orchestrator.initialize();
    const observer = new WorkspaceObserver(projectConfig, orchestrator);
    await observer.start();
    const context = { project, config: projectConfig, orchestrator, observer, store };
    this.#contexts.set(project.id, context);
    this.registry.touch(project.id);
    return context;
  }
}
