# Manual de uso de HRP

HRP ejecuta un solo servicio local para todos tus proyectos. Cada carpeta registrada mantiene su propia sesión, grafo, comandos, observador y eventos dentro de una base SQLite compartida.

## Instalación desde cero

Requiere Node.js 20 o posterior y npm.

```bash
cd /ruta/donde/quieras/guardar/hrp
npm install
./scripts/install-codex.sh
```

Reinicia Codex después de instalar la skill. La instalación crea el comando personal `~/.local/bin/hrp` y copia `use-hrp` al catálogo personal; no modifica los proyectos observados.

Comprueba la instalación:

```bash
hrp --version
node scripts/verify-codex-skill.mjs
```

## Primer proyecto

Desde el proyecto que quieres supervisar:

```bash
cd /ruta/al/proyecto
hrp attach . --start
```

El comando inicia el servicio si hace falta, registra la carpeta y devuelve la URL exacta del proyecto. Abre el panel en `http://127.0.0.1:4317`.

No necesitas definir `HUMAN_REVIEW_WORKSPACE_ROOT` ni `HUMAN_REVIEW_DATA_DIR`. Los defaults son:

- proyecto: el directorio actual;
- datos: `/ruta/de/hrp/.human-review/hrp.sqlite`;
- panel/API: `http://127.0.0.1:4317`.

## Agregar más proyectos

No detengas el servicio ni cambies de puerto. Registra cada carpeta con el mismo comando:

```bash
hrp attach /Users/tuusuario/proyectos/app-a --start
hrp attach /Users/tuusuario/proyectos/app-b --start
```

La franja **Proyectos** del panel muestra el nombre, la ruta completa y el estado de cada carpeta. Al seleccionar una carpeta cambian juntos el grafo, los eventos SSE, las observaciones y los controles. La URL conserva la selección mediante `?project=<id>`.

Los comandos del CLI resuelven el proyecto desde el directorio actual, por lo que el flujo normal sigue siendo:

```bash
cd /Users/tuusuario/proyectos/app-b
hrp state
hrp commands list
```

No hace falta copiar ni recordar un `projectId`.

## Usarlo con Codex

Abre una tarea de Codex desde la carpeta objetivo y escribe, por ejemplo:

```text
Usa $use-hrp para implementar esta tarea. Publica primero el grafo y detente sólo en los nodos marcados como REVISAR.
```

La skill conecta esa carpeta, publica el plan, procesa comandos humanos y deja evidencia de patches y verificaciones. Cambiar un nodo a `AUTO` no aprueba el plan inicial: son decisiones distintas. El panel muestra una franja bermellón **DECISIÓN** cuando aún falta una aprobación.

## Políticas de revisión

- `REVISAR` (`required`): el adaptador debe solicitar aprobación antes del nodo.
- `OBSERVAR` (`watch`): mantiene el nodo visible, pero no detiene el trabajo.
- `AUTO` (`auto`): continúa sin gate de nodo.

La opción **Aplicar a la rama** extiende la política a todos los descendientes. Si cambia el fingerprint de un nodo durante una replanificación, su exención se invalida.

## Servicio

```bash
hrp service status
hrp service stop
hrp service start /ruta/al/proyecto
```

`status` informa cuántos proyectos hay registrados. `start` reconoce también una instancia iniciada con `npm start` o `run.sh` aunque no tenga PID administrado y registra la nueva carpeta en ella.

Opciones avanzadas:

```bash
hrp attach . --start --port 4417
hrp attach . --start --data-dir /ruta/a/otro-registro
```

Un `--data-dir` distinto crea otro registro multi-proyecto completo; normalmente no es necesario. Las variables de entorno equivalentes siguen disponibles sólo por compatibilidad y automatización.

## Persistencia y migración

SQLite guarda dos conjuntos principales:

- `projects`: identidad estable por ruta canónica, nombre y actividad reciente;
- `events`: secuencia causal aislada por `project_id`.

La base usa WAL y claves foráneas. Cuando registras por primera vez una carpeta que tenía el formato anterior, HRP importa automáticamente y una sola vez su `.human-review/workspaces/<carpeta-hash>/events.jsonl`. El JSONL original no se elimina.

## API neutral

Lista y registra proyectos:

```text
GET  /api/projects
POST /api/projects              { "workspaceRoot": "/ruta/al/proyecto" }
```

La forma explícita recomendada para integraciones nuevas es:

```text
/api/projects/:projectId/state
/api/projects/:projectId/events
/api/projects/:projectId/protocol/plans
/api/projects/:projectId/observations
```

Las rutas anteriores (`/api/state`, `/api/events`, `/api/protocol/...`) siguen funcionando. Un adaptador puede enviar `x-hrp-workspace-root` para resolver automáticamente el contexto, como hace el CLI.

## Diagnóstico

Si `attach` no conecta:

```bash
hrp service status
curl http://127.0.0.1:4317/api/protocol
curl http://127.0.0.1:4317/api/projects
```

Si una carpeta aparece como **No disponible**, verifica que no fue movida o eliminada y vuelve a ejecutar `hrp attach` con la ruta nueva. Si el observador indica que Git no está disponible, el protocolo y la revisión continúan; sólo faltan los snapshots independientes del working tree.

## Verificación del repositorio

```bash
npm run typecheck
npm test
npm run build
npm run demo:test
node --check packages/cli/bin/hrp.mjs
```
