# Integración de agentes con HRP v2

Este documento es el contrato de integración para conectar un agente de programación —Codex, Claude, Gemini o cualquier implementación propia— con Human Review Protocol v2.

HRP es neutral al proveedor. El agente puede publicar mediante el CLI `hrp` o mediante HTTP; no necesita MCP, una skill ni cambios dentro del proyecto observado. Las integraciones específicas de un proveedor deben limitarse a traducir su ciclo de trabajo a este protocolo.

## Objetivo del adaptador

El adaptador convierte una tarea de programación en evidencia observable:

1. registra la carpeta del proyecto;
2. crea una ejecución para el requerimiento humano;
3. publica un grafo de operaciones semánticas;
4. anuncia qué nodo comienza;
5. publica el diff atribuible a ese nodo;
6. ejecuta y publica una verificación;
7. completa el nodo o lo reintenta;
8. añade al grafo el trabajo que descubra durante la implementación.

El panel reconstruye el estado desde esos eventos. HRP no ejecuta el trabajo por el agente ni infiere automáticamente la intención de un cambio.

## Requisitos

- HRP v2 instalado y compilado.
- Node.js 20 o posterior.
- El comando `hrp` disponible en `PATH`.
- Acceso local a `http://127.0.0.1:4317`.
- Permiso del agente para ejecutar comandos en el workspace o realizar solicitudes HTTP locales.

Instalación de HRP:

```sh
cd /ruta/a/hrp
npm install
npm run build
npm link
hrp service start
```

Valores predeterminados:

```text
URL:       http://127.0.0.1:4317
Datos:     ~/.hrp-v2
Protocolo: 2.3
```

El servicio es local y no tiene autenticación. No debe exponerse directamente a una red pública.

Para instalar la skill de un agente concreto (Claude, Codex o Antigravity) y mantenerla sincronizada con cada actualización de HRP, usa `hrp skills install <agente>`; las rutas por agente y el mecanismo de actualización automática están en [agent-skills.md](agent-skills.md).

## Regla de granularidad

Un nodo representa exactamente:

```text
archivo + símbolo o sección lógica + intención
```

Ejemplos correctos:

- `src/preferences.ts` + `saveTheme` + persistir la apariencia elegida;
- `src/preferences.ts` + `resolveTheme` + resolver preferencia y valor del sistema;
- `app.json` + `expo.plugins` + registrar un plugin;
- `README.md` + `Instalación` + documentar un nuevo requisito.

Ejemplos incorrectos:

- “Implementar el backend”;
- “Modificar archivos de configuración”;
- un nodo único para `src/preferences.ts` cuando cambiarán tres funciones independientes;
- un nodo por comando ejecutado;
- un nodo por fase genérica como “codificar” o “probar”.

Dos cambios independientes en el mismo archivo son dos nodos. Una modificación transversal de un solo símbolo es un nodo, aunque requiera varias líneas.

Las dependencias expresan prerrequisitos reales. Si `HomeScreen.shareImageAsync` necesita que `expo-sharing` esté declarado, el nodo de la pantalla depende del nodo de configuración. No agregues dependencias únicamente para producir una secuencia visual.

## Información permitida

HRP solicita explicaciones operativas, no razonamiento interno del modelo.

Publica:

- qué pretende cambiar el nodo;
- por qué ese cambio es necesario para el requerimiento;
- de qué operaciones depende;
- qué diff aplicó;
- qué comando verificó el resultado;
- qué restricción nueva fue descubierta.

No publiques:

- cadena de pensamiento privada;
- deliberaciones internas paso a paso;
- contenido secreto, credenciales o variables sensibles;
- logs completos que no ayuden a entender o verificar el cambio.

Una justificación adecuada es breve y comprobable: “La pantalla necesita una única fuente persistente para evitar estados divergentes”.

## Flujo recomendado mediante CLI

Ejecuta estos comandos desde la raíz del proyecto observado.

### 1. Comprobar e iniciar el servicio

```sh
hrp service status || hrp service start
```

### 2. Registrar la carpeta

```sh
project_json=$(hrp attach . --json)
project_id=$(printf '%s' "$project_json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).id")
```

