/**
 * Run this once before the talk. It embeds the corpus and the queries into
 * .cache/embeddings.json so the on-stage runs do not depend on the wifi.
 *
 * run: npm run demo:4:seed
 */
import { embed } from '../lib/embed';
import { DOCS, QUERIES } from './corpus';

console.log(`embedding ${DOCS.length} documents…`);
await embed(DOCS.map((d) => d.text), 'document');

console.log(`embedding ${QUERIES.length} queries…`);
await embed(QUERIES.map((q) => q.text), 'query');

console.log('cache warm — .cache/embeddings.json');
