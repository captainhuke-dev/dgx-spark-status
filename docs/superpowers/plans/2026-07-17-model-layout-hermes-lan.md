# Model Layout and Hermes LAN Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give vLLM and ETC more desktop width, enlarge the Hermes portrait, advertise the working Hermes LAN URL, and prove the state-driven Start/Stop control against the live services.

**Architecture:** Keep the existing Dashboard and Hermes service controller boundaries. The controller advertises `http://192.168.0.21:9119` to browsers while probing the loopback-only upstream at `http://127.0.0.1:9119`; Svelte source tests lock the approved layout and URLs before the CSS and constants change.

**Tech Stack:** Node.js test runner, Express, Svelte, Vite, systemd user services, Caddy

## Global Constraints

- Desktop model tracks are `26 / 34 / 40` for llama.cpp, vLLM, and ETC.
- Hermes portrait is `104px × 116px` on desktop, `78px × 88px` at the 1200px breakpoint, and `58px × 68px` on narrow mobile screens.
- `Open Hermes Local` opens `http://192.168.0.21:9119`.
- Health probing remains on `http://127.0.0.1:9119/api/status`.
- Do not modify Caddy, vLLM, Hermes configuration, DataTrain, port 3389, or port 11000.
- Preserve the existing two-column and one-column responsive model-row breakpoints.

---

### Task 1: Lock the LAN and layout behavior with failing tests

**Files:**
- Modify: `test/hermes-service.test.js`
- Modify: `test/hermes-spotlight.test.js`

**Interfaces:**
- Consumes: `createHermesServiceController({ execFile, fetchImpl })`, `HermesSpotlight.svelte`, and `SystemMetrics.svelte` source.
- Produces: regression assertions for the advertised LAN URL, loopback health probe, desktop track ratio, portrait sizes, and unchanged responsive breakpoints.

- [ ] **Step 1: Extend the service status test**

Capture the URL passed to `fetchImpl`, then assert:

```js
assert.equal(result.localUrl, 'http://192.168.0.21:9119');
assert.deepEqual(requestedUrls, ['http://127.0.0.1:9119/api/status']);
assert.equal(result.health.endpoint, 'http://127.0.0.1:9119/api/status');
```

- [ ] **Step 2: Extend the component source test**

Assert the LAN fallback, endpoint copy, desktop portrait, tablet portrait, desktop tracks, and existing responsive tracks:

