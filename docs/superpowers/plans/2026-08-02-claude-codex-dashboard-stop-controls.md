# Claude/Codex Dashboard Stop Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add separate, confirmed dashboard controls in the CPU card that stop only owned Claude or Codex processes using an allowlisted PID snapshot.

**Architecture:** Put process discovery, exact executable classification, ownership/protection filtering, signal escalation, and result shaping in a focused `process-control.js` module with dependency injection. Add one family-allowlisted Express route in `dev-server.js` guarded by a dedicated action lock, then add two independent Svelte action states and buttons to the CPU card.

**Tech Stack:** Node.js ESM, Express, Svelte 5, `node:test`, `assert/strict`, Vite.

## Global Constraints

- Only executable basenames `claude`/`claude-code` and `codex`/`dacr-codex` are controllable.
- Only processes owned by the dashboard user are eligible.
- The dashboard process and its ancestor chain are always excluded.
- Use direct process APIs or fixed-argument `execFile`; never use shell interpolation, `pkill`, or `killall`.
- Actions capture a PID snapshot; newly spawned processes are not included in that action.
- Confirmation tokens are `STOP_CLAUDE` and `STOP_CODEX`.
- Tests must run before implementation for each behavior and must be observed failing for the expected reason.

---

### Task 1: Add the process-control module and unit tests

**Files:**
- Create: `process-control.js`
- Create: `test/process-control.test.js`

**Interfaces:**
- Produces `classifyExecutable(executable)`, `validateStopRequest(family, body)`, `createProcessController(dependencies)`, and `STOP_CONFIRMATIONS` for the server route.
- `createProcessController(dependencies).stopFamily(family)` returns `{ ok, family, captured, stopped, alreadyExited, escalated, failures }`.

- [ ] **Step 1: Write the failing tests**

Add tests for exact classification, confirmation validation, owner/protected PID filtering, graceful stop, PID reuse protection, SIGKILL escalation, and partial failures. The first test should assert the new exports:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyExecutable, validateStopRequest } from '../process-control.js';

test('classifies only exact Claude and Codex executable basenames', () => {
  assert.equal(classifyExecutable('claude'), 'claude');
  assert.equal(classifyExecutable('/usr/local/bin/codex'), 'codex');
  assert.equal(classifyExecutable('claude-helper'), null);
  assert.equal(classifyExecutable('node-codex-wrapper'), null);
});

