# Flujo de agente para HRP v3

Usa este flujo desde la raíz del proyecto observado. Los ejemplos muestran el CLI; las herramientas MCP `hrp_*` exponen las mismas operaciones con argumentos estructurados.

## 1. Conectar y crear una ejecución

Comprueba el servicio, registra la carpeta y crea exactamente una ejecución para el requerimiento humano:

```sh
hrp service status || hrp service start
project_json=$(hrp attach . --json)
project_id=$(printf '%s' "$project_json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).id")

run_json=$(hrp run create \
  --project "$project_id" \
  --title "Resultado buscado" \
  --requirement "Requerimiento humano fiel" \
  --json)
run_id=$(printf '%s' "$run_json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).id")
```

Con MCP usa, en orden, `hrp_service_status` o `hrp_service_start`, `hrp_attach` y `hrp_create_run`.

## 2. Publicar el mapa granular

Inspecciona antes de editar. Cada nodo declara un solo archivo, un símbolo o sección real y una intención:

```json
{
  "nodes": [
    {
      "id": "settings-schema",
      "file": "src/settings.ts",
      "symbol": "SettingsSchema",
      "title": "Ampliar el esquema de preferencias",
      "description": "Añadir la nueva preferencia al contrato validado.",
      "rationale": "Los consumidores necesitan una fuente compartida y verificable.",
      "dependencies": []
    },
    {
      "id": "settings-reader",
      "file": "src/read-settings.ts",
      "symbol": "readSettings",
      "title": "Leer la nueva preferencia",
      "description": "Incorporar el campo validado al resultado público.",
      "rationale": "La aplicación debe recibir el valor persistido.",
      "dependencies": ["settings-schema"]
    }
  ]
}
```

```sh
hrp graph publish "$run_id" /ruta/temporal/graph.json --agent codex
```

`--agent codex` te registra como **modelo base** si eres el primer publicador: ejecutas por defecto los nodos sin asignación y los nodos descubiertos se te asignan automáticamente.

Usa identificadores estables con letras, números, `_` o `-`; rutas relativas al workspace; dependencias reales y sin ciclos. No crees nodos por comandos, fases genéricas ni grupos de archivos.

## 3. Esperar aprobación y respetar asignaciones

Todo nodo del grafo inicial queda con `approved: false`. Espera el visto bueno del humano con el comando bloqueante:

```sh
hrp wait approval "$run_id" --agent codex --timeout 300
```

Sale con éxito en cuanto hay trabajo aprobado disponible para ti; al agotar el timeout devuelve error: reintenta, o entrega al humano el enlace del panel y termina el turno. Para inspeccionar el detalle usa `hrp state "$run_id" --json`.

Continúa sólo cuando el nodo tenga `approved: true` y esté sin asignar o asignado a `codex`. `hrp node approve` y `hrp_approve_nodes` son controles humanos: ejecútalos únicamente ante una instrucción explícita del usuario.

Republicar el grafo devuelve a aprobación los nodos no completados. Hazlo sólo cuando cambie realmente el mapa y avisa al humano.

Los nodos descubiertos dentro de una ejecución ya aprobada nacen `approved: true` y se implementan en cuanto sus dependencias estén completas. No vuelvas a pedir aprobación humana para ellos.

Antes de elegir trabajo, consulta `run.baseAgent` en el estado. Si es `codex`, también te corresponden los nodos sin asignar y los delegados a `ollama`; si es otro agente, sólo te corresponden los nodos cuyo `assignee` sea `codex`.

Después del gate inicial, la espera normal no es terminar el turno: usa la herramienta MCP bloqueante `hrp_attention` o, si no está disponible, el CLI:

```sh
hrp attention --agent codex --wait 600
```

El plugin de Codex instala un hook `Stop` en `hooks.json`: antes de cerrar, consulta HRP y bloquea la parada cuando hay trabajo accionable o cuando debes quedarte estacionado esperando la siguiente señal. El hook `SessionStart` añade contexto al abrir una sesión si el workspace tiene ejecuciones HRP relevantes.

## 4. Ejecutar un nodo

Antes de editar:

```sh
hrp node start "$run_id" settings-schema --agent codex
```

Si otro nodo está `running`, espera. Si el nodo pertenece a otro agente, no lo tomes. Si una dependencia está pendiente, ejecuta primero los prerrequisitos aprobados.

Captura el estado anterior del archivo o símbolo, aplica únicamente la operación declarada y produce un diff unificado exclusivo. El encabezado debe identificar el archivo del nodo y no puede incluir rutas de otros archivos.

```sh
git diff -- src/settings.ts > /ruta/temporal/settings-schema.diff

hrp patch publish "$run_id" settings-schema \
  --summary "Se añadió la preferencia al esquema validado" \
  --rationale "Extender el contrato existente evita una segunda fuente de verdad" \
  --diff-file /ruta/temporal/settings-schema.diff

hrp verify run "$run_id" settings-schema -- npm test -- settings.test.ts
hrp node complete "$run_id" settings-schema
```

