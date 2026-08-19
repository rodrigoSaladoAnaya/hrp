#!/usr/bin/env bash

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

hrp_require_node
hrp_parse_args "$@"
hrp_load_runtime

cd "$HRP_ROOT"

if [ ! -x "$HRP_ROOT/node_modules/.bin/tsx" ]; then
  echo "Faltan dependencias. Ejecuta: npm install" >&2
  exit 1
fi

if [ "${HRP_SKIP_BUILD:-0}" != "1" ]; then
  npm run build
fi

echo "Human Review Protocol: $HRP_URL"
echo "Workspace observado: $HRP_WORKSPACE_ROOT"
echo "Datos: $HRP_DATA_DIR"
echo "Detén el servicio con Ctrl+C."

exec "$HRP_ROOT/node_modules/.bin/tsx" apps/server/src/index.ts
