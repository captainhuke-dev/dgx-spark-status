import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMemoryDisplay } from '../memory-display.js';

const GiB = 1024 ** 3;

test('uses MemAvailable for active usage and separates reclaimable file cache', () => {
  const display = buildMemoryDisplay({
    total: 16 * GiB,
    used: 12 * GiB,
    free: 4 * GiB,
    available: 6 * GiB,
    buffcache: 2 * GiB
  }, [{ memoryGB: '9.00' }], [{ memoryTotal: null, memoryUsed: null }]);

  assert.equal(display.totalGB, 16);
  assert.equal(display.usedGB, 10);
  assert.equal(display.freeGB, 4);
  assert.equal(display.availableGB, 6);
  assert.equal(display.cacheGB, 2);
  assert.equal(display.processRssGB, 9);
  assert.equal(display.otherUsedGB, 10);
  assert.equal(display.usedPercent, 62.5);
  assert.equal(display.cachePercent, 12.5);
});

test('uses unified-memory GPU process allocation when VRAM totals are unavailable', () => {
  const display = buildMemoryDisplay({
    total: 32 * GiB,
    free: 8 * GiB,
    available: 12 * GiB
  }, [], [{ memoryTotal: null, memoryUsed: null, computeMemoryUsedMB: 4096 }]);

  assert.equal(display.gpuMemoryGB, 4);
  assert.equal(display.usedGB, 20);
  assert.equal(display.gpuPercent, 12.5);
  assert.equal(display.otherUsedGB, 16);
});
