function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizedPath(value) {
  return normalized(value).replace(/\/+$/, '');
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
  return {
    key: process.alias || process.label,
    name: process.label,
    displayName: process.label,
    servedModelName: resolvedModel,
    functionLabel: 'Plain GGUF · OpenAI-compatible API',
    connectionLabel: `llama-server · :${process.port}${process.context ? ` · ctx ${(process.context / 1024).toFixed(0)}K` : ''}`,
    apiModel: resolvedModel,
    sizeGB: sizeGB ?? null,
    path: process.modelPath,
    modelPath: process.modelPath,
    ctx: process.context,
    port: process.port,
    backendPort: process.port,
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
  const displayPort = configured.port || process.port;
  const liveApiModel = String(details.apiModel || '').trim() || null;
  next.llama[index] = {
    ...configured,
    runtime: 'llama',
    status,
    running: status === 'running',
    port: displayPort,
    backendPort: process.port,
    host: configured.host || '127.0.0.1',
    path: configured.path || process.modelPath,
    modelPath: configured.modelPath || process.modelPath,
    apiModel: liveApiModel,
    servedModelName: liveApiModel,
    sizeGB: configured.sizeGB ?? details.sizeGB ?? null,
    ctx: configured.ctx || process.context,
    functionLabel: configured.functionLabel || 'Plain GGUF · OpenAI-compatible API',
    connectionLabel: configured.connectionLabel || `llama-server · :${displayPort}${process.context ? ` · ctx ${(process.context / 1024).toFixed(0)}K` : ''}`
  };
  return next;
}