Registrar una carpeta existente es idempotente: HRP devuelve el mismo proyecto canónico.

### 3. Crear la ejecución

Usa como `requirement` el requerimiento humano original, resumido sin cambiar su intención.

```sh
run_json=$(hrp run create \
  --project "$project_id" \
  --title "Compartir la composición" \
  --requirement "Agregar una opción para compartir la imagen editada" \
  --json)

run_id=$(printf '%s' "$run_json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).id")
```

Una ejecución corresponde a un requerimiento. No crees una ejecución nueva por cada archivo, reintento o descubrimiento.

### 4. Inspeccionar y publicar el mejor grafo conocido

Antes de modificar archivos, inspecciona el código suficiente para identificar las operaciones previstas. Guarda un archivo temporal como `graph.json`:

```json
{
  "nodes": [
    {
      "id": "sharing-dependency",
      "file": "package.json",
      "symbol": "dependencies.expo-sharing",
      "title": "Declarar Expo Sharing",
      "description": "Añadir la dependencia compatible con la versión actual de Expo.",
      "rationale": "La pantalla necesita la API nativa de compartir.",
      "dependencies": []
    },
    {
      "id": "share-action",
      "file": "app/(tabs)/index.tsx",
      "symbol": "HomeScreen.shareImageAsync",
      "title": "Compartir el JPEG editado",
      "description": "Crear la acción que comparte la imagen generada y maneja disponibilidad.",
      "rationale": "El usuario debe poder sacar la composición fuera de la aplicación.",
      "dependencies": ["sharing-dependency"]
    }
  ]
}
```

Publica el grafo:

```sh
hrp graph publish "$run_id" graph.json --agent codex
```

Declara tu identidad con `--agent` al publicar: el primer publicador queda registrado como **modelo base** de la ejecución. El modelo base es el ejecutor por defecto de todos los nodos sin asignación explícita, y cualquier nodo descubierto durante la ejecución se le asigna automáticamente, para que el proceso no quede colgado esperando a otro agente que no sabe que existe trabajo nuevo.

Requisitos del grafo:

- los identificadores son únicos y estables dentro de la ejecución;
- sólo contienen letras, números, guion o guion bajo;
- todas las dependencias existen;
- no hay ciclos;
- `file` es relativo al workspace;
- `symbol` identifica el método, componente, clave o sección lógica real;
- `description` explica qué hará;
- `rationale` explica por qué existe;
- `suggestedAgent` (opcional) recomienda quién debería implementarlo — por ejemplo `"ollama"` para trabajo mecánico o de bajo riesgo. HRP pre-asigna el nodo al agente sugerido si el humano no ha decidido otra cosa; la insignia «sugiere» del panel deja visible que la recomendación vino del modelo base.

### 4b. Esperar la aprobación humana

Desde el protocolo 2.1, todo nodo publicado o descubierto nace **sin aprobar** y el servidor rechaza su inicio hasta que el humano da el visto bueno, desde el panel (botón «Aprobar grafo» o la aprobación individual del inspector) o por CLI:

```sh
hrp node approve "$run_id"              # todo lo pendiente de aprobación
hrp node approve "$run_id" nodo-a nodo-b # nodos concretos
```

Después de publicar el grafo, el adaptador debe esperar la aprobación sin exigir un segundo aviso del humano. La forma estándar en cualquier agente es el comando bloqueante:

```sh
hrp wait approval "$run_id" --agent codex --timeout 300
```

Sale con éxito en cuanto hay trabajo aprobado disponible para esa identidad (o para cualquiera, si se omite `--agent`); al agotar el timeout devuelve error con la instrucción de reintentar. Además, al comenzar la espera con `--agent` el comando **registra la presencia del agente** en la ejecución, de modo que el panel deja de mostrar "sin señal" desde que el agente se engancha, no hasta su primer `start`. Un adaptador sin CLI puede sondear `GET /api/runs/:runId` hasta ver `approved: true` en sus nodos, y anunciar su presencia con `POST /api/runs/:runId/agents`. Los comandos de aprobación son controles humanos: el adaptador sólo puede ejecutarlos cuando el usuario le ordena explícitamente aprobar nodos, nunca por inferirlo de la autonomía general de la tarea. Volver a publicar el grafo devuelve al gate los nodos no completados.

