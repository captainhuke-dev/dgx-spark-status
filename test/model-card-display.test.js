import assert from 'node:assert/strict';
import test from 'node:test';

import { modelBudgetLabel } from '../model-card-display.js';
import * as modelCardDisplay from '../model-card-display.js';

test('formats DS4 240K-total context and input/output budgets compactly', () => {
  assert.equal(
    modelBudgetLabel({ ctx: 245760, maxInputTokens: 212992, maxOutputTokens: 32768 }),
    'ctx240K · 208K/32K'
  );
});

test('modelIdValue returns the exact live API model ID even when the display name matches', () => {
  assert.equal(typeof modelCardDisplay.modelIdValue, 'function');

  assert.equal(
    modelCardDisplay.modelIdValue({
      apiModel: 'unsloth/DeepSeek-V4-Flash-0731-GGUF',
      name: 'unsloth/DeepSeek-V4-Flash-0731-GGUF'
    }),
    'unsloth/DeepSeek-V4-Flash-0731-GGUF'
  );
});

test('modelIdValue does not invent an ID from an empty model name', () => {
  assert.equal(typeof modelCardDisplay.modelIdValue, 'function');

  assert.equal(
    modelCardDisplay.modelIdValue({
      name: 'unsloth/DeepSeek-V4-Flash-0731-GGUF'
    }),
    ''
  );
});
