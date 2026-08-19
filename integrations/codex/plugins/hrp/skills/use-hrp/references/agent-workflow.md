# Flujo de agente para HRP 2.2

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

Todo nodo nuevo queda con `approved: false`. Espera el visto bueno del humano con el comando bloqueante:

```sh
hrp wait approval "$run_id" --agent codex --timeout 300
```

Sale con éxito en cuanto hay trabajo aprobado disponible para ti; al agotar el timeout devuelve error: reintenta, o entrega al humano el enlace del panel y termina el turno. Para inspeccionar el detalle usa `hrp state "$run_id" --json`.

Continúa sólo cuando el nodo tenga `approved: true` y esté sin asignar o asignado a `codex`. `hrp node approve` y `hrp_approve_nodes` son controles humanos: ejecútalos únicamente ante una instrucción explícita del usuario.

Republicar el grafo devuelve a aprobación los nodos no completados. Hazlo sólo cuando cambie realmente el mapa y avisa al humano.

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

No escondas trabajo imprevisto dentro del nodo activo. Publica otro nodo con `hrp node discover` o `hrp_discover_node`; enlaza dependencias reales y vuelve a esperar aprobación humana para ese nodo.

Si el descubrimiento exige cambiar dependencias de nodos pendientes, republica el mapa completo y explica que los nodos no completados requerirán aprobación otra vez.

## 7. Reanudar y terminar

Después de una interrupción, consulta `hrp state "$run_id" --json` o `hrp_get_state` y reconcilia el mapa con el workspace:

- conserva nodos `completed`;
- reintenta un nodo `failed` sólo después de comprobar el cambio real;
- no repitas parches ya publicados;
- no asumas que `En vivo` significa que otro agente sigue trabajando;
- registra como descubierto el trabajo real que falte en el mapa.

Antes de entregar, confirma que todos los nodos estén `completed`, tengan diff atribuible y verificación exitosa, y ejecuta la verificación integral apropiada del workspace.
