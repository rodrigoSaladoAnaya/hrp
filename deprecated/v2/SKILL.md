---
name: hrp
description: Integra tareas de programación con Human Review Protocol v2 (HRP), publicando evidencia observable (grafo de operaciones, diffs por nodo, verificaciones) al servicio local hrp mientras se implementa. Usa esta skill siempre que el usuario mencione HRP, "Human Review Protocol", el CLI hrp, el panel de revisión, o pida implementar/trabajar una tarea "con hrp", "usando hrp", "publicando evidencia", "con revisión humana" o invocando /hrp — aunque la tarea de fondo sea cualquier cambio de código normal.
---

# Adaptador HRP v2 para Claude

Traduce el ciclo de trabajo normal de programación al protocolo HRP v2: cada operación semántica se declara antes de ejecutarse, y cada cambio deja evidencia (diff + verificación) que un humano puede revisar en el panel. HRP no ejecuta nada por ti: tú haces el trabajo y publicas la evidencia con el CLI `hrp`.

El contrato completo está en [references/agent-adapter.md](references/agent-adapter.md). Léelo si necesitas la API HTTP (cuando el CLI no esté disponible), el detalle de reanudación, o resolver un caso que este resumen no cubra.

## Regla de oro: granularidad

Un nodo del grafo es exactamente `archivo + símbolo o sección lógica + intención`:

- Correcto: `src/preferences.ts` + `saveTheme` + persistir la apariencia elegida.
- Incorrecto: "implementar el backend", un nodo por fase ("codificar", "probar"), o un solo nodo para un archivo donde cambiarán tres funciones independientes.

Dos cambios independientes en el mismo archivo son dos nodos. Un cambio transversal de un solo símbolo es un nodo aunque toque muchas líneas. Las dependencias entre nodos expresan prerrequisitos reales, nunca secuencia decorativa.

## Qué publicar y qué no

Publica explicaciones operativas breves y comprobables: qué cambia el nodo, por qué es necesario, qué diff aplicó, qué comando lo verificó, qué restricción nueva apareció.

Nunca publiques cadena de pensamiento privada, deliberaciones internas, secretos/credenciales, ni logs completos que no ayuden a entender el cambio.

## Flujo

Ejecuta todo desde la raíz del proyecto observado (el workspace del usuario).

### 0. Servicio y registro

```sh
hrp service status || hrp service start
project_id=$(hrp attach . --json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).id")
```

`attach` es idempotente: registrar una carpeta ya registrada devuelve el mismo proyecto.

### 1. Una ejecución por requerimiento humano

```sh
run_id=$(hrp run create --project "$project_id" \
  --title "Título corto" \
  --requirement "El requerimiento humano original, resumido sin cambiar su intención" \
  --json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).id")
```

No crees otra ejecución por archivo, reintento o descubrimiento. Solo hay una nueva ejecución si el humano formula un requerimiento distinto o abandona explícitamente el planteamiento anterior.

### 2. Inspecciona y publica el grafo ANTES de editar

Lee el código suficiente para descomponer la tarea en nodos. Escribe el grafo en un archivo temporal (usa tu scratchpad, no el workspace) y publícalo:

```json
{
  "nodes": [
    {
      "id": "kebab-o-snake-unico",
      "file": "ruta/relativa/al/workspace.ts",
      "symbol": "Clase.metodo | clave.de.config | sección lógica",
      "title": "Qué hace, corto",
      "description": "Qué hará exactamente este nodo.",
      "rationale": "Por qué es necesario para el requerimiento.",
      "dependencies": ["ids-de-prerrequisitos-reales"]
    }
  ]
}
```

```sh
hrp graph publish "$run_id" /ruta/temporal/graph.json --agent claude
```

Los ids: únicos, estables, solo `[A-Za-z0-9_-]`. Sin ciclos; toda dependencia debe existir.

