import { readFileSync, realpathSync } from 'node:fs';

import {
  UNSLOTH_STUDIO_INTERPRETER,
  UNSLOTH_STUDIO_LAUNCHER,
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

function parseProcParentPid(statText) {
  const closeParen = String(statText || '').lastIndexOf(')');
  if (closeParen < 0) return null;
  const fields = String(statText).slice(closeParen + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  return Number.isSafeInteger(ppid) && ppid >= 0 ? ppid : null;
}

function parseProcArgv(cmdline) {
  const raw = Buffer.isBuffer(cmdline) ? cmdline : Buffer.from(cmdline || '');
  return raw.toString('utf8').split('\0').filter(Boolean);
}

export function readProcessRecord(
  pid,
  {
    readFile = readFileSync,
    realpath = realpathSync,
    procRoot = '/proc',
  } = {},
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const processRoot = `${procRoot}/${pid}`;
    const executable = realpath(`${processRoot}/exe`);
    const ppid = parseProcParentPid(readFile(`${processRoot}/stat`, 'utf8'));
    const argv = parseProcArgv(readFile(`${processRoot}/cmdline`));
    if (!executable || ppid === null || argv.length === 0) return null;
    return { pid, ppid, executable, argv };
  } catch {
    return null;
  }
}

function hasVerifiedStudioLauncherAncestry(
  process,
  { readProcess = readProcessRecord, realpath = realpathSync } = {},
) {
  let installedInterpreter;
  try {
    installedInterpreter = realpath(UNSLOTH_STUDIO_INTERPRETER);
  } catch {
    return false;
  }

  let ancestorPid = process?.ppid;
  const seen = new Set();
  while (Number.isSafeInteger(ancestorPid) && ancestorPid > 0 && !seen.has(ancestorPid)) {
    seen.add(ancestorPid);
    let ancestor = null;
    try {
      ancestor = readProcess(ancestorPid);
    } catch {
      return false;
    }
    if (!ancestor) return false;
    if (ancestor.executable === installedInterpreter &&
        ancestor.argv?.[0] === UNSLOTH_STUDIO_INTERPRETER &&
        ancestor.argv?.[1] === UNSLOTH_STUDIO_LAUNCHER &&
        ancestor.argv?.[2] === 'studio') {
      return true;
    }
    ancestorPid = ancestor.ppid;
  }
  return false;
}

export function parseRunningLlamaProcessLine(
  line = '',
  { readProcess = readProcessRecord, realpath = realpathSync } = {},
) {
  const match = String(line).match(/^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  if (!match) return null;

  const [, pidText, ppidText, startedAt, command] = match;
  const pid = Number(pidText);
  let processRecord = null;
  try {
    processRecord = readProcess(pid) || null;
  } catch {
    processRecord = null;
  }
  const executable = processRecord?.executable || null;
  const studioLauncherAncestryVerified = processRecord
    ? hasVerifiedStudioLauncherAncestry(processRecord, { readProcess, realpath })
    : false;
  const port = numericPort(parseCommandArg(command, ['--port', '-p']));
  const modelPath = parseCommandArg(command, ['--model', '-m']);
  const alias = parseCommandArg(command, ['--alias']);
  const context = numericPort(parseCommandArg(command, ['--ctx-size', '-c']));
  const baseName = modelPath ? modelPath.split('/').filter(Boolean).pop() : '';
  const processIdentity = {
    executable,
    command,
    port,
    studioLauncherAncestryVerified,
  };
  const clientPort = clientPortForLlamaProcess(processIdentity);

  return {
    pid,
    ppid: processRecord?.ppid ?? Number(ppidText),
    startedAt,
    executable,
    studioLauncherAncestryVerified,
    command,
    port,
    clientPort,
    backendPort: port,
    isUnslothStudio: isUnslothStudioProcess(processIdentity),
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
