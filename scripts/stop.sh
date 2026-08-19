#!/usr/bin/env bash

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

hrp_require_node
hrp_parse_args "$@"
hrp_load_runtime

server_pid="$(hrp_read_pid || true)"
if [ -n "$server_pid" ] && ! hrp_pid_is_running "$server_pid"; then
  echo "Eliminando PID obsoleto: $server_pid"
  rm -f "$HRP_PID_FILE"
  server_pid=""
fi
if [ -z "$server_pid" ]; then
  if ! hrp_health_json >/dev/null 2>&1; then
    echo "El servicio ya está detenido."
    exit 0
  fi

  server_pid="$(hrp_listener_pid || true)"
  if [ -z "$server_pid" ]; then
    echo "Hay una API HRP activa en $HRP_URL, pero no se pudo identificar su proceso." >&2
    echo "Instala 'lsof' o detén la terminal desde la que ejecutaste run.sh/npm start." >&2
    exit 2
  fi
  if ! hrp_listener_is_owned "$server_pid"; then
    echo "El puerto $HRP_PORT responde como HRP, pero el proceso $server_pid no pertenece a esta copia:" >&2
    ps -p "$server_pid" -o command= >&2 || true
    echo "No se detuvo por seguridad." >&2
    exit 2
  fi
  echo "Servicio HRP activo sin PID registrado; proceso detectado: $server_pid."
fi
if ! hrp_pid_is_running "$server_pid"; then
  rm -f "$HRP_PID_FILE"
  echo "El proceso $server_pid terminó antes de recibir la señal."
  exit 0
fi

kill -TERM "$server_pid"
for _attempt in {1..40}; do
  if ! hrp_pid_is_running "$server_pid"; then
    rm -f "$HRP_PID_FILE"
    echo "Servicio detenido."
    exit 0
  fi
  sleep 0.25
done

echo "El servicio no terminó en 10 segundos; enviando SIGKILL." >&2
kill -KILL "$server_pid"
rm -f "$HRP_PID_FILE"
echo "Servicio detenido forzosamente."
