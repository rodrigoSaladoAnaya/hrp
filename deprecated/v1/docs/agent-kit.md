# Agent kit de Human Review Protocol

El agent kit permite decirle a un agente “usa HRP” sin convertir HRP en una dependencia del proyecto que estás desarrollando. Consta de un CLI neutral, una instrucción del proveedor y el servicio local existente.

## Instalación recomendada para Codex

Desde una copia local de HRP:

```bash
cd /Users/rrrssa/Documents/mysrc/hrp
npm install
./scripts/install-codex.sh
```

El instalador añade dos elementos al perfil del usuario:

- Una copia standalone en `~/.agents/skills/use-hrp`, que es la ubicación personal vigente de descubrimiento de Codex.
- Un enlace `~/.local/bin/hrp` hacia el CLI neutral.

No toca repositorios objetivo, no instala MCP y no registra hooks. Si `~/.local/bin` no está en `PATH`, el instalador lo avisa. Después de instalar, reinicia Codex para que descubra la skill.

Si el comando `codex` está disponible, el instalador consulta `skills/list` con recarga forzada y sólo termina correctamente cuando Codex registra el nombre exacto `use-hrp` como habilitado.

Las versiones iniciales del instalador usaban `~/.codex/skills` y después un enlace hacia el árbol del plugin. Al volver a ejecutarlo, ambos casos se migran de forma segura a una copia standalone: esto evita que Codex la registre con el nombre calificado `hrp:use-hrp`. Otros archivos no se tocan.

Para desinstalar:

```bash
cd /Users/rrrssa/Documents/mysrc/hrp
./scripts/uninstall-codex.sh
```

El desinstalador sólo borra enlaces que todavía apuntan a esta copia de HRP; no elimina directorios ni sobrescribe instalaciones ajenas.

## Uso cotidiano

Abre el proyecto objetivo en Codex y escribe una petición como:

```text
Usa $use-hrp para implementar esta tarea. Quiero revisar el plan y elegir qué ramas pueden continuar en automático.
```

El agente debe:

1. Ejecutar `hrp attach . --start` desde el proyecto.
2. Publicar el plan antes de modificar archivos.
3. Esperar la aprobación del plan.
4. Consultar las políticas `required`, `watch` y `auto` elegidas en el panel.
5. Publicar intención, patches y verificaciones.
6. Procesar observaciones y pausas humanas.

Abre [http://127.0.0.1:4317](http://127.0.0.1:4317) para revisar el grafo. Puedes marcar un nodo o su rama como:

- **REVISAR:** crea un gate antes de trabajar ese nodo.
- **OBSERVAR:** muestra evidencia sin bloquear el flujo.
- **AUTO:** permite que el agente continúe sin una revisión individual.

## Ejemplo con StickerSmash

Con la integración ya instalada, abre una tarea de Codex cuya carpeta sea:

```text
/Users/rrrssa/Documents/mysrc/yapp/StickerSmash
```

Y solicita:

```text
Usa $use-hrp para hacer este cambio en StickerSmash. Publica primero un grafo revisable y detente donde el panel indique REVISAR.
```

También puedes comprobar la conexión manualmente:

```bash
cd /Users/rrrssa/Documents/mysrc/yapp/StickerSmash
hrp attach . --start
```

No necesitas definir `HUMAN_REVIEW_WORKSPACE_ROOT` ni `HUMAN_REVIEW_DATA_DIR`. El workspace es el directorio actual y HRP deriva un data directory estable de su ruta absoluta.

## CLI neutral

Los comandos principales son:

| Comando | Propósito |
| --- | --- |
| `hrp attach [workspace] --start` | Inicia o conecta y valida el workspace. |
| `hrp state --json` | Recupera plan, modos, gates y pausa. |
| `hrp plan publish plan.json` | Publica un DAG y abre su revisión inicial. |
| `hrp review request NODE --summary TEXTO` | Abre la revisión de un nodo `required`. |
| `hrp wait review --id ID` | Espera una decisión durante un intervalo acotado. |
| `hrp node start NODE --intent TEXTO --files a,b` | Declara intención antes de editar. |
| `hrp patch publish NODE --change ID --summary TEXTO` | Publica y separa el diff real por archivo; no aplica cambios. |
| `hrp verify run NODE -- comando` | Ejecuta desde el adaptador y mapea la evidencia a cambios/operaciones/patches. |
| `hrp node complete NODE --summary TEXTO` | Cierra un nodo verificado. |
| `hrp commands list` | Obtiene observaciones, control y decisiones pendientes. |
| `hrp commands ack ID` | Confirma un comando después de incorporarlo. |
| `hrp service stop` | Detiene el servicio iniciado por esta copia de HRP. |

Todos aceptan `--url URL`; los que devuelven datos aceptan `--json`. `hrp --help` muestra el contrato completo.

## Distribución para el equipo

El plugin está en `integrations/codex/plugins/hrp` y el marketplace versionable en `integrations/codex/.agents/plugins/marketplace.json`. Ambos se pueden compartir junto con el repositorio. El plugin empaqueta la misma skill, sin MCP ni hooks, y declara invocación implícita desactivada.

Para una primera etapa, el instalador standalone es más simple y comprobable. El marketplace es útil cuando el equipo ya administra plugins de Codex de forma centralizada.

## Claude y Gemini

No necesitan una API nueva. Un adaptador futuro debe instalar una instrucción invocable equivalente y usar el mismo binario `hrp`. El contrato portable está en `integrations/AGENT-INTEGRATION.md`; los detalles HTTP permanecen en el core.

Esta separación evita que decisiones como skills, plugins o extensiones de un proveedor contaminen sesiones, eventos o el panel humano.

## Límites actuales

- La integración de Codex depende de que el agente siga la skill; todavía no existe enforcement fuera de los gates del servidor.
- Las observaciones se consumen por polling acotado. Un adaptador residente podría usar SSE en una etapa posterior.
- Una instancia comparte puerto y SQLite entre varias carpetas, con contexto y stream aislados por proyecto.
- Mover la carpeta de HRP rompe el enlace del CLI; la skill standalone seguirá disponible, pero debes reinstalar para que sus actualizaciones y el comando `hrp` apunten a la ruta nueva.
