import { type Readable, type Writable } from "node:stream";
import { executeHrpTool, HrpMcpClient, hrpToolDefinitions } from "./tools.js";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export class HrpMcpServer {
  private client: HrpMcpClient;

  constructor(client?: HrpMcpClient) {
    this.client = client ?? new HrpMcpClient();
  }

  async handleMessage(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const isNotification = message.id === undefined || message.id === null;
    const id = message.id ?? null;

    try {
      switch (message.method) {
        case "initialize": {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {
                tools: {},
              },
              serverInfo: {
                name: "hrp-mcp",
                version: "3.2.0",
              },
            },
          };
        }

        case "notifications/initialized": {
          return null;
        }

        case "ping": {
          return {
            jsonrpc: "2.0",
            id,
            result: {},
          };
        }

        case "tools/list": {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              tools: hrpToolDefinitions,
            },
          };
        }

        case "tools/call": {
          const toolName = String(message.params?.name ?? "");
          const toolArgs = (message.params?.arguments ?? {}) as Record<string, unknown>;

          try {
            const output = await executeHrpTool(this.client, toolName, toolArgs);
            const text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text,
                  },
                ],
                isError: false,
              },
            };
          } catch (toolError) {
            const errorMessage = toolError instanceof Error ? toolError.message : String(toolError);
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `Error ejecutando ${toolName}: ${errorMessage}`,
                  },
                ],
                isError: true,
              },
            };
          }
        }

        default: {
          if (isNotification) return null;
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Método no soportado: ${message.method}`,
            },
          };
        }
      }
    } catch (handlerError) {
      if (isNotification) return null;
      const errorMessage = handlerError instanceof Error ? handlerError.message : String(handlerError);
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: `Error interno: ${errorMessage}`,
        },
      };
    }
  }

  listen(stdin: Readable = process.stdin, stdout: Writable = process.stdout): void {
    let buffer = "";

    const processBuffer = async () => {
      while (buffer.length > 0) {
        if (buffer.startsWith("Content-Length:")) {
          const headerEnd = buffer.indexOf("\r\n\r\n");
          const newlineHeaderEnd = buffer.indexOf("\n\n");
          const endOfHeader = headerEnd >= 0 ? headerEnd + 4 : (newlineHeaderEnd >= 0 ? newlineHeaderEnd + 2 : -1);

          if (endOfHeader < 0) return;

          const header = buffer.slice(0, endOfHeader);
          const match = /Content-Length:\s*(\d+)/i.exec(header);
          if (!match) {
            buffer = buffer.slice(endOfHeader);
            continue;
          }

          const contentLength = parseInt(match[1], 10);
          if (buffer.length < endOfHeader + contentLength) {
            return;
          }

          const rawBody = buffer.slice(endOfHeader, endOfHeader + contentLength);
          buffer = buffer.slice(endOfHeader + contentLength);

          try {
            const request = JSON.parse(rawBody) as JsonRpcRequest;
            const response = await this.handleMessage(request);
            if (response) {
              const body = JSON.stringify(response);
              stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
            }
          } catch (parseError) {
            console.error("Error parseando mensaje JSON-RPC:", parseError);
          }
        } else {
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex < 0) return;

          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (line.length === 0) continue;

          try {
            const request = JSON.parse(line) as JsonRpcRequest;
            const response = await this.handleMessage(request);
            if (response) {
              stdout.write(`${JSON.stringify(response)}\n`);
            }
          } catch (parseError) {
            console.error("Error parseando línea JSON-RPC:", parseError);
          }
        }
      }
    };

    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      buffer += chunk;
      void processBuffer();
    });
  }
}

export function startMcpStdioServer(client?: HrpMcpClient): void {
  const server = new HrpMcpServer(client);
  server.listen();
}
