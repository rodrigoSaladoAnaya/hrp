# Manual de uso de Human Review Protocol

Human Review Protocol (HRP) es un servicio local para que un agente publique su plan y evidencia, mientras una persona decide qué nodos requieren revisión y envía observaciones dirigidas. El servicio no ejecuta comandos ni aplica patches: registra hechos, impone gates de revisión y entrega comandos neutrales al adaptador del agente.

Para usarlo desde Codex con una instrucción explícita y sin modificar el proyecto observado, consulta [agent-kit.md](./agent-kit.md).
Para publicar cambios semánticos, operaciones por archivo y verificaciones mapeadas, consulta [granular-review.md](./granular-review.md).

## 1. Requisitos e instalación

- macOS o Linux.
- Node.js 20 o posterior.
- npm.
- Git es opcional, pero necesario para que el observador independiente muestre snapshots del workspace.

Desde la carpeta del proyecto:

```bash
cd /Users/rrrssa/Documents/mysrc/hrp
npm install
```

## 2. Arrancar y detener el servicio

### Primer plano

Compila el panel, inicia la API y deja los logs en la terminal:

```bash
./scripts/run.sh
```

Detén el proceso con `Ctrl+C`.

### Segundo plano

```bash
./scripts/start.sh
./scripts/status.sh
./scripts/stop.sh
```

