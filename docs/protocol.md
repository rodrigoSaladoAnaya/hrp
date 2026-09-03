# Protocolo HRP v4

Decisiones de mecánica tomadas el 1 de septiembre de 2026. Este documento es la
referencia de v4; `src/shared/protocol.ts` se reescribe a partir de él, no al
revés. Lo que no aparece aquí no está decidido.

## Tesis

1. **El grafo es salida, no entrada.** No se planea ni se aprueba un grafo
   antes de programar. Los nodos se registran conforme el modelo base los
   ejecuta y el mapa se deriva de ese registro.
2. **El humano inicia y monitorea.** Su trabajo activo es invocar `/hrp` y
   enganchar sesiones. No aprueba nodos ni planes. Una objeción tardía es un run
   nuevo.
3. **La calidad la ponen las sesiones auditoras.** Todo lo implementado, sin
   excepción, lo audita alguien que no lo escribió. Un run sin auditores nunca
   se cierra solo.
4. **El suelo común son archivos.** Lo que un auditor necesita para entender el
   requerimiento está en `~/.hrp`, legible por cualquier modelo sin hablar con
   el servicio.

## Roles

| Rol | Quién | Qué hace |
|---|---|---|
| Humano | La persona | Invoca `/hrp <tarea>` y `/hrp attention <id>`; monitorea el panel. Palancas: pausar/detener el run, escribir en hilos como `human`. Fusiona la rama cuando el run cierra. |
| Base | La sesión que recibió `/hrp <tarea>` | Escribe el issue, implementa **todos** los nodos, consume la cola de hallazgos, cierra la implementación. Autoriza el resultado de cada hallazgo. |
| Auditor | Cualquier sesión enganchada que no sea el base | Audita requerimiento, nodos e integración; abre hallazgos; vota al cierre. |
| Runner | Proceso sin sesión (`hrp attend`) | Un auditor sin chat: consulta atención en loop y ejecuta lo que se le pide. Ollama es el primer runner; es opcional. |

La **unidad de independencia es la sesión, no el modelo**. Dos sesiones del
mismo modelo bastan para cerrar un run; el panel muestra cuántos modelos
distintos participaron. Reglas fijas:

- Nadie audita un nodo que escribió.
- El base nunca es el único voto.
- No existe delegación de nodos: el base implementa todo. Se elimina la
  asignación por nodo, la dificultad declarada y los archivos de contexto.

## Superficie

Una sola skill, `/hrp`, instalada igual en Claude Code, Codex y Antigravity.
Despacha por el primer argumento:

| Invocación | Efecto |
|---|---|
| `/hrp <tarea>` | La sesión se vuelve base de un run nuevo. |
| `/hrp attention <id>` | La sesión se engancha como auditora del run. |

La skill habla con el servicio a través del **MCP**; el CLI queda reducido al
runner (`hrp attend <id> --agent <nombre>`) y a instalación/servicio.

Herramientas MCP previstas (nombres provisionales; la lista definitiva sale de
la implementación):

- `hrp_service_start`, `hrp_service_status`
- `hrp_run_start` (con `continues` para dar continuidad a un run cerrado),
  `hrp_run_extend` (adenda a un run vivo), `hrp_run_state`, `hrp_run_close`
- `hrp_attach`, `hrp_attention`, `hrp_release`
- `hrp_node_open`, `hrp_node_complete`, `hrp_node_fail`
- `hrp_finding_add`, `hrp_finding_reply`, `hrp_finding_accept`,
  `hrp_finding_reject`, `hrp_finding_escalate`, `hrp_finding_list`
- `hrp_audit_vote`
- `hrp_activity`

Se eliminan respecto a v3: publicar grafo, aprobar nodos, pasada de plan,
asignar nodo, reintentar nodo, review gate como herramienta aparte (queda
dentro de `hrp_run_state`).

## Suelo común: `~/.hrp`

v3 se borra completa (`scripts/uninstall-v3.sh`). Estructura de v4:

```
~/.hrp/
  hrp.db                       estado: proyectos, runs, nodos, hallazgos, sesiones
  runs/<id>/
    run.json                   proyecto, workspaceRoot, rama, base, createdAt
    issue.md                   el requerimiento en el formato de abajo
    attachments/               copias de imágenes y archivos que envió el humano
```

