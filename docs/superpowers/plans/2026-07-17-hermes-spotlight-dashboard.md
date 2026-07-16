# Hermes Spotlight Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a branded Hermes Spotlight card to the Dashboard ETC section with live status, safe Start/Stop controls, and a tailnet-only Open Hermes action.

**Architecture:** Put systemd and health-probe behavior in a focused dependency-injected ES module, expose four fixed Express endpoints from the existing server, and render an isolated Svelte component inside the ETC card. The service controller accepts no user-selected unit names and controls only the two approved Hermes user services.

**Tech Stack:** Node.js 25, Express 5, Svelte 5, Vite 7, Node built-in test runner, systemd user services, fixed local HTTP health probe.

## Global Constraints

- Use the approved black-and-white girl logo from `/home/mctdgx01/.hermes/hermes-agent/website/static/img/logo.png` without altering the source file.
- Keep Hermes on `127.0.0.1:9119`, Caddy on `127.0.0.1:9120`, and the tailnet URL at `http://100.108.68.20:9119`.
- Do not modify vLLM, Hermes configuration, DataTrain, Tailscale Serve configuration, Caddy configuration, or ports 3389 and 11000.
- Preserve all pre-existing uncommitted Dashboard changes and avoid unrelated refactoring.
- Stop requires confirmation and stops the proxy before Hermes; start starts Hermes before the proxy.

---

## File Structure

- Create `hermes-service.js`: fixed runtime constants, user-systemd execution, health probing, serialized start/stop behavior, and status normalization.
- Create `test/hermes-service.test.js`: Node unit tests for status, sequencing, allowlisting, busy protection, and failure normalization.
- Modify `dev-server.js`: import the controller and register fixed status/start/stop/logo routes.
- Create `src/lib/HermesSpotlight.svelte`: self-contained card state, polling, actions, accessibility, and visual treatment.
- Modify `src/lib/SystemMetrics.svelte`: import and mount the Hermes card at the top of ETC.
- Modify `package.json`: add the built-in unit-test command.
- Modify `.gitignore`: ignore `.superdesign/tmp/` only.

### Task 1: Hermes Service Controller

**Files:**
- Create: `test/hermes-service.test.js`
- Create: `hermes-service.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `HERMES_RUNTIME`, `HermesServiceError`, and `createHermesServiceController(dependencies)`.
- Controller methods: `status(): Promise<HermesStatus>`, `start(): Promise<HermesStatus>`, and `stop(): Promise<HermesStatus>`.
- `HermesStatus` includes `ok`, `state`, `ready`, `url`, `localUrl`, `proxyUrl`, `dashboard`, `proxy`, and `health`.

- [ ] **Step 1: Add the unit-test command**

Add to `package.json` scripts:

```json
"test": "node --test test/*.test.js"
```

- [ ] **Step 2: Write failing controller tests**

Create tests that inject fake `execFile`, `fetchImpl`, and `sleep` dependencies. Cover:

```js
test('status reports online only when both services and health are ready', async () => {
  const controller = createHermesServiceController(onlineDependencies());
  const result = await controller.status();
  assert.equal(result.state, 'online');
  assert.equal(result.ready, true);
  assert.equal(result.url, 'http://100.108.68.20:9119');
});

test('start orders dashboard before proxy', async () => {
  const calls = [];
  const controller = createHermesServiceController(recordingDependencies(calls));
  await controller.start();
  assert.deepEqual(calls.filter(call => call[0] === 'systemctl'), [
    ['systemctl', '--user', 'start', 'hermes-dashboard.service'],
    ['systemctl', '--user', 'start', 'hermes-tail-proxy.service'],
  ]);
});

test('stop orders proxy before dashboard', async () => {
  const calls = [];
  const controller = createHermesServiceController(recordingDependencies(calls));
  await controller.stop();
  assert.deepEqual(calls.filter(call => call[0] === 'systemctl'), [
    ['systemctl', '--user', 'stop', 'hermes-tail-proxy.service'],
    ['systemctl', '--user', 'stop', 'hermes-dashboard.service'],
  ]);
});

