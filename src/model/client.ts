import type { ContentBlock, Message } from '../l2/types.js';
import { messageTokens } from '../l2/tokens.js';
import { cacheHitRate, costUsd, type Usage } from './pricing.js';

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: { name: string; description: string }[];
  /** Index of the last message covered by the cache breakpoint. */
  cacheBreakpoint?: number;
}

export interface ModelResponse {
  content: ContentBlock[];
  stopReason: 'end_turn' | 'tool_use';
  usage: Usage;
}

export interface ModelClient {
  send(req: ModelRequest): Promise<ModelResponse>;
  readonly totals: Usage;
  readonly costUsd: number;
  readonly hitRate: number;
}

/**
 * Honest offline cache simulation.
 *
 * We hash each message and compare against the previous request's hashes to find the
 * longest common PREFIX. That prefix is billed as a cache read; everything after it, up
 * to the breakpoint, is billed as a cache write. This is the same arithmetic the real API
 * does, which is why act2 produces a real number and not a slide claim.
 */
export class CacheSimulator {
  private previous: string[] = [];
  private previousSystemHash = '';

  measure(req: ModelRequest): { cacheRead: number; cacheWrite: number; fresh: number } {
    const systemHash = hash(req.system + JSON.stringify(req.tools));
    const hashes = req.messages.map((m) => hash(JSON.stringify(m.content)));
    const tokens = req.messages.map(messageTokens);
    const systemTokens = Math.ceil((req.system.length + JSON.stringify(req.tools).length) / 4);

    const breakpoint = req.cacheBreakpoint ?? req.messages.length - 1;

    let common = 0;
    if (systemHash === this.previousSystemHash) {
      while (common < hashes.length && common < this.previous.length && hashes[common] === this.previous[common]) {
        common++;
      }
    }

    const cacheableUpTo = Math.min(breakpoint + 1, hashes.length);
    const readMessages = Math.min(common, cacheableUpTo);

    let cacheRead = systemHash === this.previousSystemHash ? systemTokens : 0;
    let cacheWrite = systemHash === this.previousSystemHash ? 0 : systemTokens;
    let fresh = 0;

    for (let i = 0; i < hashes.length; i++) {
      if (i < readMessages) cacheRead += tokens[i];
      else if (i < cacheableUpTo) cacheWrite += tokens[i];
      else fresh += tokens[i];
    }

    this.previous = hashes;
    this.previousSystemHash = systemHash;
    return { cacheRead, cacheWrite, fresh };
  }
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export interface ScriptStep {
  /** Emit these tool calls. */
  toolUses?: { name: string; input: unknown }[];
  /** Or finish the turn with this text. */
  text?: string;
}

/**
 * Deterministic scripted model. Recommended mode for live demos: offline, reproducible,
 * free, and it makes the cost comparison instant instead of a 40-turn wait.
 */
export class ScriptedModel implements ModelClient {
  private step = 0;
  private counter = 0;
  private readonly cache = new CacheSimulator();
  readonly totals: Usage = {
    input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
  };

  constructor(private readonly script: ScriptStep[]) {}

  async send(req: ModelRequest): Promise<ModelResponse> {
    const { cacheRead, cacheWrite, fresh } = this.cache.measure(req);

    const s = this.script[Math.min(this.step, this.script.length - 1)];
    this.step++;

    const content: ContentBlock[] = [];
    if (s.toolUses?.length) {
      for (const u of s.toolUses) {
        content.push({ type: 'tool_use', id: `toolu_${String(++this.counter).padStart(4, '0')}`, name: u.name, input: u.input });
      }
    } else {
      content.push({ type: 'text', text: s.text ?? 'Done.' });
    }

    const output = Math.ceil(JSON.stringify(content).length / 4);
    this.totals.cache_read_input_tokens += cacheRead;
    this.totals.cache_creation_input_tokens += cacheWrite;
    this.totals.input_tokens += fresh;
    this.totals.output_tokens += output;

    return {
      content,
      stopReason: s.toolUses?.length ? 'tool_use' : 'end_turn',
      usage: {
        input_tokens: fresh,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
        output_tokens: output,
      },
    };
  }

  get costUsd(): number {
    return costUsd(this.totals);
  }
  get hitRate(): number {
    return cacheHitRate(this.totals);
  }
  get exhausted(): boolean {
    return this.step >= this.script.length;
  }
}

/** The real thing. Requires ANTHROPIC_API_KEY. Same interface, so the acts do not change. */
export class LiveModel implements ModelClient {
  readonly totals: Usage = {
    input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
  };

  constructor(
    private readonly apiKey = process.env.ANTHROPIC_API_KEY ?? '',
    private readonly model = process.env.MODEL ?? 'claude-sonnet-4-6',
  ) {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  }

  async send(req: ModelRequest): Promise<ModelResponse> {
    const messages = req.messages.map(({ role, content }, i) => ({
      role,
      content:
        i === (req.cacheBreakpoint ?? -1)
          ? content.map((b, j) => (j === content.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b))
          : content,
    }));

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: this.model, max_tokens: 2048, system: req.system, messages }),
    });
    if (!res.ok) throw new Error(`model error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as any;

    this.totals.input_tokens += data.usage?.input_tokens ?? 0;
    this.totals.cache_read_input_tokens += data.usage?.cache_read_input_tokens ?? 0;
    this.totals.cache_creation_input_tokens += data.usage?.cache_creation_input_tokens ?? 0;
    this.totals.output_tokens += data.usage?.output_tokens ?? 0;

    return {
      content: data.content as ContentBlock[],
      stopReason: data.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
      usage: {
        input_tokens: data.usage?.input_tokens ?? 0,
        cache_read_input_tokens: data.usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: data.usage?.cache_creation_input_tokens ?? 0,
        output_tokens: data.usage?.output_tokens ?? 0,
      },
    };
  }

  get costUsd(): number {
    return costUsd(this.totals);
  }
  get hitRate(): number {
    return cacheHitRate(this.totals);
  }
}
