#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CLI_VERSION = "0.4.0";
const DEFAULT_URL = "http://127.0.0.1:4317";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BOOLEAN_OPTIONS = new Set(["--all", "--help", "--json", "--skip-build", "--start", "--version"]);

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArguments(argv) {
  const separator = argv.indexOf("--");
  const regular = separator === -1 ? argv : argv.slice(0, separator);
  const passthrough = separator === -1 ? [] : argv.slice(separator + 1);
  const options = new Map();
  const positional = [];

  for (let index = 0; index < regular.length; index += 1) {
    const token = regular[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals !== -1) {
      options.set(token.slice(0, equals), token.slice(equals + 1));
      continue;
    }
    if (BOOLEAN_OPTIONS.has(token)) {
      options.set(token, true);
      continue;
    }
    const value = regular[index + 1];
    if (value === undefined || value.startsWith("--")) throw new CliError(`${token} requiere un valor.`);
    options.set(token, value);
    index += 1;
  }
  return { options, passthrough, positional };
}

function option(parsed, name, fallback) {
  return parsed.options.has(name) ? parsed.options.get(name) : fallback;
}

function requiredOption(parsed, name) {
  const value = option(parsed, name);
  if (typeof value !== "string" || !value.trim()) throw new CliError(`Falta ${name}.`);
  return value;
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new CliError(`${name} debe ser un número positivo.`);
  return number;
}

function integer(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new CliError(`${name} debe ser un entero.`);
  return number;
}

function csv(value, name = "--files") {
  if (typeof value !== "string") throw new CliError(`Falta ${name}.`);
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!values.length) throw new CliError(`${name} no puede estar vacío.`);
  return values;
}

function optionalCsv(parsed, name) {
  const value = option(parsed, name);
  return typeof value === "string" ? csv(value, name) : undefined;
}

function normalizedUrl(parsed) {
  let value = String(option(parsed, "--url", process.env.HRP_URL ?? DEFAULT_URL));
  const port = option(parsed, "--port");
  if (!parsed.options.has("--url") && !process.env.HRP_URL && typeof port === "string") {
    const url = new URL(value);
    url.port = port;
    value = url.href;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return url.href.replace(/\/$/, "");
  } catch {
    throw new CliError(`URL de HRP inválida: ${value}`);
  }
}

async function api(parsed, pathname, init = {}, workspaceRoot = process.cwd()) {
  const url = `${normalizedUrl(parsed)}${pathname}`;
  let response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        "x-hrp-workspace-root": path.resolve(workspaceRoot),
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new CliError(`No se pudo conectar con HRP en ${normalizedUrl(parsed)}: ${error.message}`);
  }

  const raw = await response.text();
  let body;
  if (raw) {
    try { body = JSON.parse(raw); } catch { body = raw; }
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? body.error : raw || response.statusText;
    throw new CliError(`HRP respondió ${response.status}: ${message}`);
  }
  return body;
}

function output(parsed, value, render) {
  if (parsed.options.has("--json")) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const text = render ? render(value) : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  process.stdout.write(`${text}\n`);
}

