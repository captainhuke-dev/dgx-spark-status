# Dashboard Equal Model Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the current Dashboard state in Git, then make the desktop LLAMA.cpp, vLLM, and ETC cards equal width without changing Hermes image dimensions.

**Architecture:** Keep the existing Svelte layout and responsive breakpoints. Change one desktop CSS grid declaration in `SystemMetrics.svelte`; protect the behavior with a source-level regression test that also asserts the Hermes portrait remains `104px × 116px`.

**Tech Stack:** Svelte 5, Vite, Node test runner, Git.

## Global Constraints

- Preserve the pre-layout Dashboard state at commit `40304e9` and tag `dashboard-layout-before-equal-columns-20260803`.
- Modify only the Dashboard UI layout and its regression test after the snapshot.
- Do not edit `src/lib/HermesSpotlight.svelte` or reduce `.portrait-shell` from `104px × 116px`.
- Keep the existing `@media (max-width: 1200px)` two-column and `@media (max-width: 768px)` one-column behavior.
- Do not change model processes, model-control profiles, network listeners, or Hermes service state.

---

### Task 1: Record the approved design and plan

**Files:**
- Create: `docs/superpowers/specs/2026-08-03-dashboard-equal-model-columns-design.md`
- Create: `docs/superpowers/plans/2026-08-03-dashboard-equal-model-columns.md`

**Interfaces:**
- Produces the design constraints and exact implementation/test steps used by later tasks.

- [x] **Step 1: Record the design and plan**

  The design fixes the scope to the desktop `.models-row` grid and explicitly
  preserves the Hermes portrait and responsive breakpoints.

- [x] **Step 2: Commit the planning documents**

  ```bash
  git add docs/superpowers/specs/2026-08-03-dashboard-equal-model-columns-design.md \
    docs/superpowers/plans/2026-08-03-dashboard-equal-model-columns.md
  git commit -m "docs: plan equal Dashboard model columns"
  ```

### Task 2: Add the layout regression test first

**Files:**
- Create: `test/model-layout.test.js`
- Read: `src/lib/SystemMetrics.svelte`
- Read: `src/lib/HermesSpotlight.svelte`

**Interfaces:**
- Test reads the two Svelte sources and asserts the required CSS contract.

- [ ] **Step 1: Write the failing test**

  Add this test file:

  ```js
  import assert from 'node:assert/strict';
  import { readFileSync } from 'node:fs';
  import test from 'node:test';

  const dashboardUi = readFileSync(new URL('../src/lib/SystemMetrics.svelte', import.meta.url), 'utf8');
  const hermesUi = readFileSync(new URL('../src/lib/HermesSpotlight.svelte', import.meta.url), 'utf8');

  test('uses equal desktop columns for LLAMA.cpp, vLLM, and ETC', () => {
    assert.match(
      dashboardUi,
      /\.models-row\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/
    );
  });

  test('preserves the Hermes desktop portrait dimensions', () => {
    assert.match(hermesUi, /\.portrait-shell\s*\{[\s\S]*?width:\s*104px;[\s\S]*?height:\s*116px;/);
  });
  ```

- [ ] **Step 2: Run the focused test and confirm RED**

  Run:

  ```bash
  node --test test/model-layout.test.js
  ```

  Expected result: the equal-column test fails because the current desktop
  declaration is `26fr / 34fr / 40fr`; the Hermes dimension test passes.

### Task 3: Implement equal desktop columns

**Files:**
- Modify: `src/lib/SystemMetrics.svelte:1430-1434`
- Do not modify: `src/lib/HermesSpotlight.svelte`

**Interfaces:**
- Consumes the existing `.models-row` grid and responsive overrides.
- Produces equal desktop columns with the same three child cards and unchanged Hermes component dimensions.

- [ ] **Step 1: Replace only the desktop grid declaration**

  Change:

  ```css
  grid-template-columns: minmax(0, 26fr) minmax(0, 34fr) minmax(0, 40fr);
  ```

  to:

  ```css
  grid-template-columns: repeat(3, minmax(0, 1fr));
  ```

  Leave the two responsive `.models-row` declarations unchanged.

- [ ] **Step 2: Run the focused test and confirm GREEN**

  Run:

  ```bash
  node --test test/model-layout.test.js
  ```

  Expected result: both tests pass.

### Task 4: Verify, review, and record the final change

**Files:**
- Review: `src/lib/SystemMetrics.svelte`
- Review: `src/lib/HermesSpotlight.svelte`
- Review: `test/model-layout.test.js`

**Interfaces:**
- Produces a verified UI commit after the pre-layout snapshot/tag.

- [ ] **Step 1: Run the complete test suite**

  ```bash
  npm test
  ```

  Expected result: zero failures.

- [ ] **Step 2: Build the Dashboard**

  ```bash
  npm run build
  ```

  Expected result: Vite exits with status 0. Existing unrelated Svelte note-click
  accessibility warnings may remain; no new warning from this change is expected.

- [ ] **Step 3: Verify the diff is scoped**

  ```bash
  git diff --check
  git diff -- src/lib/SystemMetrics.svelte src/lib/HermesSpotlight.svelte test/model-layout.test.js
  ```

  Confirm that only the grid declaration and its test changed after the
  snapshot, while `HermesSpotlight.svelte` has no diff.

- [ ] **Step 4: Commit the layout change**

  ```bash
  git add src/lib/SystemMetrics.svelte test/model-layout.test.js
  git commit -m "fix: equalize Dashboard model card columns"
  ```

- [ ] **Step 5: Verify restoration metadata remains available**

  ```bash
  git show --stat --oneline dashboard-layout-before-equal-columns-20260803
  git tag --points-at 40304e9
  ```

  Expected result: the tag resolves to the pre-layout snapshot and can be used
  with a deliberate future restore operation.
