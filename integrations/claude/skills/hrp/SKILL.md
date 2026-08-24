---
name: hrp
description: Integra tareas de programación con Human Review Protocol v3 (HRP), publicando evidencia observable (grafo de operaciones, diffs por nodo, verificaciones) al servicio local hrp mientras se implementa, y atendiendo el debate con los modelos revisores. Usa esta skill siempre que el usuario mencione HRP, "Human Review Protocol", el CLI hrp, el panel de revisión, o pida implementar/trabajar una tarea "con hrp", "usando hrp", "publicando evidencia", "con revisión humana" o invocando /hrp — aunque la tarea de fondo sea cualquier cambio de código normal.
---

# Adaptador HRP v3 para Claude

Traduce el ciclo de trabajo normal de programación al protocolo HRP v3: cada operación semántica se declara antes de ejecutarse, cada cambio deja evidencia (diff + verificación) que un humano puede revisar en el panel, y otros modelos auditan tu trabajo en un debate que tú, como agente base, estás obligado a atender. HRP no ejecuta nada por ti: tú haces el trabajo y publicas la evidencia con el CLI `hrp`.

El contrato completo está en [references/agent-adapter.md](references/agent-adapter.md). Léelo si necesitas la API HTTP (cuando el CLI no esté disponible), el detalle de reanudación, o resolver un caso que este resumen no cubra.

## Regla de oro: granularidad

Un nodo del grafo es exactamente `archivo + símbolo o sección lógica + intención`:

- Correcto: `src/preferences.ts` + `saveTheme` + persistir la apariencia elegida.
- Incorrecto: "implementar el backend", un nodo por fase ("codificar", "probar"), o un solo nodo para un archivo donde cambiarán tres funciones independientes.

Dos cambios independientes en el mismo archivo son dos nodos. Un cambio transversal de un solo símbolo es un nodo aunque toque muchas líneas. Las dependencias entre nodos expresan prerrequisitos reales, nunca secuencia decorativa.

**Declara la arista cuando compartas archivo.** Si tu nodo toca el mismo archivo o símbolo que otro nodo del run, decláralo en `dependencies` aunque los cambios sean independientes: sin esa arista el grafo permite un orden que rompe los parches. Vale igual para los descubiertos, que dependen del nodo cuyo código modifican.

**Publica diffs atribuibles.** El diff de un nodo contiene sólo lo que ese nodo hizo. Si otro nodo del run ya tocó ese archivo y aún no hay commit —o si otro agente trabaja en paralelo sobre él—, `git diff` contra `HEAD` te atribuye trabajo ajeno. Copia el archivo antes de editar y publica el diff contra esa copia:

