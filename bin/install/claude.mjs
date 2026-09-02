// Instalador de HRP para Claude Code: skill, MCP en alcance de usuario y hooks
// Stop/SessionStart como despertador. Lo delicado es fusionar sin pisar lo
// ajeno y comprobar que el despertador responde de verdad.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeJsonFile, ownedByHrp, readJsonFile, removePaths, report, shellCommand } from "./shared.mjs";

export const agent = "claude";

const settingsFile = path.join(os.homedir(), ".claude", "settings.json");
const userConfigFile = path.join(os.homedir(), ".claude.json");
const skillsDir = path.join(os.homedir(), ".claude", "skills");

function claudeCli() {
  const candidates = [process.env.HRP_CLAUDE_CLI, path.join(os.homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  const found = spawnSync("command", ["-v", "claude"], { encoding: "utf8", shell: true });
  const resolved = found.stdout?.trim();
  return resolved && existsSync(resolved) ? resolved : undefined;
}

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}

function isHrpHook(entry, cliPath) {
  const command = String(entry?.command ?? "");
  return command.includes(cliPath) || /hrp(\.mjs)?['"]?\s+hook\s/.test(command);
}

export async function install(context) {
  const { nodePath, cliPath, dataDir, log } = context;
  const rep = report(agent);

  const state = context.installSkill("claude");
  rep.action(`Skill ${state}: ${path.join(skillsDir, "hrp")}`);
  rep.check("la skill queda al día", context.skillState("claude") === "current");

  const cli = claudeCli();
  let registered = false;
  if (cli) {
    if (run(cli, ["mcp", "get", "hrp"]).status === 0) {
      run(cli, ["mcp", "remove", "hrp", "--scope", "user"]);
      run(cli, ["mcp", "remove", "hrp", "--scope", "local"]);
    }
    const added = run(cli, ["mcp", "add", "--scope", "user", "hrp", "--", nodePath, cliPath, "mcp", "--family", "claude"]);
    if (added.status === 0) {
      rep.action(`MCP registrado con el CLI de Claude: hrp -> ${nodePath} ${cliPath} mcp --family claude`);
      registered = run(cli, ["mcp", "get", "hrp"]).status === 0;
    } else {
      rep.warn(`El CLI de Claude no pudo registrar el MCP: ${(added.stderr || added.stdout || "").trim().split("\n")[0]}`);
    }
  } else {
    rep.warn("No encontré el CLI de Claude Code; registro el MCP escribiendo la configuración de usuario.");
  }
  if (!registered) {
    const { changed, backup } = mergeJsonFile(userConfigFile, (draft) => {
      draft.mcpServers ??= {};
      draft.mcpServers.hrp = { type: "stdio", command: nodePath, args: [cliPath, "mcp", "--family", "claude"], env: {} };
    });
    rep.action(changed ? `MCP escrito en ${userConfigFile}${backup ? ` (respaldo: ${backup})` : ""}` : `MCP ya presente en ${userConfigFile}`);
    registered = Boolean(readJsonFile(userConfigFile).mcpServers?.hrp);
  }
  rep.check("el MCP hrp queda registrado para Claude Code", registered);

  const stopCommand = shellCommand(nodePath, cliPath, ["hook", "stop", "--agent", agent]);
  const sessionCommand = shellCommand(nodePath, cliPath, ["hook", "session-start", "--agent", agent]);
  const { changed: hooksChanged, backup: hooksBackup } = mergeJsonFile(settingsFile, (draft) => {
    draft.hooks ??= {};
    for (const [event, command, timeout] of [["Stop", stopCommand, 150], ["SessionStart", sessionCommand, 10]]) {
      const previous = Array.isArray(draft.hooks[event]) ? draft.hooks[event] : [];
      const foreign = previous
        .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((entry) => !isHrpHook(entry, cliPath)) }))
        .filter((group) => (group.hooks ?? []).length > 0);
      draft.hooks[event] = [...foreign, { hooks: [{ type: "command", command, timeout }] }];
    }
  });
  rep.action(hooksChanged ? `Hooks Stop y SessionStart instalados en ${settingsFile}${hooksBackup ? ` (respaldo: ${hooksBackup})` : ""}` : `Hooks Stop y SessionStart ya estaban al día en ${settingsFile}`);
  const installed = readJsonFile(settingsFile).hooks ?? {};
  rep.check("los hooks Stop y SessionStart quedan declarados", ["Stop", "SessionStart"]
    .every((event) => (installed[event] ?? []).some((group) => (group.hooks ?? []).some((entry) => isHrpHook(entry, cliPath)))));

  const legacySkills = existsSync(skillsDir)
    ? readdirSync(skillsDir).filter((entry) => entry.startsWith("hrp") && entry !== "hrp").map((entry) => path.join(skillsDir, entry))
      .filter((target) => statSync(target, { throwIfNoEntry: false })?.isDirectory() && ownedByHrp(target))
    : [];
  removePaths(legacySkills, (message) => { rep.action(message); log?.(message); });
  const hooksState = path.join(dataDir, "runtime", "hooks");
  if (existsSync(hooksState)) {
    const limit = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const entry of readdirSync(hooksState)) {
      const target = path.join(hooksState, entry);
      if ((statSync(target, { throwIfNoEntry: false })?.mtimeMs ?? Infinity) < limit) rmSync(target, { force: true });
    }
  }

  const probe = spawnSync(nodePath, [cliPath, "hook", "stop", "--agent", agent], {
    input: JSON.stringify({ cwd: context.root, session_id: "hrp-install-check", hook_event_name: "Stop", stop_hook_active: false }),
    encoding: "utf8",
    env: { ...process.env, HRP_HOOK_WAIT_MS: "0" },
  });
  const output = (probe.stdout ?? "").trim();
  let valid = probe.status === 0;
  if (valid && output) { try { JSON.parse(output); } catch { valid = false; } }
  rep.check("el hook Stop responde sin romper la sesión", valid);
  rep.warn("Claude Code lee hooks y MCP al abrir la sesión: reinicia las sesiones abiertas.");
  return rep.finish();
}

export async function status(context) {
  const settings = readJsonFile(settingsFile);
  const cli = claudeCli();
  const mcp = cli && run(cli, ["mcp", "get", "hrp"]).status === 0 ? "registrado" : (readJsonFile(userConfigFile).mcpServers?.hrp ? "registrado en ~/.claude.json" : "ausente");
  const hooks = ["Stop", "SessionStart"].filter((event) => (settings.hooks?.[event] ?? []).some((group) => (group.hooks ?? []).some((entry) => isHrpHook(entry, context.cliPath))));
  return { skill: context.skillState("claude"), mcp, hooks: hooks.length ? hooks.join(", ") : "ausentes" };
}
