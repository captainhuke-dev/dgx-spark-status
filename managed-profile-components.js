import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const DEFAULT_PROFILE_DIR = '/etc/dgx-model-control/models.d';
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

function unquote(value) {
  const trimmed = String(value || '').trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseProfileEnv(text) {
  const env = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) env[match[1]] = unquote(match[2]);
  }
  return env;
}

function readPositiveInteger(path, reader) {
  try {
    const value = String(reader(path, 'utf8')).trim();
    if (!/^[1-9][0-9]*$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function processGroupForPid(pid, reader) {
  try {
    const stat = String(reader(`/proc/${pid}/stat`, 'utf8'));
    const suffix = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const state = suffix[0];
    const processGroup = Number(suffix[2]);
    if (state === 'Z' || !Number.isSafeInteger(processGroup) || processGroup <= 0) return null;
    return processGroup;
  } catch {
    return null;
  }
}

export function readManagedProfileComponents(profile = {}, options = {}) {
  const profileId = String(profile.profile_id || '').trim();
  if (!SAFE_NAME.test(profileId)) return [];

  const reader = options.readFileSync || readFileSync;
  const profileDir = options.profileDir || DEFAULT_PROFILE_DIR;
  let env;
  try {
    env = parseProfileEnv(reader(join(profileDir, `${profileId}.env`), 'utf8'));
  } catch {
    return [];
  }

  const runtimeDir = String(env.MANAGED_RUNTIME_DIR || '').trim();
  const componentNames = String(env.MANAGED_COMPONENTS || '')
    .split(/\s+/)
    .filter(name => SAFE_NAME.test(name));
  if (!isAbsolute(runtimeDir) || componentNames.length === 0) return [];

  return componentNames.map(name => {
    const pid = readPositiveInteger(join(runtimeDir, `${name}.pid`), reader);
    const pgid = readPositiveInteger(join(runtimeDir, `${name}.pgid`), reader);
    const actualPgid = pid ? processGroupForPid(pid, reader) : null;
    return {
      name,
      active: Boolean(pid && pgid && actualPgid === pgid),
      pid,
      pgid,
      actual_pgid: actualPgid
    };
  });
}
