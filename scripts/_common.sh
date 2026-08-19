#!/usr/bin/env bash

set -euo pipefail

HRP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HRP_CALLER_DIR="$PWD"

hrp_require_node() {
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "Error: se requieren Node.js 20+ y npm." >&2
    exit 1
  fi

  local major
  major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if [ "$major" -lt 20 ]; then
    echo "Error: Node.js 20+ requerido; versión actual: $(node --version)." >&2
    exit 1
  fi
}

hrp_print_usage() {
  cat <<EOF
Uso: $(basename "$0") [WORKSPACE] [opciones]

Opciones:
  -w, --workspace PATH   Proyecto que HRP observará. Default: directorio actual.
  -d, --data-dir PATH   Base compartida. Default: .human-review de HRP.
  -p, --port PORT       Puerto HTTP. Default: protocol.config.json.
      --skip-build      No recompilar el panel antes de iniciar.
  -h, --help            Mostrar esta ayuda.

Ejemplo:
  $(basename "$0") --workspace /ruta/al/proyecto
EOF
}

hrp_parse_args() {
  local workspace_arg=""
  local data_dir_arg=""
  local port_arg=""

  while [ "$#" -gt 0 ]; do
    case "$1" in
      -w|--workspace)
        [ "$#" -ge 2 ] || { echo "Error: $1 requiere una ruta." >&2; exit 1; }
        workspace_arg="$2"
        shift 2
        ;;
      -d|--data-dir)
        [ "$#" -ge 2 ] || { echo "Error: $1 requiere una ruta." >&2; exit 1; }
        data_dir_arg="$2"
        shift 2
        ;;
      -p|--port)
        [ "$#" -ge 2 ] || { echo "Error: $1 requiere un puerto." >&2; exit 1; }
        port_arg="$2"
        shift 2
        ;;
      --skip-build)
        export HRP_SKIP_BUILD=1
        shift
        ;;
      -h|--help)
        hrp_print_usage
        exit 0
        ;;
      --)
        shift
        ;;
      -*)
        echo "Error: opción desconocida: $1" >&2
        hrp_print_usage >&2
        exit 1
        ;;
      *)
        if [ -n "$workspace_arg" ]; then
          echo "Error: sólo se admite un workspace posicional." >&2
          exit 1
        fi
        workspace_arg="$1"
        shift
        ;;
    esac
  done

  workspace_arg="${workspace_arg:-${HUMAN_REVIEW_WORKSPACE_ROOT:-$HRP_CALLER_DIR}}"
  if [ ! -d "$workspace_arg" ]; then
    echo "Error: el workspace no existe: $workspace_arg" >&2
    exit 1
  fi
  HRP_WORKSPACE_ROOT="$(cd "$workspace_arg" && pwd)"
  export HUMAN_REVIEW_WORKSPACE_ROOT="$HRP_WORKSPACE_ROOT"

  if [ -n "$data_dir_arg" ]; then
    HRP_DATA_DIR="$(node -e 'const path=require("path"); process.stdout.write(path.resolve(process.argv[1]))' "$data_dir_arg")"
  elif [ -n "${HUMAN_REVIEW_DATA_DIR:-}" ]; then
    HRP_DATA_DIR="$(node -e 'const path=require("path"); process.stdout.write(path.resolve(process.argv[1]))' "$HUMAN_REVIEW_DATA_DIR")"
  else
    HRP_DATA_DIR="$HRP_ROOT/.human-review"
  fi
  export HUMAN_REVIEW_DATA_DIR="$HRP_DATA_DIR"

  if [ -n "$port_arg" ]; then
    export HUMAN_REVIEW_HTTP_PORT="$port_arg"
  fi
}

hrp_resolve_config() {
  local configured="${HUMAN_REVIEW_CONFIG_PATH:-protocol.config.json}"
  if [[ "$configured" = /* ]]; then
    HRP_CONFIG_PATH="$configured"
  else
    HRP_CONFIG_PATH="$HRP_ROOT/$configured"
  fi

  if [ ! -f "$HRP_CONFIG_PATH" ]; then
    echo "Error: no existe la configuración: $HRP_CONFIG_PATH" >&2
    exit 1
  fi
  export HUMAN_REVIEW_CONFIG_PATH="$HRP_CONFIG_PATH"
}

hrp_load_runtime() {
  hrp_resolve_config
  HRP_HOST="$(node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(c.http.host)' "$HRP_CONFIG_PATH")"
  HRP_PORT="${HUMAN_REVIEW_HTTP_PORT:-$(node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(c.http.port))' "$HRP_CONFIG_PATH")}"

  if ! [[ "$HRP_PORT" =~ ^[0-9]+$ ]] || [ "$HRP_PORT" -lt 1024 ] || [ "$HRP_PORT" -gt 65535 ]; then
    echo "Error: puerto inválido: $HRP_PORT" >&2
    exit 1
  fi

  HRP_RUNTIME_DIR="${HUMAN_REVIEW_RUNTIME_DIR:-$HRP_ROOT/.human-review/runtime}"
  HRP_PID_FILE="$HRP_RUNTIME_DIR/server.pid"
  HRP_LOG_FILE="${HUMAN_REVIEW_LOG_FILE:-$HRP_RUNTIME_DIR/server.log}"
  HRP_URL="http://$HRP_HOST:$HRP_PORT"
}

hrp_pid_is_running() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

hrp_read_pid() {
  if [ -f "$HRP_PID_FILE" ]; then
    tr -d '[:space:]' < "$HRP_PID_FILE"
  fi
}

hrp_health_json() {
  node -e '
    fetch(process.argv[1])
      .then(async response => {
        if (!response.ok) process.exit(1);
        process.stdout.write(await response.text());
      })
      .catch(() => process.exit(1));
  ' "$HRP_URL/api/protocol"
}

hrp_attach_workspace() {
  node -e '
    const [url, workspaceRoot] = process.argv.slice(1);
    fetch(`${url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot }),
    }).then(async response => {
      if (!response.ok) throw new Error(await response.text());
      process.stdout.write(await response.text());
    }).catch(error => { console.error(error.message); process.exit(1); });
  ' "$HRP_URL" "$HRP_WORKSPACE_ROOT"
}

hrp_projects_json() {
  node -e '
    fetch(`${process.argv[1]}/api/projects`)
      .then(async response => {
        if (!response.ok) process.exit(1);
        process.stdout.write(await response.text());
      })
      .catch(() => process.exit(1));
  ' "$HRP_URL"
}

hrp_listener_pid() {
  if ! command -v lsof >/dev/null 2>&1; then
    return 1
  fi
  lsof -nP -tiTCP:"$HRP_PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR == 1 { print; exit }'
}

hrp_listener_is_owned() {
  local pid="$1"
  local command_line
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command_line" in
    *"$HRP_ROOT"*"apps/server/src/index.ts"*) return 0 ;;
    *) return 1 ;;
  esac
}
