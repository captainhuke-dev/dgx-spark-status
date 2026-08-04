import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { modelBudgetLabel } from '../model-card-display.js';
import * as modelCardDisplay from '../model-card-display.js';

const dashboardUi = readFileSync(new URL('../src/lib/SystemMetrics.svelte', import.meta.url), 'utf8');

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

test('SystemMetrics renders full model ID rows with copy buttons for llama, vLLM, and ETC cards', () => {
  assert.match(
    dashboardUi,
    /import\s+\{\s*modelBudgetLabel,\s*modelIdValue\s*\}\s+from '\.\.\/\.\.\/model-card-display\.js';/
  );
  assert.equal((dashboardUi.match(/\{@const liveModelId = modelIdValue\(model\)\}/g) || []).length, 3);
  assert.equal((dashboardUi.match(/class="model-id-value" title=\{liveModelId\}>\{liveModelId\}<\/span>/g) || []).length, 3);
  assert.equal((dashboardUi.match(/class="model-id-copy"/g) || []).length, 3);
  assert.equal((dashboardUi.match(/onclick=\{\(\) => copyModelId\(liveModelId\)\}/g) || []).length, 3);
  assert.match(dashboardUi, /await navigator\.clipboard\.writeText\(modelId\);/);
  assert.match(dashboardUi, /\{copied \? 'Copied' : 'Copy'\}/);
  assert.equal((dashboardUi.match(/aria-label="Copy full model ID"/g) || []).length, 3);
  assert.equal((dashboardUi.match(/title="Copy full model ID"/g) || []).length, 3);
  assert.doesNotMatch(dashboardUi, />\s*Model ID\s*</);
  assert.doesNotMatch(dashboardUi, /class="model-id-label"/);
  assert.doesNotMatch(dashboardUi, /\.model-id-value\s*\{[^}]*text-overflow\s*:\s*ellipsis/);
  assert.doesNotMatch(dashboardUi, /\.model-id-value\s*\{[^}]*white-space\s*:\s*nowrap/);
  assert.doesNotMatch(dashboardUi, /\.model-id-value\s*\{[^}]*overflow\s*:\s*hidden/);
  assert.doesNotMatch(dashboardUi, /displayModelId\(model\)/);
});
