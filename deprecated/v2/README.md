# HRP v2 (deprecado)

Copia congelada del contrato del protocolo **2.6**, última versión de la línea v2.

- La v2 completa (código, docs, web) vive en la rama git `v2` y el tag `v2.6.0`.
- `agent-adapter.md` y `SKILL.md` son la referencia rápida del contrato v2: delegación
  económica a Ollama Cloud como **ejecutor** (triaje fábrica/creativo, `hrp ollama exec`,
  paquete anti-alucinación: contextFiles, protocolo NECESITO, temperatura 0,
  verificación ejecutable).
- La v3 cambia el objetivo: de ahorro de tokens a **calidad mediante auditoría
  multi-modelo** — los otros modelos actúan como revisores que debaten hallazgos con el
  agente base, con arbitraje humano. La guía v2 de delegación sigue vigente como
  criterio secundario de ejecución.

No editar estos archivos; los contratos vivos están en `docs/agent-adapter.md` y
`integrations/claude/skills/hrp/SKILL.md`.
