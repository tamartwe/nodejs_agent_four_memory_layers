import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resetUnsafeState,
  runUnsafeAgent,
  unsafePersistedRuns,
  unsafeRunRegistry,
} from '../src/01-working-memory/before';
import {
  collectSafeMetrics,
  runSafeAgent,
} from '../src/01-working-memory/after';
import {
  resetToolInstrumentation,
  toolInstrumentation,
} from '../src/01-working-memory/fake-tools';
import {
  activeRunRegistry,
  checkpointStore,
  resetSafeState,
  RunScope,
  TraceSpan,
} from '../src/01-working-memory/workingMemory';
import { DEFAULT_LIMITS } from '../src/01-working-memory/types';

test.beforeEach(() => {
  resetUnsafeState();
  resetSafeState();
  resetToolInstrumentation();
});

test.afterEach(() => {
  resetUnsafeState();
  resetSafeState();
  resetToolInstrumentation();
});

test('broken registry retains completed runs', async () => {
  await runUnsafeAgent({ runId: 'broken-retains' });

  assert.equal(unsafeRunRegistry.size, 1);
  assert.equal(unsafeRunRegistry.get('broken-retains')?.status, 'completed');
});

test('corrected registry is empty after successful completion', async () => {
  await runSafeAgent({ runId: 'safe-success' });

  assert.equal(activeRunRegistry.size, 0);
});

test('cleanup runs after an exception', async () => {
  await assert.rejects(
    runSafeAgent({ runId: 'safe-model-error', failModelAtStep: 1 }),
    /simulated model failure/,
  );

  assert.equal(activeRunRegistry.size, 0);
  assert.equal(TraceSpan.active.size, 0);
});

test('cleanup runs after cancellation', async () => {
  const controller = new AbortController();
  const run = runSafeAgent({
    runId: 'safe-cancelled',
    parentSignal: controller.signal,
    toolLatencyMs: 50,
  });

  setTimeout(() => controller.abort(new Error('client disconnected')), 5).unref();

  await assert.rejects(run, /cancelled by parent|client disconnected|aborted/);
  assert.equal(activeRunRegistry.size, 0);
  assert.equal(TraceSpan.active.size, 0);
});

test('tool operations receive and respect abort signals', async () => {
  const controller = new AbortController();
  const run = runSafeAgent({
    runId: 'safe-tool-abort',
    parentSignal: controller.signal,
    toolLatencyMs: 50,
  });

  setTimeout(() => controller.abort(new Error('stop tools')), 5).unref();

  await assert.rejects(run, /stop tools|cancelled by parent|aborted/);
  assert.ok(toolInstrumentation.signalsSeen > 0);
  assert.ok(toolInstrumentation.abortedOperations > 0);
});

test('step and tool-call limits are enforced', async () => {
  await assert.rejects(
    runSafeAgent({
      runId: 'safe-step-limit',
      neverFinal: true,
      limits: { maxSteps: 2 },
    }),
    /step limit exceeded/,
  );

  await assert.rejects(
    runSafeAgent({
      runId: 'safe-tool-limit',
      plannedToolSteps: 2,
      limits: { maxToolCalls: 1 },
    }),
    /tool call limit exceeded/,
  );
});

test('cache never exceeds its configured bound', async () => {
  const result = await runSafeAgent({
    runId: 'safe-cache-bound',
    plannedToolSteps: 4,
    limits: { maxCacheEntries: 2, maxToolCalls: 4, maxSteps: 5 },
  });

  assert.ok(result.peakCacheEntries <= 2);
});

test('large tool responses are not retained', async () => {
  const result = await runSafeAgent({
    runId: 'safe-large-response',
    candidateCount: 120,
    responsePaddingBytes: 256,
    limits: { maxRawToolResponseBytes: 512 },
  });
  const metrics = collectSafeMetrics();

  assert.equal(result.retainedRawToolResponses, 0);
  assert.equal(metrics.retainedRawToolResponses, 0);
});

test('persisted checkpoints do not contain raw tool data', async () => {
  await runSafeAgent({ runId: 'safe-checkpoint' });
  const checkpoint = checkpointStore.get('safe-checkpoint');

  assert.ok(checkpoint);
  assert.equal(JSON.stringify(checkpoint).includes('rawFareRules'), false);
  assert.equal(JSON.stringify(checkpoint).includes('candidates'), false);
  assert.equal(JSON.stringify(checkpoint).includes('prompt'), false);
});

test('cleanup can safely be called more than once', () => {
  const scope = new RunScope({
    runId: 'idempotent-cleanup',
    limits: DEFAULT_LIMITS,
  });

  const span = scope.startTrace('test');
  scope.rawToolResponses.push({
    requestId: 'raw',
    origin: 'TLV',
    destination: 'BER',
    generatedAt: new Date().toISOString(),
    candidates: [],
    diagnostics: { shard: 'test', tracePayload: 'raw' },
  });

  scope.dispose();
  scope.dispose();

  assert.equal(scope.disposed, true);
  assert.equal(span.disposed, true);
  assert.equal(scope.rawToolResponses.length, 0);
});

test('broken implementation persists the whole run context', async () => {
  await runUnsafeAgent({ runId: 'broken-persisted' });
  const persisted = unsafePersistedRuns.get('broken-persisted') ?? '';

  assert.equal(persisted.includes('rawFareRules'), true);
  assert.equal(persisted.includes('scratchpad'), true);
});