```sh
cp src/server/store.ts /tmp/store.before
# ...editar...
diff -u /tmp/store.before src/server/store.ts \
  --label a/src/server/store.ts --label b/src/server/store.ts > patch.diff
```

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
      "difficulty": "trivial | standard | hard",
      "dependencies": ["ids-de-prerrequisitos-reales"]
    }
  ]
}
```

```sh
hrp graph publish "$run_id" /ruta/temporal/graph.json   # --agent NOMBRE sólo si no declaraste HRP_AGENT
```

Los ids: únicos, estables, solo `[A-Za-z0-9_-]`. Sin ciclos; toda dependencia debe existir.

Publicar con tu identidad te registra como **modelo base** de la ejecución: ejecutas por defecto todos los nodos sin asignación, y los nodos que descubras se te asignan automáticamente para que el proceso no espere a otro agente.

Como modelo base también decides qué conviene delegar, con un criterio **económico**, no solo de mecanicidad. Sugiere `"suggestedAgent": "ollama"` únicamente en nodos tipo **fábrica** y solo cuando la cuenta salga positiva:

```
ahorro del nodo ≈ salida que no escribes − (spec + revisión fiel + ~1k de ceremonia)
```

- **Sí delega**: salida mecánica o de patrón con spec-contrato corta y salida estimada ≥ ~2-3k tokens (boilerplate, datos, fixtures, migraciones formulaicas), o un nodo que pertenece a una **serie de 3+ hermanos del mismo patrón**, donde la spec y la revisión se amortizan (pantallas CRUD, tests desde tabla de casos, configs por ambiente).
- **Nunca delegues** nodos creativos, de diseño, seguridad o núcleo novedoso, **aunque puedas especificarlos**: revisarlos fielmente cuesta igual o más que escribirlos (medido: delegar un motor de juego completo consumió más tokens del modelo base que la autoría directa).
- En caso de duda, quédatelo: el modelo más capaz ataca lo creativo; ollama fabrica lo repetitivo.

**Declara la dificultad de cada nodo.** `"difficulty"` es `trivial`, `standard` o `hard` (ausente equivale a `standard`), y es lo que decide **qué modelo ataca qué problema**: el roster de Ollama asocia un modelo a cada nivel y `hard` no se delega nunca — esas operaciones son tuyas. La dificultad es semántica que el humano aprueba junto con la spec, así que clasifícala por el trabajo real (¿hay diseño, contratos nuevos, seguridad? entonces `hard`; ¿es mecánico y verificable de un vistazo? `trivial`), no por lo largo que sea el archivo. Cambiarla después obliga a re-aprobar el nodo.

HRP pre-asigna a `ollama` los nodos sugeridos y el humano confirma o reasigna al aprobar. Puedes sugerir un carril concreto (`"suggestedAgent": "ollama:<modelo>"`) cuando quieras fijar el modelo; si sólo dices `ollama`, el carril lo decide la dificultad.

**Reparte para ganar velocidad.** Un carril `ollama:<modelo>` es una identidad ejecutora distinta y HRP sostiene un nodo por identidad, así que el paralelismo real equivale al número de modelos distintos en juego. Si vas a delegar varios nodos, dales dificultades (o carriles) que se repartan entre modelos distintos: dos nodos del mismo modelo se ejecutan en serie aunque no choquen.

### 2a. Auditoría del plan: la ronda que bloquea la aprobación (protocolo 3.3)

Publicar el grafo abre una ronda de auditoría **sobre el plan**: los auditores elegidos revisan el grafo, no código, buscando lo que ningún diff podría revelar después —un nodo faltante, un corte incorrecto, una dependencia mal declarada, un nodo sin verificación observable o uno fuera del requerimiento—. Una sola ronda por versión del grafo, y **bloquea la aprobación humana inicial**: mientras un auditor elegido no publique su pasada, el servidor rechaza aprobar el grafo.

**Como modelo base, después de publicar el grafo no pidas la aprobación: espera.** La señal `plan-wait` te dice quién falta; estaciónate en `hrp attention --wait 600` (o la herramienta MCP) hasta que la ronda cierre y el humano apruebe. Leer `hrp state "$run_id" --json` te da lo mismo en `run.planGate` (`pending`, `open`).

Los hallazgos llegan con `scope: "plan"` y sin `nodeId`. Atiéndelos antes de que el humano apruebe:

1. Léelos con `hrp finding show <finding-id>`.
2. Si el hallazgo procede, **corrige el grafo y vuelve a publicarlo** — no abras un nodo descubierto: lo que está mal es el plan, y republicar devuelve los nodos no completados al gate humano y reabre la ronda sobre la versión nueva. Después acepta el hallazgo citando esa versión.
3. Si no procede, recházalo con `hrp finding reject <id> --author TU_IDENTIDAD --body RAZON`, con una razón técnica y verificable. Tu respuesta se ve junto al botón de aprobar, así que es lo que el humano leerá para decidir.

Los hallazgos no bloquean por sí mismos —el humano decide si aprueba así o pide el grafo corregido—; lo que bloquea es que un auditor todavía no haya hablado.

Si tus auditores son modelos con sesión (no `ollama`), genera el paquete con `hrp graph review "$run_id"` y pide al humano que lo copie a esas sesiones. `hrp graph review` también relanza la ronda de ollama si falló o si el humano eligió auditores después de publicar.

**Cuando el auditor eres tú.** Si HRP te entrega la señal `plan` (accionable), el humano está detenido frente al botón de aprobar esperando tu opinión:

```sh
hrp graph review "$run_id"                         # el paquete del plan
hrp finding add "$run_id" --title T --body B --severity major --scope plan --reviewer TU_IDENTIDAD
hrp graph review done "$run_id" --findings N
```

Cierra siempre tu pasada, **también cuando el plan te parezca sano** (`--findings 0`): sin ella nadie puede aprobar. No inventes hallazgos para justificar la ronda.

### 2b. Espera la aprobación humana (protocolo 3.0)

Los nodos del **grafo inicial** nacen **sin aprobar** y el servidor rechaza `node start` hasta el visto bueno del humano (botón «Aprobar grafo» del panel, o `hrp node approve <run-id>`). Lo que **descubras** después ya no pasa por ese gate. Tras publicar el grafo, espera el clic del humano con el comando bloqueante:

```sh
hrp wait approval "$run_id" --timeout 300
```

Sale con éxito en cuanto exista trabajo aprobado disponible para ti; si agota el timeout, vuelve a ejecutarlo o pregunta al humano. Así el humano solo da un clic y tú continúas solo. No apruebes tú mismo con el CLI: la aprobación es del humano.

El humano puede asignar nodos a agentes concretos. **Tu identidad es la que declare `HRP_AGENT`** —por ejemplo `claude:opus`— y `claude` sólo cuando esa variable no existe; compruébala con `hrp whoami` (el aviso de inicio de sesión de HRP también te la dice). El CLI la hereda, así que puedes omitir `--agent`; si lo pasas, gana lo que escribas. Trabaja sólo nodos asignados a tu identidad o sin asignar, y decláralo al iniciar.

Varias sesiones de Claude pueden repartirse los papeles en la misma ejecución —una publica el grafo y audita, otra implementa— porque HRP sostiene un nodo en vuelo y un estado por identidad: dos sesiones que compartan identidad se pisan el estado. En ese reparto, los nodos sin asignar siguen perteneciendo al **modelo base** (quien publicó el grafo), así que si tú planeas y otra sesión implementa, enruta el trabajo con `"suggestedAgent": "claude:opus"` en el grafo o pídele al humano que lo asigne; y lo que descubras se queda contigo, que eres quien lo descubrió.

### 3. Ciclo por nodo: start → editar → patch → verify → complete

Elige siempre un nodo aprobado cuyas dependencias estén completadas (HRP rechaza `start` si no lo están). Puede haber varios nodos en curso si HRP confirma que no comparten archivo, contexto aprobado ni rama de dependencias — incluidos los carriles delegados corriendo mientras tú trabajas el tuyo. Tu propia sesión nunca sostiene dos nodos en curso: cierra el tuyo con patch, verify y complete antes de tomar otro. Si `start` se rechaza por conflicto con otro nodo en vuelo, no edites y espera a que termine. Mientras otro nodo esté en vuelo, el comando de `hrp verify run` debe nombrar el archivo, el símbolo o el id de este nodo; un comando integral se rechaza porque lee lo que el otro nodo está editando.

```sh
hrp node start "$run_id" <node-id>
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

