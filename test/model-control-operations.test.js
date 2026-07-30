import test from 'node:test';
import assert from 'node:assert/strict';

let stopAllManagedModels = async () => ({
  ok: true,
  action: 'stop_all',
  stopped: [],
  already_stopped: [],
  failures: []
});

try {
  ({ stopAllManagedModels } = await import('../model-control-operations.js'));
} catch {}

test('stops active profiles sequentially and skips stopped profiles', async () => {
  const calls = [];
  const result = await stopAllManagedModels([
    { profile_id: 'running-model', status: 'running' },
    { profile_id: 'stopped-model', status: 'stopped' },
    { profile_id: 'resident-model', status: 'degraded_resident', active: true }
  ], {
    stopProfile: async profileId => {
      calls.push(profileId);
      return { ok: true };
    },
    getLegacyDs4Status: async () => ({ running: false, port_listening: false }),
    stopLegacyDs4: async () => {
      throw new Error('legacy stop should not run');
    }
  });

  assert.deepEqual(calls, ['running-model', 'resident-model']);
  assert.deepEqual(result.stopped, ['running-model', 'resident-model']);
  assert.deepEqual(result.already_stopped, ['stopped-model']);
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
});

test('records profile failures and continues with remaining active profiles', async () => {
  const calls = [];
  const result = await stopAllManagedModels([
    { profile_id: 'broken-model', status: 'loading' },
    { profile_id: 'healthy-model', status: 'running' }
  ], {
    stopProfile: async profileId => {
      calls.push(profileId);
      return profileId === 'broken-model'
        ? { ok: false, code: 'stop_failed', message: 'refused' }
        : { ok: true };
    },
    getLegacyDs4Status: async () => ({ running: false, port_listening: false }),
    stopLegacyDs4: async () => ({ ok: true })
  });

  assert.deepEqual(calls, ['broken-model', 'healthy-model']);
  assert.deepEqual(result.stopped, ['healthy-model']);
  assert.deepEqual(result.failures, [
    { profile_id: 'broken-model', code: 'stop_failed', message: 'refused' }
  ]);
  assert.equal(result.ok, false);
});

test('reports a failure when a profile remains active after its stop command', async () => {
  const result = await stopAllManagedModels([
    { profile_id: 'survivor-model', status: 'running' }
  ], {
    stopProfile: async () => ({ ok: true }),
    statusProfile: async () => ({ ok: true, status: 'degraded_resident', active: true }),
    getLegacyDs4Status: async () => ({ running: false, port_listening: false }),
    stopLegacyDs4: async () => ({ ok: true })
  });

  assert.deepEqual(result.stopped, []);
  assert.deepEqual(result.failures, [{
    profile_id: 'survivor-model',
    code: 'stop_incomplete',
    message: 'Model remains active after stop'
  }]);
  assert.equal(result.ok, false);
});

test('stops the exact legacy DS4 controller only when it is active', async () => {
  let legacyStops = 0;
  let legacyChecks = 0;
  const result = await stopAllManagedModels([], {
    stopProfile: async () => ({ ok: true }),
    getLegacyDs4Status: async () => ({ running: false, port_listening: legacyChecks++ === 0 }),
    stopLegacyDs4: async () => {
      legacyStops += 1;
      return { ok: true };
    }
  });

  assert.equal(legacyStops, 1);
  assert.deepEqual(result.stopped, ['ds4-deepseek-v4-flash-256k-8889']);
  assert.equal(result.ok, true);
});
