# DGX Unsloth durable exposure package

This package installs the maintained guard and proxy runtime under `/home/mctdgx01/.local/lib/dgx-unsloth-exposure`, installs the exact user units under `/home/mctdgx01/.config/systemd/user`, and preserves the fixed public topology:

- `dgx-unsloth-guard.service` runs the request guard on `127.0.0.1:56828`
- `dgx-unsloth-lan-proxy.service` exposes `192.168.0.21:56827`
- Tailscale Serve TCP `56827` is allowed to target only `127.0.0.1:56828`

Safety rules:

- no wildcard listener binding
- no direct Tailscale route to the raw backend on port `56827`
- no broad process-kill commands
- no global Serve reset

Default state/evidence paths:

- Active operation record: `/home/mctdgx01/.local/state/dgx-unsloth-exposure/active-operation.env`
- Default evidence directory: `/home/mctdgx01/.local/state/dgx-unsloth-exposure/evidence`

Entry points:

- `install_exposure.sh` installs runtime files with mode `0755`, installs unit files with mode `0644`, runs `systemctl --user daemon-reload`, enables `dgx-unsloth-guard.service` and `dgx-unsloth-lan-proxy.service`, verifies `192.168.0.21`, then starts the exact-address exposure safely
- `start_exposure.sh` refuses occupied unowned listeners, starts the exact units, verifies `192.168.0.21:56827` and `127.0.0.1:56828`, and records `ROUTE_PREEXISTING=1` or `ROUTE_CREATED=1`
- `stop_exposure.sh` stops only `dgx-unsloth-lan-proxy.service` and `dgx-unsloth-guard.service` and proves the listeners closed
- `remove_exposure.sh` performs exact rollback, removes the Tailscale TCP `56827` route only when `ROUTE_CREATED=1`, disables only the two exact units, and removes the installed files
