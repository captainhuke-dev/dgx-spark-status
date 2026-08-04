import {
  clientPortForLlamaProcess,
  isUnslothStudioProcess,
} from './runtime-model-inventory.js';

function numericPort(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseCommandArg(command, flags) {
  const escaped = flags.map(flag => flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = String(command || '').match(new RegExp(`(?:^|\\s)(?:${escaped})(?:=|\\s+)([^\\s]+)`));
  return match ? match[1] : null;
}

export function parseRunningLlamaProcessLine(line = '') {
  const match = String(line).match(/^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  if (!match) return null;

  const [, pidText, ppidText, startedAt, command] = match;
  const port = numericPort(parseCommandArg(command, ['--port', '-p']));
  const modelPath = parseCommandArg(command, ['--model', '-m']);
  const alias = parseCommandArg(command, ['--alias']);
  const context = numericPort(parseCommandArg(command, ['--ctx-size', '-c']));
  const baseName = modelPath ? modelPath.split('/').filter(Boolean).pop() : '';
  const clientPort = clientPortForLlamaProcess({ command, port });

  return {
    pid: Number(pidText),
    ppid: Number(ppidText),
    startedAt,
    command,
    port,
    clientPort,
    backendPort: port,
    isUnslothStudio: isUnslothStudioProcess({ command }),
    modelPath,
    alias,
    context,
    label: alias || baseName?.replace(/\.gguf.*$/i, '') || `llama.cpp :${port}`
  };
}

export function selectedLlamaPorts(selectedRuntime = {}, fallbackPort = null) {
  const backendPort = numericPort(selectedRuntime?.backendPort ?? selectedRuntime?.port ?? fallbackPort);
  const proxyPort = numericPort(selectedRuntime?.clientPort ?? backendPort);
  return {
    port: backendPort,
    backendPort,
    proxyPort
  };
}
