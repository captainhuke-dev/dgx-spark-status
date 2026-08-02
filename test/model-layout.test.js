import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dashboardUi = readFileSync(new URL('../src/lib/SystemMetrics.svelte', import.meta.url), 'utf8');
const hermesUi = readFileSync(new URL('../src/lib/HermesSpotlight.svelte', import.meta.url), 'utf8');

test('uses equal desktop columns for LLAMA.cpp, vLLM, and ETC', () => {
  assert.match(
    dashboardUi,
    /\.models-row\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/
  );
});

test('preserves the Hermes desktop portrait dimensions', () => {
  assert.match(hermesUi, /\.portrait-shell\s*\{[\s\S]*?width:\s*104px;[\s\S]*?height:\s*116px;/);
});
