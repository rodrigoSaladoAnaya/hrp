// Runner para modelos sin sesión de chat. Ollama es el primero: se engancha al
// run como una sesión más ('ollama:N'), sigue las mismas directivas que un
// auditor con sesión y publica hallazgos por la misma API. Vive en el servidor
// compilado para que el CLI (hrp attend) no duplique el contrato.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { findingSeverities, type Finding, type FindingSeverity, type RunDetail, type Session } from "../shared/protocol.js";
import type { Attention } from "./attention.js";

export type RunnerOptions = {
  baseUrl: string;
  runId: string;
  family: string;
  model: string;
  ollamaUrl: string;
  apiKey?: string;
  log: (message: string) => void;
  // Para pruebas: sustituye la llamada al modelo.
  ask?: (prompt: string) => Promise<string>;
};

type ReviewItem = { severity: FindingSeverity; title: string; body: string; node?: string };

function upstreamJson(target: string, headers: Record<string, string>, payload: string): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const parsed = new URL(target);
  const requestFn = parsed.protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const clientRequest = requestFn(parsed, {
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(payload)) },
      timeout: 1_800_000,
    }, (upstream) => {
      let raw = "";
      upstream.setEncoding("utf8");
      upstream.on("data", (chunk) => { raw += chunk; });
      upstream.on("end", () => {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* el status decide */ }
        resolve({ statusCode: upstream.statusCode ?? 500, body });
      });
    });
    clientRequest.on("timeout", () => clientRequest.destroy(new Error("el modelo no respondió en 30 minutos")));
    clientRequest.on("error", reject);
    clientRequest.end(payload);
  });
}

function unwrapFence(answer: string): string {
  const match = /^`{3,}[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?`{3,}$/.exec(answer.trim());
  return match ? match[1].trim() : answer.trim();
}

// Respuesta esperada del modelo: SIN-HALLAZGOS o un arreglo JSON de hallazgos;
// en la pasada de integración puede añadir {"vote":"ok|reject"} al final.
export function parseReview(answer: string): { findings: ReviewItem[]; vote?: "ok" | "reject" } {
  const text = unwrapFence(answer);
  if (/^SIN-HALLAZGOS/i.test(text)) return { findings: [], vote: "ok" };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`la respuesta del modelo no es JSON ni SIN-HALLAZGOS: ${text.slice(0, 160)}`); }
  const container = Array.isArray(parsed) ? { findings: parsed } : (parsed as { findings?: unknown; vote?: unknown });
  const findings = Array.isArray(container.findings) ? container.findings : [];
  for (const item of findings as Array<Partial<ReviewItem>>) {
    if (!item || typeof item.title !== "string" || !item.title || typeof item.body !== "string" || !item.body || !findingSeverities.includes(item.severity as FindingSeverity)) {
      throw new Error(`hallazgo con formato inválido: ${JSON.stringify(item).slice(0, 160)}`);
    }
  }
  const vote = container.vote === "reject" ? "reject" : container.vote === "ok" ? "ok" : undefined;
  return { findings: findings as ReviewItem[], vote };
}

const instructions = [
  "Eres un modelo auditor dentro de Human Review Protocol v4. No edites código: tu salida son hallazgos.",
  "Busca únicamente problemas reales y verificables: desviaciones entre el requerimiento literal y lo implementado, contratos rotos, casos borde sin cubrir, verificaciones que no prueban lo que dicen.",
  "Responde ÚNICAMENTE con un arreglo JSON, sin explicaciones ni fences: cada elemento es {\"severity\":\"critical|major|minor|question\",\"title\":\"...\",\"body\":\"...\",\"node\":\"id-del-nodo\"} y \"node\" es opcional.",
  "critical sólo si rompe el requerimiento o el sistema. Si no encuentras nada real, responde exactamente SIN-HALLAZGOS. No inventes hallazgos para rellenar.",
];

