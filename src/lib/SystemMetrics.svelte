<script>
  import { onMount, onDestroy } from 'svelte';
  import { subscribe, getCurrentMetrics, isWebSocketConnected } from './websocket.js';
  import Gauge from './Gauge.svelte';
  import HermesSpotlight from './HermesSpotlight.svelte';
  import { modelBudgetLabel } from '../../model-card-display.js';
  import { buildMemoryDisplay } from '../../memory-display.js';
  import { findModelControlProfile } from '../../model-control-matching.js';
  import { isActiveControlStatus, modelControlStatusLabel, resolveModelDisplayStatus } from '../../model-control-state.js';

  let metrics = $state(null);
  let connected = $state(false);
  let unsubscribe = null;

  // History for sparklines (last 60 data points = 60 seconds)
  const HISTORY_LEN = 60;
  let cpuHistory = $state(Array(HISTORY_LEN).fill(0));
  let gpuHistory = $state(Array(HISTORY_LEN).fill(0));
  let netRxHistory = $state(Array(HISTORY_LEN).fill(0));
  let netTxHistory = $state(Array(HISTORY_LEN).fill(0));
  let modelControls = $state([]);
  let modelControlError = $state('');
  let modelActions = $state({});
  let stopAllAction = $state({});
  let agentProcessActions = $state({ claude: {}, codex: {} });
  let ds4Action = $state({});
  let modelControlTimer = null;
  let graphTopology = $state(null);
  let graphifyError = $state('');
  let graphifyTimer = null;
  let dgxHealth = $state(null);
  let dgxHealthError = $state('');
  let dgxHealthTimer = null;

  const DGX_HEALTH_BASE_PORTS = [9000, 11000];

  function pushHistory(arr, val) {
    const next = [...arr.slice(1), val];
    return next;
  }

  function isWifiNetwork(net) {
    return net?.kind === 'wifi' || String(net?.iface || '').startsWith('wl');
  }

  function selectGraphNetwork(network = []) {
    return network.find(isWifiNetwork) || network.find(n => n.iface === 'all') || network[0];
  }

  function visibleNetworkRows(network = []) {
    return network.filter(n => n.iface !== 'all').slice(0, 4);
  }

  function formatNetworkSpeed(value) {
    return Number(value || 0).toFixed(2);
  }

  function networkName(net) {
    const label = net?.label || net?.kind || 'Network';
    return `${label} ${net?.iface || ''}`.trim();
  }

  onMount(() => {
    loadModelControls();
    loadGraphifyTopology();
    loadDgxHealth();
    modelControlTimer = setInterval(loadModelControls, 15000);
    graphifyTimer = setInterval(loadGraphifyTopology, 5000);
    dgxHealthTimer = setInterval(loadDgxHealth, 5000);
    unsubscribe = subscribe((message) => {
      if (message.type === 'connected') {
        connected = true;
      } else if (message.type === 'disconnected') {
        connected = false;
      } else if (message.type === 'metrics') {
        metrics = message.data;
        cpuHistory = pushHistory(cpuHistory, message.data.cpu?.usage || 0);
        gpuHistory = pushHistory(gpuHistory, message.data.gpu?.[0]?.utilizationGpu || 0);
        const net = selectGraphNetwork(message.data.network || []);
        netRxHistory = pushHistory(netRxHistory, net?.rx_sec_mb || 0);
        netTxHistory = pushHistory(netTxHistory, net?.tx_sec_mb || 0);
      }
    });
    metrics = getCurrentMetrics();
    connected = isWebSocketConnected();
  });

  onDestroy(() => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (modelControlTimer) { clearInterval(modelControlTimer); modelControlTimer = null; }
    if (graphifyTimer) { clearInterval(graphifyTimer); graphifyTimer = null; }
    if (dgxHealthTimer) { clearInterval(dgxHealthTimer); dgxHealthTimer = null; }
  });

  async function loadModelControls() {
    try {
      const res = await fetch('/api/model-control/list');
      const data = await res.json();
      if (!data.ok) throw new Error(data.message || 'Model control list failed');
      modelControls = data.profiles || [];
      modelActions = Object.fromEntries(
        Object.entries(modelActions).map(([profileId, state]) => [
          profileId,
          state?.busy ? state : {}
        ]).filter(([, state]) => state?.busy)
      );
      modelControlError = '';
    } catch (error) {
      modelControlError = error.message || 'Model control unavailable';
    }
  }

  async function loadGraphifyTopology() {
    try {
      const res = await fetch('/api/graphify/topology');
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.message || 'Graphify topology failed');
      graphTopology = data;
      graphifyError = '';
    } catch (error) {
      graphifyError = error.message || 'Graphify unavailable';
    }
  }

  async function loadDgxHealth() {
    try {
      const res = await fetch('/api/dgx-health/latest');
      const data = await res.json();
      dgxHealth = data;
      dgxHealthError = !res.ok || data.ok === false ? (data.error || 'DGX health unavailable') : '';
    } catch (error) {
      dgxHealth = null;
      dgxHealthError = error.message || 'DGX health unavailable';
    }
  }

  function controlForModel(model, runtimeModel, displayPort) {
    return findModelControlProfile(model, runtimeModel, displayPort, modelControls);
  }

  function actionState(profileId) {
    return modelActions[profileId] || {};
  }

  function controlDisabledLabel(control) {
    if (!control?.control_enabled) return 'Inventory Only';
    return control?.status || 'Unavailable';
  }

  function controlErrorMessage(state) {
    if (!state?.error) return '';
    if (state.code === 'busy') {
      return 'Another model action is still finishing. Try again in a moment.';
    }
    if (state.code === 'FAILED_RAM_GUARD' || /available RAM dropped below/i.test(state.error)) {
      return 'Start aborted: available RAM dropped below 10GB. Model was stopped automatically.';
    }
    return state.error;
  }

  function isDs4Model(model) {
    return model?.source === 'ds4-dwarfstar' || model?.runtime === 'ds4';
  }

  function ds4StatusLabel(model) {
    const status = model?.ds4Status || {};
    if (status.running) return `RUNNING :${status.port || 8889}`;
    if (status.port_listening) return `LOADING :${status.port || 8889}`;
    return 'stopped';
  }

  function ds4MetaLine(model) {
    const status = model?.ds4Status || {};
    const mem = Number(status.mem_available_gb);
    const nvrm = status.nvrm_delta;
    return [
      status.models_http_status ? `/v1/models ${status.models_http_status}` : null,
      Number.isFinite(mem) ? `MemAvailable ${mem.toFixed(1)} GiB` : null,
      Number.isFinite(Number(nvrm)) ? `NVRM delta ${nvrm}` : null,
      status.localhost_only === false ? `bind ${status.listener_host || status.bind_scope || 'non-localhost'}` : null
    ].filter(Boolean).join(' · ');
  }

  async function runDs4Action(action) {
    ds4Action = { busy: true, verb: action };
    try {
      const endpoint = action === 'status' ? '/api/ds4/status' : `/api/ds4/${action}`;
      const res = await fetch(endpoint, { method: action === 'status' ? 'GET' : 'POST' });
      const data = await res.json();
      if (!data.ok) throw Object.assign(new Error(data.message || `${action} failed`), { code: data.code });
      const detail = action === 'status'
        ? data.status
        : (data.status || data.action || action);
      ds4Action = { busy: false, message: detail, detail: data };
    } catch (error) {
      ds4Action = { busy: false, code: error.code, error: error.message || `${action} failed` };
    }
  }

  async function refreshModelStatus(profileId) {
    modelActions = { ...modelActions, [profileId]: { busy: true, verb: 'status' } };
    try {
      const res = await fetch(`/api/model-control/status/${profileId}`);
      const data = await res.json();
      if (!data.ok) throw Object.assign(new Error(data.message || 'Status failed'), { code: data.code });
      modelControls = modelControls.map(profile => profile.profile_id === profileId ? { ...profile, ...data } : profile);
      modelActions = { ...modelActions, [profileId]: { busy: false, message: data.status } };
    } catch (error) {
      modelActions = { ...modelActions, [profileId]: { busy: false, code: error.code, error: error.message || 'Status failed' } };
    }
  }

  async function runModelAction(profileId, action) {
    modelActions = { ...modelActions, [profileId]: { busy: true, verb: action } };
    try {
      const res = await fetch(`/api/model-control/${action}/${profileId}`, { method: 'POST' });
      const data = await res.json();
      if (!data.ok) throw Object.assign(new Error(data.message || `${action} failed`), { code: data.code });
      modelActions = { ...modelActions, [profileId]: { busy: false, message: data.status || action } };
      await loadModelControls();
    } catch (error) {
      modelActions = { ...modelActions, [profileId]: { busy: false, code: error.code, error: error.message || `${action} failed` } };
      await loadModelControls();
    }
  }

  async function runStopAllModels() {
    if (!window.confirm('Stop all Dashboard-managed models that are currently running?')) return;
    stopAllAction = { busy: true };
    try {
      const res = await fetch('/api/model-control/stop-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'KILL_ALL_MODELS' })
      });
      const data = await res.json();
      if (!data.ok) {
        const detail = data.failures?.map(item => `${item.profile_id}: ${item.message}`).join(' · ');
        throw new Error(detail || data.message || 'Kill all models failed');
      }
      const count = data.stopped?.length || 0;
      stopAllAction = { busy: false, message: count ? `Stopped ${count} model preset${count === 1 ? '' : 's'}` : 'All models already stopped' };
      await loadModelControls();
    } catch (error) {
      stopAllAction = { busy: false, error: error.message || 'Kill all models failed' };
      await loadModelControls();
    }
  }

  const agentProcessConfirmations = Object.freeze({ claude: 'STOP_CLAUDE', codex: 'STOP_CODEX' });
  const agentProcessLabels = Object.freeze({ claude: 'Claude', codex: 'Codex' });

  async function stopAgentFamily(family) {
    const label = agentProcessLabels[family];
    const confirmToken = agentProcessConfirmations[family];
    if (!label || !confirmToken) return;
    if (!window.confirm(`ปิด ${label} ทุก process ที่กำลังทำงานอยู่หรือไม่? session ของ ${label} จะถูกขัดจังหวะ`)) return;

    agentProcessActions = { ...agentProcessActions, [family]: { busy: true, verb: 'stop' } };
    try {
      const res = await fetch(`/api/process-control/stop/${family}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: confirmToken })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        const detail = data.failures?.map(item => `PID ${item.pid}: ${item.code}`).join(' · ');
        throw new Error(detail || data.message || `ปิด ${label} ไม่สำเร็จ`);
      }
      const stopped = data.stopped?.length || 0;
      const alreadyExited = data.alreadyExited?.length || 0;
      const total = stopped + alreadyExited;
      agentProcessActions = {
        ...agentProcessActions,
        [family]: {
          busy: false,
          message: total ? `ปิด ${label} แล้ว ${total} process` : `ไม่พบ ${label} process ที่กำลังทำงาน`
        }
      };
    } catch (error) {
      agentProcessActions = {
        ...agentProcessActions,
        [family]: { busy: false, error: error.message || `ปิด ${label} ไม่สำเร็จ` }
      };
    }
  }

  // Notes
  let editingNote = $state(null);
  let noteInput = $state('');

  function startEditNote(modelId, currentNote) {
    editingNote = modelId;
    noteInput = currentNote || '';
  }

  async function saveNote(modelId) {
    await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, note: noteInput })
    });
    editingNote = null;
  }

  function cancelEdit() { editingNote = null; }

  function getNote(modelId) {
    return metrics?.modelNotes?.[modelId] || '';
  }

  // Sparkline path generator
  function sparklinePath(data, w, h) {
    if (!data || data.length === 0) return '';
    const max = Math.max(...data, 1);
    const step = w / (data.length - 1);
    return data.map((v, i) => {
      const x = i * step;
      const y = h - (v / max) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }

  function sparklineArea(data, w, h) {
    const path = sparklinePath(data, w, h);
    if (!path) return '';
    return path + ` L${w},${h} L0,${h} Z`;
  }

  function formatBytes(bytes) {
    return (bytes / (1024 ** 3)).toFixed(2);
  }

  function getModelStatusRank(model) {
    const status = String(model?.status || '').toLowerCase();
    if (model?.running || status === 'running') return 0;
    if (status === 'loading' || status === 'starting') return 1;
    if (status === 'stopped') return 2;
    if (status === 'installed' || status === 'inventory' || status === 'inventory-only' || model?.inventoryOnly) return 3;
    return 4;
  }

  function getModelPort(model) {
    const port = Number(model?.port || model?.proxyPort || 0);
    return Number.isFinite(port) && port > 0 ? port : Number.MAX_SAFE_INTEGER;
  }

  function getModelName(model) {
    return String(model?.name || model?.model || model?.key || model?.id || '').toLowerCase();
  }

  function displayModelName(model) {
    return model?.displayName || model?.modelName || model?.name || model?.key || model?.id || 'unknown model';
  }

  function displayModelId(model) {
    return model?.apiModel || model?.servedModelName || model?.modelAlias || model?.name || model?.key || '';
  }

  function modelFunctionLabel(model, fallbackRuntime) {
    if (model?.functionLabel) return model.functionLabel;
    const runtime = String(model?.runtime || fallbackRuntime || '').toLowerCase();
    if (runtime === 'llama' || runtime.includes('llama.cpp') || runtime.includes('llama-cpp')) return 'Plain GGUF · OpenAI-compatible API';
    if (runtime === 'vllm') return 'vLLM OpenAI-compatible API';
    return runtime ? `${runtime} API` : '';
  }

  function modelConnectionLabel(model, runtimeModel, fallbackPort) {
    if (model?.connectionLabel) return model.connectionLabel;
    const port = runtimeModel?.port || model?.port || fallbackPort;
    const ctx = model?.ctx || runtimeModel?.ctxSize;
    const ctxLabel = ctx ? `ctx ${(ctx / 1024).toFixed(0)}K` : '';
    return [port ? `:${port}` : '', ctxLabel].filter(Boolean).join(' · ');
  }

  function sortModelsForDisplay(models) {
    return [...(models || [])].sort((a, b) => {
      const rankDiff = getModelStatusRank(a) - getModelStatusRank(b);
      if (rankDiff !== 0) return rankDiff;
      if (getModelStatusRank(a) === 0) {
        const portDiff = getModelPort(a) - getModelPort(b);
        if (portDiff !== 0) return portDiff;
      }
      return getModelName(a).localeCompare(getModelName(b));
    });
  }

  function graphNodes(type) {
    return (graphTopology?.nodes || []).filter(node => node.type === type);
  }

  function graphRuntimes() {
    return graphNodes('runtime').sort((a, b) => Number(a.port || 0) - Number(b.port || 0));
  }

  function graphHealthNodes() {
    return [...graphNodes('health'), ...graphNodes('network')];
  }

  function graphHealthPorts() {
    return graphNodes('health_port').sort((a, b) => Number(a.port || 0) - Number(b.port || 0));
  }

  function graphNode(id) {
    return (graphTopology?.nodes || []).find(node => node.id === id);
  }

  function graphStatusClass(status) {
    const value = String(status || 'unknown').toLowerCase();
    if (value === 'running') return 'running';
    if (value === 'loading' || value === 'starting') return 'loading';
    if (value === 'stopped') return 'stopped';
    return 'unknown';
  }

  function graphRuntimeY(index) {
    return 44 + (index * 44);
  }

  function compactGraphLabel(label, max = 28) {
    const value = String(label || '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function healthLatest() {
    return dgxHealth?.latest || null;
  }

  function dgxHealthPorts() {
    const snapshotPorts = Object.keys(healthLatest()?.listening_ports?.ports || {}).map(Number);
    const topologyPorts = graphNodes('runtime').map(node => Number(node.port));
    return [...new Set([...DGX_HEALTH_BASE_PORTS, ...snapshotPorts, ...topologyPorts])]
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
  }

  function healthAgeSeconds() {
    const value = Number(dgxHealth?.age_seconds);
    return Number.isFinite(value) ? value : null;
  }

  function formatHealthAge(seconds) {
    if (!Number.isFinite(seconds)) return 'unknown';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return `${minutes}m ${remaining}s`;
  }

  function healthStatuses() {
    const statuses = [...(healthLatest()?.status || [])];
    const age = healthAgeSeconds();
    if (Number.isFinite(age) && age > 180 && !statuses.includes('STALE_SNAPSHOT')) {
      statuses.push('STALE_SNAPSHOT');
    }
    return statuses.length ? statuses : ['OK'];
  }

  function healthBadgeClass(status) {
    const value = String(status || '').toLowerCase();
    if (value === 'ok') return 'running';
    if (value.includes('emergency') || value.includes('block')) return 'stopped';
    if (value.includes('warn') || value.includes('stale') || value.includes('gpu_memory')) return 'loading';
    return 'unknown';
  }

  function memAvailableGiB() {
    const value = Number(healthLatest()?.memory?.memavailable_gib);
    return Number.isFinite(value) ? `${value.toFixed(1)} GiB` : 'unknown';
  }

  function defaultRoute() {
    return healthLatest()?.routes?.default_route || {};
  }

  function activeOutputPath() {
    const route = defaultRoute();
    const dev = String(route.dev || '');
    const raw = String(route.raw || '');
    if (dev === 'enP7s7') return 'enP7s7 LAN';
    if (dev === 'wlP9s9') return 'wlP9s9 Wi-Fi True/legacy';
    if (dev.startsWith('tailscale')) return `${dev} Tailscale`;
    if (raw.includes('192.168.5.1')) return 'Wi-Fi True/legacy';
    if (dev) return `${dev} unknown`;
    return 'unknown';
  }

  function healthInterfaces() {
    return (healthLatest()?.interfaces?.classified || [])
      .filter(iface => ['enP7s7', 'wlP9s9', 'tailscale0'].includes(iface.name))
      .slice(0, 4);
  }

  function interfaceSummary(iface) {
    return (iface?.addresses || [])
      .map(item => `${item.address} ${item.classification}`)
      .join(' / ');
  }

  function listeningCount(port) {
    const rows = healthLatest()?.listening_ports?.ports?.[String(port)];
    return Array.isArray(rows) ? rows.length : 0;
  }

  function endpointProbe(port) {
    const key = Number(port) === 9000 ? 'dashboard_loopback' : String(port);
    const entry = healthLatest()?.endpoint_health?.[key] || {};
    return entry.models_endpoint || entry.probe || entry;
  }

  function endpointStatus(port) {
    const probe = endpointProbe(port);
    if (probe?.ok) return probe.http_code ? `OK ${probe.http_code}` : 'OK';
    if (listeningCount(port) > 0) return 'listening';
    return 'inactive';
  }

  function portClass(port) {
    if (endpointProbe(port)?.ok || listeningCount(port) > 0) return 'running';
    return 'unknown';
  }

  function healthMessages() {
    const latest = healthLatest();
    if (!latest) return [];
    const messages = [];
    if (healthStatuses().includes('STALE_SNAPSHOT')) messages.push('Snapshot is older than 180 seconds.');
    if (latest.journal?.permission_limited) messages.push('Journal access is permission limited.');
    if (latest.status?.includes('GPU_MEMORY_WARNING')) messages.push('Readable logs contain NVIDIA/NVRM/Xid memory warning evidence.');
    if (latest.status?.includes('MODEL_INITIALIZING')) messages.push('Model process detected; its API is still initializing.');
    if (messages.length === 0) messages.push('No dashboard-level health alerts beyond the recorded snapshot status.');
    return messages;
  }
</script>

<div class="dashboard">
  <div class="header">
    <div class="header-left">
      <h1>DGX Spark Status</h1>
      <div class="system-name">{metrics?.system.hostname || 'Loading...'}</div>
      {#if metrics?.uptime}
        <div class="uptime">
          Uptime: {metrics.uptime.days}d {metrics.uptime.hours}h {metrics.uptime.minutes}m
        </div>
      {/if}
    </div>
    <div class="status {connected ? 'connected' : 'disconnected'}">
      {connected ? '● Live' : '○ Disconnected'}
    </div>
  </div>

  {#if metrics}
    <!-- Row 1: CPU, GPU, Memory, Disk — all compact in one row -->
    <div class="stats-row">
      <!-- CPU -->
      <div class="card stat-card">
        <div class="stat-top">
          <Gauge value={metrics.cpu.usage.toFixed(0)} max={100} color="#76b900" label="%" size={56} thickness={5} />
          <div class="stat-info">
            <h2>CPU</h2>
            <div class="stat-detail">{metrics.cpu.physicalCores}C/{metrics.cpu.cores}T {metrics.cpu.speed}GHz</div>
          </div>
        </div>
        <div class="sparkline-container">
          <svg viewBox="0 0 120 28" preserveAspectRatio="none" class="sparkline">
            <path d={sparklineArea(cpuHistory, 120, 28)} fill="rgba(118,185,0,0.15)" />
            <path d={sparklinePath(cpuHistory, 120, 28)} fill="none" stroke="#76b900" stroke-width="1.5" />
          </svg>
        </div>
        <div class="agent-process-controls" aria-label="Claude and Codex process controls">
          <button class="control-btn stop agent-process-stop" disabled={agentProcessActions.claude?.busy} onclick={() => stopAgentFamily('claude')}>
            {agentProcessActions.claude?.busy ? 'กำลังปิด Claude…' : 'ปิด Claude'}
          </button>
          <button class="control-btn stop agent-process-stop" disabled={agentProcessActions.codex?.busy} onclick={() => stopAgentFamily('codex')}>
            {agentProcessActions.codex?.busy ? 'กำลังปิด Codex…' : 'ปิด Codex'}
          </button>
        </div>
        {#if agentProcessActions.claude?.message}<div class="control-message agent-process-feedback">Claude · {agentProcessActions.claude.message}</div>{/if}
        {#if agentProcessActions.claude?.error}<div class="control-error agent-process-feedback">Claude · {agentProcessActions.claude.error}</div>{/if}
        {#if agentProcessActions.codex?.message}<div class="control-message agent-process-feedback">Codex · {agentProcessActions.codex.message}</div>{/if}
        {#if agentProcessActions.codex?.error}<div class="control-error agent-process-feedback">Codex · {agentProcessActions.codex.error}</div>{/if}
      </div>

      <!-- GPU -->
      {#if metrics.gpu && metrics.gpu.length > 0}
        {@const gpu = metrics.gpu[0]}
        <div class="card stat-card">
          <div class="stat-top">
            <Gauge value={gpu.utilizationGpu ?? 0} max={100} color="#ff9800" label="%" size={56} thickness={5} />
            <div class="stat-info">
              <h2>GPU</h2>
              <div class="stat-detail">
                {#if gpu.temperatureGpu}{gpu.temperatureGpu}°C{/if}
                {#if gpu.powerDraw !== null} • {gpu.powerDraw}W{/if}
              </div>
              <div class="gpu-memory-detail">
                CUDA allocation: {((gpu.computeMemoryUsedMB ?? 0) / 1024).toFixed(1)}G
                {#if gpu.unifiedMemory} · unified memory{/if}
              </div>
            </div>
          </div>
          <div class="sparkline-container">
            <svg viewBox="0 0 120 28" preserveAspectRatio="none" class="sparkline">
              <path d={sparklineArea(gpuHistory, 120, 28)} fill="rgba(255,152,0,0.15)" />
              <path d={sparklinePath(gpuHistory, 120, 28)} fill="none" stroke="#ff9800" stroke-width="1.5" />
            </svg>
          </div>
        </div>
      {/if}

      <!-- Unified Memory -->
      {#if metrics.processes}
        {@const memoryDisplay = buildMemoryDisplay(metrics.memory, metrics.processes, metrics.gpu)}
        <div class="card stat-card">
          <div class="stat-top">
            <div class="stat-info" style="width:100%">
              <h2>Memory</h2>
              <div class="mem-total-compact">{memoryDisplay.usedGB.toFixed(1)} / {memoryDisplay.totalGB.toFixed(2)} GB active (cache excluded)</div>
            </div>
          </div>
          <div class="mem-bar-container">
            <div class="mem-bar">
              <div class="mem-bar-gpu" style="width: {memoryDisplay.gpuPercent}%"></div>
              <div class="mem-bar-other" style="width: {memoryDisplay.otherPercent}%"></div>
              <div class="mem-bar-cache" style="width: {memoryDisplay.cachePercent}%"></div>
              <div class="mem-bar-free" style="width: {memoryDisplay.freePercent}%"></div>
            </div>
          </div>
          <div class="mem-legend-compact">
            <span><span class="mem-dot gpu"></span>GPU alloc {memoryDisplay.gpuMemoryGB.toFixed(1)}G</span>
            <span><span class="mem-dot os"></span>Model RSS* {memoryDisplay.processRssGB.toFixed(0)}G</span>
            <span><span class="mem-dot other"></span>Active other {memoryDisplay.otherUsedGB.toFixed(1)}G</span>
            <span><span class="mem-dot cache"></span>Cache {memoryDisplay.cacheGB.toFixed(1)}G</span>
            <span><span class="mem-dot free"></span>Free {memoryDisplay.freeGB.toFixed(1)}G</span>
          </div>
          <div class="mem-availability">Available / RAMguard headroom: {memoryDisplay.availableGB.toFixed(1)}G</div>
          <div class="mem-availability">*Model RSS includes file-backed GGUF pages and is not additive to GPU/cache.</div>
          <button class="kill-all-models" disabled={stopAllAction.busy} onclick={runStopAllModels}>
            {stopAllAction.busy ? 'Stopping all models…' : 'Kill All Models'}
          </button>
          {#if stopAllAction.message}<div class="kill-all-message">{stopAllAction.message}</div>{/if}
          {#if stopAllAction.error}<div class="kill-all-error">{stopAllAction.error}</div>{/if}
        </div>
      {/if}

      <!-- Disk -->
      {#if metrics.disk}
        {@const disk = metrics.disk.find(d => d.mount === '/') || metrics.disk[0]}
        <div class="card stat-card">
          <div class="stat-top">
            <div class="stat-info" style="width:100%">
              <h2>Storage</h2>
              <div class="mem-total-compact">{disk.usedGB} / {disk.sizeGB} {disk.unit || 'GB'}</div>
            </div>
          </div>
          <div class="mem-bar-container">
            <div class="mem-bar">
              <div class="mem-bar-disk" style="width: {disk.usagePercent}%"></div>
            </div>
          </div>
          <div class="mem-legend-compact">
            <span><span class="mem-dot disk"></span>Used {disk.usagePercent}%</span>
            <span><span class="mem-dot free"></span>Free {disk.availableGB} {disk.unit || 'GB'}</span>
          </div>
        </div>
      {/if}

      <!-- Network -->
      {#if metrics.network && metrics.network.length > 0}
        {@const net = selectGraphNetwork(metrics.network)}
        {@const totalNet = metrics.network.find(n => n.iface === 'all') || net}
        {@const networkRows = visibleNetworkRows(metrics.network)}
        <div class="card stat-card">
          <div class="stat-top">
            <div class="stat-info" style="width:100%">
              <h2>Network</h2>
              <div class="net-stats">
                <span class="net-name">Total</span>
                <span class="net-rx">↓ {formatNetworkSpeed(totalNet.rx_sec_mb)} MB/s</span>
                <span class="net-tx">↑ {formatNetworkSpeed(totalNet.tx_sec_mb)} MB/s</span>
              </div>
            </div>
          </div>
          <div class="network-interfaces">
            {#each networkRows as row}
              <div class:network-active={row.iface === net.iface} class="network-interface" title={networkName(row)}>
                <span class="net-name">{networkName(row)}</span>
                <span class="net-flow">
                  <span class="net-rx">↓ {formatNetworkSpeed(row.rx_sec_mb)}</span>
                  <span class="net-tx">↑ {formatNetworkSpeed(row.tx_sec_mb)}</span>
                </span>
              </div>
            {/each}
          </div>
          <div class="sparkline-container">
            <svg viewBox="0 0 120 28" preserveAspectRatio="none" class="sparkline">
              <path d={sparklineArea(netRxHistory, 120, 28)} fill="rgba(0,212,255,0.1)" />
              <path d={sparklinePath(netRxHistory, 120, 28)} fill="none" stroke="#00d4ff" stroke-width="1.5" />
              <path d={sparklinePath(netTxHistory, 120, 28)} fill="none" stroke="#76b900" stroke-width="1" opacity="0.6" />
            </svg>
          </div>
        </div>
      {/if}
    </div>

    <!-- Row 2: All Models side by side -->
    {#if metrics.inference}
      <div class="models-row">
        <!-- llama.cpp -->
        <div class="card models-card">
          <h2>llama.cpp
            {#if metrics.inference.llama.status === 'running'}
              <span class="engine-status running">● Ready to Use (:{metrics.inference.llama.proxyPort})</span>
            {:else if metrics.inference.llama.status === 'loading'}
              <span class="engine-status loading">◐ loading :{metrics.inference.llama.port}</span>
            {:else}
              <span class="engine-status stopped">○ stopped</span>
            {/if}
          </h2>
          <div class="models-list">
	            {#if metrics.inference.availableModels?.llama}
	              {#each sortModelsForDisplay(metrics.inference.availableModels.llama) as model}
	                {@const runtimeModel = metrics.inference.llama.models?.find(r => (model.port && r.port && Number(model.port) === Number(r.port)) || (model.name && r.name && model.name === r.name) || (model.name && r.modelAlias && model.name === r.modelAlias) || (model.apiModel && r.modelAlias && model.apiModel === r.modelAlias)) || model}
                  {@const displayPort = runtimeModel?.port || model.port || metrics.inference.llama.port}
                  {@const control = controlForModel(model, runtimeModel, displayPort)}
                  {@const effectiveStatus = resolveModelDisplayStatus(control?.status, runtimeModel?.status, model.status)}
	                {@const isRunning = isActiveControlStatus(effectiveStatus)}
                  {@const controlState = control ? actionState(control.profile_id) : {}}
	                {@const noteId = `llama:${model.key || model.name}`}
                <div class="model-item {isRunning ? 'loaded' : ''}">
                  <div class="model-header-row">
                    <div class="model-title-wrap">
                      <div class="model-name" title={displayModelName(model)}>{displayModelName(model)}</div>
                      {#if displayModelId(model) && displayModelId(model) !== displayModelName(model)}
                        <div class="model-id" title={displayModelId(model)}>{displayModelId(model)}</div>
                      {/if}
                    </div>
	                    {#if isRunning}<span class="running-badge" class:degraded-badge={effectiveStatus === 'degraded_resident'}>{modelControlStatusLabel(effectiveStatus)}{#if displayPort} (:{displayPort}){/if}</span>{/if}
                  </div>
                  <div class="model-function">
                    {#if modelFunctionLabel(model, 'llama')}<span>{modelFunctionLabel(model, 'llama')}</span>{/if}
                    {#if modelConnectionLabel(model, runtimeModel, displayPort)}<span>{modelConnectionLabel(model, runtimeModel, displayPort)}</span>{/if}
                  </div>
                  <div class="model-info">
                    {#if model.sizeGB}<span class="model-size">{model.sizeGB} GB</span>{/if}
                    {#if isRunning && metrics.inference.llama.quantFormat}<span class="model-quant">{metrics.inference.llama.quantFormat}</span>{/if}
                    {#if isRunning && metrics.inference.llama.paramSize}<span class="model-params">{metrics.inference.llama.paramSize}</span>{/if}
                    {#if model.ctx}<span class="model-params">{modelBudgetLabel(model)}</span>{/if}
                    {#if isRunning && metrics.inference.llama.ctxSize}<span class="model-params active-ctx">active: {(metrics.inference.llama.ctxSize / 1024).toFixed(0)}K</span>{/if}
                  </div>
                  {#if control}
                    <div class="model-control">
                      <button class="control-btn secondary" disabled={(controlState.busy && controlState.verb === 'status') || !control.control_enabled} onclick={() => refreshModelStatus(control.profile_id)}>Status</button>
                      {#if !control.control_enabled}
                        <button class="control-btn secondary" disabled>{controlDisabledLabel(control)}</button>
                      {:else if isActiveControlStatus(control.status)}
                        <button class="control-btn stop" disabled={controlState.busy} onclick={() => runModelAction(control.profile_id, 'stop')}>{controlState.busy && controlState.verb === 'stop' ? 'Stopping' : 'Stop Model'}</button>
                      {:else if control.status === 'stopped'}
                        <button class="control-btn start" disabled={controlState.busy} onclick={() => runModelAction(control.profile_id, 'start')}>{controlState.busy && controlState.verb === 'start' ? 'Starting' : 'Start Model'}</button>
                      {:else}
                        <button class="control-btn secondary" disabled>{control.status || 'loading'}</button>
                      {/if}
                    </div>
                    {#if controlState.message}<div class="control-message">{controlState.message}</div>{/if}
                    {#if controlState.error}<div class="control-error">{controlErrorMessage(controlState)}</div>{/if}
                  {/if}
                  {#if editingNote === noteId}
                    <div class="note-edit">
                      <textarea bind:value={noteInput} placeholder="Add note..." rows="2" onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveNote(noteId); } if (e.key === 'Escape') cancelEdit(); }}></textarea>
                      <div class="note-actions">
                        <button class="note-btn save" onclick={() => saveNote(noteId)}>Save</button>
                        <button class="note-btn cancel" onclick={cancelEdit}>Cancel</button>
                      </div>
                    </div>
                  {:else}
                    <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                      {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
                      <span class="note-edit-icon" title="Edit note">✏️</span>
                    </div>
                  {/if}
                </div>
              {/each}
            {/if}
          </div>
        </div>

        <!-- vLLM -->
        <div class="card models-card">
          <h2>vLLM
            {#if metrics.inference.vllm.status === 'running'}
              <span class="engine-status running">● running</span>
            {:else if metrics.inference.vllm.status === 'loading' || metrics.inference.vllm.status === 'starting'}
              <span class="engine-status loading">◐ {metrics.inference.vllm.status}</span>
            {:else}
              <span class="engine-status stopped">○ stopped</span>
            {/if}
          </h2>
          <div class="models-list">
            {#if metrics.inference.availableModels?.vllm && metrics.inference.availableModels.vllm.length > 0}
              {#each sortModelsForDisplay(metrics.inference.availableModels.vllm) as model}
                {@const runtimeModel = metrics.inference.vllm.models?.find(r => (model.port && r.port && Number(model.port) === Number(r.port)) || (model.name && r.name && model.name === r.name) || (model.name && r.modelAlias && model.name === r.modelAlias) || (model.apiModel && r.modelAlias && model.apiModel === r.modelAlias))}
                {@const displayPort = runtimeModel?.port || model.port}
                {@const control = controlForModel(model, runtimeModel, displayPort)}
                {@const effectiveStatus = resolveModelDisplayStatus(control?.status, runtimeModel?.status, model.status, (metrics.inference.vllm.status !== 'stopped' && metrics.inference.vllm.model && model.name.includes(metrics.inference.vllm.model)) ? metrics.inference.vllm.status : null)}
                {@const isRunning = isActiveControlStatus(effectiveStatus)}
                {@const controlState = control ? actionState(control.profile_id) : {}}
                {@const noteId = `vllm:${model.name}`}
                <div class="model-item {isRunning ? 'loaded' : ''}">
                  <div class="model-header-row">
                    <div class="model-title-wrap">
                      <div class="model-name" title={displayModelName(model)}>{displayModelName(model)}</div>
                      {#if displayModelId(model) && displayModelId(model) !== displayModelName(model)}
                        <div class="model-id" title={displayModelId(model)}>{displayModelId(model)}</div>
                      {/if}
                    </div>
                    {#if isRunning}<span class="running-badge" class:degraded-badge={effectiveStatus === 'degraded_resident'}>{modelControlStatusLabel(effectiveStatus)}{#if displayPort} :{displayPort}{/if}</span>{/if}
                  </div>
                  <div class="model-function">
                    {#if modelFunctionLabel(model, 'vllm')}<span>{modelFunctionLabel(model, 'vllm')}</span>{/if}
                    {#if modelConnectionLabel(model, runtimeModel, displayPort)}<span>{modelConnectionLabel(model, runtimeModel, displayPort)}</span>{/if}
                  </div>
                  <div class="model-info">
                    <span class="model-size">{model.sizeGB} GB</span>
                    <span class="model-params">{model.name?.split('/')?.[0]}</span>
                  </div>
                  {#if control?.runtime_details}
                    <div class="model-runtime-details">
                      <div><strong>Backend</strong> {control.runtime_details.backend}{#if control.runtime_details.attention} · Attention {control.runtime_details.attention}{/if}</div>
                      <div><strong>MTP</strong> {control.runtime_details.mtp}{#if control.runtime_details.architecture} · CUTE DSL {control.runtime_details.architecture}{/if}{#if control.runtime_details.context} · ctx {control.runtime_details.context}{/if}</div>
                      {#if control.runtime_details.stack}<div class="runtime-stack">{control.runtime_details.stack}</div>{/if}
                      {#if control.runtime_details.apiAliasNote}<div class="runtime-alias-note">{control.runtime_details.apiAliasNote}</div>{/if}
                    </div>
                  {/if}
                  {#if control}
                    <div class="model-control">
                      <button class="control-btn secondary" disabled={(controlState.busy && controlState.verb === 'status') || !control.control_enabled} onclick={() => refreshModelStatus(control.profile_id)}>Status</button>
                      {#if !control.control_enabled}
                        <button class="control-btn secondary" disabled>{controlDisabledLabel(control)}</button>
                      {:else if isActiveControlStatus(control.status)}
                        <button class="control-btn stop" disabled={controlState.busy} onclick={() => runModelAction(control.profile_id, 'stop')}>{controlState.busy && controlState.verb === 'stop' ? 'Stopping' : 'Stop Model'}</button>
                      {:else if control.status === 'stopped'}
                        <button class="control-btn start" disabled={controlState.busy} onclick={() => runModelAction(control.profile_id, 'start')}>{controlState.busy && controlState.verb === 'start' ? 'Starting' : 'Start Model'}</button>
                      {:else}
                        <button class="control-btn secondary" disabled>{control.status || 'loading'}</button>
                      {/if}
                    </div>
                    {#if controlState.message}<div class="control-message">{controlState.message}</div>{/if}
                    {#if controlState.error}<div class="control-error">{controlErrorMessage(controlState)}</div>{/if}
                  {/if}
                  {#if editingNote === noteId}
                    <div class="note-edit">
                      <textarea bind:value={noteInput} placeholder="Add note..." rows="2" onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveNote(noteId); } if (e.key === 'Escape') cancelEdit(); }}></textarea>
                      <div class="note-actions">
                        <button class="note-btn save" onclick={() => saveNote(noteId)}>Save</button>
                        <button class="note-btn cancel" onclick={cancelEdit}>Cancel</button>
                      </div>
                    </div>
                  {:else}
                    <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                      {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
                      <span class="note-edit-icon" title="Edit note">✏️</span>
                    </div>
                  {/if}
                </div>
              {/each}
            {:else}
              <div class="model-info"><span class="model-params">No models downloaded</span></div>
            {/if}
          </div>
        </div>

        <!-- ETC -->
        {#if metrics.inference.ollama}
          <div class="card models-card">
            <h2>ETC</h2>
            <div class="models-list">
              <HermesSpotlight />
              {#if metrics.inference.ollama.models && metrics.inference.ollama.models.length > 0}
                {#each sortModelsForDisplay(metrics.inference.ollama.models.map(model => ({ ...model, status: metrics.inference.ollama.runningModel === model.name ? 'running' : (model.status || 'installed') }))) as model}
                  {@const runtimeModel = isDs4Model(model) ? null : metrics.inference.vllm.models?.find(r => (model.port && r.port && Number(model.port) === Number(r.port)) || (model.name && r.name && model.name === r.name) || (model.name && r.modelAlias && model.name === r.modelAlias) || (model.apiModel && r.modelAlias && model.apiModel === r.modelAlias))}
                  {@const isRunning = isDs4Model(model) ? Boolean(model.ds4Status?.running) : (runtimeModel ? (runtimeModel.status === 'running' || runtimeModel.status === 'loading') : (model.status ? (model.status === 'running' || model.status === 'loading') : false))}
                  {@const noteId = `ollama:${model.name}`}
                  <div class="model-item {isRunning ? 'loaded' : ''}">
                  <div class="model-header-row">
                    <div class="model-title-wrap">
                      <div class="model-name" title={displayModelName(model)}>{displayModelName(model)}</div>
                      {#if displayModelId(model) && displayModelId(model) !== displayModelName(model)}
                        <div class="model-id" title={displayModelId(model)}>{displayModelId(model)}</div>
                      {/if}
                    </div>
                      {#if isDs4Model(model)}
                        <span class="running-badge {model.ds4Status?.running ? '' : 'stopped-badge'}">{ds4StatusLabel(model)}</span>
                      {:else if isRunning}
                        <span class="running-badge">{(runtimeModel?.status || model.status || metrics.inference.vllm.status) === 'running' ? 'RUNNING' : 'LOADING'}</span>
                      {/if}
                    </div>
                    <div class="model-function">
                      <span>{isDs4Model(model) ? 'ds4-server / DwarfStar' : 'Ollama API'}</span>
                      {#if modelConnectionLabel(model, runtimeModel, metrics.inference.ollama.port)}<span>{modelConnectionLabel(model, runtimeModel, metrics.inference.ollama.port)}</span>{/if}
                    </div>
                    <div class="model-info">
                      {#if model.sizeGB}<span class="model-size">{model.sizeGB} GB</span>{/if}
                      {#if model.quantFormat}<span class="model-quant">{model.quantFormat}</span>{/if}
                      {#if model.paramSize}<span class="model-params">{model.paramSize}</span>{/if}
                      {#if model.family}<span class="model-params">{model.family}</span>{/if}
                      {#if isDs4Model(model) && model.ctx}<span class="model-params">ctx: {(model.ctx / 1024).toFixed(0)}K</span>{/if}
                    </div>
                    {#if isDs4Model(model)}
                      <div class="model-control">
                        <button class="control-btn secondary" disabled={ds4Action.busy && ds4Action.verb === 'status'} onclick={() => runDs4Action('status')}>Status</button>
                        {#if model.ds4Status?.running}
                          <button class="control-btn stop" disabled={ds4Action.busy} onclick={() => runDs4Action('stop')}>{ds4Action.busy && ds4Action.verb === 'stop' ? 'Stopping' : 'Stop Model'}</button>
                        {:else}
                          <button class="control-btn start" disabled={ds4Action.busy} onclick={() => runDs4Action('start')}>{ds4Action.busy && ds4Action.verb === 'start' ? 'Starting' : 'Start Model'}</button>
                        {/if}
                      </div>
                      {#if ds4MetaLine(model)}<div class="control-message">{ds4MetaLine(model)}</div>{/if}
                      {#if ds4Action.message}<div class="control-message">{ds4Action.message}</div>{/if}
                      {#if ds4Action.error}<div class="control-error">{controlErrorMessage(ds4Action)}</div>{/if}
                    {/if}
                    {#if editingNote === noteId}
                      <div class="note-edit">
                        <textarea bind:value={noteInput} placeholder="Add note..." rows="2" onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveNote(noteId); } if (e.key === 'Escape') cancelEdit(); }}></textarea>
                        <div class="note-actions">
                          <button class="note-btn save" onclick={() => saveNote(noteId)}>Save</button>
                          <button class="note-btn cancel" onclick={cancelEdit}>Cancel</button>
                        </div>
                      </div>
                    {:else}
                      <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                        {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
                        <span class="note-edit-icon" title="Edit note">✏️</span>
                      </div>
                    {/if}
                  </div>
                {/each}
              {:else}
                <div class="model-info"><span class="model-params">No models</span></div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <div class="card dgx-health-card">
      <div class="dgx-health-header">
        <h2>DGX Health <span class="engine-status {dgxHealth?.ok ? 'running' : 'loading'}">{dgxHealth?.ok ? 'snapshot' : 'unavailable'}</span></h2>
        <span class="health-path">~/dgx-health/logs/latest.json</span>
      </div>

      {#if dgxHealthError}
        <div class="control-error">{dgxHealthError}</div>
      {/if}

      {#if dgxHealth?.ok && healthLatest()}
        {@const latest = healthLatest()}
        <div class="health-badges">
          {#each healthStatuses() as status}
            <span class="health-badge {healthBadgeClass(status)}">{status}</span>
          {/each}
        </div>

        <div class="health-grid">
          <div class="health-section">
            <div class="health-section-title">Snapshot</div>
            <div class="health-row"><span>Timestamp</span><strong>{latest.timestamp || 'unknown'}</strong></div>
            <div class="health-row"><span>Age</span><strong>{formatHealthAge(healthAgeSeconds())}</strong></div>
            <div class="health-row"><span>Boot</span><strong>{latest.boot_id?.slice(0, 8) || 'unknown'}</strong></div>
            <div class="health-row"><span>Host</span><strong>{latest.hostname || 'unknown'}</strong></div>
          </div>

          <div class="health-section">
            <div class="health-section-title">Resources</div>
            <div class="health-row"><span>MemAvailable</span><strong>{memAvailableGiB()}</strong></div>
            <div class="health-row"><span>Swap</span><strong>{latest.memory?.swapon?.ok ? 'recorded' : 'unknown'}</strong></div>
            <div class="health-row"><span>Load</span><strong>{(latest.load_average || []).join(' ') || 'unknown'}</strong></div>
            <div class="health-row"><span>Disk</span><strong>{latest.disk?.root?.use_percent || latest.disk?.root?.used || 'recorded'}</strong></div>
          </div>

          <div class="health-section">
            <div class="health-section-title">Network</div>
            <div class="health-row"><span>Output</span><strong>{activeOutputPath()}</strong></div>
            <div class="health-row"><span>Default</span><strong>{defaultRoute().via || 'unknown'} {defaultRoute().dev || ''}</strong></div>
            <div class="health-row"><span>Source</span><strong>{defaultRoute().src || 'unknown'}</strong></div>
            <div class="health-row"><span>Metric</span><strong>{defaultRoute().metric || 'unknown'}</strong></div>
          </div>
        </div>

        <div class="health-subgrid">
          <div class="health-section">
            <div class="health-section-title">Interfaces</div>
            <div class="interface-grid">
              {#each healthInterfaces() as iface}
                <div class="health-chip" title={interfaceSummary(iface)}>
                  <span>{iface.name}</span>
                  <strong>{iface.state}</strong>
                </div>
              {/each}
            </div>
          </div>

          <div class="health-section">
            <div class="health-section-title">Ports / Endpoints</div>
            <div class="port-grid">
              {#each dgxHealthPorts() as port}
                <div class="port-pill {portClass(port)}">
                  <span>:{port}</span>
                  <strong>{endpointStatus(port)}</strong>
                </div>
              {/each}
            </div>
          </div>
        </div>

        <div class="health-message-list">
          {#each healthMessages() as message}
            <span>{message}</span>
          {/each}
        </div>
      {:else}
        <div class="graphify-empty">Health snapshot unavailable.</div>
      {/if}
    </div>

    <div class="card graphify-card">
      <div class="graphify-header">
        <h2>Graphify <span class="engine-status {graphTopology ? 'running' : 'loading'}">{graphTopology ? `${graphTopology.nodes?.length || 0} nodes` : 'loading'}</span></h2>
        <button class="control-btn secondary" onclick={loadGraphifyTopology}>Refresh</button>
      </div>

      {#if graphifyError}
        <div class="control-error">{graphifyError}</div>
      {/if}

      {#if graphTopology}
        <div class="graphify-canvas-wrap">
          <svg class="graphify-canvas" viewBox="0 0 820 340" role="img" aria-label="DGX runtime topology">
            <defs>
              <marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill="#4f6f43" />
              </marker>
            </defs>

            <line x1="120" y1="78" x2="280" y2="78" class="graph-edge-line" marker-end="url(#graph-arrow)" />
            <line x1="120" y1="162" x2="280" y2="162" class="graph-edge-line" marker-end="url(#graph-arrow)" />
            <line x1="365" y1="78" x2="365" y2="162" class="graph-edge-line" marker-end="url(#graph-arrow)" />
            <line x1="365" y1="162" x2="500" y2="162" class="graph-edge-line" marker-end="url(#graph-arrow)" />

            <g class="graph-svg-node">
              <rect x="24" y="42" width="120" height="72" rx="8" />
              <text x="84" y="70" text-anchor="middle">Access</text>
              <text x="84" y="92" text-anchor="middle" class="graph-svg-sub">Local / LAN / Tail</text>
            </g>

            <g class="graph-svg-node">
              <rect x="24" y="126" width="120" height="72" rx="8" />
              <text x="84" y="154" text-anchor="middle">Clients</text>
              <text x="84" y="176" text-anchor="middle" class="graph-svg-sub">Cline / CCR</text>
            </g>

            <g class="graph-svg-node running">
              <rect x="280" y="42" width="170" height="72" rx="8" />
              <text x="365" y="70" text-anchor="middle">Main Dashboard :9000</text>
              <text x="365" y="92" text-anchor="middle" class="graph-svg-sub">{graphTopology.host}</text>
            </g>

            <g class="graph-svg-node running">
              <rect x="280" y="126" width="170" height="72" rx="8" />
              <text x="365" y="154" text-anchor="middle">DGX Host</text>
              <text x="365" y="176" text-anchor="middle" class="graph-svg-sub">edgexpert-ba03</text>
            </g>

            <g class="graph-svg-node">
              <rect x="280" y="226" width="170" height="72" rx="8" />
              <text x="365" y="254" text-anchor="middle">Model Control</text>
              <text x="365" y="276" text-anchor="middle" class="graph-svg-sub">{graphNodes('profile').length} profiles</text>
            </g>

            {#each graphRuntimes().slice(0, 6) as node, index}
              <line x1="500" y1="162" x2="570" y2={graphRuntimeY(index)} class="graph-edge-line faint" marker-end="url(#graph-arrow)" />
              <g class="graph-svg-node {graphStatusClass(node.status)}">
                <rect x="570" y={graphRuntimeY(index) - 22} width="220" height="38" rx="7" />
                <text x="582" y={graphRuntimeY(index) - 5}>{compactGraphLabel(node.label)}</text>
                <text x="582" y={graphRuntimeY(index) + 10} class="graph-svg-sub">:{node.port} · {node.runtime}{#if node.contextLabel} · {node.contextLabel}{/if}</text>
              </g>
            {/each}
          </svg>
        </div>

        <div class="graphify-lanes">
          <div class="graph-lane">
            <div class="graph-lane-title">Access Paths</div>
            {#each graphNodes('access') as node}
              <div class="graph-chip {graphStatusClass(node.status)}">
                <span class="graph-dot"></span>
                <span>{node.label}</span>
              </div>
            {/each}
          </div>

          <div class="graph-lane">
            <div class="graph-lane-title">Clients / Tools</div>
            {#each graphNodes('client') as node}
              <div class="graph-chip {graphStatusClass(node.status)}">
                <span class="graph-dot"></span>
                <span>{node.label}</span>
              </div>
            {/each}
          </div>

          <div class="graph-lane">
            <div class="graph-lane-title">Health / Route</div>
            {#each graphHealthNodes() as node}
              <div class="graph-chip {graphStatusClass(node.status)}">
                <span class="graph-dot"></span>
                <span>{node.label}</span>
                {#if node.ageSeconds !== undefined && node.ageSeconds !== null}
                  <strong>{node.ageSeconds}s</strong>
                {:else if node.labelDetail}
                  <strong>{node.labelDetail}</strong>
                {/if}
              </div>
            {/each}
          </div>

          <div class="graph-lane">
            <div class="graph-lane-title">Observed Ports</div>
            <div class="graph-port-list">
              {#each graphHealthPorts() as node}
                <div class="graph-chip {graphStatusClass(node.status)}">
                  <span class="graph-dot"></span>
                  <span>:{node.port}</span>
                  <strong>{node.status}</strong>
                </div>
              {/each}
            </div>
          </div>

          <div class="graph-lane runtime-lane">
            <div class="graph-lane-title">Model Runtimes</div>
            <div class="graph-runtime-grid">
              {#each graphRuntimes() as node}
                <div class="graph-runtime-node {graphStatusClass(node.status)}">
                  <div class="graph-runtime-top">
                    <span class="graph-dot"></span>
                    <span class="graph-runtime-name" title={node.label}>{node.label}</span>
                    <span class="graph-port">:{node.port}</span>
                  </div>
                  <div class="graph-runtime-meta">
                    <span>{node.runtime}</span>
                    {#if node.contextLabel}<span>ctx {node.contextLabel}</span>{/if}
                    {#if node.validatedInput}<span>input {node.validatedInput}</span>{/if}
                    {#if node.recommendedOutput}<span>recommended output {node.recommendedOutput}</span>{/if}
                    {#if node.validatedOutput}<span>output {node.validatedOutput}</span>{/if}
                    {#if node.maxNumSeqs}<span>seq {node.maxNumSeqs}</span>{/if}
                    {#if node.maxNumBatchedTokens}<span>batch {node.maxNumBatchedTokens}</span>{/if}
                    {#if node.gpuMemoryUtilization}<span>GPU util {node.gpuMemoryUtilization}</span>{/if}
                    {#if node.moeBackend}<span>MoE {node.moeBackend}</span>{/if}
                    {#if node.linearBackend}<span>linear {node.linearBackend}</span>{/if}
                    {#if node.cuteDslArch}<span>{node.cuteDslArch}</span>{/if}
                    {#if node.thinkingDefault}<span>thinking default ON</span>{/if}
                    {#if node.mtpOptionalTokens}<span>MTP OFF / optional {node.mtpOptionalTokens}</span>{/if}
                    {#if node.startupSafetyStatus}<span>{node.startupSafetyStatus}</span>{/if}
                    {#if node.speculative}<span>{node.speculativeType || 'speculative'}</span>{/if}
                    {#if node.isLora}<span>LoRA</span>{/if}
                    {#if node.profileId}<span>{node.profileId}</span>{/if}
                  </div>
                  {#if node.modelId}
                    <div class="graph-runtime-model" title={node.modelId}>{node.modelId}</div>
                  {/if}
                  {#if node.modelRepository}
                    <div class="graph-runtime-model" title={`${node.modelRepository}@${node.modelRevision || 'revision unknown'}`}>{node.modelRepository}@{node.modelRevision || 'revision unknown'}</div>
                  {/if}
                  {#if node.runtimeStack}
                    <div class="graph-runtime-model" title={node.runtimeStack}>{node.runtimeStack}</div>
                  {/if}
                  {#if node.loraPath}
                    <div class="graph-runtime-model" title={node.loraPath}>LoRA: {node.loraPath}</div>
                  {/if}
                  {#if node.startupSafetyStatus}
                    <div class="graph-runtime-model" title={node.safetyEvidence}>
                      startup NVRM {node.startupNvrmCount ?? 'pending'} · post-ready {node.postReadyNvrmDelta ?? 'pending'} · zero-certified {node.zeroNvrmCertified ? 'yes' : 'no'}
                    </div>
                  {/if}
                  {#if node.kvDtype || node.attentionBackend || node.moeBackend || node.executorBackend}
                    <div class="graph-runtime-model">
                      {node.kvDtype || 'KV ?'} · {node.attentionBackend || 'attention ?'} · {node.moeBackend || 'MoE ?'} · {node.executorBackend || 'executor ?'}
                    </div>
                  {/if}
                  {#if node.tailscaleEndpoint}
                    <div class="graph-runtime-model" title={node.tailscaleEndpoint}>{node.tailscaleEndpoint}</div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        </div>

        <div class="graph-edge-list">
          {#each (graphTopology.edges || []).filter(edge => edge.source === 'dashboard:9000' || edge.source === 'control:modelctl' || edge.source === 'client:claude-code-router').slice(0, 14) as edge}
            {@const from = graphNode(edge.source)}
            {@const to = graphNode(edge.target)}
            <span>{from?.label || edge.source} → {to?.label || edge.target} · {edge.label}</span>
          {/each}
        </div>
      {:else}
        <div class="graphify-empty">Topology loading...</div>
      {/if}
    </div>

    <div class="footer-compact">
      {new Date(metrics.timestamp).toLocaleTimeString()}
    </div>
  {:else}
    <div class="loading-state">
      <div class="loading">Loading system metrics...</div>
    </div>
  {/if}
</div>

<style>
  .dashboard {
    min-height: 100vh;
    padding: 0.5rem;
    max-width: 1600px;
    margin: 0 auto;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
    padding: 0.25rem 0;
  }

  .header-left {
    display: flex;
    align-items: baseline;
    gap: 1rem;
  }

  h1 { margin: 0; color: #76b900; font-size: 1.3rem; font-weight: 600; }
  .system-name { color: #666; font-size: 0.85rem; }
  .uptime { color: #888; font-size: 0.75rem; }

  h2 {
    margin: 0 0 0.3rem 0;
    color: #76b900;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .status {
    padding: 0.3rem 0.7rem;
    border-radius: 4px;
    font-weight: 600;
    font-size: 0.8rem;
  }
  .status.connected { background: #1a4d1a; color: #76b900; }
  .status.disconnected { background: #4d1a1a; color: #ff6b6b; }

  .card {
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    padding: 0.5rem;
    transition: border-color 0.2s;
  }
  .card:hover { border-color: #76b900; }

  /* Row 1: Stats row — horizontal scroll on mobile */
  .stats-row {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .stat-card {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    min-height: 0;
  }

  .stat-top {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .stat-info {
    flex: 1;
    min-width: 0;
  }

  .stat-info h2 { margin: 0; text-align: left; }

  .stat-detail {
    color: #888;
    font-size: 0.65rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .gpu-memory-detail {
    color: #ffb74d;
    font-size: 0.58rem;
    margin-top: 0.12rem;
    white-space: nowrap;
  }

  .sparkline-container {
    width: 100%;
    height: 28px;
  }

  .sparkline {
    width: 100%;
    height: 100%;
  }

  /* Memory compact */
  .mem-total-compact {
    font-size: 0.9rem;
    font-weight: 700;
    color: #fff;
  }

  .mem-bar-container { width: 100%; }

  .mem-bar {
    width: 100%;
    height: 10px;
    background: #2a2a2a;
    border-radius: 5px;
    overflow: hidden;
    display: flex;
  }
  .mem-bar-gpu { height: 100%; background: #ff9800; transition: width 0.5s; }
  .mem-bar-os { height: 100%; background: #00d4ff; transition: width 0.5s; }
  .mem-bar-other { height: 100%; background: #8bc34a; transition: width 0.5s; }
  .mem-bar-cache { height: 100%; background: #607d8b; transition: width 0.5s; }
  .mem-bar-free { height: 100%; background: #2a2a2a; transition: width 0.5s; }
  .mem-bar-disk { height: 100%; background: #9c27b0; transition: width 0.5s; }

  .mem-legend-compact {
    display: flex;
    gap: 0.5rem;
    font-size: 0.6rem;
    color: #888;
    flex-wrap: wrap;
  }

  .kill-all-models {
    width: 100%;
    margin-top: 0.15rem;
    border: 1px solid #8f3434;
    border-radius: 4px;
    padding: 0.28rem 0.4rem;
    color: #ff8f8f;
    background: #421818;
    font-size: 0.62rem;
    font-weight: 700;
    cursor: pointer;
  }
  .kill-all-models:hover:not(:disabled) { background: #572020; border-color: #ff6b6b; }
  .kill-all-models:disabled { opacity: 0.55; cursor: not-allowed; }
  .kill-all-message, .kill-all-error { font-size: 0.56rem; line-height: 1.25; }
  .kill-all-message { color: #76b900; }
  .kill-all-error { color: #ff6b6b; }

  .agent-process-controls {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.3rem;
    margin-top: 0.35rem;
  }
  .agent-process-stop { width: 100%; }
  .agent-process-feedback { font-size: 0.56rem; line-height: 1.25; margin-top: 0.2rem; }

  .mem-dot {
    width: 6px; height: 6px; border-radius: 50%;
    display: inline-block; vertical-align: middle; margin-right: 2px;
  }
  .mem-dot.gpu { background: #ff9800; }
  .mem-dot.os { background: #00d4ff; }
  .mem-dot.other { background: #8bc34a; }
  .mem-dot.cache { background: #607d8b; }
  .mem-dot.disk { background: #9c27b0; }
  .mem-dot.free { background: #2a2a2a; border: 1px solid #555; }
  .mem-availability { color: #76b900; font-size: 0.58rem; margin-top: 0.12rem; }

  /* Network */
  .net-stats {
    display: flex;
    gap: 0.75rem;
    font-size: 0.68rem;
    font-weight: 600;
    align-items: center;
    flex-wrap: wrap;
  }
  .network-interfaces {
    display: grid;
    gap: 0.25rem;
    margin-top: 0.45rem;
  }
  .network-interface {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    align-items: center;
    min-height: 1.35rem;
    padding: 0.18rem 0.35rem;
    background: #111;
    border: 1px solid #242424;
    border-radius: 4px;
    font-size: 0.58rem;
  }
  .network-interface.network-active {
    border-color: rgba(0, 212, 255, 0.45);
    background: rgba(0, 212, 255, 0.06);
  }
  .net-name {
    color: #cfcfcf;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .net-flow {
    display: flex;
    gap: 0.45rem;
    white-space: nowrap;
    font-weight: 600;
  }
  .net-rx { color: #00d4ff; }
  .net-tx { color: #76b900; }

  /* Models row */
  .models-row {
    display: grid;
    grid-template-columns: minmax(0, 26fr) minmax(0, 34fr) minmax(0, 40fr);
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .models-card {
    min-height: 0;
    max-height: 520px;
    text-align: left;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .models-card .models-list {
    overflow-y: auto;
    flex: 1;
  }

  .model-runtime-details {
    display: grid;
    gap: 0.18rem;
    margin-top: 0.35rem;
    padding: 0.38rem 0.45rem;
    border: 1px solid rgba(0, 212, 255, 0.28);
    border-radius: 4px;
    background: rgba(0, 212, 255, 0.05);
    color: #c9d4d8;
    font-size: 0.58rem;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .model-runtime-details strong {
    color: #00d4ff;
    font-weight: 700;
  }

  .runtime-stack { color: #9ba9ae; }
  .runtime-alias-note { color: #ffd166; }

  .models-card h2 {
    display: flex;
    justify-content: space-between;
    align-items: center;
    text-align: left;
  }

  .engine-status {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: none;
    letter-spacing: 0;
  }
  .engine-status.running { color: #76b900; }
  .engine-status.loading { color: #ffd166; }
  .engine-status.stopped { color: #ff6b6b; }

  .models-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    width: 100%;
  }

  .model-item {
    padding: 0.35rem 0.4rem;
    background: #0f0f0f;
    border-radius: 4px;
    border: 1px solid #2a2a2a;
    transition: all 0.2s;
  }

  .model-item.loaded {
    background: rgba(118, 185, 0, 0.1);
    border: 1px solid #76b900;
    box-shadow: 0 0 8px rgba(118, 185, 0, 0.2);
  }

  .model-header-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.45rem;
  }

  .model-title-wrap {
    min-width: 0;
    flex: 1;
  }

  .model-name {
    color: #fff;
    font-weight: 600;
    font-size: 0.8rem;
    font-family: 'Monaco', 'Menlo', monospace;
    white-space: normal;
    overflow-wrap: anywhere;
    line-height: 1.25;
  }

  .model-id {
    color: #777;
    font-size: 0.58rem;
    font-family: 'Monaco', 'Menlo', monospace;
    line-height: 1.25;
    margin-top: 0.12rem;
    overflow-wrap: anywhere;
  }

  .model-function {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.25rem;
  }

  .model-function span {
    color: #c9d4c0;
    background: rgba(118, 185, 0, 0.1);
    border: 1px solid rgba(118, 185, 0, 0.22);
    border-radius: 3px;
    padding: 0.08rem 0.28rem;
    font-size: 0.58rem;
    line-height: 1.3;
  }

  .running-badge {
    font-size: 0.55rem;
    font-weight: 700;
    color: #76b900;
    background: #1a4d1a;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }

  .running-badge.stopped-badge {
    color: #ff6b6b;
    background: #4d1a1a;
  }

  .running-badge.degraded-badge {
    color: #ffd166;
    background: #4a3b12;
  }

  .model-info {
    display: flex;
    gap: 0.5rem;
    font-size: 0.7rem;
    flex-wrap: wrap;
  }

  .model-size { color: #76b900; font-weight: 600; }

  .model-quant {
    color: #e6a817;
    font-weight: 600;
    background: rgba(230, 168, 23, 0.15);
    padding: 0px 4px;
    border-radius: 3px;
    font-size: 0.7em;
  }

  .model-params { color: #888; }
  .model-params.active-ctx { color: #76b900; font-weight: 600; }

  .model-control {
    display: flex;
    gap: 0.3rem;
    margin-top: 0.3rem;
    flex-wrap: wrap;
  }

  .control-btn {
    border: 1px solid #333;
    border-radius: 4px;
    padding: 0.2rem 0.45rem;
    font-size: 0.65rem;
    font-weight: 700;
    cursor: pointer;
    color: #eee;
    background: #222;
  }
  .control-btn:hover:not(:disabled) { border-color: #76b900; }
  .control-btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .control-btn.start { background: #1a4d1a; color: #76b900; }
  .control-btn.stop { background: #4d1a1a; color: #ff6b6b; }
  .control-btn.secondary { background: #1a1a1a; color: #aaa; }

  .control-message {
    color: #76b900;
    font-size: 0.65rem;
    margin-top: 0.2rem;
  }

  .control-error {
    color: #ff6b6b;
    font-size: 0.65rem;
    margin-top: 0.2rem;
    line-height: 1.3;
  }

  /* Notes */
  .note-display {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    margin-top: 0.2rem;
    cursor: pointer;
    min-height: 1.2rem;
  }
  .note-display:hover .note-edit-icon { opacity: 1; }
  .note-text { color: #aaa; font-size: 0.7em; line-height: 1.3; white-space: pre-wrap; }
  .note-edit-icon { opacity: 0.2; font-size: 0.65em; transition: opacity 0.2s; flex-shrink: 0; }

  .note-edit { margin-top: 0.2rem; }
  .note-edit textarea {
    width: 100%;
    background: #1a1a2e;
    border: 1px solid #444;
    color: #ddd;
    border-radius: 4px;
    padding: 0.3rem;
    font-size: 0.75em;
    font-family: inherit;
    resize: vertical;
  }
  .note-edit textarea:focus { outline: none; border-color: #76b900; }

  .note-actions { display: flex; gap: 0.3rem; margin-top: 0.2rem; }
  .note-btn { padding: 2px 8px; border: none; border-radius: 3px; cursor: pointer; font-size: 0.7em; }
  .note-btn.save { background: #76b900; color: #000; }
  .note-btn.cancel { background: #444; color: #ccc; }

  .dgx-health-card {
    margin-bottom: 0.5rem;
    overflow: hidden;
  }

  .dgx-health-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.45rem;
  }

  .dgx-health-header h2 {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .health-path {
    color: #777;
    font-size: 0.62rem;
    font-family: 'Monaco', 'Menlo', monospace;
    overflow-wrap: anywhere;
    text-align: right;
  }

  .health-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-bottom: 0.5rem;
  }

  .health-badge {
    border: 1px solid #333;
    border-radius: 4px;
    padding: 0.16rem 0.42rem;
    font-size: 0.58rem;
    font-weight: 800;
    letter-spacing: 0.4px;
    color: #aaa;
    background: #111;
  }

  .health-badge.running {
    color: #76b900;
    border-color: rgba(118, 185, 0, 0.45);
    background: rgba(118, 185, 0, 0.12);
  }

  .health-badge.loading {
    color: #ffd166;
    border-color: rgba(255, 209, 102, 0.45);
    background: rgba(255, 209, 102, 0.1);
  }

  .health-badge.stopped {
    color: #ff6b6b;
    border-color: rgba(255, 107, 107, 0.45);
    background: rgba(255, 107, 107, 0.1);
  }

  .health-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.5rem;
  }

  .health-subgrid {
    display: grid;
    grid-template-columns: 1fr 2fr;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .health-section {
    background: #0f0f0f;
    border: 1px solid #242424;
    border-radius: 6px;
    padding: 0.45rem;
    min-width: 0;
  }

  .health-section-title {
    color: #c9d4c0;
    font-size: 0.6rem;
    font-weight: 800;
    letter-spacing: 0.45px;
    text-transform: uppercase;
    margin-bottom: 0.35rem;
  }

  .health-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
    min-height: 1.15rem;
    color: #858585;
    font-size: 0.64rem;
  }

  .health-row strong {
    color: #ededed;
    font-size: 0.66rem;
    font-weight: 700;
    text-align: right;
    overflow-wrap: anywhere;
  }

  .interface-grid,
  .port-grid {
    display: grid;
    gap: 0.35rem;
  }

  .interface-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .port-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .health-chip,
  .port-pill {
    display: flex;
    justify-content: space-between;
    gap: 0.35rem;
    align-items: center;
    background: #151515;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    padding: 0.25rem 0.35rem;
    min-width: 0;
    font-size: 0.62rem;
  }

  .health-chip span,
  .port-pill span {
    color: #cfcfcf;
    font-family: 'Monaco', 'Menlo', monospace;
  }

  .health-chip strong,
  .port-pill strong {
    color: #888;
    font-size: 0.58rem;
    overflow-wrap: anywhere;
    text-align: right;
  }

  .port-pill.running {
    border-color: rgba(118, 185, 0, 0.42);
    background: rgba(118, 185, 0, 0.08);
  }

  .port-pill.running strong { color: #76b900; }

  .health-message-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.5rem;
  }

  .health-message-list span {
    color: #cfcfcf;
    background: #111;
    border: 1px solid #242424;
    border-radius: 4px;
    padding: 0.25rem 0.4rem;
    font-size: 0.62rem;
    line-height: 1.3;
  }

  .graphify-card {
    margin-bottom: 0.5rem;
    overflow: hidden;
  }

  .graphify-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.45rem;
  }

  .graphify-header h2 {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .graphify-canvas-wrap {
    width: 100%;
    overflow-x: auto;
    background: #0f0f0f;
    border: 1px solid #242424;
    border-radius: 6px;
  }

  .graphify-canvas {
    width: 100%;
    min-width: 820px;
    height: 340px;
    display: block;
  }

  .graph-edge-line {
    stroke: #4f6f43;
    stroke-width: 1.3;
    fill: none;
  }

  .graph-edge-line.faint {
    opacity: 0.55;
  }

  .graph-svg-node rect {
    fill: #171717;
    stroke: #333;
    stroke-width: 1;
  }

  .graph-svg-node.running rect {
    fill: rgba(118, 185, 0, 0.12);
    stroke: #76b900;
  }

  .graph-svg-node.loading rect {
    fill: rgba(255, 209, 102, 0.10);
    stroke: #ffd166;
  }

  .graph-svg-node.stopped rect {
    fill: rgba(255, 107, 107, 0.08);
    stroke: #5b2a2a;
  }

  .graph-svg-node text {
    fill: #ececec;
    font-size: 11px;
    font-family: 'Monaco', 'Menlo', monospace;
    pointer-events: none;
  }

  .graph-svg-node .graph-svg-sub {
    fill: #9aa096;
    font-size: 9px;
  }

  .graphify-lanes {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .graph-lane {
    background: #0f0f0f;
    border: 1px solid #242424;
    border-radius: 6px;
    padding: 0.45rem;
    min-width: 0;
  }

  .graph-lane-title {
    color: #76b900;
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    margin-bottom: 0.35rem;
  }

  .graph-chip {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-height: 26px;
    padding: 0.22rem 0.32rem;
    border: 1px solid #2a2a2a;
    border-radius: 5px;
    color: #ddd;
    font-size: 0.68rem;
    margin-bottom: 0.25rem;
    background: #151515;
  }

  .graph-chip span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .graph-chip strong {
    color: #9aa096;
    font-size: 0.58rem;
    margin-left: auto;
    text-align: right;
    overflow-wrap: anywhere;
  }

  .graph-port-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.25rem;
  }

  .graph-port-list .graph-chip {
    margin-bottom: 0;
  }

  .runtime-lane {
    grid-column: 1 / -1;
  }

  .graph-runtime-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.35rem;
  }

  .graph-runtime-node {
    border: 1px solid #2a2a2a;
    background: #151515;
    border-radius: 6px;
    padding: 0.4rem;
    min-width: 0;
  }

  .graph-runtime-node.running {
    border-color: #76b900;
    background: rgba(118, 185, 0, 0.09);
  }

  .graph-runtime-node.loading {
    border-color: #ffd166;
    background: rgba(255, 209, 102, 0.08);
  }

  .graph-runtime-node.stopped {
    border-color: #3a2525;
    background: rgba(255, 107, 107, 0.05);
  }

  .graph-runtime-top {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
  }

  .graph-runtime-name {
    color: #fff;
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 0.72rem;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .graph-port {
    color: #76b900;
    font-size: 0.68rem;
    font-weight: 800;
  }

  .graph-runtime-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.3rem;
  }

  .graph-runtime-meta span {
    color: #c9d4c0;
    background: rgba(118, 185, 0, 0.08);
    border: 1px solid rgba(118, 185, 0, 0.18);
    border-radius: 3px;
    padding: 0.06rem 0.25rem;
    font-size: 0.56rem;
  }

  .graph-runtime-model {
    margin-top: 0.28rem;
    color: #8d8d8d;
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 0.58rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .graph-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #777;
    flex-shrink: 0;
  }

  .running .graph-dot { background: #76b900; }
  .loading .graph-dot { background: #ffd166; }
  .stopped .graph-dot { background: #ff6b6b; }
  .unknown .graph-dot { background: #777; }

  .graph-edge-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.45rem;
  }

  .graph-edge-list span {
    color: #aaa;
    background: #111;
    border: 1px solid #242424;
    border-radius: 4px;
    padding: 0.16rem 0.35rem;
    font-size: 0.58rem;
  }

  .graphify-empty {
    color: #888;
    font-size: 0.8rem;
    padding: 0.5rem;
  }

  .footer-compact {
    text-align: center;
    color: #444;
    font-size: 0.65rem;
    margin-top: 0.3rem;
    padding: 0.3rem 0;
  }

  .loading-state {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 50vh;
  }
  .loading { color: #888; font-size: 1.2rem; }

  /* Responsive */
  @media (max-width: 1200px) {
    .stats-row { grid-template-columns: repeat(3, 1fr); }
    .models-row { grid-template-columns: repeat(2, 1fr); }
    .health-grid { grid-template-columns: 1fr; }
    .health-subgrid { grid-template-columns: 1fr; }
    .graphify-lanes { grid-template-columns: 1fr; }
    .graph-runtime-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }

  @media (max-width: 768px) {
    .stats-row { grid-template-columns: repeat(2, 1fr); }
    .models-row { grid-template-columns: 1fr; }
    .dgx-health-header { align-items: flex-start; flex-direction: column; }
    .health-path { text-align: left; }
    .interface-grid { grid-template-columns: 1fr; }
    .port-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .graph-runtime-grid { grid-template-columns: 1fr; }
  }
</style>
