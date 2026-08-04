import { realpathSync } from 'node:fs';

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizedPath(value) {
  return normalized(value).replace(/\/+$/, '');
}

export const UNSLOTH_STUDIO_ROOT = '/home/mctdgx01/apps/unsloth-studio';
export const UNSLOTH_STUDIO_LLAMA_SERVER = `${UNSLOTH_STUDIO_ROOT}/llama.cpp/llama-server`;
export const UNSLOTH_STUDIO_INTERPRETER = `${UNSLOTH_STUDIO_ROOT}/unsloth_studio/bin/python`;
export const UNSLOTH_STUDIO_LAUNCHER = `${UNSLOTH_STUDIO_ROOT}/bin/unsloth`;
export const UNSLOTH_STUDIO_CLIENT_PORT = 56827;

function numericPort(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function installedStudioExecutable(realpath) {
  try {
    return realpath(UNSLOTH_STUDIO_LLAMA_SERVER);
  } catch {
    return UNSLOTH_STUDIO_LLAMA_SERVER;
  }
}

export function isUnslothStudioProcess(process = {}, { realpath = realpathSync } = {}) {
  const executable = String(process.executable || '').trim();
  return process.studioLauncherAncestryVerified === true &&
    executable !== '' &&
    executable === installedStudioExecutable(realpath);
}

export function clientPortForLlamaProcess(process = {}) {
  if (isUnslothStudioProcess(process)) return UNSLOTH_STUDIO_CLIENT_PORT;
  return numericPort(process.clientPort ?? process.port);
}

function backendPortForLlamaProcess(process = {}) {
  return numericPort(process.backendPort ?? process.port);
}

function connectionLabelForProcess(process = {}, displayPort = null) {
  return `llama-server · :${displayPort}${process.context ? ` · ctx ${(process.context / 1024).toFixed(0)}K` : ''}`;
}

export function modelMatchesRunningLlamaProcess(model = {}, process = {}) {
  const processAlias = normalized(process.alias);
  const modelIds = [
    model.apiModel,
    model.servedModelName,
    model.modelAlias,
    model.name,
    model.key
  ].map(normalized).filter(Boolean);

  if (processAlias && modelIds.includes(processAlias)) return true;

  const configuredPath = normalizedPath(model.modelPath || model.path);
  const processPath = normalizedPath(process.modelPath);
  if (!configuredPath || !processPath) return false;
  return configuredPath === processPath ||
    configuredPath.startsWith(`${processPath}/`) ||
    processPath.startsWith(`${configuredPath}/`);
}

function processInventoryItem(process, { status, sizeGB, apiModel, studioRuntimeResolved } = {}) {
  const resolvedStatus = status || 'running';
  const resolvedModel = String(apiModel || '').trim() || null;
  const studioIdentityUnavailable = isUnslothStudioProcess(process) && studioRuntimeResolved === false;
  const clientPort = studioIdentityUnavailable ? null : clientPortForLlamaProcess(process);
  const backendPort = studioIdentityUnavailable ? null : backendPortForLlamaProcess(process);
  const displayPort = clientPort || backendPort;
  return {
    key: process.alias || process.label,
    name: process.label,
    displayName: process.label,
    servedModelName: resolvedModel,
    functionLabel: 'Plain GGUF · OpenAI-compatible API',
    connectionLabel: connectionLabelForProcess(process, displayPort),
    apiModel: resolvedModel,
    sizeGB: sizeGB ?? null,
    path: process.modelPath,
    modelPath: process.modelPath,
    ctx: process.context,
    port: displayPort,
    clientPort,
    backendPort,
    host: '127.0.0.1',
    status: resolvedStatus,
    running: resolvedStatus === 'running',
    runtime: 'llama',
    source: 'llama-process'
  };
}

function unresolvedStudioCard(configured) {
  return {
    ...configured,
    apiModel: null,
    servedModelName: null,
    status: 'loading',
    running: false,
    port: null,
    clientPort: null,
    backendPort: null,
    proxyPort: null,
    proxyUrl: null,
    localUrl: null,
    server: null,
    connectionLabel: null,
  };
}

export function mergeRunningLlamaProcess(models, process, details = {}) {
  const next = {
    ...models,
    llama: [...(models.llama || [])],
    vllm: (models.vllm || []).filter(model => Number(model.port || 0) !== Number(process.port || 0))
  };

  const matchingIndexes = next.llama
    .map((model, index) => (
      Number(model.port || 0) === Number(process.port || 0) ||
      modelMatchesRunningLlamaProcess(model, process)
        ? index
        : -1
    ))
    .filter(index => index >= 0);
  const studioProcess = isUnslothStudioProcess(process);

  if (studioProcess && matchingIndexes.length > 1) {
    for (const matchingIndex of matchingIndexes) {
      next.llama[matchingIndex] = unresolvedStudioCard(next.llama[matchingIndex]);
    }
    return next;
  }

  const index = matchingIndexes[0] ?? -1;

  if (index < 0) {
    next.llama.push(processInventoryItem(process, details));
    return next;
  }

  const configured = next.llama[index];
  const status = details.status || 'running';
  const studioRuntimeResolved = !studioProcess || details.studioRuntimeResolved !== false;
  const processClientPort = clientPortForLlamaProcess(process);
  const processBackendPort = backendPortForLlamaProcess(process);
  const clientPort = !studioRuntimeResolved
    ? null
    : studioProcess
    ? processClientPort || processBackendPort
    : numericPort(configured.clientPort || configured.port) || processClientPort || processBackendPort;
  const backendPort = studioRuntimeResolved ? processBackendPort : null;
  const displayPort = studioRuntimeResolved ? clientPort || backendPort : null;
  const liveApiModel = String(details.apiModel || '').trim() || null;
  next.llama[index] = {
    ...configured,
    runtime: 'llama',
    status,
    running: status === 'running',
    port: displayPort,
    clientPort,
    backendPort,
    host: configured.host || '127.0.0.1',
    path: configured.path || process.modelPath,
    modelPath: configured.modelPath || process.modelPath,
    apiModel: liveApiModel,
    servedModelName: liveApiModel,
    sizeGB: configured.sizeGB ?? details.sizeGB ?? null,
    ctx: configured.ctx || process.context,
    functionLabel: configured.functionLabel || 'Plain GGUF · OpenAI-compatible API',
    connectionLabel: studioProcess
      ? connectionLabelForProcess(process, displayPort)
      : configured.connectionLabel || connectionLabelForProcess(process, displayPort),
    ...(studioRuntimeResolved
      ? (studioProcess ? { proxyPort: clientPort } : {})
      : {
          proxyPort: null,
          proxyUrl: null,
          localUrl: null,
          server: null,
        }),
  };
  return next;
}
