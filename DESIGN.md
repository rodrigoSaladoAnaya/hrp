# Diseño de HRP v3

Este documento describe el sistema visual y de interacción vigente de Human Review Protocol v3. Es una referencia para mantener coherencia al extender la interfaz; la intención del producto y sus límites funcionales siguen definidos en `PRODUCT.md`.

## Tesis visual

El grafo de ejecución es la interfaz principal. HRP evita una composición de dashboard con paneles equivalentes y presenta, en cambio, un tablero de enclavamiento ferroviario: una ruta técnica global a la izquierda y un único inspector de evidencia acoplado a la derecha.

La metáfora no es decorativa. Las operaciones son placas de ruta, las dependencias son vías dirigidas y los estados son señales. El usuario debe poder responder en una sola mirada:

1. qué operaciones componen el cambio;
2. en qué orden dependen unas de otras;
3. cuál está ejecutándose y cuáles terminaron;
4. qué intención, código y verificación corresponden a la operación seleccionada.

La dirección visual se inspira en un tablero ferroviario diurno: verde mineral, marfil, grafito, ámbar de movimiento y verde de señal completada. La interfaz debe sentirse técnica, sobria y legible, no como una consola oscura ni como una herramienta genérica de gestión.

## Principios de composición

- **El mapa domina.** La mayor superficie se reserva al grafo semántico; el inspector explica sólo el nodo activo.
- **Una operación, una placa.** Un nodo representa `archivo + símbolo o sección lógica + intención`, no un archivo completo ni una fase abstracta.
- **Intención y evidencia son distintas.** Antes de ejecutar se muestra qué hará y por qué. Después se muestra qué hizo, el diff y la verificación.
- **Estado escrito además de color.** Todas las señales incluyen icono y etiqueta textual.
- **Lo descubierto se declara.** Las operaciones añadidas durante la ejecución aparecen en el mismo mapa con la etiqueta `Descubierto`.
- **La actividad es secundaria.** Inspecciones, comandos, parches y verificaciones viven en una vista cronológica aparte; no compiten con el mapa.
- **Sin razonamiento privado.** La interfaz presenta razones operativas concisas, nunca cadena de pensamiento interna del modelo.

## Tokens visuales

Los tokens canónicos están declarados en `src/web/styles.css`.

| Token | Valor | Uso |
| --- | --- | --- |
| `--ink` | `#17201e` | Texto principal |
| `--ink-soft` | `#53615c` | Texto secundario |
| `--panel` | `#e6ebe7` | Superficies auxiliares |
| `--field` | `#ccd6d0` | Campo del mapa |
| `--paper` | `#f8f6ec` | Placas/nodos |
| `--rule` | `#a6b1ab` | Divisores |
| `--track` | `#3c4a46` | Dependencias y vías neutrales |
| `--pending` | `#4f5d58` | Operación pendiente |
| `--running` | `#8b4a08` | Operación en curso |
| `--completed` | `#13704f` | Operación terminada |
| `--failed` | `#a33a32` | Operación fallida |
| `--focus` | `#087e96` | Foco de teclado |

La barra superior usa grafito `#26322f`; los paneles de lectura son claros y el diff emplea una superficie oscura `#16211e`. Los colores de estado no deben reutilizarse como decoración: comunican exclusivamente progreso o resultado.

Las formas son contenidas: radios de 3–4 px, bordes visibles y sombras cortas. Las placas completadas y fallidas usan un borde de 3 px; las pendientes y en curso, 2 px. La selección es independiente del estado: cambia únicamente el borde a un azul medio sobrio y conserva intactos el fondo, el contenido y la profundidad del nodo. El estado continúa comunicado por su icono y texto.

## Tipografía

- **Display:** Saira Condensed 600/700, servida localmente mediante `@fontsource/saira-condensed`. Se usa en marca, encabezados y estados vacíos.
- **Interfaz:** Aptos, Segoe UI y `system-ui` como respaldo. Se usa para navegación, explicaciones y controles.
- **Código y datos:** `ui-monospace`, SFMono-Regular y Consolas. Se usa en archivos, símbolos, rutas, comandos, horas, verificaciones y diffs.

La jerarquía privilegia densidad legible: títulos condensados, metadatos pequeños pero de alto contraste y texto explicativo con interlineado amplio. Archivos y símbolos deben conservar su carácter técnico mediante monoespaciada y truncarse visualmente sin perder su valor accesible.

## Layout de escritorio

La aplicación ocupa el viewport y se organiza alrededor de una navegación persistente:

1. **Barra operacional, 74 px.** Contiene marca, progreso de la ejecución, carpeta activa y estado de conexión SSE.
2. **Árbol lateral, 300 px.** Muestra todos los proyectos y sus ejecuciones; prioriza trabajo en curso y luego ordena por actividad descendente.
3. **Superficie principal.** Contiene el selector `Mapa / Actividad` y se divide entre el mapa flexible y un inspector de `minmax(370px, 31vw)`.