`--agent claude` te registra como **modelo base** de la ejecución: ejecutas por defecto todos los nodos sin asignación, y los nodos que descubras se te asignan automáticamente para que el proceso no espere a otro agente.

Como modelo base también decides qué conviene delegar, con un criterio **económico**, no solo de mecanicidad. Sugiere `"suggestedAgent": "ollama"` únicamente en nodos tipo **fábrica** y solo cuando la cuenta salga positiva:

```
ahorro del nodo ≈ salida que no escribes − (spec + revisión fiel + ~1k de ceremonia)
```

- **Sí delega**: salida mecánica o de patrón con spec-contrato corta y salida estimada ≥ ~2-3k tokens (boilerplate, datos, fixtures, migraciones formulaicas), o un nodo que pertenece a una **serie de 3+ hermanos del mismo patrón**, donde la spec y la revisión se amortizan (pantallas CRUD, tests desde tabla de casos, configs por ambiente).
- **Nunca delegues** nodos creativos, de diseño, seguridad o núcleo novedoso, **aunque puedas especificarlos**: revisarlos fielmente cuesta igual o más que escribirlos (medido: delegar un motor de juego completo consumió más tokens del modelo base que la autoría directa).
- En caso de duda, quédatelo: el modelo más capaz ataca lo creativo; ollama fabrica lo repetitivo.

HRP pre-asigna a `ollama` los nodos sugeridos y el humano confirma o reasigna al aprobar.

### 2b. Espera la aprobación humana (protocolo 2.1)

Todo nodo publicado o descubierto nace **sin aprobar** y el servidor rechaza `node start` hasta el visto bueno del humano (botón «Aprobar grafo» del panel, o `hrp node approve <run-id>`). Tras publicar el grafo, espera el clic del humano con el comando bloqueante:

```sh
hrp wait approval "$run_id" --agent claude --timeout 300
```

Sale con éxito en cuanto exista trabajo aprobado disponible para ti; si agota el timeout, vuelve a ejecutarlo o pregunta al humano. Así el humano solo da un clic y tú continúas solo. No apruebes tú mismo con el CLI: la aprobación es del humano.

El humano puede asignar nodos a agentes concretos. Tu identidad es `claude`: trabaja solo nodos asignados a `claude` o sin asignar, y decláralo al iniciar.

### 3. Ciclo por nodo: start → editar → patch → verify → complete

Elige siempre un nodo aprobado cuyas dependencias estén completadas (HRP rechaza `start` si no lo están). Solo puede haber un nodo en curso por ejecución: si el inicio se rechaza por otro nodo en vuelo, espera a que termine.

```sh
hrp node start "$run_id" <node-id> --agent claude
```

**Captura el estado previo antes de editar.** El diff publicado debe contener solo el cambio de este nodo, no el acumulado del workspace. Si el nodo es el único cambio pendiente del archivo, `git diff -- <archivo>` basta. Si varios nodos tocan el mismo archivo, copia el archivo a tu scratchpad antes de editar y compara después:

```sh
cp ruta/archivo.ts /ruta/scratchpad/<node-id>.before
# ...editar...
diff -u /ruta/scratchpad/<node-id>.before ruta/archivo.ts > /ruta/scratchpad/<node-id>.diff || true
```

Aplica la modificación con tus herramientas normales de edición y publica la evidencia. El resumen describe lo que realmente ocurrió — no copies la descripción planeada sin comprobarla:

```sh
hrp patch publish "$run_id" <node-id> \
  --summary "Lo que realmente se cambió" \
  --diff-file /ruta/scratchpad/<node-id>.diff
```

Verifica con el comando más pequeño que demuestre el nodo (sin omitir verificaciones integrales cuando hagan falta), y completa:

```sh
hrp verify run "$run_id" <node-id> -- <comando de verificación>
hrp node complete "$run_id" <node-id>
```

`verify run` publica comando, salida y código de salida, y devuelve el mismo código que el proceso. Un nodo solo puede completarse con diff no vacío y su verificación más reciente aprobada.

