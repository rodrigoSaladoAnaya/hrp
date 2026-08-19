import { execFile } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cli = path.resolve(import.meta.dirname, "bin/hrp.mjs");
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("hrp CLI", () => {
  it("exposes a stable version command", async () => {
    const { stdout } = await execFileAsync(process.execPath, [cli, "--version"]);
    expect(stdout.trim()).toBe("0.4.0");
  });

  it("registers and selects the requested workspace without restarting the shared service", async () => {
    const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "hrp-cli-test-")));
    const selectedRoots: string[] = [];
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/protocol") {
        response.end(JSON.stringify({ name: "human-review-protocol", version: "1.0" }));
        return;
      }
      if (request.url === "/api/config") {
        response.end(JSON.stringify({ workspaceRoot: workspace }));
        return;
      }
      if (request.url === "/api/projects" && request.method === "POST") {
        selectedRoots.push(String(request.headers["x-hrp-workspace-root"]));
        response.statusCode = 201;
        response.end(JSON.stringify({ project: { id: "project-test", workspaceRoot: workspace } }));
        return;
      }
      if (request.url === "/api/state") {
        response.end(JSON.stringify({ sessionId: "session-test" }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const { stdout } = await execFileAsync(process.execPath, [
      cli,
      "attach",
      workspace,
      "--url",
      `http://127.0.0.1:${address.port}`,
      "--json",
    ]);

    expect(JSON.parse(stdout)).toMatchObject({
      connected: true,
      projectId: "project-test",
      workspaceRoot: workspace,
      sessionId: "session-test",
      protocolVersion: "1.0",
    });
    expect(selectedRoots).toEqual([workspace]);
  });
});
