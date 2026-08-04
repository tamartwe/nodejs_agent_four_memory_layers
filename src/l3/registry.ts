import { hashInput } from '../l1/run-context.js';
import type { ResultRef } from './spill.js';

export type CallState = 'pending' | 'running' | 'ok' | 'error' | 'timeout' | 'cancelled';

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface CallRecord {
  readonly id: string; // tool_use_id — the join key with L2
  readonly name: string;
  readonly inputHash: string;
  readonly stepIndex: number;
  state: CallState;
  startedAt: number;
  endedAt?: number;
  controller: AbortController;
  /** A HANDLE, never the bytes. This is the line that keeps RSS flat. */
  resultRef?: ResultRef;
  bytes: number;
  error?: { name: string; message: string };
}

export class BackpressureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackpressureError';
  }
}

export interface RegistryLimits {
  maxInflight: number;
  maxTotalBytes: number;
}

/**
 * L3 — the tool call state machine.
 *
 *   requested -> dispatched -> running -> { ok | error | timeout | cancelled }
 *                                  |
 *                                  +-- owns: socket, fd, child process, timer
 *
 * L2 asks "what was said". L3 asks "what is in flight, what does it hold, and how do I
 * guarantee it gets released".
 */
export class ToolCallRegistry implements Disposable {
  private readonly calls = new Map<string, CallRecord>();
  private readonly inflight = new Set<string>();

  constructor(private readonly limits: RegistryLimits = { maxInflight: 8, maxTotalBytes: 64 << 20 }) {}

  open(use: ToolUse, stepIndex: number): CallRecord {
    if (this.inflight.size >= this.limits.maxInflight) {
      throw new BackpressureError(`max in-flight tool calls reached (${this.limits.maxInflight})`);
    }
    const rec: CallRecord = {
      id: use.id,
      name: use.name,
      inputHash: hashInput(use.name, use.input),
      stepIndex,
      state: 'pending',
      startedAt: performance.now(),
      controller: new AbortController(),
      bytes: 0,
    };
    this.calls.set(rec.id, rec);
    this.inflight.add(rec.id);
    return rec;
  }

  settle(rec: CallRecord, state: CallState, patch: Partial<CallRecord> = {}): void {
    /* eslint-disable no-param-reassign -- `rec` is the record's own owner mutating it in
     * place; callers keep the same reference from open() specifically so a settle() here
     * is visible wherever else that record is held, no re-fetch required. */
    rec.state = state;
    rec.endedAt = performance.now();
    Object.assign(rec, patch);
    /* eslint-enable no-param-reassign */
    this.inflight.delete(rec.id);
    rec.controller.abort(); // idempotent; releases any listener still attached
  }

  findByHash(hash: string): CallRecord | undefined {
    for (const rec of this.calls.values()) {
      if (rec.inputHash === hash && rec.state === 'ok') return rec;
    }
    return undefined;
  }

  get(id: string): CallRecord | undefined {
    return this.calls.get(id);
  }

  /** Fires when the run ends, however it ends. `using registry = new ToolCallRegistry()`. */
  [Symbol.dispose](): void {
    for (const id of this.inflight) {
      const rec = this.calls.get(id);
      if (!rec) continue;
      rec.controller.abort(new Error('run disposed'));
      rec.state = 'cancelled';
    }
    this.inflight.clear();
    this.calls.clear();
  }

  get stats() {
    const now = performance.now();
    let bytes = 0;
    let orphaned = 0;
    for (const r of this.calls.values()) {
      bytes += r.bytes;
      if (r.state === 'running' && now - r.startedAt > 60_000) orphaned++;
    }
    return {
      total: this.calls.size,
      inflight: this.inflight.size,
      bytes,
      /** If this is ever non-zero in production you have leak class #2. Alert on it. */
      orphaned,
    };
  }
}
