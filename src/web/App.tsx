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
import {
  DEFAULT_UI_PREFERENCES,
  attentionCommand,
  isLiveFinding,
  runnerCommand,
  type Activity,
  type ChangeNode,
  type Finding,
  type NodeStatus,
  type Project,
  type RunDetail,
  type RunPhase,
  type RunSummary,
  type Session,
  type UiPreferences,
  type ViewShortcutModifier,
} from "../shared/protocol";
import type { EvolutionData, EvolutionFileChange, EvolutionFileContent, EvolutionFileStatus } from "../shared/evolution";
import { collectCatalogRunIds, resolveCatalogChange, resolveCatalogRunFocus, type CatalogChange, type CatalogRunFocus } from "./catalog-focus";
import { decideGraphFit, decideGraphViewportAction, graphMaxZoom, graphMinZoom, graphNodesMeasured, isGraphFlowMounted, magnifierContentTransform, shouldPersistGraphViewport, type GraphView, type StoredGraphViewport } from "./graph-viewport";
import { buildEvolutionTree, evolutionHighlights, expandedDirectories, filesAtFrame, frameIndexForNode, highlightLevel, type EvolutionHighlight, type EvolutionTreeNode } from "./evolution-tree";
import { alignLines, diffRowCounts, type DiffRow } from "./line-diff";
import { resolveProjectRunListState } from "./project-tree-runs";
import { highlightLines } from "./syntax";
import { isViewShortcutEvent, resolveViewShortcut, resolveEvolutionFrameShortcut } from "./view-shortcuts";

type ProjectWithRuns = Project & { runs: RunSummary[] };
type Catalog = { projects: ProjectWithRuns[] };
type Health = { buildStale?: boolean };
type ConnectionState = "connecting" | "connected" | "offline";
type CatalogLoadOptions = { focus?: CatalogRunFocus; visibleProjectId?: string };
type View = GraphView;
type GlobalPendingEntry = { project: ProjectWithRuns; run: RunSummary; reasons: string[]; priority: number };
type AttentionSignal = { runId: string; session: string; kind: string; directive: string; actionable: boolean; waiting: boolean; terminal: boolean };
type GraphMagnifierState = { active: boolean; x: number; y: number; width: number; height: number };
type GraphPointerState = Omit<GraphMagnifierState, "active"> & { inside: boolean; clientX: number; clientY: number };
type MapNodeData = { change: ChangeNode; isSelected: boolean; onSelect: (id: string) => void };
type EvolutionState = { runId: string; data: EvolutionData };

const changeNodeWidthFallback = 272;
const changeNodeLayoutHeightFallback = 196;
const graphMagnifierTargetScale = 1.45;
const graphMagnifierFramePadding = 48;
const graphMagnifierSize = 2 * Math.ceil((changeNodeWidthFallback * graphMagnifierTargetScale + graphMagnifierFramePadding) / 2);
const uiPreferencesKey = "hrp.ui-preferences";
const inspectorCollapsedKey = "hrp.inspector-collapsed";

function readInspectorCollapsed(): boolean {
  try { return localStorage.getItem(inspectorCollapsedKey) === "true"; } catch { return false; }
}

function readCssPixels(property: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(property));
  return Number.isFinite(value) ? value : fallback;
}

function readUiPreferences(): UiPreferences {
  try {
    const raw = localStorage.getItem(uiPreferencesKey);
    if (!raw) return DEFAULT_UI_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<UiPreferences>;
    return { viewShortcuts: { ...DEFAULT_UI_PREFERENCES.viewShortcuts, ...(parsed.viewShortcuts ?? {}) } };
  } catch {
    return DEFAULT_UI_PREFERENCES;
  }
}

const statusCopy: Record<NodeStatus, string> = { running: "En curso", completed: "Terminado", failed: "Falló" };
const phaseCopy: Record<RunPhase, string> = { open: "Implementando", hold: "En hold", implemented: "Implementado · por auditar", closed: "Cerrado" };
const phaseRank: Record<RunPhase, number> = { hold: 0, open: 1, implemented: 2, closed: 3 };
const severityCopy: Record<Finding["severity"], string> = { critical: "crítico", major: "mayor", minor: "menor", question: "duda" };
const findingStatusCopy: Record<Finding["status"], string> = { open: "abierto", debating: "en debate", accepted: "aceptado", rejected: "rechazado", escalated: "esperando tu arbitraje" };
const scopeCopy: Record<Finding["scope"], string> = { requirement: "requerimiento", node: "nodo", integration: "integración" };
const fileStatusCopy: Record<EvolutionFileStatus, string> = { A: "creado", M: "modificado", D: "borrado", R: "renombrado" };

function sessionLabel(session: string): string {
  const separator = session.indexOf(":");
  return separator === -1 ? session : `${session.slice(0, separator)} · ${session.slice(separator + 1)}`;
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
}

