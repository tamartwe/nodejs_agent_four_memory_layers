/**
 * LAYER 4 — LONG-TERM STORAGE · AFTER
 *
 * Same corpus, same queries, same model. Five things added, in this order of
 * impact:
 *
 *   1. WRITE-TIME FILTER   never embed chatter. Fewer, denser rows.
 *   2. GATE                decide whether to retrieve at all (Haiku, ~12 tokens out)
 *   3. HYBRID + RRF        BM25 catches CR-88214; vectors catch the paraphrase
 *   4. RERANK + FLOOR      keep 3 that survive scrutiny, not 10 that ranked
 *   5. BUDGET              a hard token ceiling on retrieved context
 *
 * The measurable claim: signal ratio goes from single digits to most of what
 * is injected, injected tokens drop by roughly an order of magnitude, and Q3
 * gets an honest "I do not have that" instead of a confident fabrication.
 *
 * run: npm run demo:4:after
 */
import { callModel, MODEL, UsageMeter } from '../lib/client';
import { banner, kv } from '../lib/report';
import { DOCS, QUERIES } from './corpus';
import {
  MemoryStore, shouldRetrieve, rerank, type RrfHit,
} from './store';

const CANDIDATES = 8;
const KEEP = 3;
const CONTEXT_BUDGET_CHARS = 1_200;

banner('Layer 4 — long-term storage', 'after');
const meter = new UsageMeter('L4-after');

// ── 1. write-time filter ─────────────────────────────────────────────────
const durable = DOCS.filter((d) => d.kind !== 'chatter');
console.log(
  `  write-time filter: ${DOCS.length} raw items → ${durable.length} durable records `
    + `(${DOCS.length - durable.length} pieces of chatter never embedded)\n`,
);
const store = await new MemoryStore(durable).init();

let injectedTotal = 0;
let usefulTotal = 0;

// eslint-disable-next-line no-restricted-syntax
for (const q of QUERIES) {
  // ── 2. gate ────────────────────────────────────────────────────────────
  // eslint-disable-next-line no-await-in-loop
  const gate = await shouldRetrieve(q.text, meter);

  let kept: RrfHit[] = [];
  let lexTop = '—';
  let vecTop = '—';

  if (gate) {
    // ── 3. hybrid + RRF ──────────────────────────────────────────────────
    // eslint-disable-next-line no-await-in-loop
    const { fused, vec, lex } = await store.hybrid(q.text, { k: CANDIDATES });
    lexTop = lex[0] ? `${lex[0].id}` : 'none';
    vecTop = vec[0] ? `${vec[0].id}` : 'none';

    // ── 4. rerank ────────────────────────────────────────────────────────
    // eslint-disable-next-line no-await-in-loop
    kept = await rerank(q.text, fused.slice(0, CANDIDATES), { keep: KEEP }, meter);
  }

  // ── 5. budget ──────────────────────────────────────────────────────────
  let used = 0;
  kept = kept.filter((h) => {
    used += h.text.length;
    return used <= CONTEXT_BUDGET_CHARS;
  });

  const context = kept.length
    ? `Relevant records from long-term memory:\n${kept.map((h) => `- ${h.text}`).join('\n')}`
    : 'Long-term memory returned no relevant records for this question.';

  // eslint-disable-next-line no-await-in-loop
  const res = await callModel(meter, {
    model: MODEL,
    max_tokens: 300,
    system:
      'You are an ops assistant. Answer only from the provided records. '
      + `If the records do not contain the answer, say so plainly — do not guess.\n\n${
        context}`,
    messages: [{ role: 'user', content: q.text }],
  });
  const answer = res.content.find((b) => b.type === 'text')?.text ?? '';

  const relevantRetrieved = kept.filter((h) => q.relevant.includes(h.id)).length;
  injectedTotal += kept.length;
  usefulTotal += relevantRetrieved;

  console.log(`\n  ${q.id} (${q.kind}): ${q.text}`);
  console.log(`  ├ gate: ${gate ? 'SEARCH' : 'SKIP — no retrieval performed'}`);
  if (gate) console.log(`  ├ arms: bm25 top=${lexTop}  vector top=${vecTop}`);
  console.log(`  ├ kept ${kept.length} chunks [${kept.map((h) => h.id).join(', ') || '—'}], ${res.usage.input_tokens} input tokens`);
  console.log(
    `  ├ precision: ${kept.length ? ((relevantRetrieved / kept.length) * 100).toFixed(0) : '—'}%`
      + `  recall: ${q.relevant.length ? `${((relevantRetrieved / q.relevant.length) * 100).toFixed(0)}%` : 'n/a'}`,
  );
  console.log(`  └ answer: ${answer.trim().replace(/\s+/g, ' ').slice(0, 200)}`);
}

kv({
  'chunks injected': injectedTotal,
  'chunks actually relevant': usefulTotal,
  'signal ratio': injectedTotal ? `${((usefulTotal / injectedTotal) * 100).toFixed(0)}%` : 'n/a',
  ...meter.summary(),
});
console.log(
  '\n  Q1 works because of BM25, not the vectors — identifiers have no semantic\n'
    + '  neighbourhood, so "CR-88214" is a token match or it is nothing.\n'
    + '  Q2 works because of the vectors, not BM25 — "will not come back online"\n'
    + '  and "fails to check in" share no words at all.\n'
    + '  Q3 is the structural one: BM25 returned ZERO rows, because a term either\n'
    + '  appears or it does not. Cosine similarity cannot do that — every vector\n'
    + '  has an angle to every other vector, so top-k always returns k. If your\n'
    + '  only retrieval arm is vectors, "I have nothing relevant" is not an answer\n'
    + '  your system is capable of producing. You have to add it.\n',
);
