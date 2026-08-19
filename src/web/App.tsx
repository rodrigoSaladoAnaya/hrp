import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dagre from "@dagrejs/dagre";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type AriaLabelConfig,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { Activity, ChangeNode, NodeStatus, Project, RunDetail, RunSummary } from "../shared/protocol";

type ProjectWithRuns = Project & { runs: RunSummary[] };
type Catalog = { projects: ProjectWithRuns[] };
type ConnectionState = "connecting" | "connected" | "offline";
type MapNodeData = {
  change: ChangeNode;
  isSelected: boolean;
  onSelect: (id: string) => void;
};

const statusCopy: Record<NodeStatus, string> = {
  pending: "Pendiente",
  running: "En curso",
  completed: "Terminado",
  failed: "Falló",
};

const runStatusRank: Record<NodeStatus, number> = {
  running: 0,
  failed: 1,
  pending: 2,
  completed: 3,
};

function sortRuns(runs: RunSummary[]): RunSummary[] {
  return [...runs].sort((left, right) => runStatusRank[left.status] - runStatusRank[right.status]
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function sortProjects(projects: ProjectWithRuns[]): ProjectWithRuns[] {
  const projectTime = (project: ProjectWithRuns) => Math.max(
    Date.parse(project.lastOpenedAt),
    ...project.runs.map((run) => Date.parse(run.updatedAt)),
  );
  return [...projects].sort((left, right) => {
    const leftActive = left.runs.some((run) => run.status === "running") ? 1 : 0;
    const rightActive = right.runs.some((run) => run.status === "running") ? 1 : 0;
    return rightActive - leftActive || projectTime(right) - projectTime(left);
  });
}

function Icon({ name }: { name: "route" | "activity" | "folder" | "check" | "clock" | "warning" | "code" }) {
  const paths = {
    route: <><circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h5a4 4 0 0 1 4 4v4a4 4 0 0 0 3 4"/></>,
    activity: <><path d="M4 17h3l2-10 4 13 3-8 2 5h2"/></>,
    folder: <><path d="M3 7h7l2 2h9v10H3z"/><path d="M3 7V5h7l2 2"/></>,
    check: <><path d="m5 12 4 4L19 6"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    warning: <><path d="M12 3 2.8 20h18.4z"/><path d="M12 9v4M12 17h.01"/></>,
    code: <><path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="icon">{paths[name]}</svg>;
}

function StatusSignal({ status }: { status: NodeStatus }) {
  const icon = status === "completed" ? "check" : status === "failed" ? "warning" : "clock";
  return <span className={`status-signal status-${status}`}><Icon name={icon}/>{statusCopy[status]}</span>;
}

function ChangeNodeCard({ data }: NodeProps<Node<MapNodeData>>) {
  const change = data.change;
  return (
    <button
      type="button"
      className={`change-node nodrag nopan change-node-${change.status} ${data.isSelected ? "is-selected" : ""}`}
      aria-label={`${change.file}, ${change.symbol}, ${statusCopy[change.status]}`}
      aria-pressed={data.isSelected}
      onClick={() => data.onSelect(change.id)}
    >
      <Handle type="target" position={Position.Left} className="route-handle" />
      <div className="node-route-head">
        <span className="node-file">{change.file}</span>
        {change.discovered && <span className="discovered-label">Descubierto</span>}
      </div>
      <strong className="node-symbol">{change.symbol}</strong>
      <p>{change.title}</p>
      <div className="node-status-row"><StatusSignal status={change.status}/></div>
      <Handle type="source" position={Position.Right} className="route-handle" />
    </button>
  );
}

const nodeTypes = { change: ChangeNodeCard };
const graphAriaLabels: Partial<AriaLabelConfig> = {
  "node.a11yDescription.default": "Operación semántica de cambio",
  "node.a11yDescription.keyboardDisabled": "Usa el botón dentro del nodo para abrir sus detalles.",
  "edge.a11yDescription.default": "Dependencia entre operaciones",
  "controls.ariaLabel": "Controles del mapa",
  "controls.zoomIn.ariaLabel": "Acercar mapa",
  "controls.zoomOut.ariaLabel": "Alejar mapa",
  "controls.fitView.ariaLabel": "Mostrar el mapa completo",
  "controls.interactive.ariaLabel": "Alternar interacción",
  "minimap.ariaLabel": "Vista general del mapa",
  "handle.ariaLabel": "Conexión de dependencia",
};

function layoutGraph(changes: ChangeNode[], selectedId: string | undefined, onSelect: (id: string) => void): { nodes: Node<MapNodeData>[]; edges: Edge[] } {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", ranksep: 86, nodesep: 46, marginx: 44, marginy: 44 });
  for (const change of changes) graph.setNode(change.id, { width: 272, height: 148 });
  for (const change of changes) for (const dependency of change.dependencies) graph.setEdge(dependency, change.id);
  dagre.layout(graph);
  const byId = new Map(changes.map((change) => [change.id, change]));
  const nodes = changes.map((change) => {
    const point = graph.node(change.id) as { x: number; y: number };
    return {
      id: change.id,
      type: "change",
      position: { x: point.x - 136, y: point.y - 74 },
      data: { change, isSelected: change.id === selectedId, onSelect },
    };
  });
  const edges = changes.flatMap((change) => change.dependencies.map((dependency) => ({
    id: `${dependency}-${change.id}`,
    source: dependency,
    target: change.id,
    type: "smoothstep",
    animated: change.status === "running",
    className: `route-edge route-edge-${change.status}`,
    markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15 },
    data: { sourceStatus: byId.get(dependency)?.status },
  })));
  return { nodes, edges };
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="diff-view" aria-label="Diferencia aplicada">
      {lines.map((line, index) => {
        const kind = line.startsWith("+") && !line.startsWith("+++") ? "add"
          : line.startsWith("-") && !line.startsWith("---") ? "remove"
            : line.startsWith("@@") ? "hunk" : "context";
        return <code className={`diff-line diff-${kind}`} key={`${index}-${line}`}><span>{index + 1}</span>{line || " "}</code>;
      })}
    </pre>
  );
}

function Inspector({ node, nodes, activity }: { node?: ChangeNode; nodes: ChangeNode[]; activity: Activity[] }) {
  if (!node) {
    return (
      <aside className="inspector empty-inspector">
        <div className="empty-symbol"><Icon name="route" /></div>
        <h2>Selecciona una operación</h2>
        <p>Cada nodo representa un cambio concreto en un archivo y símbolo. Aquí aparecerán su intención, dependencias y evidencia.</p>
      </aside>
    );
  }
  const dependencies = node.dependencies.map((id) => nodes.find((candidate) => candidate.id === id)).filter(Boolean) as ChangeNode[];
  const failedAttempts = activity.filter((item) => item.nodeId === node.id && item.type === "verify" && item.message.toLocaleLowerCase("es").includes("fallida")).length;
  return (
    <aside className="inspector" aria-live="polite">
      <header className="inspector-head">
        <div>
          <span className="inspector-file">{node.file}</span>
          <h2>{node.symbol}</h2>
        </div>
        <StatusSignal status={node.status}/>
      </header>

      {node.status === "failed" && (
        <section className="failure-guidance" role="alert">
          <Icon name="warning"/>
          <div>
            <h3>Este nodo necesita corrección</h3>
            <p>El agente debe corregir el cambio y reintentar este mismo nodo. Sus dependientes permanecen bloqueados; no se crea otra ejecución.</p>
            <span>{failedAttempts || 1} {failedAttempts === 1 ? "intento fallido conservado" : "intentos fallidos conservados"} en Actividad.</span>
          </div>
        </section>
      )}

      <section className="inspector-intent">
        <h3>{node.status === "pending" ? "Qué hará" : "Qué hizo"}</h3>
        <p>{node.status === "pending" ? node.description : node.patchSummary ?? node.description}</p>
      </section>

      <section>
        <h3>Por qué</h3>
        <p>{node.rationale}</p>
      </section>

      {dependencies.length > 0 && (
        <section>
          <h3>Depende de</h3>
          <ul className="dependency-list">
            {dependencies.map((dependency) => <li key={dependency.id}><span className={`dependency-dot status-${dependency.status}`}/><span><strong>{dependency.file}</strong>{dependency.symbol}</span></li>)}
          </ul>
        </section>
      )}

      {node.diff ? (
        <section className="diff-section">
          <div className="section-title-row"><h3>Diff aplicado</h3><span>{node.diff.split("\n").length} líneas</span></div>
          <DiffView diff={node.diff}/>
        </section>
      ) : (
        <section className="pending-evidence"><Icon name="clock"/><div><h3>Sin código todavía</h3><p>El diff aparecerá cuando el agente publique esta operación.</p></div></section>
      )}

      {node.verification && (
        <section className={`verification verification-${node.verification.passed ? "passed" : "failed"}`}>
          <div className="verification-title"><Icon name={node.verification.passed ? "check" : "warning"}/><div><h3>{node.verification.passed ? "Verificación aprobada" : "Verificación fallida"}</h3><code>{node.verification.command}</code></div></div>
          {node.verification.output && <pre>{node.verification.output}</pre>}
        </section>
      )}
    </aside>
  );
}

function ActivityLedger({ activity, nodes, onSelect }: { activity: Activity[]; nodes: ChangeNode[]; onSelect: (id: string) => void }) {
  if (!activity.length) return <div className="ledger-empty"><Icon name="activity"/><h2>Aún no hay actividad</h2><p>Las inspecciones, operaciones, parches y verificaciones aparecerán aquí en orden causal.</p></div>;
  return (
    <ol className="activity-ledger">
      {activity.map((item) => {
        const node = item.nodeId ? nodes.find((candidate) => candidate.id === item.nodeId) : undefined;
        return (
          <li key={item.id}>
            <span className={`activity-mark activity-${item.type}`}/>
            <time>{new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(item.createdAt))}</time>
            <div>
              <strong>{item.message}</strong>
              {node && <button type="button" onClick={() => onSelect(node.id)}>{node.file} · {node.symbol}</button>}
              {item.detail && <p>{item.detail}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function EmptyState({ kind }: { kind: "projects" | "runs" }) {
  return (
    <main className="full-empty">
      <div className="empty-route" aria-hidden="true"><span/><span/><span/></div>
      <h1>{kind === "projects" ? "Conecta una carpeta para comenzar" : "Publica una ejecución para ver su mapa"}</h1>
      <p>{kind === "projects" ? "HRP sólo observa los proyectos que un adaptador registra explícitamente." : "El agente debe declarar cada operación semántica antes de aplicar sus cambios."}</p>
      <pre>{kind === "projects" ? "hrp attach . --start" : "hrp run create --title \"Mi tarea\" --requirement \"Qué debe cambiar\""}</pre>
    </main>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <main className="loading-state" aria-busy="true" aria-live="polite">
      <div className="loading-route" aria-hidden="true"><span/><span/><span/></div>
      <h1>{label}</h1>
      <p>Sincronizando el registro local de HRP.</p>
    </main>
  );
}

function ProjectTree({ projects, projectId, runId, onProject, onRun }: {
  projects: ProjectWithRuns[];
  projectId: string;
  runId: string;
  onProject: (project: ProjectWithRuns) => void;
  onRun: (projectId: string, runId: string) => void;
}) {
  const orderedProjects = sortProjects(projects);
  const formatter = new Intl.DateTimeFormat("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <aside className="project-tree" aria-label="Proyectos y ejecuciones">
      <header className="tree-head">
        <div><Icon name="folder"/><h2>Proyectos</h2></div>
        <span>{projects.length}</span>
      </header>
      <div className="tree-scroll">
        {orderedProjects.map((project) => {
          const runs = sortRuns(project.runs);
          const selected = project.id === projectId;
          return (
            <section className={`tree-project ${selected ? "is-current" : ""}`} key={project.id}>
              <button type="button" className="tree-project-button" aria-current={selected ? "true" : undefined} onClick={() => onProject(project)}>
                <span className="tree-branch"><Icon name="folder"/></span>
                <span><strong>{project.name}</strong><small title={project.workspaceRoot}>{project.workspaceRoot}</small></span>
              </button>
              {runs.length ? (
                <ul>
                  {runs.map((run) => (
                    <li key={run.id}>
                      <button type="button" className={`tree-run status-${run.status} ${run.id === runId ? "is-current" : ""}`} aria-current={run.id === runId ? "page" : undefined} onClick={() => onRun(project.id, run.id)}>
                        <span className="tree-signal"/>
                        <span className="tree-run-copy"><strong>{run.title}</strong><small>{statusCopy[run.status]} · {run.completedCount}/{run.nodeCount} · {formatter.format(new Date(run.updatedAt))}</small></span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="tree-empty">Sin ejecuciones</p>}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

export function App() {
  const [catalog, setCatalog] = useState<Catalog>({ projects: [] });
  const [projectId, setProjectId] = useState(() => new URLSearchParams(location.search).get("project") ?? "");
  const [runId, setRunId] = useState(() => new URLSearchParams(location.search).get("run") ?? "");
  const [detail, setDetail] = useState<RunDetail>();
  const [selectedId, setSelectedId] = useState<string>();
  const [view, setView] = useState<"map" | "activity">("map");
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [loadingRun, setLoadingRun] = useState(false);
  const [error, setError] = useState<string>();
  const observedStatuses = useRef(new Map<string, NodeStatus>());

  const loadCatalog = useCallback(async () => {
    try {
      const response = await fetch("/api/projects");
      if (!response.ok) throw new Error("No se pudo cargar la lista de proyectos");
      const next = await response.json() as Catalog;
      setCatalog(next);
      setProjectId((current) => current && next.projects.some((project) => project.id === current) ? current : next.projects[0]?.id ?? "");
    } finally {
      setLoadingCatalog(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    if (!id) { setDetail(undefined); setLoadingRun(false); return; }
    setLoadingRun(true);
    try {
      const response = await fetch(`/api/runs/${id}`);
      if (!response.ok) throw new Error("No se pudo cargar la ejecución");
      const next = await response.json() as RunDetail;
      const newlyFailed = next.nodes.find((node) => node.status === "failed" && observedStatuses.current.get(`${next.run.id}:${node.id}`) !== "failed");
      for (const node of next.nodes) observedStatuses.current.set(`${next.run.id}:${node.id}`, node.status);
      setDetail(next);
      setSelectedId((current) => newlyFailed?.id
        ?? (current && next.nodes.some((node) => node.id === current) ? current : next.nodes.find((node) => node.status === "running")?.id ?? next.nodes[0]?.id));
    } finally {
      setLoadingRun(false);
    }
  }, []);

  useEffect(() => { loadCatalog().catch((cause) => setError(String(cause))); }, [loadCatalog]);

  const project = catalog.projects.find((candidate) => candidate.id === projectId);
  useEffect(() => {
    if (!project) { setRunId(""); return; }
    setRunId((current) => current && project.runs.some((run) => run.id === current) ? current : project.runs[0]?.id ?? "");
  }, [project]);

  useEffect(() => { loadDetail(runId).catch((cause) => setError(String(cause))); }, [runId, loadDetail]);

  useEffect(() => {
    setConnectionState("connecting");
    const source = new EventSource(`/api/events${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
    source.onopen = () => setConnectionState("connected");
    source.addEventListener("ready", () => setConnectionState("connected"));
    source.addEventListener("change", (event) => {
      const change = JSON.parse((event as MessageEvent).data) as { runId: string };
      loadCatalog().catch(() => undefined);
      if (runId && change.runId === runId) loadDetail(runId).catch(() => undefined);
    });
    source.onerror = () => setConnectionState("offline");
    return () => source.close();
  }, [projectId, runId, loadCatalog, loadDetail]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (projectId) params.set("project", projectId);
    if (runId) params.set("run", runId);
    history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }, [projectId, runId]);

  const graph = useMemo(() => layoutGraph(detail?.nodes ?? [], selectedId, setSelectedId), [detail?.nodes, selectedId]);
  const selectedNode = detail?.nodes.find((node) => node.id === selectedId);
  const progress = detail?.run.nodeCount ? Math.round((detail.run.completedCount / detail.run.nodeCount) * 100) : 0;

  if (error) return <div className="fatal-error"><Icon name="warning"/><h1>HRP no pudo iniciar</h1><p>{error}</p><button onClick={() => location.reload()}>Volver a intentar</button></div>;
  if (loadingCatalog) return <><TopBar connectionState={connectionState}/><LoadingState label="Cargando proyectos"/></>;
  if (!catalog.projects.length) return <><TopBar connectionState={connectionState}/><EmptyState kind="projects"/></>;

  return (
    <div className="app-shell">
      <TopBar connectionState={connectionState} project={project} run={detail?.run} progress={progress}/>
      <div className="app-body">
        <ProjectTree
          projects={catalog.projects}
          projectId={projectId}
          runId={runId}
          onProject={(nextProject) => { setProjectId(nextProject.id); setRunId(sortRuns(nextProject.runs)[0]?.id ?? ""); }}
          onRun={(nextProjectId, nextRunId) => { setProjectId(nextProjectId); setRunId(nextRunId); }}
        />
        <div className="content-shell">
          <div className="content-toolbar">
            <div className="current-context"><Icon name="route"/><span>{detail?.run.title ?? "Sin ejecución seleccionada"}</span></div>
            <nav aria-label="Vista principal"><button aria-pressed={view === "map"} className={view === "map" ? "active" : ""} onClick={() => setView("map")}><Icon name="route"/>Mapa</button><button aria-pressed={view === "activity"} className={view === "activity" ? "active" : ""} onClick={() => setView("activity")}><Icon name="activity"/>Actividad</button></nav>
          </div>
          {loadingRun ? <LoadingState label="Cargando ejecución"/> : !runId || !detail ? <EmptyState kind="runs"/> : (
            <main className="workspace">
              <section className="map-stage" aria-label={view === "map" ? "Mapa de cambios" : "Actividad de la ejecución"}>
                <header className="stage-head">
                  <div><h1>{detail.run.title}</h1><p>{detail.run.requirement}</p></div>
                  <div className="stage-count"><strong>{detail.run.completedCount}/{detail.run.nodeCount}</strong><span>operaciones terminadas</span></div>
                </header>
                {view === "map" ? (
                  detail.nodes.length ? <div className="flow-wrap"><ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false} onNodeClick={(_event, node) => setSelectedId(node.id)} ariaLabelConfig={graphAriaLabels} fitView fitViewOptions={{ padding: 0.22, maxZoom: 1 }} minZoom={0.25} maxZoom={1.8} proOptions={{ hideAttribution: true }}><Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#aab5af"/><Controls showInteractive={false} aria-label="Controles del mapa"/></ReactFlow></div>
                    : <div className="map-empty"><Icon name="route"/><h2>El mapa aún no ha sido publicado</h2><p>La ejecución existe, pero el agente todavía no declaró sus operaciones.</p></div>
                ) : <ActivityLedger activity={detail.activity} nodes={detail.nodes} onSelect={(id) => { setSelectedId(id); setView("map"); }}/>} 
              </section>
              <Inspector node={selectedNode} nodes={detail.nodes} activity={detail.activity}/>
            </main>
          )}
        </div>
      </div>
    </div>
  );
}

function TopBar({ connectionState, project, run, progress = 0 }: { connectionState: ConnectionState; project?: Project; run?: RunSummary; progress?: number }) {
  const connectionCopy = connectionState === "connected" ? "En vivo" : connectionState === "offline" ? "Sin conexión" : "Conectando";
  return (
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><i/><i/><i/></span><div><strong>Human Review Protocol</strong><span>Mapa observable de cambios</span></div></div>
      <div className="run-telemetry">
        {run && <div className="progress-track" role="progressbar" aria-label="Progreso de la ejecución" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }}/></div>}
        <div className="telemetry-copy"><strong>{run ? statusCopy[run.status] : "Sin ejecución"}</strong><span>{project?.workspaceRoot ?? "Ningún proyecto conectado"}</span></div>
      </div>
      <span className={`connection ${connectionState}`}><i/>{connectionCopy}{connectionState === "offline" && <button type="button" onClick={() => location.reload()}>Reintentar</button>}</span>
    </header>
  );
}
