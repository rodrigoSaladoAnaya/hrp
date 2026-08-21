# Human Review Protocol v3

HRP muestra la ejecución observable de un agente de código como un grafo global de operaciones semánticas. Cada nodo representa un archivo y símbolo concreto, explica qué cambiará y por qué, conserva sus dependencias y muestra el diff real cuando termina.

La implementación es neutral: el servidor no conoce Codex, Claude, Gemini, skills ni MCP. Cualquier adaptador capaz de llamar HTTP o ejecutar el CLI puede publicar el mismo protocolo.

## Instalación desde cero

Requiere Node.js 20 o posterior.

```sh
cd /Users/rrrssa/Documents/mysrc/hrp
npm install
npm run build
npm link
hrp service start
```

El panel queda disponible en <http://127.0.0.1:4317>. Los datos se guardan por defecto en `~/.hrp-v2`; no es necesario configurar variables de entorno.

También puedes iniciar y detener el servicio con:

```sh
./scripts/start.sh
./scripts/stop.sh
```

Para instalar o actualizar la integración completa de los agentes soportados:

```sh
hrp agent install all
```

Comprueba el resultado:

```sh
hrp agent status
```

También puedes instalar un modelo concreto con `hrp agent install claude`, `hrp agent install codex` o `hrp agent install antigravity`. Cada instalador deja su skill al día, registra el MCP `hrp` y configura el despertador nativo del entorno: hook `Stop`/`SessionStart` en Claude Code y Codex, y la herramienta bloqueante `hrp_attention` en Antigravity.

En Codex debes ver `hrp@hrp-local` instalado, `hooks.json` materializado en la caché del plugin y un servidor MCP `hrp` habilitado. Abre una tarea nueva y usa `Usa $hrp:use-hrp para esta tarea.` Las tareas que ya estaban abiertas no recargan plugins, hooks ni skills; cierra la GUI con Cmd+Q y vuelve a abrirla cuando reinstales. La skill prefiere las herramientas `hrp_*` y conserva el CLI como alternativa; no instala dependencias ni archivos dentro del proyecto observado.

No ejecutes `codex plugin marketplace add` contra la raíz del repositorio. El instalador registra automáticamente el marketplace válido que vive en `integrations/codex`.

## Conectar un proyecto

Desde la carpeta que quieres observar:

```sh
hrp attach . --start
```

El servicio puede mantener múltiples proyectos registrados simultáneamente.

## Publicar una ejecución

```sh
run_json=$(hrp run create \
  --title "Agregar configuración" \
  --requirement "Añadir una pantalla de configuración" \
  --json)

run_id=$(printf '%s' "$run_json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).id")

hrp graph publish "$run_id" graph.json
hrp node start "$run_id" settings-contract
hrp patch publish "$run_id" settings-contract \
  --summary "Se añadió el contrato de preferencias" \
  --rationale "El contrato existente es la fuente compartida por todas las pantallas" \
  --diff-file /tmp/settings.diff
hrp verify run "$run_id" settings-contract -- npm test
hrp node complete "$run_id" settings-contract
```

Para una demostración completa:

```sh
hrp service start .
npm run seed:demo
```

El comando imprime la URL exacta del proyecto y la ejecución creada.

## Comandos principales

```text
hrp service start|status|stop|restart
hrp attach [workspace] [--start]
hrp project list
hrp project remove <project-id> --yes
hrp run create|list|delete
hrp graph publish <run-id> <graph.json>
hrp node discover|approve|assign|start|complete
hrp node retry <run-id> <node-id>
hrp patch publish
hrp verify run
hrp verify tree <run-id>
hrp activity publish
hrp state <run-id>
hrp attention --agent <nombre> --wait 600
hrp attention release <run-id> --agent <nombre>
hrp agent install <claude|codex|antigravity|all>
hrp agent status
```

Consulta [docs/protocol.md](docs/protocol.md) para el contrato y el formato del grafo. Para conectar Codex, Claude, Gemini u otro agente, usa el manual autocontenido [docs/agent-adapter.md](docs/agent-adapter.md).

## Alcance de esta etapa

- El grafo inicial requiere aprobación humana antes de comenzar; los nodos descubiertos dentro de una ejecución ya aprobada nacen aprobados automáticamente.
- No existen los modos heredados `REVISAR`, `OBSERVAR` o `AUTO`; la aprobación es un gate único y explícito.
- El humano puede asignar nodos a agentes y sólo se ejecuta un nodo a la vez por ejecución.
- No se captura cadena de pensamiento; sólo intención y justificación operativa.
- Un nodo sólo termina cuando tiene diff y verificación aprobada.
- Un nodo fallido se corrige y reintenta dentro de la misma ejecución; `hrp node retry` conserva el intento anterior en Actividad.
- Los cambios descubiertos durante la ejecución se agregan al mismo mapa y se implementan en cuanto sus dependencias estén listas.

La implementación anterior está congelada en [`deprecated/v1`](deprecated/v1) y no participa en v2.
