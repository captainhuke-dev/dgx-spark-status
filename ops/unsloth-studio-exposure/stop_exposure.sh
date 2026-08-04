#!/usr/bin/env bash
set -euo pipefail

RUNTIME_ROOT="/home/mctdgx01/.local/lib/dgx-unsloth-exposure"
USER_UNIT_ROOT="/home/mctdgx01/.config/systemd/user"
STATE_FILE="/home/mctdgx01/.local/state/dgx-unsloth-exposure/active-operation.env"
GUARD_UNIT_NAME="dgx-unsloth-guard.service"
LAN_PROXY_UNIT_NAME="dgx-unsloth-lan-proxy.service"
LAN_BIND_ADDRESS="192.168.0.21"
GUARD_TARGET="127.0.0.1:56828"
GUARD_PORT="56828"
PUBLIC_PORT="56827"

systemctl_user() {
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
  /usr/bin/systemctl --user "$@"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --state-file)
        STATE_FILE="$2"
        shift 2
        ;;
      *)
        echo "unknown argument: $1" >&2
        exit 2
        ;;
    esac
  done
}

listener_bindings() {
  local host="$1"
  local port="$2"
  python3 - "$host" "$port" <<'PY'
import subprocess
import sys

host = sys.argv[1]
port = int(sys.argv[2])
result = subprocess.run(['ss', '-H', '-ltnp'], capture_output=True, text=True, check=True)
matches = []
for line in result.stdout.splitlines():
    parts = line.split()
    if len(parts) < 4:
        continue
    local = parts[3].strip()
    if local in {f'{host}:{port}', f'[{host}]:{port}'}:
        matches.append('EXACT')
    elif local in {
        f'0.0.0.0:{port}',
        f'[::]:{port}',
        f':::{port}',
        f'*:{port}',
    }:
        matches.append('WILDCARD')
print('\n'.join(matches))
PY
}

assert_listener_closed() {
  local host="$1"
  local port="$2"
  local active_bindings
  active_bindings="$(listener_bindings "${host}" "${port}")"
  if grep -Fxq "WILDCARD" <<< "${active_bindings}"; then
    echo "required port ${port} is still open through a wildcard listener" >&2
    exit 1
  fi
  if [[ -n "${active_bindings}" ]]; then
    echo "listener ${host}:${port} is still open" >&2
    exit 1
  fi
}

main() {
  parse_args "$@"
  systemctl_user stop "${LAN_PROXY_UNIT_NAME}"
  systemctl_user stop "${GUARD_UNIT_NAME}"
  assert_listener_closed "${LAN_BIND_ADDRESS}" "${PUBLIC_PORT}"
  assert_listener_closed "127.0.0.1" "${GUARD_PORT}"
}

main "$@"
