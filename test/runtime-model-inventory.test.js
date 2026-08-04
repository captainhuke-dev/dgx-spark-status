import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import test from 'node:test';

import {
  UNSLOTH_STUDIO_CLIENT_PORT,
  UNSLOTH_STUDIO_LLAMA_SERVER,
  mergeRunningLlamaProcess,
} from '../runtime-model-inventory.js';

function installedStudioExecutable() {
  try {
    return realpathSync(UNSLOTH_STUDIO_LLAMA_SERVER);
  } catch {
    return UNSLOTH_STUDIO_LLAMA_SERVER;
  }
}

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
  assert.equal(merged.llama[0].proxyPort, undefined);
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
    port: 36321,
    alias: 'deepseek0731-flash',
    modelPath: '/home/mctdgx01/models/unsloth-DeepSeek-V4-Flash-0731-GGUF-IQ3-XXS/UD-IQ3_XXS/DeepSeek-V4-Flash-0731-UD-IQ3_XXS-00001-of-00004.gguf',
    context: 278528,
    label: 'DeepSeek V4 Flash 0731 Unsloth UD-IQ3_XXS',
    executable: installedStudioExecutable(),
    studioLauncherAncestryVerified: true,
    command: '/home/mctdgx01/apps/unsloth-studio/llama.cpp/llama-server --port 36321'
  }, { status: 'running', apiModel: 'unsloth/DeepSeek-V4-Flash-0731-GGUF' });

  assert.equal(merged.llama.length, 1);
  assert.equal(merged.llama[0].port, UNSLOTH_STUDIO_CLIENT_PORT);
  assert.equal(merged.llama[0].clientPort, UNSLOTH_STUDIO_CLIENT_PORT);
  assert.equal(merged.llama[0].backendPort, 36321);
  assert.equal(merged.llama[0].proxyPort, UNSLOTH_STUDIO_CLIENT_PORT);
  assert.equal(merged.llama[0].apiModel, 'unsloth/DeepSeek-V4-Flash-0731-GGUF');
  assert.equal(merged.llama[0].displayName, 'DeepSeek V4 Flash 0731 Unsloth UD-IQ3_XXS');
  assert.equal(merged.llama[0].functionLabel, 'Configured card label');
  assert.equal(merged.llama[0].connectionLabel, 'llama-server · :56827 · ctx 272K');
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

test('creates a Studio inventory item with separate backend and client ports plus the exact live API model ID', () => {
  const merged = mergeRunningLlamaProcess({
    llama: [],
    vllm: []
  }, {
    port: 36321,
    alias: 'unsloth/DeepSeek-V4-Flash-0731-GGUF',
    modelPath: '/models/deepseek/model.gguf',
    context: 278528,
    label: 'DeepSeek V4 Flash 0731',
    executable: installedStudioExecutable(),
    studioLauncherAncestryVerified: true,
    command: '/home/mctdgx01/apps/unsloth-studio/llama.cpp/llama-server --port 36321'
  }, { status: 'running', apiModel: 'unsloth/DeepSeek-V4-Flash-0731-GGUF' });

  assert.equal(merged.llama.length, 1);
  assert.equal(merged.llama[0].port, UNSLOTH_STUDIO_CLIENT_PORT);
  assert.equal(merged.llama[0].clientPort, UNSLOTH_STUDIO_CLIENT_PORT);
  assert.equal(merged.llama[0].backendPort, 36321);
  assert.equal(merged.llama[0].apiModel, 'unsloth/DeepSeek-V4-Flash-0731-GGUF');
  assert.equal(merged.llama[0].servedModelName, 'unsloth/DeepSeek-V4-Flash-0731-GGUF');
  assert.equal(merged.llama[0].connectionLabel, 'llama-server · :56827 · ctx 272K');
  assert.equal(merged.llama[0].inventoryOnly, true);
  assert.equal(merged.llama[0].lifecycleOwner, 'unsloth-studio');
  assert.equal(merged.llama[0].exposureOwner, 'dgx-unsloth-guard');
});

