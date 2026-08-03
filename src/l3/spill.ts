import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fmtBytes } from '../l1/metrics.js';

export interface ResultRef {
  kind: 'inline' | 'spilled';
  id?: string;
  bytes?: number;
}

/**
 * The single highest-leverage pattern in agent design:
 *
 *   give the agent a POINTER and a way to dereference it, instead of the value.
 *
 * It is exactly virtual memory. The transcript is a small address space, the spill store
 * is disk, and `read_result` is the page fault.
 */
export const INLINE_LIMIT_BYTES = 8 * 1024; // ~2k tokens

export class SpillStore {
  private readonly mem = new Map<string, Buffer>();

  constructor(
    private readonly dir: string | null = null,
    /** Keeping spilled bytes in the JS heap defeats the purpose; disk mode is the real one. */
    private readonly mode: 'memory' | 'disk' = 'memory',
  ) {}

  async write(buf: Buffer): Promise<ResultRef> {
    const id = randomUUID().slice(0, 8);
    if (this.mode === 'disk' && this.dir) {
      await mkdir(this.dir, { recursive: true });
      await writeFile(path.join(this.dir, id), buf);
    } else {
      this.mem.set(id, buf);
    }
    return { kind: 'spilled', id, bytes: buf.byteLength };
  }

  async read(id: string, offset = 0, length = 4096): Promise<string> {
    let buf: Buffer | undefined;
    if (this.mode === 'disk' && this.dir) {
      buf = await readFile(path.join(this.dir, id));
    } else {
      buf = this.mem.get(id);
    }
    if (!buf) throw new Error(`no spilled result with ref ${id}`);
    return buf.subarray(offset, offset + length).toString('utf8');
  }

  clear(): void {
    this.mem.clear();
  }

  get residentBytes(): number {
    let n = 0;
    for (const b of this.mem.values()) n += b.byteLength;
    return n;
  }
}

export interface Materialized {
  /** What goes into the TRANSCRIPT. Never the raw bytes. */
  text: string;
  ref: ResultRef;
  bytes: number;
}

export async function materialize(raw: unknown, spill: SpillStore): Promise<Materialized> {
  const buf = Buffer.isBuffer(raw)
    ? raw
    : Buffer.from(typeof raw === 'string' ? raw : JSON.stringify(raw, null, 0));
  const bytes = buf.byteLength;

  if (bytes <= INLINE_LIMIT_BYTES) {
    return { text: buf.toString('utf8'), ref: { kind: 'inline' }, bytes };
  }

  // 1. spill the bytes OUT of the transcript (and, in disk mode, out of the JS heap)
  const ref = await spill.write(buf);

  // 2. hand the MODEL a summary plus a handle it can act on
  const head = buf.subarray(0, 2_000).toString('utf8');
  const tail = buf.subarray(Math.max(0, bytes - 500)).toString('utf8');
  const text = [
    `[truncated: ${fmtBytes(bytes)} total, showing first 2000 and last 500 bytes]`,
    `[full result available via read_result({ ref="${ref.id}", offset, length })]`,
    '---',
    head,
    '\n... [omitted] ...\n',
    tail,
  ].join('\n');

  return { text, ref, bytes };
}
