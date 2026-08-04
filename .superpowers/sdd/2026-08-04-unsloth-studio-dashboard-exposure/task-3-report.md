# Task 3 report — dedicated Model ID row on LLAMA, vLLM, and ETC cards

Commit SHA: `febee68c7931d80d8727774d067b2d4211cb4333`

Commit message: `Add dedicated model ID rows to dashboard cards`

## Files changed

- `src/lib/SystemMetrics.svelte`
- `test/model-card-display.test.js`

## Scope summary

- Added a focused source-level regression test that requires `SystemMetrics.svelte` to import the shared `modelIdValue(...)` helper, render three visible `Model ID` labels/templates, and avoid the old display-name fallback path in the dedicated ID row.
- Updated `SystemMetrics.svelte` to import and use `modelIdValue(model)` for LLAMA, vLLM, and ETC cards.
- Rendered a dedicated visible `Model ID` row whenever a real API/served/model alias exists, keeping the full exact ID in the `title` attribute while allowing the visible value to truncate for layout.
- Left the display-name/title row, status badges, connection rows, notes, control behavior, and inventory-only behavior unchanged.

## Test/build commands and exact outputs

### Red run

Command:

```bash
node --test test/model-card-display.test.js
```

Output:

```text
TAP version 13
# Subtest: formats DS4 240K-total context and input/output budgets compactly
ok 1 - formats DS4 240K-total context and input/output budgets compactly
  ---
  duration_ms: 0.379747
  type: 'test'
  ...
# Subtest: modelIdValue returns the exact live API model ID even when the display name matches
ok 2 - modelIdValue returns the exact live API model ID even when the display name matches
  ---
  duration_ms: 0.069313
  type: 'test'
  ...
# Subtest: modelIdValue does not invent an ID from an empty model name
ok 3 - modelIdValue does not invent an ID from an empty model name
  ---
  duration_ms: 0.046144
  type: 'test'
  ...
# Subtest: SystemMetrics renders dedicated Model ID rows from the shared live-ID helper for llama, vLLM, and ETC cards
not ok 4 - SystemMetrics renders dedicated Model ID rows from the shared live-ID helper for llama, vLLM, and ETC cards
  ---
  duration_ms: 1.560109
  type: 'test'
  location: '/home/mctdgx01/dgx-spark-status/test/model-card-display.test.js:40:1'
  failureType: 'testCodeFailure'
  error: |-
    The input did not match the regular expression /import\s+\{\s*modelBudgetLabel,\s*modelIdValue\s*\}\s+from '\.\.\/\.\.\/model-card-display\.js';/. Input:

    '<script>\n' +
      "  import { onMount, onDestroy } from 'svelte';\n" +
      "  import { subscribe, getCurrentMetrics, isWebSocketConnected } from './websocket.js';\n" +
      "  import Gauge from './Gauge.svelte';\n" +
      "  import HermesSpotlight from './HermesSpotlight.svelte';\n" +
      "  import { modelBudgetLabel } from '../../model-card-display.js';\n" +
      "  import { buildMemoryDisplay } from '../../memory-display.js';\n" +
      "  import { findModelControlProfile } from '../../model-control-matching.js';\n" +
      "  import { isActiveControlStatus, modelControlStatusLabel, resolveModelDisplayStatus } from '../../model-control-state.js';\n" +
      '\n' +
      '  let metrics = $state(null);\n' +
      '  let connected = $state(false);\n' +
      '  let unsubscribe = null;\n' +
      '\n' +
      '  // History for sparklines (last 60 data points = 60 seconds)\n' +
      '  const HISTORY_LEN = 60;\n' +
      '  let cpuHistory = $state(Array(HISTORY_LEN).fill(0));\n' +
      '  let gpuHistory = $state(Array(HISTORY_LEN).fill(0));\n' +
      '  let netRxHistory = $state(Array(HISTORY_LEN).fill(0));\n' +
      '  let netTxHistory = $state(Array(HISTORY_LEN).fill(0));\n' +
      '  let modelControls = $state([]);\n' +
      "  let modelControlError = $state('');\n" +
      '  let modelActions = $state({});\n' +
      '  let stopAllAction = $state({});\n' +
      '  let agentProcessActions = $state({ claude: {}, codex: {} });\n' +
      '  let ds4Action = $state({});\n' +
      '  let modelControlTimer = null;\n' +
      '  let graphTopology = $state(null);\n' +
      "  let graphifyError = $state('');\n" +
      '  let graphifyTimer = null;\n' +
      '  let dgxHealth = $state(null);\n' +
      "  let dgxHealthError = $state('');\n" +
      '  let dgxHealthTimer = null;\n' +
      '\n' +
      '  const DGX_HEALTH_BASE_PORTS = [9000, 11000];\n' +
      '\n' +
      '  function pushHistory(arr, val) {\n' +
      '    const next = [...arr.slice(1), val];\n' +
      '    return next;\n' +
      '  }\n' +
      '\n' +
      '  function isWifiNetwork(net) {\n' +
      "    return net?.kind === 'wifi' || String(net?.iface || '').startsWith('wl');\n" +
      '  }\n' +
      '\n' +
      '  function selectGraphNetwork(network = []) {\n' +
      "    return network.find(isWifiNetwork) || network.find(n => n.iface === 'all') || network[0];\n" +
      '  }\n' +
      '\n' +
      '  function visibleNetworkRows(network = []) {\n' +
      "    return network.filter(n => n.iface !== 'all').slice(0, 4);\n" +
      '  }\n' +
      '\n' +
      '  function formatNetworkSpeed(value) {\n' +
      '    return Number(value || 0).toFixed(2);\n' +
      '  }\n' +
      '\n' +
      '  function networkName(net) {\n' +
      "    const label = net?.label || net?.kind || 'Network';\n" +
      "    return `${label} ${net?.iface || ''}`.trim();\n" +
      '  }\n' +
      '\n' +
      '  onMount(() => {\n' +
      '    loadModelControls();\n' +
      '    loadGraphifyTopology();\n' +
      '    loadDgxHealth();\n' +
      '    modelControlTimer = setInterval(loadModelControls, 15000);\n' +
      '    graphifyTimer = setInterval(loadGraphifyTopology, 5000);\n' +
      '    dgxHealthTimer = setInterval(loadDgxHealth, 5000);\n' +
      '    unsubscribe = subscribe((message) => {\n' +
      "      if (message.type === 'connected') {\n" +
      '        connected = true;\n' +
      "      } else if (message.type === 'disconnected') {\n" +
      '        connected = false;\n' +
      "      } else if (message.type === 'metrics') {\n" +
      '        metrics = message.data;\n' +
      '        cpuHistory = pushHistory(cpuHistory, message.data.cpu?.usage || 0);\n' +
      '        gpuHistory = pushHistory(gpuHistory, message.data.gpu?.[0]?.utilizationGpu || 0);\n' +
      '        const net = selectGraphNetwork(message.data.network || []);\n' +
      '        netRxHistory = pushHistory(netRxHistory, net?.rx_sec_mb || 0);\n' +
      '        netTxHistory = pushHistory(netTxHistory, net?.tx_sec_mb || 0);\n' +
      '      }\n' +
      '    });\n' +
      '    metrics = getCurrentMetrics();\n' +
      '    connected = isWebSocketConnected();\n' +
      '  });\n' +
      '\n' +
      '  onDestroy(() => {\n' +
      '    if (unsubscribe) { unsubscribe(); unsubscribe = null; }\n' +
      '    if (modelControlTimer) { clearInterval(modelControlTimer); modelControlTimer = null; }\n' +
      '    if (graphifyTimer) { clearInterval(graphifyTimer); graphifyTimer = null; }\n' +
      '    if (dgxHealthTimer) { clearInterval(dgxHealthTimer); dgxHealthTimer = null; }\n' +
      '  });\n' +
      '\n' +
      '  async function loadModelControls() {\n' +
      '    try {\n' +
      "      const res = await fetch('/api/model-control/list');\n" +
      '      const data = await res.json();\n' +
      "      if (!data.ok) throw new Error(data.message || 'Model control list failed');\n" +
      '      modelControls = data.profiles || [];\n' +
      '      modelActions = Object.fromEntries(\n' +
      '        Object.entries(modelActions).map(([profileId, state]) => [\n' +
      '          profileId,\n' +
      '          state?.busy ? state : {}\n' +
      '        ]).filter(([, state]) => state?.busy)\n' +
      '      );\n' +
      "      modelControlError = '';\n" +
      '    } catch (error) {\n' +
      "      modelControlError = error.message || 'Model control unavailable';\n" +
      '    }\n' +
      '  }\n' +
      '\n' +
      '  async function loadGraphifyTopology() {\n' +
      '    try {\n' +
      "      const res = await fetch('/api/graphify/topology');\n" +
      '      const data = await res.json();\n' +
      "      if (!res.ok || data.ok === false) throw new Error(data.message || 'Graphify topology failed');\n" +
      '      graphTopology = data;\n' +
      "      graphifyError = '';\n" +
      '    } catch (error) {\n' +
      "      graphifyError = error.message || 'Graphify unavailable';\n" +
      '    }\n' +
      '  }\n' +
      '\n' +
      '  async function loadDgxHealth() {\n' +
      '    try {\n' +
      "      const res = await fetch('/api/dgx-health/latest');\n" +
      '      const data = await res.json();\n' +
      '      dgxHealth = data;\n' +
      "      dgxHealthError = !res.ok || data.ok === false ? (data.error || 'DGX health unavailable') : '';\n" +
      '    } catch (error) {\n' +
      '      dgxHealth = null;\n' +
      "      dgxHealthError = error.message || 'DGX health unavailable';\n" +
      '    }\n' +
      '  }\n' +
      '\n' +
      '  function controlForModel(model, runtimeModel, displayPort) {\n' +
      '    return findModelControlProfile(model, runtimeModel, displayPort, modelControls);\n' +
      '  }\n' +
      '\n' +
      '  function actionState(profileId) {\n' +
      '    return modelActions[profileId] || {};\n' +
      '  }\n' +
      '\n' +
      '  function controlDisabledLabel(control) {\n' +
      "    if (!control?.control_enabled) return 'Inventory Only';\n" +
      "    return control?.status || 'Unavailable';\n" +
      '  }\n' +
      '\n' +
      '  function controlErrorMessage(state) {\n' +
      "    if (!state?.error) return '';\n" +
      "    if (state.code === 'busy') {\n" +
      "      return 'Another model action is still finishing. Try again in a moment.';\n" +
      '    }\n' +
      "    if (state.code === 'FAILED_RAM_GUARD' || /available RAM dropped below/i.test(state.error)) {\n" +
      "      return 'Start aborted: available RAM dropped below 10GB. Model was stopped automatically.';\n" +
      '    }\n' +
      '    return state.error;\n' +
      '  }\n' +
      '\n' +
      '  function isDs4Model(model) {\n' +
      "    return model?.source === 'ds4-dwarfstar' || model?.runtime === 'ds4';\n" +
      '  }\n' +
      '\n' +
      '  function ds4StatusLabel(model) {\n' +
      '    const status = model?.ds4Status || {};\n' +
      '    if (status.running) return `RUNNING :${status.port || 8889}`;\n' +
      '    if (status.port_listening) return `LOADING :${status.port || 8889}`;\n' +
      "    return 'stopped';\n" +
      '  }\n' +
      '\n' +
      '  function ds4MetaLine(model) {\n' +
      '    const status = model?.ds4Status || {};\n' +
      '    const mem = Number(status.mem_available_gb);\n' +
      '    const nvrm = status.nvrm_delta;\n' +
      '    return [\n' +
      '      status.models_http_status ? `/v1/models ${status.models_http_status}` : null,\n' +
      '      Number.isFinite(mem) ? `MemAvailable ${mem.toFixed(1)} GiB` : null,\n' +
      '      Number.isFinite(Number(nvrm)) ? `NVRM delta ${nvrm}` : null,\n' +
      "      status.localhost_only === false ? `bind ${status.listener_host || status.bind_scope || 'non-localhost'}` : null\n" +
      "    ].filter(Boolean).join(' · ');\n" +
      '  }\n' +
      '\n' +
      '  async function runDs4Action(action) {\n' +
      '    ds4Action = { busy: true, verb: action };\n' +
      '    try {\n' +
      "      const endpoint = action === 'status' ? '/api/ds4/status' : `/api/ds4/${action}`;\n" +
      "      const res = await fetch(endpoint, { method: action === 'status' ? 'GET' : 'POST' });\n" +
      '      const data = await res.json();\n' +
      '      if (!data.ok) throw Object.assign(new Error(data.message || `${action} failed`), { code: data.code });\n' +
      "      const detail = action === 'status'\n" +
      '        ? data.status\n' +
      '        : (data.status || data.action || action);\n' +
      '      ds4Action = { busy: false, message: detail, detail: data };\n' +
      '    } catch (error) {\n' +
      '      ds4Action = { busy: false, code: error.code, error: error.message || `${action} failed` };\n' +
      '    }\n' +
      '  }\n' +
      '\n' +
      '  async function refreshModelStatus(profileId) {\n' +
      "    modelActions = { ...modelActions, [profileId]: { busy: true, verb: 'status' } };\n" +
      '    try {\n' +
      '      const res = await fetch(`/api/model-control/status/${profileId}`);\n' +
      '      const data = await res.json();\n' +
      "      if (!data.ok) throw Object.assign(new Error(data.message || 'Status failed'), { code: data.code });\n" +
      '      modelControls = modelControls.map(profile => profile.profile_id === profileId ? { ...profile, ...data } : profile);\n' +
      '      modelActions = { ...modelActions, [profileId]: { busy: false, message: data.status } };\n' +
      '    } catch (error) {\n' +
      "      modelActions = { ...modelActions, [profileId]: { busy: false, code: error.code, error: error.message || 'Status failed' } };\n" +
      '    }\n' +
      '  }\n' +
      '\n' +
      '  async function runModelAction(profileId, action) {\n' +
      '    modelActions = { ...modelActions, [profileId]: { busy: true, verb: action } };\n' +
      '    try {\n' +
      "      const res = await fetch(`/api/model-control/${action}/${profileId}`, { method: 'POST' });\n" +
      '      const data = await res.json();\n' +
      '      if (!data.ok) throw Object.assign(new Error(data.message || `${action} failed`), { code: data.code });\n' +
      '      modelActions = { ...modelActions, [profileId]: { busy: false, message: data.status || action } };\n' +
      '      await loadModelControls();\n' +
      '    } catch (error) {\n' +
      '      modelActions = { ...modelActions, [profileId]: { busy: false, code: error.code, error: error.message || `${action} failed` } };\n' +
      '      await loadModelControls();\n' +
      '    }\n' +
      '  }\n' +
      '\n' +
      '  async function runStopAllModels() {\n' +
      "    if (!window.confirm('Stop all Dashboard-managed models that are currently running?')) return;\n" +
      '    stopAllAction = { busy: true };\n' +
      '    try {\n' +
      "      const res = await fetch('/api/model-control/stop-all', {\n" +
      "        method: 'POST',\n" +
      "        headers: { 'Content-Type': 'application/json' },\n" +
      "        body: JSON.stringify({ confirm: 'KILL_ALL_MODELS' })\n" +
      '      });\n' +
      "      …71108 more characters\n"
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
  actual: |-
    <script>
      import { onMount, onDestroy } from 'svelte';
      import { subscribe, getCurrentMetrics, isWebSocketConnected } from './websocket.js';
      import Gauge from './Gauge.svelte';
      import HermesSpotlight from './HermesSpotlight.svelte';
      import { modelBudgetLabel } from '../../model-card-display.js';
      import { buildMemoryDisplay } from '../../memory-display.js';
      import { findModelControlProfile } from '../../model-control-matching.js';
      import { isActiveControlStatus, modelControlStatusLabel, resolveModelDisplayStatus } from '../../model-control-state.js';
      …16250 tokens truncated…
  operator: 'match'
  stack: |-
    TestContext.<anonymous> (file:///home/mctdgx01/dgx-spark-status/test/model-card-display.test.js:41:10)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.processPendingSubtests (node:internal/test_runner/test:744:18)
    Test.postRun (node:internal/test_runner/test:1173:19)
    Test.run (node:internal/test_runner/test:1101:12)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
1..4
# tests 4
# suites 0
# pass 3
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 48.794336
```

