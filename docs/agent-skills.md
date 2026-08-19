# Skills por agente: ubicaciones y actualización

HRP mantiene una skill por agente soportado. Las fuentes canónicas viven versionadas en este repositorio, bajo `integrations/`, y se distribuyen a las rutas de cada agente con el comando `hrp skills`. Nunca edites la copia instalada: edita la fuente en el repo y sincroniza.

## Fuentes canónicas en el repositorio

```text
integrations/claude/skills/hrp/SKILL.md
integrations/codex/plugins/hrp/skills/use-hrp/   (SKILL.md, references/, agents/, scripts/)
integrations/antigravity/skills/hrp/SKILL.md
integrations/antigravity/rules/hrp.md
```

La skill de Claude no incluye `references/agent-adapter.md` en su fuente: el instalador la genera copiando `docs/agent-adapter.md`, de modo que el contrato distribuido siempre es el vigente.

## Dónde vive la skill de cada agente

| Agente | Global (todas las carpetas) | Local (por workspace) |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/hrp/` | `<workspace>/.claude/skills/hrp/` |
| Codex | `~/.agents/skills/use-hrp/` (estándar compartido; Codex también lee `~/.codex/skills/`) | `<workspace>/.codex/skills/use-hrp/` o `<workspace>/.agents/skills/use-hrp/` |
| Antigravity | `~/.gemini/config/skills/hrp/` | `<workspace>/.agents/skills/hrp/` y `<workspace>/.agents/rules/hrp.md` |

Notas:

- El destino de Codex puede cambiarse con la variable `HRP_CODEX_SKILLS_DIR`.
- Las reglas globales de Antigravity viven en `~/.gemini/GEMINI.md` (archivo compartido con otras reglas del usuario); HRP no lo modifica automáticamente. Las reglas de HRP se distribuyen por workspace en `.agents/rules/hrp.md`, como hace este propio repositorio.
- Los archivos `AGENTS.md` (global `~/.codex/AGENTS.md`, o en la raíz del workspace) son la alternativa siempre-activa para agentes sin soporte de skills; el bloque reutilizable está en `docs/agent-adapter.md`.
- Este repositorio incluye su propia instalación local de Antigravity en `.agents/` (skills, reglas y el MCP `hrp mcp`), que sirve además como ejemplo de instalación por workspace.

## Instalar y actualizar

```sh
hrp skills install all          # o claude | codex | antigravity
hrp skills status               # al día / desactualizada / no instalada / ajena
hrp skills update               # reinstala solo lo propio que quedó desactualizado
```

Cada instalación escribe un recibo `.hrp-install-source` con la ruta de su fuente. Ese recibo delimita la propiedad:

- un destino **sin recibo** o con recibo de otra fuente se considera ajeno y nunca se toca (instalarlo encima requiere borrarlo a mano);
- `update` y la sincronización automática solo reescriben destinos con recibo propio;
- el estado se decide comparando el digest del contenido instalado contra la fuente más sus extras, no por versión declarada.

## Actualización automática

`hrp service start` sincroniza las skills instaladas antes de reportar el estado del servicio: cualquier skill con recibo propio cuyo contenido difiera de la fuente se reinstala y se informa en la salida (`Skills sincronizadas con esta versión de HRP: …`).

El comando único recomendado es `scripts/update.sh`: compila, reinicia el servicio e instala/actualiza las **tres** skills (incluidas las que aún no estaban instaladas), terminando con el `status`:

```sh
cd /ruta/a/hrp
git pull
npm install
./scripts/update.sh
```

El instalador histórico `scripts/install-codex.sh` sigue funcionando y usa el mismo recibo, así que ambas vías son intercambiables para Codex (además enlaza el CLI en `~/.local/bin/hrp`).
