#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);

function value(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function flag(name) {
  return argv.includes(name);
}

const url = value("--url", process.env.HRP_URL ?? "http://127.0.0.1:4317");
const port = Number(value("--port", new URL(url).port || "4317"));
const dataDir = path.resolve(value("--data-dir", process.env.HRP_DATA_DIR ?? path.join(os.homedir(), ".hrp-v2")));
const json = flag("--json");

function positional() {
  const result = [];
  const optionsWithValues = new Set(["--url", "--port", "--data-dir", "--project", "--title", "--requirement", "--summary", "--rationale", "--diff-file", "--type", "--detail", "--node"]);
  for (let index = 0; index < argv.length; index += 1) {
    if (optionsWithValues.has(argv[index])) index += 1;
    else if (!argv[index].startsWith("--")) result.push(argv[index]);
  }
  return result;
}

function print(valueToPrint) {
  if (json || typeof valueToPrint !== "string") console.log(JSON.stringify(valueToPrint, null, 2));
  else console.log(valueToPrint);
}

async function api(endpoint, init = {}) {
  const response = await fetch(`${url}${endpoint}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  }).catch((error) => { throw new Error(`HRP no responde en ${url}: ${error.message}`); });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return response.status === 204 ? undefined : response.json();
}

async function healthy() {
  return fetch(`${url}/api/health`).then((response) => response.ok).catch(() => false);
}

async function startService(workspace) {
  if (await healthy()) {
    if (workspace) await api("/api/projects", { method: "POST", body: JSON.stringify({ workspaceRoot: workspace }) });
    print(`HRP ya está activo: ${url}`);
    return;
  }
  const entry = path.join(root, "dist/server/server/index.js");
  if (!existsSync(entry)) throw new Error(`Falta el build de HRP. Ejecuta: cd ${root} && npm run build`);
  const runtime = path.join(dataDir, "runtime");
  mkdirSync(runtime, { recursive: true });
  const logPath = path.join(runtime, "server.log");
  const log = openSync(logPath, "a");
  const args = [entry, "--port", String(port), "--data-dir", dataDir];
  if (workspace) args.push("--workspace", path.resolve(workspace));
  const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ["ignore", log, log] });
  child.unref();
  writeFileSync(path.join(runtime, "server.pid"), String(child.pid));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await healthy()) {
      print(`HRP iniciado: ${url}\nDatos: ${dataDir}\nLog: ${logPath}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`HRP no inició. Revisa ${logPath}`);
}

async function stopService() {
  const pidPath = path.join(dataDir, "runtime", "server.pid");
  if (!existsSync(pidPath)) {
    print("El servicio ya está detenido.");
    return;
  }
  const pid = Number(readFileSync(pidPath, "utf8"));
  try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { process.kill(pid, 0); } catch { break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { unlinkSync(pidPath); } catch { /* no-op */ }
  print("HRP detenido.");
}

async function attach(workspace = process.cwd()) {
  return api("/api/projects", { method: "POST", body: JSON.stringify({ workspaceRoot: path.resolve(workspace) }) });
}

async function resolveProject(projectId) {
  if (projectId) return projectId;
  return (await attach()).id;
}

function readJson(file) {
  return JSON.parse(readFileSync(path.resolve(file), "utf8"));
}

function help() {
  console.log(`Human Review Protocol CLI v2.0

Uso:
  hrp service <start|status|stop> [workspace]
  hrp attach [workspace] [--start]
  hrp project list
  hrp project remove <project-id> --yes
  hrp run create --title TEXTO --requirement TEXTO [--project ID]
  hrp run list [--project ID]
  hrp run delete <run-id> --yes
  hrp graph publish <run-id> <graph.json>
  hrp node discover <run-id> <node.json>
  hrp node start <run-id> <node-id>
  hrp node retry <run-id> <node-id>
  hrp patch publish <run-id> <node-id> --summary TEXTO [--rationale TEXTO] --diff-file PATH|-
  hrp verify run <run-id> <node-id> -- <comando> [args...]
  hrp node complete <run-id> <node-id>
  hrp activity publish <run-id> --type run|graph|inspect|node|patch|verify|note --summary TEXTO [--detail TEXTO] [--node ID]
  hrp state <run-id>

Opciones globales:
  --url URL        Default: http://127.0.0.1:4317
  --data-dir PATH  Default: ~/.hrp-v2
  --port N         Default: 4317
  --json           Salida estructurada
`);
}

async function main() {
  const args = positional();
  const [group, action, first, second] = args;
  if (!group || flag("--help")) return help();

  if (group === "service") {
    if (action === "start") return startService(first);
    if (action === "stop") return stopService();
    if (action === "status") {
      const isHealthy = await healthy();
      const projects = isHealthy ? (await api("/api/projects")).projects.length : 0;
      print(isHealthy ? { status: "running", url, dataDir, projects } : { status: "stopped", url, dataDir });
      process.exitCode = isHealthy ? 0 : 1;
      return;
    }
  }

  if (group === "attach") {
    const workspace = action ?? process.cwd();
    if (flag("--start")) await startService(workspace);
    const project = await attach(workspace);
    print(json ? project : `Proyecto: ${project.name}\nCarpeta: ${project.workspaceRoot}\nPanel: ${url}/?project=${project.id}`);
    return;
  }

  if (group === "project" && action === "list") return print((await api("/api/projects")).projects);
  if (group === "project" && action === "remove") {
    if (!flag("--yes")) throw new Error("Confirma el borrado con --yes");
    await api(`/api/projects/${encodeURIComponent(first)}`, { method: "DELETE" });
    return print("Proyecto eliminado.");
  }

  if (group === "run" && action === "create") {
    const projectId = await resolveProject(value("--project"));
    const run = await api(`/api/projects/${projectId}/runs`, { method: "POST", body: JSON.stringify({ title: value("--title"), requirement: value("--requirement") }) });
    return print(run);
  }
  if (group === "run" && action === "list") {
    const projectId = await resolveProject(value("--project"));
    return print((await api(`/api/projects/${projectId}/runs`)).runs);
  }
  if (group === "run" && action === "delete") {
    if (!flag("--yes")) throw new Error("Confirma el borrado con --yes");
    await api(`/api/runs/${encodeURIComponent(first)}`, { method: "DELETE" });
    return print("Ejecución eliminada.");
  }

  if (group === "graph" && action === "publish") {
    return print(await api(`/api/runs/${first}/graph`, { method: "POST", body: JSON.stringify(readJson(second)) }));
  }
  if (group === "node" && action === "discover") {
    return print(await api(`/api/runs/${first}/nodes`, { method: "POST", body: JSON.stringify(readJson(second)) }));
  }
  if (group === "node" && (action === "start" || action === "retry")) {
    return print(await api(`/api/runs/${first}/nodes/${second}/start`, { method: "POST", body: "{}" }));
  }
  if (group === "node" && action === "complete") {
    return print(await api(`/api/runs/${first}/nodes/${second}/complete`, { method: "POST", body: "{}" }));
  }
  if (group === "patch" && action === "publish") {
    const diffFile = value("--diff-file");
    const diff = diffFile === "-" ? readFileSync(0, "utf8") : readFileSync(path.resolve(diffFile), "utf8");
    return print(await api(`/api/runs/${first}/nodes/${second}/patch`, { method: "POST", body: JSON.stringify({ summary: value("--summary"), rationale: value("--rationale"), diff }) }));
  }
  if (group === "verify" && action === "run") {
    const separator = argv.indexOf("--");
    if (separator < 0 || !argv[separator + 1]) throw new Error("Falta el comando después de --");
    const command = argv[separator + 1];
    const commandArgs = argv.slice(separator + 2);
    const result = spawnSync(command, commandArgs, { cwd: process.cwd(), encoding: "utf8", shell: false });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const observed = await api(`/api/runs/${first}/nodes/${second}/verify`, {
      method: "POST",
      body: JSON.stringify({ command: [command, ...commandArgs].join(" "), output, exitCode: result.status ?? 1 }),
    });
    process.stdout.write(output);
    if ((result.status ?? 1) !== 0) process.exitCode = result.status ?? 1;
    if (json) print(observed);
    return;
  }
  if (group === "activity" && action === "publish") {
    return print(await api(`/api/runs/${first}/activity`, { method: "POST", body: JSON.stringify({
      type: value("--type", "note"), message: value("--summary"), detail: value("--detail"), nodeId: value("--node"),
    }) }));
  }
  if (group === "state") return print(await api(`/api/runs/${action}`));
  help();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
