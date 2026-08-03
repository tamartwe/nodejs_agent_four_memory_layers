import { fmtBytes, snapshot } from '../l1/metrics.js';
import type { StepInfo } from '../agent/loop.js';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

export const colors = c;

export function banner(act: string, title: string): void {
  const line = '='.repeat(78);
  console.log(`\n${c.cyan(line)}`);
  console.log(`${c.bold(act)}  ${title}`);
  console.log(`${c.cyan(line)}\n`);
}

export function section(title: string): void {
  console.log(`\n${c.bold('--- ' + title + ' ' + '-'.repeat(Math.max(0, 70 - title.length)))}\n`);
}

/** The metrics panel is the real star of the demo: it makes the failures VISIBLE. */
export function stepLine(info: StepInfo, maxTokens: number): void {
  const pct = info.bufferTokens / maxTokens;
  const bar = renderBar(pct, 20);
  const hit = (info.hitRate * 100).toFixed(0).padStart(3);
  const hitColor = info.hitRate > 0.5 ? c.green : info.hitRate > 0.2 ? c.yellow : c.red;
  console.log(
    `step ${String(info.step).padStart(2)} ${bar} ${String(info.bufferTokens).padStart(6)} tok  ` +
      `cache ${hitColor(hit + '%')}  $${info.costUsd.toFixed(4)}  ` +
      `evict ${info.evictions}  inflight ${info.inflight}  ` +
      (info.orphaned ? c.red(`orphaned ${info.orphaned}`) : c.dim('orphaned 0')) +
      c.dim(`  [${info.toolNames.join(', ')}]`),
  );
}

export function renderBar(pct: number, width: number): string {
  const filled = Math.min(width, Math.round(pct * width));
  const body = '#'.repeat(filled) + '.'.repeat(width - filled);
  return pct > 0.9 ? c.red(`[${body}]`) : pct > 0.7 ? c.yellow(`[${body}]`) : c.green(`[${body}]`);
}

export function heapLine(label: string): void {
  const s = snapshot();
  console.log(
    `${label.padEnd(22)} rss ${fmtBytes(s.rss).padStart(9)}  heapUsed ${fmtBytes(s.heapUsed).padStart(9)}  ` +
      `arrayBuffers ${fmtBytes(s.arrayBuffers).padStart(9)}  loop p99 ${s.loopP99Ms.toFixed(1)}ms`,
  );
}

export function verdict(pass: boolean, message: string): void {
  console.log(pass ? c.green(`  PASS  ${message}`) : c.red(`  FAIL  ${message}`));
}
