#!/usr/bin/env bash

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

hrp_require_node
hrp_parse_args "$@"
hrp_load_runtime

server_pid="$(hrp_read_pid || true)"
if [ -z "$server_pid" ]; then
  if protocol_json="$(hrp_health_json 2>/dev/null)"; then
    listener_pid="$(hrp_listener_pid || true)"
    echo "Servicio HRP activo, pero no está registrado en $HRP_PID_FILE."
    [ -n "$listener_pid" ] && echo "Proceso detectado: PID $listener_pid."
    printf '%s' "$protocol_json" | node -e '
      let raw = "";
      process.stdin.on("data", chunk => raw += chunk);
      process.stdin.on("end", () => {
        const protocol = JSON.parse(raw);
        console.log(`HTTP saludable: ${protocol.name} v${protocol.version} (${protocol.transport})`);
      });
    '
    echo "Panel: $HRP_URL"
    if projects_json="$(hrp_projects_json 2>/dev/null)"; then
      printf '%s' "$projects_json" | node -e '
        let raw = "";
        process.stdin.on("data", chunk => raw += chunk);
        process.stdin.on("end", () => console.log(`Proyectos registrados: ${JSON.parse(raw).projects.length}`));
      '
    fi
    exit 0
  fi
  echo "Servicio detenido: no existe $HRP_PID_FILE y la API no responde en $HRP_URL"
  exit 1
fi
if ! hrp_pid_is_running "$server_pid"; then
  echo "Servicio detenido: PID obsoleto $server_pid"
  exit 1
fi

echo "Proceso activo (PID $server_pid)."
if protocol_json="$(hrp_health_json)"; then
  printf '%s' "$protocol_json" | node -e '
    let raw = "";
    process.stdin.on("data", chunk => raw += chunk);
    process.stdin.on("end", () => {
      const protocol = JSON.parse(raw);
      console.log(`HTTP saludable: ${protocol.name} v${protocol.version} (${protocol.transport})`);
    });
  '
  echo "Panel: $HRP_URL"
  if projects_json="$(hrp_projects_json 2>/dev/null)"; then
    printf '%s' "$projects_json" | node -e '
      let raw = "";
      process.stdin.on("data", chunk => raw += chunk);
      process.stdin.on("end", () => console.log(`Proyectos registrados: ${JSON.parse(raw).projects.length}`));
    '
  fi
  echo "Log: $HRP_LOG_FILE"
  exit 0
fi

echo "El proceso existe, pero la API no responde en $HRP_URL." >&2
echo "Revisa: $HRP_LOG_FILE" >&2
exit 2
