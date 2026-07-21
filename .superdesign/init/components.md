# Shared UI Components

The Dashboard uses custom Svelte components and local component styles rather than a third-party component library.

## Gauge

- Path: `src/lib/Gauge.svelte`
- Description: Circular utilization gauge with warning and critical threshold markers.
- Props: `value`, `max`, `size`, `thickness`, `color`, `label`, `yellowThreshold`, `redThreshold`

```svelte
<script>
  export let value = 0;
  export let max = 100;
  export let size = 120;
  export let thickness = 10;
  export let color = '#76b900';
  export let label = '';
  export let yellowThreshold = 70;
  export let redThreshold = 90;

  $: percentage = Math.min((value / max) * 100, 100);
  $: radius = (size - thickness) / 2;
  $: circumference = 2 * Math.PI * radius;
  $: offset = circumference - (percentage / 100) * circumference;
  $: center = size / 2;
  $: yellowAngle = -90 + (yellowThreshold / 100) * 360;
  $: redAngle = -90 + (redThreshold / 100) * 360;

  function getLineCoords(angle, innerRadius, outerRadius) {
    const rad = (angle * Math.PI) / 180;
    return {
      x1: center + innerRadius * Math.cos(rad),
      y1: center + innerRadius * Math.sin(rad),
      x2: center + outerRadius * Math.cos(rad),
      y2: center + outerRadius * Math.sin(rad)
    };
  }

  $: yellowLine = getLineCoords(yellowAngle, radius - thickness / 2, radius + thickness / 2);
  $: redLine = getLineCoords(redAngle, radius - thickness / 2, radius + thickness / 2);
</script>

<div class="gauge" style="width: {size}px; height: {size}px;">
  <svg width={size} height={size}>
    <circle cx={center} cy={center} r={radius} fill="none" stroke="#2a2a2a" stroke-width={thickness} />
    <circle
      cx={center}
      cy={center}
      r={radius}
      fill="none"
      stroke={color}
      stroke-width={thickness}
      stroke-dasharray={circumference}
      stroke-dashoffset={offset}
      stroke-linecap="round"
      transform="rotate(-90 {center} {center})"
      class="progress-circle"
    />
    <line
      x1={yellowLine.x1}
      y1={yellowLine.y1}
      x2={yellowLine.x2}
      y2={yellowLine.y2}
      stroke="#ffa726"
      stroke-width="2"
      stroke-linecap="round"
    />
    <line
      x1={redLine.x1}
      y1={redLine.y1}
      x2={redLine.x2}
      y2={redLine.y2}
      stroke="#ff6b6b"
      stroke-width="2"
      stroke-linecap="round"
    />
  </svg>
  <div class="gauge-content">
    <div class="gauge-value">{value}{label}</div>
  </div>
</div>

<style>
  .gauge {
    position: relative;
    display: inline-block;
  }

  .progress-circle {
    transition: stroke-dashoffset 0.3s ease;
  }

  .gauge-content {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
  }

  .gauge-value {
    font-size: 1.3rem;
    font-weight: 700;
    color: #fff;
    line-height: 1;
  }
</style>
```

