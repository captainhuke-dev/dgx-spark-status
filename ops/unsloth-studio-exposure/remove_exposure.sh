#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RUNTIME_ROOT="${DGX_UNSLOTH_EXPOSURE_RUNTIME_ROOT:-/home/mctdgx01/.local/lib/dgx-unsloth-exposure}"
USER_UNIT_ROOT="${DGX_UNSLOTH_EXPOSURE_USER_UNIT_ROOT:-/home/mctdgx01/.config/systemd/user}"
STATE_ROOT="${DGX_UNSLOTH_EXPOSURE_STATE_ROOT:-/home/mctdgx01/.local/state/dgx-unsloth-exposure}"
STATE_FILE="${DGX_UNSLOTH_EXPOSURE_STATE_FILE:-${STATE_ROOT}/active-operation.env}"
EVIDENCE_DIR="${DGX_UNSLOTH_EXPOSURE_EVIDENCE_DIR:-${STATE_ROOT}/evidence-remove}"
GUARD_UNIT_NAME="dgx-unsloth-guard.service"
LAN_PROXY_UNIT_NAME="dgx-unsloth-lan-proxy.service"
LAN_BIND_ADDRESS="192.168.0.21"
GUARD_TARGET="127.0.0.1:56828"

systemctl_user() {
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
  /usr/bin/systemctl --user "$@"
}

main() {
  local stop_helper="${RUNTIME_ROOT}/stop_exposure.sh"
  local route_helper="${RUNTIME_ROOT}/tailscale_route_state.py"
  if [[ ! -x "${stop_helper}" ]]; then
    stop_helper="${SCRIPT_DIR}/stop_exposure.sh"
  fi
  if [[ ! -x "${route_helper}" ]]; then
    route_helper="${SCRIPT_DIR}/tailscale_route_state.py"
  fi

  "${stop_helper}" --state-file "${STATE_FILE}"
  if [[ -n "${route_helper}" && -x "${route_helper}" ]]; then
    python3 "${route_helper}" remove \
      --state-file "${STATE_FILE}" \
      --evidence-dir "${EVIDENCE_DIR}"
  fi

  systemctl_user disable "${LAN_PROXY_UNIT_NAME}"
  systemctl_user disable "${GUARD_UNIT_NAME}"

  rm -f "${USER_UNIT_ROOT}/${LAN_PROXY_UNIT_NAME}"
  rm -f "${USER_UNIT_ROOT}/${GUARD_UNIT_NAME}"
  rm -f "${RUNTIME_ROOT}/unsloth_request_guard.py"
  rm -f "${RUNTIME_ROOT}/unsloth_backend_resolver.py"
  rm -f "${RUNTIME_ROOT}/tailscale_route_state.py"
  rm -f "${RUNTIME_ROOT}/start_exposure.sh"
  rm -f "${RUNTIME_ROOT}/stop_exposure.sh"
  rm -f "${RUNTIME_ROOT}/remove_exposure.sh"
  rm -f "${RUNTIME_ROOT}/README.md"
  rmdir "${RUNTIME_ROOT}" 2>/dev/null || true
  systemctl_user daemon-reload
}

main "$@"
