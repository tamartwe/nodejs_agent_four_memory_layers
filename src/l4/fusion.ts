/**
 * Reciprocal Rank Fusion.
 *
 * BM25 scores and cosine distances live on incomparable scales, and both drift with
 * corpus and model. RANK is scale-free. 1/(k+rank) with k=60 is the standard, needs no
 * tuning, and beats hand-tuned score blending in practice. One line of arithmetic instead
 * of a calibration job.
 */
export const RRF_K = 60;

export interface Ranked {
  id: string;
  score: number;
}

export function rrf(lists: Ranked[][], k = RRF_K): Ranked[] {
  const fused = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, index) => {
      fused.set(item.id, (fused.get(item.id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...fused.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Maximal Marginal Relevance: stop retrieving the same paragraph five times.
 * Trades relevance against novelty.
 */
export function mmr<T extends { id: string; emb: Float32Array; score: number }>(
  candidates: T[],
  k: number,
  lambda = 0.7,
  sim: (a: Float32Array, b: Float32Array) => number,
): T[] {
  const selected: T[] = [];
  const pool = [...candidates];

  while (selected.length < k && pool.length) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const redundancy = selected.length ? Math.max(...selected.map((s) => sim(pool[i].emb, s.emb))) : 0;
      const val = lambda * pool[i].score - (1 - lambda) * redundancy;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    selected.push(pool.splice(bestIdx, 1)[0]);
  }
  return selected;
}
