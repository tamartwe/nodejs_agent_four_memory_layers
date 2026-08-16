import type { DemoMetrics } from './types';

export function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

export function heapMb(): number {
  global.gc?.();
  global.gc?.();
  return Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1));
}

export function rssMb(): number {
  return Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1));
}

export function printMetricsTable(rows: DemoMetrics[]): void {
  const headers = [
    'demo',
    'runs',
    'registry',
    'heap MB',
    'rss MB',
    'raw responses',
    'persisted bytes',
    'timers',
    'traces',
    'cache',
  ];
  const body = rows.map((row) => [
    row.label,
    String(row.completedRuns),
    String(row.activeRunRegistryEntries),
    row.heapMb.toFixed(1),
    row.rssMb.toFixed(1),
    String(row.retainedRawToolResponses),
    String(row.persistedBytes),
    String(row.activeTimers),
    String(row.activeTraceHandles),
    String(row.cacheEntries),
  ]);
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...body.map((line) => line[index]!.length),
  ));

  const printRow = (cells: string[]): void => {
    console.log(cells.map((cell, index) => cell.padEnd(widths[index]!)).join('  '));
  };

  printRow(headers);
  printRow(widths.map((width) => '-'.repeat(width)));
  body.forEach(printRow);
}