async function readJson(filename) {
  const raw = filename === "-" ? await readStdin() : await readFile(path.resolve(filename), "utf8");
  try { return JSON.parse(raw); } catch (error) { throw new CliError(`JSON inválido en ${filename}: ${error.message}`); }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function runServiceScript(name, parsed, workspace) {
  const script = path.join(REPO_ROOT, "scripts", `${name}.sh`);
  if (!existsSync(script)) throw new CliError(`No se encontró ${script}. Instala el CLI desde una copia completa de HRP.`);
  const args = [];
  if (workspace) args.push("--workspace", path.resolve(workspace));
  const dataDir = option(parsed, "--data-dir");
  if (typeof dataDir === "string") args.push("--data-dir", dataDir);
  const explicitPort = option(parsed, "--port");
  const urlPort = new URL(normalizedUrl(parsed)).port;
  if (typeof explicitPort === "string") args.push("--port", explicitPort);
  else if (parsed.options.has("--url") && urlPort) args.push("--port", urlPort);
  if (parsed.options.has("--skip-build") && name !== "stop" && name !== "status") args.push("--skip-build");
  const result = spawnSync(script, args, { cwd: workspace ? path.resolve(workspace) : process.cwd(), stdio: "inherit" });
  if (result.error) throw new CliError(result.error.message);
  if (result.status !== 0) throw new CliError(`${path.basename(script)} terminó con código ${result.status}.`, result.status ?? 1);
}

async function attach(parsed) {
  const requestedWorkspace = path.resolve(parsed.positional[1] ?? process.cwd());
  let protocol;
  try {
    protocol = await api(parsed, "/api/protocol", {}, requestedWorkspace);
  } catch (error) {
    if (!parsed.options.has("--start")) throw error;
    runServiceScript("start", parsed, requestedWorkspace);
    protocol = await api(parsed, "/api/protocol", {}, requestedWorkspace);
  }
  const registration = await api(parsed, "/api/projects", {
    method: "POST",
    body: JSON.stringify({ workspaceRoot: requestedWorkspace }),
  }, requestedWorkspace);
  const [config, state] = await Promise.all([
    api(parsed, "/api/config", {}, requestedWorkspace),
    api(parsed, "/api/state", {}, requestedWorkspace),
  ]);
  const observedWorkspace = path.resolve(config.workspaceRoot);
  const projectId = registration.project.id;
  const result = {
    connected: true,
    url: normalizedUrl(parsed),
    projectId,
    workspaceRoot: observedWorkspace,
    sessionId: state.sessionId,
    protocolVersion: protocol.version,
    panelUrl: `${normalizedUrl(parsed)}/?project=${encodeURIComponent(projectId)}`,
  };
  output(parsed, result, (value) => [
    `Conectado a HRP ${value.protocolVersion}.`,
    `Panel: ${value.panelUrl}`,
    `Workspace: ${value.workspaceRoot}`,
    `Sesión: ${value.sessionId}`,
  ].join("\n"));
}

function renderState(state) {
  const plan = state.plans.find((candidate) => candidate.id === state.activePlanId);
  const nodes = plan?.nodes.map((node) => `  ${node.id}: ${node.status} [${node.reviewMode}]`).join("\n") ?? "  Sin plan activo";
  return [
    `Sesión: ${state.sessionId}`,
    `Pausa global: ${state.paused ? "sí" : "no"}`,
    `Plan: ${plan ? `${plan.title} (v${plan.version})` : "ninguno"}`,
    `Revisión pendiente: ${state.pendingReview?.id ?? "ninguna"}`,
    "Nodos:",
    nodes,
    `Comandos pendientes: ${state.commands.filter((command) => command.status === "pending").length}`,
  ].join("\n");
}

async function publishPlan(parsed, replan = false) {
  const filename = parsed.positional[2];
  if (!filename) throw new CliError(`Uso: hrp ${replan ? "replan" : "plan"} publish <archivo.json|->`);
  const result = await api(parsed, replan ? "/api/protocol/replans" : "/api/protocol/plans", {
    method: "POST",
    body: JSON.stringify(await readJson(filename)),
  });
  output(parsed, result, (value) => [
    `${replan ? "Replan" : "Plan"} publicado: ${value.plan?.title ?? value.proposal?.proposedPlan?.title}`,
    `Revisión: ${value.review.id}`,
    "Abre el panel y espera una decisión humana.",
  ].join("\n"));
}

async function requestReview(parsed) {
  const nodeId = parsed.positional[2];
  if (!nodeId) throw new CliError("Uso: hrp review request <node-id> --summary <texto>");
  const result = await api(parsed, "/api/protocol/reviews", {
    method: "POST",
    body: JSON.stringify({ kind: "node", nodeId, summary: requiredOption(parsed, "--summary") }),
  });
  output(parsed, result, (value) => `Revisión solicitada: ${value.id} (${value.nodeId})`);
}

function reviewExitCode(decision) {
  return { approved: 0, rejected: 10, redirected: 11, paused: 12 }[decision] ?? 1;
}

async function waitFor(parsed, subject) {
  const timeoutSeconds = positiveNumber(option(parsed, "--timeout", "50"), "--timeout");
  const intervalMs = positiveNumber(option(parsed, "--interval", "1000"), "--interval");
  const deadline = Date.now() + timeoutSeconds * 1_000;
  const reviewId = option(parsed, "--id");

  while (Date.now() <= deadline) {
    if (subject === "review") {
      const state = await api(parsed, "/api/state");
      const review = typeof reviewId === "string"
        ? state.reviews.find((candidate) => candidate.id === reviewId)
        : state.pendingReview ?? state.reviews.at(-1);
      if (!review) throw new CliError("No hay una revisión que esperar.");
      if (review.status !== "pending") {
        output(parsed, review, (value) => [
          `Revisión ${value.status}: ${value.id}`,
          value.direction ? `Dirección humana: ${value.direction}` : undefined,
        ].filter(Boolean).join("\n"));
        process.exitCode = reviewExitCode(review.status);
        return;
      }
    } else if (subject === "commands") {
      const result = await api(parsed, "/api/protocol/commands");
      if (result.commands.length) {
        output(parsed, result, renderCommands);
        return;
      }
    } else {
      throw new CliError("Uso: hrp wait <review|commands> [--timeout 50]");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new CliError(`Tiempo de espera agotado después de ${timeoutSeconds}s. Vuelve a ejecutar el comando para continuar esperando.`, 4);
}

async function startNode(parsed) {
  const nodeId = parsed.positional[2];
  if (!nodeId) throw new CliError("Uso: hrp node start <node-id> --intent <texto> --files a,b");
  await api(parsed, `/api/protocol/nodes/${encodeURIComponent(nodeId)}/start`, {
    method: "POST",
    body: JSON.stringify({ intent: requiredOption(parsed, "--intent"), affectedFiles: csv(option(parsed, "--files")) }),
  });
  output(parsed, { nodeId, started: true }, () => `Nodo iniciado: ${nodeId}`);
}

function git(args, allowFailure = false) {
  try {
    return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    if (allowFailure && (error.status === 1 || error.status === 0)) return `${error.stdout ?? ""}`;
    throw new CliError(`No se pudo obtener evidencia Git: ${error.message}`);
  }
}

function gitFiles(explicitFiles) {
  if (explicitFiles) return csv(explicitFiles);
  const tracked = git(["diff", "--name-only", "HEAD", "--"]).split("\n").filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])];
  if (!files.length) throw new CliError("Git no detectó archivos modificados. Usa --files y --diff-file para publicar evidencia explícita.");
  return files;
}

