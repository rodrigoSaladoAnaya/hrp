/*
THESIS: A human review desk makes intent, evidence, and selective oversight legible without binding the experience to one model vendor.
OWN-WORLD: Cool production paper, navy rules, one vermilion decision signal, continuous work lanes, and compact operational controls.
STORY: Read the graph, choose where review matters, inspect live evidence, then send a targeted observation back through the neutral protocol.
FIRST VIEWPORT: A status rail above three full-height lanes—review graph, selected-node control, and change reel—with required decisions pinned centrally.
FORM: Technical-director cue desk, ranked first among grounded forms; seed key 39da12e6.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
*/
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node as FlowNode,
  type NodeProps,
} from "@xyflow/react";
import { diffLines } from "diff";
import type {
  ChangeOperationEvidence,
  ChangeProgress,
  HumanObservation,
  NodeStatus,
  ObservationKind,
  Plan,
  PlanNode,
  ProtocolEvent,
  ProtocolState,
  ReviewMode,
  SemanticChange,
  VerificationResult,
} from "@human-review/protocol";

const statusLabels: Record<NodeStatus, string> = {
  pending: "Pendiente",
  awaiting_review: "En revisión",
  running: "En curso",
  paused: "Pausado",
  completed: "Terminado",
  superseded: "Sustituido",
  failed: "Falló",
};

const reviewLabels: Record<ReviewMode, string> = {
  required: "REVISAR",
  watch: "OBSERVAR",
  auto: "AUTO",
};

const observationLabels: Record<ObservationKind, string> = {
  change: "Cambio solicitado",
  question: "Pregunta",
  constraint: "Restricción",
  note: "Nota",
};

const eventLabels: Record<ProtocolEvent["type"], string> = {
  plan_created: "Plan creado",
  review_requested: "Revisión solicitada",
  review_resolved: "Revisión resuelta",
  review_policy_changed: "Política cambiada",
  node_started: "Nodo iniciado",
  intent_declared: "Intención declarada",
  patch_observed: "Cambio observado",
  verification_observed: "Verificación observada",
  node_completed: "Nodo terminado",
  human_observation_recorded: "Observación humana",
  control_changed: "Control cambiado",
  command_issued: "Comando emitido",
  command_acknowledged: "Comando recibido",
  replan_proposed: "Replanificación propuesta",
  replan_approved: "Replanificación aprobada",
  workspace_snapshot_observed: "Workspace observado",
};

type GraphProjection = "changes" | "plan";
type CueNodeData = {
  nodeId: string;
  changeId?: string;
  cue: string;
  title: string;
  status: NodeStatus;
  reviewMode: ReviewMode;
  active: boolean;
  dependencyLabel: string;
  detail: string;
  stage?: string;
};
type ObserverStatus = { state: "disabled" | "watching" | "unavailable" | "stopped"; detail: string };
type ProjectSummary = {
  id: string;
  name: string;
  workspaceRoot: string;
  available: boolean;
  loaded: boolean;
  observer?: ObserverStatus;
  sessionId?: string;
  activeNodeId?: string;
  pendingReview: boolean;
  lastActivityAt?: string;
};

