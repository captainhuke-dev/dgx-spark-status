# Managed Model Lifecycle and Kill All Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correctly expose complete/partial managed-model lifecycle state and provide a safe Memory-card action that stops every active managed model.

**Architecture:** Add a pure state classifier plus an exact PID/PGID component reader, enrich model-control API results without changing unconfigured profiles, and add a sequential stop-all orchestrator behind one authenticated-local Dashboard route. The Svelte UI consumes the enriched status and invokes the new endpoint after confirmation.

**Tech Stack:** Node.js ES modules, Express, Svelte 5, Bash modelctl/STOP_CMD, Node test runner.

## Global Constraints

- Never use `pkill`, `killall`, process-name matching, or an unresolved recursive target.
- DeepSeek components are `server`, `request-guard`, `memory-guard`, and `weight-server` under its exact dashboard runtime directory.
- `degraded_resident` is active and stoppable but not API-ready.
- Profiles without managed-component metadata retain current behavior byte-for-byte.
- Kill All is sequential, allowlisted, result-reporting, and includes the exact legacy DS4 controller.
- Preserve the existing uncommitted Nemotron cleanup in `dev-server.js`.

---

### Task 1: Managed component state

**Files:**
- Create: `model-control-state.js`
- Create: `managed-profile-components.js`
- Create: `test/managed-profile-components.test.js`

**Interfaces:**
- `classifyManagedStatus(profileStatus, components)` returns `{ status, running, active, degraded, active_components, inactive_components }`.
- `readManagedProfileComponents(profile, dependencies)` returns exact component observations from declared metadata.

- [ ] Write a failing test where only an exact matching `weight-server` PID/PGID is alive and expect `degraded_resident`, `active=true`, `running=false`.
- [ ] Run `node --test test/managed-profile-components.test.js` and verify the expected `stopped` versus `degraded_resident` failure.
- [ ] Implement strict numeric PID/PGID parsing, `/proc/<pid>/stat` PGID comparison, and the pure classification function.
- [ ] Add cases for full components without health (`loading`), passing health (`running`), stale PID/PGID (`stopped`), and an unconfigured profile (unchanged).
- [ ] Run the focused test and commit the exact new files.

### Task 2: Backend enrichment and safe Start behavior

**Files:**
- Modify: `dev-server.js`
- Modify: `/etc/dgx-model-control/models.d/deepseek-v4-flash-in240k-out32k.env`
- Test: `test/managed-profile-components.test.js`

**Interfaces:**
- `enrichModelControlProfile()` merges managed state into modelctl output.
- `startModelAsync()` rejects `degraded_resident` with code `managed_components_active`.

- [ ] Add a failing integration test proving an enriched partial DeepSeek profile returns `degraded_resident` while an ordinary stopped profile remains unchanged.
- [ ] Run the focused test and verify it fails before production integration.
- [ ] Add `MANAGED_RUNTIME_DIR` and `MANAGED_COMPONENTS` only to the DeepSeek profile and parse them from its trusted profile file.
- [ ] Integrate enrichment and Start rejection without changing existing running/loading branches.
- [ ] Run focused tests plus `node --check dev-server.js` and commit only the intended source/tests.

### Task 3: Stop-all orchestration and API

**Files:**
- Create: `model-control-operations.js`
- Create: `test/model-control-operations.test.js`
- Modify: `dev-server.js`

**Interfaces:**
- `stopAllManagedModels(profiles, dependencies)` returns `{ ok, action, stopped, already_stopped, failures }`.
- Route: `POST /api/model-control/stop-all`.

- [ ] Write a failing test with running, degraded, loading, and stopped profiles; expect stop calls only for the three active profile IDs in list order.
- [ ] Verify the test fails because the orchestrator is absent.
- [ ] Implement sequential exact-profile stop calls, legacy DS4 stop integration, and per-profile failure collection.
- [ ] Register the route and return HTTP 200 only when `ok=true`.
- [ ] Run focused tests and commit the exact files.

### Task 4: Dashboard display and Memory-card control

**Files:**
- Modify: `src/lib/SystemMetrics.svelte`
- Modify: `model-control-state.js`
- Test: `test/managed-profile-components.test.js`

**Interfaces:**
- `isActiveControlStatus(status)` recognizes `degraded_resident`.
- `modelControlStatusLabel(status)` returns `Weights Resident · API Offline` for the degraded state.

- [ ] Add failing literal-status tests for active classification and the degraded label.
- [ ] Verify the tests fail before UI changes.
- [ ] Use the shared helpers for model badge/control state and add confirmed `runStopAllModels()` behavior.
- [ ] Place `Kill All Models` in the Memory card with busy/result/error states and scoped red styling.
- [ ] Run focused tests, Svelte compilation through the existing suite, and commit the exact files.

### Task 5: Live lifecycle verification and evidence

**Files:**
- Modify: `DeepSeek-V4-Flash-Entrpi-DS4-DGX-Spark/logs/DASHBOARD_MODEL_LIFECYCLE_KILL_ALL_20260730.md` in the canonical DGXmodelmd repository.

**Interfaces:**
- Existing `STOP_CMD` and `START_CMD` remain the real lifecycle boundary.

- [ ] Stop current PID/PGID-recorded DeepSeek components and verify both ports, all four PIDs/PGIDs, and broker socket are absent.
- [ ] Restart Dashboard, verify API reports `stopped`, then click/call Start and wait for health plus all four exact components.
- [ ] Verify Dashboard reports `running`, then Stop and prove complete closure.
- [ ] Start once more, invoke Kill All, and prove every active managed profile/legacy DS4 runtime is stopped while Dashboard and unrelated services remain healthy.
- [ ] Run all tests, canonical validator, secret/large-file scans, commit/push only canonical evidence, and verify remote SHA.
