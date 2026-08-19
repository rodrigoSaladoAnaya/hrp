import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type ReactFlowInstance,
} from "@xyflow/react";
import type { Activity, ChangeNode, NodeStatus, OllamaSettingsView, Project, RunDetail, RunSummary } from "../shared/protocol";

type ProjectWithRuns = Project & { runs: RunSummary[] };
type Catalog = { projects: ProjectWithRuns[] };
type ConnectionState = "connecting" | "connected" | "offline";
type MapNodeData = {
  change: ChangeNode;
  isSelected: boolean;
  baseAgent?: string;
  seenAgents: string[];
  ollamaConfigured: boolean;
  onSelect: (id: string) => void;
  onAssign: (id: string, assignee: string | null) => void;
};

const supportedAgents = ["claude", "codex", "antigravity", "ollama"] as const;

function formatTokens(tokens: number): string {
  return `~${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tokens`;
}

function agentMissing(change: ChangeNode, baseAgent: string | undefined, seenAgents: string[], ollamaConfigured = false): boolean {
  // ollama no abre sesión propia: el modelo base delega vía el servicio, así
  // que basta con que exista una API key configurada para considerarlo listo.
  if (change.assignee === "ollama" && ollamaConfigured) return false;
  return Boolean(change.assignee
    && change.status !== "completed" && change.status !== "running"
    && change.assignee !== baseAgent
    && !seenAgents.includes(change.assignee));
}

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

function Icon({ name }: { name: "route" | "activity" | "folder" | "check" | "clock" | "warning" | "code" | "sliders" }) {
  const paths = {
    sliders: <><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/></>,
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
  const missing = agentMissing(change, data.baseAgent, data.seenAgents, data.ollamaConfigured);
  return (
    <div
      role="button"
      tabIndex={0}
      className={`change-node nodrag nopan change-node-${change.status} ${data.isSelected ? "is-selected" : ""}`}
      aria-label={`${change.file}, ${change.symbol}, ${statusCopy[change.status]}`}
      aria-pressed={data.isSelected}
      onClick={() => data.onSelect(change.id)}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); data.onSelect(change.id); } }}
    >
      <Handle type="target" position={Position.Left} className="route-handle" />
      <div className="node-route-head">
        <span className="node-file">{change.file}</span>
        {change.discovered && <span className="discovered-label">Descubierto</span>}
        {!change.approved && <span className="approval-label">Por aprobar</span>}
        {change.suggestedAgent && change.status !== "completed" && (
          <span className="suggested-label" title={`El modelo base sugiere que esta operación la implemente ${change.suggestedAgent}`}>sugiere {change.suggestedAgent}</span>
        )}
      </div>
      <strong className="node-symbol">{change.symbol}</strong>
      <p>{change.title}</p>
      <div className="node-status-row">
        {change.status === "pending" || change.status === "failed" ? (
          <select
            className="node-agent-select nodrag"
            value={change.assignee ?? ""}
            aria-label="Modelo que implementará esta operación"
            title={missing ? `${change.assignee} no se ha presentado en esta ejecución; considera devolverla al modelo base` : "Modelo que implementará esta operación"}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onChange={(event) => { event.stopPropagation(); data.onAssign(change.id, event.target.value || null); }}
          >
            <option value="">{data.baseAgent ? `base · ${data.baseAgent}` : "modelo base"}</option>
            {supportedAgents.map((agent) => <option key={agent} value={agent}>{agent}</option>)}
          </select>
        ) : (change.executedBy ?? change.assignee ?? data.baseAgent) && (
          <span className="node-assignee" title={`${change.status === "completed" ? "Implementado" : "En ejecución"} por ${change.executedBy ?? change.assignee ?? data.baseAgent}`}>{change.executedBy ?? change.assignee ?? data.baseAgent}</span>
        )}
        {change.tokens != null && <span className="node-tokens" title={`Consumo reportado por el agente: ${change.tokens} tokens`}>{formatTokens(change.tokens)}</span>}
        {missing && <span className="node-agent-warning" title={`${change.assignee} no se ha presentado en esta ejecución`}><Icon name="warning"/>sin señal</span>}
        <StatusSignal status={change.status}/>
      </div>
      {change.verification && <code className={`node-verify node-verify-${change.verification.passed ? "passed" : "failed"}`} title={change.verification.command}>{change.verification.command}</code>}
      <Handle type="source" position={Position.Right} className="route-handle" />
    </div>
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

