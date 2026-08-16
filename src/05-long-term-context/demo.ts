/**
 * FINAL DEMO — the four layers, assembled.
 *
 * The point of this demo is not that each layer works. It is that they have
 * to be assembled by ONE budget allocator. Four layers each independently
 * "reasonable" about how much context they deserve will happily produce a
 * 60k-token request between them.
 *
 * Watch three things:
 *   - the budget line: a fixed context envelope, divided on purpose
 *   - the supersession event around turn 8, where the rollback window changes
 *   - the final probe, which asks for the CURRENT value of a fact that was
 *     stated twice with different values
 *
 * run: npm run demo:5
 */
import type Anthropic from '@anthropic-ai/sdk';
import { callModel, MODEL, UsageMeter } from '../lib/client';
import { banner, kv, HeapTrace } from '../lib/report';
import { withRunScope } from '../01-working-memory/workingMemory';
import { ConversationWindow, estimateTokens } from '../02-conversation-history/window';
import { withToolState, READ_RESULT_TOOL } from '../03-tool-state/runState';
import { TOOL_DEFS, runTool } from '../lib/tools';
import { StructuredMemory, extractFacts } from './memory';

// ── the context envelope, decided once ───────────────────────────────────
const BUDGET = {
  total: 8_000,
  system: 500, // instructions
  longTerm: 1_000, // Layer 4 — retrieved facts
  history: 4_000, // Layer 2 — conversation window
  tools: 2_000, // Layer 3 — tool results in flight
  headroom: 500, // never allocate to 100%
};

const SESSION: string[] = [
  'We are rolling out firmware 3.4.2 to 1,200 gateways under change request CR-88214.',
  'The rollback window for CR-88214 is 40 minutes.',
  'Canary is 2% of each region, minimum 20 devices.',
  'Check SKU-8830 stock and tell me if it will block the rollout.',
  'Telemetry lag is about 90 seconds through Kafka into ClickHouse.',
  'What health signals should gate promotion between stages?',
  'ap-south-1 has no on-call between 02:00 and 06:00 UTC.',
  'Correction — legal came back and the rollback window for CR-88214 is now 15 minutes, not 40.',
  'Pull 600 telemetry rows for edge-a1 and tell me the dominant firmware.',
  'Does the shorter window change the canary strategy?',
  'Draft the go/no-go checklist for the on-call engineer.',
  'What should we log so the post-mortem is useful?',
];

const PROBE = 'What is the current rollback window for CR-88214, and why is it that value?';

const SYSTEM = 'You are an infrastructure ops agent. Be concise. Use tools before asserting facts.';

banner('Final demo — four layers, one budget', null);
console.log('  budget envelope:', JSON.stringify(BUDGET), '\n');

const meter = new UsageMeter('full-stack');
const trace = new HeapTrace('full-stack');
const ltm = new StructuredMemory(); // Layer 4
const win = new ConversationWindow({ // Layer 2
  budgetTokens: BUDGET.history,
  compactToTokens: Math.floor(BUDGET.history / 2),
  keepRecentTurns: 6,
});
trace.sample('start');

/** Layer 4 assembly: live facts only, ranked, truncated to its slice. */
function longTermBlock(turn: number): string | null {
  const ranked = ltm.rank(ltm.live(), { now: turn });
  const lines: string[] = [];
  let chars = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const r of ranked) {
    const line = `- ${r.subject} · ${r.predicate}: ${r.value}`;
    if (chars + line.length > BUDGET.longTerm * 3.6) break;
    lines.push(line);
    chars += line.length;
  }
  return lines.length ? `Known facts (current values only):\n${lines.join('\n')}` : null;
}

interface TurnResult {
  text: string;
  tools: { started: number; ok: number; failed: number; offloaded: number; bytesOffloaded: number };
  wrote: number;
}

