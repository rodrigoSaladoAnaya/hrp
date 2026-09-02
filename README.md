# Human Review Protocol v4

La mecánica de v4 está definida en `docs/protocol.md` y aún no implementada.
Este árbol quedó vacío a propósito: v3 se congeló completa en `deprecated/v3` y
de ella sólo sobrevive el contrato en `src/shared/protocol.ts`, que se reescribe
a partir del protocolo, no al revés.

## Estado del árbol

| Ruta | Qué es |
|---|---|
| `docs/protocol.md` | Mecánica de v4: roles, ciclo del run, atención, estados, suelo común en `~/.hrp`. |
| `src/shared/protocol.ts` | Tipos y helpers del protocolo heredados de v3. Herencia deliberada, sujeta a rediseño. |
| `deprecated/v3` | v3 completa y congelada: servidor, panel, MCP, CLI, instaladores, integraciones y documentos. |
| `deprecated/v2`, `deprecated/v1` | Versiones anteriores. Referencia histórica. |
| `scripts/uninstall-v3.sh` | Desinstala de la máquina lo que v3 dejó fuera del repositorio. |

Requiere Node.js 20 o posterior.

```sh
npm install
npm run typecheck
npm test
```

## Antes de trabajar en v4

v3 quedaba instalada fuera del repositorio: CLI global, enlaces en
`~/.local/bin`, skills y servidores MCP en Claude Code, Codex y Antigravity, y
datos en `~/.hrp`. Al mover `bin/` e `integrations/` a `deprecated/v3` esas
instalaciones apuntan a rutas que ya no existen. Ejecuta:

```sh
./scripts/uninstall-v3.sh
```

Muestra primero lo que encontró y sólo borra con `--apply`.