Si tu entorno te muestra el presupuesto de tokens restante (por ejemplo `<total_tokens>` en los resultados de herramienta), calcula el delta consumido durante el nodo y repórtalo al completar: `hrp node complete "$run_id" <node-id> --tokens <delta>`. Es aproximado pero real; si no puedes medirlo, omite el parámetro — nunca inventes el número.

### 3b. Nodos asignados a ollama: delega y revisa como administrador

Un nodo asignado a `ollama` no espera a otra sesión: tú lo administras, y `hrp wait approval` ya lo cuenta como trabajo tuyo (regresa en cuanto el humano lo aprueba). El ciclo es el mismo, pero la generación del cambio se delega al modelo configurado de Ollama Cloud:

```sh
hrp node start "$run_id" <node-id> --agent ollama
hrp ollama exec "$run_id" <node-id> > /ruta/scratchpad/salida.txt
```

`exec` arma el prompt automáticamente con la descripción aprobada del nodo, sus `contextFiles` como referencia de solo lectura y el contenido actual del archivo — no redactes un prompt artesanal que duplique la spec. Usa `hrp ollama run --prompt-file ... --run "$run_id" --node <node-id>` solo cuando necesites un prompt a medida (fragmentos de un archivo grande), siempre con `--run`/`--node` para conservar la auditoría. Ambas vías quedan registradas en la Actividad con modelo y tokens.

Si `exec` falla con **«Ollama necesita más contexto — NECESITO: ...»**, el protocolo funcionó: el modelo pidió lo que le faltaba en vez de inventarlo. Enriquece la descripción o los `contextFiles` del nodo, republica el grafo (el nodo vuelve al gate de aprobación) y reintenta. Nunca completes el nodo con una salida donde el modelo haya supuesto contratos.

La verificación de un nodo delegado es **ejecutable sin excepciones**: el código corre sus casos y la documentación ejecuta sus ejemplos contra el código real («se ve bien» no es verificación).

Después actúas como revisor: valida la salida, corrige lo que haga falta, aplica el cambio al workspace con tus herramientas y sigue el ciclo normal (patch → verify → complete). En el `--summary` del parche distingue qué generó ollama y qué corregiste tú. `hrp ollama run` reporta por stderr los tokens de prompt/respuesta del modelo delegado: úsalo para `--tokens` al completar. Nunca completes un nodo delegado sin haber revisado y verificado su resultado; si la salida es inservible, corrígela tú mismo y anótalo en el resumen.

### 4. Fallos: reintenta el MISMO nodo

Si la verificación falla, el nodo queda `failed` y sus dependientes bloqueados. Diagnostica, corrige, y:

```sh
hrp node retry "$run_id" <node-id> --agent claude
# aplicar la corrección, capturar nuevo diff
hrp patch publish "$run_id" <node-id> --summary "Qué se corrigió" --diff-file <nuevo.diff>
hrp verify run "$run_id" <node-id> -- <comando>
hrp node complete "$run_id" <node-id>
```

Captura el fallo de `verify run` (con `if`/`||`) en lugar de dejar que aborte el flujo. Opcionalmente publica una actividad `inspect` explicando qué se investigará.

### 5. Trabajo descubierto

Si durante la implementación aparece una operación que no estaba en el grafo, no la escondas en el nodo actual ni abras otra ejecución. Publícala como nodo descubierto (mismo formato de nodo, en un JSON temporal):

```sh
hrp node discover "$run_id" /ruta/temporal/discovered.json
```

**Triaje del ejecutor en el momento.** Si ollama está activo y configurado (consulta `hrp ollama status --json` una vez por sesión y recuérdalo), decide antes de publicar cada descubierto quién debería implementarlo con el mismo criterio económico del triaje inicial: si es tipo fábrica y la cuenta sale positiva (salida ≥ ~2-3k tokens o serie de 3+ del mismo patrón), inclúyele `"suggestedAgent": "ollama"` en el JSON; si implica diseño, seguridad, integración delicada, ambigüedad o simplemente no da el umbral, no pongas sugerencia y quedará asignado a ti como modelo base. Así el modelo avanzado se reserva para el trabajo de alto valor en lugar de gastarse en lo trivial.

