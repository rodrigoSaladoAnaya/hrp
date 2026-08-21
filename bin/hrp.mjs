#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  const optionsWithValues = new Set(["--url", "--port", "--data-dir", "--project", "--title", "--requirement", "--summary", "--rationale", "--diff-file", "--type", "--detail", "--node", "--agent", "--phase", "--completed", "--total", "--reviewed", "--remaining", "--timeout", "--tokens", "--api-key", "--base-url", "--model", "--prompt-file", "--system-file", "--run", "--severity", "--body", "--reviewer", "--author", "--resolution-node", "--workspace", "--wait"]);
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

async function ollamaChat(body) {
  // El proxy de ollama puede tardar minutos legítimamente (paquetes de revisión
  // grandes); el fetch global corta a los ~300s (headersTimeout de undici), así
  // que esta ruta usa node:http con un tope explícito de 30 minutos.
  const { request } = await import("node:http");
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const target = new URL("/api/ollama/chat", url);
    const clientRequest = request(target, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      timeout: 1_800_000,
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = {}; }
        if ((response.statusCode ?? 500) >= 400) reject(new Error(parsed.error ?? `${response.statusCode} en el proxy de ollama`));
        else resolve(parsed);
      });
    });
    clientRequest.on("timeout", () => {
      clientRequest.destroy(new Error("La consulta a ollama superó los 30 minutos"));
    });
    clientRequest.on("error", (error) => reject(new Error(`HRP no responde en ${url}: ${error.message}`)));
    clientRequest.end(payload);
  });
}

function printOllamaResult(result) {
  if (json) return print(result);
  // El desglose va a stderr para poder canalizar la respuesta limpia a un archivo.
  process.stderr.write(`# ${result.model} · prompt ${result.promptTokens ?? "?"} tokens · respuesta ${result.completionTokens ?? "?"} tokens\n`);
  process.stdout.write(result.content.endsWith("\n") ? result.content : `${result.content}\n`);
}

// Consulta la señal de HRP para un agente. Las esperas largas se parten en
// tramos porque el fetch de Node aborta a los 300s de espera de cabeceras: el
// servidor no responde hasta tener algo que decir, así que un --wait 600 en una
// sola petición moriría por timeout del cliente, no del protocolo.
const attentionChunkMs = 240_000;

async function attention({ agent, runId, workspace, waitSeconds = 0 }) {
  const deadline = Date.now() + Math.min(Math.max(Number(waitSeconds) || 0, 0), 600) * 1000;
  let networkFailures = 0;
  for (;;) {
    const remaining = Math.max(deadline - Date.now(), 0);
    const params = new URLSearchParams({ agent });
    if (runId) params.set("runId", runId);
    if (workspace) params.set("workspace", path.resolve(workspace));
    if (remaining > 0) params.set("waitMs", String(Math.min(remaining, attentionChunkMs)));
    let signal;
    try {
      signal = await api(`/api/attention?${params}`);
      networkFailures = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith(`HRP no responde en ${url}:`) || networkFailures >= 5) throw error;
      networkFailures += 1;
      process.stderr.write(`Fallo transitorio de HRP; reintento ${networkFailures}/5 en 3s: ${message}\n`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    if (signal.actionable || signal.terminal || Date.now() >= deadline) return signal;
  }
}

// --- Despertador nativo -------------------------------------------------
// Los hooks de Claude Code y de Codex comparten esquema: reciben el evento por
// stdin y responden por stdout. Un hook Stop que devuelve {"decision":"block"}
// impide que la sesión termine, así que es el único punto donde HRP puede
// devolverle el turno a un agente sin que el humano se lo pida.
const hookWaitMs = Math.min(Math.max(Number(process.env.HRP_HOOK_WAIT_MS ?? 15000), 0), 120_000);
// Sólo se retiene la sesión mientras otro agente tiene un nodo en vuelo: ahí el
// trabajo llega en minutos. Cualquier otra espera (auditor pendiente, pausa,
// prerrequisitos de un agente que no está trabajando) puede durar horas y su
// siguiente movimiento suele ser del humano; retener ahí no mantiene atento al
// agente, le impide devolver el turno.
const hookMaxParks = Math.max(Number(process.env.HRP_HOOK_MAX_PARKS ?? 3), 1);

function readHookEvent() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function hookStateFile(sessionId) {
  const safe = String(sessionId || "sin-sesion").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  return path.join(dataDir, "runtime", "hooks", `${safe}.json`);
}

function readHookParks(sessionId) {
  try { return Number(JSON.parse(readFileSync(hookStateFile(sessionId), "utf8")).parks) || 0; } catch { return 0; }
}

function writeHookParks(sessionId, parks) {
  try {
    const file = hookStateFile(sessionId);
    mkdirSync(path.dirname(file), { recursive: true });
    if (parks <= 0) rmSync(file, { force: true });
    else writeFileSync(file, JSON.stringify({ parks, updatedAt: new Date().toISOString() }));
  } catch { /* el contador es una salvaguarda, nunca un motivo de fallo */ }
}

async function healthy() {
  return fetch(`${url}/api/health`).then((response) => response.ok).catch(() => false);
}

function reportSkillSync() {
  const updated = syncInstalledSkills();
  if (updated.length) print(`Skills sincronizadas con esta versión de HRP: ${updated.join(", ")}`);
}

async function startService(workspace) {
  if (await healthy()) {
    if (workspace) await api("/api/projects", { method: "POST", body: JSON.stringify({ workspaceRoot: workspace }) });
    reportSkillSync();
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
      reportSkillSync();
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

const skillReceipt = ".hrp-install-source";
const skillAgents = {
  claude: {
    source: path.join(root, "integrations/claude/skills/hrp"),
    target: path.join(os.homedir(), ".claude", "skills", "hrp"),
    extras: [{ from: path.join(root, "docs/agent-adapter.md"), to: "references/agent-adapter.md" }],
  },
  codex: {
    source: path.join(root, "integrations/codex/plugins/hrp/skills/use-hrp"),
    target: path.join(process.env.HRP_CODEX_SKILLS_DIR ?? path.join(os.homedir(), ".agents", "skills"), "use-hrp"),
    extras: [],
  },
  antigravity: {
    source: path.join(root, "integrations/antigravity/skills/hrp"),
    target: path.join(os.homedir(), ".gemini", "config", "skills", "hrp"),
    extras: [
      { from: path.join(root, "docs/agent-adapter.md"), to: "references/agent-adapter.md" },
      { from: path.join(root, "docs/protocol.md"), to: "references/protocol.md" },
      { from: path.join(root, "integrations/antigravity/rules/hrp.md"), to: "references/hrp-rules.md" },
    ],
  },
};

function walkSkillFiles(dir, prefix = "") {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === skillReceipt) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...walkSkillFiles(path.join(dir, entry.name), relative));
    else result.push(relative);
  }
  return result;
}