function CueNode({ data, selected }: NodeProps<FlowNode<CueNodeData>>) {
  return (
    <div className={`cue-node status-${data.status} review-${data.reviewMode} ${data.active ? "is-active" : ""} ${selected ? "is-selected" : ""}`}>
      <Handle type="target" position={Position.Top} />
      <div className="cue-node__meta">
        <span className="cue-number">{data.cue}</span>
        <span className={`review-badge review-badge--${data.reviewMode}`}>{reviewLabels[data.reviewMode]}</span>
      </div>
      {data.stage && <span className="cue-node__stage">{data.stage}</span>}
      <strong>{data.title}</strong>
      <span className="cue-node__detail">{data.detail}</span>
      <div className="cue-node__footer">
        <span className="status-label">{statusLabels[data.status]}</span>
        <small>{data.dependencyLabel}</small>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { cue: CueNode };

function graphElements(
  plan: Plan,
  activeNodeId: string | undefined,
  projection: GraphProjection,
  progressByNode: Record<string, ChangeProgress[]>,
): { nodes: FlowNode<CueNodeData>[]; edges: Edge[] } {
  const hasGranularChanges = plan.nodes.some((node) => node.changes?.length);
  if (projection === "changes" && hasGranularChanges) {
    const changes = plan.nodes.flatMap((node, nodeIndex) => (node.changes ?? []).map((change, changeIndex) => ({
      node,
      nodeIndex,
      change,
      changeIndex,
    })));
    const byChangeId = new Map(changes.map((item) => [item.change.id, item]));
    const depths = new Map<string, number>();
    const depthOf = (id: string, trail = new Set<string>()): number => {
      if (depths.has(id)) return depths.get(id)!;
      if (trail.has(id)) return 0;
      const item = byChangeId.get(id);
      const nextTrail = new Set(trail).add(id);
      const depth = item?.change.dependencies.length
        ? Math.max(...item.change.dependencies.map((dependency) => depthOf(dependency, nextTrail))) + 1
        : item?.nodeIndex ?? 0;
      depths.set(id, depth);
      return depth;
    };
    changes.forEach(({ change }) => depthOf(change.id));
    const lanes = new Map<number, string[]>();
    for (const { change } of changes) {
      const depth = depths.get(change.id) ?? 0;
      lanes.set(depth, [...(lanes.get(depth) ?? []), change.id]);
    }
    const statusFor = (node: PlanNode, change: SemanticChange): NodeStatus => {
      if (node.status === "failed" || node.status === "superseded" || node.status === "paused") return node.status;
      const progress = progressByNode[node.id]?.find((candidate) => candidate.changeId === change.id);
      if (progress?.status === "verified") return "completed";
      if (progress?.status === "observed") return "running";
      return node.status === "completed" ? "completed" : "pending";
    };
    return {
      nodes: changes.map(({ node, nodeIndex, change, changeIndex }) => {
        const depth = depths.get(change.id) ?? nodeIndex;
        const lane = lanes.get(depth) ?? [];
        const offset = lane.indexOf(change.id) - (lane.length - 1) / 2;
        return {
          id: `${node.id}::${change.id}`,
          type: "cue",
          position: { x: 210 + offset * 245, y: 24 + depth * 188 },
          data: {
            nodeId: node.id,
            changeId: change.id,
            cue: `Q${String(nodeIndex + 1).padStart(2, "0")} · C${String(changeIndex + 1).padStart(2, "0")}`,
            title: change.title,
            stage: node.title,
            detail: `${change.operations.length} ${change.operations.length === 1 ? "operación" : "operaciones"} · ${new Set(change.operations.map((operation) => operation.file)).size} ${new Set(change.operations.map((operation) => operation.file)).size === 1 ? "archivo" : "archivos"}`,
            status: statusFor(node, change),
            reviewMode: node.reviewMode,
            active: node.id === activeNodeId,
            dependencyLabel: change.dependencies.length ? `tras ${change.dependencies.join(", ")}` : node.dependencies.length ? "tras fase anterior" : "inicio",
          },
        };
      }),
      edges: changes.flatMap(({ node, change }) => {
        const explicit = change.dependencies.map((dependency) => ({
          id: `${dependency}-${change.id}`,
          source: `${byChangeId.get(dependency)?.node.id}::${dependency}`,
          target: `${node.id}::${change.id}`,
        }));
        return explicit.map((edge) => ({ ...edge, animated: node.id === activeNodeId }));
      }),
    };
  }
  const depths = new Map<string, number>();
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  const depthOf = (id: string): number => {
    if (depths.has(id)) return depths.get(id)!;
    const node = byId.get(id);
    const depth = node?.dependencies.length ? Math.max(...node.dependencies.map(depthOf)) + 1 : 0;
    depths.set(id, depth);
    return depth;
  };
  plan.nodes.forEach((node) => depthOf(node.id));
  const lanes = new Map<number, string[]>();
  for (const node of plan.nodes) {
    const depth = depths.get(node.id) ?? 0;
    lanes.set(depth, [...(lanes.get(depth) ?? []), node.id]);
  }

  return {
    nodes: plan.nodes.map((node, index) => {
      const depth = depths.get(node.id) ?? 0;
      const lane = lanes.get(depth) ?? [];
      const offset = lane.indexOf(node.id) - (lane.length - 1) / 2;
      return {
        id: node.id,
        type: "cue",
        position: { x: 220 + offset * 220, y: 24 + depth * 168 },
        data: {
          nodeId: node.id,
          cue: `Q${String(index + 1).padStart(2, "0")}`,
          title: node.title,
          status: node.status,
          reviewMode: node.reviewMode,
          detail: node.changes?.length ? `${node.changes.length} cambios semánticos` : `${node.affectedFiles.length} archivos previstos`,
          active: node.id === activeNodeId,
          dependencyLabel: node.dependencies.length
            ? `tras ${node.dependencies.map((dependency) => `Q${String(plan.nodes.findIndex((candidate) => candidate.id === dependency) + 1).padStart(2, "0")}`).join(", ")}`
            : "inicio",
        },
      };
    }),
    edges: plan.nodes.flatMap((node) =>
      node.dependencies.map((dependency) => ({
        id: `${dependency}-${node.id}`,
        source: dependency,
        target: node.id,
        animated: node.id === activeNodeId,
        className: node.status === "superseded" ? "edge-superseded" : "",
      })),
    ),
  };
}

async function request(path: string, options: RequestInit = {}): Promise<void> {
  const response = await fetch(path, options);
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Request failed (${response.status})`);
  }
}

async function sendJson(path: string, method: "POST" | "PUT", body?: unknown): Promise<void> {
  await request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

function useProtocolState() {
  const [state, setState] = useState<ProtocolState | null>(null);
  const [observer, setObserver] = useState<ObserverStatus>();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string>();
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");
  const [error, setError] = useState<string>();

  const refreshProjects = useCallback(async () => {
    const response = await fetch("/api/projects");
    if (!response.ok) throw new Error(`Projects request failed (${response.status})`);
    const payload = (await response.json()) as { defaultProjectId: string; projects: ProjectSummary[] };
    setProjects(payload.projects);
    setProjectId((current) => {
      if (current && payload.projects.some((project) => project.id === current)) return current;
      const requested = new URL(window.location.href).searchParams.get("project");
      return requested && payload.projects.some((project) => project.id === requested)
        ? requested
        : payload.defaultProjectId;
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const base = `/api/projects/${encodeURIComponent(projectId)}`;
      const [stateResponse, configResponse, projectsResponse] = await Promise.all([
        fetch(`${base}/state`),
        fetch(`${base}/config`),
        fetch("/api/projects"),
      ]);
      if (!stateResponse.ok) throw new Error(`State request failed (${stateResponse.status})`);
      setState((await stateResponse.json()) as ProtocolState);
      if (configResponse.ok) setObserver(((await configResponse.json()) as { observer: ObserverStatus }).observer);
      if (projectsResponse.ok) setProjects(((await projectsResponse.json()) as { projects: ProjectSummary[] }).projects);
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo recuperar la sesión");
    }
  }, [projectId]);

  useEffect(() => {
    void refreshProjects().catch((caught) => {
      setError(caught instanceof Error ? caught.message : "No se pudo recuperar la lista de proyectos");
    });
  }, [refreshProjects]);

  useEffect(() => {
    if (!projectId) return;
    setState(null);
    setObserver(undefined);
    setConnection("connecting");
    void refresh();
    const stream = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events`);
    stream.addEventListener("ready", () => {
      setConnection("live");
      void refresh();
    });
    stream.addEventListener("protocol-event", () => void refresh());
    stream.onerror = () => setConnection("offline");
    return () => stream.close();
  }, [projectId, refresh]);

  const selectProject = useCallback((nextProjectId: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("project", nextProjectId);
    window.history.replaceState({}, "", url);
    setProjectId(nextProjectId);
  }, []);

  return { state, observer, projects, projectId, selectProject, connection, error, refresh };
}