**Regla de la spec delegable.** Un nodo sugerido para ollama se redacta con la descripción como **spec a nivel contrato** — firma o punto de inserción exacto, invariantes («tal bloque queda igual»), casos borde y criterio de verificación — nunca pseudocódigo línea a línea. La delegación paga cuando la spec es corta y la salida larga; si describir el nodo te cuesta casi lo mismo que escribir el código, no lo sugieras para ollama: quédatelo. Esa descripción es la que el humano aprueba y la que `hrp ollama exec` enviará tal cual al modelo, así que se escribe una sola vez.

**Firmas o contexto, siempre.** Si la spec delegada menciona símbolos que viven en **otros archivos** (funciones, tipos, formatos), incluye su contrato exacto en la descripción o declara esos archivos en `"contextFiles": ["ruta.ts"]` del nodo: `exec` los adjunta como referencia de solo lectura. Un modelo al que le ordenas usar algo que no puede ver no se detiene: lo inventa. El contexto es semántica aprobada — cambiarlo republica el nodo al gate del humano.

**No detengas la implementación por un descubierto.** El nodo descubierto espera la aprobación humana antes de poder iniciarse, pero esa espera no debe frenar el flujo: publícalo y continúa de inmediato con los nodos ya aprobados cuyas dependencias estén completas. Ejecuta `hrp wait approval` solo cuando ya no te quede ningún nodo aprobado disponible, agrupando en una sola espera todos los descubiertos pendientes.

Después síguele el ciclo normal start → patch → verify → complete (con la sección 3b si quedó asignado a ollama). Si el descubrimiento cambia dependencias de nodos aún pendientes, vuelve a publicar el grafo completo actualizado. Nunca cambies la semántica de un nodo ya terminado.

### 6. Actividad secundaria (con moderación)

Para observaciones que no son operaciones de cambio pero ayudan a entender una decisión o restricción:

```sh
hrp activity publish "$run_id" --type inspect --node <node-id> \
  --summary "Observación breve" --detail "Contexto opcional"
```

Tipos: `run | graph | inspect | node | patch | verify | note`. No conviertas cada lectura o comando en actividad.

## Control humano: pausada o detenida

El humano puede pausar, detener o reanudar la ejecución (panel o `hrp run pause|resume|stop`). El servidor rechaza `node start` en esos estados para todos los agentes; no es un error tuyo:

- Rechazo por **pausa** (`Run is paused by the human…`): espera sin abandonar — sondea `hrp state <run-id> --json` (campo `run.control`) o deja corriendo `hrp wait approval`, y al reanudarse retoma exactamente donde ibas.
- Rechazo por **detención** (`Run was stopped by the human…`): cierra ordenadamente — no inicies más nodos, conserva lo completado y reporta al humano el avance y lo pendiente.

## Reanudación

Si retomas una tarea interrumpida, consulta primero el estado persistido:

```sh
hrp state "$run_id" --json
```

Conserva los `completed`, comprueba el workspace antes de reanudar/reintentar `running`/`failed`, no repitas parches ya aplicados, y publica como descubierta cualquier diferencia entre el mapa persistido y el trabajo real restante. "En vivo" en el panel indica navegador conectado, no agente vivo — siempre consulta `hrp state`.

## Antes de entregar al humano

No existe `run complete`; el estado se deriva de los nodos. Consulta `hrp state "$run_id" --json` y confirma:

- todos los nodos `completed`, cada uno con diff y verificación aprobada;
- el mapa incluye los nodos descubiertos;
- el workspace pasó la verificación integral apropiada (tests/build del proyecto).

Después reporta al usuario el resultado como harías normalmente, mencionando que la evidencia quedó publicada en HRP.
