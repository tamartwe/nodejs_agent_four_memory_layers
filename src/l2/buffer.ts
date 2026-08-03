import type { Message } from './types.js';
import { assertWellFormed, safeCutPoints } from './invariants.js';
import { messageTokens } from './tokens.js';
import { emptyRollup, renderRollup, type Rollup, type Summarizer } from './rollup.js';

export class ContextOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextOverflowError';
  }
}

export interface Archive {
  put(messages: Message[]): Promise<void>;
  previousRollup(): Promise<Rollup | null>;
  saveRollup(r: Rollup): Promise<void>;
  all(): Promise<Message[]>;
}

/** Default archive: raw turns are never destroyed, only demoted. Act 5 swaps in the L4 store. */
export class InMemoryArchive implements Archive {
  private readonly raw: Message[] = [];
  private rollup: Rollup | null = null;

  async put(messages: Message[]): Promise<void> {
    this.raw.push(...messages);
  }
  async previousRollup(): Promise<Rollup | null> {
    return this.rollup;
  }
  async saveRollup(r: Rollup): Promise<void> {
    this.rollup = r;
  }
  async all(): Promise<Message[]> {
    return this.raw;
  }
}

export interface BufferOptions {
  /** Model context minus reserved output. */
  maxTokens: number;
  /** Start evicting at this fraction. */
  highWater: number;
  /** Evict down to this fraction. */
  lowWater: number;
  /** Leading messages never evicted (task spec, few-shot). */
  pinnedPrefix: number;
  /**
   * The knob the whole talk turns on.
   *  'per-turn'  — evict one turn every turn. Prefix changes constantly -> 0% cache hits.
   *  'watermark' — do nothing until highWater, then evict to lowWater. Prefix is stable
   *                between evictions -> cache hits at 0.1x.
   */
  strategy: 'per-turn' | 'watermark' | 'none';
}

export const DEFAULT_BUFFER_OPTIONS: BufferOptions = {
  maxTokens: 32_000,
  highWater: 0.8,
  lowWater: 0.5,
  pinnedPrefix: 1,
  strategy: 'watermark',
};

/**
 * The rollup has to bridge the seam without breaking role alternation — and the API
 * requires the transcript to start with a user message, so a cut at an assistant index
 * cannot simply be spliced in.
 */
export function bridgeMessages(
  prefixLastRole: 'user' | 'assistant' | null,
  suffixFirstRole: 'user' | 'assistant',
  summary: string,
): Message[] {
  const ack = 'Understood — continuing from that summary.';
  const asUser = (t: string): Message => ({ role: 'user', content: [{ type: 'text', text: t }], meta: { kind: 'rollup' } });
  const asAssistant = (t: string): Message => ({ role: 'assistant', content: [{ type: 'text', text: t }], meta: { kind: 'rollup' } });

  if (prefixLastRole === 'user') {
    return suffixFirstRole === 'user' ? [asAssistant(summary)] : [asAssistant(summary), asUser(ack)];
  }
  // prefix is empty or ends with an assistant turn: the bridge must start with a user message
  return suffixFirstRole === 'user' ? [asUser(summary), asAssistant(ack)] : [asUser(summary)];
}

export class ConversationBuffer {
  private messages: Message[] = [];
  /** WeakMap keyed by the message object: entries vanish when messages are evicted.
   *  No manual cleanup, no leak. A nice callback to L1. */
  private readonly tokenCache = new WeakMap<Message, number>();
  private currentRollup: Rollup | null = null;

  evictions = 0;
  lastEvictedTokens = 0;

  constructor(
    private readonly opts: BufferOptions = DEFAULT_BUFFER_OPTIONS,
    private readonly summarizer?: Summarizer,
    private readonly archive: Archive = new InMemoryArchive(),
  ) {}

  append(msg: Message): void {
    this.messages.push(msg);
  }

  get length(): number {
    return this.messages.length;
  }

  snapshot(): Message[] {
    return this.messages;
  }

  get tokens(): number {
    let total = 0;
    for (const m of this.messages) {
      let t = this.tokenCache.get(m);
      if (t === undefined) {
        t = messageTokens(m);
        this.tokenCache.set(m, t);
      }
      total += t;
    }
    return total;
  }

