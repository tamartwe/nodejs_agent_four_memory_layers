import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, Message } from '../l2/types.js';
import { messageTokens } from '../l2/tokens.js';
import { CACHE_READ_MULTIPLIER, CACHE_WRITE_5M_MULTIPLIER, cacheHitRate, costUsd, type Usage } from './pricing.js';

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema, e.g. from zod-to-json-schema. Required for real tool_use — the API
   *  validates arguments against it and Claude uses it to decide how to call the tool. */
  input_schema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
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
        content.push({
          type: 'tool_use',
          id: `toolu_${String(++this.counter).padStart(4, '0')}`,
          name: u.name,
          input: u.input,
        });
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

/**
 * $/MTok per model, for turning real `usage` numbers into a real dollar figure on stage.
 * Deliberately separate from pricing.ts: that file's constants drive the SIMULATED cost
 * math in act2/act5 and are pinned to the exact numbers quoted in the talk (e.g. the
 * "$0.96 vs $0.32" cache comparison) — changing them to match whatever model act0 happens
 * to call live would silently break those slides.
 */
const LIVE_PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
  'claude-opus-5': { input: 5.0, output: 25.0 },
};
const DEFAULT_LIVE_MODEL = 'claude-haiku-4-5'; // fast + cheap: a live demo should cost cents, not dollars

/**
 * Whether — and how — to turn thinking off, so a stage demo has flat, predictable
 * latency/cost instead of adaptive reasoning it doesn't need. Behavior differs by tier:
 * Fable/Mythos reject an explicit "disabled" outright (thinking is always on); Opus 5 and
 * Sonnet 5 run adaptive by default so they need it turned off explicitly; everything older
 * (Haiku 4.5, Sonnet 4.x, Opus 4.x) already has no thinking unless you opt in, so omitting
 * the field is both sufficient and safest.
 */
function thinkingParam(model: string): { type: 'disabled' } | undefined {
  if (model.includes('fable') || model.includes('mythos')) return undefined;
  if (model.includes('opus-5') || model.includes('sonnet-5')) return { type: 'disabled' };
  return undefined;
}

export interface LiveModelOptions {
  apiKey?: string;
  /** Defaults to $env:MODEL, then claude-haiku-4-5. Override for a slower/costlier/smarter run. */
  model?: string;
  maxTokens?: number;
}

/**
 * The real thing: an actual `client.messages.create` call via the official SDK. Same
 * `ModelClient` interface as ScriptedModel, so nothing in agent/loop.ts changes to use it —
 * only act0 (and whichever act you point at it) needs to pick this class over the scripted
 * one.
 *
 * Thinking is turned off wherever the model would otherwise default to it (see
 * `thinkingParam`): this act is about L2 transcript growth, not thinking budgets, and a
 * live lecture demo wants predictable latency/cost, not adaptive reasoning.
 */
export class LiveModel implements ModelClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly pricing: { input: number; output: number };

  readonly totals: Usage = {
    input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
  };

  constructor(opts: LiveModelOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set — export it to run against the real API');
    this.model = opts.model ?? process.env.MODEL ?? DEFAULT_LIVE_MODEL;
    this.maxTokens = opts.maxTokens ?? 1024;
    this.client = new Anthropic({ apiKey });
    this.pricing = LIVE_PRICING_PER_MTOK[this.model] ?? LIVE_PRICING_PER_MTOK[DEFAULT_LIVE_MODEL];
  }

  async send(req: ModelRequest): Promise<ModelResponse> {
    const messages: Anthropic.MessageParam[] = req.messages.map(({ role, content }, i) => ({
      role,
      content:
        i === (req.cacheBreakpoint ?? -1)
          ? (content.map((b, j) =>
              j === content.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b,
            ) as Anthropic.ContentBlockParam[])
          : (content as Anthropic.ContentBlockParam[]),
    }));

    const tools: Anthropic.Tool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }));

    const thinking = thinkingParam(this.model);
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      ...(thinking ? { thinking } : {}),
      system: req.system,
      messages,
      tools,
    });

    const usage: Usage = {
      input_tokens: res.usage.input_tokens ?? 0,
      cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0,
      output_tokens: res.usage.output_tokens ?? 0,
    };
    this.totals.input_tokens += usage.input_tokens;
    this.totals.cache_read_input_tokens += usage.cache_read_input_tokens;
    this.totals.cache_creation_input_tokens += usage.cache_creation_input_tokens;
    this.totals.output_tokens += usage.output_tokens;

    const content: ContentBlock[] = res.content.map((b): ContentBlock => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      // thinking/redacted_thinking/server_tool_use etc. don't apply here (thinking is
      // disabled and no server tools are declared) — render as inert text if one shows up.
      return { type: 'text', text: '' };
    });

    return {
      content,
      stopReason: res.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
      usage,
    };
  }

  private costOf(u: Usage): number {
    const inputCost =
      (u.input_tokens +
        u.cache_creation_input_tokens * CACHE_WRITE_5M_MULTIPLIER +
        u.cache_read_input_tokens * CACHE_READ_MULTIPLIER) *
      (this.pricing.input / 1e6);
    return inputCost + u.output_tokens * (this.pricing.output / 1e6);
  }

  get costUsd(): number {
    return this.costOf(this.totals);
  }

  get hitRate(): number {
    return cacheHitRate(this.totals);
  }
}
