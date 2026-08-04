import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectLiveModelFromProbe,
  selectPreferredLlamaRuntime,
} from '../llama-runtime-selection.js';

test('requires exactly one distinct live ID for Studio probes while preserving non-Studio first-model behavior', () => {
  const payload = {
    data: [
      { id: 'unsloth/Studio-Alpha', root: '/models/alpha' },
      { id: 'unsloth/Studio-Beta', root: '/models/beta' },
    ],
  };

  assert.equal(selectLiveModelFromProbe(payload)?.id, 'unsloth/Studio-Alpha');
  assert.equal(
    selectLiveModelFromProbe(payload, { requireSingleDistinctId: true }),
    null,
  );
  assert.equal(
    selectLiveModelFromProbe(
      { data: [{ id: 'unsloth/Studio-Alpha' }, { id: 'unsloth/Studio-Alpha' }] },
      { requireSingleDistinctId: true },
    )?.id,
    'unsloth/Studio-Alpha',
  );
});

test('does not select the first Studio backend when multiple eligible candidates exist', () => {
  const candidates = [
    {
      source: 'process',
      isUnslothStudio: true,
      healthy: true,
      liveApiModelId: 'unsloth/Studio-Alpha',
      backendPort: 36321,
      clientPort: 56827,
    },
    {
      source: 'process',
      isUnslothStudio: true,
      healthy: true,
      liveApiModelId: 'unsloth/Studio-Alpha',
      backendPort: 36322,
      clientPort: 56827,
    },
  ];

  assert.equal(
    selectPreferredLlamaRuntime({ liveProcessCandidates: candidates }),
    null,
  );
});

test('does not fall back to stale Studio configuration when its live identity is unavailable', () => {
  const configuredCandidate = {
    source: 'configured',
    isUnslothStudio: true,
    healthy: false,
    liveApiModelId: '',
    apiModel: 'stale-configured-id',
    clientPort: 56827,
  };

  assert.equal(
    selectPreferredLlamaRuntime({ configuredCandidates: [configuredCandidate] }),
    null,
  );
});

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

test('keeps the selected live process candidate when its backend and client ports differ', () => {
  const configuredCandidate = {
    source: 'configured',
    healthy: true,
    liveApiModelId: '',
    apiModel: 'stale-configured-id',
    port: 56827,
    clientPort: 56827
  };
  const liveProcessCandidate = {
    source: 'process',
    healthy: true,
    liveApiModelId: 'unsloth/DeepSeek-V4-Flash-0731-GGUF',
    apiModel: 'unsloth/DeepSeek-V4-Flash-0731-GGUF',
    port: 36321,
    backendPort: 36321,
    clientPort: 56827
  };

  const selected = selectPreferredLlamaRuntime({
    configuredCandidates: [configuredCandidate],
    liveProcessCandidates: [liveProcessCandidate]
  });

  assert.equal(selected, liveProcessCandidate);
  assert.equal(selected.backendPort, 36321);
  assert.equal(selected.clientPort, 56827);
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
