import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAutoReview } from "./review.js";
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
