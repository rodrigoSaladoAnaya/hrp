#!/usr/bin/env node
// CLI de Human Review Protocol v4. La vía normal de uso es el MCP (hrp mcp);
// el CLI queda para arrancar el servicio, los hooks despertadores, el runner
// de modelos sin sesión (hrp attend) y la instalación en cada agente.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

function value(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function flag(name) {
  return argv.includes(name);
}

function positionals() {
  const withValue = new Set(["--agent", "--family", "--model", "--base-url", "--api-key", "--session", "--wait", "--port", "--data-dir", "--url", "--workspace"]);
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (withValue.has(argv[index])) { index += 1; continue; }
    if (argv[index].startsWith("--")) continue;
    result.push(argv[index]);
  }
  return result;
}

const url = value("--url", process.env.HRP_URL ?? "http://127.0.0.1:4317");
const port = Number(value("--port", new URL(url).port || "4317"));
const dataDir = path.resolve(value("--data-dir", process.env.HRP_DATA_DIR ?? path.join(os.homedir(), ".hrp")));
const json = flag("--json");

function print(valueToPrint) {
  if (json || typeof valueToPrint !== "string") console.log(JSON.stringify(valueToPrint, null, 2));
  else console.log(valueToPrint);
}

async function api(endpoint, init = {}) {
  const response = await fetch(`${url}${endpoint}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } })
    .catch((error) => { throw new Error(`HRP no responde en ${url}: ${error.message}`); });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  if (response.status === 204) return undefined;
  const type = response.headers.get("content-type") ?? "";
  return type.includes("json") ? response.json() : response.text();
}

async function serviceHealth() {
  return fetch(`${url}/api/health`).then((res) => (res.ok ? res.json() : undefined)).catch(() => undefined);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// --- Servicio -------------------------------------------------------------

async function startService(workspace) {
  if (await serviceHealth()) {
    if (workspace) await api("/api/projects", { method: "POST", body: JSON.stringify({ workspaceRoot: path.resolve(workspace) }) });
    print(`HRP ya corre en ${url}`);
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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await serviceHealth()) { print(`HRP iniciado en ${url} (datos en ${dataDir})`); return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`HRP no inició. Revisa ${logPath}`);
}

async function stopService() {
  const pidPath = path.join(dataDir, "runtime", "server.pid");
  const health = await serviceHealth();
  const pid = health?.pid ?? (existsSync(pidPath) ? Number(readFileSync(pidPath, "utf8").trim()) : Number.NaN);
  if (!processAlive(pid)) { print("HRP no está corriendo."); try { unlinkSync(pidPath); } catch { /* no-op */ } return; }
  try { process.kill(pid, "SIGTERM"); } catch { /* ya estaba muerto */ }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processAlive(pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (processAlive(pid)) throw new Error(`HRP (pid ${pid}) no terminó; mátalo a mano`);
  try { unlinkSync(pidPath); } catch { /* no-op */ }
  print("HRP detenido.");
}

async function serviceStatus() {
  const health = await serviceHealth();
  if (!health) { print(json ? { status: "stopped", url } : `HRP detenido (${url})`); process.exitCode = 1; return; }
  const { projects } = await api("/api/projects");
  const { runs } = await api("/api/runs");
  const live = runs.filter((run) => run.status !== "closed" && run.control !== "stopped");
  if (json) { print({ status: "running", url, pid: health.pid, buildStale: health.buildStale, projects, liveRuns: live }); return; }
  print(`HRP corriendo en ${url} (pid ${health.pid}${health.buildStale ? ", build viejo: reinicia con ./scripts/update.sh" : ""})`);
  print(`Proyectos: ${projects.length} · runs vivos: ${live.length}`);
  for (const run of live) print(`  ${run.id} [${run.phase}] ${run.title} · sesiones: ${run.attachedSessions.join(", ") || "ninguna"}`);
}

// --- Atención -------------------------------------------------------------

// El fetch de Node aborta a los ~300s sin cabeceras, así que una espera larga
// se parte en tramos.
const attentionChunkMs = 240_000;

async function attention(params, waitSeconds = 0) {
  const deadline = Date.now() + Math.min(Math.max(Number(waitSeconds) || 0, 0), 600) * 1000;
  let failures = 0;
  for (;;) {
    const remaining = Math.max(deadline - Date.now(), 0);
    const query = new URLSearchParams(params);
    if (remaining > 0) query.set("waitMs", String(Math.min(remaining, attentionChunkMs)));
    let signal;
    try {
      signal = await api(`/api/attention?${query}`);
      failures = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith("HRP no responde") || failures >= 5) throw error;
      failures += 1;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    if (signal.actionable || signal.terminal || Date.now() >= deadline) return signal;
  }
}

function ancestorPids(limit = 8) {
  const pids = [];
  let pid = process.ppid;
  for (let depth = 0; depth < limit && pid > 1; depth += 1) {
    pids.push(pid);
    const result = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
    const parent = Number((result.stdout ?? "").trim());
    if (!Number.isInteger(parent) || parent <= 1 || parent === pid) break;
    pid = parent;
  }
  return pids;
}

// --- Hooks despertadores --------------------------------------------------
// Claude Code y Codex comparten esquema: evento por stdin, respuesta por
// stdout. Un Stop que devuelve {"decision":"block"} devuelve el turno al
// agente; es el único punto donde HRP puede despertar a una sesión sin humano.
const hookWaitMs = Math.min(Math.max(Number(process.env.HRP_HOOK_WAIT_MS ?? 15000), 0), 120_000);
const hookMaxParks = Math.max(Number(process.env.HRP_HOOK_MAX_PARKS ?? 2), 1);

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

function readParks(sessionId, kind) {
  try {
    const state = JSON.parse(readFileSync(hookStateFile(sessionId), "utf8"));
    return state.kind === kind ? Number(state.parks) || 0 : 0;
  } catch { return 0; }
}

function writeParks(sessionId, kind, parks) {
  try {
    const file = hookStateFile(sessionId);
    mkdirSync(path.dirname(file), { recursive: true });
    if (parks <= 0) rmSync(file, { force: true });
    else writeFileSync(file, JSON.stringify({ kind, parks, updatedAt: new Date().toISOString() }));
  } catch { /* salvaguarda, nunca motivo de fallo */ }
}

async function hook(action) {
  const family = value("--agent") ?? process.env.HRP_FAMILY;
  const event = readHookEvent();
  const workspace = typeof event.cwd === "string" && event.cwd ? event.cwd : process.cwd();
  const sessionId = event.session_id ?? event.sessionId;
  try {
    if (!family) throw new Error("Falta --agent FAMILIA en el hook de HRP");
    if (!(await serviceHealth())) return;
    const params = { pids: ancestorPids().join(","), family, workspace };
    if (action === "session-start") {
      const { runs } = await api("/api/runs");
      const { projects } = await api("/api/projects");
      const here = projects.find((project) => project.workspaceRoot === workspace || path.resolve(project.workspaceRoot) === path.resolve(workspace));
      const live = runs.filter((run) => run.status !== "closed" && run.control !== "stopped" && (!here || run.projectId === here.id));
      if (!live.length) return;
      const lines = live.slice(0, 3).map((run) => `- ${run.id} [${run.phase}] ${run.title} · sesiones: ${run.attachedSessions.join(", ") || "ninguna"} → /hrp attention ${run.id}`);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `HRP tiene ${live.length} ${live.length === 1 ? "run vivo" : "runs vivos"} en este workspace. Si el humano te pide auditar, engánchate con la skill:\n${lines.join("\n")}${live.length > 3 ? `\n(+${live.length - 3} más)` : ""}`,
        },
      }));
      return;
    }
    if (action !== "stop") throw new Error("Uso: hrp hook <stop|session-start> --agent FAMILIA");
    let signal = await attention(params, 0);
    if (!signal.runs?.length) return;
    if (!signal.actionable && signal.waiting) signal = await attention(params, Math.round(hookWaitMs / 1000));
    const where = signal.session ? ` (tu identidad: ${signal.session})` : "";
    if (signal.actionable) {
      // 'resume' es un recordatorio, no una orden: se retiene el turno un número
      // acotado de veces para no atrapar a un base que necesita al humano.
      if (signal.kind === "resume") {
        const parks = readParks(sessionId, "resume") + 1;
        if (parks > hookMaxParks) { writeParks(sessionId, "resume", 0); return; }
        writeParks(sessionId, "resume", parks);
      } else {
        writeParks(sessionId, signal.kind, 0);
      }
      process.stdout.write(JSON.stringify({
        decision: "block",
        reason: `HRP [${signal.kind}] en el run ${signal.runId}${where}: ${signal.directive}`,
      }));
      return;
    }
    writeParks(sessionId, signal.kind, 0);
    if (signal.waiting) {
      process.stdout.write(JSON.stringify({
        continue: true,
        systemMessage: `HRP: el run ${signal.runId} sigue vivo y no hay trabajo para ti ahora (${signal.kind})${where}. ${signal.directive} Para seguir atento sin terminar el turno usa hrp_attention con waitMs 600000.`,
      }));
    }
  } catch (error) {
    process.stderr.write(`hrp hook: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

// --- Runner para modelos sin sesión (ollama) --------------------------------

async function loadRunner() {
  const entry = path.join(root, "dist/server/server/runner.js");
  if (!existsSync(entry)) throw new Error("Falta el build de HRP: ejecuta npm run build");
  return import(pathToFileURL(entry).href);
}

async function attend(runId) {
  if (!runId) throw new Error("Uso: hrp attend <run-id> --agent ollama [--model M] [--base-url U] [--api-key K]");
  const family = value("--agent", "ollama");
  const { runAttendLoop } = await loadRunner();
  await runAttendLoop({
    baseUrl: url,
    runId,
    family,
    model: value("--model", process.env.HRP_OLLAMA_MODEL ?? "qwen3-coder"),
    ollamaUrl: value("--base-url", process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434"),
    apiKey: value("--api-key", process.env.OLLAMA_API_KEY),
    log: (message) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${message}\n`),
  });
}

// --- Instalación por agente -------------------------------------------------

const installerAgents = ["claude", "codex", "antigravity"];

async function installerContext() {
  const entry = path.join(root, "bin/install/shared.mjs");
  const shared = await import(pathToFileURL(entry).href);
  return {
    root,
    nodePath: process.execPath,
    cliPath: path.join(root, "bin/hrp.mjs"),
    dataDir,
    url,
    log: (message) => process.stderr.write(`  ${message}\n`),
    installSkill: (name) => shared.installSkill(root, name),
    skillState: (name) => shared.skillState(root, name),
  };
}

async function agentInstall(name) {
  if (name === "all") {
    // Instala lo que exista en esta máquina: un agente ausente no es un error.
    let failed = false;
    for (const candidate of installerAgents) {
      try {
        await agentInstall(candidate);
        if (process.exitCode) failed = true;
        process.exitCode = 0;
      } catch (error) {
        print(`${candidate}: omitido (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    if (failed) process.exitCode = 1;
    return;
  }
  if (!installerAgents.includes(name)) throw new Error(`Agente desconocido: ${name}. Usa ${installerAgents.join(", ")} o all`);
  const installer = await import(pathToFileURL(path.join(root, `bin/install/${name}.mjs`)).href);
  const result = await installer.install(await installerContext());
  if (json) { print(result); if (!result.verified) process.exitCode = 1; return; }
  print(`Instalación de ${name}:`);
  for (const action of result.actions) print(`  ✓ ${action}`);
  for (const warning of result.warnings) print(`  ! ${warning}`);
  print(result.verified ? "Verificado." : "Con verificaciones fallidas.");
  if (!result.verified) process.exitCode = 1;
}

async function agentStatus() {
  const context = await installerContext();
  const report = {};
  for (const name of installerAgents) {
    try {
      const installer = await import(pathToFileURL(path.join(root, `bin/install/${name}.mjs`)).href);
      report[name] = await installer.status(context);
    } catch (error) {
      report[name] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  print(json ? report : Object.entries(report).map(([name, entry]) => `${name}: ${Object.entries(entry).map(([key, val]) => `${key}=${val}`).join(" · ")}`).join("\n"));
}

// --- MCP ----------------------------------------------------------------------

async function mcp() {
  const entry = path.join(root, "dist/server/mcp/index.js");
  if (!existsSync(entry)) throw new Error("Falta el build de HRP: ejecuta npm run build");
  const { startMcpStdioServer, HrpMcpClient } = await import(pathToFileURL(entry).href);
  const family = value("--family", process.env.HRP_FAMILY ?? "claude");
  startMcpStdioServer(new HrpMcpClient(family, url, dataDir, port));
}

function usage() {
  print(`hrp v4

  hrp mcp [--family claude|codex|antigravity]     servidor MCP por stdio (lo lanza cada agente)
  hrp service start|stop|status [--workspace DIR]
  hrp attend <run-id> --agent ollama [--model M] [--base-url U] [--api-key K]
  hrp hook stop|session-start --agent FAMILIA      despertador (lee el evento por stdin)
  hrp agent install <claude|codex|antigravity> | hrp agent status
  hrp attention <run-id> --session familia:N [--wait S]
  hrp state <run-id>
  hrp runs

Opciones: --url ${url} · --data-dir ${dataDir} · --json`);
}

async function main() {
  const [group, ...rest] = positionals();
  switch (group) {
    case "mcp": return mcp();
    case "service": {
      const action = rest[0];
      if (action === "start") return startService(value("--workspace"));
      if (action === "stop") return stopService();
      if (action === "status") return serviceStatus();
      throw new Error("Uso: hrp service start|stop|status");
    }
    case "hook": return hook(rest[0]);
    case "attend": return attend(rest[0]);
    case "agent": {
      if (rest[0] === "install") return agentInstall(rest[1]);
      if (rest[0] === "status") return agentStatus();
      throw new Error("Uso: hrp agent install <agente> | hrp agent status");
    }
    case "attention": {
      const session = value("--session");
      if (!rest[0] || !session) throw new Error("Uso: hrp attention <run-id> --session familia:N [--wait S]");
      return print(await attention({ runId: rest[0], session }, Number(value("--wait", 0))));
    }
    case "state": {
      if (!rest[0]) throw new Error("Uso: hrp state <run-id>");
      return print(await api(`/api/runs/${encodeURIComponent(rest[0])}`));
    }
    case "runs": return print(await api("/api/runs"));
    case undefined:
    case "help":
    case "--help":
      return usage();
    default:
      throw new Error(`Comando desconocido: ${group}`);
  }
}

main().catch((error) => {
  process.stderr.write(`hrp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
