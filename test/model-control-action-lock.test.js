import test from 'node:test';
import assert from 'node:assert/strict';

let createModelControlActionLock;
try {
  ({ createModelControlActionLock } = await import('../model-control-action-lock.js'));
} catch {}

test('rejects overlapping model mutations and releases after completion', async () => {
  const lock = createModelControlActionLock();
  let release;
  const first = lock.run(async () => {
    await new Promise(resolve => { release = resolve; });
    return { ok: true, action: 'first' };
  });

  await Promise.resolve();
  assert.deepEqual(await lock.run(async () => ({ ok: true, action: 'second' })), {
    ok: false,
    code: 'busy',
    message: 'Another model control action is already in progress'
  });

  release();
  assert.deepEqual(await first, { ok: true, action: 'first' });
  assert.deepEqual(await lock.run(async () => ({ ok: true, action: 'third' })), {
    ok: true,
    action: 'third'
  });
});

test('releases the mutation lock when an action throws', async () => {
  const lock = createModelControlActionLock();
  await assert.rejects(lock.run(async () => {
    throw new Error('boom');
  }), /boom/);
  assert.equal((await lock.run(async () => ({ ok: true }))).ok, true);
});