### Focused green run

Command:

```bash
node --test test/model-card-display.test.js
```

Output:

```text
TAP version 13
# Subtest: formats DS4 240K-total context and input/output budgets compactly
ok 1 - formats DS4 240K-total context and input/output budgets compactly
  ---
  duration_ms: 0.839336
  type: 'test'
  ...
# Subtest: modelIdValue returns the exact live API model ID even when the display name matches
ok 2 - modelIdValue returns the exact live API model ID even when the display name matches
  ---
  duration_ms: 0.173697
  type: 'test'
  ...
# Subtest: modelIdValue does not invent an ID from an empty model name
ok 3 - modelIdValue does not invent an ID from an empty model name
  ---
  duration_ms: 0.127329
  type: 'test'
  ...
# Subtest: SystemMetrics renders dedicated Model ID rows from the shared live-ID helper for llama, vLLM, and ETC cards
ok 4 - SystemMetrics renders dedicated Model ID rows from the shared live-ID helper for llama, vLLM, and ETC cards
  ---
  duration_ms: 1.337787
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 50.462077
```

### Full suite

Command:

```bash
npm test
```

Output:

```text
> dgx-spark-status@0.0.0 test
> node --test test/*.test.js

TAP version 13
# tests 72
# suites 0
# pass 72
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 401.644882
```