Con MCP usa `hrp_start_node` con `agent: "codex"`, `hrp_publish_patch`, `hrp_verify_run` y `hrp_complete_node`.

El resumen y la justificación del patch describen el resultado observado, no repiten automáticamente el plan. La verificación debe demostrar el nodo con el menor alcance útil y conservar su salida real.

## 5. Fallos

Una verificación fallida marca el nodo como `failed`. Diagnostica sin crear otra ejecución y reintenta el mismo nodo:

```sh
hrp node retry "$run_id" settings-schema --agent codex
# aplicar la corrección y generar un diff exclusivo nuevo
hrp patch publish "$run_id" settings-schema \
  --summary "Se corrigió el contrato tras la verificación" \
  --rationale "La prueba reveló la forma exacta requerida por el consumidor" \
  --diff-file /ruta/temporal/settings-schema-retry.diff
hrp verify run "$run_id" settings-schema -- npm test -- settings.test.ts
hrp node complete "$run_id" settings-schema
```

Con MCP usa `hrp_retry_node` declarando `agent: "codex"`.

## 6. Trabajo descubierto

No escondas trabajo imprevisto dentro del nodo activo. Publica otro nodo con `hrp node discover` o `hrp_discover_node`; enlaza dependencias reales. El descubierto queda aprobado automáticamente dentro de la ejecución ya aprobada, así que inícialo cuando sus dependencias estén listas.

Si el descubrimiento exige cambiar dependencias de nodos pendientes del grafo inicial, republica el mapa completo y explica que los nodos no completados de esa republicación requerirán aprobación otra vez.

## 7. Revisión multi-modelo

La revisión depende del rol registrado en `run.baseAgent`.

### Codex como agente base

Los hallazgos cuyo último turno no sea del base tienen prioridad sobre trabajo nuevo:

```sh
hrp finding show <finding-id>
```

- Hallazgo válido: publica un nodo de corrección descubierto y vincúlalo con `hrp finding accept <finding-id> --resolution-node <node-id>`. La aceptación lo aprueba sin otro clic humano.
- Hallazgo inválido: `hrp finding reject <finding-id> --author codex --body "Razón técnica verificable"`.
- Duda que no puede resolverse con evidencia: `hrp finding escalate <finding-id>`.

Al completarse todos los nodos, el servidor ejecuta la auditoría final automáticamente. Mantente atento con `hrp_attention` o `hrp attention --agent codex --wait 600`, resuelve todo hallazgo vivo y confirma:

```sh
hrp review gate "$run_id"
```

### Codex como colaborador

Si `run.baseAgent` pertenece a Claude u otro agente, completa sólo los nodos asignados a `codex`. No resuelvas hallazgos, no tomes nodos sin asignar y no ejecutes la auditoría final: informa al base cuando tu trabajo quede publicado y verificado.

### Codex como revisor

Si estás seleccionado en `run.auditors`, mantén activa la espera con `hrp_attention` o `hrp attention --agent codex --wait 600`. Al recibir **Auditoría disponible**, no reclames nodos sin asignación: publica `hrp agent status <run-id> --agent codex --phase reviewing ...`, genera `hrp review pack <run-id>` y busca errores de integración, contratos rotos y desviaciones entre spec y diff. Durante pasadas largas actualiza `--completed`, `--reviewed` y `--remaining` para que el humano vea la cobertura real.

Registra problemas con `hrp finding add` y debate con `hrp finding reply`; no edites el workspace ni inventes hallazgos para rellenar. Cuando todos los nodos estén cubiertos, publica `phase completed` con todos sus IDs en `--reviewed` y sin `--remaining`. Después vuelve a la espera con `hrp_attention` o `hrp attention`: si el base completa una corrección, HRP restablece el auditor a `waiting` y solicita otra pasada. Nunca publiques `completed` sólo porque aún no existen hallazgos.

## 8. Control, reanudación y cierre

Si `run.control` está `paused`, espera; si está `stopped`, no inicies más nodos y reporta lo completado. Nunca interpretes estos estados como fallos técnicos propios.

Después de una interrupción, consulta `hrp state "$run_id" --json` o `hrp_get_state` y reconcilia el mapa con el workspace:

- conserva nodos `completed`;
- reintenta un nodo `failed` sólo después de comprobar el cambio real;
- no repitas parches ya publicados;
- no asumas que `En vivo` significa que otro agente sigue trabajando;
- registra como descubierto el trabajo real que falte en el mapa.

Antes de entregar como agente base, confirma que todos los nodos estén `completed`, tengan diff atribuible y verificación exitosa, que cada auditor seleccionado haya publicado `phase completed` y que `hrp review gate` pase sin hallazgos vivos ni `pendingAuditors`. Como colaborador, confirma únicamente tus nodos asignados y devuelve el control al base.
