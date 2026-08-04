# Unsloth Studio Dashboard Exposure Implementation Plan
> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan.

**Goal:** Make the live Unsloth Studio model visible in Dashboard 9000 with its exact API model ID, keep live-process status authoritative, and expose the guarded OpenAI-compatible endpoint on LAN and the specified Tailscale IP while leaving the Studio-owned backend loopback-only.

**Architecture:** Dashboard inventory continues discovering `llama-server` processes dynamically. A live `/v1/models` response supplies the model ID and wins over stale or absent static configuration. The UI renders that value as a dedicated `Model ID` field. A generic request-guard sidecar forwards only approved model API paths from `127.0.0.1:56828` to the Studio backend at `127.0.0.1:56827`, validates output-token budgets, and preserves streaming. A specific-address LAN `socat` listener exposes `192.168.0.21:56827` to the guard, while Tailscale Serve maps Tailscale TCP `56827` to the same guard. Studio keeps ownership of the model process and its original loopback port.

**Tech Stack:** Node.js ESM, Svelte 5, Node test runner, Python 3 standard library, `socat`, Tailscale Serve, existing Dashboard/Vite dev server.

## Global Constraints

- The exact live model ID is `unsloth/DeepSeek-V4-Flash-0731-GGUF`; obtain it from the live `/v1/models` response and render it separately from the display name even when the strings are equal. Never derive or hardcode the ID from a filename, stale env file, or guessed alias.
- The current Studio backend remains `127.0.0.1:56827`; do not rebind it to `0.0.0.0`, change its launcher, change its model, change its context, or take lifecycle ownership away from Unsloth Studio.
- The guard binds only `127.0.0.1:56828`, the LAN proxy binds only `192.168.0.21:56827`, and Tailscale Serve exposes only TCP `56827` to `127.0.0.1:56828`. Preserve all unrelated existing Tailscale Serve routes.
- Do not run Tailscale Funnel, `tailscale up`, ACL/DNS changes, firewall changes, broad process-kill commands, `tailscale serve reset`, or edits to other Unsloth vLLM profiles.
- The guard must reject malformed JSON and negative, non-integer, or over-limit output budgets (`max_tokens`, `max_completion_tokens`, and `max_output_tokens`) with a bounded client error; the maximum accepted value is `32768`. It must forward streaming responses without buffering the complete response.
- The model endpoint must expose the exact live model ID on both LAN and Tailscale paths. A successful `/v1/models` check and a bounded completion request are required before claiming the route is ready.
- Runtime scripts, PID/PGID records, raw command output, and rollback evidence stay outside Git under `/home/mctdgx01/models/operation_records/dashboard-unsloth-20260804T000000Z/`. Canonical sanitized Markdown belongs in the existing `Unsloth-Studio-main-UnslothAI-NA-9900` model folder in the DGXmodelmd repository.
- Dashboard model inventory is inventory-only for this Studio process: do not add a Dashboard Start/Stop profile for it. Future Unsloth Studio models must follow the same dynamic live-ID and guarded-exposure rule.
- The Dashboard UI must remain reachable from another LAN device at `http://192.168.0.21:9000/` and from the Tailscale address at `http://100.108.68.20:9000/`. The no-port example `http://192.168.0.21/` means TCP 80 and may only be added through an explicitly owned, privilege-authorized reverse proxy; do not silently take port 80 or claim it is ready when no host listener/authority exists.

---

## Task 1: Add red tests for live model ID precedence and display

**Files:** `test/model-card-display.test.js`, `test/runtime-model-inventory.test.js`, `model-card-display.js`.

1. Read the existing helpers and tests to preserve their current public shapes.
2. Add a model-card helper test proving a model with `apiModel: 'unsloth/DeepSeek-V4-Flash-0731-GGUF'` returns that exact value for the dedicated ID field, including when `name` is the same string. Add a test for an empty model proving the helper does not invent an ID from `name`.
3. Add an inventory merge test with a stale configured `apiModel` and live `details.apiModel: 'unsloth/DeepSeek-V4-Flash-0731-GGUF'`; assert the live value wins while the configured display metadata and Dashboard display port remain intact.
4. Run the two focused tests and record the expected failures before changing implementation code.