function layoutGraph(changes: ChangeNode[], selectedId: string | undefined, run: RunSummary | undefined, ollamaConfigured: boolean, onSelect: (id: string) => void, onAssign: (id: string, assignee: string | null) => void): { nodes: Node<MapNodeData>[]; edges: Edge[] } {
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
      data: { change, isSelected: change.id === selectedId, baseAgent: run?.baseAgent, seenAgents: run?.seenAgents ?? [], ollamaConfigured, onSelect, onAssign },
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

function Inspector({ node, nodes, activity, runId, baseAgent, seenAgents, ollamaConfigured, onChanged }: { node?: ChangeNode; nodes: ChangeNode[]; activity: Activity[]; runId: string; baseAgent?: string; seenAgents: string[]; ollamaConfigured: boolean; onChanged: () => void }) {
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
  const post = (path: string, body: unknown) => {
    fetch(`/api/runs/${runId}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(() => onChanged())
      .catch(() => undefined);
  };
  return (
    <aside className="inspector" aria-live="polite">
      <header className="inspector-head">
        <div>
          <span className="inspector-file">{node.file}</span>
          <h2>{node.symbol}</h2>
        </div>
        <div className="inspector-signals">
          <StatusSignal status={node.status}/>
          {(node.status === "running" || node.status === "completed") && (node.executedBy ?? node.assignee ?? baseAgent) && (
            <span className="inspector-executor">{node.status === "completed" ? "por" : "ejecuta"} {node.executedBy ?? node.assignee ?? baseAgent}</span>
          )}
          {node.tokens != null && <span className="inspector-executor" title={`Consumo reportado por el agente: ${node.tokens} tokens`}>{formatTokens(node.tokens)}</span>}
        </div>
      </header>

      {(node.status === "pending" || node.status === "failed") && (
        <section className="human-controls">
          {!node.approved && (
            <button type="button" className="approve-button" onClick={() => post("/approve", { nodeIds: [node.id] })}><Icon name="check"/>Aprobar esta operación</button>
          )}
          {node.suggestedAgent && (
            <p className="suggested-note">El modelo base sugiere delegar esta operación a <strong>{node.suggestedAgent}</strong>; tú decides con el selector.</p>
          )}
          <div className="assign-row">
            <select
              value={node.assignee ?? ""}
              aria-label="Modelo que implementará esta operación"
              onChange={(event) => post(`/nodes/${node.id}/assign`, { assignee: event.target.value || null })}
            >
              <option value="">{baseAgent ? `modelo base · ${baseAgent}` : "modelo base"}</option>
              {supportedAgents.map((agent) => <option key={agent} value={agent}>{agent}</option>)}
            </select>
            {agentMissing(node, baseAgent, seenAgents, ollamaConfigured) && baseAgent && (
              <button type="button" onClick={() => post(`/nodes/${node.id}/assign`, { assignee: baseAgent })}>Devolver a {baseAgent}</button>
            )}
          </div>
          {agentMissing(node, baseAgent, seenAgents, ollamaConfigured) && (
            <p className="assign-warning"><Icon name="warning"/>{node.assignee} no se ha presentado en esta ejecución; puedes devolver la operación al modelo base.</p>
          )}
        </section>
      )}

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

      <section className="change-history planned-history">
        <div className="history-heading"><h3>Qué hará</h3><span>Plan original</span></div>
        <p className="history-summary">{node.description}</p>
        <div className="history-rationale"><strong>Por qué se planeó</strong><p>{node.rationale}</p></div>
      </section>

      {node.patchSummary && (
        <section className="change-history result-history">
          <div className="history-heading"><h3>Qué hizo</h3><span>Resultado observado</span></div>
          <p className="history-summary">{node.patchSummary}</p>
          <div className="history-rationale">
            <strong>Por qué se hizo así</strong>
            {node.patchRationale
              ? <p>{node.patchRationale}</p>
              : <p className="history-missing">El agente no publicó un porqué adicional para este resultado; el motivo original permanece en el plan.</p>}
          </div>
        </section>
      )}

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

function AgentDock({ run, nodes, workspaceRoot, ollama }: { run: RunSummary; nodes: ChangeNode[]; workspaceRoot?: string; ollama?: OllamaSettingsView }) {
  const [copyFeedback, setCopyFeedback] = useState<{ agent: string; result: "copied" | "failed" }>();
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (feedbackTimer.current) clearTimeout(feedbackTimer.current); }, []);
  if (!nodes.length) return null;
  const commandFor = (agent: string) => agent === "ollama"
    // ollama no abre su propia sesión: la instrucción va a la sesión del modelo
    // base, que administra la delegación y revisa el resultado antes de publicar.
    ? `Como modelo base de la ejecución HRP ${run.id}${workspaceRoot ? ` (workspace: ${workspaceRoot})` : ""}, trabaja los nodos asignados a "ollama" delegando la implementación: inicia cada nodo con hrp node start --agent ollama, genera el cambio con hrp ollama run --prompt-file <prompt con el contexto del nodo>, revisa y corrige el resultado como administrador, aplica el cambio, y publica su diff y su verificación antes de completarlo.`
    : `Trabaja los nodos asignados a "${agent}"${agent === run.baseAgent ? " o sin asignar" : ""} de la ejecución HRP ${run.id}${workspaceRoot ? ` (workspace: ${workspaceRoot})` : ""} siguiendo docs/agent-adapter.md: consulta el estado con hrp state ${run.id} --json, inicia cada nodo con --agent ${agent}, y publica su diff y su verificación antes de completarlo.`;
  const copyCommand = async (agent: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(commandFor(agent));
      setCopyFeedback({ agent, result: "copied" });
    } catch {
      setCopyFeedback({ agent, result: "failed" });
    }
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setCopyFeedback(undefined), 2000);
  };
  return (
    <section className="agent-dock" aria-label="Agentes de la ejecución">
      {supportedAgents.map((agent) => {
        const isBase = agent === run.baseAgent;
        const isOllama = agent === "ollama";
        const present = isBase || run.seenAgents.includes(agent) || (isOllama && Boolean(ollama?.configured));
        const count = nodes.filter((node) => node.status !== "completed" && (node.assignee === agent || (isBase && !node.assignee))).length;
        const presenceLabel = isBase ? "Modelo base"
          : isOllama ? (ollama?.configured ? `Ollama Cloud · ${ollama.model}` : "Sin API key configurada")
            : present ? "Presente" : "Sin señal";
        const buttonLabel = copyFeedback?.agent === agent
          ? copyFeedback.result === "copied" ? "Copiado" : "No se pudo copiar"
          : "Copiar";
        return (
          <div className="agent-dock-row" key={agent}>
            <span className={`agent-presence-dot agent-presence-${present ? "present" : "absent"}`} role="img" aria-label={presenceLabel} title={presenceLabel}/>
            <span className="agent-dock-name" title={agent}>{agent}</span>
            <span className="agent-dock-count" aria-label={`${count} ${count === 1 ? "nodo asignado" : "nodos asignados"}`}>{count}</span>
            <button
              type="button"
              aria-label={`Copiar instrucciones para ${agent}; ${count} ${count === 1 ? "nodo asignado" : "nodos asignados"}`}
              aria-live="polite"
              onClick={() => { copyCommand(agent).catch(() => undefined); }}
            >{buttonLabel}</button>
          </div>
        );
      })}
    </section>
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

function ProjectTree({ projects, projectId, runId, agentDock, onProject, onRun, onDeleteProject, onDeleteRun }: {
  projects: ProjectWithRuns[];
  projectId: string;
  runId: string;
  agentDock?: ReactNode;
  onProject: (project: ProjectWithRuns) => void;
  onRun: (projectId: string, runId: string) => void;
  onDeleteProject: (project: ProjectWithRuns) => void;
  onDeleteRun: (run: RunSummary) => void;
}) {
  const orderedProjects = sortProjects(projects);
  const formatter = new Intl.DateTimeFormat("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  // Sin override del usuario, solo el proyecto activo se muestra expandido:
  // la lista crece con cada ejecución y debe seguir siendo navegable.
  const [collapseOverrides, setCollapseOverrides] = useState<Record<string, boolean>>({});
  const isCollapsed = (id: string) => collapseOverrides[id] ?? (id !== projectId);
  const toggleCollapse = (id: string) => setCollapseOverrides((previous) => ({ ...previous, [id]: !isCollapsed(id) }));
  const selectProject = (project: ProjectWithRuns) => {
    setCollapseOverrides((previous) => { const next = { ...previous }; delete next[project.id]; return next; });
    onProject(project);
  };
  return (
    <aside className="project-tree" aria-label={agentDock ? "Proyectos, ejecuciones y agentes" : "Proyectos y ejecuciones"}>
      <header className="tree-head">
        <div><Icon name="folder"/><h2>Proyectos</h2></div>
        <span>{projects.length}</span>
      </header>
      <div className="tree-scroll">
        {orderedProjects.map((project) => {
          const runs = sortRuns(project.runs);
          const selected = project.id === projectId;
          const collapsed = isCollapsed(project.id);
          return (
            <section className={`tree-project ${selected ? "is-current" : ""}`} key={project.id}>
              <div className="tree-project-row">
                <button type="button" className="tree-collapse" aria-expanded={!collapsed} aria-label={`${collapsed ? "Expandir" : "Colapsar"} ${project.name}`} onClick={() => toggleCollapse(project.id)}>{collapsed ? "▸" : "▾"}</button>
                <button type="button" className="tree-project-button" aria-current={selected ? "true" : undefined} onClick={() => selectProject(project)}>
                  <span className="tree-branch"><Icon name="folder"/></span>
                  <span><strong>{project.name}</strong><small title={project.workspaceRoot}>{project.workspaceRoot}</small></span>
                </button>
                {collapsed && runs.length > 0 && <span className="tree-run-count" aria-label={`${runs.length} ejecuciones`}>{runs.length}</span>}
                <button type="button" className="tree-delete" aria-label={`Eliminar el proyecto ${project.name}`} title="Eliminar proyecto" onClick={() => onDeleteProject(project)}>×</button>
              </div>
              {collapsed ? null : runs.length ? (
                <ul>
                  {runs.map((run) => (
                    <li className="tree-run-row" key={run.id}>
                      <button type="button" className={`tree-run status-${run.status} ${run.id === runId ? "is-current" : ""}`} aria-current={run.id === runId ? "page" : undefined} onClick={() => onRun(project.id, run.id)}>
                        <span className="tree-signal"/>
                        <span className="tree-run-copy"><strong>{run.title}</strong><small>{statusCopy[run.status]} · {run.completedCount}/{run.nodeCount} · {formatter.format(new Date(run.updatedAt))}</small></span>
                      </button>
                      <button type="button" className="tree-delete" aria-label={`Eliminar la ejecución ${run.title}`} title="Eliminar ejecución" onClick={() => onDeleteRun(run)}>×</button>
                    </li>
                  ))}
                </ul>
              ) : <p className="tree-empty">Sin ejecuciones</p>}
            </section>
          );
        })}
      </div>
      {agentDock}
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
  const [ollama, setOllama] = useState<OllamaSettingsView>();
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [loadingRun, setLoadingRun] = useState(false);
  const [error, setError] = useState<string>();
  const observedStatuses = useRef(new Map<string, NodeStatus>());
  const loadedRunId = useRef("");
  const flowInstance = useRef<ReactFlowInstance<Node<MapNodeData>, Edge> | null>(null);

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
    if (!id) { loadedRunId.current = ""; setDetail(undefined); setLoadingRun(false); return; }
    // Solo el cambio de ejecución muestra la pantalla de carga; los refrescos
    // del run visible (SSE) actualizan en sitio para no desmontar el mapa.
    const switching = loadedRunId.current !== id;
    if (switching) setLoadingRun(true);
    try {
      const response = await fetch(`/api/runs/${id}`);
      if (!response.ok) throw new Error("No se pudo cargar la ejecución");
      const next = await response.json() as RunDetail;
      const newlyFailed = next.nodes.find((node) => node.status === "failed" && observedStatuses.current.get(`${next.run.id}:${node.id}`) !== "failed");
      for (const node of next.nodes) observedStatuses.current.set(`${next.run.id}:${node.id}`, node.status);
      loadedRunId.current = id;
      setDetail(next);
      setSelectedId((current) => newlyFailed?.id
        ?? (!switching && current === "" ? ""
          : current && next.nodes.some((node) => node.id === current) ? current : next.nodes.find((node) => node.status === "running")?.id ?? next.nodes[0]?.id));
    } finally {
      setLoadingRun(false);
    }
  }, []);

  const loadOllama = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/ollama");
      if (response.ok) setOllama(await response.json() as OllamaSettingsView);
    } catch { /* la configuración es opcional; el panel sigue funcionando sin ella */ }
  }, []);

  useEffect(() => { loadCatalog().catch((cause) => setError(String(cause))); }, [loadCatalog]);
  useEffect(() => { loadOllama().catch(() => undefined); }, [loadOllama]);

  const project = catalog.projects.find((candidate) => candidate.id === projectId);
  useEffect(() => {
    if (!project) { setRunId(""); return; }
    setRunId((current) => current && project.runs.some((run) => run.id === current) ? current : project.runs[0]?.id ?? "");
  }, [project]);

  useEffect(() => { loadDetail(runId).catch((cause) => setError(String(cause))); }, [runId, loadDetail]);

  useEffect(() => {
    setConnectionState("connecting");
    const source = new EventSource("/api/events");
    source.onopen = () => setConnectionState("connected");
    source.addEventListener("ready", () => setConnectionState("connected"));
    source.addEventListener("change", (event) => {
      const change = JSON.parse((event as MessageEvent).data) as { runId: string };
      loadCatalog().catch(() => undefined);
      if (runId && change.runId === runId) loadDetail(runId).catch(() => undefined);
    });
    source.onerror = () => setConnectionState("offline");
    return () => source.close();
  }, [runId, loadCatalog, loadDetail]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (projectId) params.set("project", projectId);
    if (runId) params.set("run", runId);
    history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }, [projectId, runId]);

  const assignAgent = useCallback(async (nodeId: string, assignee: string | null) => {
    if (!runId) return;
    await fetch(`/api/runs/${runId}/nodes/${nodeId}/assign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assignee }) });
    await loadDetail(runId);
  }, [runId, loadDetail]);

  const deleteRun = useCallback(async (run: RunSummary) => {
    if (!window.confirm(`¿Eliminar la ejecución "${run.title}" con toda su evidencia? Esta acción es permanente.`)) return;
    await fetch(`/api/runs/${run.id}`, { method: "DELETE" });
    if (run.id === runId) setRunId("");
    await loadCatalog();
  }, [runId, loadCatalog]);

  const deleteProject = useCallback(async (target: ProjectWithRuns) => {
    const runsCopy = target.runs.length === 1 ? "su ejecución" : `sus ${target.runs.length} ejecuciones`;
    if (!window.confirm(`¿Eliminar el proyecto "${target.name}"${target.runs.length ? ` con ${runsCopy}` : ""}? Esta acción es permanente.`)) return;
    await fetch(`/api/projects/${target.id}`, { method: "DELETE" });
    if (target.id === projectId) { setProjectId(""); setRunId(""); }
    await loadCatalog();
  }, [projectId, loadCatalog]);

  const graph = useMemo(() => layoutGraph(detail?.nodes ?? [], selectedId, detail?.run, ollama?.configured ?? false, setSelectedId, (nodeId, assignee) => { assignAgent(nodeId, assignee).catch(() => undefined); }), [detail?.nodes, detail?.run, selectedId, ollama?.configured, assignAgent]);

  // El layout se re-acomoda cuando aparecen o desaparecen nodos (descubiertos,
  // grafo republicado) y el contenido puede quedar fuera del viewport: reencuadra
  // solo cuando cambia el conjunto de ids, no en cada refresco de estado.
  const nodeSetKey = useMemo(() => (detail?.nodes ?? []).map((node) => node.id).sort().join("|"), [detail?.nodes]);
  useEffect(() => {
    if (!nodeSetKey) return;
    // ReactFlow ingiere el layout nuevo de forma asíncrona: un solo fitView puede
    // ejecutarse contra los límites viejos y dejar el grafo fuera de vista.
    // Encuadra en el siguiente frame y reintenta una vez ya asentado el render.
    const fit = () => { flowInstance.current?.fitView({ padding: 0.22, maxZoom: 1, duration: 320 }); };
    let frame2 = 0;
    const frame1 = requestAnimationFrame(() => { frame2 = requestAnimationFrame(fit); });
    const settle = setTimeout(fit, 400);
    return () => { cancelAnimationFrame(frame1); cancelAnimationFrame(frame2); clearTimeout(settle); };
  }, [nodeSetKey]);
  const selectedNode = detail?.nodes.find((node) => node.id === selectedId);
  const progress = detail?.run.nodeCount ? Math.round((detail.run.completedCount / detail.run.nodeCount) * 100) : 0;
  const publishedActivity = detail?.activity.filter((entry) => entry.type !== "run").length ?? 0;
  const unapprovedCount = detail?.nodes.filter((node) => !node.approved).length ?? 0;

  const approveAll = useCallback(async () => {
    if (!runId) return;
    await fetch(`/api/runs/${runId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await loadDetail(runId);
  }, [runId, loadDetail]);

  if (error) return <div className="fatal-error"><Icon name="warning"/><h1>HRP no pudo iniciar</h1><p>{error}</p><button onClick={() => location.reload()}>Volver a intentar</button></div>;
  if (loadingCatalog) return <><TopBar connectionState={connectionState} ollama={ollama} onOllamaSaved={() => { loadOllama().catch(() => undefined); }}/><LoadingState label="Cargando proyectos"/></>;
  if (!catalog.projects.length) return <><TopBar connectionState={connectionState} ollama={ollama} onOllamaSaved={() => { loadOllama().catch(() => undefined); }}/><EmptyState kind="projects"/></>;

  return (
    <div className="app-shell">
      <TopBar connectionState={connectionState} project={project} run={detail?.run} progress={progress} ollama={ollama} onOllamaSaved={() => { loadOllama().catch(() => undefined); }}/>
      <div className="app-body">
        <ProjectTree
          projects={catalog.projects}
          projectId={projectId}
          runId={runId}
          agentDock={!loadingRun && detail?.run.id === runId ? <AgentDock run={detail.run} nodes={detail.nodes} workspaceRoot={project?.workspaceRoot} ollama={ollama}/> : undefined}
          onProject={(nextProject) => { setProjectId(nextProject.id); setRunId(sortRuns(nextProject.runs)[0]?.id ?? ""); }}
          onRun={(nextProjectId, nextRunId) => { setProjectId(nextProjectId); setRunId(nextRunId); }}
          onDeleteProject={(target) => { deleteProject(target).catch(() => undefined); }}
          onDeleteRun={(target) => { deleteRun(target).catch(() => undefined); }}
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
                {unapprovedCount > 0 && (
                  <div className="approval-banner" role="status">
                    <Icon name="warning"/>
                    <p>{unapprovedCount === 1 ? "1 operación espera tu aprobación." : `${unapprovedCount} operaciones esperan tu aprobación.`} El agente no puede iniciarlas hasta tu visto bueno.</p>
                    <button type="button" onClick={() => { approveAll().catch(() => undefined); }}>Aprobar grafo</button>
                  </div>
                )}
                {view === "map" ? (
                  detail.nodes.length ? <div className="flow-wrap"><ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false} onInit={(instance) => { flowInstance.current = instance; }} onNodeClick={(_event, node) => setSelectedId(node.id)} onPaneClick={() => setSelectedId("")} ariaLabelConfig={graphAriaLabels} fitView fitViewOptions={{ padding: 0.22, maxZoom: 1 }} minZoom={0.25} maxZoom={1.8} proOptions={{ hideAttribution: true }}><Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#aab5af"/><Controls showInteractive={false} aria-label="Controles del mapa"/></ReactFlow></div>
                    : <div className="map-empty"><Icon name="route"/><h2>El mapa aún no ha sido publicado</h2><p>La ejecución existe, pero el agente todavía no declaró sus operaciones.</p>{publishedActivity > 0 && <button type="button" className="map-empty-cta" onClick={() => setView("activity")}><Icon name="activity"/>{publishedActivity === 1 ? "Ver 1 evento publicado en Actividad" : `Ver ${publishedActivity} eventos publicados en Actividad`}</button>}</div>
                ) : <ActivityLedger activity={detail.activity} nodes={detail.nodes} onSelect={(id) => { setSelectedId(id); setView("map"); }}/>} 
              </section>
              <Inspector node={selectedNode} nodes={detail.nodes} activity={detail.activity} runId={detail.run.id} baseAgent={detail.run.baseAgent} seenAgents={detail.run.seenAgents} ollamaConfigured={ollama?.configured ?? false} onChanged={() => { loadDetail(detail.run.id).catch(() => undefined); }}/>
            </main>
          )}
        </div>
      </div>
    </div>
  );
}

function OllamaSettingsPanel({ ollama, onSaved }: { ollama?: OllamaSettingsView; onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; text: string }>();
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  // Al abrir, el formulario parte de lo guardado; la key nunca se rehidrata:
  // el campo vacío significa "conservar la actual".
  useEffect(() => {
    if (!open) return;
    setApiKey("");
    setModel(ollama?.model ?? "");
    setBaseUrl(ollama?.baseUrl ?? "");
    setFeedback(undefined);
  }, [open, ollama]);
  const submit = async (body: Record<string, string | null>, confirmation: string) => {
    setSaving(true);
    setFeedback(undefined);
    try {
      const response = await fetch("/api/settings/ollama", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "No se pudo guardar la configuración");
      setApiKey("");
      setFeedback({ kind: "ok", text: confirmation });
      onSaved?.();
    } catch (cause) {
      setFeedback({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSaving(false);
    }
  };
  const save = () => {
    const body: Record<string, string> = {};
    if (apiKey.trim()) body.apiKey = apiKey.trim();
    if (model.trim()) body.model = model.trim();
    if (baseUrl.trim()) body.baseUrl = baseUrl.trim();
    if (!Object.keys(body).length) { setFeedback({ kind: "error", text: "No hay cambios que guardar." }); return; }
    submit(body, "Configuración guardada.").catch(() => undefined);
  };
  return (
    <div className="settings-wrap">
      <button type="button" className="settings-toggle" aria-expanded={open} aria-label="Configurar Ollama Cloud" title="Configurar Ollama Cloud" onClick={() => setOpen((value) => !value)}>
        <Icon name="sliders"/>
        <span className={`settings-state settings-state-${ollama?.configured ? "on" : "off"}`} aria-hidden="true"/>
      </button>
      {open && (
        <>
          <div className="settings-backdrop" onClick={() => setOpen(false)}/>
          <section className="settings-panel" role="dialog" aria-label="Configuración de Ollama Cloud">
            <h3>Ollama Cloud</h3>
            <p className="settings-status">
              {ollama?.configured
                ? <>API key guardada ({ollama.keyMask}) · modelo <strong>{ollama.model}</strong></>
                : "Sin API key: los nodos delegados a ollama no podrán ejecutarse."}
            </p>
            <label className="settings-field">
              <span>API key</span>
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder={ollama?.configured ? "Deja vacío para conservar la actual" : "Pega aquí tu API key de ollama.com"}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
            <label className="settings-field">
              <span>Modelo</span>
              <input type="text" value={model} placeholder="kimi-k2.7-code" onChange={(event) => setModel(event.target.value)}/>
            </label>
            <label className="settings-field">
              <span>URL base</span>
              <input type="text" value={baseUrl} placeholder="https://ollama.com" onChange={(event) => setBaseUrl(event.target.value)}/>
            </label>
            {feedback && <p className={`settings-feedback settings-feedback-${feedback.kind}`} role="status">{feedback.text}</p>}
            <div className="settings-actions">
              <button type="button" className="settings-save" disabled={saving} onClick={save}>{saving ? "Guardando…" : "Guardar"}</button>
              {ollama?.configured && (
                <button type="button" className="settings-clear" disabled={saving} onClick={() => { submit({ apiKey: null }, "API key eliminada.").catch(() => undefined); }}>Borrar key</button>
              )}
            </div>
            <p className="settings-hint">La key se guarda en el servicio local de HRP y nunca vuelve al navegador; el modelo puede cambiarse sin reingresarla.</p>
          </section>
        </>
      )}
    </div>
  );
}

function HelpPanel() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div className="help-wrap">
      <button type="button" className="help-toggle" aria-expanded={open} aria-label="Ayuda" title="Ayuda" onClick={() => setOpen((value) => !value)}>?</button>
      {open && (
        <>
          <div className="help-backdrop" onClick={() => setOpen(false)}/>
          <section className="help-panel" role="dialog" aria-label="Ayuda de HRP">
            <h3>Delegar trabajo a otro modelo</h3>
            <ol>
              <li>Aprueba el grafo cuando el agente lo publique (botón «Aprobar grafo»).</li>
              <li>En la cajita del nodo elige quién lo implementa: claude, codex o antigravity.</li>
              <li>En el dock de agentes (abajo a la izquierda) pulsa «Copiar» junto a ese modelo.</li>
              <li>Pega el comando en la sesión de ese modelo. Su punto se pone verde al engancharse y trabajará solo sus nodos.</li>
            </ol>
            <h3>¿Un agente actúa «a la antigua»?</h3>
            <p>Las sesiones abiertas conservan la skill con la que arrancaron. Si un agente no continúa solo tras tu aprobación, no declara identidad o queda naranja mientras trabaja, escríbele: <em>«vuelve a leer la skill de hrp antes de continuar»</em>. Las conversaciones nuevas siempre nacen con la skill al día; <code>./scripts/update.sh</code> actualiza HRP y las skills de los tres modelos.</p>
            <h3>Tips</h3>
            <ul>
              <li>Nada se ejecuta sin tu aprobación; los nodos descubiertos también pasan por el gate.</li>
              <li>Solo hay un nodo en curso por ejecución: los agentes se turnan solos.</li>
              <li>Naranja prolongado con trabajo aprobado = ese modelo no se enteró; reenvíale el comando o usa «Devolver a claude» en el inspector.</li>
              <li>Un nodo en curso no puede cambiar de modelo; al terminar, su tarjeta muestra quién lo hizo y su costo (~tokens) si el agente lo reportó.</li>
              <li>Clic fuera del grafo deselecciona; el chevron colapsa proyectos y la × elimina con confirmación.</li>
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function TopBar({ connectionState, project, run, progress = 0, ollama, onOllamaSaved }: { connectionState: ConnectionState; project?: Project; run?: RunSummary; progress?: number; ollama?: OllamaSettingsView; onOllamaSaved?: () => void }) {
  const connectionCopy = connectionState === "connected" ? "En vivo" : connectionState === "offline" ? "Sin conexión" : "Conectando";
  return (
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><i/><i/><i/></span><div><strong>Human Review Protocol</strong><span>Mapa observable de cambios</span></div></div>
      <div className="run-telemetry">
        {run && <div className="progress-track" role="progressbar" aria-label="Progreso de la ejecución" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }}/></div>}
        <div className="telemetry-copy"><strong>{run ? statusCopy[run.status] : "Sin ejecución"}</strong><span>{project?.workspaceRoot ?? "Ningún proyecto conectado"}</span></div>
      </div>
      {/* Una sola celda del grid: la barra conserva sus 4 hijos originales. */}
      <div className="topbar-tools">
        <OllamaSettingsPanel ollama={ollama} onSaved={onOllamaSaved}/>
        <HelpPanel/>
      </div>
      <span className={`connection ${connectionState}`}><i/>{connectionCopy}{connectionState === "offline" && <button type="button" onClick={() => location.reload()}>Reintentar</button>}</span>
    </header>
  );
}
