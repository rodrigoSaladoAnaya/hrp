#!/usr/bin/env bash
# Genera el paquete compartible de HRP para el equipo: un tarball npm con el
# build fresco (prepack ejecuta npm run build), el instalador install.sh y una
# nota con el comando único. La carpeta resultante dist-pack/ se comparte tal
# cual con quien vaya a instalar.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"

out_dir="$root/dist-pack"
mkdir -p "$out_dir"
rm -f "$out_dir"/human-review-protocol-*.tgz

echo "Generando el tarball (incluye build completo)..."
tarball_name=$(npm pack --pack-destination "$out_dir" | tail -n 1)

cp "$root/scripts/install.sh" "$out_dir/install.sh"
chmod +x "$out_dir/install.sh"

cat > "$out_dir/README-INSTALL.txt" <<EOF
Instalación de HRP ($tarball_name)

Requisito: Node.js 20 o posterior (https://nodejs.org).

Desde esta carpeta ejecuta:

    ./install.sh

Eso instala el CLI hrp de forma global, arranca el servicio local y deja
listas las integraciones de los agentes que tengas instalados (Claude Code,
Codex, Antigravity). Al terminar, el panel queda en http://127.0.0.1:4317
EOF

echo
echo "Paquete listo para compartir en: $out_dir"
ls -lh "$out_dir"
