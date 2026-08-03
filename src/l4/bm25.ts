import { tokenize } from './embeddings.js';

/**
 * Lexical retrieval. This is the half of the pipeline that gets exact identifiers right —
 * error codes, ticket ids, version strings, function names — where embeddings get you
 * NEARBY, and nearby is wrong.
 */
export class BM25Index {
  private readonly docs = new Map<string, string[]>();
  private readonly df = new Map<string, number>();
  private readonly postings = new Map<string, Set<string>>();
  private totalLength = 0;

  constructor(
    private readonly k1 = 1.5,
    private readonly b = 0.75,
  ) {}

  add(id: string, text: string): void {
    const terms = tokenize(text);
    this.docs.set(id, terms);
    this.totalLength += terms.length;
    for (const t of new Set(terms)) {
      this.df.set(t, (this.df.get(t) ?? 0) + 1);
      const set = this.postings.get(t) ?? new Set<string>();
      set.add(id);
      this.postings.set(t, set);
    }
  }

  private get avgdl(): number {
    return this.docs.size ? this.totalLength / this.docs.size : 0;
  }

  search(query: string, limit = 50): { id: string; score: number }[] {
    const qTerms = tokenize(query);
    const N = this.docs.size;
    const scores = new Map<string, number>();

    for (const term of new Set(qTerms)) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const df = this.df.get(term) ?? 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

      for (const id of posting) {
        const terms = this.docs.get(id)!;
        let tf = 0;
        for (const t of terms) if (t === term) tf++;
        const denom = tf + this.k1 * (1 - this.b + (this.b * terms.length) / this.avgdl);
        scores.set(id, (scores.get(id) ?? 0) + idf * ((tf * (this.k1 + 1)) / denom));
      }
    }

    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
