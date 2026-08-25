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
import { DEFAULT_UI_PREFERENCES, agentFamily, agentSessionLabel, agentTree, auditorIdentity, isDelegateAgent, laneModel, runRoster, type Activity, type AgentWorkState, type ChangeNode, type Finding, type NodeStatus, type OllamaSettingsView, type Project, type RunDetail, type RunSummary, type UiPreferences, type ViewShortcutModifier } from "../shared/protocol";
import { agentAttentionCommand, agentAttentionReleaseCommand } from "./agent-attention";
import { delegateLanes, delegateSubtitle } from "./agent-lanes";
import { agentWorkload } from "./agent-workload";
import { collectCatalogRunIds, resolveCatalogChange, resolveCatalogRunFocus, type CatalogChange, type CatalogRunFocus } from "./catalog-focus";
import { branchSelection, fileSelection, toggleSelection } from "./node-selection";
import { decideGraphFit, decideGraphViewportAction, graphMaxZoom, graphMinZoom, graphNodesMeasured, isGraphFlowMounted, magnifierContentTransform, shouldPersistGraphViewport, type GraphView, type StoredGraphViewport } from "./graph-viewport";
import { resolveProjectRunListState } from "./project-tree-runs";
import { isViewShortcutEvent, resolveViewShortcut } from "./view-shortcuts";

type ProjectWithRuns = Project & { runs: RunSummary[] };
type Catalog = { projects: ProjectWithRuns[] };
type Health = { buildStale?: boolean };
// Lo devuelve GET /api/runs/:id/attribution. Se declara aquí, como Health,
// porque el cliente no puede importar tipos del servidor.
type FileAttribution = { file: string; nodeId?: string; status: "attributed" | "drifted" | "unknown" };
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
  // 'isSelected' es la operación abierta en el inspector; 'isPicked' es la que
  // entra en la próxima asignación por lote. Son dos selecciones distintas y
  // conviven en la misma tarjeta.
  isPicked: boolean;
  baseAgent?: string;
  seenAgents: string[];
  ollamaConfigured: boolean;
  roster: string[];
  onSelect: (id: string) => void;
  onAssign: (id: string, assignee: string | null) => void;
  onPickFile: (file: string) => void;
  onPickBranch: (id: string) => void;
};

const changeNodeWidthFallback = 272;
const changeNodeLayoutHeightFallback = 196;
const graphMagnifierTargetScale = 1.45;
const graphMagnifierFramePadding = 48;
const graphMagnifierSize = 2 * Math.ceil((changeNodeWidthFallback * graphMagnifierTargetScale + graphMagnifierFramePadding) / 2);
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

const difficultyCopy: Record<NonNullable<ChangeNode["difficulty"]>, string> = {
  trivial: "trivial",
  standard: "estándar",
  hard: "difícil",
};

const difficultyHint = "Dificultad declarada por el modelo base: con ella se decide qué modelo implementa la operación.";

// Opciones de asignación: el censo de la ejecución (base, familias con
// adaptador, sesiones ya nombradas y carriles delegados) y, si el nodo ya tiene
// un valor fuera de él, ese valor para no perderlo.
function AgentOptions({ roster, current }: { roster: string[]; current?: string }) {
  const options = [...roster];
  if (current && !options.includes(current)) options.push(current);
  return <>{options.map((agent) => <option key={agent} value={agent}>{agentLabel(agent)}</option>)}</>;
}

// Una identidad se lee en dos partes: la familia y, si es un carril delegado o
// una sesión, su etiqueta. Así "claude:opus" y "claude:fable" se distinguen de
// un vistazo en vez de leerse como dos cadenas casi iguales.
function agentLabel(agent: string): string {
  const lane = laneModel(agent);
  if (lane) return `ollama · ${lane}`;
  const session = agentSessionLabel(agent);
  return session ? `${agentFamily(agent)} · ${session}` : agent;
}

function agentMissing(change: ChangeNode, baseAgent: string | undefined, seenAgents: string[], ollamaConfigured = false): boolean {
  // ollama no abre sesión propia: el modelo base delega vía el servicio, así
  // que basta con que exista una API key configurada para considerarlo listo.
  // Vale igual para cualquier carril 'ollama:<modelo>'.
  if (isDelegateAgent(change.assignee) && ollamaConfigured) return false;
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

function Icon({ name }: { name: "route" | "activity" | "folder" | "check" | "clock" | "warning" | "code" | "sliders" | "copy" | "bell" | "bellOff" | "plus" | "minus" }) {
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
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    minus: <><path d="M5 12h14"/></>,
    bellOff: <><path d="m3 3 18 18"/><path d="M6.6 6.6A5.9 5.9 0 0 0 6 8c0 7-3 7-3 9h14"/><path d="M18 14.5c-.6-1.2 0-3.1 0-6.5a6 6 0 0 0-7.4-5.8"/><path d="M10 21h4"/></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="icon">{paths[name]}</svg>;
}

function StatusSignal({ status }: { status: NodeStatus }) {
  const icon = status === "completed" ? "check" : status === "failed" ? "warning" : "clock";
  return <span className={`status-signal status-${status}`}><Icon name={icon}/>{statusCopy[status]}</span>;
}

// Exportada para poder renderizarla en una prueba: los gestos de selección
// viven en el JSX de la tarjeta y una comprobación por texto del fuente ya dejó
// pasar antes un estado que se escribía y nunca se leía.
export function ChangeNodeCard({ data }: NodeProps<Node<MapNodeData>>) {
  const change = data.change;
  const missing = agentMissing(change, data.baseAgent, data.seenAgents, data.ollamaConfigured);
  return (
    <div
      role="button"
      tabIndex={0}
      className={`change-node nodrag nopan change-node-${change.status} ${data.isSelected ? "is-selected" : ""} ${data.isPicked ? "is-picked" : ""}`}
      aria-label={`${change.file}, ${change.symbol}, ${statusCopy[change.status]}${data.isPicked ? ", seleccionada para asignar" : ""}`}
      aria-pressed={data.isSelected}
      onClick={() => data.onSelect(change.id)}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); data.onSelect(change.id); } }}
    >
      <Handle type="target" position={Position.Left} className="route-handle" />
      <div className="node-route-head">
        {/* El archivo y la rama son los dos gestos con significado en este grafo:
            el contrato ya obliga a encadenar los nodos de un mismo archivo, y la
            dependencia es la única vecindad real —la posición la calcula dagre y
            no significa nada—. */}
        <button
          type="button"
          className="node-file node-pick-file nodrag"
          title={`Seleccionar las operaciones de ${change.file} para asignarlas juntas`}
          onClick={(event) => { event.stopPropagation(); data.onPickFile(change.file); }}
          onPointerDown={(event) => event.stopPropagation()}
        >{change.file}</button>
        <button
          type="button"
          className="node-pick-branch nodrag"
          title="Seleccionar esta operación y todas las que dependen de ella"
          aria-label={`Seleccionar la rama de ${change.symbol}`}
          onClick={(event) => { event.stopPropagation(); data.onPickBranch(change.id); }}
          onPointerDown={(event) => event.stopPropagation()}
        ><Icon name="route"/></button>
        {change.discovered && <span className="discovered-label">Descubierto</span>}
        {!change.approved && <span className="approval-label">Por aprobar</span>}
        {change.suggestedAgent && change.status !== "completed" && (
          <span className="suggested-label" title={`El modelo base sugiere que esta operación la implemente ${change.suggestedAgent}`}>sugiere {change.suggestedAgent}</span>
        )}
        {change.difficulty && <span className="suggested-label" title={difficultyHint}>{difficultyCopy[change.difficulty]}</span>}
      </div>
      <strong className="node-symbol">{change.symbol}</strong>
      {change.status === "completed" && <span className="node-completion-crumb" aria-hidden="true"><i/><i/><i/></span>}
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
            <AgentOptions roster={data.roster} current={change.assignee}/>
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

