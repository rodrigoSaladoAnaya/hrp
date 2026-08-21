# Integración de agentes con HRP v3

Este documento es el contrato de integración para conectar un agente de programación —Codex, Claude, Gemini o cualquier implementación propia— con Human Review Protocol v3 (protocolo 3.0).

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

- HRP v3 instalado y compilado.
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
Protocolo: 3.0
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

**Aristas por archivo compartido.** Si un nodo toca el mismo archivo o símbolo que otro nodo de la ejecución, declara la dependencia aunque los cambios sean conceptualmente independientes: sin esa arista el grafo autoriza un orden de aplicación que rompe los parches y falsea la causalidad que el humano lee en el mapa. Aplica igual a los nodos descubiertos, que dependen del nodo cuyo código modifican.

**Diffs atribuibles.** El diff de un nodo debe contener sólo lo que ese nodo hizo. Cuando otro nodo de la ejecución ya modificó ese archivo y el trabajo aún no está confirmado en git, `git diff` contra `HEAD` devuelve un diff acumulado que le atribuye a este nodo cambios ajenos. Copia el archivo antes de editarlo y publica el diff contra esa copia:

```sh
cp src/server/store.ts /tmp/store.before        # antes de editar
# ...editar...
diff -u /tmp/store.before src/server/store.ts \
  --label a/src/server/store.ts --label b/src/server/store.ts > patch.diff
```

Lo mismo vale cuando otro agente trabaja en paralelo sobre ese archivo: la copia previa delimita tu autoría.

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
- `contextFiles` (opcional) lista archivos del workspace que `hrp ollama exec` adjuntará al prompt como **referencia de solo lectura**. Es parte de la semántica aprobada: el inspector lo muestra antes de aprobar, y cambiarlo en una republicación regresa el nodo a «por aprobar».

### 4b. Seleccionar auditores y esperar la aprobación humana

Todo nodo publicado o descubierto nace **sin aprobar** y el servidor rechaza su inicio hasta que el humano da el visto bueno. Antes de aprobar, el panel pide elegir qué modelos auditarán esa ejecución en la sección **Agentes**. La selección es propia del run —configurar Ollama no lo vuelve auditor global— y se congela al aprobar el primer nodo para conservar una política estable durante toda la ejecución.

Después de elegir al menos un auditor, el humano autoriza desde el panel (botón «Aprobar grafo» o la aprobación individual del inspector) o por CLI:

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

La presencia no equivale a actividad. HRP actualiza automáticamente el estado observable cuando un agente inicia, falla o completa un nodo. Durante una auditoría larga, el adaptador debe publicar hitos operativos —nunca cadena de pensamiento— para que el humano vea qué hace, cuánto lleva y qué falta:

```sh
hrp agent status "$run_id" \
  --agent codex \
  --phase reviewing \
  --summary "Auditando contratos entre backend y CLI" \
  --completed 2 --total 5 \
  --reviewed nodo-a,nodo-b \
  --remaining nodo-c,nodo-d,nodo-e
```

Fases válidas: `idle`, `waiting`, `executing`, `reviewing`, `completed` y `failed`. `summary` y `detail` describen la etapa externa o el artefacto actual; no deben revelar razonamiento privado. Al cerrar la revisión publica `phase completed` con la cobertura final.

Ollama Cloud publica estos estados automáticamente. Mientras Kimi u otro modelo no haya respondido, el panel muestra el paquete enviado y mantiene sus nodos como **cobertura no confirmada**; HRP no finge avance interno que la API no expone. Cuando llega la respuesta, confirma la cobertura y registra los hallazgos o el resultado limpio.

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

**Aprobar en pausa.** El banner de aprobación ofrece dos caminos: «Aprobar grafo» autoriza y los agentes arrancan de inmediato, y «Aprobar en pausa» autoriza el plan dejando la ejecución pausada — el humano asigna nodos, copia las instrucciones de cada agente y abre sus sesiones con calma, y reanuda cuando todo esté conectado. Los agentes en `hrp wait approval` ven la pausa y esperan sin abandonar.

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

Confirma —leyendo el JSON de `hrp state`, no releyendo tu trabajo— que:

- todos los nodos estén `completed`, cada uno con diff y verificación aprobada;
- el mapa incluya los cambios descubiertos;
- el workspace haya pasado **una sola vez** la verificación ejecutable integral (tests/build del proyecto: la corre la máquina, no tu juicio);
- `hrp review gate "$run_id"` pase (código 0): una ejecución con hallazgos vivos de la revisión no puede darse por cerrada.