function digestSkillFiles(files) {
  const hash = createHash("sha256");
  for (const relative of [...files.keys()].sort()) hash.update(relative).update("\0").update(readFileSync(files.get(relative))).update("\0");
  return hash.digest("hex");
}

function skillSourceFiles(spec) {
  const files = new Map(walkSkillFiles(spec.source).map((relative) => [relative, path.join(spec.source, relative)]));
  for (const extra of spec.extras) files.set(extra.to, extra.from);
  return files;
}

function skillOwnership(spec) {
  if (!existsSync(spec.target)) return "absent";
  const receipt = path.join(spec.target, skillReceipt);
  if (!existsSync(receipt)) return "foreign";
  return readFileSync(receipt, "utf8").split("\n")[0] === spec.source ? "owned" : "foreign";
}

function skillState(spec) {
  const ownership = skillOwnership(spec);
  if (ownership !== "owned") return ownership;
  const installed = new Map(walkSkillFiles(spec.target).map((relative) => [relative, path.join(spec.target, relative)]));
  return digestSkillFiles(installed) === digestSkillFiles(skillSourceFiles(spec)) ? "current" : "stale";
}

function installSkill(name, spec) {
  if (!existsSync(path.join(spec.source, "SKILL.md"))) throw new Error(`Falta la fuente de la skill de ${name}: ${spec.source}`);
  const ownership = skillOwnership(spec);
  if (ownership === "foreign") throw new Error(`${spec.target} existe y no pertenece a esta instalación de HRP`);
  mkdirSync(path.dirname(spec.target), { recursive: true });
  const staging = `${spec.target}.hrp-staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(spec.source, staging, { recursive: true });
  for (const extra of spec.extras) {
    mkdirSync(path.dirname(path.join(staging, extra.to)), { recursive: true });
    cpSync(extra.from, path.join(staging, extra.to));
  }
  writeFileSync(path.join(staging, skillReceipt), `${spec.source}\n`);
  rmSync(spec.target, { recursive: true, force: true });
  renameSync(staging, spec.target);
  if (name === "antigravity") {
    const rulesSource = path.join(root, "integrations/antigravity/rules/hrp.md");
    if (existsSync(rulesSource)) {
      const globalRulesDir = path.join(os.homedir(), ".gemini", "config", "rules");
      mkdirSync(globalRulesDir, { recursive: true });
      cpSync(rulesSource, path.join(globalRulesDir, "hrp.md"));
    }
  }
  return ownership === "owned" ? "actualizada" : "instalada";
}

function syncInstalledSkills() {
  const updated = [];
  for (const [name, spec] of Object.entries(skillAgents)) {
    try {
      if (skillState(spec) === "stale") { installSkill(name, spec); updated.push(name); }
    } catch { /* fuente incompleta o destino ajeno: hrp skills status lo reporta */ }
  }
  return updated;
}

// Contrato de los instaladores por modelo: cada agente implementa el suyo en
// bin/install/<agente>.mjs con 'export const agent' y
// 'export async function install(context)' devolviendo
// { agent, actions, warnings, verified }. El CLI solo fija el contrato,
// entrega rutas absolutas (las GUIs no heredan el PATH) y evalúa el resultado.
const installerAgents = ["claude", "codex", "antigravity"];

function installerContext(name) {
  return {
    root,
    nodePath: process.execPath,
    cliPath: path.join(root, "bin/hrp.mjs"),
    dataDir,
    url,
    log: (message) => process.stderr.write(`  ${message}\n`),
    installSkill: (skillName = name) => {
      const spec = skillAgents[skillName];
      if (!spec) throw new Error(`No hay skill declarada para ${skillName}`);
      return installSkill(skillName, spec);
    },
    skillState: (skillName = name) => {
      const spec = skillAgents[skillName];
      if (!spec) throw new Error(`No hay skill declarada para ${skillName}`);
      return skillState(spec);
    },
  };
}

async function loadInstaller(name) {
  if (!installerAgents.includes(name)) throw new Error(`Agente desconocido: ${name}. Usa ${installerAgents.join(", ")} o all`);
  const modulePath = path.join(root, "bin/install", `${name}.mjs`);
  if (!existsSync(modulePath)) throw new Error(`Falta el instalador de ${name}: ${modulePath}`);
  const installer = await import(pathToFileURL(modulePath).href);
  if (typeof installer.install !== "function") throw new Error(`${modulePath} no exporta install(context)`);
  if (installer.agent && installer.agent !== name) throw new Error(`${modulePath} dice ser el instalador de ${installer.agent}, no de ${name}`);
  return installer;
}

async function runInstaller(name) {
  process.stderr.write(`Instalando la integración de ${name}...\n`);
  try {
    const installer = await loadInstaller(name);
    const result = await installer.install(installerContext(name));
    return { agent: name, actions: [], warnings: [], verified: false, ...result };
  } catch (error) {
    return { agent: name, actions: [], warnings: [error instanceof Error ? error.message : String(error)], verified: false };
  }
}

async function installerStatus(name) {
  try {
    const installer = await loadInstaller(name);
    if (typeof installer.status === "function") return { agent: name, ...(await installer.status(installerContext(name))) };
    return { agent: name, skill: skillState(skillAgents[name]), installer: "presente" };
  } catch (error) {
    return { agent: name, error: error instanceof Error ? error.message : String(error) };
  }
}

function localVersion() {
  try { return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version; } catch { return "desconocida"; }
}

function help() {
  console.log(`Human Review Protocol CLI v${localVersion()}

Uso:
  hrp service <start|status|stop> [workspace]
  hrp attach [workspace] [--start]
  hrp project list
  hrp project remove <project-id> --yes
  hrp run create --title TEXTO --requirement TEXTO [--project ID]
  hrp run list [--project ID]
  hrp run pause|resume|stop <run-id>
  hrp run auditors <run-id> <agente...>
  hrp run delete <run-id> --yes
  hrp graph publish <run-id> <graph.json> [--agent NOMBRE]
  hrp node discover <run-id> <node.json>
  hrp node approve <run-id> [node-id...]
  hrp node assign <run-id> <node-id> <agente|->
  hrp node start <run-id> <node-id> [--agent NOMBRE]
  hrp node retry <run-id> <node-id> [--agent NOMBRE]
  hrp patch publish <run-id> <node-id> --summary TEXTO [--rationale TEXTO] --diff-file PATH|-
  hrp verify run <run-id> <node-id> -- <comando> [args...]
  hrp node complete <run-id> <node-id> [--tokens N]
  hrp activity publish <run-id> --type run|graph|inspect|node|patch|verify|note --summary TEXTO [--detail TEXTO] [--node ID] [--agent NOMBRE]
  hrp agent status <run-id> --agent NOMBRE --phase idle|waiting|executing|reviewing|completed|failed --summary TEXTO [--detail TEXTO] [--node ID] [--completed N --total N --reviewed ID,ID --remaining ID,ID]
  hrp ollama status
  hrp ollama config [--api-key KEY] [--model MODELO] [--base-url URL] [--clear-key]
  hrp ollama exec <run-id> <node-id> [--model MODELO]
  hrp ollama run --prompt-file PATH|- [--system-file PATH] [--model MODELO] [--run RUN_ID --node NODE_ID]
  hrp ollama review <run-id> [--node ID] [--model MODELO]
  hrp review pack <run-id> [--node ID]
  hrp review gate <run-id>
  hrp finding add <run-id> --title T --body B --severity critical|major|minor|question --reviewer NOMBRE [--node ID]
  hrp finding list <run-id>
  hrp finding show <finding-id>
  hrp finding reply <finding-id> --author NOMBRE --body TEXTO
  hrp finding accept <finding-id> [--resolution-node ID]
  hrp finding reject <finding-id> --author NOMBRE --body RAZON
  hrp finding reopen <finding-id> --author NOMBRE --body RAZON
  hrp finding escalate <finding-id>
  hrp state <run-id>
  hrp version
  hrp attention [run-id] [--agent NOMBRE] [--run RUN_ID] [--workspace PATH] [--wait SEGUNDOS]
  hrp hook <stop|session-start> --agent NOMBRE   (lee el evento por stdin; lo instalan los agentes)
  hrp wait approval <run-id> [--agent NOMBRE] [--timeout SEGUNDOS]
  hrp agent install <claude|codex|antigravity|all>   (skill + MCP + despertador nativo del modelo)
  hrp agent status                                   (qué quedó instalado por modelo)
  hrp skills install <claude|codex|antigravity|all>  (solo la skill; lo instala 'agent install')
  hrp skills update
  hrp skills status
  hrp mcp

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
    const agent = value("--agent") ?? value("--author");
    const body = { title: value("--title"), requirement: value("--requirement") };
    if (agent) body.agent = agent;
    const run = await api(`/api/projects/${projectId}/runs`, { method: "POST", body: JSON.stringify(body) });
    return print(run);
  }
  if (group === "run" && action === "list") {
    const projectId = await resolveProject(value("--project"));
    return print((await api(`/api/projects/${projectId}/runs`)).runs);
  }
  if (group === "run" && (action === "pause" || action === "resume" || action === "stop")) {
    const control = action === "pause" ? "paused" : action === "resume" ? "active" : "stopped";
    const run = await api(`/api/runs/${encodeURIComponent(first)}/control`, { method: "POST", body: JSON.stringify({ control }) });
    return print(json ? run : `Ejecución "${run.title}": ${control === "active" ? "reanudada" : control === "paused" ? "pausada" : "detenida"}.`);
  }
  if (group === "run" && action === "auditors") {
    const auditors = args.slice(3);
    if (!first || auditors.length === 0) throw new Error("Uso: hrp run auditors <run-id> <agente...>");
    try {
      const run = await api(`/api/runs/${encodeURIComponent(first)}/auditors`, { method: "PUT", body: JSON.stringify({ auditors }) });
      return print(json ? run : `Auditores: ${run.auditors.join(", ") || "(ninguno)"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/paus|pause|activa|active|congel/i.test(message)) {
        throw new Error(`${message}. Pausa primero con 'hrp run pause ${first}' y vuelve a ejecutar el comando.`);
      }
      throw error;
    }
  }
  if (group === "run" && action === "delete") {
    if (!flag("--yes")) throw new Error("Confirma el borrado con --yes");
    await api(`/api/runs/${encodeURIComponent(first)}`, { method: "DELETE" });
    return print("Ejecución eliminada.");
  }

  if (group === "graph" && action === "publish") {
    const agent = value("--agent");
    return print(await api(`/api/runs/${first}/graph`, { method: "POST", body: JSON.stringify({ ...readJson(second), ...(agent ? { agent } : {}) }) }));
  }
  if (group === "node" && action === "discover") {
    return print(await api(`/api/runs/${first}/nodes`, { method: "POST", body: JSON.stringify(readJson(second)) }));
  }
  if (group === "node" && action === "approve") {
    const nodeIds = args.slice(3);
    return print(await api(`/api/runs/${first}/approve`, { method: "POST", body: JSON.stringify(nodeIds.length ? { nodeIds } : {}) }));
  }
  if (group === "node" && action === "assign") {
    const assignee = args[4];
    if (!assignee) throw new Error("Falta el agente: hrp node assign <run-id> <node-id> <agente|->");
    return print(await api(`/api/runs/${first}/nodes/${second}/assign`, { method: "POST", body: JSON.stringify({ assignee: assignee === "-" ? null : assignee }) }));
  }
  if (group === "node" && (action === "start" || action === "retry")) {
    const agent = value("--agent");
    return print(await api(`/api/runs/${first}/nodes/${second}/start`, { method: "POST", body: JSON.stringify(agent ? { agent } : {}) }));
  }
  if (group === "node" && action === "complete") {
    const tokens = value("--tokens");
    return print(await api(`/api/runs/${first}/nodes/${second}/complete`, { method: "POST", body: JSON.stringify(tokens ? { tokens: Number(tokens) } : {}) }));
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
      agent: value("--agent") ?? value("--author"),
    }) }));
  }
  if (group === "agent" && action === "install") {
    const names = !first || first === "all" ? installerAgents : [first];
    for (const name of names) if (!installerAgents.includes(name)) throw new Error(`Agente desconocido: ${name}. Usa ${installerAgents.join(", ")} o all`);
    const results = [];
    for (const name of names) results.push(await runInstaller(name));
    if (json) print({ results, verified: results.every((result) => result.verified) });
    else {
      for (const result of results) {
        print(`${result.agent}: ${result.verified ? "instalado y verificado" : "REVISAR"}`);
        for (const action of result.actions) print(`  · ${action}`);
        for (const warning of result.warnings) print(`  ! ${warning}`);
      }
    }
    if (!results.every((result) => result.verified)) process.exitCode = 1;
    return;
  }

  // Sin run-id, 'agent status' reporta la instalación de cada modelo; con
  // run-id conserva su significado de siempre: publicar la fase observable.
  if (group === "agent" && action === "status" && !first) {
    const estados = [];
    for (const name of installerAgents) estados.push(await installerStatus(name));
    return print(json ? estados : estados.map((estado) => `${estado.agent}: ${JSON.stringify({ ...estado, agent: undefined })}`).join("\n"));
  }

  if (group === "agent" && action === "status") {
    const agent = value("--agent");
    const phase = value("--phase");
    const summary = value("--summary");
    if (!first || !agent || !phase || !summary) throw new Error("Uso: hrp agent status <run-id> --agent NOMBRE --phase FASE --summary TEXTO");
    const splitIds = (name) => (value(name) ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    const count = (name) => {
      const parsed = Number(value(name));
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} espera un entero no negativo`);
      return parsed;
    };
    // Una bandera ausente no declara cobertura cero: omitirla conserva la que
    // el agente ya publicó, y sólo la bandera presente la reemplaza. Enviar
    // ceros por defecto borraba lo revisado al anunciar una fase nueva.
    const body = { phase, summary };
    if (flag("--completed")) body.completed = count("--completed");
    if (flag("--total")) body.total = count("--total");
    if (flag("--reviewed")) body.reviewedNodeIds = splitIds("--reviewed");
    if (flag("--remaining")) body.remainingNodeIds = splitIds("--remaining");
    if (value("--detail")) body.detail = value("--detail");
    if (value("--node")) body.currentNodeId = value("--node");
    return print(await api(`/api/runs/${encodeURIComponent(first)}/agents/${encodeURIComponent(agent)}/status`, { method: "PUT", body: JSON.stringify(body) }));
  }
  if (group === "version") {
    const local = localVersion();
    const health = await fetch(`${url}/api/health`).then((response) => response.ok ? response.json() : undefined).catch(() => undefined);
    const service = health?.protocolVersion ?? "servicio detenido";
    if (json) return print({
      cli: local,
      serviceProtocol: health?.protocolVersion ?? null,
      serviceBuild: health?.buildId ?? null,
      currentBuild: health?.currentBuildId ?? null,
      buildStale: health?.buildStale ?? null,
      url,
    });
    const build = health?.buildId ? ` · build ${health.buildId}` : "";
    print(`CLI:      v${local}\nServicio: ${health ? `protocolo ${service}${build} (${url})` : `detenido (${url})`}`);
    if (health?.buildStale === true) {
      print("Aviso: el build local y el servicio en ejecución difieren; reinicia con ./scripts/update.sh");
    }
    return;
  }
  if (group === "hook") {
    // Un hook jamás debe romper la sesión del agente: cualquier problema se
    // reporta por stderr y se deja continuar como si HRP no existiera.
    const agent = value("--agent", process.env.HRP_AGENT);
    const event = readHookEvent();
    const workspace = typeof event.cwd === "string" && event.cwd ? event.cwd : process.cwd();
    const sessionId = event.session_id ?? event.sessionId;
    try {
      if (!agent) throw new Error("Falta --agent NOMBRE en el hook de HRP");
      // Comprobación barata primero: sin servicio, el hook no puede costarle
      // ni un segundo a una sesión que no tiene nada que ver con HRP.
      if (!(await healthy())) return;
      if (action === "session-start") {
        const signal = await attention({ agent, workspace, waitSeconds: 0 });
        if (!signal.runs?.length) return;
        // El barrido ya viene ordenado por prioridad. Un workspace veterano
        // acumula decenas de ejecuciones vivas: listarlas todas convierte el
        // contexto en ruido, así que sólo entran las que reclaman algo y como
        // mucho tres, diciendo cuántas quedaron fuera.
        const relevantes = signal.runs.filter((candidate) => candidate.actionable || candidate.waiting);
        if (!relevantes.length) return;
        const visibles = relevantes.slice(0, 3);
        const detalle = visibles.map((candidate) => `- ${candidate.runId} [${candidate.kind}]: ${candidate.directive}`).join("\n");
        const resto = relevantes.length - visibles.length;
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: `HRP tiene ${relevantes.length} ${relevantes.length === 1 ? "ejecución viva" : "ejecuciones vivas"} en este workspace para ${agent}${resto > 0 ? ` (las ${visibles.length} más urgentes)` : ""}:\n${detalle}${resto > 0 ? `\n(+${resto} más; consúltalas con 'hrp attention --agent ${agent} --json')` : ""}\nRetoma con 'hrp attention --agent ${agent} --wait 600' o con la herramienta MCP hrp_attention; no abras una ejecución nueva para el mismo requerimiento.`,
          },
        }));
        return;
      }
      if (action !== "stop") throw new Error("Uso: hrp hook <stop|session-start> --agent NOMBRE");

      let signal = await attention({ agent, workspace, waitSeconds: 0 });
      if (!signal.actionable && (!signal.waiting || signal.kind === "busy")) {
        signal = await attention({ agent, workspace, waitSeconds: Math.round(hookWaitMs / 1000) });
      }
      if (signal.actionable) {
        writeHookParks(sessionId, 0);
        process.stdout.write(JSON.stringify({
          decision: "block",
          reason: `HRP tiene trabajo para ti (${signal.kind}) en la ejecución ${signal.runId}: ${signal.directive}`,
        }));
        return;
      }
      // El contador sólo se reinicia cuando la espera termina, no en cada
      // consulta: reiniciarlo antes de leerlo dejaba el tope inalcanzable.
      const soltar = (respond) => { writeHookParks(sessionId, 0); return respond?.(); };
      if (!signal.waiting) return soltar();
      // El resto de las esperas se informan sin retener: si el siguiente
      // movimiento es del humano, atrapar al agente sólo le impide contestarle.
      const avisar = () => soltar(() => process.stdout.write(JSON.stringify({
        continue: true,
        systemMessage: `HRP: la ejecución ${signal.runId} sigue viva y ahora mismo no hay trabajo para ${agent} (${signal.kind}). ${signal.directive} Cuando quieras retomar: 'hrp attention --agent ${agent} --workspace ${workspace} --wait 600'.`,
      })));
      if (signal.kind !== "busy") return avisar();
      // 'busy' es la única espera corta y previsible: otro agente está
      // ejecutando un nodo justo ahora y el turno se libera al terminarlo.
      const parks = readHookParks(sessionId) + 1;
      if (parks > hookMaxParks) return avisar();
      writeHookParks(sessionId, parks);
      process.stdout.write(JSON.stringify({
        decision: "block",
        reason: `${signal.directive} No cierres el turno todavía: ejecuta 'hrp attention --agent ${agent} --workspace ${workspace} --wait 600' y retoma en cuanto ese nodo termine (espera ${parks}/${hookMaxParks}).`,
      }));
    } catch (error) {
      process.stderr.write(`hrp hook: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return;
  }

  if (group === "attention") {
    const agent = value("--agent", process.env.HRP_AGENT);
    if (!agent) throw new Error("Falta --agent NOMBRE (o la variable HRP_AGENT): la señal de HRP siempre es para un agente concreto");
    const signal = await attention({
      agent,
      runId: value("--run") ?? (action && action !== "wait" ? action : undefined),
      workspace: value("--workspace"),
      waitSeconds: Number(value("--wait", "0")),
    });
    if (json) print(signal);
    else print(signal.directive);
    // 0 = hay trabajo ahora; 3 = nada que hacer (esperando, detenida o completa).
    if (!signal.actionable) process.exitCode = 3;
    return;
  }

  if (group === "wait" && action === "approval") {
    const timeoutSeconds = Number(value("--timeout", "300"));
    const deadline = Date.now() + timeoutSeconds * 1000;
    // Sin --agent la espera es la del modelo base: la señal siempre pertenece a
    // un agente concreto y el servidor la resuelve por identidad.
    const agent = value("--agent") ?? (await api(`/api/runs/${first}`)).run.baseAgent;
    if (!agent) throw new Error("Esta ejecución todavía no tiene modelo base; indica --agent NOMBRE");
    // Anuncia presencia desde que comienza la espera: el panel deja de mostrar
    // "sin señal" aunque el agente aún no haya iniciado ningún nodo.
    await api(`/api/runs/${first}/agents`, { method: "POST", body: JSON.stringify({ agent }) }).catch(() => undefined);
    process.stderr.write("Esperando una señal accionable de HRP...\n");
    let lastKind;
    let pendingAuditors = [];
    while (Date.now() < deadline) {
      const remaining = Math.max(Math.ceil((deadline - Date.now()) / 1000), 0);
      // El primer sondeo es inmediato para poder explicar por qué se espera;
      // a partir de ahí el servidor avisa solo (long-poll) en vez de sondear.
      const signal = await attention({ agent, runId: first, waitSeconds: lastKind === undefined ? 0 : remaining });
      if (signal.actionable || signal.terminal) return print(signal.directive);
      pendingAuditors = signal.pendingAuditors ?? [];
      if (signal.kind !== lastKind) {
        process.stderr.write(`${signal.directive}\n`);
        lastKind = signal.kind;
      }
    }
    if (lastKind === "implementation") {
      throw new Error(`La implementación aún no termina después de ${timeoutSeconds}s. Vuelve a ejecutar 'hrp wait approval'; no necesitas pedir otra aprobación humana.`);
    }
    if (lastKind === "auditors") {
      throw new Error(`Siguen pendientes los auditores ${pendingAuditors.join(", ")} después de ${timeoutSeconds}s. Vuelve a ejecutar 'hrp wait approval'; review gate permanece bloqueado.`);
    }
    if (lastKind === "review-pass") {
      throw new Error(`No hubo una nueva pasada de auditoría después de ${timeoutSeconds}s. Vuelve a ejecutar 'hrp wait approval' para seguir disponible.`);
    }
    if (lastKind === "blocked") {
      throw new Error(`Tu trabajo aprobado sigue esperando prerrequisitos después de ${timeoutSeconds}s. Vuelve a ejecutar 'hrp wait approval'; no necesitas pedir otra aprobación humana.`);
    }
    throw new Error(`Sin aprobación después de ${timeoutSeconds}s. Vuelve a ejecutar 'hrp wait approval' o pide la aprobación al humano`);
  }
  if (group === "skills") {
    if (action === "install") {
      const names = !first || first === "all" ? Object.keys(skillAgents) : [first];
      for (const name of names) if (!skillAgents[name]) throw new Error(`Agente desconocido: ${name}. Usa claude, codex, antigravity o all`);
      for (const name of names) print(`Skill de ${name} ${installSkill(name, skillAgents[name])}: ${skillAgents[name].target}`);
      return;
    }
    if (action === "update") {
      const updated = syncInstalledSkills();
      return print(updated.length ? `Skills actualizadas: ${updated.join(", ")}` : "Todas las skills instaladas están al día.");
    }
    if (action === "status") {
      const copy = { absent: "no instalada", foreign: "existe pero es ajena a HRP", current: "al día", stale: "desactualizada" };
      return print(Object.fromEntries(Object.entries(skillAgents).map(([name, spec]) => {
        let state;
        try { state = copy[skillState(spec)] ?? skillState(spec); } catch (error) { state = `error: ${error.message}`; }
        return [name, { estado: state, destino: spec.target }];
      })));
    }
  }
  if (group === "ollama") {
    if (action === "status") return print(await api("/api/settings/ollama"));
    if (action === "config") {
      const body = {};
      if (flag("--clear-key")) body.apiKey = null;
      else if (value("--api-key")) body.apiKey = value("--api-key");
      if (value("--model")) body.model = value("--model");
      if (value("--base-url")) body.baseUrl = value("--base-url");
      if (!Object.keys(body).length) throw new Error("Nada que actualizar: usa --api-key, --model, --base-url o --clear-key");
      return print(await api("/api/settings/ollama", { method: "PUT", body: JSON.stringify(body) }));
    }
    if (action === "run") {
      const promptFile = value("--prompt-file");
      if (!promptFile) throw new Error("Falta --prompt-file PATH|- (el prompt para el modelo de ollama)");
      const body = { prompt: promptFile === "-" ? readFileSync(0, "utf8") : readFileSync(path.resolve(promptFile), "utf8") };
      const systemFile = value("--system-file");
      if (systemFile) body.system = readFileSync(path.resolve(systemFile), "utf8");
      if (value("--model")) body.model = value("--model");
      // Con contexto, la consulta queda auditada en la actividad de esa ejecución.
      if (value("--run")) body.runId = value("--run");
      if (value("--node")) body.nodeId = value("--node");
      return printOllamaResult(await ollamaChat(body));
    }
    if (action === "exec") {
      // La descripción del nodo (aprobada por el humano) ES la especificación:
      // exec la reutiliza como prompt en lugar de redactar uno artesanal.
      if (!first || !second) throw new Error("Uso: hrp ollama exec <run-id> <node-id> [--model MODELO]");
      const detail = await api(`/api/runs/${first}`);
      const node = detail.nodes.find((candidate) => candidate.id === second);
      if (!node) throw new Error(`Nodo desconocido en la ejecución: ${second}`);
      const filePath = path.resolve(process.cwd(), node.file);
      const exists = existsSync(filePath);
      const content = exists ? readFileSync(filePath, "utf8") : "";
      // Contexto de referencia aprobado en el nodo: los contratos reales que
      // el modelo modesto necesita ver para no inventar nada.
      const references = [];
      for (const contextFile of node.contextFiles ?? []) {
        const contextPath = path.resolve(process.cwd(), contextFile);
        if (!existsSync(contextPath)) throw new Error(`El archivo de contexto del nodo no existe en el workspace: ${contextFile}`);
        references.push({ file: contextFile, content: readFileSync(contextPath, "utf8") });
      }
      if (content.length + references.reduce((sum, ref) => sum + ref.content.length, 0) > 200_000) {
        throw new Error(`El archivo del nodo más su contexto exceden 200KB; usa 'hrp ollama run --prompt-file' con solo los fragmentos relevantes`);
      }
      const prompt = [
        "Eres un asistente de programación. Aplica la siguiente operación y devuelve ÚNICAMENTE el contenido completo del archivo resultante, sin explicaciones, sin markdown y sin fences de código.",
        "",
        `Archivo: ${node.file}`,
        `Símbolo u objetivo: ${node.symbol}`,
        `Operación: ${node.title}`,
        `Especificación: ${node.description}`,
        `Motivo: ${node.rationale}`,
        "",
        "No cambies nada fuera de lo especificado: conserva el resto del archivo exactamente igual.",
        "Si la especificación no define el contrato de algo que necesitas (una función, un campo, un formato), NO lo supongas ni lo inventes: responde únicamente una línea que empiece con 'NECESITO: ' describiendo qué te falta.",
        ...references.flatMap((ref) => ["", `REFERENCIA (solo lectura, NO la modifiques): ${ref.file}`, "", ref.content.trimEnd()]),
        "",
        exists ? `Contenido actual de ${node.file}:` : `El archivo ${node.file} no existe todavía: genera su contenido completo.`,
        ...(exists ? ["", content] : []),
      ].join("\n");
      const body = { prompt, runId: first, nodeId: second };
      if (value("--model")) body.model = value("--model");
      const result = await ollamaChat(body);
      const answer = String(result.content ?? "").trim();
      if (answer.startsWith("NECESITO:")) {
        // El modelo pidió lo que le falta en vez de inventarlo: el protocolo
        // funcionó, pero este nodo no puede continuar con la spec actual.
        throw new Error(`Ollama necesita más contexto para este nodo — ${answer.split("\n")[0]}. Enriquece la descripción o agrega contextFiles al nodo, republica el grafo y reintenta`);
      }
      return printOllamaResult(result);
    }
    if (action === "review") {
      // Revisor automático sin sesión: audita el pack y registra hallazgos con
      // reviewer ollama:<modelo>. Nunca edita código ni inventa problemas.
      if (!first) throw new Error("Uso: hrp ollama review <run-id> [--node ID] [--model MODELO]");
      const nodeId = value("--node");
      const params = new URLSearchParams({ agent: "ollama" });
      if (nodeId) params.set("nodeId", nodeId);
      const query = `?${params}`;
      const packResponse = await fetch(`${url}/api/runs/${encodeURIComponent(first)}/review-pack${query}`)
        .catch((error) => { throw new Error(`HRP no responde en ${url}: ${error.message}`); });
      if (!packResponse.ok) {
        const errorBody = await packResponse.json().catch(() => ({}));
        throw new Error(errorBody.error ?? `${packResponse.status} ${packResponse.statusText}`);
      }
      const pack = await packResponse.text();
      if (pack.length > 200_000) throw new Error("El paquete de revisión excede 200KB; audita por subárboles con --node");
      const detail = await api(`/api/runs/${encodeURIComponent(first)}`);
      const prompt = [
        "Eres un modelo revisor de código dentro del protocolo HRP. Audita el paquete de revisión que sigue.",
        "Busca únicamente problemas reales y verificables en los diffs aplicados: errores de integración entre nodos, contratos rotos, desviaciones respecto a la spec aprobada y casos borde sin cubrir.",
        "Si el paquete no incluye algo que necesitas para afirmar un problema, NO lo supongas: responde únicamente una línea que empiece con 'NECESITO: ' describiendo qué falta.",
        `Responde ÚNICAMENTE con un arreglo JSON, sin explicaciones, sin markdown y sin fences: cada elemento es {"severity":"critical|major|minor|question","title":"...","body":"...","node":"id-del-nodo"} y "node" es opcional.`,
        "Si no encuentras ningún problema real, responde exactamente el literal SIN-HALLAZGOS.",
        "No inventes hallazgos para rellenar: SIN-HALLAZGOS es una respuesta válida y valiosa.",
        "",
        pack,
      ].join("\n");
      const requestBody = { prompt, runId: first };
      if (nodeId) requestBody.nodeId = nodeId;
      if (value("--model")) requestBody.model = value("--model");
      const result = await ollamaChat(requestBody);
      const answer = String(result.content ?? "").trim();
      if (answer.startsWith("NECESITO:")) {
        throw new Error(`El revisor necesita más contexto — ${answer.split("\n")[0]}. Audita un subárbol menor con --node o completa la evidencia de los nodos`);
      }
      process.stderr.write(`# ${result.model} · prompt ${result.promptTokens ?? "?"} tokens · respuesta ${result.completionTokens ?? "?"} tokens\n`);
      if (answer === "SIN-HALLAZGOS") return print("El revisor no reportó hallazgos.");
      let parsed;
      try { parsed = JSON.parse(answer); } catch {
        throw new Error(`La respuesta del revisor no es un arreglo JSON ni SIN-HALLAZGOS; no se registró nada. Respuesta: ${answer.slice(0, 200)}`);
      }
      if (!Array.isArray(parsed)) throw new Error("La respuesta del revisor no es un arreglo; no se registró nada");
      // Todo-o-nada: se valida el lote completo antes de registrar el primero,
      // para no dejar hallazgos a medias si un elemento viene malformado.
      const validSeverities = new Set(["critical", "major", "minor", "question"]);
      const validNodes = new Set(detail.nodes.map((node) => node.id));
      for (const item of parsed) {
        if (!item || typeof item.title !== "string" || !item.title || typeof item.body !== "string" || !item.body || !validSeverities.has(item.severity)) {
          throw new Error(`Hallazgo con formato inválido; no se registró nada: ${JSON.stringify(item).slice(0, 200)}`);
        }
      }
      const reviewer = `ollama:${result.model}`;
      const created = [];
      for (const item of parsed) {
        const payload = { reviewer, severity: item.severity, title: item.title, body: item.body };
        if (item.node && validNodes.has(item.node)) payload.nodeId = item.node;
        else if (item.node) payload.body += `\n(El revisor refirió el nodo "${item.node}", que no existe en el run.)`;
        created.push(await api(`/api/runs/${encodeURIComponent(first)}/findings`, { method: "POST", body: JSON.stringify(payload) }));
      }
      if (json) return print(created);
      print(`Hallazgos registrados (${created.length}):`);
      for (const finding of created) print(`[${finding.status}/${finding.severity}] ${finding.id} — ${finding.title}${finding.nodeId ? ` · nodo ${finding.nodeId}` : ""}`);
      return;
    }
  }
  if (group === "finding") {
    const describeFinding = (finding) => `[${finding.status}/${finding.severity}] ${finding.id} — ${finding.title} (${finding.reviewer}${finding.nodeId ? ` · nodo ${finding.nodeId}` : ""}${finding.resolutionNodeId ? ` · corrección ${finding.resolutionNodeId}` : ""})`;
    if (action === "add") {
      if (!first) throw new Error("Uso: hrp finding add <run-id> --title T --body B --severity S --reviewer NOMBRE [--node ID]");
      const body = { reviewer: value("--reviewer"), severity: value("--severity"), title: value("--title"), body: value("--body") };
      if (!body.reviewer || !body.severity || !body.title || !body.body) throw new Error("Faltan datos: --reviewer, --severity (critical|major|minor|question), --title y --body son obligatorios");
      if (value("--node")) body.nodeId = value("--node");
      const finding = await api(`/api/runs/${encodeURIComponent(first)}/findings`, { method: "POST", body: JSON.stringify(body) });
      return print(json ? finding : `Hallazgo registrado: ${describeFinding(finding)}`);
    }
    if (action === "list") {
      if (!first) throw new Error("Uso: hrp finding list <run-id>");
      const { findings } = await api(`/api/runs/${encodeURIComponent(first)}/findings`);
      if (json) return print(findings);
      return print(findings.length ? findings.map(describeFinding).join("\n") : "Sin hallazgos en esta ejecución.");
    }
    if (action === "show") {
      if (!first) throw new Error("Uso: hrp finding show <finding-id>");
      const finding = await api(`/api/findings/${encodeURIComponent(first)}`);
      if (json) return print(finding);
      const thread = finding.messages.map((message) => `  ${message.author} (${message.createdAt}):\n    ${message.body.split("\n").join("\n    ")}`);
      return print([describeFinding(finding), "", finding.body, "", thread.length ? "Debate:" : "Sin respuestas todavía.", ...thread].join("\n"));
    }
    if (action === "reply") {
      const author = value("--author");
      const body = value("--body");
      if (!first || !author || !body) throw new Error("Uso: hrp finding reply <finding-id> --author NOMBRE --body TEXTO");
      const finding = await api(`/api/findings/${encodeURIComponent(first)}/messages`, { method: "POST", body: JSON.stringify({ author, body }) });
      return print(json ? finding : `Respuesta registrada; el hallazgo queda en ${finding.status}.`);
    }
    if (action === "reopen") {
      const author = value("--author");
      const reason = value("--body");
      if (!first || !author || !reason) throw new Error("Uso: hrp finding reopen <finding-id> --author NOMBRE --body RAZON");
      await api(`/api/findings/${encodeURIComponent(first)}/messages`, { method: "POST", body: JSON.stringify({ author, body: reason }) });
      const finding = await api(`/api/findings/${encodeURIComponent(first)}/status`, { method: "POST", body: JSON.stringify({ status: "open" }) });
      return print(json ? finding : `Hallazgo reabierto: ${finding.title}`);
    }
    if (action === "accept" || action === "reject" || action === "escalate") {
      if (!first) throw new Error(`Uso: hrp finding ${action} <finding-id>`);
      if (action === "reject") {
        // El rechazo exige dejar la razón en el hilo: un hallazgo descartado
        // sin argumento no es auditable.
        const author = value("--author");
        const reason = value("--body");
        if (!author || !reason) throw new Error("Uso: hrp finding reject <finding-id> --author NOMBRE --body RAZON");
        await api(`/api/findings/${encodeURIComponent(first)}/messages`, { method: "POST", body: JSON.stringify({ author, body: reason }) });
      }
      const status = action === "accept" ? "accepted" : action === "reject" ? "rejected" : "escalated";
      const payload = { status };
      if (action === "accept" && value("--resolution-node")) payload.resolutionNodeId = value("--resolution-node");
      const finding = await api(`/api/findings/${encodeURIComponent(first)}/status`, { method: "POST", body: JSON.stringify(payload) });
      return print(json ? finding : `Hallazgo ${finding.status}: ${finding.title}`);
    }
  }
  if (group === "review" && action === "gate") {
    if (!first) throw new Error("Uso: hrp review gate <run-id>");
    const gate = await api(`/api/runs/${encodeURIComponent(first)}/review-gate`);
    const pending = gate.pending ?? [];
    if (!Array.isArray(gate.pendingAuditors)) {
      print("La ejecución NO puede cerrarse: el servicio HRP no expone pendingAuditors. Actualiza o reinicia el servicio y vuelve a ejecutar el gate.");
      process.exitCode = 1;
      return;
    }
    const pendingAuditors = gate.pendingAuditors;
    const pendingAuditorVotes = typeof gate.pendingAuditorVotes === "number" ? gate.pendingAuditorVotes : pendingAuditors.length;
    if (!pending.length && pendingAuditorVotes === 0) return print("Revisión limpia: sin hallazgos vivos y con mayoría de auditores conforme; la ejecución puede darse por cerrada.");
    print(`La ejecución NO puede cerrarse: ${pending.length} ${pending.length === 1 ? "hallazgo vivo" : "hallazgos vivos"} y ${pendingAuditorVotes} ${pendingAuditorVotes === 1 ? "voto auditor pendiente" : "votos auditores pendientes"} para mayoría.`);
    for (const finding of pending) print(`[${finding.status}/${finding.severity}] ${finding.id} — ${finding.title}`);
    if (pendingAuditors.length && pendingAuditorVotes === 0) print(`Auditores aún sin voto (no bloquean la mayoría): ${pendingAuditors.map((auditor) => auditor.agent).join(", ")}`);
    for (const auditor of pendingAuditors) print(`[${auditor.phase}] ${auditor.agent} — ${auditor.summary}`);
    process.exitCode = 1;
    return;
  }
  if (group === "review" && action === "pack") {
    // El pack es markdown, no JSON: se imprime crudo para copiarlo tal cual a
    // la sesión del modelo revisor (o canalizarlo a un archivo).
    if (!first) throw new Error("Uso: hrp review pack <run-id> [--node ID] [--agent AGENTE]");
    const nodeId = value("--node");
    const agent = value("--agent") ?? value("--author");
    const params = new URLSearchParams();
    if (nodeId) params.set("nodeId", nodeId);
    if (agent) params.set("agent", agent);
    const query = params.toString() ? `?${params}` : "";
    const response = await fetch(`${url}/api/runs/${encodeURIComponent(first)}/review-pack${query}`)
      .catch((error) => { throw new Error(`HRP no responde en ${url}: ${error.message}`); });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `${response.status} ${response.statusText}`);
    }
    const pack = await response.text();
    process.stdout.write(pack.endsWith("\n") ? pack : `${pack}\n`);
    return;
  }
  if (group === "state") return print(await api(`/api/runs/${action}`));
  if (group === "mcp") {
    const mcpEntry = path.join(root, "dist/server/mcp/index.js");
    const { HrpMcpClient, startMcpStdioServer } = await import(mcpEntry);
    const client = new HrpMcpClient(url, dataDir, port);
    return startMcpStdioServer(client);
  }
  help();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
