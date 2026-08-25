#!/usr/bin/env bash
# Instalador de HRP para integrantes del equipo. Se distribuye junto al tarball
# generado por scripts/package.sh y no depende del repositorio: instala el
# paquete global, arranca el servicio local e instala las integraciones de los
# agentes que existan en esta máquina.
#
# Uso: ./install.sh [ruta/al/human-review-protocol-X.Y.Z.tgz]
# Sin argumento busca el tarball en la misma carpeta que este script.

set -euo pipefail

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

command -v npm >/dev/null 2>&1 || fail "npm no está instalado. Instala Node.js 20 o posterior (https://nodejs.org) y vuelve a ejecutar este script."
command -v node >/dev/null 2>&1 || fail "node no está instalado. Instala Node.js 20 o posterior (https://nodejs.org) y vuelve a ejecutar este script."

node_major=$(node -p "process.versions.node.split('.')[0]")
[ "$node_major" -ge 20 ] || fail "HRP requiere Node.js 20 o posterior; tienes $(node --version). Actualiza Node y vuelve a ejecutar este script."

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

if [ "$#" -ge 1 ]; then
  tarball="$1"
  [ -f "$tarball" ] || fail "no existe el tarball indicado: $tarball"
else
  # Sin argumento: el tarball más reciente junto al script.
  tarball=$(ls "$script_dir"/human-review-protocol-*.tgz 2>/dev/null | sort -V | tail -n 1 || true)
  [ -n "$tarball" ] || fail "no encontré human-review-protocol-*.tgz junto a este script. Copia el tarball a esta carpeta o pásalo como argumento."
fi

echo "Instalando $(basename "$tarball") de forma global..."
npm install -g "$tarball"

# npm install -g deja 'hrp' en el bin global; si esa carpeta no está en PATH,
# usamos la ruta absoluta y avisamos al final.
if command -v hrp >/dev/null 2>&1; then
  hrp_cmd="hrp"
else
  global_bin="$(npm prefix -g)/bin"
  hrp_cmd="$global_bin/hrp"
  [ -x "$hrp_cmd" ] || fail "npm instaló el paquete pero no encuentro el ejecutable hrp; revisa la salida de 'npm prefix -g'."
fi

echo "Arrancando el servicio HRP..."
"$hrp_cmd" service start

echo "Instalando las integraciones de los agentes detectados en esta máquina..."
"$hrp_cmd" agent install all

echo
"$hrp_cmd" agent status
echo
echo "Listo. El panel de HRP está en http://127.0.0.1:4317"
if [ "$hrp_cmd" != "hrp" ]; then
  echo "Aviso: agrega $global_bin a tu PATH para poder invocar 'hrp' directamente."
fi