El encabezado del mapa resume título, requerimiento y contador de operaciones terminadas. Debajo, React Flow presenta el grafo de izquierda a derecha, calculado con Dagre. Las dependencias usan flechas dirigidas; una arista en curso se destaca y puede animarse cuando no existe preferencia de movimiento reducido.

El inspector derecho es desplazable y mantiene fijo su encabezado. Su orden de lectura es:

1. archivo, símbolo y estado;
2. qué hará y por qué se planeó;
3. qué hizo y por qué se hizo así, cuando existe resultado;
4. dependencias directas;
5. diff aplicado o estado pendiente;
6. comando, resultado y salida de verificación.

El resultado nunca sustituye al plan. Ambos permanecen visibles como una historia breve del cambio. Si un adaptador anterior no publicó el porqué del resultado, la interfaz declara esa ausencia en lugar de inferirlo.

## Nodos y estados

Cada placa mide 272 px de ancho y al menos 148 px de alto. Su contenido estable es: archivo, etiqueta de descubrimiento opcional, símbolo, título de la operación y señal de estado.

| Estado | Tratamiento | Significado |
| --- | --- | --- |
| `pending` | Borde gris mineral, reloj, `Pendiente` | Declarada pero aún sin ejecución |
| `running` | Borde ámbar, reloj, `En curso`; arista destacada | El agente trabaja en esa operación |
| `completed` | Borde verde de 3 px, check, `Terminado` | Tiene diff real y verificación aprobada |
| `failed` | Borde rojo de 3 px, alerta, `Falló` | La aplicación o verificación no concluyó correctamente |

`Descubierto` es una procedencia, no un quinto estado. Identifica trabajo incorporado después del plan inicial y conserva cualquiera de los cuatro estados anteriores.

Una operación completada no debe representarse como terminada sólo por un mensaje del agente: el protocolo exige diff y verificación aprobada. Si todavía no existe diff, el inspector dice explícitamente `Sin código todavía`.

## Interacción

- El grafo es de sólo lectura: no permite arrastrar nodos, crear conexiones ni seleccionar aristas.
- El usuario puede desplazar y ampliar el lienzo; los controles de zoom tienen un objetivo mínimo de 44 × 44 px.
- Cada nodo es un botón real. Click, `Tab`, `Shift+Tab`, `Enter` y espacio permiten seleccionarlo; `aria-pressed` comunica la selección.
- Seleccionar un nodo actualiza el inspector sin navegación de página. El inspector usa una región viva moderada para anunciar el cambio.
- `Mapa` y `Actividad` son botones de estado con `aria-pressed`. La actividad vinculada a una operación permite regresar a ese nodo y abre el mapa.
- Los selectores de proyecto y ejecución actualizan la URL mediante `project` y `run`, por lo que una vista específica es compartible y recuperable.
- La conexión en vivo distingue `Conectando`, `En vivo` y `Sin conexión`; el último estado ofrece `Reintentar`.
- Un fallo recién observado selecciona automáticamente su nodo. El inspector explica que se reintenta dentro de la misma ejecución y conserva los intentos previos en Actividad.
- Los estados de carga, vacío y error son diferentes. No debe mostrarse un vacío mientras todavía se consulta el registro.

## Accesibilidad

- El foco visible usa un contorno de 3 px en `--focus` con separación de 3 px.
- Los controles interactivos principales mantienen un alto mínimo de 44 px.
- El progreso expone `role="progressbar"` y valores ARIA de 0 a 100.
- Iconos puramente visuales están ocultos al árbol accesible; los estados conservan texto.
- El color nunca es el único indicador de estado: borde, icono y etiqueta cambian juntos.
- La selección del nodo se comunica mediante `aria-pressed`; el foco de teclado conserva su contorno azul.
- Con `prefers-reduced-motion: reduce` se detienen la arista animada, la señal de carga y las transiciones del nodo, sin eliminar indiscriminadamente otros estilos.
- El contraste de texto secundario y estados debe mantenerse al menos en nivel AA al modificar la paleta.

## Responsive

### Hasta 1050 px

- El inspector crece proporcionalmente hasta 39 vw.
- Se reduce el texto visible de telemetría.
- Los rótulos `Proyecto` y `Ejecución` se ocultan, pero permanecen sus iconos y controles.

### Hasta 760 px

