# Unsloth Studio Unified API Dynamic Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the dynamic Dashboard card by discovering the one loaded model from authenticated Unsloth Studio `:9900`, while keeping client port `56827`, guard port `56828`, and legacy child-backend support.

**Architecture:** The Python resolver continues to prefer an exact Studio-owned `llama-server` child and falls back to the verified Studio launcher/listener on `9900` only when no child exists. The guard owns the Studio service credential, replaces client authorization only for the unified upstream, and returns safe backend-port metadata. A focused Node module validates the guarded response and supplies one Studio runtime candidate to both Dashboard inventory and top-level llama status.

**Tech Stack:** Python 3 standard library and `unittest`, Node.js ESM and Node test runner, Express/Vite/Svelte 5, Bash, user systemd, Unsloth Studio 2026.8.18.

## Global Constraints

- The only canonical Studio root is `/home/mctdgx01/apps/unsloth-studio`; do not read runtime identity from or reintroduce `/home/mctdgx01/.unsloth/studio`.
- Obtain the active model ID from authenticated `/v1/models` and accept exactly one entry with `loaded is true`; never hardcode or infer it from cached entries, paths, aliases, or display names.
- Preserve legacy exact-child `llama-server` discovery as the preferred mode when it is valid.
- Dashboard badge/client connection port is `56827`, request guard is `127.0.0.1:56828`, and backend diagnostics port is `9900`.
- Keep Studio lifecycle ownership outside Dashboard. Do not stop, restart, reload, replace, or tune the model or Studio.
- Do not alter the LAN proxy, Tailscale Serve/Funnel, firewall, Studio bind, or expose a new raw route to `9900`.
- Store the service key only at `/home/mctdgx01/.config/unsloth/dgx-guard-api-key`, owned by `mctdgx01`, mode `0600`; never print, log, commit, or return it.
- Preserve user-owned untracked `.codex/` and `ops/unsloth-studio-exposure/__pycache__/`.
- Back up every live helper, unit, and auth state file before deployment. Restart only the guard and Dashboard after tests pass.

---

### Task 1: Add authenticated unified fallback to the Python resolver

**Files:**
- Modify: `ops/unsloth-studio-exposure/unsloth_backend_resolver.py:1-367`
- Test: `ops/unsloth-studio-exposure/test_unsloth_backend_resolver.py`

**Interfaces:**
- Consumes: exact `ProcessRecord` and `ListenerRecord` observations, `DGX_UNSLOTH_STUDIO_API_KEY_FILE`, and `RealInspector.probe_models(port, timeout_seconds, authorization=None)`.
- Produces: `ResolvedBackend(..., mode: str = 'legacy', authorization: str | None = None)` where the authorization field uses `repr=False`; `BackendResolver.resolve()` still returns exactly one backend or raises `BackendUnavailable`/`BackendAmbiguous`.

- [ ] **Step 1: Write failing unified-resolution tests**

Extend `FakeInspector.probe_models` to record the optional authorization argument. Add tests equivalent to:

```python
def test_unified_studio_selects_only_loaded_model(self):
    self.inspector.set_processes([studio_owner()])
    self.inspector.set_listeners([
        ListenerRecord(pid=10, host='0.0.0.0', port=9900),
    ])
    self.inspector.set_probe_response(9900, (200, {
        'data': [
            {'id': 'unsloth/Qwen3.8-27B-NVFP4', 'loaded': True},
            {'id': 'cached/gguf', 'loaded': False},
        ],
    }))
    resolver = BackendResolver(
        self.inspector,
        time_fn=self.clock.time,
        credential_reader=lambda: 'studio-service-key',
    )

    resolved = resolver.resolve()

    self.assertEqual(resolved.port, 9900)
    self.assertEqual(resolved.model_id, 'unsloth/Qwen3.8-27B-NVFP4')
    self.assertEqual(resolved.mode, 'unified')
    self.assertEqual(resolved.authorization, 'Bearer studio-service-key')
    self.assertEqual(
        self.inspector.probe_calls,
        [(9900, 2.0, 'Bearer studio-service-key')],
    )
```

Add separate tests proving zero loaded entries, two loaded entries, empty/missing credentials, 401, malformed payload, and a listener owned by a non-Studio process fail closed. Add a test proving one valid legacy child is returned without reading the credential or probing `9900`.