**El base no se re-verifica.** El cierre no incluye releer tus propios diffs ni una pasada de auto-auditoría: el mismo modelo que escribió el código tiene sus mismos puntos ciegos y esa relectura cuesta casi tanto como la autoría. La pasada final de calidad pertenece a los revisores (ver «Diversidad del revisor»). Resolver los hallazgos del debate y correr el gate son cierre administrativo, no re-verificación.

### Diversidad del revisor

Lo que la v3.1 elimina es que **la misma sesión que escribió el código se audite a sí misma**: comparte los puntos ciegos de la autoría y su relectura cuesta casi tanto como escribirla. A partir de ahí, la diversidad tiene grados:

1. **Preferente** — un modelo distinto al base. Aporta diversidad de modelo y de contexto; es lo que cubre la auditoría automática de Ollama Cloud.
2. **Aceptable** — otra sesión del mismo modelo que el base. No comparte el contexto de autoría y sí detecta errores de integración y desviaciones spec↔diff, pero es un escalón más débil: quien revise así debe declararlo en el hallazgo (por ejemplo, `--reviewer claude-revisor`).
3. **Prohibida** — la sesión autora auditando su propio trabajo, en cualquier forma.

Cuando el humano sólo dispone de sesiones del modelo base, la combinación correcta es el auditor automático de ollama —que aporta la diversidad de modelo— más un revisor con sesión del nivel 2, que aporta la de contexto. Los auditores elegidos para la ejecución quedan registrados en `run.auditors`.

## Revisión multi-modelo (protocolo v3)

El objetivo de la v3 es la calidad del producto, no el ahorro de tokens: otros modelos actúan como **revisores y auditores** del trabajo del agente base, y sus hallazgos abren un debate que termina en acuerdo o en arbitraje humano. La ejecución conserva todo el ciclo v2 (grafo, gate, evidencia por nodo); la revisión se monta encima de esa evidencia.

### Cuándo se revisa

- **Checkpoint por flujo**: al completarse una cadena de dependencias (un flujo funcional), el base lanza por sí mismo la revisión de ese subárbol (`hrp ollama review <run-id> --node <nodo-hoja>`, o genera `hrp review pack <run-id> --node <nodo-hoja>` para que el humano lo copie a otro modelo con sesión). Revisar el flujo integrado —y no nodo por nodo— es deliberado: los errores valiosos para un segundo modelo son los de integración, y el gate por nodo duplicaría ceremonia y serializaría la ejecución.
- **Auditoría final automática**: al quedar todos los nodos completados, el servidor lanza solo la auditoría del run completo (ver «Auditoría automática al completar»); nadie tiene que pedirla.
- Los hallazgos **no bloquean nodos individuales**; bloquean el **cierre del run**: `hrp review gate <run-id>` sale con código 1 mientras existan hallazgos en `open`, `debating` o `escalated`.

### Contrato del modelo revisor

El humano convierte en revisor a cualquier modelo con sesión —preferentemente distinto al base, o una sesión distinta del mismo modelo según la jerarquía de «Diversidad del revisor»— copiándole el paquete de `hrp review pack <run-id>` (o el botón «Copiar paquete de revisión» del panel). El paquete incluye el requisito, el grafo, los hallazgos ya reportados y, por nodo completado, la spec aprobada, el diff y la verificación. El revisor:

- permanece en `hrp wait approval <run-id> --agent SU_NOMBRE` hasta recibir **Auditoría disponible**; esa señal sólo aparece cuando todos los nodos están completos y nunca le entrega nodos sin asignar del modelo base;
- publica `phase reviewing` antes de leer el paquete y actualiza `--completed`, `--reviewed` y `--remaining` durante una auditoría larga;
- audita buscando **errores de integración entre nodos, contratos rotos, desviaciones entre la spec aprobada y el diff aplicado, y casos borde sin cubrir**;
- reporta cada problema con `hrp finding add <run-id> --title T --body B --severity critical|major|minor|question [--node ID] --reviewer SU_NOMBRE`;
- debate las respuestas del base con `hrp finding reply <finding-id> --author SU_NOMBRE --body ...`, con argumentos técnicos y citas al diff;
- sólo publica `phase completed` cuando `--reviewed` cubre todos los nodos y `--remaining` queda vacío; después vuelve a `hrp wait approval`, porque una corrección completada puede abrir otra pasada;
- **nunca edita código**: su salida son hallazgos y debate;
- si no encuentra nada real, lo dice; inventar hallazgos para rellenar contamina el debate y el registro.

### Contrato del agente base (autoridad v3.1)

Quien autoriza los cambios del debate es el **agente base**; el humano es monitor. En concreto:

