import { describe, it, expect } from 'vitest';
import { withRun } from '../src/l1/run-context.js';
import { settleGc } from '../src/l1/leak-probe.js';

const MB = 1024 * 1024;

/**
 * A unit test for a memory leak. Most people have never seen one; it is the single most
 * useful artifact in this repo.
 *
 * Requires --expose-gc (wired up in vitest.config.ts).
 */
describe('L1 working memory', () => {
  it('1000 runs do not grow the heap', async () => {
    await settleGc();
    const before = process.memoryUsage().heapUsed;

    for (let i = 0; i < 1000; i++) {
      await withRun({ maxTokens: 100_000, timeoutMs: 5_000 }, async (ctx) => {
        ctx.scratch.set('payload', Buffer.alloc(64 * 1024)); // 64 KB per run
        return 'ok';
      });
    }

    await settleGc();
    const growthMb = (process.memoryUsage().heapUsed - before) / MB;

    // Leaky version (module-scoped Map, no dispose): ~64 MB. Correct version: < 8 MB
    // (headroom above the ~5.2 MB baseline overhead observed on newer Node/V8 versions).
    expect(growthMb).toBeLessThan(8);
  });

  it('disposes the run context even when the body throws', async () => {
    let captured: { signal: AbortSignal } | undefined;
    await expect(
      withRun({ maxTokens: 1000, timeoutMs: 1000 }, async (ctx) => {
        captured = ctx;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(captured!.signal.aborted).toBe(true);
  });
});
