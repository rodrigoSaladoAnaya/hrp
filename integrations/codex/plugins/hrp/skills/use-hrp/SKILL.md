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
- No instales MCP, hooks ni dependencias dentro del proyecto objetivo como efecto de usar HRP; la integracion se verifica aparte con `hrp agent install codex`.

## Invariantes

1. Inspecciona el código suficiente y publica el mejor grafo conocido antes de modificar archivos, declarando tu identidad: `hrp graph publish <run-id> graph.json --agent codex`. El primer publicador queda como **modelo base** de la ejecución: ejecuta por defecto los nodos sin asignación y recibe automáticamente los nodos descubiertos.
2. Un nodo representa exactamente `archivo + símbolo o sección lógica + intención`. Separa cambios independientes, incluso dentro del mismo archivo.
3. Publicar el grafo dispara una **auditoría del plan** (protocolo 3.2): los auditores elegidos revisan el grafo —no código, que aún no existe— buscando nodo faltante, corte incorrecto, dependencia mal declarada, nodo sin verificación observable o nodo fuera del requerimiento. Es una sola ronda por versión del grafo y **no bloquea nada**: ni la aprobación, ni el arranque, ni el cierre. Sus hallazgos llegan con `scope: "plan"` y sin `nodeId`; atiéndelos antes de que el humano apruebe: si proceden, **corrige el grafo y vuelve a publicarlo** —no abras un nodo descubierto, lo que está mal es el plan—, y si no, recházalos con una razón técnica y verificable, que es lo que el humano leerá junto al botón de aprobar. Con auditores de sesión la ronda no se lanza sola: genera el paquete con `hrp graph review <run-id>` y pide al humano que lo copie; ese mismo comando relanza la ronda de ollama si falló. No la trates como una certificación del plan.
4. Tras publicar el grafo inicial, espera la aprobación humana con `hrp wait approval <run-id> --agent codex --timeout 300`: bloquea hasta que el clic del humano libere trabajo y sale con error reintentable si agota el tiempo. Los nodos descubiertos dentro de una ejecución ya aprobada nacen aprobados automáticamente y se implementan en cuanto sus dependencias estén listas. No uses `hrp node approve` ni `hrp_approve_nodes` en nombre del humano salvo que éste lo pida explícitamente.
5. Identifícate como `codex` al iniciar o reintentar. Respeta las asignaciones y no trabajes nodos asignados a otro agente; los nodos sin asignar pertenecen al modelo base.
6. Pueden existir varios nodos en curso sólo cuando HRP acepte que son compatibles: sin dependencia pendiente, sin archivo compartido y sin tocar archivos que otro nodo usa como contexto aprobado. El mismo agente nunca sostiene dos nodos `running`; si ya tienes uno, ciérralo antes de tomar otro. Si `start` rechaza el nodo por conflicto, no modifiques el workspace y espera la siguiente señal.
7. Para cada nodo que HRP te permita iniciar sigue `start → editar únicamente su operación → patch → verify → complete`.
8. El patch debe incluir un diff exclusivo del archivo declarado, un resumen de lo que realmente hizo y por qué se hizo así. HRP rechaza diffs que mezclan otros archivos.
9. No completes un nodo sin diff no vacío y verificación exitosa. Mientras otro nodo esté en vuelo, el comando de verificación debe nombrar el archivo, el símbolo o el id de este nodo; los comandos de proyecto entero se rechazan hasta que el workspace quede libre.
10. Un fallo técnico se corrige con `retry` en el mismo nodo. El trabajo imprevisto se publica como nodo descubierto, queda aprobado automáticamente y sigue el mismo ciclo `start → patch → verify → complete` sin otro clic humano.
11. Publica explicaciones operativas breves y comprobables; nunca cadena de pensamiento privada, credenciales ni secretos.
12. Al completar un nodo, reporta tu consumo con `--tokens N` únicamente si tu entorno expone el uso real de tokens; si no lo conoces, omite el parámetro. Nunca inventes el número.

## Rol dentro de la ejecución

Consulta `run.baseAgent` antes de actuar:

- Si es `codex`, eres el agente base: trabajas nodos sin asignar o asignados a `codex`, administras los sugeridos para `ollama`, atiendes los hallazgos y no entregas hasta que `hrp review gate <run-id>` pase.
- Si el base es otro agente, eres colaborador: trabaja únicamente nodos asignados a `codex`. No tomes nodos sin asignar, no administres `ollama` y no aceptes, rechaces ni escales hallazgos en nombre del base.
- Si el usuario te entrega un paquete de revisión, eres revisor: reporta, debate y acuerda hallazgos sin editar código mientras actúes sólo en ese rol. Si HRP te asigna después la corrección de un hallazgo que reportaste, vuelves al rol ejecutor para ese nodo.