async function turnHandler(turn: number, userText: string): Promise<TurnResult> {
  // Layer 1 — run scope. Everything below dies when this resolves.
  return withRunScope({ runId: `turn-${turn}`, timeoutMs: 90_000 }, (scope) => (
    // Layer 3 — tool state, owned by this run.
    withToolState(`turn-${turn}`, async (tools) => {
      win.push({ role: 'user', content: userText });
      await win.maybeCompact();

      const ltmBlock = longTermBlock(turn);
      const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }];
      if (ltmBlock) system.push({ type: 'text', text: ltmBlock });
      if (win.summary) system.push({ type: 'text', text: `Earlier:\n${win.summary}` });

      let text = '';
      for (let step = 0; step < 8; step += 1) {
        // eslint-disable-next-line no-await-in-loop
        const res = await callModel(meter, {
          model: MODEL,
          max_tokens: 700,
          system,
          tools: [...TOOL_DEFS, READ_RESULT_TOOL],
          messages: win.messages,
        });
        win.push({ role: 'assistant', content: res.content });

        if (res.stop_reason !== 'tool_use') {
          text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
          break;
        }
        const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        // eslint-disable-next-line no-await-in-loop
        const results = await Promise.all(
          uses.map((u) => tools.execute(
            u,
            async (n, i, o) => (n === 'read_result'
              ? tools.readResult(i as { handle: string; path?: string }) as Record<string, unknown>
              : runTool(n, i, o)),
            { signal: scope.signal },
          )),
        );
        win.push({ role: 'user', content: results });
      }

      // Layer 4 write path — runs on this turn, not at the end of the session.
      const facts = await extractFacts(userText, text, meter);
      const events = facts.map((f) => ltm.write(f, { runId: `turn-${turn}`, turn }));

      return { text, tools: tools.stats, wrote: events.length };
    })
  ));
}

// eslint-disable-next-line no-restricted-syntax
for (const [i, userText] of SESSION.entries()) {
  const turn = i + 1;
  const before = ltm.stats.superseded;
  // eslint-disable-next-line no-await-in-loop
  const out = await turnHandler(turn, userText);
  const mb = trace.sample(`t${turn}`);

  const superseded = ltm.stats.superseded > before;
  process.stdout.write(
    `  t${String(turn).padStart(2)}  hist=${String(estimateTokens(win.messages)).padStart(5)}tok`
      + `  ltm=${String(ltm.live().length).padStart(2)} facts`
      + `  tools=${out.tools.started}`
      + `  offload=${out.tools.offloaded}`
      + `  heap=${mb}MB${
        superseded ? '   ◀ SUPERSEDED a fact' : ''
      }\n`,
  );
}

// ── the probe: a fact that was asserted twice, with different values ──────
win.push({ role: 'user', content: PROBE });
await win.maybeCompact();
const ltmBlock = longTermBlock(SESSION.length + 1);
const probe = await callModel(meter, {
  model: MODEL,
  max_tokens: 300,
  system: [{ type: 'text', text: SYSTEM }, { type: 'text', text: ltmBlock ?? '' }],
  messages: win.messages,
});
const answer = probe.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';

console.log(`\n  probe: ${PROBE}`);
console.log(`  answer: ${answer.trim().replace(/\s+/g, ' ').slice(0, 300)}`);
console.log(`  says 15 minutes: ${/15\s*min/i.test(answer) ? 'YES ✓' : 'NO ✗'}`);
console.log(`  wrongly says 40: ${/40\s*min/i.test(answer) && !/15\s*min/i.test(answer) ? 'YES ✗' : 'no ✓'}`);

console.log('\n  audit trail for CR-88214 · rollback_window:');
// eslint-disable-next-line no-restricted-syntax
for (const r of ltm.history('CR-88214', 'rollback_window')) {
  console.log(
    `    ${r.id}  value=${r.value}  validFrom=t${r.validFrom}  validTo=${r.validTo ? `t${r.validTo}` : 'CURRENT'}`,
  );
}

trace.print();
kv({
  'facts written': ltm.stats.written,
  'facts superseded': ltm.stats.superseded,
  'duplicate writes avoided': ltm.stats.duplicates,
  'live facts retrievable': ltm.live().length,
  'window compactions': win.compactions,
  ...meter.summary(),
});
console.log(
  '\n  Append-only memory would have returned BOTH rollback windows here, and\n'
    + '  the model would have picked one. Supersession is not a storage nicety —\n'
    + '  it is the difference between memory and a pile of past sentences.\n',
);