Reparto estricto: **los archivos son las entradas** del run; **el servicio es
el estado**. No se duplica estado en archivos.

Los adjuntos se **copian**, nunca se enlazan: las rutas que una sesión recibe
al pegar una imagen son temporales y desaparecen.

### Formato de `issue.md`

```markdown
---
id: 3f9a2c1d
project: motor-nv
workspaceRoot: /Users/x/src/motor-nv
branch: hrp/run-3f9a2c1d
base: claude
createdAt: 2026-09-01T21:00:00-06:00
---

# <título corto>

## Requerimiento literal
<lo que escribió el humano, sin editar ni resumir>

## Interpretación del base
<qué entendió el base que hay que hacer>

## Alcance
- Incluye: ...
- Excluye: ...

## Criterios de aceptación
- `npm test` termina en 0
- `./gradlew build` termina en 0
- [ejercicio] abrir el panel con un run y comprobar que el nodo muestra su diff
- <cada criterio es un comando ejecutable o, con [ejercicio], una acción
  sobre el artefacto real; al menos uno debe ser de ejercicio>

## Riesgos
- ...

## Adjuntos
- attachments/pantalla-1.png — <para qué sirve>
```

El requerimiento literal es obligatorio y se conserva sin tocar: la auditoría
de requerimiento compara la interpretación del base contra el original, no
contra sí misma.

**Todo issue lleva al menos un criterio de ejercicio** (`exercise: true`):
abrir y usar el artefacto de verdad —el panel, el juego, el CLI— y mirar qué
hace. Un exit 0 demuestra que compila y que pasan las pruebas que escribió el
mismo que implementa; no demuestra que funciona. En el run del Tetris los tres
defectos más visibles tenían su nodo en verde con verificación aprobada.

## Ciclo de un run

### 1. Inicio

`/hrp <tarea>` en cualquier sesión. El base:

1. Asegura el servicio (lo arranca si no corre).
2. Registra el proyecto por `workspaceRoot` (el directorio actual) si no existe.
3. Crea el run, escribe `issue.md`, copia adjuntos.
4. Crea la rama `hrp/run-<id>` a partir del árbol actual. Siempre; no sólo con
   cambios pendientes.
5. Responde al humano una sola vez con tres cosas:
   - `/hrp attention <id>` para pegar en otras sesiones;
   - `hrp attend <id> --agent <nombre>` para runners;
   - la URL del panel con proyecto y run.

Y empieza a implementar. No hay tiempo de gracia: un hallazgo de requerimiento
se consume como cualquier otro, y si es `critical` detiene al base antes del
siguiente nodo.

### 2. Enganche

`/hrp attention <id>` en una sesión. El servicio acuña una **identidad de
sesión** (modelo + sesión + rol) y la lista como activa. El panel ofrece **un
solo comando copiable por run**, `/hrp attention <id>`, que el humano pega en
la sesión que quiera; no hay comandos por modelo. Junto a él muestra qué
sesiones están enganchadas, con qué modelo y qué han auditado.

Una sesión enganchada **se mantiene atenta hasta que observe que el run
cerró** (o el humano lo detuvo), y entonces libera su atención sola. El
mecanismo es el despertador de v3: el hook `Stop` consulta `hrp_attention` y
recibe una directiva; una sesión sin directiva termina su turno normalmente.

El hook `SessionStart` informa de los runs abiertos del proyecto del directorio
actual y sugiere `/hrp attention <id>`; el enganche sigue siendo explícito.

### 3. Implementación

El base trabaja nodo por nodo. Un nodo es una **operación semántica**:
`archivos + símbolo o sección lógica + intención`. Cubre un solo archivo o
varios que cambian juntos —un módulo y su prueba, una interfaz y su
implementación— siempre que compartan intención y verificación. Dos cambios
independientes en el mismo archivo siguen siendo dos nodos. Con la regla de un
archivo por nodo, el Tetris necesitó 31 nodos para unas ocho operaciones reales
y el grafo se leía como escrituras de archivo, no como cambios.

