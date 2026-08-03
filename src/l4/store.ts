import { BM25Index } from './bm25.js';
import { cosine, ToyTopicEmbedder, type Embedder } from './embeddings.js';
import { mmr, rrf, type Ranked } from './fusion.js';
import { estimateTokens } from '../l2/tokens.js';

export interface Chunk {
  id: string;
  docId: string;
  content: string;
  /** Contextual-retrieval prefix: a sentence describing where this chunk sits in its
   *  document. Resolves the pronouns and implicit subjects that make isolated chunks
   *  unembeddable. Large, cheap recall win. */
  context?: string;
  date?: string;
  validTo?: string | null;
  meta?: Record<string, unknown>;
}

export interface Hit extends Ranked {
  chunk: Chunk;
  emb: Float32Array;
  lexicalRank?: number;
  vectorRank?: number;
  cosine?: number;
}

export interface RetrieveOptions {
  limit?: number;
  candidates?: number;
  /** Returning NOTHING is a valid, often correct answer. An agent told "nothing relevant
   *  found" asks a clarifying question. An agent given three wrong documents confidently
   *  answers wrong. */
  minScore?: number;
  /** Absolute relevance floors, applied PER LEG before fusion. This matters: an RRF score
   *  carries no information about absolute relevance — rank 1 of a garbage result set
   *  still scores 1/61. The floor has to be applied to the underlying scores. */
  cosineFloor?: number;
  bm25Floor?: number;
  mode?: 'vector' | 'lexical' | 'hybrid';
  mmrLambda?: number;
  /** Doc ids already visible in the L2 window — never pay twice for the same tokens. */
  exclude?: Set<string>;
}

export const DEFAULT_MIN_SCORE = 0.012;
/** Calibrate these on YOUR eval set, per embedding model. These are for the toy embedder. */
export const DEFAULT_COSINE_FLOOR = 0.45;
export const DEFAULT_BM25_FLOOR = 4.0;

export class MemoryStore {
  private readonly chunks = new Map<string, Chunk>();
  private readonly vectors = new Map<string, Float32Array>();
  private readonly bm25 = new BM25Index();

  constructor(private readonly embedder: Embedder = new ToyTopicEmbedder()) {}

  get size(): number {
    return this.chunks.size;
  }

  async index(chunks: Chunk[], batchSize = 96): Promise<void> {
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      // Embed WITH the context prefix; store content and context separately so you can
      // render either.
      const vectors = await this.embedder.embedBatch(
        batch.map((c) => (c.context ? `${c.context}\n\n${c.content}` : c.content)),
      );
      batch.forEach((c, j) => {
        this.chunks.set(c.id, c);
        this.vectors.set(c.id, vectors[j]);
        this.bm25.add(c.id, `${c.context ?? ''} ${c.content}`);
      });
    }
  }

  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<Hit[]> {
    const {
      limit = 8,
      candidates = 50,
      minScore = DEFAULT_MIN_SCORE,
      mode = 'hybrid',
      mmrLambda = 0.7,
      cosineFloor = DEFAULT_COSINE_FLOOR,
      bm25Floor = DEFAULT_BM25_FLOOR,
      exclude,
    } = opts;

    const qv = await this.embedder.embed(query);

    // Vector leg
    const vectorList: Ranked[] = [...this.vectors.entries()]
      .filter(([id]) => this.isCurrent(id))
      .map(([id, v]) => ({ id, score: cosine(qv, v) }))
      .filter((r) => r.score >= cosineFloor)
      .sort((a, b) => b.score - a.score)
      .slice(0, candidates);

    // Lexical leg
    const lexicalList: Ranked[] = this.bm25
      .search(query, candidates)
      .filter((r) => r.score >= bm25Floor)
      .filter((r) => this.isCurrent(r.id));

    const fused =
      mode === 'vector' ? reRank(vectorList) : mode === 'lexical' ? reRank(lexicalList) : rrf([lexicalList, vectorList]);

    const vectorRankById = new Map(vectorList.map((r, i) => [r.id, i + 1]));
    const lexicalRankById = new Map(lexicalList.map((r, i) => [r.id, i + 1]));
    const cosineById = new Map(vectorList.map((r) => [r.id, r.score]));

    const pool: Hit[] = fused
      .filter((r) => r.score >= minScore)
      .filter((r) => !exclude?.has(this.chunks.get(r.id)!.docId))
      .slice(0, 30)
      .map((r) => ({
        ...r,
        chunk: this.chunks.get(r.id)!,
        emb: this.vectors.get(r.id)!,
        vectorRank: vectorRankById.get(r.id),
        lexicalRank: lexicalRankById.get(r.id),
        cosine: cosineById.get(r.id),
      }));

    if (!pool.length) return [];

    // Diversify, then cap. (In production a cross-encoder rerank goes between these two:
    // retrieve 30-50, rerank to 5-10. It is the single biggest precision win.)
    return mmr(pool, limit, mmrLambda, cosine);
  }

  private isCurrent(id: string): boolean {
    const c = this.chunks.get(id);
    return !!c && (c.validTo === undefined || c.validTo === null);
  }
}

function reRank(list: Ranked[]): Ranked[] {
  // Normalize a single-leg score onto the same 1/(k+rank) scale so minScore behaves the
  // same way regardless of mode.
  return list.map((r, i) => ({ id: r.id, score: 1 / (60 + i + 1) }));
}

/**
 * Retrieval ends in a TOKEN BUDGET, not a result set.
 *
 * Include the date and the source id in each block: the model can then reason about
 * staleness itself, and it can cite, which makes the agent auditable. Cheap; large payoff.
 */
export function pack(hits: Hit[], budget: number, maxPerDoc = 2): string {
  const out: string[] = [];
  let used = 0;
  const perDoc = new Map<string, number>();

  for (const h of hits) {
    const seen = perDoc.get(h.chunk.docId) ?? 0;
    if (seen >= maxPerDoc) continue;
    const block =
      `<doc id="${h.chunk.docId}" date="${h.chunk.date ?? 'unknown'}" score="${h.score.toFixed(4)}">\n` +
      `${h.chunk.context ? h.chunk.context + '\n' : ''}${h.chunk.content}\n</doc>`;
    const t = estimateTokens(block);
    if (used + t > budget) break;
    out.push(block);
    used += t;
    perDoc.set(h.chunk.docId, seen + 1);
  }

  if (!out.length) return '<retrieved_context>no relevant context found</retrieved_context>';
  return `<retrieved_context>\n${out.join('\n')}\n</retrieved_context>`;
}
