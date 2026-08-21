// Instalador de la integracion de HRP para Codex. Codex combina tres piezas:
// skill standalone, plugin local cacheado y CLI propio para marketplaces; cada
// una debe verificarse porque la GUI no recarga plugins ni hooks en caliente.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonFile, removePaths, report } from "./shared.mjs";

export const agent = "codex";

const marketplaceName = "hrp-local";
const pluginName = "hrp";
const pluginSelector = `${pluginName}@${marketplaceName}`;
const chatgptCodexCli = "/Applications/ChatGPT.app/Contents/Resources/codex";

function codexHome() {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function binRoot() {
  return process.env.HRP_BIN_DIR ?? path.join(os.homedir(), ".local", "bin");
}

function pluginCacheRoot() {
  return process.env.HRP_CODEX_PLUGIN_CACHE_DIR ?? path.join(codexHome(), "plugins", "cache", marketplaceName, pluginName);
}

function paths(root) {
  const marketplaceRoot = path.join(root, "integrations", "codex");
  const pluginSource = path.join(marketplaceRoot, "plugins", pluginName);
  return {
    skillSource: path.join(pluginSource, "skills", "use-hrp"),
    marketplaceRoot,
    marketplaceManifest: path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
    pluginSource,
    pluginManifest: path.join(pluginSource, ".codex-plugin", "plugin.json"),
    mcpManifest: path.join(pluginSource, ".mcp.json"),
    hooksFile: path.join(pluginSource, "hooks.json"),
    mcpLauncher: path.join(pluginSource, "scripts", "hrp-mcp"),
    cliTarget: path.join(binRoot(), "hrp"),
  };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function runOk(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n")[0];
    throw new Error(`${command} ${args.join(" ")} falló${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function findCodexCli() {
  const candidates = [process.env.HRP_CODEX_CLI, chatgptCodexCli];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  const found = run("command", ["-v", "codex"], { shell: true });
  const resolved = found.stdout?.trim();
  return resolved && existsSync(resolved) ? resolved : undefined;
}

function parsePluginList(raw) {
  try { return JSON.parse(raw); } catch { return {}; }
}

function installedPlugin(list, selector = pluginSelector) {
  const installed = Array.isArray(list.installed) ? list.installed : [];
  return installed.find((entry) => entry.pluginId === selector
    || entry.id === selector
    || entry.name === pluginName
    || entry.pluginId === pluginName);
}

function marketplacePath(raw) {
  try {
    const parsed = JSON.parse(raw);
    const entries = parsed.marketplaces ?? parsed.installed ?? parsed;
    if (Array.isArray(entries)) {
      const found = entries.find((entry) => entry.name === marketplaceName || entry.id === marketplaceName);
      return found?.path ?? found?.root;
    }
  } catch { /* texto plano */ }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(marketplaceName)) continue;
    return trimmed.slice(marketplaceName.length).trim();
  }
  return undefined;
}

function ensureDistribution({ skillSource, marketplaceManifest, pluginManifest, mcpManifest, hooksFile, mcpLauncher }) {
  for (const file of [path.join(skillSource, "SKILL.md"), marketplaceManifest, pluginManifest, mcpManifest, hooksFile, mcpLauncher]) {
    if (!existsSync(file)) throw new Error(`La distribucion de Codex esta incompleta: falta ${file}`);
  }
}

function ensureCliLink(cliTarget, cliPath) {
  mkdirSync(path.dirname(cliTarget), { recursive: true });
  if (existsSync(cliTarget)) {
    const stat = lstatSync(cliTarget);
    if (!stat.isSymbolicLink()) throw new Error(`${cliTarget} ya existe y no es un enlace administrado por HRP`);
    const current = readlinkSync(cliTarget);
    if (!path.resolve(path.dirname(cliTarget), current).startsWith(path.dirname(path.dirname(cliPath)))) {
      throw new Error(`${cliTarget} apunta a una instalacion ajena: ${current}`);
    }
    unlinkSync(cliTarget);
  }
  symlinkSync(cliPath, cliTarget);
}

function sameTree(source, target) {
  const walk = (dir, base = dir) => {
    const result = [];
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(base, full);
      if (entry.isDirectory()) result.push(...walk(full, base));
      else result.push(relative);
    }
    return result;
  };
  if (!existsSync(source) || !existsSync(target)) return false;
  const left = walk(source);
  const right = walk(target);
  if (left.join("\0") !== right.join("\0")) return false;
  return left.every((relative) => {
    const a = path.join(source, relative);
    const b = path.join(target, relative);
    return statSync(a).size === statSync(b).size && readFileSync(a, "utf8") === readFileSync(b, "utf8");
  });
}

function pluginVersion(pluginManifest) {
  return String(readJsonFile(pluginManifest).version ?? "");
}

function mcpEnabled(cacheVersionDir) {
  return Boolean(readJsonFile(path.join(cacheVersionDir, ".mcp.json")).mcpServers?.hrp);
}

function chatgptGuiRunning() {
  if (run("command", ["-v", "osascript"], { shell: true }).status === 0) {
    const result = run("osascript", ["-e", 'application "ChatGPT" is running']);
    if (result.stdout.trim() === "true") return true;
  }
  return run("pgrep", ["-f", "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"]).status === 0;
}

export async function install(context) {
  const rep = report({ agent });
  const { root, nodePath, cliPath, log } = context;
  const resolved = paths(root);
  ensureDistribution(resolved);

  const codexCli = findCodexCli();
  if (!codexCli) throw new Error("No se encontro el CLI codex; define HRP_CODEX_CLI o instala ChatGPT/Codex");
  if (!existsSync(codexCli)) throw new Error(`El CLI codex seleccionado no existe: ${codexCli}`);
  const version = run(codexCli, ["--version"]);
  rep.action(`CLI de Codex: ${codexCli}${version.status === 0 ? ` (${version.stdout.trim()})` : ""}`);

  runOk("npm", ["run", "build"], { cwd: root });
  rep.action("Build de HRP ejecutado antes de instalar el servidor MCP");

  const skillState = context.installSkill("codex");
  rep.action(`Skill use-hrp ${skillState}: ${context.skillState("codex")}`);
  rep.check("la skill standalone queda al dia", context.skillState("codex") === "current");

  ensureCliLink(resolved.cliTarget, cliPath);
  rep.action(`CLI enlazado: ${resolved.cliTarget} -> ${cliPath}`);
  rep.check("el enlace ~/.local/bin/hrp apunta al CLI local", existsSync(resolved.cliTarget) && lstatSync(resolved.cliTarget).isSymbolicLink());

  const listed = runOk(codexCli, ["plugin", "marketplace", "list"]);
  const registered = marketplacePath(listed.stdout);
  if (registered && path.resolve(registered) !== path.resolve(resolved.marketplaceRoot)) {
    throw new Error(`El marketplace ${marketplaceName} ya apunta a otra carpeta: ${registered}`);
  }
  if (!registered) {
    runOk(codexCli, ["plugin", "marketplace", "add", resolved.marketplaceRoot, "--json"]);
    rep.action(`Marketplace registrado: ${marketplaceName} -> ${resolved.marketplaceRoot}`);
  } else {
    rep.action(`Marketplace al dia: ${marketplaceName} -> ${resolved.marketplaceRoot}`);
  }

  const beforeList = parsePluginList(runOk(codexCli, ["plugin", "list", "--json"]).stdout);
  if (installedPlugin(beforeList)) {
    runOk(codexCli, ["plugin", "remove", pluginSelector, "--json"]);
    rep.action(`Plugin anterior eliminado: ${pluginSelector}`);
  }

  const cacheRoot = pluginCacheRoot();
  const materializedSkill = path.join(cacheRoot, pluginVersion(resolved.pluginManifest), "skills", "use-hrp");
  const removed = removePaths([cacheRoot, materializedSkill], (message) => { rep.action(message); log?.(message); });
  if (!removed.length) rep.action(`Cache Codex HRP ya estaba limpio: ${cacheRoot}`);

  runOk(codexCli, ["plugin", "add", pluginSelector, "--json"]);
  const afterList = parsePluginList(runOk(codexCli, ["plugin", "list", "--json"]).stdout);
  const installed = installedPlugin(afterList);
  const expectedVersion = pluginVersion(resolved.pluginManifest);
  const installedVersion = String(installed?.version ?? "");
  const cacheVersionDir = path.join(cacheRoot, expectedVersion);
  const cacheSkillDir = path.join(cacheVersionDir, "skills", "use-hrp");

  rep.action(`Plugin instalado: ${pluginSelector} ${installedVersion || "(sin version reportada)"}`);
  rep.check("Codex reporta el plugin instalado", Boolean(installed));
  rep.check("la version instalada coincide con el manifiesto", installedVersion === expectedVersion);
  rep.check("la skill cacheada coincide con la fuente", sameTree(resolved.skillSource, cacheSkillDir));
  rep.check("hooks.json quedo materializado en el cache", existsSync(path.join(cacheVersionDir, "hooks.json")));
  rep.check("el MCP hrp queda declarado por el plugin cacheado", mcpEnabled(cacheVersionDir));

  const legacyWorkspaceSkill = path.join(root, ".agents", "skills", "hrp", "SKILL.md");
  if (existsSync(legacyWorkspaceSkill) && /HRP v[12]|Protocol [12]|v[12]\./.test(readFileSync(legacyWorkspaceSkill, "utf8"))) {
    rep.warn(`Existe una skill local HRP desactualizada en ${legacyWorkspaceSkill}; usa $hrp:use-hrp o actualizala.`);
  }
  rep.warn("Los hooks nuevos de Codex pueden requerir confirmacion de confianza una vez en la GUI.");
  rep.warn(chatgptGuiRunning()
    ? "ChatGPT/Codex esta abierto: cierralo con Cmd+Q y vuelve a abrirlo para recargar plugins, hooks y skills."
    : "Si ChatGPT/Codex estaba abierto, cierralo con Cmd+Q y vuelve a abrirlo para recargar plugins, hooks y skills.");

  return rep.finish();
}

export async function status(context) {
  const resolved = paths(context.root);
  const codexCli = findCodexCli();
  const expectedVersion = pluginVersion(resolved.pluginManifest);
  let installed = false;
  let installedVersion = "";
  if (codexCli) {
    try {
      const entry = installedPlugin(parsePluginList(runOk(codexCli, ["plugin", "list", "--json"]).stdout));
      installed = Boolean(entry);
      installedVersion = String(entry?.version ?? "");
    } catch { /* Codex no disponible o no responde */ }
  }
  const cacheVersionDir = path.join(pluginCacheRoot(), expectedVersion);
  return {
    skill: context.skillState("codex"),
    codexCli: codexCli ?? "ausente",
    plugin: installed ? `${pluginSelector} ${installedVersion}` : "ausente",
    cache: existsSync(cacheVersionDir) ? cacheVersionDir : "ausente",
    hooks: existsSync(path.join(cacheVersionDir, "hooks.json")) ? "materializados" : "ausentes",
    mcp: mcpEnabled(cacheVersionDir) ? "hrp declarado" : "ausente",
  };
}