### Build verification

Command:

```bash
npm run build
```

Output:

```text
> dgx-spark-status@0.0.0 build
> vite build

vite v7.3.1 building ssr environment for production...
transforming...
6:46:09 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:776:20 Visible, non-interactive elements with a click event must be accompanied by a keyboard event handler. Consider whether an interactive element such as `<button type="button">` or `<a>` might be more appropriate
https://svelte.dev/e/a11y_click_events_have_key_events
774:                     </div>
775:                   {:else}
776:                     <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                               ^
777:                       {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
778:                       <span class="note-edit-icon" title="Edit note">✏️</span>
6:46:09 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:776:20 `<div>` with a click handler must have an ARIA role
https://svelte.dev/e/a11y_no_static_element_interactions
774:                     </div>
775:                   {:else}
776:                     <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                               ^
777:                       {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
778:                       <span class="note-edit-icon" title="Edit note">✏️</span>
6:46:09 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:862:20 Visible, non-interactive elements with a click event must be accompanied by a keyboard event handler. Consider whether an interactive element such as `<button type="button">` or `<a>` might be more appropriate
https://svelte.dev/e/a11y_click_events_have_key_events
860:                     </div>
861:                   {:else}
862:                     <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                               ^
863:                       {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
864:                       <span class="note-edit-icon" title="Edit note">✏️</span>
6:46:09 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:862:20 `<div>` with a click handler must have an ARIA role
https://svelte.dev/e/a11y_no_static_element_interactions
860:                     </div>
861:                   {:else}
862:                     <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                               ^
863:                       {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
864:                       <span class="note-edit-icon" title="Edit note">✏️</span>
6:46:09 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:936:22 Visible, non-interactive elements with a click event must be accompanied by a keyboard event handler. Consider whether an interactive element such as `<button type="button">` or `<a>` might be more appropriate
https://svelte.dev/e/a11y_click_events_have_key_events
934:                       </div>
935:                     {:else}
936:                       <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                                 ^
937:                         {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
938:                         <span class="note-edit-icon" title="Edit note">✏️</span>
6:46:09 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:936:22 `<div>` with a click handler must have an ARIA role
https://svelte.dev/e/a11y_no_static_element_interactions
934:                       </div>
935:                     {:else}
936:                       <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                                 ^
937:                         {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
938:                         <span class="note-edit-icon" title="Edit note">✏️</span>
✓ 204 modules transformed.
rendering chunks...
vite v7.3.1 building client environment for production...
transforming...
6:46:10 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:776:20 Visible, non-interactive elements with a click event must be accompanied by a keyboard event handler. Consider whether an interactive element such as `<button type="button">` or `<a>` might be more appropriate
https://svelte.dev/e/a11y_click_events_have_key_events
774:                     </div>
775:                   {:else}
776:                     <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                               ^
777:                       {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
778:                       <span class="note-edit-icon" title="Edit note">✏️</span>
6:46:10 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:776:20 `<div>` with a click handler must have an ARIA role
https://svelte.dev/e/a11y_no_static_element_interactions
774:                     </div>
775:                   {:else}
776:                     <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                               ^
777:                       {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
778:                       <span class="note-edit-icon" title="Edit note">✏️</span>
6:46:10 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:862:20 Visible, non-interactive elements with a click event must be accompanied by a keyboard event handler. Consider whether an interactive element such as `<button type="button">` or `<a>` might be more appropriate
https://svelte.dev/e/a11y_click_events_have_key_events
860:                     </div>
861:                   {:else}
862:                     <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                               ^
863:                       {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
864:                       <span class="note-edit-icon" title="Edit note">✏️</span>
6:46:10 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:862:20 `<div>` with a click handler must have an ARIA role
https://svelte.dev/e/a11y_no_static_element_interactions
860:                     </div>
861:                   {:else}
862:                     <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                               ^
863:                       {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
864:                       <span class="note-edit-icon" title="Edit note">✏️</span>
6:46:10 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:936:22 Visible, non-interactive elements with a click event must be accompanied by a keyboard event handler. Consider whether an interactive element such as `<button type="button">` or `<a>` might be more appropriate
https://svelte.dev/e/a11y_click_events_have_key_events
934:                       </div>
935:                     {:else}
936:                       <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                                 ^
937:                         {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
938:                         <span class="note-edit-icon" title="Edit note">✏️</span>
6:46:10 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:936:22 `<div>` with a click handler must have an ARIA role
https://svelte.dev/e/a11y_no_static_element_interactions
934:                       </div>
935:                     {:else}
936:                       <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                                 ^
937:                         {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
938:                         <span class="note-edit-icon" title="Edit note">✏️</span>
✓ 162 modules transformed.
rendering chunks...
computing gzip size...
.svelte-kit/output/client/_app/version.json                        0.03 kB │ gzip:  0.05 kB
.svelte-kit/output/client/.vite/manifest.json                      3.08 kB │ gzip:  0.60 kB
.svelte-kit/output/client/_app/immutable/assets/0.BoEVJnPZ.css     0.81 kB │ gzip:  0.46 kB
.svelte-kit/output/client/_app/immutable/assets/2.CXrw4Des.css    24.08 kB │ gzip:  4.91 kB
.svelte-kit/output/client/_app/immutable/chunks/CLD2Ge5n.js        0.03 kB │ gzip:  0.05 kB
.svelte-kit/output/client/_app/immutable/entry/start.BxRkgtug.js   0.08 kB │ gzip:  0.09 kB
.svelte-kit/output/client/_app/immutable/nodes/0.CKo6XDjN.js       0.33 kB │ gzip:  0.25 kB
.svelte-kit/output/client/_app/immutable/chunks/Bt56_tVe.js        0.37 kB │ gzip:  0.26 kB
.svelte-kit/output/client/_app/immutable/nodes/1.DUSOQ4NY.js       1.02 kB │ gzip:  0.58 kB
.svelte-kit/output/client/_app/immutable/chunks/DV5Dk4_J.js        1.39 kB │ gzip:  0.74 kB
.svelte-kit/output/client/_app/immutable/chunks/t2jIknds.js        2.73 kB │ gzip:  1.30 kB
.svelte-kit/output/client/_app/immutable/entry/app.BHEmW50w.js     5.68 kB │ gzip:  2.65 kB
.svelte-kit/output/client/_app/immutable/chunks/QqyJ4F7F.js        5.70 kB │ gzip:  2.59 kB
.svelte-kit/output/client/_app/immutable/chunks/vu83rdnr.js       22.30 kB │ gzip:  8.87 kB
.svelte-kit/output/client/_app/immutable/chunks/1AqpEsEb.js       26.07 kB │ gzip: 10.27 kB
.svelte-kit/output/client/_app/immutable/nodes/2.BeAzJvOe.js      80.83 kB │ gzip: 24.11 kB
✓ built in 622ms
.svelte-kit/output/server/.vite/manifest.json                           3.46 kB
.svelte-kit/output/server/_app/immutable/assets/_layout.BoEVJnPZ.css    0.81 kB
.svelte-kit/output/server/_app/immutable/assets/_page.BrBeDW6N.css     17.83 kB
.svelte-kit/output/server/entries/pages/_layout.svelte.js               0.23 kB
.svelte-kit/output/server/internal.js                                   0.33 kB
.svelte-kit/output/server/chunks/equality.js                            0.33 kB
.svelte-kit/output/server/chunks/environment.js                         0.66 kB
.svelte-kit/output/server/chunks/utils.js                               1.15 kB
.svelte-kit/output/server/entries/fallbacks/error.svelte.js             1.32 kB
.svelte-kit/output/server/entries/pages/_page.svelte.js                 1.50 kB
.svelte-kit/output/server/chunks/context.js                             2.65 kB
.svelte-kit/output/server/entries/hooks.server.js                       3.54 kB
.svelte-kit/output/server/entries/endpoints/api/ollama/_server.js       3.58 kB
.svelte-kit/output/server/chunks/exports.js                             7.04 kB
.svelte-kit/output/server/entries/endpoints/api/metrics/_server.js     12.53 kB
.svelte-kit/output/server/remote-entry.js                              18.96 kB
.svelte-kit/output/server/chunks/shared.js                             25.96 kB
.svelte-kit/output/server/chunks/index.js                              29.77 kB
.svelte-kit/output/server/chunks/internal.js                           78.13 kB
.svelte-kit/output/server/index.js                                    120.28 kB
✓ built in 1.90s

Run npm run preview to preview your production build locally.

> Using @sveltejs/adapter-node
  ✔ done
```

