#!/usr/bin/env bash
# Instalación desde el clone: dependencias, build, servicio e integraciones.
set -euo pipefail
fail() { echo "ERROR: $1" >&2; exit 1; }
command -v node >/dev/null 2>&1 || fail "node no está instalado (se requiere Node.js 20 o posterior)"
node_major=$(node -p "process.versions.node.split('.')[0]")
[ "$node_major" -ge 20 ] || fail "HRP requiere Node.js 20 o posterior; tienes $(node --version)"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"
npm install --no-audit --no-fund
exec "$root/scripts/update.sh"
