/**
 * LAYER 4 — LONG-TERM STORAGE · BEFORE
 *
 * The default RAG shape everybody ships first:
 *   embed every message → cosine top-10 → paste into the system prompt.
 *
 * Three queries expose three different failures:
 *   Q1 exact-match  — vectors are weak on identifiers; the right doc may not rank
 *   Q2 semantic     — this is the case vectors are actually good at
 *   Q3 absent       — the answer is NOT in the store, and cosine returns 10 hits anyway
 *
 * Q3 is the one to sit on. Similarity search has no concept of "nothing here".
 * It will hand you the ten least-irrelevant chunks with a straight face, and
 * the model will use them.
 *
 * run: npm run demo:4:before
 */
import { callModel, MODEL, UsageMeter } from '../lib/client';
import { banner, kv } from '../lib/report';
import { DOCS, QUERIES } from './corpus';
import { MemoryStore } from './store';

const TOP_K = 10;

banner('Layer 4 — long-term storage', 'before');
const meter = new UsageMeter('L4-before');
const store = await new MemoryStore(DOCS).init();

let injectedTotal = 0;
let usefulTotal = 0;

// eslint-disable-next-line no-restricted-syntax
for (const q of QUERIES) {
  // eslint-disable-next-line no-await-in-loop
  const hits = await store.vectorSearch(q.text, { k: TOP_K });
  const context = hits.map((h) => `- ${h.text}`).join('\n');

  // eslint-disable-next-line no-await-in-loop
  const res = await callModel(meter, {
    model: MODEL,
    max_tokens: 300,
    system: `You are an ops assistant. Relevant context from memory:\n${context}`,
    messages: [{ role: 'user', content: q.text }],
  });
  const answer = res.content.find((b) => b.type === 'text')?.text ?? '';

  const relevantRetrieved = hits.filter((h) => q.relevant.includes(h.id)).length;
  const precision = q.relevant.length ? relevantRetrieved / hits.length : 0;
  injectedTotal += hits.length;
  usefulTotal += relevantRetrieved;

  console.log(`\n  ${q.id} (${q.kind}): ${q.text}`);
  console.log(`  ├ retrieved ${hits.length} chunks, ${res.usage.input_tokens} input tokens`);
  console.log(
    `  ├ top scores: ${hits.slice(0, 5).map((h) => `${h.id}=${h.score.toFixed(2)}`).join(' ')}`,
  );
  console.log(`  ├ chatter in top-${TOP_K}: ${hits.filter((h) => h.kind === 'chatter').length}`);
  console.log(`  ├ precision: ${(precision * 100).toFixed(0)}%`);
  console.log(`  └ answer: ${answer.trim().replace(/\s+/g, ' ').slice(0, 200)}`);
}

kv({
  'chunks injected': injectedTotal,
  'chunks actually relevant': usefulTotal,
  'signal ratio': `${((usefulTotal / injectedTotal) * 100).toFixed(0)}%`,
  ...meter.summary(),
});
console.log(
  '\n  Look at Q3. Nothing in the store is about cloud spend, and the retriever\n'
    + '  still returned 10 chunks with respectable-looking cosine scores.\n'
    + '  A retriever with a fixed k cannot say "I have nothing." You have to say it for it.\n',
);
