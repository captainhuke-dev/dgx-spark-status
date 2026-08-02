import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dashboardUi = readFileSync(new URL('../src/lib/SystemMetrics.svelte', import.meta.url), 'utf8');

test('CPU card exposes separate Claude and Codex stop controls', () => {
  const cpuStart = dashboardUi.indexOf('<!-- CPU -->');
  const gpuStart = dashboardUi.indexOf('<!-- GPU -->');
  assert.ok(cpuStart >= 0);
  assert.ok(gpuStart > cpuStart);
  const cpuCard = dashboardUi.slice(cpuStart, gpuStart);

  assert.match(cpuCard, /ปิด Claude/);
  assert.match(cpuCard, /ปิด Codex/);
  assert.match(dashboardUi, /process-control\/stop\/\$\{family\}/);
  assert.match(dashboardUi, /window\.confirm/);
  assert.match(dashboardUi, /agentProcessActions/);
});

test('CPU controls expose busy and inline result feedback', () => {
  assert.match(dashboardUi, /กำลังปิด/);
  assert.match(dashboardUi, /control-message/);
  assert.match(dashboardUi, /control-error/);
});

test('GPU card exposes unified CUDA allocation even when GB10 VRAM totals are N/A', () => {
  assert.match(dashboardUi, /CUDA allocation/);
  assert.match(dashboardUi, /computeMemoryUsedMB/);
  assert.match(dashboardUi, /unified memory/);
});
