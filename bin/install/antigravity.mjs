// Instalador de HRP para Antigravity. Sin hooks nativos: su despertador es la
// herramienta MCP bloqueante hrp_attention, así que lo crítico es que el MCP
// quede registrado con rutas absolutas y arranque de verdad.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeJsonFile, readJsonFile, report } from "./shared.mjs";

export const agent = "antigravity";

const geminiHome = path.join(os.homedir(), ".gemini");
const skillsDir = path.join(geminiHome, "config", "skills");
const rulesFile = path.join(geminiHome, "config", "rules", "hrp.md");
const mcpFiles = [
  path.join(geminiHome, "config", "mcp_config.json"),
  path.join(geminiHome, "antigravity", "mcp_config.json"),
];

function mcpResponds(nodePath, cliPath) {
  return new Promise((resolve) => {
    const child = spawn(nodePath, [cliPath, "mcp", "--family", agent], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    const finish = (value) => { clearTimeout(deadline); child.kill(); resolve(value); };
    const deadline = setTimeout(() => finish(false), 15_000);
    child.on("error", () => finish(false));
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const line = buffer.split("\n").find((candidate) => candidate.trim().startsWith("{"));
      if (!line) return;
      try { finish(JSON.parse(line).result?.serverInfo?.name === "hrp-mcp"); } catch { /* incompleta */ }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  });
}

export async function install(context) {
  const { nodePath, cliPath, root } = context;
  const rep = report({ agent });

  const state = context.installSkill("antigravity");
  rep.action(`Skill ${state}: ${path.join(skillsDir, "hrp")}`);
  const rulesSource = path.join(root, "integrations/antigravity/rules/hrp.md");
  if (existsSync(rulesSource)) {
    mkdirSync(path.dirname(rulesFile), { recursive: true });
    cpSync(rulesSource, rulesFile);
    rep.action(`Reglas globales copiadas: ${rulesFile}`);
  }
  rep.check("la skill queda al día", context.skillState("antigravity") === "current");
  rep.check("las reglas globales quedan instaladas", existsSync(rulesFile));

  for (const file of mcpFiles) {
    const { changed, backup } = mergeJsonFile(file, (draft) => {
      draft.mcpServers ??= {};
      draft.mcpServers.hrp = { command: nodePath, args: [cliPath, "mcp", "--family", agent] };
    });
    rep.action(changed ? `MCP registrado en ${file}${backup ? ` (respaldo: ${backup})` : ""}` : `MCP ya presente en ${file}`);
  }
  rep.check("las configuraciones de MCP declaran hrp con rutas absolutas", mcpFiles.every((file) => {
    const entry = readJsonFile(file).mcpServers?.hrp;
    return Boolean(entry) && path.isAbsolute(entry.command) && existsSync(entry.command) && existsSync(entry.args?.[0] ?? "");
  }));
  rep.check("el servidor MCP responde initialize", await mcpResponds(nodePath, cliPath));
  rep.warn("Antigravity no tiene hooks: su despertador es hrp_attention con waitMs; la skill le exige quedarse ahí en vez de terminar el turno.");
  rep.warn("Reinicia Antigravity para que recargue MCP, skills y reglas.");
  return rep.finish();
}

export async function status(context) {
  const registered = mcpFiles.filter((file) => Boolean(readJsonFile(file).mcpServers?.hrp));
  return {
    skill: context.skillState("antigravity"),
    reglas: existsSync(rulesFile) ? "instaladas" : "ausentes",
    mcp: registered.length ? `registrado en ${registered.length} de ${mcpFiles.length} configuraciones` : "ausente",
    despertador: "hrp_attention (sin hooks)",
  };
}
