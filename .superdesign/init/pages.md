# Page Dependency Trees

## `/` — DGX Spark Status

Entry: `src/routes/+page.svelte`

Dependencies:

- `src/routes/+layout.svelte`
  - `src/app.css`
- `src/routes/+page.svelte`
  - `src/lib/SystemMetrics.svelte`
    - `src/lib/Gauge.svelte`
    - `src/lib/websocket.js`

Render branch notes:

- `SystemMetrics.svelte` renders a `.dashboard` shell beginning near line 531.
- The dashboard has a live header, resource cards, inference/model cards, the ETC model card, DGX Health, Graphify, and network sections.
- The target insertion point is the ETC `.models-list` at approximately lines 834–904.
- Because `SystemMetrics.svelte` exceeds 1,000 lines, design calls must pass only the relevant ETC template block, the card CSS block, global responsive rules, and the separate new Hermes component.

