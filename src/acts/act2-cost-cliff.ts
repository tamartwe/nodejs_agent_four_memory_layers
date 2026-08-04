import { banner, section, colors, stepLine } from '../panel/dashboard.js';
import { withRun } from '../l1/run-context.js';
import { ScriptedModel } from '../model/client.js';
import { SpillStore } from '../l3/spill.js';
import { buildTools } from '../tools/index.js';
import { runAgent } from '../agent/loop.js';
import { investigationScript } from './script.js';
import { BASE_INPUT_PER_MTOK, CACHE_READ_MULTIPLIER, CACHE_WRITE_5M_MULTIPLIER } from '../model/pricing.js';

/**
 * ACT 2 — the cost cliff.
 *
 * Eviction now works. Same conversation, same model, same answers. The only difference
 * is WHEN we evict, and it is worth ~7x.
 */
banner('ACT 2', 'Same conversation, same answers, 7x the bill');

console.log(
  `cache multipliers: read ${CACHE_READ_MULTIPLIER}x, 5-min write ${CACHE_WRITE_5M_MULTIPLIER}x, ` +
    `base input $${BASE_INPUT_PER_MTOK}/MTok`,
);
console.log(colors.dim('It is a PREFIX match: change one token near the front and everything after it is a miss.\n'));

const MAX_TOKENS = 24_000;
const STEPS = 60;

async function run(strategy: 'per-turn' | 'watermark') {
  const spill = new SpillStore();
  const tools = buildTools({ spill });
  const model = new ScriptedModel(investigationScript(STEPS));

  await withRun({ maxTokens: MAX_TOKENS, timeoutMs: 60_000 }, async (ctx) => {
    await runAgent(ctx, 'Why do checkout requests fail?', {
      system: 'You are a repo archaeologist. Investigate methodically.',
      model,
      tools,
      spill,
      retrieval: false,
      maxSteps: STEPS + 2,
      buffer: { maxTokens: MAX_TOKENS, highWater: 0.8, lowWater: 0.5, pinnedPrefix: 1, strategy },
      onStep: (info) => stepLine(info, MAX_TOKENS),
    });
  });

  return model;
}

section('A. evict one turn every turn  (the sliding window everyone writes first)');
const a = await run('per-turn');

section('B. high/low watermark  (evict at 80%, down to 50%)');
const b = await run('watermark');

section('the bill');
const row = (label: string, m: typeof a) =>
  `${label.padEnd(28)} cache hit ${(m.hitRate * 100).toFixed(1).padStart(5)}%   ` +
  `read ${String(m.totals.cache_read_input_tokens).padStart(7)}   ` +
  `write ${String(m.totals.cache_creation_input_tokens).padStart(7)}   ` +
  `$${m.costUsd.toFixed(4)}`;

console.log(row('A: evict every turn', a));
console.log(row('B: watermark', b));
console.log('');
console.log(
  colors.bold(`  ${(a.costUsd / Math.max(b.costUsd, 1e-9)).toFixed(1)}x cheaper, from one scheduling decision.`),
);
console.log(colors.dim('  Nothing about the model changed. Same transcript, same tools, same answers.'));
console.log(colors.dim('\n  Corollary: injecting retrieved documents at the TOP of the prompt does this to you'));
console.log(colors.dim('  on every single turn. Retrieval output belongs below the cache breakpoint.'));
