import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./http.js";
import { HrpStore } from "./store.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const port = Number(option("--port") ?? process.env.HRP_PORT ?? 4317);
const dataDirectory = path.resolve(option("--data-dir") ?? process.env.HRP_DATA_DIR ?? path.join(os.homedir(), ".hrp"));
const workspace = option("--workspace");
// dist/server/server/index.js → dist/web, tanto en dev (tsx) como compilado.
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = here.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(here, "..", "..", "web")
  : path.resolve(here, "..", "..", "dist", "web");
const store = new HrpStore(dataDirectory);

if (workspace) store.attachProject(workspace);

const server = createApp(store, { webRoot }).listen(port, "127.0.0.1", () => {
  console.log(`Human Review Protocol v4: http://127.0.0.1:${port}`);
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
