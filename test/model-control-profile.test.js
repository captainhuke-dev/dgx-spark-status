import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const profileId = 'laguna-s21-dflash-vllm25-256k-seq3';
const profilePath = `/etc/dgx-model-control/models.d/${profileId}.env`;

test('Laguna DFlash is an explicitly managed dashboard profile', () => {
  const profile = readFileSync(profilePath, 'utf8');
  assert.match(profile, new RegExp(`^PROFILE_ID=${profileId}$`, 'm'));
  assert.match(profile, /^PORT=8542$/m);
  assert.match(profile, /^TMUX_SESSION=laguna-s21-dflash-vllm25-8542$/m);
  assert.match(profile, /^CONTROL_ENABLED=true$/m);
  assert.match(profile, /^START_CMD=\/home\/mctdgx01\/models\/operation_records\/laguna_s21_dflash15_uma_20260726_020944\/runtime\/run_laguna_dflash\.sh$/m);
});

test('modelctl resolves Laguna before the auto-discovered duplicate port', () => {
  const listing = JSON.parse(execFileSync('/opt/dgx-model-control/modelctl', ['list'], { encoding: 'utf8' }));
  const matches = listing.profiles.filter((profile) => profile.port === 8542);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].profile_id, profileId);
  assert.equal(matches[0].control_enabled, true);
});