test('rejects a second action while an action is active', async () => {
  const controller = createHermesServiceController(blockingDependencies());
  const first = controller.start();
  await assert.rejects(controller.stop(), error => error.code === 'busy');
  releaseBlockingAction();
  await first;
});
```

- [ ] **Step 3: Run tests and confirm RED**

Run: `npm test`

Expected: FAIL because `hermes-service.js` does not exist.

- [ ] **Step 4: Implement the controller minimally**

Implement fixed constants and a factory with these rules:

```js
export const HERMES_RUNTIME = Object.freeze({
  dashboardUnit: 'hermes-dashboard.service',
  proxyUnit: 'hermes-tail-proxy.service',
  localUrl: 'http://127.0.0.1:9119',
  proxyUrl: 'http://127.0.0.1:9120',
  tailnetUrl: 'http://100.108.68.20:9119',
  logoPath: '/home/mctdgx01/.hermes/hermes-agent/website/static/img/logo.png',
  userRuntimeDir: '/run/user/1000',
});

const APPROVED_UNITS = new Set([
  HERMES_RUNTIME.dashboardUnit,
  HERMES_RUNTIME.proxyUnit,
]);
```

Use `systemctl --user show <unit> --property=ActiveState --property=UnitFileState --no-pager` for status. Set `XDG_RUNTIME_DIR=/run/user/1000` and `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus` in every systemctl execution. Probe `/api/status` with a bounded request and normalize failures into `health.ok=false` rather than throwing from `status()`.

- [ ] **Step 5: Run controller tests and confirm GREEN**

Run: `npm test`

Expected: all controller tests pass.

### Task 2: Fixed Express API

**Files:**
- Modify: `dev-server.js`
- Test: `test/hermes-service.test.js`

**Interfaces:**
- Consumes: `HERMES_RUNTIME` and a singleton controller from Task 1.
- Produces: `GET /api/hermes/status`, `POST /api/hermes/start`, `POST /api/hermes/stop`, and `GET /api/hermes/logo`.

- [ ] **Step 1: Add route-contract assertions**

Extend the test suite with response-mapping tests for success, `busy` → HTTP 409, and operation failure → HTTP 503. Keep route handlers thin by exporting a helper:

```js
export function hermesErrorStatus(error) {
  return error?.code === 'busy' ? 409 : 503;
}
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm test`

Expected: FAIL because the error mapping is not implemented.

- [ ] **Step 3: Register the fixed routes**

Import the controller into `dev-server.js`, instantiate it with `execFileAsync` and global `fetch`, then register:

```js
app.get('/api/hermes/status', async (_req, res) => {
  res.json(await hermesController.status());
});

app.post('/api/hermes/start', async (_req, res) => {
  try {
    res.json(await hermesController.start());
  } catch (error) {
    res.status(hermesErrorStatus(error)).json(errorPayload(error));
  }
});

app.post('/api/hermes/stop', async (_req, res) => {
  try {
    res.json(await hermesController.stop());
  } catch (error) {
    res.status(hermesErrorStatus(error)).json(errorPayload(error));
  }
});

