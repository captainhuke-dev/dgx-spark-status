# Dashboard Section Override for DS4

## Goal

Show the active DeepSeek V4 Flash DS4 preset in the Dashboard's left model
column without claiming that DS4 is a llama.cpp runtime.

## Current constraint

The Dashboard currently uses one runtime classification for both technical
identity and visual placement. It also excludes model configurations whose
metadata identifies them as DS4 because a legacy DS4 integration is hard-coded
for port 8889.

The active runtime is a separate deployment:

- runtime: DS4 / DwarfStar
- backend: `127.0.0.1:18081`
- guarded client endpoint: `127.0.0.1:18082`
- server context: 278528 tokens
- rendered-input limit: 245760 tokens
- output limit: 32768 tokens

## Design

Add an optional `DASHBOARD_SECTION` inventory field. The field controls only
which existing Dashboard column contains a model card. It must not change the
runtime or engine labels.

For the DS4 preset:

```text
DASHBOARD_SECTION=llama
RUNTIME=ds4
ENGINE=ds4-server
```

The existing `classifyEnvRuntime` behavior remains the source of the truthful
runtime identity. A separate section-classification helper selects the
inventory array. Without `DASHBOARD_SECTION`, all existing profiles retain
their current placement.

An explicit section override also permits the new DS4 preset through the
legacy DS4 exclusion. The hard-coded port-8889 integration remains excluded;
the override applies only to the explicitly configured profile.

## Preset and control behavior

Create matching runtime-inventory and model-control profile files for the
active guard port 18082. The preset reports DS4/DwarfStar metadata and a 5 GiB
minimum RAM threshold.

`CONTROL_ENABLED=false` is required for the current live process. The active
runtime was not launched under the model-control tmux session, so exposing
Start/Stop controls would imply ownership that model-control does not have.
Status and health remain visible through `http://127.0.0.1:18082/v1/models`.

## Tailscale boundary

Tailscale publishes only a raw TCP handler on node port 18082 forwarding to
`127.0.0.1:18082`. The required client base URL is
`http://100.108.68.20:18082/v1`; direct IP-and-port access is a release gate,
not an optional alias. The backend on 18081 remains loopback-only. Existing
Serve handlers remain unchanged and Funnel remains disabled.

Tailscale mutation requires root/operator authority and is independent of the
Dashboard code change.

## Tests

Automated tests must prove:

1. `DASHBOARD_SECTION=llama` places a DS4 profile in the left inventory column.
2. Runtime and engine metadata remain `ds4` and `ds4-server`.
3. A profile without the override retains existing classification.
4. The legacy hard-coded DS4 profile remains excluded.

Live verification must prove:

1. The Dashboard model-control API reports the preset as running.
2. The metrics payload contains the model in the left inventory collection.
3. The card metadata identifies DS4/DwarfStar, not llama.cpp.
4. Both application listeners remain on `127.0.0.1`.
5. `http://100.108.68.20:18082/v1/models` returns the DS4 model inventory.
6. `http://100.108.68.20:18082/v1` rejects `max_tokens=32769` and accepts a
   bounded request after the Serve route is successfully installed.

## Failure handling

If Dashboard verification fails, remove only the two new preset files and
leave the active runtime untouched. If Tailscale verification fails after
route creation, remove only TCP handler 18082 and preserve all pre-existing
Serve handlers.