1. `hrp_node_open` antes de editar, con `files`: el nodo aparece `running` en
   el mapa con su intención y sus dependencias declaradas.
2. Edita, verifica con `hrp_node_verify` (la máquina corre el comando sin
   color y guarda la salida recortada según el resultado).
3. `hrp_node_complete` con verificación aprobada. La finalización mide el diff
   de todos los archivos del nodo y hace **un solo commit en la rama del run**.

Las herramientas de nodo devuelven un acuse corto (estado, archivos, líneas
cambiadas, commit), nunca el diff que el base acaba de escribir: en un run
real ese eco costaba más del 10% de la sesión.

Todos los nodos son iguales: desaparece la etiqueta `discovered`. Un nodo que
no se pudo terminar queda `failed` con su intento visible; el base puede abrir
otro nodo que lo reemplace.

### 4. Auditoría en paralelo

Cada nodo completado despierta a los auditores. Auditan ese nodo mientras el
base sigue con el siguiente. Los hallazgos son asíncronos: **nadie interrumpe
al base**; los hallazgos entran a una cola.

El base consume la cola **entre nodos**: acepta con nodo de corrección o
rechaza con razón en el hilo. Sólo escala al humano ante una duda genuina.

Única excepción: un hallazgo `critical` pone el run en `hold`. El base lo
resuelve antes de abrir otro nodo.

### 5. Cierre del base

Cuando el base considera terminada la tarea, **ejercita el artefacto**: lo
abre, lo usa y mira lo que hace, criterio por criterio de ejercicio. Después
llama `hrp_run_close` con `exercised`, lo que observó en cada uno; sin ese
reporte el servicio rechaza el cierre. Lo observado queda como evidencia junto
al criterio, visible para los auditores y en el panel.

El servicio ejecuta entonces los **criterios de aceptación** que sean
comandos; si alguno falla, el run no cierra y el base recibe la salida. Si
pasan, el run queda `implemented` y se despierta a los auditores para la
pasada de integración y el voto.

El base no relee sus propios diffs ni se autoaudita.

### 6. Gate

El run pasa a `closed` cuando:

- cada nodo completado tiene al menos una auditoría de una sesión que no lo
  escribió;
- no hay hallazgos vivos (`open`, `debating`, `escalated`);
- hay al menos un voto OK de un auditor distinto del base, y la mayoría simple
  de los auditores que votaron es OK.

Si no hay auditores, el run se queda en `implemented` **sin auditar**,
visible así en el panel, indefinidamente. Nunca se cierra solo.

La fusión de la rama es un acto del humano, fuera del protocolo.

### 7. Cuando el issue crece

Es normal que un issue pida más de lo que decía al inicio. Hay dos casos y
se tratan distinto, porque el cierre tiene que seguir significando lo mismo:
los auditores votaron OK sobre un conjunto concreto de nodos.

**Adenda (el run sigue vivo: `open` o `implemented`).** El base llama
`hrp_run_extend` con el requerimiento literal nuevo y su interpretación; el
humano puede hacerlo desde el panel con sólo el requerimiento. El servicio:

- anexa la adenda al final de `issue.md` (el requerimiento original no se
  toca) y suma los criterios de aceptación nuevos;
- si el run estaba `implemented`, lo devuelve a `open`;
- conserva las auditorías de nodos ya hechas (esos nodos no cambiaron), pero
  anula los votos y la pasada de requerimiento de todos los auditores, que
  reciben de nuevo la directiva `requirement` con la adenda señalada;
- avisa al base con `resume` mientras no abra ningún nodo posterior a la
  adenda.

**Continuación (el run ya cerró).** Un run cerrado **no se reabre**: tocarlo
haría que sus votos certificaran algo que nadie miró. Lo que sigue es otro run
con `continues: <id>` en `hrp_run_start`. Su rama nace de la punta de la rama
del run anterior (si ya no existe, del árbol actual) y su issue lleva una
sección *Antecedente*. El panel muestra la cadena completa como la historia de
una implementación; cada eslabón conserva su certificación. Un run que quedó
"a medias" porque el alcance inicial era parcial no está a medias: es un run
completo de un alcance parcial, y lo que falta es una continuación.

Un run detenido no se continúa ni se amplía: se reanuda.

## Atención

