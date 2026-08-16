/** Heap + table helpers. Run demos with --expose-gc for honest numbers. */

export function heapMb(): number {
  if (typeof global.gc === 'function') {
    global.gc();
    global.gc(); // second pass collects objects resurrected by finalizers
  }
  return Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1));
}

interface HeapSample {
  tag: string;
  mb: number;
}

export class HeapTrace {
  label: string;

  samples: HeapSample[] = [];

  constructor(label: string) {
    this.label = label;
  }

  sample(tag: string): number {
    const mb = heapMb();
    this.samples.push({ tag, mb });
    return mb;
  }

  /** Slope in MB per sample — the number that tells you if you have a leak. */
  slope(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0]!.mb;
    const last = this.samples.at(-1)!.mb;
    return Number(((last - first) / (this.samples.length - 1)).toFixed(3));
  }

  sparkline(): string {
    const bars = '▁▂▃▄▅▆▇█';
    const vals = this.samples.map((s) => s.mb);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    return vals
      .map((v) => bars[Math.min(7, Math.floor(((v - min) / span) * 7))])
      .join('');
  }

  print(): void {
    const first = this.samples[0]?.mb ?? 0;
    const last = this.samples.at(-1)?.mb ?? 0;
    console.log(
      `\n  heap  ${this.sparkline()}  ${first} MB → ${last} MB`
        + `  (drift ${(last - first).toFixed(1)} MB, slope ${this.slope()} MB/turn)`,
    );
  }
}

export type Mode = 'before' | 'after' | null;

const MODE_TAGS: Record<Exclude<Mode, null>, string> = {
  before: '\x1b[41m BEFORE \x1b[0m',
  after: '\x1b[42m\x1b[30m AFTER \x1b[0m',
};

export function banner(title: string, mode: Mode): void {
  const tag = mode ? MODE_TAGS[mode] : '';
  console.log(`\n${'─'.repeat(72)}\n${tag}  ${title}\n${'─'.repeat(72)}`);
}

export function kv(obj: Record<string, unknown>): void {
  const width = Math.max(...Object.keys(obj).map((k) => k.length));
  Object.entries(obj).forEach(([k, v]) => {
    console.log(`  ${k.padEnd(width)}  ${v}`);
  });
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function sizeOf(value: unknown): number {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
}
