import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import test from 'node:test';

import { findModelControlProfile } from '../model-control-matching.js';
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

test('unmatched Studio runtime quarantines a stale shared-port config card without attaching its managed profile', () => {
  const liveModelId = 'unsloth/Live-Studio-Model-GGUF';
  const staleConfigCard = {
    key: 'stale-config-card',
    name: 'Stale configured model',
    displayName: 'Stale configured model',
    apiModel: liveModelId,
    servedModelName: liveModelId,
    modelPath: '/models/stale/model.gguf',
    path: '/models/stale/model.gguf',
    port: UNSLOTH_STUDIO_CLIENT_PORT,
    clientPort: UNSLOTH_STUDIO_CLIENT_PORT,
    backendPort: UNSLOTH_STUDIO_CLIENT_PORT,
    status: 'running',
    running: true,
    runtime: 'llama',
    source: 'custom-llama-config',
    config: '/etc/vllm/models/stale-config.env',
  };
  const unrelatedManagedProfile = {
    profile_id: 'unrelated-managed-runtime',
    display_name: 'Unrelated managed runtime',
    model_path: '/models/unrelated/model.gguf',
    api_model_id: 'unrelated-model',
    port: UNSLOTH_STUDIO_CLIENT_PORT,
    control_enabled: true,
    status: 'running',
  };

  const inventory = mergeRunningLlamaProcess({
    llama: [staleConfigCard],
    vllm: [],
  }, {
    port: 36321,
    backendPort: 36321,
    alias: 'studio-runtime-alias-that-does-not-match-config',
    modelPath: '/models/live/model.gguf',
    context: 278528,
    label: 'Live Studio process',
    executable: installedStudioExecutable(),
    studioLauncherAncestryVerified: true,
  }, {
    status: 'running',
    apiModel: liveModelId,
    studioRuntimeResolved: true,
  });

  assert.equal(inventory.llama.length, 2);

  const quarantinedConfigCard = inventory.llama.find(model =>
    model.source === 'custom-llama-config');
  assert.ok(quarantinedConfigCard);
  assert.equal(quarantinedConfigCard.inventoryOnly, true);
  assert.equal(quarantinedConfigCard.quarantined, true);
  assert.equal(
    quarantinedConfigCard.quarantineReason,
    'verified-unsloth-studio-shared-client-port',
  );
  assert.equal(quarantinedConfigCard.lifecycleOwner, undefined);
  assert.equal(quarantinedConfigCard.apiModel, null);
  assert.equal(quarantinedConfigCard.servedModelName, null);
  assert.equal(quarantinedConfigCard.running, false);
  assert.equal(quarantinedConfigCard.port, null);
  assert.equal(quarantinedConfigCard.clientPort, null);
  assert.equal(quarantinedConfigCard.backendPort, null);

  const liveStudioCard = inventory.llama.find(model =>
    model.source === 'llama-process');
  assert.ok(liveStudioCard);
  assert.equal(liveStudioCard.name, 'Live Studio process');
  assert.equal(liveStudioCard.modelPath, '/models/live/model.gguf');
  assert.equal(liveStudioCard.apiModel, liveModelId);
  assert.equal(liveStudioCard.clientPort, UNSLOTH_STUDIO_CLIENT_PORT);
  assert.equal(liveStudioCard.backendPort, 36321);
  assert.equal(liveStudioCard.inventoryOnly, true);

  for (const card of inventory.llama) {
    const control = findModelControlProfile(
      card,
      card,
      card.clientPort || card.port,
      [unrelatedManagedProfile],
    );
    assert.equal(control, null);
  }
});
