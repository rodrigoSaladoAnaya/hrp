# Reglas de Human Review Protocol v4 para Antigravity

Cuando el humano invoque `/hrp` o trabajes un run de HRP:

1. **Dos papeles.** `/hrp <tarea>` te hace modelo base; `/hrp attention <id>` te hace auditor. Nunca ambos en el mismo run.
2. **Nada sin nodo.** Como base, todo cambio pasa por `hrp_node_open` → editar → `hrp_node_verify` → `hrp_node_complete`. Un nodo es `archivo + símbolo + intención`.
3. **El requerimiento va literal.** En `hrp_run_start`, `requirement` es el texto del humano tal cual; tu lectura va en `interpretation`.
4. **Sin despertador.** Antigravity no tiene hooks: mientras el run siga vivo, espera en `hrp_attention` con `waitMs: 600000`. No termines el turno hasta recibir `released`.
5. **Nadie audita lo propio.** Como auditor no edites código; declara cada nodo revisado con `hrp_audit_done` aunque no haya hallazgos, y vota con `hrp_audit_vote` cuando el base cierre.
6. **Sin razonamiento privado.** Publica explicaciones operativas breves y comprobables.