function EmptySession({ observer }: { observer?: ObserverStatus }) {
  return (
    <main className="empty-session">
      <div className="empty-session__mark" aria-hidden="true">HR</div>
      <h1>El protocolo está listo.</h1>
      <p>
        Conecta cualquier agente o simulador al endpoint <code>POST /api/protocol/plans</code>. El primer plan aparecerá aquí con revisión obligatoria antes de ejecutar sus nodos.
      </p>
      <div className="empty-steps" aria-label="Flujo esperado">
        <span>El agente publica intención</span>
        <span>Tú defines la revisión</span>
        <span>El protocolo devuelve comandos</span>
      </div>
      <p className={`observer-note observer-note--${observer?.state ?? "stopped"}`}>
        Workspace: {observer?.detail ?? "comprobando observador…"}
      </p>
    </main>
  );
}

function EventList({ events }: { events: ProtocolEvent[] }) {
  if (!events.length) return <p className="empty-copy">Aún no hay eventos para este nodo.</p>;
  return (
    <ol className="event-list">
      {events.slice().reverse().map((event) => (
        <li key={event.id}>
          <time>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
          <div><strong>{eventLabels[event.type]}</strong><p>{event.summary}</p></div>
        </li>
      ))}
    </ol>
  );
}

function unifiedDiffLines(diff: string) {
  return diff.split("\n").map((line, index) => {
    const added = line.startsWith("+") && !line.startsWith("+++");
    const removed = line.startsWith("-") && !line.startsWith("---");
    return (
      <code className={added ? "line-added" : removed ? "line-removed" : "line-context"} key={`${index}-${line}`}>
        <i>{added ? "+" : removed ? "−" : " "}</i>{line || " "}{"\n"}
      </code>
    );
  });
}

type EvidenceTarget = {
  changeId?: string;
  operationId?: string;
  file?: string;
  symbol?: string;
  patchId?: string;
};