Un nodo delegado —asignado a `ollama` o a un carril `ollama:<modelo>`— no espera a otra sesión: tú lo administras, y `hrp wait approval` ya lo cuenta como trabajo tuyo (regresa en cuanto el humano lo aprueba). El ciclo es el mismo, pero la generación del cambio se delega a Ollama Cloud.

**Despacha el lote completo, no un nodo a la vez.** Encadenar un `exec` bloqueante por nodo desperdicia el paralelismo que el grafo ya permite:

```sh
hrp dispatch "$run_id" --out-dir /ruta/scratchpad/despacho
```

`dispatch` elige los nodos delegados que pueden generarse a la vez —aprobados, con dependencias completas, sin conflicto entre sí ni con lo que esté en curso, y con su carril libre—, los arranca en su carril y lanza las consultas en paralelo, cada una con el modelo que le toca. Deja la salida de cada nodo en `<out-dir>/<node-id>.out` e informa carril, modelo, tokens y, para lo que no despachó, la razón exacta. Un fallo no cancela el lote: ese nodo queda en curso para que lo retomes. Mientras el lote se genera puedes trabajar tu propio nodo, siempre que no choque con los delegados.

Para un solo nodo, o cuando quieras controlar el prompt, sigue disponible la vía directa:

```sh
hrp node start "$run_id" <node-id> --agent ollama
hrp ollama exec "$run_id" <node-id> > /ruta/scratchpad/salida.txt
```

`exec` toma el modelo del carril del nodo y, si no lo declara, de su dificultad; `--model` lo anula explícitamente.