- [ ] **Step 2: Run the resolver tests and verify the new tests fail**

Run:

```bash
python3 -m unittest ops/unsloth-studio-exposure/test_unsloth_backend_resolver.py -v
```

Expected: FAIL because `credential_reader`, authenticated probing, `mode`, and loaded-entry filtering do not exist.

- [ ] **Step 3: Implement the minimal two-mode resolver**

Add fixed constants and a secret-safe result shape:

```python
from dataclasses import dataclass, field

UNSLOTH_STUDIO_PORT = 9900
API_KEY_FILE_ENV = 'DGX_UNSLOTH_STUDIO_API_KEY_FILE'

@dataclass(frozen=True, slots=True)
class ResolvedBackend:
    pid: int
    start_time: str
    executable: str
    port: int
    model_id: str
    resolved_at: float
    mode: str = 'legacy'
    authorization: str | None = field(default=None, repr=False)
```

Make `RealInspector.probe_models` add `Authorization` only when supplied. Split discovery into `_discover_legacy_candidates`; return its result unchanged when nonempty. Otherwise verify exactly one process satisfying `_is_studio_launcher_command`, verify that same PID owns `9900` on `127.0.0.1`, `0.0.0.0`, or `::`, read a nonempty key, prepend the literal `Bearer ` scheme to that credential in memory, and call:

```python
def _extract_single_loaded_model_id(payload) -> str | None:
    data = payload.get('data') if isinstance(payload, dict) else None
    if not isinstance(data, list):
        return None
    loaded = [
        item.get('id').strip()
        for item in data
        if isinstance(item, dict)
        and item.get('loaded') is True
        and isinstance(item.get('id'), str)
        and item.get('id').strip()
    ]
    if not loaded:
        return None
    if len(loaded) != 1:
        raise BackendAmbiguous('Multiple loaded Studio model IDs reported.')
    return loaded[0]
```

Catch filesystem, HTTP, JSON, timeout, and malformed-response errors as unavailable without including token text in messages.

- [ ] **Step 4: Run resolver tests and verify they pass**

Run the Task 1 command. Expected: PASS, including all pre-existing legacy and ambiguity tests.

- [ ] **Step 5: Commit the resolver change**

```bash
git add ops/unsloth-studio-exposure/unsloth_backend_resolver.py ops/unsloth-studio-exposure/test_unsloth_backend_resolver.py
git commit -m "fix: resolve unified Unsloth Studio backend"
```

### Task 2: Replace upstream authorization and return safe backend metadata

**Files:**
- Modify: `ops/unsloth-studio-exposure/unsloth_request_guard.py:383-573`
- Test: `ops/unsloth-studio-exposure/test_unsloth_request_guard.py`

**Interfaces:**
- Consumes: `ResolvedBackend.authorization`, `ResolvedBackend.port`, and `ResolvedBackend.mode` from Task 1.
- Produces: `filter_request_headers(headers, body, upstream_authorization=None)` and successful `/v1/models` responses containing `X-DGX-Backend-Port: 9900` in unified mode.

- [ ] **Step 1: Write failing guard tests**

Add a unified backend fixture with `port=9900`, `mode='unified'`, and `authorization='Bearer service-secret'`. Prove that a client header `Bearer client-secret` is replaced, while the response contains only safe metadata:

```python
self.assertEqual(
    connection.request_call['headers']['Authorization'],
    'Bearer service-secret',
)
self.assertEqual(
    self.response_header_map(handler)['x-dgx-backend-port'],
    '9900',
)
self.assertNotIn(b'service-secret', handler.wfile.getvalue())
self.assertNotIn('service-secret', repr(resolver.resolved))
```

Add a legacy test proving client authorization remains unchanged when `authorization is None`, and error-response tests proving no backend-port or credential header is emitted on 503/502.

- [ ] **Step 2: Run guard tests and verify they fail**

Run:

```bash
python3 -m unittest ops/unsloth-studio-exposure/test_unsloth_request_guard.py -v
```

Expected: FAIL because the guard currently forwards client authorization and has no backend-port response header.

- [ ] **Step 3: Implement authorization replacement and response metadata**

Change request filtering to remove any case variant of `Authorization` when an upstream service authorization is supplied, then set exactly one canonical header:

