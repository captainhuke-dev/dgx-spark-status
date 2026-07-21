# Route Map

## `/`

- Route file: `src/routes/+page.svelte`
- Layout: `src/routes/+layout.svelte`
- Renders: the full live DGX Spark system dashboard through `SystemMetrics`.

```svelte
<script>
  import SystemMetrics from '$lib/SystemMetrics.svelte';
</script>

<svelte:head>
  <title>DGX Spark Status</title>
</svelte:head>

<SystemMetrics />
```

## `/api/metrics`

- Route file: `src/routes/api/metrics/+server.js`
- Runtime note: the active development service exposes its metrics and control APIs through `dev-server.js` before Vite middleware.

## `/api/ollama`

- Route file: `src/routes/api/ollama/+server.js`

