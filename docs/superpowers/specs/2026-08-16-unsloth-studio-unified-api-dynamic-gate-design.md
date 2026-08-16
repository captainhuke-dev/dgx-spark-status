# Unsloth Studio Unified API Dynamic Gate Design

## Goal

Restore the dynamic Unsloth Studio card in Dashboard 9000 after the Studio
runtime changed from a descendant `llama-server` listener to the authenticated,
unified OpenAI-compatible API on port `9900`.

The card must show the exact currently loaded model ID. Its running badge and
client connection details must continue to use public client port `56827`, while
backend diagnostics must report Studio backend port `9900`.

## Confirmed current state

- Dashboard source and Git root: `/home/mctdgx01/dgx-spark-status`
- Dashboard endpoint: `0.0.0.0:9000`
- Studio endpoint: `0.0.0.0:9900`
- Request guard: `127.0.0.1:56828`
- LAN and Tailscale client port: `56827`
- Authenticated Studio `/v1/models` reports one loaded model:
  `unsloth/Qwen3.8-27B-NVFP4`
- The same response also contains cached, unloaded models, so selecting the
  first `data` entry is not a valid live-model rule.
- The current resolver recognizes only a descendant `llama-server` process and
  its ephemeral listener. Studio 2026.8.18 has no such listener, so resolution
  fails closed, the guard returns `backend_unavailable`, and Dashboard receives
  no Studio inventory item to render.

The existing UI already renders a supplied `apiModel` and client port. The bug
is in runtime discovery and metadata transport, not in text visibility or card
layout.

## Chosen approach

Extend the resolver and guard with an authenticated unified-Studio fallback.
Keep legacy descendant `llama-server` discovery as the preferred path when it
exists. Dashboard learns safe runtime metadata from the guard; it does not hold
the Studio credential and does not query the authenticated Studio API directly.

Rejected alternatives:

1. Giving Dashboard its own Studio credential duplicates authentication logic
   and puts a secret in a broader process than necessary.
2. Inferring the model ID from process arguments, download directories, or the
   first `/v1/models` entry can select a cached but unloaded model and violates
   the exact-live-ID requirement.

## Architecture and responsibilities

### Resolver

The resolver keeps two explicit discovery modes:

1. **Legacy child backend:** retain the existing exact process ancestry,
   executable, listener, and model-ID checks. If one eligible child backend is
   present, it remains authoritative.
2. **Unified Studio fallback:** only when no eligible child exists, verify the
   expected Studio process owner and listener, then query
   `http://127.0.0.1:9900/v1/models` with the dedicated service credential.

For unified discovery, filter response entries to those whose `loaded` value is
exactly `true`. Resolution succeeds only when there is exactly one such entry
with a non-empty string `id`. Zero or multiple loaded entries fail closed.
Cached entries with `loaded=false` never become the active ID.

The resolver returns an internal structured result containing discovery mode,
exact model ID, backend host, and backend port. Callers must not reconstruct
these values from display labels.

### Credential handling

Create one dedicated Unsloth Studio API key using Studio's official same-user
identity flow. Store it outside Git at
`/home/mctdgx01/.config/unsloth/dgx-guard-api-key`, owned by the
`mctdgx01` account that runs the guard and set to mode `0600`. The guard service
receives only this credential-file path.

The key must never appear in source, tests, process arguments, logs, Dashboard
responses, operation records, or Git. Missing, unreadable, or rejected
credentials make unified resolution unavailable and preserve fail-closed
behavior.

Before live setup, preserve a recoverable backup of the affected Studio auth
state. Key creation must not restart Studio or change model state.

### Request guard

The guard uses the resolver result for its upstream. In unified mode it removes
any client-supplied `Authorization` header and injects the dedicated Studio
service bearer token for the upstream request. Other existing request limits
and streaming behavior remain unchanged.

Successful guarded model metadata responses include a safe internal response
header, `X-DGX-Backend-Port: 9900`. The header contains no credential or private
identity material. Guard errors remain bounded and do not echo upstream auth
details.

### Dashboard inventory

Dashboard probes the existing local guard rather than Studio directly. From a
successful guarded `/v1/models` response it requires exactly one active model
ID and reads the validated backend port header. It then creates or merges one
Studio-owned runtime inventory item with:

