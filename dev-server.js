import { createServer } from 'vite';
import si from 'systeminformation';
import express from 'express';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { pathToFileURL } from 'url';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, openSync, closeSync } from 'fs';
import {
  createHermesServiceController,
  hermesErrorPayload,
  hermesErrorStatus,
  sendHermesLogo,
} from './hermes-service.js';
import { readModelRuntimeDetails } from './model-runtime-details.js';
import { classifyInventoryConfig } from './model-inventory-section.js';
import { parseRunningLlamaProcessLine, selectedLlamaPorts } from './llama-process-inventory.js';
import {
  UNSLOTH_STUDIO_CLIENT_PORT,
  clientPortForLlamaProcess,
  isUnslothStudioProcess,
  mergeRunningLlamaProcess,
  modelMatchesRunningLlamaProcess
} from './runtime-model-inventory.js';
import {
  selectLiveModelFromProbe,
  selectPreferredLlamaRuntime,
} from './llama-runtime-selection.js';
import { classifyManagedStatus, DEGRADED_RESIDENT_STATUS } from './model-control-state.js';
import { readManagedProfileComponents } from './managed-profile-components.js';
import { stopAllManagedModels } from './model-control-operations.js';
import { createModelControlActionLock } from './model-control-action-lock.js';
import { createProcessController, validateStopRequest } from './process-control.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const hermesController = createHermesServiceController({
  execFile: execFileAsync,
  fetchImpl: globalThis.fetch,
});
const modelControlActionLock = createModelControlActionLock();
const processControlActionLock = createModelControlActionLock();
const processController = createProcessController({ execFile: execFileAsync });
const UPDATE_INTERVAL = 1000;
const LLAMA_SERVER = 'http://127.0.0.1:8001';
const MODELCTL = '/opt/dgx-model-control/modelctl';
const DGX_HEALTH_LATEST = '/home/mctdgx01/dgx-health/logs/latest.json';
const DGX_HEALTH_BASE_PORTS = [9000, 11000];
const DS4_RUNTIME = Object.freeze({
  profile_id: 'ds4-deepseek-v4-flash-256k-8889',
  display_name: 'DeepSeek V4 Flash 256K',
  runtime_label: 'ds4-server / DwarfStar',
  root: '/home/mctdgx01/sandbox/ds4',
  server: '/home/mctdgx01/sandbox/ds4/ds4-server',
  model: '/home/mctdgx01/sandbox/ds4/ds4flash.gguf',
  host: '127.0.0.1',
  port: 8889,
  ctx: 262144,
  max_tokens: 2048,
  cache_experts: '32GB',
  kv_dir: '/home/mctdgx01/sandbox/ds4/run/kv-disk-8889',
  kv_space_mb: 8192,
  run_dir: '/home/mctdgx01/sandbox/ds4/run',
  log_dir: '/home/mctdgx01/sandbox/ds4/run/logs',
  pidfile: '/home/mctdgx01/sandbox/ds4/run/ds4-8889.pid',
  nvrm_baseline: '/home/mctdgx01/sandbox/ds4/run/ds4-8889.nvrm-baseline',
  model_id: 'deepseek-v4-flash',
  env: {
    DS4_CUDA_STREAMING_EXPERT_CACHE_RESERVE_GB: '24',
    DS4_CUDA_Q8_F16_CACHE_RESERVE_MB: '12288'
  }
});
const NETWORK_INTERFACE_LABELS = {
  enP7s7: 'LAN',
  wlP9s9: 'Wi-Fi',
  tailscale0: 'Tailscale'
};
let previousNetworkCounters = new Map();

// Model notes — user-editable, stored in JSON file
const NOTES_FILE = '/opt/dgx-spark-status/model-notes.json';

