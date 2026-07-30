import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const runtimeConfig = readFileSync('/etc/vllm/models/deepseek-v4-flash-in240k-out32k.env', 'utf8');
const controlConfig = readFileSync('/etc/dgx-model-control/models.d/deepseek-v4-flash-in240k-out32k.env', 'utf8');
const dashboardProfile = readFileSync('/home/mctdgx01/models/deepseek-v4-flash-ds4-clean-v0.4.2/dashboard/profile.env', 'utf8');
const dashboardServer = readFileSync(new URL('../dev-server.js', import.meta.url), 'utf8');
const dashboardUi = readFileSync(new URL('../src/lib/SystemMetrics.svelte', import.meta.url), 'utf8');
const deepseekStartScript = readFileSync('/home/mctdgx01/bin/start_deepseek_v4_flash_ds4_best_245k.sh', 'utf8');
const deepseekStopScript = readFileSync('/home/mctdgx01/bin/stop_deepseek_v4_flash_ds4_best_245k.sh', 'utf8');

test('DS4 Dashboard card reports the deployed 245K input and 32K output budget', () => {
  assert.match(runtimeConfig, /^DISPLAY_NAME="DeepSeek V4 Flash DS4 — 245K \/ 32K — no-MTP"$/m);
  assert.match(runtimeConfig, /^CONTEXT_LENGTH=278528$/m);
  assert.match(runtimeConfig, /^MAX_INPUT_TOKENS=245760$/m);
  assert.match(runtimeConfig, /^MAX_NEW_TOKENS=32768$/m);
});

test('DS4 Dashboard control owns an exact full-stack stop command and component manifest', () => {
  assert.match(controlConfig, /^CONTROL_ENABLED=true$/m);
  assert.match(controlConfig, /^STOP_CMD=\/home\/mctdgx01\/bin\/stop_deepseek_v4_flash_ds4_best_245k\.sh$/m);
  assert.match(controlConfig, /^MANAGED_RUNTIME_DIR=\/home\/mctdgx01\/models\/deepseek-v4-flash-ds4-clean-v0\.4\.2\/dashboard\/runtime$/m);
  assert.match(controlConfig, /^MANAGED_COMPONENTS="server request-guard memory-guard weight-server"$/m);
});

test('Dashboard exposes the confirmed stop-all control in the Memory card', () => {
  assert.match(dashboardServer, /app\.post\('\/api\/model-control\/stop-all'/);
  assert.match(dashboardUi, /window\.confirm\('Stop all Dashboard-managed models that are currently running\?'\)/);
  assert.match(dashboardUi, /'Kill All Models'/);
});

test('DeepSeek exact stop preserves PID evidence unless every component is dead', () => {
  assert.doesNotMatch(deepseekStopScript, /--stop-exact-pgid[\s\S]{0,200}\|\| true/);
  assert.match(deepseekStopScript, /for name in server request-guard memory-guard weight-server/);
  assert.match(deepseekStopScript, /component remains alive/);
});

test('DeepSeek uses a strict one-GiB floor and clears only proven stale weight-server evidence', () => {
  assert.match(dashboardProfile, /^RAMGUARD_HARD_FLOOR_BYTES=1073741824$/m);
  assert.match(dashboardProfile, /^RAMGUARD_BREACH_CONDITION="MemAvailable < 1073741824"$/m);
  assert.match(controlConfig, /^MIN_AVAILABLE_RAM_GB=1$/m);
  assert.match(runtimeConfig, /^RAMGUARD_HARD_FLOOR_BYTES=1073741824$/m);
  assert.match(runtimeConfig, /^MIN_AVAILABLE_RAM_GB=1$/m);
  assert.match(deepseekStartScript, /stale weight-server evidence cleared/);
  assert.match(deepseekStartScript, /kill -0 "\$weight_pid"/);
});
