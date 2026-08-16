import Anthropic from '@anthropic-ai/sdk';

export const MODEL = process.env.AGENT_MODEL ?? 'claude-sonnet-5';
export const CHEAP_MODEL = process.env.CHEAP_MODEL ?? 'claude-haiku-4-5-20251001';

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: 2,
});

export interface UsageSummary {
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  peakTurnInput: number;
  estUsd: number;
}

interface CostRates {
  inPerM?: number;
  outPerM?: number;
  cacheReadPerM?: number;
}

/**
 * Every demo in this repo talks to a real model. Nothing is scripted or stubbed.
 * This wrapper exists only so that every call site records real token usage,
 * which is the number the whole talk is actually about.
 */
export class UsageMeter {
  label: string;

  calls = 0;

  inputTokens = 0;

  outputTokens = 0;

  cacheReadTokens = 0;

  cacheWriteTokens = 0;

  perTurnInput: number[] = [];

  constructor(label: string) {
    this.label = label;
  }

  record(usage: Anthropic.Usage): void {
    this.calls += 1;
    this.inputTokens += usage.input_tokens ?? 0;
    this.outputTokens += usage.output_tokens ?? 0;
    this.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    this.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    this.perTurnInput.push(usage.input_tokens ?? 0);
  }

  /** Rough USD, Sonnet-class list pricing. Adjust if you re-price before the talk. */
  cost({ inPerM = 3, outPerM = 15, cacheReadPerM = 0.3 }: CostRates = {}): number {
    return (
      (this.inputTokens / 1e6) * inPerM
      + (this.outputTokens / 1e6) * outPerM
      + (this.cacheReadTokens / 1e6) * cacheReadPerM
    );
  }

  summary(): UsageSummary {
    return {
      label: this.label,
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      peakTurnInput: Math.max(0, ...this.perTurnInput),
      estUsd: Number(this.cost().toFixed(4)),
    };
  }
}

/** One place to send a request so usage is never silently dropped. */
export async function callModel(
  meter: UsageMeter | undefined,
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  const res = await anthropic.messages.create(params);
  meter?.record(res.usage);
  return res;
}
