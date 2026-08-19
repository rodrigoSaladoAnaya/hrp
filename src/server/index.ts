import os from "node:os";
import path from "node:path";
import { createApp } from "./http.js";
import { HrpStore } from "./store.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const port = Number(option("--port") ?? process.env.HRP_PORT ?? 4317);
const dataDirectory = path.resolve(option("--data-dir") ?? process.env.HRP_DATA_DIR ?? path.join(os.homedir(), ".hrp-v2"));
const workspace = option("--workspace");
const store = new HrpStore(dataDirectory);

if (workspace) store.attachProject(workspace);

const server = createApp(store).listen(port, "127.0.0.1", () => {
  console.log(`Human Review Protocol v2: http://127.0.0.1:${port}`);
  console.log(`Data: ${dataDirectory}`);
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

