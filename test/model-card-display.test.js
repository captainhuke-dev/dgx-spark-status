import assert from 'node:assert/strict';
import test from 'node:test';

import { modelBudgetLabel } from '../model-card-display.js';

test('formats DS4 240K-total context and input/output budgets compactly', () => {
  assert.equal(
    modelBudgetLabel({ ctx: 245760, maxInputTokens: 212992, maxOutputTokens: 32768 }),
    'ctx240K · 208K/32K'
  );
});