function gitDiff(files) {
  let diff = git(["diff", "--no-ext-diff", "--no-color", "HEAD", "--", ...files]);
  const untracked = new Set(git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean));
  for (const file of files.filter((candidate) => untracked.has(candidate))) {
    diff += git(["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", file], true);
  }
  if (!diff.trim()) throw new CliError("El diff está vacío. Usa --diff-file para publicar evidencia explícita.");
  return diff;
}

async function publishPatch(parsed) {
  const nodeId = parsed.positional[2];
  if (!nodeId) throw new CliError("Uso: hrp patch publish <node-id> --summary <texto> [--files a,b] [--diff-file archivo]");
  const files = gitFiles(option(parsed, "--files"));
  const diffFile = option(parsed, "--diff-file");
  const diff = typeof diffFile === "string"
    ? diffFile === "-" ? await readStdin() : await readFile(path.resolve(diffFile), "utf8")
    : gitDiff(files);
  const state = await api(parsed, "/api/state");
  const plan = state.plans.find((candidate) => candidate.id === state.activePlanId);
  const node = plan?.nodes.find((candidate) => candidate.id === nodeId);
  const declaredChanges = node?.changes ?? [];
  let changeId = option(parsed, "--change");
  if (declaredChanges.length && typeof changeId !== "string") {
    if (declaredChanges.length === 1) changeId = declaredChanges[0].id;
    else throw new CliError(`El nodo ${nodeId} declara ${declaredChanges.length} cambios. Usa --change <id>.`);
  }
  const body = {
    changeId: typeof changeId === "string" ? changeId : undefined,
    operationIds: optionalCsv(parsed, "--operations"),
    summary: requiredOption(parsed, "--summary"),
    files,
    diff,
    actor: String(option(parsed, "--actor", "hrp-cli")),
  };
  const result = await api(parsed, `/api/protocol/nodes/${encodeURIComponent(nodeId)}/patches`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  output(parsed, result, (value) => `Patch publicado: ${value.evidence?.patchId ?? value.id} (${files.length} archivo${files.length === 1 ? "" : "s"}${body.changeId ? ` · ${body.changeId}` : ""})`);
}

async function verificationCoverage(parsed, nodeId) {
  const explicit = {
    coversChangeIds: optionalCsv(parsed, "--changes"),
    coversOperationIds: optionalCsv(parsed, "--operations"),
    coversPatchIds: optionalCsv(parsed, "--patches"),
  };
  if (explicit.coversChangeIds || explicit.coversOperationIds || explicit.coversPatchIds) return explicit;
  const state = await api(parsed, "/api/state");
  const plan = state.plans.find((candidate) => candidate.id === state.activePlanId);
  const node = plan?.nodes.find((candidate) => candidate.id === nodeId);
  return {
    coversChangeIds: (node?.changes ?? []).map((change) => change.id),
    coversOperationIds: (node?.changes ?? []).flatMap((change) => change.operations.map((operation) => operation.id)),
    coversPatchIds: (state.patchesByNode?.[nodeId] ?? []).map((patch) => patch.patchId),
  };
}

async function publishVerification(parsed) {
  const nodeId = parsed.positional[2];
  if (!nodeId) throw new CliError("Uso: hrp verify publish <node-id> --command-id <id> --command <texto> --exit-code <n> [--output-file archivo|-]");
  const outputFile = option(parsed, "--output-file");
  const commandOutput = typeof outputFile === "string"
    ? outputFile === "-" ? await readStdin() : await readFile(path.resolve(outputFile), "utf8")
    : "";
  const body = {
    commandId: requiredOption(parsed, "--command-id"),
    command: requiredOption(parsed, "--command"),
    output: commandOutput,
    exitCode: integer(requiredOption(parsed, "--exit-code"), "--exit-code"),
    ...await verificationCoverage(parsed, nodeId),
  };
  const result = await api(parsed, `/api/protocol/nodes/${encodeURIComponent(nodeId)}/verifications`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  output(parsed, result, (value) => `Verificación ${value.passed ? "correcta" : "fallida"}: ${value.commandId}`);
  if (!result.passed) process.exitCode = result.exitCode || 1;
}

async function runVerification(parsed) {
  const nodeId = parsed.positional[2];
  if (!nodeId || !parsed.passthrough.length) {
    throw new CliError("Uso: hrp verify run <node-id> [--command-id <id>] -- <comando> [args...]");
  }
  const [command, ...args] = parsed.passthrough;
  const commandText = [command, ...args].join(" ");
  const commandId = String(option(parsed, "--command-id", `verify-${Date.now()}`));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env });
    const chunks = [];
    child.stdout.on("data", (chunk) => { process.stdout.write(chunk); chunks.push(chunk); });
    child.stderr.on("data", (chunk) => { process.stderr.write(chunk); chunks.push(chunk); });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({
      commandId,
      command: commandText,
      output: Buffer.concat(chunks).toString("utf8").slice(-1_000_000),
      exitCode: exitCode ?? (signal ? 128 : 1),
    }));
  });
  const observed = await api(parsed, `/api/protocol/nodes/${encodeURIComponent(nodeId)}/verifications`, {
    method: "POST",
    body: JSON.stringify({ ...result, ...await verificationCoverage(parsed, nodeId) }),
  });
  if (parsed.options.has("--json")) process.stdout.write(`${JSON.stringify(observed, null, 2)}\n`);
  else process.stdout.write(`\nEvidencia publicada: ${observed.passed ? "correcta" : "fallida"} (${commandId})\n`);
  if (!observed.passed) process.exitCode = observed.exitCode || 1;
}

