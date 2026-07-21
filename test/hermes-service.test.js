import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

import * as hermesModule from '../hermes-service.js';
import {
  HERMES_RUNTIME,
  createHermesServiceController,
  hermesErrorPayload,
  hermesErrorStatus,
} from '../hermes-service.js';

function serviceShow(activeState = 'active', unitFileState = 'enabled') {
  return `ActiveState=${activeState}\nUnitFileState=${unitFileState}\n`;
}

function createExecFile({ dashboardState = 'active', proxyState = 'active', calls = [] } = {}) {
  return async (file, args, options) => {
    calls.push([file, ...args]);
    assert.equal(options.env.XDG_RUNTIME_DIR, '/run/user/1000');
    assert.equal(options.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');

    if (args[1] === 'show') {
      const unit = args[2];
      return {
        stdout: serviceShow(unit === HERMES_RUNTIME.dashboardUnit ? dashboardState : proxyState),
        stderr: '',
      };
    }

    return { stdout: '', stderr: '' };
  };
}

function okFetch() {
  return Promise.resolve({ ok: true, status: 200 });
}

test('status reports online only when both services and health are ready', async () => {
  const requestedUrls = [];
  const controller = createHermesServiceController({
    execFile: createExecFile(),
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return { ok: true, status: 200 };
    },
  });

  const result = await controller.status();

  assert.equal(result.ok, true);
  assert.equal(result.state, 'online');
  assert.equal(result.ready, true);
  assert.equal(result.url, 'http://100.108.68.20:9119');
  assert.equal(result.localUrl, 'http://192.168.0.21:9119');
  assert.deepEqual(requestedUrls, ['http://127.0.0.1:9119/api/status']);
  assert.equal(result.health.endpoint, 'http://127.0.0.1:9119/api/status');
  assert.equal(result.dashboard.active, true);
  assert.equal(result.proxy.active, true);
  assert.equal(result.health.ok, true);
});

test('status reports offline when both services are inactive', async () => {
  const controller = createHermesServiceController({
    execFile: createExecFile({ dashboardState: 'inactive', proxyState: 'inactive' }),
    fetchImpl: async () => {
      throw new Error('connection refused');
    },
  });

  const result = await controller.status();

  assert.equal(result.state, 'offline');
  assert.equal(result.ready, false);
  assert.equal(result.health.ok, false);
});

test('status reports degraded when only part of the stack is ready', async () => {
  const controller = createHermesServiceController({
    execFile: createExecFile({ proxyState: 'inactive' }),
    fetchImpl: okFetch,
  });

  const result = await controller.status();

  assert.equal(result.state, 'degraded');
  assert.equal(result.ready, false);
});

test('start orders dashboard before proxy', async () => {
  const calls = [];
  const controller = createHermesServiceController({
    execFile: createExecFile({ calls }),
    fetchImpl: okFetch,
    sleep: async () => {},
  });

  await controller.start();

  assert.deepEqual(calls.filter((call) => call[2] === 'start'), [
    ['systemctl', '--user', 'start', 'hermes-dashboard.service'],
    ['systemctl', '--user', 'start', 'hermes-tail-proxy.service'],
  ]);
});

test('start allows the Hermes web build to exceed the original eight-second window', async () => {
  let healthProbes = 0;
  const controller = createHermesServiceController({
    execFile: createExecFile(),
    fetchImpl: async () => {
      healthProbes += 1;
      return { ok: healthProbes > 16, status: healthProbes > 16 ? 200 : 503 };
    },
    sleep: async () => {},
  });

  const result = await controller.start();

  assert.equal(result.ready, true);
  assert.equal(healthProbes, 17);
});

test('stop orders proxy before dashboard', async () => {
  const calls = [];
  let stopped = false;
  const execFile = async (file, args, options) => {
    calls.push([file, ...args]);
    assert.equal(options.env.XDG_RUNTIME_DIR, '/run/user/1000');
    if (args[1] === 'stop') stopped = true;
    if (args[1] === 'show') {
      return { stdout: serviceShow(stopped ? 'inactive' : 'active'), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const controller = createHermesServiceController({ execFile, fetchImpl: okFetch, sleep: async () => {} });

  await controller.stop();

  assert.deepEqual(calls.filter((call) => call[2] === 'stop'), [
    ['systemctl', '--user', 'stop', 'hermes-tail-proxy.service'],
    ['systemctl', '--user', 'stop', 'hermes-dashboard.service'],
  ]);
});

test('rejects a second action while an action is active', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let blocked = false;
  const execFile = async (file, args) => {
    if (!blocked && args[1] === 'start') {
      blocked = true;
      await gate;
    }
    if (args[1] === 'show') return { stdout: serviceShow(), stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const controller = createHermesServiceController({ execFile, fetchImpl: okFetch, sleep: async () => {} });

  const first = controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(controller.stop(), (error) => error.code === 'busy');
  release();
  await first;
});

test('systemd calls never accept a caller-selected service name', async () => {
  const calls = [];
  const controller = createHermesServiceController({
    execFile: createExecFile({ calls }),
    fetchImpl: okFetch,
    sleep: async () => {},
  });

  await controller.start('malicious.service');

  const controlledUnits = calls
    .filter((call) => ['start', 'stop', 'show'].includes(call[2]))
    .map((call) => call[3]);
  assert.ok(controlledUnits.length > 0);
  assert.ok(controlledUnits.every((unit) => [
    HERMES_RUNTIME.dashboardUnit,
    HERMES_RUNTIME.proxyUnit,
  ].includes(unit)));
});

test('API error helpers map busy and operation failures without leaking details', () => {
  const busy = Object.assign(new Error('another action is already running'), { code: 'busy' });
  const failed = Object.assign(new Error('systemctl stderr secret'), { code: 'operation_failed' });

  assert.equal(hermesErrorStatus(busy), 409);
  assert.equal(hermesErrorStatus(failed), 503);
  assert.deepEqual(hermesErrorPayload(busy), {
    ok: false,
    code: 'busy',
    message: 'Hermes is already processing another action.',
  });
  assert.deepEqual(hermesErrorPayload(failed), {
    ok: false,
    code: 'operation_failed',
    message: 'Hermes could not complete the requested action.',
  });
});

test('logo handler serves the approved image from the hidden Hermes directory', async (t) => {
  assert.equal(typeof hermesModule.sendHermesLogo, 'function', 'sendHermesLogo handler must exist');
  const app = express();
  app.get('/logo', hermesModule.sendHermesLogo);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/logo`);
  const bytes = new Uint8Array(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