`exec` arma el prompt automáticamente con la descripción aprobada del nodo, sus `contextFiles` como referencia de solo lectura y el contenido actual del archivo — no redactes un prompt artesanal que duplique la spec. Usa `hrp ollama run --prompt-file ... --run "$run_id" --node <node-id>` solo cuando necesites un prompt a medida (fragmentos de un archivo grande), siempre con `--run`/`--node` para conservar la auditoría. Ambas vías quedan registradas en la Actividad con modelo y tokens.

Si `exec` falla con **«Ollama necesita más contexto — NECESITO: ...»**, el protocolo funcionó: el modelo pidió lo que le faltaba en vez de inventarlo. Enriquece la descripción o los `contextFiles` del nodo, republica el grafo (el nodo vuelve al gate de aprobación) y reintenta. Nunca completes el nodo con una salida donde el modelo haya supuesto contratos.

La verificación de un nodo delegado es **ejecutable sin excepciones**: el código corre sus casos y la documentación ejecuta sus ejemplos contra el código real («se ve bien» no es verificación).

**El despacho sólo genera.** Después actúas como revisor de cada salida: valídala, corrige lo que haga falta, aplica el cambio al workspace con tus herramientas y sigue el ciclo normal (patch → verify → complete) nodo por nodo. Con varios nodos del lote en vuelo, el comando de `hrp verify run` de cada uno debe nombrar su archivo, su símbolo o su id: un comando integral lee lo que otro carril tiene a medio escribir. En el `--summary` del parche distingue qué generó ollama y qué corregiste tú. `hrp ollama run` reporta por stderr los tokens de prompt/respuesta del modelo delegado: úsalo para `--tokens` al completar. Nunca completes un nodo delegado sin haber revisado y verificado su resultado; si la salida es inservible, corrígela tú mismo y anótalo en el resumen.

### 4. Fallos: reintenta el MISMO nodo

Si la verificación falla, el nodo queda `failed` y sus dependientes bloqueados. Diagnostica, corrige, y:

```sh
hrp node retry "$run_id" <node-id>
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

**Triaje del ejecutor en el momento.** Si ollama está activo y configurado (consulta `hrp ollama status --json` una vez por sesión y recuérdalo), decide antes de publicar cada descubierto quién debería implementarlo con el mismo criterio económico del triaje inicial: si es tipo fábrica y la cuenta sale positiva (salida ≥ ~2-3k tokens o serie de 3+ del mismo patrón), inclúyele `"suggestedAgent": "ollama"` y su `"difficulty"` en el JSON; si implica diseño, seguridad, integración delicada, ambigüedad o simplemente no da el umbral, no pongas sugerencia y quedará asignado a ti como modelo base. Así el modelo avanzado se reserva para el trabajo de alto valor en lugar de gastarse en lo trivial.

**Regla de la spec delegable.** Un nodo sugerido para ollama se redacta con la descripción como **spec a nivel contrato** — firma o punto de inserción exacto, invariantes («tal bloque queda igual»), casos borde y criterio de verificación — nunca pseudocódigo línea a línea. La delegación paga cuando la spec es corta y la salida larga; si describir el nodo te cuesta casi lo mismo que escribir el código, no lo sugieras para ollama: quédatelo. Esa descripción es la que el humano aprueba y la que `hrp ollama exec` enviará tal cual al modelo, así que se escribe una sola vez.

**Firmas o contexto, siempre.** Si la spec delegada menciona símbolos que viven en **otros archivos** (funciones, tipos, formatos), incluye su contrato exacto en la descripción o declara esos archivos en `"contextFiles": ["ruta.ts"]` del nodo: `exec` los adjunta como referencia de solo lectura. Un modelo al que le ordenas usar algo que no puede ver no se detiene: lo inventa. El contexto es semántica aprobada — cambiarlo republica el nodo al gate del humano.

**El descubierto nace aprobado.** `hrp node discover` lo devuelve con `approved: true` y ya asignado (a ti, o al agente sugerido), así que impleméntalo en cuanto sus dependencias estén completas: no esperes un segundo clic ni agrupes esperas por descubiertos. El gate humano cubre el plan, no cada consecuencia de implementarlo.

Después síguele el ciclo normal start → patch → verify → complete (con la sección 3b si quedó asignado a ollama). Si el descubrimiento cambia dependencias de nodos aún pendientes, vuelve a publicar el grafo completo actualizado. Nunca cambies la semántica de un nodo ya terminado.

### 6. Actividad secundaria (con moderación)

Para observaciones que no son operaciones de cambio pero ayudan a entender una decisión o restricción:

```sh
hrp activity publish "$run_id" --type inspect --node <node-id> \
  --summary "Observación breve" --detail "Contexto opcional"
