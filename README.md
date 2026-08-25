# Human Review Protocol v3

HRP muestra la ejecución observable de un agente de código como un grafo global de operaciones semánticas. Cada nodo representa un archivo y símbolo concreto, explica qué cambiará y por qué, conserva sus dependencias y muestra el diff real cuando termina.

La implementación es neutral: el servidor no conoce Codex, Claude, Gemini, skills ni MCP. Cualquier adaptador capaz de llamar HTTP o ejecutar el CLI puede publicar el mismo protocolo.

## Instalación desde cero

Requiere Node.js 20 o posterior.

```sh
git clone https://github.com/rodrigoSaladoAnaya/hrp.git
cd hrp
npm install
npm run build
npm link
hrp service start
```

El panel queda disponible en <http://127.0.0.1:4317>. Los datos se guardan por defecto en `~/.hrp`; no es necesario configurar variables de entorno.

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

## Uso normal: pídeselo al agente

Después de instalar, no necesitas el CLI. Le dices al modelo que use HRP y qué quieres implementar, y él se encarga del resto: arranca el servicio si está caído, registra la carpeta como proyecto, crea la ejecución, publica el grafo y se detiene a esperar tu aprobación.

Según el agente, la frase de entrada cambia:

```text
Claude Code    Usa HRP para implementar una pantalla de configuración con tema claro y oscuro.
Codex          Usa $hrp:use-hrp para esta tarea. Quiero una pantalla de configuración con tema claro y oscuro.
Antigravity    Usa HRP para esta tarea: una pantalla de configuración con tema claro y oscuro.
```

En Claude Code también sirve `/hrp` seguido del requerimiento.

Lo que pasa a continuación, sin que escribas un comando:

1. El agente lee el código, descompone la tarea en operaciones (`archivo + símbolo + intención`) y publica el grafo. Quien publica primero queda como **modelo base** de la ejecución.
2. Se queda esperando en el gate de aprobación. **Aquí entras tú**: abre <http://127.0.0.1:4317>, revisa el mapa y aprueba. Ésa es la única acción obligatoria del humano en toda la ejecución.
3. El agente implementa nodo por nodo, y cada uno termina sólo con su diff y su verificación ejecutada.
4. Los auditores revisan y abren hallazgos; el agente base los responde y autoriza las correcciones, que entran como nodos nuevos. La ejecución no cierra con hallazgos vivos.

Para elegir quién audita, usa los interruptores de auditor en el panel antes de aprobar; la lista queda congelada mientras la ejecución corre y se puede cambiar si la pausas.

Si el agente termina su turno con trabajo vivo, el despertador nativo lo regresa solo. Si aun así se quedó callado, basta con pedírselo en lenguaje natural:

```text
Retoma la ejecución de HRP que tienes pendiente.
```

Y para pedir un cambio de rumbo a media ejecución, díselo y ya: los nodos que descubra se agregan al mismo mapa, sin abrir otra ejecución.

```text
Ya que estás, el tema tiene que persistir entre sesiones.
```

## Compartir HRP con el equipo

Para instalar HRP en otra máquina no hace falta clonar el repositorio. Quien comparte genera el paquete:

```sh
./scripts/package.sh
```

Eso deja en `dist-pack/` el tarball npm (con el build incluido), el instalador `install.sh` y un `README-INSTALL.txt`. Comparte esa carpeta completa (zip, drive, etc.).

Quien recibe solo necesita Node.js 20 o posterior y ejecuta, desde la carpeta recibida:

```sh
./install.sh
```

El instalador instala el CLI `hrp` de forma global, arranca el servicio local y ejecuta `hrp agent install all`, que detecta qué agentes hay en esa máquina (Claude Code, Codex, Antigravity) e instala solo las integraciones correspondientes. Al terminar muestra `hrp agent status` y el panel queda en <http://127.0.0.1:4317>.

## Conectar un proyecto

Lo que sigue es la ruta manual: el mismo protocolo desde el CLI, útil para escribir un adaptador nuevo o para operar sin agente. Desde la carpeta que quieres observar:

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

hrp graph publish "$run_id" graph.json --agent codex
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
hrp graph publish <run-id> <graph.json> --agent <nombre>
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
- La revisión la hacen modelos pares, no el humano: los auditores revisan durante la ejecución y al cierre con `hrp review pack`, y publican lo que encuentran con `hrp finding add`. Ningún agente audita un nodo que él mismo ejecutó.
- Quien autoriza es el agente base: acepta el hallazgo —lo que abre su nodo de corrección— o lo rechaza con razón en el hilo. `hrp review gate` impide cerrar una ejecución con hallazgos vivos. El humano aprueba el grafo inicial y monitorea; su objeción tardía se hace como una ejecución nueva.
- El humano puede asignar nodos a agentes; HRP permite ejecución concurrente sólo cuando no comparte archivo, contexto aprobado ni rama de dependencias con otro nodo en curso. Un agente mantiene un solo nodo activo, y la verificación debe declarar su alcance si otro nodo sigue en vuelo.
- No se captura cadena de pensamiento; sólo intención y justificación operativa.
- Un nodo sólo termina cuando tiene diff y verificación aprobada.
- Un nodo fallido se corrige y reintenta dentro de la misma ejecución; `hrp node retry` conserva el intento anterior en Actividad.
- Los cambios descubiertos durante la ejecución se agregan al mismo mapa y se implementan en cuanto sus dependencias estén listas.

La implementación anterior está congelada en [`deprecated/v1`](deprecated/v1) y no participa en v2.