function sortRuns(runs: RunSummary[]): RunSummary[] {
  return [...runs].sort((left, right) => phaseRank[left.phase] - phaseRank[right.phase]
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function unauditedRuns(project: ProjectWithRuns): number {
  return project.runs.filter((run) => run.status === "implemented" && run.control !== "stopped").length;
}

function openFindingsTotal(project: ProjectWithRuns): number {
  return project.runs.reduce((sum, run) => sum + run.openFindings, 0);
}

function globalPendingEntries(projects: ProjectWithRuns[]): GlobalPendingEntry[] {
  return projects.flatMap((project) => project.runs.map((run) => {
    const reasons: string[] = [];
    let priority = 0;
    if (run.phase === "hold") { reasons.push("hallazgo crítico en hold"); priority += 90; }
    if (run.openFindings > 0) { reasons.push(`${run.openFindings} ${run.openFindings === 1 ? "hallazgo vivo" : "hallazgos vivos"}`); priority += 80; }
    if (run.status === "implemented") { reasons.push(run.attachedSessions.length > 1 ? "esperando auditoría" : "implementado sin auditores"); priority += 60; }
    if (run.runningCount > 0) { reasons.push(`${run.runningCount} en curso`); priority += 50; }
    if (run.failedCount > 0) { reasons.push(`${run.failedCount} ${run.failedCount === 1 ? "nodo fallido" : "nodos fallidos"}`); priority += 45; }
    if (run.status === "open" && !reasons.length) { reasons.push(`${run.completedCount}/${run.nodeCount} nodos`); priority += 30; }
    if (run.control === "paused") { reasons.push("pausado"); priority += 15; }
    if (run.control === "stopped" || run.status === "closed" || !reasons.length) return undefined;
    return { project, run, reasons, priority } satisfies GlobalPendingEntry;
  })).filter((entry): entry is GlobalPendingEntry => Boolean(entry))
    .sort((left, right) => right.priority - left.priority || Date.parse(right.run.updatedAt) - Date.parse(left.run.updatedAt));
}

function sortProjects(projects: ProjectWithRuns[]): ProjectWithRuns[] {
  const projectTime = (project: ProjectWithRuns) => Math.max(Date.parse(project.lastOpenedAt), ...project.runs.map((run) => Date.parse(run.updatedAt)));
  return [...projects].sort((left, right) => {
    const leftLive = left.runs.some((run) => run.status !== "closed" && run.control !== "stopped") ? 1 : 0;
    const rightLive = right.runs.some((run) => run.status !== "closed" && run.control !== "stopped") ? 1 : 0;
    return rightLive - leftLive || projectTime(right) - projectTime(left);
  });
}

function Icon({ name }: { name: "route" | "activity" | "folder" | "check" | "clock" | "warning" | "code" | "sliders" | "copy" | "bell" | "doc" | "timeline" }) {
  const paths = {
    timeline: <><path d="M3 12h18"/><circle cx="6" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M12 5v4M12 15v4"/></>,
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
    doc: <><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="icon">{paths[name]}</svg>;
}

function StatusSignal({ status }: { status: NodeStatus }) {
  const icon = status === "completed" ? "check" : status === "failed" ? "warning" : "clock";
  return <span className={`status-signal status-${status}`}><Icon name={icon}/>{statusCopy[status]}</span>;
}

// Un botón de copia por comando: el humano lo pega donde lo necesite.
function CopyButton({ text, label, className = "" }: { text: string; label: string; className?: string }) {
  const [result, setResult] = useState<"copied" | "failed">();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(text);
      setResult("copied");
    } catch {
      setResult("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult(undefined), 2000);
  };
  const title = result === "copied" ? "Copiado" : result === "failed" ? "No se pudo copiar; cópialo a mano" : label;
  return (
    <button type="button" className={`attention-copy ${result ? `is-${result}` : ""} ${className}`} title={title} aria-label={title} aria-live="polite" onClick={() => { copy().catch(() => undefined); }}>
      <Icon name={result === "copied" ? "check" : result === "failed" ? "warning" : "copy"}/>
      <code>{text}</code>
    </button>
  );
}

// Exportada para poder renderizarla en una prueba.
export function ChangeNodeCard({ data }: NodeProps<Node<MapNodeData>>) {
  const change = data.change;
  const audited = change.auditedBy.filter((session) => session !== change.author);
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
        <span className="node-file" title={change.files.join("\n")}>{change.file}{change.files.length > 1 && <small className="node-file-more"> +{change.files.length - 1}</small>}</span>
        {change.status === "completed" && (
          <span className={audited.length ? "suggested-label" : "approval-label"} title={audited.length ? `Auditado por ${audited.join(", ")}` : "Sin auditoría ajena todavía"}>
            {audited.length ? `auditado ×${audited.length}` : "sin auditar"}
          </span>
        )}
      </div>
      <strong className="node-symbol">{change.symbol}</strong>
      {change.status === "completed" && <span className="node-completion-crumb" aria-hidden="true"><i/><i/><i/></span>}
      <p>{change.title}</p>
      <div className="node-status-row">
        <span className="node-assignee" title={`${change.status === "completed" ? "Implementado" : "En ejecución"} por ${change.author}`}>{change.author}</span>
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

export function layoutGraph(changes: ChangeNode[], selectedId: string | undefined, onSelect: (id: string) => void): { nodes: Node<MapNodeData>[]; edges: Edge[] } {
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
      // Medidas declaradas: una pestaña sin pintar no entrega ResizeObserver y
      // ReactFlow escondería el nodo hasta medirlo.
      measured: { width: nodeWidth, height: nodeHeight },
      data: { change, isSelected: change.id === selectedId, onSelect },
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

// Botón de plegar/abrir el inspector; el estado vive en App y se recuerda.
function InspectorToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? "Abrir el detalle del nodo" : "Plegar el detalle del nodo";
  return <button type="button" className="inspector-toggle" aria-expanded={!collapsed} aria-label={label} title={label} onClick={onToggle}>{collapsed ? "◂" : "▸"}</button>;
}

function Inspector({ node, nodes, findings, collapsed, onToggle, onSelectFinding }: { node?: ChangeNode; nodes: ChangeNode[]; findings: Finding[]; collapsed: boolean; onToggle: () => void; onSelectFinding: (id: string) => void }) {
  if (collapsed) {
    return (
      <aside className="inspector inspector-collapsed" aria-label="Detalle del nodo, plegado">
        <InspectorToggle collapsed onToggle={onToggle}/>
        <span className="inspector-rail-label" title={node ? `${node.file} · ${node.symbol}` : undefined}>{node ? `${node.id} · ${node.symbol}` : "Sin nodo seleccionado"}</span>
      </aside>
    );
  }
  if (!node) {
    return (
      <aside className="inspector empty-inspector">
        <div className="inspector-empty-tools"><InspectorToggle collapsed={false} onToggle={onToggle}/></div>
        <div className="empty-symbol"><Icon name="route" /></div>
        <h2>Selecciona una operación</h2>
        <p>Cada nodo es un cambio concreto en un archivo y símbolo. Aquí aparecen su intención, su diff, su verificación y quién lo auditó.</p>
      </aside>
    );
  }
  const dependencies = node.dependencies.map((id) => nodes.find((candidate) => candidate.id === id)).filter(Boolean) as ChangeNode[];
  const related = findings.filter((finding) => finding.nodeId === node.id || finding.resolutionNodeId === node.id);
  const audited = node.auditedBy.filter((session) => session !== node.author);
  return (
    <aside className="inspector" aria-live="polite">
      <header className="inspector-head">
        <div>
          {node.files.map((file) => <span className="inspector-file" key={file}>{file}</span>)}
          <h2>{node.symbol}</h2>
        </div>
        <div className="inspector-signals">
          <InspectorToggle collapsed={false} onToggle={onToggle}/>
          <StatusSignal status={node.status}/>
          <span className="inspector-executor">{node.status === "completed" ? "por" : "ejecuta"} {node.author}</span>
        </div>
      </header>

      {node.status === "failed" && (
        <section className="failure-guidance" role="alert">
          <Icon name="warning"/>
          <div>
            <h3>Este nodo falló</h3>
            <p>{node.failure ?? "El base lo marcó fallido sin razón registrada."}</p>
            <span>El base debe abrir otro nodo que lo reemplace; no se crea otro run.</span>
          </div>
        </section>
      )}

      <section className="change-history planned-history">
        <div className="history-heading"><h3>Qué hará</h3><span>Intención declarada</span></div>
        <p className="history-summary">{node.description}</p>
        <div className="history-rationale"><strong>Por qué</strong><p>{node.rationale}</p></div>
      </section>

      {node.patchSummary && (
        <section className="change-history result-history">
          <div className="history-heading"><h3>Qué hizo</h3><span>{node.commit ? `commit ${node.commit.slice(0, 10)}` : "Resultado observado"}</span></div>
          <p className="history-summary">{node.patchSummary}</p>
          <div className="history-rationale">
            <strong>Por qué se hizo así</strong>
            {node.patchRationale ? <p>{node.patchRationale}</p> : <p className="history-missing">El base no publicó un porqué adicional para este resultado.</p>}
          </div>
        </section>
      )}

      {node.status === "completed" && (
        <section>
          <h3>Auditoría</h3>
          {audited.length
            ? <ul className="dependency-list">{audited.map((session) => <li key={session}><span className="dependency-dot status-completed"/><span><strong>{session}</strong>revisó este nodo</span></li>)}</ul>
            : <p className="history-missing">Nadie ajeno al autor ha revisado este nodo todavía; el run no puede cerrar sin esa auditoría.</p>}
        </section>
      )}

      {related.length > 0 && (
        <section>
          <h3>Hallazgos</h3>
          <ul className="dependency-list">
            {related.map((finding) => (
              <li key={finding.id}>
                <span className={`dependency-dot ${isLiveFinding(finding) ? "status-failed" : "status-completed"}`}/>
                <button type="button" className="finding-node-link" onClick={() => onSelectFinding(finding.id)}>
                  {finding.resolutionNodeId === node.id ? "corrige: " : ""}{finding.title} · {findingStatusCopy[finding.status]}
                </button>
              </li>
            ))}
          </ul>
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
          <div className="section-title-row"><h3>Diff commiteado</h3><span>{node.diff.split("\n").length} líneas</span></div>
          <DiffView diff={node.diff}/>
        </section>
      ) : (
        <section className="pending-evidence"><Icon name="clock"/><div><h3>Sin código todavía</h3><p>El diff lo mide git cuando el base completa la operación.</p></div></section>
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

// El issue se escribe en markdown con secciones fijas; se pinta por secciones
// y los adjuntos se sirven desde el propio run.
function IssueView({ detail }: { detail: RunDetail }) {
  const body = detail.issue.replace(/^---[\s\S]*?---\s*/, "");
  const sections = body.split(/\n(?=## )/).map((chunk) => chunk.trim()).filter(Boolean);
  const title = sections[0]?.startsWith("# ") ? sections.shift()?.slice(2) : undefined;
  const images = detail.run.attachments.filter((file) => /\.(png|jpe?g|gif|webp|svg)$/i.test(file));
  return (
    <div className="issue-view">
      {title && <h2>{title}</h2>}
      <p className="issue-meta"><code>{detail.run.issuePath}</code> · rama <code>{detail.run.branch}</code> · base <strong>{detail.run.base}</strong></p>
      {sections.map((section) => {
        const [heading, ...rest] = section.split("\n");
        return (
          <section className="issue-section" key={heading}>
            <h3>{heading.replace(/^## /, "")}</h3>
            <pre className="issue-text">{rest.join("\n").trim()}</pre>
          </section>
        );
      })}
      {detail.run.acceptance.some((criterion) => criterion.result || criterion.observed) && (
        <section className="issue-section">
          <h3>Resultado de los criterios</h3>
          <ul className="dependency-list">
            {detail.run.acceptance.map((criterion) => (
              <li key={criterion.text}>
                <span className={`dependency-dot ${criterion.result ? (criterion.result.passed ? "status-completed" : "status-failed") : criterion.observed ? "status-completed" : "status-running"}`}/>
                <span>
                  <strong>{criterion.exercise ? "[ejercicio] " : ""}{criterion.text}</strong>
                  {criterion.command ? `${criterion.command}${criterion.result ? ` → exit ${criterion.result.exitCode}` : ""}` : criterion.exercise ? (criterion.observed ? `observado: ${criterion.observed}` : "pendiente de ejercitar") : "sin comando: lo juzgan los auditores"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {images.length > 0 && (
        <section className="issue-section">
          <h3>Adjuntos</h3>
          <div className="issue-attachments">
            {images.map((file) => <a key={file} href={`/api/runs/${detail.run.id}/${file}`} target="_blank" rel="noreferrer"><img src={`/api/runs/${detail.run.id}/${file}`} alt={file}/><span>{file.replace(/^attachments\//, "")}</span></a>)}
          </div>
        </section>
      )}
    </div>
  );
}

// Evolución: el árbol de archivos del workspace recorrido cuadro a cuadro, un
// cuadro por nodo completado. El cuadro actual y la selección del nodo son el
// mismo estado; el rótulo reproduce lo que el nodo ya guardaba.
function EvolutionBranch({ nodes, depth, highlights, dirCounts, focusPath, isOpen, onToggle, onSelectFile }: {
  nodes: EvolutionTreeNode[];
  depth: number;
  highlights: Map<string, EvolutionHighlight>;
  dirCounts: Map<string, { current: number; past: number }>;
  focusPath?: string;
  isOpen: (path: string, depth: number) => boolean;
  onToggle: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  return (
    <ul className="evolution-branch" role={depth === 0 ? "tree" : "group"}>
      {nodes.map((node) => {
        if (node.kind === "dir") {
          const open = isOpen(node.path, depth);
          const counts = dirCounts.get(node.path);
          return (
            <li key={node.path} className="evolution-dir" role="treeitem" aria-expanded={open}>
              <button type="button" className={`evolution-dir-row ${counts?.current ? "has-current" : counts ? "has-past" : ""}`} style={{ paddingLeft: depth * 16 + 8 }} onClick={() => onToggle(node.path)}>
                <span className="evolution-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
                <Icon name="folder"/>
                <span className="evolution-name">{node.name}</span>
                {counts && <span className="evolution-dir-count" title={`${counts.current + counts.past} ${counts.current + counts.past === 1 ? "archivo tocado" : "archivos tocados"} dentro`}>{counts.current + counts.past}</span>}
              </button>
              {open && <EvolutionBranch nodes={node.children} depth={depth + 1} highlights={highlights} dirCounts={dirCounts} focusPath={focusPath} isOpen={isOpen} onToggle={onToggle} onSelectFile={onSelectFile}/>}
            </li>
          );
        }
        const highlight = highlights.get(node.path);
        const focused = node.path === focusPath;
        const className = `evolution-file ${highlight ? `is-${highlight.kind} level-${highlightLevel(highlight.age)} status-${highlight.status}` : ""} ${focused ? "is-focus" : ""}`;
        return (
          <li key={node.path} role="treeitem" aria-selected={focused} className={className} data-evolution-current={highlight?.kind === "current" ? "true" : undefined}>
            <button type="button" className="evolution-file-row" style={{ paddingLeft: depth * 16 + 30 }} title={highlight ? `${node.path} · ${fileStatusCopy[highlight.status]}${highlight.kind === "past" ? ` hace ${highlight.age} ${highlight.age === 1 ? "cuadro" : "cuadros"}` : " en este cuadro"}` : node.path} onClick={() => onSelectFile(node.path)}>
              <span className="evolution-name">{node.name}</span>
              {highlight && <span className={`evolution-status status-${highlight.status}`} aria-label={fileStatusCopy[highlight.status]}>{highlight.status}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// Antes y después del archivo en foco, alineados línea a línea en una sola
// rejilla: número y texto de cada lado, con la fila coloreada según añadida,
// borrada o modificada.
function EvolutionCodePane({ runId, node, change, path, frameLabel, onShowFrame }: {
  runId: string;
  node: ChangeNode;
  change?: EvolutionFileChange;
  path: string;
  frameLabel: string;
  onShowFrame: () => void;
}) {
  const [state, setState] = useState<{ key: string; content?: EvolutionFileContent; error?: string }>({ key: "" });
  const key = `${runId}:${node.id}:${path}`;
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/runs/${runId}/evolution/file?nodeId=${encodeURIComponent(node.id)}&path=${encodeURIComponent(path)}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as EvolutionFileContent & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "No se pudo leer el archivo");
        return body;
      })
      .then((content) => { if (!cancelled) setState({ key, content }); })
      .catch((cause) => { if (!cancelled) setState({ key, error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { cancelled = true; };
  }, [key, runId, node.id, path]);
  const loaded = state.key === key ? state : { key };
  const rows: DiffRow[] = useMemo(() => loaded.content && !loaded.content.binary ? alignLines(loaded.content.before, loaded.content.after) : [], [loaded.content]);
  // HTML resaltado por línea de cada versión; el índice es el número de línea - 1.
  const beforeHtml = useMemo(() => loaded.content && !loaded.content.binary ? highlightLines(loaded.content.before, path) : [], [loaded.content, path]);
  const afterHtml = useMemo(() => loaded.content && !loaded.content.binary ? highlightLines(loaded.content.after, path) : [], [loaded.content, path]);
  const counts = useMemo(() => diffRowCounts(rows), [rows]);
  const status = change?.status;
  return (
    <section className="evolution-code-pane" aria-label={`Antes y después de ${path}`}>
      <header className="evolution-code-head">
        <div className="evolution-code-node">
          <strong>{frameLabel}</strong>
          <span className="evolution-code-title" title={node.title}>{node.title}</span>
          <button type="button" className="evolution-code-frame-link" onClick={onShowFrame}>Ver cuadro</button>
        </div>
        <div className="evolution-code-file">
          {status ? <span className={`evolution-status status-${status}`}>{status}</span> : <span className="evolution-status status-none" title="Sin cambios en este cuadro">=</span>}
          <code title={path}>{path}</code>
          {change?.from && <em>desde {change.from}</em>}
          {loaded.content && !loaded.content.binary && (
            <span className="evolution-code-counts" aria-label={`${counts.added} añadidas, ${counts.deleted} borradas, ${counts.modified} modificadas`}>
              <b className="count-add">+{counts.added}</b><b className="count-del">−{counts.deleted}</b><b className="count-mod">~{counts.modified}</b>
            </span>
          )}
        </div>
      </header>
      {loaded.error ? (
        <div className="evolution-code-fallback">
          <p role="alert"><Icon name="warning"/>{loaded.error}</p>
          {node.diff && change ? <><p>Se muestra el diff guardado del nodo.</p><DiffView diff={node.diff}/></> : null}
        </div>
      ) : !loaded.content ? (
        <p className="evolution-code-loading" aria-busy="true">Leyendo las dos versiones…</p>
      ) : loaded.content.binary ? (
        <p className="evolution-code-loading">Archivo binario: no se muestra su contenido.</p>
      ) : (
        <div className="evolution-code" role="table" aria-label="Líneas antes y después">
          <div className="evolution-code-columns" role="row">
            <span role="columnheader" className={loaded.content.before === undefined ? "is-void" : ""}>Antes{loaded.content.before === undefined ? " · no existía" : ""}</span>
            <span role="columnheader" className={loaded.content.after === undefined ? "is-void" : ""}>Después{loaded.content.after === undefined ? " · borrado" : ""}</span>
          </div>
          {loaded.content.truncated && <p className="evolution-code-loading">Archivo truncado a 1 MB.</p>}
          {rows.map((row, index) => (
            <div className={`evolution-code-row kind-${row.kind}`} role="row" key={index}>
              <span className={`evolution-ln ${row.left ? "" : "is-void"}`} role="cell">{row.left?.number ?? ""}</span>
              <span className={`evolution-src ${row.left ? "" : "is-void"}`} role="cell" dangerouslySetInnerHTML={{ __html: row.left ? beforeHtml[row.left.number - 1] ?? "" : "" }}/>
              <span className={`evolution-ln ${row.right ? "" : "is-void"}`} role="cell">{row.right?.number ?? ""}</span>
              <span className={`evolution-src ${row.right ? "" : "is-void"}`} role="cell" dangerouslySetInnerHTML={{ __html: row.right ? afterHtml[row.right.number - 1] ?? "" : "" }}/>
            </div>
          ))}
          {!rows.length && <p className="evolution-code-loading">Archivo vacío en las dos versiones.</p>}
        </div>
      )}
    </section>
  );
}

function EvolutionView({ runId, evolution, error, nodes, findings, frameIndex, onFrame, onSelectFinding }: {
  runId: string;
  evolution?: EvolutionData;
  error: string;
  nodes: ChangeNode[];
  findings: Finding[];
  frameIndex: number;
  onFrame: (index: number) => void;
  onSelectFinding: (id: string) => void;
}) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  // Por defecto se ve el código del archivo en foco; el rótulo del cuadro es
  // el otro modo. Seleccionar un archivo vuelve al código.
  const [mode, setMode] = useState<"code" | "frame">("code");
  const [focusPath, setFocusPath] = useState<string>();
  const treeRef = useRef<HTMLDivElement>(null);
  const frames = useMemo(() => evolution?.frames ?? [], [evolution]);
  const frame = frames[frameIndex];
  const node = frame ? nodes.find((candidate) => candidate.id === frame.nodeId) : undefined;
  const paths = useMemo(() => evolution ? filesAtFrame(evolution.baseFiles, frames, frameIndex) : [], [evolution, frames, frameIndex]);
  const tree = useMemo(() => buildEvolutionTree(paths), [paths]);
  const highlights = useMemo(() => evolutionHighlights(frames, frameIndex), [frames, frameIndex]);
  const autoExpanded = useMemo(() => expandedDirectories([...highlights.keys()]), [highlights]);
  const dirCounts = useMemo(() => {
    const counts = new Map<string, { current: number; past: number }>();
    for (const [path, highlight] of highlights) {
      // Un borrado sólo está en el árbol durante su cuadro.
      if (highlight.status === "D" && highlight.kind !== "current") continue;
      const segments = path.split("/");
      for (let depth = 1; depth < segments.length; depth += 1) {
        const directory = segments.slice(0, depth).join("/");
        const entry = counts.get(directory) ?? { current: 0, past: 0 };
        entry[highlight.kind] += 1;
        counts.set(directory, entry);
      }
    }
    return counts;
  }, [highlights]);
  // Al cambiar de cuadro el árbol vuelve a abrirse solo hacia lo tocado y
  // enfoca el primer archivo del cuadro.
  useEffect(() => { setOverrides({}); }, [frameIndex, evolution]);
  useEffect(() => { setFocusPath(frame?.files[0]?.path); }, [frame]);
  const selectFile = useCallback((path: string) => { setFocusPath(path); setMode("code"); }, []);
  useEffect(() => {
    treeRef.current?.querySelector<HTMLElement>("[data-evolution-current]")?.scrollIntoView({ block: "center" });
  }, [frameIndex, evolution]);
  const isOpen = useCallback((path: string, depth: number) => overrides[path] ?? (depth === 0 || autoExpanded.has(path)), [overrides, autoExpanded]);
  const toggle = useCallback((path: string) => setOverrides((current) => {
    const open = current[path] ?? (!path.includes("/") || autoExpanded.has(path));
    return { ...current, [path]: !open };
  }), [autoExpanded]);
  const related = node ? findings.filter((finding) => finding.nodeId === node.id || finding.resolutionNodeId === node.id) : [];

  if (error) return <div className="ledger-empty"><Icon name="warning"/><h2>No se pudo cargar la evolución</h2><p>{error}</p></div>;
  if (!evolution) return <div className="ledger-empty" aria-busy="true"><Icon name="timeline"/><h2>Cargando la evolución</h2><p>Leyendo el árbol base y los cuadros del run.</p></div>;

  return (
    <div className="evolution">
      <div className="evolution-strip" role="group" aria-label="Línea de tiempo del run">
        <button type="button" disabled={frameIndex <= 0} title="Primer cuadro (Inicio)" aria-label="Primer cuadro" onClick={() => onFrame(0)}>⇤</button>
        <button type="button" disabled={frameIndex <= 0} title="Cuadro anterior (←)" aria-label="Cuadro anterior" onClick={() => onFrame(frameIndex - 1)}>←</button>
        <ol className="evolution-dots">
          {frames.map((candidate, index) => {
            const title = nodes.find((item) => item.id === candidate.nodeId)?.title ?? candidate.nodeId;
            return (
              <li key={candidate.nodeId}>
                <button type="button" className={index === frameIndex ? "is-current" : index < frameIndex ? "is-past" : ""} aria-current={index === frameIndex ? "step" : undefined} aria-label={`Cuadro ${index + 1}: ${candidate.nodeId}, ${title}`} title={`${candidate.nodeId} · ${title}`} onClick={() => onFrame(index)}/>
              </li>
            );
          })}
        </ol>
        <button type="button" disabled={frameIndex >= frames.length - 1} title="Cuadro siguiente (→)" aria-label="Cuadro siguiente" onClick={() => onFrame(frameIndex + 1)}>→</button>
        <button type="button" disabled={frameIndex >= frames.length - 1} title="Último cuadro (Fin)" aria-label="Último cuadro" onClick={() => onFrame(frames.length - 1)}>⇥</button>
        <span className="evolution-counter">{frames.length ? `${Math.max(frameIndex, 0) + 1} / ${frames.length}` : "0 cuadros"}</span>
        <div className="evolution-mode" role="group" aria-label="Qué mostrar junto al árbol">
          <button type="button" className={mode === "code" ? "active" : ""} aria-pressed={mode === "code"} onClick={() => setMode("code")}>Código</button>
          <button type="button" className={mode === "frame" ? "active" : ""} aria-pressed={mode === "frame"} onClick={() => setMode("frame")}>Cuadro</button>
        </div>
        <span className="evolution-hint">← → cambian de cuadro · Inicio/Fin van a los extremos</span>
      </div>
      {evolution.partial && (
        <p className="evolution-partial" role="status"><Icon name="warning"/>git ya no alcanza el commit base: el árbol se reconstruyó sólo con los archivos que tocan los nodos.</p>
      )}
      <div className={`evolution-body mode-${mode}`}>
        <div className="evolution-tree" ref={treeRef} aria-label="Árbol de archivos en este cuadro">
          {tree.length
            ? <EvolutionBranch nodes={tree} depth={0} highlights={highlights} dirCounts={dirCounts} focusPath={focusPath} isOpen={isOpen} onToggle={toggle} onSelectFile={selectFile}/>
            : <p className="evolution-empty-tree">Sin archivos en el árbol.</p>}
        </div>
        {mode === "code" && frame && node && focusPath ? (
          <EvolutionCodePane runId={runId} node={node} change={frame.files.find((candidate) => candidate.path === focusPath)} path={focusPath} frameLabel={`${node.id} · ${frameIndex + 1}/${frames.length}`} onShowFrame={() => setMode("frame")}/>
        ) : mode === "code" && frame && node ? (
          <section className="evolution-caption" aria-label="Archivo en foco"><strong>Sin archivo en foco</strong><p>Elige un archivo del árbol para ver su antes y su después en este cuadro.</p></section>
        ) : (
        <section className="evolution-caption" aria-live="polite" aria-label="Cuadro actual">
          {frame && node ? (
            <>
              <div className="evolution-caption-head">
                <strong>{node.id} · cuadro {frameIndex + 1} de {frames.length}</strong>
                {frame.commit && <span className="activity-agent" title={frame.commit}>commit {frame.commit.slice(0, 10)}</span>}
                {frame.committedAt && <time dateTime={frame.committedAt}>{formatTime(frame.committedAt)}</time>}
                <span className="evolution-author">{node.author}</span>
              </div>
              <h2>{node.title}</h2>
              <ul className="evolution-files">
                {frame.files.map((change) => (
                  <li key={change.path}>
                    <span className={`evolution-status status-${change.status}`}>{change.status}</span>
                    <code>{change.path}</code>
                    <em>{fileStatusCopy[change.status]}{change.from ? ` desde ${change.from}` : ""}</em>
                  </li>
                ))}
                {!frame.files.length && <li><em>git no registró archivos en este nodo.</em></li>}
              </ul>
              {node.patchSummary && <p className="evolution-summary">{node.patchSummary}</p>}
              {node.patchRationale && <p className="evolution-rationale"><strong>Por qué</strong>{node.patchRationale}</p>}
              <div className="evolution-signals">
                {node.verification && (
                  <span className={`evolution-verify verify-${node.verification.passed ? "passed" : "failed"}`} title={node.verification.command}>
                    <Icon name={node.verification.passed ? "check" : "warning"}/>{node.verification.passed ? "Verificación aprobada" : "Verificación fallida"}<code>{node.verification.command}</code>
                  </span>
                )}
                {related.length > 0 && (
                  <button type="button" className="finding-node-link" onClick={() => onSelectFinding(related[0].id)}>
                    {related.length === 1 ? "1 hallazgo" : `${related.length} hallazgos`}{related.some(isLiveFinding) ? " · alguno vivo" : ""}
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <strong>{frames.length ? "Cuadro sin nodo" : "Antes del run"}</strong>
              <p>{frames.length ? "El nodo de este cuadro ya no está en el run." : "Todavía no hay nodos completados: este es el árbol del que parte el run. Los cuadros aparecen conforme el base completa operaciones."}</p>
            </>
          )}
        </section>
        )}
      </div>
    </div>
  );
}

// Filtro por sesión compartido entre Actividad y Hallazgos: moverse entre lo
// que hizo cada sesión es la forma de leer un run con varios auditores.
function SessionFilterBar({ sessions, value, onChange }: { sessions: string[]; value: string; onChange: (session: string) => void }) {
  if (!sessions.length) return null;
  return (
    <div className="session-filter" role="group" aria-label="Filtrar por sesión">
      <button type="button" className={value === "" ? "active" : ""} aria-pressed={value === ""} onClick={() => onChange("")}>Todas</button>
      {sessions.map((session) => (
        <button type="button" key={session} className={value === session ? "active" : ""} aria-pressed={value === session} onClick={() => onChange(value === session ? "" : session)}>
          {session === "human" ? "humano" : session}
        </button>
      ))}
    </div>
  );
}

function ActivityLedger({ activity, nodes, sessionFilter, onSelect }: { activity: Activity[]; nodes: ChangeNode[]; sessionFilter: string; onSelect: (id: string) => void }) {
  const visible = sessionFilter ? activity.filter((item) => item.agent === sessionFilter) : activity;
  if (!visible.length) return <div className="ledger-empty"><Icon name="activity"/><h2>{sessionFilter ? `Sin actividad de ${sessionFilter}` : "Aún no hay actividad"}</h2><p>Las operaciones, verificaciones, hallazgos y auditorías aparecen aquí en orden causal.</p></div>;
  return (
    <ol className="activity-ledger">
      {visible.map((item) => {
        const node = item.nodeId ? nodes.find((candidate) => candidate.id === item.nodeId) : undefined;
        return (
          <li key={item.id}>
            <span className={`activity-mark activity-${item.type}`}/>
            <time>{formatTime(item.createdAt)}</time>
            <div>
              <div className="activity-header">
                <strong>{item.message}</strong>
                {item.agent && <span className={`activity-agent activity-agent-${item.agent === "human" ? "human" : item.agent.startsWith("ollama") ? "ollama" : "model"}`}>{item.agent === "human" ? "humano" : item.agent}</span>}
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

function FindingsPanel({ findings, nodes, sessionFilter, focusId, onChanged, onSelectNode }: {
  findings: Finding[];
  nodes: ChangeNode[];
  sessionFilter: string;
  focusId?: string;
  onChanged: () => void;
  onSelectNode: (id: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<string>(focusId ?? "");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  useEffect(() => { if (focusId) setExpandedId(focusId); }, [focusId]);
  const post = async (findingId: string, endpoint: string, body: unknown): Promise<boolean> => {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
    if (!response?.ok) {
      const detail = response ? (await response.json().catch(() => ({}))) as { error?: string } : {};
      setActionErrors((previous) => ({ ...previous, [findingId]: detail.error ?? "El servidor no respondió; reintenta." }));
      return false;
    }
    setActionErrors((previous) => ({ ...previous, [findingId]: "" }));
    setDrafts((previous) => ({ ...previous, [findingId]: "" }));
    onChanged();
    return true;
  };
  const draft = (finding: Finding) => (drafts[finding.id] ?? "").trim();
  const intervene = (finding: Finding) => draft(finding) && post(finding.id, `/api/findings/${finding.id}/messages`, { author: "human", body: draft(finding) });
  const accept = (finding: Finding) => post(finding.id, `/api/findings/${finding.id}/accept`, { actor: "human", note: draft(finding) || undefined });
  const reject = (finding: Finding) => {
    const reason = draft(finding) || window.prompt("Razón del rechazo (queda en el hilo):")?.trim();
    return reason && post(finding.id, `/api/findings/${finding.id}/reject`, { actor: "human", reason });
  };
  const reopen = (finding: Finding) => {
    const reason = draft(finding) || window.prompt("Evidencia nueva para reabrir (queda en el hilo):")?.trim();
    return reason && post(finding.id, `/api/findings/${finding.id}/reopen`, { author: "human", reason });
  };
  const visible = sessionFilter
    ? findings.filter((finding) => finding.reviewer === sessionFilter || finding.messages.some((message) => message.author === sessionFilter))
    : findings;
  if (!visible.length) {
    return <div className="findings-empty"><Icon name="check"/><h2>{sessionFilter ? `Sin hallazgos de ${sessionFilter}` : "Sin hallazgos todavía"}</h2></div>;
  }
  return (
    <div className="findings-panel">
      <header className="findings-head">
        <p>{findings.filter(isLiveFinding).length} vivos de {findings.length}; el cierre exige cero hallazgos vivos, cada nodo auditado por alguien ajeno y mayoría OK.</p>
      </header>
      <ol className="findings-list">
        {visible.map((finding) => {
          const node = finding.nodeId ? nodes.find((candidate) => candidate.id === finding.nodeId) : undefined;
          const expanded = expandedId === finding.id;
          const terminal = finding.status === "accepted" || finding.status === "rejected";
          return (
            <li key={finding.id} className={`finding-card status-${finding.status} ${finding.status === "escalated" ? "needs-human" : ""}`}>
              <button type="button" className="finding-summary" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? "" : finding.id)}>
                <span className={`severity-chip severity-${finding.severity}`}>{severityCopy[finding.severity]}</span>
                {finding.scope !== "node" && <span className="finding-scope">{scopeCopy[finding.scope]}</span>}
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
                  {finding.resolutionNodeId && <p className="finding-resolution">Corrección: <button type="button" onClick={() => onSelectNode(finding.resolutionNodeId!)}>{finding.resolutionNodeId}</button></p>}
                  {finding.status === "accepted" && !finding.resolutionNodeId && <p className="finding-meta">Aceptado sin nodo de corrección todavía; el base debe abrirlo.</p>}
                  <div className="finding-actions">
                    <textarea
                      placeholder={terminal ? "Evidencia nueva para reabrir…" : finding.status === "escalated" ? "Tu arbitraje: tercia o escribe la razón del rechazo…" : "Tercia en el debate como humano…"}
                      value={drafts[finding.id] ?? ""}
                      onChange={(event) => setDrafts((previous) => ({ ...previous, [finding.id]: event.target.value }))}
                    />
                    <div className="finding-buttons">
                      {terminal ? (
                        <button type="button" onClick={() => { void reopen(finding); }}>Reabrir</button>
                      ) : (
                        <>
                          <button type="button" onClick={() => { void intervene(finding); }} disabled={!draft(finding)}>Responder</button>
                          <button type="button" className="finding-accept" title="Da la razón al auditor; el base abrirá el nodo de corrección" onClick={() => { void accept(finding); }}>Aceptar</button>
                          <button type="button" className="finding-reject" title="Descarta el hallazgo; la razón queda en el hilo" onClick={() => { void reject(finding); }}>Rechazar</button>
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

function elapsedSince(startedAt: string | undefined, tick: number): string | undefined {
  if (!startedAt) return undefined;
  const seconds = Math.max(0, Math.floor((tick - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

// Dock de sesiones: quién está enganchado, con qué modelo, qué cubrió y cómo
// votó. Un solo comando copiable por run; nada que pegar por modelo.
export function SessionDock({ run, nodes, sessions, onFocusSession }: { run: RunSummary; nodes: ChangeNode[]; sessions: Session[]; onFocusSession: (session: string) => void }) {
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const completed = nodes.filter((node) => node.status === "completed");
  const families = new Set(sessions.map((session) => session.family));
  const live = run.status !== "closed" && run.control !== "stopped";
  return (
    <section className="agent-dock" aria-label="Sesiones del run">
      <header className="agent-dock-head">
        <div><strong>Sesiones</strong><span>{sessions.length ? `${families.size} ${families.size === 1 ? "modelo" : "modelos"} · ${run.attachedSessions.length} atentas` : "Nadie enganchado todavía"}</span></div>
        <b>{run.audit.okVotes.length} OK</b>
      </header>
      {live && (
        <div className="agent-dock-attention">
          <CopyButton text={attentionCommand(run.id)} label="Copiar el comando para enganchar otra sesión (Claude, Codex, Antigravity)"/>
          <CopyButton text={runnerCommand(run.id)} label="Copiar el comando del runner sin sesión (ollama)" className="attention-copy-runner"/>
        </div>
      )}
      {sessions.map((session) => {
        const own = completed.filter((node) => node.author === session.id).length;
        const foreign = completed.length - own;
        const reviewed = session.reviewedNodeIds.length;
        const present = session.status === "attached";
        const state = session.role === "base"
          ? (run.status === "open" ? (run.runningCount ? "Implementando" : "Entre nodos") : run.status === "implemented" ? "Esperando auditoría" : "Terminó")
          : session.vote ? `Votó ${session.vote === "ok" ? "OK" : "rechazo"}` : reviewed < foreign ? `Auditando ${reviewed}/${foreign}` : run.status === "implemented" ? "Pasada final pendiente" : "Atenta";
        return (
          <div className={`agent-dock-entry ${session.role === "base" ? "is-base-agent" : ""} phase-${present ? "executing" : "idle"}`} key={session.id} role="group" aria-label={`${session.id}, ${session.role === "base" ? "modelo base" : "auditor"}`}>
            <div className="agent-dock-row">
              <span className={`agent-presence-dot agent-presence-${present ? "present" : "absent"}`} role="img" aria-label={present ? "Atenta" : "Liberada"} title={present ? `Atenta desde ${formatTime(session.attachedAt)}` : `Liberada ${session.releasedAt ? formatTime(session.releasedAt) : ""}`}/>
              <button type="button" className="agent-dock-name agent-dock-focus" title={`Ver la actividad de ${session.id}`} onClick={() => onFocusSession(session.id)}>
                <span className="agent-name-text">{session.family}</span><small>{session.id.slice(session.family.length + 1)} · {session.role === "base" ? "base" : "auditor"}</small>
              </button>
              <span className="agent-dock-counts">
                {own > 0 && <span className="agent-dock-count agent-dock-count-done" title={`${session.id} implementó ${own} ${own === 1 ? "nodo" : "nodos"}`}><Icon name="check"/>{own}</span>}
                {session.role === "auditor" && <span className="agent-dock-count" title={`${reviewed} de ${foreign} nodos ajenos auditados`}>{reviewed}/{foreign}</span>}
              </span>
            </div>
            <div className="agent-dock-subrow">
              <span className="agent-activity-row"><i aria-hidden="true"/><span><strong>{state}</strong>{session.role === "auditor" && <> · req. {session.requirementReviewed ? "✓" : "—"}</>}</span>{present && <time>{elapsedSince(session.lastSeenAt, tick)}</time>}</span>
            </div>
            {session.voteDetail && <p className="agent-dock-vote">{session.voteDetail}</p>}
          </div>
        );
      })}
      {live && sessions.length < 2 && (
        <p className="agent-dock-hint">Pega el comando en otra sesión (puede ser del mismo modelo) para que audite. Sin auditores el run se quedará implementado sin cerrar.</p>
      )}
    </section>
  );
}

function RunControls({ run, onChanged }: { run: RunSummary; onChanged: () => void }) {
  const setControl = async (control: "active" | "paused" | "stopped") => {
    if (control === "stopped" && !window.confirm(`¿Detener el run "${run.title}"? Se libera a todas las sesiones y nadie podrá abrir nodos hasta reanudarlo.`)) return;
    await fetch(`/api/runs/${run.id}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ control, actor: "human" }) });
    onChanged();
  };
  if (run.status === "closed") return null;
  return (
    <div className="run-controls" role="group" aria-label="Control del run">
      {run.control !== "active" && <button type="button" className="control-resume" onClick={() => { setControl("active").catch(() => undefined); }}>Reanudar</button>}
      {run.control === "active" && <button type="button" className="control-pause" title="Nadie podrá abrir nodos nuevos; los nodos en curso terminan" onClick={() => { setControl("paused").catch(() => undefined); }}>Pausar</button>}
      {run.control !== "stopped" && <button type="button" className="control-stop" title="Detiene el run para todas las sesiones" onClick={() => { setControl("stopped").catch(() => undefined); }}>Detener</button>}
    </div>
  );
}

function EmptyState({ kind }: { kind: "projects" | "runs" }) {
  return (
    <main className="full-empty">
      <div className="empty-route" aria-hidden="true"><span/><span/><span/></div>
      <h1>{kind === "projects" ? "Inicia un run para comenzar" : "Este proyecto no tiene runs"}</h1>
      <p>{kind === "projects" ? "En cualquier sesión de Claude, Codex o Antigravity con HRP instalado:" : "En una sesión abierta en la carpeta del proyecto:"}</p>
      <pre>/hrp &lt;tarea a desarrollar&gt;</pre>
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

function ProjectTree({ projects, projectId, runId, dock, onProject, onRun, onDeleteProject, onDeleteRun }: {
  projects: ProjectWithRuns[];
  projectId: string;
  runId: string;
  dock?: ReactNode;
  onProject: (project: ProjectWithRuns) => void;
  onRun: (projectId: string, runId: string) => void;
  onDeleteProject: (project: ProjectWithRuns) => void;
  onDeleteRun: (run: RunSummary) => void;
}) {
  const orderedProjects = sortProjects(projects);
  const formatter = new Intl.DateTimeFormat("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
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
    <aside className="project-tree" aria-label="Proyectos, runs y sesiones">
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
          const unaudited = unauditedRuns(project);
          const findingsTotal = openFindingsTotal(project);
          return (
            <section className={`tree-project ${selected ? "is-current" : ""}`} key={project.id}>
              <div className="tree-project-row">
                <button type="button" className="tree-collapse" aria-expanded={!collapsed} aria-label={`${collapsed ? "Expandir" : "Colapsar"} ${project.name}`} onClick={() => toggleCollapse(project.id)}>{collapsed ? "▸" : "▾"}</button>
                <button type="button" className="tree-project-button" aria-current={selected ? "true" : undefined} onClick={() => selectProject(project)}>
                  <span className="tree-branch"><Icon name="folder"/></span>
                  <span><strong>{project.name}</strong><small title={project.workspaceRoot}>{project.workspaceRoot}</small></span>
                </button>
                {unaudited > 0 && <span className="tree-approval-badge" role="status" title={`${unaudited} ${unaudited === 1 ? "run implementado espera" : "runs implementados esperan"} auditoría`}>{unaudited}</span>}
                {findingsTotal > 0 && <span className="tree-findings-badge" role="status" title={`${findingsTotal} ${findingsTotal === 1 ? "hallazgo vivo" : "hallazgos vivos"}`}>{findingsTotal}</span>}
                {collapsed && runs.length > 0 && <span className="tree-run-count" aria-label={`${runs.length} runs`}>{runs.length}</span>}
                <button type="button" className="tree-delete" aria-label={`Eliminar el proyecto ${project.name}`} title="Eliminar proyecto" onClick={() => onDeleteProject(project)}>×</button>
              </div>
              {collapsed ? null : runs.length ? (
                <ul>
                  {visibleRuns.map((run) => (
                    <li className="tree-run-row" key={run.id}>
                      <button type="button" className={`tree-run status-${run.phase === "closed" ? "completed" : run.phase === "hold" ? "failed" : run.runningCount ? "running" : "pending"} ${run.id === runId ? "is-current" : ""}`} aria-current={run.id === runId ? "page" : undefined} onClick={() => onRun(project.id, run.id)}>
                        <span className="tree-signal"/>
                        <span className="tree-run-copy">
                          <strong>{run.title}{run.status === "implemented" && <span className="tree-run-approval" title="Implementado; esperando auditoría">Por auditar</span>}{run.openFindings > 0 && <span className="tree-run-findings" title={`${run.openFindings} ${run.openFindings === 1 ? "hallazgo vivo" : "hallazgos vivos"}`}>En debate</span>}</strong>
                          <small>{phaseCopy[run.phase]} · {run.completedCount}/{run.nodeCount} · {formatter.format(new Date(run.updatedAt))}</small>
                        </span>
                      </button>
                      <button type="button" className="tree-delete" aria-label={`Eliminar el run ${run.title}`} title="Eliminar run" onClick={() => onDeleteRun(run)}>×</button>
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
              ) : <p className="tree-empty">Sin runs</p>}
            </section>
          );
        })}
      </div>
      {dock}
    </aside>
  );
}

function SettingsPanel({ uiPreferences, onUiPreferencesSaved }: { uiPreferences: UiPreferences; onUiPreferencesSaved: (next: UiPreferences) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const save = (patch: Partial<UiPreferences["viewShortcuts"]>) => onUiPreferencesSaved({ ...uiPreferences, viewShortcuts: { ...uiPreferences.viewShortcuts, ...patch } });
  return (
    <div className="settings-wrap">
      <button type="button" className="settings-toggle" aria-expanded={open} aria-label="Configuración" title="Configuración" onClick={() => setOpen((value) => !value)}>
        <Icon name="sliders"/>
      </button>
      {open && (
        <>
          <div className="settings-backdrop" onClick={() => setOpen(false)}/>
          <section className="settings-panel" role="dialog" aria-label="Configuración de HRP">
            <div className="settings-section shortcut-settings">
              <h3>Atajos de vistas</h3>
              <label className="settings-check">
                <input type="checkbox" checked={uiPreferences.viewShortcuts.enabled} onChange={(event) => save({ enabled: event.target.checked })}/>
                <span>Flechas izquierda/derecha recorren Issue, Mapa, Actividad, Hallazgos y Evolución</span>
              </label>
              <div className="shortcut-options" role="group" aria-label="Modificador de atajos de vistas">
                {([["meta", "Command"], ["ctrl", "Ctrl"], ["either", "Ambos"]] as const).map(([modifier, label]) => (
                  <button key={modifier} type="button" className={uiPreferences.viewShortcuts.modifier === modifier ? "active" : ""} aria-pressed={uiPreferences.viewShortcuts.modifier === modifier} onClick={() => save({ modifier: modifier as ViewShortcutModifier })}>{label}</button>
                ))}
              </div>
              <p className="settings-hint">La lupa del mapa se activa manteniendo Command o Ctrl sobre el grafo.</p>
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
            <h3>Ciclo de un run</h3>
            <ol>
              <li>En cualquier sesión: <code>/hrp &lt;tarea&gt;</code>. Esa sesión es el base: escribe el issue, crea la rama y empieza a implementar sin pedir aprobación.</li>
              <li>Copia <code>/hrp attention &lt;id&gt;</code> desde el dock de sesiones y pégalo en otras sesiones (del mismo modelo o de otro). Cada una aparece aquí al engancharse.</li>
              <li>Los auditores revisan el requerimiento, cada nodo al completarse y la integración al cierre. Sus hallazgos los resuelve el base; tú sólo tercias si quieres.</li>
              <li>El run cierra solo cuando cada nodo tiene auditoría ajena, no quedan hallazgos vivos y hay mayoría OK. Después fusionas la rama <code>hrp/run-&lt;id&gt;</code>.</li>
            </ol>
            <h3>Tus palancas</h3>
            <ul>
              <li>Pausar o detener el run.</li>
              <li>Escribir en un hilo de hallazgo, o arbitrar uno escalado.</li>
              <li>Una objeción tardía es un run nuevo.</li>
            </ul>
            <h3>Tips</h3>
            <ul>
              <li>Command/Ctrl sobre el mapa abre la lupa; con Command/Ctrl, las flechas recorren Issue, Mapa, Actividad, Hallazgos y Evolución.</li>
              <li>En Evolución, las flechas sin modificador recorren los cuadros (uno por nodo completado) sobre el árbol de archivos; Inicio y Fin van al primero y al último. Junto al árbol se ve el antes y el después del archivo en foco; clic en un archivo lo enfoca y «Cuadro» muestra el rótulo del nodo.</li>
              <li>Clic en una sesión del dock filtra Actividad y Hallazgos por esa sesión.</li>
              <li>Un run «implementado sin auditar» se queda así hasta que alguien se enganche; nunca cierra solo.</li>
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
  const pendingKey = useMemo(() => entries.map((entry) => `${entry.run.id}:${entry.run.attachedSessions.join(",")}`).sort().join("|"), [entries]);
  const toggleButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closePanel = useCallback(() => { setOpen(false); toggleButtonRef.current?.focus(); }, []);
  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closePanel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closePanel]);
  useEffect(() => {
    if (!open || !pendingKey) { setAttentionByRun({}); return; }
    let cancelled = false;
    Promise.all(entries.flatMap((entry) => entry.run.attachedSessions.map(async (session) => {
      const response = await fetch(`/api/attention?session=${encodeURIComponent(session)}&runId=${encodeURIComponent(entry.run.id)}&waitMs=0`);
      return response.ok ? [await response.json() as AttentionSignal] : [];
    }))).then((groups) => {
      if (cancelled) return;
      const next: Record<string, AttentionSignal[]> = {};
      for (const signal of groups.flat()) next[signal.runId] = [...(next[signal.runId] ?? []), signal];
      setAttentionByRun(next);
    }).catch(() => { if (!cancelled) setAttentionByRun({}); });
    return () => { cancelled = true; };
  }, [open, pendingKey, entries]);
  const runControl = async (entry: GlobalPendingEntry, control: "active" | "paused" | "stopped") => {
    if (control === "stopped" && !window.confirm(`¿Detener "${entry.run.title}"?`)) return;
    setBusyRunId(entry.run.id);
    setError("");
    try { await onControl(entry.run, control); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo actualizar el run"); }
    finally { setBusyRunId(""); }
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
              <div><h3>Pendientes globales</h3><p>{entries.length ? "Runs vivos en todos los proyectos." : "No hay runs vivos."}</p></div>
              <button ref={closeButtonRef} type="button" aria-label="Cerrar pendientes globales" onClick={closePanel}>×</button>
            </header>
            {error && <p className="global-pending-error" role="alert">{error}</p>}
            {entries.length ? (
              <ol className="global-pending-list">
                {entries.map((entry) => {
                  const signals = attentionByRun[entry.run.id] ?? [];
                  const signal = signals.find((candidate) => candidate.actionable) ?? signals.find((candidate) => candidate.waiting) ?? signals[0];
                  return (
                    <li key={entry.run.id} className={`global-pending-item control-${entry.run.control} ${entry.run.id === currentRunId ? "is-current" : ""}`}>
                      <div className="global-pending-main">
                        <div className="global-pending-attention">
                          <span>{signal ? `${signal.session}: ${signal.kind}` : "sin sesiones atentas"}</span>
                          {signal && <p title={signal.directive}>{signal.directive}</p>}
                        </div>
                        <span className="global-pending-state">{entry.run.control === "paused" ? "Pausado" : phaseCopy[entry.run.phase]}</span>
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
                  );
                })}
              </ol>
            ) : <div className="global-pending-empty"><Icon name="check"/><strong>Todo cerrado</strong><p>Ningún run reclama atención.</p></div>}
          </section>
        </>
      )}
    </div>
  );
}

function TopBar({ connectionState, buildStale, project, run, progress = 0, uiPreferences, pendingEntries = [], currentRunId = "", onPendingOpenRun, onPendingControl, onUiPreferencesSaved }: {
  connectionState: ConnectionState;
  buildStale: boolean;
  project?: Project;
  run?: RunSummary;
  progress?: number;
  uiPreferences: UiPreferences;
  pendingEntries?: GlobalPendingEntry[];
  currentRunId?: string;
  onPendingOpenRun?: (projectId: string, runId: string) => void;
  onPendingControl?: (run: RunSummary, control: "active" | "paused" | "stopped") => Promise<void>;
  onUiPreferencesSaved: (next: UiPreferences) => void;
}) {
  const connectionCopy = buildStale ? "Reinicia HRP" : connectionState === "connected" ? "En vivo" : connectionState === "offline" ? "Sin conexión" : "Conectando";
  const connectionClass = buildStale ? "offline" : connectionState;
  return (
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><i/><i/><i/></span><div><strong>Human Review Protocol</strong><span>v4 · auditoría entre sesiones</span></div></div>
      <div className="run-telemetry">
        {run && <div className="progress-track" role="progressbar" aria-label="Progreso del run" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }}/></div>}
        <div className="telemetry-copy"><strong>{run ? phaseCopy[run.phase] : "Sin run"}</strong><span>{project?.workspaceRoot ?? "Ningún proyecto registrado"}</span></div>
      </div>
      <div className="topbar-tools">
        {onPendingOpenRun && onPendingControl && <GlobalPendingPanel entries={pendingEntries} currentRunId={currentRunId} onOpenRun={onPendingOpenRun} onControl={onPendingControl}/>}
        <SettingsPanel uiPreferences={uiPreferences} onUiPreferencesSaved={onUiPreferencesSaved}/>
        <HelpPanel/>
      </div>
      <span className={`connection ${connectionClass}`} role="status" title={buildStale ? "El build cambió. Ejecuta ./scripts/update.sh para reiniciar el servicio." : undefined}><i/>{connectionCopy}{!buildStale && connectionState === "offline" && <button type="button" onClick={() => location.reload()}>Reintentar</button>}</span>
    </header>
  );
}

export function App() {
  const [catalog, setCatalog] = useState<Catalog>({ projects: [] });
  const [projectId, setProjectId] = useState(() => new URLSearchParams(location.search).get("project") ?? "");
  const [runId, setRunId] = useState(() => new URLSearchParams(location.search).get("run") ?? "");
  const [detail, setDetail] = useState<RunDetail>();
  const [selectedId, setSelectedId] = useState<string>();
  const [view, setView] = useState<View>("map");
  const [sessionFilter, setSessionFilter] = useState("");
  const [focusFindingId, setFocusFindingId] = useState<string>();
  const [evolution, setEvolution] = useState<EvolutionState>();
  const [evolutionError, setEvolutionError] = useState("");
  const [frameIndex, setFrameIndex] = useState(-1);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [buildStale, setBuildStale] = useState(false);
  const [uiPreferences, setUiPreferences] = useState<UiPreferences>(readUiPreferences);
  const [inspectorCollapsed, setInspectorCollapsed] = useState<boolean>(readInspectorCollapsed);
  const toggleInspector = useCallback(() => setInspectorCollapsed((current) => {
    const next = !current;
    try { localStorage.setItem(inspectorCollapsedKey, String(next)); } catch { /* preferencia efímera */ }
    return next;
  }), []);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [loadingRun, setLoadingRun] = useState(false);
  const [error, setError] = useState<string>();
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

  // --- Lupa del mapa (idéntica a v3) ---
  const cancelPendingGraphFit = useCallback(() => {
    pendingGraphFitCancel.current?.();
    pendingGraphFitCancel.current = undefined;
  }, []);
  const setGraphMagnifierSnapshot = useCallback((next: GraphMagnifierState) => {
    graphMagnifierActive.current = next.active;
    setGraphMagnifier((current) => (
      current.active === next.active && current.x === next.x && current.y === next.y && current.width === next.width && current.height === next.height
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
      inside: true, clientX, clientY,
      x: Math.min(Math.max(clientX - rect.left, 0), rect.width),
      y: Math.min(Math.max(clientY - rect.top, 0), rect.height),
      width: rect.width, height: rect.height,
    };
    graphPointer.current = pointer;
    return pointer;
  }, []);
  const refreshGraphPointer = useCallback((target = flowWrapRef.current): GraphPointerState => {
    if (!target) { resetGraphPointer(); return graphPointer.current; }
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
  const leaveGraphMagnifier = useCallback(() => { resetGraphPointer(); hideGraphMagnifier(); }, [hideGraphMagnifier, resetGraphPointer]);
  const setFlowWrapElement = useCallback((element: HTMLDivElement | null) => {
    flowWrapRef.current = element;
    resetGraphPointer();
    if (!element) hideGraphMagnifier();
  }, [hideGraphMagnifier, resetGraphPointer]);

  // --- Carga ---
  const loadCatalog = useCallback(async ({ focus, visibleProjectId }: CatalogLoadOptions = {}) => {
    try {
      const response = await fetch("/api/projects");
      if (!response.ok) throw new Error("No se pudo cargar la lista de proyectos");
      const next = await response.json() as Catalog;
      const nextFocus = resolveCatalogRunFocus(next.projects, { focus, currentProjectId: visibleProjectId, knownRunIds: knownRunIds.current });
      knownRunIds.current = collectCatalogRunIds(next.projects);
      setCatalog(next);
      setProjectId((current) => nextFocus?.projectId ?? (current && next.projects.some((project) => project.id === current) ? current : next.projects[0]?.id ?? ""));
      if (nextFocus) setRunId(nextFocus.runId);
    } finally {
      setLoadingCatalog(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    if (!id) { loadedRunId.current = ""; setDetail(undefined); setLoadingRun(false); return; }
    const switching = loadedRunId.current !== id;
    if (switching) setLoadingRun(true);
    try {
      const response = await fetch(`/api/runs/${id}`);
      if (!response.ok) throw new Error("No se pudo cargar el run");
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

  const loadHealth = useCallback(async () => {
    try {
      const response = await fetch("/api/health");
      if (response.ok) setBuildStale((await response.json() as Health).buildStale === true);
    } catch { /* connectionState ya lo representa */ }
  }, []);

  const saveUiPreferences = useCallback((next: UiPreferences) => {
    setUiPreferences(next);
    try { localStorage.setItem(uiPreferencesKey, JSON.stringify(next)); } catch { /* preferencia efímera */ }
  }, []);

  useEffect(() => { loadCatalog().catch((cause) => setError(String(cause))); }, [loadCatalog]);
  useEffect(() => {
    loadHealth().catch(() => undefined);
    const interval = window.setInterval(() => { loadHealth().catch(() => undefined); }, 15_000);
    return () => window.clearInterval(interval);
  }, [loadHealth]);

  const project = catalog.projects.find((candidate) => candidate.id === projectId);
  useEffect(() => {
    if (!project) { setRunId(""); return; }
    setRunId((current) => current && project.runs.some((run) => run.id === current) ? current : sortRuns(project.runs)[0]?.id ?? "");
  }, [project]);
  useEffect(() => { currentProjectId.current = projectId; }, [projectId]);
  useEffect(() => { currentRunId.current = runId; }, [runId]);
  useEffect(() => { loadDetail(runId).catch((cause) => setError(String(cause))); }, [runId, loadDetail]);
  useEffect(() => { setSessionFilter(""); setFocusFindingId(undefined); }, [runId]);

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

  const deleteRun = useCallback(async (run: RunSummary) => {
    if (!window.confirm(`¿Eliminar el run "${run.title}" con toda su evidencia? La rama git se conserva. Esta acción es permanente.`)) return;
    await fetch(`/api/runs/${run.id}`, { method: "DELETE" });
    if (run.id === runId) setRunId("");
    await loadCatalog();
  }, [runId, loadCatalog]);

  const deleteProject = useCallback(async (target: ProjectWithRuns) => {
    const runsCopy = target.runs.length === 1 ? "su run" : `sus ${target.runs.length} runs`;
    if (!window.confirm(`¿Eliminar el proyecto "${target.name}"${target.runs.length ? ` con ${runsCopy}` : ""}? Esta acción es permanente.`)) return;
    await fetch(`/api/projects/${target.id}`, { method: "DELETE" });
    if (target.id === projectId) { setProjectId(""); setRunId(""); }
    await loadCatalog();
  }, [projectId, loadCatalog]);

  const setRunControl = useCallback(async (run: RunSummary, control: "active" | "paused" | "stopped") => {
    const response = await fetch(`/api/runs/${run.id}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ control, actor: "human" }) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? "No se pudo actualizar el control del run");
    }
    await loadCatalog({ visibleProjectId: projectId });
    if (run.id === runId) await loadDetail(run.id);
  }, [projectId, runId, loadCatalog, loadDetail]);

  const graph = useMemo(() => layoutGraph(detail?.nodes ?? [], selectedId, setSelectedId), [detail?.nodes, selectedId]);
  const nodeSetKey = useMemo(() => (detail?.nodes ?? []).map((node) => node.id).sort().join("|"), [detail?.nodes]);
  const flowMounted = isGraphFlowMounted(view, detail?.nodes.length);

  // --- Evolución: se recarga cuando cambia el conjunto de nodos completados ---
  const evolutionRunId = detail?.run.id ?? "";
  const completedKey = useMemo(() => (detail?.nodes ?? []).filter((node) => node.status === "completed").map((node) => `${node.id}@${node.commit ?? ""}`).join("|"), [detail?.nodes]);
  useEffect(() => {
    if (!evolutionRunId) { setEvolution(undefined); setEvolutionError(""); return; }
    let cancelled = false;
    fetch(`/api/runs/${evolutionRunId}/evolution`)
      .then(async (response) => {
        if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "No se pudo cargar la evolución");
        return await response.json() as EvolutionData;
      })
      .then((data) => { if (!cancelled) { setEvolution({ runId: evolutionRunId, data }); setEvolutionError(""); } })
      .catch((cause) => { if (!cancelled) setEvolutionError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [evolutionRunId, completedKey]);
  const evolutionData = evolution?.runId === evolutionRunId ? evolution.data : undefined;
  const evolutionFrames = evolutionData?.frames ?? [];
  useEffect(() => {
    setFrameIndex((current) => current >= 0 && current < evolutionFrames.length ? current : evolutionFrames.length - 1);
  }, [evolutionFrames.length, evolutionRunId]);
  useEffect(() => {
    const index = frameIndexForNode(evolutionFrames, selectedId);
    if (index !== -1) setFrameIndex(index);
  }, [selectedId, evolutionFrames]);
  // Entrar a Evolución con un nodo que no es cuadro (en curso, fallido o
  // ninguno) alinea la selección con el cuadro mostrado.
  useEffect(() => {
    if (view !== "evolution") return;
    const frame = evolutionFrames[frameIndex];
    if (frame && frameIndexForNode(evolutionFrames, selectedId) === -1) setSelectedId(frame.nodeId);
    // selectedId se omite a propósito: sólo importa al entrar o al cambiar de cuadro.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, evolutionFrames, frameIndex]);
  const goToFrame = useCallback((index: number) => {
    const frame = evolutionFrames[index];
    if (!frame) return;
    setFrameIndex(index);
    setSelectedId(frame.nodeId);
  }, [evolutionFrames]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcutsAvailable = Boolean(runId && detail);
      // Sin modificador, en Evolución, las flechas mueven el cuadro; con
      // modificador recorren las vistas. No compiten.
      const nextFrame = shortcutsAvailable ? resolveEvolutionFrameShortcut({ event, index: frameIndex, length: evolutionFrames.length, view }) : null;
      if (nextFrame !== null) { event.preventDefault(); goToFrame(nextFrame); return; }
      const isViewShortcut = shortcutsAvailable && isViewShortcutEvent({ event, preferences: uiPreferences });
      const nextView = isViewShortcut ? resolveViewShortcut({ currentView: view, event, preferences: uiPreferences }) : null;
      if (nextView) { event.preventDefault(); hideGraphMagnifier(); setView(nextView); return; }
      if (isViewShortcut) { event.preventDefault(); return; }
      if (event.metaKey || event.ctrlKey) showGraphMagnifier(refreshGraphPointer());
    };
    const onKeyUp = (event: KeyboardEvent) => { if (!event.metaKey && !event.ctrlKey) hideGraphMagnifier(); };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", hideGraphMagnifier);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", hideGraphMagnifier);
    };
  }, [detail, hideGraphMagnifier, refreshGraphPointer, runId, showGraphMagnifier, uiPreferences, view, evolutionFrames.length, frameIndex, goToFrame]);

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
    const cancel = () => { cancelled = true; window.clearTimeout(timer); };
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
    return () => { observer?.disconnect(); window.removeEventListener("resize", refresh); };
  }, [flowMounted, refreshGraphPointer, showGraphMagnifier]);

  const selectedNode = detail?.nodes.find((node) => node.id === selectedId);
  const progress = detail?.run.nodeCount ? Math.round((detail.run.completedCount / detail.run.nodeCount) * 100) : 0;
  const liveFindingsCount = detail?.findings.filter(isLiveFinding).length ?? 0;
  const criticalFindings = detail?.findings.filter((finding) => finding.severity === "critical" && isLiveFinding(finding)) ?? [];
  const escalatedFindings = detail?.findings.filter((finding) => finding.status === "escalated") ?? [];
  const globalPending = useMemo(() => globalPendingEntries(catalog.projects), [catalog.projects]);
  const sessionNames = useMemo(() => {
    const names = new Set<string>();
    for (const session of detail?.sessions ?? []) names.add(session.id);
    for (const item of detail?.activity ?? []) if (item.agent) names.add(item.agent);
    for (const finding of detail?.findings ?? []) { names.add(finding.reviewer); for (const message of finding.messages) names.add(message.author); }
    return [...names].sort((left, right) => (left === "human" ? 1 : 0) - (right === "human" ? 1 : 0) || left.localeCompare(right));
  }, [detail]);
  const graphMagnifierStyle: CSSProperties = { left: graphMagnifier.x, top: graphMagnifier.y, width: graphMagnifierSize, height: graphMagnifierSize };
  const graphMagnifierTransform = magnifierContentTransform({
    height: graphMagnifier.height, lensSize: graphMagnifierSize, pointerX: graphMagnifier.x, pointerY: graphMagnifier.y,
    targetScale: graphMagnifierTargetScale, viewport: graphViewport, width: graphMagnifier.width,
  });
  const graphMagnifierContentStyle: CSSProperties = { width: graphMagnifierTransform.width, height: graphMagnifierTransform.height, transform: graphMagnifierTransform.transform };
  const refresh = () => { if (detail) loadDetail(detail.run.id).catch(() => undefined); };
  const focusSession = (session: string) => { setSessionFilter((current) => current === session ? "" : session); if (view === "map" || view === "issue") setView("activity"); };
  const openFinding = (id: string) => { setFocusFindingId(id); setView("findings"); };

  const topBar = <TopBar connectionState={connectionState} buildStale={buildStale} project={project} run={detail?.run} progress={progress} uiPreferences={uiPreferences} pendingEntries={globalPending} currentRunId={runId} onPendingOpenRun={(nextProjectId, nextRunId) => { setProjectId(nextProjectId); setRunId(nextRunId); }} onPendingControl={setRunControl} onUiPreferencesSaved={saveUiPreferences}/>;

  if (error) return <div className="fatal-error"><Icon name="warning"/><h1>HRP no pudo iniciar</h1><p>{error}</p><button onClick={() => location.reload()}>Volver a intentar</button></div>;
  if (loadingCatalog) return <>{topBar}<LoadingState label="Cargando proyectos"/></>;
  if (!catalog.projects.length) return <>{topBar}<EmptyState kind="projects"/></>;

  return (
    <div className="app-shell">
      {topBar}
      <div className="app-body">
        <ProjectTree
          projects={catalog.projects}
          projectId={projectId}
          runId={runId}
          dock={!loadingRun && detail?.run.id === runId ? <SessionDock run={detail.run} nodes={detail.nodes} sessions={detail.sessions} onFocusSession={focusSession}/> : undefined}
          onProject={(nextProject) => { setProjectId(nextProject.id); setRunId(sortRuns(nextProject.runs)[0]?.id ?? ""); }}
          onRun={(nextProjectId, nextRunId) => { setProjectId(nextProjectId); setRunId(nextRunId); }}
          onDeleteProject={(target) => { deleteProject(target).catch(() => undefined); }}
          onDeleteRun={(target) => { deleteRun(target).catch(() => undefined); }}
        />
        <div className="content-shell">
          <div className="content-toolbar">
            <div className="current-context"><Icon name="route"/><span>{detail?.run.title ?? "Sin run seleccionado"}</span></div>
            <nav aria-label="Vista principal">
              <button aria-pressed={view === "issue"} className={view === "issue" ? "active" : ""} onClick={() => setView("issue")}><Icon name="doc"/>Issue</button>
              <button aria-pressed={view === "map"} className={view === "map" ? "active" : ""} onClick={() => setView("map")}><Icon name="route"/>Mapa</button>
              <button aria-pressed={view === "activity"} className={view === "activity" ? "active" : ""} onClick={() => setView("activity")}><Icon name="activity"/>Actividad</button>
              <button aria-pressed={view === "findings"} className={view === "findings" ? "active" : ""} onClick={() => setView("findings")}><Icon name="warning"/>Hallazgos{liveFindingsCount > 0 && <span className="nav-findings-count">{liveFindingsCount}</span>}</button>
              <button aria-pressed={view === "evolution"} className={view === "evolution" ? "active" : ""} onClick={() => setView("evolution")}><Icon name="timeline"/>Evolución</button>
            </nav>
          </div>
          {loadingRun ? <LoadingState label="Cargando run"/> : !runId || !detail ? <EmptyState kind="runs"/> : (
            <main className={`workspace ${inspectorCollapsed ? "inspector-collapsed" : ""}`}>
              <section className="map-stage" aria-label={view === "map" ? "Mapa de cambios" : view === "issue" ? "Issue del run" : view === "activity" ? "Actividad del run" : view === "evolution" ? "Evolución del run" : "Hallazgos del run"}>
                <header className="stage-head">
                  <div>
                    <h1>{detail.run.title}</h1>
                    <p>{phaseCopy[detail.run.phase]} · base {detail.run.base} · <span className="activity-agent" title={`Rama del run: ${detail.run.branch}`}>{detail.run.branch}</span></p>
                  </div>
                  <div className="stage-actions">
                    <RunControls run={detail.run} onChanged={refresh}/>
                    <div className="stage-count"><strong>{detail.run.completedCount}/{detail.run.nodeCount}</strong><span>nodos terminados</span></div>
                  </div>
                </header>
                {detail.run.control !== "active" && (
                  <div className={`control-banner control-banner-${detail.run.control}`} role="status">
                    <Icon name={detail.run.control === "paused" ? "clock" : "warning"}/>
                    <p>{detail.run.control === "paused" ? "Run pausado: nadie puede abrir nodos hasta que lo reanudes; los nodos en curso terminan." : "Run detenido: todas las sesiones quedaron liberadas. Puedes reanudarlo."}</p>
                  </div>
                )}
                {criticalFindings.length > 0 && view !== "findings" && (
                  <div className="approval-banner findings-banner" role="status">
                    <Icon name="warning"/>
                    <p>Run en hold: {criticalFindings.length === 1 ? "un hallazgo crítico" : `${criticalFindings.length} hallazgos críticos`} bloquea{criticalFindings.length === 1 ? "" : "n"} al base hasta resolverlo.</p>
                    <button type="button" onClick={() => setView("findings")}>Ver hallazgos</button>
                  </div>
                )}
                {detail.run.status === "implemented" && (
                  <div className="approval-banner" role="status">
                    <Icon name={detail.run.audit.pendingVoters.length ? "clock" : "warning"}/>
                    <p>{detail.run.attachedSessions.length > 1
                      ? `Implementado; esperando auditoría. Bloquea: ${detail.run.audit.blockers.join("; ")}.`
                      : "Implementado sin auditores: no cerrará solo. Pega el comando de enganche en otra sesión."}</p>
                    {detail.run.attachedSessions.length <= 1 && <CopyButton text={attentionCommand(detail.run.id)} label="Copiar el comando de enganche"/>}
                  </div>
                )}
                {escalatedFindings.length > 0 && view !== "findings" && (
                  <div className="approval-banner findings-banner" role="status">
                    <Icon name="warning"/>
                    <p>{escalatedFindings.length === 1 ? "1 hallazgo espera tu arbitraje." : `${escalatedFindings.length} hallazgos esperan tu arbitraje.`} Los modelos no llegaron a acuerdo.</p>
                    <button type="button" onClick={() => setView("findings")}>Ver hallazgos</button>
                  </div>
                )}
                {(view === "activity" || view === "findings") && <SessionFilterBar sessions={sessionNames} value={sessionFilter} onChange={setSessionFilter}/>}
                {view === "issue" ? (
                  <IssueView detail={detail}/>
                ) : view === "evolution" ? (
                  <EvolutionView runId={detail.run.id} evolution={evolutionData} error={evolutionError} nodes={detail.nodes} findings={detail.findings} frameIndex={frameIndex} onFrame={goToFrame} onSelectFinding={openFinding}/>
                ) : view === "findings" ? (
                  <FindingsPanel findings={detail.findings} nodes={detail.nodes} sessionFilter={sessionFilter} focusId={focusFindingId} onChanged={refresh} onSelectNode={(id) => { setSelectedId(id); setView("map"); }}/>
                ) : view === "map" ? (
                  detail.nodes.length ? <div className={`flow-wrap ${graphMagnifier.active ? "is-magnifying" : ""}`} ref={setFlowWrapElement} onPointerEnter={enterGraphMagnifier} onPointerMove={updateGraphMagnifier} onPointerLeave={leaveGraphMagnifier}>
                    <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false} onInit={(instance) => { flowInstance.current = instance; updateGraphViewport(instance.getViewport()); appliedGraphViewportKey.current = ""; applyGraphViewport(0); }} onViewportChange={updateGraphViewport} onMoveStart={(event) => { if (event) { graphViewportUserMoved.current = true; cancelPendingGraphFit(); } }} onMoveEnd={(_event, viewport) => { updateGraphViewport(viewport); if (shouldPersistGraphViewport({ nodeSetKey, runId, userMoved: graphViewportUserMoved.current })) graphViewports.current.set(runId, { nodeSetKey, viewport }); graphViewportUserMoved.current = false; }} onNodeClick={(_event, node) => setSelectedId(node.id)} onPaneClick={() => setSelectedId("")} ariaLabelConfig={graphAriaLabels} minZoom={graphMinZoom} maxZoom={graphMaxZoom} proOptions={{ hideAttribution: true }}><Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#aab5af"/><Controls showInteractive={false} aria-label="Controles del mapa"/></ReactFlow>
                    {graphMagnifier.active && (
                      <div className="graph-magnifier" style={graphMagnifierStyle} aria-hidden="true" inert>
                        <div className="graph-magnifier__content" style={graphMagnifierContentStyle}>
                          <ReactFlow className="graph-magnifier__flow" nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false} viewport={graphViewport} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} panOnDrag={false} panOnScroll={false} preventScrolling={false} ariaLabelConfig={graphAriaLabels} minZoom={graphMinZoom} maxZoom={graphMaxZoom} proOptions={{ hideAttribution: true }}><Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#aab5af"/></ReactFlow>
                        </div>
                      </div>
                    )}
                  </div>
                    : <div className="map-empty"><Icon name="route"/><h2>Todavía no hay nodos</h2><p>El mapa se dibuja conforme el base abre y completa operaciones.</p><button type="button" className="map-empty-cta" onClick={() => setView("issue")}><Icon name="doc"/>Ver el issue</button></div>
                ) : <ActivityLedger activity={detail.activity} nodes={detail.nodes} sessionFilter={sessionFilter} onSelect={(id) => { setSelectedId(id); setView("map"); }}/>}
              </section>
              <Inspector node={selectedNode} nodes={detail.nodes} findings={detail.findings} collapsed={inspectorCollapsed} onToggle={toggleInspector} onSelectFinding={openFinding}/>
            </main>
          )}
        </div>
      </div>
    </div>
  );
}
