import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dashboardServer = readFileSync(new URL('../dev-server.js', import.meta.url), 'utf8');

test('dashboard exposes separate Claude and Codex process stop routes', () => {
  assert.match(dashboardServer, /app\.post\('\/api\/process-control\/stop\/:family'/);
  assert.match(dashboardServer, /processController\.stopFamily\(family\)/);
});

test('process stop route validates the request and uses a separate action lock', () => {
  assert.match(dashboardServer, /validateStopRequest\(family, req\.body\)/);
  assert.match(dashboardServer, /processControlActionLock/);
  assert.match(dashboardServer, /res\.status\(result\.code === 'busy' \? 409/);
});
