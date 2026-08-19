#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entry = path.join(root, "dist/server/mcp/index.js");

try {
  const { HrpMcpClient, startMcpStdioServer } = await import(entry);
  const client = new HrpMcpClient(
    process.env.HRP_URL,
    process.env.HRP_DATA_DIR,
    process.env.HRP_PORT ? Number(process.env.HRP_PORT) : undefined,
  );
  startMcpStdioServer(client);
} catch (error) {
  console.error("Error iniciando servidor MCP de HRP:", error);
  process.exit(1);
}
