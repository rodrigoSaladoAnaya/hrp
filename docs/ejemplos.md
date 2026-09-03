# HRP: ejemplos básicos de uso

Guía práctica para el humano. Cada ejemplo muestra qué escribes tú, qué hace
la sesión y qué ves en el panel. La mecánica completa está en
[`protocol.md`](protocol.md).

Todos los ejemplos parten de una sesión de Claude Code, Codex o Antigravity
abierta en la carpeta del proyecto, con HRP instalado (`./scripts/install.sh`).

## 1. Iniciar un run

Escribe la tarea después de `/hrp`:

```
/hrp Quiero que el tema elegido en Ajustes se guarde y se recupere al recargar
```

La sesión se vuelve **base** del run. Escribe el issue en
`~/.hrp/runs/<id>/issue.md` con tu texto literal, crea la rama
`hrp/run-<id>` y te responde una sola vez con tres cosas:

```
Para enganchar otra sesión: /hrp attention 9fe3df77
Para un runner sin sesión:  hrp attend 9fe3df77 --agent ollama
Panel: http://127.0.0.1:4317/?project=af5c1a3c&run=9fe3df77
```

Y empieza a implementar sin pedir aprobación. Cada operación aparece en el
mapa del panel como un nodo con su diff, su verificación y su commit.

Si pegaste una imagen o un archivo junto con la tarea, se copia al run y los
auditores lo ven en la vista Issue.

## 2. Enganchar auditores

Abre otra sesión (del mismo modelo o de otro) en la misma carpeta y pega el
comando que te dio el base o el botón de copia del panel:

```
/hrp attention 9fe3df77
```

Esa sesión queda como **auditora**: revisa el issue, cada nodo conforme se
completa y la integración al final. Abre hallazgos que el base atiende entre
nodos. Se libera sola cuando el run cierra.

Dos sesiones bastan para cerrar un run. El base nunca es el único voto y nadie
audita lo que escribió.

Para un auditor sin chat, desde una terminal:

```sh
hrp attend 9fe3df77 --agent ollama --model qwen2.5-coder
```

## 3. Monitorear

En el panel:

- **Issue**: requerimiento literal, interpretación del base, criterios, adjuntos
  y la historia del run.
- **Mapa**: los nodos y sus dependencias; al seleccionar uno, su diff y
  verificación.
- **Actividad** y **Hallazgos**: qué hizo cada sesión, filtrable por sesión.
- **Evolución**: el árbol de archivos cuadro a cuadro, un cuadro por nodo.

Palancas del humano:

- **Pausar**: nadie abre nodos nuevos; los que están en curso terminan.
- **Detener**: libera a todas las sesiones. Se puede reanudar.
- Escribir en el hilo de un hallazgo como `human`, sobre todo cuando un
  hallazgo fue **escalado** porque las sesiones no se pusieron de acuerdo.

Al terminar, el base ejercita el artefacto, reporta lo que vio y cierra. La
máquina corre los criterios con comando. Si pasan, el run queda
`implementado` y los auditores votan. Con auditoría completa y mayoría OK el
run queda `cerrado`.

## 4. Fusionar

Fusionar la rama es cosa tuya, fuera del protocolo:

```sh
git merge hrp/run-9fe3df77
```

Un run sin auditores se queda en `implementado, sin auditar` indefinidamente.
Nunca cierra solo.

## 5. Pedir más mientras el run sigue vivo: adenda

El run está `open` o `implemented` y te das cuenta de que falta algo. En la
misma sesión del base escribe:

```
Además del tema, quiero que también se guarde el tamaño de fuente
```

El base llama `hrp_run_extend` con tu texto literal, su interpretación y los
criterios nuevos. Efectos:

- La adenda se anexa al final del issue; el requerimiento original no se toca.
- Si el run estaba `implemented`, vuelve a `open`.
- Las auditorías de los nodos ya hechos siguen valiendo. Los votos y la pasada
  de requerimiento se repiten.

También puedes hacerlo desde el panel sin pasar por la sesión: vista Issue,
botón **Ampliar el alcance**, escribes el requerimiento. Entra como adenda de
`human` y el base la recibe en su siguiente señal de atención.

## 6. Pedir más cuando el run ya cerró: continuación

Un run cerrado **no se reabre**: su auditoría certifica exactamente lo que
contiene. Lo que sigue es un run nuevo que lo continúa. En cualquier sesión:

```
/hrp continúa el run 9fe3df77: ahora que el tema se guarda, quiero que también se guarde el idioma
```

El base abre el run con `continues: 9fe3df77`. Su rama nace de la punta de la
rama anterior, así que hereda el trabajo aunque todavía no lo hayas fusionado.
En la vista Issue, la sección **Historia** muestra la cadena completa. Los
auditores se enganchan igual, con el id nuevo.

Regla rápida:

| Estado del run | Qué hacer |
|---|---|
| `open` o `implemented` | Adenda: "agrega esto al run". |
| `closed` | Continuación: "continúa el run <id>". |
| `stopped` | Reanudar desde el panel; luego adenda si hace falta. |

No hace falta nombrar herramientas: la skill sabe qué hacer en cada estado.

## 7. Si la sesión perdió el contexto

Dile "sigue con el run" o "en qué va el run 9fe3df77". La sesión recupera su
identidad con `hrp_service_status` y el estado con `hrp_run_state`. No abras
otro run para el mismo requerimiento.

## 8. Servicio y mantenimiento

```sh
hrp service status        # ¿corre? ¿con qué build?
hrp service start
./scripts/update.sh       # tras cambiar este repositorio: recompila y reinicia
hrp agent status          # skill, MCP y despertador por agente
```

El panel avisa con **Reinicia HRP** cuando el servicio corre un build viejo.
