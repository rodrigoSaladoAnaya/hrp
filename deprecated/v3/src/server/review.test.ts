import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPlanReviewPack, buildReviewPack, runAutoReview, runPlanReview } from "./review.js";
import { HrpStore } from "./store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "hrp-review-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const store = new HrpStore(path.join(root, "data"));
  const project = store.attachProject(workspace);
  const run = store.createRun(project.id, "Review", "Audit the completed graph");
  return { store, run };
}

async function waitUntilAfter(isoTimestamp: string): Promise<void> {
  while (Date.now() <= Date.parse(isoTimestamp)) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function ollamaServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unexpected test server address"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((closeResolve, closeReject) => {
          server.close((error) => error ? closeReject(error) : closeResolve());
        }),
      });
    });
  });
}

describe("auditoría del plan", () => {
  function planFixture(auditors: string[]) {
    const { store, run } = fixture();
    if (auditors.length) store.setRunAuditors(run.id, auditors);
    store.publishGraph(run.id, { nodes: [
      { id: "uno", file: "src/theme.ts", symbol: "saveTheme", title: "Persistir", description: "Guardar el tema", rationale: "Lo pide el requisito", dependencies: [] },
    ] }, "claude");
    return { store, run };
  }

  function planReviewServer(answer: string, calls: { count: number; prompts: string[] }) {
    return ollamaServer((request, response) => {
      calls.count += 1;
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const payload = JSON.parse(body) as { messages: Array<{ content: string }> };
        calls.prompts.push(payload.messages[0].content);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ model: "qa-plan", message: { content: answer } }));
      });
    });
  }

  it("arma el paquete del grafo sin diffs y con los cinco tipos admitidos", () => {
    const { store, run } = planFixture(["codex"]);
    const pack = buildPlanReviewPack(store, run.id);
    expect(pack).toContain("Audit the completed graph");
    expect(pack).toContain("src/theme.ts · saveTheme");
    expect(pack).not.toContain("```diff");
    for (const tipo of ["Nodo faltante", "Corte incorrecto", "Dependencia mal declarada", "Nodo sin verificación observable", "Nodo fuera del requisito"]) {
      expect(pack).toContain(tipo);
    }
    expect(pack).toContain("--scope plan");
    expect(pack).toContain("nunca lleva --node");
  });

  it("no audita un run sin grafo publicado", async () => {
    const { store, run } = fixture();
    store.setRunAuditors(run.id, ["ollama"]);
    expect(() => buildPlanReviewPack(store, run.id)).toThrow(/no published graph/);
    await expect(runPlanReview(store, run.id)).resolves.toBeUndefined();
  });

  it("no audita sin auditores elegidos por el humano", async () => {
    const { store, run } = planFixture([]);
    await expect(runPlanReview(store, run.id)).resolves.toBeUndefined();
  });

  it("registra los hallazgos con scope plan sin bloquear el cierre ni tocar la cobertura", async () => {
    const calls = { count: 0, prompts: [] as string[] };
    const server = await planReviewServer(JSON.stringify([
      { severity: "major", title: "Falta el nodo de migración", body: "El nodo uno cambia el formato y nada migra lo anterior." },
    ]), calls);
    try {
      const { store, run } = planFixture(["ollama"]);
      store.setOllamaSettings({ apiKey: "qa-key", model: "qa-plan", baseUrl: server.baseUrl });
      const coverageBefore = JSON.stringify(store.getRunDetail(run.id)?.agentStates);

      await expect(runPlanReview(store, run.id)).resolves.toEqual({ created: 1 });

      const findings = store.listFindings(run.id);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ scope: "plan", nodeId: undefined, reviewer: "ollama:qa-plan" });
      // La ronda informa al humano antes de aprobar; no es un segundo gate.
      expect(store.getRun(run.id)?.openFindings).toBe(0);
      expect(store.runReviewGate(run.id)).toHaveLength(0);
      // Tampoco es la auditoría de los diffs: la cobertura del auditor no se toca.
      expect(JSON.stringify(store.getRunDetail(run.id)?.agentStates)).toBe(coverageBefore);
      // Y no interfiere con el gate humano del grafo.
      expect(store.getRun(run.id)?.awaitingApproval).toBe(1);

      await expect(runPlanReview(store, run.id)).resolves.toBeUndefined();
      expect(calls.count).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("relanza con force la misma versión del grafo, y sólo con force", async () => {
    const calls = { count: 0, prompts: [] as string[] };
    const server = await planReviewServer("SIN-HALLAZGOS", calls);
    try {
      const { store, run } = planFixture(["ollama"]);
      store.setOllamaSettings({ apiKey: "qa-key", model: "qa-plan", baseUrl: server.baseUrl });
      await expect(runPlanReview(store, run.id)).resolves.toEqual({ created: 0 });
      expect(calls.count).toBe(1);

      // Sin force la ronda de esa versión ya está cerrada y no se repite.
      await expect(runPlanReview(store, run.id)).resolves.toBeUndefined();
      expect(calls.count).toBe(1);

      // Con force sí: es el caso de 'hrp graph review' y POST /plan-review
      // cuando la ronda falló o el humano eligió auditores después de publicar.
      await expect(runPlanReview(store, run.id, { force: true })).resolves.toEqual({ created: 0 });
      expect(calls.count).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("vuelve a auditar cuando el grafo cambia de versión", async () => {
    const calls = { count: 0, prompts: [] as string[] };
    const server = await planReviewServer("SIN-HALLAZGOS", calls);
    try {
      const { store, run } = planFixture(["ollama"]);
      store.setOllamaSettings({ apiKey: "qa-key", model: "qa-plan", baseUrl: server.baseUrl });
      await expect(runPlanReview(store, run.id)).resolves.toEqual({ created: 0 });
      store.publishGraph(run.id, { nodes: [
        { id: "uno", file: "src/theme.ts", symbol: "saveTheme", title: "Persistir", description: "Guardar el tema", rationale: "Lo pide el requisito", dependencies: [] },
        { id: "dos", file: "src/theme.ts", symbol: "loadTheme", title: "Leer", description: "Leer el tema", rationale: "Lo pide el requisito", dependencies: ["uno"] },
      ] }, "claude");
      await expect(runPlanReview(store, run.id)).resolves.toEqual({ created: 0 });
      expect(calls.count).toBe(2);
      expect(calls.prompts[1]).toContain("loadTheme");
    } finally {
      await server.close();
    }
  });

  it("cierra la pasada de ollama cuando declara el plan sano", async () => {
    const calls = { count: 0, prompts: [] as string[] };
    const server = await planReviewServer("SIN-HALLAZGOS", calls);
    try {
      const { store, run } = planFixture(["ollama"]);
      store.setOllamaSettings({ apiKey: "qa-key", model: "qa-plan", baseUrl: server.baseUrl });
      await expect(runPlanReview(store, run.id)).resolves.toEqual({ created: 0 });

      const gate = store.getRun(run.id)?.planGate;
      expect(gate?.reviewed).toEqual(["ollama"]);
      expect(gate?.open).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("cierra la pasada de ollama con los hallazgos que reportó", async () => {
    const calls = { count: 0, prompts: [] as string[] };
    const server = await planReviewServer(JSON.stringify([
      { severity: "major", title: "Falta el nodo de migración", body: "El nodo uno cambia el formato y nada migra lo anterior." },
    ]), calls);
    try {
      const { store, run } = planFixture(["ollama"]);
      store.setOllamaSettings({ apiKey: "qa-key", model: "qa-plan", baseUrl: server.baseUrl });
      await expect(runPlanReview(store, run.id)).resolves.toEqual({ created: 1 });

      expect(store.getRun(run.id)?.planGate?.open).toBe(false);
      // Opinar cierra la pasada; los hallazgos los resuelve el humano al decidir.
      expect(store.listFindings(run.id)).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("deja la pasada pendiente si la consulta al revisor falla", async () => {
    const calls = { count: 0, prompts: [] as string[] };
    const server = await ollamaServer((_request, response) => {
      calls.count += 1;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "upstream caído" }));
    });
    try {
      const { store, run } = planFixture(["ollama"]);
      store.setOllamaSettings({ apiKey: "qa-key", model: "qa-plan", baseUrl: server.baseUrl });
      await expect(runPlanReview(store, run.id)).resolves.toBeUndefined();

      const gate = store.getRun(run.id)?.planGate;
      expect(gate?.pending).toEqual(["ollama"]);
      expect(gate?.open).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("con auditores de sesión no llama a ollama y explica cómo obtener el paquete", async () => {
    const calls = { count: 0, prompts: [] as string[] };
    const server = await planReviewServer("SIN-HALLAZGOS", calls);
    try {
      const { store, run } = planFixture(["codex"]);
      store.setOllamaSettings({ apiKey: "qa-key", model: "qa-plan", baseUrl: server.baseUrl });
      await expect(runPlanReview(store, run.id)).resolves.toEqual({ created: 0 });
      expect(calls.count).toBe(0);
      const activity = store.getRunDetail(run.id)?.activity.map((item) => item.message) ?? [];
      expect(activity.some((message) => message.includes("hrp graph review"))).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe("buildReviewPack", () => {
  it("muestra acuerdos pendientes y la unanimidad alcanzada", () => {
    const { store, run } = fixture();
    try {
      store.setRunAuditors(run.id, ["claude", "antigravity"]);
      store.publishGraph(run.id, { nodes: [
        { id: "change", file: "src/A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [] },
      ] }, "codex");
      const finding = store.createFinding(run.id, {
        reviewer: "claude",
        severity: "major",
        title: "Contrato incompleto",
        body: "Falta validar el caso límite.",
      });
      store.setFindingStatus(finding.id, "accepted", "change");

      const pendingPack = buildReviewPack(store, run.id);
      expect(pendingPack).toContain("hrp finding agree <finding-id> --author TU_NOMBRE");
      expect(pendingPack).toContain("acuerdos 2/3 · faltan antigravity");

      store.agreeFinding(finding.id, "antigravity");
      const unanimousPack = buildReviewPack(store, run.id);
      expect(unanimousPack).toContain("acuerdos 3/3 · unanimidad");
    } finally {
      store.close();
    }
  });
});

describe("runAutoReview", () => {
  it("allows the configured Ollama auditor to close with no scope when the same base model implemented every node", async () => {
    const model = "kimi-k2.7-code";
    const { store, run } = fixture();
    try {
      store.setOllamaSettings({ apiKey: "qa-key", model });
      store.setRunAuditors(run.id, ["ollama"]);
      store.publishGraph(run.id, { nodes: [
        { id: "change", file: "src/A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [] },
      ] }, `ollama:${model}`);
      for (const auditor of store.getRun(run.id)?.planGate?.pending ?? []) store.recordPlanPass(run.id, auditor, 0);
      store.approveNodes(run.id);
      store.startNode(run.id, "change", `ollama:${model}`);
      store.publishPatch(run.id, "change", "Changed method", "diff --git a/src/A.ts b/src/A.ts\n--- a/src/A.ts\n+++ b/src/A.ts\n+return true");
      store.publishVerification(run.id, "change", { command: "npm test", output: "ok", exitCode: 0 });
      store.completeNode(run.id, "change");

      await expect(runAutoReview(store, run.id, { force: true })).resolves.toEqual({ created: 0 });

      const detail = store.getRunDetail(run.id);
      expect(detail?.activity.some((event) => event.message.includes("Auditoría sin alcance para ollama"))).toBe(true);
      expect(detail?.findings).toHaveLength(0);
      expect(detail?.agentStates.find((state) => state.agent === "ollama")).toMatchObject({
        phase: "completed",
        completed: 0,
        total: 0,
        reviewedNodeIds: [],
        remainingNodeIds: [],
      });
      const startedAt = detail?.agentStates.find((state) => state.agent === "ollama")?.startedAt;
      expect(startedAt).toBeDefined();
      await waitUntilAfter(startedAt!);
      expect(store.getRun(run.id)?.pendingAuditorVotes).toBe(0);
      store.publishGraph(run.id, { nodes: [
        { id: "change", file: "src/A.ts", symbol: "A.method", title: "Change", description: "Work", rationale: "Required", dependencies: [] },
      ] }, `ollama:${model}`);
      const updated = store.getRunDetail(run.id)?.nodes.find((node) => node.id === "change")?.updatedAt;
      expect(Date.parse(updated!)).toBeGreaterThan(Date.parse(startedAt!));
      expect(store.getRun(run.id)?.pendingAuditorVotes).toBe(0);
    } finally {
      store.close();
    }
  });

  it("sends only nodes implemented by other agents to the configured Ollama auditor", async () => {
    const model = "kimi-k2.7-code";
    const { store, run } = fixture();
    const prompts: string[] = [];
    const server = await ollamaServer((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/chat");
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const payload = JSON.parse(body) as { messages: Array<{ content: string }> };
        prompts.push(payload.messages[0].content);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          model,
          message: { content: JSON.stringify([{ severity: "minor", title: "Check dependency", body: "Review the hidden dependency", node: "own" }]) },
          prompt_eval_count: 12,
          eval_count: 3,
        }));
      });
    });
    try {
      store.setOllamaSettings({ apiKey: "qa-key", model, baseUrl: server.baseUrl });
      store.setRunAuditors(run.id, ["ollama"]);
      store.publishGraph(run.id, { nodes: [
        { id: "own", file: "src/A.ts", symbol: "A.own", title: "Own", description: "Own work", rationale: "Required", dependencies: [] },
        { id: "other", file: "src/B.ts", symbol: "B.other", title: "Other", description: "Other work", rationale: "Required", dependencies: [] },
      ] }, `ollama:${model}`);
      for (const auditor of store.getRun(run.id)?.planGate?.pending ?? []) store.recordPlanPass(run.id, auditor, 0);
      store.approveNodes(run.id);
      store.startNode(run.id, "own", `ollama:${model}`);
      store.publishPatch(run.id, "own", "Changed own method", "diff --git a/src/A.ts b/src/A.ts\n--- a/src/A.ts\n+++ b/src/A.ts\n+return true");
      store.publishVerification(run.id, "own", { command: "npm test", output: "ok", exitCode: 0 });
      store.completeNode(run.id, "own");
      store.assignNode(run.id, "other", "claude");
      store.startNode(run.id, "other", "claude");
      store.publishPatch(run.id, "other", "Changed other method", "diff --git a/src/B.ts b/src/B.ts\n--- a/src/B.ts\n+++ b/src/B.ts\n+return true");
      store.publishVerification(run.id, "other", { command: "npm test", output: "ok", exitCode: 0 });
      store.completeNode(run.id, "other");

      await expect(runAutoReview(store, run.id, { force: true })).resolves.toEqual({ created: 1 });

      const detail = store.getRunDetail(run.id);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("other [completed]");
      expect(prompts[0]).not.toContain("own [completed]");
      expect(detail?.findings).toHaveLength(1);
      expect(detail?.findings[0]).toMatchObject({
        title: "Check dependency",
        nodeId: undefined,
      });
      expect(detail?.findings[0]?.body).toContain('el nodo "own", que existe en el run pero queda fuera del alcance auditable de ollama');
      expect(detail?.findings[0]?.body).not.toContain("que no existe en el run");
      expect(detail?.agentStates.find((state) => state.agent === "ollama")).toMatchObject({
        phase: "completed",
        completed: 1,
        total: 1,
        reviewedNodeIds: ["other"],
        remainingNodeIds: [],
      });
    } finally {
      store.close();
      await server.close();
    }
  });
});
