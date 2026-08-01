import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMemoryDisplay } from '../memory-display.js';

const GiB = 1024 ** 3;

test('uses system used/free accounting while keeping process RSS and available headroom separate', () => {
  const display = buildMemoryDisplay({
    total: 16 * GiB,
    used: 12 * GiB,
    free: 4 * GiB,
    available: 6 * GiB
  }, [{ memoryGB: '9.00' }], [{ memoryTotal: null, memoryUsed: null }]);

  assert.equal(display.totalGB, 16);
  assert.equal(display.usedGB, 12);
  assert.equal(display.freeGB, 4);
  assert.equal(display.availableGB, 6);
  assert.equal(display.processRssGB, 9);
  assert.equal(display.otherUsedGB, 3);
  assert.equal(display.usedPercent, 75);
});
