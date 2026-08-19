---
target: granularidad fina del grafo y evidencia por archivo
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
timestamp: 2026-08-18T23-45-49Z
slug: apps-web-src-app-tsx
---
# Crítica: granularidad de revisión en HRP

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 2/4 | El estado del nodo es claro, pero la cobertura por cambio/archivo es invisible. |
| 2 | Match System / Real World | 2/4 | “1 cambio” representa seis archivos y varias decisiones. |
| 3 | User Control and Freedom | 2/4 | No se puede intervenir por archivo, hunk o línea. |
| 4 | Consistency and Standards | 3/4 | El tab del primer archivo contradice el alcance multiarchivo. |
| 5 | Error Prevention | 2/4 | Un solo AUTO autoriza cambios heterogéneos. |
| 6 | Recognition Rather Than Recall | 2/4 | El humano debe inferir qué motivo corresponde a cada archivo. |
| 7 | Flexibility and Efficiency | 2/4 | No hay navegación ni filtros por operación, archivo o riesgo. |
| 8 | Aesthetic and Minimalist Design | 3/4 | Buena composición, evidencia insuficiente para el espacio ocupado. |
| 9 | Error Recovery | 2/4 | No avisa si el diff es sintético, incompleto o truncado. |
| 10 | Help and Documentation | 1/4 | No explica procedencia ni por qué faltan Antes/Después. |
| **Total** | | **21/40** | **Acceptable** |

## Design Specificity Verdict

Visualmente específico, interaccionalmente incompleto. El cue desk de tres carriles es propio de HRP y cuenta bien intención → control humano → evidencia. Sin embargo, el grafo sólo conoce fases amplias y el reel convierte un evento multiarchivo en un único “cambio”, por lo que la unidad real de revisión sigue siendo una tarjeta genérica más un log.

El detector mecánico devolvió `[]`; es un blind spot esperado porque la falla es semántica y de arquitectura de información, no un patrón superficial de markup.

La estructura correcta no es un nodo canónico por archivo. Debe ser: nodo semántico (decisión verificable) → operaciones hijas por archivo/símbolo/hunk → evidencia real y verificaciones mapeadas. La vista por archivo es una proyección alternativa útil, no la fuente del grafo.

## Overall Impression

La interfaz inspira confianza al entrar y la pierde al inspeccionar: Q01 agrupa seis archivos y varias decisiones, pero el tab dice `package.json` y muestra un resumen narrativo coloreado como diff. El humano sabe que terminó, no qué hizo ni por qué cada modificación era necesaria.

## What's Working

1. La composición de tres carriles mantiene intención, control y evidencia juntas.
2. Los estados escritos (`REVISAR`, `OBSERVAR`, `AUTO`, `TERMINADO`) no dependen sólo del color.
3. El protocolo ya soporta targets precisos (`file`, `line`, `patchId`) y causalidad, aunque la UI no los expone.

## Priority Issues

### [P1] La unidad de revisión es demasiado gruesa

Un nodo mezcla dependencia, esquema, persistencia, registro, contextos, migración y pruebas. Una sola política aplica a riesgos distintos. Dividir por decisiones independientemente explicables, verificables y reversibles; usar operaciones hijas para los archivos.

### [P1] El resumen sintético se presenta como diff real

El protocolo acepta cualquier string en `diff` y la UI colorea prefijos `+`. Modelar `unified_diff`, `snapshot_pair`, `change_summary` y `workspace_observation`. Si no hay código, mostrar “Resumen reportado por el agente; no se publicó diff”.

### [P1] La evidencia multiarchivo está colapsada

El tab usa `files[0]` aunque el evento cubre múltiples rutas. Mostrar operaciones por archivo con motivo local, símbolos, estadísticas y hunks expandibles.

### [P1] La UI descarta targeting preciso

La observación siempre se envía al nodo. Añadir comentar operación/archivo/hunk/línea con target prellenado y visible.

### [P2] Verificación binaria sin cobertura

La verificación se asocia por orden temporal y parece certificar todo. Dar IDs a criterios y operaciones; cada resultado debe declarar cobertura y quedar stale tras un patch posterior.

## Persona Red Flags

**Alex (Power User):** no puede navegar por archivo/símbolo/riesgo, aplicar políticas distintas ni saltar al siguiente cambio sin revisar. Volverá al IDE o confiará ciegamente en el verde.

**Sam (Accessibility):** el reel es un `<pre>` multiarchivo sin secciones semánticas; el resumen sintético se anuncia igual que código y el target debe reconstruirse de memoria en otro formulario.

**Riley (Stress Tester):** acepta narrativa como diff, no muestra truncamiento, oculta alternativas posteriores a la primera y enlaza verificación por proximidad temporal.

## Minor Observations

- “1 cambios” debe ser singular.
- “Cambios en tiempo real” sobrepromete para evidencia agregada y terminada.
- Mantener breadcrumb sticky del nodo seleccionado.
- Colapsar coincidencias entre previstos/observados y resaltar faltantes o inesperados.
- Explicar por qué Antes/Después están deshabilitados.
- Diferenciar mucho más evidencia del agente y observación independiente.

## Questions to Consider

1. ¿Cuál es la unidad mínima que puede aprobarse, rechazarse y verificarse independientemente?
2. ¿Qué evidencia debe ser obligatoria antes de llamar “Terminado” a un cambio semántico?
3. ¿Debe el grafo alternar entre vista semántica y vista por archivo?
