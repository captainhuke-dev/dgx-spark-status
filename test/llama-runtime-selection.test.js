import assert from 'node:assert/strict';
import test from 'node:test';

import { selectPreferredLlamaRuntime } from '../llama-runtime-selection.js';

test('selects a healthy live process with a live API model ID over stale configured metadata', () => {
  const configuredCandidate = {
    source: 'configured',
    healthy: true,
    liveApiModelId: '',
    apiModel: 'stale-configured-id',
    port: 18132
  };
  const liveProcessCandidate = {
    source: 'process',
    healthy: true,
    liveApiModelId: 'unsloth/DeepSeek-V4-Flash-0731-GGUF',
    apiModel: 'unsloth/DeepSeek-V4-Flash-0731-GGUF',
    port: 56827
  };

  assert.equal(
    selectPreferredLlamaRuntime({
      configuredCandidates: [configuredCandidate],
      liveProcessCandidates: [liveProcessCandidate]
    }),
    liveProcessCandidate
  );
});

test('selects a healthy configured candidate with a live API model ID when no live process qualifies', () => {
  const configuredCandidate = {
    source: 'configured',
    healthy: true,
    liveApiModelId: 'unsloth/DeepSeek-V4-Flash-0731-GGUF',
    apiModel: 'stale-configured-id',
    port: 18132
  };
  const liveProcessCandidate = {
    source: 'process',
    healthy: false,
    liveApiModelId: 'unsloth/DeepSeek-V4-Flash-0731-GGUF',
    apiModel: 'unsloth/DeepSeek-V4-Flash-0731-GGUF',
    port: 56827
  };

  assert.equal(
    selectPreferredLlamaRuntime({
      configuredCandidates: [configuredCandidate],
      liveProcessCandidates: [liveProcessCandidate]
    }),
    configuredCandidate
  );
});

test('falls back to the first configured candidate when no healthy live API model ID is available', () => {
  const configuredCandidate = {
    source: 'configured',
    healthy: false,
    liveApiModelId: '',
    apiModel: 'stale-configured-id',
    port: 18132
  };
  const liveProcessCandidate = {
    source: 'process',
    healthy: true,
    liveApiModelId: '',
    apiModel: '',
    port: 56827
  };

  assert.equal(
    selectPreferredLlamaRuntime({
      configuredCandidates: [configuredCandidate],
      liveProcessCandidates: [liveProcessCandidate]
    }),
    configuredCandidate
  );
});

test('returns null when there are no configured or live process candidates', () => {
  assert.equal(
    selectPreferredLlamaRuntime({
      configuredCandidates: [],
      liveProcessCandidates: []
    }),
    null
  );
});