```python
def filter_request_headers(headers, body: bytes, upstream_authorization=None):
    filtered = {}
    for key, value in headers.items():
        lower_key = key.lower()
        if lower_key in HOP_BY_HOP_HEADERS or lower_key in {'host', 'content-length'}:
            continue
        if upstream_authorization is not None and lower_key == 'authorization':
            continue
        filtered[key] = value
    if upstream_authorization is not None:
        filtered['Authorization'] = upstream_authorization
    filtered['Content-Length'] = str(len(body))
    filtered['X-DGX-Request-Guard'] = 'unsloth-studio'
    return filtered
```

Pass `resolved_backend.authorization` at the call site. Change `_write_upstream_response(response, resolved_backend)` to add `X-DGX-Backend-Port` only when the upstream status is 2xx and `urlsplit(self.path).path == '/v1/models'`.

- [ ] **Step 4: Run guard and resolver tests**

Run:

```bash
python3 -m unittest discover -s ops/unsloth-studio-exposure -p 'test_unsloth_*.py' -v
```

Expected: PASS.

- [ ] **Step 5: Commit the guard change**

```bash
git add ops/unsloth-studio-exposure/unsloth_request_guard.py ops/unsloth-studio-exposure/test_unsloth_request_guard.py
git commit -m "fix: authenticate unified Studio guard upstream"
```

### Task 3: Update exposure packaging for the key path and loaded-model readiness

**Files:**
- Modify: `ops/unsloth-studio-exposure/systemd/dgx-unsloth-guard.service:1-14`
- Modify: `ops/unsloth-studio-exposure/start_exposure.sh:206-258`
- Modify: `ops/unsloth-studio-exposure/test_exposure_packaging.py`
- Modify: `ops/unsloth-studio-exposure/README.md`

**Interfaces:**
- Consumes: the fixed external key file and guard response contract from Tasks 1-2.
- Produces: a user unit exporting `DGX_UNSLOTH_STUDIO_API_KEY_FILE=/home/mctdgx01/.config/unsloth/dgx-guard-api-key`; readiness accepts one loaded model plus any number of unloaded cached models and requires backend header `9900`.

- [ ] **Step 1: Write failing package tests**

Update the fake guard server to send `X-DGX-Backend-Port`. Add a success fixture:

```python
{
    'data': [
        {'id': 'unsloth/Qwen3.8-27B-NVFP4', 'loaded': True},
        {'id': 'cached/model-a', 'loaded': False},
        {'id': 'cached/model-b', 'loaded': False},
    ],
}
```

Add failure cases for zero/two loaded entries, missing marker, missing/wrong backend-port header, and empty loaded ID. Update `EXPECTED_GUARD_UNIT` to require the exact environment line.

- [ ] **Step 2: Run package tests and verify they fail**

Run:

```bash
python3 -m unittest ops/unsloth-studio-exposure/test_exposure_packaging.py -v
```

Expected: FAIL because readiness currently requires `len(data) == 1` and the unit has no key-file environment.

- [ ] **Step 3: Implement package contract**

Add this unit line immediately above `ExecStart`:

```ini
Environment=DGX_UNSLOTH_STUDIO_API_KEY_FILE=/home/mctdgx01/.config/unsloth/dgx-guard-api-key
```

In `assert_guard_ready`, require both safe headers, filter entries using `item.get('loaded') is True`, and require exactly one valid loaded ID. Do not read or print the key in shell. Document unified `:9900` fallback, credential ownership/mode, and legacy precedence in the README.

- [ ] **Step 4: Run package and shell checks**

Run:

```bash
python3 -m unittest ops/unsloth-studio-exposure/test_exposure_packaging.py -v
bash -n ops/unsloth-studio-exposure/install_exposure.sh
bash -n ops/unsloth-studio-exposure/start_exposure.sh
bash -n ops/unsloth-studio-exposure/stop_exposure.sh
bash -n ops/unsloth-studio-exposure/remove_exposure.sh
```

Expected: PASS with no live service mutation.

- [ ] **Step 5: Commit packaging changes**

```bash
git add ops/unsloth-studio-exposure/systemd/dgx-unsloth-guard.service ops/unsloth-studio-exposure/start_exposure.sh ops/unsloth-studio-exposure/test_exposure_packaging.py ops/unsloth-studio-exposure/README.md
git commit -m "fix: package unified Studio guard credentials"
```

### Task 4: Add a pure Dashboard adapter for guarded Studio metadata

