#!/usr/bin/env bash
# Actualiza HRP y las integraciones de los tres agentes a la última versión:
# compila, reinicia el servicio, instala las skills de Claude y Antigravity,
# y reinstala la integración completa de Codex (skill, CLI, plugin y MCP).

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"

npm run build
node bin/hrp.mjs service stop
node bin/hrp.mjs service start
node bin/hrp.mjs skills install claude
node bin/hrp.mjs skills install antigravity
"$root/scripts/install-codex.sh"
node bin/hrp.mjs skills status
