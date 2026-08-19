# Reglas de Integración con Human Review Protocol (HRP v2.1)

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
- Todo nodo nace sin aprobar (`approved: false`).
- Espera la aprobación humana antes de llamar a `start` en un nodo.
- Declara siempre tu identidad (`antigravity`) al iniciar nodos.
- Respeta las asignaciones de agentes hechas por el humano; no ejecutes nodos asignados a otros agentes.
- Trabaja un solo nodo activo (`running`) a la vez por ejecución.

## 4. Atribución de Diffs y Verificación
- Cada parche publicado (`patch`) debe contener únicamente el diff atribuible al archivo y símbolo del nodo en curso.
- No mezcles cambios de otros archivos ni de otros símbolos dentro del parche de un nodo.
- Ejecuta siempre una verificación (`verify`) que demuestre la validez del cambio antes de completar el nodo.
- Un nodo nunca se da por completado si no tiene un diff válido y su verificación más reciente aprobada (`exitCode: 0`).

## 5. Gestión de Fallos y Descubrimientos
- Si una verificación falla, no crees una nueva ejecución: reintenta el mismo nodo (`retry`), aplica la corrección y vuelve a verificar.
- Si descubres trabajo imprevisto durante la ejecución, regístralo como nodo descubierto (`discover`), no lo ocultes en el nodo actual.