**Files:**
- Create: `unsloth-studio-guard-runtime.js`
- Create: `test/unsloth-studio-guard-runtime.test.js`
- Modify: `runtime-model-inventory.js:11-244`
- Test: `test/runtime-model-inventory.test.js`

**Interfaces:**
- Consumes: HTTP response marker `X-DGX-Request-Guard: unsloth-studio`, header `X-DGX-Backend-Port: 9900`, and `/v1/models` JSON.
- Produces: `selectSingleLoadedStudioModel(payload)`, `parseGuardedStudioRuntime(response, payload)`, `probeUnifiedStudioRuntime({ fetchImpl, timeoutMs })`, and `mergeUnifiedStudioRuntime(models, runtime)`.

- [ ] **Step 1: Write failing adapter and inventory tests**

Test exact successful output:

```javascript
assert.deepEqual(parseGuardedStudioRuntime(response, payload), {
  source: 'unsloth-studio-guard',
  isUnslothStudio: true,
  unifiedStudio: true,
  healthy: true,
  liveApiModelId: 'unsloth/Qwen3.8-27B-NVFP4',
  liveApiModelIds: ['unsloth/Qwen3.8-27B-NVFP4'],
  apiModel: 'unsloth/Qwen3.8-27B-NVFP4',
  clientPort: 56827,
  backendPort: 9900,
  port: 9900,
  server: 'http://127.0.0.1:56828',
});
```

Add null-result tests for non-2xx, wrong/missing guard marker, wrong/missing backend port, malformed payload, zero loaded entries, and multiple loaded entries. Add merge tests proving the card has `apiModel`, `servedModelName`, `clientPort=56827`, `backendPort=9900`, `port=56827`, running state, and Studio inventory-only ownership. Prove ambiguous shared-port configured cards are quarantined and one dynamic live card is added.

- [ ] **Step 2: Run focused Node tests and verify they fail**

Run:

```bash
node --test test/unsloth-studio-guard-runtime.test.js test/runtime-model-inventory.test.js
```

Expected: FAIL because the adapter and unified merge function do not exist.

- [ ] **Step 3: Implement the pure adapter and merge function**

Use fixed constants and strict parsing:

```javascript
export const UNSLOTH_STUDIO_GUARD_URL = 'http://127.0.0.1:56828';
export const UNSLOTH_STUDIO_BACKEND_PORT = 9900;

export function selectSingleLoadedStudioModel(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const loaded = data.filter(item =>
    item?.loaded === true && typeof item.id === 'string' && item.id.trim());
  return loaded.length === 1 ? loaded[0] : null;
}
```

`probeUnifiedStudioRuntime` must use a one-second abort timeout, catch all network/JSON errors as `null`, and never accept model metadata without both validated headers. `mergeUnifiedStudioRuntime` must preserve a single configured card's display metadata, replace stale API/runtime fields, quarantine multiple shared-port cards using the existing quarantine contract, and create one dynamic card when no unique merge target exists.

- [ ] **Step 4: Run adapter, inventory, and display tests**

Run:

```bash
node --test test/unsloth-studio-guard-runtime.test.js test/runtime-model-inventory.test.js test/model-card-display.test.js
```

Expected: PASS; the existing UI test continues proving the visible value and client-port badge behavior.

- [ ] **Step 5: Commit the Dashboard adapter**

```bash
git add unsloth-studio-guard-runtime.js runtime-model-inventory.js test/unsloth-studio-guard-runtime.test.js test/runtime-model-inventory.test.js
git commit -m "fix: adapt guarded Studio runtime metadata"
```

### Task 5: Render the distinct backend port on the Studio card

**Files:**
- Modify: `model-card-display.js`
- Modify: `src/lib/SystemMetrics.svelte:1-12,771-805`
- Test: `test/model-card-display.test.js`

**Interfaces:**
- Consumes: card/runtime `backendPort` and the already selected client/display port.
- Produces: `modelBackendPortValue(model, runtimeModel)` and a visible `Backend :9900` detail only when the backend differs from the client/display port.

- [ ] **Step 1: Write failing backend-detail tests**

Add helper tests:

