#!/usr/bin/env bash

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

hrp_require_node
hrp_parse_args "$@"
hrp_load_runtime

mkdir -p "$HRP_RUNTIME_DIR"

existing_pid="$(hrp_read_pid || true)"
if [ -n "$existing_pid" ] && hrp_pid_is_running "$existing_pid"; then
  hrp_attach_workspace >/dev/null
  echo "El servicio ya está activo (PID $existing_pid): $HRP_URL"
  echo "Proyecto registrado: $HRP_WORKSPACE_ROOT"
  exit 0
fi
if [ -f "$HRP_PID_FILE" ]; then
  rm -f "$HRP_PID_FILE"
fi
if hrp_health_json >/dev/null 2>&1; then
  listener_pid="$(hrp_listener_pid || true)"
  hrp_attach_workspace >/dev/null
  echo "El servicio ya está activo${listener_pid:+ (PID $listener_pid)}: $HRP_URL"
  echo "Proyecto registrado: $HRP_WORKSPACE_ROOT"
  exit 0
fi

cd "$HRP_ROOT"
if [ ! -x "$HRP_ROOT/node_modules/.bin/tsx" ]; then
  echo "Faltan dependencias. Ejecuta: npm install" >&2
  exit 1
fi

if [ "${HRP_SKIP_BUILD:-0}" != "1" ]; then
  npm run build
fi

nohup "$HRP_ROOT/node_modules/.bin/tsx" apps/server/src/index.ts >>"$HRP_LOG_FILE" 2>&1 &
server_pid=$!
printf '%s\n' "$server_pid" > "$HRP_PID_FILE"

for _attempt in {1..40}; do
  if ! hrp_pid_is_running "$server_pid"; then
    echo "El servicio terminó durante el arranque. Revisa: $HRP_LOG_FILE" >&2
    rm -f "$HRP_PID_FILE"
    exit 1
  fi
  if hrp_health_json >/dev/null 2>&1; then
    hrp_attach_workspace >/dev/null
    echo "Servicio iniciado (PID $server_pid): $HRP_URL"
    echo "Proyecto inicial: $HRP_WORKSPACE_ROOT"
    echo "Base compartida: $HRP_DATA_DIR/hrp.sqlite"
    echo "Log: $HRP_LOG_FILE"
    exit 0
  fi
  sleep 0.25
done

echo "El proceso inició, pero el health check no respondió: $HRP_URL" >&2
echo "Revisa: $HRP_LOG_FILE" >&2
exit 1
