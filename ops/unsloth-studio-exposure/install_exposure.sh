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
SYSTEMCTL_BIN="${DGX_UNSLOTH_EXPOSURE_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
RUNTIME_FILES=(
  unsloth_request_guard.py
  unsloth_backend_resolver.py
  tailscale_route_state.py
  start_exposure.sh
  stop_exposure.sh
  remove_exposure.sh
  README.md
)
UNIT_FILES=("${GUARD_UNIT_NAME}" "${LAN_PROXY_UNIT_NAME}")
BACKUP_ROOT=""
INSTALL_MUTATED="0"
RUNTIME_ROOT_EXISTED="0"
USER_UNIT_ROOT_EXISTED="0"
GUARD_ENABLED_BEFORE="0"
LAN_ENABLED_BEFORE="0"

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
  "${SYSTEMCTL_BIN}" --user "$@"
}

snapshot_file() {
  local source_path="$1"
  local backup_path="$2"
  if [[ -e "${source_path}" && ! -f "${source_path}" ]]; then
    echo "refusing non-regular pre-existing install target ${source_path}" >&2
    exit 1
  fi
  if [[ -f "${source_path}" ]]; then
    cp -a -- "${source_path}" "${backup_path}"
  fi
}

snapshot_install_state() {
  [[ -d "${RUNTIME_ROOT}" ]] && RUNTIME_ROOT_EXISTED="1"
  [[ -d "${USER_UNIT_ROOT}" ]] && USER_UNIT_ROOT_EXISTED="1"
  systemctl_user is-enabled --quiet "${GUARD_UNIT_NAME}" && GUARD_ENABLED_BEFORE="1"
  systemctl_user is-enabled --quiet "${LAN_PROXY_UNIT_NAME}" && LAN_ENABLED_BEFORE="1"

  BACKUP_ROOT="$(mktemp -d)"
  mkdir -p "${BACKUP_ROOT}/runtime" "${BACKUP_ROOT}/units"
  local name
  for name in "${RUNTIME_FILES[@]}"; do
    snapshot_file "${RUNTIME_ROOT}/${name}" "${BACKUP_ROOT}/runtime/${name}"
  done
  for name in "${UNIT_FILES[@]}"; do
    snapshot_file "${USER_UNIT_ROOT}/${name}" "${BACKUP_ROOT}/units/${name}"
  done
}

restore_file_or_remove_new() {
  local destination="$1"
  local backup="$2"
  if [[ -f "${backup}" ]]; then
    cp -a -- "${backup}" "${destination}"
  else
    rm -f -- "${destination}"
  fi
}

rollback_install() {
  local exit_code="$?"
  set +e
  if [[ "${exit_code}" -ne 0 && "${INSTALL_MUTATED}" == "1" ]]; then
    if [[ "${LAN_ENABLED_BEFORE}" == "0" ]] && systemctl_user is-enabled --quiet "${LAN_PROXY_UNIT_NAME}"; then
      systemctl_user disable "${LAN_PROXY_UNIT_NAME}"
    fi
    if [[ "${GUARD_ENABLED_BEFORE}" == "0" ]] && systemctl_user is-enabled --quiet "${GUARD_UNIT_NAME}"; then
      systemctl_user disable "${GUARD_UNIT_NAME}"
    fi

    local name
    for name in "${RUNTIME_FILES[@]}"; do
      restore_file_or_remove_new "${RUNTIME_ROOT}/${name}" "${BACKUP_ROOT}/runtime/${name}"
    done
    for name in "${UNIT_FILES[@]}"; do
      restore_file_or_remove_new "${USER_UNIT_ROOT}/${name}" "${BACKUP_ROOT}/units/${name}"
    done
    systemctl_user daemon-reload
    if [[ "${RUNTIME_ROOT_EXISTED}" == "0" ]]; then
      rmdir "${RUNTIME_ROOT}" 2>/dev/null || true
    fi
    if [[ "${USER_UNIT_ROOT_EXISTED}" == "0" ]]; then
      rmdir "${USER_UNIT_ROOT}" 2>/dev/null || true
    fi
  fi
  if [[ -n "${BACKUP_ROOT}" && -d "${BACKUP_ROOT}" ]]; then
    rm -rf -- "${BACKUP_ROOT}"
  fi
  return "${exit_code}"
}

preflight_install() {
  "${SCRIPT_DIR}/start_exposure.sh" \
    --preflight-only \
    --state-file "${STATE_FILE}" \
    --evidence-dir "${EVIDENCE_DIR}" \
    --runtime-root "${SCRIPT_DIR}" \
    --user-unit-root "${USER_UNIT_ROOT}" \
    --lan-address "${LAN_BIND_ADDRESS}" \
    --guard-target "${GUARD_TARGET}"
}

main() {
  preflight_install
  trap rollback_install EXIT
  snapshot_install_state
  INSTALL_MUTATED="1"
  install_runtime_files
  systemctl_user daemon-reload
  if [[ "${GUARD_ENABLED_BEFORE}" == "0" ]]; then
    systemctl_user enable "${GUARD_UNIT_NAME}"
  fi
  if [[ "${LAN_ENABLED_BEFORE}" == "0" ]]; then
    systemctl_user enable "${LAN_PROXY_UNIT_NAME}"
  fi
  "${RUNTIME_ROOT}/start_exposure.sh" \
    --state-file "${STATE_FILE}" \
    --evidence-dir "${EVIDENCE_DIR}" \
    --runtime-root "${RUNTIME_ROOT}" \
    --user-unit-root "${USER_UNIT_ROOT}" \
    --lan-address "${LAN_BIND_ADDRESS}" \
    --guard-target "${GUARD_TARGET}"
}

main "$@"