- `apiModel`: exact active ID from the guarded API
- `clientPort`: `56827`
- `backendPort`: `9900`
- lifecycle ownership: Studio, inventory-only from Dashboard
- running/ready state: based on a successful current guard probe

The card's running badge and client endpoint display `56827`. Backend/process
details display `9900`. Dashboard must not fabricate the API ID, expose the
service key, or gain Start/Stop ownership of Studio.

## Data flow

```text
Dashboard :9000
    |
    | local inventory probe: GET /v1/models
    v
request guard 127.0.0.1:56828
    | inject dedicated Studio credential
    | return exact loaded ID + safe backend-port metadata
    v
Unsloth Studio OpenAI API 127.0.0.1:9900
    |
    +-- loaded=true  -> unsloth/Qwen3.8-27B-NVFP4
    +-- loaded=false -> ignored cached models

Clients -> LAN/Tailscale :56827 -> request guard :56828 -> Studio :9900
```

## Error handling and invariants

- Prefer a valid legacy child backend over unified fallback; never merge both
  into duplicate Studio cards.
- Accept unified mode only for the verified Studio owner and expected listener.
- Require exactly one `loaded=true` model with a valid ID.
- Fail closed on malformed JSON, timeout, authentication failure, missing key,
  zero loaded models, or multiple loaded models.
- Do not fall back to cached metadata, directory names, stale model cards, or a
  hardcoded current ID.
- Preserve public port `56827`, guard port `56828`, and backend port `9900` as
  distinct fields.
- Do not restart or stop Studio, reload the model, alter proxy/Tailscale
  topology, expose the raw backend, or modify unrelated Dashboard profiles.

## Testing strategy

Implement the fix test-first.

### Resolver tests

- A verified unified Studio listener plus an authenticated response containing
  one loaded and multiple unloaded models resolves the loaded ID and port
  `9900`.
- Zero loaded models and multiple loaded models fail closed.
- Missing, invalid, or rejected credentials fail closed without disclosing the
  credential.
- An eligible legacy child backend remains preferred over unified fallback.

### Guard tests

- Unified forwarding replaces client authorization with the service bearer
  token.
- The response exposes `X-DGX-Backend-Port` but never exposes the key.
- Existing request limits, streaming, and bounded backend failures continue to
  pass.

### Dashboard tests

- A successful guarded response creates one Studio inventory card with exact
  `apiModel`, `clientPort=56827`, and `backendPort=9900`.
- Display helpers keep the running badge on `56827` and backend details on
  `9900`.
- Failed or ambiguous discovery does not produce a stale or fabricated card.

Run the focused Python and Node test suites, the existing complete relevant
suites, and the production build before deployment.

## Deployment and acceptance

After automated verification:

1. Capture pre-change service, listener, process, and Dashboard metrics evidence.
2. Back up affected guard/helper/service files and Studio auth state.
3. Mint and install the dedicated key without printing it.
4. Install the tested helper and service configuration.
5. Restart only the request guard and Dashboard processes required to load the
   change. Do not restart Studio, the LAN proxy, or Tailscale.
6. Verify process ownership and listener topology are unchanged except for the
   intended guard/Dashboard PIDs.

Acceptance requires all of the following:

- Guard `/v1/models` succeeds and reports
  `unsloth/Qwen3.8-27B-NVFP4`.
- Dashboard `/api/metrics` contains exactly one Studio runtime item with that
  `apiModel`, client port `56827`, and backend port `9900`.
- The visible card shows the exact model ID, a `56827` running badge, and `9900`
  in backend details.
- LAN and Tailscale client endpoints on `56827` remain functional through the
  guard.
- No response or log contains the dedicated credential.
- Studio PID/model state, proxy topology, Tailscale configuration, and unrelated
  models remain unchanged.

## Scope exclusions

- No Studio upgrade, reinstall, model reload, model replacement, or runtime
  tuning.
- No Dashboard Start/Stop control for Studio.
- No LAN/Tailscale port or topology redesign.
- No new route, proxy, or firewall exposure for Studio port `9900`; leave its
  existing bind and authentication unchanged.
- No unrelated refactor of Dashboard inventory or model cards.