El humano puede además repartir el trabajo asignando nodos a agentes concretos:

```sh
hrp node assign "$run_id" nodo-a codex   # '-' retira la asignación
```

Un adaptador debe declarar su identidad al iniciar (`hrp node start "$run_id" nodo-a --agent codex`); si el nodo está asignado a otro agente, el inicio se rechaza. Trabaja únicamente los nodos asignados a tu identidad o sin asignar (los nodos sin asignar pertenecen al modelo base). La asignación se congela mientras el nodo está en curso: el humano solo puede reasignar nodos pendientes o fallidos.

Cada inicio con identidad registra la **presencia** del agente en la ejecución (`seenAgents`). El panel usa esa señal para advertir al humano cuando un nodo está asignado a un modelo que nunca se ha presentado, ofrecerle el comando que debe pegar en ese modelo, y permitirle devolver el nodo al modelo base si el asignado no responde.

Solo puede haber **un nodo en curso por ejecución**: el workspace es compartido y dos agentes editando o verificando a la vez se contaminan mutuamente. Si el inicio se rechaza por otro nodo en vuelo, espera a que ese nodo termine.

### 5. Ejecutar un nodo

Antes de editar su contenido:

```sh
hrp node start "$run_id" sharing-dependency
```

HRP rechazará el inicio si alguna dependencia no está terminada.

Captura una referencia del contenido anterior del archivo o símbolo. El diff que se publique después debe contener sólo el cambio atribuible a este nodo, no todos los cambios acumulados del workspace.

Realiza la modificación y genera un diff unificado. Por ejemplo, si el nodo fue el único cambio pendiente del archivo:

```sh
git diff -- package.json > /tmp/sharing-dependency.diff
```

Si varios nodos modifican el mismo archivo, captura el estado inmediatamente antes de cada nodo y compáralo con el estado posterior. No reutilices un diff acumulado que mezcle símbolos.

El servidor valida la atribución en ambas direcciones: el texto del diff debe contener la ruta declarada del nodo (`file`) o al menos su nombre de archivo, como ocurre naturalmente en los encabezados de `git diff` y `diff -u`, o en un encabezado mínimo `@@ ruta/archivo`; y sus encabezados no pueden tocar ningún otro archivo. Un diff que nunca menciona el archivo del nodo, o que mezcla cambios de archivos ajenos (por ejemplo, el cableado en otro módulo o el ajuste de un test existente), se rechaza con error: publica ese trabajo como nodos propios o descubiertos.

Publica la evidencia:

```sh
hrp patch publish "$run_id" sharing-dependency \
  --summary "Se añadió expo-sharing con una versión compatible con Expo" \
  --rationale "Mantener la versión alineada con el SDK evita una resolución nativa incompatible" \
  --diff-file /tmp/sharing-dependency.diff
```

El resumen describe lo que realmente ocurrió. `--rationale` explica por qué el cambio aplicado tomó esa forma. No copies sin comprobar la descripción o el porqué planeados: HRP conserva ambos para comparar plan y resultado.

### 6. Verificar y completar

Ejecuta la verificación más pequeña que demuestre el nodo, sin omitir las verificaciones integrales necesarias:

```sh
hrp verify run "$run_id" sharing-dependency -- npm ls expo-sharing --depth=0
hrp node complete "$run_id" sharing-dependency --tokens 12500
```

`--tokens` es opcional y reporta el consumo del agente en este nodo para que el humano vea el costo en el panel. Repórtalo únicamente si tu entorno expone el consumo real (o un delta medible de tu presupuesto); si no lo conoces, omítelo — un número inventado es peor que la ausencia del dato.

`hrp verify run` publica comando, salida y código de terminación. Un nodo sólo puede completarse cuando tiene un diff no vacío y su verificación más reciente pasó.

Después continúa con los nodos cuyas dependencias ya estén terminadas.

## Fallos y reintentos

Un fallo técnico pertenece al mismo nodo y a la misma ejecución.

Cuando una verificación falla:

1. HRP marca el nodo como `failed`;
2. el intento queda conservado en la vista Actividad;
3. los nodos dependientes continúan bloqueados;
4. el agente diagnostica y corrige el problema;
5. reinicia ese mismo nodo;
6. publica el nuevo diff y la nueva verificación;
7. lo completa cuando pase.

