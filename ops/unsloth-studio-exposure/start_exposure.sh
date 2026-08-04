#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RUNTIME_ROOT="/home/mctdgx01/.local/lib/dgx-unsloth-exposure"
USER_UNIT_ROOT="/home/mctdgx01/.config/systemd/user"
STATE_FILE="/home/mctdgx01/.local/state/dgx-unsloth-exposure/active-operation.env"
EVIDENCE_DIR="/home/mctdgx01/.local/state/dgx-unsloth-exposure/evidence"
GUARD_UNIT_NAME="dgx-unsloth-guard.service"
LAN_PROXY_UNIT_NAME="dgx-unsloth-lan-proxy.service"
LAN_BIND_ADDRESS="192.168.0.21"
GUARD_TARGET="127.0.0.1:56828"
GUARD_PORT="56828"
PUBLIC_PORT="56827"
SYSTEMCTL_BIN="${DGX_UNSLOTH_EXPOSURE_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
GUARD_STARTED="0"
LAN_STARTED="0"
GUARD_WAS_ACTIVE="0"
LAN_WAS_ACTIVE="0"
PREFLIGHT_ONLY="0"

systemctl_user() {
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
  "${SYSTEMCTL_BIN}" --user "$@"
}

cleanup_on_error() {
  local exit_code="$?"
  if [[ "${exit_code}" -ne 0 ]]; then
    if [[ "${LAN_STARTED}" == "1" ]]; then
      systemctl_user stop "${LAN_PROXY_UNIT_NAME}" || true
    fi
    if [[ "${GUARD_STARTED}" == "1" ]]; then
      systemctl_user stop "${GUARD_UNIT_NAME}" || true
    fi
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --state-file)
        STATE_FILE="$2"
        shift 2
        ;;
      --evidence-dir)
        EVIDENCE_DIR="$2"
        shift 2
        ;;
      --runtime-root)
        RUNTIME_ROOT="$2"
        shift 2
        ;;
      --user-unit-root)
        USER_UNIT_ROOT="$2"
        shift 2
        ;;
      --lan-address)
        LAN_BIND_ADDRESS="$2"
        shift 2
        ;;
      --guard-target)
        GUARD_TARGET="$2"
        GUARD_PORT="${GUARD_TARGET##*:}"
        shift 2
        ;;
      --preflight-only)
        PREFLIGHT_ONLY="1"
        shift
        ;;
      *)
        echo "unknown argument: $1" >&2
        exit 2
        ;;
    esac
  done
}

require_lan_address() {
  if ! ip -o -4 addr show | awk '{print $4}' | cut -d/ -f1 | grep -Fxq "${LAN_BIND_ADDRESS}"; then
    echo "required LAN address ${LAN_BIND_ADDRESS} is not configured" >&2
    exit 1
  fi
}

listener_records() {
  local host="$1"
  local port="$2"
  python3 - "$host" "$port" <<'PY'
import re
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
    wildcard_locals = {
        f'0.0.0.0:{port}',
        f'[::]:{port}',
        f':::${port}'.replace('$', ''),
        f'*:{port}',
    }
    exact_locals = {f'{host}:{port}', f'[{host}]:{port}'}
    if local in exact_locals:
        listener_kind = 'EXACT'
    elif local in wildcard_locals:
        listener_kind = 'WILDCARD'
    else:
        continue
    pids = re.findall(r'pid=(\d+)', line)
    if pids:
        matches.extend(f'{listener_kind}:{pid}' for pid in pids)
    else:
        matches.append(f'{listener_kind}:PID_METADATA_UNAVAILABLE')
print('\n'.join(matches))
PY
}

resolve_route_helper() {
  local route_helper="${RUNTIME_ROOT}/tailscale_route_state.py"
  if [[ -f "${route_helper}" ]]; then
    printf '%s\n' "${route_helper}"
    return 0
  fi
  route_helper="${SCRIPT_DIR}/tailscale_route_state.py"
  if [[ -f "${route_helper}" ]]; then
    printf '%s\n' "${route_helper}"
    return 0
  fi
  return 1
}

assert_listener_available_or_owned() {
  local host="$1"
  local port="$2"
  local unit_name="$3"
  assert_single_exact_owned_listener "${host}" "${port}" "${unit_name}" "1"
}

