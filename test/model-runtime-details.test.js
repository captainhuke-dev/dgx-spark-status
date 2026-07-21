import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let runtimeDetailsModule = {};
try {
  runtimeDetailsModule = await import('../model-runtime-details.js');
} catch {
  // The first TDD run must fail because the implementation does not exist yet.
}

test('reports the validated CUTLASS MTP runtime while preserving the legacy B12X API alias', () => {
  assert.equal(typeof runtimeDetailsModule.buildModelRuntimeDetails, 'function');

  const details = runtimeDetailsModule.buildModelRuntimeDetails({
    API_MODEL_ID: 'qwen36-35b-a3b-unsloth-nvfp4-fast-vllm25-b12x',
    RUNTIME_STACK: 'Python 3.13 / vLLM 0.25.0 / FlashInfer 0.6.13 / CUTLASS DSL 4.5.2',
    CUTE_DSL_ARCH: 'sm_121a',
    MAX_MODEL_LEN: '262144',
    ATTENTION_BACKEND: 'flashinfer',
    MOE_BACKEND: 'auto',
    LINEAR_BACKEND: 'auto',
    VALIDATED_BACKEND: 'flashinfer_cutlass_auto_mtp',
    MTP_ENABLED: 'true',
    MTP_OPTIONAL_TOKENS: '2',
  });

  assert.deepEqual(details, {
    backend: 'FlashInfer CUTLASS (auto)',
    attention: 'FlashInfer',
    mtp: 'Enabled · 2 speculative tokens',
    architecture: 'sm_121a',
    context: '256K',
    stack: 'Python 3.13 / vLLM 0.25.0 / FlashInfer 0.6.13 / CUTLASS DSL 4.5.2',
    apiAliasNote: 'Legacy API alias; B12X is not the active backend',
  });
});

test('omits runtime details when no validated metadata is available', () => {
  assert.equal(typeof runtimeDetailsModule.buildModelRuntimeDetails, 'function');
  assert.equal(runtimeDetailsModule.buildModelRuntimeDetails({ API_MODEL_ID: 'plain-model' }), null);
});

test('reads details only from the trusted vLLM model configuration directory', () => {
  assert.equal(typeof runtimeDetailsModule.readModelRuntimeDetails, 'function');
  const reads = [];
  const readFile = (path) => {
    reads.push(path);
    return [
      'API_MODEL_ID=qwen36-fast-vllm25-b12x',
      'VALIDATED_BACKEND=flashinfer_cutlass_auto_mtp',
      'ATTENTION_BACKEND=flashinfer',
      'MTP_ENABLED=true',
      'MTP_OPTIONAL_TOKENS=2',
      'MAX_MODEL_LEN=262144',
    ].join('\n');
  };

  const details = runtimeDetailsModule.readModelRuntimeDetails(
    { config_file: '/etc/vllm/models/qwen36-fast.env' },
    readFile,
  );

  assert.equal(details.backend, 'FlashInfer CUTLASS (auto)');
  assert.equal(details.apiAliasNote, 'Legacy API alias; B12X is not the active backend');
  assert.deepEqual(reads, ['/etc/vllm/models/qwen36-fast.env']);

  assert.equal(runtimeDetailsModule.readModelRuntimeDetails(
    { config_file: '/tmp/untrusted.env' },
    readFile,
  ), null);
  assert.deepEqual(reads, ['/etc/vllm/models/qwen36-fast.env']);
});

test('dashboard API enriches profiles and the vLLM card renders runtime truth', () => {
  const serverSource = readFileSync(
    fileURLToPath(new URL('../dev-server.js', import.meta.url)),
    'utf8',
  );
  const componentSource = readFileSync(
    fileURLToPath(new URL('../src/lib/SystemMetrics.svelte', import.meta.url)),
    'utf8',
  );

  assert.match(serverSource, /readModelRuntimeDetails\(profile, readFileSync\)/);
  assert.match(serverSource, /runtime_details:/);
  assert.match(componentSource, /control\.runtime_details/);
  assert.match(componentSource, /runtime_details\.backend/);
  assert.match(componentSource, /runtime_details\.apiAliasNote/);
});
