# Skills por agente: ubicaciones y actualización

HRP mantiene una skill por agente soportado. Codex recibe además un plugin completo que registra el servidor MCP local. Las fuentes canónicas viven versionadas en este repositorio, bajo `integrations/`; nunca edites la copia instalada o cacheada.

## Fuentes canónicas en el repositorio

```text
integrations/claude/skills/hrp/SKILL.md
integrations/codex/plugins/hrp/skills/use-hrp/   (SKILL.md, references/, agents/, scripts/)
integrations/codex/plugins/hrp/.codex-plugin/plugin.json
integrations/codex/plugins/hrp/.mcp.json
integrations/codex/.agents/plugins/marketplace.json
integrations/antigravity/skills/hrp/SKILL.md
integrations/antigravity/rules/hrp.md
```

La skill de Claude no incluye `references/agent-adapter.md` en su fuente: el instalador la genera copiando `docs/agent-adapter.md`, de modo que el contrato distribuido siempre es el vigente.

## Dónde vive la skill de cada agente

| Agente | Global (todas las carpetas) | Local (por workspace) |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/hrp/` | `<workspace>/.claude/skills/hrp/` |
| Codex | plugin `hrp@hrp-local` en la caché de Codex; la copia compatible de la skill queda en `~/.agents/skills/use-hrp/` | `<workspace>/.codex/skills/use-hrp/` o `<workspace>/.agents/skills/use-hrp/` |
| Antigravity | `~/.gemini/config/skills/hrp/` | `<workspace>/.agents/skills/hrp/` y `<workspace>/.agents/rules/hrp.md` |

Notas:

- El destino de la copia compatible de la skill de Codex puede cambiarse con `HRP_CODEX_SKILLS_DIR`; el plugin siempre se instala desde el marketplace local `integrations/codex`.
- Las reglas globales de Antigravity viven en `~/.gemini/GEMINI.md` (archivo compartido con otras reglas del usuario); HRP no lo modifica automáticamente. Las reglas de HRP se distribuyen por workspace en `.agents/rules/hrp.md`, como hace este propio repositorio.
- Los archivos `AGENTS.md` (global `~/.codex/AGENTS.md`, o en la raíz del workspace) son la alternativa siempre-activa para agentes sin soporte de skills; el bloque reutilizable está en `docs/agent-adapter.md`.
- Este repositorio incluye su propia instalación local de Antigravity en `.agents/` (skills, reglas y el MCP `hrp mcp`), que sirve además como ejemplo de instalación por workspace.

## Instalar Codex desde cero

Desde la raíz de HRP ejecuta:

```sh
./scripts/install-codex.sh
```

El instalador realiza en orden estas operaciones:

1. instala o actualiza la skill compatible en `~/.agents/skills/use-hrp/`;
2. enlaza el CLI en `~/.local/bin/hrp`;
3. registra `integrations/codex` como marketplace local `hrp-local` si todavía no existe;
4. instala `hrp@hrp-local`, cuyo manifiesto declara `./.mcp.json` y el servidor `hrp`;
5. conserva `hrp` CLI como fallback si MCP no está disponible.

No agregues la raíz del repositorio como marketplace: el manifiesto soportado vive en `integrations/codex/.agents/plugins/marketplace.json`. Tampoco copies manualmente `.codex-plugin/plugin.json`.

Verifica la instalación con:

```sh
codex plugin list
codex mcp list
```

La primera salida debe mostrar `hrp@hrp-local installed, enabled` y la segunda un servidor `hrp` habilitado. Codex resuelve las skills y herramientas al abrir una tarea: después de instalar o actualizar, crea una tarea nueva. Una tarea que ya estaba abierta seguirá usando la versión anterior aunque la caché haya cambiado.

## Instalar skills y actualizar HRP

```sh
hrp skills install all          # instala sólo las skills compatibles
hrp skills status               # al día / desactualizada / no instalada / ajena
hrp skills update               # reinstala solo lo propio que quedó desactualizado
```

Cada instalación escribe un recibo `.hrp-install-source` con la ruta de su fuente. Ese recibo delimita la propiedad:

- un destino **sin recibo** o con recibo de otra fuente se considera ajeno y nunca se toca (instalarlo encima requiere borrarlo a mano);
- `update` y la sincronización automática solo reescriben destinos con recibo propio;
- el estado se decide comparando el digest del contenido instalado contra la fuente más sus extras, no por versión declarada.

## Actualización automática

`hrp service start` sincroniza las skills instaladas antes de reportar el estado del servicio: cualquier skill con recibo propio cuyo contenido difiera de la fuente se reinstala y se informa en la salida (`Skills sincronizadas con esta versión de HRP: …`). Esa sincronización no reemplaza el plugin cacheado de Codex.

El comando único recomendado es `scripts/update.sh`: compila, reinicia el servicio e instala/actualiza las **tres** skills (incluidas las que aún no estaban instaladas), terminando con el `status`:

```sh
cd /ruta/a/hrp
git pull
npm install
./scripts/update.sh
```

`scripts/update.sh` usa `scripts/install-codex.sh`, por lo que también reinstala el plugin. Cada versión fuente del plugin debe usar la misma base semántica que `package.json` y un único sufijo `+codex.<cachebuster>`; así Codex no conserva una copia anterior durante desarrollo local.
