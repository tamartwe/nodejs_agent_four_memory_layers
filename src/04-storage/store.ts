import { embed, cosine } from '../lib/embed';
import { callModel, CHEAP_MODEL, type UsageMeter } from '../lib/client';
import type { Doc, DocKind } from './corpus';

/**
 * Everything here is doable in one Postgres instance:
 *   vector search  → pgvector  (<=> cosine operator, HNSW index)
 *   keyword search → tsvector + ts_rank, or pg_trgm for fuzzy identifiers
 *   fusion         → a CTE per arm and a reciprocal-rank JOIN
 *
 * A dedicated vector DB buys you scale past ~10M vectors and specialised
 * filtered ANN. It does not buy you relevance. Relevance is the five steps
 * below, and none of them are the database's job.
 */

export interface ScoredHit {
  id: string;
  text: string;
  kind: DocKind;
  score: number;
}

export interface RrfHit extends ScoredHit {
  rrf: number;
}

/**
 * Postgres strips these in to_tsvector('english', ...). Skipping this step is
 * why hand-rolled BM25 demos look better than they are — without it, "a",
 * "not" and "after" carry rank.
 */
const STOPWORDS = new Set(
  ('a an the and or but if then than that this these those is are was were be been being '
   + 'do does did doing have has had having will would shall should can could may might must '
   + 'to of in on at by for with about into over after before between out up down off no not '
   + 'it its they them their we our you your i me my he she his her as so such what which who '
   + 'when where why how all any both each more most other some only own same too very just now'
  ).split(' '),
);

export class MemoryStore {
  docs: Doc[];

  vectors = new Map<string, number[]>();

  df = new Map<string, number>(); // document frequency, for BM25

  tokenized = new Map<string, string[]>();

  avgLen = 0;

  constructor(docs: Doc[]) {
    this.docs = docs;
    this.#buildLexicalIndex();
  }

  async init(): Promise<this> {
    const vecs = await embed(this.docs.map((d) => d.text), 'document');
    this.docs.forEach((d, i) => this.vectors.set(d.id, vecs[i] as number[]));
    return this;
  }

  // ── lexical arm ─────────────────────────────────────────────────────────
  #tokens(text: string): string[] {
    return (text.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? []).filter(
      (t) => !STOPWORDS.has(t),
    );
  }

  #buildLexicalIndex(): void {
    this.docs.forEach((d) => {
      const toks = this.#tokens(d.text);
      this.tokenized.set(d.id, toks);
      new Set(toks).forEach((t) => this.df.set(t, (this.df.get(t) ?? 0) + 1));
    });
    this.avgLen = [...this.tokenized.values()].reduce((n, t) => n + t.length, 0) / this.docs.length;
  }

  /** Textbook BM25. In Postgres this is ts_rank_cd; here it is 12 lines. */
  bm25(query: string, { k = 10 }: { k?: number } = {}): ScoredHit[] {
    const n = this.docs.length;
    const qToks = this.#tokens(query);
    const scored = this.docs.map((d) => {
      const toks = this.tokenized.get(d.id) as string[];
      const len = toks.length;
      let score = 0;
      new Set(qToks).forEach((q) => {
        const tf = toks.filter((t) => t === q).length;
        if (!tf) return;
        const df = this.df.get(q) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += idf * ((tf * 2.5) / (tf + 1.5 * (1 - 0.75 + (0.75 * len) / this.avgLen)));
      });
      return {
        id: d.id, text: d.text, kind: d.kind, score,
      };
    });
    return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  }

  // ── vector arm ──────────────────────────────────────────────────────────
  async vectorSearch(query: string, { k = 10 }: { k?: number } = {}): Promise<ScoredHit[]> {
    const qv = await embed(query, 'query');
    return this.docs
      .map((d) => ({
        id: d.id, text: d.text, kind: d.kind, score: cosine(qv, this.vectors.get(d.id) as number[]),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  // ── fusion ──────────────────────────────────────────────────────────────
  /**
   * Reciprocal Rank Fusion. Uses RANK, not score, which is why it works:
   * cosine similarity and BM25 are not on the same scale and never will be.
   */
  static rrf(lists: ScoredHit[][], { k = 60 }: { k?: number } = {}): RrfHit[] {
    const acc = new Map<string, RrfHit>();
    lists.forEach((list) => {
      list.forEach((hit, rank) => {
        const cur = acc.get(hit.id) ?? { ...hit, rrf: 0 };
        cur.rrf += 1 / (k + rank + 1);
        acc.set(hit.id, cur);
      });
    });
    return [...acc.values()].sort((a, b) => b.rrf - a.rrf);
  }

  async hybrid(
    query: string,
    { k = 10 }: { k?: number } = {},
  ): Promise<{ fused: RrfHit[]; vec: ScoredHit[]; lex: ScoredHit[] }> {
    const [vec, lex] = await Promise.all([
      this.vectorSearch(query, { k }),
      Promise.resolve(this.bm25(query, { k })),
    ]);
    return { fused: MemoryStore.rrf([vec, lex]), vec, lex };
  }
}

/**
 * GATE. The single highest-leverage thing in Layer 4, and the one almost
 * nobody implements. Decides WHETHER to retrieve at all.
 *
 * Costs ~150 Haiku tokens. Saves 4,000 Sonnet tokens of noise on every query
 * whose answer is not in the store — and, more importantly, stops the model
 * from confidently answering from irrelevant context.
 */
export async function shouldRetrieve(query: string, meter?: UsageMeter): Promise<boolean> {
  const res = await callModel(meter, {
    model: CHEAP_MODEL,
    max_tokens: 12,
    system:
      'You decide whether an ops assistant needs to search its long-term memory '
      + 'to answer a question. The memory contains: firmware rollout decisions, '
      + 'incident runbooks, fleet topology, inventory and change requests. '
      + 'It does NOT contain: billing, HR, source code, or anything about cloud spend. '
      + 'Answer with exactly one word: SEARCH or SKIP.',
    messages: [{ role: 'user', content: query }],
  });
  const text = res.content.find((b) => b.type === 'text')?.text ?? '';
  return /SEARCH/i.test(text);
}

/**
 * RERANK. Fusion gets you good candidates. Reranking decides which of them
 * are actually about the question. Returns only what survives.
 */
export async function rerank(
  query: string,
  candidates: RrfHit[],
  { keep }: { keep: number },
  meter?: UsageMeter,
): Promise<RrfHit[]> {
  if (!candidates.length) return [];
  const numbered = candidates
    .map((c, i) => `[${i}] ${c.text}`)
    .join('\n');
  const res = await callModel(meter, {
    model: CHEAP_MODEL,
    max_tokens: 60,
    system:
      'You are a reranker. Given a question and numbered passages, return the '
      + 'indices of ONLY the passages that directly help answer the question, '
      + 'best first, as a JSON array of integers. If none help, return []. '
      + 'Be strict — a passage that is merely on the same topic does not help. '
      + 'Output only the array.',
    messages: [{ role: 'user', content: `Question: ${query}\n\nPassages:\n${numbered}` }],
  });
  const text = res.content.find((b) => b.type === 'text')?.text ?? '[]';
  let idx: number[] = [];
  try {
    idx = JSON.parse(text.match(/\[.*\]/s)?.[0] ?? '[]') as number[];
  } catch {
    idx = [];
  }
  return idx
    .filter((i) => Number.isInteger(i) && candidates[i])
    .slice(0, keep)
    .map((i) => candidates[i] as RrfHit);
}
