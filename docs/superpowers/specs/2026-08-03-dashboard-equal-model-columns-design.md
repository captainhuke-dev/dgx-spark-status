# Dashboard Equal Model Columns Design

## Goal

Preserve the current Dashboard state as a Git recovery point, then make the
desktop LLAMA.cpp, vLLM, and ETC model cards equal width while keeping the
Hermes portrait dimensions unchanged.

## Current context

- Dashboard source: `/home/mctdgx01/dgx-spark-status`
- Model-card row: `src/lib/SystemMetrics.svelte`, `.models-row`
- Current desktop columns: `26fr / 34fr / 40fr`
- Hermes component: `src/lib/HermesSpotlight.svelte`
- Hermes portrait: `.portrait-shell` `104px × 116px`
- Existing responsive behavior: two columns below `1200px`, one column below
  `768px`

## Design

1. Commit all current tracked Dashboard changes as a pre-layout snapshot and
   tag it `dashboard-layout-before-equal-columns-20260803`.
2. Change only the desktop `.models-row` declaration to:

   ```css
   grid-template-columns: repeat(3, minmax(0, 1fr));
   ```

3. Leave `HermesSpotlight.svelte`, the Hermes image URL, `.portrait-shell`,
   responsive breakpoints, card height, and model-card behavior unchanged.
4. Add a regression test that checks the equal desktop grid and the preserved
   `104px × 116px` Hermes portrait dimensions.

## Rationale

`repeat(3, minmax(0, 1fr))` gives each card the same available width and keeps
long model content from forcing the grid wider. The fixed Hermes portrait
remains the same size; only the outer ETC card receives the same column width
as the other two cards.

## Acceptance criteria

- A Git commit and tag identify the exact pre-layout state for restoration.
- Desktop model columns are equal width.
- LLAMA.cpp, vLLM, and ETC remain present in the same order.
- Hermes portrait remains `104px × 116px` on desktop and its existing responsive
  sizes remain unchanged.
- Existing tests pass and the production build succeeds.
- No model runtime, model-control profile, network listener, or Hermes service
  state is changed by this UI-only task.
