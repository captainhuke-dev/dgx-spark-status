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

Package route commands serialize through an exclusive lock beside the active
operation record. Every command creates a unique evidence session, and each
Serve snapshot is written once under a phase such as `pre-change`,
`post-change`, `remove-pre-off`, or `compensation-post-off`. Add/remove checks
compare the normalized complete route maps after excluding only managed TCP
`56827`; any unrelated route change is a hard failure.

The Tailscale CLI has no compare-and-swap operation that combines status
classification and mutation. The package therefore holds its lock across the
last classification, exact per-route command, and verification, and re-reads
immediately before every `off`. This serializes package operations and narrows
the external-CLI race window; a replacement or conflict observed by that last
classification is never mutated. The package still never uses Serve reset,
Funnel, or `tailscale up`.

Default state/evidence paths:

- Active operation record: `/home/mctdgx01/.local/state/dgx-unsloth-exposure/active-operation.env`
- Default evidence directory: `/home/mctdgx01/.local/state/dgx-unsloth-exposure/evidence`

Entry points:

- `install_exposure.sh` snapshots pre-existing package files and each unit's enabled state, installs runtime files with mode `0755` and unit files with mode `0644`, then starts the exact-address exposure. A later failure removes/disables only additions from that invocation and restores pre-existing files and enablement; successful repeated installation remains idempotent.
- `start_exposure.sh` refuses occupied unowned listeners, starts the guard, and requires HTTP 200 from `127.0.0.1:56828/v1/models` with `X-DGX-Request-Guard: unsloth-studio` and exactly one nonempty live model ID before starting the LAN proxy or ensuring the Tailscale route. It then verifies `192.168.0.21:56827` and records `ROUTE_PREEXISTING=1` or `ROUTE_CREATED=1`.
- `stop_exposure.sh` stops only `dgx-unsloth-lan-proxy.service` and `dgx-unsloth-guard.service` and proves the listeners closed
- `remove_exposure.sh` performs exact rollback, removes the Tailscale TCP `56827` route only when `ROUTE_CREATED=1`, disables only the two exact units, and removes the installed files

## Interrupted route reconciliation

`ROUTE_PENDING=1` is fail-closed. Preflight, ensure, and remove refuse to run,
even if a later route happens to match the guard target. Inspect the preserved
evidence and current Serve state, then explicitly preserve the current route
without claiming or deleting it:

```bash
python3 /home/mctdgx01/.local/lib/dgx-unsloth-exposure/tailscale_route_state.py \
  reconcile \
  --resolution preserve-current \
  --state-file /home/mctdgx01/.local/state/dgx-unsloth-exposure/active-operation.env \
  --evidence-dir /home/mctdgx01/.local/state/dgx-unsloth-exposure/evidence
```

This command is deliberately non-mutating. It records the observed
`absent`/`matching`/`conflicting` classification, clears pending state only
because the operator invoked reconciliation explicitly, and relinquishes route
ownership. A preserved conflict will still fail subsequent preflight until the
operator resolves it outside this package.