async function completeNode(parsed) {
  const nodeId = parsed.positional[2];
  if (!nodeId) throw new CliError("Uso: hrp node complete <node-id> --summary <texto>");
  await api(parsed, `/api/protocol/nodes/${encodeURIComponent(nodeId)}/complete`, {
    method: "POST",
    body: JSON.stringify({ summary: requiredOption(parsed, "--summary") }),
  });
  output(parsed, { nodeId, completed: true }, () => `Nodo completado: ${nodeId}`);
}

function renderCommands(result) {
  if (!result.commands.length) return "No hay comandos humanos pendientes.";
  return result.commands.map((command) => [
    `${command.id}  ${command.type}  ${command.status}`,
    `  objetivo: ${JSON.stringify(command.target ?? {})}`,
    `  payload: ${JSON.stringify(command.payload)}`,
  ].join("\n")).join("\n");
}

async function listCommands(parsed) {
  const result = await api(parsed, `/api/protocol/commands${parsed.options.has("--all") ? "?pending=false" : ""}`);
  output(parsed, result, renderCommands);
}

async function acknowledgeCommand(parsed) {
  const commandId = parsed.positional[2];
  if (!commandId) throw new CliError("Uso: hrp commands ack <command-id>");
  await api(parsed, `/api/protocol/commands/${encodeURIComponent(commandId)}/ack`, { method: "POST" });
  output(parsed, { commandId, acknowledged: true }, () => `Comando confirmado: ${commandId}`);
}

