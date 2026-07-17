# Hermes Dual Open Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ETC header runtime-neutral and give Hermes separate Local and Tail IP opening actions while preserving Start/Stop controls.

**Architecture:** Keep the existing fixed URLs returned by `GET /api/hermes/status`; no backend or service configuration changes are required. Update only the isolated Hermes Svelte component and the ETC heading, with source-contract tests covering the two destinations and neutral header.

**Tech Stack:** Svelte 5, Node.js built-in test runner, Vite 7.

## Global Constraints

- The ETC heading displays only `ETC`, without an aggregate `running` or `stopped` label.
- Preserve the existing Hermes `Start` and `Stop` controls.
- `Open Hermes Local` opens `http://127.0.0.1:9119` from `hermes.localUrl`.
- `Open Tail IP` opens `http://100.108.68.20:9119` from `hermes.url`.
- Both opening actions use `_blank` with `noopener,noreferrer` and remain disabled while Hermes is not ready.
- Do not modify Hermes, Caddy, Tailscale, vLLM, DataTrain, or ports 3389 and 11000.
- Preserve all pre-existing uncommitted Dashboard changes.

---

### Task 1: Neutral ETC Header and Dual Hermes Destinations

**Files:**
- Modify: `test/hermes-spotlight.test.js`
- Modify: `src/lib/HermesSpotlight.svelte`
- Modify: `src/lib/SystemMetrics.svelte:838`

**Interfaces:**
- Consumes: `hermes.localUrl`, `hermes.url`, and `hermes.ready` from `GET /api/hermes/status`.
- Produces: `openHermesLocal()` and `openHermesTail()` browser actions plus the neutral `<h2>ETC</h2>` heading.

- [ ] **Step 1: Write the failing source-contract tests**

Extend `test/hermes-spotlight.test.js` with exact assertions:

```js
const dashboardPath = fileURLToPath(new URL('../src/lib/SystemMetrics.svelte', import.meta.url));

assert.match(source, /Open Hermes Local/);
assert.match(source, /Open Tail IP/);
assert.match(source, /hermes\?\.localUrl \|\| 'http:\/\/127\.0\.0\.1:9119'/);
assert.match(source, /hermes\?\.url \|\| 'http:\/\/100\.108\.68\.20:9119'/);

const dashboardSource = readFileSync(dashboardPath, 'utf8');
assert.match(dashboardSource, /<h2>ETC<\/h2>/);
assert.doesNotMatch(dashboardSource, /<h2>ETC \{#if metrics\.inference\.ollama\.available\}/);
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm test`

Expected: the Hermes Spotlight contract fails because only `Open Hermes` and the aggregate ETC status currently exist.

- [ ] **Step 3: Implement the two fixed opening functions**

Replace the single opening function with:

```js
function openHermesLocal() {
  window.open(hermes?.localUrl || 'http://127.0.0.1:9119', '_blank', 'noopener,noreferrer');
}

function openHermesTail() {
  window.open(hermes?.url || 'http://100.108.68.20:9119', '_blank', 'noopener,noreferrer');
}
```

Render two `.action-button.open` controls labeled `Open Hermes Local` and `Open Tail IP`. Keep Start and Stop unchanged, and change the action grid to two columns so four controls form a compact two-by-two layout.

- [ ] **Step 4: Make the ETC heading neutral**

Replace the current conditional heading with:

```svelte
<h2>ETC</h2>
```

- [ ] **Step 5: Verify tests and production build**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: all tests pass, the build exits 0, and no whitespace errors are reported. Existing `note-display` accessibility warnings may remain because they predate and are outside this change.

- [ ] **Step 6: Reload and verify the live Dashboard**

Reload only `dgx-spark-status.service`, then verify:

```bash
curl -fsS http://127.0.0.1:9000/api/hermes/status | jq '{state,ready,localUrl,url}'
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9119/api/status
curl -fsS -o /dev/null -w '%{http_code}\n' http://100.108.68.20:9119/api/status
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8538/health
```

Expected: status reports both fixed URLs, and Hermes Local, Hermes Tail IP, and vLLM each return HTTP 200.

- [ ] **Step 7: Preserve repository ownership**

Review the exact diff and leave the implementation changes in the current working tree without a broad commit, because `SystemMetrics.svelte` contains pre-existing user changes that must not be staged accidentally.

