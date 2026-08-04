import type { ContentBlock, Message } from './types.js';

/**
 * Chars-per-token, measured on representative corpora.
 *
 * The `length / 4` heuristic every tutorial uses is calibrated on ENGLISH PROSE.
 * Hebrew, Arabic and CJK tokenize at roughly 1-2 characters per token. Budget a
 * Hebrew-language product with /4 and you overflow the window by 2-3x — and then blame
 * the model for hallucinating when in fact you are being truncated.
 */
export const CHARS_PER_TOKEN = {
  ascii: 4.0,
  code: 3.0,
  json: 2.8,
  cjkHeb: 1.6,
  base64: 1.4,
} as const;

const BLOCK_OVERHEAD = 8;
const MESSAGE_OVERHEAD = 6;

export function estimateTokens(textValue: string): number {
  if (!textValue) return 0;
  // Deliberately starts at \u0000: anything outside Latin-1 + Latin Extended-A counts as
  // "non-Latin" for this heuristic, control characters included — narrowing the range
  // would change the ratio it computes.
  // eslint-disable-next-line no-control-regex
  const nonLatin = (textValue.match(/[^\u0000-\u024F]/g) ?? []).length;
  const nonLatinRatio = nonLatin / textValue.length;
  const looksJson = /^\s*[[{]/.test(textValue) && textValue.includes('":');
  const looksBase64 = textValue.length > 256 && /^[A-Za-z0-9+/=\s]+$/.test(textValue.slice(0, 256));

  let cpt: number = CHARS_PER_TOKEN.ascii;
  if (looksBase64) cpt = CHARS_PER_TOKEN.base64;
  else if (nonLatinRatio > 0.2) cpt = CHARS_PER_TOKEN.cjkHeb;
  else if (looksJson) cpt = CHARS_PER_TOKEN.json;
  else if (/[;{}()=>]/.test(textValue)) cpt = CHARS_PER_TOKEN.code;

  return Math.ceil(textValue.length / cpt) + BLOCK_OVERHEAD;
}

export function blockTokens(b: ContentBlock): number {
  switch (b.type) {
    case 'text':
      return estimateTokens(b.text);
    case 'tool_use':
      return estimateTokens(JSON.stringify(b.input)) + estimateTokens(b.name);
    case 'tool_result':
      return estimateTokens(b.content);
    default:
      throw new Error(`unknown content block type: ${JSON.stringify(b)}`);
  }
}

export function messageTokens(m: Message): number {
  return m.content.reduce((s, b) => s + blockTokens(b), MESSAGE_OVERHEAD);
}

export function transcriptTokens(ms: Message[]): number {
  return ms.reduce((s, m) => s + messageTokens(m), 0);
}
