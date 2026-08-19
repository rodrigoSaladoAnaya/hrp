import { EventEmitter, PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { HrpMcpServer } from "./server.js";
import { HrpMcpClient, hrpToolDefinitions } from "./tools.js";

class MockHrpMcpClient extends HrpMcpClient {
  state: Record<string, unknown> = {
    healthy: true,
    projects: [{ id: "proj-1", name: "test", workspaceRoot: "/test" }],
    runs: {} as Record<string, unknown>,
  };

  override async isHealthy(): Promise<boolean> {
    return this.state.healthy as boolean;
  }

  override async getStatus(): Promise<Record<string, unknown>> {
    return {
      status: "running",
      url: "http://127.0.0.1:4317",
      dataDir: "/tmp/.hrp-v2",
      projectCount: 1,
    };
  }

  override async attach(workspaceRoot?: string): Promise<unknown> {
    return { id: "proj-1", name: "test", workspaceRoot: workspaceRoot ?? "/test" };
  }

  override async listProjects(): Promise<unknown> {
    return { projects: [{ id: "proj-1", name: "test" }] };
  }

  override async createRun(params: { title: string; requirement: string; projectId?: string }): Promise<unknown> {
    const run = {
      id: "run-100",
      projectId: params.projectId ?? "proj-1",
      title: params.title,
      requirement: params.requirement,
      status: "pending",
    };
    (this.state.runs as Record<string, unknown>)["run-100"] = run;
    return run;
  }

  override async listRuns(): Promise<unknown> {
    return { runs: Object.values(this.state.runs) };
  }

  override async getRunState(runId: string): Promise<unknown> {
    return {
      run: (this.state.runs as Record<string, unknown>)[runId] ?? { id: runId, status: "running" },
      nodes: [],
      activity: [],
    };
  }

  override async publishGraph(runId: string, nodes: unknown[]): Promise<unknown> {
    return { nodes };
  }

  override async discoverNode(runId: string, node: unknown): Promise<unknown> {
    return { ...node as object, discovered: true, approved: false };
  }

  override async approveNodes(runId: string, nodeIds?: string[]): Promise<unknown> {
    return { approved: nodeIds ?? "all" };
  }

  override async assignNode(runId: string, nodeId: string, assignee: string | null): Promise<unknown> {
    return { id: nodeId, assignee };
  }

  override async startNode(runId: string, nodeId: string, agent: string = "antigravity"): Promise<unknown> {
    return { id: nodeId, status: "running", agent };
  }

  override async publishPatch(runId: string, nodeId: string, params: { summary: string; diff: string; rationale?: string }): Promise<unknown> {
    return { id: nodeId, patch: params };
  }

  override async completeNode(runId: string, nodeId: string): Promise<unknown> {
    return { id: nodeId, status: "completed" };
  }

  override async publishActivity(runId: string, params: unknown): Promise<unknown> {
    return { id: 1, runId, ...(params as object) };
  }
}

describe("HrpMcpServer", () => {
  it("handles initialize handshake and ping", async () => {
    const server = new HrpMcpServer(new MockHrpMcpClient());
    const initResponse = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });

    expect(initResponse?.result).toMatchObject({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "hrp-mcp", version: "2.1.0" },
    });

    const pingResponse = await server.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "ping",
    });
    expect(pingResponse?.result).toEqual({});

    const notifyResponse = await server.handleMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(notifyResponse).toBeNull();
  });

  it("lists all available HRP tools in tools/list", async () => {
    const server = new HrpMcpServer(new MockHrpMcpClient());
    const response = await server.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {},
    });

    const tools = (response?.result as { tools: typeof hrpToolDefinitions }).tools;
    expect(tools.length).toBeGreaterThanOrEqual(14);
    expect(tools.some((tool) => tool.name === "hrp_attach")).toBe(true);
    expect(tools.some((tool) => tool.name === "hrp_create_run")).toBe(true);
    expect(tools.some((tool) => tool.name === "hrp_publish_graph")).toBe(true);
    expect(tools.some((tool) => tool.name === "hrp_start_node")).toBe(true);
    expect(tools.some((tool) => tool.name === "hrp_publish_patch")).toBe(true);
    expect(tools.some((tool) => tool.name === "hrp_verify_run")).toBe(true);
    expect(tools.some((tool) => tool.name === "hrp_complete_node")).toBe(true);
  });

  it("executes tools/call for key HRP operations", async () => {
    const mockClient = new MockHrpMcpClient();
    const server = new HrpMcpServer(mockClient);

    const attachResponse = await server.handleMessage({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "hrp_attach",
        arguments: { workspaceRoot: "/Users/test/project" },
      },
    });

    expect(attachResponse?.result).toMatchObject({
      isError: false,
    });
    const attachContent = (attachResponse?.result as { content: Array<{ text: string }> }).content[0].text;
    expect(attachContent).toContain("proj-1");

    const createRunResponse = await server.handleMessage({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "hrp_create_run",
        arguments: {
          title: "Feature",
          requirement: "Add new feature",
        },
      },
    });

    expect(createRunResponse?.result).toMatchObject({ isError: false });
    const runContent = (createRunResponse?.result as { content: Array<{ text: string }> }).content[0].text;
    expect(runContent).toContain("run-100");

    const startNodeResponse = await server.handleMessage({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "hrp_start_node",
        arguments: {
          runId: "run-100",
          nodeId: "theme-node",
          agent: "antigravity",
        },
      },
    });
    expect(startNodeResponse?.result).toMatchObject({ isError: false });
    const startContent = (startNodeResponse?.result as { content: Array<{ text: string }> }).content[0].text;
    expect(startContent).toContain("theme-node");
  });

  it("returns formatted error if a tool execution fails", async () => {
    const server = new HrpMcpServer(new MockHrpMcpClient());
    const response = await server.handleMessage({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "unknown_tool",
        arguments: {},
      },
    });

    expect(response?.result).toMatchObject({
      isError: true,
    });
    const errorContent = (response?.result as { content: Array<{ text: string }> }).content[0].text;
    expect(errorContent).toContain("Herramienta no reconocida");
  });

  it("handles line-delimited stdio stream", async () => {
    const server = new HrpMcpServer(new MockHrpMcpClient());
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    server.listen(stdin, stdout);

    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "msg-1", method: "ping" }) + "\n");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(output).toContain('"id":"msg-1"');
  });

  it("handles Content-Length framed stdio stream", async () => {
    const server = new HrpMcpServer(new MockHrpMcpClient());
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    server.listen(stdin, stdout);

    const body = JSON.stringify({ jsonrpc: "2.0", id: "msg-2", method: "ping" });
    stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(output).toContain("Content-Length:");
    expect(output).toContain('"id":"msg-2"');
  });
});
