import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const runtimeConfig = readFileSync('/etc/vllm/models/deepseek-v4-flash-in240k-out32k.env', 'utf8');
const controlConfig = readFileSync('/etc/dgx-model-control/models.d/deepseek-v4-flash-in240k-out32k.env', 'utf8');

test('DS4 Dashboard card uses compact title and budget metadata', () => {
  assert.match(runtimeConfig, /^DISPLAY_NAME="DeepSeek V4 Flash DS4"$/m);
  assert.match(runtimeConfig, /^CONTEXT_LENGTH=278528$/m);
  assert.match(runtimeConfig, /^MAX_INPUT_TOKENS=245760$/m);
  assert.match(runtimeConfig, /^MAX_NEW_TOKENS=32768$/m);
});

test('DS4 Dashboard control owns an exact stop command', () => {
  assert.match(controlConfig, /^CONTROL_ENABLED=true$/m);
  assert.match(controlConfig, /^STOP_CMD=\/home\/mctdgx01\/models\/deepseek-v4-flash-entrpi-ds4-v0\.4\.2\/bin\/stop_deepseek_v4_flash_ds4_in240k_out32k\.sh$/m);
});