```

Tipos: `run | graph | inspect | node | patch | verify | note`. No conviertas cada lectura o comando en actividad.

## Revisión multi-modelo (v3.1): el debate es parte del trabajo y tú lo resuelves

El objetivo de la v3 es la calidad del producto: otros modelos auditan tus nodos y tú, como agente base, **resuelves cada hallazgo con autoridad propia**. El humano es monitor: observa el debate en el panel y, si al final objeta una resolución tuya, eso se materializa como una **segunda corrida** (un run nuevo con la corrección objetada). La revisión ocurre **por flujo y al final**, nunca nodo a nodo:

- **Checkpoint por flujo**: al completar una cadena de dependencias, lanza tú mismo la revisión de ese subárbol con `hrp ollama review "$run_id" --node <nodo-hoja>` (si ollama está configurado); para un revisor con sesión, genera `hrp review pack "$run_id" --node <nodo-hoja>` y pide al humano copiarlo.
- **Auditoría final automática**: al completarse el último nodo, el servidor lanza solo la auditoría del run completo y sus hallazgos aparecen sin que nadie los pida. Tras completar el último nodo, ejecuta `hrp wait approval` para recibirlos y atenderlos antes de entregar.

**Atiende y resuelve los hallazgos.** `hrp wait approval` te avisa cuando hay hallazgos cuyo último turno no es tuyo; atenderlos tiene prioridad sobre iniciar nodos nuevos:

1. Lee el hilo completo: `hrp finding show <finding-id>`.
2. Si el hallazgo procede: publica el nodo de corrección como trabajo descubierto y acéptalo vinculándolo — `hrp finding accept <id> --resolution-node <nodo>`. **La aceptación autoriza el nodo en el acto** (sin clic humano) y registra el acuerdo del base; no lo inicies mientras falten acuerdos del censo.
3. El reportero ya acuerda al crear el hallazgo. Cada auditor seleccionado que acepte la corrección registra `hrp finding agree <id> --author SU_NOMBRE`; quien discrepe responde con `hrp finding reply` y mantiene abierto el debate.
4. Con unanimidad del base y todos los auditores, HRP reasigna la corrección descubierta al reportero elegible sólo si existe otro auditor seleccionado distinto que pueda revisarla y no hay una asignación manual incompatible. Sin ese revisor independiente, permanece con el modelo base. Lee `hrp state`: impleméntala únicamente si está asignada a `claude`; de lo contrario, espera a su dueño.
5. Si no procede: recházalo tú mismo — `hrp finding reject <id> --author TU_IDENTIDAD --body RAZON` — también frente a revisores sin sesión (`ollama:*`). La razón debe ser técnica y verificable (spec aprobada, requisito, evidencia ejecutable); un rechazo por autoridad, sin argumento, es abuso.
6. `hrp finding escalate <id>` queda como recurso **opcional** para dudas genuinas que no puedes resolver con evidencia (ambigüedad del requisito, decisión de producto). Ya no es la salida del desacuerdo.

El modelo que implemente la corrección no puede auditar ese nodo; otro auditor debe cubrirlo. Reabrir el hallazgo reinicia los acuerdos y conserva sólo el del reportero. Esta unanimidad decide quién corrige y no sustituye la mayoría simple de votos `phase completed` que usa el gate final.

El gate humano inicial del grafo sigue vigente: tu autoridad cubre el ciclo de revisión, no el plan. Nunca cierres el debate borrando o ignorando hallazgos: `hrp review gate "$run_id"` fallará mientras haya hallazgos vivos o falten votos para la mayoría, y esa es la señal correcta.

Si el humano te convierte en **revisor** de otro agente, mantén `hrp wait approval <run-id>` con tu identidad hasta recibir **Auditoría disponible**; los nodos sin asignación pertenecen al base y no debes reclamarlos. Publica `hrp agent status` con `phase reviewing` antes de obtener `hrp review pack`, y actualiza `--completed`, `--reviewed` y `--remaining` mientras auditas integración entre nodos, contratos rotos y desviaciones spec↔diff. Reporta con `hrp finding add`, debate con `hrp finding reply` y acuerda correcciones aceptables con `hrp finding agree`. Mientras actúes sólo como revisor no edites código; si HRP te asigna por unanimidad la corrección de tu hallazgo, ejecútala como nodo normal y exclúyela de tu propia cobertura. Publica `phase completed` sólo al cubrir todos los nodos ajenos; después vuelve a esperar porque una corrección puede exigir otra pasada de los demás auditores. Si no encuentras nada real, dilo — no inventes hallazgos ni marques cobertura que no realizaste.

## No te quedes ciego: espera en lugar de terminar el turno

Mientras la ejecución siga viva, terminar tu turno es quedarte ciego: nadie puede devolverte el control salvo tu propio entorno. En vez de cerrar, estaciónate en la señal de HRP:

```sh
hrp attention --wait 600      # bloquea hasta que haya algo para ti (identidad: HRP_AGENT)
```

Sale con código 0 e imprime la directiva accionable cuando hay trabajo (nodos iniciables, hallazgos por responder, auditoría disponible o cierre pendiente), y con código 3 si el plazo se agota sin novedad — en cuyo caso vuelve a ejecutarlo. Acepta `--run <id>` para una ejecución concreta y `--workspace <ruta>` para todas las del proyecto; `--json` entrega la señal completa (`kind`, `actionable`, `waiting`, `terminal`, `directive`).

Además, el instalador deja un **hook `Stop` nativo** en Claude Code: si intentas terminar el turno mientras HRP tiene trabajo, el hook lo impide y te entrega la directiva. No lo esquives — es la red que permite al humano desatenderse. Si el hook te retiene sin trabajo inmediato, estaciónate con el comando de arriba en lugar de cerrar.

Confirma que tu integración está al día (skill, MCP y hook) con:

```sh
hrp agent install claude    # idempotente; 'hrp agent status' muestra qué hay instalado
```

## Control humano: pausada o detenida

El humano puede pausar, detener o reanudar la ejecución (panel o `hrp run pause|resume|stop`). El servidor rechaza `node start` en esos estados para todos los agentes; no es un error tuyo:

- Rechazo por **pausa** (`Run is paused by the human…`): espera sin abandonar — deja corriendo `hrp attention --wait 600` o `hrp wait approval`, y al reanudarse **relee `hrp state <run-id> --json` antes de retomar**: la pausa es justo el momento en que el humano puede reconfigurar quién implementa cada nodo y quién audita, así que el nodo que creías tuyo puede haber cambiado de dueño (incluso uno que tenías en curso, que vuelve a `pending` con otro asignado).
- Rechazo por **detención** (`Run was stopped by the human…`): cierra ordenadamente — no inicies más nodos, conserva lo completado y reporta al humano el avance y lo pendiente.

## Reanudación

Si retomas una tarea interrumpida, consulta primero el estado persistido:

```sh
hrp state "$run_id" --json
```

Conserva los `completed`, comprueba el workspace antes de reanudar/reintentar `running`/`failed`, no repitas parches ya aplicados, y publica como descubierta cualquier diferencia entre el mapa persistido y el trabajo real restante. "En vivo" en el panel indica navegador conectado, no agente vivo — siempre consulta `hrp state`.

## Antes de entregar al humano

No existe `run complete`; el estado se deriva de los nodos. Consulta `hrp state "$run_id" --json` y confirma **leyendo ese JSON, sin releer tu trabajo**:

- todos los nodos `completed`, cada uno con diff y verificación aprobada;
- el mapa incluye los nodos descubiertos;
- el workspace pasó **una sola vez** la verificación ejecutable integral (tests/build del proyecto — la corre la máquina, no tú);
- la auditoría automática final corrió (revisa la Actividad), sus hallazgos quedaron resueltos por ti, y `hrp review gate "$run_id"` pasa.

**Prohibido re-verificarte.** No releas tus propios diffs ni los cuentes como cobertura revisada: escribiste ese código y tienes sus mismos puntos ciegos. Si también fuiste elegido como auditor, revisa sólo nodos ajenos; si no hay alcance, publica cobertura 0 y deja visible que esa ejecución necesita otro auditor para obtener revisión real. Responder el debate y correr el gate no son re-verificación: son el cierre administrativo.

Después reporta al usuario el resultado como harías normalmente, mencionando que la evidencia quedó publicada en HRP.
