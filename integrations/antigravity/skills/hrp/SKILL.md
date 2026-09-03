---
name: hrp
description: Human Review Protocol v4 (HRP). Úsala siempre que el usuario invoque /hrp, ya sea "/hrp <tarea>" (implementar una tarea como modelo base publicando evidencia al servicio HRP) o "/hrp attention <id>" (engancharse como auditor de un run en curso), o cuando mencione HRP, "Human Review Protocol", el panel de revisión, o pida trabajar "con hrp" o "con auditoría de otros modelos".
---

# HRP v4

HRP convierte una tarea de programación en un run auditable: el modelo base implementa y deja evidencia (nodos con diff + verificación, commits en una rama del run); otras sesiones —de este u otro modelo— se enganchan y auditan mientras avanza; el run cierra solo cuando la auditoría está completa. El humano sólo inicia, engancha sesiones y monitorea el panel. Todo se hace con las herramientas MCP `hrp_*`; no hay CLI que memorizar.

El contrato completo está en [references/protocol.md](references/protocol.md).

## Despacho por argumento

- `/hrp attention <id>` → eres **auditor** del run `<id>`. Sigue *Auditor*.
- `/hrp <cualquier otra cosa>` → eres **base** de un run nuevo con esa tarea. Sigue *Base*.

## Base

### 1. Issue

Lee el código que necesites para entender la tarea. Luego llama `hrp_run_start` (arranca el servicio si hace falta) con:

- `requirement`: el texto del humano **literal**, sin resumir ni corregir. Es lo que los auditores comparan contra tu interpretación.
- `interpretation`: qué entendiste que hay que hacer.
- `scopeIncludes` / `scopeExcludes`: archivos o áreas.
- `acceptance`: criterios con `command` ejecutable siempre que se pueda (`npm test`, `./gradlew build`, un `grep`…); la máquina los corre al cerrar. **Al menos uno lleva `exercise: true`**: abrir y usar el artefacto de verdad (el panel en el navegador, el juego, el CLI con datos reales) y decir qué debe verse. Sin ese criterio el servicio rechaza el run.
- `risks`.
- `attachments`: rutas de las imágenes o archivos que pegó el humano. Se **copian** al run para que los auditores los vean.

Responde al humano **una sola vez** con lo que devuelve la herramienta: `/hrp attention <id>`, el comando del runner y la URL del panel. No pidas aprobación: empieza a implementar.

### 2. Nodos

Un nodo es una **operación semántica**: `archivos + símbolo o sección lógica + intención`. Cubre uno o varios archivos que cambian juntos: un módulo y su prueba, una interfaz y su implementación, un componente y su CSS. Dos cambios independientes en el mismo archivo son dos nodos; un cambio transversal de un símbolo es un nodo aunque toque muchas líneas. Nada de "implementar el backend" ni nodos por fase, y nada de partir una operación en nodos por archivo.

Por cada nodo:

1. `hrp_node_open` **antes** de editar, con `files` (todos los archivos de la operación) y `dependencies` reales.
2. Edita los archivos.
3. `hrp_node_verify` con un comando cuyo **exit code** pruebe ese cambio (la máquina lo ejecuta sin color y guarda la salida). No lo termines en `| tail` ni `| grep`: la tubería esconde el exit code y una prueba roja pasa como verde.
4. `hrp_node_complete`: el servidor mide el diff de todos los archivos del nodo con git y deja **un solo commit en la rama del run**. Exige verificación aprobada y diff real.

Las herramientas de nodo devuelven un acuse corto (estado, archivos, líneas cambiadas, commit); no esperes el diff de vuelta ni lo pidas. Si un nodo no sale, `hrp_node_fail` con la razón y abre otro. Nada de trabajo oculto: todo cambio pasa por un nodo.

### 3. Entre nodos: la cola de hallazgos

Antes de abrir el siguiente nodo llama `hrp_attention` con `waitMs: 0`.

- `finding`: lee cada uno con `hrp_finding_show`. Si procede, `hrp_finding_accept` y corrige en un nodo nuevo (`hrp_node_open` con `resolves`). Si no, `hrp_finding_reject` con razón técnica. Rebate con `hrp_finding_reply`. Tras dos rondas sin evidencia nueva, `hrp_finding_escalate`.
- `hold`: hay un hallazgo `critical` vivo; no puedes abrir nodos hasta aceptarlo o rechazarlo.

Tú autorizas el resultado del debate; no escales al humano por defecto.

### 4. Cierre

Cuando la tarea esté completa, **ejercita el artefacto antes de cerrar**: abre el panel, la página o el CLI, úsalo como lo usaría el humano y mira qué hace (tamaño de la ventana, lo que se dibuja, lo que responde). Los defectos que más duelen son los que un exit 0 no ve. Luego `hrp_run_close` con `exercised`: por cada criterio de ejercicio, su texto exacto y lo que observaste. Sin ese reporte el cierre se rechaza.

