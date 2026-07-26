import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyInventoryConfig } from '../model-inventory-section.js';

test('places explicit DS4 override in llama section without changing runtime identity', () => {
  assert.deepEqual(
    classifyInventoryConfig(
      { DASHBOARD_SECTION: 'llama', RUNTIME: 'ds4' },
      'vllm',
      true
    ),
    { include: true, section: 'llama', runtime: 'ds4' }
  );
});

test('preserves default classification without an override', () => {
  assert.deepEqual(
    classifyInventoryConfig({}, 'vllm', false),
    { include: true, section: 'vllm', runtime: 'vllm' }
  );
});

test('keeps legacy DS4 excluded without a valid override', () => {
  assert.deepEqual(
    classifyInventoryConfig({ RUNTIME: 'ds4' }, 'vllm', true),
    { include: false, section: 'vllm', runtime: 'vllm' }
  );
});

test('invalid section override cannot bypass legacy DS4 exclusion', () => {
  assert.deepEqual(
    classifyInventoryConfig(
      { DASHBOARD_SECTION: 'other', RUNTIME: 'ds4' },
      'vllm',
      true
    ),
    { include: false, section: 'vllm', runtime: 'vllm' }
  );
});
