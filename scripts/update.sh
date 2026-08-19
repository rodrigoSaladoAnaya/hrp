#!/usr/bin/env bash
# Actualiza HRP y las skills de los tres agentes a la última versión:
# compila, reinicia el servicio e instala/actualiza las skills de
# claude, codex y antigravity desde las fuentes canónicas del repo.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"

npm run build
node bin/hrp.mjs service stop
node bin/hrp.mjs service start
node bin/hrp.mjs skills install all
node bin/hrp.mjs skills status
