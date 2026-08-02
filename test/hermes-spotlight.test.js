import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compile } from 'svelte/compiler';

const componentPath = fileURLToPath(new URL('../src/lib/HermesSpotlight.svelte', import.meta.url));
const dashboardPath = fileURLToPath(new URL('../src/lib/SystemMetrics.svelte', import.meta.url));

test('Hermes Spotlight compiles with fixed safe controls and accessible branding', () => {
  assert.equal(existsSync(componentPath), true, 'HermesSpotlight.svelte must exist');
  const source = readFileSync(componentPath, 'utf8');

  assert.doesNotThrow(() => compile(source, { generate: false, filename: componentPath }));
  assert.match(source, /fetch\('\/api\/hermes\/status'/);
  assert.match(source, /fetch\(`\/api\/hermes\/\$\{action\}`/);
  assert.match(source, /confirm\(/);
  assert.match(source, /src="\/api\/hermes\/logo"/);
  assert.match(source, /alt="Hermes girl logo"/);
  assert.match(source, />Start</);
  assert.match(source, />Stop</);
  assert.match(source, /Open Hermes Local/);
  assert.match(source, /Open Hermes Tailscale/);
  assert.doesNotMatch(source, /Open Tail IP/);
  assert.match(source, /hermes\?\.localUrl \|\| 'http:\/\/192\.168\.0\.21:9119'/);
  assert.match(source, /hermes\?\.url \|\| 'http:\/\/100\.108\.68\.20:9119'/);
  assert.match(source, /192\.168\.0\.21:9119 · 100\.108\.68\.20:9119/);
  assert.match(source, /function stackIsActive\(\)/);
  assert.match(source, /hermes\.dashboard\?\.active \|\| hermes\.proxy\?\.active/);
  assert.match(source, /function toggleHermes\(\)/);
  assert.match(source, /runAction\(stackIsActive\(\) \? 'stop' : 'start'\)/);
  assert.match(source, /class="open-stack"/);
  assert.match(source, /\.open-stack\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(source, /\.action-button\.open\.local\s*\{[^}]*linear-gradient[^}]*#76b900/s);
  assert.match(source, /\.action-button\.open\.tail\s*\{[^}]*linear-gradient[^}]*#356dff/s);
  assert.match(source, /\.portrait-shell\s*\{[^}]*width:\s*104px;[^}]*height:\s*116px;/s);
  assert.match(source, /@media \(max-width: 1200px\)[\s\S]*?\.portrait-shell\s*\{\s*width:\s*78px;\s*height:\s*88px;/);
  assert.match(source, /@media \(max-width: 480px\)[\s\S]*?\.portrait-shell\s*\{\s*width:\s*58px;\s*height:\s*68px;/);
  assert.match(source, /aria-live="polite"/);

  const dashboardSource = readFileSync(dashboardPath, 'utf8');
  assert.match(dashboardSource, /<h2>ETC<\/h2>/);
  assert.doesNotMatch(dashboardSource, /<h2>ETC \{#if metrics\.inference\.ollama\.available\}/);
  assert.match(dashboardSource, /\.models-row\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(dashboardSource, /@media \(max-width: 1200px\)[\s\S]*?\.models-row \{ grid-template-columns: repeat\(2, 1fr\); \}/);
  assert.match(dashboardSource, /@media \(max-width: 768px\)[\s\S]*?\.models-row \{ grid-template-columns: 1fr; \}/);
});
