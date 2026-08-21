import { type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type Viewport,
} from "@xyflow/react";
import type { Activity, AgentWorkState, ChangeNode, Finding, NodeStatus, OllamaSettingsView, Project, RunDetail, RunSummary } from "../shared/protocol";
import { agentAttentionCommand } from "./agent-attention";
import { collectCatalogRunIds, resolveCatalogChange, resolveCatalogRunFocus, type CatalogChange, type CatalogRunFocus } from "./catalog-focus";
import { decideGraphViewportAction, isGraphFlowMounted, shouldPersistGraphViewport, type GraphView, type StoredGraphViewport } from "./graph-viewport";

type ProjectWithRuns = Project & { runs: RunSummary[] };
type Catalog = { projects: ProjectWithRuns[] };
type Health = { buildStale?: boolean };
type ConnectionState = "connecting" | "connected" | "offline";
type CatalogLoadOptions = { focus?: CatalogRunFocus; visibleProjectId?: string };
type GlobalPendingEntry = {
  project: ProjectWithRuns;
  run: RunSummary;
  reasons: string[];
  priority: number;
};
type AttentionSignal = {
  runId: string;
  agent: string;
  kind: string;
  directive: string;
  actionable: boolean;
  waiting: boolean;
  terminal: boolean;
};
type GraphMagnifierState = {
  active: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
};
type GraphPointerState = Omit<GraphMagnifierState, "active"> & {
  inside: boolean;
  clientX: number;
  clientY: number;
};
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
const changeNodeWidthFallback = 272;
const changeNodeLayoutHeightFallback = 196;
const graphMagnifierScale = 1.65;
const graphMagnifierSize = 236;

function readCssPixels(property: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(property));
  return Number.isFinite(value) ? value : fallback;
}

function formatTokens(tokens: number): string {
  return `~${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tokens`;
}

