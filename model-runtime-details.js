function truthy(value) {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value || '').trim().toLowerCase());
}

function contextLabel(value) {
  const tokens = Number.parseInt(value, 10);
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  return `${Math.round(tokens / 1024)}K`;
}

function backendLabel(env) {
  const validated = String(env.VALIDATED_BACKEND || '').toLowerCase();
  if (validated.includes('flashinfer_cutlass')) return 'FlashInfer CUTLASS (auto)';
  if (validated.includes('flashinfer_b12x')) return 'FlashInfer B12X';
  return '';
}

function parseEnvText(text) {
  const env = {};
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const separator = line.indexOf('=');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    env[key] = value;
  }
  return env;
}

export function buildModelRuntimeDetails(env = {}) {
  const backend = backendLabel(env);
  if (!backend) return null;

  const mtpEnabled = truthy(env.MTP_ENABLED);
  const mtpTokens = Number.parseInt(env.MTP_OPTIONAL_TOKENS, 10);
  const apiAlias = String(env.API_MODEL_ID || env.SERVED_MODEL_NAME || '').toLowerCase();
  const b12xIsActive = backend.includes('B12X');

  return {
    backend,
    attention: String(env.ATTENTION_BACKEND || '').toLowerCase() === 'flashinfer'
      ? 'FlashInfer'
      : String(env.ATTENTION_BACKEND || ''),
    mtp: mtpEnabled
      ? `Enabled${Number.isFinite(mtpTokens) ? ` · ${mtpTokens} speculative tokens` : ''}`
      : 'Disabled',
    architecture: String(env.CUTE_DSL_ARCH || ''),
    context: contextLabel(env.MAX_MODEL_LEN || env.CTX_SIZE || env.NATIVE_CONTEXT_LENGTH),
    stack: String(env.RUNTIME_STACK || ''),
    apiAliasNote: apiAlias.includes('b12x') && !b12xIsActive
      ? 'Legacy API alias; B12X is not the active backend'
      : '',
  };
}

export function readModelRuntimeDetails(profile = {}, readFile) {
  const configFile = String(profile.config_file || '');
  if (!/^\/etc\/vllm\/models\/[A-Za-z0-9._-]+\.env$/.test(configFile)) return null;
  if (typeof readFile !== 'function') return null;

  try {
    return buildModelRuntimeDetails(parseEnvText(readFile(configFile, 'utf8')));
  } catch {
    return null;
  }
}
