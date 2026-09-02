// Instalador de la integración de HRP para Antigravity. Es el único de los tres
// sin hooks nativos: su despertador es la herramienta MCP bloqueante
// hrp_attention, así que aquí lo crítico es que el MCP quede realmente
// registrado y arrancable. Antigravity lo lanza desde la GUI, que no hereda el
// PATH del shell, de modo que todo se escribe con rutas absolutas.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeJsonFile, ownedByHrp, readJsonFile, removePaths, report } from "./shared.mjs";

export const agent = "antigravity";

const geminiHome = path.join(os.homedir(), ".gemini");
const skillsDir = path.join(geminiHome, "config", "skills");
const rulesFile = path.join(geminiHome, "config", "rules", "hrp.md");
// Antigravity lee su configuración de MCP desde su carpeta de aplicación y
// desde la de configuración según la versión; escribir ambas evita depender de
// cuál esté vigente y las mantiene idénticas.
const mcpFiles = [
  path.join(geminiHome, "config", "mcp_config.json"),
  path.join(geminiHome, "antigravity", "mcp_config.json"),
];

// Arranca el servidor MCP y comprueba que responde initialize: verificar que el
// JSON quedó escrito no prueba que el servidor exista ni que node lo encuentre.
function mcpResponde(nodePath, cliPath) {
  return new Promise((resolve) => {
    const child = spawn(nodePath, [cliPath, "mcp"], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    const terminar = (valor) => { clearTimeout(plazo); child.kill(); resolve(valor); };
    const plazo = setTimeout(() => terminar(false), 15_000);
    child.on("error", () => terminar(false));
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const linea = buffer.split("\n").find((candidate) => candidate.trim().startsWith("{"));
      if (!linea) return;
      try { terminar(JSON.parse(linea).result?.serverInfo?.name === "hrp-mcp"); } catch { /* respuesta incompleta */ }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  });
}

export async function install(context) {
  const { nodePath, cliPath, log } = context;
  const rep = report({ agent });

  // 1. Skill y reglas globales
  const state = context.installSkill("antigravity");
  rep.action(`Skill ${state}: ${path.join(skillsDir, "hrp")}`);
  rep.action(`Reglas globales copiadas: ${rulesFile}`);
  rep.check("la skill queda al día", context.skillState("antigravity") === "current");
  rep.check("las reglas globales quedan instaladas", existsSync(rulesFile));

  // 2. MCP con rutas absolutas en las dos configuraciones que puede leer
  for (const file of mcpFiles) {
    const { changed, backup } = mergeJsonFile(file, (draft) => {
      draft.mcpServers ??= {};
      draft.mcpServers.hrp = { command: nodePath, args: [cliPath, "mcp"] };
    });
    rep.action(changed ? `MCP registrado en ${file}${backup ? ` (respaldo: ${backup})` : ""}` : `MCP ya presente en ${file}`);
  }
  rep.check("las dos configuraciones de MCP declaran hrp con rutas absolutas", mcpFiles.every((file) => {
    const entry = readJsonFile(file).mcpServers?.hrp;
    return Boolean(entry) && path.isAbsolute(entry.command) && existsSync(entry.command) && existsSync(entry.args?.[0] ?? "");
  }));

  // 3. Limpieza de restos de instalaciones anteriores
  const obsoletas = existsSync(skillsDir)
    ? readdirSync(skillsDir)
      .filter((entry) => entry.startsWith("hrp") && entry !== "hrp")
      .map((entry) => path.join(skillsDir, entry))
      .filter((target) => statSync(target, { throwIfNoEntry: false })?.isDirectory() && ownedByHrp(target))
    : [];
  const limpiadas = removePaths(obsoletas, (message) => { rep.action(message); log?.(message); });
  rep.action(`Limpieza: ${limpiadas.length} skills obsoletas de HRP`);

  // 4. El servidor MCP arranca de verdad
  rep.check("el servidor MCP responde initialize", await mcpResponde(nodePath, cliPath));

  rep.warn("Antigravity no tiene hooks nativos: su despertador es la herramienta MCP bloqueante hrp_attention, y la skill le exige estacionarse ahí en vez de terminar el turno.");
  rep.warn("Reinicia Antigravity para que recargue MCP, skills y reglas; las ventanas abiertas no las recargan.");
  return rep.finish();
}

export async function status(context) {
  const registrados = mcpFiles.filter((file) => Boolean(readJsonFile(file).mcpServers?.hrp));
  return {
    skill: context.skillState("antigravity"),
    reglas: existsSync(rulesFile) ? "instaladas" : "ausentes",
    mcp: registrados.length ? `registrado en ${registrados.length} de ${mcpFiles.length} configuraciones` : "ausente",
    despertador: "herramienta MCP hrp_attention (sin hooks nativos)",
  };
}