Directivas que puede recibir una sesión, en orden de prioridad:

| Directiva | A quién | Cuándo |
|---|---|---|
| `hold` | base | Hay un hallazgo `critical` abierto |
| `finding` | base o auditor | Hay respuestas nuevas en un hilo donde participa, o hallazgos por resolver |
| `requirement` | auditor | El issue está publicado y no lo ha revisado |
| `node` | auditor | Hay nodos completados que no ha auditado |
| `close` | auditor | El run está `implemented` y falta su pasada de integración o su voto |
| `released` | cualquiera | El run cerró o fue detenido: soltar la atención |

Una sesión enganchada a varios runs recibe las directivas agregadas y
ordenadas por prioridad.

## Estados

- **Run:** `open` (implementando), `hold`, `implemented` (cierre del base,
  pendiente de auditoría), `closed`. Control humano ortogonal: `active`,
  `paused`, `stopped`.
  `closed` es terminal: un run cerrado se continúa con otro run
  (`continues`), nunca se reabre. Un run vivo crece con adendas
  (`extensions`), que reabren un `implemented` y anulan los votos.
- **Nodo:** `running`, `completed`, `failed`. Desaparece `pending`: un nodo
  existe cuando el base lo abre.
- **Hallazgo:** `open`, `debating`, `accepted`, `rejected`, `escalated`.
  Severidades `critical`, `major`, `minor`, `question`. Alcances
  `requirement`, `node`, `integration`; desaparece `plan`.
- **Sesión:** `attached`, `released`. Con modelo, rol y run.

## Multiproyecto

Un solo servicio y una sola base de datos para todos los proyectos. Cada
proyecto se identifica por `workspaceRoot`; cada run pertenece a un proyecto y
puede haber runs abiertos en varios proyectos a la vez.

- Toda directiva de atención lleva `workspaceRoot` y rama: una sesión auditora
  abierta en otro directorio sabe dónde leer el código.
- El árbol de proyectos del panel se conserva; el enganche y la atención son
  por sesión y agregan entre proyectos.
- Un `issue.md` es autónomo: con él y el `run.json` un auditor puede empezar
  sin conocer el proyecto de antemano.

## Panel

Se conserva el sistema visual de v3 (tablero de enclavamiento: verde mineral,
marfil, grafito, ámbar de movimiento y verde de señal) menos lo que
desaparece.

Se conserva: mapa con inspector, actividad, hallazgos con debate, carriles y
carga de agentes, árbol de proyectos, **lupa**, **navegación entre sesiones en
actividad y hallazgos**, atajos de vista.

Se elimina: aprobación del grafo, plan gate y override, asignación de modelo y
dificultad por nodo, archivos de contexto, los comandos de copia por agente.

Entra: un único botón de copia por run con `/hrp attention <id>`; vista del
issue con adjuntos; lista de sesiones activas etiquetadas (modelo, sesión, rol,
cobertura); el estado `implemented` sin auditar como aviso visible en el árbol.

## Qué cae del contrato heredado

De `src/shared/protocol.ts` desaparecen: `PlanGateStatus`, `graphVersion`,
`overriddenVersion`, `awaitingApproval`, `discovered`, `approved`,
`assignee`, `suggestedAgent`, `difficulty`, `contextFiles`, `findingScope:
"plan"`, `findingScopeFor`, `nodeStatuses: "pending"`.

Se conservan: `Verification`, `Finding` y su ciclo, `FindingMessage`,
`Activity`, `RunControl`, y la idea de `AgentWorkState` como estado operacional
observable sin razonamiento privado.

Desaparece también `tokens` por nodo: era una estimación del modelo mostrada
con el mismo peso visual que un diff medido o un exit code. La evidencia la
mide la máquina; lo que no puede medir no se muestra.

## Pendiente

- Diseño concreto del runner: formato del pack de auditoría que recibe y cómo
  publica hallazgos.
- Cómo identifica el hook a la sesión (v3 usaba `HRP_AGENT` y un árbol de
  sesiones; en v4 la identidad la acuña `hrp_attach`).
- Qué hace `hrp_run_close` con criterios de aceptación que no son comandos:
  probablemente sólo se listan para los auditores.
