#!/usr/bin/env bash

set -euo pipefail

hrp_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
skill_source="$hrp_root/integrations/codex/plugins/hrp/skills/use-hrp"
skills_root="${HRP_CODEX_SKILLS_DIR:-$HOME/.agents/skills}"
skill_target="$skills_root/use-hrp"
bin_root="${HRP_BIN_DIR:-$HOME/.local/bin}"
cli_source="$hrp_root/bin/hrp.mjs"
cli_target="$bin_root/hrp"
receipt_name=".hrp-install-source"

if [ ! -f "$skill_source/SKILL.md" ] || [ ! -f "$cli_source" ]; then
  echo "Error: la distribución de HRP está incompleta." >&2
  exit 1
fi

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

echo "Reinicia Codex y usa: Usa \$use-hrp para esta tarea."
