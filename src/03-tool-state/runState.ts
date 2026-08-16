import type Anthropic from '@anthropic-ai/sdk';
import { sizeOf, bytes } from '../lib/report';
import type { TelemetryResult } from '../lib/tools';

/**
 * The two ideas that fix Layer 3:
 *
 *  1. OWNERSHIP. Tool state belongs to a run, not to a module. It is created
 *     with the run and destroyed with it. try/finally, not try/catch.
 *
 *  2. HANDLES. A tool result is not automatically context. Big results go
 *     out-of-band into a store; the transcript carries a compact preview plus
 *     a handle. If the model actually needs the detail, it calls read_result.
 *     This is the difference between an agent that can do a 30-step workflow
 *     and one that dies at step 8.
 */

export const READ_RESULT_TOOL: Anthropic.Tool = {
  name: 'read_result',
  description:
    'Read a slice of a large tool result that was stored out of band. '
    + 'Use the handle from a previous tool result, e.g. res_3.',
  input_schema: {
    type: 'object',
    properties: {
      handle: { type: 'string' },
      path: { type: 'string', description: 'Optional JSON path, e.g. rows[0..20]' },
    },
    required: ['handle'],
  },
};

const INLINE_LIMIT = 1_500; // bytes; above this a result is offloaded

export interface ToolExecStats {
  started: number;
  ok: number;
  failed: number;
  offloaded: number;
  bytesOffloaded: number;
}

interface PendingEntry {
  name: string;
  startedAt: number;
  signal: AbortSignal | null;
}

export interface ExecuteOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ReadResultInput {
  handle: string;
  path?: string;
}

type Offloadable = object;

/** Structure-preserving preview: the model needs the SHAPE, not the rows. */
function preview(out: Offloadable): unknown {
  if ('rows' in out && Array.isArray((out as TelemetryResult).rows)) {
    const telemetry = out as TelemetryResult;
    const hist = (key: keyof TelemetryResult['rows'][number]) => {
      const h: Record<string, number> = {};
      telemetry.rows.forEach((r) => {
        const v = String(r[key]);
        h[v] = (h[v] ?? 0) + 1;
      });
      return Object.fromEntries(
        Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, 5),
      );
    };
    return {
      deviceId: telemetry.deviceId,
      rowCount: telemetry.rowCount,
      firstRow: telemetry.rows[0],
      lastRow: telemetry.rows.at(-1),
      topFirmware: hist('firmware'),
      topRegions: hist('region'),
    };
  }
  return out;
}

export class ToolRunState {
  runId: string;

  pending = new Map<string, PendingEntry>(); // tool_use_id -> { name, startedAt, signal }

  results = new Map<string, Offloadable>(); // handle -> full payload (out of band)

  stats: ToolExecStats = {
    started: 0, ok: 0, failed: 0, offloaded: 0, bytesOffloaded: 0,
  };

  seq = 0;

  disposed = false;

  constructor(runId: string) {
    this.runId = runId;
  }

  /**
   * The only correct shape for this function. The finally block is not
   * defensive programming — it is the entire fix for the leak.
   */
  async execute(
    use: Anthropic.ToolUseBlock,
    exec: (name: string, input: unknown, opts: { signal: AbortSignal }) => Promise<Offloadable>,
    { signal, timeoutMs = 20_000 }: ExecuteOptions = {},
  ): Promise<Anthropic.ToolResultBlockParam> {
    const signals = [signal, AbortSignal.timeout(timeoutMs)].filter(Boolean) as AbortSignal[];
    const entrySignal = AbortSignal.any(signals);
    const entry: PendingEntry = {
      name: use.name,
      startedAt: Date.now(),
      signal: entrySignal,
    };
    this.pending.set(use.id, entry);
    this.stats.started += 1;

    try {
      const out = await exec(use.name, use.input, { signal: entrySignal });
      this.stats.ok += 1;
      return this.#toContent(use.id, out);
    } catch (err) {
      this.stats.failed += 1;
      // Errors go back to the model as tool_result, not as exceptions.
      // The model reading "invalid severity, expected P1..P4" and retrying
      // correctly is the agent working, not the agent failing.
      return {
        type: 'tool_result',
        tool_use_id: use.id,
        is_error: true,
        content: String((err as Error)?.message ?? err),
      };
    } finally {
      this.pending.delete(use.id); // ← runs on success, throw, timeout and abort
    }
  }

  #toContent(toolUseId: string, out: Offloadable): Anthropic.ToolResultBlockParam {
    const size = sizeOf(out);
    if (size <= INLINE_LIMIT) {
      return { type: 'tool_result', tool_use_id: toolUseId, content: JSON.stringify(out) };
    }

    const handle = `res_${(this.seq += 1)}`;
    this.results.set(handle, out);
    this.stats.offloaded += 1;
    this.stats.bytesOffloaded += size;

    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: JSON.stringify({
        handle,
        summary: preview(out),
        bytes: size,
        note: `Large result stored out of band as ${handle} (${bytes(size)}). `
              + 'Call read_result with this handle only if you need row-level detail.',
      }),
    };
  }

  /** Backing implementation of the read_result tool. */
  readResult({ handle, path }: ReadResultInput): unknown {
    const full = this.results.get(handle);
    if (!full) throw new Error(`unknown or expired handle: ${handle}`);
    if (!path) return preview(full);
    const m = /^rows\[(\d+)\.\.(\d+)\]$/.exec(path);
    if (m && 'rows' in full && Array.isArray((full as TelemetryResult).rows)) {
      return { rows: (full as TelemetryResult).rows.slice(Number(m[1]), Number(m[2]) + 1) };
    }
    return preview(full);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.forEach((entry) => {
      // eslint-disable-next-line no-param-reassign
      entry.signal = null;
    });
    this.pending.clear();
    this.results.clear(); // handles die with the run — that is intentional
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Same guarantee as Layer 1: the state cannot outlive the run. */
export async function withToolState<T>(
  runId: string,
  fn: (state: ToolRunState) => Promise<T>,
): Promise<T> {
  const state = new ToolRunState(runId);
  try {
    return await fn(state);
  } finally {
    state.dispose();
  }
}