```sh
hrp node retry "$run_id" sharing-dependency

# aplicar la corrección

hrp patch publish "$run_id" sharing-dependency \
  --summary "Se corrigió la versión incompatible" \
  --rationale "La verificación reveló que el proyecto requiere la versión incluida por su SDK" \
  --diff-file /tmp/sharing-dependency-retry.diff

hrp verify run "$run_id" sharing-dependency -- npm ls expo-sharing --depth=0
hrp node complete "$run_id" sharing-dependency
```

El comando de verificación devuelve el mismo código de salida que el proceso ejecutado. Si el adaptador usa `set -e`, debe capturar el fallo para poder diagnosticar y reintentar en lugar de terminar abruptamente.

Ejemplo:

```sh
if hrp verify run "$run_id" sharing-dependency -- npm test; then
  hrp node complete "$run_id" sharing-dependency
else
  hrp activity publish "$run_id" \
    --type inspect \
    --node sharing-dependency \
    --summary "La verificación falló; se investigará dentro del mismo nodo"
fi
```

Crea otra ejecución sólo si el humano formula un requerimiento distinto o si la implementación anterior se abandona explícitamente y se inicia un replanteamiento independiente.

## Trabajo descubierto durante la ejecución

Si aparece una operación que no estaba en el grafo inicial, no la escondas dentro del nodo actual ni crees otra ejecución. Publícala como descubierta.

Guarda `discovered-node.json`:

```json
{
  "id": "sharing-plugin",
  "file": "app.json",
  "symbol": "expo.plugins.expo-sharing",
  "title": "Registrar el plugin nativo",
  "description": "Añadir la configuración requerida por el build nativo.",
  "rationale": "La inspección reveló que el proyecto usa prebuild y necesita configuración explícita.",
  "dependencies": ["sharing-dependency"]
}
```

Publícalo:

```sh
hrp node discover "$run_id" discovered-node.json
```

El nuevo nodo aparecerá en el mismo mapa con la etiqueta `Descubierto`. Después sigue el ciclo normal `start → patch → verify → complete`.

**Triaje del ejecutor al descubrir.** Si Ollama Cloud está configurado (`hrp ollama status`), el agente base evalúa cada descubierto antes de publicarlo: el trabajo mecánico, repetitivo o completamente especificado por su descripción lleva `"suggestedAgent": "ollama"` (HRP lo pre-asigna a `ollama` y sigue el flujo de la sección «Delegación a Ollama Cloud»); el trabajo de diseño, seguridad o con ambigüedad se publica sin sugerencia y queda asignado al modelo base. El objetivo es que el modelo avanzado se reserve para las operaciones de alto valor.

**La aprobación del descubierto no detiene la ejecución.** Publica el nodo descubierto y continúa de inmediato con los nodos ya aprobados cuyas dependencias estén completas; ejecuta `hrp wait approval` únicamente cuando no quede trabajo aprobado disponible, agrupando en una sola espera todos los descubiertos pendientes.

Si el descubrimiento cambia las dependencias de nodos aún pendientes, vuelve a publicar el grafo completo con las relaciones actualizadas. No cambies silenciosamente la semántica de un nodo ya terminado.

## Actividad secundaria

La vista Actividad contiene observaciones útiles que no constituyen una operación de cambio:

```sh
hrp activity publish "$run_id" \
  --type inspect \
  --node share-action \
  --summary "Se confirmó que la imagen ya se genera como JPEG" \
  --detail "No es necesario añadir otra conversión antes de compartir"
```

Tipos válidos:

```text
run | graph | inspect | node | patch | verify | note
```

No conviertas cada comando o lectura en actividad. Publica sólo evidencia que ayude a entender un cambio, una restricción o una decisión observable.

## Control humano de la ejecución (pausar, detener, reanudar)

El humano puede pausar, detener o reanudar una ejecución desde el panel (botones junto al encabezado del mapa) o por CLI:

```sh
hrp run pause <run-id>
hrp run resume <run-id>
hrp run stop <run-id>
```

