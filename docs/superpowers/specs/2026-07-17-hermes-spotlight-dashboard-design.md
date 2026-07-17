# Hermes Spotlight Dashboard Design

## Goal

Add a visually distinctive Hermes service card at the top of the existing ETC section in the DGX Spark Status Dashboard. The card must show live Hermes access state, safely start or stop the two approved Hermes services, and expose separate Local and Tail IP opening actions.

## Scope

- Dashboard repository: `/home/mctdgx01/dgx-spark-status`
- Hermes UI: `http://100.108.68.20:9119`
- Hermes upstream: `127.0.0.1:9119`
- Tail proxy: `127.0.0.1:9120`
- User services:
  - `hermes-dashboard.service`
  - `hermes-tail-proxy.service`
- Approved logo source: `/home/mctdgx01/.hermes/hermes-agent/website/static/img/logo.png`

The change must not modify vLLM, Hermes configuration, DataTrain, Tailscale Serve configuration, Caddy configuration, or ports 3389 and 11000.

The ETC section header is neutral and displays only `ETC`; it must not show the Ollama-derived `running` or `stopped` label because the section contains multiple independent runtimes.

## Visual Design

The Hermes card is a premium spotlight panel inside the existing ETC card rather than a new top-level dashboard section. It uses the supplied black-and-white girl logo as the primary image, clipped into an editorial portrait frame. Navy, cyan, and restrained gold accents provide contrast without recoloring or altering the source artwork.

The card contains:

- Hermes portrait and wordmark area
- Live `ONLINE`, `STARTING`, `STOPPING`, `DEGRADED`, or `OFFLINE` status pill
- Local and Tail IP access labels and URLs
- Compact service indicators for Hermes, tail proxy, HTTP health, and WebSocket-ready access
- `Start`, `Stop`, `Open Hermes Local`, and `Open Tail IP` actions
- Inline progress, success, and error messages

The design follows the Dashboard's existing rounded cards and button vocabulary while giving Hermes a recognizable branded surface. It remains responsive and collapses cleanly on narrow screens.

## Backend Design

Add a fixed Hermes runtime definition in `dev-server.js`. No user-controlled service name is accepted.

Endpoints:

- `GET /api/hermes/status`
  - Read the active/enabled state of both approved user services.
  - Probe `http://127.0.0.1:9119/api/status` with a short timeout.
  - Report the fixed Tailnet URL and ports without exposing secrets.
- `POST /api/hermes/start`
  - Start `hermes-dashboard.service` first.
  - Start `hermes-tail-proxy.service` second.
  - Poll the local Hermes status endpoint until ready or the bounded timeout expires.
- `POST /api/hermes/stop`
  - Stop `hermes-tail-proxy.service` first.
  - Stop `hermes-dashboard.service` second.
  - Confirm both services are inactive.
- `GET /api/hermes/logo`
  - Serve only the fixed approved logo file.

User-systemd commands run with the explicit user runtime directory and bus address needed by the system-owned Dashboard service. Responses are sanitized and bounded. Concurrent start/stop operations are rejected with a busy response.

## Frontend Behavior

`SystemMetrics.svelte` loads Hermes state on mount and refreshes it every five seconds. Start and stop actions disable conflicting buttons while in progress and immediately refresh status after completion. Stop requires browser confirmation because active Hermes sessions will be interrupted.

`Open Hermes Local` opens the status response's fixed `localUrl` (`http://127.0.0.1:9119`) in a new tab with `noopener,noreferrer`. This address works only from a browser running on the DGX host because Hermes remains loopback-only.

`Open Tail IP` opens the status response's fixed `url` (`http://100.108.68.20:9119`) in a new tab with `noopener,noreferrer`. Both opening actions are available only while Hermes is ready. The existing `Start` and `Stop` controls remain unchanged.

## Error Handling

- A healthy system requires both services active and the local Hermes status probe successful.
- If services are active but the health probe fails, the card shows `DEGRADED` rather than `ONLINE`.
- systemd, timeout, and HTTP failures appear inline without changing unrelated Dashboard state.
- Failed start attempts do not alter vLLM or other services.
- The fixed service allowlist prevents arbitrary systemd commands.

## Verification

- Run the Dashboard production build.
- Verify the four Hermes endpoints return their documented shapes.
- Verify the ETC header contains no aggregate `running` or `stopped` label.
- Verify the live card reads both fixed Local and Tail IP URLs and the approved logo.
- Exercise status and a safe stop/start cycle for the two Hermes services.
- Confirm local Hermes HTTP 200 and WebSocket-capable proxy access after restart.
- Confirm vLLM remains healthy on port 8538.
- Confirm ports 3389 and 11000 remain unchanged.
- Confirm no Hermes, Caddy, Tailscale Serve, DataTrain, or vLLM configuration file is modified.