```js
assert.match(source, /hermes\?\.localUrl \|\| 'http:\/\/192\.168\.0\.21:9119'/);
assert.match(source, /192\.168\.0\.21:9119 · 100\.108\.68\.20:9119/);
assert.match(source, /\.portrait-shell\s*\{[^}]*width:\s*104px;[^}]*height:\s*116px;/s);
assert.match(source, /@media \(max-width: 1200px\)[\s\S]*?\.portrait-shell\s*\{\s*width:\s*78px;\s*height:\s*88px;/);
assert.match(dashboardSource, /grid-template-columns:\s*minmax\(0, 26fr\)\s+minmax\(0, 34fr\)\s+minmax\(0, 40fr\)/);
assert.match(dashboardSource, /@media \(max-width: 1200px\)[\s\S]*?\.models-row \{ grid-template-columns: repeat\(2, 1fr\); \}/);
assert.match(dashboardSource, /@media \(max-width: 768px\)[\s\S]*?\.models-row \{ grid-template-columns: 1fr; \}/);
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `node --test test/hermes-service.test.js test/hermes-spotlight.test.js`

Expected: assertions fail because status still advertises loopback, the portrait is still `78px × 88px`, and the model tracks are still equal.

### Task 2: Separate the LAN URL from the loopback probe

**Files:**
- Modify: `hermes-service.js`
- Modify: `src/lib/HermesSpotlight.svelte`

**Interfaces:**
- Consumes: existing `HERMES_RUNTIME`, `probeHealth()`, `status()`, and `openHermesLocal()`.
- Produces: `HERMES_RUNTIME.localUrl = 'http://192.168.0.21:9119'` and `HERMES_RUNTIME.upstreamUrl = 'http://127.0.0.1:9119'`.

- [ ] **Step 1: Update the controller constants and health probe**

```js
localUrl: 'http://192.168.0.21:9119',
upstreamUrl: 'http://127.0.0.1:9119',
```

Use `${HERMES_RUNTIME.upstreamUrl}/api/status` for the fetch and returned health endpoint. Continue returning `HERMES_RUNTIME.localUrl` as `status().localUrl`.

- [ ] **Step 2: Update the Hermes card LAN fallback and copy**

Set `HERMES_LOCAL_URL`, `openHermesLocal()` fallback, and displayed endpoint copy to `192.168.0.21:9119`, leaving the Tailscale URL unchanged.

### Task 3: Apply the approved layout

**Files:**
- Modify: `src/lib/SystemMetrics.svelte`
- Modify: `src/lib/HermesSpotlight.svelte`

**Interfaces:**
- Consumes: existing `.models-row`, `.hermes-spotlight`, and `.portrait-shell` CSS.
- Produces: a gap-safe `26fr / 34fr / 40fr` desktop grid and responsive portrait sizing.

- [ ] **Step 1: Change the desktop model tracks**

```css
grid-template-columns: minmax(0, 26fr) minmax(0, 34fr) minmax(0, 40fr);
```

Leave the existing 1200px two-column and 768px one-column rules intact.

- [ ] **Step 2: Enlarge the portrait and its grid track**

Use `104px` for the desktop first track and `104px × 116px` for `.portrait-shell`. At 1200px use `78px` and `78px × 88px`; keep the existing `58px × 68px` mobile rule.

- [ ] **Step 3: Run the focused tests and verify GREEN**

Run: `node --test test/hermes-service.test.js test/hermes-spotlight.test.js`

Expected: all focused tests pass with zero failures.

### Task 4: Build, reload, and exercise the live toggle

**Files:**
- Verify: `dev-server.js`
- Verify: `src/lib/SystemMetrics.svelte`
- Verify: `src/lib/HermesSpotlight.svelte`
- Verify: `hermes-service.js`

**Interfaces:**
- Consumes: Dashboard endpoints `/api/hermes/status`, `/api/hermes/stop`, `/api/hermes/start`.
- Produces: a freshly built and reloaded Dashboard with a confirmed live Stop/Start cycle.

- [ ] **Step 1: Run the full automated verification**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: all tests pass, Vite exits zero, and the diff check prints no errors.

- [ ] **Step 2: Reload the Dashboard service**

Read `MainPID` from `dgx-spark-status.service`, send that process `TERM`, wait for systemd's configured restart, and confirm the Dashboard status endpoint returns HTTP 200 with the LAN `localUrl`.

- [ ] **Step 3: Exercise Stop through the Dashboard API**

POST `/api/hermes/stop`, then confirm both approved user services are inactive and the status response is `offline`. Do not touch unrelated services.

- [ ] **Step 4: Exercise Start through the Dashboard API**

POST `/api/hermes/start`, then confirm both approved user services are active and the status response is `online` and `ready: true`.

- [ ] **Step 5: Run fresh endpoint and protected-port checks**

Confirm HTTP 200 from loopback `127.0.0.1:9119`, LAN `192.168.0.21:9119`, Tailscale `100.108.68.20:9119`, and vLLM `127.0.0.1:8538`. Confirm listeners on ports 3389 and 11000 are unchanged from the pre-action snapshot.

- [ ] **Step 6: Review the final diff**

Run `git diff -- hermes-service.js src/lib/HermesSpotlight.svelte src/lib/SystemMetrics.svelte test/hermes-service.test.js test/hermes-spotlight.test.js` and verify every hunk maps to this plan.
