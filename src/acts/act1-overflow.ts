import { banner, section, colors, verdict } from '../panel/dashboard.js';
import { assertWellFormed, safeCutPoints, unsafeCutPoints, TranscriptInvariantError } from '../l2/invariants.js';
import { transcriptTokens } from '../l2/tokens.js';
import type { Message } from '../l2/types.js';
import { ConversationBuffer } from '../l2/buffer.js';
import { HeuristicSummarizer } from '../l2/rollup.js';

/**
 * ACT 1 — overflow, and the SECOND 400 nobody expects.
 *
 * Fix #1 (drop the oldest N) turns a context-overflow 400 into a tool-pairing 400.
 * The invariant checker catches it locally instead of at 2am inside a retry loop.
 */
banner('ACT 1', 'Overflow -> naive truncation -> a different 400');

function buildTranscript(turns: number): Message[] {
  const msgs: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'Investigate the checkout failures.' }] }];
  for (let i = 0; i < turns; i++) {
    msgs.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'read_issue', input: { id: `ENG-${4400 + i}` } }],
    });
    msgs.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: 'x'.repeat(1200) }],
    });
    msgs.push({ role: 'assistant', content: [{ type: 'text', text: `Noted finding ${i}.` }] });
    msgs.push({ role: 'user', content: [{ type: 'text', text: 'Keep going.' }] });
  }
  return msgs;
}

const transcript = buildTranscript(12);
const WINDOW = 8_000;

section('1. the overflow');
console.log(`transcript: ${transcript.length} messages, ${transcriptTokens(transcript)} tokens, window ${WINDOW}`);
console.log(colors.red('  400 invalid_request_error: prompt is too long'));

section('2. the obvious fix: drop the oldest 10 messages');
const naive = transcript.slice(10);
try {
  assertWellFormed(naive);
  verdict(true, 'well formed');
} catch (e) {
  verdict(false, (e as TranscriptInvariantError).message);
  console.log(colors.red('\n  A DIFFERENT 400. You cut between a tool_use and its tool_result.'));
  console.log(colors.dim('  In production this shows up inside a retry loop, at 2am, under load.'));
}

section('3. safe cut points');
const cuts = safeCutPoints(transcript);
const unsafe = unsafeCutPoints(transcript);
console.log(`cuttable:     ${cuts.slice(0, 14).join(', ')} ...`);
console.log(colors.red(`NOT cuttable: ${unsafe.slice(0, 14).join(', ')} ...`) + colors.dim('   <- these carry a tool_result'));
console.log(colors.dim('  Consequence: a turn with 30 tool calls is ATOMIC. You cannot evict half of it.'));

const safe = transcript.slice(cuts.find((c) => c >= 10)!);
try {
  assertWellFormed(safe);
  verdict(true, `cut at index ${cuts.find((c) => c >= 10)}: ${safe.length} messages, ${transcriptTokens(safe)} tokens`);
} catch (e) {
  verdict(false, String(e));
}

section('4. the buffer does this for you, and archives what it drops');
const buffer = new ConversationBuffer(
  { maxTokens: WINDOW, highWater: 0.8, lowWater: 0.5, pinnedPrefix: 1, strategy: 'watermark' },
  new HeuristicSummarizer(),
);
for (const m of transcript) buffer.append(m);
const fitted = await buffer.fit();
assertWellFormed(fitted);
verdict(
  true,
  `${fitted.length} messages, ${buffer.tokens} tokens, ${buffer.evictions} eviction(s), invariants hold`,
);
console.log(colors.dim('\n  Act 2: the fix that works and costs you 7x anyway.'));
