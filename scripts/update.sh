#!/usr/bin/env bash
# Actualiza HRP tras cada cambio: compila, reinicia el servicio e instala skill,
# MCP y despertador de los agentes presentes en esta máquina.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"
npm run build
node bin/hrp.mjs service stop || true
node bin/hrp.mjs service start
node bin/hrp.mjs agent install all
node bin/hrp.mjs agent status
