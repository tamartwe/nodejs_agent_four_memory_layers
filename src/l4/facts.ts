import { randomUUID } from 'node:crypto';
import { cosine, ToyTopicEmbedder, type Embedder } from './embeddings.js';

/**
 * The WRITE path — where "signal, not garbage" is actually decided.
 *
 * Retrieval quality is capped by what you put in. None of dedup, invalidation or decay is
 * something a vector database does for you.
 */
export interface MemoryFact {
  id: string;
  subject: string; // "user" | "project:acme" | "service:billing"
  predicate: string; // "prefers" | "deploys_with" | "owns"
  object: string;
  text: string; // natural-language rendering — this is what gets embedded
  confidence: number;
  validFrom: Date;
  /** NULL = currently true. Memory update is never a DELETE. */
  validTo: Date | null;
  supersedes: string[];
  sourceRunId: string;
  lastAccessed: Date;
}

export interface UpsertResult {
  id: string;
  action: 'inserted' | 'reinforced' | 'superseded';
  supersededIds: string[];
}

export const DEDUPE_THRESHOLD = 0.93;

export class FactStore {
  private readonly facts = new Map<string, MemoryFact>();
  private readonly vectors = new Map<string, Float32Array>();

  constructor(private readonly embedder: Embedder = new ToyTopicEmbedder()) {}

  get current(): MemoryFact[] {
    return [...this.facts.values()].filter((f) => f.validTo === null);
  }

  get all(): MemoryFact[] {
    return [...this.facts.values()];
  }

  async upsert(input: Omit<MemoryFact, 'id' | 'validTo' | 'supersedes' | 'lastAccessed'>): Promise<UpsertResult> {
    const emb = await this.embedder.embed(input.text);

    // (b) Deduplication. Agents re-derive the same fact every session. Without this the
    // index fills with 40 copies of "user prefers pnpm" and every retrieval wastes budget.
    //
    // Two tiers: the (subject, predicate, object) triple is the real primary key, so an
    // exact match is a duplicate no matter how the sentence was phrased. Cosine only
    // catches near-dupes that the triple missed.
    const duplicate =
      this.current.find(
        (f) => f.subject === input.subject && f.predicate === input.predicate && f.object === input.object,
      ) ??
      this.current.find(
        (f) =>
          f.subject === input.subject &&
          f.predicate === input.predicate &&
          cosine(emb, this.vectors.get(f.id)!) >= DEDUPE_THRESHOLD,
      );
    if (duplicate) {
      duplicate.confidence = Math.min(1, duplicate.confidence + 0.1 * input.confidence);
      duplicate.lastAccessed = new Date();
      return { id: duplicate.id, action: 'reinforced', supersededIds: [] };
    }

    // (c) Contradiction & invalidation. Same (subject, predicate), different object = the
    // world changed. CLOSE the old fact, do not delete it. Bi-temporal modelling gives you
    // current-state queries, "what did we believe on date X", and an audit trail for free.
    const conflicting = this.current.filter(
      (f) => f.subject === input.subject && f.predicate === input.predicate && f.object !== input.object,
    );
    for (const c of conflicting) c.validTo = input.validFrom;

    const fact: MemoryFact = {
      ...input,
      id: randomUUID().slice(0, 8),
      validTo: null,
      supersedes: conflicting.map((c) => c.id),
      lastAccessed: new Date(),
    };
    this.facts.set(fact.id, fact);
    this.vectors.set(fact.id, emb);

    return {
      id: fact.id,
      action: conflicting.length ? 'superseded' : 'inserted',
      supersededIds: fact.supersedes,
    };
  }

  /** (d) Decay. Not everything deserves permanence. Facts that are never retrieved and
   *  never reinforced age out — which is what keeps precision from degrading as the
   *  corpus grows. Retrieval quality is NOT monotonic in corpus size. */
  async recall(query: string, limit = 5, now = new Date()): Promise<{ fact: MemoryFact; score: number }[]> {
    const qv = await this.embedder.embed(query);
    const HALF_LIFE_MS = 30 * 864e5;

    const scored = this.current.map((fact) => {
      const relevance = cosine(qv, this.vectors.get(fact.id)!);
      const recency = Math.exp(-(now.getTime() - fact.lastAccessed.getTime()) / HALF_LIFE_MS);
      return { fact, score: 0.5 * relevance + 0.3 * recency + 0.2 * fact.confidence };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    for (const t of top) t.fact.lastAccessed = now;
    return top;
  }

  /** "What did we believe on date X" — free, once validTo exists. */
  asOf(when: Date): MemoryFact[] {
    return this.all.filter((f) => f.validFrom <= when && (f.validTo === null || f.validTo > when));
  }
}