export async function runAttendLoop(options: RunnerOptions): Promise<void> {
  const { baseUrl, runId, family, model, log } = options;
  const api = async <T,>(endpoint: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${baseUrl}${endpoint}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `${response.status} ${response.statusText}`);
    }
    const type = response.headers.get("content-type") ?? "";
    return (type.includes("json") ? await response.json() : await response.text()) as T;
  };
  const post = <T,>(endpoint: string, body: unknown) => api<T>(endpoint, { method: "POST", body: JSON.stringify(body) });
  const ask = options.ask ?? (async (prompt: string): Promise<string> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
    const upstream = await upstreamJson(`${options.ollamaUrl.replace(/\/$/, "")}/api/chat`, headers, JSON.stringify({
      model, stream: false, options: { temperature: 0 }, messages: [{ role: "user", content: prompt }],
    }));
    const body = upstream.body as { message?: { content?: string }; error?: string };
    if (upstream.statusCode >= 400) throw new Error(`ollama respondió ${upstream.statusCode}: ${body.error ?? "error"}`);
    return String(body.message?.content ?? "");
  });

  const session = await post<Session>(`/api/runs/${encodeURIComponent(runId)}/sessions`, { family });
  const me = session.id;
  log(`enganchado a ${runId} como ${me} (modelo ${model})`);
  const encodedRun = encodeURIComponent(runId);

  const publish = async (items: ReviewItem[], scope: "requirement" | "node" | "integration", validNodes: Set<string>) => {
    for (const item of items) {
      const nodeId = scope === "node" && item.node && validNodes.has(item.node) ? item.node : undefined;
      const body = scope === "node" && item.node && !nodeId ? `${item.body}\n(El auditor refirió el nodo "${item.node}", fuera del alcance de esta pasada.)` : item.body;
      await post(`/api/runs/${encodedRun}/findings`, { reviewer: me, severity: item.severity, title: item.title, body, nodeId, scope: nodeId ? "node" : scope });
      log(`hallazgo ${item.severity}: ${item.title}`);
    }
  };

  for (;;) {
    let signal: Attention;
    try {
      signal = await api<Attention>(`/api/attention?session=${encodeURIComponent(me)}&runId=${encodedRun}&waitMs=240000`);
    } catch (error) {
      log(`sin señal (${error instanceof Error ? error.message : String(error)}); reintento en 5s`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    if (signal.terminal) { log(`fin: ${signal.directive}`); return; }
    if (!signal.actionable) continue;
    try {
      const detail = await api<RunDetail>(`/api/runs/${encodedRun}`);
      switch (signal.kind) {
        case "requirement": {
          const prompt = [...instructions, "", "Audita el ISSUE: compara la interpretación del base con el requerimiento literal y los criterios de aceptación.", "", detail.issue].join("\n");
          const review = parseReview(await ask(prompt));
          await publish(review.findings, "requirement", new Set());
          await post(`/api/runs/${encodedRun}/sessions/${encodeURIComponent(me)}/audit`, { requirement: true });
          log(`requerimiento auditado: ${review.findings.length} hallazgos`);
          break;
        }
        case "node": {
          const pending = detail.nodes.filter((node) => node.status === "completed" && node.author !== me && !node.auditedBy.includes(me)).map((node) => node.id);
          const pack = await api<string>(`/api/runs/${encodedRun}/review-pack?nodeIds=${encodeURIComponent(pending.join(","))}`);
          if (pack.length > 300_000) throw new Error("el paquete excede 300KB; audita con una sesión con más contexto");
          const review = parseReview(await ask([...instructions, "", pack].join("\n")));
          await publish(review.findings, "node", new Set(pending));
          await post(`/api/runs/${encodedRun}/sessions/${encodeURIComponent(me)}/audit`, { nodeIds: pending });
          log(`nodos ${pending.join(", ")} auditados: ${review.findings.length} hallazgos`);
          break;
        }
        case "close": {
          const pack = await api<string>(`/api/runs/${encodedRun}/review-pack`);
          const prompt = [...instructions,
            "Esta es la pasada de INTEGRACIÓN. Responde con un objeto {\"findings\":[...],\"vote\":\"ok|reject\"}: ok si el run cumple el requerimiento sin problemas graves, reject si no.",
            "", pack].join("\n");
          const review = parseReview(await ask(prompt));
          await publish(review.findings, "integration", new Set());
          const vote = review.vote ?? (review.findings.some((item) => item.severity === "critical" || item.severity === "major") ? "reject" : "ok");
          await post(`/api/runs/${encodedRun}/sessions/${encodeURIComponent(me)}/vote`, { vote, detail: `Pasada de integración de ${model}: ${review.findings.length} hallazgos` });
          log(`voto ${vote}`);
          break;
        }
        case "finding": {
          const mine = detail.findings.filter((finding: Finding) => (finding.reviewer === me || finding.messages.some((message) => message.author === me))
            && (finding.status === "open" || finding.status === "debating")
            && finding.messages.length && finding.messages[finding.messages.length - 1].author !== me);
          for (const finding of mine) {
            const thread = finding.messages.map((message) => `${message.author}: ${message.body}`).join("\n\n");
            const prompt = [
              "Eres el auditor que reportó (o participó en) este hallazgo dentro de HRP v4. El base respondió. Contesta en un párrafo:",
              "si su respuesta resuelve tu objeción, di explícitamente que aceptas; si no, rebate con evidencia concreta. No inventes.",
              "", `Hallazgo [${finding.severity}] ${finding.title}`, finding.body, "", "Hilo:", thread,
            ].join("\n");
            const reply = (await ask(prompt)).trim().slice(0, 4000);
            await post(`/api/findings/${encodeURIComponent(finding.id)}/messages`, { author: me, body: reply || "Sin objeciones adicionales; acepto la respuesta." });
            log(`respondido en ${finding.id}`);
          }
          break;
        }
        default:
          log(`directiva ${signal.kind} no aplica a un runner; espero`);
          await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`fallo en ${signal.kind}: ${message}`);
      try { await post(`/api/runs/${encodedRun}/activity`, { type: "note", message: `Runner ${me} falló en ${signal.kind}: ${message}`, agent: me }); } catch { /* sin servicio */ }
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
  }
}
