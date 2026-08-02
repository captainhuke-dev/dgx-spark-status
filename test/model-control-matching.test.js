import assert from 'node:assert/strict';
import test from 'node:test';

let findModelControlProfile = null;
try {
  ({ findModelControlProfile } = await import('../model-control-matching.js'));
} catch {}

const alphaProfile = {
  profile_id: 'deepseek-v4-flash-0731-alpha1-v052',
  display_name: 'DeepSeek V4 Flash 0731 Alpha-1',
  port: 18182,
  api_model_id: 'deepseek-v4-flash',
  served_model_name: 'deepseek-v4-flash',
  control_enabled: true,
  status: 'running'
};

const oldProfile = {
  profile_id: 'deepseek-v4-flash-in240k-out32k',
  display_name: 'DeepSeek V4 Flash DS4 — 245K / 32K — no-MTP',
  port: 18082,
  api_model_id: 'deepseek-v4-flash',
  served_model_name: 'deepseek-v4-flash',
  control_enabled: true,
  status: 'stopped'
};

test('same API alias does not make the stopped old card inherit Alpha-1 active state', () => {
  assert.equal(typeof findModelControlProfile, 'function');

  const oldCard = {
    key: oldProfile.display_name,
    name: oldProfile.display_name,
    displayName: oldProfile.display_name,
    port: 18081,
    apiModel: 'deepseek-v4-flash'
  };

  const matched = findModelControlProfile(oldCard, oldCard, oldCard.port, [alphaProfile, oldProfile]);
  assert.equal(matched?.profile_id, oldProfile.profile_id);
  assert.equal(matched?.status, 'stopped');
});

test('Alpha-1 card still resolves to its running control profile by its own port', () => {
  assert.equal(typeof findModelControlProfile, 'function');

  const alphaCard = {
    key: alphaProfile.display_name,
    name: alphaProfile.display_name,
    displayName: alphaProfile.display_name,
    port: alphaProfile.port,
    apiModel: 'deepseek-v4-flash'
  };

  const matched = findModelControlProfile(alphaCard, alphaCard, alphaCard.port, [alphaProfile, oldProfile]);
  assert.equal(matched?.profile_id, alphaProfile.profile_id);
  assert.equal(matched?.status, 'running');
});
