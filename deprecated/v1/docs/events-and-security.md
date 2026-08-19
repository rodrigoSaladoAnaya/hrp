# Eventos, causalidad y límites

## Envelope canónico

Cada línea de `.human-review/events.jsonl` contiene un `ProtocolEvent` inmutable con:

- `schemaVersion` y `sequence` para compatibilidad y orden total local;
- `source`: `agent`, `human`, `workspace`, `orchestrator` o `verification`;
- `planId`, `nodeId` y `changeId` cuando existe alcance semántico;
- `correlationId` para agrupar una operación;
- `causationId` para enlazar una consecuencia con el evento que la produjo;
- `evidence` para diffs reales por archivo, operaciones, comandos, cobertura y salidas observables;
- `data` para la carga estructurada necesaria al reconstruir estado.

Una resolución, exención o sustitución nunca modifica eventos anteriores. El estado actual se obtiene reproduciendo el historial.

## Políticas de revisión

`required`, `watch` y `auto` son políticas de atención, no estados de ejecución.

Cada cambio de política registra versión del plan, lista exacta de nodos afectados y fingerprint de cada nodo. Al replanificar:

- un nodo idéntico conserva la política humana;
- un nodo nuevo o semánticamente modificado vuelve a `required`;
- una revisión aprobada sólo autoriza el fingerprint que fue presentado.

Aplicar una política a una rama resuelve los descendientes en ese momento y persiste la lista concreta. El evento no depende de que el grafo futuro mantenga la misma topología.

## Comandos humanos

Las observaciones, decisiones, políticas y pausas generan `AgentCommand` pendientes. Un adaptador los consume y confirma mediante `ack`; mientras no lo haga, permanecen visibles como pendientes. Esto ofrece entrega al menos una vez. Los adaptadores deben deduplicar por `command.id`.

Una observación puede dirigirse a plan, nodo, cambio semántico, operación, archivo, símbolo, línea o patch. Si es bloqueante, el protocolo emite además un comando de pausa.

## Evidencia granular

Los planes `1.1` pueden declarar `changes` y `operations`. Cada patch granular incluye un `patchId`, un `changeId` y evidencia por archivo con los ids de operación, diff, resumen, motivo y conteo de líneas. Las verificaciones declaran `coversChangeIds`, `coversOperationIds` y `coversPatchIds`.

El estado `verified` de un cambio se deriva del replay: todas sus operaciones deben tener evidencia de diff y una verificación exitosa debe cubrir el cambio completo o todas sus operaciones. El servidor rechaza `node complete` mientras exista cobertura faltante. Los planes históricos sin `changes` siguen usando la regla anterior de última verificación exitosa.

## Observador de workspace

El observador Git compara periódicamente `status` y `diff`. Publica un snapshot sólo cuando cambia su hash. Sus eventos usan fuente `workspace` porque el protocolo no puede distinguir de forma fiable entre una edición del agente, del usuario o de otra herramienta.

Los diffs se limitan por `maxDiffBytes`. Los nombres de archivos continúan disponibles cuando el contenido queda truncado. Los archivos nuevos aparecen en el estado de Git, aunque Git no produce su diff hasta que el adaptador lo reporte o el archivo entre al índice.

## Límites de autoridad

- El servidor escucha por defecto sólo en `127.0.0.1`.
- No solicita ni almacena credenciales de proveedores de modelos.
- No ejecuta comandos suministrados por agentes.
- No aplica patches ni escribe archivos del workspace.
- Una verificación es evidencia reportada por un runner externo; el protocolo no garantiza que el comando realmente haya sido ejecutado.
- El observador Git es evidencia independiente, pero no una frontera de seguridad ni un sandbox.
- Cualquier proceso local capaz de llamar al puerto puede publicar eventos. Antes de exponerlo fuera de loopback se requiere autenticación y autorización.

La integridad fuerte depende del adaptador y del entorno de ejecución. El protocolo hace visibles las discrepancias; no sustituye el sandbox del agente.