## Revisión v3

Cuando seas el base, los hallazgos pendientes tienen prioridad sobre iniciar trabajo nuevo. Lee el hilo completo y decide con evidencia:

- Si procede, publica un nodo de corrección y usa `hrp finding accept <id> --resolution-node <nodo>`; la aceptación autoriza ese nodo.
- Si no procede, usa `hrp finding reject <id> --author codex --body RAZON` con argumento técnico verificable.
- Usa `hrp finding escalate <id>` sólo para ambigüedades genuinas que la evidencia no resuelva.
- La creación registra el acuerdo del reportero y la aceptación registra el del base. Cada auditor que acepte la corrección usa `hrp_finding_agree` o `hrp finding agree <id> --author codex`; si discrepa, responde en el hilo.
- La unanimidad del base y todos los auditores asigna la corrección descubierta al reportero elegible sólo si otro auditor seleccionado distinto puede revisarla y no hay una asignación incompatible; sin ese revisor independiente, permanece con el modelo base. Ejecútala sólo cuando el estado HRP muestre esa asignación y no incluyas ese nodo en tu propia cobertura auditora.
- Reabrir el hallazgo reinicia el consenso. La unanimidad local del hallazgo no cambia la mayoría simple del gate final.

La auditoría final se lanza automáticamente al completarse el run. El base permanece atento mientras falten votos para la mayoría auditora; implementación completa no significa ejecución cerrada. Resuelve los hallazgos y confirma `hrp review gate`: el gate sólo pasa cuando no hay hallazgos vivos y `pendingAuditorVotes` es cero, aunque aún existan auditores sin voto que ya no bloquean la mayoría. Un colaborador termina cuando sus nodos asignados quedan completados y entrega el control al base.

Cuando Codex actúe como revisor, espera la señal **Auditoría disponible**, publica `agent status` en `reviewing` antes de leer el paquete, actualiza cobertura con `--reviewed` y `--remaining`, y publica `completed` únicamente al cubrir todos los nodos ajenos. Después vuelve a esperar: una corrección puede requerir otra pasada. Como revisor no tomes nodos sin asignación; la única excepción es una corrección que HRP haya reasignado explícitamente a `codex` tras la unanimidad, que debes ejecutar y dejar para auditoría de otro modelo.

## Despertador de Codex

El plugin de Codex instala hooks nativos en `hooks.json`. El hook `Stop` consulta HRP antes de dejar cerrar el turno: si hay trabajo accionable, bloquea la parada; si la ejecución sigue viva pero aún no te toca, te indica estacionarte en una espera explícita. El hook `SessionStart` inyecta contexto sólo cuando el workspace tiene ejecuciones HRP relevantes.

Cuando debas quedarte atento dentro del turno, usa la herramienta MCP bloqueante `hrp_attention` si está disponible. Como respaldo CLI usa:

```sh
hrp attention --agent codex --wait 600
```

No termines el turno mientras una ejecución activa tenga trabajo pendiente para `codex`: vuelve a consultar `hrp state <run-id> --json` cuando `hrp_attention` o `hrp attention` despierte, y retoma el nodo o la auditoría que indique la directiva. `hrp wait approval` queda para el gate humano del grafo inicial o para compatibilidad con instalaciones antiguas, no para esperar eventos ya aprobados.

## Pausas humanas

Cuando el grafo inicial quede esperando aprobación, la espera normal es `hrp wait approval` con tu identidad; si el entorno no permite bloquear o el timeout se agota repetidamente, entrega al usuario el título de la ejecución, su identificador y la URL del panel, y termina el turno. Después de aprobado, el estacionamiento normal es `hrp_attention` o `hrp attention --agent codex --wait 600`. Al reanudarse la tarea, consulta el estado persistido antes de actuar; no vuelvas a crear la ejecución ni repitas parches ya aplicados.

## Límites de versión

No uses comandos ni conceptos de HRP v1 como `plan publish`, `wait review`, `commands ack`, `REVISAR`, `OBSERVAR`, `AUTO` o replans versionados. En v3 el control combina aprobación inicial, asignación de agentes, evidencia observable y revisión multi-modelo.
