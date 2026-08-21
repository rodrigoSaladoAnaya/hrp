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

# Sincroniza la configuración de Antigravity en la carpeta local .agents/
mkdir -p "$root/.agents/rules" "$root/.agents/skills/hrp" "$root/.agents/plugins/hrp/rules" "$root/.agents/plugins/hrp/skills/hrp"
cp -f "$root/integrations/antigravity/rules/hrp.md" "$root/.agents/rules/hrp.md"
cp -f "$root/integrations/antigravity/rules/hrp.md" "$root/.agents/plugins/hrp/rules/hrp.md"
cp -f "$root/integrations/antigravity/skills/hrp/SKILL.md" "$root/.agents/skills/hrp/SKILL.md"
cp -f "$root/integrations/antigravity/skills/hrp/SKILL.md" "$root/.agents/plugins/hrp/skills/hrp/SKILL.md"
node - "$root/package.json" "$root/.agents/plugins/hrp/plugin.json" <<'NODE'
const fs = require("fs");

const [packagePath, manifestPath] = process.argv.slice(2);
const version = JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.version = version;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

node bin/hrp.mjs skills status
