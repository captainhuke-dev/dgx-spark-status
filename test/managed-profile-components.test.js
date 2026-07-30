import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let classifyManagedStatus = () => ({
  status: 'stopped',
  running: false,
  active: false,
  degraded: false,
  active_components: [],
  inactive_components: []
});
let isActiveControlStatus = () => false;
let modelControlStatusLabel = status => status;
let resolveModelDisplayStatus = (controlStatus, ...candidates) => candidates[0] || controlStatus;

try {
  ({ classifyManagedStatus, isActiveControlStatus, modelControlStatusLabel, resolveModelDisplayStatus } = await import('../model-control-state.js'));
} catch {}

let readManagedProfileComponents = () => [];
try {
  ({ readManagedProfileComponents } = await import('../managed-profile-components.js'));
} catch {}

const component = (name, active) => ({ name, active });

function currentPgid() {
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[2]);
}

function managedFixture() {
  const root = mkdtempSync(join(tmpdir(), 'managed-profile-'));
  const profileDir = join(root, 'profiles');
  const runtimeDir = join(root, 'runtime');
  mkdirSync(profileDir);
  mkdirSync(runtimeDir);
  writeFileSync(join(profileDir, 'deepseek.env'), [
    `MANAGED_RUNTIME_DIR=${runtimeDir}`,
    'MANAGED_COMPONENTS="server request-guard memory-guard weight-server"',
    ''
  ].join('\n'));
  return { root, profileDir, runtimeDir };
}

test('classifies a lone GPU-resident weight server as degraded and active', () => {
  const result = classifyManagedStatus('stopped', [
    component('server', false),
    component('request-guard', false),
    component('memory-guard', false),
    component('weight-server', true)
  ]);

  assert.deepEqual(result, {
    status: 'degraded_resident',
    running: false,
    active: true,
    degraded: true,
    active_components: ['weight-server'],
    inactive_components: ['server', 'request-guard', 'memory-guard']
  });
});

test('maps degraded residency to an active Stop state without claiming readiness', () => {
  assert.equal(isActiveControlStatus('degraded_resident'), true);
  assert.equal(modelControlStatusLabel('degraded_resident'), 'Weights Resident · API Offline');
});

test('active control truth wins stale inventory while stopped control does not hide a live runtime', () => {
  assert.equal(resolveModelDisplayStatus('running', 'stopped'), 'running');
  assert.equal(resolveModelDisplayStatus('degraded_resident', 'stopped'), 'degraded_resident');
  assert.equal(resolveModelDisplayStatus('stopped', 'running'), 'running');
});

test('classifies a complete managed component set without API health as loading', () => {
  const result = classifyManagedStatus('stopped', [
    component('server', true),
    component('request-guard', true),
    component('memory-guard', true),
    component('weight-server', true)
  ]);

  assert.equal(result.status, 'loading');
  assert.equal(result.active, true);
  assert.equal(result.degraded, false);
  assert.equal(result.running, false);
});

test('preserves running when API health already passed', () => {
  const result = classifyManagedStatus('running', [
    component('server', true),
    component('request-guard', true),
    component('memory-guard', true),
    component('weight-server', true)
  ]);

  assert.equal(result.status, 'running');
  assert.equal(result.running, true);
  assert.equal(result.active, true);
});

test('does not claim ready when health passes but a managed component is missing', () => {
  const result = classifyManagedStatus('running', [
    component('server', true),
    component('request-guard', true),
    component('memory-guard', false),
    component('weight-server', true)
  ]);

  assert.equal(result.status, 'degraded_resident');
  assert.equal(result.running, false);
  assert.equal(result.active, true);
  assert.equal(result.degraded, true);
});

test('preserves ordinary profile state when no managed components are declared', () => {
  const result = classifyManagedStatus('stopped', []);

  assert.deepEqual(result, {
    status: 'stopped',
    running: false,
    active: false,
    degraded: false,
    active_components: [],
    inactive_components: []
  });
});

test('reads only exact PID and PGID matches as active managed components', () => {
  const fixture = managedFixture();
  try {
    writeFileSync(join(fixture.runtimeDir, 'weight-server.pid'), `${process.pid}\n`);
    writeFileSync(join(fixture.runtimeDir, 'weight-server.pgid'), `${currentPgid()}\n`);

    const components = readManagedProfileComponents(
      { profile_id: 'deepseek', status: 'stopped' },
      { profileDir: fixture.profileDir }
    );

    assert.deepEqual(
      components.map(({ name, active }) => ({ name, active })),
      [
        component('server', false),
        component('request-guard', false),
        component('memory-guard', false),
        component('weight-server', true)
      ]
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a live PID when its recorded PGID does not match', () => {
  const fixture = managedFixture();
  try {
    writeFileSync(join(fixture.runtimeDir, 'weight-server.pid'), `${process.pid}\n`);
    writeFileSync(join(fixture.runtimeDir, 'weight-server.pgid'), `${currentPgid() + 1}\n`);

    const components = readManagedProfileComponents(
      { profile_id: 'deepseek', status: 'stopped' },
      { profileDir: fixture.profileDir }
    );

    assert.equal(components.find(component => component.name === 'weight-server')?.active, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('returns no managed components for an ordinary profile', () => {
  const fixture = managedFixture();
  try {
    const components = readManagedProfileComponents(
      { profile_id: 'ordinary-model', status: 'stopped' },
      { profileDir: fixture.profileDir }
    );

    assert.deepEqual(components, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