## Concerns

- `npm run build` succeeds, but Vite/Svelte still reports pre-existing accessibility warnings for the clickable `.note-display` `<div>` blocks at lines 776, 862, and 936 in `src/lib/SystemMetrics.svelte`. This task did not change those note controls.

---

## Fix round 1 — full visible IDs plus copy buttons

Implementation commit SHA: `aaebd2d46bb9ed92bdd5652549635e416e610c4a`

Implementation commit message: `Show full model IDs with copy buttons`

### Files changed

- `src/lib/SystemMetrics.svelte`
- `test/model-card-display.test.js`

### Scope summary

- Replaced the labeled/truncated dedicated ID row with a full visible exact ID value plus a visible copy button for LLAMA, vLLM, and ETC cards.
- Kept `modelIdValue(model)` as the dynamic source for all three card types.
- Added browser clipboard copy behavior with a short `Copied` success state and accessible `title`/`aria-label` text on each copy button.
- Removed the dedicated-row visible `Model ID` text and removed truncation/clipping styling from the dedicated ID value.
- Preserved existing card titles, status badges, connection rows, controls, and inventory-only behavior.

### Test/build commands and exact outputs

#### Red run

Command:

```bash
node --test test/model-card-display.test.js
```

Output:

```text
TAP version 13
# Subtest: formats DS4 240K-total context and input/output budgets compactly
ok 1 - formats DS4 240K-total context and input/output budgets compactly
  ---
  duration_ms: 0.373172
  type: 'test'
  ...
# Subtest: modelIdValue returns the exact live API model ID even when the display name matches
ok 2 - modelIdValue returns the exact live API model ID even when the display name matches
  ---
  duration_ms: 0.069761
  type: 'test'
  ...
# Subtest: modelIdValue does not invent an ID from an empty model name
ok 3 - modelIdValue does not invent an ID from an empty model name
  ---
  duration_ms: 0.046289
  type: 'test'
  ...
# Subtest: SystemMetrics renders full model ID rows with copy buttons for llama, vLLM, and ETC cards
not ok 4 - SystemMetrics renders full model ID rows with copy buttons for llama, vLLM, and ETC cards
  ---
  duration_ms: 0.981113
  type: 'test'
  location: '/home/mctdgx01/dgx-spark-status/test/model-card-display.test.js:40:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    0 !== 3

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 3
  actual: 0
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/mctdgx01/dgx-spark-status/test/model-card-display.test.js:45:10)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.processPendingSubtests (node:internal/test_runner/test:744:18)
    Test.postRun (node:internal/test_runner/test:1173:19)
    Test.run (node:internal/test_runner/test:1101:12)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
1..4
# tests 4
# suites 0
# pass 3
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 33.588725
```

