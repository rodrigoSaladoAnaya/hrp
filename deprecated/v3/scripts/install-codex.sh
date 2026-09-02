#!/usr/bin/env bash

set -euo pipefail

hrp_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
skill_source="$hrp_root/integrations/codex/plugins/hrp/skills/use-hrp"
marketplace_root="$hrp_root/integrations/codex"
marketplace_manifest="$marketplace_root/.agents/plugins/marketplace.json"
plugin_source="$marketplace_root/plugins/hrp"
plugin_manifest="$plugin_source/.codex-plugin/plugin.json"
mcp_manifest="$plugin_source/.mcp.json"
mcp_launcher="$plugin_source/scripts/hrp-mcp"
skills_root="${HRP_CODEX_SKILLS_DIR:-$HOME/.agents/skills}"
skill_target="$skills_root/use-hrp"
bin_root="${HRP_BIN_DIR:-$HOME/.local/bin}"
cli_source="$hrp_root/bin/hrp.mjs"
cli_target="$bin_root/hrp"
receipt_name=".hrp-install-source"
codex_home="${CODEX_HOME:-$HOME/.codex}"
plugin_selector="hrp@hrp-local"
plugin_cache_root="${HRP_CODEX_PLUGIN_CACHE_DIR:-$codex_home/plugins/cache/hrp-local/hrp}"
legacy_workspace_skill="$hrp_root/.agents/skills/hrp/SKILL.md"
chatgpt_codex_cli="/Applications/ChatGPT.app/Contents/Resources/codex"

if [ -n "${HRP_CODEX_CLI:-}" ]; then
  codex_cli="$HRP_CODEX_CLI"
elif [ -x "$chatgpt_codex_cli" ]; then
  codex_cli="$chatgpt_codex_cli"
elif command -v codex >/dev/null 2>&1; then
  codex_cli="$(command -v codex)"
else
  echo "Error: no se encontró el CLI codex; instala ChatGPT/Codex o agrega codex a PATH." >&2
  exit 1
fi

codex_plugin_installed() {
  "$codex_cli" plugin list --json | node -e '
const fs = require("fs");
const pluginId = process.argv[1];
const data = JSON.parse(fs.readFileSync(0, "utf8"));
process.exit(data.installed?.some((plugin) => plugin.pluginId === pluginId) ? 0 : 1);
' "$plugin_selector"
}

codex_plugin_version() {
  "$codex_cli" plugin list --json | node -e '
const fs = require("fs");
const pluginId = process.argv[1];
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const plugin = data.installed?.find((entry) => entry.pluginId === pluginId);
process.stdout.write(plugin?.version ?? "");
' "$plugin_selector"
}

chatgpt_gui_running() {
  if command -v osascript >/dev/null 2>&1 && [ "$(osascript -e 'application "ChatGPT" is running' 2>/dev/null || true)" = "true" ]; then
    return 0
  fi
  pgrep -f "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" >/dev/null 2>&1
}

if [ ! -f "$skill_source/SKILL.md" ] || [ ! -f "$cli_source" ] || [ ! -f "$marketplace_manifest" ] || [ ! -f "$plugin_manifest" ] || [ ! -f "$mcp_manifest" ] || [ ! -x "$mcp_launcher" ]; then
  echo "Error: la distribución de HRP está incompleta." >&2
  exit 1
fi

if [ ! -x "$codex_cli" ]; then
  echo "Error: el CLI codex seleccionado no es ejecutable: $codex_cli" >&2
  exit 1
fi

echo "Usando CLI de Codex: $codex_cli ($("$codex_cli" --version))"
echo "Construyendo HRP para el servidor MCP..."
(cd "$hrp_root" && npm run build)

mkdir -p "$skills_root" "$bin_root"

previous=""
if [ -L "$skill_target" ]; then
  echo "Error: $skill_target es un enlace no administrado por el instalador de HRP." >&2
  exit 1
elif [ -e "$skill_target" ]; then
  if [ ! -f "$skill_target/$receipt_name" ] || [ "$(sed -n '1p' "$skill_target/$receipt_name")" != "$skill_source" ]; then
    echo "Error: $skill_target ya existe y no pertenece a esta instalación." >&2
    exit 1
  fi
  previous="$skills_root/.use-hrp.previous.$$"
  mv "$skill_target" "$previous"
fi

staging="$(mktemp -d "$skills_root/.use-hrp.install.XXXXXX")"
cp -R "$skill_source"/. "$staging"/
printf '%s\n' "$skill_source" > "$staging/$receipt_name"
mv "$staging" "$skill_target"
if [ -n "$previous" ]; then
  rm -rf -- "$previous"
  echo "Skill use-hrp actualizada: $skill_target"
else
  echo "Skill use-hrp instalada: $skill_target"
fi

