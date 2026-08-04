import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import test from 'node:test';

import {
  UNSLOTH_STUDIO_CLIENT_PORT,
  UNSLOTH_STUDIO_ROOT,
  clientPortForLlamaProcess,
  isUnslothStudioProcess,
} from '../runtime-model-inventory.js';
import {
  parseRunningLlamaProcessLine,
  selectedLlamaPorts,
} from '../llama-process-inventory.js';
import {
  configuredLlamaCandidateMatchesProcess,
} from '../dev-server.js';

const STUDIO_LLAMA_SERVER = `${UNSLOTH_STUDIO_ROOT}/llama.cpp/llama-server`;

function installedStudioExecutable() {
  try {
    return realpathSync(STUDIO_LLAMA_SERVER);
  } catch {
    return STUDIO_LLAMA_SERVER;
  }
}

test('identifies only the exact installed Studio llama-server path as Unsloth Studio', () => {
  assert.equal(
    isUnslothStudioProcess({
      executable: installedStudioExecutable(),
      command: '/forged/argv0 --port 36321',
    }),
    true,
  );
  assert.equal(
    isUnslothStudioProcess({
      executable: '/tmp/llama.cpp/llama-server',
      command: `${STUDIO_LLAMA_SERVER} --port 36321`,
    }),
    false,
  );
  assert.equal(
    isUnslothStudioProcess({
      executable: '/home/mctdgx01/apps/unsloth-studio/bin/llama-server',
      command: `${STUDIO_LLAMA_SERVER} --port 36321`,
    }),
    false,
  );
});

test('uses an exact installed-path fallback only when Studio realpath is unavailable', () => {
  assert.equal(
    isUnslothStudioProcess(
      {
        executable: STUDIO_LLAMA_SERVER,
        command: '/forged/argv0 --port 36321',
      },
      {
        realpath: () => {
          throw new Error('installed path unavailable');
        },
      },
    ),
    true,
  );
});

test('rejects a non-Studio executable that only mentions the Studio launcher in an argument', () => {
  const spoofedCommand = `/opt/llama.cpp/llama-server --label ${UNSLOTH_STUDIO_ROOT}/llama.cpp/llama-server --port 36321`;

  assert.equal(
    isUnslothStudioProcess({ command: spoofedCommand }),
    false,
  );

  const process = parseRunningLlamaProcessLine(
    `716620 716100 Tue Aug  4 09:14:12 2026 ${spoofedCommand}`,
    { readExecutable: () => '/opt/llama.cpp/llama-server' },
  );
  assert.equal(process.executable, '/opt/llama.cpp/llama-server');
  assert.equal(process.isUnslothStudio, false);
  assert.equal(process.clientPort, 36321);
});

test('forged argv0 cannot classify a non-Studio proc executable as Studio', () => {
  const process = parseRunningLlamaProcessLine(
    `716621 716100 Tue Aug  4 09:14:12 2026 ${STUDIO_LLAMA_SERVER} --port 36321`,
    { readExecutable: () => '/usr/bin/sleep' },
  );

  assert.equal(process.executable, '/usr/bin/sleep');
  assert.equal(process.isUnslothStudio, false);
  assert.equal(process.clientPort, 36321);
});

test('unavailable proc executable identity fails closed', () => {
  const process = parseRunningLlamaProcessLine(
    `716622 716100 Tue Aug  4 09:14:12 2026 ${STUDIO_LLAMA_SERVER} --port 36321`,
    { readExecutable: () => null },
  );

  assert.equal(process.executable, null);
  assert.equal(process.isUnslothStudio, false);
  assert.equal(process.clientPort, 36321);
});

test('maps Studio processes to the fixed client port while leaving other llama processes unchanged', () => {
  assert.equal(
    clientPortForLlamaProcess({
      executable: installedStudioExecutable(),
      command: `${STUDIO_LLAMA_SERVER} --port 36321`,
      port: 36321,
    }),
    UNSLOTH_STUDIO_CLIENT_PORT,
  );
  assert.equal(
    clientPortForLlamaProcess({
      command: '/opt/llama.cpp/llama-server --port 18131',
      port: 18131,
    }),
    18131,
  );
});

