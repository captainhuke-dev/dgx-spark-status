#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RUNTIME_ROOT="${DGX_UNSLOTH_EXPOSURE_RUNTIME_ROOT:-/home/mctdgx01/.local/lib/dgx-unsloth-exposure}"
USER_UNIT_ROOT="${DGX_UNSLOTH_EXPOSURE_USER_UNIT_ROOT:-/home/mctdgx01/.config/systemd/user}"
STATE_ROOT="${DGX_UNSLOTH_EXPOSURE_STATE_ROOT:-/home/mctdgx01/.local/state/dgx-unsloth-exposure}"
STATE_FILE="${DGX_UNSLOTH_EXPOSURE_STATE_FILE:-${STATE_ROOT}/active-operation.env}"
EVIDENCE_DIR="${DGX_UNSLOTH_EXPOSURE_EVIDENCE_DIR:-${STATE_ROOT}/evidence}"
GUARD_UNIT_NAME="dgx-unsloth-guard.service"
LAN_PROXY_UNIT_NAME="dgx-unsloth-lan-proxy.service"
LAN_BIND_ADDRESS="192.168.0.21"
GUARD_TARGET="127.0.0.1:56828"

install_runtime_files() {
  install -d -m 0755 "${RUNTIME_ROOT}" "${USER_UNIT_ROOT}" "${STATE_ROOT}"
  install -m 0755 "${SCRIPT_DIR}/unsloth_request_guard.py" "${RUNTIME_ROOT}/unsloth_request_guard.py"
  install -m 0755 "${SCRIPT_DIR}/unsloth_backend_resolver.py" "${RUNTIME_ROOT}/unsloth_backend_resolver.py"
  install -m 0755 "${SCRIPT_DIR}/tailscale_route_state.py" "${RUNTIME_ROOT}/tailscale_route_state.py"
  install -m 0755 "${SCRIPT_DIR}/start_exposure.sh" "${RUNTIME_ROOT}/start_exposure.sh"
  install -m 0755 "${SCRIPT_DIR}/stop_exposure.sh" "${RUNTIME_ROOT}/stop_exposure.sh"
  install -m 0755 "${SCRIPT_DIR}/remove_exposure.sh" "${RUNTIME_ROOT}/remove_exposure.sh"
  install -m 0644 "${SCRIPT_DIR}/README.md" "${RUNTIME_ROOT}/README.md"
  install -m 0644 "${SCRIPT_DIR}/systemd/${GUARD_UNIT_NAME}" "${USER_UNIT_ROOT}/${GUARD_UNIT_NAME}"
  install -m 0644 "${SCRIPT_DIR}/systemd/${LAN_PROXY_UNIT_NAME}" "${USER_UNIT_ROOT}/${LAN_PROXY_UNIT_NAME}"
}

systemctl_user() {
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
  /usr/bin/systemctl --user "$@"
}

main() {
  install_runtime_files
  systemctl_user daemon-reload
  systemctl_user enable "${GUARD_UNIT_NAME}"
  systemctl_user enable "${LAN_PROXY_UNIT_NAME}"
  "${RUNTIME_ROOT}/start_exposure.sh" \
    --state-file "${STATE_FILE}" \
    --evidence-dir "${EVIDENCE_DIR}" \
    --runtime-root "${RUNTIME_ROOT}" \
    --user-unit-root "${USER_UNIT_ROOT}" \
    --lan-address "${LAN_BIND_ADDRESS}" \
    --guard-target "${GUARD_TARGET}"
}

main "$@"
