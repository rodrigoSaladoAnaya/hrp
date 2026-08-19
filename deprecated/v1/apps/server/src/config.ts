import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ProtocolConfig } from "@human-review/protocol";

const configSchema = z.object({
  workspaceRoot: z.string().default("."),
  dataDirectory: z.string().default(".human-review"),
  http: z.object({
    host: z.enum(["127.0.0.1", "localhost"]).default("127.0.0.1"),
    port: z.number().int().min(1024).max(65_535).default(4317),
  }),
  workspaceObserver: z.object({
    enabled: z.boolean().default(true),
    pollIntervalMs: z.number().int().min(250).max(30_000).default(900),
    maxDiffBytes: z.number().int().min(16_384).max(4 * 1024 * 1024).default(512 * 1024),
  }),
});

export async function loadConfig(): Promise<ProtocolConfig> {
  const configPath = path.resolve(process.env.HUMAN_REVIEW_CONFIG_PATH ?? "protocol.config.json");
  const configDirectory = path.dirname(configPath);
  const parsed = configSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  return {
    ...parsed,
    workspaceRoot: path.resolve(process.env.HUMAN_REVIEW_WORKSPACE_ROOT ?? configDirectory, parsed.workspaceRoot),
    dataDirectory: path.resolve(
      process.env.HUMAN_REVIEW_DATA_DIR ?? path.resolve(configDirectory, parsed.dataDirectory),
    ),
    http: {
      host: parsed.http.host,
      port: Number(process.env.HUMAN_REVIEW_HTTP_PORT ?? parsed.http.port),
    },
  };
}