El panel y la API quedan disponibles en [http://127.0.0.1:4317](http://127.0.0.1:4317). El PID y el log se guardan por defecto en `.human-review/runtime/`.

El workspace por defecto es el directorio desde el que invocas el script. El directorio de datos se deriva automáticamente de la ruta absoluta del workspace y se guarda bajo `.human-review/workspaces/` en HRP.

Para omitir el build cuando ya existe `apps/web/dist`:

```bash
./scripts/start.sh --skip-build
```

## 3. Observar otro proyecto

Puedes pasar el workspace como argumento posicional:

```bash
./scripts/start.sh /ruta/al/proyecto
```

O mediante un flag explícito:

```bash
./scripts/start.sh --workspace /ruta/al/proyecto
```

La opción más corta es ejecutar HRP desde el proyecto objetivo; no requiere argumentos:

```bash
cd /ruta/al/proyecto
/ruta/a/hrp/scripts/start.sh
```

Para sobrescribir el data dir o el puerto:

```bash
./scripts/start.sh /ruta/al/proyecto \
  --data-dir /ruta/a/sesiones/proyecto-1 \
  --port 4400

./scripts/status.sh --port 4400
./scripts/stop.sh --port 4400
```

Flags disponibles:

| Flag | Propósito | Default |
| --- | --- | --- |
| `WORKSPACE` o `--workspace PATH` | Workspace observado por Git. | Directorio actual. |
| `--data-dir PATH` | Directorio del event store JSONL. | Derivado automáticamente del workspace. |
| `--port PORT` | Puerto HTTP. | Valor de `protocol.config.json`. |
| `--skip-build` | No recompilar el panel. | Compilar antes de arrancar. |

Las variables de entorno siguen disponibles por compatibilidad. La precedencia es: flag, variable de entorno, default automático.

| Variable | Propósito |
| --- | --- |
| `HUMAN_REVIEW_WORKSPACE_ROOT` | Alternativa a `--workspace`. |
| `HUMAN_REVIEW_CONFIG_PATH` | Configuración alternativa. Las rutas relativas se resuelven desde la raíz de HRP. |
| `HUMAN_REVIEW_DATA_DIR` | Alternativa a `--data-dir`. |
| `HUMAN_REVIEW_HTTP_PORT` | Sobrescribe el puerto configurado. |
| `HUMAN_REVIEW_RUNTIME_DIR` | Ubicación del PID y log de los scripts. |
| `HUMAN_REVIEW_LOG_FILE` | Ruta exacta del log. |
| `HRP_SKIP_BUILD=1` | No recompila el panel al arrancar. |

Si ejecutas varias instancias, asigna a cada una un puerto, data dir y runtime dir diferentes.

## 4. Conceptos esenciales

- **Plan:** DAG versionado con los pasos que propone el agente.
- **Nodo:** unidad revisable con objetivo, dependencias, archivos y criterios de verificación.
- **Cambio semántico:** decisión fina, explicable y verificable que aparece como nodo en la vista predeterminada del grafo.
- **Operación:** modificación prevista en un archivo o símbolo, con descripción de qué cambia y por qué.
- **Patch:** evidencia de diff real ligada a un cambio y separada por archivo.
- **Cobertura:** relación explícita entre una verificación y los cambios, operaciones o patches que demuestra.
- **REVISAR (`required`):** el agente debe detenerse y esperar aprobación.
- **OBSERVAR (`watch`):** el nodo sigue visible, pero no detiene al agente.
- **AUTO (`auto`):** el nodo puede continuar en segundo plano.
- **Observación humana:** comentario dirigido a un plan, nodo, archivo, línea o patch; puede ser bloqueante.
- **Comando:** instrucción neutral pendiente de entrega al agente.
- **Fingerprint:** identidad semántica del nodo. Si cambia su contenido durante un replan, una exención previa deja de ser válida.

## 5. Flujo cotidiano desde el panel

1. El adaptador del agente publica un plan.
2. Abre el panel en `http://127.0.0.1:4317`.
3. Revisa y aprueba el plan inicial.
4. Usa **Cambios** para navegar decisiones finas o **Plan** para ver las fases y gates.
5. Selecciona un cambio y después una operación para ver qué cambió en ese archivo, por qué, el diff real y su verificación.
6. Elige `REVISAR`, `OBSERVAR` o `AUTO`. Activa **Aplicar a la rama** si quieres afectar todos sus descendientes.
7. Escribe una observación; quedará dirigida al cambio, operación, archivo, símbolo y patch seleccionados. Marca **Bloquear hasta respuesta** cuando el agente no deba continuar.
8. El adaptador consume el comando y confirma su recepción.
9. Ante un replan, revisa el supuesto cambiado y los nodos conservados, sustituidos o nuevos antes de aprobar.

El botón global **Pausar/Reanudar** crea un comando; no mata el proceso del agente por sí solo. El adaptador debe obedecerlo.

## 6. Recorrido manual por HTTP

Define una URL para acortar los ejemplos:

```bash
export HRP_URL=http://127.0.0.1:4317
```

Comprueba el servicio:

```bash
curl "$HRP_URL/api/protocol"
curl "$HRP_URL/api/config"
```

Publica un plan mínimo:

```bash
curl -X POST "$HRP_URL/api/protocol/plans" \
  -H 'content-type: application/json' \
  -d '{
    "title": "Cambio de ejemplo",
    "summary": "Implementar y verificar un cambio pequeño",
    "nodes": [{
      "id": "implementation",
      "title": "Implementar cambio",
      "objective": "Modificar el comportamiento solicitado",
      "dependencies": [],
      "affectedFiles": ["src/example.ts"],
      "rationale": "Es el cambio principal.",
      "verificationCriteria": ["La prueba externa termina con exitCode 0."],
      "changes": [{
        "id": "adjust-return-value",
        "title": "Ajustar el valor de retorno",
        "intent": "Cambiar el resultado observable de 1 a 2",
        "rationale": "Es la decisión funcional solicitada.",
        "dependencies": [],
        "operations": [{
          "id": "modify-example-return",
          "file": "src/example.ts",
          "kind": "modify",
          "summary": "Cambiar el literal retornado",
          "rationale": "Produce el nuevo resultado observable."
        }]
      }]
    }]
  }'
```

Consulta el estado y localiza la revisión pendiente:

```bash
curl "$HRP_URL/api/state"
```

La forma más cómoda de aprobarla es desde el panel. También puedes usar su `reviewId`:

```bash
curl -X POST "$HRP_URL/api/reviews/REVIEW_ID/resolve" \
  -H 'content-type: application/json' \
  -d '{"decision":"approved"}'
```

Cambia la política del nodo:

```bash
curl -X PUT "$HRP_URL/api/review-policy" \
  -H 'content-type: application/json' \
  -d '{
    "nodeId": "implementation",
    "scope": "node",
    "mode": "watch",
    "reason": "Sólo necesito visibilidad en esta etapa."
  }'
```

Registra que el agente comenzó el nodo:

```bash
curl -X POST "$HRP_URL/api/protocol/nodes/implementation/start" \
  -H 'content-type: application/json' \
  -d '{
    "intent": "Modificar únicamente src/example.ts",
    "affectedFiles": ["src/example.ts"]
  }'
```

Publica un patch observado:

```bash
curl -X POST "$HRP_URL/api/protocol/nodes/implementation/patches" \
  -H 'content-type: application/json' \
  -d '{
    "changeId": "adjust-return-value",
    "summary": "Ajusta el valor de retorno",
    "files": ["src/example.ts"],
    "diff": "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-return 1\n+return 2",
    "beforeCode": "return 1",
    "afterCode": "return 2",
    "actor": "my-agent-adapter"
  }'
```

Publica evidencia de verificación. HRP registra el resultado, pero no ejecuta el comando:

```bash
curl -X POST "$HRP_URL/api/protocol/nodes/implementation/verifications" \
  -H 'content-type: application/json' \
  -d '{
    "commandId": "test-001",
    "command": "npm test",
    "output": "1 test passed",
    "exitCode": 0,
    "coversChangeIds": ["adjust-return-value"],
    "coversOperationIds": ["modify-example-return"],
    "coversPatchIds": ["PATCH_ID_DEVUELTO_POR_EL_ENDPOINT_ANTERIOR"]
  }'
```

Completa el nodo:

```bash
curl -X POST "$HRP_URL/api/protocol/nodes/implementation/complete" \
  -H 'content-type: application/json' \
  -d '{"summary":"Cambio implementado y verificado."}'
```

## 7. Integración de un adaptador

Un adaptador mantiene dos ciclos independientes:

### Agente → HRP

1. Publica el plan.
2. Solicita revisiones requeridas.
3. Declara inicio e intención del nodo.
4. Publica patches y verificaciones.
5. Completa el nodo o propone un replan.

### HRP → agente

Consulta periódicamente:

```bash
curl "$HRP_URL/api/protocol/commands"
```

Entrega cada comando pendiente al agente y confirma sólo cuando el agente lo haya recibido:

```bash
curl -X POST "$HRP_URL/api/protocol/commands/COMMAND_ID/ack"
```

Para actualización inmediata, suscríbete al stream SSE:

```bash
curl -N "$HRP_URL/api/events"
```

No confirmes un comando antes de entregarlo. Si el adaptador se reinicia, vuelve a consultar los comandos pendientes; el protocolo conserva su estado.

## 8. Persistencia y reinicio

Los eventos viven en `.human-review/events.jsonl`. Al reiniciar, HRP reconstruye el estado por replay.

Para una sesión aislada:

```bash
./scripts/start.sh /ruta/al/proyecto \
  --data-dir /tmp/hrp-session-1 \
  --port 4401
```

No edites `events.jsonl` mientras el servicio esté activo. Para conservar auditoría, archiva el directorio de datos completo.

## 9. Diagnóstico

### El servicio no inicia

```bash
tail -n 100 .human-review/runtime/server.log
./scripts/status.sh
```

Comprueba también `node --version`, `npm install` y que el puerto no esté ocupado.

### El panel abre, pero no hay plan

El agente todavía no publicó `POST /api/protocol/plans`, o estás usando otro `HUMAN_REVIEW_DATA_DIR`.

### El observador Git no está disponible

Comprueba que `HUMAN_REVIEW_WORKSPACE_ROOT` apunte a un worktree Git. HRP sigue funcionando sin el observador.

### Un nodo no puede iniciar

Verifica que:

- Sus dependencias estén completas.
- El plan inicial esté aprobado.
- Si está en `required`, exista una revisión de nodo aprobada para su fingerprint actual.
- No haya una observación bloqueante o pausa global pendiente.

### El PID existe, pero la API no responde

Ejecuta `./scripts/stop.sh`, revisa el log y vuelve a iniciar. Si arrancaste con variables personalizadas, repítelas también al consultar o detener.

## 10. CLI y agentes

El CLI `hrp` ofrece la misma superficie sin escribir `curl`. Después de `npm install` puedes ejecutarlo dentro del repositorio con `npm run hrp -- --help`, mediante `node_modules/.bin/hrp` o instalarlo en tu perfil con `./scripts/install-codex.sh`.

La integración de Codex es opt-in: invoca `$use-hrp` en tu petición. No instala MCP, no usa hooks y no añade archivos al proyecto objetivo. Claude y Gemini pueden reutilizar el mismo CLI mediante una instrucción equivalente; consulta [../integrations/AGENT-INTEGRATION.md](../integrations/AGENT-INTEGRATION.md).

## 11. Límites actuales

- Una persona y una sesión activa por data directory.
- Sin autenticación: escucha sólo en `127.0.0.1` o `localhost`.
- Codex tiene un adaptador inicial basado en skill y CLI; Claude y Gemini todavía no tienen instaladores propios.
- HRP no ejecuta comandos, no modifica el workspace y no atribuye automáticamente cambios Git a un agente.
- Para múltiples agentes o equipos se recomienda SQLite, leases por sesión y autenticación local.

Consulta también [protocol-walkthrough.md](./protocol-walkthrough.md) y [events-and-security.md](./events-and-security.md).
