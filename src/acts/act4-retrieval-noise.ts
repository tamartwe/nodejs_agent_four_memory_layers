import { banner, section, colors, verdict } from '../panel/dashboard.js';
import { MemoryStore, pack } from '../l4/store.js';
import { buildCorpus } from '../corpus/generate.js';
import { evaluate, formatEval } from '../l4/eval.js';
import { FactStore } from '../l4/facts.js';

/**
 * ACT 4 — when vectors help, and when they are expensive noise.
 *
 * Cosine ALWAYS returns something. There is no "no results". Ask about ENG-4471, get
 * ENG-4470: a real, well-formed, wrong ticket. The model has no way to know.
 */
banner('ACT 4', 'Cosine always returns something');

const { chunks, golden } = buildCorpus();
const store = new MemoryStore();
await store.index(chunks);
console.log(`indexed ${store.size} chunks (${new Set(chunks.map((c) => c.docId)).size} documents)\n`);

const EXACT = 'what was the fix for the ECONNRESET in ENG-4471';
const PARAPHRASE = 'our stripe integration keeps disconnecting mid-charge';

async function show(label: string, query: string, mode: 'vector' | 'lexical' | 'hybrid') {
  const hits = await store.retrieve(query, { mode, limit: 3 });
  const line = hits.length
    ? hits.map((h) => `${h.chunk.docId}`).join(', ')
    : colors.yellow('(nothing above the score floor)');
  const correct = hits[0]?.chunk.docId === 'ENG-4471' || hits[0]?.chunk.docId === 'RUNBOOK-ONCALL';
  console.log(`  ${label.padEnd(10)} -> ${(correct ? colors.green : colors.red)(line)}`);
  return hits;
}

section('1. exact identifier: "…the ECONNRESET in ENG-4471"');
await show('vector', EXACT, 'vector');
await show('lexical', EXACT, 'lexical');
await show('hybrid', EXACT, 'hybrid');
console.log(
  colors.dim(
    '\n  Embeddings get you NEARBY, and nearby is wrong. ENG-4470 is a real ticket on the same\n' +
      '  topic with a different resolution. The agent will answer confidently from it.',
  ),
);

section(`2. paraphrase with zero lexical overlap: "${PARAPHRASE}"`);
await show('vector', PARAPHRASE, 'vector');
await show('lexical', PARAPHRASE, 'lexical');
await show('hybrid', PARAPHRASE, 'hybrid');
console.log(colors.dim('\n  Now the mirror case: no lexical overlap at all. BM25 alone has nothing to match.'));
console.log(colors.bold('  Neither leg is sufficient. That is the whole point of RRF.'));

section('3. the golden set');
for (const mode of ['vector', 'lexical', 'hybrid'] as const) {
  console.log(formatEval(mode, await evaluate(store, golden, { mode })));
}
console.log(
  colors.dim(
    '\n  contextPrecision is the L4 -> L2 bridge metric: how much of the context budget you spent\n' +
      '  was worth spending. recall 0.9 with contextPrecision 0.2 is HURTING the agent.',
  ),
);

section('4. the score floor: returning nothing is a valid answer');
const nonsense = 'what is the airspeed velocity of an unladen swallow';
const loose = await store.retrieve(nonsense, { minScore: 0, cosineFloor: 0, bm25Floor: 0, limit: 3 });
const strict = await store.retrieve(nonsense, { limit: 3 });
console.log(`  no floor   -> ${colors.red(loose.map((h) => h.chunk.docId).join(', ') || 'none')}`);
console.log(`  with floor -> ${colors.green(strict.map((h) => h.chunk.docId).join(', ') || 'nothing returned')}`);
console.log(colors.dim('\n  An agent told "nothing relevant found" asks a clarifying question.'));
console.log(colors.dim('  An agent given three wrong documents confidently answers wrong.'));

section('5. versioned docs: valid_to, not DELETE');
const deploy = await store.retrieve('how do we deploy to production', { limit: 2 });
console.log('  ' + pack(deploy, 600).split('\n').slice(0, 4).join('\n  '));
verdict(
  !deploy.some((h) => h.chunk.content.includes('helm upgrade manually')),
  'the superseded 2023 runbook was not retrieved',
);

section('6. the write path: dedup, contradiction, audit trail');
const facts = new FactStore();
const base = { subject: 'user', confidence: 0.8, sourceRunId: 'run-1', validFrom: new Date('2025-01-01') };
console.log(
  '  ' +
    (await facts.upsert({ ...base, predicate: 'prefers', object: 'pnpm', text: 'the user prefers pnpm' })).action,
);
console.log(
  '  ' +
    (await facts.upsert({ ...base, predicate: 'prefers', object: 'pnpm', text: 'user prefers pnpm for installs' }))
      .action + colors.dim('   <- deduped, not a 40th copy'),
);
const superseded = await facts.upsert({
  ...base,
  validFrom: new Date('2025-06-01'),
  predicate: 'prefers',
  object: 'bun',
  text: 'the user prefers bun',
});
console.log('  ' + superseded.action + colors.dim(`   <- closed ${superseded.supersededIds.length} old fact(s), did not DELETE`));
console.log(`\n  current facts: ${facts.current.length}   total rows: ${facts.all.length}`);
console.log(`  as of 2025-03-01: ${facts.asOf(new Date('2025-03-01')).map((f) => f.object).join(', ')}`);
console.log(`  as of today:      ${facts.current.map((f) => f.object).join(', ')}`);
console.log(colors.dim('\n  Bi-temporal modelling gives you current-state queries, "what did we believe on'));
console.log(colors.dim('  date X" for debugging, and an audit trail — for one nullable column.'));