function PatchPlayer({
  events,
  selectedChangeId,
  selectedOperationId,
  onSelectTarget,
}: {
  events: ProtocolEvent[];
  selectedChangeId?: string;
  selectedOperationId?: string;
  onSelectTarget: (target: EvidenceTarget) => void;
}) {
  const patches = events.filter((event) => event.type === "patch_observed" || event.type === "workspace_snapshot_observed");
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedFile, setSelectedFile] = useState<string>();
  const [view, setView] = useState<"diff" | "before" | "after">("diff");
  const matchingPatch = patches.slice().reverse().find((patch) => {
    if (selectedOperationId) return patch.evidence?.operations?.some((operation) => operation.operationIds.includes(selectedOperationId));
    if (selectedChangeId) return (patch.changeId ?? patch.evidence?.changeId) === selectedChangeId;
    return false;
  });
  const selected = patches.find((patch) => patch.id === selectedId) ?? matchingPatch ?? patches.at(-1);
  const operationEvidence: ChangeOperationEvidence[] = selected?.evidence?.operations?.length
    ? selected.evidence.operations
    : (selected?.evidence?.files ?? []).map((file) => ({
        operationIds: [],
        file,
        summary: selected?.summary ?? "Cambio heredado",
        rationale: "Evidencia heredada sin mapeo granular declarado.",
        diff: selected?.evidence?.diff ?? "",
        beforeCode: selected?.evidence?.beforeCode,
        afterCode: selected?.evidence?.afterCode,
        addedLines: 0,
        removedLines: 0,
      }));
  const selectedEvidence = operationEvidence.find((operation) =>
    selectedOperationId ? operation.operationIds.includes(selectedOperationId) : operation.file === selectedFile,
  ) ?? operationEvidence[0];
  const patchId = selected?.evidence?.patchId ?? selected?.id;
  const associatedVerifications = selected ? events.filter((event) => {
    if (event.type !== "verification_observed") return false;
    const result = event.data?.result as VerificationResult | undefined;
    if (!result) return false;
    return (patchId ? result.coversPatchIds?.includes(patchId) : false)
      || (selectedChangeId ? result.coversChangeIds?.includes(selectedChangeId) : false)
      || (selectedEvidence?.operationIds.some((operationId) => result.coversOperationIds?.includes(operationId)) ?? false);
  }) : [];
  const lineChanges = useMemo(
    () => diffLines(selectedEvidence?.beforeCode ?? "", selectedEvidence?.afterCode ?? ""),
    [selectedEvidence],
  );

  useEffect(() => {
    setSelectedId(undefined);
    setSelectedFile(undefined);
  }, [selectedChangeId, selectedOperationId]);

  if (!selected) {
    return (
      <div className="player-empty">
        <strong>Sin cambios observados</strong>
        <p>Los patches reportados por el agente y los snapshots del workspace aparecerán aquí en orden causal.</p>
      </div>
    );
  }

  const hasSnapshots = selectedEvidence?.beforeCode !== undefined || selectedEvidence?.afterCode !== undefined;
  return (
    <div className="patch-player">
      <div className="patch-strip" role="list" aria-label="Cambios del nodo">
        {patches.map((patch, index) => (
          <button className={patch.id === selected.id ? "active" : ""} key={patch.id} onClick={() => { setSelectedId(patch.id); setSelectedFile(undefined); }} type="button">
            <span>P{String(index + 1).padStart(2, "0")} · {patch.source}</span>
            <strong>{patch.changeId ?? patch.evidence?.changeId ?? "workspace"}</strong>
            <small>{patch.evidence?.operations?.length ?? patch.evidence?.files?.length ?? 0} archivos</small>
          </button>
        ))}
      </div>
      <div className="patch-caption">
        <div><p>{selected.summary}</p><span>{selected.source}{selected.actor ? ` · ${selected.actor}` : ""} · {new Date(selected.timestamp).toLocaleTimeString()}</span></div>
        <span className="evidence-label">{selected.type === "workspace_snapshot_observed" ? "OBSERVADO" : "REPORTADO"}</span>
      </div>
      <div className="operation-strip" role="list" aria-label="Operaciones por archivo">
        {operationEvidence.map((operation) => {
          const operationId = operation.operationIds[0];
          const active = operation === selectedEvidence;
          return (
            <button
              className={active ? "active" : ""}
              key={`${selected.id}-${operation.file}-${operation.operationIds.join("-")}`}
              onClick={() => {
                setSelectedFile(operation.file);
                onSelectTarget({
                  changeId: selected.changeId ?? selected.evidence?.changeId,
                  operationId,
                  file: operation.file,
                  symbol: operation.symbol,
                  patchId,
                });
              }}
              type="button"
            >
              <span>{operation.file}</span>
              <small>+{operation.addedLines} −{operation.removedLines}{operation.symbol ? ` · ${operation.symbol}` : ""}</small>
            </button>
          );
        })}
      </div>
      {selectedEvidence && (
        <div className="operation-rationale">
          <div><strong>Qué cambió</strong><p>{selectedEvidence.summary}</p></div>
          <div><strong>Por qué</strong><p>{selectedEvidence.rationale}</p></div>
        </div>
      )}
      <div className="view-switcher" aria-label="Vista del cambio">
        {(["diff", "before", "after"] as const).map((option) => (
          <button
            className={view === option ? "active" : ""}
            disabled={!hasSnapshots && option !== "diff"}
            key={option}
            onClick={() => setView(option)}
            type="button"
          >
            {option === "diff" ? "Diferencia" : option === "before" ? "Antes" : "Después"}
          </button>
        ))}
      </div>
      <pre className="code-reel" tabIndex={0} aria-label={`Código ${view}`}>
        {view === "diff"
          ? hasSnapshots
            ? lineChanges.flatMap((change, index) =>
                change.value.split("\n").slice(0, -1).map((line, lineIndex) => (
                  <code className={change.added ? "line-added" : change.removed ? "line-removed" : "line-context"} key={`${index}-${lineIndex}`}>
                    <i>{change.added ? "+" : change.removed ? "−" : " "}</i>{line || " "}{"\n"}
                  </code>
                )),
              )
            : unifiedDiffLines(selectedEvidence?.diff ?? selected.evidence?.diff ?? "")
          : selectedEvidence?.[view === "before" ? "beforeCode" : "afterCode"]}
      </pre>
      <div className="mapped-verifications">
        {associatedVerifications.length ? associatedVerifications.map((verification) => (
          <details className={`patch-verification ${verification.evidence?.exitCode === 0 ? "passed" : "failed"}`} key={verification.id}>
            <summary>{verification.evidence?.exitCode === 0 ? "COBERTURA VERIFICADA" : "VERIFICACIÓN FALLÓ"} · {verification.evidence?.command}</summary>
            <pre>{verification.evidence?.output || "Sin salida."}</pre>
          </details>
        )) : <p className="unverified-evidence">Sin verificación mapeada a este cambio.</p>}
      </div>
    </div>
  );
}

