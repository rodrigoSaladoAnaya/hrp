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
Protocolo: 2.0
```

El servicio es local y no tiene autenticación. No debe exponerse directamente a una red pública.

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
hrp graph publish "$run_id" graph.json
```

Requisitos del grafo:

- los identificadores son únicos y estables dentro de la ejecución;
- sólo contienen letras, números, guion o guion bajo;
- todas las dependencias existen;
- no hay ciclos;
- `file` es relativo al workspace;
- `symbol` identifica el método, componente, clave o sección lógica real;
- `description` explica qué hará;
- `rationale` explica por qué existe.

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
hrp node complete "$run_id" sharing-dependency
```

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
| Iniciar o reintentar | `POST /api/runs/:runId/nodes/:nodeId/start` | `{}` |
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

mientras existan nodos sin terminar:
    node = siguiente_nodo_con_dependencias_completas()
    iniciar(node)
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

consultar_estado(run)
ejecutar_verificacion_integral()
```

## Instrucción reutilizable para otro agente

Puedes entregar este bloque junto con el requerimiento:

```text
Integra esta tarea con Human Review Protocol v2 siguiendo docs/agent-adapter.md.

Trabaja desde la raíz del proyecto. Usa el CLI `hrp` si está disponible y HTTP local como alternativa. Antes de editar, registra el workspace, crea una sola ejecución y publica un grafo granular: un nodo por archivo + símbolo o sección lógica + intención, con dependencias reales.

Para cada nodo: inicia, aplica únicamente esa operación, publica su diff atribuible junto con qué hizo y por qué se hizo así, ejecuta una verificación y completa. Si falla, corrige y reintenta el mismo nodo; no crees otra ejecución. Publica cualquier trabajo nuevo como nodo descubierto. Conserva razones operativas breves y nunca publiques cadena de pensamiento privada.

Antes de finalizar, consulta el estado y confirma que todos los nodos tengan diff y verificación aprobada.
```

## Checklist de compatibilidad

Un adaptador para Codex, Claude, Gemini u otro agente es compatible cuando:

- [ ] usa el protocolo `2.0` sin depender de conceptos internos del proveedor;
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

HRP v2 es automático y local. No incluye gates humanos, aprobaciones, pausa del agente, heartbeat, autenticación ni adaptadores oficiales por proveedor. Esas capacidades pueden añadirse alrededor del protocolo sin cambiar la identidad de los nodos ni la evidencia requerida.
