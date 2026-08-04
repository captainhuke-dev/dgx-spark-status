# Unsloth Studio Model ID and Tailscale Exposure Design

## Goal

Make Dashboard 9000 show the exact live model ID for models discovered from
Unsloth Studio and expose the current Studio API privately through LAN and
Tailscale without changing the running Studio backend or unrelated models.

The durable rule is future-facing: when Studio replaces a model on the same
endpoint, the dashboard inventory and visible card must use the replacement's
live `/v1/models` ID without a hand-edited model card.

## Current context

- Dashboard source: `/home/mctdgx01/dgx-spark-status`
- Dashboard control plane: `http://127.0.0.1:9000`
- Active Studio backend: `127.0.0.1:56827`
- Current live model ID: `unsloth/DeepSeek-V4-Flash-0731-GGUF`
- Active LAN address: `192.168.0.21`
- Tailscale IPv4: `100.108.68.20`
- Tailscale IPv6: `fd7a:115c:a1e0::a237:4415`
- Studio lifecycle owner: Unsloth Studio, not Dashboard model-control
- Existing Tailscale Serve handlers: preserved; only the new handler is added

The current Dashboard process inventory already discovers the live llama-server
process, but the model card hides the ID when it equals the display name. A
stale llama config can also win the primary status selection, so readiness must
prefer the healthy live process/API.

## Design

### 1. Live identity and UI

Use the OpenAI-compatible response `data[0].id` as the authoritative identity
for a running Studio process. When merging a running llama process, a fresh
API ID wins over configured `API_MODEL_ID`, display name, path, and process
alias. Keep the current port and model path matching behavior so unrelated
llama processes remain separate.

Render a separate `Model ID` line on LLAMA, vLLM, and ETC model cards whenever a
real API/served alias exists, including the equal-name case. Do not use a
display label as a fabricated API ID. Add regression tests for the equal-name
case and live-ID precedence with a replacement model ID.

When selecting the primary llama status, prefer a healthy live llama process
and its `/v1/models` response over the first stale config file. This makes the
current Studio card report ready/running based on the actual API.

### 2. Guarded network exposure

Do not rebind or restart the active Studio process. Keep its backend at
`127.0.0.1:56827`.

Add a sidecar request guard on an unused loopback port, selected only after a
listener check (the planned candidate is `127.0.0.1:56828`). The guard
forwards OpenAI API requests to the Studio backend, rejects invalid or
explicit output budgets above `32768` tokens, and returns a bounded 503 when
the backend is unavailable. It does not expose an administrative Studio UI.

Preserve the user-facing port with two separate forwarders:

```text
Studio backend 127.0.0.1:56827
        ▲
        │
guard 127.0.0.1:56828
        ▲
        ├── LAN proxy 192.168.0.21:56827
        └── Tailscale Serve :56827 -> 127.0.0.1:56828
```

The LAN proxy binds only `192.168.0.21`; it never binds `0.0.0.0`. Tailscale
uses tailnet-only Serve/TCP and forwards only to the guard. Do not use Funnel,
`tailscale up`, ACL/DNS/route/exit-node changes, or a broad Serve reset.

The guard and LAN proxy are owned by an exact-PID/PGID sidecar start/stop
script outside Git. The sidecar leaves Studio's PID/PGID and lifecycle
untouched. Tailscale route rollback removes only port `56827` created by this
operation.

### 3. Persistent skill rule

Create the discoverable skill
`/home/mctdgx01/.codex/skills/unsloth-studio-dashboard-exposure/SKILL.md`.
It requires the live-ID and guarded-Tailscale invariants for every Unsloth
Studio-to-Dashboard request, rejects direct backend exposure and hardcoded
future IDs, and requires `/api/metrics` plus endpoint evidence before PASS.

The skill keeps Studio lifecycle ownership by default and allows an
inventory-only Dashboard mapping. It must not turn a currently running Studio
process into a Dashboard Start/Stop profile without explicit authorization.

### 4. Evidence and documentation

Store raw evidence in a timestamped directory under
`/home/mctdgx01/models/operation_records/`. Store only sanitized Markdown and
safe checksums under the canonical DGX model documentation checkout. Preserve
the pre-change Studio PID/PGID, listener set, GPU process, memory, kernel
events, Tailscale Serve JSON, and Dashboard metrics snapshot.

## Error handling

- If the guard/client port is occupied, stop before mutation and choose a new
  isolated pair.
- If Tailscale Serve cannot be changed by the authenticated operator, leave all
  routes unchanged and report the exact permission blocker; do not use Funnel or
  a direct backend bind as a workaround.
- If the live API ID differs from stale metadata, use the live ID and record
  the mismatch; never overwrite it with the stale value.
- If a guard, proxy, or health check fails, stop only the new sidecar PIDs and
  remove only the new Serve handler after preserving evidence.
- If a fresh GPU/kernel/OOM event appears, stop and diagnose; do not retry by
  weakening runtime or guard settings.

## Testing and acceptance criteria

### Automated

- Dashboard model-card tests prove an equal-name live model ID renders.
- Runtime inventory tests prove a replacement `/v1/models` ID overrides stale
  configured metadata.
- Readiness tests prove a healthy live llama process wins stale config order.
- Existing Dashboard test suite and production build pass.
- Skill `quick_validate.py` passes with a complete non-template body.

### Live

- Current Studio `/v1/models` returns exactly
  `unsloth/DeepSeek-V4-Flash-0731-GGUF`.
- Loopback guard, `192.168.0.21:56827`, `100.108.68.20:56827`, IPv6, and
  MagicDNS return the same ID from `/v1/models`.
- Bounded chat works through LAN and Tailscale; streaming remains intact where
  requested.
- Dashboard `/api/metrics` contains the same ID under
  `inference.availableModels.llama`, and the card has a visible `Model ID`.
- Direct remote access to `127.0.0.1:56827` is impossible because the backend
  remains loopback-only; the guard is the only client upstream.
- Studio PID/PGID, GPU process, unrelated listeners, profiles, and old
  Tailscale Serve handlers are unchanged.
- The final state keeps the current Studio model running.

## Scope exclusions

- Do not modify or expose the other Unsloth vLLM profiles.
- Do not add Dashboard Start/Stop ownership for Studio.
- Do not change Studio model weights, launcher flags, model context, firewall,
  Tailscale ACLs, DNS, routes, or exit-node settings.