```javascript
assert.equal(
  modelBackendPortValue(
    { clientPort: 56827, backendPort: 9900 },
    { clientPort: 56827, backendPort: 9900 },
  ),
  9900,
);
assert.equal(
  modelBackendPortValue(
    { clientPort: 18131, backendPort: 18131 },
    { clientPort: 18131, backendPort: 18131 },
  ),
  null,
);
```

Add source assertions requiring one llama-card element with class `model-backend-port` and text `Backend :{backendPort}`, while retaining the existing `displayPort` expression for the running badge.

- [ ] **Step 2: Run the display test and verify it fails**

```bash
node --test test/model-card-display.test.js
```

Expected: FAIL because there is no backend-port helper or rendered detail.

- [ ] **Step 3: Implement the helper and llama-card detail**

Add a strict positive-integer helper:

```javascript
export function modelBackendPortValue(model = {}, runtimeModel = {}) {
  const backendPort = Number(runtimeModel.backendPort || model.backendPort || 0);
  const clientPort = Number(
    runtimeModel.clientPort || model.clientPort || runtimeModel.port || model.port || 0,
  );
  return Number.isInteger(backendPort) && backendPort > 0 && backendPort !== clientPort
    ? backendPort
    : null;
}
```

Import it in `SystemMetrics.svelte`, derive `backendPort` beside `displayPort`, and add this detail to the llama card's model-function row:

```svelte
{#if backendPort}<span class="model-backend-port">Backend :{backendPort}</span>{/if}
```

Do not change the running badge expression; it must continue to use client port `56827`.

- [ ] **Step 4: Run display and inventory tests**

