<script>
  import { onDestroy, onMount } from 'svelte';

  const HERMES_URL = 'http://100.108.68.20:9119';
  const HERMES_LOCAL_URL = 'http://192.168.0.21:9119';

  let hermes = $state({
    state: 'checking',
    ready: false,
    url: HERMES_URL,
    localUrl: HERMES_LOCAL_URL,
    dashboard: { active: false, activeState: 'unknown' },
    proxy: { active: false, activeState: 'unknown' },
    health: { ok: false, status: null }
  });
  let actionState = $state({ busy: false, verb: '', message: '', error: '' });
  let timer = null;

  function displayState() {
    if (actionState.busy && actionState.verb === 'start') return 'starting';
    if (actionState.busy && actionState.verb === 'stop') return 'stopping';
    return hermes.state || 'checking';
  }

  function stateLabel() {
    const labels = {
      online: 'ONLINE',
      offline: 'OFFLINE',
      degraded: 'DEGRADED',
      starting: 'STARTING',
      stopping: 'STOPPING',
      checking: 'CHECKING'
    };
    return labels[displayState()] || 'UNKNOWN';
  }

  function serviceIndicators() {
    return [
      { label: 'Hermes', detail: hermes.dashboard?.active ? 'active' : (hermes.dashboard?.activeState || 'offline'), ok: Boolean(hermes.dashboard?.active) },
      { label: 'Proxy', detail: hermes.proxy?.active ? 'active' : (hermes.proxy?.activeState || 'offline'), ok: Boolean(hermes.proxy?.active) },
      { label: 'HTTP', detail: hermes.health?.ok ? `HTTP ${hermes.health.status || 200}` : 'not ready', ok: Boolean(hermes.health?.ok) },
      { label: 'Tailnet', detail: hermes.ready ? 'ready' : 'waiting', ok: Boolean(hermes.ready) }
    ];
  }

  async function loadStatus({ quiet = false } = {}) {
    if (actionState.busy) return;
    try {
      const response = await fetch('/api/hermes/status', { headers: { accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.message || 'Hermes status unavailable');
      hermes = data;
      if (!quiet) actionState.error = '';
    } catch (error) {
      hermes = { ...hermes, state: 'degraded', ready: false };
      if (!quiet) actionState.error = error.message || 'Hermes status unavailable';
    }
  }

  async function runAction(action) {
    if (action === 'stop' && !confirm('Stop Hermes and disconnect active Hermes sessions?')) return;

    actionState = { busy: true, verb: action, message: '', error: '' };
    try {
      const response = await fetch(`/api/hermes/${action}`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.message || `${action} failed`);
      hermes = data;
      actionState = {
        busy: false,
        verb: '',
        message: action === 'start' ? 'Hermes is ready.' : 'Hermes stopped.',
        error: ''
      };
    } catch (error) {
      actionState = {
        busy: false,
        verb: '',
        message: '',
        error: error.message || `Unable to ${action} Hermes.`
      };
      await loadStatus({ quiet: true });
    }
  }

  function stackIsActive() {
    return Boolean(hermes.dashboard?.active || hermes.proxy?.active);
  }

  function toggleHermes() {
    return runAction(stackIsActive() ? 'stop' : 'start');
  }

  function openHermesLocal() {
    window.open(hermes?.localUrl || 'http://192.168.0.21:9119', '_blank', 'noopener,noreferrer');
  }

  function openHermesTail() {
    window.open(hermes?.url || 'http://100.108.68.20:9119', '_blank', 'noopener,noreferrer');
  }

  onMount(() => {
    loadStatus();
    timer = setInterval(() => loadStatus({ quiet: true }), 5000);
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
  });
</script>

<section class="hermes-spotlight" aria-labelledby="hermes-title">
  <div class="portrait-shell" aria-hidden="true">
    <img src="/api/hermes/logo" alt="Hermes girl logo" />
    <span class:online={hermes.ready} class="portrait-presence"></span>
  </div>

  <div class="hermes-content">
    <div class="identity-row">
      <div>
        <div class="eyebrow">NOUS RESEARCH · LOCAL AGENT</div>
        <h3 id="hermes-title">Hermes</h3>
        <p>Research workspace · local + tailnet access</p>
      </div>
      <span class="state-pill {displayState()}">
        <span class="state-dot"></span>{stateLabel()}
      </span>
    </div>

    <div class="service-grid" aria-label="Hermes service status">
      {#each serviceIndicators() as service}
        <div class:ready={service.ok} class="service-chip">
          <span class="service-dot"></span>
          <span>
            <strong>{service.label}</strong>
            <small>{service.detail}</small>
          </span>
        </div>
      {/each}
    </div>

    <div class="actions-shell">
      <button
        class="action-button service-toggle {stackIsActive() ? 'stop' : 'start'}"
        type="button"
        disabled={actionState.busy}
        onclick={toggleHermes}
        aria-label={stackIsActive() ? 'Stop Hermes' : 'Start Hermes'}
      >
        {#if actionState.busy}
          <span class="spinner"></span>
          <span>{actionState.verb === 'start' ? 'Starting…' : 'Stopping…'}</span>
        {:else if stackIsActive()}
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z" /></svg>
          <span>Stop</span>
        {:else}
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
          <span>Start</span>
        {/if}
      </button>
      <div class="open-stack">
        <button
          class="action-button open local"
          type="button"
          disabled={!hermes.ready || actionState.busy}
          onclick={openHermesLocal}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14V3z" /><path d="M5 5h6v2H7v10h10v-4h2v6H5V5z" /></svg>
          <span>Open Hermes Local</span>
        </button>
        <button
          class="action-button open tail"
          type="button"
          disabled={!hermes.ready || actionState.busy}
          onclick={openHermesTail}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14V3z" /><path d="M5 5h6v2H7v10h10v-4h2v6H5V5z" /></svg>
          <span>Open Hermes Tailscale</span>
        </button>
      </div>
    </div>

    <div class="operation-message" aria-live="polite">
      {#if actionState.busy}
        <span class="working"><span class="spinner"></span>{actionState.verb === 'start' ? 'Starting Hermes…' : 'Stopping Hermes…'}</span>
      {:else if actionState.error}
        <span class="error">{actionState.error}</span>
      {:else if actionState.message}
        <span class="success">{actionState.message}</span>
      {:else}
        <span class="endpoint">192.168.0.21:9119 · 100.108.68.20:9119</span>
      {/if}
    </div>
  </div>
</section>

<style>
  .hermes-spotlight {
    position: relative;
    isolation: isolate;
    display: grid;
    grid-template-columns: 104px minmax(0, 1fr);
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem;
    overflow: hidden;
    color: #f5fbff;
    background:
      radial-gradient(circle at 8% 12%, rgba(0, 212, 255, 0.14), transparent 36%),
      linear-gradient(135deg, #0a1721 0%, #0b1118 55%, #11140f 100%);
    border: 1px solid rgba(0, 212, 255, 0.34);
    border-radius: 9px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 8px 24px rgba(0, 0, 0, 0.22);
  }

  .hermes-spotlight::before {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    z-index: -1;
    width: 2px;
    background: linear-gradient(#00d4ff, #d3a729, transparent 82%);
  }

  .portrait-shell {
    position: relative;
    width: 104px;
    height: 116px;
    padding: 3px;
    background: linear-gradient(145deg, rgba(0, 212, 255, 0.95), rgba(211, 167, 41, 0.8));
    border-radius: 8px 8px 20px 8px;
    box-shadow: 0 5px 18px rgba(0, 0, 0, 0.35);
  }

  .portrait-shell img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center 36%;
    background: #fff;
    border-radius: 6px 6px 17px 6px;
  }

  .portrait-presence {
    position: absolute;
    right: -3px;
    bottom: -3px;
    width: 13px;
    height: 13px;
    background: #ff6b6b;
    border: 3px solid #0b1118;
    border-radius: 999px;
  }

  .portrait-presence.online {
    background: #76b900;
    box-shadow: 0 0 10px rgba(118, 185, 0, 0.55);
  }

  .hermes-content {
    min-width: 0;
  }

  .identity-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .eyebrow {
    margin-bottom: 0.08rem;
    color: #8ba1ad;
    font-size: 0.5rem;
    font-weight: 750;
    letter-spacing: 0.11em;
  }

  h3 {
    margin: 0;
    color: #fff;
    font-size: 1.2rem;
    line-height: 1.05;
    letter-spacing: -0.02em;
  }

  p {
    margin: 0.2rem 0 0;
    color: #8ea0aa;
    font-size: 0.61rem;
  }

  .state-pill {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 0.28rem;
    padding: 0.2rem 0.42rem;
    color: #ff6b6b;
    background: rgba(255, 107, 107, 0.09);
    border: 1px solid rgba(255, 107, 107, 0.3);
    border-radius: 999px;
    font-size: 0.51rem;
    font-weight: 800;
    letter-spacing: 0.06em;
  }

  .state-pill.online {
    color: #a4e545;
    background: rgba(118, 185, 0, 0.1);
    border-color: rgba(118, 185, 0, 0.36);
  }

  .state-pill.degraded,
  .state-pill.starting,
  .state-pill.stopping,
  .state-pill.checking {
    color: #ffd166;
    background: rgba(255, 209, 102, 0.08);
    border-color: rgba(255, 209, 102, 0.3);
  }

  .state-dot,
  .service-dot {
    width: 6px;
    height: 6px;
    background: currentColor;
    border-radius: 999px;
  }

  .state-pill.online .state-dot {
    box-shadow: 0 0 8px currentColor;
  }

  .service-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.28rem;
    margin-top: 0.58rem;
  }

  .service-chip {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    min-width: 0;
    padding: 0.28rem 0.34rem;
    color: #697882;
    background: rgba(255, 255, 255, 0.025);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 5px;
  }

  .service-chip.ready {
    color: #76b900;
    border-color: rgba(118, 185, 0, 0.2);
  }

  .service-chip > span:last-child {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .service-chip strong {
    color: #dce7ec;
    font-size: 0.53rem;
    line-height: 1.15;
  }

  .service-chip small {
    overflow: hidden;
    color: #6f818b;
    font-size: 0.46rem;
    line-height: 1.15;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actions-shell {
    display: grid;
    grid-template-columns: 84px minmax(0, 1fr);
    align-items: start;
    gap: 0.35rem;
    margin-top: 0.58rem;
  }

  .open-stack {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    min-width: 0;
  }

  .action-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.28rem;
    min-height: 30px;
    padding: 0.36rem 0.48rem;
    border-radius: 6px;
    font-size: 0.61rem;
    font-weight: 750;
    transition: transform 160ms ease, border-color 160ms ease, background 160ms ease, opacity 160ms ease;
  }

  .action-button svg {
    width: 12px;
    height: 12px;
    fill: currentColor;
  }

  .action-button.start {
    color: #c7f58a;
    background: rgba(118, 185, 0, 0.12);
    border-color: rgba(118, 185, 0, 0.35);
  }

  .action-button.stop {
    color: #ff9a9a;
    background: rgba(255, 107, 107, 0.06);
    border-color: rgba(255, 107, 107, 0.3);
  }

  .service-toggle {
    width: 84px;
    min-height: 30px;
    padding-inline: 0.35rem;
  }

  .action-button.open {
    width: 100%;
    min-height: 32px;
    border-radius: 8px;
    letter-spacing: 0.01em;
  }

  .action-button.open.local {
    color: #0b1800;
    background: linear-gradient(135deg, #76b900, #a8e635);
    border-color: #b7f34e;
    box-shadow: 0 5px 14px rgba(118, 185, 0, 0.24);
  }

  .action-button.open.tail {
    color: #fff;
    background: linear-gradient(135deg, #00c6ff, #356dff);
    border-color: #6f93ff;
    box-shadow: 0 5px 14px rgba(53, 109, 255, 0.26);
  }

  .action-button:not(:disabled):hover {
    transform: translateY(-1px);
  }

  .action-button:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }

  .action-button:disabled {
    cursor: not-allowed;
    opacity: 0.38;
  }

  .operation-message {
    min-height: 0.75rem;
    margin-top: 0.3rem;
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 0.48rem;
    line-height: 1.35;
  }

  .endpoint { color: #52636d; }
  .success { color: #9edb00; }
  .error { color: #ff8a8a; }
  .working { display: inline-flex; align-items: center; gap: 0.3rem; color: #ffd166; }

  .spinner {
    width: 8px;
    height: 8px;
    border: 1px solid rgba(255, 209, 102, 0.3);
    border-top-color: #ffd166;
    border-radius: 50%;
    animation: spin 800ms linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 1200px) {
    .service-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .hermes-spotlight { grid-template-columns: 78px minmax(0, 1fr); }
    .portrait-shell { width: 78px; height: 88px; }
  }

  @media (max-width: 480px) {
    .hermes-spotlight { grid-template-columns: 58px minmax(0, 1fr); padding: 0.62rem; }
    .portrait-shell { width: 58px; height: 68px; }
    .identity-row { align-items: flex-start; flex-direction: column; }
    .actions-shell { grid-template-columns: 1fr; }
    .service-toggle { width: 84px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .action-button { transition: none; }
    .spinner { animation: none; }
  }
</style>
