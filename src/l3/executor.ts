import type { ContentBlock } from '../l2/types.js';
import type { RunContext } from '../l1/run-context.js';
import { semaphore } from './semaphore.js';
import { materialize, SpillStore } from './spill.js';
import { ToolCallRegistry, type CallState, type ToolUse } from './registry.js';
import type { ToolRegistry } from '../tools/index.js';

export const TOOL_TIMEOUT_MS = 30_000;

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`unknown tool: ${name}`);
    this.name = 'UnknownToolError';
  }
}

export interface ExecutorDeps {
  tools: ToolRegistry;
  registry: ToolCallRegistry;
  spill: SpillStore;
  concurrency?: number;
  timeoutMs?: number;
  /** Turn off to demonstrate the model re-calling the same tool forever. */
  dedupe?: boolean;
}

/**
 * The model can emit N tool_use blocks in one assistant turn, and the API requires all N
 * results back. Three properties must hold:
 *
 *   completeness  — never drop one, even on failure
 *   isolation     — one failure must not sink the batch
 *   boundedness   — N=30 file reads must not open 30 fds at once
 */
export async function runToolBatch(
  uses: ToolUse[],
  ctx: RunContext,
  deps: ExecutorDeps,
  stepIndex: number,
): Promise<ContentBlock[]> {
  const gate = semaphore(deps.concurrency ?? 8);

  // allSettled, never all: `all` rejects on first failure and you lose the results of the
  // ones that succeeded — which you still owe the API.
  const settled = await Promise.allSettled(uses.map((use) => gate(() => runOne(use, ctx, deps, stepIndex))));

  // Map 1:1 back onto the original uses. Completeness is guaranteed by construction.
  return uses.map((use, i): ContentBlock => {
    const s = settled[i];
    if (s.status === 'fulfilled') return s.value;
    return {
      type: 'tool_result',
      tool_use_id: use.id, // the id MUST still be here on the failure path
      is_error: true,
      content: toModelReadableError(s.reason),
    };
  });
}

async function runOne(use: ToolUse, ctx: RunContext, deps: ExecutorDeps, stepIndex: number): Promise<ContentBlock> {
  const rec = deps.registry.open(use, stepIndex);

  // The cancellation TREE: run deadline, per-call timeout, and the registry's own handle,
  // composed into one signal that is threaded all the way to the syscall.
  const signal = AbortSignal.any([
    ctx.signal,
    rec.controller.signal,
    AbortSignal.timeout(deps.timeoutMs ?? TOOL_TIMEOUT_MS),
  ]);

  try {
    signal.throwIfAborted(); // fail fast if the run already died
    rec.state = 'running';
    ctx.metrics.toolCalls++;

    // Dedup: an L1 structure serving an L3 concern to protect an L2 budget.
    if (deps.dedupe !== false) {
      const key = `${use.name}:${rec.inputHash}`;
      if (ctx.seen.has(key)) {
        const prior = deps.registry.findByHash(rec.inputHash);
        deps.registry.settle(rec, 'ok');
        return {
          type: 'tool_result',
          tool_use_id: use.id,
          content: `Identical call already made at step ${prior?.stepIndex ?? '?'}. ${
            prior?.resultRef?.id
              ? `Its result is available via read_result({ ref="${prior.resultRef.id}" }).`
              : 'Reuse the earlier result rather than repeating this call.'
          }`,
        };
      }
      ctx.seen.add(key);
    }

    const handler = deps.tools.get(use.name);
    if (!handler) throw new UnknownToolError(use.name);

    // The model's tool input is UNTRUSTED INPUT FROM A PROBABILISTIC SOURCE.
    // Validate it exactly as you would an HTTP body.
    const input = handler.schema.parse(use.input);
    const raw = await handler.run(input as never, { signal, ctx });

    const { text, ref, bytes } = await materialize(raw, deps.spill);
    if (ref.kind === 'spilled') ctx.metrics.spilledBytes += bytes;
    deps.registry.settle(rec, 'ok', { resultRef: ref, bytes });

    return { type: 'tool_result', tool_use_id: use.id, content: text };
  } catch (err) {
    const e = err as Error;
    let state: CallState = 'error';
    if (e?.name === 'TimeoutError') state = 'timeout';
    else if (signal.aborted) state = 'cancelled';
    deps.registry.settle(rec, state, { error: { name: e?.name ?? 'Error', message: e?.message ?? String(err) } });
    ctx.metrics.toolErrors++;

    // Return an error RESULT, not a throw. The model can often recover, and the transcript
    // stays well-formed either way: a tool failure must never become a protocol failure.
    return {
      type: 'tool_result',
      tool_use_id: use.id,
      is_error: true,
      content: toModelReadableError(err),
    };
  }
}

/**
 * Error messages go to the MODEL. Write them for the model: what failed, why, and what a
 * valid retry looks like. "ECONNREFUSED" is useless; the version below produces a recovery.
 */
export function toModelReadableError(err: unknown): string {
  const e = err as Error;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return `The tool call timed out or was cancelled. Try a narrower query, or use a cheaper tool.`;
  }
  if (e?.name === 'ZodError') {
    return `Invalid tool input: ${e.message}. Re-issue the call with arguments matching the schema.`;
  }
  if (e?.name === 'UnknownToolError') {
    return `${e.message}. Use one of the tools listed in the tool definitions.`;
  }
  return `Tool failed: ${e?.message ?? String(err)}. If this is transient, retry once; otherwise try a different approach.`;
}

/**
 * THE MOST COMMON LEAK IN AGENT CODE — kept here so act3 can run it side by side.
 *
 * Promise.race settles, but it does NOT cancel the loser. The underlying work keeps its
 * socket open, keeps buffering the response, and keeps its closure alive. Do this 100
 * times in a run and you have 100 orphaned requests writing into memory nobody will read.
 * heapUsed looks fine; arrayBuffers and RSS climb.
 */
export async function leakyRace<T>(work: () => Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work(),
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]);
}
