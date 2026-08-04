import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import test from 'node:test';

import { modelIdValue } from '../model-card-display.js';
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

test('identity-matched Studio runtime quarantines every stale shared-port sibling without attaching controls', () => {
  const liveModelId = 'unsloth/DeepSeek-V4-Flash-0731-GGUF';
  const selectedStudioCard = {
    key: 'studio-deepseek-v4-flash',
    name: 'DeepSeek V4 Flash 0731',
    displayName: 'DeepSeek V4 Flash 0731 — Unsloth Studio (full precision)',
    apiModel: 'stale-selected-id',
    servedModelName: 'stale-selected-id',
    modelPath: '/models/live',
    path: '/models/live',
    port: 36320,
    clientPort: 36320,
    backendPort: 36320,
    status: 'stopped',
    running: false,
    runtime: 'llama',
    source: 'model-inventory',
    quarantined: true,
    quarantineReason: 'verified-unsloth-studio-shared-client-port',
  };
  const staleSharedPortCard = {
    key: 'stale-shared-port-config',
    name: 'Stale shared-port config',
    displayName: 'Stale shared-port config',
    apiModel: 'stale/config-model',
    servedModelName: 'stale/config-model',
    modelPath: '/models/stale/model.gguf',
    path: '/models/stale/model.gguf',
    port: UNSLOTH_STUDIO_CLIENT_PORT,
    clientPort: UNSLOTH_STUDIO_CLIENT_PORT,
    backendPort: 36299,
    proxyPort: UNSLOTH_STUDIO_CLIENT_PORT,
    status: 'running',
    running: true,
    runtime: 'llama',
    source: 'custom-llama-config',
    config: '/etc/vllm/models/stale-shared-port.env',
    lifecycleOwner: 'unsloth-studio',
    exposureOwner: 'dgx-unsloth-guard',
  };
  const unrelatedManagedProfile = {
    profile_id: 'unrelated-managed-runtime',
    display_name: 'Unrelated managed runtime',
    model_path: '/models/stale/model.gguf',
    config_file: '/etc/vllm/models/stale-shared-port.env',
    api_model_id: 'unrelated/model',
    port: UNSLOTH_STUDIO_CLIENT_PORT,
    control_enabled: true,
    status: 'running',
  };

  const inventory = mergeRunningLlamaProcess({
    llama: [selectedStudioCard, staleSharedPortCard],
    vllm: [],
  }, {
    port: 36321,
    backendPort: 36321,
    alias: 'studio-live-runtime',
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

  const selected = inventory.llama.find(model =>
    model.source === 'model-inventory');
  assert.ok(selected);
  assert.equal(selected.apiModel, liveModelId);
  assert.equal(selected.servedModelName, liveModelId);
  assert.equal(modelIdValue(selected), liveModelId);
  assert.equal(
    selected.displayName,
    'DeepSeek V4 Flash 0731 — Unsloth Studio (full precision)',
  );
  assert.equal(selected.port, UNSLOTH_STUDIO_CLIENT_PORT);
  assert.equal(selected.clientPort, UNSLOTH_STUDIO_CLIENT_PORT);
  assert.equal(selected.backendPort, 36321);
  assert.equal(selected.inventoryOnly, true);
  assert.equal(selected.lifecycleOwner, 'unsloth-studio');
  assert.equal(selected.exposureOwner, 'dgx-unsloth-guard');
  assert.equal(selected.quarantined, false);
  assert.equal(selected.quarantineReason, null);

  const quarantinedSibling = inventory.llama.find(model =>
    model.source === 'custom-llama-config');
  assert.ok(quarantinedSibling);
  assert.equal(quarantinedSibling.inventoryOnly, true);
  assert.equal(quarantinedSibling.quarantined, true);
  assert.equal(
    quarantinedSibling.quarantineReason,
    'verified-unsloth-studio-shared-client-port',
  );
  assert.equal(quarantinedSibling.apiModel, null);
  assert.equal(quarantinedSibling.servedModelName, null);
  assert.equal(quarantinedSibling.running, false);
  assert.equal(quarantinedSibling.port, null);
  assert.equal(quarantinedSibling.clientPort, null);
  assert.equal(quarantinedSibling.backendPort, null);
  assert.equal(quarantinedSibling.proxyPort, null);
  assert.equal(quarantinedSibling.lifecycleOwner, null);
  assert.equal(quarantinedSibling.exposureOwner, null);

  assert.equal(
    inventory.llama.filter(model => model.apiModel === liveModelId).length,
    1,
  );
  for (const card of inventory.llama) {
    assert.equal(
      findModelControlProfile(
        card,
        card,
        card.clientPort || card.port,
        [unrelatedManagedProfile],
      ),
      null,
    );
  }
});

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
  assert.equal(quarantinedConfigCard.lifecycleOwner, null);
  assert.equal(quarantinedConfigCard.exposureOwner, null);
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
