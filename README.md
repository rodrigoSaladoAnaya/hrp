# Human Review Protocol v2

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
hrp service start|status|stop
hrp attach [workspace] [--start]
hrp project list
hrp project remove <project-id> --yes
hrp run create|list|delete
hrp graph publish <run-id> <graph.json>
hrp node discover|start|complete
hrp node retry <run-id> <node-id>
hrp patch publish
hrp verify run
hrp activity publish
hrp state <run-id>
```

Consulta [docs/protocol.md](docs/protocol.md) para el contrato y el formato del grafo.

## Alcance de esta etapa

- Todo se ejecuta en modo automático.
- No existen gates `REVISAR`, `OBSERVAR` o `AUTO`.
- No se captura cadena de pensamiento; sólo intención y justificación operativa.
- Un nodo sólo termina cuando tiene diff y verificación aprobada.
- Un nodo fallido se corrige y reintenta dentro de la misma ejecución; `hrp node retry` conserva el intento anterior en Actividad.
- Los cambios descubiertos durante la ejecución se agregan al mismo mapa.

La implementación anterior está congelada en [`deprecated/v1`](deprecated/v1) y no participa en v2.