app.get('/api/hermes/logo', (_req, res) => {
  res.type('png').sendFile(HERMES_RUNTIME.logoPath);
});
```

Do not accept a service, URL, port, path, or shell command from request input.

- [ ] **Step 4: Run tests and syntax validation**

Run:

```bash
npm test
node --check dev-server.js
```

Expected: all tests pass and syntax check exits 0.

### Task 3: Hermes Spotlight Component

**Files:**
- Create: `src/lib/HermesSpotlight.svelte`
- Modify: `src/lib/SystemMetrics.svelte`
- Modify: `.gitignore`

**Interfaces:**
- Consumes the four fixed `/api/hermes/*` routes.
- Produces a responsive card mounted inside the ETC `.models-list` before Ollama entries.

- [ ] **Step 1: Initialize Superdesign context**

Verify and run the on-demand CLI. If `.superdesign/init/` is absent, follow the skill initialization workflow. Add `.superdesign/tmp/` to `.gitignore` before creating temporary design files.

Run:

```bash
npx --yes @superdesign/cli@latest --version
```

Expected: a CLI version and authenticated command access.

- [ ] **Step 2: Create a faithful design draft**

Use the existing Dashboard page dependency context and specify:

- black-and-white Hermes girl portrait
- navy/cyan background with restrained gold accents
- status pill and four small service indicators
- Start, Stop, Open Hermes buttons
- ETC-card-compatible dimensions and mobile stacking

Use the draft as visual guidance; do not replace the app architecture with generated standalone HTML.

- [ ] **Step 3: Implement component state and actions**

Implement self-contained polling and actions:

```svelte
onMount(() => {
  loadStatus();
  timer = setInterval(loadStatus, 5000);
});

async function runAction(action) {
  if (action === 'stop' && !confirm('Stop Hermes and disconnect active Hermes sessions?')) return;
  actionState = { busy: true, verb: action, message: '', error: '' };
  const response = await fetch(`/api/hermes/${action}`, { method: 'POST' });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.message || `${action} failed`);
  hermes = data;
  actionState = { busy: false, message: action === 'start' ? 'Hermes is ready.' : 'Hermes stopped.' };
}

function openHermes() {
  window.open(hermes?.url || 'http://100.108.68.20:9119', '_blank', 'noopener,noreferrer');
}
```

- [ ] **Step 4: Implement visual and accessibility states**

Use semantic buttons, visible focus rings, `aria-live` for status messages, descriptive alt text, and disabled states during operations. Preserve the portrait without filters that alter the approved artwork. Use responsive CSS local to the component.

- [ ] **Step 5: Mount in ETC**

Import the component in `SystemMetrics.svelte`:

```svelte
import HermesSpotlight from './HermesSpotlight.svelte';
```

Render `<HermesSpotlight />` immediately inside the ETC `.models-list`, before the existing Ollama model loop.

- [ ] **Step 6: Run the production build**

Run: `npm run build`

Expected: Vite/Svelte build exits 0 without accessibility or compile errors.

### Task 4: Live Integration and Preservation Verification

**Files:**
- Modify only if a defect is found: files from Tasks 1–3

**Interfaces:**
- Consumes the running Dashboard at port 9000 and Hermes tailnet stack.
- Produces evidence that the feature works without changing protected systems.

- [ ] **Step 1: Restart only the Dashboard service**

Run:

```bash
sudo systemctl restart dgx-spark-status.service
systemctl is-active dgx-spark-status.service
```

Expected: `active`.

- [ ] **Step 2: Verify status and logo endpoints**

Run:

```bash
curl -fsS http://127.0.0.1:9000/api/hermes/status | jq '{state,ready,url,dashboard,proxy,health}'
curl -fsSI http://127.0.0.1:9000/api/hermes/logo
```

Expected: state `online`, URL `http://100.108.68.20:9119`, both services active, health true, and logo HTTP 200 with PNG content type.

- [ ] **Step 3: Exercise the controlled stop/start cycle**

Record current states, POST stop, verify both user services inactive, POST start, and verify both active plus local `/api/status` HTTP 200. If active Hermes sessions are present, report that the verification intentionally interrupts them before performing this approved control test.

- [ ] **Step 4: Verify protected ports and vLLM**

Run:

```bash
curl -fsS http://127.0.0.1:8538/health
ss -ltn '( sport = :3389 or sport = :11000 or sport = :8538 or sport = :9119 or sport = :9120 )'
```

Expected: vLLM health succeeds; ports 3389 and 11000 are unchanged; Hermes and proxy return on loopback after start.

- [ ] **Step 5: Run final verification suite**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: tests and build pass, and no whitespace errors are reported.