if [ -L "$cli_target" ]; then
  current_target="$(readlink "$cli_target")"
  case "$current_target" in
    "$hrp_root"/*) rm "$cli_target" ;;
    *)
      echo "Error: $cli_target apunta a una instalación ajena: $current_target" >&2
      exit 1
      ;;
  esac
elif [ -e "$cli_target" ]; then
  echo "Error: $cli_target ya existe y no es un enlace administrado por HRP." >&2
  exit 1
fi

ln -s "$cli_source" "$cli_target"
echo "CLI instalado: $cli_target -> $cli_source"

case ":$PATH:" in
  *":$bin_root:"*) ;;
  *) echo "Aviso: agrega $bin_root a PATH para ejecutar hrp directamente." >&2 ;;
esac

registered_root="$("$codex_cli" plugin marketplace list | awk '$1 == "hrp-local" { $1 = ""; sub(/^[[:space:]]+/, ""); print; exit }')"
if [ -n "$registered_root" ] && [ "$registered_root" != "$marketplace_root" ]; then
  echo "Error: el marketplace hrp-local ya apunta a otra carpeta: $registered_root" >&2
  exit 1
fi
if [ -z "$registered_root" ]; then
  "$codex_cli" plugin marketplace add "$marketplace_root" --json >/dev/null
  echo "Marketplace registrado: hrp-local -> $marketplace_root"
else
  echo "Marketplace al día: hrp-local -> $marketplace_root"
fi

pkg_version="$(node -p "require(process.argv[1]).version" "$hrp_root/package.json")"
plugin_version="$(node -e '
const fs = require("fs");
const [manifestPath, baseVersion] = [process.argv[1], process.argv[2]];
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const current = String(manifest.version || "");
const match = current.match(/\+codex(?:\.[0-9a-zA-Z._-]+)?$/);
const suffix = match ? match[0] : `+codex.${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
const resolvedVersion = `${baseVersion}${suffix}`;
if (manifest.version !== resolvedVersion) {
  manifest.version = resolvedVersion;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}
process.stdout.write(resolvedVersion);
' "$plugin_manifest" "$pkg_version")"
plugin_cache_version_dir="$plugin_cache_root/$plugin_version"
plugin_cache_skill_dir="$plugin_cache_version_dir/skills/use-hrp"

if codex_plugin_installed; then
  "$codex_cli" plugin remove "$plugin_selector" --json >/dev/null
  echo "Plugin anterior eliminado: $plugin_selector"
fi

if [ -d "$plugin_cache_root" ]; then
  rm -rf -- "$plugin_cache_root"
  echo "Cache Codex HRP limpiado: $plugin_cache_root"
fi

"$codex_cli" plugin add "$plugin_selector" --json >/dev/null
installed_plugin_version="$(codex_plugin_version)"
if [ "$installed_plugin_version" != "$plugin_version" ]; then
  echo "Error: Codex reporta $plugin_selector $installed_plugin_version, se esperaba $plugin_version." >&2
  exit 1
fi

if [ -d "$plugin_cache_skill_dir" ]; then
  cache_diff="$(diff -qr "$skill_source" "$plugin_cache_skill_dir" || true)"
  if [ -n "$cache_diff" ]; then
    echo "Error: la skill cacheada por Codex no coincide con la fuente instalada:" >&2
    echo "$cache_diff" >&2
    echo "Fuente: $skill_source/SKILL.md" >&2
    echo "Cache:  $plugin_cache_skill_dir/SKILL.md" >&2
    exit 1
  fi
  echo "Cache Codex actualizado: $plugin_cache_version_dir"
else
  echo "Aviso: Codex instaló el plugin, pero no materializó la skill en cache todavía: $plugin_cache_skill_dir/SKILL.md" >&2
fi

echo "Plugin instalado: hrp@hrp-local $plugin_version"
if [ -f "$legacy_workspace_skill" ] && grep -Eq 'HRP v[12]|Protocol [12]|v[12]\.' "$legacy_workspace_skill"; then
  echo "Aviso: existe una skill local de HRP desactualizada en este repo: $legacy_workspace_skill" >&2
  echo "Si Codex carga instrucciones HRP legacy al invocar \$hrp, está leyendo esa skill local; usa \$hrp:use-hrp o actualiza/elimina la skill local." >&2
fi
if chatgpt_gui_running; then
  echo "ChatGPT/Codex GUI está abierta ahora: ciérrala completamente con Cmd+Q y vuelve a abrirla para recargar skills/plugins."
else
  echo "Si la GUI de ChatGPT/Codex estaba abierta, ciérrala completamente con Cmd+Q y vuelve a abrirla para recargar skills/plugins."
fi
echo "Luego abre una tarea nueva en la GUI y usa: Usa \$hrp:use-hrp para esta tarea."