La máquina ejecuta después los criterios con comando; si alguno falla, corrige con nodos nuevos y vuelve a cerrar. Si pasan, el run queda `implemented` y los auditores hacen la pasada final.

Después, **no termines el turno**: llama `hrp_attention` con `waitMs: 600000` y atiende los hallazgos de integración que lleguen. Cuando responda `released`, el run cerró. Si no hay auditores enganchados el run se queda en `implemented, sin auditar`; díselo al humano y termina.

No te autoaudites, no votes, no fusiones la rama: eso es del humano.

### 5. Si pierdes contexto

`hrp_service_status` te dice tu identidad por run; `hrp_run_state` y `hrp_run_issue` reconstruyen dónde vas. No abras otro run para el mismo requerimiento.

### 6. Si el humano pide más sobre el mismo issue

- **El run sigue vivo** (`open` o `implemented`): `hrp_run_extend` con el `requirement` literal nuevo y tu `interpretation`, más criterios y adjuntos si los hay. La adenda se anexa al issue; si el run estaba implementado vuelve a `open` y los votos se anulan. Implementa lo nuevo en nodos y vuelve a cerrar con `hrp_run_close`. Si `hrp_attention` te devuelve `resume` con una adenda, el humano la escribió desde el panel: léela con `hrp_run_issue` y retómala.
- **El run ya cerró**: no se reabre. `hrp_run_start` con `continues: <id>`; la rama nueva nace de la punta de la rama anterior y el panel muestra ambos como una sola historia. Un run detenido se reanuda, no se continúa.

## Auditor

1. `hrp_attach` con el `runId`. Devuelve tu identidad (`familia:N`) y la primera directiva.
2. Sigue la directiva y vuelve a `hrp_attention` con `waitMs: 600000`. **No termines el turno** mientras la respuesta no sea `released`: si lo haces, el despertador te devolverá el turno cuando haya trabajo, pero la espera activa es más fiable.

Directivas:

- `requirement`: `hrp_run_issue`. Lee los adjuntos (rutas locales). Compara la interpretación del base con el requerimiento literal y los criterios. Reporta con `hrp_finding_add` `scope: "requirement"`. Con hallazgos o sin ellos, `hrp_audit_done` con `requirement: true`. Si la directiva menciona una adenda, el alcance creció: la adenda está al final del issue y tu pasada anterior ya no cuenta; revisa lo nuevo (y los nodos que vengan después) y vuelve a declararla.
- `node`: `hrp_review_pack` con esos `nodeIds`. Lee el código real en el workspace indicado (rama del run) si el diff no basta. Reporta con `hrp_finding_add` `nodeId`. Declara cada nodo revisado con `hrp_audit_done` `nodeIds` **aunque no encuentres nada**: sin esa declaración el run no puede cerrar.
- `close`, además de la integración: comprueba que el base reportó lo observado en cada criterio de ejercicio y que lo observado corresponde al requerimiento; si puedes, ejercita el artefacto tú también.
- `finding`: el base respondió en tu hilo. `hrp_finding_show` y `hrp_finding_reply`: acepta explícitamente su respuesta o rebate con evidencia. Si tienes evidencia nueva sobre un hallazgo cerrado, `hrp_finding_reopen`.
- `close`: el base cerró la implementación. `hrp_review_pack` sin `nodeIds` (integración), reporta con `scope: "integration"`, y vota con `hrp_audit_vote` (`ok` o `reject` con detalle). Con mayoría OK y sin hallazgos vivos el run cierra solo.
- `wait`: nada que hacer ahora; sigue en `hrp_attention`.
- `released`: fin. Dile al humano en una línea cómo quedó.

Reglas: no edites código; cada hallazgo lleva archivo, línea y cómo reproducirlo; `critical` sólo si rompe el requerimiento o el sistema; no inventes hallazgos para justificar la pasada. Nadie audita lo propio: si en otro run fuiste base, aquí eres otra sesión.

## Qué publicar

Explicaciones operativas breves y comprobables: qué cambia, por qué, qué comando lo verificó. Nunca cadena de pensamiento, secretos ni logs enteros. `hrp_activity` sirve para anotar inspecciones o decisiones que el panel deba mostrar.

## Despertador

Claude Code y Codex tienen hooks `Stop`/`SessionStart` instalados por HRP: si terminas el turno con trabajo pendiente en un run enganchado, el hook te lo devuelve con la directiva. Antigravity no tiene hooks: su única espera es `hrp_attention` con `waitMs`.
