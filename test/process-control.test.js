import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyExecutable, validateStopRequest, createProcessController } from '../process-control.js';

function controllerFor(processes, overrides = {}) {
  return createProcessController({
    listProcesses: async () => processes,
    ownerUid: 1000,
    selfPid: 900,
    sleep: async () => {},
    ...overrides
  });
}

test('classifies only exact Claude and Codex executable basenames', () => {
  assert.equal(classifyExecutable('claude'), 'claude');
  assert.equal(classifyExecutable('/usr/local/bin/codex'), 'codex');
  assert.equal(classifyExecutable('claude-code'), 'claude');
  assert.equal(classifyExecutable('dacr-codex'), 'codex');
  assert.equal(classifyExecutable('claude-helper'), null);
  assert.equal(classifyExecutable('node-codex-wrapper'), null);
});

test('requires the family-specific confirmation token', () => {
  assert.equal(validateStopRequest('claude', { confirm: 'STOP_CLAUDE' }).ok, true);
  assert.equal(validateStopRequest('codex', { confirm: 'STOP_CODEX' }).ok, true);
  assert.equal(validateStopRequest('codex', { confirm: 'STOP_CLAUDE' }).ok, false);
  assert.equal(validateStopRequest('other', { confirm: 'STOP_OTHER' }).ok, false);
});

test('stops only owned family processes and excludes the dashboard ancestor chain', async () => {
  const signals = [];
  const processes = [
    { pid: 901, ppid: 1, uid: 1000, executable: 'node', startTime: 'ancestor' },
    { pid: 900, ppid: 901, uid: 1000, executable: 'node', startTime: 'self' },
    { pid: 101, ppid: 900, uid: 1000, executable: 'claude', startTime: 'claude-child' },
    { pid: 102, ppid: 1, uid: 1001, executable: 'claude', startTime: 'other-user' },
    { pid: 103, ppid: 1, uid: 1000, executable: 'codex', startTime: 'codex' },
    { pid: 104, ppid: 1, uid: 1000, executable: 'claude-helper', startTime: 'lookalike' }
  ];
  const result = await controllerFor(processes, {
    kill: (pid, signal) => signals.push([pid, signal]),
    isAlive: async () => false,
    readStartTime: async pid => processes.find(item => item.pid === pid)?.startTime
  }).stopFamily('claude');

  assert.deepEqual(result.captured, [101]);
  assert.deepEqual(result.stopped, [101]);
  assert.deepEqual(signals, [[101, 'SIGTERM']]);
});

test('stops an eligible process with SIGTERM when it exits cleanly', async () => {
  let alive = true;
  const signals = [];
  const processes = [{ pid: 201, ppid: 1, uid: 1000, executable: 'claude', startTime: 'start-201' }];
  const result = await controllerFor(processes, {
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 'SIGTERM') alive = false;
    },
    isAlive: async () => alive,
    readStartTime: async () => 'start-201'
  }).stopFamily('claude');

  assert.deepEqual(result.captured, [201]);
  assert.deepEqual(result.stopped, [201]);
  assert.deepEqual(result.escalated, []);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(signals, [[201, 'SIGTERM']]);
});

test('escalates only the captured process when SIGTERM leaves it alive', async () => {
  let alive = true;
  const signals = [];
  const processes = [{ pid: 202, ppid: 1, uid: 1000, executable: 'codex', startTime: 'start-202' }];
  const result = await controllerFor(processes, {
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 'SIGKILL') alive = false;
    },
    isAlive: async () => alive,
    readStartTime: async () => 'start-202'
  }).stopFamily('codex');

  assert.deepEqual(result.stopped, [202]);
  assert.deepEqual(result.escalated, [202]);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(signals, [[202, 'SIGTERM'], [202, 'SIGKILL']]);
});

test('does not escalate a reused PID after the original process exits', async () => {
  const signals = [];
  const processes = [{ pid: 203, ppid: 1, uid: 1000, executable: 'claude', startTime: 'original' }];
  const result = await controllerFor(processes, {
    kill: (pid, signal) => signals.push([pid, signal]),
    isAlive: async () => true,
    readStartTime: async () => 'reused'
  }).stopFamily('claude');

  assert.deepEqual(result.stopped, []);
  assert.deepEqual(result.escalated, []);
  assert.deepEqual(result.failures, [{ pid: 203, code: 'pid_reused' }]);
  assert.deepEqual(signals, [[203, 'SIGTERM']]);
});

test('reports partial failure while continuing to stop the remaining candidates', async () => {
  const signals = [];
  const processes = [
    { pid: 204, ppid: 1, uid: 1000, executable: 'claude', startTime: 'start-204' },
    { pid: 205, ppid: 1, uid: 1000, executable: 'claude', startTime: 'start-205' }
  ];
  const result = await controllerFor(processes, {
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (pid === 204) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    },
    isAlive: async () => false,
    readStartTime: async pid => `start-${pid}`
  }).stopFamily('claude');

  assert.equal(result.ok, false);
  assert.deepEqual(result.stopped, [205]);
  assert.deepEqual(result.failures, [{ pid: 204, code: 'signal_failed' }]);
  assert.deepEqual(signals, [[204, 'SIGTERM'], [205, 'SIGTERM']]);
});
