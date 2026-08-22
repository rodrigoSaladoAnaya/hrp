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
