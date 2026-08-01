# Claude/Codex Dashboard Stop Controls Design

## Goal

Add two independent controls to the CPU card in the DGX Spark Status Dashboard:

- `ปิด Claude` stops only running Claude processes owned by the dashboard user.
- `ปิด Codex` stops only running Codex processes owned by the dashboard user.

The controls are intended for operator use when the dashboard shows the current process load. They must not stop model runtimes, dashboard services, unrelated Node processes, or processes owned by another user.

## Current context

The dashboard is `/home/mctdgx01/dgx-spark-status`, served by `dev-server.js` on port 9000. Metrics are streamed over the existing WebSocket and the CPU card is rendered by `src/lib/SystemMetrics.svelte`. Existing model and Hermes controls use server-side allowlists, confirmation for destructive actions, and action-state feedback.

The current DGX process inventory includes executable names such as `claude`, `codex`, and `codex app-server`. The existing process classification contract treats executable `claude`/`claude-code` as Claude and executable `codex`/`dacr-codex` as Codex. The new control will reuse that exact classification boundary instead of matching arbitrary command text.

## Design

### Backend process control module

Create a small, testable module that:

1. Enumerates processes with PID, owner UID, executable name, command line, and start time.
2. Classifies only the supported executable boundaries:
   - Claude: executable basename `claude` or `claude-code`.
   - Codex: executable basename `codex` or `dacr-codex`.
   - Everything else: ignored.
3. Filters to the dashboard process owner and excludes the dashboard server's own PID and its ancestor chain as a defense-in-depth safeguard.
4. Sends `SIGTERM` to the captured PID set, waits briefly, and verifies each PID. Any still-alive captured PID may receive `SIGKILL`; new processes discovered after the capture are not included in the same action.
5. Returns bounded, structured results: requested family, captured PIDs, stopped PIDs, already-exited PIDs, failures, and an `ok` flag. Error messages must not expose command-line contents or secrets.

The process list and kill implementation will use direct Node process APIs or `execFile` with fixed arguments. No shell interpolation, `pkill`, `killall`, or caller-provided command is permitted.

### API

Add `POST /api/process-control/stop/:family`, where `family` is an allowlisted route value: `claude` or `codex`.

The endpoint requires an explicit JSON confirmation token matching the selected family, such as `STOP_CLAUDE` or `STOP_CODEX`. Invalid family or missing confirmation returns HTTP 400. Concurrent process-control actions return HTTP 409 using the existing action-lock pattern. A successful stop returns HTTP 200 with the structured result; partial failures return a non-success response with the same result shape so the UI can display the affected counts.

The endpoint runs under the existing dashboard service user (`mctdgx01`). It therefore cannot affect another user's processes and must report permission failures instead of attempting escalation.

### CPU-card UI

Add a compact control row below the CPU sparkline with two visibly distinct destructive buttons:

- `ปิด Claude`
- `ปิด Codex`

Each button:

- asks for browser confirmation before sending the request;
- disables itself while its action is running;
- displays `กำลังปิด…` during the request;
- displays a concise success result with the number of stopped processes;
- displays an inline error for invalid/partial/failed results;
- remains independent, so a Claude action cannot disable the Codex button except while the shared server action lock is busy.

After a successful or partial action, the existing metrics refresh continues to show the current process state; no new polling channel is introduced.

### Error handling and safety

- Only `claude`/`claude-code` and `codex`/`dacr-codex` executable names are controllable.
- The action is PID-snapshot based to avoid killing processes spawned after the operator clicked the button.
- PID reuse is guarded by recording process start time and rechecking it before escalation.
- The UI confirmation text names the selected family and warns that active sessions will be interrupted.
- A process that exits between enumeration and signal delivery is reported as already exited, not as a failure.
- The dashboard process itself and known dashboard ancestor processes are never eligible.

## Testing

Write tests before implementation for:

- exact family classification and rejection of lookalike command text;
- owner and dashboard-process exclusions;
- SIGTERM/verification behavior, escalation only for the captured PID and matching start time, and partial-failure reporting using injected process dependencies;
- route validation and per-family confirmation tokens;
- CPU-card markup containing both controls and the frontend request/confirmation paths.

Run the focused tests during the red-green cycle, then run the complete `npm test` suite and `npm run build`. For live validation, exercise the API with a harmless temporary process that is classified through an injected test dependency or a controlled local fixture; do not use the live Claude/Codex processes as the first test target. Finally verify the dashboard page and metrics endpoint remain healthy on port 9000.

## Non-goals

- No combined “stop all agents” control.
- No model, Hermes, dashboard, or systemd service changes.
- No process restart or automatic relaunch.
- No control over arbitrary PIDs, arbitrary command strings, or processes owned by other users.