assert_single_exact_owned_listener() {
  local host="$1"
  local port="$2"
  local unit_name="$3"
  local allow_absent="$4"
  local main_pid_before
  main_pid_before="$(systemctl_user show --property MainPID --value "${unit_name}" 2>/dev/null || true)"
  local active_records
  active_records="$(listener_records "${host}" "${port}")"
  if [[ -z "${active_records}" ]]; then
    if [[ "${allow_absent}" == "1" ]]; then
      return 0
    fi
    echo "expected listener ${host}:${port} was not present" >&2
    exit 1
  fi

  local main_pid_after
  main_pid_after="$(systemctl_user show --property MainPID --value "${unit_name}" 2>/dev/null || true)"
  local record
  local record_count="0"
  local exact_record=""
  while IFS= read -r record; do
    [[ -z "${record}" ]] && continue
    record_count="$((record_count + 1))"
    if [[ "${record}" == WILDCARD:* ]]; then
      echo "refusing wildcard listener on required port ${port} for ${unit_name}; exact listener ${host}:${port} is required" >&2
      exit 1
    fi
    exact_record="${record}"
  done <<< "${active_records}"

  if [[ "${record_count}" != "1" || "${exact_record}" != EXACT:* ]]; then
    echo "expected exactly one listener at ${host}:${port} for ${unit_name}" >&2
    exit 1
  fi
  if [[ "${exact_record}" == "EXACT:PID_METADATA_UNAVAILABLE" ]]; then
    echo "refusing occupied unowned listener ${host}:${port}; listener ownership metadata is unavailable" >&2
    exit 1
  fi
  if [[ -z "${main_pid_before}" || "${main_pid_before}" == "0" || -z "${main_pid_after}" || "${main_pid_after}" == "0" ]]; then
    echo "refusing occupied unowned listener ${host}:${port} for ${unit_name}" >&2
    exit 1
  fi
  if [[ "${main_pid_before}" != "${main_pid_after}" ]]; then
    echo "MainPID changed during listener verification for ${unit_name}" >&2
    exit 1
  fi
  local listener_pid="${exact_record#EXACT:}"
  if [[ "${listener_pid}" != "${main_pid_after}" ]]; then
    echo "listener PID ${listener_pid} does not match current MainPID ${main_pid_after} for ${unit_name}" >&2
    exit 1
  fi
}

assert_listener_present() {
  assert_single_exact_owned_listener "$1" "$2" "$3" "0"
}

assert_guard_ready() {
  python3 - "${GUARD_PORT}" <<'PY'
import http.client
import json
import sys

port = int(sys.argv[1])
connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
try:
    connection.request('GET', '/v1/models', headers={'Connection': 'close'})
    response = connection.getresponse()
    body = response.read(1024 * 1024 + 1)
except Exception as error:
    print(f'guard readiness failed before outward exposure: {error}', file=sys.stderr)
    raise SystemExit(1)
finally:
    connection.close()

if response.status != 200:
    print(
        f'guard readiness requires HTTP 200 /v1/models; received {response.status}',
        file=sys.stderr,
    )
    raise SystemExit(1)
if response.getheader('X-DGX-Request-Guard') != 'unsloth-studio':
    print(
        'guard readiness requires X-DGX-Request-Guard=unsloth-studio',
        file=sys.stderr,
    )
    raise SystemExit(1)
if len(body) > 1024 * 1024:
    print('guard readiness response exceeded 1 MiB', file=sys.stderr)
    raise SystemExit(1)
try:
    payload = json.loads(body)
except (UnicodeDecodeError, json.JSONDecodeError) as error:
    print(f'guard readiness returned invalid JSON: {error}', file=sys.stderr)
    raise SystemExit(1)

data = payload.get('data') if isinstance(payload, dict) else None
ids = [
    item.get('id').strip()
    for item in data
    if isinstance(item, dict) and isinstance(item.get('id'), str) and item.get('id').strip()
] if isinstance(data, list) else []
if not isinstance(data, list) or len(data) != 1 or len(ids) != 1:
    print(
        'guard readiness requires exactly one nonempty live model ID',
        file=sys.stderr,
    )
    raise SystemExit(1)
PY
}

preflight_exposure() {
  local route_helper="$1"
  python3 "${route_helper}" preflight \
    --state-file "${STATE_FILE}" \
    --evidence-dir "${EVIDENCE_DIR}"
  require_lan_address
  assert_listener_available_or_owned "127.0.0.1" "${GUARD_PORT}" "${GUARD_UNIT_NAME}"
  assert_listener_available_or_owned "${LAN_BIND_ADDRESS}" "${PUBLIC_PORT}" "${LAN_PROXY_UNIT_NAME}"
}

main() {
  parse_args "$@"
  mkdir -p "$(dirname "${STATE_FILE}")" "${EVIDENCE_DIR}"
  local route_helper
  route_helper="$(resolve_route_helper)"

  preflight_exposure "${route_helper}"
  if [[ "${PREFLIGHT_ONLY}" == "1" ]]; then
    return 0
  fi

  trap cleanup_on_error EXIT

  if systemctl_user is-active --quiet "${GUARD_UNIT_NAME}"; then
    GUARD_WAS_ACTIVE="1"
  fi
  if systemctl_user is-active --quiet "${LAN_PROXY_UNIT_NAME}"; then
    LAN_WAS_ACTIVE="1"
  fi

  systemctl_user start "${GUARD_UNIT_NAME}"
  if [[ "${GUARD_WAS_ACTIVE}" == "0" ]]; then
    GUARD_STARTED="1"
  fi
  assert_listener_present "127.0.0.1" "${GUARD_PORT}" "${GUARD_UNIT_NAME}"
  assert_guard_ready

  systemctl_user start "${LAN_PROXY_UNIT_NAME}"
  if [[ "${LAN_WAS_ACTIVE}" == "0" ]]; then
    LAN_STARTED="1"
  fi
  assert_listener_present "${LAN_BIND_ADDRESS}" "${PUBLIC_PORT}" "${LAN_PROXY_UNIT_NAME}"

  python3 "${route_helper}" ensure \
    --state-file "${STATE_FILE}" \
    --evidence-dir "${EVIDENCE_DIR}"
  trap - EXIT
}

main "$@"