El servidor rechaza `node start` mientras la ejecución esté pausada o detenida, así que el control aplica a **todos** los agentes por igual (claude, codex, antigravity y ollama). El nodo que ya estaba en curso no se aborta: termina su ciclo o falla.

Conducta esperada del agente:

- **Pausada** (`Run is paused by the human…`): no es un error tuyo. Sondea `hrp state <run-id> --json` (campo `run.control`) o deja corriendo `hrp wait approval`, que sigue esperando y anuncia trabajo solo al reanudarse. Retoma exactamente donde ibas.
- **Detenida** (`Run was stopped by the human…`): cierra ordenadamente — no inicies más nodos, no deshagas trabajo completado, y reporta al humano el avance y lo que quedó pendiente. `hrp wait approval` también sale con este mensaje.
- **Reanudada**: el flujo continúa normal; los nodos completados nunca se ven afectados por el control.

## Reanudación después de una interrupción

HRP conserva proyectos, ejecuciones, nodos y actividad en SQLite. Antes de continuar una tarea interrumpida:

```sh
hrp state "$run_id" --json
```

El adaptador debe:

- conservar los nodos `completed`;
- reanudar o reintentar un nodo `running` o `failed` después de comprobar el workspace;
- no repetir parches ya aplicados;
- continuar los nodos `pending` cuando sus dependencias estén completas;
- publicar como descubierta cualquier diferencia entre el mapa persistido y el trabajo real restante.

En v2 no existe heartbeat del agente. `En vivo` en el panel significa que el navegador está conectado al servicio HRP, no que el agente siga ejecutándose. Por ello, un adaptador reanudado siempre debe consultar `hrp state`.

## Cuándo termina una ejecución

No existe un comando separado `run complete`. El estado se deriva de sus nodos:

- `pending`: aún hay trabajo declarado sin iniciar;
- `running`: al menos un nodo está en curso;
- `failed`: al menos un nodo falló;
- `completed`: todos los nodos terminaron.

Antes de entregar la tarea al humano:

```sh
hrp state "$run_id" --json
```

Confirma que:

- todos los nodos estén `completed`;
- cada nodo tenga diff;
- cada nodo tenga verificación aprobada;
- el mapa incluya los cambios descubiertos;
- el workspace haya pasado la verificación integral apropiada.

## Delegación a Ollama Cloud

HRP puede usar modelos de Ollama Cloud como ejecutores modestos bajo la administración del modelo base: el modelo avanzado planifica, delega el trabajo mecánico y revisa el resultado antes de publicarlo. La API key y el modelo se configuran una sola vez —desde el panel web (icono de ajustes en la barra superior) o con `hrp ollama config --api-key KEY --model MODELO`— y quedan persistidos en el servicio. La key nunca regresa a los clientes: `GET /api/settings/ollama` sólo expone una vista enmascarada, y las llamadas al modelo salen del servidor vía `POST /api/ollama/chat`.

**Nivel de especificidad.** Un nodo con `suggestedAgent: "ollama"` se redacta como **spec delegable a nivel contrato**: firma o punto de inserción exacto, invariantes ("tal bloque queda igual"), casos borde y criterio de verificación — nunca pseudocódigo línea a línea. La delegación paga cuando la spec es corta y la salida larga; si especificar el nodo cuesta casi lo mismo que escribir el código, el nodo no se delega: quédatelo como modelo base. La descripción del nodo es la spec que el humano aprueba y la que `hrp ollama exec` envía al modelo, así que se escribe una sola vez.

Flujo de delegación:

1. Al publicar el grafo, marca con `"suggestedAgent": "ollama"` los nodos mecánicos, repetitivos o de bajo riesgo. HRP los pre-asigna a `ollama` y el humano puede reasignarlos antes de aprobar.
2. Los nodos asignados a `ollama` cuentan como trabajo del **agente base** en `hrp wait approval`: la espera del base regresa en cuanto el humano los aprueba (ollama no abre sesión propia, así que nadie más los reclamará). Tras la aprobación, el modelo base administra cada uno: lo inicia con `hrp node start <run-id> <node-id> --agent ollama` y genera la implementación con:

   ```sh
   hrp ollama exec RUN_ID NODE_ID [--model MODELO] > salida
   ```

   `exec` arma el prompt automáticamente desde el nodo aprobado (título, especificación, motivo y símbolo) más el contenido actual del archivo, y queda auditado en la Actividad («Consulta a ollama (modelo) · N prompt + M respuesta tokens», ligada al nodo). Reserva `hrp ollama run --prompt-file prompt.txt --run RUN_ID --node NODE_ID` para prompts a medida (fragmentos de archivos grandes, contexto de varios archivos); con `run`, pasa siempre `--run` y `--node` para conservar la auditoría.