**Expected failure:** the current model-card module has no dedicated live-ID helper and `mergeRunningLlamaProcess` prefers the stale configured ID.

## Task 2: Implement live-ID inventory and live-runtime selection

**Files:** `model-card-display.js`, `runtime-model-inventory.js`, `llama-runtime-selection.js`, `test/runtime-model-inventory.test.js`, `test/llama-runtime-selection.test.js`, `dev-server.js`.

1. Add an exported `modelIdValue(model)` helper that returns the first non-empty `apiModel`, `servedModelName`, or `modelAlias`, and returns an empty string when no live/served ID exists; do not fall back to a display name.
2. Update `mergeRunningLlamaProcess` so a live probed `details.apiModel` takes precedence over configured metadata. Preserve the configured card identity, display port, path, and guard metadata when merging a process into a configured inventory item.
3. Add a pure `selectPreferredLlamaRuntime` helper in `llama-runtime-selection.js` with explicit precedence: a healthy live process carrying a live API model ID, then a healthy configured candidate carrying a live API model ID, then the existing configured/process fallback. Add tests covering stale config versus live process, configured fallback, and no-candidate fallback.
4. Refactor `getLlamaInfo` in `dev-server.js` to collect live process/API observations and use the helper. A healthy live process must report `status: 'running'`, its actual port, and the live API model ID even if the first static config is stale. Keep existing `/health` and `/props` behavior and error fallback intact.
5. Run `node --test test/model-card-display.test.js test/runtime-model-inventory.test.js test/llama-runtime-selection.test.js`, then the full `npm test` suite.

## Task 3: Render the dedicated Model ID field in every model card

**Files:** `src/lib/SystemMetrics.svelte`, `test/model-card-display.test.js`.

1. Add a focused source/behavior test that requires a visible `Model ID` label for LLAMA, vLLM, and ETC cards and verifies the value is sourced from `apiModel`/served metadata rather than a display-name fallback.
2. Update `SystemMetrics.svelte` to import the shared helper and render a separate, always-labeled `Model ID` row whenever a real ID is available. Keep the existing display title and connection/status rows unchanged.
3. Use truncation/tooltip styling suitable for long Hugging Face IDs without hiding the full value from the title attribute or API response.
4. Run the focused UI/model-card tests and `npm test`.

## Task 4: Add and test the generic Unsloth request guard

**Files:** `/home/mctdgx01/models/operation_records/dashboard-unsloth-20260804T000000Z/runtime/unsloth_request_guard.py`, `/home/mctdgx01/models/operation_records/dashboard-unsloth-20260804T000000Z/runtime/test_unsloth_request_guard.py`.

1. Write Python `unittest` cases first for accepted bounded budgets, rejection of malformed JSON, negative values, non-integers, values over `32768`, disallowed paths, and the guard header marker.
2. Implement a standard-library `ThreadingHTTPServer` reverse proxy with fixed upstream `127.0.0.1:56827`, configurable bind address/port defaults of `127.0.0.1:56828`, API-only path allowlisting (`/v1/` plus read-only health/metadata paths needed for validation), bounded request-body reads, and bounded 400/404/502/504 JSON errors.
3. Strip hop-by-hop headers, set `X-DGX-Request-Guard: unsloth-studio`, and stream upstream response bytes to the client with connection-close framing instead of buffering the complete response. Do not accept arbitrary upstream hosts or expose Studio UI/admin paths.
4. Run the focused Python tests and a syntax check before starting any listener.

## Task 5: Start exact-PID sidecars and expose LAN/Tailscale routes

