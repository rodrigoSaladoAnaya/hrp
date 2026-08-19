#!/usr/bin/env bash

set -euo pipefail

hrp_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
skills_root="${HRP_CODEX_SKILLS_DIR:-$HOME/.agents/skills}"
bin_root="${HRP_BIN_DIR:-$HOME/.local/bin}"
skill_source="$hrp_root/integrations/codex/plugins/hrp/skills/use-hrp"
skill_receipt=".hrp-install-source"

remove_owned_link() {
  local target="$1"
  local expected="$2"
  if [ ! -L "$target" ]; then
    echo "Sin cambios: $target no es un enlace instalado por HRP."
    return
  fi
  if [ "$(readlink "$target")" != "$expected" ]; then
    echo "Sin cambios: $target apunta a otro destino." >&2
    return
  fi
  rm "$target"
  echo "Eliminado: $target"
}

remove_owned_skill() {
  local target="$1"
  if [ -L "$target" ]; then
    remove_owned_link "$target" "$skill_source"
    return
  fi
  if [ ! -d "$target" ]; then
    echo "Sin cambios: $target no está instalado."
    return
  fi
  if [ ! -f "$target/$skill_receipt" ] || [ "$(cat "$target/$skill_receipt")" != "$skill_source" ]; then
    echo "Sin cambios: $target no pertenece a esta instalación." >&2
    return
  fi
  rm -rf -- "$target"
  echo "Eliminado: $target"
}

remove_owned_skill "$skills_root/use-hrp"
if [ -z "${HRP_CODEX_SKILLS_DIR:-}" ]; then
  remove_owned_link "$HOME/.codex/skills/use-hrp" "$skill_source"
fi
remove_owned_link "$bin_root/hrp" "$hrp_root/packages/cli/bin/hrp.mjs"