function loadNotes() {
  try {
    if (existsSync(NOTES_FILE)) return JSON.parse(readFileSync(NOTES_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function saveNotes(notes) {
  writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2), 'utf8');
}

function visibleNetworkInterface(iface) {
  const name = String(iface || '');
  return name &&
    name !== 'lo' &&
    !name.startsWith('veth') &&
    !name.startsWith('br-') &&
    !name.startsWith('docker') &&
    !name.startsWith('virbr');
}

function networkInterfaceKind(iface) {
  const name = String(iface || '');
  if (name.startsWith('wl') || name.startsWith('wlan')) return 'wifi';
  if (name.startsWith('en') || name.startsWith('eth')) return 'lan';
  if (name.startsWith('tailscale')) return 'tailscale';
  return 'other';
}

function networkInterfaceLabel(iface) {
  return NETWORK_INTERFACE_LABELS[iface] || networkInterfaceKind(iface).toUpperCase();
}

function readNetworkCounter(iface, counter) {
  try {
    const value = readFileSync(`/sys/class/net/${iface}/statistics/${counter}`, 'utf8').trim();
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch (error) {
    return 0;
  }
}

function readNetworkOperstate(iface) {
  try {
    return readFileSync(`/sys/class/net/${iface}/operstate`, 'utf8').trim();
  } catch (error) {
    return 'unknown';
  }
}

function getSysNetworkIfaces(networkStats) {
  const ifaces = new Set((networkStats || []).map(n => n.iface).filter(visibleNetworkInterface));
  for (const iface of Object.keys(NETWORK_INTERFACE_LABELS)) ifaces.add(iface);
  try {
    for (const iface of readdirSync('/sys/class/net')) {
      if (visibleNetworkInterface(iface)) ifaces.add(iface);
    }
  } catch (error) {}
  return [...ifaces];
}

function normalizedNetworkStats(networkStats) {
  const now = Date.now();
  const systemStats = new Map((networkStats || [])
    .filter(n => visibleNetworkInterface(n.iface))
    .map(n => [n.iface, n]));
  const rows = [];
  const nextCounters = new Map();

  for (const iface of getSysNetworkIfaces(networkStats)) {
    const sysInfo = systemStats.get(iface) || {};
    const rxBytes = readNetworkCounter(iface, 'rx_bytes') || sysInfo.rx_bytes || 0;
    const txBytes = readNetworkCounter(iface, 'tx_bytes') || sysInfo.tx_bytes || 0;
    const previous = previousNetworkCounters.get(iface);
    const elapsedSeconds = previous ? Math.max((now - previous.timestamp) / 1000, 0.001) : 0;
    const rxFromSys = previous ? Math.max((rxBytes - previous.rx_bytes) / elapsedSeconds, 0) : 0;
    const txFromSys = previous ? Math.max((txBytes - previous.tx_bytes) / elapsedSeconds, 0) : 0;
    const rxSec = sysInfo.rx_sec > 0 ? sysInfo.rx_sec : rxFromSys;
    const txSec = sysInfo.tx_sec > 0 ? sysInfo.tx_sec : txFromSys;
    const operstate = readNetworkOperstate(iface);

    nextCounters.set(iface, { timestamp: now, rx_bytes: rxBytes, tx_bytes: txBytes });
    if (operstate !== 'up' && rxBytes === 0 && txBytes === 0) continue;

    rows.push({
      iface,
      label: networkInterfaceLabel(iface),
      kind: networkInterfaceKind(iface),
      operstate,
      rx_sec: rxSec,
      tx_sec: txSec,
      rx_bytes: rxBytes,
      tx_bytes: txBytes,
      rx_sec_mb: parseFloat((rxSec / (1024 ** 2)).toFixed(2)),
      tx_sec_mb: parseFloat((txSec / (1024 ** 2)).toFixed(2))
    });
  }

  previousNetworkCounters = nextCounters;
  rows.sort((a, b) => {
    const order = { wifi: 0, lan: 1, tailscale: 2, other: 3 };
    return (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.iface.localeCompare(b.iface);
  });

  const totalRx = rows.reduce((sum, n) => sum + (n.rx_sec || 0), 0);
  const totalTx = rows.reduce((sum, n) => sum + (n.tx_sec || 0), 0);
  const totalRxBytes = rows.reduce((sum, n) => sum + (n.rx_bytes || 0), 0);
  const totalTxBytes = rows.reduce((sum, n) => sum + (n.tx_bytes || 0), 0);

  return [{
    iface: 'all',
    label: 'Total',
    kind: 'total',
    operstate: rows.some(n => n.operstate === 'up') ? 'up' : 'unknown',
    rx_sec: totalRx,
    tx_sec: totalTx,
    rx_bytes: totalRxBytes,
    tx_bytes: totalTxBytes,
    rx_sec_mb: parseFloat((totalRx / (1024 ** 2)).toFixed(2)),
    tx_sec_mb: parseFloat((totalTx / (1024 ** 2)).toFixed(2))
  }, ...rows];
}

function validModelControlProfile(profile) {
  return typeof profile === 'string' && /^[A-Za-z0-9_-]+$/.test(profile);
}

function sanitizeOutput(value) {
  return String(value || '')
    .replace(/hf_[A-Za-z0-9_=-]+/g, '[redacted-token]')
    .slice(0, 20000);
}

function readDgxHealthLatest() {
  try {
    const fileStat = statSync(DGX_HEALTH_LATEST);
    const latest = JSON.parse(readFileSync(DGX_HEALTH_LATEST, 'utf8'));
    return {
      ok: true,
      path: DGX_HEALTH_LATEST,
      mtime: fileStat.mtime.toISOString(),
      age_seconds: Math.max(0, Math.round((Date.now() - fileStat.mtimeMs) / 1000)),
      latest
    };
  } catch (error) {
    return {
      ok: false,
      error: 'health_latest_unavailable',
      path: DGX_HEALTH_LATEST,
      message: sanitizeOutput(error.message || 'Health snapshot unavailable')
    };
  }
}

function parseModelctlJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (e) {
    return { ok: false, code: 'invalid_json', message: 'modelctl returned non-JSON output', stdout: sanitizeOutput(stdout) };
  }
}

async function runModelctl(args) {
  try {
    const { stdout, stderr } = await execFileAsync(MODELCTL, args, {
      timeout: 700000,
      maxBuffer: 1024 * 1024
    });
    const parsed = parseModelctlJson(stdout);
    if (stderr) parsed.stderr = sanitizeOutput(stderr);
    return parsed;
  } catch (error) {
    const stdout = sanitizeOutput(error.stdout);
    const stderr = sanitizeOutput(error.stderr);
    const parsed = stdout ? parseModelctlJson(stdout) : {};
    return {
      ok: false,
      code: parsed.code || 'modelctl_failed',
      message: parsed.message || error.message || 'modelctl failed',
      stdout,
      stderr,
      exitCode: error.code ?? null
    };
  }
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function memAvailableGb() {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf8');
    const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    return match ? Number(match[1]) / 1024 / 1024 : 0;
  } catch (error) {
    return 0;
  }
}

function ds4Timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '').replace('T', '_').slice(0, 15);
}

function readDs4Pid() {
  try {
    const raw = readFileSync(DS4_RUNTIME.pidfile, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch (error) {
    return null;
  }
}

function readProcCmdline(pid) {
  if (!pid) return '';
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch (error) {
    return '';
  }
}

function isDs4CommandLine(command) {
  const text = String(command || '');
  return text.includes(DS4_RUNTIME.server) &&
    text.includes('--port') &&
    new RegExp(`(^|\\s)${DS4_RUNTIME.port}(\\s|$)`).test(text);
}

function isDs4RuntimeCandidate(source = {}) {
  const port = Number(source.PORT || source.port || 0);
  const modelText = [
    source.API_MODEL_ID,
    source.SERVED_MODEL_NAME,
    source.MODEL_ID,
    source.modelAlias,
    source.model,
    source.name,
    source.__file,
    source.config
  ].filter(Boolean).join(' ').toLowerCase();

  return port === DS4_RUNTIME.port ||
    modelText.includes(DS4_RUNTIME.model_id) ||
    modelText.includes('ds4') ||
    modelText.includes('dwarfstar');
}

function ds4PidMatches(pid) {
  return isDs4CommandLine(readProcCmdline(pid));
}

async function isDs4PortListening() {
  const info = await ds4PortInfo();
  return info.listening;
}

async function ds4PortDetail() {
  const { stdout } = await execAsync(`ss -ltnp '( sport = :${DS4_RUNTIME.port} )' 2>/dev/null || true`);
  return sanitizeOutput(stdout);
}

async function ds4PortInfo() {
  const detail = await ds4PortDetail();
  const lines = detail.trim().split('\n').filter(Boolean);
  const listener = lines.find(line => line.includes('LISTEN') && line.includes(`:${DS4_RUNTIME.port}`)) || '';
  const parts = listener.trim().split(/\s+/);
  const local = parts[3] || '';
  const localMatch = local.match(/^(.*):(\d+)$/);
  const listenerHost = localMatch ? localMatch[1].replace(/^\[|\]$/g, '') : '';
  return {
    listening: Boolean(listener),
    detail,
    listener,
    listener_host: listenerHost,
    localhost_only: listenerHost === DS4_RUNTIME.host || listenerHost === 'localhost',
    bind_scope: listenerHost || null
  };
}

async function discoverDs4PidByPort() {
  const detail = await ds4PortDetail();
  const match = detail.match(/pid=(\d+)/);
  const pid = match ? Number(match[1]) : null;
  if (pid && ds4PidMatches(pid)) return pid;
  return null;
}

async function countNvidiaKernelWarnings() {
  try {
    const { stdout } = await execAsync("journalctl -k --no-pager 2>/dev/null | grep -iE 'NVRM|Xid|NV_ERR|out of memory|oom' | wc -l", {
      timeout: 10000,
      maxBuffer: 1024 * 1024
    });
    return Number(stdout.trim()) || 0;
  } catch (error) {
    return null;
  }
}

async function ensureDs4NvrmBaseline() {
  try {
    if (existsSync(DS4_RUNTIME.nvrm_baseline)) {
      const value = Number(readFileSync(DS4_RUNTIME.nvrm_baseline, 'utf8').trim());
      if (Number.isFinite(value)) return value;
    }
    const count = await countNvidiaKernelWarnings();
    if (Number.isFinite(count)) {
      mkdirSync(DS4_RUNTIME.run_dir, { recursive: true });
      writeFileSync(DS4_RUNTIME.nvrm_baseline, `${count}\n`, 'utf8');
    }
    return count;
  } catch (error) {
    return null;
  }
}

async function probeDs4Models(host = DS4_RUNTIME.host) {
  try {
    const res = await fetch(`http://${host}:${DS4_RUNTIME.port}/v1/models`, {
      signal: AbortSignal.timeout(3000)
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {}
    return {
      ok: res.ok,
      http_status: res.status,
      model_id: data?.data?.[0]?.id || null,
      models: data?.data || []
    };
  } catch (error) {
    return {
      ok: false,
      http_status: 0,
      model_id: null,
      models: [],
      error: sanitizeOutput(error.message || 'models probe failed')
    };
  }
}

async function getDs4Status(options = {}) {
  const portInfo = await ds4PortInfo();
  const portListening = portInfo.listening;
  let pid = readDs4Pid();
  let command = readProcCmdline(pid);
  let pidMatches = pid ? isDs4CommandLine(command) : false;
  if (!pidMatches && portListening) {
    const discoveredPid = await discoverDs4PidByPort();
    if (discoveredPid) {
      pid = discoveredPid;
      command = readProcCmdline(pid);
      pidMatches = true;
      try {
        writeFileSync(DS4_RUNTIME.pidfile, `${pid}\n`, 'utf8');
      } catch (error) {}
    }
  }
  const probeHost = portInfo.localhost_only ? DS4_RUNTIME.host : portInfo.listener_host;
  const modelsProbe = portListening && probeHost ? await probeDs4Models(probeHost) : {
    ok: false,
    http_status: 0,
    model_id: null,
    models: []
  };
  const mem = memAvailableGb();
  const nvrmBaseline = await ensureDs4NvrmBaseline();
  const nvrmCount = await countNvidiaKernelWarnings();
  const nvrmDelta = Number.isFinite(nvrmBaseline) && Number.isFinite(nvrmCount)
    ? nvrmCount - nvrmBaseline
    : null;

  if (options.enforceEmergencyGuard && pidMatches && mem < 5) {
    await stopDs4Runtime('mem_guard_status');
  }

  const running = Boolean(pidMatches && portListening);
  const endpointReachable = Boolean(modelsProbe.ok);
  const bindWarning = portListening && !portInfo.localhost_only
    ? `DS4 is listening on ${portInfo.listener_host}:${DS4_RUNTIME.port}, not ${DS4_RUNTIME.host}:${DS4_RUNTIME.port}.`
    : '';
  return {
    ok: true,
    profile_id: DS4_RUNTIME.profile_id,
    display_name: DS4_RUNTIME.display_name,
    runtime: DS4_RUNTIME.runtime_label,
    status: running ? 'running' : (pidMatches || portListening ? 'loading' : 'stopped'),
    running,
    pid,
    pid_matches: pidMatches,
    command: pidMatches ? command : '',
    host: DS4_RUNTIME.host,
    listener_host: portInfo.listener_host,
    bind_scope: portInfo.bind_scope,
    port: DS4_RUNTIME.port,
    endpoint: `http://${probeHost || DS4_RUNTIME.host}:${DS4_RUNTIME.port}`,
    ctx: DS4_RUNTIME.ctx,
    model_id: modelsProbe.model_id || DS4_RUNTIME.model_id,
    models_http_status: modelsProbe.http_status,
    models_ok: modelsProbe.ok,
    endpoint_reachable: endpointReachable,
    port_listening: portListening,
    port_detail: portInfo.detail,
    mem_available_gb: Number(mem.toFixed(2)),
    nvrm_baseline: nvrmBaseline,
    nvrm_count: nvrmCount,
    nvrm_delta: nvrmDelta,
    pidfile: DS4_RUNTIME.pidfile,
    log_dir: DS4_RUNTIME.log_dir,
    localhost_only: portInfo.localhost_only,
    warning: bindWarning
  };
}

async function waitForDs4Port(pid, baselineCount, logFile) {
  for (let i = 0; i < 120; i++) {
    const available = memAvailableGb();
    if (available < 5) {
      await stopDs4Runtime('mem_guard_start');
      return { ok: false, code: 'FAILED_RAM_GUARD', message: 'Start aborted: MemAvailable dropped below 5GiB.', mem_available_gb: Number(available.toFixed(2)) };
    }
    const nvrmNow = await countNvidiaKernelWarnings();
    if (Number.isFinite(baselineCount) && Number.isFinite(nvrmNow) && nvrmNow > baselineCount) {
      await stopDs4Runtime('nvrm_guard_start');
      return { ok: false, code: 'NVRM_GUARD', message: 'Start aborted: new NVIDIA/NVRM warning appeared.', nvrm_baseline: baselineCount, nvrm_count: nvrmNow, log_file: logFile };
    }
    if (await isDs4PortListening()) {
      const discoveredPid = await discoverDs4PidByPort();
      if (discoveredPid) {
        writeFileSync(DS4_RUNTIME.pidfile, `${discoveredPid}\n`, 'utf8');
        return { ok: true, pid: discoveredPid };
      }
      return {
        ok: false,
        code: 'port_occupied_unverified',
        message: 'Port 8889 opened, but the listener is not the verified ds4-server command.',
        port_detail: await ds4PortDetail(),
        log_file: logFile
      };
    }
    if (i > 2 && !ds4PidMatches(pid) && !(await discoverDs4PidByPort())) {
      return { ok: false, code: 'process_exited_before_port', message: 'ds4-server exited before port 8889 opened' };
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return { ok: false, code: 'port_timeout', message: 'Timed out waiting for localhost:8889.' };
}

async function startDs4Runtime() {
  mkdirSync(DS4_RUNTIME.kv_dir, { recursive: true });
  mkdirSync(DS4_RUNTIME.log_dir, { recursive: true });

  const current = await getDs4Status();
  if (current.running) {
    return { ...current, action: 'start', status: 'already_running' };
  }
  if (await isDs4PortListening()) {
    return {
      ok: false,
      code: 'port_occupied',
      message: 'Port 8889 is already listening but is not the verified ds4-server PID.',
      port_detail: await ds4PortDetail()
    };
  }
  const available = memAvailableGb();
  if (available < 20) {
    return {
      ok: false,
      code: 'FAILED_RAM_GUARD',
      message: `Start aborted: MemAvailable ${available.toFixed(2)}GiB is below 20GiB.`,
      mem_available_gb: Number(available.toFixed(2))
    };
  }

  const baseline = await countNvidiaKernelWarnings();
  if (Number.isFinite(baseline)) {
    writeFileSync(DS4_RUNTIME.nvrm_baseline, `${baseline}\n`, 'utf8');
  }

  const logFile = `${DS4_RUNTIME.log_dir}/ds4-dashboard-8889-${ds4Timestamp()}.log`;
  const outFd = openSync(logFile, 'a');
  const args = [
    'env',
    `DS4_CUDA_STREAMING_EXPERT_CACHE_RESERVE_GB=${DS4_RUNTIME.env.DS4_CUDA_STREAMING_EXPERT_CACHE_RESERVE_GB}`,
    `DS4_CUDA_Q8_F16_CACHE_RESERVE_MB=${DS4_RUNTIME.env.DS4_CUDA_Q8_F16_CACHE_RESERVE_MB}`,
    DS4_RUNTIME.server,
    '-m', DS4_RUNTIME.model,
    '--cuda',
    '--ssd-streaming',
    '--ssd-streaming-cache-experts', DS4_RUNTIME.cache_experts,
    '--host', DS4_RUNTIME.host,
    '--port', String(DS4_RUNTIME.port),
    '--ctx', String(DS4_RUNTIME.ctx),
    '-n', String(DS4_RUNTIME.max_tokens),
    '--kv-disk-dir', DS4_RUNTIME.kv_dir,
    '--kv-disk-space-mb', String(DS4_RUNTIME.kv_space_mb)
  ];

  const child = spawn('setsid', args, {
    cwd: DS4_RUNTIME.root,
    detached: true,
    stdio: ['ignore', outFd, outFd]
  });
  child.unref();
  closeSync(outFd);
  writeFileSync(DS4_RUNTIME.pidfile, `${child.pid}\n`, 'utf8');

  const waitResult = await waitForDs4Port(child.pid, baseline, logFile);
  if (!waitResult.ok) return { ok: false, action: 'start', pid: child.pid, log_file: logFile, ...waitResult };

  const models = await probeDs4Models();
  if (!models.ok) {
    await stopDs4Runtime('models_probe_failed');
    return {
      ok: false,
      action: 'start',
      code: 'models_probe_failed',
      message: `/v1/models failed with HTTP ${models.http_status || 0}.`,
      models_http_status: models.http_status,
      log_file: logFile
    };
  }

  return {
    ...(await getDs4Status()),
    action: 'start',
    status: 'running',
    log_file: logFile,
    nvrm_baseline: baseline
  };
}

async function stopDs4Runtime(reason = 'dashboard_stop') {
  const pid = readDs4Pid();
  const command = readProcCmdline(pid);
  if (!pid || !isDs4CommandLine(command)) {
    return {
      ok: false,
      action: 'stop',
      code: 'pid_not_verified',
      message: 'Refusing to stop: pidfile PID is missing or is not ds4-server on port 8889.',
      pid
    };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    return { ok: false, action: 'stop', code: 'sigterm_failed', message: sanitizeOutput(error.message), pid };
  }

  for (let i = 0; i < 15; i++) {
    if (!ds4PidMatches(pid)) {
      return { ok: true, action: 'stop', status: 'stopped', pid, reason };
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (ds4PidMatches(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      return { ok: false, action: 'stop', code: 'sigkill_failed', message: sanitizeOutput(error.message), pid };
    }
  }

  for (let i = 0; i < 5; i++) {
    if (!ds4PidMatches(pid)) {
      return { ok: true, action: 'stop', status: 'stopped', pid, reason, escalated: true };
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return { ok: false, action: 'stop', code: 'process_still_alive', message: 'ds4-server PID is still alive after stop.', pid };
}

async function smokeDs4Runtime() {
  const before = await getDs4Status({ enforceEmergencyGuard: true });
  if (!before.running) {
    return { ok: false, code: 'not_running', message: 'ds4-server is not running on localhost:8889.', status: before };
  }

  const nvrmBefore = await countNvidiaKernelWarnings();
  const model = before.model_id || DS4_RUNTIME.model_id;
  let chatHttpStatus = 0;
  let chatContent = '';
  try {
    const res = await fetch(`http://${DS4_RUNTIME.host}:${DS4_RUNTIME.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: DS4_OK' }],
        max_tokens: 64,
        temperature: 0
      }),
      signal: AbortSignal.timeout(120000)
    });
    chatHttpStatus = res.status;
    const data = await res.json().catch(() => null);
    chatContent = data?.choices?.[0]?.message?.content || '';
  } catch (error) {
    return { ok: false, code: 'chat_failed', message: sanitizeOutput(error.message), models_http_status: before.models_http_status };
  }

  const after = await getDs4Status({ enforceEmergencyGuard: true });
  const nvrmAfter = await countNvidiaKernelWarnings();
  const nvrmDelta = Number.isFinite(nvrmBefore) && Number.isFinite(nvrmAfter) ? nvrmAfter - nvrmBefore : null;
  return {
    ok: chatHttpStatus === 200 && after.running && (!Number.isFinite(nvrmDelta) || nvrmDelta === 0),
    models_http_status: before.models_http_status,
    chat_http_status: chatHttpStatus,
    chat_content: sanitizeOutput(chatContent).slice(0, 200),
    pid_alive_after_chat: after.running,
    mem_available_gb: after.mem_available_gb,
    nvrm_before: nvrmBefore,
    nvrm_after: nvrmAfter,
    nvrm_delta: nvrmDelta,
    status: after
  };
}

function firstCommandWord(command) {
  const trimmed = String(command || '').trim();
  return trimmed.split(/\s+/)[0] || '';
}

async function startModelAsync(profile) {
  const status = enrichModelControlResult(await runModelctl(['status', profile]));
  if (!status.ok) return status;
  if (!status.control_enabled) {
    return { ok: false, code: 'control_disabled', message: `Control is disabled for profile: ${profile}` };
  }
  if (status.status === 'running') {
    return { ok: true, profile_id: profile, action: 'start', status: 'already_running' };
  }
  if (status.status === 'loading' || status.status === 'starting') {
    return { ok: true, profile_id: profile, action: 'start', status: status.status };
  }
  if (status.status === DEGRADED_RESIDENT_STATUS) {
    return {
      ok: false,
      code: 'managed_components_active',
      message: 'Managed model components are still active. Stop the existing preset before starting again.',
      status: status.status,
      active_components: status.active_components || []
    };
  }

  const startCmd = String(status.start_cmd || '').trim();
  const tmuxSession = String(status.tmux_session || '').trim();
  const firstWord = firstCommandWord(startCmd);
  if (!startCmd || !firstWord || !existsSync(firstWord)) {
    return { ok: false, code: 'start_disabled', message: `START_CMD target missing: ${firstWord || '(empty)'}` };
  }
  if (!tmuxSession || !validModelControlProfile(tmuxSession)) {
    return { ok: false, code: 'invalid_tmux_session', message: 'Invalid tmux session in model-control profile' };
  }

  const available = memAvailableGb();
  const minRam = Number(status.min_available_ram_gb || 10);
  if (Number.isFinite(minRam) && available < minRam) {
    return {
      ok: false,
      code: 'FAILED_RAM_GUARD',
      message: `Start aborted: available RAM ${available.toFixed(2)}GB is below ${minRam}GB.`,
      mem_available_gb: Number(available.toFixed(2))
    };
  }

  const runtimeLogDir = '/home/mctdgx01/logs/dgx-model-control';
  const runtimeLog = `${runtimeLogDir}/${profile}.runtime.log`;
  mkdirSync(runtimeLogDir, { recursive: true });
  const tmuxCommand = `bash -lc ${shellSingleQuote(`${startCmd} 2>&1 | tee -a ${shellSingleQuote(runtimeLog)}`)}`;
  await execFileAsync('tmux', ['new-session', '-d', '-s', tmuxSession, tmuxCommand], {
    timeout: 10000,
    maxBuffer: 1024 * 1024
  });
  return {
    ok: true,
    profile_id: profile,
    action: 'start',
    status: 'starting',
    tmux_session: tmuxSession,
    mem_available_gb: Number(available.toFixed(2)),
    runtime_log: runtimeLog
  };
}

function parseModelMeta(modelId) {
  if (!modelId) return { model: null, quantFormat: null, paramSize: null };
  const quantMatch = modelId.match(/(Q\d+_K(?:_[A-Z]+)?|Q\d+_\d+|F16|F32|BF16|FP8|MXFP4)/i);
  const model = modelId
    .replace(/-\d+-of-\d+\.gguf.*$/, '')
    .replace(/\.gguf.*$/, '')
    .replace(/^.*\//, '');
  const paramMatch = model.match(/(\d+B)/i);
  return {
    model,
    quantFormat: quantMatch ? quantMatch[1] : null,
    paramSize: paramMatch ? paramMatch[1] : null
  };
}

function parseEnvText(txt) {
  const env = {};
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    val = val.replace(/^['"]|['"]$/g, '');
    env[key] = val;
  }
  return env;
}

function normalizeRuntimeValue(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

function envLooksLikeLlamaRuntime(env = {}) {
  const haystack = [
    env.RUNTIME,
    env.ENGINE,
    env.MODEL_PATH,
    env.API_MODEL_ID,
    env.SERVED_MODEL_NAME,
    env.MODEL_ID,
    env.DISPLAY_NAME,
    env.MODEL_NAME,
    env.START_CMD,
    env.TMUX_SESSION,
    env.__file
  ].filter(Boolean).join(' ').toLowerCase();

  return haystack.includes('llama.cpp') ||
    haystack.includes('llama-cpp') ||
    haystack.includes('llamacpp') ||
    haystack.includes('llama-server') ||
    haystack.includes('.gguf') ||
    /\bgguf\b/.test(haystack);
}

function classifyEnvRuntime(env) {
  const values = [normalizeRuntimeValue(env.RUNTIME), normalizeRuntimeValue(env.ENGINE)];
  if (values.some(v => ['llama.cpp', 'llama-cpp', 'llama-server', 'llama'].includes(v))) {
    return 'llama';
  }
  if (values.some(v => ['vllm'].includes(v))) {
    return 'vllm';
  }
  if (envLooksLikeLlamaRuntime(env)) {
    return 'llama';
  }
  return 'vllm';
}

function numericPort(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function getRunningLlamaProcesses() {
  try {
    const { stdout } = await execAsync("ps -eo pid=,ppid=,lstart=,args= | grep -E '[/]llama-server( |$)' | grep -v grep || true");
    return stdout.trim().split('\n').filter(Boolean).map(parseRunningLlamaProcessLine).filter(item => item?.port);
  } catch (error) {
    return [];
  }
}

async function getRunningLlamaProcessByPort() {
  const processes = await getRunningLlamaProcesses();
  return new Map(processes.map(item => [Number(item.port), item]));
}

function modelApiLooksLikeLlama(data) {
  const first = data?.data?.[0] || data?.models?.[0] || {};
  const text = JSON.stringify({
    owned_by: first.owned_by,
    id: first.id || first.name || first.model,
    format: first.details?.format,
    family: first.details?.family,
    aliases: first.aliases
  }).toLowerCase();

  return text.includes('llamacpp') ||
    text.includes('llama.cpp') ||
    text.includes('"format":"gguf"') ||
    /\bgguf\b/.test(text);
}

export function liveModelForLlamaProcess(payload, process = {}) {
  return selectLiveModelFromProbe(payload, {
    requireSingleDistinctId: isUnslothStudioProcess(process),
  });
}

function envContextLength(env) {
  const raw = env.CONTEXT_LENGTH || env.MAX_MODEL_LEN || env.CTX_SIZE;
  const parsed = raw ? parseInt(raw, 10) : null;
  return Number.isFinite(parsed) ? parsed : null;
}

function isPlaceholderModelName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return !normalized || normalized === 'model' || normalized === '/model';
}

function envDisplayName(env) {
  const explicitName = env.DISPLAY_NAME || env.MODEL_NAME;
  if (explicitName && !isPlaceholderModelName(explicitName)) return explicitName;

  const servedName = env.SERVED_MODEL_NAME || env.MODEL_ID;
  if (servedName && !isPlaceholderModelName(servedName)) return servedName;

  if (env.API_MODEL_ID && !isPlaceholderModelName(env.API_MODEL_ID)) return env.API_MODEL_ID;
  return (env.MODEL_PATH || '').split('/').filter(Boolean).pop();
}

function normalizedIdentityValue(value) {
  return String(value || '').trim().toLowerCase();
}

function candidateProcessIdentity(candidate = {}) {
  const env = candidate.env || {};
  const process = candidate.process || {};
  return {
    pid: candidate.pid ?? process.pid ?? env.PID ?? env.SERVER_PID ?? env.LLAMA_PID,
    ppid: candidate.ppid ?? process.ppid ?? env.PPID ?? env.SERVER_PPID ?? env.LLAMA_PPID,
    startedAt: candidate.startedAt ?? process.startedAt ?? env.STARTED_AT ?? env.START_TIME ?? env.STARTED,
    command: candidate.command ?? process.command ?? env.COMMAND
  };
}

function stableProcessIdentityState(candidate = {}, process = {}) {
  const configuredIdentity = candidateProcessIdentity(candidate);
  const identityFields = ['pid', 'ppid', 'startedAt', 'command'];
  const comparableFields = identityFields.filter(field => {
    const expected = normalizedIdentityValue(configuredIdentity[field]);
    const actual = normalizedIdentityValue(process[field]);
    return expected && actual;
  });
  if (!comparableFields.length) return 'unknown';
  return comparableFields.every(field =>
    normalizedIdentityValue(configuredIdentity[field]) === normalizedIdentityValue(process[field])
  ) ? 'match' : 'conflict';
}

function candidateModelIdentity(candidate = {}) {
  const env = candidate.env || {};
  const displayName = envDisplayName(env);
  return {
    apiModel: candidate.liveApiModelId || candidate.apiModel || env.API_MODEL_ID || null,
    servedModelName: candidate.servedModelName || env.SERVED_MODEL_NAME || env.MODEL_ID || null,
    modelAlias: candidate.alias || candidate.modelAlias || env.API_MODEL_ID || null,
    name: candidate.name || displayName,
    key: candidate.key || displayName,
    modelPath: candidate.modelPath || candidate.path || env.MODEL_PATH || null,
    path: candidate.modelPath || candidate.path || env.MODEL_PATH || null
  };
}

export function configuredLlamaCandidateMatchesProcess(candidate = {}, process = {}, candidates = []) {
  const stableIdentity = stableProcessIdentityState(candidate, process);
  if (stableIdentity === 'match' ||
      modelMatchesRunningLlamaProcess(candidateModelIdentity(candidate), process)) {
    return true;
  }
  if (stableIdentity === 'conflict') return false;

  const candidateClientPort = numericPort(candidate.clientPort ?? candidate.port);
  const processClientPort = numericPort(process.clientPort);
  if (!candidateClientPort || !processClientPort || candidateClientPort !== processClientPort) {
    return false;
  }

  if (!isUnslothStudioProcess(process)) return true;

  const candidatePool = Array.isArray(candidates) && candidates.length ? candidates : [candidate];
  const sameClientPortCandidates = candidatePool.filter(item =>
    numericPort(item?.clientPort ?? item?.port) === processClientPort
  );
  return sameClientPortCandidates.length === 1;
}

function enrichModelControlProfile(profile = {}) {
  const runtimeDetails = readModelRuntimeDetails(profile, readFileSync);
  const managedComponents = readManagedProfileComponents(profile);
  const managedState = managedComponents.length
    ? classifyManagedStatus(profile.status, managedComponents)
    : null;
  if (!runtimeDetails && !managedState) return profile;

  return {
    ...profile,
    ...(managedState || {}),
    ...(managedComponents.length ? { managed_components: managedComponents } : {}),
    ...(runtimeDetails ? { runtime_details: runtimeDetails } : {})
  };
}

function enrichModelControlResult(result) {
  if (!result || typeof result !== 'object') return result;
  const enriched = { ...result };
  if (Array.isArray(enriched.profiles)) {
    enriched.profiles = enriched.profiles.map(enrichModelControlProfile);
  }
  if (Array.isArray(enriched.models)) {
    enriched.models = enriched.models.map(enrichModelControlProfile);
  }
  if (enriched.profile && typeof enriched.profile === 'object') {
    enriched.profile = enrichModelControlProfile(enriched.profile);
  }
  if (enriched.profile_id || enriched.api_model_id || enriched.config_file) {
    return enrichModelControlProfile(enriched);
  }
  return enriched;
}

function envTruthy(value) {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value || '').trim().toLowerCase());
}

function envProbeHost(env = {}) {
  const host = String(env.HOST || '').trim();
  if (!host || host === '0.0.0.0' || host === '::' || host === '[::]') return '127.0.0.1';
  return host;
}

function envVllmVersion(env = {}) {
  const explicit = env.VLLM_VERSION || env.VLLM_IMAGE_VERSION;
  if (explicit) return String(explicit).replace(/^v/i, '');

  const image = env.IMAGE || env.DOCKER_IMAGE || '';
  const match = String(image).match(/v(\d+\.\d+(?:\.\d+)?)/i);
  return match ? match[1] : '';
}

function envRuntimeDisplayLabel(env = {}, runtime) {
  if (runtime === 'llama') return env.ENGINE || 'llama-server';
  const version = envVllmVersion(env);
  return version ? `vLLM ${version}` : (env.ENGINE || 'vLLM');
}

function envModelFunctionLabel(env, runtime) {
  const parts = [];
  const engine = envRuntimeDisplayLabel(env, runtime);

  if (runtime === 'llama') {
    parts.push('Plain GGUF');
    parts.push('OpenAI-compatible API');
  } else {
    parts.push(engine);
    if (env.QUANTIZATION || env.QUANTIZATION_FORMAT) {
      parts.push(env.QUANTIZATION || env.QUANTIZATION_FORMAT);
    }
  }

  if (envTruthy(env.SPECULATIVE_DECODING)) {
    parts.push(env.SPECULATIVE_METHOD ? `Speculative: ${env.SPECULATIVE_METHOD}` : 'Speculative decoding');
  }
  if (envTruthy(env.IS_LORA)) parts.push('LoRA');
  if (env.DRAFT_MODEL_PATH) parts.push('Draft model');
  if (env.MODEL_ROLE) parts.push(env.MODEL_ROLE);

  return parts.filter(Boolean).join(' · ');
}

function envConnectionLabel(env, runtime) {
  const port = env.PORT ? `:${env.PORT}` : '';
  const ctx = envContextLength(env);
  const ctxLabel = ctx ? `ctx ${(ctx / 1024).toFixed(0)}K` : '';
  const engine = envRuntimeDisplayLabel(env, runtime);
  return [engine, port, ctxLabel].filter(Boolean).join(' · ');
}

function envDashboardClientPort(env = {}) {
  return numericPort(env.DASHBOARD_CLIENT_PORT || env.LAN_PROXY_PORT || env.PORT);
}

function envDashboardBackendPort(env = {}) {
  return numericPort(env.DASHBOARD_BACKEND_PORT || env.BACKEND_PORT);
}

function envDashboardProbeUrl(env = {}) {
  const explicit = String(env.DASHBOARD_PROBE_URL || env.HEALTH_URL || '').trim();
  if (explicit) return explicit;
  const probePort = numericPort(env.DASHBOARD_PROBE_PORT || env.GUARD_PORT || env.PORT);
  return probePort ? `http://${envProbeHost(env)}:${probePort}/v1/models` : null;
}

function contextLabel(ctx) {
  const parsed = Number(ctx);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return `${Math.round(parsed / 1024)}K`;
}

function graphNode(id, label, type, extra = {}) {
  return {
    id,
    label,
    type,
    status: extra.status || 'unknown',
    ...extra
  };
}

function graphEdge(source, target, label, extra = {}) {
  return {
    id: `${source}->${target}:${label}`,
    source,
    target,
    label,
    type: extra.type || 'relationship',
    status: extra.status || 'nominal',
    ...extra
  };
}

async function readEnvFiles(dir) {
  const files = [];
  try {
    const { stdout } = await execAsync(`ls -1 ${dir}/*.env 2>/dev/null || true`);
    for (const file of stdout.trim().split('\n').filter(Boolean)) {
      try {
        files.push({ file, env: parseEnvText(readFileSync(file, 'utf8')) });
      } catch (e) {}
    }
  } catch (e) {}
  return files;
}

async function probeOpenAIModels(port, host = '127.0.0.1') {
  if (!port) return { status: 'stopped', models: [] };
  try {
    const res = await fetch(`http://${host}:${port}/v1/models`, { signal: AbortSignal.timeout(900) });
    if (!res.ok) return { status: 'stopped', models: [] };
    const data = await res.json();
    return {
      status: data?.data?.length ? 'running' : 'unknown',
      models: data?.data || []
    };
  } catch (e) {
    return { status: 'stopped', models: [] };
  }
}

function graphRuntimeDefaults() {
  return [];
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return null;
  }
}

function qwen36BoundedNvrmState(profileId) {
  const roots = {
    qwen36native2568537: '/home/mctdgx01/models/operation_records/qwen36_native256_bounded_nvrm_20260714_065144',
    'qwen36-35b-a3b-unsloth-nvfp4-fast-vllm25-cutlass-256k': '/home/mctdgx01/models/operation_records/qwen36_fast_approved_cutlass_20260714_085401'
  };
  const root = roots[profileId];
  if (!root) return {};
  const cycle = `${root}/current-cycle`;
  const classification = readJsonFile(`${cycle}/startup-classification.json`);
  const failure = readJsonFile(`${cycle}/failure.json`);
  let watchdog = {};
  let lastTransition = null;
  try {
    const lines = readFileSync(`${cycle}/watchdog.csv`, 'utf8').trim().split('\n');
    if (lines.length >= 2) {
      const keys = lines[0].replace(/\r/g, '').split(',');
      const values = lines[lines.length - 1].replace(/\r/g, '').split(',');
      watchdog = Object.fromEntries(keys.map((key, index) => [key, values[index]]));
    }
  } catch (error) {}
  try {
    const transitions = readFileSync(`${cycle}/phase-transitions.log`, 'utf8').trim().split('\n').filter(Boolean);
    lastTransition = transitions.at(-1) || null;
  } catch (error) {}

  const startupCount = Number(classification?.startup_nv_err_no_memory_count);
  const totalNvrmDelta = Number(watchdog.nvrm_delta);
  const startupCountValue = Number.isFinite(startupCount) ? startupCount : null;
  const postReadyDelta = Number.isFinite(totalNvrmDelta) && startupCountValue !== null
    ? Math.max(0, totalNvrmDelta - startupCountValue)
    : null;
  const safetyStatus = failure
    ? `FAILED_${failure.event}`
    : (classification?.classification || 'STARTUP_PENDING');

  return {
    startupSafetyStatus: safetyStatus,
    startupNvrmCount: startupCountValue,
    postReadyNvrmDelta: postReadyDelta,
    zeroNvrmCertified: startupCountValue === 0 && postReadyDelta === 0 && !failure,
    safetyPhase: watchdog.phase || null,
    lastHealthCheck: watchdog.timestamp || null,
    lastTransition,
    safetyEvidence: cycle
  };
}

function mergeRuntimeInfo(base, env, profile) {
  if (base?.source === 'ds4-dwarfstar') {
    return {
      ...base,
      label: DS4_RUNTIME.display_name,
      runtime: DS4_RUNTIME.runtime_label,
      engine: DS4_RUNTIME.runtime_label,
      context: DS4_RUNTIME.ctx,
      modelId: DS4_RUNTIME.model_id,
      modelPath: DS4_RUNTIME.model,
      profileId: DS4_RUNTIME.profile_id,
      controlEnabled: true,
      access: ['local']
    };
  }

  const runtime = env ? classifyEnvRuntime(env) : normalizeRuntimeValue(base.runtime).includes('llama') ? 'llama' : 'vllm';
  const displayName = envDisplayName(env || {}) || profile?.DISPLAY_NAME || base.label;
  const rawModelPath = env?.MODEL_PATH || profile?.MODEL_PATH || null;
  const modelPath = rawModelPath;
  return {
    ...base,
    label: displayName || base.label,
    runtime: runtime === 'llama' ? 'llama.cpp' : envRuntimeDisplayLabel(env || profile || {}, runtime),
    engine: env?.ENGINE || profile?.ENGINE || (runtime === 'llama' ? 'llama-server' : 'vllm'),
    context: envContextLength(env || {}) || Number(profile?.CTX_SIZE || profile?.CONTEXT_LENGTH || profile?.MAX_MODEL_LEN) || base.context || null,
    modelId: env?.API_MODEL_ID || env?.SERVED_MODEL_NAME || env?.MODEL_ID || profile?.API_MODEL_ID || profile?.SERVED_MODEL_NAME || profile?.MODEL_ID || null,
    loraModelId: env?.LORA_MODEL_ID || profile?.LORA_MODEL_ID || null,
    loraPath: env?.LORA_PATH || profile?.LORA_PATH || null,
    baseModelPath: env?.BASE_MODEL_PATH || profile?.BASE_MODEL_PATH || null,
    drafterPath: env?.DRAFTER_PATH || env?.DRAFT_MODEL_PATH || profile?.DRAFTER_PATH || profile?.DRAFT_MODEL_PATH || null,
    modelPath,
    config: env?.__file || profile?.CONFIG_FILE || null,
    profileId: profile?.PROFILE_ID || null,
    controlEnabled: envTruthy(profile?.CONTROL_ENABLED || env?.CONTROL_ENABLED),
    role: env?.MODEL_ROLE || null,
    modelRepository: env?.MODEL_REPOSITORY || null,
    modelRevision: env?.MODEL_REVISION || null,
    runtimeStack: env?.RUNTIME_STACK || null,
    pythonVersion: env?.PYTHON_VERSION || null,
    vllmVersion: env?.VLLM_VERSION || null,
    flashinferVersion: env?.FLASHINFER_VERSION || null,
    cutlassDslVersion: env?.CUTLASS_DSL_VERSION || null,
    torchVersion: env?.TORCH_VERSION || null,
    venv: env?.VENV || null,
    cuteDslArch: env?.CUTE_DSL_ARCH || null,
    containerName: env?.CONTAINER_NAME || profile?.CONTAINER_NAME || null,
    image: env?.IMAGE || null,
    imageId: env?.IMAGE_ID || null,
    nativeContext: Number(env?.NATIVE_CONTEXT_LENGTH) || null,
    validatedInput: Number(env?.VALIDATED_MAX_INPUT) || null,
    recommendedOutput: Number(env?.RECOMMENDED_MAX_OUTPUT) || null,
    validatedOutput: Number(env?.VALIDATED_MAX_OUTPUT) || null,
    maxNumSeqs: Number(env?.MAX_NUM_SEQS) || null,
    maxNumBatchedTokens: Number(env?.MAX_NUM_BATCHED_TOKENS) || null,
    gpuMemoryUtilization: Number(env?.GPU_MEMORY_UTILIZATION) || null,
    kvDtype: env?.KV_CACHE_DTYPE || null,
    attentionBackend: env?.ATTENTION_BACKEND || null,
    moeBackend: env?.MOE_BACKEND || null,
    linearBackend: env?.LINEAR_BACKEND || null,
    atomicAdd: env?.ATOMIC_ADD || null,
    loadFormat: env?.LOAD_FORMAT || null,
    executorBackend: env?.EXECUTOR_BACKEND || null,
    mtpEnabled: envTruthy(env?.MTP_ENABLED),
    mtpOptionalTokens: Number(env?.MTP_OPTIONAL_TOKENS) || null,
    yarnEnabled: envTruthy(env?.YARN_ENABLED),
    thinkingDefault: envTruthy(env?.THINKING_DEFAULT),
    chunkedPrefill: envTruthy(env?.CHUNKED_PREFILL),
    conflictProfileIds: env?.CONFLICT_PROFILE_IDS || profile?.CONFLICT_PROFILE_IDS || null,
    localEndpoint: env?.LOCAL_ENDPOINT || null,
    tailscaleEndpoint: env?.TAILSCALE_ENDPOINT || null,
    speculative: envTruthy(env?.SPECULATIVE_DECODING) || Boolean(env?.SPECULATIVE_METHOD || env?.SPECULATIVE_TYPE),
    speculativeType: env?.SPECULATIVE_TYPE || env?.SPECULATIVE_METHOD || null,
    isLora: envTruthy(env?.IS_LORA) || Boolean(env?.LORA_PATH || env?.LORA_MODEL_ID || profile?.LORA_MODEL_ID)
  };
}

function graphHealthStatus(healthResult) {
  if (!healthResult?.ok) return 'unknown';
  const statuses = healthResult.latest?.status || [];
  if (healthResult.age_seconds > 180) return 'loading';
  if (statuses.some(status => /EMERGENCY|BLOCK_START|STALE_MODEL/i.test(status))) return 'stopped';
  if (statuses.some(status => /WARN|GPU_MEMORY|MODEL_INITIALIZING|STALE/i.test(status))) return 'loading';
  return 'running';
}

function graphHealthPortStatus(latest, port, ds4Status = null) {
  if (port === DS4_RUNTIME.port && ds4Status?.running) return 'running';
  const key = String(port);
  const endpoint = latest?.endpoint_health?.[port === 9000 ? 'dashboard_loopback' : key] || {};
  const probe = endpoint.models_endpoint || endpoint.probe || endpoint;
  const listeners = latest?.listening_ports?.ports?.[key] || [];
  if (probe?.ok) return 'running';
  if (Array.isArray(listeners) && listeners.length > 0) return 'loading';
  return 'stopped';
}

function graphHealthPortLabel(port) {
  if (port === DS4_RUNTIME.port) return 'DS4 DwarfStar :8889';
  if (port === 9000) return 'Main Dashboard :9000';
  if (port === 11000) return 'DGX Dashboard :11000';
  return `Model API :${port}`;
}

async function buildGraphifyTopology() {
  const [runtimeConfigsRaw, profileConfigsRaw] = await Promise.all([
    readEnvFiles('/etc/vllm/models'),
    readEnvFiles('/etc/dgx-model-control/models.d')
  ]);
  const ds4Status = null;
  const healthResult = readDgxHealthLatest();
  const healthLatest = healthResult.ok ? healthResult.latest : null;
  const healthStatus = graphHealthStatus(healthResult);
  const defaultRoute = healthLatest?.routes?.default_route || {};

  const runtimeConfigs = runtimeConfigsRaw.map(item => ({ ...item.env, __file: item.file }));
  const profileConfigs = profileConfigsRaw.map(item => ({ ...item.env, __file: item.file }));
  const runtimeByPort = new Map(runtimeConfigs.filter(env => env.PORT).map(env => [Number(env.PORT), env]));
  const profileByPort = new Map(profileConfigs.filter(env => env.PORT).map(env => [Number(env.PORT), env]));

  const runtimeBases = graphRuntimeDefaults();
  for (const env of runtimeConfigs) {
    const port = Number(env.PORT);
    if (!port || runtimeBases.some(item => item.port === port)) continue;
    const runtime = classifyEnvRuntime(env);
    runtimeBases.push({
      port,
      label: envDisplayName(env) || `${runtime === 'llama' ? 'llama.cpp' : 'vLLM'} :${port}`,
      runtime: runtime === 'llama' ? 'llama.cpp' : 'vLLM',
      context: envContextLength(env)
    });
  }

  const nodes = [
    graphNode('host:edgexpert-ba03', 'DGX edgexpert-ba03', 'host', {
      status: 'running',
      address: '192.168.0.21'
    }),
    graphNode('dashboard:9000', 'Main Dashboard :9000', 'dashboard', {
      status: 'running',
      port: 9000,
      access: ['local', 'LAN', 'Tailscale']
    }),
    graphNode('health:agent', 'DGX Health Agent', 'health', {
      status: healthStatus,
      ageSeconds: healthResult.age_seconds ?? null,
      statuses: healthLatest?.status || [],
      path: DGX_HEALTH_LATEST
    }),
    graphNode('health:latest', 'Health latest.json', 'health', {
      status: healthStatus,
      ageSeconds: healthResult.age_seconds ?? null,
      timestamp: healthLatest?.timestamp || null,
      path: DGX_HEALTH_LATEST
    }),
    graphNode('network:default-route', `Default ${defaultRoute.dev || 'unknown'}`, 'network', {
      status: defaultRoute.dev ? 'running' : 'unknown',
      route: defaultRoute,
      labelDetail: [defaultRoute.via, defaultRoute.src].filter(Boolean).join(' -> ')
    }),
    graphNode('access:local', 'Local 127.0.0.1', 'access', { status: 'running', access: ['local'] }),
    graphNode('access:lan', 'LAN 192.168.0.21', 'access', { status: 'running', address: '192.168.0.21', access: ['LAN'] }),
    graphNode('access:tailscale', 'Tailscale 100.108.68.20', 'access', { status: 'running', address: '100.108.68.20', access: ['Tailscale'] }),
    graphNode('client:claude-code-router', 'Claude Code Router :3456', 'client', { status: 'unknown', port: 3456 }),
    graphNode('client:cline', 'Cline', 'client', { status: 'unknown' }),
    graphNode('control:modelctl', 'Model Control Profiles', 'control', {
      status: profileConfigs.length ? 'running' : 'unknown',
      count: profileConfigs.length
    })
  ];

  const edges = [
    graphEdge('access:local', 'dashboard:9000', 'browser'),
    graphEdge('access:lan', 'dashboard:9000', 'browser'),
    graphEdge('access:tailscale', 'dashboard:9000', 'browser'),
    graphEdge('dashboard:9000', 'host:edgexpert-ba03', 'status metrics'),
    graphEdge('dashboard:9000', 'health:latest', 'DGX Health API'),
    graphEdge('health:agent', 'health:latest', 'writes snapshot', { status: healthStatus }),
    graphEdge('health:latest', 'network:default-route', 'default route'),
    graphEdge('dashboard:9000', 'control:modelctl', 'Start/Stop API'),
    graphEdge('client:cline', 'client:claude-code-router', 'tool calls'),
    graphEdge('client:claude-code-router', 'access:local', 'local API path')
  ];

  const monitoredPorts = [...new Set([
    ...DGX_HEALTH_BASE_PORTS,
    ...runtimeConfigs.map(env => Number(env.PORT)),
    ...profileConfigs.map(env => Number(env.PORT))
  ].filter(Number.isFinite))].sort((a, b) => a - b);

  for (const port of monitoredPorts) {
    const status = graphHealthPortStatus(healthLatest, port, ds4Status);
    nodes.push(graphNode(`health-port:${port}`, graphHealthPortLabel(port), 'health_port', {
      status,
      port,
      listening: status === 'running' || status === 'loading',
      runtime: port === DS4_RUNTIME.port ? DS4_RUNTIME.runtime_label : undefined,
      modelId: port === DS4_RUNTIME.port ? DS4_RUNTIME.model_id : undefined
    }));
    edges.push(graphEdge('health:latest', `health-port:${port}`, 'observes', { status }));
  }

  for (const base of runtimeBases.sort((a, b) => Number(a.port) - Number(b.port))) {
    const env = runtimeByPort.get(Number(base.port));
    const profile = profileByPort.get(Number(base.port));
    const info = mergeRuntimeInfo(base, env, profile);
    const probe = await probeOpenAIModels(info.port, envProbeHost(env || profile || {}));
    const apiModel = probe.models?.[0]?.id || info.modelId;
    const runtimeId = `runtime:${info.port}`;
    const portId = `port:${info.port}`;
    const profileId = profile?.PROFILE_ID ? `profile:${profile.PROFILE_ID}` : null;
    const access = info.access || ['local', 'LAN', 'Tailscale'];
    const boundedSafety = qwen36BoundedNvrmState(profile?.PROFILE_ID || env?.PROFILE_ID);

    nodes.push(graphNode(portId, `:${info.port}`, 'port', {
      status: probe.status,
      port: info.port,
      access
    }));

    nodes.push(graphNode(runtimeId, info.label, 'runtime', {
      status: probe.status,
      port: info.port,
      runtime: info.runtime,
      engine: info.engine,
      context: info.context,
      contextLabel: contextLabel(info.context),
      modelId: apiModel,
      loraModelId: info.loraModelId,
      loraPath: info.loraPath,
      baseModelPath: info.baseModelPath,
      drafterPath: info.drafterPath,
      modelPath: info.modelPath,
      config: info.config,
      profileId: profile?.PROFILE_ID || null,
      controlEnabled: info.controlEnabled,
      role: info.role,
      modelRepository: info.modelRepository,
      modelRevision: info.modelRevision,
      runtimeStack: info.runtimeStack,
      pythonVersion: info.pythonVersion,
      vllmVersion: info.vllmVersion,
      flashinferVersion: info.flashinferVersion,
      cutlassDslVersion: info.cutlassDslVersion,
      torchVersion: info.torchVersion,
      venv: info.venv,
      cuteDslArch: info.cuteDslArch,
      containerName: info.containerName,
      image: info.image,
      imageId: info.imageId,
      nativeContext: info.nativeContext,
      validatedInput: info.validatedInput,
      recommendedOutput: info.recommendedOutput,
      validatedOutput: info.validatedOutput,
      maxNumSeqs: info.maxNumSeqs,
      maxNumBatchedTokens: info.maxNumBatchedTokens,
      gpuMemoryUtilization: info.gpuMemoryUtilization,
      kvDtype: info.kvDtype,
      attentionBackend: info.attentionBackend,
      moeBackend: info.moeBackend,
      linearBackend: info.linearBackend,
      atomicAdd: info.atomicAdd,
      loadFormat: info.loadFormat,
      executorBackend: info.executorBackend,
      mtpEnabled: info.mtpEnabled,
      mtpOptionalTokens: info.mtpOptionalTokens,
      yarnEnabled: info.yarnEnabled,
      thinkingDefault: info.thinkingDefault,
      chunkedPrefill: info.chunkedPrefill,
      conflictProfileIds: info.conflictProfileIds,
      localEndpoint: info.localEndpoint,
      tailscaleEndpoint: info.tailscaleEndpoint,
      ...boundedSafety,
      speculative: info.speculative,
      speculativeType: info.speculativeType,
      isLora: info.isLora,
      access
    }));

    edges.push(graphEdge('host:edgexpert-ba03', portId, 'binds'));
    edges.push(graphEdge(portId, runtimeId, 'OpenAI API', { status: probe.status }));
    edges.push(graphEdge('dashboard:9000', runtimeId, 'health probe', { status: probe.status }));
    edges.push(graphEdge('client:claude-code-router', portId, 'model API'));

    if (profileId) {
      nodes.push(graphNode(profileId, profile.PROFILE_ID, 'profile', {
        status: probe.status,
        port: info.port,
        runtime: info.runtime,
        controlEnabled: info.controlEnabled
      }));
      edges.push(graphEdge('control:modelctl', profileId, 'profile'));
      edges.push(graphEdge(profileId, runtimeId, 'controls', { status: probe.status }));
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    host: 'edgexpert-ba03',
    nodes,
    edges,
    legend: {
      running: 'API is responding on localhost',
      stopped: 'Configured or known runtime, API not responding',
      unknown: 'Relationship exists but live state is not probed'
    }
  };
}

async function getAvailableModels() {
  const models = { llama: [], vllm: [] };

  // Scan switch-model.sh for llama.cpp model definitions
  try {
    const { stdout } = await execAsync("grep -E '^MODELS\\[' /usr/local/bin/switch-model.sh 2>/dev/null");
    const ctxOut = (await execAsync("grep -E '^CTX\\[' /usr/local/bin/switch-model.sh 2>/dev/null").catch(() => ({ stdout: '' }))).stdout;
    const ctxMap = {};
    for (const line of ctxOut.trim().split('\n')) {
      const m = line.match(/^CTX\[(\w+)\]="?(\d+)"?/);
      if (m) ctxMap[m[1]] = parseInt(m[2]);
    }
    for (const line of stdout.trim().split('\n')) {
      const m = line.match(/^MODELS\[(\w+)\]="([^"]+)"/);
      if (m) {
        const key = m[1];
        const path = m[2];
        const filename = path.split('/').pop().replace(/\.gguf.*/, '').replace(/-\d+-of-\d+$/, '').replace(/^stepfun-ai_/, '');
        let sizeGB = null;
        try {
          // For multi-file models use directory, for single file use the file itself
          const target = path.includes('-00001-of-') ? path.substring(0, path.lastIndexOf('/')) : path;
          const { stdout: sizeOut } = await execAsync(`du -sb "${target}" 2>/dev/null | cut -f1`);
          const bytes = parseInt(sizeOut.trim());
          if (bytes > 1e9) sizeGB = parseFloat((bytes / (1024 ** 3)).toFixed(1));
        } catch (e) {}
        models.llama.push({ key, name: filename, path, sizeGB, ctx: ctxMap[key] || null });
      }
    }
  } catch (e) {}

  // Scan HuggingFace cache for vLLM models
  try {
    const { stdout } = await execAsync("ls -d /root/.cache/huggingface/hub/models--*/ 2>/dev/null");
    for (const dir of stdout.trim().split('\n').filter(Boolean)) {
      const dirClean = dir.replace(/\/+$/, '');
      const basename = dirClean.split('/').pop();
      const name = basename.replace(/^models--/, '').replace(/--/g, '/');
      let sizeGB = null;
      try {
        const { stdout: sizeOut } = await execAsync(`du -sb "${dir}" 2>/dev/null | cut -f1`);
        const bytes = parseInt(sizeOut.trim());
        if (bytes < 1e9) continue;
        sizeGB = parseFloat((bytes / (1024 ** 3)).toFixed(1));
      } catch (e) { continue; }
      models.vllm.push({ name, sizeGB, path: dir });
    }
  } catch (e) {}

  // Scan /opt/models/ for locally downloaded vLLM models
  try {
    const { stdout } = await execAsync("ls -d /opt/models/*/ 2>/dev/null");
    for (const dir of stdout.trim().split('\n').filter(Boolean)) {
      const dirClean = dir.replace(/\/+$/, '');
      const name = dirClean.split('/').pop();
      let sizeGB = null;
      try {
        const { stdout: sizeOut } = await execAsync(`du -sb "${dirClean}" 2>/dev/null | cut -f1`);
        const bytes = parseInt(sizeOut.trim());
        if (bytes < 1e9) continue;
        sizeGB = parseFloat((bytes / (1024 ** 3)).toFixed(1));
      } catch (e) { continue; }
      models.vllm.push({ name, sizeGB, path: dirClean });
    }
  } catch (e) {}

  // MCIT_RUNTIME_CONFIG_SCAN_BEGIN
  // Auto-detect runtime models from /etc/vllm/models/*.env.
  // RUNTIME/ENGINE controls whether an env belongs to llama.cpp or vLLM.
  try {
    const newline = String.fromCharCode(10);
    const { stdout: cfgOut } = await execAsync("ls -1 /etc/vllm/models/*.env 2>/dev/null || true");

    for (const cfg of cfgOut.trim().split(newline).filter(Boolean)) {
      try {
        const env = parseEnvText(readFileSync(cfg, 'utf8'));
        if (!env.MODEL_PATH && !env.PORT) continue;
        env.__file = cfg;
        const classifiedRuntime = classifyEnvRuntime(env);
        const inventoryConfig = classifyInventoryConfig(
          env,
          classifiedRuntime,
          isDs4RuntimeCandidate(env)
        );
        if (!inventoryConfig.include) continue;

        const target = inventoryConfig.section === 'llama' ? models.llama : models.vllm;
        const name = envDisplayName(env);
        const displayName = name;
        const configuredPort = env.PORT ? parseInt(env.PORT, 10) : null;
        const port = envDashboardClientPort(env) || configuredPort;
        const probeUrl = envDashboardProbeUrl(env);
        const backendPort = envDashboardBackendPort(env) || numericPort(env.GUARD_PORT) || configuredPort;
        const ctx = envContextLength(env);
        let sizeGB = null;
        let status = 'stopped';
        let apiModel = null;
        let modelPath = env.MODEL_PATH || null;

        if (env.MODEL_PATH) {
          try {
            const { stdout: sizeOut } = await execAsync(`du -sb "${env.MODEL_PATH}" 2>/dev/null | cut -f1`);
            const bytes = parseInt(sizeOut.trim(), 10);
            if (bytes > 1e9) sizeGB = parseFloat((bytes / (1024 ** 3)).toFixed(1));
          } catch (e) {}
        }

        if (probeUrl) {
          try {
            const { stdout: modelsOut } = await execAsync(`curl -s --max-time 1 ${probeUrl} 2>/dev/null || true`);
            if (modelsOut) {
              if (/Loading model/i.test(modelsOut)) {
                status = 'loading';
              } else {
                const data = JSON.parse(modelsOut);
                const firstModel = data?.data?.[0] || null;
                if (firstModel?.id) {
                  status = 'running';
                  apiModel = firstModel.id;
                  modelPath = firstModel.root || modelPath;
                }
              }
            }
          } catch (e) {}
        }

        const already = target.some(m => {
          if (port && m.port) return Number(m.port) === Number(port);
          if (cfg && m.config) return m.config === cfg;
          return !port && !m.port && ((env.MODEL_PATH && m.path === env.MODEL_PATH) || (name && m.name === name));
        });
        if (!already) {
          const servedModelName = env.SERVED_MODEL_NAME || env.MODEL_ID || null;
          target.push({
            key: name,
            name,
            displayName,
            servedModelName,
            functionLabel: envModelFunctionLabel(env, classifiedRuntime),
            connectionLabel: envConnectionLabel(env, classifiedRuntime),
            apiModel,
            sizeGB,
            path: env.MODEL_PATH || modelPath,
            modelPath,
            ctx,
            maxInputTokens: env.MAX_INPUT_TOKENS ? parseInt(env.MAX_INPUT_TOKENS, 10) : null,
            maxOutputTokens: env.MAX_NEW_TOKENS || env.SERVER_MAX_OUTPUT
              ? parseInt(env.MAX_NEW_TOKENS || env.SERVER_MAX_OUTPUT, 10)
              : null,
            port,
            clientPort: port,
            backendPort,
            host: envProbeHost(env),
            status,
            running: status === 'running',
            runtime: inventoryConfig.runtime,
            source: `custom-${inventoryConfig.runtime}-config`,
            config: cfg,
            dashboardProbeUrl: probeUrl,
            localEndpoint: env.LOCAL_ENDPOINT || null,
            lanEndpoint: env.LAN_ENDPOINT || null,
            tailscaleEndpoint: env.TAILSCALE_ENDPOINT || null
          });
        }
      } catch (e) {}
    }
  } catch (e) {}
  // MCIT_RUNTIME_CONFIG_SCAN_END

  try {
    const llamaProcesses = await getRunningLlamaProcesses();
    const processProbeResults = [];
    for (const proc of llamaProcesses) {
      const studioProcess = isUnslothStudioProcess(proc);
      const configuredMatches = models.llama.filter(model =>
        Number(model.port || 0) === Number(proc.port) ||
        modelMatchesRunningLlamaProcess(model, proc)
      );
      const configuredModel = studioProcess
        ? (configuredMatches.length === 1 ? configuredMatches[0] : null)
        : configuredMatches[0];
      const configurationAmbiguous = studioProcess && configuredMatches.length > 1;
      const probe = await probeOpenAIModels(proc.port, configuredModel?.host || '127.0.0.1');
      const liveModel = liveModelForLlamaProcess({ data: probe.models }, proc);
      const status = probe.status === 'running' && liveModel?.id ? 'running' : 'loading';
      let procSizeGB = null;
      if (proc.modelPath) {
        try {
          const { stdout: sizeOut } = await execAsync(`du -sb "${proc.modelPath}" 2>/dev/null | cut -f1`);
          const bytes = parseInt(sizeOut.trim(), 10);
          if (bytes > 1e9) procSizeGB = parseFloat((bytes / (1024 ** 3)).toFixed(1));
        } catch (e) {}
      }

      processProbeResults.push({
        process: proc,
        status,
        sizeGB: procSizeGB,
        candidate: {
          source: 'process',
          process: proc,
          isUnslothStudio: studioProcess,
          healthy: status === 'running' && !configurationAmbiguous,
          configurationAmbiguous,
          liveApiModelId: String(liveModel?.id || '').trim(),
          liveApiModelIds: (probe.models || [])
            .map(model => String(model?.id || '').trim())
            .filter(Boolean),
          backendPort: proc.port,
          clientPort: clientPortForLlamaProcess(proc),
        },
      });
    }

    const studioCandidates = processProbeResults
      .map(result => result.candidate)
      .filter(candidate => candidate.isUnslothStudio);
    const selectedStudio = studioCandidates.length
      ? selectPreferredLlamaRuntime({ liveProcessCandidates: studioCandidates })
      : null;
    const orderedProbeResults = processProbeResults
      .filter(result => result.candidate !== selectedStudio)
      .concat(processProbeResults.filter(result => result.candidate === selectedStudio));

    for (const result of orderedProbeResults) {
      const studioProcess = result.candidate.isUnslothStudio;
      const studioRuntimeResolved = !studioProcess || (
        result.candidate === selectedStudio &&
        !result.candidate.configurationAmbiguous
      );
      const merged = mergeRunningLlamaProcess(models, result.process, {
        status: studioRuntimeResolved ? result.status : 'loading',
        sizeGB: result.sizeGB,
        apiModel: studioRuntimeResolved ? result.candidate.liveApiModelId : null,
        studioRuntimeResolved,
      });
      models.llama = merged.llama;
      models.vllm = merged.vllm;
    }
  } catch (e) {}

  return models;
}

// Get llama.cpp server info
async function getLlamaInfo() {
  try {
    let llamaServer = LLAMA_SERVER;
    let llamaPort = 8001;
    let llamaConfig = null;
    const runningLlamaProcesses = await getRunningLlamaProcesses();
    const llamaConfigs = [];
    const configuredCandidates = [];
    const liveProcessCandidates = [];

    try {
      const newline = String.fromCharCode(10);
      const { stdout: cfgOut } = await execAsync("ls -1 /etc/vllm/models/*.env 2>/dev/null || true");
      for (const cfg of cfgOut.trim().split(newline).filter(Boolean)) {
        const env = parseEnvText(readFileSync(cfg, 'utf8'));
        if (classifyEnvRuntime(env) !== 'llama' || !env.PORT) continue;
        const port = parseInt(env.PORT, 10);
        const probeHost = envProbeHost(env);
        const server = `http://${probeHost}:${port}`;
        const candidate = {
          source: 'configured',
          env,
          cfg,
          port,
          clientPort: port,
          backendPort: port,
          probeHost,
          server,
          healthy: false,
          isUnslothStudio: false,
          liveApiModelId: '',
          liveApiModelIds: [],
          modelPath: env.MODEL_PATH || null
        };
        llamaConfigs.push(candidate);
        configuredCandidates.push(candidate);

        try {
          const modelsRes = await fetch(`${server}/v1/models`, { signal: AbortSignal.timeout(1000) });
          if (!modelsRes.ok) continue;
          const data = await modelsRes.json();
          candidate.liveApiModelIds = (data?.data || [])
            .map(model => String(model?.id || '').trim())
            .filter(Boolean);
          const firstModel = selectLiveModelFromProbe(data);
          if (firstModel?.id) {
            candidate.healthy = true;
            candidate.liveApiModelId = firstModel.id;
            candidate.modelPath = firstModel.root || candidate.modelPath;
          }
        } catch (e) {}
      }
    } catch (e) {}

    for (const proc of runningLlamaProcesses) {
      const matchingConfigs = llamaConfigs.filter(candidate =>
        configuredLlamaCandidateMatchesProcess(candidate, proc, llamaConfigs)
      );
      const matchingConfig = matchingConfigs.length === 1 ? matchingConfigs[0] : null;
      const studioProcess = isUnslothStudioProcess(proc);
      const configurationAmbiguous = studioProcess && matchingConfigs.length > 1;
      if (studioProcess && matchingConfig) matchingConfig.isUnslothStudio = true;
      const probeHost = matchingConfig ? matchingConfig.probeHost : '127.0.0.1';
      const server = `http://${probeHost}:${proc.port}`;
      const processClientPort = clientPortForLlamaProcess(proc);
      const clientPort = studioProcess
        ? processClientPort
        : numericPort(matchingConfig?.clientPort) || processClientPort;
      const candidate = {
        source: 'process',
        process: proc,
        env: matchingConfig?.env || {
          PORT: String(clientPort || proc.port),
          MODEL_PATH: proc.modelPath || '',
          API_MODEL_ID: ''
        },
        cfg: matchingConfig?.cfg || null,
        port: proc.port,
        clientPort,
        backendPort: proc.port,
        probeHost,
        server,
        healthy: false,
        isUnslothStudio: studioProcess,
        configurationAmbiguous,
        liveApiModelId: '',
        liveApiModelIds: [],
        modelPath: proc.modelPath || matchingConfig?.modelPath || null
      };
      liveProcessCandidates.push(candidate);

      try {
        const modelsRes = await fetch(`${server}/v1/models`, { signal: AbortSignal.timeout(1000) });
        if (!modelsRes.ok) continue;
        const data = await modelsRes.json();
        candidate.liveApiModelIds = (data?.data || [])
          .map(model => String(model?.id || '').trim())
          .filter(Boolean);
        const firstModel = liveModelForLlamaProcess(data, proc);
        if (firstModel?.id && modelApiLooksLikeLlama(data)) {
          candidate.healthy = !configurationAmbiguous;
          candidate.liveApiModelId = firstModel.id;
          candidate.modelPath = firstModel.root || candidate.modelPath;
          if (matchingConfig) matchingConfig.backendPort = proc.port;
          if (!matchingConfig) {
            candidate.env = {
              PORT: String(clientPort || proc.port),
              MODEL_PATH: proc.modelPath || candidate.modelPath || '',
              API_MODEL_ID: firstModel.id
            };
          }
        }
      } catch (e) {}
    }

    if (runningLlamaProcesses.some(isUnslothStudioProcess)) {
      for (const candidate of configuredCandidates) {
        if (numericPort(candidate.clientPort) === UNSLOTH_STUDIO_CLIENT_PORT) {
          candidate.isUnslothStudio = true;
        }
      }
    }

    const selectedRuntime = selectPreferredLlamaRuntime({
      configuredCandidates,
      liveProcessCandidates
    });
    const studioRuntimeUnresolved = liveProcessCandidates.some(candidate => candidate.isUnslothStudio) &&
      !selectedRuntime;

    if (selectedRuntime) {
      llamaPort = selectedLlamaPorts(selectedRuntime, selectedRuntime.port).port || llamaPort;
      llamaServer = selectedRuntime.server;
      llamaConfig = {
        env: selectedRuntime.env,
        cfg: selectedRuntime.cfg
      };
    }

    const [healthRes, propsRes, slotsRes] = studioRuntimeUnresolved
      ? [
          { status: 'rejected' },
          { status: 'rejected' },
          { status: 'rejected' }
        ]
      : await Promise.allSettled([
          fetch(`${llamaServer}/health`, { signal: AbortSignal.timeout(2000) }),
          fetch(`${llamaServer}/props`, { signal: AbortSignal.timeout(2000) }),
          fetch(`${llamaServer}/slots`, { signal: AbortSignal.timeout(2000) })
        ]);

    let healthy = false;
    let loading = false;
    let processRunning = false;
    let model = 'unknown';
    let ctxSize = null;
    let quantFormat = null;
    let paramSize = null;
    let liveApiModelId = String(selectedRuntime?.liveApiModelId || '').trim() || null;

    if (healthRes.status === 'fulfilled') {
      healthy = healthRes.value.ok;
      if (!healthy) {
        try {
          const err = await healthRes.value.json();
          const msg = err?.error?.message || '';
          if (/loading model/i.test(msg)) loading = true;
        } catch (e) {}
      }
    }

    // Try /slots first (newer llama-server), fallback to /props
    if (slotsRes.status === 'fulfilled' && slotsRes.value.ok) {
      const slots = await slotsRes.value.json();
      if (Array.isArray(slots) && slots.length > 0) {
        ctxSize = slots[0]?.n_ctx || null;
      }
    }
    if (!ctxSize && propsRes.status === 'fulfilled') {
      if (propsRes.value.ok) {
        const props = await propsRes.value.json();
        ctxSize = props?.default_generation_settings?.params?.n_ctx || null;
      } else {
        try {
          const err = await propsRes.value.json();
          const msg = err?.error?.message || '';
          if (/loading model/i.test(msg)) loading = true;
        } catch (e) {}
      }
    }

    // Get model name from /v1/models API (includes full filename with quant format)
    try {
      if (studioRuntimeUnresolved) throw new Error('Studio runtime identity unresolved');
      const modelsRes = await fetch(`${llamaServer}/v1/models`, { signal: AbortSignal.timeout(2000) });
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        const firstModel = selectLiveModelFromProbe(modelsData, {
          requireSingleDistinctId: selectedRuntime?.isUnslothStudio === true,
        });
        const modelId = firstModel?.id || '';
        if (modelId) {
          healthy = true;
          liveApiModelId = modelId;
          const parsed = parseModelMeta(modelId);
          model = parsed.model || model;
          quantFormat = parsed.quantFormat || quantFormat;
          paramSize = parsed.paramSize || paramSize;
          ctxSize = firstModel?.meta?.n_ctx || firstModel?.max_model_len || ctxSize;
        }
      } else {
        try {
          const err = await modelsRes.json();
          const msg = err?.error?.message || '';
          if (/loading model/i.test(msg)) loading = true;
        } catch (e) {}
      }
    } catch (e) {}

    // Fallback to running process if API isn't ready yet.
    try {
      const proc = selectedRuntime?.process ||
        (!studioRuntimeUnresolved
          ? runningLlamaProcesses.find(item => Number(item.port || 0) === Number(llamaPort || 0))
          : null) ||
        runningLlamaProcesses.find(item => !isUnslothStudioProcess(item)) ||
        null;
      const cmd = proc?.command || '';
      if (proc && cmd) {
        processRunning = true;
        if (!healthy && proc.port) {
          llamaPort = proc.port;
          llamaServer = `http://127.0.0.1:${llamaPort}`;
        }
        if (proc.modelPath) {
          const path = proc.modelPath;
          if (model === 'unknown') {
            const base = path.split('/').pop() || path;
            model = base.replace(/-\d+-of-\d+\.gguf.*$/, '').replace(/\.gguf.*$/, '');
          }
          if (!quantFormat || !paramSize) {
            const parsed = parseModelMeta(path);
            quantFormat = parsed.quantFormat || quantFormat;
            paramSize = parsed.paramSize || paramSize;
          }
        }
        if (!ctxSize) {
          ctxSize = proc.context || null;
        }
      }
    } catch (e) {}

    // Fallback to systemctl/ps if API didn't work
    if (model === 'unknown') {
      try {
        const { stdout } = await execAsync("systemctl show llama-server -p Description --value 2>/dev/null");
        const match = stdout.match(/\(([^)]+)\)/);
        if (match) model = match[1];
      } catch (e) {}
    }

    const status = healthy ? 'running' : (loading || processRunning ? 'loading' : 'stopped');

    const resolvedPorts = studioRuntimeUnresolved
      ? { port: null, backendPort: null, proxyPort: null }
      : selectedLlamaPorts(selectedRuntime, llamaPort);

    return {
      engine: 'llama.cpp',
      available: status !== 'stopped',
      status,
      model,
      apiModel: liveApiModelId,
      ctxSize,
      quantFormat,
      paramSize,
      port: resolvedPorts.port,
      backendPort: resolvedPorts.backendPort,
      proxyPort: resolvedPorts.proxyPort,
      config: llamaConfig?.cfg || null,
      modelPath: llamaConfig?.env?.MODEL_PATH || null
    };
  } catch (error) {
    return { engine: 'llama.cpp', available: false, status: 'stopped', model: null, ctxSize: null, port: 8001, proxyPort: 8000 };
  }
}

// Get vLLM container info
async function getVllmInfo() {
  try {
    const newline = String.fromCharCode(10);
    const { stdout } = await execAsync("docker ps --filter 'name=vllm' --format '{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null");
    const running = stdout.trim();
    let containers = [];
    const llamaProcessesByPort = await getRunningLlamaProcessByPort();

    if (running) {
      containers = running.split(newline).filter(Boolean).map(line => {
        const [name, status, ports] = line.split('|');
        return { name, status, ports };
      });
    }

    const parseEnv = (txt) => {
      const env = {};
      for (const raw of txt.split(newline)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || !line.includes('=')) continue;
        const idx = line.indexOf('=');
        const key = line.slice(0, idx).trim();
        let val = line.slice(idx + 1).trim();
        val = val.replace(/^['"]|['"]$/g, '');
        env[key] = val;
      }
      return env;
    };

    const candidates = [];

    try {
      const { stdout: cfgOut } = await execAsync("ls -1 /etc/vllm/models/*.env 2>/dev/null || true");
	      for (const cfg of cfgOut.trim().split(newline).filter(Boolean)) {
	        try {
	          const env = parseEnv(readFileSync(cfg, 'utf8'));
	          if (!env.PORT) continue;
            const configuredPort = parseInt(env.PORT, 10);
            const port = envDashboardClientPort(env) || configuredPort;
            const probeUrl = envDashboardProbeUrl(env);
            const backendPort = envDashboardBackendPort(env) || numericPort(env.GUARD_PORT) || configuredPort;
            env.__file = cfg;
            if (isDs4RuntimeCandidate(env)) continue;
	          if (classifyEnvRuntime(env) === 'llama' || llamaProcessesByPort.has(configuredPort)) continue;

	          candidates.push({
	            name: envDisplayName(env) || env.SERVED_MODEL_NAME || (env.MODEL_PATH || '').split('/').filter(Boolean).pop(),
	            endpoint: probeUrl,
	            port,
	            clientPort: port,
	            backendPort,
	            ctxSize: envContextLength(env),
            modelPath: env.MODEL_PATH || null,
	            apiModel: env.API_MODEL_ID || null,
	            config: cfg,
	            source: 'custom-vllm-config'
          });
        } catch (e) {}
      }
    } catch (e) {}

    for (const port of [8008, 8016, 8032, 8100, 8102, 8109]) {
      if (!candidates.some(c => c.port === port)) {
        candidates.push({
          name: null,
          endpoint: `http://127.0.0.1:${port}/v1/models`,
          port,
          ctxSize: null,
          modelPath: null,
          config: null,
          source: 'api-port-scan'
        });
      }
    }

    const models = [];

    for (const item of candidates) {
      if (isDs4RuntimeCandidate(item)) continue;
      let status = 'stopped';
      let modelAlias = item.apiModel || null;
      let modelName = item.name;
      let modelPath = item.modelPath;
      let ctxSize = item.ctxSize;

      try {
        const { stdout: modelsOut } = await execAsync(`curl -s --max-time 1 ${item.endpoint} 2>/dev/null || true`);
        if (modelsOut) {
          if (/Loading model/i.test(modelsOut)) {
            status = 'loading';
          } else {
            const data = JSON.parse(modelsOut);
            if (modelApiLooksLikeLlama(data)) continue;
            const firstModel = data?.data?.[0] || null;
            if (firstModel?.id) {
              status = 'running';
	              modelAlias = firstModel.id;
	              modelName = modelName || firstModel.id;
	              modelPath = modelPath || firstModel.root || null;
	              ctxSize = firstModel?.meta?.n_ctx || firstModel.max_model_len || ctxSize;
	            }
          }
        }
      } catch (e) {
        if (/Loading model/i.test(String(e?.message || ''))) status = 'loading';
      }

      if (item.config || status !== 'stopped') {
        models.push({
          name: modelName,
          model: modelName,
          modelAlias,
          modelPath,
          ctxSize,
          port: item.port,
          clientPort: item.clientPort || item.port,
          backendPort: item.backendPort || item.port,
          status,
          running: status === 'running',
          source: item.source,
          config: item.config
        });
      }
    }

    const runningModels = models.filter(m => m.status === 'running');
    const loadingModels = models.filter(m => m.status === 'loading');
    const status = runningModels.length > 0
      ? 'running'
      : (loadingModels.length > 0 ? 'loading' : (containers.length > 0 ? 'starting' : 'stopped'));
    const primary = runningModels[0] || loadingModels[0] || models[0] || null;

    return {
      engine: 'vLLM',
      available: status !== 'stopped',
      status,
      model: primary?.name || null,
      modelAlias: primary?.modelAlias || null,
      modelPath: primary?.modelPath || null,
      ctxSize: primary?.ctxSize || null,
      port: primary?.port || null,
      source: primary?.source || null,
      runningCount: runningModels.length,
      totalCount: models.length,
      models,
      containers
    };
  } catch (error) {
    return { engine: 'vLLM', available: false, status: 'stopped', model: null, containers: [], models: [] };
  }
}

// Get Ollama info
async function getOllamaInfo() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return {
      engine: 'Ollama',
      available: false,
      status: 'stopped',
      models: [],
      runningModel: null,
      port: 11434
    };
    const data = await res.json();
    const models = (data.models || []).map(m => {
      const sizeGB = m.size ? parseFloat((m.size / (1024 ** 3)).toFixed(1)) : null;
      // Parse quant from model details or name
      const quantFormat = m.details?.quantization_level || null;
      const paramSize = m.details?.parameter_size || null;
      return {
        name: m.name,
        sizeGB,
        quantFormat,
        paramSize,
        family: m.details?.family || null,
        modified: m.modified_at
      };
    });

    // Check if any model is currently loaded (running)
    let runningModel = null;
    try {
      const psRes = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(2000) });
      if (psRes.ok) {
        const psData = await psRes.json();
        if (psData.models && psData.models.length > 0) {
          runningModel = psData.models[0].name;
        }
      }
    } catch (e) {}

    return {
      engine: 'Ollama',
      available: true,
      status: 'running',
      models,
      runningModel,
      port: 11434
    };
  } catch (error) {
    return {
      engine: 'Ollama',
      available: false,
      status: 'stopped',
      models: [],
      runningModel: null,
      port: 11434
    };
  }
}

// Get top memory-consuming processes
async function getTopProcesses(limit = 10) {
  try {
    const { stdout } = await execAsync(
      `ps aux --sort=-%mem | head -n ${limit + 1} | tail -n ${limit}`
    );

    const processes = stdout.trim().split('\n').map(line => {
      const parts = line.trim().split(/\s+/);
      const user = parts[0];
      const pid = parseInt(parts[1]);
      const cpu = parseFloat(parts[2]);
      const mem = parseFloat(parts[3]);
      const vsz = parseInt(parts[4]);
      const rss = parseInt(parts[5]);
      const command = parts.slice(10).join(' ');

      return {
        user,
        pid,
        cpu,
        mem,
        memoryMB: (rss / 1024).toFixed(1),
        memoryGB: (rss / 1024 / 1024).toFixed(2),
        command: command.length > 80 ? command.substring(0, 77) + '...' : command
      };
    });

    return processes;
  } catch (error) {
    console.error('Error getting top processes:', error.message);
    return [];
  }
}

// Get NVIDIA GPU info using nvidia-smi
async function getNvidiaGPUInfo() {
  try {
    const [{ stdout }, computeResult] = await Promise.all([
      execAsync(
        'nvidia-smi --query-gpu=index,uuid,name,memory.total,memory.used,memory.free,utilization.gpu,utilization.memory,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits'
      ),
      execAsync(
        'nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits'
      ).catch(() => ({ stdout: '' }))
    ]);

    const computeMemoryByUuid = new Map();
    for (const line of computeResult.stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const [uuid, , , usedMemory] = line.split(',').map(s => s.trim());
      const amount = parseFloat(usedMemory);
      if (uuid && Number.isFinite(amount)) {
        computeMemoryByUuid.set(uuid, (computeMemoryByUuid.get(uuid) || 0) + amount);
      }
    }

    const gpus = stdout.trim().split('\n').map(line => {
      const [index, uuid, name, memTotal, memUsed, memFree, utilGpu, utilMem, temp, powerDraw, powerLimit] =
        line.split(',').map(s => s.trim());

      const parseValue = (val) => {
        if (val === '[N/A]' || val === 'N/A' || val === '') return null;
        const num = parseFloat(val);
        return isNaN(num) ? null : num;
      };

      return {
        index: parseInt(index),
        uuid,
        model: name,
        vendor: 'NVIDIA',
        memoryTotal: parseValue(memTotal),
        memoryUsed: parseValue(memUsed),
        memoryFree: parseValue(memFree),
        memoryTotalGB: memTotal === '[N/A]' ? null : parseFloat((parseValue(memTotal) || 0).toFixed(2)),
        memoryUsedGB: memUsed === '[N/A]' ? null : parseFloat((parseValue(memUsed) || 0).toFixed(2)),
        memoryFreeGB: memFree === '[N/A]' ? null : parseFloat((parseValue(memFree) || 0).toFixed(2)),
        utilizationGpu: parseValue(utilGpu),
        utilizationMemory: parseValue(utilMem),
        computeMemoryUsedMB: computeMemoryByUuid.get(uuid) || 0,
        temperatureGpu: parseValue(temp),
        powerDraw: parseValue(powerDraw),
        powerLimit: parseValue(powerLimit),
        unifiedMemory: memTotal === '[N/A]' // Indicate unified memory
      };
    });

    return gpus;
  } catch (error) {
    console.error('Error getting NVIDIA GPU info:', error.message);
    return [];
  }
}

// Collect system metrics
async function getSystemMetrics() {
  try {
    const [cpu, mem, currentLoad, osInfo, gpuData, processes, llamaInfo, vllmInfo, ollamaInfo, availableModels, fsSize, time, networkStats] = await Promise.all([
      si.cpu(),
      si.mem(),
      si.currentLoad(),
      si.osInfo(),
      getNvidiaGPUInfo(),
      getTopProcesses(10),
      getLlamaInfo(),
      getVllmInfo(),
      getOllamaInfo(),
      getAvailableModels(),
      si.fsSize(),
      si.time(),
      si.networkStats()
    ]);

    const normalizedNetwork = normalizedNetworkStats(networkStats);

    const metrics = {
      timestamp: Date.now(),
      system: {
        platform: osInfo.platform,
        distro: osInfo.distro,
        hostname: osInfo.hostname,
        arch: osInfo.arch
      },
      cpu: {
        manufacturer: cpu.manufacturer,
        brand: cpu.brand,
        cores: cpu.cores,
        physicalCores: cpu.physicalCores,
        speed: cpu.speed,
        usage: parseFloat(currentLoad.currentLoad.toFixed(2)),
        perCore: currentLoad.cpus.map(core => ({
          load: parseFloat(core.load.toFixed(2))
        }))
      },
      memory: {
        total: mem.total,
        free: mem.free,
        used: mem.used,
        active: mem.active,
        available: mem.available,
        buffers: mem.buffers,
        cached: mem.cached,
        buffcache: mem.buffcache,
        usagePercent: parseFloat(((mem.used / mem.total) * 100).toFixed(2)),
        totalGB: parseFloat((mem.total / (1024 ** 3)).toFixed(2)),
        usedGB: parseFloat((mem.used / (1024 ** 3)).toFixed(2)),
        freeGB: parseFloat((mem.free / (1024 ** 3)).toFixed(2))
      },
      gpu: gpuData,
      processes: processes,
      inference: {
        llama: llamaInfo,
        vllm: vllmInfo,
        ollama: ollamaInfo,
        availableModels
      },
      disk: fsSize.map(disk => ({
        fs: disk.fs,
        type: disk.type,
        size: disk.size,
        used: disk.used,
        available: disk.available,
        usagePercent: parseFloat(disk.use.toFixed(2)),
        mount: disk.mount,
        unit: 'GB',
        sizeGB: parseFloat((disk.size / 1e9).toFixed(2)),
        usedGB: parseFloat((disk.used / 1e9).toFixed(2)),
        availableGB: parseFloat((disk.available / 1e9).toFixed(2))
      })),
      uptime: {
        seconds: time.uptime,
        days: Math.floor(time.uptime / 86400),
        hours: Math.floor((time.uptime % 86400) / 3600),
        minutes: Math.floor((time.uptime % 3600) / 60)
      },
      network: normalizedNetwork
    };

    return metrics;
  } catch (error) {
    console.error('Error collecting metrics:', error);
    return null;
  }
}

// Store active SSE clients
const sseClients = new Set();

// SSE endpoint handler
function handleSSE(req, res) {
  const clientIp = req.socket.remoteAddress;
  console.log(`Client connected via SSE from ${clientIp}`);

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Send initial comment to establish connection
  res.write(':ok\n\n');

  // Send initial metrics immediately
  getSystemMetrics().then(metrics => {
    if (metrics) {
      res.write(`data: ${JSON.stringify(metrics)}\n\n`);
    }
  }).catch(error => {
    console.error('Error getting initial metrics:', error);
  });

  // Add client to set
  const client = { res, ip: clientIp };
  sseClients.add(client);

  // Handle client disconnect
  req.on('close', () => {
    sseClients.delete(client);
    console.log(`Client disconnected from ${clientIp}`);
  });

  req.on('error', (error) => {
    sseClients.delete(client);
    console.error('SSE error:', error.message);
  });
}

// Broadcast metrics to all connected clients
async function broadcastMetrics() {
  if (sseClients.size === 0) return;

  try {
    const metrics = await getSystemMetrics();
    if (!metrics) return;
    metrics.modelNotes = loadNotes();

    const data = `data: ${JSON.stringify(metrics)}\n\n`;

    // Send to all connected clients
    for (const client of sseClients) {
      try {
        client.res.write(data);
      } catch (error) {
        console.error(`Error sending to ${client.ip}:`, error.message);
        sseClients.delete(client);
      }
    }
  } catch (error) {
    console.error('Error broadcasting metrics:', error);
  }
}

const isMainModule = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
);

// Start broadcasting interval
if (isMainModule) setInterval(broadcastMetrics, UPDATE_INTERVAL);

async function startDevServer() {
  // Create Vite dev server with middleware mode
  const vite = await createServer({
	    server: {
	      host: '0.0.0.0',
	      port: 9000,
	      strictPort: true,
	      middlewareMode: true,
	      watch: {
	        usePolling: true,
	        interval: 1000,
	        ignored: ['**/build/**', '**/.svelte-kit/**', '**/node_modules/**']
	      }
	    }
	  });

  // Create Express app
  const app = express();

  // Add SSE endpoint BEFORE Vite middleware
  app.get('/api/metrics', handleSSE);

  // Model notes API
  app.use(express.json());
  app.get('/api/notes', (req, res) => {
    res.json(loadNotes());
  });
  app.post('/api/notes', (req, res) => {
    const { modelId, note } = req.body;
    if (!modelId) return res.status(400).json({ error: 'modelId required' });
    const notes = loadNotes();
    if (note && note.trim()) {
      notes[modelId] = note.trim();
    } else {
      delete notes[modelId];
    }
    saveNotes(notes);
    res.json({ ok: true, notes });
  });

  app.post('/api/process-control/stop/:family', async (req, res) => {
    const { family } = req.params;
    const validation = validateStopRequest(family, req.body);
    if (!validation.ok) {
      return res.status(400).json({
        ok: false,
        code: validation.code,
        message: 'A family-specific confirmation is required'
      });
    }
    const result = await processControlActionLock.run(() => processController.stopFamily(family));
    res.status(result.code === 'busy' ? 409 : result.ok ? 200 : 500).json(result);
  });

  // Model control API. Only calls the allowlisted modelctl helper.
  app.get('/api/model-control/list', async (req, res) => {
    res.json(enrichModelControlResult(await runModelctl(['list'])));
  });

  app.get('/api/model-control/status/:profile', async (req, res) => {
    const { profile } = req.params;
    if (!validModelControlProfile(profile)) {
      return res.status(400).json({ ok: false, code: 'invalid_profile', message: 'Invalid profile id' });
    }
    const result = await runModelctl(['status', profile]);
    res.status(result.ok ? 200 : 400).json(enrichModelControlResult(result));
  });

  app.post('/api/model-control/start/:profile', async (req, res) => {
    const { profile } = req.params;
    if (!validModelControlProfile(profile)) {
      return res.status(400).json({ ok: false, code: 'invalid_profile', message: 'Invalid profile id' });
    }
    const result = await modelControlActionLock.run(() => startModelAsync(profile));
    res.status(result.ok ? 200 : result.code === 'busy' ? 409 : 500).json(result);
  });

  app.post('/api/model-control/stop/:profile', async (req, res) => {
    const { profile } = req.params;
    if (!validModelControlProfile(profile)) {
      return res.status(400).json({ ok: false, code: 'invalid_profile', message: 'Invalid profile id' });
    }
    const result = await modelControlActionLock.run(() => runModelctl(['stop', profile]));
    res.status(result.ok ? 200 : result.code === 'busy' ? 409 : 500).json(result);
  });

  app.post('/api/model-control/stop-all', async (req, res) => {
    if (req.body?.confirm !== 'KILL_ALL_MODELS') {
      return res.status(400).json({
        ok: false,
        code: 'confirmation_required',
        message: 'Explicit Kill All confirmation is required'
      });
    }
    const result = await modelControlActionLock.run(async () => {
      const listResult = enrichModelControlResult(await runModelctl(['list']));
      if (!listResult?.ok) return listResult;
      return stopAllManagedModels(listResult.profiles || [], {
        stopProfile: profile => runModelctl(['stop', profile]),
        statusProfile: async profile => enrichModelControlResult(await runModelctl(['status', profile])),
        getLegacyDs4Status: () => getDs4Status(),
        stopLegacyDs4: () => stopDs4Runtime('dashboard_stop_all')
      });
    });
    res.status(result.ok ? 200 : result.code === 'busy' ? 409 : 500).json(result);
  });

  app.get('/api/graphify/topology', async (req, res) => {
    try {
      res.json(await buildGraphifyTopology());
    } catch (error) {
      res.status(500).json({
        ok: false,
        code: 'graphify_topology_failed',
        message: sanitizeOutput(error.message || 'Failed to build topology')
      });
    }
  });

  app.get('/api/dgx-health/latest', (req, res) => {
    const result = readDgxHealthLatest();
    res.status(result.ok ? 200 : 503).json(result);
  });

  // Hermes control API. Unit names, paths, and URLs are fixed server-side.
  app.get('/api/hermes/status', async (_req, res) => {
    res.json(await hermesController.status());
  });

  app.post('/api/hermes/start', async (_req, res) => {
    try {
      res.json(await hermesController.start());
    } catch (error) {
      res.status(hermesErrorStatus(error)).json(hermesErrorPayload(error));
    }
  });

  app.post('/api/hermes/stop', async (_req, res) => {
    try {
      res.json(await hermesController.stop());
    } catch (error) {
      res.status(hermesErrorStatus(error)).json(hermesErrorPayload(error));
    }
  });

  app.get('/api/hermes/logo', sendHermesLogo);

  // Use Vite middleware
  app.use(vite.middlewares);

  // Start server
  const server = app.listen(9000, '0.0.0.0', () => {
    console.log('');
    console.log('\x1b[32m%s\x1b[0m', '  ➜ DGX Spark Status Server');
    console.log('  \x1b[36m%s\x1b[0m', `Local:   http://localhost:9000/`);
    console.log('  \x1b[36m%s\x1b[0m', `Network: http://0.0.0.0:9000/`);
    console.log('  \x1b[33m%s\x1b[0m', `SSE Endpoint: http://0.0.0.0:9000/api/metrics`);
    console.log('');
  });
}

if (isMainModule) {
  startDevServer().catch(err => {
    console.error('Failed to start dev server:', err);
    process.exit(1);
  });
}