```bash
node --test test/model-card-display.test.js test/runtime-model-inventory.test.js test/unsloth-studio-guard-runtime.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit the UI detail**

```bash
git add model-card-display.js src/lib/SystemMetrics.svelte test/model-card-display.test.js
git commit -m "fix: show Studio backend port on model card"
```

### Task 6: Wire unified runtime into inventory and top-level llama status

**Files:**
- Modify: `dev-server.js:14-27,1490-1725,1728-2013`
- Modify: `test/unsloth-studio-inventory.test.js`
- Test: `test/llama-runtime-selection.test.js`

**Interfaces:**
- Consumes: `probeUnifiedStudioRuntime`, `selectSingleLoadedStudioModel`, and `mergeUnifiedStudioRuntime` from Task 4.
- Produces: `/api/metrics` where `inference.availableModels.llama` contains one running Studio card and `inference.llama` reports `apiModel`, `backendPort=9900`, and `proxyPort=56827`.

- [ ] **Step 1: Write failing wiring tests**

Export a small pure helper from `dev-server.js`:

```javascript
export function selectModelForRuntimeProbe(payload, runtime = {}) {
  return runtime.unifiedStudio === true
    ? selectSingleLoadedStudioModel(payload)
    : selectLiveModelFromProbe(payload, {
        requireSingleDistinctId: runtime.isUnslothStudio === true,
      });
}
```

Test that a unified payload with one loaded and two unloaded entries returns the loaded ID, while legacy Studio behavior still rejects multiple distinct IDs. Add a source-wiring assertion that both `getAvailableModels` and `getLlamaInfo` call `probeUnifiedStudioRuntime` only when no valid legacy Studio child candidate exists.

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```bash
node --test test/unsloth-studio-inventory.test.js test/llama-runtime-selection.test.js
```

Expected: FAIL because unified guarded candidates are not wired into either metrics path.

- [ ] **Step 3: Wire the candidate into `getAvailableModels`**

After legacy process probing and before returning models:

```javascript
if (!studioCandidates.length) {
  const unifiedStudio = await probeUnifiedStudioRuntime({ fetchImpl: fetch });
  if (unifiedStudio) {
    const merged = mergeUnifiedStudioRuntime(models, unifiedStudio);
    models.llama = merged.llama;
    models.vllm = merged.vllm;
  }
}
```

Do not query Studio directly or add the service credential to Node.

- [ ] **Step 4: Wire the candidate into `getLlamaInfo`**

When no verified legacy Studio process candidate exists, probe the guard and push its returned candidate into `liveProcessCandidates`. Set its `server` to the guard URL, preserve `port/backendPort=9900` and `clientPort=56827`, and use `selectModelForRuntimeProbe` for the final model query. A valid guarded model probe sets healthy/running even if Studio does not implement llama.cpp-only `/health`, `/props`, or `/slots` semantics.

- [ ] **Step 5: Run focused and complete Dashboard tests**

Run:

```bash
node --test test/unsloth-studio-guard-runtime.test.js test/unsloth-studio-inventory.test.js test/runtime-model-inventory.test.js test/llama-runtime-selection.test.js test/model-card-display.test.js
npm test
npm run build
```

Expected: all PASS and build exits zero.

- [ ] **Step 6: Commit Dashboard wiring**

```bash
git add dev-server.js test/unsloth-studio-inventory.test.js test/llama-runtime-selection.test.js
git commit -m "fix: expose unified Studio runtime in Dashboard"
```

### Task 7: Run repository-wide verification before deployment

**Files:**
- Verify only; no new source file is required.

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: a clean test/build result and reviewed diff before any production mutation.

- [ ] **Step 1: Run all Python, shell, Node, and build checks**

```bash
python3 -m unittest discover -s ops/unsloth-studio-exposure -p 'test_*.py' -v
bash -n ops/unsloth-studio-exposure/install_exposure.sh
bash -n ops/unsloth-studio-exposure/start_exposure.sh
bash -n ops/unsloth-studio-exposure/stop_exposure.sh
bash -n ops/unsloth-studio-exposure/remove_exposure.sh
npm test
npm run build
git diff --check
```

- [ ] **Step 2: Review secret and topology invariants**

```bash
rg -n "studio-service-key|client-secret|Authorization.*Bearer" ops/unsloth-studio-exposure/unsloth_backend_resolver.py ops/unsloth-studio-exposure/unsloth_request_guard.py dev-server.js unsloth-studio-guard-runtime.js runtime-model-inventory.js src
rg -n "56827|56828|9900|tailscale|Funnel|0\.0\.0\.0" ops/unsloth-studio-exposure dev-server.js unsloth-studio-guard-runtime.js runtime-model-inventory.js
git status --short --branch
git diff 9760dcb..HEAD --stat
```

Expected: no real credential, no topology mutation, and only intended tracked files. Preserve the two known user-owned untracked paths.

- [ ] **Step 3: Review the complete code diff**

Check resolver owner verification, auth replacement, fail-closed branches, duplicate-card handling, test coverage, and secret redaction. Resolve every Critical or Important issue and rerun Step 1 before deployment.

### Task 8: Deploy the tested guard safely without restarting Studio

**Files:**
- Create outside Git: `/home/mctdgx01/models/operation_records/unsloth-unified-gate-20260816T034326Z/`
- Create outside Git: `/home/mctdgx01/.config/unsloth/dgx-guard-api-key`
- Update from tested package: `/home/mctdgx01/.local/lib/dgx-unsloth-exposure/unsloth_backend_resolver.py`
- Update from tested package: `/home/mctdgx01/.local/lib/dgx-unsloth-exposure/unsloth_request_guard.py`
- Update from tested package: `/home/mctdgx01/.config/systemd/user/dgx-unsloth-guard.service`

**Interfaces:**
- Consumes: verified source package and official Unsloth same-user authentication helpers from canonical Root A.
- Produces: a restarted guard resolving `unsloth/Qwen3.8-27B-NVFP4` through backend `9900`; Studio, LAN proxy, and Tailscale remain untouched.

- [ ] **Step 1: Capture pre-change evidence and backups**

Create a timestamped operation record and save sanitized outputs for `git rev-parse HEAD`, `systemctl --user show/cat`, exact PIDs, `ss -ltnp`, Dashboard metrics, SHA-256 hashes, file modes, and Tailscale Serve status. Back up the three live files above plus Studio auth database/key metadata without copying model weights. Record Studio PID, GPU worker PID, and loaded model ID using in-memory authentication without printing the token.

Use the fixed operation directory and restrictive permissions:

```bash
install -d -m 0700 /home/mctdgx01/models/operation_records/unsloth-unified-gate-20260816T034326Z
install -d -m 0700 /home/mctdgx01/models/operation_records/unsloth-unified-gate-20260816T034326Z/backups
systemctl --user cat dgx-unsloth-guard.service > /home/mctdgx01/models/operation_records/unsloth-unified-gate-20260816T034326Z/guard-unit-before.txt
systemctl --user show dgx-unsloth-guard.service -p MainPID -p FragmentPath -p Environment -p ExecStart > /home/mctdgx01/models/operation_records/unsloth-unified-gate-20260816T034326Z/guard-show-before.txt
ss -H -ltnp > /home/mctdgx01/models/operation_records/unsloth-unified-gate-20260816T034326Z/listeners-before.txt
cp -a /home/mctdgx01/.local/lib/dgx-unsloth-exposure/unsloth_backend_resolver.py /home/mctdgx01/models/operation_records/unsloth-unified-gate-20260816T034326Z/backups/
cp -a /home/mctdgx01/.local/lib/dgx-unsloth-exposure/unsloth_request_guard.py /home/mctdgx01/models/operation_records/unsloth-unified-gate-20260816T034326Z/backups/
cp -a /home/mctdgx01/.config/systemd/user/dgx-unsloth-guard.service /home/mctdgx01/models/operation_records/unsloth-unified-gate-20260816T034326Z/backups/
```

Locate the canonical Studio auth database with the installed official storage module, record its exact path, and copy only that regular database plus any pre-existing guard key into the backup directory with mode `0600`.

- [ ] **Step 2: Mint and atomically store one dedicated key**

Use canonical Root A's Python, verify `http://127.0.0.1:9900` with the official same-user identity proof, self-issue the official local token, POST `{"name":"DGX dynamic request guard"}` to `/api/auth/api-keys`, and write only the returned raw key to the fixed path with directory mode `0700` and file mode `0600`. Do not pass the key in argv or shell variables and do not redirect it through terminal output. Immediately verify authenticated `/v1/models`, then discard the in-memory token and key variables.