- La página pasa de viewport fijo a desplazamiento vertical.
- La barra superior se reorganiza en dos filas: marca/conexión y telemetría.
- Los selectores ocupan dos columnas; `Mapa / Actividad` forma una fila completa debajo.
- Mapa e inspector dejan de estar lado a lado. El mapa ocupa primero una altura de 62 vh con mínimo de 520 px y el inspector continúa debajo.
- Se compactan encabezados y márgenes, no los objetivos táctiles.
- La descripción del requerimiento se limita visualmente a dos líneas en el encabezado del mapa.

La anchura mínima soportada es 320 px. Los textos técnicos largos deben desplazarse, truncarse o envolver según su función; nunca deben ensanchar el viewport.

## Movimiento

El movimiento sirve sólo para indicar actividad:

- una arista animada señala la operación en curso;
- el estado de carga pulsa una señal central;
- el hover de una placa la eleva 2 px;
- los cambios de progreso y placa usan transiciones breves de 180 ms.

No se usan animaciones de entrada, fondos decorativos en movimiento ni efectos que compitan con la lectura causal.

## Despertador de agentes

Un agente que termina su turno deja de existir para HRP. El problema real que resuelve esta parte del diseño es que el humano no pueda desatenderse: los modelos se quedaban ciegos y había que pedirles a mano que retomaran.

**La decisión: el despertador es nativo de cada agente, sobre una única señal del servidor.** El servidor calcula qué debe hacer cada agente (`computeAttention`) y lo publica en `GET /api/attention`, con long-poll sobre el mismo emisor que alimenta el panel. Encima de esa señal, cada entorno usa el mecanismo que tiene:

| Entorno | Despertador |
| --- | --- |
| Claude Code | Hook `Stop` nativo: al intentar terminar el turno, HRP responde `{"decision":"block","reason":…}` y la sesión continúa. |
| Codex | El mismo esquema de hooks, declarado en el plugin (`hooks.json`). |
| Antigravity | Sin hooks: herramienta MCP bloqueante `hrp_attention`, donde la sesión se estaciona en vez de cerrar. |

**Por qué no hay un demonio global.** Se evaluó levantar un worker que escuchara los eventos por agente. Un proceso externo puede enterarse de todo y no puede hacer nada con ello: no existe forma de devolverle el turno a una sesión de agente desde fuera; sólo su propio entorno puede. Un demonio habría duplicado el estado del servicio y seguido dependiendo del hook o de la herramienta MCP para el último tramo, así que se descartó a favor de una sola señal servida por HTTP.

**Límites conocidos.** El hook actúa al terminar el turno: una sesión ya cerrada no se puede despertar —al abrir la siguiente, el hook `SessionStart` inyecta las ejecuciones vivas del workspace para que retome—. Y ningún entorno recarga hooks, MCP o skills en sesiones abiertas.

**Antibucle.** Retener una sesión indefinidamente sería el defecto simétrico. El hook cuenta las esperas consecutivas sin señal por `session_id` y, tras 40, suelta la sesión con un `systemMessage`. La señal, además, nunca ordena lo imposible: no anuncia nodos con dependencias abiertas, ni trabajo ajeno mientras otro nodo está en vuelo, ni el cierre de una ejecución que ya no tiene nada que cerrar.

## Reconfiguración en caliente

Un agente puede quedarse sin presupuesto a mitad de una ejecución, y con él se va su trabajo asignado y su turno de auditoría. La pausa es el punto de control donde el humano rehace el reparto: mientras `run.control` es `paused`, puede cambiar la lista de auditores —congelada mientras la ejecución corre— y reasignar nodos, incluido el que quedó en vuelo, que vuelve a `pending` conservando el diff y la verificación del intento como evidencia. Cada cambio queda en Actividad con su antes y después, y los demás agentes se enteran por la misma señal: su espera despierta con el cambio y la directiva de pausa les ordena releer el estado antes de retomar.

## Límites actuales

HRP v3 es una superficie local y de un solo usuario. Esta versión:

- no incluye modos `REVISAR`, `OBSERVAR` o `AUTO` por nodo;
- no almacena ni solicita cadena de pensamiento;
- no depende de Codex, Claude, Gemini, skills o MCP;
- no convierte el historial cronológico en el modelo principal de navegación.

Las capacidades de aprobación, pausa y revisión deben reforzar la claridad de esta base: cada operación sigue siendo granular, causal, seleccionable y verificable.

## Reglas para futuras extensiones

1. No introducir un panel permanente nuevo si la información puede vivir en el mapa, el inspector o la actividad.
2. No agrupar varios símbolos de un archivo en un solo nodo por conveniencia visual.
3. No marcar como completada una operación sin evidencia verificable.
4. No sustituir etiquetas de estado por color o animación.
5. No exponer logs crudos como explicación de intención.
6. Mantener los contratos neutral al proveedor y separados de cualquier adaptador de agente.
7. Probar cualquier cambio visual en escritorio, 1050 px, 760 px y 320 px, con teclado y movimiento reducido.
