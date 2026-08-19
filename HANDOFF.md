# Handoff de Human Review Protocol

Actualizado: 2026-08-18

Este archivo permite continuar el trabajo con Codex, Claude, Gemini u otro agente sin depender del historial de la conversación original.

## Objetivo del producto

HRP ofrece al programador una vista humana y en tiempo real del trabajo de un agente: plan en forma de grafo, intención, archivos, patches y verificaciones. El humano puede comentar, pausar, redirigir y marcar nodos o ramas como `required`, `watch` o `auto`.

La arquitectura debe seguir neutral. Codex, Claude o Gemini son adaptadores reemplazables; el protocolo, los eventos y el panel no deben conocer detalles de un proveedor.

## Estado implementado

La versión del repositorio es `0.4.0`; la versión del protocolo es `1.1`.

- Core HTTP + SSE funcional en `apps/server`.
- Registro compartido SQLite (`.human-review/hrp.sqlite`) con proyectos y event streams aislados por `project_id`.
- Importación automática, no destructiva y de una sola vez desde el JSONL heredado de cada carpeta.
- `ProjectManager` con un orquestador, observador, sesión y SSE independientes por proyecto.
- Observador Git independiente.
- Panel React con franja de proyectos por nombre/ruta, grafo, evidencia, observaciones y políticas por nodo/rama.
- Modelo granular neutral: `PlanNode` (fase/gate) → `SemanticChange` (decisión) → `ChangeOperation` (archivo/símbolo) → evidencia de patch.
- El panel ofrece las proyecciones **Cambios** y **Plan**. La primera dibuja un nodo por cambio semántico, muestra sus operaciones y permite navegar al diff real por archivo.
- Los patches granulares conservan `patchId`, `changeId`, operación, motivo, símbolo, diff por archivo y conteos de líneas.
- Las verificaciones declaran cobertura de cambios, operaciones y patches. El servidor rechaza el cierre si falta cualquier diff o cobertura exitosa.
- Las observaciones del panel conservan el target fino: cambio, operación, archivo, símbolo y patch.
- Compatibilidad de replay con corridas `1.0`; la UI las identifica como evidencia heredada sin inventar granularidad.
- Scripts `run`, `start`, `status` y `stop` con proyecto posicional/flag y base compartida automática.
- CLI neutral en `packages/cli/bin/hrp.mjs`.
- Skill/plugin opt-in de Codex en `integrations/codex/plugins/hrp`.
- Marketplace de equipo en `integrations/codex/.agents/plugins/marketplace.json`.
- Instalador y desinstalador no destructivos en `scripts/install-codex.sh` y `scripts/uninstall-codex.sh`.
- Verificador de descubrimiento real en `scripts/verify-codex-skill.mjs`; usa `skills/list` del App Server y exige el nombre directo `use-hrp`, no el calificado `hrp:use-hrp`.
- `status` y `stop` descubren instancias HRP iniciadas con `run.sh`/`npm start` aunque no exista `server.pid`; sólo detienen listeners validados como pertenecientes a esta copia.
- `start` también reutiliza una instancia sana sin PID, registra en ella la carpeta solicitada y evita el falso conflicto de workspace.
- Contrato portable para otros agentes en `integrations/AGENT-INTEGRATION.md`.
- Manual específico en `docs/agent-kit.md`.

No hay MCP ni hooks. Ninguna instalación modifica el proyecto observado.

## Decisiones que deben conservarse

1. **Core neutral:** toda integración de proveedor vive fuera de `packages/protocol` y `apps/server`, salvo cambios verdaderamente generales del protocolo.
2. **CLI como frontera:** los adaptadores invocan `hrp`; no duplican clientes HTTP por proveedor.
3. **Invocación controlada:** la skill puede descubrirse por nombre directo como `use-hrp`; sólo se usa cuando el usuario pide HRP o revisión humana selectiva.
4. **No reconocer antes de entregar:** `commands ack` ocurre sólo después de que el agente lee e incorpora el comando.
5. **Timeout no es aprobación:** `hrp wait review` sale con código `4`; el adaptador debe volver a esperar.
6. **Evidencia no es autoría:** el observador Git no atribuye automáticamente cambios del usuario al agente.
7. **No intrusión:** no agregar `AGENTS.md`, `.claude`, `.gemini`, dependencias ni configuración HRP al proyecto objetivo.
8. **Aislamiento por carpeta:** ninguna ruta, evento SSE o comando humano puede cruzar de un `project_id` a otro.
9. **Unidad semántica:** no usar archivo como sinónimo de cambio. Una decisión puede tocar varios archivos y un archivo puede contener varias decisiones.
10. **Evidencia honesta:** un resumen del agente nunca sustituye al diff. La UI distingue evidencia reportada por el agente de evidencia observada en el workspace.

## Contrato del CLI

Ejecuta `node packages/cli/bin/hrp.mjs --help`. Operaciones implementadas:

- `attach`, `service start/status/stop`, `state`.
- `plan publish`, `replan publish`.
- `review request`, `wait review/commands`.
- `node start/complete`.
- `patch publish --change`, incluyendo diff Git, separación por archivo y archivos nuevos.
- `verify publish/run`, con cobertura explícita o inferencia documentada de todo el nodo.
- `commands list/ack`.

Defaults: URL `http://127.0.0.1:4317`, proyecto derivado del directorio actual y base compartida `.human-review/hrp.sqlite`. `attach` registra carpetas adicionales sin reiniciar ni cambiar de puerto. `--json` es la interfaz recomendada para agentes.

