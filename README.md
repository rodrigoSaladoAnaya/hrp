# Human Review Protocol

Protocolo local y neutral para observar trabajo de agentes de programación, decidir qué partes requieren revisión y devolver observaciones humanas mientras el trabajo sigue en curso.

El núcleo sólo conoce planes, eventos, evidencia, políticas de revisión y comandos humanos. El repositorio incluye un CLI neutral y un adaptador opt-in de Codex como capas separadas; no requiere MCP, hooks ni modificar el proyecto observado.

## Arquitectura

```text
adaptador de agente ──HTTP──▶ protocolo/orquestador ──SSE──▶ panel
        ▲                          │                        │
        └──── comandos humanos ────┘                        │
                                   ◀── observaciones ──────┘
                                   ▲
                   gestor de proyectos + SQLite
                         ▲                 ▲
                 observador Git A   observador Git B
```

## Componentes

- `packages/protocol`: tipos canónicos, versión del protocolo e interfaz `AgentAdapter`.
- `packages/cli`: comando neutral `hrp` para cualquier agente o automatización.
- `apps/server`: registro SQLite, contextos de proyecto, orquestadores, API HTTP/SSE y observadores Git opcionales.
- `apps/web`: lista de carpetas, doble proyección del grafo (cambios/plan), operaciones por archivo, diffs reales, cobertura y observaciones dirigidas.
- `integrations/codex`: skill/plugin opt-in y marketplace versionable para Codex.
- `examples/user-registration`: fixture mínimo para pruebas manuales.

## Ejecutar

Requiere Node.js 20 o posterior.

```bash
npm install
./scripts/run.sh
```

Abre `http://127.0.0.1:4317`.

Para desarrollo:

```bash
npm run dev
```

- Panel Vite: `http://127.0.0.1:4318`
- Protocolo/API: `http://127.0.0.1:4317`

Para ejecutarlo en segundo plano:

```bash
./scripts/start.sh /ruta/al/proyecto
./scripts/status.sh
./scripts/stop.sh
```

También puedes ejecutarlo desde el proyecto objetivo sin argumentos:

```bash
cd /ruta/al/proyecto
/ruta/a/hrp/scripts/start.sh
```

El proyecto inicial por defecto es el directorio actual. Todos los proyectos comparten el registro `.human-review/hrp.sqlite`, con eventos aislados por `project_id`; no necesitas definir `HUMAN_REVIEW_WORKSPACE_ROOT` ni `HUMAN_REVIEW_DATA_DIR`.

Para registrar más carpetas en el mismo servicio:

```bash
hrp attach /ruta/al/proyecto-a --start
hrp attach /ruta/al/proyecto-b --start
```

El panel muestra ambos proyectos por nombre y ruta. Los comandos `hrp state`, `plan`, `node`, `patch`, `verify` y `commands` seleccionan automáticamente el proyecto según el directorio actual.

## Usarlo desde Codex sin invadir el proyecto

Instala una vez la skill y el CLI en tu perfil:

```bash
./scripts/install-codex.sh
```

Reinicia Codex, abre una tarea en el proyecto objetivo y escribe:

```text
Usa $use-hrp para implementar esta tarea.
```

La skill se activa sólo de forma explícita. Inicia o conecta HRP, publica el grafo y respeta las decisiones del panel. Para retirarla:

```bash
./scripts/uninstall-codex.sh
```

El manual del agent kit está en [docs/agent-kit.md](./docs/agent-kit.md). La especificación portátil para futuros adaptadores está en [integrations/AGENT-INTEGRATION.md](./integrations/AGENT-INTEGRATION.md).

El manual actualizado —instalación, múltiples proyectos, panel, API y diagnóstico— está en [MANUAL.md](./MANUAL.md).

La configuración vive en `protocol.config.json`. Los scripts aceptan `--workspace`, `--data-dir` y `--port`; las variables de entorno equivalentes siguen disponibles por compatibilidad.

## Flujo neutral

1. Un adaptador publica un DAG en `POST /api/protocol/plans`.
2. El protocolo crea automáticamente la revisión inicial del plan.
3. El humano aprueba el plan y elige por nodo o rama:
   - `required`: detiene el flujo y exige revisión del nodo.
   - `watch`: mantiene el nodo visible sin bloquearlo.
   - `auto`: permite continuar en segundo plano.
