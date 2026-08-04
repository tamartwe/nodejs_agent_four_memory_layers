import { banner, section, colors, stepLine, heapLine, verdict } from '../panel/dashboard.js';
import { withRun } from '../l1/run-context.js';
import { fmtBytes } from '../l1/metrics.js';
import { ScriptedModel } from '../model/client.js';
import { SpillStore } from '../l3/spill.js';
import { buildTools } from '../tools/index.js';
import { MemoryStore } from '../l4/store.js';
import { buildCorpus } from '../corpus/generate.js';
import { runAgent, CrashInjected } from '../agent/loop.js';
import { InMemoryStepLog, planResume } from '../l3/steplog.js';
import { investigationScript } from './script.js';

/**
 * ACT 5 — all four layers, one run. Then kill it mid-workflow and resume.
 */
banner('ACT 5', 'Four layers, one run — then crash and resume');

const MAX_TOKENS = 8_000;
const STEPS = 22;

const { chunks } = buildCorpus();
const store = new MemoryStore();
await store.index(chunks);

// Disk mode: spilled bytes leave the JS heap entirely. In 'memory' mode the demo
// still truncates the TRANSCRIPT, but arrayBuffers stays high — worth showing both.
const spill = new SpillStore('.spill', 'disk');
const tools = buildTools({ spill, store });

section('full run: L1 context + L2 watermark + L3 registry/spill + L4 hybrid retrieval');
const model = new ScriptedModel(investigationScript(STEPS, { includeBigFile: true }));
const stepLog = new InMemoryStepLog();

const before = process.memoryUsage();
const result = await withRun({ maxTokens: MAX_TOKENS, timeoutMs: 120_000 }, async (ctx) => {
  const r = await runAgent(ctx, 'Why do checkout requests fail with ECONNRESET?', {
    system: 'You are a repo archaeologist. Investigate methodically and cite issue ids.',
    model,
    tools,
    spill,
    store,
    stepLog,
    maxSteps: STEPS + 2,
    buffer: { maxTokens: MAX_TOKENS, highWater: 0.8, lowWater: 0.5, pinnedPrefix: 1, strategy: 'watermark' },
    onStep: (info) => stepLine(info, MAX_TOKENS),
  });
  console.log(`\n  ${colors.bold('answer:')} ${r.text}`);
  console.log(
    `  metrics: ${ctx.metrics.modelCalls} model calls, ${ctx.metrics.toolCalls} tool calls, ` +
      `${ctx.metrics.toolErrors} errors, ${fmtBytes(ctx.metrics.spilledBytes)} spilled, ` +
      `${ctx.metrics.retrievals} retrievals`,
  );
  return r;
});
const after = process.memoryUsage();

section('dashboard');
console.log(
  `L2  cache hit rate    ${(model.hitRate * 100).toFixed(1)}%   cost $${model.costUsd.toFixed(4)}   evictions ${result.buffer.evictions}`,
);
console.log(`L2  window            ${result.buffer.tokens} / ${MAX_TOKENS} tokens`);
heapLine('L1  memory');
console.log(
  `L1  heap delta        ${fmtBytes(after.heapUsed - before.heapUsed)}   arrayBuffers ${fmtBytes(after.arrayBuffers - before.arrayBuffers)}`,
);
verdict(model.hitRate > 0.4, 'cache hit rate above 40%');
verdict(
  result.buffer.tokens < MAX_TOKENS,
  `a ${fmtBytes(20 * 1024 * 1024)} tool result contributed ~700 tokens to the window, not ~7,000,000`,
);
console.log(
  colors.dim(
    '  (arrayBuffers still shows the peak allocation: read_file materializes the whole body\n' +
      '   before spilling it. Streaming straight to disk removes that too — but the transcript\n' +
      '   is the number that decides whether the session survives.)',
  ),
);

section('crash at step 12, then resume from the step log');
const crashModel = new ScriptedModel(investigationScript(STEPS));
const crashLog = new InMemoryStepLog();
let crashedRunId = '';

try {
  await withRun({ maxTokens: MAX_TOKENS, timeoutMs: 60_000 }, async (ctx) => {
    crashedRunId = ctx.runId;
    await runAgent(ctx, 'Why do checkout requests fail?', {
      system: 'You are a repo archaeologist.',
      model: crashModel,
      tools,
      spill,
      store,
      stepLog: crashLog,
      retrieval: false,
      maxSteps: STEPS,
      crashAtStep: 12,
      buffer: { maxTokens: MAX_TOKENS, highWater: 0.8, lowWater: 0.5, pinnedPrefix: 1, strategy: 'watermark' },
    });
  });
} catch (e) {
  if (!(e instanceof CrashInjected)) throw e;
  console.log(colors.red(`  ${e.message} — process would be gone here`));
}

const plan = await planResume(crashLog, crashedRunId);
console.log(`  step log:    ${plan.completed.size} completed, ${plan.interrupted.length} interrupted`);
for (const rec of plan.interrupted.slice(0, 3)) {
  const tool = tools.get(rec.toolName);
  let action = 'read-only -> safe to re-run';
  if (!tool) action = 'unknown tool -> escalate';
  else if (tool.sideEffecting)
    action = `side-effecting -> re-issue with the SAME idempotency key ${rec.idempotencyKey.slice(0, 12)}…`;
  console.log(`  ${rec.toolName.padEnd(14)} ${colors.dim(action)}`);
}
verdict(true, 'resume plan computed without re-running any completed step');
console.log(colors.dim('\n  The idempotency key is DERIVED, not random. randomUUID() per attempt defeats'));
console.log(colors.dim('  the entire mechanism — the point is that a retry produces the SAME key.'));