test('clears Studio API, running, backend, and client fields when runtime identity is ambiguous', () => {
  const merged = mergeRunningLlamaProcess({
    llama: [{
      apiModel: 'stale-configured-id',
      servedModelName: 'stale-configured-id',
      modelPath: '/models/deepseek',
      port: UNSLOTH_STUDIO_CLIENT_PORT,
      clientPort: UNSLOTH_STUDIO_CLIENT_PORT,
      backendPort: 36320,
      status: 'running',
      running: true,
    }],
    vllm: [],
  }, {
    port: 36321,
    alias: 'process-alias',
    modelPath: '/models/deepseek/model.gguf',
    context: 278528,
    label: 'DeepSeek',
    executable: installedStudioExecutable(),
    studioLauncherAncestryVerified: true,
  }, {
    status: 'loading',
    apiModel: null,
    studioRuntimeResolved: false,
  });

  assert.equal(merged.llama[0].apiModel, null);
  assert.equal(merged.llama[0].servedModelName, null);
  assert.equal(merged.llama[0].running, false);
  assert.equal(merged.llama[0].port, null);
  assert.equal(merged.llama[0].clientPort, null);
  assert.equal(merged.llama[0].backendPort, null);
});

test('multiple configured Studio card matches cannot select the first card', () => {
  const merged = mergeRunningLlamaProcess({
    llama: [
      {
        name: 'Studio card alpha',
        apiModel: 'configured-alpha',
        servedModelName: 'configured-alpha',
        modelPath: '/models/shared-studio',
        port: UNSLOTH_STUDIO_CLIENT_PORT,
        clientPort: UNSLOTH_STUDIO_CLIENT_PORT,
        backendPort: 36320,
        proxyPort: UNSLOTH_STUDIO_CLIENT_PORT,
        status: 'stopped',
        running: false,
      },
      {
        name: 'Studio card beta',
        apiModel: 'configured-beta',
        servedModelName: 'configured-beta',
        modelPath: '/models/shared-studio',
        port: UNSLOTH_STUDIO_CLIENT_PORT,
        clientPort: UNSLOTH_STUDIO_CLIENT_PORT,
        backendPort: 36322,
        proxyPort: UNSLOTH_STUDIO_CLIENT_PORT,
        status: 'stopped',
        running: false,
      },
    ],
    vllm: [],
  }, {
    port: 36321,
    alias: 'unsloth/Studio-Live',
    modelPath: '/models/shared-studio/model.gguf',
    context: 278528,
    label: 'Studio Live',
    executable: installedStudioExecutable(),
    studioLauncherAncestryVerified: true,
  }, {
    status: 'running',
    apiModel: 'unsloth/Studio-Live',
    studioRuntimeResolved: true,
  });

  assert.equal(merged.llama.length, 2);
  for (const card of merged.llama) {
    assert.equal(card.apiModel, null);
    assert.equal(card.servedModelName, null);
    assert.equal(card.status, 'loading');
    assert.equal(card.running, false);
    assert.equal(card.port, null);
    assert.equal(card.clientPort, null);
    assert.equal(card.backendPort, null);
    assert.equal(card.proxyPort, null);
    assert.equal(card.inventoryOnly, true);
    assert.equal(card.quarantined, true);
    assert.equal(
      card.quarantineReason,
      'verified-unsloth-studio-shared-client-port',
    );
    assert.equal(card.lifecycleOwner, null);
    assert.equal(card.exposureOwner, null);
  }
});

test('does not expose ports for an unmatched Studio process with unavailable live identity', () => {
  const merged = mergeRunningLlamaProcess({ llama: [], vllm: [] }, {
    port: 36321,
    alias: 'process-alias',
    modelPath: '/models/deepseek/model.gguf',
    context: 278528,
    label: 'DeepSeek',
    executable: installedStudioExecutable(),
    studioLauncherAncestryVerified: true,
  }, {
    status: 'loading',
    apiModel: null,
    studioRuntimeResolved: false,
  });

  assert.equal(merged.llama[0].running, false);
  assert.equal(merged.llama[0].port, null);
  assert.equal(merged.llama[0].clientPort, null);
  assert.equal(merged.llama[0].backendPort, null);
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

test('keeps non-Studio llama processes on their observed port for both client and backend inventory', () => {
  const merged = mergeRunningLlamaProcess({
    llama: [],
    vllm: []
  }, {
    port: 18131,
    alias: 'deepseek0731-flash',
    modelPath: '/models/deepseek/file.gguf',
    context: 278528,
    label: 'deepseek0731-flash',
    command: '/opt/llama.cpp/llama-server --port 18131'
  }, { status: 'running', apiModel: 'deepseek0731-flash' });

  assert.equal(merged.llama[0].port, 18131);
  assert.equal(merged.llama[0].clientPort, 18131);
  assert.equal(merged.llama[0].backendPort, 18131);
  assert.equal(merged.llama[0].connectionLabel, 'llama-server · :18131 · ctx 272K');
});
