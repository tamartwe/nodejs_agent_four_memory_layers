import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../src/l2/tokens.js';

describe('token estimation', () => {
  it('does not use length/4 for Hebrew', () => {
    const hebrew = 'שלום עולם, זהו טקסט בעברית שנועד להדגים את בעיית ספירת הטוקנים';
    const naive = Math.ceil(hebrew.length / 4);
    expect(estimateTokens(hebrew)).toBeGreaterThan(naive * 1.8);
  });

  it('treats JSON as more token-dense than prose', () => {
    const json = JSON.stringify({ alpha: 1, beta: 'two', gamma: [3, 4, 5], delta: { e: true } });
    const prose = 'a'.repeat(json.length);
    expect(estimateTokens(json)).toBeGreaterThan(estimateTokens(prose));
  });

  it('over-estimates rather than under-estimates', () => {
    // Under-estimating costs you a 400. Over-estimating costs you a little headroom.
    expect(estimateTokens('hello world')).toBeGreaterThan('hello world'.length / 4);
  });
});