**Files:** `/home/mctdgx01/models/operation_records/dashboard-unsloth-20260804T000000Z/runtime/start_sidecars.sh`, `/home/mctdgx01/models/operation_records/dashboard-unsloth-20260804T000000Z/runtime/stop_sidecars.sh`, `/home/mctdgx01/models/operation_records/dashboard-unsloth-20260804T000000Z/runtime/README.md`.

1. Add a start script that verifies the existing Studio backend is exactly `127.0.0.1:56827`, checks `127.0.0.1:56828` and `192.168.0.21:56827` are free, starts the guard and address-bound `socat` proxy in separate sessions, records exact PID/PGID values, and verifies each listener before route mutation.
2. Preserve existing Serve state and add only `--bg --tcp=56827 127.0.0.1:56828` using the installed Tailscale syntax. If an unprivileged invocation is rejected, stop before claiming Tailscale exposure and record the exact error; do not use reset/up/Funnel workarounds.
3. Add a stop script that reads only the recorded exact PID/PGID values, verifies command identity and process group before signaling, waits for exit, and never uses `pkill`, `killall`, wildcard matching, or broad process groups.
4. Run `bash -n` and shell-level dry checks, then start the sidecars and capture raw `ss`, process, and `tailscale serve status` evidence before/after the route change.

## Task 6: Restart Dashboard safely and run live acceptance tests

**Files:** `/home/mctdgx01/dgx-spark-status` runtime only; `/home/mctdgx01/models/operation_records/dashboard-unsloth-20260804T000000Z/evidence/`.

1. Restart only the exact Dashboard dev-server PID/PGID if the backend module is not hot-reloaded, using the existing `start.sh`/tmux ownership and verifying port `9000` remains on `0.0.0.0`.
2. Read the first SSE payload from `/api/metrics` and assert the LLAMA inventory contains `unsloth/DeepSeek-V4-Flash-0731-GGUF`, the live backend port `56827`, and a running status.
3. From loopback, LAN IPv4, Tailscale IPv4, Tailscale IPv6, and MagicDNS where locally resolvable, run `/v1/models` and assert the exact ID. Run a bounded non-streaming chat/completion request with the exact ID and a small output budget through LAN and Tailscale. Test a streaming request through the guard and confirm it receives incremental response bytes and the guard header.
4. Verify the raw backend is still loopback-only, the public paths terminate at the guard, the guard rejects an over-limit request, unrelated Tailscale routes are unchanged, and other Unsloth vLLM profiles were not touched.
5. Verify the Dashboard HTML itself from LAN `http://192.168.0.21:9000/` and Tailscale `http://100.108.68.20:9000/`. Probe `http://192.168.0.21/` separately; if TCP 80 has no existing authorized listener, record that bounded limitation rather than changing ownership or using a privileged workaround.
6. Save raw command output and JSON responses without credentials or model weights in the operation record.

## Task 7: Record canonical handoff and complete verification

**Files:** `/home/mctdgx01/projects/DGXmodelmd/Unsloth-Studio-main-UnslothAI-NA-9900/logs/DASHBOARD_MODEL_ID_TAILSCALE_20260804.md`, operation-record evidence files, SDD ledger.

1. Append a sanitized operation log containing exact model ID, port topology, ownership boundaries, validation results, Tailscale endpoint, rollback commands, and any environment limitation. Do not include tokens, full command lines with secrets, weight paths, or raw high-volume logs.
2. Run the canonical DGXmodelmd validator from the required `main` checkout, commit and push only the Markdown handoff if the validator and repository checks pass. Do not mix Dashboard source changes into that repository.
3. Run the full Dashboard test suite, Python guard tests, `bash -n`, endpoint checks, `git diff --check`, and the verification checklist from the design spec. Review `git status` for unrelated modifications.
4. Run the whole-branch code review and resolve all Critical/Important findings before completion. Keep any integration decision for the user after verification; do not delete or reset existing work.