export function layoutGraph(changes: ChangeNode[], selectedId: string | undefined, run: RunSummary | undefined, ollamaConfigured: boolean, roster: string[], onSelect: (id: string) => void, onAssign: (id: string, assignee: string | null) => void, picked: string[] = [], onPickFile: (file: string) => void = () => undefined, onPickBranch: (id: string) => void = () => undefined): { nodes: Node<MapNodeData>[]; edges: Edge[] } {
  const nodeWidth = readCssPixels("--change-node-width", changeNodeWidthFallback);
  const nodeHeight = readCssPixels("--change-node-layout-height", changeNodeLayoutHeightFallback);
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", ranksep: 86, nodesep: 46, marginx: 44, marginy: 44 });
  for (const change of changes) graph.setNode(change.id, { width: nodeWidth, height: nodeHeight });
  for (const change of changes) for (const dependency of change.dependencies) graph.setEdge(dependency, change.id);
  dagre.layout(graph);
  const byId = new Map(changes.map((change) => [change.id, change]));
  const pickedIds = new Set(picked);
  const nodes = changes.map((change) => {
    const point = graph.node(change.id) as { x: number; y: number };
    return {
      id: change.id,
      type: "change",
      position: { x: point.x - nodeWidth / 2, y: point.y - nodeHeight / 2 },
      // ReactFlow esconde el nodo y descarta el encuadre mientras no tenga
      // medidas, y sólo las obtiene de un ResizeObserver que no entrega nada
      // en una pestaña que el navegador no pinta. Declaramos las mismas que
      // usó dagre; no width/height sueltos, que ReactFlow volvería estilo
      // inline y recortarían la tarjeta, más alta que su altura de layout.
      measured: { width: nodeWidth, height: nodeHeight },
      data: { change, isSelected: change.id === selectedId, isPicked: pickedIds.has(change.id), baseAgent: run?.baseAgent, seenAgents: run?.seenAgents ?? [], ollamaConfigured, roster, onSelect, onAssign, onPickFile, onPickBranch },
    };
  });
  const edges = changes.flatMap((change) => change.dependencies.map((dependency) => {
    const sourceStatus = byId.get(dependency)?.status;
    const completedRoute = sourceStatus === "completed" && change.status === "completed";
    return {
      id: `${dependency}-${change.id}`,
      source: dependency,
      target: change.id,
      type: "smoothstep",
      animated: change.status === "running",
      className: `route-edge route-edge-${change.status} route-edge-from-${sourceStatus ?? "unknown"} ${completedRoute ? "route-edge-completed-path" : ""}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15 },
      data: { sourceStatus, completedRoute },
    };
  }));
  return { nodes, edges };
}

// La selección múltiple no reparte trabajo en paralelo: HRP admite un solo nodo
// corriendo por identidad, así que asignar diez operaciones a una sesión es
// ponerle una fila de diez. La barra lo dice porque, si no, el gesto promete un
// reparto que el protocolo no hace.
export function SelectionBar({ count, roster, baseAgent, seenAgents, ollamaConfigured, skipped, error, busy, onAssign, onClear }: {
  count: number;
  roster: string[];
  baseAgent?: string;
  seenAgents: string[];
  ollamaConfigured: boolean;
  skipped: { id: string; reason: string }[];
  error?: string;
  busy: boolean;
  onAssign: (assignee: string | null) => void;
  onClear: () => void;
}) {
  const [assignee, setAssignee] = useState("");
  // El reporte de un lote parcial vive más que la selección que lo produjo: al
  // aplicar, App limpia lo seleccionado y conserva lo omitido, y es justo
  // entonces cuando el humano necesita leer por qué no cambió todo.
  const reporting = skipped.length > 0 || Boolean(error);
  if (!count && !reporting) return null;
  const missing = Boolean(assignee) && assignee !== baseAgent && !seenAgents.includes(assignee)
    && !(isDelegateAgent(assignee) && ollamaConfigured);
  return (
    <div className="selection-bar" role="group" aria-label={count ? "Asignar las operaciones seleccionadas" : "Resultado del último lote"}>
      <strong className="selection-count">{count
        ? `${count} ${count === 1 ? "operación seleccionada" : "operaciones seleccionadas"}`
        : "Resultado del último lote"}</strong>
      {count > 0 && <select
        className="selection-agent"
        aria-label="Modelo que implementará las operaciones seleccionadas"
        value={assignee}
        onChange={(event) => setAssignee(event.target.value)}
      >
        <option value="">{baseAgent ? `base · ${baseAgent}` : "modelo base"}</option>
        <AgentOptions roster={roster} current={assignee || undefined}/>
      </select>}
      {count > 0 && (
        <button type="button" className="approve-button" disabled={busy} onClick={() => onAssign(assignee || null)}>
          <Icon name="check"/>{assignee ? `Asignar a ${agentLabel(assignee)}` : "Devolver al modelo base"}
        </button>
      )}
      <button type="button" className="selection-clear" onClick={onClear}>{count ? "Limpiar" : "Entendido"}</button>
      {count > 0 && <p className="selection-queue"><Icon name="clock"/>Un modelo ejecuta sus operaciones de una en una: esto le arma una fila, no las reparte.</p>}
      {count > 0 && missing && <p className="assign-warning"><Icon name="warning"/>{assignee} no se ha presentado en esta ejecución; sus operaciones esperarán hasta que abra sesión.</p>}
      {error && <p className="assign-warning" role="alert"><Icon name="warning"/>{error}</p>}
      {skipped.length > 0 && (
        <ul className="selection-skipped" aria-label="Operaciones que no cambiaron">
          {skipped.map((entry) => <li key={entry.id}><code>{entry.id}</code> sin cambio: {entry.reason}</li>)}
        </ul>
      )}
    </div>
  );
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

function Inspector({ node, nodes, activity, runId, runControl, attribution, baseAgent, seenAgents, ollamaConfigured, roster, canApprove, onChanged }: { node?: ChangeNode; nodes: ChangeNode[]; activity: Activity[]; runId: string; runControl: RunSummary["control"]; attribution: FileAttribution[]; baseAgent?: string; seenAgents: string[]; ollamaConfigured: boolean; roster: string[]; canApprove: boolean; onChanged: () => void }) {
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
  const canReassign = node.status === "pending" || node.status === "failed" || (node.status === "running" && runControl === "paused");
  // El diff que el humano lee es la foto del archivo cuando el nodo publicó. Si
  // el archivo se movió después —otra sesión editando el mismo archivo—, ese
  // diff ya no describe lo que hay en disco, y aprobar o commitear a partir de
  // él se lleva trabajo que nadie revisó.
  const drifted = attribution.some((entry) => entry.file === node.file && entry.status === "drifted");
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

      {drifted && (
        <p className="assign-warning" role="alert"><Icon name="warning"/>El archivo cambió después de que este nodo publicó su diff. Lo que ves abajo sigue siendo lo que hizo esta operación, pero ya no describe el archivo completo: comprueba el árbol con «hrp verify tree» antes de commitear.</p>
      )}

      {canReassign && (
        <section className="human-controls">
          {!node.approved && (
            <button type="button" className="approve-button" disabled={!canApprove} title={canApprove ? undefined : "Elige al menos un auditor en la columna izquierda"} onClick={() => post("/approve", { nodeIds: [node.id] })}><Icon name="check"/>{canApprove ? "Aprobar esta operación" : "Elige un auditor para aprobar"}</button>
          )}
          {node.status === "running" && runControl === "paused" && (
            <>
              {/* El selector no basta para recuperar: onChange no dispara al
                  reelegir el valor actual, y un nodo del modelo base ya muestra
                  esa opción seleccionada. Este botón es la acción explícita, y
                  conserva al dueño para no confundir recuperar con reasignar. */}
              <button type="button" className="approve-button" onClick={() => post(`/nodes/${node.id}/assign`, { assignee: node.assignee ?? null })}><Icon name="clock"/>Recuperar esta operación</button>
              <p className="assign-warning"><Icon name="warning"/>Recuperar o reasignar esta operación la devuelve a pendiente y conserva el diff y la verificación del intento. Al reanudar, los agentes deben releer el estado.</p>
            </>
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
              <AgentOptions roster={roster} current={node.assignee}/>
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
        <div className="history-heading"><h3>Qué hará</h3><span>{node.difficulty ? `Plan original · dificultad ${difficultyCopy[node.difficulty]}` : "Plan original"}</span></div>
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

// Exportado para poder renderizar el árbol en una prueba: el duplicado de la
// rama de ollama sólo se ve en el HTML, no en el fuente.
export function AgentDock({ run, nodes, agentStates, workspaceRoot, ollama, sessions, onAuditorsChange, onConfigureLanes }: {
  run: RunSummary;
  nodes: ChangeNode[];
  agentStates: AgentWorkState[];
  workspaceRoot?: string;
  ollama?: OllamaSettingsView;
  sessions: string[];
  onAuditorsChange: (auditors: string[]) => Promise<void>;
  onConfigureLanes?: () => void;
}) {
  const [sessionError, setSessionError] = useState<string>();
  const [mintingFamily, setMintingFamily] = useState<string>();
  const [minted, setMinted] = useState<{ agent: string; command: string; copied: boolean }>();
  const [retiringAgent, setRetiringAgent] = useState<string>();
  const [copyFeedback, setCopyFeedback] = useState<{ agent: string; action: "attend" | "release"; result: "copied" | "failed" }>();
  const [expandedAgent, setExpandedAgent] = useState<string>();
  const [selectionBusy, setSelectionBusy] = useState<string>();
  const [selectionError, setSelectionError] = useState<string>();
  const [tick, setTick] = useState(Date.now());
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (feedbackTimer.current) clearTimeout(feedbackTimer.current); }, []);
  // El censo sale de la ejecución: una sesión ("claude:opus") sólo existe aquí
  // si alguien la nombró —como base, auditora, presente o asignataria—, que es
  // lo que permite al humano repartir papeles entre sesiones del mismo modelo.
  const roster = useMemo(() => runRoster(run, nodes, delegateLanes(ollama), sessions), [run, nodes, ollama, sessions]);
  const tree = useMemo(() => agentTree(roster), [roster]);
  const hasActiveAgent = agentStates.some((state) => state.phase === "executing" || state.phase === "reviewing");
  useEffect(() => {
    if (!hasActiveAgent) return undefined;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasActiveAgent]);
  if (!nodes.length) return null;
  const copyAttention = async (agent: string, action: "attend" | "release") => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      const text = action === "attend" ? agentAttentionCommand(agent, workspaceRoot) : agentAttentionReleaseCommand(run.id, agent);
      await navigator.clipboard.writeText(text);
      setCopyFeedback({ agent, action, result: "copied" });
    } catch {
      setCopyFeedback({ agent, action, result: "failed" });
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
  const auditorHint = selectionLocked
    ? "Auditores fijados; pausa la ejecución para cambiarlos"
    : reconfigurable
      ? "Ejecución pausada: reemplaza auditores sin perder cobertura publicada"
      : "Elige quién audita antes de aprobar";
  const toggleAuditor = async (agent: string, selected: boolean) => {
    const next = selected ? [...run.auditors, agent] : run.auditors.filter((candidate) => candidate !== agent);
    setSelectionBusy(agent);
    setSelectionError(undefined);
    try { await onAuditorsChange(next); }
    catch (cause) { setSelectionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSelectionBusy(undefined); }
  };
  // Acuñar y copiar en un gesto: el humano no teclea identidades y el comando
  // queda listo para pegarlo en la sesión que ya tiene abierta. El censo del
  // panel se refresca solo con el evento de difusión que emite el servidor.
  // Retirar sólo quita la identidad del censo del proyecto; el servidor la
  // rechaza si audita una ejecución viva o tiene nodos sin completar, y ese
  // mensaje es el que se enseña.
  const retireSession = async (agent: string) => {
    setRetiringAgent(agent);
    setSessionError(undefined);
    setMinted(undefined);
    try {
      const response = await fetch(`/api/projects/${run.projectId}/sessions/${encodeURIComponent(agent)}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `No se pudo retirar ${agent}`);
      }
    } catch (cause) {
      setSessionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRetiringAgent(undefined);
    }
  };

  const mintSession = async (family: string) => {
    setMintingFamily(family);
    setSessionError(undefined);
    setMinted(undefined);
    try {
      const response = await fetch(`/api/projects/${run.projectId}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ family }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "No se pudo acuñar la sesión");
      }
      const { agent } = await response.json() as { agent: string };
      const command = agentAttentionCommand(agent, workspaceRoot);
      let copied = true;
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
        await navigator.clipboard.writeText(command);
      } catch {
        copied = false;
      }
      setMinted({ agent, command, copied });
    } catch (cause) {
      setSessionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMintingFamily(undefined);
    }
  };
  const nodeLabel = (id: string) => {
    const node = nodes.find((candidate) => candidate.id === id);
    return node ? `${node.file} · ${node.symbol}` : id;
  };
  // Una identidad se pinta igual sea raíz de familia o sesión colgando de ella:
  // lo único que cambia es la sangría y que la sesión se anuncia como hija de
  // su modelo, para que el árbol se lea también sin ver la pantalla.
  const entry = (agent: string, family: string, isSession = false) => {
        const isBase = agent === run.baseAgent;
        // El trato especial del delegado vale para la familia y para cada
        // carril: ninguno abre sesión, así que su presencia es la API key.
        const isOllama = isDelegateAgent(agent);
        const lane = laneModel(agent);
        const session = agentSessionLabel(agent);
        const present = isBase || run.seenAgents.includes(agent) || (isOllama && Boolean(ollama?.configured));
        const { pending, implemented } = agentWorkload(nodes, agent, run.baseAgent);
        const state = agentStates.find((candidate) => candidate.agent === agent);
        const selectedAuditor = run.auditors.includes(agent);
        const elapsed = state && (state.phase === "executing" || state.phase === "reviewing") ? elapsedSince(state.startedAt, tick) : undefined;
        // La raíz delegada no puede vestirse de carril: cuando hay varios
        // modelos el suyo lo decide la dificultad de cada nodo, así que nombrar
        // uno mentiría, y cuando hay uno solo no existe carril que la repita.
        const delegateLabel = isOllama && !lane ? delegateSubtitle(ollama) : undefined;
        const presenceLabel = isBase ? "Modelo base"
          : isOllama ? (ollama?.configured ? `Ollama Cloud · ${lane ?? delegateLabel ?? ollama.model}` : "Sin API key configurada")
            : present ? "Presente" : "Sin señal";
        const attendResult = copyFeedback?.agent === agent && copyFeedback.action === "attend" ? copyFeedback.result : undefined;
        const releaseResult = copyFeedback?.agent === agent && copyFeedback.action === "release" ? copyFeedback.result : undefined;
        const attendLabel = attendResult === "copied"
          ? `Comando copiado para poner atención con ${agent}`
          : attendResult === "failed"
            ? `No se pudo copiar el comando para poner atención con ${agent}`
            : `Copiar comando para poner atención con ${agent}`;
        const releaseLabel = releaseResult === "copied"
          ? `Comando copiado para dejar de poner atención con ${agent}`
          : releaseResult === "failed"
            ? `No se pudo copiar el comando para dejar de poner atención con ${agent}`
            : `Copiar comando para dejar de poner atención con ${agent}`;
        return (
          <div
            className={`agent-dock-entry phase-${state?.phase ?? "idle"} ${isBase ? "is-base-agent" : ""} ${isSession ? "is-session" : ""}`}
            key={agent}
            role="group"
            aria-label={`${agent}${lane ? `, carril del modelo ${lane}` : isSession ? `, sesión de ${family}` : ""}${isBase ? ", modelo base" : ""}${selectedAuditor ? ", auditor" : ""}`}
          >
            <div className="agent-dock-row">
              <span className={`agent-presence-dot agent-presence-${present ? "present" : "absent"}`} role="img" aria-label={presenceLabel} title={presenceLabel}/>
              <span className="agent-dock-name" title={isBase ? `Modelo base (${agent}): controla los nodos sin asignar y coordina el cierre de la ejecución` : isOllama && ollama?.configured ? (lane ? `${agent}: carril del modelo ${lane}` : delegateLabel === "por dificultad" ? `${agent}: el modelo de cada operación lo decide su dificultad; cada modelo distinto es un carril propio` : `${agent} · ${delegateLabel ?? ollama.model}`) : session ? `${agent}: sesión ${session} del modelo ${agentFamily(agent)}` : agent}>
                <span className="agent-name-text">{session ? agentFamily(agent) : agent}</span>
                {session ? <small>{session}</small> : delegateLabel && <small>{delegateLabel}</small>}
              </span>
              {/* Dos cuentas, no una: la de pendientes cae a cero cuando el
                  agente termina su reparto, y sin la de implementadas la fila
                  del que hizo el trabajo se leía igual que la de quien no tocó
                  nada —sobre todo si su auditoría se quedó sin alcance por no
                  autocertificarse—. Lo implementado sólo aparece cuando existe:
                  un cero de más en un dock denso no dice nada. */}
              <span className="agent-dock-counts">
                {implemented > 0 && (
                  <span
                    className="agent-dock-count agent-dock-count-done"
                    title={`${agent} implementó ${implemented} ${implemented === 1 ? "operación" : "operaciones"} de esta ejecución`}
                    aria-label={`${implemented} ${implemented === 1 ? "operación implementada" : "operaciones implementadas"}`}
                  ><Icon name="check"/>{implemented}</span>
                )}
                <span
                  className="agent-dock-count"
                  title={`${pending} ${pending === 1 ? "operación pendiente" : "operaciones pendientes"} para ${agent}`}
                  aria-label={`${pending} ${pending === 1 ? "operación pendiente" : "operaciones pendientes"}`}
                >{pending}</span>
              </span>
              <span className="agent-attention-actions">
                {!isSession && !isOllama && (
                  <button
                    type="button"
                    className="agent-attention-button agent-mint-button"
                    disabled={mintingFamily === family}
                    aria-label={`Acuñar una sesión nueva de ${family} y copiar su comando`}
                    title={`Acuñar una sesión nueva de ${family} y copiar su comando para pegarlo en esa sesión`}
                    onClick={() => { mintSession(family).catch(() => undefined); }}
                  ><Icon name="plus"/></button>
                )}
                {/* La rama delegada tiene el mismo gesto con otro significado:
                    ollama no abre sesión, así que no hay identidad que acuñar
                    —el servidor lo rechaza—. Lo que sí crea un carril nuevo es
                    configurar otro modelo, y ahí lleva este botón. */}
                {!lane && isOllama && onConfigureLanes && (
                  <button
                    type="button"
                    className="agent-attention-button agent-mint-button"
                    aria-label="Configurar un modelo de ollama"
                    title="Cada modelo distinto es un carril propio: configura uno para que dos operaciones delegadas puedan correr a la vez"
                    onClick={onConfigureLanes}
                  ><Icon name="plus"/></button>
                )}
                {/* Sólo lo acuñado se retira: un carril delegado o una sesión
                    que la ejecución nombra por su cuenta no salen del censo. */}
                {isSession && sessions.includes(agent) && (
                  <button
                    type="button"
                    className="agent-attention-button agent-retire-button"
                    disabled={retiringAgent === agent}
                    aria-label={`Retirar la sesión ${agent} del proyecto`}
                    title={`Retirar la sesión ${agent}: sale del árbol y deja de recibir señal; no borra su trabajo`}
                    onClick={() => { retireSession(agent).catch(() => undefined); }}
                  ><Icon name="minus"/></button>
                )}
                {/* Poner o quitar atención es un comando que un humano pega en
                    una sesión abierta; lo delegado no tiene dónde pegarlo. */}
                {!isOllama && (
                  <>
                    <button
                      type="button"
                      className={`agent-attention-button ${attendResult ? `is-${attendResult}` : ""}`}
                      aria-label={attendLabel}
                      aria-live="polite"
                      title={attendLabel}
                      onClick={() => { copyAttention(agent, "attend").catch(() => undefined); }}
                    ><Icon name={attendResult === "copied" ? "check" : attendResult === "failed" ? "warning" : "bell"}/></button>
                    <button
                      type="button"
                      className={`agent-attention-button agent-attention-release ${releaseResult ? `is-${releaseResult}` : ""}`}
                      aria-label={releaseLabel}
                      aria-live="polite"
                      title={releaseLabel}
                      onClick={() => { copyAttention(agent, "release").catch(() => undefined); }}
                    ><Icon name={releaseResult === "copied" ? "check" : releaseResult === "failed" ? "warning" : "bellOff"}/></button>
                  </>
                )}
              </span>
            </div>
            <div className="agent-dock-subrow">
              <button type="button" className="agent-activity-row" disabled={!state} aria-expanded={expandedAgent === agent} onClick={() => setExpandedAgent((current) => current === agent ? undefined : agent)}>
                <i aria-hidden="true"/>
                <span>{state ? <><strong>{agentPhaseCopy[state.phase]}</strong> · {state.summary}</> : present ? "Conectado; sin actividad reportada" : "Sin actividad reportada"}</span>
                {state && state.total > 0 && <b>{state.completed}/{state.total}</b>}
                {elapsed && <time>{elapsed}</time>}
              </button>
              <label className="auditor-toggle" title={isOllama && !ollama?.configured ? "Configura Ollama Cloud antes de elegirlo" : selectionLocked ? "La selección se bloquea mientras la ejecución corre; pausa la ejecución para cambiarla" : reconfigurable ? `${selectedAuditor ? "Retirar" : "Añadir"} ${agent} en la auditoría; la cobertura ya publicada se conserva` : `${selectedAuditor ? "Quitar" : "Usar"} ${agent} como auditor`}>
                <input type="checkbox" aria-label={`Usar ${agent}${isOllama && ollama?.configured ? ` (${lane ?? delegateLabel ?? ollama.model})` : ""} como auditor`} checked={selectedAuditor} disabled={selectionLocked || Boolean(selectionBusy) || (isOllama && !ollama?.configured)} onChange={(event) => { toggleAuditor(agent, event.target.checked).catch(() => undefined); }}/>
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
  };

  return (
    <section className="agent-dock" aria-label="Agentes de la ejecución">
      <header className="agent-dock-head">
        <div><strong>Agentes</strong><span>{auditorHint}</span></div>
        <b>{run.auditors.length} aud.</b>
      </header>
      {selectionError && <p className="agent-dock-error" role="alert">{selectionError}</p>}
      {tree.map((branch) => {
        // Lo que cuelga de la familia delegada son carriles, no sesiones: el
        // contrato lo dice y el árbol tiene que decir lo mismo.
        const delegate = isDelegateAgent(branch.family);
        const noun = branch.sessions.length === 1
          ? (delegate ? "carril" : "sesión")
          : (delegate ? "carriles" : "sesiones");
        return (
          <div className="agent-dock-branch" key={branch.family} role="group" aria-label={`Modelo ${branch.family}${branch.sessions.length ? ` con ${branch.sessions.length} ${noun}` : ""}`}>
            {branch.root && entry(branch.root, branch.family)}
            {branch.sessions.length > 0 && (
              <div className="agent-dock-sessions" role="group" aria-label={`${delegate ? "Carriles" : "Sesiones"} de ${branch.family}`}>
                {branch.sessions.map((agent) => entry(agent, branch.family, true))}
              </div>
            )}
          </div>
        );
      })}
      {/* El rechazo del acuñado (familia inválida o delegada, proyecto ausente)
          se lee aquí: sin este párrafo la variable se escribía y nadie la veía. */}
      {sessionError && <p className="agent-dock-error" role="alert">{sessionError}</p>}
      {minted && (
        <p className="agent-dock-minted" role="status">
          Sesión <strong>{minted.agent}</strong> acuñada.{" "}
          {minted.copied
            ? "Comando copiado: pégalo en la sesión de ese modelo que ya tengas abierta."
            : "No se pudo copiar; cópialo a mano:"}
          {!minted.copied && <code>{minted.command}</code>}
        </p>
      )}
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
      {run.control === "active" && <button type="button" className="control-pause" title="Ningún agente podrá iniciar nodos nuevos; los nodos en curso terminan su ciclo" onClick={() => { setControl("paused").catch(() => undefined); }}>Pausar</button>}
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
          const resolutionNode = finding.resolutionNodeId ? nodes.find((candidate) => candidate.id === finding.resolutionNodeId) : undefined;
          const expanded = expandedId === finding.id;
          const terminal = finding.status === "accepted" || finding.status === "rejected";
          const requiredAgreementAgents = finding.requiredAgreementAgents ?? [];
          const agreedAgents = new Set((finding.agreements ?? []).map((agreement) => agreement.agent));
          const pendingAgreementAgents = requiredAgreementAgents.filter((agent) => !agreedAgents.has(agent));
          const agreementCount = requiredAgreementAgents.length - pendingAgreementAgents.length;
          const unanimousCopy = auditorIdentity(resolutionNode?.assignee) === auditorIdentity(finding.reviewer)
            ? `${finding.reviewer} puede implementar la corrección; otro modelo deberá auditarla.`
            : `La corrección permanece con ${resolutionNode?.assignee ?? "el modelo base"}; transferirla a ${finding.reviewer} requiere otro auditor independiente y una asignación compatible.`;
          return (
            <li key={finding.id} className={`finding-card status-${finding.status} ${finding.status === "escalated" ? "needs-human" : ""}`}>
              <button type="button" className="finding-summary" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? "" : finding.id)}>
                <span className={`severity-chip severity-${finding.severity}`}>{severityCopy[finding.severity]}</span>
                {finding.scope === "plan" && <span className="finding-scope">grafo</span>}
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
                  {requiredAgreementAgents.length > 0 && (
                    <p className={finding.unanimous ? "finding-resolution" : "finding-meta"}>
                      {finding.unanimous
                        ? `Acuerdo unánime (${agreementCount}/${requiredAgreementAgents.length}). ${unanimousCopy}`
                        : `Acuerdos ${agreementCount}/${requiredAgreementAgents.length} · Pendientes: ${pendingAgreementAgents.join(", ")}.`}
                    </p>
                  )}
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
  const [expandedRunLists, setExpandedRunLists] = useState<Record<string, boolean>>({});
  const isCollapsed = (id: string) => collapseOverrides[id] ?? (id !== projectId);
  const toggleCollapse = (id: string) => setCollapseOverrides((previous) => ({ ...previous, [id]: !isCollapsed(id) }));
  const toggleRunList = (id: string) => setExpandedRunLists((previous) => ({ ...previous, [id]: !(previous[id] ?? false) }));
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
          const runListExpanded = expandedRunLists[project.id] ?? false;
          const { visibleRuns, collapsedHiddenRuns, canToggleRuns } = resolveProjectRunListState(runs, { runId, expanded: runListExpanded });
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
                  {visibleRuns.map((run) => (
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
                  {canToggleRuns && (
                    <li className="tree-more-row">
                      <button type="button" className={`tree-show-more ${runListExpanded ? "is-expanded" : ""}`} aria-expanded={runListExpanded} onClick={() => toggleRunList(project.id)}>
                        {runListExpanded ? "Mostrar menos" : "Mostrar más"}
                        {!runListExpanded && <span>{collapsedHiddenRuns}</span>}
                      </button>
                    </li>
                  )}
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
  const [attribution, setAttribution] = useState<FileAttribution[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [view, setView] = useState<GraphView>("map");
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [buildStale, setBuildStale] = useState(false);
  const [ollama, setOllama] = useState<OllamaSettingsView>();
  const [uiPreferences, setUiPreferences] = useState<UiPreferences>(DEFAULT_UI_PREFERENCES);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [projectSessions, setProjectSessions] = useState<string[]>([]);
  // La configuración se abre desde su propio botón y también desde el + de la
  // rama de ollama, que vive en la otra columna del panel.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // La selección para asignar por lote: ids elegidos, lo que el último lote no
  // pudo cambiar y el error del servidor si lo hubo.
  const [picked, setPicked] = useState<string[]>([]);
  const [skippedAssignments, setSkippedAssignments] = useState<{ id: string; reason: string }[]>([]);
  const [selectionError, setSelectionError] = useState<string>();
  const [assigningSelection, setAssigningSelection] = useState(false);
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

  // Sesiones acuñadas del proyecto: viven fuera de la ejecución, así que se
  // cargan al seleccionar proyecto y se refrescan con la misma difusión. Sin
  // esto, una sesión acuñada sólo existiría en la pestaña que la acuñó.
  const loadProjectSessions = useCallback(async (id: string) => {
    if (!id) { setProjectSessions([]); return; }
    try {
      const response = await fetch(`/api/projects/${id}/sessions`);
      if (!response.ok) throw new Error("No se pudieron cargar las sesiones del proyecto");
      const payload = await response.json() as { sessions?: string[] };
      setProjectSessions(payload.sessions ?? []);
    } catch {
      // El árbol sigue mostrando el censo que deriva de la ejecución.
      setProjectSessions([]);
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
      // La atribución es informativa: si el servicio corre un build anterior y
      // no expone la ruta, el panel sigue funcionando sin el aviso.
      fetch(`/api/runs/${id}/attribution`)
        .then((result) => result.ok ? result.json() as Promise<{ files?: FileAttribution[] }> : { files: [] })
        .then((report) => setAttribution(report.files ?? []))
        .catch(() => setAttribution([]));
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

  const loadUiPreferences = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/ui");
      if (response.ok) setUiPreferences(await response.json() as UiPreferences);
    } catch { /* los defaults locales mantienen usable la navegación */ }
  }, []);

  const saveUiPreferences = useCallback(async (next: UiPreferences) => {
    const previous = uiPreferences;
    setUiPreferences(next);
    try {
      const response = await fetch("/api/settings/ui", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "No se pudo guardar la configuración de interfaz");
      }
      setUiPreferences(await response.json() as UiPreferences);
    } catch (cause) {
      setUiPreferences(previous);
      throw cause;
    }
  }, [uiPreferences]);

  const loadHealth = useCallback(async () => {
    try {
      const response = await fetch("/api/health");
      if (response.ok) setBuildStale((await response.json() as Health).buildStale === true);
    } catch { /* una interrupción de red ya queda representada por connectionState */ }
  }, []);

  useEffect(() => { loadCatalog().catch((cause) => setError(String(cause))); }, [loadCatalog]);
  useEffect(() => { loadOllama().catch(() => undefined); }, [loadOllama]);
  useEffect(() => { loadUiPreferences().catch(() => undefined); }, [loadUiPreferences]);
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
  useEffect(() => { loadProjectSessions(projectId).catch(() => undefined); }, [projectId, loadProjectSessions]);

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
      loadProjectSessions(visibleProjectId).catch(() => undefined);
      if (shouldReloadDetail) loadDetail(visibleRunId).catch(() => undefined);
    });
    source.onerror = () => setConnectionState("offline");
    return () => source.close();
  }, [loadCatalog, loadDetail, loadProjectSessions]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (projectId) params.set("project", projectId);
    if (runId) params.set("run", runId);
    history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }, [projectId, runId]);

  const assignAgent = useCallback(async (nodeId: string, assignee: string | null) => {
    if (!runId) return;
    const response = await fetch(`/api/runs/${runId}/nodes/${nodeId}/assign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assignee }) });
    // El alta de sesión asigna con una identidad escrita a mano: si el servidor
    // la rechaza, el humano tiene que leer por qué en vez de ver que no pasa nada.
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? "No se pudo asignar la operación");
    }
    await loadDetail(runId);
  }, [runId, loadDetail]);

  const runPaused = detail?.run.control === "paused";
  const pickFile = useCallback((file: string) => {
    setPicked((current) => toggleSelection(current, fileSelection(detail?.nodes ?? [], file, runPaused)));
  }, [detail?.nodes, runPaused]);
  const pickBranch = useCallback((nodeId: string) => {
    setPicked((current) => toggleSelection(current, branchSelection(detail?.nodes ?? [], nodeId, runPaused)));
  }, [detail?.nodes, runPaused]);
  const clearSelection = useCallback(() => {
    setPicked([]);
    setSkippedAssignments([]);
    setSelectionError(undefined);
  }, []);
  // La selección pertenece a la ejecución que se está mirando: arrastrarla a
  // otra asignaría operaciones que el humano ya no tiene enfrente.
  useEffect(() => { clearSelection(); }, [runId, clearSelection]);

  const assignSelection = useCallback(async (assignee: string | null) => {
    if (!runId || !picked.length) return;
    setAssigningSelection(true);
    setSelectionError(undefined);
    try {
      const response = await fetch(`/api/runs/${runId}/assign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeIds: picked, assignee }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; skipped?: { id: string; reason: string }[] };
      if (!response.ok) {
        setSelectionError(body.error ?? "No se pudo asignar el lote");
        return;
      }
      // Lo omitido sobrevive a la limpieza de la selección: es lo único que le
      // explica al humano por qué el lote aplicó a medias.
      setSkippedAssignments(body.skipped ?? []);
      setPicked([]);
      await loadDetail(runId);
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : "No se pudo asignar el lote");
    } finally {
      setAssigningSelection(false);
    }
  }, [runId, picked, loadDetail]);

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

  const laneIds = useMemo(() => delegateLanes(ollama), [ollama]);
  const roster = useMemo(
    () => detail?.run ? runRoster(detail.run, detail.nodes, laneIds, projectSessions) : laneIds,
    [detail?.run, detail?.nodes, laneIds, projectSessions],
  );
  const graph = useMemo(() => layoutGraph(detail?.nodes ?? [], selectedId, detail?.run, ollama?.configured ?? false, roster, setSelectedId, (nodeId, assignee) => { assignAgent(nodeId, assignee).catch(() => undefined); }, picked, pickFile, pickBranch), [detail?.nodes, detail?.run, selectedId, ollama?.configured, roster, assignAgent, picked, pickFile, pickBranch]);

  // El layout se re-acomoda cuando aparecen o desaparecen nodos (descubiertos,
  // grafo republicado) y el contenido puede quedar fuera del viewport: reencuadra
  // solo cuando cambia el conjunto de ids, no en cada refresco de estado.
  const nodeSetKey = useMemo(() => (detail?.nodes ?? []).map((node) => node.id).sort().join("|"), [detail?.nodes]);
  const flowMounted = isGraphFlowMounted(view, detail?.nodes.length);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcutsAvailable = Boolean(runId && detail);
      const isViewShortcut = shortcutsAvailable && isViewShortcutEvent({ event, preferences: uiPreferences });
      const nextView = isViewShortcut
        ? resolveViewShortcut({ currentView: view, event, preferences: uiPreferences })
        : null;
      if (nextView) {
        event.preventDefault();
        hideGraphMagnifier();
        setView(nextView);
        return;
      }
      if (isViewShortcut) {
        event.preventDefault();
        return;
      }
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
  }, [detail, hideGraphMagnifier, refreshGraphPointer, runId, showGraphMagnifier, uiPreferences, view]);
  const applyGraphViewport = useCallback((duration = 320) => {
    const instance = flowInstance.current;
    if (!instance) return;
    const action = decideGraphViewportAction({ appliedKey: appliedGraphViewportKey.current, nodeSetKey, runId, saved: graphViewports.current.get(runId) });
    if (action.kind === "skip") return;
    cancelPendingGraphFit();
    if (action.kind === "restore") {
      appliedGraphViewportKey.current = action.graphKey;
      void instance.setViewport(action.viewport, { duration: 0 });
      return;
    }
    // fitView no encuadra por sí mismo en un montaje controlado: encola el
    // encuadre y el lote lo entrega dentro de un requestAnimationFrame que una
    // pestaña sin pintado nunca ejecuta. Calculamos el viewport y lo aplicamos
    // con setViewport, que sí transforma en el acto, y sólo entonces damos la
    // clave por aplicada: un encuadre descartado debe poder reintentarse.
    let cancelled = false;
    let timer = 0;
    const attempt = (index: number) => {
      if (cancelled) return;
      const current = flowInstance.current;
      const size = flowWrapRef.current?.getBoundingClientRect();
      const nodes = current?.getNodes() ?? [];
      const measured = graphNodesMeasured(nodes);
      const decision = decideGraphFit({
        attempt: index,
        bounds: current && measured ? current.getNodesBounds(nodes) : undefined,
        documentHidden: document.hidden,
        duration,
        measured,
        size,
      });
      if (decision.kind === "apply" && current) {
        appliedGraphViewportKey.current = action.graphKey;
        void current.setViewport(decision.viewport, { duration: decision.duration });
        return;
      }
      if (decision.kind === "retry") timer = window.setTimeout(() => attempt(index + 1), decision.delay);
    };
    timer = window.setTimeout(() => attempt(0), 0);
    const cancel = () => {
      cancelled = true;
      window.clearTimeout(timer);
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
  const liveFindingsCount = detail?.findings.filter((finding) => liveFindingStatuses.includes(finding.status)).length ?? 0;
  const escalatedImplementationFindings = detail?.findings.filter((finding) => finding.scope !== "plan" && finding.status === "escalated") ?? [];
  const auditorsReady = Boolean(detail?.run.auditors.length) && (!detail?.run.auditors.includes("ollama") || Boolean(ollama?.configured));
  const globalPending = useMemo(() => globalPendingEntries(catalog.projects), [catalog.projects]);
  const graphMagnifierStyle: CSSProperties = {
    left: graphMagnifier.x,
    top: graphMagnifier.y,
    width: graphMagnifierSize,
    height: graphMagnifierSize,
  };
  const graphMagnifierTransform = magnifierContentTransform({
    height: graphMagnifier.height,
    lensSize: graphMagnifierSize,
    pointerX: graphMagnifier.x,
    pointerY: graphMagnifier.y,
    targetScale: graphMagnifierTargetScale,
    viewport: graphViewport,
    width: graphMagnifier.width,
  });
  const graphMagnifierContentStyle: CSSProperties = {
    width: graphMagnifierTransform.width,
    height: graphMagnifierTransform.height,
    transform: graphMagnifierTransform.transform,
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
  if (loadingCatalog) return <><TopBar connectionState={connectionState} buildStale={buildStale} ollama={ollama} uiPreferences={uiPreferences} onOllamaSaved={() => { loadOllama().catch(() => undefined); }} onUiPreferencesSaved={saveUiPreferences} settingsOpen={settingsOpen} onSettingsOpenChange={setSettingsOpen}/><LoadingState label="Cargando proyectos"/></>;
  if (!catalog.projects.length) return <><TopBar connectionState={connectionState} buildStale={buildStale} ollama={ollama} uiPreferences={uiPreferences} onOllamaSaved={() => { loadOllama().catch(() => undefined); }} onUiPreferencesSaved={saveUiPreferences} settingsOpen={settingsOpen} onSettingsOpenChange={setSettingsOpen}/><EmptyState kind="projects"/></>;

  return (
    <div className="app-shell">
      <TopBar connectionState={connectionState} buildStale={buildStale} project={project} run={detail?.run} progress={progress} ollama={ollama} uiPreferences={uiPreferences} pendingEntries={globalPending} currentRunId={runId} onPendingOpenRun={(nextProjectId, nextRunId) => { setProjectId(nextProjectId); setRunId(nextRunId); }} onPendingControl={setRunControl} onOllamaSaved={() => { loadOllama().catch(() => undefined); }} onUiPreferencesSaved={saveUiPreferences} settingsOpen={settingsOpen} onSettingsOpenChange={setSettingsOpen}/>
      <div className="app-body">
        <ProjectTree
          projects={catalog.projects}
          projectId={projectId}
          runId={runId}
          agentDock={!loadingRun && detail?.run.id === runId ? <AgentDock run={detail.run} nodes={detail.nodes} agentStates={detail.agentStates} workspaceRoot={project?.workspaceRoot} ollama={ollama} sessions={projectSessions} onAuditorsChange={updateAuditors} onConfigureLanes={() => setSettingsOpen(true)}/> : undefined}
          onProject={(nextProject) => { setProjectId(nextProject.id); setRunId(sortRuns(nextProject.runs)[0]?.id ?? ""); }}
          onRun={(nextProjectId, nextRunId) => { setProjectId(nextProjectId); setRunId(nextRunId); }}
          onDeleteProject={(target) => { deleteProject(target).catch(() => undefined); }}
          onDeleteRun={(target) => { deleteRun(target).catch(() => undefined); }}
        />
        <div className="content-shell">
          <div className="content-toolbar">
            <div className="current-context"><Icon name="route"/><span>{detail?.run.title ?? "Sin ejecución seleccionada"}</span></div>
            <nav aria-label="Vista principal"><button aria-pressed={view === "map"} className={view === "map" ? "active" : ""} onClick={() => setView("map")}><Icon name="route"/>Mapa</button><button aria-pressed={view === "activity"} className={view === "activity" ? "active" : ""} onClick={() => setView("activity")}><Icon name="activity"/>Actividad</button><button aria-pressed={view === "findings"} className={view === "findings" ? "active" : ""} onClick={() => setView("findings")}><Icon name="warning"/>Hallazgos{liveFindingsCount > 0 && <span className="nav-findings-count">{liveFindingsCount}</span>}</button></nav>
          </div>
          {loadingRun ? <LoadingState label="Cargando ejecución"/> : !runId || !detail ? <EmptyState kind="runs"/> : (
            <main className="workspace">
              <section className="map-stage" aria-label={view === "map" ? "Mapa de cambios" : "Actividad de la ejecución"}>
                <header className="stage-head">
                  <div>
                    <h1>{detail.run.title}</h1>
                    <p>{detail.run.requirement}</p>
                    {detail.run.changeBranch && (
                      <span
                        className="activity-agent"
                        title={`Branch de salvaguarda: ${detail.run.changeBranch}`}
                        aria-label={`Branch de salvaguarda: ${detail.run.changeBranch}`}
                      >branch {detail.run.changeBranch}</span>
                    )}
                  </div>
                  <div className="stage-actions">
                    <RunControls run={detail.run} onChanged={() => { loadDetail(detail.run.id).catch(() => undefined); }}/>
                    <div className="stage-count"><strong>{detail.run.completedCount}/{detail.run.nodeCount}</strong><span>operaciones terminadas</span></div>
                  </div>
                </header>
                {detail.run.control !== "active" && (
                  <div className={`control-banner control-banner-${detail.run.control}`} role="status">
                    <Icon name={detail.run.control === "paused" ? "clock" : "warning"}/>
                    <p>{detail.run.control === "paused"
                      ? "Ejecución pausada: ningún agente puede iniciar nodos hasta que la reanudes; los nodos en curso terminan su ciclo."
                      : "Ejecución detenida: los agentes no pueden iniciar más nodos y deben cerrar ordenadamente. Puedes reanudarla cuando quieras."}</p>
                  </div>
                )}
                {unapprovedCount > 0 && (
                  <div className="approval-banner" role="status">
                    <Icon name="warning"/>
                    <p>{unapprovedCount === 1 ? "1 operación espera tu aprobación." : `${unapprovedCount} operaciones esperan tu aprobación.`} {detail.run.auditors.includes("ollama") && !ollama?.configured ? "Configura Ollama Cloud o elige otro auditor antes de iniciar." : !detail.run.auditors.length ? "Elige al menos un auditor en la columna izquierda para iniciar." : ""}</p>
                    <button type="button" disabled={!auditorsReady} onClick={() => { approveAll().catch(() => undefined); }}>Aprobar grafo</button>
                    <button type="button" disabled={!auditorsReady} className="approve-paused" title="Autoriza el plan pero deja la ejecución en pausa: asigna nodos y conecta agentes con calma, y reanuda cuando todo esté listo" onClick={() => { approveAll(true).catch(() => undefined); }}>Aprobar en pausa</button>
                    {approveError && <p className="approve-error" role="alert">{approveError}</p>}
                  </div>
                )}
                {escalatedImplementationFindings.length > 0 && view !== "findings" && (
                  <div className="approval-banner findings-banner" role="status">
                    <Icon name="warning"/>
                    <p>{escalatedImplementationFindings.length === 1 ? "1 hallazgo del debate espera tu arbitraje." : `${escalatedImplementationFindings.length} hallazgos del debate esperan tu arbitraje.`} Los modelos no llegaron a acuerdo.</p>
                    <button type="button" onClick={() => setView("findings")}>Ver hallazgos</button>
                  </div>
                )}
                {view === "findings" ? (
                  <FindingsPanel findings={detail.findings} nodes={detail.nodes} runId={detail.run.id} onChanged={() => { loadDetail(detail.run.id).catch(() => undefined); }} onSelectNode={(id) => { setSelectedId(id); setView("map"); }}/>
                ) : view === "map" ? (
                  detail.nodes.length ? <div className={`flow-wrap ${graphMagnifier.active ? "is-magnifying" : ""}`} ref={setFlowWrapElement} onPointerEnter={enterGraphMagnifier} onPointerMove={updateGraphMagnifier} onPointerLeave={leaveGraphMagnifier}>
                    <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false} onInit={(instance) => { flowInstance.current = instance; updateGraphViewport(instance.getViewport()); appliedGraphViewportKey.current = ""; applyGraphViewport(0); }} onViewportChange={updateGraphViewport} onMoveStart={(event) => { if (event) { graphViewportUserMoved.current = true; cancelPendingGraphFit(); } }} onMoveEnd={(_event, viewport) => { updateGraphViewport(viewport); if (shouldPersistGraphViewport({ nodeSetKey, runId, userMoved: graphViewportUserMoved.current })) graphViewports.current.set(runId, { nodeSetKey, viewport }); graphViewportUserMoved.current = false; }} onNodeClick={(_event, node) => setSelectedId(node.id)} onPaneClick={() => setSelectedId("")} ariaLabelConfig={graphAriaLabels} minZoom={graphMinZoom} maxZoom={graphMaxZoom} proOptions={{ hideAttribution: true }}><Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#aab5af"/><Controls showInteractive={false} aria-label="Controles del mapa"/></ReactFlow>
                    <div
                      className="selection-layer"
                      onPointerEnter={(event) => { event.stopPropagation(); leaveGraphMagnifier(); }}
                      onPointerMove={(event) => event.stopPropagation()}
                    >
                      <SelectionBar
                        count={picked.length}
                        roster={roster}
                        baseAgent={detail.run.baseAgent}
                        seenAgents={detail.run.seenAgents}
                        ollamaConfigured={ollama?.configured ?? false}
                        skipped={skippedAssignments}
                        error={selectionError}
                        busy={assigningSelection}
                        onAssign={(assignee) => { assignSelection(assignee).catch(() => undefined); }}
                        onClear={clearSelection}
                      />
                    </div>
                    {graphMagnifier.active && (
                      <div className="graph-magnifier" style={graphMagnifierStyle} aria-hidden="true" inert>
                        <div className="graph-magnifier__content" style={graphMagnifierContentStyle}>
                          <ReactFlow className="graph-magnifier__flow" nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false} viewport={graphViewport} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} panOnDrag={false} panOnScroll={false} preventScrolling={false} ariaLabelConfig={graphAriaLabels} minZoom={graphMinZoom} maxZoom={graphMaxZoom} proOptions={{ hideAttribution: true }}><Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#aab5af"/></ReactFlow>
                        </div>
                      </div>
                    )}
                  </div>
                    : <div className="map-empty"><Icon name="route"/><h2>El mapa aún no ha sido publicado</h2><p>La ejecución existe, pero el agente todavía no declaró sus operaciones.</p>{publishedActivity > 0 && <button type="button" className="map-empty-cta" onClick={() => setView("activity")}><Icon name="activity"/>{publishedActivity === 1 ? "Ver 1 evento publicado en Actividad" : `Ver ${publishedActivity} eventos publicados en Actividad`}</button>}</div>
                ) : <ActivityLedger activity={detail.activity} nodes={detail.nodes} onSelect={(id) => { setSelectedId(id); setView("map"); }}/>} 
              </section>
              <Inspector node={selectedNode} nodes={detail.nodes} activity={detail.activity} runId={detail.run.id} runControl={detail.run.control} attribution={attribution} baseAgent={detail.run.baseAgent} seenAgents={detail.run.seenAgents} ollamaConfigured={ollama?.configured ?? false} roster={roster} canApprove={auditorsReady} onChanged={() => { loadDetail(detail.run.id).catch(() => undefined); }}/>
            </main>
          )}
        </div>
      </div>
    </div>
  );
}

// Abre por su cuenta desde el botón de la barra, pero acepta control externo:
// el + de la rama de ollama vive en la otra columna y necesita abrir este panel.
export function OllamaSettingsPanel({ ollama, uiPreferences, onSaved, onUiPreferencesSaved, open: controlledOpen, onOpenChange }: {
  ollama?: OllamaSettingsView;
  uiPreferences: UiPreferences;
  onSaved?: () => void;
  onUiPreferencesSaved: (next: UiPreferences) => Promise<void>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = useCallback((next: boolean | ((value: boolean) => boolean)) => {
    const resolve = (value: boolean) => typeof next === "function" ? next(value) : next;
    if (controlledOpen === undefined) setUncontrolledOpen(resolve);
    else onOpenChange?.(resolve(controlledOpen));
  }, [controlledOpen, onOpenChange]);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  // Roster editable por dificultad. 'hard' no aparece: esa dificultad no se
  // delega, se queda con el modelo base de la ejecución.
  const [tiers, setTiers] = useState<Record<string, string>>({});
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
    setTiers({ trivial: ollama?.tiers?.trivial ?? "", standard: ollama?.tiers?.standard ?? "" });
    setFeedback(undefined);
  }, [open, ollama]);
  const submit = async (body: Record<string, unknown>, confirmation: string) => {
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
    const body: Record<string, unknown> = {};
    if (apiKey.trim()) body.apiKey = apiKey.trim();
    if (model.trim()) body.model = model.trim();
    if (baseUrl.trim()) body.baseUrl = baseUrl.trim();
    // Sólo viajan los niveles que cambiaron; la cadena vacía borra el nivel
    // para que vuelva a heredar el modelo por defecto.
    const changedTiers = Object.fromEntries(Object.entries(tiers)
      .filter(([difficulty, value]) => value.trim() !== (ollama?.tiers?.[difficulty as "trivial" | "standard"] ?? ""))
      .map(([difficulty, value]) => [difficulty, value.trim()]));
    if (Object.keys(changedTiers).length) body.tiers = changedTiers;
    if (!Object.keys(body).length) { setFeedback({ kind: "error", text: "No hay cambios que guardar." }); return; }
    submit(body, "Configuración guardada.").catch(() => undefined);
  };
  const saveViewShortcuts = async (patch: Partial<UiPreferences["viewShortcuts"]>) => {
    setSaving(true);
    setFeedback(undefined);
    try {
      await onUiPreferencesSaved({
        ...uiPreferences,
        viewShortcuts: { ...uiPreferences.viewShortcuts, ...patch },
      });
      setFeedback({ kind: "ok", text: "Atajos actualizados." });
    } catch (cause) {
      setFeedback({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="settings-wrap">
      <button type="button" className="settings-toggle" aria-expanded={open} aria-label="Configuración" title="Configuración" onClick={() => setOpen((value) => !value)}>
        <Icon name="sliders"/>
        <span className={`settings-state settings-state-${ollama?.configured ? "on" : "off"}`} aria-hidden="true"/>
      </button>
      {open && (
        <>
          <div className="settings-backdrop" onClick={() => setOpen(false)}/>
          <section className="settings-panel" role="dialog" aria-label="Configuración de HRP">
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
            <div className="settings-section">
              <h3>Modelo por dificultad</h3>
              <p className="settings-hint">Cada modelo distinto es un carril propio: dos operaciones delegadas sólo corren a la vez si las ataca un modelo diferente. Un nivel vacío hereda el modelo de arriba.</p>
              {(["trivial", "standard"] as const).map((difficulty) => (
                <label className="settings-field" key={difficulty}>
                  <span>{difficultyCopy[difficulty]}</span>
                  <input
                    type="text"
                    value={tiers[difficulty] ?? ""}
                    placeholder={`Hereda ${ollama?.model ?? "el modelo por defecto"}`}
                    onChange={(event) => setTiers((current) => ({ ...current, [difficulty]: event.target.value }))}
                  />
                </label>
              ))}
              <p className="settings-hint">La dificultad «{difficultyCopy.hard}» no se delega: esas operaciones se quedan con el modelo base de la ejecución.</p>
            </div>
            <div className="settings-section shortcut-settings">
              <h3>Atajos de vistas</h3>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={uiPreferences.viewShortcuts.enabled}
                  disabled={saving}
                  onChange={(event) => { saveViewShortcuts({ enabled: event.target.checked }).catch(() => undefined); }}
                />
                <span>Flechas izquierda/derecha cambian Mapa, Actividad y Hallazgos</span>
              </label>
              <div className="shortcut-options" role="group" aria-label="Modificador de atajos de vistas">
                {([
                  ["meta", "Command"],
                  ["ctrl", "Ctrl"],
                  ["either", "Ambos"],
                ] as const).map(([modifier, label]) => (
                  <button
                    key={modifier}
                    type="button"
                    className={uiPreferences.viewShortcuts.modifier === modifier ? "active" : ""}
                    disabled={saving}
                    aria-pressed={uiPreferences.viewShortcuts.modifier === modifier}
                    onClick={() => { saveViewShortcuts({ modifier: modifier as ViewShortcutModifier }).catch(() => undefined); }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
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
              <li>En la cajita del nodo elige quién lo implementa: claude, codex, antigravity, un carril de ollama o una sesión por modelo (<code>claude:opus</code>).</li>
              <li>¿Repartes papeles entre sesiones del mismo modelo? Pulsa <strong>+</strong> en la fila del modelo: HRP acuña la sesión (<code>claude:2</code>) y copia su comando. Pégalo en cualquier sesión de ese modelo que ya tengas abierta y aparecerá colgando de él en el árbol. Si vas a abrir una terminal nueva, <code>HRP_AGENT=claude:2</code> es más sólido: cubre también hooks y MCP.</li>
              <li>En el dock de agentes (abajo a la izquierda) pulsa el icono de copiar junto a ese modelo.</li>
              <li>Pega el comando en la sesión de ese modelo. Su punto se pone verde al engancharse y trabajará solo sus nodos.</li>
            </ol>
            <h3>¿Un agente actúa «a la antigua»?</h3>
            <p>Las sesiones abiertas conservan la skill con la que arrancaron. Si un agente no continúa solo tras tu aprobación, no declara identidad o queda naranja mientras trabaja, escríbele: <em>«vuelve a leer la skill de hrp antes de continuar»</em>. Las conversaciones nuevas siempre nacen con la skill al día; <code>./scripts/update.sh</code> actualiza HRP y las skills de los tres modelos.</p>
            <h3>Tips</h3>
            <ul>
              <li>Nada se ejecuta sin tu aprobación; los nodos descubiertos también pasan por el gate.</li>
              <li>HRP permite nodos compatibles en paralelo; si comparten archivo, contexto o rama, los agentes esperan la siguiente señal.</li>
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
  // Las identidades de las que hay que pedir señal salen de las propias
  // ejecuciones pendientes: con sesiones por modelo, una lista fija de familias
  // dejaría fuera justo a la sesión que tiene trabajo.
  const pendingAgentKey = useMemo(
    () => [...new Set(entries.flatMap((entry) => runRoster(entry.run)))].sort().join("|"),
    [entries],
  );
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
    Promise.all(pendingAgentKey.split("|").map(async (agent) => {
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
  }, [open, pendingRunKey, pendingAgentKey]);
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

function TopBar({ connectionState, buildStale, project, run, progress = 0, ollama, uiPreferences, pendingEntries = [], currentRunId = "", onPendingOpenRun, onPendingControl, onOllamaSaved, onUiPreferencesSaved, settingsOpen, onSettingsOpenChange }: {
  connectionState: ConnectionState;
  buildStale: boolean;
  project?: Project;
  run?: RunSummary;
  progress?: number;
  ollama?: OllamaSettingsView;
  uiPreferences: UiPreferences;
  pendingEntries?: GlobalPendingEntry[];
  currentRunId?: string;
  onPendingOpenRun?: (projectId: string, runId: string) => void;
  onPendingControl?: (run: RunSummary, control: "active" | "paused" | "stopped") => Promise<void>;
  onOllamaSaved?: () => void;
  onUiPreferencesSaved: (next: UiPreferences) => Promise<void>;
  settingsOpen?: boolean;
  onSettingsOpenChange?: (open: boolean) => void;
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
        <OllamaSettingsPanel ollama={ollama} uiPreferences={uiPreferences} onSaved={onOllamaSaved} onUiPreferencesSaved={onUiPreferencesSaved} open={settingsOpen} onOpenChange={onSettingsOpenChange}/>
        <HelpPanel/>
      </div>
      <span className={`connection ${connectionClass}`} role="status" title={buildStale ? "El build cambió. Ejecuta ./scripts/update.sh para reiniciar el servicio." : undefined}><i/>{connectionCopy}{!buildStale && connectionState === "offline" && <button type="button" onClick={() => location.reload()}>Reintentar</button>}</span>
    </header>
  );
}