  private tokensFrom(index: number): number {
    let total = 0;
    for (let i = index; i < this.messages.length; i++) {
      const m = this.messages[i];
      let t = this.tokenCache.get(m);
      if (t === undefined) {
        t = messageTokens(m);
        this.tokenCache.set(m, t);
      }
      total += t;
    }
    return total;
  }

  /**
   * Called before each model request. A cheap no-op on most turns under 'watermark'
   * — that IS the design.
   */
  async fit(): Promise<Message[]> {
    if (this.opts.strategy === 'none') return this.messages;

    const used = this.tokens;
    const target = this.opts.maxTokens * this.opts.lowWater;

    // The ONLY difference between the two strategies: when they re-trim.
    //   watermark — nothing happens until 80% of the window, then trim to 50%.
    //               The prefix is byte-identical between evictions, so it stays cached.
    //   per-turn  — trim back to 50% on EVERY turn. The front of the array moves every
    //               turn, so the prefix is a cache miss every turn.
    if (this.opts.strategy === 'watermark' && used <= this.opts.maxTokens * this.opts.highWater) {
      return this.messages; // hot path: prefix unchanged, cache intact
    }
    if (this.opts.strategy === 'per-turn' && used <= target) {
      return this.messages;
    }

    // The rollup block occupies the slot right after the pinned prefix. It must be
    // excluded from the eviction range, or eviction converges to repeatedly evicting and
    // re-inserting its OWN summary and stops dropping real history.
    const bridgeStart = this.opts.pinnedPrefix;
    let bridgeEnd = bridgeStart;
    while (bridgeEnd < this.messages.length && this.messages[bridgeEnd].meta?.kind === 'rollup') bridgeEnd++;

    const cuts = safeCutPoints(this.messages).filter((i) => i > bridgeEnd);
    if (!cuts.length) {
      if (used > this.opts.maxTokens) {
        throw new ContextOverflowError(
          `no safe cut point: a single turn is ${used} tokens, over the ${this.opts.maxTokens} budget. ` +
            `This is L3's problem — spill the tool result (see src/l3/spill.ts).`,
        );
      }
      return this.messages;
    }

    let chosen = -1;
    for (const cut of cuts) {
      if (this.tokensFrom(cut) <= target) {
        chosen = cut;
        break;
      }
    }
    if (chosen < 0) chosen = cuts[cuts.length - 1];

    const evicted = this.messages.slice(bridgeEnd, chosen);
    if (!evicted.length) return this.messages;

    this.lastEvictedTokens = evicted.reduce((s, m) => s + (this.tokenCache.get(m) ?? messageTokens(m)), 0);
    this.evictions++;

    // 1. archive RAW before summarizing — summaries are lossy, raw is not, and this makes
    //    the loss recoverable via L4.
    await this.archive.put(evicted);

    // 2. summarize from RAW, merging into the previous structured rollup.
    let summary = '[earlier conversation omitted]';
    if (this.summarizer) {
      const previous = this.currentRollup ?? (await this.archive.previousRollup());
      this.currentRollup = await this.summarizer.rollup(evicted, previous ?? emptyRollup());
      await this.archive.saveRollup(this.currentRollup);
      summary = renderRollup(this.currentRollup);
    }

    // 3. splice, bridging the seam so roles still alternate and the transcript still
    //    starts with a user message.
    const prefixLastRole = bridgeStart > 0 ? this.messages[bridgeStart - 1].role : null;
    const suffixFirstRole = this.messages[chosen].role;
    this.messages = [
      ...this.messages.slice(0, bridgeStart),
      ...bridgeMessages(prefixLastRole, suffixFirstRole, summary),
      ...this.messages.slice(chosen),
    ];

    assertWellFormed(this.messages);
    return this.messages;
  }

  /** Doc ids already visible in the window — used to dedupe L4 retrieval against L2. */
  docIdsMentioned(): Set<string> {
    const ids = new Set<string>();
    for (const m of this.messages) {
      for (const b of m.content) {
        const s = b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content : '';
        for (const match of s.matchAll(/\b(ENG-\d+|[\w./-]+\.(?:ts|md|sh|json))\b/g)) ids.add(match[1]);
      }
    }
    return ids;
  }
}
