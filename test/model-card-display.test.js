import assert from 'node:assert/strict';
import test from 'node:test';

import { modelBudgetLabel } from '../model-card-display.js';

test('formats DS4 context and input/output budgets compactly', () => {
  assert.equal(
    modelBudgetLabel({ ctx: 278528, maxInputTokens: 245760, maxOutputTokens: 32768 }),
    'ctx272K · 240K/32K'
  );
});