function help() {
  return `Human Review Protocol CLI v${CLI_VERSION}

Uso:
  hrp attach [workspace] [--start] [--url URL] [--data-dir PATH] [--port N]
  hrp service <start|status|stop> [workspace]
  hrp state [--json]
  hrp plan publish <plan.json|->
  hrp replan publish <replan.json|->
  hrp review request <node-id> --summary TEXTO
  hrp wait <review|commands> [--id ID] [--timeout 50]
  hrp node start <node-id> --intent TEXTO --files a,b
  hrp patch publish <node-id> --change ID --summary TEXTO [--operations a,b] [--files a,b] [--diff-file PATH|-]
  hrp verify publish <node-id> --command-id ID --command TEXTO --exit-code N [--changes a,b] [--operations a,b] [--patches a,b] [--output-file PATH|-]
  hrp verify run <node-id> [--command-id ID] [--changes a,b] [--operations a,b] [--patches a,b] -- <comando> [args...]
  hrp node complete <node-id> --summary TEXTO
  hrp commands list [--all]
  hrp commands ack <command-id>

Opciones globales:
  --url URL       Default: HRP_URL o ${DEFAULT_URL}
  --json          Salida estructurada para adaptadores
  --help          Mostrar esta ayuda

El servicio permanece neutral: verify run ejecuta el comando en el proceso adaptador
y sólo publica el resultado en HRP.`;
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const [resource, action] = parsed.positional;
  if (parsed.options.has("--version")) return output(parsed, { version: CLI_VERSION }, () => CLI_VERSION);
  if (!resource || resource === "help" || parsed.options.has("--help")) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  if (resource === "version") return output(parsed, { version: CLI_VERSION }, () => CLI_VERSION);
  if (resource === "attach") return attach(parsed);
  if (resource === "state") return output(parsed, await api(parsed, "/api/state"), renderState);
  if (resource === "service" && ["start", "status", "stop"].includes(action)) {
    return runServiceScript(action, parsed, parsed.positional[2]);
  }
  if (resource === "plan" && action === "publish") return publishPlan(parsed, false);
  if (resource === "replan" && action === "publish") return publishPlan(parsed, true);
  if (resource === "review" && action === "request") return requestReview(parsed);
  if (resource === "wait") return waitFor(parsed, action);
  if (resource === "node" && action === "start") return startNode(parsed);
  if (resource === "node" && action === "complete") return completeNode(parsed);
  if (resource === "patch" && action === "publish") return publishPatch(parsed);
  if (resource === "verify" && action === "publish") return publishVerification(parsed);
  if (resource === "verify" && action === "run") return runVerification(parsed);
  if (resource === "commands" && action === "list") return listCommands(parsed);
  if (resource === "commands" && action === "ack") return acknowledgeCommand(parsed);
  throw new CliError(`Comando desconocido: ${parsed.positional.join(" ")}\n\n${help()}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = error instanceof CliError ? error.exitCode : 1;
});
