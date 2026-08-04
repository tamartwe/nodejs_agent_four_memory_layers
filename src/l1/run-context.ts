import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { TokenBudget } from './budget.js';
import { RunMetrics } from './metrics.js';
import { trackForCollection } from './leak-probe.js';

/**
 * L1 — in-process working memory.
 *
 * Everything here dies with the run and never becomes tokens. If it needs to be in the
 * prompt it belongs to L2. If it owns an OS resource it belongs to L3.
 */
export interface RunContext {
  readonly runId: string;
  readonly startedAt: number;
  /** Absolute epoch ms, not a duration. Durations get re-based by accident; deadlines don't. */
  readonly deadline: number;
  /** Root of the cancellation tree. Every socket in this run descends from it. */
  readonly signal: AbortSignal;
  readonly budget: TokenBudget;
  readonly scratch: Map<string, unknown>;
  /** hash(tool + input) — dedup for the loop the model gets into. */
  readonly seen: Set<string>;
  readonly metrics: RunMetrics;
  dispose(): void;
}

const als = new AsyncLocalStorage<RunContext>();

/** Throws rather than returning undefined: a silent undefined ctx is a debugging nightmare. */
export function currentRun(): RunContext {
  const ctx = als.getStore();
  if (!ctx) throw new Error('currentRun() called outside of withRun()');
  return ctx;
}

export function maybeCurrentRun(): RunContext | undefined {
  return als.getStore();
}

export interface RunInit {
  maxTokens: number;
  timeoutMs: number;
  parentSignal?: AbortSignal;
}

export function createRunContext(init: RunInit): RunContext {
  const controller = new AbortController();
  const signals: AbortSignal[] = [controller.signal, AbortSignal.timeout(init.timeoutMs)];
  if (init.parentSignal) signals.push(init.parentSignal);

  const ctx: RunContext = {
    runId: randomUUID(),
    startedAt: Date.now(),
    deadline: Date.now() + init.timeoutMs,
    // AbortSignal.any (Node 20.3+) is the composition primitive: a cancellation TREE,
    // not a cancellation flag. AbortSignal.timeout is unref'd, so it won't hold the loop open.
    signal: AbortSignal.any(signals),
    budget: new TokenBudget(init.maxTokens),
    scratch: new Map(),
    seen: new Set(),
    metrics: new RunMetrics(),
    dispose() {
      controller.abort(new Error(`run ${this.runId} disposed`));
      this.scratch.clear();
      this.seen.clear();
    },
  };

  trackForCollection(ctx, ctx.runId);
  return ctx;
}

/**
 * The whole point of this function is the `finally`. Everything else is scaffolding.
 */
export async function withRun<T>(init: RunInit, fn: (ctx: RunContext) => Promise<T>): Promise<T> {
  const ctx = createRunContext(init);
  try {
    return await als.run(ctx, () => fn(ctx));
  } finally {
    ctx.dispose();
  }
}

export function hashInput(toolName: string, input: unknown): string {
  return createHash('sha256')
    .update(toolName)
    .update('\u0000')
    .update(stableStringify(input))
    .digest('hex')
    .slice(0, 16);
}

/** Key order must not change the hash, or dedup and idempotency keys both break. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  // eslint-disable-next-line no-nested-ternary -- the standard three-way string comparator idiom
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
