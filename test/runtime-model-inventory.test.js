import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeRunningLlamaProcess } from '../runtime-model-inventory.js';

test('merges a raw llama backend into its configured guard preset by alias and keeps the guard port', () => {
  const models = {
    llama: [{
      name: 'DeepSeek V4 Flash 0731 Unsloth UD-IQ3_XXS',
      apiModel: 'deepseek0731-flash',
      servedModelName: 'deepseek0731-flash',
      modelPath: '/home/mctdgx01/models/unsloth-DeepSeek-V4-Flash-0731-GGUF-IQ3-XXS/UD-IQ3_XXS',
      port: 18132,
      status: 'running',
      runtime: 'llama.cpp',
      config: '/etc/vllm/models/deepseek0731-flash.env'
    }],
    vllm: []
  };

  const merged = mergeRunningLlamaProcess(models, {
    port: 18131,
    alias: 'deepseek0731-flash',
    modelPath: '/home/mctdgx01/models/unsloth-DeepSeek-V4-Flash-0731-GGUF-IQ3-XXS/UD-IQ3_XXS/DeepSeek-V4-Flash-0731-UD-IQ3_XXS-00001-of-00004.gguf',
    context: 278528,
    label: 'deepseek0731-flash'
  }, { status: 'running', apiModel: 'deepseek0731-flash' });

  assert.equal(merged.llama.length, 1);
  assert.equal(merged.llama[0].port, 18132);
  assert.equal(merged.llama[0].backendPort, 18131);
  assert.equal(merged.llama[0].apiModel, 'deepseek0731-flash');
  assert.equal(merged.llama[0].ctx, 278528);
});

test('keeps an unrelated running llama process as a separate inventory item', () => {
  const merged = mergeRunningLlamaProcess({
    llama: [{ apiModel: 'other-model', modelPath: '/models/other', port: 18000 }],
    vllm: []
  }, {
    port: 18131,
    alias: 'deepseek0731-flash',
    modelPath: '/models/deepseek/file.gguf',
    context: 278528,
    label: 'deepseek0731-flash'
  }, { status: 'running', apiModel: 'deepseek0731-flash' });

  assert.equal(merged.llama.length, 2);
  assert.equal(merged.llama[1].port, 18131);
});
