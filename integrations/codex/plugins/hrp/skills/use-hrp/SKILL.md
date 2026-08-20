---
name: use-hrp
description: Conecta una tarea de código con HRP v3 para publicar un mapa granular, ejecutar cambios aprobados y participar en la revisión multi-modelo con evidencia por nodo. Úsalo cuando el usuario invoque $use-hrp o pida trabajar, observar o revisar una ejecución HRP; no lo uses en tareas que no solicitan HRP.
---

# Use HRP

HRP es un protocolo local neutral. Esta skill traduce el ciclo de trabajo de Codex al protocolo 3.0 sin agregar archivos ni configuración al proyecto observado.

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
11. Al completar un nodo, reporta tu consumo con `--tokens N` únicamente si tu entorno expone el uso real de tokens; si no lo conoces, omite el parámetro. Nunca inventes el número.

## Rol dentro de la ejecución

Consulta `run.baseAgent` antes de actuar:

- Si es `codex`, eres el agente base: trabajas nodos sin asignar o asignados a `codex`, administras los sugeridos para `ollama`, atiendes los hallazgos y no entregas hasta que `hrp review gate <run-id>` pase.
- Si el base es otro agente, eres colaborador: trabaja únicamente nodos asignados a `codex`. No tomes nodos sin asignar, no administres `ollama` y no aceptes, rechaces ni escales hallazgos en nombre del base.
- Si el usuario te entrega un paquete de revisión, eres revisor: reporta y debate hallazgos, pero nunca edites código.

## Revisión v3

Cuando seas el base, los hallazgos pendientes tienen prioridad sobre iniciar trabajo nuevo. Lee el hilo completo y decide con evidencia:

- Si procede, publica un nodo de corrección y usa `hrp finding accept <id> --resolution-node <nodo>`; la aceptación autoriza ese nodo.
- Si no procede, usa `hrp finding reject <id> --author codex --body RAZON` con argumento técnico verificable.
- Usa `hrp finding escalate <id>` sólo para ambigüedades genuinas que la evidencia no resuelva.

La auditoría final se lanza automáticamente al completarse el run. El base espera sus resultados, resuelve los hallazgos y confirma `hrp review gate`. Un colaborador termina cuando sus nodos asignados quedan completados y entrega el control al base.

## Pausas humanas

Cuando el grafo quede esperando aprobación, la espera normal es `hrp wait approval` con tu identidad; si el entorno no permite bloquear o el timeout se agota repetidamente, entrega al usuario el título de la ejecución, su identificador y la URL del panel, y termina el turno. Al reanudarse la tarea, consulta el estado persistido antes de actuar; no vuelvas a crear la ejecución ni repitas parches ya aplicados.

## Límites de versión

No uses comandos ni conceptos de HRP v1 como `plan publish`, `wait review`, `commands ack`, `REVISAR`, `OBSERVAR`, `AUTO` o replans versionados. En v3 el control combina aprobación inicial, asignación de agentes, evidencia observable y revisión multi-modelo.
