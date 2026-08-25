import os from "node:os";
import path from "node:path";
import { createApp } from "./http.js";
import { pendingAuditRunIds, runAutoReview } from "./review.js";
import { HrpStore } from "./store.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const port = Number(option("--port") ?? process.env.HRP_PORT ?? 4317);
const dataDirectory = path.resolve(option("--data-dir") ?? process.env.HRP_DATA_DIR ?? path.join(os.homedir(), ".hrp"));
const workspace = option("--workspace");
const store = new HrpStore(dataDirectory);

if (workspace) store.attachProject(workspace);

const server = createApp(store).listen(port, "127.0.0.1", () => {
  console.log(`Human Review Protocol v3: http://127.0.0.1:${port}`);
  console.log(`Data: ${dataDirectory}`);
});

// Rescate de auditorías huérfanas: si este servidor está arrancando, ningún
// proceso anterior sigue vivo, así que todo candado pendiente es una auditoría
// perdida (p. ej. un reinicio con la consulta en vuelo). Se relanzan en segundo
// plano, con force porque la antigüedad del candado ya no importa.
for (const runId of pendingAuditRunIds(store)) {
  const run = store.getRun(runId);
  if (!run || run.nodeCount === 0 || run.completedCount !== run.nodeCount) continue;
  try { store.addActivity(runId, "note", "Auditoría automática re-lanzada tras reinicio del servidor"); } catch { continue; }
  void runAutoReview(store, runId, { force: true });
}

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