test('requires the family-specific confirmation token', () => {
  assert.equal(validateStopRequest('claude', { confirm: 'STOP_CLAUDE' }).ok, true);
  assert.equal(validateStopRequest('codex', { confirm: 'STOP_CLAUDE' }).ok, false);
  assert.equal(validateStopRequest('other', { confirm: 'STOP_OTHER' }).ok, false);
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `node --test test/process-control.test.js`

Expected: FAIL because `process-control.js` does not exist yet. If the test errors for any other reason, fix the test setup before writing production code.

- [ ] **Step 3: Implement the minimal module**

Implement `process-control.js` with:

```js
export const STOP_CONFIRMATIONS = Object.freeze({ claude: 'STOP_CLAUDE', codex: 'STOP_CODEX' });

export function classifyExecutable(executable) {
  const basename = String(executable || '').split('/').pop().toLowerCase();
  if (basename === 'claude' || basename === 'claude-code') return 'claude';
  if (basename === 'codex' || basename === 'dacr-codex') return 'codex';
  return null;
}
```

Use injected `listProcesses`, `kill`, `isAlive`, `readStartTime`, `sleep`, `ownerUid`, and `selfPid` dependencies. Parse live process rows with fixed `ps` arguments in the default list implementation, build the protected ancestor set from PID/PPID rows, record each candidate's start time, send `SIGTERM`, wait 250ms, verify the same PID/start time, and use `SIGKILL` only for a still-alive matching candidate. Never include a process with a different UID, the dashboard PID, or an ancestor PID. Catch `ESRCH` as `alreadyExited`; return bounded failure codes for other errors.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `node --test test/process-control.test.js`

Expected: all process-control tests pass with no warnings.

- [ ] **Step 5: Refactor only after green**

Keep classification, candidate filtering, and signal execution as separate functions if the tests stay green. Do not add unrelated process matching.

- [ ] **Step 6: Commit the module and tests**

```bash
git add process-control.js test/process-control.test.js
git commit -m "feat: add safe Claude Codex process controller"
```

### Task 2: Add the family-specific stop API

**Files:**
- Modify: `dev-server.js` imports and route section near the existing model-control routes
- Create: `test/process-control-api.test.js`

**Interfaces:**
- Consumes `createProcessController`, `validateStopRequest`, and `STOP_CONFIRMATIONS` from `process-control.js`.
- Produces `POST /api/process-control/stop/:family` with `claude`/`codex` allowlisting, confirmation validation, action locking, and structured JSON results.

- [ ] **Step 1: Write the failing API contract tests**

Assert the server source contains the new route, both allowlisted family values, the confirmation validator, the dedicated action lock, and the controller call. Keep these source-contract assertions consistent with the existing `test/ds4-dashboard-preset.test.js` style so importing `dev-server.js` does not start a live server during tests.

```js
test('dashboard exposes separate Claude and Codex process stop routes', () => {
  assert.match(dashboardServer, /app\.post\('\/api\/process-control\/stop\/:family'/);
  assert.match(dashboardServer, /STOP_CLAUDE/);
  assert.match(dashboardServer, /STOP_CODEX/);
  assert.match(dashboardServer, /processController\.stopFamily\(family\)/);
});
```

- [ ] **Step 2: Run the focused API test to verify RED**

Run: `node --test test/process-control-api.test.js`

Expected: FAIL because the route and controller wiring do not exist.

- [ ] **Step 3: Implement the route**

Import and instantiate the controller using the existing `execFileAsync`. Add a separate `processControlActionLock = createModelControlActionLock()` near the model lock. In the route, reject invalid families or confirmation with HTTP 400, return HTTP 409 for a busy lock, call `processController.stopFamily(family)` inside the lock, and return HTTP 200 for `ok` results or HTTP 500 for partial failures. Do not put a caller-provided command, PID, or signal into an `exec` string.

- [ ] **Step 4: Run focused API tests and the existing suite**

Run: `node --test test/process-control.test.js test/process-control-api.test.js`

Expected: all focused tests pass.

Run: `npm test`

Expected: the existing tests plus the new tests pass with zero failures.

- [ ] **Step 5: Commit the API**

```bash
git add dev-server.js test/process-control-api.test.js
git commit -m "feat: expose Claude Codex stop controls"
```

### Task 3: Add the CPU-card controls

**Files:**
- Modify: `src/lib/SystemMetrics.svelte` CPU card markup and component state/functions
- Modify: `src/app.css` control-row/status styles if needed
- Create: `test/process-control-ui.test.js`

**Interfaces:**
- Consumes `/api/process-control/stop/claude` and `/api/process-control/stop/codex`.
- Produces two independent buttons with confirmation, busy state, success count, and inline error feedback in the CPU card.

- [ ] **Step 1: Write the failing UI contract tests**

Read `SystemMetrics.svelte` as text and assert it contains both Thai labels, both API paths, `window.confirm`, a busy label, and separate action state keys. Also assert the controls are inside the CPU card boundary.

```js
test('CPU card exposes separate Claude and Codex stop controls', () => {
  const source = readFileSync(new URL('../src/lib/SystemMetrics.svelte', import.meta.url), 'utf8');
  assert.match(source, /ปิด Claude/);
  assert.match(source, /ปิด Codex/);
  assert.match(source, /process-control\/stop\/\$\{family\}/);
  assert.match(source, /window\.confirm/);
  assert.match(source, /agentProcessActions/);
});
```

- [ ] **Step 2: Run the focused UI test to verify RED**

Run: `node --test test/process-control-ui.test.js`

Expected: FAIL because the CPU card has no agent process controls.

- [ ] **Step 3: Implement the minimal UI**

Add `let agentProcessActions = $state({ claude: {}, codex: {} });` and a `stopAgentFamily(family)` function that confirms `STOP_CLAUDE`/`STOP_CODEX` through the fixed family mapping, posts JSON to `/api/process-control/stop/${family}`, sets `{ busy, verb: 'stop' }`, and stores either a bounded count message or error. Add a compact control row under the CPU sparkline with two buttons calling `stopAgentFamily('claude')` and `stopAgentFamily('codex')`. Keep the buttons independent and use the existing dashboard button vocabulary.

- [ ] **Step 4: Run focused UI tests and build**

Run: `node --test test/process-control-ui.test.js`

Expected: PASS.

Run: `npm run build`

Expected: Vite exits with code 0 and produces the application build.

- [ ] **Step 5: Commit the UI**

```bash
git add src/lib/SystemMetrics.svelte src/app.css test/process-control-ui.test.js
git commit -m "feat: add Claude Codex controls to CPU card"
```

### Task 4: Verify safely on the live dashboard

**Files:**
- No source changes unless a verification failure requires a TDD fix

- [ ] **Step 1: Run the complete automated verification**

Run: `npm test && npm run build`

Expected: all tests pass and the production build exits 0.

- [ ] **Step 2: Check the live dashboard contract**

Run: `curl -fsS http://127.0.0.1:9000/ | rg 'ปิด Claude|ปิด Codex'`

Expected: both controls are present in the served page/assets path used by the dev server.

- [ ] **Step 3: Exercise the API without touching live agents**

Start a temporary same-user process only through a controlled test fixture or injected controller dependency, verify the process-control unit tests cover its lifecycle, and do not send `STOP_CLAUDE` or `STOP_CODEX` to the live dashboard while real sessions are running. Check `curl -fsS http://127.0.0.1:9000/healthz` or the dashboard's existing health endpoint afterward.

- [ ] **Step 4: Review the final diff and status**

Run: `git diff HEAD~3..HEAD --check && git status --short`

Expected: no whitespace errors; report any unrelated working-tree changes without modifying them.
