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

if [ ! -f "$skill_source/SKILL.md" ] || [ ! -f "$cli_source" ] || [ ! -f "$marketplace_manifest" ] || [ ! -f "$plugin_manifest" ] || [ ! -f "$mcp_manifest" ] || [ ! -x "$mcp_launcher" ]; then
  echo "Error: la distribución de HRP está incompleta." >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "Error: no se encontró el CLI codex; instálalo o agrega su ubicación a PATH." >&2
  exit 1
fi

echo "Construyendo HRP para el servidor MCP..."
(cd "$hrp_root" && npm run build)

mkdir -p "$skills_root" "$bin_root"

previous=""
if [ -L "$skill_target" ]; then
  echo "Error: $skill_target es un enlace no administrado por el instalador v2.1." >&2
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

registered_root="$(codex plugin marketplace list | awk '$1 == "hrp-local" { $1 = ""; sub(/^[[:space:]]+/, ""); print; exit }')"
if [ -n "$registered_root" ] && [ "$registered_root" != "$marketplace_root" ]; then
  echo "Error: el marketplace hrp-local ya apunta a otra carpeta: $registered_root" >&2
  exit 1
fi
if [ -z "$registered_root" ]; then
  codex plugin marketplace add "$marketplace_root" --json >/dev/null
  echo "Marketplace registrado: hrp-local -> $marketplace_root"
else
  echo "Marketplace al día: hrp-local -> $marketplace_root"
fi

codex plugin add hrp@hrp-local --json >/dev/null
plugin_version="$(node -p "require(process.argv[1]).version" "$plugin_manifest")"
echo "Plugin instalado: hrp@hrp-local $plugin_version"
echo "Abre una tarea nueva de Codex y usa: Usa \$hrp:use-hrp para esta tarea."
