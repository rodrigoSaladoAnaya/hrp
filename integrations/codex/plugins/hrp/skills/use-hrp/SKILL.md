---
name: use-hrp
description: Conecta una tarea de programación con Human Review Protocol para mostrar al humano un grafo del plan, publicar cambios y verificaciones en tiempo real, detenerse en gates seleccionados y recibir observaciones dirigidas. Úsalo cuando el usuario diga “usa HRP”, pida revisión humana selectiva o quiera observar y dirigir el trabajo desde el panel HRP.
---

# Use HRP

HRP es un protocolo local neutral. Esta skill sólo enseña a Codex a hablar con él mediante el CLI `hrp`; no requiere MCP, hooks ni cambios en el repositorio objetivo.

## Flujo obligatorio

1. Lee [references/agent-workflow.md](references/agent-workflow.md) antes de ejecutar la primera operación HRP de la tarea.
2. Desde la raíz del proyecto objetivo, ejecuta `hrp attach . --start --json`. Si `hrp` no está en `PATH`, usa `scripts/hrp` resuelto desde esta skill.
3. Publica un DAG honesto antes de modificar archivos. Cada nodo agrupa una fase revisable y declara `changes`: decisiones semánticas finas con `operations` por archivo/símbolo. Cada operación explica qué cambiará y por qué; no escondas varias decisiones independientes en un resumen de fase.
4. Espera la aprobación inicial del plan. Haz esperas acotadas de hasta 50 segundos y vuelve a intentarlo mientras mantienes informado al usuario.
5. Antes de cada nodo, consulta `hrp state --json`:
   - `required`: solicita revisión del nodo y espera aprobación.
   - `watch` o `auto`: continúa sin crear un gate adicional.
6. Declara el inicio del nodo antes de editar. Trabaja con las herramientas normales del agente; HRP nunca reemplaza esas herramientas.
7. Publica cada patch con su `changeId`. HRP separa el diff real por archivo y lo liga a las operaciones declaradas. Publica verificaciones con cobertura de cambios/operaciones/patches; procesa los comandos humanos antes de completar el nodo y antes de una acción nueva significativa.
8. Confirma un comando con `hrp commands ack` sólo después de leerlo e incorporarlo. Una observación bloqueante o una pausa global detiene el trabajo hasta una instrucción de reanudación.
9. Completa el nodo únicamente después de una verificación publicada y exitosa.
10. Si una observación cambia supuestos, alcance o archivos, propone un replan versionado; no fuerces el cambio dentro del nodo original.

## Comportamiento con decisiones humanas

- `approved`: continúa con el flujo aprobado.
- `redirected`: incorpora la dirección y publica un replan si cambia el grafo.
- `rejected`: no implementes ese plan o nodo; vuelve a planear.
- `paused`: no hagas nuevas mutaciones ni ejecutes verificaciones hasta que el panel reanude la sesión.
- Un timeout del CLI no equivale a aprobación. Repite la espera.

## Límites

- No instales MCP ni agregues `AGENTS.md`, `.claude`, `.gemini` o archivos HRP al proyecto objetivo.
- No reconozcas comandos humanos por adelantado.
- No publiques archivos fuera de los declarados por el nodo. Si aparecen, detente y replantea.
- No atribuyas automáticamente al agente todos los cambios del workspace; puede haber cambios del usuario.
- Si el servicio no puede iniciarse o el workspace conectado no coincide, explica el bloqueo. No simules que HRP está activo.
