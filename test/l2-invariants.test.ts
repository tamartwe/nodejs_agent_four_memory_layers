import { describe, it, expect } from 'vitest';
import { assertWellFormed, isWellFormed, safeCutPoints } from '../src/l2/invariants.js';
import type { Message } from '../src/l2/types.js';
import { ConversationBuffer } from '../src/l2/buffer.js';
import { HeuristicSummarizer } from '../src/l2/rollup.js';
import { transcriptTokens } from '../src/l2/tokens.js';

function transcript(turns: number): Message[] {
  const msgs: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'start' }] }];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'read_issue', input: { id: i } }] });
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(400) }] });
    msgs.push({ role: 'assistant', content: [{ type: 'text', text: `finding ${i}` }] });
    msgs.push({ role: 'user', content: [{ type: 'text', text: 'continue' }] });
  }
  return msgs;
}

describe('transcript invariants', () => {
  it('accepts a well-formed transcript', () => {
    expect(() => assertWellFormed(transcript(5))).not.toThrow();
  });

  it('rejects a tool_result with no matching tool_use', () => {
    const bad = transcript(3).slice(2);
    expect(isWellFormed(bad)).toBe(false);
  });

  it('rejects an unanswered tool_use', () => {
    const bad = transcript(3).slice(0, 2);
    expect(isWellFormed(bad)).toBe(false);
  });

  it('requires ALL parallel results, not N-1', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'x', input: {} },
          { type: 'tool_use', id: 'b', name: 'y', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
    ];
    expect(isWellFormed(msgs)).toBe(false);
  });
});

describe('safeCutPoints', () => {
  it('never proposes a cut that splits a tool pair', () => {
    const msgs = transcript(8);
    for (const cut of safeCutPoints(msgs)) {
      expect(isWellFormed(msgs.slice(cut))).toBe(true);
    }
  });
});

describe('eviction preserves invariants under pressure', () => {
  // The property test: eviction is a function that must preserve an invariant.
  it.each([600, 1500, 4000, 9000])('budget %i', async (budget) => {
    const buffer = new ConversationBuffer(
      { maxTokens: budget, highWater: 0.8, lowWater: 0.5, pinnedPrefix: 1, strategy: 'watermark' },
      new HeuristicSummarizer(),
    );
    for (const m of transcript(20)) buffer.append(m);
    const fitted = await buffer.fit();
    expect(() => assertWellFormed(fitted)).not.toThrow();
    expect(transcriptTokens(fitted)).toBeLessThanOrEqual(budget);
  });
});
