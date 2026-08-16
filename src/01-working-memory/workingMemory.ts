/* eslint-disable max-classes-per-file */
import { bytesOf } from './memory-metrics';
import type {
  AgentLimits,
  PersistedCheckpoint,
  RawFlightSearchResponse,
} from './types';
import { DEFAULT_LIMITS } from './types';

export const activeRunRegistry = new Map<string, RunScope>();
export const activeRunTimers = new Set<NodeJS.Timeout>();

export class BoundedCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly maxEntries: number) {}

  get size(): number {
    return this.entries.size;
  }

  set(key: K, value: V): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }

    this.entries.set(key, value);

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export class TraceSpan {
  static readonly active = new Set<TraceSpan>();

  disposed = false;

  constructor(readonly id: string) {
    TraceSpan.active.add(this);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    TraceSpan.active.delete(this);
  }
}

export class CheckpointStore {
  private readonly checkpoints = new Map<string, PersistedCheckpoint>();

  save(checkpoint: PersistedCheckpoint): void {
    this.checkpoints.set(checkpoint.runId, checkpoint);
  }

  get(runId: string): PersistedCheckpoint | undefined {
    return this.checkpoints.get(runId);
  }

  clear(): void {
    this.checkpoints.clear();
  }

  get size(): number {
    return this.checkpoints.size;
  }

  approximateBytes(): number {
    return [...this.checkpoints.values()].reduce(
      (total, checkpoint) => total + bytesOf(checkpoint),
      0,
    );
  }

  values(): PersistedCheckpoint[] {
    return [...this.checkpoints.values()];
  }
}

export const checkpointStore = new CheckpointStore();

export interface RunScopeOptions {
  runId: string;
  limits?: Partial<AgentLimits>;
  timeoutMs?: number;
  parentSignal?: AbortSignal;
}

export class RunScope {
  readonly controller = new AbortController();

  readonly signal: AbortSignal;

  readonly cache: BoundedCache<string, string>;

  readonly rawToolResponses: RawFlightSearchResponse[] = [];

  readonly traceSpans: TraceSpan[] = [];

  disposed = false;

  private readonly cleanupCallbacks: Array<() => void> = [];

  private readonly timeout: NodeJS.Timeout;

  constructor(readonly options: RunScopeOptions) {
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    const maxExecutionMs = options.timeoutMs ?? limits.maxExecutionMs;
    this.cache = new BoundedCache(limits.maxCacheEntries);
    this.signal = this.controller.signal;
    this.timeout = setTimeout(() => {
      this.controller.abort(new Error(`run ${options.runId} timed out`));
    }, maxExecutionMs);
    this.timeout.unref?.();
    activeRunTimers.add(this.timeout);
    this.defer(() => {
      clearTimeout(this.timeout);
      activeRunTimers.delete(this.timeout);
    });

    if (options.parentSignal) {
      const cancelFromParent = (): void => {
        this.controller.abort(new Error(`run ${options.runId} cancelled by parent`));
      };
      options.parentSignal.addEventListener('abort', cancelFromParent, { once: true });
      this.defer(() => options.parentSignal?.removeEventListener('abort', cancelFromParent));
    }
  }

  startTrace(label: string): TraceSpan {
    const span = new TraceSpan(`${this.options.runId}:${label}:${this.traceSpans.length + 1}`);
    this.traceSpans.push(span);
    return span;
  }

  releaseRawToolResponses(): void {
    this.rawToolResponses.length = 0;
  }

  defer(callback: () => void): void {
    this.cleanupCallbacks.push(callback);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.cleanupCallbacks.reverse().forEach((callback) => callback());
    this.cleanupCallbacks.length = 0;
    this.traceSpans.forEach((span) => span.dispose());
    this.traceSpans.length = 0;
    this.rawToolResponses.length = 0;
    this.cache.clear();

    if (!this.controller.signal.aborted) {
      this.controller.abort(new Error(`run ${this.options.runId} disposed`));
    }
  }
}

export async function withRunScope<T>(
  options: RunScopeOptions,
  callback: (scope: RunScope) => Promise<T>,
): Promise<T> {
  const scope = new RunScope(options);
  activeRunRegistry.set(options.runId, scope);

  try {
    return await callback(scope);
  } finally {
    activeRunRegistry.delete(options.runId);
    scope.dispose();
  }
}

export function resetSafeState(): void {
  activeRunRegistry.forEach((scope) => scope.dispose());
  activeRunRegistry.clear();
  activeRunTimers.forEach((timer) => clearTimeout(timer));
  activeRunTimers.clear();
  TraceSpan.active.forEach((span) => span.dispose());
  checkpointStore.clear();
}
