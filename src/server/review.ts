import { PROTOCOL_VERSION, type ChangeNode } from "../shared/protocol.js";
import type { HrpStore } from "./store.js";

function fenceFor(content: string): string {
  let longest = 0;
  for (const match of content.matchAll(/`{3,}/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

// Paquete de auditoría: lo que un auditor necesita para revisar sin el panel.
// Con nodeIds se limita a esos nodos; sin ellos es la pasada de integración y
// lleva todos los nodos completados más el resultado de los criterios.
export function buildReviewPack(store: HrpStore, runId: string, nodeIds?: string[]): string {
  const detail = store.getRunDetail(runId);
  if (!detail) throw new Error(`Unknown run: ${runId}`);
  const byId = new Map(detail.nodes.map((node) => [node.id, node]));
  let scope = detail.nodes;
  if (nodeIds?.length) {
    const unknown = nodeIds.filter((id) => !byId.has(id));
    if (unknown.length) throw new Error(`Unknown nodes: ${unknown.join(", ")}`);
    const keep = new Set(nodeIds);
    scope = detail.nodes.filter((node) => keep.has(node.id));
  }
  const integration = !nodeIds?.length;
  const lines: string[] = [
    `# Paquete de auditoría HRP v${PROTOCOL_VERSION}`,
    "",
    `- Run: ${detail.run.id} · ${detail.run.title}`,
    `- Estado: ${detail.run.phase} · control ${detail.run.control}`,
    `- Workspace: ${detail.project.workspaceRoot} · rama ${detail.run.branch}`,
    `- Base: ${detail.run.base ?? "(sin registrar)"}`,
    `- Issue: ${detail.run.issuePath} (léelo con hrp_run_issue)`,
    "",
    "## Tu rol: auditor",
    "",
    "No edites código. Tu salida son hallazgos y debate. Busca desviaciones entre el requerimiento",
    "literal y lo implementado, contratos rotos entre nodos, casos borde sin cubrir y verificaciones",
    "que no prueban lo que dicen. Si no encuentras nada, dilo: declara la cobertura igualmente.",
    "",
    integration ? "## Nodos del run" : "## Nodos en tu alcance (hay más en el run)",
    "",
    ...scope.map((node) => `- ${node.id} [${node.status}] ${node.file} · ${node.symbol} — ${node.title}${node.dependencies.length ? ` ← depende de ${node.dependencies.join(", ")}` : ""}${node.auditedBy.length ? ` · auditado por ${node.auditedBy.join(", ")}` : ""}`),
  ];
  if (integration && detail.run.acceptance.length) {
    lines.push("", "## Criterios de aceptación", "");
    for (const criterion of detail.run.acceptance) {
      const result = criterion.result ? ` → ${criterion.result.passed ? "pasó" : `falló (exit ${criterion.result.exitCode})`}` : criterion.command ? " → sin ejecutar" : "";
      lines.push(`- ${criterion.text}${criterion.command ? ` (\`${criterion.command}\`)` : ""}${result}`);
    }
  }
  if (detail.findings.length) {
    lines.push("", "## Hallazgos ya reportados (no los dupliques)", "");
    for (const finding of detail.findings) {
      lines.push(`- ${finding.id} [${finding.status}/${finding.severity}/${finding.scope}] ${finding.title} (${finding.reviewer}${finding.nodeId ? ` · nodo ${finding.nodeId}` : ""}${finding.resolutionNodeId ? ` · corrección ${finding.resolutionNodeId}` : ""})`);
    }
  }
  const completed = scope.filter((node): node is ChangeNode & { diff: string } => node.status === "completed" && Boolean(node.diff));
  for (const node of completed) {
    const diffFence = fenceFor(node.diff);
    lines.push(
      "",
      `## Nodo ${node.id}: ${node.title}`,
      "",
      `- Archivo: ${node.file} · ${node.symbol}`,
      `- Intención: ${node.description}`,
      `- Por qué: ${node.rationale}`,
      `- Resumen del parche: ${node.patchSummary ?? "(sin resumen)"}`,
      `- Commit: ${node.commit ?? "(sin commit)"}`,
      "",
      `${diffFence}diff`,
      node.diff,
      diffFence,
    );
    if (node.verification) {
      const output = node.verification.output.slice(-2000);
      const outputFence = fenceFor(output);
      lines.push("", `Verificación (exit ${node.verification.exitCode}, ${node.verification.passed ? "pasó" : "falló"}): \`${node.verification.command}\``, "", outputFence, output, outputFence);
    }
  }
  return lines.join("\n");
}