#### Focused green run

Command:

```bash
node --test test/model-card-display.test.js
```

Output:

```text
TAP version 13
# Subtest: formats DS4 240K-total context and input/output budgets compactly
ok 1 - formats DS4 240K-total context and input/output budgets compactly
  ---
  duration_ms: 0.384068
  type: 'test'
  ...
# Subtest: modelIdValue returns the exact live API model ID even when the display name matches
ok 2 - modelIdValue returns the exact live API model ID even when the display name matches
  ---
  duration_ms: 0.070688
  type: 'test'
  ...
# Subtest: modelIdValue does not invent an ID from an empty model name
ok 3 - modelIdValue does not invent an ID from an empty model name
  ---
  duration_ms: 0.045568
  type: 'test'
  ...
# Subtest: SystemMetrics renders full model ID rows with copy buttons for llama, vLLM, and ETC cards
ok 4 - SystemMetrics renders full model ID rows with copy buttons for llama, vLLM, and ETC cards
  ---
  duration_ms: 1.090827
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 32.73264
```

#### Full suite

Command:

```bash
npm test
```

Output:

```text
> dgx-spark-status@0.0.0 test
> node --test test/*.test.js

TAP version 13
# tests 72
# suites 0
# pass 72
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 420.45783
```

#### Build verification

