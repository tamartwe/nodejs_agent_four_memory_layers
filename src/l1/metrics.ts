import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';

export interface HeapSnapshot {
  rss: number;
  heapUsed: number;
  /** Buffers live HERE, not in heapUsed. This is the column people forget to graph. */
  external: number;
  arrayBuffers: number;
  heapLimit: number;
  loopP99Ms: number;
}

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

export const longGcs: { duration: number; kind: number }[] = [];

try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      // detail.kind: 1 = scavenge (cheap), 2 = minor mark-compact, 4 = incremental, 8 = weak cb
      if (e.duration > 20) {
        longGcs.push({ duration: e.duration, kind: (e as any).detail?.kind ?? 0 });
      }
    }
  }).observe({ entryTypes: ['gc'] });
} catch {
  /* gc entries unavailable in some environments */
}

export function snapshot(): HeapSnapshot {
  const m = process.memoryUsage();
  const h = v8.getHeapStatistics();
  return {
    rss: m.rss,
    heapUsed: m.heapUsed,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
    heapLimit: h.heap_size_limit,
    loopP99Ms: loop.percentile(99) / 1e6,
  };
}

export class RunMetrics {
  modelCalls = 0;
  toolCalls = 0;
  toolErrors = 0;
  evictions = 0;
  rollups = 0;
  retrievals = 0;
  promptTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  spilledBytes = 0;

  get cacheHitRate(): number {
    const total = this.cacheReadTokens + this.cacheWriteTokens + this.promptTokens;
    return total === 0 ? 0 : this.cacheReadTokens / total;
  }
}

export const fmtBytes = (n: number): string => {
  const abs = Math.abs(n);
  if (abs < 1024) return `${n} B`;
  if (abs < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (abs < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};
