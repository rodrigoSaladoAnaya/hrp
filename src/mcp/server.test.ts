import { readFileSync } from "node:fs";
import { EventEmitter, PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { HrpMcpServer } from "./server.js";
import { HrpMcpClient, hrpToolDefinitions } from "./tools.js";

const EXPECTED_PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

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
      dataDir: "/tmp/.hrp",
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

  graphCalls: unknown[] = [];

  override async publishGraph(runId: string, nodes: unknown[], agent?: string): Promise<unknown> {
    this.graphCalls.push({ runId, nodes, agent });
    return { nodes, agent };
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

  override async startNode(runId: string, nodeId: string, agent?: string): Promise<unknown> {
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

  attentionCalls: unknown[] = [];
  agreementCalls: unknown[] = [];

  override async attention(params: { agent: string; runId?: string; workspace?: string; waitSeconds?: number }): Promise<Record<string, unknown>> {
    this.attentionCalls.push(params);
    return { runId: params.runId ?? "run-100", agent: params.agent, kind: "work", actionable: true, terminal: false, waiting: false, directive: "Aprobado: 1 nodo disponible (uno)", pendingAuditors: [], runs: [] };
  }

  override async agreeFinding(findingId: string, agent: string): Promise<unknown> {
    this.agreementCalls.push({ findingId, agent });
    return { id: findingId, agreements: [{ agent }], unanimous: false };
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
      serverInfo: { name: "hrp-mcp", version: EXPECTED_PACKAGE_VERSION },
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
    expect(tools.some((tool) => tool.name === "hrp_retry_node")).toBe(true);
    expect(tools.some((tool) => tool.name === "hrp_publish_activity")).toBe(true);
    expect(tools.some((tool) => tool.name === "hrp_review_pack")).toBe(true);
    expect(tools.some((tool) => tool.name === "hrp_review_gate")).toBe(true);
    expect(tools.some((tool) => tool.name === "hrp_finding_add")).toBe(true);
    expect(tools.some((tool) => tool.name === "hrp_finding_list")).toBe(true);
    expect(tools.some((tool) => tool.name === "hrp_finding_show")).toBe(true);
    expect(tools.some((tool) => tool.name === "hrp_finding_reply")).toBe(true);
    expect(tools.some((tool) => tool.name === "hrp_finding_agree")).toBe(true);
    expect(tools.some((tool) => tool.name === "hrp_finding_accept")).toBe(true);
    expect(tools.some((tool) => tool.name === "hrp_finding_reject")).toBe(true);
    expect(tools.some((tool) => tool.name === "hrp_finding_escalate")).toBe(true);
  });

  it("expone y despacha el acuerdo explícito de un hallazgo", async () => {
    const mockClient = new MockHrpMcpClient();
    const server = new HrpMcpServer(mockClient);
    const toolsResponse = await server.handleMessage({ jsonrpc: "2.0", id: 40, method: "tools/list", params: {} });
    const tools = (toolsResponse?.result as { tools: typeof hrpToolDefinitions }).tools;
    const agreement = tools.find((tool) => tool.name === "hrp_finding_agree");
    expect(agreement?.inputSchema.required).toEqual(["findingId", "author"]);

    const response = await server.handleMessage({
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: { name: "hrp_finding_agree", arguments: { findingId: "finding-1", author: "claude" } },
    });

    expect(response?.result).toMatchObject({ isError: false });
    expect(mockClient.agreementCalls).toEqual([{ findingId: "finding-1", agent: "claude" }]);
  });

  it("expone hrp_attention como el despertador de los entornos sin hooks", async () => {
    const server = new HrpMcpServer(new MockHrpMcpClient());
    const response = await server.handleMessage({ jsonrpc: "2.0", id: 30, method: "tools/list", params: {} });
    const tools = (response?.result as { tools: typeof hrpToolDefinitions }).tools;
    const attention = tools.find((tool) => tool.name === "hrp_attention");
    expect(attention).toBeDefined();
    expect(attention?.inputSchema.required).toEqual(["agent"]);
    expect(Object.keys(attention?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["agent", "runId", "workspace", "waitSeconds"]));
    // La descripción es lo único que le dice al modelo que puede quedarse
    // esperando en vez de terminar el turno: si se pierde, se pierde el hábito.
    expect(attention?.description).toMatch(/bloqueante/i);
    const discover = tools.find((tool) => tool.name === "hrp_discover_node");
    expect(discover?.description).toMatch(/aprobado autom/i);
  });

  it("delega hrp_attention en el cliente con la espera pedida", async () => {
    const mockClient = new MockHrpMcpClient();
    const server = new HrpMcpServer(mockClient);
    const response = await server.handleMessage({
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: { name: "hrp_attention", arguments: { agent: "codex", runId: "run-100", waitSeconds: 120 } },
    });
    expect((response?.result as { isError: boolean }).isError).toBe(false);
    expect(mockClient.attentionCalls).toEqual([{ agent: "codex", runId: "run-100", workspace: undefined, waitSeconds: 120 }]);
    const payload = JSON.parse((response?.result as { content: { text: string }[] }).content[0].text);
    expect(payload.actionable).toBe(true);
    expect(payload.directive).toContain("nodo disponible");

    // Sin waitSeconds la espera por omisión es larga: el sentido de la
    // herramienta es que el agente se quede colgado hasta que haya trabajo.
    await server.handleMessage({ jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "hrp_attention", arguments: { agent: "codex" } } });
    expect((mockClient.attentionCalls[1] as { waitSeconds: number }).waitSeconds).toBe(300);
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

  it("propaga el agente al publicar el grafo por MCP", async () => {
    const mockClient = new MockHrpMcpClient();
    const server = new HrpMcpServer(mockClient);
    const nodes = [
      { id: "theme-node", file: "theme.ts", symbol: "Theme", title: "Theme", description: "Work", rationale: "Required", dependencies: [] },
    ];

    const toolsResponse = await server.handleMessage({ jsonrpc: "2.0", id: 13, method: "tools/list", params: {} });
    const tools = (toolsResponse?.result as { tools: typeof hrpToolDefinitions }).tools;
    const publishGraph = tools.find((tool) => tool.name === "hrp_publish_graph");
    expect(Object.keys(publishGraph?.inputSchema.properties ?? {})).toContain("agent");
    expect(publishGraph?.inputSchema.required).toEqual(["runId", "nodes", "agent"]);

    const withAgent = await server.handleMessage({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: { name: "hrp_publish_graph", arguments: { runId: "run-100", nodes, agent: "codex" } },
    });
    expect(withAgent?.result).toMatchObject({ isError: false });

    const withoutAgent = await server.handleMessage({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: { name: "hrp_publish_graph", arguments: { runId: "run-100", nodes } },
    });
    expect(withoutAgent?.result).toMatchObject({ isError: true });
    expect((withoutAgent?.result as { content: { text: string }[] }).content[0].text).toContain("requiere agent");
    expect(mockClient.graphCalls).toEqual([
      { runId: "run-100", nodes, agent: "codex" },
    ]);
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
