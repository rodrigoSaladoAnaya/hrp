# Human Review Protocol v4

HRP convierte una tarea de programación en un **run auditable**: la sesión que
recibe la tarea (el *base*) implementa dejando evidencia —nodos con diff y
verificación, commits en una rama del run—, otras sesiones (del mismo modelo o
de otro) se enganchan y auditan mientras avanza, y el run cierra solo cuando la
auditoría está completa. El humano inicia, engancha sesiones y monitorea.

La mecánica completa está en [`docs/protocol.md`](docs/protocol.md).

## Uso

En cualquier sesión de Claude Code, Codex o Antigravity abierta en la carpeta
del proyecto:

```
/hrp <tarea a desarrollar>
```

La sesión escribe el issue en `~/.hrp/runs/<id>/`, crea la rama
`hrp/run-<id>`, y responde con tres cosas:

- `/hrp attention <id>` — pégalo en otras sesiones para que auditen. También
  está en el panel, con un solo botón de copia por run.
- `hrp attend <id> --agent ollama` — para un runner sin sesión (opcional).
- La URL del panel: `http://127.0.0.1:4317/?project=…&run=…`.

El run queda `implementado` cuando el base cierra y la máquina aprueba los
criterios de aceptación; queda `cerrado` cuando cada nodo tiene auditoría
ajena, no hay hallazgos vivos y hay mayoría OK. Sin auditores no cierra solo.
Fusionar la rama es cosa del humano.

## Instalación

Requiere Node.js 20 o posterior y git.

```sh
./scripts/install.sh
```

Instala dependencias, compila, arranca el servicio e instala skill, MCP y
despertador en los agentes presentes (`hrp agent install all`). Tras cada
cambio en este repositorio:

```sh
./scripts/update.sh
```

Si vienes de v3, primero `./scripts/uninstall-v3.sh --apply`.

## Estado del árbol

| Ruta | Qué es |
|---|---|
| `docs/protocol.md` | Mecánica de v4: roles, ciclo del run, atención, estados, suelo común en `~/.hrp`. |
| `src/shared/protocol.ts` | Contrato: tipos y la regla del gate (`computeAuditStatus`). |
| `src/server` | Servicio local: store SQLite + git, resolutor de atención, HTTP/SSE, paquete de auditoría, runner. |
| `src/mcp` | Servidor MCP por stdio con las herramientas `hrp_*`; es la vía normal de uso. |
| `src/web` | Panel: issue, mapa con lupa, actividad y hallazgos con filtro por sesión, dock de sesiones. |
| `bin/hrp.mjs` | CLI: `mcp`, `service`, `hook`, `attend`, `agent install`. |
| `integrations/` | Skill `hrp` para Claude, plugin para Codex, skill y reglas para Antigravity. |
| `scripts/` | `install.sh`, `update.sh`, `start.sh`, `stop.sh`, `uninstall-v3.sh`. |
| `deprecated/` | v1, v2 y v3 congeladas. Referencia histórica. |

## Desarrollo

```sh
npm install
npm run typecheck
npm test
npm run build
npm run dev          # servidor en 4317 con datos en .hrp-dev y panel en 5173
```