Run a no-output Python program under the canonical environment:

```bash
UNSLOTH_STUDIO_HOME=/home/mctdgx01/apps/unsloth-studio /home/mctdgx01/apps/unsloth-studio/unsloth_studio/bin/python - <<'PY'
import os
from pathlib import Path

from unsloth_cli.commands.start import _http_json, _studio_token, verify_studio_identity

base = 'http://127.0.0.1:9900'
destination = Path('/home/mctdgx01/.config/unsloth/dgx-guard-api-key')
temporary = destination.with_name(f'.{destination.name}.new')
if not verify_studio_identity(base):
    raise SystemExit('Studio same-user identity verification failed')
token = _studio_token()
if not token:
    raise SystemExit('Studio local token creation failed')
created = _http_json(
    'POST',
    f'{base}/api/auth/api-keys',
    token,
    {'name': 'DGX dynamic request guard'},
)
key = created.get('key')
if not isinstance(key, str) or not key.strip():
    raise SystemExit('Studio did not return a service key')
destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as handle:
    handle.write(key.strip() + '\n')
os.replace(temporary, destination)
os.chmod(destination, 0o600)
models = _http_json('GET', f'{base}/v1/models', key)
loaded = [item for item in models.get('data', []) if item.get('loaded') is True]
if len(loaded) != 1 or loaded[0].get('id') != 'unsloth/Qwen3.8-27B-NVFP4':
    raise SystemExit('Dedicated key did not verify the one expected loaded model')
del key, token
PY
```

- [ ] **Step 3: Install only tested guard artifacts**

After exact listener/service ownership checks, use `install` to replace only the two backed-up Python helpers under `/home/mctdgx01/.local/lib/dgx-unsloth-exposure/` with mode `0755` and the backed-up guard unit with the tested repository unit using mode `0644`. Do not invoke `install_exposure.sh`, because its wider start path also evaluates the already-correct LAN/Tailscale exposure. Verify installed SHA-256 hashes match repository sources, the key path/mode/owner are exact, and the user unit environment points to the fixed key file.

```bash
install -m 0755 ops/unsloth-studio-exposure/unsloth_backend_resolver.py /home/mctdgx01/.local/lib/dgx-unsloth-exposure/unsloth_backend_resolver.py
install -m 0755 ops/unsloth-studio-exposure/unsloth_request_guard.py /home/mctdgx01/.local/lib/dgx-unsloth-exposure/unsloth_request_guard.py
install -m 0644 ops/unsloth-studio-exposure/systemd/dgx-unsloth-guard.service /home/mctdgx01/.config/systemd/user/dgx-unsloth-guard.service
sha256sum ops/unsloth-studio-exposure/unsloth_backend_resolver.py /home/mctdgx01/.local/lib/dgx-unsloth-exposure/unsloth_backend_resolver.py
sha256sum ops/unsloth-studio-exposure/unsloth_request_guard.py /home/mctdgx01/.local/lib/dgx-unsloth-exposure/unsloth_request_guard.py
stat -c '%U %a %n' /home/mctdgx01/.config/unsloth/dgx-guard-api-key
```

