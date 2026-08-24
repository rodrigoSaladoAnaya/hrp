import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./http.js";
import { HrpStore } from "./store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "hrp-http-"));
  roots.push(root);
  mkdirSync(path.join(root, "workspace"));
  return new HrpStore(path.join(root, "data"));
}

async function withServer<T>(store: HrpStore, test: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createApp(store).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await test(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    store.close();
  }
}

describe("settings API", () => {
  it("reads and updates UI preferences", async () => {
    await withServer(storeFixture(), async (baseUrl) => {
      const initial = await fetch(`${baseUrl}/api/settings/ui`);
      expect(initial.status).toBe(200);
      expect(await initial.json()).toEqual({ viewShortcuts: { enabled: true, modifier: "meta" } });

      const update = await fetch(`${baseUrl}/api/settings/ui`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewShortcuts: { enabled: false, modifier: "ctrl" } }),
      });
      expect(update.status).toBe(200);
      expect(await update.json()).toEqual({ viewShortcuts: { enabled: false, modifier: "ctrl" } });

      const persisted = await fetch(`${baseUrl}/api/settings/ui`);
      expect(await persisted.json()).toEqual({ viewShortcuts: { enabled: false, modifier: "ctrl" } });
    });
  });

  it("rejects invalid UI preference payloads", async () => {
    await withServer(storeFixture(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/settings/ui`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewShortcuts: { modifier: "command" } }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()) as { error?: string }).toMatchObject({ error: expect.stringContaining("Invalid option") });
    });
  });
});

// El árbol del dock acuña identidades y el humano pega su comando en una sesión
// ya abierta: aquí se fija ese contrato de punta a punta.
describe("sesiones del proyecto y atención", () => {
  function projectFixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), "hrp-http-sessions-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace);
    const store = new HrpStore(path.join(root, "data"));
    const project = store.attachProject(workspace);
    return { store, workspace, project };
  }

  const mint = (baseUrl: string, projectId: string, family: unknown) => fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ family }),
  });

  it("acuña la siguiente identidad libre y la devuelve en el censo", async () => {
    const { store, project } = projectFixture();
    await withServer(store, async (baseUrl) => {
      const vacio = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`);
      expect(vacio.status).toBe(200);
      expect(await vacio.json()).toEqual({ sessions: [] });

      const primera = await mint(baseUrl, project.id, "claude");
      expect(primera.status).toBe(201);
      expect(await primera.json()).toEqual({ agent: "claude:2", sessions: ["claude:2"] });

      const segunda = await mint(baseUrl, project.id, "claude");
      expect((await segunda.json() as { agent: string }).agent).toBe("claude:3");

      const censo = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`);
      expect(await censo.json()).toEqual({ sessions: ["claude:2", "claude:3"] });
    });
  });

  it("rechaza proyecto inexistente y familias que no lo son", async () => {
    const { store, project } = projectFixture();
    await withServer(store, async (baseUrl) => {
      expect((await fetch(`${baseUrl}/api/projects/no-existe/sessions`)).status).toBe(404);
      expect((await mint(baseUrl, "no-existe", "claude")).status).toBe(404);
      expect((await mint(baseUrl, project.id, "claude opus")).status).toBe(400);
      expect((await mint(baseUrl, project.id, "claude:2")).status).toBe(400);
    });
  });

  it("retira una sesión acuñada y rechaza lo que no puede retirar", async () => {
    const { store, project } = projectFixture();
    store.mintProjectSession(project.id, "claude");   // claude:2
    store.mintProjectSession(project.id, "claude");   // claude:3
    const run = store.createRun(project.id, "Viva", "r");
    store.publishGraph(run.id, { nodes: [{ id: "uno", file: "a.ts", symbol: "a", title: "A", description: "d", rationale: "r", dependencies: [] }] }, "claude");
    store.setRunAuditors(run.id, ["claude:3"]);
    await withServer(store, async (baseUrl) => {
      const retirar = (projectId: string, agent: string) => fetch(`${baseUrl}/api/projects/${projectId}/sessions/${encodeURIComponent(agent)}`, { method: "DELETE" });

      const ok = await retirar(project.id, "claude:2");
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ sessions: ["claude:3"] });
      const censo = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`);
      expect(await censo.json()).toEqual({ sessions: ["claude:3"] });

      expect((await retirar(project.id, "claude:9")).status).toBe(400);
      expect((await retirar("no-existe", "claude:3")).status).toBe(404);

      const auditora = await retirar(project.id, "claude:3");
      expect(auditora.status).toBe(400);
      expect((await auditora.json() as { error?: string }).error).toContain("Viva");
    });
  });

  it("da señal y presencia a la sesión acuñada que pega su comando", async () => {
    const { store, workspace, project } = projectFixture();
    const run = store.createRun(project.id, "t", "r");
    store.publishGraph(run.id, { nodes: [{ id: "uno", file: "a.ts", symbol: "a", title: "A", description: "d", rationale: "r", dependencies: [] }] }, "claude");
    store.mintProjectSession(project.id, "claude");
    await withServer(store, async (baseUrl) => {
      const consulta = (agent: string, extra = "") => fetch(`${baseUrl}/api/attention?agent=${encodeURIComponent(agent)}&workspace=${encodeURIComponent(workspace)}${extra}`);

      const sondeo = await (await consulta("claude:2")).json() as { runs?: unknown[] };
      expect(sondeo.runs).toHaveLength(1);
      expect(store.getRun(run.id)?.seenAgents).not.toContain("claude:2");

      await consulta("claude:2", "&waitMs=1");
      expect(store.getRun(run.id)?.seenAgents).toContain("claude:2");

      await consulta("claude:99", "&waitMs=1");
      const ajena = await (await consulta("claude:99")).json() as { runs?: unknown[] };
      expect(ajena.runs ?? []).toHaveLength(0);
      expect(store.getRun(run.id)?.seenAgents).not.toContain("claude:99");
    });
  });

  it("difunde esa presencia para que el panel abierto la pinte", async () => {
    const { store, workspace, project } = projectFixture();
    const run = store.createRun(project.id, "t", "r");
    store.publishGraph(run.id, { nodes: [{ id: "uno", file: "a.ts", symbol: "a", title: "A", description: "d", rationale: "r", dependencies: [] }] }, "claude");
    store.mintProjectSession(project.id, "claude");
    await withServer(store, async (baseUrl) => {
      // Un panel abierto sólo se entera por /api/events: aquí se cuenta lo que
      // habría recibido mientras la sesión pega su comando.
      const eventos: string[] = [];
      const stream = await fetch(`${baseUrl}/api/events`);
      const lector = stream.body!.getReader();
      const decoder = new TextDecoder();
      const leyendo = (async () => {
        try {
          for (;;) {
            const { value, done } = await lector.read();
            if (done) break;
            for (const linea of decoder.decode(value).split("\n")) {
              if (linea.startsWith("data:") && linea.includes(run.id)) eventos.push(linea);
            }
          }
        } catch { /* el cierre del flujo termina la lectura */ }
      })();
      const reposar = () => new Promise((resolve) => { setTimeout(resolve, 200); });
      const parquear = () => fetch(`${baseUrl}/api/attention?agent=claude%3A2&workspace=${encodeURIComponent(workspace)}&waitMs=1`);

      await reposar();
      await parquear();
      await reposar();
      expect(eventos).toHaveLength(1);

      await parquear();
      await reposar();
      expect(eventos).toHaveLength(1);
      expect(store.getRun(run.id)?.seenAgents).toContain("claude:2");

      await lector.cancel().catch(() => undefined);
      await leyendo;
    });
  });
});
