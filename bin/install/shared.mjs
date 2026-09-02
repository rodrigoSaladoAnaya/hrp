// Utilidades compartidas por los instaladores. Lo delicado no es copiar
// archivos: es fusionar configuración ajena sin pisarla, usar rutas absolutas
// (las GUIs no heredan el PATH del shell) y dejar recibos para poder limpiar.
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
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

function quote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function shellCommand(nodePath, cliPath, extraArgs = []) {
  return [nodePath, cliPath, ...extraArgs].map(quote).join(" ");
}

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

export const installReceipt = ".hrp-install-source";

export function ownedByHrp(target) {
  const receipt = path.join(target, installReceipt);
  return existsSync(receipt) && Boolean(readFileSync(receipt, "utf8").trim());
}

export function report(agent) {
  agent = typeof agent === "string" ? agent : agent?.agent;
  const actions = [];
  const warnings = [];
  const checks = [];
  return {
    agent,
    action(message) { actions.push(message); return message; },
    warn(message) { warnings.push(message); return message; },
    check(description, passed) { checks.push({ description, passed: Boolean(passed) }); return Boolean(passed); },
    finish() {
      for (const { description, passed } of checks) if (!passed) warnings.push(`Verificación fallida: ${description}`);
      return { agent, actions, warnings, checks, verified: checks.length > 0 && checks.every((entry) => entry.passed) };
    },
  };
}

// --- Skills ---------------------------------------------------------------
// Cada agente recibe la misma skill 'hrp' más docs/protocol.md como referencia.

export function skillSpecs(root) {
  const protocol = { from: path.join(root, "docs/protocol.md"), to: "references/protocol.md" };
  return {
    claude: {
      source: path.join(root, "integrations/claude/skills/hrp"),
      target: path.join(os.homedir(), ".claude", "skills", "hrp"),
      extras: [protocol],
    },
    codex: {
      source: path.join(root, "integrations/codex/plugins/hrp/skills/hrp"),
      target: path.join(process.env.HRP_CODEX_SKILLS_DIR ?? path.join(os.homedir(), ".agents", "skills"), "hrp"),
      extras: [protocol],
    },
    antigravity: {
      source: path.join(root, "integrations/antigravity/skills/hrp"),
      target: path.join(os.homedir(), ".gemini", "config", "skills", "hrp"),
      extras: [protocol, { from: path.join(root, "integrations/antigravity/rules/hrp.md"), to: "references/hrp-rules.md" }],
    },
  };
}

function walkSkillFiles(dir, prefix = "") {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === installReceipt) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...walkSkillFiles(path.join(dir, entry.name), relative));
    else result.push(relative);
  }
  return result;
}

function digest(files) {
  const hash = createHash("sha256");
  for (const relative of [...files.keys()].sort()) hash.update(relative).update("\0").update(readFileSync(files.get(relative))).update("\0");
  return hash.digest("hex");
}

function sourceFiles(spec) {
  const files = new Map(walkSkillFiles(spec.source).map((relative) => [relative, path.join(spec.source, relative)]));
  for (const extra of spec.extras) if (existsSync(extra.from)) files.set(extra.to, extra.from);
  return files;
}

function ownership(spec) {
  if (!existsSync(spec.target)) return "absent";
  const receipt = path.join(spec.target, installReceipt);
  if (!existsSync(receipt)) return "foreign";
  return readFileSync(receipt, "utf8").split("\n")[0] === spec.source ? "owned" : "foreign";
}

export function skillState(root, name) {
  const spec = skillSpecs(root)[name];
  if (!spec) throw new Error(`No hay skill declarada para ${name}`);
  const owner = ownership(spec);
  if (owner !== "owned") return owner;
  const installed = new Map(walkSkillFiles(spec.target).map((relative) => [relative, path.join(spec.target, relative)]));
  return digest(installed) === digest(sourceFiles(spec)) ? "current" : "stale";
}

export function installSkill(root, name) {
  const spec = skillSpecs(root)[name];
  if (!spec) throw new Error(`No hay skill declarada para ${name}`);
  if (!existsSync(path.join(spec.source, "SKILL.md"))) throw new Error(`Falta la fuente de la skill de ${name}: ${spec.source}`);
  const owner = ownership(spec);
  if (owner === "foreign") throw new Error(`${spec.target} existe y no pertenece a esta instalación de HRP`);
  mkdirSync(path.dirname(spec.target), { recursive: true });
  const staging = `${spec.target}.hrp-staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(spec.source, staging, { recursive: true });
  for (const extra of spec.extras) {
    if (!existsSync(extra.from)) continue;
    mkdirSync(path.dirname(path.join(staging, extra.to)), { recursive: true });
    cpSync(extra.from, path.join(staging, extra.to));
  }
  writeFileSync(path.join(staging, installReceipt), `${spec.source}\n`);
  rmSync(spec.target, { recursive: true, force: true });
  renameSync(staging, spec.target);
  return owner === "owned" ? "actualizada" : "instalada";
}

export function isDirectory(target) {
  return Boolean(statSync(target, { throwIfNoEntry: false })?.isDirectory());
}
