function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizedPath(value) {
  return normalized(value).replace(/\/+$/, '');
}

export const UNSLOTH_STUDIO_ROOT = '/home/mctdgx01/apps/unsloth-studio';
export const UNSLOTH_STUDIO_CLIENT_PORT = 56827;

function numericPort(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function isUnslothStudioProcess(process = {}) {
  const command = String(process.command || '');
  return command.includes(`${UNSLOTH_STUDIO_ROOT}/llama.cpp/llama-server`);
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

function processInventoryItem(process, { status, sizeGB, apiModel } = {}) {
  const resolvedStatus = status || 'running';
  const resolvedModel = String(apiModel || '').trim() || null;
  const clientPort = clientPortForLlamaProcess(process);
  const backendPort = backendPortForLlamaProcess(process);
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

export function mergeRunningLlamaProcess(models, process, details = {}) {
  const next = {
    ...models,
    llama: [...(models.llama || [])],
    vllm: (models.vllm || []).filter(model => Number(model.port || 0) !== Number(process.port || 0))
  };

  const index = next.llama.findIndex(model =>
    Number(model.port || 0) === Number(process.port || 0) ||
    modelMatchesRunningLlamaProcess(model, process)
  );

  if (index < 0) {
    next.llama.push(processInventoryItem(process, details));
    return next;
  }

  const configured = next.llama[index];
  const status = details.status || 'running';
  const studioProcess = isUnslothStudioProcess(process);
  const processClientPort = clientPortForLlamaProcess(process);
  const processBackendPort = backendPortForLlamaProcess(process);
  const clientPort = studioProcess
    ? processClientPort || processBackendPort
    : numericPort(configured.clientPort || configured.port) || processClientPort || processBackendPort;
  const displayPort = clientPort || processBackendPort;
  const liveApiModel = String(details.apiModel || '').trim() || null;
  next.llama[index] = {
    ...configured,
    runtime: 'llama',
    status,
    running: status === 'running',
    port: displayPort,
    clientPort,
    backendPort: processBackendPort,
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
      : configured.connectionLabel || connectionLabelForProcess(process, displayPort)
  };
  return next;
}
