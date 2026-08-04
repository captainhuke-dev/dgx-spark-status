import assert from 'node:assert/strict';
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

test('identifies only the exact installed Studio llama-server path as Unsloth Studio', () => {
  assert.equal(
    isUnslothStudioProcess({
      command: `${UNSLOTH_STUDIO_ROOT}/llama.cpp/llama-server --port 36321`,
    }),
    true,
  );
  assert.equal(
    isUnslothStudioProcess({
      command: '/tmp/llama.cpp/llama-server --port 36321',
    }),
    false,
  );
  assert.equal(
    isUnslothStudioProcess({
      command: '/home/mctdgx01/apps/unsloth-studio/bin/llama-server --port 36321',
    }),
    false,
  );
});

test('maps Studio processes to the fixed client port while leaving other llama processes unchanged', () => {
  assert.equal(
    clientPortForLlamaProcess({
      command: `${UNSLOTH_STUDIO_ROOT}/llama.cpp/llama-server --port 36321`,
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