## Verificación realizada

Se ejecutó manualmente un flujo E2E sobre un worktree temporal:

1. `attach --start` en puerto aislado.
2. Publicación y aprobación del plan.
3. Solicitud y aprobación de nodo `required`.
4. Inicio e intención.
5. Cambio real y publicación del diff Git.
6. `verify run` con resultado exitoso.
7. Confirmación de comandos humanos.
8. Cierre del nodo y estado final `completed`.

También se probaron el instalador/desinstalador en directorios temporales. El plugin y la skill pasaron los validadores oficiales usando un venv temporal con `PyYAML`.

La implementación multi-proyecto se probó con dos carpetas reales en el mismo puerto:

- `/Users/rrrssa/Documents/mysrc/hrp`, sesión `7b60a704-2166-47b8-9bc6-7cebae841faa`;
- `/Users/rrrssa/Documents/mysrc/yapp/StickerSmash`, sesión `038ac42c-3c4c-4002-92e6-5287180a09fb`.

`GET /api/projects` devolvió ambos contextos y el CLI resolvió correctamente `hrp state` desde el cwd de HRP después de adjuntar StickerSmash. La suite automatizada tiene diez pruebas, incluidas reconstrucción aislada de dos carpetas, migración JSONL idempotente, registro desde el CLI y una garantía que impide completar un nodo hasta observar y verificar todos sus cambios y operaciones.

Para `0.4.0` se ejecutaron correctamente `npm run typecheck`, `npm test` y `npm run build`. El detector Impeccable se ejecutó una sola vez sobre `App.tsx` y `styles.css` y devolvió `[]`. La automatización del navegador no estaba disponible en esa sesión, así que todavía hace falta una inspección visual manual de la corrida granular en desktop y móvil.

La instalación standalone quedó activa para el usuario actual:

- `/Users/rrrssa/.agents/skills/use-hrp` contiene una copia standalone de la skill. Ésta es la ubicación personal vigente de descubrimiento de Codex; no debe ser un enlace hacia el árbol del plugin porque Codex la registraría como `hrp:use-hrp` en vez de `use-hrp`.
- `/Users/rrrssa/.local/bin/hrp` apunta al CLI del repositorio.

Codex debe reiniciarse para descubrir una skill recién instalada.

Antes de entregar cualquier cambio nuevo ejecuta:

```bash
npm run typecheck
npm test
npm run build
npm run demo:test
node --check packages/cli/bin/hrp.mjs
```

Para validar el empaquetado, los scripts oficiales requieren `PyYAML`:

```bash
python3 -m venv /tmp/hrp-validation
/tmp/hrp-validation/bin/pip install PyYAML
/tmp/hrp-validation/bin/python \
  /Users/rrrssa/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  integrations/codex/plugins/hrp
/tmp/hrp-validation/bin/python \
  /Users/rrrssa/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  integrations/codex/plugins/hrp/skills/use-hrp
```

## Próximas etapas recomendadas

1. Publicar una corrida granular real y revisar visualmente en desktop/móvil las proyecciones Cambios/Plan, overflow de rutas, selector de operaciones, diff y observaciones dirigidas.
2. Añadir un modo residente opcional del CLI que consuma SSE y reduzca polling, sin convertirlo en MCP.
3. Crear paquetes de instrucciones equivalentes para Claude y Gemini a partir de `integrations/AGENT-INTEGRATION.md`.
4. Añadir leases para coordinar varios agentes que trabajen simultáneamente dentro del mismo proyecto.
5. Añadir autenticación local antes de escuchar fuera de loopback.
6. Publicar el CLI como paquete instalable sólo cuando se defina nombre, versionado y canal de distribución estable.

## Riesgos y asuntos abiertos

- El plugin está empaquetado y validado, pero la ruta de marketplace local debe probarse en las versiones de Codex usadas por el equipo.
- El instalador copia la skill standalone para que Codex la descubra como `use-hrp`; el comando `~/.local/bin/hrp` sí es un enlace a esta copia de desarrollo. Una distribución versionada deberá instalar artefactos inmutables.
- `verify run` ejecuta comandos en el proceso del adaptador. El core sigue sin ejecutar nada; no mezclar esas responsabilidades.
- La base SQLite es global para esta copia de HRP. `--data-dir` crea otro registro completo, no una sesión limpia de un único proyecto; aún falta una operación explícita de archivar/reiniciar sesión.
- `better-sqlite3` está fijado a la serie `12.x` porque el proyecto soporta Node 20; la serie `13.x` requiere Node 22 o posterior.
- La UI compilada no pudo capturarse automáticamente en esta sesión porque el canal de inspección del navegador no estaba disponible. No se debe confundir el detector mecánico limpio con una aprobación visual.
- Los planes antiguos sin `changes` siguen aceptados para replay y transición. Los adaptadores nuevos deben declararlos; eliminar esta compatibilidad requiere una migración explícita de protocolo.

## Prompt para reanudar con otro agente

```text
Continúa el desarrollo de Human Review Protocol en /Users/rrrssa/Documents/mysrc/hrp.
Lee primero HANDOFF.md, README.md, docs/agent-kit.md e integrations/AGENT-INTEGRATION.md.
Conserva el core neutral, no agregues MCP ni hooks y no modifiques proyectos observados.
Revisa el estado actual, ejecuta la suite de verificación y continúa con la siguiente etapa pendiente documentando cualquier decisión nueva en HANDOFF.md.
```
