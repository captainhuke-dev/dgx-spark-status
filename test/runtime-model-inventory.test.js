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

test('prefers a live probed apiModel over stale configured metadata while keeping the dashboard card identity', () => {
  const models = {
    llama: [{
      name: 'DeepSeek V4 Flash 0731 Unsloth UD-IQ3_XXS',
      displayName: 'DeepSeek V4 Flash 0731 Unsloth UD-IQ3_XXS',
      apiModel: 'stale-configured-id',
      servedModelName: 'stale-configured-id',
      modelPath: '/home/mctdgx01/models/unsloth-DeepSeek-V4-Flash-0731-GGUF-IQ3-XXS/UD-IQ3_XXS',
      port: 18132,
      backendPort: 18132,
      status: 'running',
      runtime: 'llama.cpp',
      functionLabel: 'Configured card label',
      connectionLabel: 'llama-server · :18131 · ctx 272K'
    }],
    vllm: []
  };

  const merged = mergeRunningLlamaProcess(models, {
    port: 18131,
    alias: 'deepseek0731-flash',
    modelPath: '/home/mctdgx01/models/unsloth-DeepSeek-V4-Flash-0731-GGUF-IQ3-XXS/UD-IQ3_XXS/DeepSeek-V4-Flash-0731-UD-IQ3_XXS-00001-of-00004.gguf',
    context: 278528,
    label: 'DeepSeek V4 Flash 0731 Unsloth UD-IQ3_XXS'
  }, { status: 'running', apiModel: 'unsloth/DeepSeek-V4-Flash-0731-GGUF' });

  assert.equal(merged.llama.length, 1);
  assert.equal(merged.llama[0].port, 18132);
  assert.equal(merged.llama[0].backendPort, 18131);
  assert.equal(merged.llama[0].apiModel, 'unsloth/DeepSeek-V4-Flash-0731-GGUF');
  assert.equal(merged.llama[0].displayName, 'DeepSeek V4 Flash 0731 Unsloth UD-IQ3_XXS');
  assert.equal(merged.llama[0].functionLabel, 'Configured card label');
  assert.equal(merged.llama[0].connectionLabel, 'llama-server · :18131 · ctx 272K');
});

test('does not present stale configured or process aliases when the live model probe is unavailable', () => {
  const merged = mergeRunningLlamaProcess({
    llama: [{
      apiModel: 'stale-configured-id',
      servedModelName: 'stale-configured-id',
      modelPath: '/models/deepseek',
      port: 56827,
      status: 'running'
    }],
    vllm: []
  }, {
    port: 56827,
    alias: 'process-alias',
    modelPath: '/models/deepseek/model.gguf',
    context: 278528,
    label: 'DeepSeek'
  }, { status: 'loading', apiModel: null });

  assert.equal(merged.llama[0].apiModel, null);
  assert.equal(merged.llama[0].servedModelName, null);
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
