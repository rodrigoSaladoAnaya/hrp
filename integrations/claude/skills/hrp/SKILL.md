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

El nodo descubierto también espera la aprobación humana antes de poder iniciarse. Luego síguele el ciclo normal start → patch → verify → complete. Si el descubrimiento cambia dependencias de nodos aún pendientes, vuelve a publicar el grafo completo actualizado. Nunca cambies la semántica de un nodo ya terminado.

### 6. Actividad secundaria (con moderación)

Para observaciones que no son operaciones de cambio pero ayudan a entender una decisión o restricción:

```sh
hrp activity publish "$run_id" --type inspect --node <node-id> \
  --summary "Observación breve" --detail "Contexto opcional"
```

Tipos: `run | graph | inspect | node | patch | verify | note`. No conviertas cada lectura o comando en actividad.

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
