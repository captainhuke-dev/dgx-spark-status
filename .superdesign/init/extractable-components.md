# Extractable Components

## Gauge

- Source: `src/lib/Gauge.svelte`
- Category: basic
- Description: Circular live utilization gauge used across system cards.
- Extractable props: value, max, size, thickness, color, label, yellowThreshold, redThreshold
- Hardcoded: SVG structure, threshold line colors, gauge typography, transitions

No shared layout component is extractable: the current application shell is embedded in the single `SystemMetrics.svelte` dashboard page. The Hermes Spotlight is a page feature, not a cross-page layout component.