function TokenCostBadge({ tokens, className = "" }: { tokens?: number; className?: string }) {
  const hasReport = tokens != null;
  const label = hasReport ? formatTokens(tokens) : "? tokens";
  return (
    <span
      className={["token-cost-badge", !hasReport && "token-cost-badge-muted", className].filter(Boolean).join(" ")}
      title={hasReport
        ? `Tokens reportados por el agente: ${tokens}`
        : "El agente completó este nodo sin reportar tokens; HRP no inventa estimaciones cuando el entorno no expone consumo real."}
      aria-label={hasReport ? `Tokens reportados: ${label}` : "Tokens no reportados"}
    >
      {label}
    </span>
  );
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

function awaitingApprovals(project: ProjectWithRuns): number {
  return project.runs.reduce((sum, run) => sum + run.awaitingApproval, 0);
}

function globalPendingEntries(projects: ProjectWithRuns[]): GlobalPendingEntry[] {
  return projects.flatMap((project) => project.runs.map((run) => {
    const reasons: string[] = [];
    let priority = 0;
    if (run.openFindings > 0) { reasons.push(`${run.openFindings} ${run.openFindings === 1 ? "hallazgo vivo" : "hallazgos vivos"}`); priority += 80; }
    if (run.awaitingApproval > 0) { reasons.push(`${run.awaitingApproval} ${run.awaitingApproval === 1 ? "aprobación pendiente" : "aprobaciones pendientes"}`); priority += 70; }
    if (run.status === "running") { reasons.push("hay trabajo en curso"); priority += 60; }
    if (run.status === "failed") { reasons.push("hay un nodo fallido"); priority += 55; }
    if (run.status === "pending" && run.nodeCount > 0) { reasons.push(`${run.completedCount}/${run.nodeCount} nodos completados`); priority += 40; }
    const pendingAuditorVotes = run.pendingAuditorVotes ?? run.pendingAuditorCount;
    if (run.status === "completed" && run.control === "active" && pendingAuditorVotes > 0) { reasons.push(`${pendingAuditorVotes} ${pendingAuditorVotes === 1 ? "voto auditor pendiente" : "votos auditores pendientes"}`); priority += 35; }
    if (run.status === "pending" && run.nodeCount === 0) { reasons.push("sin grafo publicado"); priority += 25; }
    if (run.control === "paused") { reasons.push("pausada"); priority += 15; }
    if (run.control === "active" && run.status !== "completed" && !reasons.length) { reasons.push("activa"); priority += 10; }
    if (run.control === "stopped" || !reasons.length) return undefined;
    return { project, run, reasons, priority } satisfies GlobalPendingEntry;
  })).filter((entry): entry is GlobalPendingEntry => Boolean(entry))
    .sort((left, right) => right.priority - left.priority || Date.parse(right.run.updatedAt) - Date.parse(left.run.updatedAt));
}

function sortProjects(projects: ProjectWithRuns[]): ProjectWithRuns[] {
  const projectTime = (project: ProjectWithRuns) => Math.max(
    Date.parse(project.lastOpenedAt),
    ...project.runs.map((run) => Date.parse(run.updatedAt)),
  );
  return [...projects].sort((left, right) => {
    // Una aprobación pendiente significa un agente bloqueado esperando al
    // humano: ese proyecto sube antes que los meramente activos.
    const leftWaiting = awaitingApprovals(left) > 0 ? 1 : 0;
    const rightWaiting = awaitingApprovals(right) > 0 ? 1 : 0;
    const leftActive = left.runs.some((run) => run.status === "running") ? 1 : 0;
    const rightActive = right.runs.some((run) => run.status === "running") ? 1 : 0;
    return rightWaiting - leftWaiting || rightActive - leftActive || projectTime(right) - projectTime(left);
  });
}

function Icon({ name }: { name: "route" | "activity" | "folder" | "check" | "clock" | "warning" | "code" | "sliders" | "copy" }) {
  const paths = {
    sliders: <><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/></>,
    route: <><circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h5a4 4 0 0 1 4 4v4a4 4 0 0 0 3 4"/></>,
    activity: <><path d="M4 17h3l2-10 4 13 3-8 2 5h2"/></>,
    folder: <><path d="M3 7h7l2 2h9v10H3z"/><path d="M3 7V5h7l2 2"/></>,
    check: <><path d="m5 12 4 4L19 6"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    warning: <><path d="M12 3 2.8 20h18.4z"/><path d="M12 9v4M12 17h.01"/></>,
    code: <><path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="1"/><path d="M16 8V5H5v11h3"/></>,
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
        {change.status === "completed" && <TokenCostBadge tokens={change.tokens} className="node-tokens" />}
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
  const nodeWidth = readCssPixels("--change-node-width", changeNodeWidthFallback);
  const nodeHeight = readCssPixels("--change-node-layout-height", changeNodeLayoutHeightFallback);
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", ranksep: 86, nodesep: 46, marginx: 44, marginy: 44 });
  for (const change of changes) graph.setNode(change.id, { width: nodeWidth, height: nodeHeight });
  for (const change of changes) for (const dependency of change.dependencies) graph.setEdge(dependency, change.id);
  dagre.layout(graph);
  const byId = new Map(changes.map((change) => [change.id, change]));
  const nodes = changes.map((change) => {
    const point = graph.node(change.id) as { x: number; y: number };
    return {
      id: change.id,
      type: "change",
      position: { x: point.x - nodeWidth / 2, y: point.y - nodeHeight / 2 },
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

function Inspector({ node, nodes, activity, runId, baseAgent, seenAgents, ollamaConfigured, canApprove, onChanged }: { node?: ChangeNode; nodes: ChangeNode[]; activity: Activity[]; runId: string; baseAgent?: string; seenAgents: string[]; ollamaConfigured: boolean; canApprove: boolean; onChanged: () => void }) {
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
          {node.status === "completed" && <TokenCostBadge tokens={node.tokens} className="inspector-token-cost" />}
        </div>
      </header>

      {(node.status === "pending" || node.status === "failed") && (
        <section className="human-controls">
          {!node.approved && (
            <button type="button" className="approve-button" disabled={!canApprove} title={canApprove ? undefined : "Elige al menos un auditor en la columna izquierda"} onClick={() => post("/approve", { nodeIds: [node.id] })}><Icon name="check"/>{canApprove ? "Aprobar esta operación" : "Elige un auditor para aprobar"}</button>
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
        {node.contextFiles && node.contextFiles.length > 0 && (<div className="history-rationale"><strong>Contexto de referencia (solo lectura)</strong><p>{node.contextFiles.join(", ")}</p></div>)}
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

const agentPhaseCopy: Record<AgentWorkState["phase"], string> = {
  idle: "En espera",
  waiting: "En espera",
  executing: "Implementando",
  reviewing: "Auditando",
  completed: "Terminado",
  failed: "Falló",
};

function elapsedSince(startedAt: string | undefined, tick: number): string | undefined {
  if (!startedAt) return undefined;
  const seconds = Math.max(0, Math.floor((tick - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function AgentDock({ run, nodes, agentStates, workspaceRoot, ollama, onAuditorsChange }: {
  run: RunSummary;
  nodes: ChangeNode[];
  agentStates: AgentWorkState[];
  workspaceRoot?: string;
  ollama?: OllamaSettingsView;
  onAuditorsChange: (auditors: string[]) => Promise<void>;
}) {
  const [copyFeedback, setCopyFeedback] = useState<{ agent: string; result: "copied" | "failed" }>();
  const [expandedAgent, setExpandedAgent] = useState<string>();
  const [selectionBusy, setSelectionBusy] = useState<string>();
  const [selectionError, setSelectionError] = useState<string>();
  const [tick, setTick] = useState(Date.now());
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (feedbackTimer.current) clearTimeout(feedbackTimer.current); }, []);
  const hasActiveAgent = agentStates.some((state) => state.phase === "executing" || state.phase === "reviewing");
  useEffect(() => {
    if (!hasActiveAgent) return undefined;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasActiveAgent]);
  if (!nodes.length) return null;
  const copyCommand = async (agent: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(agentAttentionCommand(agent, workspaceRoot));
      setCopyFeedback({ agent, result: "copied" });
    } catch {
      setCopyFeedback({ agent, result: "failed" });
    }
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setCopyFeedback(undefined), 2000);
  };
  // La selección se congela con el grafo aprobado para que la política de
  // revisión no cambie a mitad, pero la pausa es una decisión deliberada del
  // humano: ahí puede reconfigurar quién audita (p. ej. retirar a un agente
  // que se quedó sin presupuesto y que bloquearía el cierre para siempre).
  const approvalStarted = nodes.some((node) => node.approved);
  const reconfigurable = approvalStarted && run.control === "paused";
  const selectionLocked = approvalStarted && !reconfigurable;
  const toggleAuditor = async (agent: string, selected: boolean) => {
    const next = selected ? [...run.auditors, agent] : run.auditors.filter((candidate) => candidate !== agent);
    setSelectionBusy(agent);
    setSelectionError(undefined);
    try { await onAuditorsChange(next); }
    catch (cause) { setSelectionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSelectionBusy(undefined); }
  };
  const nodeLabel = (id: string) => {
    const node = nodes.find((candidate) => candidate.id === id);
    return node ? `${node.file} · ${node.symbol}` : id;
  };
  return (
    <section className="agent-dock" aria-label="Agentes de la ejecución">
      <header className="agent-dock-head">
        <div><strong>Agentes</strong><span>{selectionLocked ? "Auditores fijados; pausa la ejecución para cambiarlos" : reconfigurable ? "Ejecución pausada: puedes reconfigurar quién audita" : "Elige quién audita antes de aprobar"}</span></div>
        <b>{run.auditors.length} aud.</b>
      </header>
      {selectionError && <p className="agent-dock-error" role="alert">{selectionError}</p>}
      {supportedAgents.map((agent) => {
        const isBase = agent === run.baseAgent;
        const isOllama = agent === "ollama";
        const present = isBase || run.seenAgents.includes(agent) || (isOllama && Boolean(ollama?.configured));
        const count = nodes.filter((node) => node.status !== "completed" && (node.assignee === agent || (isBase && !node.assignee))).length;
        const state = agentStates.find((candidate) => candidate.agent === agent);
        const selectedAuditor = run.auditors.includes(agent);
        const elapsed = state && (state.phase === "executing" || state.phase === "reviewing") ? elapsedSince(state.startedAt, tick) : undefined;
        const presenceLabel = isBase ? "Modelo base"
          : isOllama ? (ollama?.configured ? `Ollama Cloud · ${ollama.model}` : "Sin API key configurada")
            : present ? "Presente" : "Sin señal";
        const copyResult = copyFeedback?.agent === agent ? copyFeedback.result : undefined;
        const buttonLabel = copyResult === "copied"
          ? `Comando copiado para ${agent}`
          : copyResult === "failed"
            ? `No se pudo copiar el comando para ${agent}`
            : `Copiar comando de atención para ${agent}`;
        return (
          <div className={`agent-dock-entry phase-${state?.phase ?? "idle"} ${isBase ? "is-base-agent" : ""}`} key={agent} role="group" aria-label={`${agent}${isBase ? ", modelo base" : ""}${selectedAuditor ? ", auditor" : ""}`}>
            <div className="agent-dock-row">
              <span className={`agent-presence-dot agent-presence-${present ? "present" : "absent"}`} role="img" aria-label={presenceLabel} title={presenceLabel}/>
              <span className="agent-dock-name" title={isBase ? "Modelo base: controla los nodos sin asignar y coordina el cierre de la ejecución" : isOllama && ollama?.configured ? `${agent} · ${ollama.model}` : agent}>
                <span className="agent-name-text">{agent}</span>
                {isOllama && ollama?.configured && <small>{ollama.model}</small>}
              </span>
              <span className="agent-dock-count" aria-label={`${count} ${count === 1 ? "nodo asignado" : "nodos asignados"}`}>{count}</span>
              <button
                type="button"
                className={`agent-copy ${copyResult ? `is-${copyResult}` : ""}`}
                aria-label={buttonLabel}
                aria-live="polite"
                title={buttonLabel}
                onClick={() => { copyCommand(agent).catch(() => undefined); }}
              ><Icon name={copyResult === "copied" ? "check" : copyResult === "failed" ? "warning" : "copy"}/></button>
            </div>
            <div className="agent-dock-subrow">
              <button type="button" className="agent-activity-row" disabled={!state} aria-expanded={expandedAgent === agent} onClick={() => setExpandedAgent((current) => current === agent ? undefined : agent)}>
                <i aria-hidden="true"/>
                <span>{state ? <><strong>{agentPhaseCopy[state.phase]}</strong> · {state.summary}</> : present ? "Conectado; sin actividad reportada" : "Sin actividad reportada"}</span>
                {state && state.total > 0 && <b>{state.completed}/{state.total}</b>}
                {elapsed && <time>{elapsed}</time>}
              </button>
              <label className="auditor-toggle" title={isOllama && !ollama?.configured ? "Configura Ollama Cloud antes de elegirlo" : selectionLocked ? "La selección se bloquea mientras la ejecución corre; pausa la ejecución para cambiarla" : `${selectedAuditor ? "Quitar" : "Usar"} ${agent} como auditor`}>
                <input type="checkbox" aria-label={`Usar ${agent}${isOllama && ollama?.configured ? ` (${ollama.model})` : ""} como auditor`} checked={selectedAuditor} disabled={selectionLocked || Boolean(selectionBusy) || (isOllama && !ollama?.configured)} onChange={(event) => { toggleAuditor(agent, event.target.checked).catch(() => undefined); }}/>
                <span>Audita</span>
              </label>
            </div>
            {expandedAgent === agent && state && (
              <div className="agent-activity-detail" role="region" aria-label={`Actividad de ${agent}`}>
                <div className="agent-activity-summary"><strong>{state.summary}</strong>{state.detail && <p>{state.detail}</p>}</div>
                {state.total > 0 && <div className="agent-review-progress" role="progressbar" aria-label="Cobertura confirmada" aria-valuemin={0} aria-valuemax={state.total} aria-valuenow={state.completed}><span style={{ transform: `scaleX(${state.completed / state.total})` }}/></div>}
                {state.currentNodeId && <p className="agent-current"><span>Ahora</span>{nodeLabel(state.currentNodeId)}</p>}
                <div className="agent-coverage">
                  <section><h4>Qué lleva · {state.reviewedNodeIds.length}</h4>{state.reviewedNodeIds.length ? <ul>{state.reviewedNodeIds.map((id) => <li key={id}>{nodeLabel(id)}</li>)}</ul> : <p>Aún no hay cobertura confirmada.</p>}</section>
                  <section><h4>Qué falta · {state.remainingNodeIds.length}</h4>{state.remainingNodeIds.length ? <ul>{state.remainingNodeIds.map((id) => <li key={id}>{nodeLabel(id)}</li>)}</ul> : <p>{state.total > 0 && state.completed === state.total ? "El paquete quedó cubierto." : "Cobertura todavía no reportada."}</p>}</section>
                </div>
                <small>Actualizado {new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(state.updatedAt))}</small>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function RunControls({ run, onChanged }: { run: RunSummary; onChanged: () => void }) {
  const setControl = async (control: "active" | "paused" | "stopped") => {
    if (control === "stopped" && !window.confirm(`¿Detener la ejecución "${run.title}"? Ningún agente podrá iniciar más nodos hasta que la reanudes.`)) return;
    await fetch(`/api/runs/${run.id}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ control }) });
    onChanged();
  };
  // Una ejecución completa y activa no necesita controles; sí los conserva si
  // quedó pausada/detenida para poder reanudarla.
  if (run.control === "active" && run.nodeCount > 0 && run.completedCount === run.nodeCount) return null;
  return (
    <div className="run-controls" role="group" aria-label="Control de la ejecución">
      {run.control !== "active" && <button type="button" className="control-resume" onClick={() => { setControl("active").catch(() => undefined); }}>Reanudar</button>}
      {run.control === "active" && <button type="button" className="control-pause" title="Ningún agente podrá iniciar nodos nuevos; el nodo en curso termina" onClick={() => { setControl("paused").catch(() => undefined); }}>Pausar</button>}
      {run.control !== "stopped" && <button type="button" className="control-stop" title="Detiene la ejecución para todos los agentes" onClick={() => { setControl("stopped").catch(() => undefined); }}>Detener</button>}
    </div>
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
              <div className="activity-header">
                <strong>{item.message}</strong>
                {item.agent && (
                  <span className={`activity-agent activity-agent-${item.agent === "human" ? "human" : item.agent.startsWith("ollama") ? "ollama" : "model"}`}>
                    {item.agent === "human" ? "humano" : item.agent}
                  </span>
                )}
              </div>
              {node && <button type="button" onClick={() => onSelect(node.id)}>{node.file} · {node.symbol}</button>}
              {item.detail && <p>{item.detail}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const severityCopy: Record<Finding["severity"], string> = { critical: "crítico", major: "mayor", minor: "menor", question: "duda" };
const findingStatusCopy: Record<Finding["status"], string> = { open: "abierto", debating: "en debate", accepted: "aceptado", rejected: "rechazado", escalated: "esperando tu arbitraje" };
const liveFindingStatuses: Finding["status"][] = ["open", "debating", "escalated"];

function openFindingsTotal(project: ProjectWithRuns): number {
  return project.runs.reduce((sum, run) => sum + run.openFindings, 0);
}

function FindingsPanel({ findings, nodes, runId, onChanged, onSelectNode }: {
  findings: Finding[];
  nodes: ChangeNode[];
  runId: string;
  onChanged: () => void;
  onSelectNode: (id: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<string>("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [packFeedback, setPackFeedback] = useState<"copied" | "failed">();
  const copyPack = async () => {
    try {
      const response = await fetch(`/api/runs/${runId}/review-pack?agent=human`);
      if (!response.ok) throw new Error(await response.text());
      await navigator.clipboard.writeText(await response.text());
      setPackFeedback("copied");
    } catch {
      setPackFeedback("failed");
    }
    setTimeout(() => setPackFeedback(undefined), 2500);
  };
  // Un fallo del servidor no puede disfrazarse de éxito: el error se muestra en
  // la tarjeta y el borrador se conserva para reintentar sin reescribir.
  const post = async (findingId: string, endpoint: string, body: unknown): Promise<boolean> => {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
    if (!response?.ok) {
      const detail = response ? (await response.json().catch(() => ({}))) as { error?: string } : {};
      setActionErrors((previous) => ({ ...previous, [findingId]: detail.error ?? "El servidor no respondió; reintenta." }));
      return false;
    }
    setActionErrors((previous) => ({ ...previous, [findingId]: "" }));
    onChanged();
    return true;
  };
  const intervene = async (finding: Finding) => {
    const draft = (drafts[finding.id] ?? "").trim();
    if (!draft) return;
    if (await post(finding.id, `/api/findings/${finding.id}/messages`, { author: "human", body: draft })) {
      setDrafts((previous) => ({ ...previous, [finding.id]: "" }));
    }
  };
  const arbitrate = async (finding: Finding, status: "accepted" | "rejected") => {
    if (status === "rejected") {
      // El rechazo sin razón no es auditable: la razón queda en el hilo antes
      // del cambio de estado, escrita por el humano.
      const reason = (drafts[finding.id] ?? "").trim() || window.prompt("Razón del rechazo (queda en el hilo del debate):")?.trim();
      if (!reason) return;
      if (!await post(finding.id, `/api/findings/${finding.id}/messages`, { author: "human", body: reason })) return;
      setDrafts((previous) => ({ ...previous, [finding.id]: "" }));
      await post(finding.id, `/api/findings/${finding.id}/status`, { status });
      return;
    }
    // Aceptar ata la corrección: el ID puede omitirse solo si la resolución ya
    // quedó documentada en el hilo (el servidor rechaza el accept silencioso).
    const resolution = window.prompt("ID del nodo de corrección que resuelve el hallazgo (déjalo vacío si la resolución quedó documentada en el hilo):")?.trim();
    if (resolution === undefined) return;
    await post(finding.id, `/api/findings/${finding.id}/status`, resolution ? { status, resolutionNodeId: resolution } : { status });
  };
  const reopen = async (finding: Finding) => {
    const reason = (drafts[finding.id] ?? "").trim() || window.prompt("Razón para reabrir el debate (queda en el hilo):")?.trim();
    if (!reason) return;
    if (!await post(finding.id, `/api/findings/${finding.id}/messages`, { author: "human", body: reason })) return;
    setDrafts((previous) => ({ ...previous, [finding.id]: "" }));
    await post(finding.id, `/api/findings/${finding.id}/status`, { status: "open" });
  };
  const copyPackButton = (
    <button type="button" className="pack-copy" title="Copia el paquete markdown con todo el contexto del run (specs, diffs y verificaciones) para pegarlo en la sesión de otro modelo y convertirlo en revisor" onClick={() => { copyPack().catch(() => undefined); }}>
      {packFeedback === "copied" ? "Paquete copiado" : packFeedback === "failed" ? "No se pudo copiar" : "Copiar paquete de revisión"}
    </button>
  );
  if (!findings.length) {
    return (
      <div className="findings-empty">
        <Icon name="check"/>
        <h2>Sin hallazgos todavía</h2>
      </div>
    );
  }
  return (
    <div className="findings-panel">
      <header className="findings-head">
        <p>{findings.filter((finding) => liveFindingStatuses.includes(finding.status)).length} vivos de {findings.length}; el cierre requiere cero hallazgos vivos y mayoría auditora conforme.</p>
        {copyPackButton}
      </header>
      <ol className="findings-list">
        {findings.map((finding) => {
          const node = finding.nodeId ? nodes.find((candidate) => candidate.id === finding.nodeId) : undefined;
          const expanded = expandedId === finding.id;
          const terminal = finding.status === "accepted" || finding.status === "rejected";
          return (
            <li key={finding.id} className={`finding-card status-${finding.status} ${finding.status === "escalated" ? "needs-human" : ""}`}>
              <button type="button" className="finding-summary" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? "" : finding.id)}>
                <span className={`severity-chip severity-${finding.severity}`}>{severityCopy[finding.severity]}</span>
                <strong>{finding.title}</strong>
                <span className="finding-meta">{finding.reviewer} · {findingStatusCopy[finding.status]}</span>
              </button>
              {expanded && (
                <div className="finding-detail">
                  {node && <button type="button" className="finding-node-link" onClick={() => onSelectNode(node.id)}>{node.file} · {node.symbol}</button>}
                  <div className="debate-thread">
                    <div className="debate-message author-reviewer"><span>{finding.reviewer}</span><p>{finding.body}</p></div>
                    {finding.messages.map((message) => (
                      <div key={message.id} className={`debate-message ${message.author === "human" ? "author-human" : message.author === finding.reviewer ? "author-reviewer" : "author-base"}`}>
                        <span>{message.author === "human" ? "tú" : message.author}</span>
                        <p>{message.body}</p>
                      </div>
                    ))}
                  </div>
                  {finding.resolutionNodeId && <p className="finding-resolution">Corrección vinculada: <button type="button" onClick={() => onSelectNode(finding.resolutionNodeId!)}>{finding.resolutionNodeId}</button></p>}
                  <div className="finding-actions">
                    <textarea
                      placeholder={terminal ? "Razón para reabrir el debate…" : finding.status === "escalated" ? "Tu arbitraje: tercia en el debate o escribe la razón del rechazo…" : "Tercia en el debate como humano…"}
                      value={drafts[finding.id] ?? ""}
                      onChange={(event) => setDrafts((previous) => ({ ...previous, [finding.id]: event.target.value }))}
                    />
                    <div className="finding-buttons">
                      {terminal ? (
                        <button type="button" onClick={() => { reopen(finding).catch(() => undefined); }}>Reabrir debate</button>
                      ) : (
                        <>
                        <button type="button" onClick={() => { intervene(finding).catch(() => undefined); }} disabled={!(drafts[finding.id] ?? "").trim()}>Responder</button>
                        <button type="button" className="finding-accept" title="Da la razón al revisor; idealmente el agente base ya vinculó (o descubrirá) un nodo de corrección" onClick={() => { arbitrate(finding, "accepted").catch(() => undefined); }}>Aceptar</button>
                        <button type="button" className="finding-reject" title="Descarta el hallazgo; la razón que escribas queda en el hilo" onClick={() => { arbitrate(finding, "rejected").catch(() => undefined); }}>Rechazar</button>
                        </>
                      )}
                    </div>
                    {actionErrors[finding.id] && <p className="finding-error" role="alert">{actionErrors[finding.id]}</p>}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
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
                {awaitingApprovals(project) > 0 && (
                  <span
                    className="tree-approval-badge"
                    role="status"
                    title={`${awaitingApprovals(project)} ${awaitingApprovals(project) === 1 ? "operación espera" : "operaciones esperan"} tu aprobación`}
                    aria-label={`${awaitingApprovals(project)} ${awaitingApprovals(project) === 1 ? "operación espera" : "operaciones esperan"} tu aprobación`}
                  >{awaitingApprovals(project)}</span>
                )}
                {openFindingsTotal(project) > 0 && (
                  <span
                    className="tree-findings-badge"
                    role="status"
                    title={`${openFindingsTotal(project)} ${openFindingsTotal(project) === 1 ? "hallazgo vivo de la revisión" : "hallazgos vivos de la revisión"}`}
                    aria-label={`${openFindingsTotal(project)} ${openFindingsTotal(project) === 1 ? "hallazgo vivo de la revisión" : "hallazgos vivos de la revisión"}`}
                  >{openFindingsTotal(project)}</span>
                )}
                {collapsed && runs.length > 0 && <span className="tree-run-count" aria-label={`${runs.length} ejecuciones`}>{runs.length}</span>}
                <button type="button" className="tree-delete" aria-label={`Eliminar el proyecto ${project.name}`} title="Eliminar proyecto" onClick={() => onDeleteProject(project)}>×</button>
              </div>
              {collapsed ? null : runs.length ? (
                <ul>
                  {runs.map((run) => (
                    <li className="tree-run-row" key={run.id}>
                      <button type="button" className={`tree-run status-${run.status} ${run.id === runId ? "is-current" : ""}`} aria-current={run.id === runId ? "page" : undefined} onClick={() => onRun(project.id, run.id)}>
                        <span className="tree-signal"/>
                        <span className="tree-run-copy">
                          <strong>{run.title}{run.awaitingApproval > 0 && <span className="tree-run-approval" title={`${run.awaitingApproval} ${run.awaitingApproval === 1 ? "operación espera" : "operaciones esperan"} tu aprobación`}>Por aprobar</span>}{run.openFindings > 0 && <span className="tree-run-findings" title={`${run.openFindings} ${run.openFindings === 1 ? "hallazgo vivo" : "hallazgos vivos"} de la revisión multi-modelo`}>En debate</span>}</strong>
                          <small>{statusCopy[run.status]} · {run.completedCount}/{run.nodeCount} · {formatter.format(new Date(run.updatedAt))}</small>
                        </span>
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
  const [view, setView] = useState<GraphView>("map");
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [buildStale, setBuildStale] = useState(false);
  const [ollama, setOllama] = useState<OllamaSettingsView>();
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [loadingRun, setLoadingRun] = useState(false);
  const [error, setError] = useState<string>();
  const [approveError, setApproveError] = useState<string>();
  const observedStatuses = useRef(new Map<string, NodeStatus>());
  const knownRunIds = useRef<Set<string> | undefined>(undefined);
  const loadedRunId = useRef("");
  const currentProjectId = useRef(projectId);
  const currentRunId = useRef(runId);
  const flowInstance = useRef<ReactFlowInstance<Node<MapNodeData>, Edge> | null>(null);
  const flowWrapRef = useRef<HTMLDivElement | null>(null);
  const graphViewports = useRef(new Map<string, StoredGraphViewport>());
  const appliedGraphViewportKey = useRef("");
  const pendingGraphFitCancel = useRef<(() => void) | undefined>(undefined);
  const graphViewportUserMoved = useRef(false);
  const graphViewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 });
  const graphMagnifierRect = useRef<DOMRect | undefined>(undefined);
  const graphPointer = useRef<GraphPointerState>({ inside: false, clientX: 0, clientY: 0, x: 0, y: 0, width: 0, height: 0 });
  const graphMagnifierActive = useRef(false);
  const [graphViewport, setGraphViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [graphMagnifier, setGraphMagnifier] = useState<GraphMagnifierState>({ active: false, x: 0, y: 0, width: 0, height: 0 });
  const cancelPendingGraphFit = useCallback(() => {
    pendingGraphFitCancel.current?.();
    pendingGraphFitCancel.current = undefined;
  }, []);
  const setGraphMagnifierSnapshot = useCallback((next: GraphMagnifierState) => {
    graphMagnifierActive.current = next.active;
    setGraphMagnifier((current) => (
      current.active === next.active
      && current.x === next.x
      && current.y === next.y
      && current.width === next.width
      && current.height === next.height
    ) ? current : next);
  }, []);
  const hideGraphMagnifier = useCallback(() => {
    if (!graphMagnifierActive.current) return;
    setGraphMagnifierSnapshot({ ...graphPointer.current, active: false });
  }, [setGraphMagnifierSnapshot]);
  const updateGraphViewport = useCallback((viewport: Viewport) => {
    graphViewportRef.current = viewport;
    if (graphMagnifierActive.current) setGraphViewport(viewport);
  }, []);
  const resetGraphPointer = useCallback(() => {
    graphMagnifierRect.current = undefined;
    graphPointer.current = { inside: false, clientX: 0, clientY: 0, x: 0, y: 0, width: 0, height: 0 };
  }, []);
  const readGraphPointer = useCallback((target: HTMLDivElement, clientX: number, clientY: number): GraphPointerState => {
    const rect = graphMagnifierRect.current ?? target.getBoundingClientRect();
    const pointer = {
      inside: true,
      clientX,
      clientY,
      x: Math.min(Math.max(clientX - rect.left, 0), rect.width),
      y: Math.min(Math.max(clientY - rect.top, 0), rect.height),
      width: rect.width,
      height: rect.height,
    };
    graphPointer.current = pointer;
    return pointer;
  }, []);
  const refreshGraphPointer = useCallback((target = flowWrapRef.current): GraphPointerState => {
    if (!target) {
      resetGraphPointer();
      return graphPointer.current;
    }
    graphMagnifierRect.current = target.getBoundingClientRect();
    if (!graphPointer.current.inside) return graphPointer.current;
    return readGraphPointer(target, graphPointer.current.clientX, graphPointer.current.clientY);
  }, [readGraphPointer, resetGraphPointer]);
  const showGraphMagnifier = useCallback((pointer = graphPointer.current) => {
    if (!pointer.inside || !flowWrapRef.current) return;
    setGraphViewport(graphViewportRef.current);
    setGraphMagnifierSnapshot({ ...pointer, active: true });
  }, [setGraphMagnifierSnapshot]);
  const enterGraphMagnifier = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    graphMagnifierRect.current = event.currentTarget.getBoundingClientRect();
    readGraphPointer(event.currentTarget, event.clientX, event.clientY);
  }, [readGraphPointer]);
  const updateGraphMagnifier = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const active = event.metaKey || event.ctrlKey;
    const pointer = readGraphPointer(event.currentTarget, event.clientX, event.clientY);
    if (!active) { hideGraphMagnifier(); return; }
    showGraphMagnifier(pointer);
  }, [hideGraphMagnifier, readGraphPointer, showGraphMagnifier]);
  const leaveGraphMagnifier = useCallback(() => {
    resetGraphPointer();
    hideGraphMagnifier();
  }, [hideGraphMagnifier, resetGraphPointer]);
  const setFlowWrapElement = useCallback((element: HTMLDivElement | null) => {
    flowWrapRef.current = element;
    resetGraphPointer();
    if (!element) hideGraphMagnifier();
  }, [hideGraphMagnifier, resetGraphPointer]);

  const loadCatalog = useCallback(async ({ focus, visibleProjectId }: CatalogLoadOptions = {}) => {
    try {
      const response = await fetch("/api/projects");
      if (!response.ok) throw new Error("No se pudo cargar la lista de proyectos");
      const next = await response.json() as Catalog;
      const nextFocus = resolveCatalogRunFocus(next.projects, { focus, currentProjectId: visibleProjectId, knownRunIds: knownRunIds.current });
      const nextRunIds = collectCatalogRunIds(next.projects);
      knownRunIds.current = nextRunIds;
      setCatalog(next);
      setProjectId((current) => nextFocus?.projectId ?? (current && next.projects.some((project) => project.id === current) ? current : next.projects[0]?.id ?? ""));
      if (nextFocus) setRunId(nextFocus.runId);
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
      // El build web puede quedar listo unos minutos antes de que el humano
      // reinicie un servicio con ejecuciones activas: tolera el contrato v3.2
      // anterior sin romper el panel durante esa ventana de despliegue.
      next.run.auditors ??= [];
      next.agentStates ??= [];
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

  const loadHealth = useCallback(async () => {
    try {
      const response = await fetch("/api/health");
      if (response.ok) setBuildStale((await response.json() as Health).buildStale === true);
    } catch { /* una interrupción de red ya queda representada por connectionState */ }
  }, []);

  useEffect(() => { loadCatalog().catch((cause) => setError(String(cause))); }, [loadCatalog]);
  useEffect(() => { loadOllama().catch(() => undefined); }, [loadOllama]);
  useEffect(() => {
    loadHealth().catch(() => undefined);
    const interval = window.setInterval(() => { loadHealth().catch(() => undefined); }, 15_000);
    return () => window.clearInterval(interval);
  }, [loadHealth]);

  const project = catalog.projects.find((candidate) => candidate.id === projectId);
  useEffect(() => {
    if (!project) { setRunId(""); return; }
    setRunId((current) => current && project.runs.some((run) => run.id === current) ? current : project.runs[0]?.id ?? "");
  }, [project]);

  useEffect(() => { currentProjectId.current = projectId; }, [projectId]);
  useEffect(() => { currentRunId.current = runId; }, [runId]);
  useEffect(() => { loadDetail(runId).catch((cause) => setError(String(cause))); }, [runId, loadDetail]);

  useEffect(() => {
    setConnectionState("connecting");
    const source = new EventSource("/api/events");
    source.onopen = () => setConnectionState("connected");
    source.addEventListener("ready", () => setConnectionState("connected"));
    source.addEventListener("change", (event) => {
      const change = JSON.parse((event as MessageEvent).data) as CatalogChange;
      const visibleProjectId = currentProjectId.current;
      const visibleRunId = currentRunId.current;
      const { focus, shouldReloadDetail } = resolveCatalogChange({ change, visibleProjectId, visibleRunId });
      loadCatalog({ focus, visibleProjectId }).catch(() => undefined);
      if (shouldReloadDetail) loadDetail(visibleRunId).catch(() => undefined);
    });
    source.onerror = () => setConnectionState("offline");
    return () => source.close();
  }, [loadCatalog, loadDetail]);

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

  const updateAuditors = useCallback(async (auditors: string[]) => {
    if (!runId) return;
    const response = await fetch(`/api/runs/${runId}/auditors`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auditors }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? "No se pudo guardar la selección de auditores");
    }
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

  const setRunControl = useCallback(async (run: RunSummary, control: "active" | "paused" | "stopped") => {
    const response = await fetch(`/api/runs/${run.id}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ control }) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? "No se pudo actualizar el control de la ejecución");
    }
    await loadCatalog({ visibleProjectId: projectId });
    if (run.id === runId) await loadDetail(run.id);
  }, [projectId, runId, loadCatalog, loadDetail]);

  const graph = useMemo(() => layoutGraph(detail?.nodes ?? [], selectedId, detail?.run, ollama?.configured ?? false, setSelectedId, (nodeId, assignee) => { assignAgent(nodeId, assignee).catch(() => undefined); }), [detail?.nodes, detail?.run, selectedId, ollama?.configured, assignAgent]);

  // El layout se re-acomoda cuando aparecen o desaparecen nodos (descubiertos,
  // grafo republicado) y el contenido puede quedar fuera del viewport: reencuadra
  // solo cuando cambia el conjunto de ids, no en cada refresco de estado.
  const nodeSetKey = useMemo(() => (detail?.nodes ?? []).map((node) => node.id).sort().join("|"), [detail?.nodes]);
  const flowMounted = isGraphFlowMounted(view, detail?.nodes.length);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey) showGraphMagnifier(refreshGraphPointer());
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) hideGraphMagnifier();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", hideGraphMagnifier);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", hideGraphMagnifier);
    };
  }, [hideGraphMagnifier, refreshGraphPointer, showGraphMagnifier]);
  const applyGraphViewport = useCallback((duration = 320) => {
    const instance = flowInstance.current;
    if (!instance) return;
    const action = decideGraphViewportAction({ appliedKey: appliedGraphViewportKey.current, nodeSetKey, runId, saved: graphViewports.current.get(runId) });
    if (action.kind === "skip") return;
    cancelPendingGraphFit();
    appliedGraphViewportKey.current = action.graphKey;
    if (action.kind === "restore") {
      void instance.setViewport(action.viewport, { duration: 0 });
      return;
    }
    // ReactFlow ingiere el layout nuevo de forma asíncrona: un solo fitView puede
    // ejecutarse contra los límites viejos y dejar el grafo fuera de vista.
    // Encuadra en el siguiente frame y reintenta una vez ya asentado el render.
    let cancelled = false;
    const fit = () => { if (!cancelled) flowInstance.current?.fitView({ padding: 0.22, maxZoom: 1, duration }); };
    let frame2 = 0;
    const frame1 = requestAnimationFrame(() => { frame2 = requestAnimationFrame(fit); });
    const settle = setTimeout(fit, 400);
    const cancel = () => {
      cancelled = true;
      cancelAnimationFrame(frame1);
      cancelAnimationFrame(frame2);
      clearTimeout(settle);
    };
    pendingGraphFitCancel.current = cancel;
    return cancel;
  }, [cancelPendingGraphFit, nodeSetKey, runId]);
  useEffect(() => {
    if (!nodeSetKey) return;
    return applyGraphViewport();
  }, [applyGraphViewport, nodeSetKey]);
  useEffect(() => () => cancelPendingGraphFit(), [cancelPendingGraphFit]);
  useEffect(() => {
    if (flowMounted) return;
    cancelPendingGraphFit();
    resetGraphPointer();
    hideGraphMagnifier();
    flowInstance.current = null;
    appliedGraphViewportKey.current = "";
    graphViewportUserMoved.current = false;
  }, [cancelPendingGraphFit, flowMounted, hideGraphMagnifier, resetGraphPointer]);
  useEffect(() => {
    if (!flowMounted || !flowWrapRef.current) return;
    const target = flowWrapRef.current;
    const refresh = () => {
      const pointer = refreshGraphPointer(target);
      if (graphMagnifierActive.current) showGraphMagnifier(pointer);
    };
    refresh();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(refresh);
    observer?.observe(target);
    window.addEventListener("resize", refresh);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", refresh);
    };
  }, [flowMounted, refreshGraphPointer, showGraphMagnifier]);
  const selectedNode = detail?.nodes.find((node) => node.id === selectedId);
  const progress = detail?.run.nodeCount ? Math.round((detail.run.completedCount / detail.run.nodeCount) * 100) : 0;
  const publishedActivity = detail?.activity.filter((entry) => entry.type !== "run").length ?? 0;
  const unapprovedCount = detail?.nodes.filter((node) => !node.approved).length ?? 0;
  const auditorsReady = Boolean(detail?.run.auditors.length) && (!detail?.run.auditors.includes("ollama") || Boolean(ollama?.configured));
  const globalPending = useMemo(() => globalPendingEntries(catalog.projects), [catalog.projects]);
  const graphMagnifierStyle: CSSProperties = {
    left: graphMagnifier.x,
    top: graphMagnifier.y,
    width: graphMagnifierSize,
    height: graphMagnifierSize,
  };
  const graphMagnifierContentStyle: CSSProperties = {
    width: graphMagnifier.width,
    height: graphMagnifier.height,
    transform: `translate(${graphMagnifierSize / 2 - graphMagnifier.x * graphMagnifierScale}px, ${graphMagnifierSize / 2 - graphMagnifier.y * graphMagnifierScale}px) scale(${graphMagnifierScale})`,
  };

  // paused = aprobar sin arrancar: el plan queda autorizado pero ningún agente
  // puede iniciar nodos hasta reanudar — tiempo para asignar y conectar agentes.
  const approveAll = useCallback(async (paused = false) => {
    if (!runId) return;
    setApproveError(undefined);
    const failure = async (response: Response | undefined, fallback: string) => {
      const body = response ? (await response.json().catch(() => ({}))) as { error?: string } : {};
      setApproveError(body.error ?? fallback);
    };
    // La pausa va antes de aprobar y debe confirmarse: si falla, aprobar de
    // todos modos entregaría el arranque inmediato justo cuando el humano pidió
    // lo contrario, así que el grafo se queda sin aprobar y el fallo se ve.
    if (paused) {
      const pauseResponse = await fetch(`/api/runs/${runId}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ control: "paused" }) }).catch(() => undefined);
      if (!pauseResponse?.ok) {
        await failure(pauseResponse, "No se pudo pausar la ejecución; el grafo sigue sin aprobar.");
        return;
      }
    }
    const approved = await fetch(`/api/runs/${runId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
    if (!approved?.ok) {
      await failure(approved, "No se pudo aprobar el grafo.");
      await loadDetail(runId);
      return;
    }
    await loadDetail(runId);
  }, [runId, loadDetail]);

  if (error) return <div className="fatal-error"><Icon name="warning"/><h1>HRP no pudo iniciar</h1><p>{error}</p><button onClick={() => location.reload()}>Volver a intentar</button></div>;
  if (loadingCatalog) return <><TopBar connectionState={connectionState} buildStale={buildStale} ollama={ollama} onOllamaSaved={() => { loadOllama().catch(() => undefined); }}/><LoadingState label="Cargando proyectos"/></>;
  if (!catalog.projects.length) return <><TopBar connectionState={connectionState} buildStale={buildStale} ollama={ollama} onOllamaSaved={() => { loadOllama().catch(() => undefined); }}/><EmptyState kind="projects"/></>;

  return (
    <div className="app-shell">
      <TopBar connectionState={connectionState} buildStale={buildStale} project={project} run={detail?.run} progress={progress} ollama={ollama} pendingEntries={globalPending} currentRunId={runId} onPendingOpenRun={(nextProjectId, nextRunId) => { setProjectId(nextProjectId); setRunId(nextRunId); }} onPendingControl={setRunControl} onOllamaSaved={() => { loadOllama().catch(() => undefined); }}/>
      <div className="app-body">
        <ProjectTree
          projects={catalog.projects}
          projectId={projectId}
          runId={runId}
          agentDock={!loadingRun && detail?.run.id === runId ? <AgentDock run={detail.run} nodes={detail.nodes} agentStates={detail.agentStates} workspaceRoot={project?.workspaceRoot} ollama={ollama} onAuditorsChange={updateAuditors}/> : undefined}
          onProject={(nextProject) => { setProjectId(nextProject.id); setRunId(sortRuns(nextProject.runs)[0]?.id ?? ""); }}
          onRun={(nextProjectId, nextRunId) => { setProjectId(nextProjectId); setRunId(nextRunId); }}
          onDeleteProject={(target) => { deleteProject(target).catch(() => undefined); }}
          onDeleteRun={(target) => { deleteRun(target).catch(() => undefined); }}
        />
        <div className="content-shell">
          <div className="content-toolbar">
            <div className="current-context"><Icon name="route"/><span>{detail?.run.title ?? "Sin ejecución seleccionada"}</span></div>
            <nav aria-label="Vista principal"><button aria-pressed={view === "map"} className={view === "map" ? "active" : ""} onClick={() => setView("map")}><Icon name="route"/>Mapa</button><button aria-pressed={view === "activity"} className={view === "activity" ? "active" : ""} onClick={() => setView("activity")}><Icon name="activity"/>Actividad</button><button aria-pressed={view === "findings"} className={view === "findings" ? "active" : ""} onClick={() => setView("findings")}><Icon name="warning"/>Hallazgos{(detail?.run.openFindings ?? 0) > 0 && <span className="nav-findings-count">{detail?.run.openFindings}</span>}</button></nav>
          </div>
          {loadingRun ? <LoadingState label="Cargando ejecución"/> : !runId || !detail ? <EmptyState kind="runs"/> : (
            <main className="workspace">
              <section className="map-stage" aria-label={view === "map" ? "Mapa de cambios" : "Actividad de la ejecución"}>
                <header className="stage-head">
                  <div><h1>{detail.run.title}</h1><p>{detail.run.requirement}</p></div>
                  <div className="stage-actions">
                    <RunControls run={detail.run} onChanged={() => { loadDetail(detail.run.id).catch(() => undefined); }}/>
                    <div className="stage-count"><strong>{detail.run.completedCount}/{detail.run.nodeCount}</strong><span>operaciones terminadas</span></div>
                  </div>
                </header>
                {detail.run.control !== "active" && (
                  <div className={`control-banner control-banner-${detail.run.control}`} role="status">
                    <Icon name={detail.run.control === "paused" ? "clock" : "warning"}/>
                    <p>{detail.run.control === "paused"
                      ? "Ejecución pausada: ningún agente puede iniciar nodos hasta que la reanudes; el nodo que estaba en curso termina su ciclo."
                      : "Ejecución detenida: los agentes no pueden iniciar más nodos y deben cerrar ordenadamente. Puedes reanudarla cuando quieras."}</p>
                  </div>
                )}
                {unapprovedCount > 0 && (
                  <div className="approval-banner" role="status">
                    <Icon name="warning"/>
                    <p>{unapprovedCount === 1 ? "1 operación espera tu aprobación." : `${unapprovedCount} operaciones esperan tu aprobación.`} {detail.run.auditors.includes("ollama") && !ollama?.configured ? "Configura Ollama Cloud o elige otro auditor antes de iniciar." : detail.run.auditors.length ? `Auditarán: ${detail.run.auditors.join(", ")}.` : "Elige al menos un auditor en la columna izquierda para iniciar."}</p>
                    <button type="button" disabled={!auditorsReady} onClick={() => { approveAll().catch(() => undefined); }}>Aprobar grafo</button>
                    <button type="button" disabled={!auditorsReady} className="approve-paused" title="Autoriza el plan pero deja la ejecución en pausa: asigna nodos y conecta agentes con calma, y reanuda cuando todo esté listo" onClick={() => { approveAll(true).catch(() => undefined); }}>Aprobar en pausa</button>
                    {approveError && <p className="approve-error" role="alert">{approveError}</p>}
                  </div>
                )}
                {detail.findings.some((finding) => finding.status === "escalated") && view !== "findings" && (
                  <div className="approval-banner findings-banner" role="status">
                    <Icon name="warning"/>
                    <p>{detail.findings.filter((finding) => finding.status === "escalated").length === 1 ? "1 hallazgo del debate espera tu arbitraje." : `${detail.findings.filter((finding) => finding.status === "escalated").length} hallazgos del debate esperan tu arbitraje.`} Los modelos no llegaron a acuerdo.</p>
                    <button type="button" onClick={() => setView("findings")}>Ver hallazgos</button>
                  </div>
                )}
                {view === "findings" ? (
                  <FindingsPanel findings={detail.findings} nodes={detail.nodes} runId={detail.run.id} onChanged={() => { loadDetail(detail.run.id).catch(() => undefined); }} onSelectNode={(id) => { setSelectedId(id); setView("map"); }}/>
                ) : view === "map" ? (
                  detail.nodes.length ? <div className={`flow-wrap ${graphMagnifier.active ? "is-magnifying" : ""}`} ref={setFlowWrapElement} onPointerEnter={enterGraphMagnifier} onPointerMove={updateGraphMagnifier} onPointerLeave={leaveGraphMagnifier}>
                    <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false} onInit={(instance) => { flowInstance.current = instance; updateGraphViewport(instance.getViewport()); appliedGraphViewportKey.current = ""; applyGraphViewport(0); }} onViewportChange={updateGraphViewport} onMoveStart={(event) => { if (event) { graphViewportUserMoved.current = true; cancelPendingGraphFit(); } }} onMoveEnd={(_event, viewport) => { updateGraphViewport(viewport); if (shouldPersistGraphViewport({ nodeSetKey, runId, userMoved: graphViewportUserMoved.current })) graphViewports.current.set(runId, { nodeSetKey, viewport }); graphViewportUserMoved.current = false; }} onNodeClick={(_event, node) => setSelectedId(node.id)} onPaneClick={() => setSelectedId("")} ariaLabelConfig={graphAriaLabels} minZoom={0.25} maxZoom={1.8} proOptions={{ hideAttribution: true }}><Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#aab5af"/><Controls showInteractive={false} aria-label="Controles del mapa"/></ReactFlow>
                    {graphMagnifier.active && (
                      <div className="graph-magnifier" style={graphMagnifierStyle} aria-hidden="true" inert>
                        <div className="graph-magnifier__content" style={graphMagnifierContentStyle}>
                          <ReactFlow className="graph-magnifier__flow" nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false} viewport={graphViewport} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} panOnDrag={false} panOnScroll={false} preventScrolling={false} ariaLabelConfig={graphAriaLabels} minZoom={0.25} maxZoom={1.8} proOptions={{ hideAttribution: true }}><Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#aab5af"/></ReactFlow>
                        </div>
                      </div>
                    )}
                  </div>
                    : <div className="map-empty"><Icon name="route"/><h2>El mapa aún no ha sido publicado</h2><p>La ejecución existe, pero el agente todavía no declaró sus operaciones.</p>{publishedActivity > 0 && <button type="button" className="map-empty-cta" onClick={() => setView("activity")}><Icon name="activity"/>{publishedActivity === 1 ? "Ver 1 evento publicado en Actividad" : `Ver ${publishedActivity} eventos publicados en Actividad`}</button>}</div>
                ) : <ActivityLedger activity={detail.activity} nodes={detail.nodes} onSelect={(id) => { setSelectedId(id); setView("map"); }}/>} 
              </section>
              <Inspector node={selectedNode} nodes={detail.nodes} activity={detail.activity} runId={detail.run.id} baseAgent={detail.run.baseAgent} seenAgents={detail.run.seenAgents} ollamaConfigured={ollama?.configured ?? false} canApprove={auditorsReady} onChanged={() => { loadDetail(detail.run.id).catch(() => undefined); }}/>
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
              <li>En el dock de agentes (abajo a la izquierda) pulsa el icono de copiar junto a ese modelo.</li>
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

function GlobalPendingPanel({ entries, currentRunId, onOpenRun, onControl }: {
  entries: GlobalPendingEntry[];
  currentRunId: string;
  onOpenRun: (projectId: string, runId: string) => void;
  onControl: (run: RunSummary, control: "active" | "paused" | "stopped") => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busyRunId, setBusyRunId] = useState("");
  const [error, setError] = useState("");
  const [attentionByRun, setAttentionByRun] = useState<Record<string, AttentionSignal[]>>({});
  const [loadingAttention, setLoadingAttention] = useState(false);
  const pendingRunKey = useMemo(() => entries.map((entry) => entry.run.id).sort().join("|"), [entries]);
  const toggleButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusOnCloseRef = useRef(false);
  const closePanel = useCallback(() => {
    restoreFocusOnCloseRef.current = true;
    setOpen(false);
  }, []);
  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closePanel(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (restoreFocusOnCloseRef.current) {
        restoreFocusOnCloseRef.current = false;
        toggleButtonRef.current?.focus();
      }
    };
  }, [open, closePanel]);
  useEffect(() => {
    if (!open || !pendingRunKey) { setAttentionByRun({}); return; }
    let cancelled = false;
    const runIds = new Set(pendingRunKey.split("|"));
    setLoadingAttention(true);
    Promise.all(supportedAgents.map(async (agent) => {
      const response = await fetch(`/api/attention?agent=${encodeURIComponent(agent)}&waitMs=0`);
      if (!response.ok) return [];
      const payload = await response.json() as { runs?: AttentionSignal[] };
      return (payload.runs ?? []).filter((signal) => runIds.has(signal.runId));
    })).then((groups) => {
      if (cancelled) return;
      const next: Record<string, AttentionSignal[]> = {};
      for (const signal of groups.flat()) {
        next[signal.runId] = [...(next[signal.runId] ?? []), signal];
      }
      setAttentionByRun(next);
    }).catch(() => {
      if (!cancelled) setAttentionByRun({});
    }).finally(() => {
      if (!cancelled) setLoadingAttention(false);
    });
    return () => { cancelled = true; };
  }, [open, pendingRunKey]);
  const runControl = async (entry: GlobalPendingEntry, control: "active" | "paused" | "stopped") => {
    if (control === "stopped" && !window.confirm(`¿Detener "${entry.run.title}"? Dejará de despertar a los agentes hasta que la reanudes desde su ejecución.`)) return;
    setBusyRunId(entry.run.id);
    setError("");
    try {
      await onControl(entry.run, control);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo actualizar la ejecución");
    } finally {
      setBusyRunId("");
    }
  };
  return (
    <div className="global-pending-wrap">
      <button ref={toggleButtonRef} type="button" className={`global-pending-toggle ${entries.length ? "has-pending" : ""}`} aria-expanded={open} aria-label="Ver pendientes globales" title="Ver pendientes globales" onClick={() => setOpen((value) => !value)}>
        <Icon name="activity"/>
        <span>{entries.length}</span>
      </button>
      {open && (
        <>
          <div className="global-pending-backdrop" onClick={closePanel}/>
          <section className="global-pending-panel" role="dialog" aria-modal="true" aria-label="Pendientes globales de HRP">
            <header>
              <div><h3>Pendientes globales</h3><p>{entries.length ? "Ejecuciones que aún pueden despertar hooks o pedir intervención." : "No hay ejecuciones vivas que reclamen atención."}</p></div>
              <button ref={closeButtonRef} type="button" aria-label="Cerrar pendientes globales" onClick={closePanel}>×</button>
            </header>
            {error && <p className="global-pending-error" role="alert">{error}</p>}
            {entries.length ? (
              <ol className="global-pending-list">
                {entries.map((entry) => (
                  <li key={entry.run.id} className={`global-pending-item control-${entry.run.control} status-${entry.run.status} ${entry.run.id === currentRunId ? "is-current" : ""}`}>
                    <div className="global-pending-main">
                      {(() => {
                        const signals = (attentionByRun[entry.run.id] ?? []).filter((candidate) => candidate.actionable || (candidate.waiting && !candidate.terminal));
                        const signal = signals.find((candidate) => candidate.actionable) ?? signals.find((candidate) => candidate.waiting) ?? signals[0];
                        return (
                          <div className="global-pending-attention">
                            <span>{loadingAttention ? "attention..." : signal ? `${signal.agent}: ${signal.kind}` : "sin señal attention"}</span>
                            {signal && <p title={signal.directive}>{signal.directive}</p>}
                          </div>
                        );
                      })()}
                      <span className="global-pending-state">{entry.run.control === "paused" ? "Pausada" : statusCopy[entry.run.status]}</span>
                      <strong>{entry.run.title}</strong>
                      <small title={entry.project.workspaceRoot}>{entry.project.name} · {entry.project.workspaceRoot}</small>
                      <div className="global-pending-reasons">{entry.reasons.map((reason) => <span key={reason}>{reason}</span>)}</div>
                    </div>
                    <div className="global-pending-actions">
                      <button type="button" onClick={() => { onOpenRun(entry.project.id, entry.run.id); closePanel(); }}>Abrir</button>
                      {entry.run.control === "paused" && <button type="button" className="control-resume" disabled={busyRunId === entry.run.id} onClick={() => { runControl(entry, "active").catch(() => undefined); }}>Reanudar</button>}
                      {entry.run.control !== "stopped" && <button type="button" className="control-stop" disabled={busyRunId === entry.run.id} onClick={() => { runControl(entry, "stopped").catch(() => undefined); }}>{busyRunId === entry.run.id ? "Deteniendo" : "Detener"}</button>}
                    </div>
                  </li>
                ))}
              </ol>
            ) : <div className="global-pending-empty"><Icon name="check"/><strong>Todo cerrado</strong><p>Los hooks no deberían encontrar ejecuciones vivas en este workspace.</p></div>}
          </section>
        </>
      )}
    </div>
  );
}

function TopBar({ connectionState, buildStale, project, run, progress = 0, ollama, pendingEntries = [], currentRunId = "", onPendingOpenRun, onPendingControl, onOllamaSaved }: {
  connectionState: ConnectionState;
  buildStale: boolean;
  project?: Project;
  run?: RunSummary;
  progress?: number;
  ollama?: OllamaSettingsView;
  pendingEntries?: GlobalPendingEntry[];
  currentRunId?: string;
  onPendingOpenRun?: (projectId: string, runId: string) => void;
  onPendingControl?: (run: RunSummary, control: "active" | "paused" | "stopped") => Promise<void>;
  onOllamaSaved?: () => void;
}) {
  const connectionCopy = buildStale ? "Reinicia HRP" : connectionState === "connected" ? "En vivo" : connectionState === "offline" ? "Sin conexión" : "Conectando";
  const connectionClass = buildStale ? "offline" : connectionState;
  return (
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><i/><i/><i/></span><div><strong>Human Review Protocol</strong><span>Mapa observable de cambios</span></div></div>
      <div className="run-telemetry">
        {run && <div className="progress-track" role="progressbar" aria-label="Progreso de la ejecución" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }}/></div>}
        <div className="telemetry-copy"><strong>{run ? statusCopy[run.status] : "Sin ejecución"}</strong><span>{project?.workspaceRoot ?? "Ningún proyecto conectado"}</span></div>
      </div>
      {/* Una sola celda del grid: la barra conserva sus 4 hijos originales. */}
      <div className="topbar-tools">
        {onPendingOpenRun && onPendingControl && <GlobalPendingPanel entries={pendingEntries} currentRunId={currentRunId} onOpenRun={onPendingOpenRun} onControl={onPendingControl}/>}
        <OllamaSettingsPanel ollama={ollama} onSaved={onOllamaSaved}/>
        <HelpPanel/>
      </div>
      <span className={`connection ${connectionClass}`} role="status" title={buildStale ? "El build cambió. Ejecuta ./scripts/update.sh para reiniciar el servicio." : undefined}><i/>{connectionCopy}{!buildStale && connectionState === "offline" && <button type="button" onClick={() => location.reload()}>Reintentar</button>}</span>
    </header>
  );
}
