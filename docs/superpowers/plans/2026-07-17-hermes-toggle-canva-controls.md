# Hermes Toggle and Canva Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace separate Hermes Start/Stop buttons with one state-driven toggle and restyle the vertically stacked Local/Tailscale opening buttons with distinct Canva-like colors while preserving the original logo size.

**Architecture:** Keep all existing backend APIs and fixed URLs. Add a small stack-state helper inside the isolated Svelte component, render one toggle from that state, and group the two opening actions in a vertical sub-layout with separate scoped visual variants.

**Tech Stack:** Svelte 5, Node.js built-in test runner, Vite 7, scoped vanilla CSS.

## Global Constraints

- Preserve `POST /api/hermes/start`, `POST /api/hermes/stop`, `hermes.localUrl`, and `hermes.url` unchanged.
- Show `Stop` whenever `hermes.dashboard.active` or `hermes.proxy.active` is true; show `Start` only when both are false.
- Keep the existing confirmation before every stop action.
- Rename `Open Tail IP` to `Open Hermes Tailscale`.
- Stack `Open Hermes Local` above `Open Hermes Tailscale` vertically.
- Use a green gradient/shadow for Local and a cyan-to-blue gradient/shadow for Tailscale.
- Preserve the portrait at `78px × 88px` on desktop and tablet.
- Do not modify service configuration, vLLM, DataTrain, Caddy, Tailscale, or ports 3389 and 11000.
- Preserve all pre-existing uncommitted Dashboard changes.

---

### Task 1: State-Driven Toggle and Stacked Opening Controls

**Files:**
- Modify: `test/hermes-spotlight.test.js`
- Modify: `src/lib/HermesSpotlight.svelte`

**Interfaces:**
- Consumes: `hermes.dashboard.active`, `hermes.proxy.active`, `hermes.ready`, `actionState.busy`, and the existing `runAction(action)` function.
- Produces: `stackIsActive(): boolean`, `toggleHermes(): Promise<void>`, one compact Start/Stop button, and `.open-stack` containing the two opening buttons.

- [ ] **Step 1: Write failing UI contract assertions**

Update the existing Hermes Spotlight test with:

```js
assert.match(source, /Open Hermes Tailscale/);
assert.doesNotMatch(source, /Open Tail IP/);
assert.match(source, /function stackIsActive\(\)/);
assert.match(source, /hermes\.dashboard\?\.active \|\| hermes\.proxy\?\.active/);
assert.match(source, /function toggleHermes\(\)/);
assert.match(source, /runAction\(stackIsActive\(\) \? 'stop' : 'start'\)/);
assert.match(source, /class="open-stack"/);
assert.match(source, /\.open-stack\s*\{[^}]*flex-direction:\s*column/s);
assert.match(source, /\.action-button\.open\.local\s*\{[^}]*linear-gradient[^}]*#76b900/s);
assert.match(source, /\.action-button\.open\.tail\s*\{[^}]*linear-gradient[^}]*#356dff/s);
assert.match(source, /\.portrait-shell\s*\{[^}]*width:\s*78px;[^}]*height:\s*88px;/s);
assert.doesNotMatch(source, /\.portrait-shell\s*\{\s*width:\s*68px;\s*height:\s*78px;/);
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm test`

Expected: the contract test fails because the old Tail IP label, separate Start/Stop controls, two-column opening layout, and shared opening-button color are still present.

- [ ] **Step 3: Implement stack state and one toggle**

Add:

```js
function stackIsActive() {
  return Boolean(hermes.dashboard?.active || hermes.proxy?.active);
}

function toggleHermes() {
  return runAction(stackIsActive() ? 'stop' : 'start');
}
```

Render one `.service-toggle` button. During an action show `Starting…` or `Stopping…`; otherwise render `Stop` when `stackIsActive()` is true and `Start` when false. Disable it only while an action is in progress. Keep the existing `runAction('stop')` confirmation path unchanged.

- [ ] **Step 4: Stack and restyle opening controls**

Use this structure:

```svelte
<div class="actions-shell">
  <button class="action-button service-toggle ...">...</button>
  <div class="open-stack">
    <button class="action-button open local">...<span>Open Hermes Local</span></button>
    <button class="action-button open tail">...<span>Open Hermes Tailscale</span></button>
  </div>
</div>
```

Use a compact `84px minmax(0, 1fr)` grid for `.actions-shell`, column flex layout for `.open-stack`, green `linear-gradient(135deg, #76b900, #a8e635)` for Local, and blue `linear-gradient(135deg, #00c6ff, #356dff)` for Tailscale. Remove the tablet rule that shrinks the portrait below `78px × 88px`.

- [ ] **Step 5: Run automated verification**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: 10 tests pass, Vite build exits 0, and diff check produces no output. Pre-existing `note-display` accessibility warnings are outside this change.

- [ ] **Step 6: Reload and verify live output**

Reload only the Dashboard process through the service's existing `Restart=always` behavior. Confirm the live Vite modules contain `Open Hermes Local`, `Open Hermes Tailscale`, one toggle function, `.open-stack`, and the two color variants. Confirm Dashboard, Hermes user services, Local/Tailscale HTTP, and vLLM remain active/HTTP 200.

- [ ] **Step 7: Preserve repository ownership**

Review the exact source locations and keep implementation changes in the current working tree without staging the pre-existing user modifications in `SystemMetrics.svelte`.