3. El modelo base revisa el resultado como administrador: corrige lo necesario, aplica el cambio al workspace y publica el diff, la verificación y el cierre como en cualquier nodo. En el `--summary` del parche distingue qué generó ollama y qué ajustó la revisión; `executedBy` queda como `ollama` para que el panel muestre la autoría real.
4. `hrp ollama status` muestra la configuración vigente (key enmascarada, modelo y URL base); `hrp ollama run` reporta por stderr el consumo upstream (tokens de prompt y respuesta), útil para `node complete --tokens`.

Cómo audita el humano lo que corre ollama: la vista **Actividad** registra cada consulta con su modelo y tokens (y a qué nodo pertenece); la tarjeta del nodo muestra `En curso (ollama)` mientras se ejecuta y `por ollama` con su costo al terminar; y `hrp state <run-id> --json` expone `executedBy` y `tokens` por nodo. Ollama no ejecuta nada en la máquina local: cada llamada es una petición HTTP del servicio a Ollama Cloud y no existe ningún proceso local que vigilar.

## Integración directa mediante HTTP

Un agente que no pueda instalar el CLI puede usar la API local.

Base URL:

```text
http://127.0.0.1:4317
```

| Operación | Método y ruta | Cuerpo principal |
| --- | --- | --- |
| Salud | `GET /api/health` | — |
| Listar proyectos y ejecuciones | `GET /api/projects` | — |
| Registrar proyecto | `POST /api/projects` | `{ "workspaceRoot": "/ruta/absoluta" }` |
| Crear ejecución | `POST /api/projects/:projectId/runs` | `{ "title", "requirement" }` |
| Consultar ejecución | `GET /api/runs/:runId` | — |
| Publicar grafo | `POST /api/runs/:runId/graph` | `{ "nodes": [...] }` |
| Descubrir nodo | `POST /api/runs/:runId/nodes` | nodo semántico |
| Anunciar presencia | `POST /api/runs/:runId/agents` | `{ "agent": "codex" }` |
| Aprobar nodos | `POST /api/runs/:runId/approve` | `{ "nodeIds?": [...] }` |
| Asignar nodo | `POST /api/runs/:runId/nodes/:nodeId/assign` | `{ "assignee": "codex" \| null }` |
| Iniciar o reintentar | `POST /api/runs/:runId/nodes/:nodeId/start` | `{ "agent?": "codex" }` |
| Publicar parche | `POST /api/runs/:runId/nodes/:nodeId/patch` | `{ "summary", "rationale?", "diff" }` |
| Publicar verificación | `POST /api/runs/:runId/nodes/:nodeId/verify` | `{ "command", "output", "exitCode" }` |
| Completar nodo | `POST /api/runs/:runId/nodes/:nodeId/complete` | `{}` |
| Publicar actividad | `POST /api/runs/:runId/activity` | `{ "type", "message", "detail?", "nodeId?" }` |
| Eliminar ejecución | `DELETE /api/runs/:runId` | — |
| Eliminar proyecto | `DELETE /api/projects/:projectId` | — |

Ejemplo:

```sh
curl -fsS http://127.0.0.1:4317/api/runs/"$run_id"/nodes/sharing-dependency/patch \
  -H 'content-type: application/json' \
  -d '{
    "summary": "Se añadió la dependencia nativa",
    "rationale": "La versión elegida debe permanecer alineada con el SDK de Expo",
    "diff": "@@ package.json\n+    \"expo-sharing\": \"~14.0.8\""
  }'
```

Actualizaciones en tiempo real:

```text
GET /api/events
GET /api/events?projectId=:projectId
```

