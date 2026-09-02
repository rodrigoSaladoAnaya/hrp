#!/usr/bin/env bash
# Retira de la máquina lo que HRP v3 instalaba fuera del repositorio: CLI
# global, enlaces, skills, servidores MCP, hooks, plugin de Codex y datos
# locales. v3 vive congelada en deprecated/v3, así que estas instalaciones
# apuntan a rutas que ya no existen en la raíz.
#
# Por defecto sólo informa. Borra con --apply. Los datos de ejecución (~/.hrp)
# son lo único irrecuperable, así que van detrás de --data.
set -uo pipefail

APPLY=0
DATA=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --data) DATA=1 ;;
    -h|--help)
      echo "uso: $0 [--apply] [--data]"
      echo "  sin flags   informa lo que encontró, no toca nada"
      echo "  --apply     retira CLI, enlaces, skills, MCP, hooks y plugin"
      echo "  --data      además borra ~/.hrp (historial de ejecuciones)"
      exit 0 ;;
    *) echo "argumento desconocido: $arg" >&2; exit 2 ;;
  esac
done

MODO="revisión"
[ "$APPLY" -eq 1 ] && MODO="aplicando"
echo "Desinstalación de HRP v3 ($MODO)"
echo

FALTA=0
paso() { echo "== $1"; }
hallado() { echo "   encontrado: $1"; FALTA=$((FALTA+1)); }
retirado() { echo "   retirado:   $1"; }
limpio()  { echo "   limpio:     $1"; }

# Edición de JSON ajeno: conserva todo lo que no es de HRP y deja respaldo.
HELPER="$(mktemp -t hrp-uninstall-XXXXXX).mjs"
trap 'rm -f "$HELPER"' EXIT
cat > "$HELPER" <<'JS'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [mode, file, apply] = process.argv.slice(2);
if (!existsSync(file)) { console.log("ausente"); process.exit(0); }
let data;
try { data = JSON.parse(readFileSync(file, "utf8").trim() || "{}"); }
catch { console.log("ilegible"); process.exit(0); }
// Mismo criterio de pertenencia que usaba el instalador: un hook es de HRP si
// invoca 'hrp hook' o el CLI hrp.mjs. Nunca se toca un hook ajeno.
const esHrp = (entry) => {
  const command = String(entry?.command ?? "");
  return /hrp(\.mjs)?['"]?\s+hook\s/.test(command) || command.includes("hrp.mjs");
};
let found = false;
if (mode === "mcp") {
  if (data.mcpServers?.hrp) { found = true; if (apply === "apply") delete data.mcpServers.hrp; }
} else {
  for (const event of ["Stop", "SessionStart"]) {
    const groups = data.hooks?.[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((entry) => !esHrp(entry)) }))
      .filter((group) => (group.hooks ?? []).length > 0);
    if (JSON.stringify(kept) === JSON.stringify(groups)) continue;
    found = true;
    if (apply !== "apply") continue;
    if (kept.length) data.hooks[event] = kept; else delete data.hooks[event];
  }
}
if (!found) { console.log("limpio"); process.exit(0); }
if (apply !== "apply") { console.log("presente"); process.exit(0); }
copyFileSync(file, `${file}.hrp-uninstall-backup`);
writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
console.log("eliminado");
JS

json() {
  local resultado
  resultado="$(node "$HELPER" "$1" "$2" "$([ "$APPLY" -eq 1 ] && echo apply || echo check)")"
  case "$resultado" in
    presente)  hallado "$3" ;;
    eliminado) retirado "$3 (respaldo: $2.hrp-uninstall-backup)" ;;
    ilegible)  echo "   ojo:        $2 no es JSON válido, revísalo a mano" ;;
    *)         limpio "$3" ;;
  esac
}

borrar() {
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then limpio "$2"; return; fi
  if [ "$APPLY" -eq 1 ]; then rm -rf "$1"; retirado "$2"; else hallado "$2"; fi
}

# 1. Servicio en marcha
paso "Servicio local"
PIDS="$(lsof -ti tcp:4317 2>/dev/null)"
if [ -n "$PIDS" ]; then
  if [ "$APPLY" -eq 1 ]; then
    echo "$PIDS" | xargs kill 2>/dev/null
    retirado "servicio escuchando en 127.0.0.1:4317 (pid $(echo "$PIDS" | tr '\n' ' '))"
  else
    hallado "servicio escuchando en 127.0.0.1:4317 (pid $(echo "$PIDS" | tr '\n' ' '))"
  fi
else
  limpio "nada escucha en 127.0.0.1:4317"
fi
echo

# 2. CLI global y enlaces
paso "CLI"
if npm ls -g --depth 0 human-review-protocol >/dev/null 2>&1; then
  if [ "$APPLY" -eq 1 ]; then
    npm rm -g human-review-protocol >/dev/null 2>&1 && retirado "paquete global human-review-protocol" \
      || echo "   ojo:        npm rm -g human-review-protocol falló, revísalo a mano"
  else
    hallado "paquete global human-review-protocol (npm link)"
  fi
else
  limpio "sin paquete global human-review-protocol"
fi
borrar "${HRP_BIN_DIR:-$HOME/.local/bin}/hrp" "enlace ${HRP_BIN_DIR:-$HOME/.local/bin}/hrp"
echo