test('parses ps output rows with process identity, backend port, and Studio client port metadata', () => {
  const process = parseRunningLlamaProcessLine(
    `716619 716100 Tue Aug  4 09:14:12 2026 ${UNSLOTH_STUDIO_ROOT}/llama.cpp/llama-server --port 36321 --model /models/deepseek/model.gguf --alias unsloth/DeepSeek-V4-Flash-0731-GGUF --ctx-size 278528`,
    { readExecutable: () => installedStudioExecutable() },
  );

  assert.equal(process.pid, 716619);
  assert.equal(process.ppid, 716100);
  assert.equal(process.startedAt, 'Tue Aug  4 09:14:12 2026');
  assert.equal(process.port, 36321);
  assert.equal(process.clientPort, UNSLOTH_STUDIO_CLIENT_PORT);
  assert.equal(process.backendPort, 36321);
  assert.equal(process.alias, 'unsloth/DeepSeek-V4-Flash-0731-GGUF');
  assert.equal(process.context, 278528);
  assert.equal(process.modelPath, '/models/deepseek/model.gguf');
  assert.equal(process.isUnslothStudio, true);
});

test('keeps diagnostics on the backend port while exposing the Studio client port as proxyPort', () => {
  assert.deepEqual(
    selectedLlamaPorts({
      port: 36321,
      backendPort: 36321,
      clientPort: UNSLOTH_STUDIO_CLIENT_PORT,
    }),
    {
      port: 36321,
      backendPort: 36321,
      proxyPort: UNSLOTH_STUDIO_CLIENT_PORT,
    },
  );

  assert.deepEqual(
    selectedLlamaPorts({
      port: 18131,
    }),
    {
      port: 18131,
      backendPort: 18131,
      proxyPort: 18131,
    },
  );
});

test('matches the configured Studio card by process identity before the shared client port', () => {
  const candidates = [
    {
      clientPort: UNSLOTH_STUDIO_CLIENT_PORT,
      env: {
        API_MODEL_ID: 'studio-alpha',
        MODEL_PATH: '/models/studio-alpha',
      },
      modelPath: '/models/studio-alpha',
    },
    {
      clientPort: UNSLOTH_STUDIO_CLIENT_PORT,
      env: {
        API_MODEL_ID: 'studio-beta',
        MODEL_PATH: '/models/studio-beta',
      },
      modelPath: '/models/studio-beta',
    },
  ];
  const betaProcess = {
    executable: installedStudioExecutable(),
    command: `${UNSLOTH_STUDIO_ROOT}/llama.cpp/llama-server --port 36322`,
    clientPort: UNSLOTH_STUDIO_CLIENT_PORT,
    port: 36322,
    alias: 'studio-beta',
    modelPath: '/models/studio-beta/model.gguf',
  };

  assert.equal(
    configuredLlamaCandidateMatchesProcess(candidates[0], betaProcess, candidates),
    false,
  );
  assert.equal(
    configuredLlamaCandidateMatchesProcess(candidates[1], betaProcess, candidates),
    true,
  );
});

test('does not choose a Studio card solely from a shared client port when identity is ambiguous', () => {
  const candidates = [
    {
      clientPort: UNSLOTH_STUDIO_CLIENT_PORT,
      env: { API_MODEL_ID: 'studio-alpha', MODEL_PATH: '/models/studio-alpha' },
      modelPath: '/models/studio-alpha',
    },
    {
      clientPort: UNSLOTH_STUDIO_CLIENT_PORT,
      env: { API_MODEL_ID: 'studio-beta', MODEL_PATH: '/models/studio-beta' },
      modelPath: '/models/studio-beta',
    },
  ];
  const unknownProcess = {
    executable: installedStudioExecutable(),
    command: `${UNSLOTH_STUDIO_ROOT}/llama.cpp/llama-server --port 36323`,
    clientPort: UNSLOTH_STUDIO_CLIENT_PORT,
    port: 36323,
    alias: 'studio-unknown',
    modelPath: '/models/studio-unknown/model.gguf',
  };

  assert.equal(
    candidates.some(candidate =>
      configuredLlamaCandidateMatchesProcess(candidate, unknownProcess, candidates)),
    false,
  );
});

test('does not accept a reused PID when the configured Studio start time differs', () => {
  const candidate = {
    clientPort: UNSLOTH_STUDIO_CLIENT_PORT,
    pid: 716619,
    startedAt: 'Tue Aug  4 09:14:12 2026',
    modelPath: '/models/studio-alpha',
    env: { MODEL_PATH: '/models/studio-alpha' },
  };
  const reusedProcess = {
    executable: installedStudioExecutable(),
    command: `${UNSLOTH_STUDIO_ROOT}/llama.cpp/llama-server --port 36324`,
    clientPort: UNSLOTH_STUDIO_CLIENT_PORT,
    port: 36324,
    pid: 716619,
    startedAt: 'Tue Aug  4 10:14:12 2026',
    modelPath: '/models/studio-unknown/model.gguf',
  };

  assert.equal(
    configuredLlamaCandidateMatchesProcess(candidate, reusedProcess, [candidate]),
    false,
  );
});
