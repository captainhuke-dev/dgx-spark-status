# Managed Model Lifecycle and Kill All Design

## Goal

Make every Dashboard preset represent its complete managed runtime lifecycle, starting and stopping all declared components together. Show a partial DeepSeek runtime as degraded and stoppable, and add a Memory-card `Kill All Models` action that safely stops every active Dashboard-managed model.

## State model

The backend remains the source of truth. A managed profile may declare an exact runtime directory and component names. Each component is active only when its numeric PID and PGID files exist, `/proc/<pid>/stat` reports the same PGID, and the process is alive.

- `running`: configured health endpoint passes.
- `loading`: the complete declared component set is alive but health is not ready yet.
- `degraded_resident`: at least one declared component is alive but the complete set or API health is missing.
- `stopped`: health fails and no declared component, tmux session, or container is alive.

`degraded_resident` is active for control purposes: Dashboard shows `Weights Resident · API Offline`, presents Stop, and refuses Start until Stop cleans the old component set.

## DeepSeek preset lifecycle

The profile declares `/home/mctdgx01/models/deepseek-v4-flash-ds4-clean-v0.4.2/dashboard/runtime` with `server`, `request-guard`, `memory-guard`, and `weight-server`. Existing Start and Stop scripts remain the lifecycle executors. Stop continues to use exact recorded PID/PGID pairs and verifies the API ports, weight server, and broker socket are gone.

## Kill All Models

`POST /api/model-control/stop-all` loads the allowlisted model-control profiles, enriches their managed-component state, and sequentially invokes each active profile's existing exact stop path. It also stops the legacy PID-file-managed DS4 runtime when active. It never scans process names or sends a broad signal.

The response reports stopped, already-stopped, and failed profile IDs. Any failure makes the overall result non-successful while preserving per-profile evidence.

The Memory card displays a red `Kill All Models` button with browser confirmation. While running, the button is disabled and shows progress; completion or failure is shown inline.

## Compatibility

Profiles without managed-component metadata keep the existing health/tmux/container classification unchanged. The new status is additive. Existing Start/Stop endpoints and profile IDs remain stable.

## Tests

Tests use real temporary PID/PGID fixtures and injected `/proc` readers to prove the state transitions. Stop-all tests use real orchestration code with deterministic profile fixtures and exact literal outcomes. Existing Dashboard tests and live status checks cover regressions across all remaining profiles.
