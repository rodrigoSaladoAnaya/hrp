// Utilidades compartidas por los instaladores de cada modelo. Lo delicado de
// instalar un agente no es copiar archivos: es fusionar configuración ajena sin
// pisarla, resolver rutas absolutas (las GUIs no heredan el PATH del shell) y
// limpiar los restos de instalaciones anteriores. Eso vive aquí una sola vez.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export function readJsonFile(file) {
  try {
    const raw = readFileSync(file, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`${file} no es JSON válido: ${error.message}`);
  }
}

// Aplica un cambio sobre un JSON ajeno conservando todo lo demás. Solo escribe
// si el contenido cambia, y deja copia del anterior para poder revertir a mano.
export function mergeJsonFile(file, mutate, { backupSuffix = ".hrp-backup" } = {}) {
  const before = readJsonFile(file);
  const previous = JSON.stringify(before, null, 2);
  const draft = JSON.parse(previous || "{}");
  mutate(draft);
  const next = JSON.stringify(draft, null, 2);
  if (next === previous && existsSync(file)) return { changed: false, backup: undefined };
  mkdirSync(path.dirname(file), { recursive: true });
  let backup;
  if (existsSync(file)) {
    backup = `${file}${backupSuffix}`;
    copyFileSync(file, backup);
  }
  writeFileSync(file, `${next}\n`);
  return { changed: true, backup };
}

// Invocación absoluta del CLI: los hooks y los servidores MCP los lanza la GUI
// del agente, que no tiene el PATH del shell del usuario.
export function launcher({ nodePath, cliPath, args = [] }) {
  return { command: nodePath, args: [cliPath, ...args] };
}

function quote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function shellCommand(nodePath, cliPath, extraArgs = []) {
  return [nodePath, cliPath, ...extraArgs].map(quote).join(" ");
}

// Borra restos conocidos (caches, copias viejas). Devuelve lo que borró para
// que el instalador lo reporte: una limpieza silenciosa no es verificable.
export function removePaths(paths, log) {
  const removed = [];
  for (const target of paths) {
    if (!target || !existsSync(target)) continue;
    rmSync(target, { recursive: true, force: true });
    removed.push(target);
    log?.(`Limpiado: ${target}`);
  }
  return removed;
}

// El recibo que deja el instalador de skills de HRP: sirve para distinguir lo
// que administramos de lo que pertenece al usuario o a otra herramienta.
export const installReceipt = ".hrp-install-source";

export function ownedByHrp(target) {
  const receipt = path.join(target, installReceipt);
  return existsSync(receipt) && Boolean(readFileSync(receipt, "utf8").trim());
}

export function isDirectory(target) {
  return Boolean(statSync(target, { throwIfNoEntry: false })?.isDirectory());
}

// Acumulador del reporte que 'hrp agent install' imprime y evalúa. Acepta el
// nombre del agente o el objeto { agent } de la spec aprobada, y se exporta con
// ambos nombres porque los tres instaladores se escriben contra esa spec.
export function report(agent) {
  agent = typeof agent === "string" ? agent : agent?.agent;
  if (!agent) throw new Error("report()/reporte() necesita el nombre del agente");
  const actions = [];
  const warnings = [];
  const checks = [];
  return {
    agent,
    action(message) { actions.push(message); return message; },
    warn(message) { warnings.push(message); return message; },
    check(description, passed) { checks.push({ description, passed: Boolean(passed) }); return Boolean(passed); },
    finish() {
      for (const { description, passed } of checks) {
        if (!passed) warnings.push(`Verificación fallida: ${description}`);
      }
      return {
        agent,
        actions,
        warnings,
        checks,
        verified: checks.length > 0 && checks.every((entry) => entry.passed),
      };
    },
  };
}

export const reporte = report;