Command:

```bash
npm run build
```

Output:

```text
> dgx-spark-status@0.0.0 build
> vite build

vite v7.3.1 building ssr environment for production...
transforming...
6:55:57 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:802:20 Visible, non-interactive elements with a click event must be accompanied by a keyboard event handler. Consider whether an interactive element such as `<button type="button">` or `<a>` might be more appropriate
https://svelte.dev/e/a11y_click_events_have_key_events
800:                     </div>
801:                   {:else}
802:                     <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                               ^
803:                       {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
804:                       <span class="note-edit-icon" title="Edit note">✏️</span>
6:55:57 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:802:20 `<div>` with a click handler must have an ARIA role
https://svelte.dev/e/a11y_no_static_element_interactions
800:                     </div>
801:                   {:else}
802:                     <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                               ^
803:                       {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
804:                       <span class="note-edit-icon" title="Edit note">✏️</span>
6:55:57 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:890:20 Visible, non-interactive elements with a click event must be accompanied by a keyboard event handler. Consider whether an interactive element such as `<button type="button">` or `<a>` might be more appropriate
https://svelte.dev/e/a11y_click_events_have_key_events
888:                     </div>
889:                   {:else}
890:                     <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                               ^
891:                       {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
892:                       <span class="note-edit-icon" title="Edit note">✏️</span>
6:55:57 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:890:20 `<div>` with a click handler must have an ARIA role
https://svelte.dev/e/a11y_no_static_element_interactions
888:                     </div>
889:                   {:else}
890:                     <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                               ^
891:                       {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
892:                       <span class="note-edit-icon" title="Edit note">✏️</span>
6:55:57 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:966:22 Visible, non-interactive elements with a click event must be accompanied by a keyboard event handler. Consider whether an interactive element such as `<button type="button">` or `<a>` might be more appropriate
https://svelte.dev/e/a11y_click_events_have_key_events
964:                       </div>
965:                     {:else}
966:                       <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                                 ^
967:                         {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
968:                         <span class="note-edit-icon" title="Edit note">✏️</span>
6:55:57 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:966:22 `<div>` with a click handler must have an ARIA role
https://svelte.dev/e/a11y_no_static_element_interactions
964:                       </div>
965:                     {:else}
966:                       <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                                 ^
967:                         {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
968:                         <span class="note-edit-icon" title="Edit note">✏️</span>
✓ 204 modules transformed.
rendering chunks...
vite v7.3.1 building client environment for production...
transforming...
6:55:58 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:802:20 Visible, non-interactive elements with a click event must be accompanied by a keyboard event handler. Consider whether an interactive element such as `<button type="button">` or `<a>` might be more appropriate
https://svelte.dev/e/a11y_click_events_have_key_events
800:                     </div>
801:                   {:else}
802:                     <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                               ^
803:                       {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
804:                       <span class="note-edit-icon" title="Edit note">✏️</span>
6:55:58 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:802:20 `<div>` with a click handler must have an ARIA role
https://svelte.dev/e/a11y_no_static_element_interactions
800:                     </div>
801:                   {:else}
802:                     <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                               ^
803:                       {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
804:                       <span class="note-edit-icon" title="Edit note">✏️</span>
6:55:58 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:890:20 Visible, non-interactive elements with a click event must be accompanied by a keyboard event handler. Consider whether an interactive element such as `<button type="button">` or `<a>` might be more appropriate
https://svelte.dev/e/a11y_click_events_have_key_events
888:                     </div>
889:                   {:else}
890:                     <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                               ^
891:                       {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
892:                       <span class="note-edit-icon" title="Edit note">✏️</span>
6:55:58 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:890:20 `<div>` with a click handler must have an ARIA role
https://svelte.dev/e/a11y_no_static_element_interactions
888:                     </div>
889:                   {:else}
890:                     <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                               ^
891:                       {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
892:                       <span class="note-edit-icon" title="Edit note">✏️</span>
6:55:58 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:966:22 Visible, non-interactive elements with a click event must be accompanied by a keyboard event handler. Consider whether an interactive element such as `<button type="button">` or `<a>` might be more appropriate
https://svelte.dev/e/a11y_click_events_have_key_events
964:                       </div>
965:                     {:else}
966:                       <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                                 ^
967:                         {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
968:                         <span class="note-edit-icon" title="Edit note">✏️</span>
6:55:58 PM [vite-plugin-svelte] src/lib/SystemMetrics.svelte:966:22 `<div>` with a click handler must have an ARIA role
https://svelte.dev/e/a11y_no_static_element_interactions
964:                       </div>
965:                     {:else}
966:                       <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                                 ^
967:                         {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
968:                         <span class="note-edit-icon" title="Edit note">✏️</span>
✓ 162 modules transformed.
rendering chunks...
computing gzip size...
.svelte-kit/output/client/_app/version.json                        0.03 kB │ gzip:  0.05 kB
.svelte-kit/output/client/.vite/manifest.json                      3.08 kB │ gzip:  0.60 kB
.svelte-kit/output/client/_app/immutable/assets/0.BoEVJnPZ.css     0.81 kB │ gzip:  0.46 kB
.svelte-kit/output/client/_app/immutable/assets/2.DF4OMjjd.css    24.20 kB │ gzip:  4.92 kB
.svelte-kit/output/client/_app/immutable/chunks/CLD2Ge5n.js        0.03 kB │ gzip:  0.05 kB
.svelte-kit/output/client/_app/immutable/entry/start.CjTvym70.js   0.08 kB │ gzip:  0.09 kB
.svelte-kit/output/client/_app/immutable/nodes/0.CKo6XDjN.js       0.33 kB │ gzip:  0.25 kB
.svelte-kit/output/client/_app/immutable/chunks/Bt56_tVe.js        0.37 kB │ gzip:  0.26 kB
.svelte-kit/output/client/_app/immutable/nodes/1.hAI-axQ8.js       1.02 kB │ gzip:  0.58 kB
.svelte-kit/output/client/_app/immutable/chunks/DV5Dk4_J.js        1.39 kB │ gzip:  0.74 kB
.svelte-kit/output/client/_app/immutable/chunks/t2jIknds.js        2.73 kB │ gzip:  1.30 kB
.svelte-kit/output/client/_app/immutable/entry/app.BcF25zUV.js     5.68 kB │ gzip:  2.65 kB
.svelte-kit/output/client/_app/immutable/chunks/QqyJ4F7F.js        5.70 kB │ gzip:  2.59 kB
.svelte-kit/output/client/_app/immutable/chunks/vu83rdnr.js       22.30 kB │ gzip:  8.87 kB
.svelte-kit/output/client/_app/immutable/chunks/BO2nC581.js       26.07 kB │ gzip: 10.27 kB
.svelte-kit/output/client/_app/immutable/nodes/2.CFBCgZh9.js      81.78 kB │ gzip: 24.42 kB
✓ built in 597ms
.svelte-kit/output/server/.vite/manifest.json                           3.46 kB
.svelte-kit/output/server/_app/immutable/assets/_layout.BoEVJnPZ.css    0.81 kB
.svelte-kit/output/server/_app/immutable/assets/_page.DPFpmw8f.css     17.95 kB
.svelte-kit/output/server/entries/pages/_layout.svelte.js               0.23 kB
.svelte-kit/output/server/internal.js                                   0.33 kB
.svelte-kit/output/server/chunks/equality.js                            0.33 kB
.svelte-kit/output/server/chunks/environment.js                         0.66 kB
.svelte-kit/output/server/chunks/utils.js                               1.15 kB
.svelte-kit/output/server/entries/fallbacks/error.svelte.js             1.32 kB
.svelte-kit/output/server/entries/pages/_page.svelte.js                 1.68 kB
.svelte-kit/output/server/chunks/context.js                             2.65 kB
.svelte-kit/output/server/entries/hooks.server.js                       3.54 kB
.svelte-kit/output/server/entries/endpoints/api/ollama/_server.js       3.58 kB
.svelte-kit/output/server/chunks/exports.js                             7.04 kB
.svelte-kit/output/server/entries/endpoints/api/metrics/_server.js     12.53 kB
.svelte-kit/output/server/remote-entry.js                              18.96 kB
.svelte-kit/output/server/chunks/shared.js                             25.96 kB
.svelte-kit/output/server/chunks/index.js                              29.77 kB
.svelte-kit/output/server/chunks/internal.js                           78.13 kB
.svelte-kit/output/server/index.js                                    120.28 kB
✓ built in 1.79s

Run npm run preview to preview your production build locally.

> Using @sveltejs/adapter-node
  ✔ done
```

### Concerns

- `npm run build` still succeeds with the same pre-existing `note-display` accessibility warnings; only the line numbers moved after this fix.
- Because a committed report file cannot self-contain its own final commit SHA in a single commit, this section is recorded in two steps: the implementation commit below, followed by a report-sync commit that writes that exact SHA into the report without amending history.