- `hrp wait approval` avisa cuando hay hallazgos cuyo último turno no es del base; atenderlos tiene prioridad sobre iniciar nodos nuevos.
- Cada hallazgo se **resuelve con autoridad propia**: si procede, el base lo acepta creando el nodo de corrección como trabajo descubierto (`hrp node discover`) y lo vincula con `hrp finding accept <id> --resolution-node NODO` — **la aceptación autoriza el nodo de corrección** (queda aprobado en el acto, sin clic humano); si no procede, lo **rechaza** con `hrp finding reject`, también frente a revisores sin sesión, dejando la razón técnica en el hilo (spec, requisito o evidencia ejecutable, nunca autoridad).
- `hrp finding escalate` es un **recurso opcional** para dudas genuinas que el base no puede resolver con evidencia (ambigüedad del requisito, decisiones de producto); ya no es la salida obligada del desacuerdo.
- `hrp finding reject` exige `--author` y `--body`: la razón del descarte queda en el hilo antes del cambio de estado. Un rechazo sin argumento técnico verificable es un abuso de la autoridad del base.
- La implementación completa no equivale al cierre: el base permanece en `hrp wait approval` mientras cualquier elemento de `run.auditors` siga en `waiting`, `reviewing` o `failed`. `hrp review gate` falla tanto por hallazgos vivos como por `pendingAuditors`, y sólo pasa cuando todos publicaron `completed`.
- El gate humano **inicial** del grafo se mantiene: la autoridad del base cubre el ciclo de revisión, no el plan de la ejecución.

### El humano como monitor: la segunda corrida

El humano observa los hallazgos y sus hilos en el panel (insignias «En debate», vista Hallazgos) y puede intervenir cuando quiera — terciar en un hilo, aceptar o rechazar por encima del base. Si al revisar el resultado final objeta una resolución del base, la objeción se materializa como una **segunda corrida**: una ejecución nueva cuyo requisito cita el hallazgo o la decisión objetada y cuyos nodos aplican la corrección, pasando por el ciclo completo de evidencia y revisión.

### Auditoría automática al completar

Cuando todos los nodos de una ejecución quedan `completed`, el servidor lanza por sí solo la auditoría del run con el modelo de Ollama configurado (mismo contrato del revisor estricto: temperatura 0, `NECESITO`, `SIN-HALLAZGOS`, registro todo-o-nada). Un candado por estado de nodos completados evita repetirla; los nodos descubiertos que se completen después re-disparan otra pasada solo sobre el estado nuevo. Todo desenlace —hallazgos, sin hallazgos, omisión por falta de configuración o fallo— queda anotado en la Actividad. `hrp ollama review` sigue disponible para pasadas manuales o por subárbol (`--node`).

### Revisor automático (Ollama Cloud)

`hrp ollama review <run-id> [--node ID]` audita el paquete con el modelo configurado a temperatura 0: responde un arreglo JSON de hallazgos o el literal `SIN-HALLAZGOS`, puede pedir contexto con `NECESITO:` en lugar de suponer, y el registro es todo-o-nada (un lote malformado no registra nada). Los hallazgos quedan como `reviewer: ollama:<modelo>` y la consulta se audita en Actividad con sus tokens.

### Arbitraje humano

La vista **Hallazgos** del panel muestra cada hallazgo con su hilo completo (revisor, base y humano distinguibles); el humano puede terciar como `human`, **Aceptar**, o **Rechazar** dejando la razón obligatoria en el hilo. Los hallazgos escalados resaltan y generan un aviso en el run y las insignias «En debate» en el árbol de proyectos, visibles aun con los proyectos colapsados.

## Delegación a Ollama Cloud

HRP puede usar modelos de Ollama Cloud como ejecutores modestos bajo la administración del modelo base: el modelo avanzado planifica, delega el trabajo mecánico y revisa el resultado antes de publicarlo. La API key y el modelo se configuran una sola vez —desde el panel web (icono de ajustes en la barra superior) o con `hrp ollama config --api-key KEY --model MODELO`— y quedan persistidos en el servicio. La key nunca regresa a los clientes: `GET /api/settings/ollama` sólo expone una vista enmascarada, y las llamadas al modelo salen del servidor vía `POST /api/ollama/chat`.

**Cuándo sugerir ollama: criterio económico.** La delegación se decide por costo, no solo por mecanicidad. El ahorro de un nodo delegado es aproximadamente `salida que el modelo base no escribe − (spec + revisión fiel + ~1k de ceremonia por nodo)`. Sugiere `ollama` únicamente en nodos tipo **fábrica** con cuenta positiva: salida mecánica o de patrón estimada en ≥ ~2-3k tokens, o nodos que pertenecen a una serie de 3 o más hermanos del mismo patrón, donde la spec y la revisión se amortizan (pantallas CRUD, migraciones formulaicas, tests desde tablas, fixtures, datos). **Nunca** delegues núcleo creativo, de diseño o seguridad aunque sea especificable: revisarlo fielmente cuesta igual o más que escribirlo (medido en el experimento de 4 estrategias: la delegación total fue la más cara en tokens del modelo base). En caso de duda, el nodo se queda con el modelo base.

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

