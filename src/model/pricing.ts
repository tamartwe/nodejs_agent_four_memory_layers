/**
 * Claude API cache multipliers, relative to the base input rate.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 *
 *   cache read        0.10x   (a hit costs 10% of standard input)
 *   5-minute write    1.25x   -> breaks even after ONE read
 *   1-hour write      2.00x   -> breaks even after TWO reads
 *
 * The cache covers the whole prefix — tools, then system, then messages — up to and
 * including the block marked with cache_control. It is a PREFIX match: change one token
 * near the front and everything after it is a miss.
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;

/** Base input $/MTok. Adjust to whatever model you are quoting on stage. */
export const BASE_INPUT_PER_MTOK = 3.0;
export const BASE_OUTPUT_PER_MTOK = 15.0;

export interface Usage {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
}

export function costUsd(u: Usage): number {
  const inputCost =
    (u.input_tokens + u.cache_creation_input_tokens * CACHE_WRITE_5M_MULTIPLIER + u.cache_read_input_tokens * CACHE_READ_MULTIPLIER) *
    (BASE_INPUT_PER_MTOK / 1e6);
  return inputCost + u.output_tokens * (BASE_OUTPUT_PER_MTOK / 1e6);
}

export function cacheHitRate(u: Usage): number {
  const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
  return total ? u.cache_read_input_tokens / total : 0;
}
