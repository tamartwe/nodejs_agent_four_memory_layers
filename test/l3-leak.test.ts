import { describe, it, expect } from 'vitest';
import { withRun } from '../src/l1/run-context.js';
import { settleGc } from '../src/l1/leak-probe.js';
import { runToolBatch } from '../src/l3/executor.js';
import { ToolCallRegistry } from '../src/l3/registry.js';
import { SpillStore } from '../src/l3/spill.js';
import { buildTools } from '../src/tools/index.js';

describe('L3 tool call state', () => {
  it('returns a result for every use, including failures', async () => {
    const spill = new SpillStore();
    const tools = buildTools({ spill });

    const blocks = await withRun({ maxTokens: 50_000, timeoutMs: 5_000 }, async (ctx) => {
      using registry = new ToolCallRegistry();
      // The await matters: `using` disposes registry (aborting anything still inflight)
      // the instant this block's scope exits. Returning the bare promise would exit the
      // block — and dispose the registry — before runToolBatch actually finishes.
      return await runToolBatch(
        [
          { id: 'a', name: 'read_issue', input: { id: 'ENG-4471' } },
          { id: 'b', name: 'read_issue', input: { id: 'ENG-9999' } }, // does not exist
          { id: 'c', name: 'no_such_tool', input: {} },
          { id: 'd', name: 'read_issue', input: { id: 'not-an-id' } }, // schema violation
        ],
        ctx,
        { tools, registry, spill, timeoutMs: 2_000 },
        0,
      );
    });

    expect(blocks).toHaveLength(4);
    expect(blocks.map((b) => (b.type === 'tool_result' ? b.tool_use_id : ''))).toEqual(['a', 'b', 'c', 'd']);
    // A tool failure must never become a protocol failure.
    expect(blocks.filter((b) => b.type === 'tool_result' && b.is_error)).toHaveLength(3);
  });

  it('does not accumulate memory across runs with a hanging tool and a large result', async () => {
    await settleGc();
    const before = process.memoryUsage();

    for (let i = 0; i < 40; i++) {
      const spill = new SpillStore();
      const tools = buildTools({ spill, bigFileBytes: 1024 * 1024 });
      await withRun({ maxTokens: 50_000, timeoutMs: 2_000 }, async (ctx) => {
        using registry = new ToolCallRegistry({ maxInflight: 8, maxTotalBytes: 64 << 20 });
        await runToolBatch(
          [
            { id: `big${i}`, name: 'read_file', input: { path: 'dist/bundle.big.js' } },
            { id: `hang${i}`, name: 'hanging_tool', input: {} },
          ],
          ctx,
          { tools, registry, spill, timeoutMs: 50 },
          i,
        );
        spill.clear();
      });
    }

    await settleGc();
    const after = process.memoryUsage();

    expect((after.heapUsed - before.heapUsed) / 1e6).toBeLessThan(20);
    // The Buffer check: heapUsed will not show you a Buffer leak.
    expect((after.arrayBuffers - before.arrayBuffers) / 1e6).toBeLessThan(20);
  });

  it('cancels in-flight calls when the registry is disposed', async () => {
    const spill = new SpillStore();
    const tools = buildTools({ spill });
    const registry = new ToolCallRegistry();

    await withRun({ maxTokens: 10_000, timeoutMs: 5_000 }, async (ctx) => {
      const p = runToolBatch(
        [{ id: 'h', name: 'hanging_tool', input: {} }],
        ctx,
        { tools, registry, spill, timeoutMs: 10_000 },
        0,
      );
      await new Promise((r) => {
        setTimeout(r, 20);
      });
      registry[Symbol.dispose]();
      const blocks = await p;
      expect(blocks[0].type).toBe('tool_result');
      expect(blocks[0].type === 'tool_result' && blocks[0].is_error).toBe(true);
    });
  });
});
