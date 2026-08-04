import { banner, section, colors, heapLine, verdict } from '../panel/dashboard.js';
import { withRun } from '../l1/run-context.js';
import { fmtBytes } from '../l1/metrics.js';
import { collectedCount, settleGc } from '../l1/leak-probe.js';
import { leakyRace, runToolBatch } from '../l3/executor.js';
import { ToolCallRegistry } from '../l3/registry.js';
import { SpillStore } from '../l3/spill.js';
import { buildTools, sleep } from '../tools/index.js';

/**
 * ACT 3 — the leak.
 *
 * Run with: node --expose-gc --import tsx src/acts/act3-leak.ts
 *
 * heapUsed looks fine. arrayBuffers and RSS climb. People stare at the wrong graph for
 * two days.
 */
banner('ACT 3', 'Promise.race does not cancel');

const RUNS = 60;
const FILE_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The leaky version. Every line of this looks correct.
// ---------------------------------------------------------------------------
const activeRuns = new Map<string, unknown>(); // module-scoped Map = a GC root
const leakedResults: Buffer[] = [];

async function leakyRun(i: number): Promise<void> {
  const ctx = { runId: `run-${i}`, buf: Buffer.alloc(FILE_BYTES, 'x') };
  activeRuns.set(ctx.runId, ctx); // set here...

  try {
    await leakyRace(async () => {
      // Simulates a fetch that keeps buffering after the race settles.
      const body = Buffer.alloc(FILE_BYTES, 'y');
      leakedResults.push(body); // the orphaned request still writes into memory
      await sleep(50);
      return body;
    }, 10);
  } catch {
    /* timeout — and the underlying work is STILL RUNNING */
  }
  // ...delete never runs on the throw path.
  activeRuns.delete(ctx.runId);
}

// ---------------------------------------------------------------------------
// The correct version: cancellation tree, registry disposal, spilling.
// ---------------------------------------------------------------------------
async function correctRun(i: number): Promise<void> {
  const spill = new SpillStore();
  const tools = buildTools({ spill, bigFileBytes: FILE_BYTES });

  await withRun({ maxTokens: 32_000, timeoutMs: 2_000 }, async (ctx) => {
    using registry = new ToolCallRegistry({ maxInflight: 4, maxTotalBytes: 64 << 20 });
    await runToolBatch(
      [
        { id: `toolu_big_${i}`, name: 'read_file', input: { path: 'dist/bundle.big.js' } },
        { id: `toolu_hang_${i}`, name: 'hanging_tool', input: {} },
      ],
      ctx,
      { tools, registry, spill, timeoutMs: 40 },
      i,
    );
    spill.clear();
  });
}

async function measure(label: string, fn: (i: number) => Promise<void>) {
  await settleGc();
  const before = process.memoryUsage();
  const t0 = performance.now();
  for (let i = 0; i < RUNS; i++) await fn(i);
  await settleGc();
  const after = process.memoryUsage();

  const heapDelta = after.heapUsed - before.heapUsed;
  const bufDelta = after.arrayBuffers - before.arrayBuffers;
  const rssDelta = after.rss - before.rss;

  console.log(
    `${label.padEnd(16)} heapUsed ${colors.dim(fmtBytes(heapDelta).padStart(10))}   ` +
      `arrayBuffers ${(bufDelta > 20e6 ? colors.red : colors.green)(fmtBytes(bufDelta).padStart(10))}   ` +
      `rss ${(rssDelta > 40e6 ? colors.red : colors.green)(fmtBytes(rssDelta).padStart(10))}   ${colors.dim(
        `${(performance.now() - t0).toFixed(0)}ms`,
      )}`,
  );
  return { heapDelta, bufDelta, rssDelta };
}

section(`${RUNS} runs, each reading ${fmtBytes(FILE_BYTES)} and calling a tool that never returns`);
heapLine('baseline');
console.log('');

const leaky = await measure('LEAKY', leakyRun);
console.log(colors.dim('  Promise.race settled. The loser kept its socket, its buffer, and its closure.'));
console.log(colors.dim(`  Still-referenced result buffers: ${leakedResults.length}`));

// Release the deliberate leak so the correct measurement is not polluted.
leakedResults.length = 0;
activeRuns.clear();
await settleGc();
console.log('');

const correct = await measure('CORRECT', correctRun);
console.log(colors.dim('  AbortSignal.any threaded to the syscall, registry disposed via `using`, results spilled.'));

section('verdict');
verdict(
  correct.bufDelta < leaky.bufDelta,
  `arrayBuffers growth ${fmtBytes(correct.bufDelta)} vs ${fmtBytes(leaky.bufDelta)}`,
);
verdict(correct.bufDelta < 20e6, 'correct version keeps Buffer growth bounded');
await settleGc(8);
console.log(`\nFinalizationRegistry reported ${collectedCount()} collected run context(s).`);
console.log(
  colors.dim(
    '(Often 0 even though the memory WAS reclaimed — finalizers are not guaranteed to run at all.\n' +
      ' That is exactly why you must never build correctness on FinalizationRegistry or WeakRef.\n' +
      ' The arrayBuffers number above is the measurement that actually means something.)',
  ),
);
console.log(colors.dim('\nAlso useful on stage: process.getActiveResourcesInfo() ->'));
console.log(colors.dim(`  ${JSON.stringify([...new Set(process.getActiveResourcesInfo())])}`));