**Exactitud del modelo delegado.** Los modelos modestos alucinan cuando les falta información y el formato los obliga a responder completo. HRP ataca las dos causas:

- **Firmas o contexto, siempre.** Todo símbolo externo que una spec delegada mencione lleva su contrato exacto en la descripción (qué recibe, qué devuelve) **o** su archivo declarado en `contextFiles`, que `exec` adjunta como secciones `REFERENCIA (solo lectura)`. Nunca pidas documentar o usar algo que el modelo no puede ver.
- **Protocolo NECESITO.** El prompt de `exec` autoriza al modelo a responder una sola línea `NECESITO: <qué falta>` en lugar de inventar. Ante esa respuesta, `exec` falla con guía; el agente base enriquece la descripción o el `contextFiles`, republica (el nodo vuelve al gate de aprobación) y reintenta. Nunca completes un nodo con contenido que el modelo produjo inventando contratos.
- **Determinismo.** El proxy fija `temperature: 0` en las consultas delegadas: mismo nodo y misma spec producen la misma salida, lo que hace reproducible la auditoría.
- **Verificación ejecutable, sin excepciones.** Un nodo delegado nunca se completa con una verificación de «se ve bien»: el código ejecuta sus casos y la documentación ejecuta sus ejemplos contra el código real. La alucinación que sobreviva a la revisión del agente base debe morir en `verify`.

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

Puedes entregar este bloque junto con el requerimiento (es la misma plantilla de doble rol que copia el panel por agente):

```text
Integra esta tarea con Human Review Protocol v3 siguiendo docs/agent-adapter.md. Tienes doble rol: ejecutor y revisor.

Como ejecutor, trabaja desde la raíz del proyecto. Usa el CLI `hrp` si está disponible y HTTP local como alternativa. Antes de editar, registra el workspace, crea una sola ejecución y publica un grafo granular: un nodo por archivo + símbolo o sección lógica + intención, con dependencias reales.

Después de publicar o descubrir nodos, espera la aprobación humana; no la concedas en nombre del usuario. Declara tu identidad al iniciar, respeta sus asignaciones y ejecuta sólo un nodo a la vez. Para cada nodo aprobado: inicia, aplica únicamente esa operación, publica su diff atribuible junto con qué hizo y por qué se hizo así, ejecuta una verificación y completa. Si falla, corrige y reintenta el mismo nodo; no crees otra ejecución. Publica cualquier trabajo nuevo como nodo descubierto. Conserva razones operativas breves y nunca publiques cadena de pensamiento privada.

Como revisor, audita el trabajo completado por los demás agentes: obtén el contexto con `hrp review pack <run-id>`, busca errores de integración y desviaciones entre la spec aprobada y el diff, registra cada problema con `hrp finding add <run-id> --title T --body B --severity critical|major|minor|question [--node ID] --reviewer TU_NOMBRE` y debate con `hrp finding reply <finding-id> --author TU_NOMBRE --body ...`. Como revisor nunca edites código ajeno y no inventes hallazgos: decir que no encontraste nada es una respuesta valiosa. Nunca audites tus propios nodos: el auditor no es el autor.

Antes de finalizar, consulta el estado, confirma que todos los nodos tengan diff y verificación aprobada, atiende los debates que te mencionen y verifica el cierre con `hrp review gate <run-id>`.
```

## Checklist de compatibilidad

Un adaptador para Codex, Claude, Gemini u otro agente es compatible cuando:

- [ ] usa el protocolo publicado por `PROTOCOL_VERSION` sin depender de conceptos internos del proveedor;
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

## Alcance actual de v3

HRP 3.0 es local y añade, sobre el ciclo v2 (gate de aprobación humana, asignación de nodos por agente, ejecución serializada, delegación a Ollama Cloud), la revisión multi-modelo: hallazgos con hilo de debate entre revisor y base, arbitraje humano en el panel y `review gate` que impide cerrar una ejecución con hallazgos vivos. No incluye heartbeat, autenticación, identidad verificada de agentes (la declaración `--agent` es de buena fe) ni adaptadores oficiales por proveedor. Esas capacidades pueden añadirse alrededor del protocolo sin cambiar la identidad de los nodos ni la evidencia requerida.