function ObservationList({ observations }: { observations: HumanObservation[] }) {
  if (!observations.length) return null;
  return (
    <div className="observation-history">
      <h4>Observaciones humanas</h4>
      <ol>
        {observations.slice().reverse().map((observation) => (
          <li key={observation.id}>
            <div><strong>{observationLabels[observation.kind]}</strong>{observation.blocking && <span>bloqueante</span>}</div>
            <p>{observation.message}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ProjectRail({
  projects,
  selectedId,
  onSelect,
}: {
  projects: ProjectSummary[];
  selectedId?: string;
  onSelect: (projectId: string) => void;
}) {
  return (
    <nav className="project-rail" aria-label="Proyectos por carpeta">
      <div className="project-rail__label">
        <strong>Proyectos</strong>
        <span>{projects.length} {projects.length === 1 ? "carpeta" : "carpetas"}</span>
      </div>
      <div className="project-list" role="list">
        {projects.map((project) => {
          const status = !project.available
            ? "No disponible"
            : project.pendingReview
              ? "Revisar"
              : project.activeNodeId
                ? "En curso"
                : "En espera";
          return (
            <div className="project-item-wrap" key={project.id} role="listitem">
              <button
                aria-current={project.id === selectedId ? "page" : undefined}
                className="project-item"
                onClick={() => onSelect(project.id)}
                type="button"
              >
                <span className={`project-light ${project.pendingReview ? "needs-review" : project.activeNodeId ? "working" : "idle"}`} aria-hidden="true" />
                <span className="project-item__identity">
                  <strong>{project.name}</strong>
                  <code title={project.workspaceRoot}>{project.workspaceRoot}</code>
                </span>
                <span className="project-item__state">{status}</span>
              </button>
            </div>
          );
        })}
      </div>
    </nav>
  );
}

export function App() {
  const { state, observer, projects, projectId, selectProject, connection, error, refresh } = useProtocolState();
  const [planId, setPlanId] = useState<string>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [selectedChangeId, setSelectedChangeId] = useState<string>();
  const [selectedOperationId, setSelectedOperationId] = useState<string>();
  const [evidenceTarget, setEvidenceTarget] = useState<EvidenceTarget>({});
  const [graphProjection, setGraphProjection] = useState<GraphProjection>("changes");
  const [observation, setObservation] = useState("");
  const [observationKind, setObservationKind] = useState<ObservationKind>("change");
  const [blocking, setBlocking] = useState(false);
  const [policyScope, setPolicyScope] = useState<"node" | "subtree">("node");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const projectPath = useCallback(
    (suffix: string) => `/api/projects/${encodeURIComponent(projectId ?? "")}${suffix}`,
    [projectId],
  );

  const plan = state?.plans.find((candidate) => candidate.id === (planId ?? state.activePlanId)) ?? state?.plans.at(-1);
  const selectedNode = plan?.nodes.find((node) => node.id === selectedNodeId)
    ?? plan?.nodes.find((node) => node.id === state?.activeNodeId)
    ?? plan?.nodes[0];
  const selectedChange = selectedNode?.changes?.find((change) => change.id === selectedChangeId)
    ?? selectedNode?.changes?.[0];
  const selectedOperation = selectedChange?.operations.find((operation) => operation.id === selectedOperationId)
    ?? selectedChange?.operations[0];
  const selectedProgress = selectedNode && selectedChange
    ? state?.changeProgressByNode[selectedNode.id]?.find((progress) => progress.changeId === selectedChange.id)
    : undefined;
  const graph = useMemo(
    () => (plan ? graphElements(plan, state?.activeNodeId, graphProjection, state?.changeProgressByNode ?? {}) : { nodes: [], edges: [] }),
    [graphProjection, plan, state?.activeNodeId, state?.changeProgressByNode],
  );
  const nodeEvents = state?.events.filter((event) => !selectedNode || event.nodeId === selectedNode.id) ?? [];
  const verifications = selectedNode ? state?.verificationsByNode[selectedNode.id] ?? [] : [];
  const actualFiles = selectedNode ? state?.actualFilesByNode[selectedNode.id] ?? [] : [];
  const nodeObservations = selectedNode ? state?.observations.filter((item) => item.target.nodeId === selectedNode.id) ?? [] : [];
  const pendingCommands = state?.commands.filter((command) => command.status === "pending").length ?? 0;

  useEffect(() => {
    if (state?.pendingReview?.nodeId) {
      setPlanId(state.activePlanId);
      setSelectedNodeId(state.pendingReview.nodeId);
    }
  }, [state?.activePlanId, state?.pendingReview?.id, state?.pendingReview?.nodeId]);

  useEffect(() => {
    setPlanId(undefined);
    setSelectedNodeId(undefined);
    setSelectedChangeId(undefined);
    setSelectedOperationId(undefined);
    setEvidenceTarget({});
    setActionError(undefined);
  }, [projectId]);

  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setActionError(undefined);
    try {
      await operation();
      await refresh();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "La operación no se pudo completar");
    } finally {
      setBusy(false);
    }
  };

  const resolve = (decision: "approved" | "rejected") => {
    if (!state?.pendingReview) return;
    void act(() => sendJson(projectPath(`/reviews/${state.pendingReview!.id}/resolve`), "POST", { decision }));
  };

  const updatePolicy = (mode: ReviewMode) => {
    if (!selectedNode || !plan) return;
    void act(() => sendJson(projectPath("/review-policy"), "PUT", {
      planId: plan.id,
      nodeId: selectedNode.id,
      scope: policyScope,
      mode,
      reason: mode === "required" ? "Human review restored" : `Human marked ${policyScope} as ${mode}`,
    }));
  };

  const submitObservation = (event: FormEvent) => {
    event.preventDefault();
    if (!observation.trim() || !selectedNode || !plan) return;
    void act(async () => {
      await sendJson(projectPath("/observations"), "POST", {
        target: {
          planId: plan.id,
          nodeId: selectedNode.id,
          changeId: selectedChange?.id,
          operationId: selectedOperation?.id,
          file: evidenceTarget.file ?? selectedOperation?.file,
          symbol: evidenceTarget.symbol ?? selectedOperation?.symbol,
          patchId: evidenceTarget.patchId,
        },
        kind: observationKind,
        message: observation,
        blocking,
      });
      setObservation("");
      setBlocking(false);
    });
  };

  if (!state) return <div className="boot-state"><span className="go-light" />{error ?? "Conectando con el protocolo local…"}</div>;

  const pending = state.pendingReview;
  const pendingNode = pending?.nodeId ? plan?.nodes.find((node) => node.id === pending.nodeId) : undefined;
  const pendingReplan = pending?.kind === "replan" ? state.replanProposals.find((proposal) => proposal.id === pending.subjectId) : undefined;
  const sessionStatus = pending ? "REVISIÓN PENDIENTE" : state.paused ? "EN HOLD" : state.activeNodeId ? "TRABAJO EN VIVO" : "A LA ESPERA";

  return (
    <div className="app-shell">
      <header className="control-rail">
        <div className="wordmark"><span>HR</span><div><strong>Human Review Protocol</strong><small>Control neutral para agentes</small></div></div>
        <div className={`live-status ${pending ? "needs-action" : ""}`}>
          <span className="go-light" aria-hidden="true" />
          <div><small>ESTADO</small><strong>{sessionStatus}</strong></div>
        </div>
        <div className="command-state" title="Comandos pendientes de entrega al adaptador"><strong>{pendingCommands}</strong><span>comandos</span></div>
        <div className="connection-state"><span className={connection} />{connection === "live" ? "En vivo" : connection === "offline" ? "Sin conexión" : "Conectando"}</div>
        <button className="hold-button" disabled={busy} onClick={() => void act(() => sendJson(projectPath(`/control/${state.paused ? "resume" : "pause"}`), "POST"))} type="button">
          {state.paused ? "Reanudar" : "Pausar"}
        </button>
      </header>

      <ProjectRail projects={projects} selectedId={projectId} onSelect={selectProject} />

      {(error || actionError) && <div className="error-ribbon" role="alert"><span>{actionError ?? error}</span><button onClick={() => void refresh()} type="button">Reintentar</button></div>}

      {!state.plans.length ? <EmptySession observer={observer} /> : <main className={`work-lanes ${pending ? "has-pending" : ""}`}>
        <section className="lane graph-lane" aria-labelledby="graph-title">
          <div className="lane-heading">
            <div><h1 id="graph-title">Grafo y cobertura</h1><p>Selecciona dónde intervenir.</p></div>
            <div className="graph-heading-controls">
              <div className="projection-switch" aria-label="Profundidad del grafo" role="group">
                <button aria-pressed={graphProjection === "changes"} onClick={() => setGraphProjection("changes")} type="button">Cambios</button>
                <button aria-pressed={graphProjection === "plan"} onClick={() => setGraphProjection("plan")} type="button">Plan</button>
              </div>
              <select aria-label="Versión del plan" value={plan?.id} onChange={(event) => { setPlanId(event.target.value); setSelectedNodeId(undefined); setSelectedChangeId(undefined); setSelectedOperationId(undefined); }}>
                {state.plans.map((item) => <option key={item.id} value={item.id}>Plan v{item.version}</option>)}
              </select>
            </div>
          </div>
          <p className="plan-summary">{plan?.summary}</p>
          <div className="graph-canvas">
            <ReactFlow
              nodes={graph.nodes}
              edges={graph.edges}
              nodeTypes={nodeTypes}
              onNodeClick={(_event, node) => {
                const data = node.data as CueNodeData;
                setSelectedNodeId(data.nodeId);
                setSelectedChangeId(data.changeId);
                setSelectedOperationId(undefined);
                setEvidenceTarget({ changeId: data.changeId });
              }}
              fitView
              fitViewOptions={{ padding: 0.18 }}
              minZoom={0.35}
              maxZoom={1.5}
            >
              <Background gap={24} size={1} color="#cad2cf" />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          <div className="graph-legend">
            <span><i className="legend-required" /> revisar</span>
            <span><i className="legend-watch" /> observar</span>
            <span><i className="legend-auto" /> auto</span>
          </div>
        </section>

        <section className="lane context-lane" aria-labelledby="context-title">
          <div className="lane-heading">
            <div><h2 id="context-title">Revisión humana</h2><p>Política, contexto y observaciones.</p></div>
            {selectedNode && <span className={`node-stamp status-${selectedNode.status}`}>{statusLabels[selectedNode.status]}</span>}
          </div>

          {pending && (
            <div className="approval-cue" role="region" aria-label="Revisión pendiente">
              <div className="approval-cue__flag"><span>DECISIÓN</span><strong>{pending.kind === "replan" ? "REPLAN" : pending.kind.toUpperCase()}</strong></div>
              <div className="approval-cue__body">
                <small>SE NECESITA TU SEÑAL</small><p>{pending.summary}</p>
                {pendingNode && <div className="approval-subject"><strong>{pendingNode.title}</strong><span>{pendingNode.objective}</span><code>{pendingNode.affectedFiles.join(" · ")}</code></div>}
                {pendingReplan && (
                  <div className="replan-impact">
                    <div><strong>Supuesto cambiado</strong><span>{pendingReplan.changedAssumption}</span></div>
                    <dl>
                      <div><dt>Se conservan</dt><dd>{pendingReplan.retainedNodeIds.join(", ") || "Ninguno"}</dd></div>
                      <div><dt>Se sustituyen</dt><dd>{pendingReplan.supersededNodeIds.join(", ") || "Ninguno"}</dd></div>
                      <div><dt>Se añaden</dt><dd>{pendingReplan.newNodeIds.join(", ") || "Ninguno"}</dd></div>
                    </dl>
                  </div>
                )}
              </div>
              <div className="approval-actions">
                <button className="go-button" disabled={busy} onClick={() => resolve("approved")} type="button">Aprobar y continuar</button>
                <button className="reject-button" disabled={busy} onClick={() => resolve("rejected")} type="button">Rechazar</button>
              </div>
            </div>
          )}

          {selectedNode ? (
            <div className="node-brief">
              <div className="node-title-row">
                <div><span className="node-id">{selectedNode.id}</span><h3>{selectedNode.title}</h3></div>
                <span className={`review-badge review-badge--${selectedNode.reviewMode}`}>{reviewLabels[selectedNode.reviewMode]}</span>
              </div>
              <p className="objective">{selectedNode.objective}</p>

              {selectedChange ? (
                <section className="change-inspector" aria-labelledby="change-detail-title">
                  <div className="change-inspector__heading">
                    <div>
                      <span>{selectedNode.id} / {selectedChange.id}</span>
                      <h4 id="change-detail-title">{selectedChange.title}</h4>
                    </div>
                    <span className={`change-status change-status--${selectedProgress?.status ?? "planned"}`}>
                      {selectedProgress?.status === "verified" ? "VERIFICADO" : selectedProgress?.status === "observed" ? "CON EVIDENCIA" : "PLANEADO"}
                    </span>
                  </div>
                  <p className="change-intent">{selectedChange.intent}</p>
                  <dl className="change-reason">
                    <div><dt>Por qué existe</dt><dd>{selectedChange.rationale}</dd></div>
                  </dl>
                  <div className="operation-list" role="list" aria-label="Operaciones previstas por archivo">
                    {selectedChange.operations.map((operation) => {
                      const observed = selectedProgress?.observedOperationIds.includes(operation.id);
                      const verified = selectedProgress?.verifiedOperationIds.includes(operation.id)
                        || (selectedProgress?.status === "verified" && observed);
                      return (
                        <button
                          aria-pressed={selectedOperation?.id === operation.id}
                          className={selectedOperation?.id === operation.id ? "active" : ""}
                          key={operation.id}
                          onClick={() => {
                            setSelectedOperationId(operation.id);
                            setEvidenceTarget({
                              changeId: selectedChange.id,
                              operationId: operation.id,
                              file: operation.file,
                              symbol: operation.symbol,
                            });
                          }}
                          role="listitem"
                          type="button"
                        >
                          <span className={`operation-state operation-state--${verified ? "verified" : observed ? "observed" : "planned"}`}>
                            {verified ? "verificado" : observed ? "observado" : "previsto"}
                          </span>
                          <code>{operation.file}{operation.symbol ? ` · ${operation.symbol}` : ""}</code>
                          <strong>{operation.summary}</strong>
                          <small>{operation.rationale}</small>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ) : (
                <div className="legacy-granularity-note">
                  Esta corrida usa el contrato anterior: conserva evidencia por nodo, pero no declaró cambios semánticos ni operaciones por archivo.
                </div>
              )}

              <div className="policy-control" aria-label="Política de revisión">
                <div className="policy-control__heading"><h4>Necesidad de revisión</h4><label><input checked={policyScope === "subtree"} onChange={(event) => setPolicyScope(event.target.checked ? "subtree" : "node")} type="checkbox" />Aplicar a la rama</label></div>
                <div className="policy-options">
                  {(["required", "watch", "auto"] as const).map((mode) => (
                    <button aria-pressed={selectedNode.reviewMode === mode} className={`policy-option policy-option--${mode}`} disabled={busy} key={mode} onClick={() => updatePolicy(mode)} type="button">
                      <strong>{reviewLabels[mode]}</strong>
                      <span>{mode === "required" ? "Detiene el flujo" : mode === "watch" ? "Visible, sin detener" : "Continúa en segundo plano"}</span>
                    </button>
                  ))}
                </div>
                <p>Las exenciones se invalidan si cambia el contenido del nodo.</p>
              </div>

              <dl className="decision-grid">
                <div><dt>Decisión de fase</dt><dd>{selectedNode.rationale}</dd></div>
                <div><dt>Alternativa descartada</dt><dd>{selectedNode.alternatives?.[0] ? `${selectedNode.alternatives[0].option} — ${selectedNode.alternatives[0].reasonRejected}` : "Sin alternativa relevante registrada."}</dd></div>
              </dl>

              <div className="evidence-grid">
                <div><h4>Archivos previstos</h4><ul>{selectedNode.affectedFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul></div>
                <div><h4>Archivos observados</h4>{actualFiles.length ? <ul>{actualFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul> : <p className="empty-copy">Ninguno todavía.</p>}</div>
              </div>

              <div className="verification-block">
                <h4>Criterio de verificación</h4>
                <ul>{selectedNode.verificationCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
                {verifications.map((verification) => (
                  <details key={verification.eventId} className={verification.passed ? "verification-pass" : "verification-fail"}>
                    <summary>{verification.passed ? "PASÓ" : "FALLÓ"} · {verification.commandId}</summary>
                    <pre>{verification.output || "Sin salida."}</pre>
                  </details>
                ))}
              </div>
            </div>
          ) : <p className="empty-copy">Selecciona un nodo del grafo.</p>}

          <form className="observation-form" onSubmit={submitObservation}>
            <div className="observation-form__heading">
              <label htmlFor="observation">Enviar una observación</label>
              <span>
                {selectedOperation
                  ? `${selectedOperation.file}${selectedOperation.symbol ? ` · ${selectedOperation.symbol}` : ""}`
                  : selectedChange
                    ? `Cambio ${selectedChange.id}`
                    : "Nodo seleccionado"}
              </span>
            </div>
            <div className="observation-meta">
              <select aria-label="Tipo de observación" onChange={(event) => setObservationKind(event.target.value as ObservationKind)} value={observationKind}>
                <option value="change">Cambio solicitado</option><option value="question">Pregunta</option><option value="constraint">Restricción</option><option value="note">Nota</option>
              </select>
              <label><input checked={blocking} onChange={(event) => setBlocking(event.target.checked)} type="checkbox" />Bloquear hasta respuesta</label>
            </div>
            <textarea id="observation" maxLength={4000} onChange={(event) => setObservation(event.target.value)} placeholder="Describe qué debe cambiar o explicar el agente; quedará ligado a esta operación y su evidencia…" value={observation} />
            <button disabled={busy || !observation.trim() || !selectedNode} type="submit">Emitir observación</button>
          </form>

          <ObservationList observations={nodeObservations} />
          <div className="timeline"><h4>Historial del nodo</h4><EventList events={nodeEvents} /></div>
        </section>

        <section className="lane patch-lane" aria-labelledby="patch-title">
          <div className="lane-heading"><div><h2 id="patch-title">Evidencia por archivo</h2><p>Qué cambió, por qué y qué lo verifica.</p></div><span className="patch-count">{nodeEvents.filter((event) => event.type === "patch_observed" || event.type === "workspace_snapshot_observed").length} patches</span></div>
          <PatchPlayer
            events={nodeEvents}
            onSelectTarget={(target) => {
              setEvidenceTarget(target);
              if (target.changeId) setSelectedChangeId(target.changeId);
              if (target.operationId) setSelectedOperationId(target.operationId);
            }}
            selectedChangeId={selectedChange?.id}
            selectedOperationId={selectedOperation?.id}
          />
        </section>
      </main>}
    </div>
  );
}
