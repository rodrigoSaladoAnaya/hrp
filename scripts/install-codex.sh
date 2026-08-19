#!/usr/bin/env bash

set -euo pipefail

hrp_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
skill_source="$hrp_root/integrations/codex/plugins/hrp/skills/use-hrp"
cli_source="$hrp_root/packages/cli/bin/hrp.mjs"
skills_root="${HRP_CODEX_SKILLS_DIR:-$HOME/.agents/skills}"
bin_root="${HRP_BIN_DIR:-$HOME/.local/bin}"
skill_target="$skills_root/use-hrp"
cli_target="$bin_root/hrp"
legacy_skill_target="$HOME/.codex/skills/use-hrp"
skill_receipt=".hrp-install-source"

install_link() {
  local source="$1"
  local target="$2"
  local label="$3"

  if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then
    echo "$label ya está instalado: $target"
    return
  fi
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "Error: $target ya existe y no pertenece a esta instalación." >&2
    echo "Muévelo o elimínalo manualmente y vuelve a ejecutar el instalador." >&2
    exit 1
  fi
  ln -s "$source" "$target"
  echo "$label instalado: $target -> $source"
}

install_skill() {
  local source="$1"
  local target="$2"
  local staging
  local previous=""

  if [ -L "$target" ]; then
    if [ "$(readlink "$target")" != "$source" ]; then
      echo "Error: $target es un enlace que no pertenece a HRP." >&2
      exit 1
    fi
    rm "$target"
    echo "Migrando la skill de enlace simbólico a copia standalone."
  elif [ -e "$target" ]; then
    if [ ! -f "$target/$skill_receipt" ] || [ "$(cat "$target/$skill_receipt")" != "$source" ]; then
      echo "Error: $target ya existe y no pertenece a esta instalación." >&2
      echo "Muévelo o elimínalo manualmente y vuelve a ejecutar el instalador." >&2
      exit 1
    fi
    previous="$skills_root/.use-hrp.previous.$$"
    mv "$target" "$previous"
  fi

  staging="$(mktemp -d "$skills_root/.use-hrp.install.XXXXXX")"
  cp -R "$source"/. "$staging"/
  printf '%s\n' "$source" > "$staging/$skill_receipt"
  mv "$staging" "$target"
  if [ -n "$previous" ]; then
    rm -rf -- "$previous"
    echo "Skill de Codex actualizada: $target"
  else
    echo "Skill de Codex instalada: $target"
  fi
}

mkdir -p "$skills_root" "$bin_root"
install_skill "$skill_source" "$skill_target"
install_link "$cli_source" "$cli_target" "CLI de HRP"

if [ -z "${HRP_CODEX_SKILLS_DIR:-}" ] && \
   [ "$legacy_skill_target" != "$skill_target" ] && \
   [ -L "$legacy_skill_target" ] && \
   [ "$(readlink "$legacy_skill_target")" = "$skill_source" ]; then
  rm "$legacy_skill_target"
  echo "Enlace anterior migrado desde: $legacy_skill_target"
fi

case ":$PATH:" in
  *":$bin_root:"*) ;;
  *)
    echo "Aviso: $bin_root no está en PATH. Agrégalo para poder ejecutar 'hrp' directamente." >&2
    ;;
esac

if command -v codex >/dev/null 2>&1; then
  node "$hrp_root/scripts/verify-codex-skill.mjs" "$PWD"
else
  echo "Aviso: no se encontró 'codex'; no se pudo verificar el catálogo de skills." >&2
fi

echo "Instalación terminada. Reinicia Codex y usa: Usa \$use-hrp para esta tarea."
