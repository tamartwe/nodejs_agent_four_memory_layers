import type { MemoryStore, RetrieveOptions } from './store.js';

export interface GoldenCase {
  query: string;
  relevantIds: string[];
  note?: string;
}

export interface EvalResult {
  recall: number;
  mrr: number;
  ndcg: number;
  /** The L4 -> L2 bridge metric: what fraction of the context budget you spent was worth
   *  spending. A pipeline with recall@10 = 0.9 and contextPrecision = 0.2 is HURTING your
   *  agent — it found the answer and buried it in noise. */
  contextPrecision: number;
  emptyRate: number;
}

export async function evaluate(
  store: MemoryStore,
  cases: GoldenCase[],
  opts: RetrieveOptions = {},
): Promise<EvalResult> {
  let recall = 0;
  let mrr = 0;
  let ndcg = 0;
  let contextPrecision = 0;
  let empty = 0;

  for (const c of cases) {
    const hits = await store.retrieve(c.query, { limit: 10, ...opts });
    const ids = hits.map((h) => h.chunk.docId);
    const relevant = new Set(c.relevantIds);
    if (!ids.length) empty++;

    recall += ids.filter((id) => relevant.has(id)).length / Math.max(relevant.size, 1);

    const firstRank = ids.findIndex((id) => relevant.has(id));
    mrr += firstRank >= 0 ? 1 / (firstRank + 1) : 0;

    const dcg = ids.reduce((s, id, i) => s + (relevant.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
    const idcg = [...relevant].reduce((s, _, i) => s + 1 / Math.log2(i + 2), 0);
    ndcg += idcg ? dcg / idcg : 0;

    contextPrecision += ids.length ? ids.filter((id) => relevant.has(id)).length / ids.length : 0;
  }

  const n = Math.max(cases.length, 1);
  return {
    recall: recall / n,
    mrr: mrr / n,
    ndcg: ndcg / n,
    contextPrecision: contextPrecision / n,
    emptyRate: empty / n,
  };
}

export function formatEval(label: string, r: EvalResult): string {
  const pct = (x: number) => `${(x * 100).toFixed(1).padStart(5)}%`;
  return `${label.padEnd(22)} recall ${pct(r.recall)}  mrr ${pct(r.mrr)}  ndcg ${pct(r.ndcg)}  ctxPrecision ${pct(r.contextPrecision)}`;
}
