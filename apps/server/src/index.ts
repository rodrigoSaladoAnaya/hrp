import { loadConfig } from "./config.js";
import { createHttpServer } from "./http-server.js";
import { ProjectManager } from "./project-manager.js";
import { ProjectRegistry } from "./project-registry.js";

const config = await loadConfig();
const manager = new ProjectManager(config, new ProjectRegistry(config.dataDirectory));
await manager.initialize();
const server = createHttpServer(config, manager);

const shutdown = () => {
  server.close(() => void manager.close());
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
