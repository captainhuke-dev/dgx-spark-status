# Dashboard Section Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display the active DS4 preset in the Dashboard's left model column while preserving its truthful DS4/DwarfStar runtime identity.

**Architecture:** Add a small pure classifier that separates inventory section placement from runtime identity. The existing runtime scanner consumes that result, while explicit preset files describe the live guarded endpoint and disable unsafe process controls.

**Tech Stack:** Node.js ESM, Node test runner, Express/Vite/Svelte Dashboard, env-file model inventory.

## Global Constraints

- `DASHBOARD_SECTION=llama` controls placement only.
- The preset must retain `RUNTIME=ds4` and `ENGINE=ds4-server`.
- The live backend remains `127.0.0.1:18081`.
- The guarded endpoint remains `127.0.0.1:18082`.
- The client base URL is `http://100.108.68.20:18082/v1`.
- `CONTROL_ENABLED=false` while the runtime is not owned by model-control tmux.
- No runtime restart or model reload is permitted.

---

### Task 1: Inventory section classifier

**Files:**
- Create: `model-inventory-section.js`
- Create: `test/model-inventory-section.test.js`

**Interfaces:**
- Consumes: parsed env object, existing classified runtime, legacy-DS4-candidate boolean.
- Produces: `classifyInventoryConfig(env, classifiedRuntime, legacyDs4Candidate)` returning `{ include, section, runtime }`.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInventoryConfig } from '../model-inventory-section.js';

test('places explicit DS4 override in llama section without changing runtime identity', () => {
  assert.deepEqual(
    classifyInventoryConfig(
      { DASHBOARD_SECTION: 'llama', RUNTIME: 'ds4' },
      'vllm',
      true
    ),
    { include: true, section: 'llama', runtime: 'ds4' }
  );
});

test('preserves default classification without an override', () => {
  assert.deepEqual(
    classifyInventoryConfig({}, 'vllm', false),
    { include: true, section: 'vllm', runtime: 'vllm' }
  );
});

test('keeps legacy DS4 excluded without a valid override', () => {
  assert.deepEqual(
    classifyInventoryConfig({ RUNTIME: 'ds4' }, 'vllm', true),
    { include: false, section: 'vllm', runtime: 'vllm' }
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/model-inventory-section.test.js`

Expected: FAIL because `model-inventory-section.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```js
const VALID_SECTIONS = new Set(['llama', 'vllm']);

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

export function classifyInventoryConfig(env = {}, classifiedRuntime, legacyDs4Candidate = false) {
  const requestedSection = normalized(env.DASHBOARD_SECTION);
  const hasOverride = VALID_SECTIONS.has(requestedSection);
  const defaultSection = classifiedRuntime === 'llama' ? 'llama' : 'vllm';
  if (legacyDs4Candidate && !hasOverride) {
    return { include: false, section: defaultSection, runtime: classifiedRuntime };
  }
  return {
    include: true,
    section: hasOverride ? requestedSection : defaultSection,
    runtime: hasOverride && normalized(env.RUNTIME) ? normalized(env.RUNTIME) : classifiedRuntime
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/model-inventory-section.test.js`

Expected: all three tests PASS.

### Task 2: Runtime scanner integration

**Files:**
- Modify: `dev-server.js`
- Test: `test/model-inventory-section.test.js`

**Interfaces:**
- Consumes: `classifyInventoryConfig` from Task 1.
- Produces: DS4 inventory model in `availableModels.llama` with `runtime: "ds4"` and DS4-derived labels.

- [ ] **Step 1: Add an integration-oriented classifier assertion**

Add a test asserting an invalid `DASHBOARD_SECTION` cannot bypass legacy DS4 exclusion:

```js
test('invalid section override cannot bypass legacy DS4 exclusion', () => {
  assert.deepEqual(
    classifyInventoryConfig(
      { DASHBOARD_SECTION: 'other', RUNTIME: 'ds4' },
      'vllm',
      true
    ),
    { include: false, section: 'vllm', runtime: 'vllm' }
  );
});
```

- [ ] **Step 2: Run the focused test**

Run: `node --test test/model-inventory-section.test.js`

Expected: PASS because Task 1 already treats an invalid section as no override.

- [ ] **Step 3: Integrate the classifier**

Import `classifyInventoryConfig`. In the env scanner, compute the existing
classified runtime, call the helper with `isDs4RuntimeCandidate(env)`, skip
when `include` is false, select the target from `section`, retain the
classified runtime for label builders, and store the helper's `runtime` on
the inventory item.

- [ ] **Step 4: Run all automated checks**

Run: `npm test && npm run build`

Expected: all tests PASS and the production build succeeds.

### Task 3: Install and verify the DS4 preset

**Files:**
- Create: `/etc/vllm/models/deepseek-v4-flash-in240k-out32k.env`
- Create: `/etc/dgx-model-control/models.d/deepseek-v4-flash-in240k-out32k.env`

**Interfaces:**
- Consumes: the Dashboard scanner behavior from Task 2.
- Produces: a status-only DS4 preset on guard port 18082.

- [ ] **Step 1: Install the truthful runtime inventory**

Set `DASHBOARD_SECTION=llama`, `RUNTIME=ds4`, `ENGINE=ds4-server`,
`PORT=18082`, `HOST=127.0.0.1`, context 278528, input 245760, output
32768, and the direct Tailscale endpoint.

- [ ] **Step 2: Install the status-only control profile**

Use `HEALTH_URL=http://127.0.0.1:18082/v1/models`,
`MIN_AVAILABLE_RAM_GB=5`, and `CONTROL_ENABLED=false`.

- [ ] **Step 3: Restart only the Dashboard service if required**

Discover the exact owning service/process first. Do not restart or signal the
DS4 backend, request guard, or memory guard.

- [ ] **Step 4: Verify live behavior**

Confirm the model-control API reports `running`, metrics place port 18082 in
`availableModels.llama`, the inventory item reports runtime `ds4`, and its
labels report `ds4-server`.

- [ ] **Step 5: Verify operational boundaries**

Confirm listeners 18081 and 18082 remain on loopback; Tailscale Serve contains
only the new 18082 mapping plus pre-existing mappings; direct backend access
on `100.108.68.20:18081` fails; Funnel is disabled; the 32769 rejection and a
bounded request both pass through `100.108.68.20:18082`.

### Task 4: Publish the Dashboard patch

**Files:**
- Modify: `docs/superpowers/plans/2026-07-27-dashboard-section-override.md`
- Modify: canonical DS4 operation documentation in `/home/mctdgx01/projects/DGXmodelmd/DeepSeek-V4-Flash-Entrpi-DS4-DGX-Spark`

**Interfaces:**
- Consumes: verified test and runtime evidence.
- Produces: committed Dashboard code and canonical operational handoff.

- [ ] **Step 1: Run verification-before-completion checks**

Run focused tests, complete test suite, build, live API probes, listener
checks, Serve checks, memory-floor check, and kernel-event delta check.

- [ ] **Step 2: Record sanitized evidence**

Document the truthful Dashboard placement, exact client endpoint, guard
behavior, loopback bindings, Funnel-disabled state, and status-only control
limitation.

- [ ] **Step 3: Commit exact Dashboard paths**

Commit only the helper, test, scanner, and plan changes. Preserve unrelated
history and user changes.

- [ ] **Step 4: Commit and push canonical operation records**

Run canonical validation, fetch/reconcile, scan the exact staged paths, commit,
push, and verify the remote SHA.