# 3. Claude Code
paso "Claude Code"
borrar "$HOME/.claude/skills/hrp" "skill ~/.claude/skills/hrp"
# El registro vive en el almacén del propio CLI, así que se consulta ahí y no
# adivinando el archivo; ~/.claude.json sólo se revisa por si quedó el respaldo
# que escribía el instalador cuando no encontraba el CLI.
CLAUDE="$(command -v claude 2>/dev/null || echo "$HOME/.local/bin/claude")"
if [ -x "$CLAUDE" ]; then
  if "$CLAUDE" mcp get hrp >/dev/null 2>&1; then
    if [ "$APPLY" -eq 1 ]; then
      "$CLAUDE" mcp remove hrp --scope user >/dev/null 2>&1
      "$CLAUDE" mcp remove hrp --scope local >/dev/null 2>&1
      if "$CLAUDE" mcp get hrp >/dev/null 2>&1; then
        echo "   ojo:        el CLI de Claude no pudo quitar el MCP hrp, revísalo con: $CLAUDE mcp list"
      else
        retirado "servidor MCP hrp registrado en Claude Code"
      fi
    else
      hallado "servidor MCP hrp registrado en Claude Code"
    fi
  else
    limpio "sin servidor MCP hrp registrado en Claude Code"
  fi
else
  echo "   ojo:        no encontré el CLI de Claude; revisa el MCP hrp a mano"
fi
json mcp "$HOME/.claude.json" "servidor MCP hrp escrito en ~/.claude.json"
json hooks "$HOME/.claude/settings.json" "hooks Stop y SessionStart en ~/.claude/settings.json"
echo

# 4. Codex
paso "Codex"
borrar "${HRP_CODEX_SKILLS_DIR:-$HOME/.agents/skills}/use-hrp" "skill use-hrp"
if command -v codex >/dev/null 2>&1 || [ -x /Applications/ChatGPT.app/Contents/Resources/codex ]; then
  CODEX="$(command -v codex 2>/dev/null || echo /Applications/ChatGPT.app/Contents/Resources/codex)"
  if [ "$APPLY" -eq 1 ]; then
    "$CODEX" plugin remove hrp@hrp-local >/dev/null 2>&1 && retirado "plugin hrp@hrp-local" || limpio "plugin hrp@hrp-local"
    "$CODEX" plugin marketplace remove hrp-local >/dev/null 2>&1 && retirado "marketplace hrp-local" \
      || echo "   ojo:        quita el marketplace hrp-local a mano: $CODEX plugin marketplace list"
  else
    "$CODEX" plugin list --json 2>/dev/null | grep -q hrp && hallado "plugin hrp@hrp-local" || limpio "plugin hrp@hrp-local"
    "$CODEX" plugin marketplace list 2>/dev/null | grep -q hrp-local && hallado "marketplace hrp-local" || limpio "marketplace hrp-local"
  fi
else
  limpio "no hay CLI de Codex en esta máquina"
fi
borrar "${CODEX_HOME:-$HOME/.codex}/plugins/cache/hrp-local" "caché de plugin de Codex"
echo

# 5. Antigravity
paso "Antigravity"
borrar "$HOME/.gemini/config/skills/hrp" "skill ~/.gemini/config/skills/hrp"
borrar "$HOME/.gemini/config/rules/hrp.md" "reglas ~/.gemini/config/rules/hrp.md"
json mcp "$HOME/.gemini/config/mcp_config.json" "servidor MCP hrp en ~/.gemini/config/mcp_config.json"
json mcp "$HOME/.gemini/antigravity/mcp_config.json" "servidor MCP hrp en ~/.gemini/antigravity/mcp_config.json"
echo

# 6. Datos locales
paso "Datos locales"
for dir in "$HOME/.hrp" "$HOME/.hrp-v2"; do
  nombre="~/$(basename "$dir")"
  if [ ! -d "$dir" ]; then limpio "$nombre"; continue; fi
  if [ "$APPLY" -eq 1 ] && [ "$DATA" -eq 1 ]; then rm -rf "$dir"; retirado "$nombre"
  else hallado "$nombre ($(du -sh "$dir" 2>/dev/null | cut -f1)) — se conserva salvo --data"; fi
done
echo

# 7. Respaldos que dejó el instalador
paso "Respaldos del instalador"
ENCONTRADOS=0
for file in "$HOME/.claude.json.hrp-backup" "$HOME/.claude/settings.json.hrp-backup" \
            "$HOME/.gemini/config/mcp_config.json.hrp-backup" "$HOME/.gemini/antigravity/mcp_config.json.hrp-backup"; do
  [ -f "$file" ] && { echo "   conservado: $file"; ENCONTRADOS=1; }
done
[ "$ENCONTRADOS" -eq 0 ] && limpio "sin respaldos .hrp-backup"
echo "   Los respaldos no se borran: guardan tu configuración previa a HRP."
echo

if [ "$APPLY" -eq 0 ]; then
  echo "Nada se modificó. Para retirarlo: $0 --apply"
  [ "$DATA" -eq 0 ] && echo "Para borrar además el historial en ~/.hrp: $0 --apply --data"
else
  echo "Listo. Reinicia Claude Code, Codex y Antigravity para que recarguen MCP, hooks y skills."
fi
