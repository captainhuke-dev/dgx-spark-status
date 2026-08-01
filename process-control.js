import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const STOP_WAIT_MS = 250;

export const STOP_CONFIRMATIONS = Object.freeze({
  claude: 'STOP_CLAUDE',
  codex: 'STOP_CODEX'
});

export function classifyExecutable(executable) {
  const basename = String(executable || '').split('/').pop().toLowerCase();
  if (basename === 'claude' || basename === 'claude-code') return 'claude';
  if (basename === 'codex' || basename === 'dacr-codex') return 'codex';
  return null;
}

export function validateStopRequest(family, body) {
  const expected = STOP_CONFIRMATIONS[family];
  if (!expected || body?.confirm !== expected) {
    return { ok: false, code: 'confirmation_required' };
  }
  return { ok: true };
}

function readProcessStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closingParen = stat.lastIndexOf(')');
    if (closingParen < 0) return null;
    return stat.slice(closingParen + 2).trim().split(/\s+/)[19] || null;
  } catch {
    return null;
  }
}

async function listSystemProcesses(readStartTime, execFileFn) {
  const { stdout } = await execFileFn('ps', ['-eo', 'pid=,ppid=,uid=,comm='], {
    maxBuffer: 1024 * 1024
  });
  const rows = [];
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    const uid = Number(fields[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(uid)) continue;
    rows.push({
      pid,
      ppid,
      uid,
      executable: fields[3],
      startTime: readStartTime(pid)
    });
  }
  return rows;
}

function protectedProcessIds(processes, selfPid) {
  const parents = new Map(processes.map(process => [process.pid, process.ppid]));
  const protectedIds = new Set([selfPid]);
  let current = selfPid;
  while (parents.has(current)) {
    const parent = parents.get(current);
    if (!Number.isInteger(parent) || parent <= 0 || protectedIds.has(parent)) break;
    protectedIds.add(parent);
    current = parent;
  }
  return protectedIds;
}

function emptyResult(family, extra = {}) {
  return {
    ok: true,
    family,
    captured: [],
    stopped: [],
    alreadyExited: [],
    escalated: [],
    failures: [],
    ...extra
  };
}

export function createProcessController(dependencies = {}) {
  const kill = dependencies.kill || process.kill.bind(process);
  const isAlive = dependencies.isAlive || (async pid => {
    try {
      kill(pid, 0);
      return true;
    } catch (error) {
      if (error?.code === 'ESRCH') return false;
      throw error;
    }
  });
  const readStartTime = dependencies.readStartTime || readProcessStartTime;
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const ownerUid = dependencies.ownerUid ?? process.getuid?.() ?? null;
  const selfPid = dependencies.selfPid ?? process.pid;
  const execFileFn = dependencies.execFile || execFileAsync;
  const listProcesses = dependencies.listProcesses
    || (() => listSystemProcesses(readStartTime, execFileFn));

  async function stopFamily(family) {
    if (!STOP_CONFIRMATIONS[family]) {
      return emptyResult(family, {
        ok: false,
        failures: [{ code: 'invalid_family' }]
      });
    }

    const processes = await listProcesses();
    const protectedIds = protectedProcessIds(processes, selfPid);
    const candidates = processes.filter(process => (
      classifyExecutable(process.executable) === family
      && (ownerUid == null || process.uid === ownerUid)
      && !protectedIds.has(process.pid)
      && process.startTime != null
    ));
    const result = emptyResult(family, { captured: candidates.map(process => process.pid) });

    for (const candidate of candidates) {
      try {
        kill(candidate.pid, 'SIGTERM');
      } catch (error) {
        if (error?.code === 'ESRCH') {
          result.alreadyExited.push(candidate.pid);
        } else {
          result.failures.push({ pid: candidate.pid, code: 'signal_failed' });
        }
        continue;
      }

      await sleep(STOP_WAIT_MS);
      let alive;
      try {
        alive = await isAlive(candidate.pid);
      } catch {
        result.failures.push({ pid: candidate.pid, code: 'status_failed' });
        continue;
      }
      if (!alive) {
        result.stopped.push(candidate.pid);
        continue;
      }

      let currentStartTime;
      try {
        currentStartTime = await readStartTime(candidate.pid);
      } catch {
        result.failures.push({ pid: candidate.pid, code: 'identity_failed' });
        continue;
      }
      if (currentStartTime !== candidate.startTime) {
        result.failures.push({ pid: candidate.pid, code: 'pid_reused' });
        continue;
      }

      try {
        kill(candidate.pid, 'SIGKILL');
        result.escalated.push(candidate.pid);
      } catch (error) {
        if (error?.code === 'ESRCH') {
          result.alreadyExited.push(candidate.pid);
        } else {
          result.failures.push({ pid: candidate.pid, code: 'escalation_failed' });
        }
        continue;
      }

      await sleep(STOP_WAIT_MS);
      try {
        if (await isAlive(candidate.pid)) {
          result.failures.push({ pid: candidate.pid, code: 'process_still_alive' });
        } else {
          result.stopped.push(candidate.pid);
        }
      } catch {
        result.failures.push({ pid: candidate.pid, code: 'status_failed' });
      }
    }

    result.ok = result.failures.length === 0;
    return result;
  }

  return { stopFamily };
}
