---
name: use-hrp
description: Conecta una tarea de código con HRP 2.2 para publicar un mapa granular de cambios, esperar aprobación humana y conservar diffs y verificaciones por nodo. Úsalo cuando el usuario invoque $use-hrp o pida observar y autorizar el trabajo desde HRP; no lo uses en tareas que no solicitan HRP.
---

# Use HRP

HRP es un protocolo local neutral. Esta skill traduce el ciclo de trabajo de Codex al protocolo 2.2 sin agregar archivos ni configuración al proyecto observado.

Antes de la primera operación HRP de una tarea, lee [references/agent-workflow.md](references/agent-workflow.md).

## Transporte

- Si están disponibles herramientas MCP `hrp_*`, prefiérelas.
- En caso contrario usa el CLI `hrp`. Si no está en `PATH`, ejecuta [scripts/hrp](scripts/hrp) desde esta skill.
- No instales MCP, hooks ni dependencias dentro del proyecto objetivo como efecto de usar HRP.

## Invariantes

1. Inspecciona el código suficiente y publica el mejor grafo conocido antes de modificar archivos, declarando tu identidad: `hrp graph publish <run-id> graph.json --agent codex`. El primer publicador queda como **modelo base** de la ejecución: ejecuta por defecto los nodos sin asignación y recibe automáticamente los nodos descubiertos.
2. Un nodo representa exactamente `archivo + símbolo o sección lógica + intención`. Separa cambios independientes, incluso dentro del mismo archivo.
3. Tras publicar o descubrir nodos, espera la aprobación humana con `hrp wait approval <run-id> --agent codex --timeout 300`: bloquea hasta que el clic del humano libere trabajo y sale con error reintentable si agota el tiempo. No uses `hrp node approve` ni `hrp_approve_nodes` en nombre del humano salvo que éste lo pida explícitamente.
4. Identifícate como `codex` al iniciar o reintentar. Respeta las asignaciones y no trabajes nodos asignados a otro agente; los nodos sin asignar pertenecen al modelo base.
5. Sólo puede existir un nodo en curso por ejecución. Si otro nodo está activo, no modifiques el workspace hasta que termine.
6. Para cada nodo sigue `start → editar únicamente su operación → patch → verify → complete`.
7. El patch debe incluir un diff exclusivo del archivo declarado, un resumen de lo que realmente hizo y por qué se hizo así. HRP rechaza diffs que mezclan otros archivos.
8. No completes un nodo sin diff no vacío y verificación exitosa.
9. Un fallo técnico se corrige con `retry` en el mismo nodo. El trabajo imprevisto se publica como nodo descubierto y vuelve a requerir aprobación.
10. Publica explicaciones operativas breves y comprobables; nunca cadena de pensamiento privada, credenciales ni secretos.

## Pausas humanas

Cuando el grafo quede esperando aprobación, la espera normal es `hrp wait approval` con tu identidad; si el entorno no permite bloquear o el timeout se agota repetidamente, entrega al usuario el título de la ejecución, su identificador y la URL del panel, y termina el turno. Al reanudarse la tarea, consulta el estado persistido antes de actuar; no vuelvas a crear la ejecución ni repitas parches ya aplicados.

## Límites de versión

No uses comandos ni conceptos de HRP v1 como `plan publish`, `wait review`, `commands ack`, `REVISAR`, `OBSERVAR`, `AUTO` o replans versionados. En 2.2 el control humano es la aprobación de nodos, la asignación de agente y el mapa observable.
