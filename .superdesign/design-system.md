# DGX Spark Dashboard Design System

## Product

An internal, dark-mode operations dashboard for a DGX Spark workstation. It prioritizes fast system-state scanning, compact technical detail, and safe controls for local AI services.

## Foundation

- Font: native system sans-serif stack from `src/app.css`.
- Canvas: near-black `#0a0a0a`.
- Standard panels: dark graphite with subtle gray borders; preserve the card geometry already defined by `SystemMetrics.svelte`.
- Primary operational accent: NVIDIA green `#76b900`; brighter hover `#9edb00`.
- Information accent: cyan/blue already used by live metrics.
- Warning: amber/gold.
- Destructive/error: red.
- Text: high-emphasis white, secondary cool gray, muted gray.
- Radius: 8px for controls; cards follow the existing Dashboard radius.
- Motion: short 150–300ms state transitions only; respect reduced motion.

## Hermes Spotlight

- Must use the approved black-and-white Hermes girl portrait without recoloring or visual filters.
- The card remains visually compatible with the existing ETC list, but can feel more branded through a restrained midnight-navy/cyan surface and a thin warm-gold highlight.
- Layout: portrait at left, identity and live status in the center, controls aligned to the right on wide screens; stack controls below on narrow screens.
- Include one clear status pill and four compact indicators: Hermes, proxy, HTTP health, and tailnet access.
- Controls: one compact Start/Stop toggle beside a vertical stack of opening actions. Local uses a green operational gradient; Tailscale uses a separate cyan-to-blue network gradient. Disable opening actions while Hermes is not ready and disable all controls during a transition.
- Use desktop model tracks of `26% / 34% / 40%` for llama.cpp, vLLM, and ETC.
- Show the approved portrait at `104px × 116px` on desktop; retain compact responsive sizing on narrow screens.
- Focus rings must be visible. Status and operation messages use an `aria-live` region.
- Avoid neon effects, decorative gradients unrelated to the Dashboard, serif/display fonts, oversized marketing typography, and changes to the surrounding Dashboard.

## Responsive Behavior

- Preserve dense desktop scanning.
- At tablet width, allow the status grid and controls to wrap.
- At mobile width, place the portrait and identity first, then indicators, then full-width action buttons.

## Source of Truth

Use `src/app.css`, the relevant ETC/card/style sections of `src/lib/SystemMetrics.svelte`, and `src/lib/HermesSpotlight.svelte` as the implementation sources. Do not invent additional visual systems.
