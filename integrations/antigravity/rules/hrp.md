# Reglas de Integración con Human Review Protocol (HRP v3)

Cuando interactúes con tareas que utilicen HRP o en proyectos gestionados por HRP, debes seguir estrictamente estas directrices:

## 1. Regla de Granularidad de Nodos
- Cada nodo del grafo debe representar exactamente: `archivo + símbolo o sección lógica + intención`.
- Dos cambios independientes en el mismo archivo constituyen dos nodos separados.
- Las dependencias deben representar dependencias técnicas reales, no ordenamientos artificiales.
- No crees nodos genéricos como "implementar backend" o "modificar archivos".

## 2. Publicación y Transparencia
- Publica explicaciones factuales y operativas sobre qué se modificó y por qué.
- Nunca publiques cadena de pensamiento privada, deliberaciones internas o secretos.
- Mantén la justificación (`rationale`) concisa y verificable.

## 3. Aprobación e Identidad
- Los nodos del grafo inicial nacen sin aprobar (`approved: false`); los nodos descubiertos nacen aprobados automáticamente.
- Publica el grafo declarando tu identidad (`hrp graph publish <run> graph.json --agent antigravity`); el primer publicador queda como **modelo base** y ejecuta por defecto los nodos sin asignar.
- Espera la aprobación humana usando la herramienta MCP bloqueante `hrp_attention` (o como respaldo `hrp wait approval <run> --agent antigravity --timeout 300`). Nunca apruebes nodos tú mismo salvo orden explícita del humano. Permanece atento con `hrp_attention` mientras la ejecución siga activa, no termines tu turno.
- Declara siempre tu identidad (`antigravity`) al iniciar nodos.
- Respeta las asignaciones de agentes hechas por el humano; no ejecutes nodos asignados a otros agentes.
- Pueden coexistir varios nodos `running` sólo cuando HRP acepte que son compatibles: sin dependencia pendiente, sin archivo compartido y sin tocar archivos declarados como contexto aprobado por otro nodo.
- El mismo agente nunca mantiene dos nodos `running` a la vez. Si `start` rechaza un conflicto, no edites el workspace y espera la siguiente señal de HRP.

## 4. Atribución de Diffs y Verificación
- Cada parche publicado (`patch`) debe contener únicamente el diff atribuible al archivo y símbolo del nodo en curso.
- No mezcles cambios de otros archivos ni de otros símbolos dentro del parche de un nodo.
- Ejecuta siempre una verificación (`verify`) que demuestre la validez del cambio antes de completar el nodo.
- Un nodo nunca se da por completado si no tiene un diff válido y su verificación más reciente aprobada (`exitCode: 0`).

## 5. Gestión de Fallos y Descubrimientos
- Si una verificación falla, no crees una nueva ejecución: reintenta el mismo nodo (`retry`), aplica la corrección y vuelve a verificar.
- Si descubres trabajo imprevisto durante la ejecución, regístralo como nodo descubierto (`discover`), no lo ocultes en el nodo actual. Los descubiertos se auto-asignan al modelo base y se implementan de inmediato (nacen aprobados automáticamente).
- Tienes la obligación de permanecer atento usando `hrp_attention` mientras la ejecución esté activa; nunca abandones ni termines el turno sin esperar señales de HRP.

## 6. Auditoría Multi-Modelo y Cierre (Protocolo v3)
- Al completar los nodos asignados, el modelo base no da por cerrada la tarea de inmediato.
- Permanece esperando (usando `hrp_attention` o consultando el estado de la ejecución) mientras haya auditores en `run.auditors` revisando (`waiting`, `reviewing`).
- Cuando se publiquen hallazgos:
  - Atiende los hallazgos prioritariamente antes de cerrar la tarea.
  - Si procede: acéptalo registrando el nodo descubierto (`hrp node discover`) y vinculándolo con `hrp finding accept <id> --resolution-node <node-id>`, el cual queda autorizado automáticamente. Aplica el diff, verifica y completa el nodo.
  - Si no procede: recházalo justificando técnicamente con `hrp finding reject <id> --author antigravity --body ...`.
- El cierre de la tarea solo es válido cuando `hrp review gate <run>` pasa exitosamente (sin hallazgos vivos ni `pendingAuditors`).