4. Cada nodo declara cambios semánticos y operaciones por archivo/símbolo antes de editar.
5. El adaptador publica patches ligados a esos cambios y verificaciones con cobertura explícita.
6. El humano navega cambio → operación → diff y envía observaciones a ese alcance exacto.
7. El adaptador consume `GET /api/protocol/commands` y confirma cada comando.

Las exenciones se ligan al fingerprint semántico del nodo. Si una replanificación cambia objetivo, archivos, cambios, operaciones, dependencias o criterios, el nodo vuelve automáticamente a `required`.

## Superficie HTTP

| Método y ruta | Propósito |
| --- | --- |
| `GET /api/protocol` | Descubrir versión y vocabulario. |
| `GET /api/projects` | Listar las carpetas registradas y su estado. |
| `POST /api/projects` | Registrar o abrir una carpeta sin reiniciar el servicio. |
| `/api/projects/:projectId/*` | Ejecutar cualquier operación dentro de un proyecto explícito. |
| `GET /api/state` | Recuperar el estado materializado completo. |
| `GET /api/events` | Suscribirse al stream SSE de eventos. |
| `POST /api/protocol/plans` | Publicar un plan y abrir su revisión. |
| `POST /api/protocol/reviews` | Solicitar revisión de un nodo. |
| `POST /api/reviews/:id/resolve` | Aprobar, rechazar, pausar o redirigir. |
| `PUT /api/review-policy` | Cambiar la política de un nodo o subtree. |
| `POST /api/protocol/nodes/:id/start` | Declarar el nodo activo y sus archivos. |
| `POST /api/protocol/nodes/:id/patches` | Registrar un cambio observado; no lo aplica. |
| `POST /api/protocol/nodes/:id/verifications` | Registrar evidencia producida por cualquier runner. |
| `POST /api/protocol/nodes/:id/complete` | Cerrar un nodo con verificación exitosa. |
| `POST /api/observations` | Emitir una observación humana dirigida. |
| `POST /api/control/pause` | Pausar el flujo mediante un comando neutral. |
| `POST /api/control/resume` | Reanudar el flujo mediante un comando neutral. |
| `GET /api/protocol/commands` | Obtener comandos aún no confirmados. |
| `POST /api/protocol/commands/:id/ack` | Confirmar recepción de un comando. |
| `POST /api/protocol/replans` | Proponer una revisión versionada del grafo. |

Consulta el recorrido de ejemplo en [docs/protocol-walkthrough.md](./docs/protocol-walkthrough.md).
El contrato fino y sus garantías de finalización están documentados en [docs/granular-review.md](./docs/granular-review.md).

## Contrato para adaptadores

Un adaptador sólo traduce dos direcciones:

```ts
interface AgentAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(command: AgentCommand): Promise<void>;
  onEvent(listener: (event: NormalizedAgentEvent) => void): () => void;
}
```

El adaptador puede usar un CLI, SDK, hook, extensión de editor o cualquier otro transporte. Este repositorio implementa primero el CLI, porque funciona igual desde Codex, Claude, Gemini o scripts. Las capacidades se declaran explícitamente (`liveEvents`, `midTurnSteering`, `approvalGates`, `sessionResume`, `workspaceDiffs`) para que el producto pueda degradarse sin fingir soporte.

## Persistencia y observación

Los proyectos y eventos se guardan en `.human-review/hrp.sqlite`. Cada secuencia pertenece a un `project_id` y conserva versión de esquema, fuente, correlación y causalidad; el estado de cada proyecto se reconstruye por replay. Al registrar una carpeta, HRP importa una vez su JSONL del formato anterior cuando existe.

El observador Git funciona como evidencia independiente: detecta cambios del working tree y publica snapshots sin atribuirlos automáticamente al agente. Si el workspace no es un worktree, el protocolo continúa y el panel muestra el observador como no disponible.

Consulta [docs/events-and-security.md](./docs/events-and-security.md) para las garantías y límites.

## Verificación

```bash
npm run typecheck
npm test
npm run build
npm run demo:test
```

## Alcance actual

La versión actual es local y de una persona, pero admite varias carpetas y sesiones de proyecto simultáneas en un único servicio. Codex tiene una integración inicial basada en instrucciones y CLI; Claude y Gemini pueden reutilizar el contrato neutral, pero aún no tienen paquetes de instalación propios. La concurrencia de varios agentes dentro del mismo proyecto todavía requiere leases; escuchar fuera de loopback requerirá autenticación.