- [ ] **Step 4: Restart only the guard**

Run `systemctl --user daemon-reload` and restart only `dgx-unsloth-guard.service`. Do not restart `dgx-unsloth-lan-proxy.service`, Studio, or Tailscale. Verify guard PID changed, Studio/Python GPU worker and LAN proxy PIDs did not change, and listeners remain `9900`, `9000`, `56828`, and both client-side `56827` endpoints.

```bash
systemctl --user daemon-reload
systemctl --user restart dgx-unsloth-guard.service
systemctl --user is-active dgx-unsloth-guard.service
systemctl --user show dgx-unsloth-guard.service -p MainPID -p Environment -p ExecStart
ss -H -ltnp
```

- [ ] **Step 5: Verify guarded API before Dashboard restart**

Probe `127.0.0.1:56828/v1/models`, LAN `192.168.0.21:56827/v1/models`, and Tailscale `100.108.68.20:56827/v1/models`. Require HTTP 200, guard marker, backend header `9900`, exactly one `loaded=true` ID equal to `unsloth/Qwen3.8-27B-NVFP4`, and no response/log containing the key. Do not send a generation request or load/replace a model; the authenticated model-list request is the bounded forwarding proof for this repair.

### Task 9: Restart Dashboard, run live acceptance, and document the repair

**Files:**
- Runtime restart only: Dashboard process serving `/home/mctdgx01/dgx-spark-status` on `:9000`
- Create: `/home/mctdgx01/projects/DGXmodelmd/Unsloth-Studio-main-UnslothAI-NA-9900/logs/DYNAMIC_GATE_UNIFIED_API_20260816.md`

**Interfaces:**
- Consumes: deployed guard and tested Dashboard commit.
- Produces: visible exact model ID, `56827` card badge, `9900` backend detail, sanitized handoff, and rollback evidence.

- [ ] **Step 1: Restart only the Dashboard process using its existing owner**

Capture the exact current Dashboard PID/PGID and launch mechanism. Restart through that same mechanism; do not kill unrelated Node processes. Verify `0.0.0.0:9000` returns and its process cwd is `/home/mctdgx01/dgx-spark-status`.

- [ ] **Step 2: Verify API metrics**

Read a fresh `/api/metrics` payload and require:

```javascript
studioCard.apiModel === 'unsloth/Qwen3.8-27B-NVFP4'
studioCard.clientPort === 56827
studioCard.backendPort === 9900
studioCard.port === 56827
studioCard.running === true
studioCard.lifecycleOwner === 'unsloth-studio'
metrics.inference.llama.apiModel === 'unsloth/Qwen3.8-27B-NVFP4'
metrics.inference.llama.backendPort === 9900
metrics.inference.llama.proxyPort === 56827
```

Require exactly one non-quarantined running Studio card.

- [ ] **Step 3: Verify the rendered card**

Open Dashboard 9000 and confirm the card shows the full model ID, running badge `56827`, and backend detail `9900`. Confirm the Copy action returns the exact ID. Capture a screenshot only if it contains no credentials or sensitive request data.

- [ ] **Step 4: Verify protected state and rollback readiness**

Compare pre/post Studio PID, GPU worker, model ID, LAN proxy PID, Tailscale Serve JSON, listener bindings, and unrelated Dashboard models. They must be unchanged except guard and Dashboard PIDs. Record exact rollback commands that restore backed-up helper/unit files, daemon-reload, and restart only guard/Dashboard.

- [ ] **Step 5: Write and validate the canonical handoff**

Document root cause, code commits, credential handling without key value, before/after topology, tests, live evidence, rollback, and confirmation that canonical Root A remains `/home/mctdgx01/apps/unsloth-studio`. Run the DGXmodelmd Markdown validator, commit only the new sanitized log in that repository, and push only if the repository is clean and still on its authorized `main` branch.

- [ ] **Step 6: Final verification**

Rerun Task 7 checks, fresh guard/LAN/Tailscale probes, fresh Dashboard metrics, UI inspection, `git diff --check`, and both repositories' status. Do not claim completion unless every acceptance item passes.
