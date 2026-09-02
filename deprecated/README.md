# Versiones obsoletas

Cada carpeta está congelada como referencia histórica. Ninguna debe reutilizarse
como base accidental de la versión en curso.

## v1

Implementación, documentación, integraciones, dependencias instaladas y estado
local anteriores al primer reinicio de Human Review Protocol.

## v2

Sólo los documentos que definieron la versión: `README.md`, `SKILL.md` y
`agent-adapter.md`.

## v3

El árbol completo de v3: servidor Express con SQLite, panel React, servidor MCP,
CLI `hrp`, instaladores por agente, integraciones de Claude Code, Codex y
Antigravity, scripts de servicio y empaquetado, y los documentos `README.md`,
`DESIGN.md`, `PRODUCT.md` y `docs/`. Se conservan también sus archivos de build
(`package.json`, `tsconfig*.json`, `vite.config.ts`, `vitest.config.ts`) para
que la referencia sea legible sin reconstruirla desde git.

No incluye `node_modules`, `dist` ni `dist-pack`: son artefactos regenerables.

De v3 sólo sobrevive en la raíz `src/shared/protocol.ts`, copiado como punto de
partida del contrato de v4.

Lo que v3 instalaba fuera del repositorio se retira con
`scripts/uninstall-v3.sh`.