El stream usa Server-Sent Events y emite `ready` y `change`. Un adaptador que sólo publica datos no necesita mantener una conexión SSE.

## Pseudocódigo de un adaptador

```text
asegurar_servicio()
project = registrar_workspace(carpeta_actual)
run = crear_ejecucion(project, requerimiento)

graph = inspeccionar_y_descomponer_por_archivo_y_simbolo()
publicar_grafo(run, graph)
informar_al_humano_y_esperar_aprobacion(run)

mientras existan nodos sin terminar:
    node = siguiente_nodo_aprobado_asignado_a_este_agente()
    iniciar(node, identidad_del_agente)
    capturar_estado_anterior(node.file, node.symbol)

    intentar:
        aplicar_cambio(node)
        diff = calcular_diff_exclusivo_del_nodo()
        publicar_parche(node, diff, resumen_real, por_que_se_hizo_asi)
        result = verificar(node)
        publicar_verificacion(node, result)

        si result.paso:
            completar(node)
        si no:
            diagnosticar()
            reintentar_mismo_nodo()
    al descubrir trabajo_nuevo:
        publicar_nodo_descubierto(trabajo_nuevo)
        informar_al_humano_y_esperar_aprobacion(trabajo_nuevo)

consultar_estado(run)
ejecutar_verificacion_integral()
```

## Instrucción reutilizable para otro agente

Puedes entregar este bloque junto con el requerimiento:

```text
Integra esta tarea con Human Review Protocol v2 siguiendo docs/agent-adapter.md.

Trabaja desde la raíz del proyecto. Usa el CLI `hrp` si está disponible y HTTP local como alternativa. Antes de editar, registra el workspace, crea una sola ejecución y publica un grafo granular: un nodo por archivo + símbolo o sección lógica + intención, con dependencias reales.

Después de publicar o descubrir nodos, espera la aprobación humana; no la concedas en nombre del usuario. Declara tu identidad al iniciar, respeta sus asignaciones y ejecuta sólo un nodo a la vez. Para cada nodo aprobado: inicia, aplica únicamente esa operación, publica su diff atribuible junto con qué hizo y por qué se hizo así, ejecuta una verificación y completa. Si falla, corrige y reintenta el mismo nodo; no crees otra ejecución. Publica cualquier trabajo nuevo como nodo descubierto. Conserva razones operativas breves y nunca publiques cadena de pensamiento privada.

Antes de finalizar, consulta el estado y confirma que todos los nodos tengan diff y verificación aprobada.
```

## Checklist de compatibilidad

Un adaptador para Codex, Claude, Gemini u otro agente es compatible cuando:

- [ ] usa el protocolo `2.1` sin depender de conceptos internos del proveedor;
- [ ] espera la aprobación humana después de publicar o descubrir nodos;
- [ ] declara su identidad con `--agent` y respeta las asignaciones del humano;
- [ ] respeta la regla de un nodo en curso por ejecución;
- [ ] registra la carpeta canónica correcta;
- [ ] crea una sola ejecución por requerimiento;
- [ ] publica el grafo antes de modificar archivos;
- [ ] separa símbolos independientes en nodos distintos;
- [ ] publica dependencias reales y sin ciclos;
- [ ] publica un diff atribuible por nodo;
- [ ] conserva por separado qué hará/por qué y qué hizo/por qué se hizo así;
- [ ] publica comando, salida y código de cada verificación;
- [ ] no completa nodos sin diff ni verificación aprobada;
- [ ] reintenta fallos dentro del mismo nodo;
- [ ] añade operaciones descubiertas al mismo mapa;
- [ ] puede reconstruir su trabajo mediante `hrp state`;
- [ ] no solicita ni almacena cadena de pensamiento;
- [ ] termina con todos los nodos completados y una verificación integral del workspace.

## Alcance actual de v2

HRP 2.1 es local y añade el gate de aprobación humana, la asignación de nodos por agente y la ejecución serializada (un nodo en curso por ejecución). No incluye heartbeat, autenticación, identidad verificada de agentes (la declaración `--agent` es de buena fe) ni adaptadores oficiales por proveedor. Esas capacidades pueden añadirse alrededor del protocolo sin cambiar la identidad de los nodos ni la evidencia requerida.
