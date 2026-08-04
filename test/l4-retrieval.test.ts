import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/l4/store.js';
import { buildCorpus } from '../src/corpus/generate.js';
import { evaluate } from '../src/l4/eval.js';
import { FactStore } from '../src/l4/facts.js';

const { chunks, golden } = buildCorpus();

describe('L4 retrieval', () => {
  it('hybrid beats either leg alone on the golden set', async () => {
    const store = new MemoryStore();
    await store.index(chunks);

    const vector = await evaluate(store, golden, { mode: 'vector' });
    const lexical = await evaluate(store, golden, { mode: 'lexical' });
    const hybrid = await evaluate(store, golden, { mode: 'hybrid' });

    expect(hybrid.recall).toBeGreaterThanOrEqual(vector.recall);
    expect(hybrid.recall).toBeGreaterThanOrEqual(lexical.recall);
  });

  it('vector search alone misses the exact identifier', async () => {
    const store = new MemoryStore();
    await store.index(chunks);
    const hits = await store.retrieve('what was the fix for the ECONNRESET in ENG-4471', { mode: 'vector', limit: 3 });
    // Cosine always returns SOMETHING — and here it is the wrong, adjacent ticket.
    expect(hits[0]?.chunk.docId).not.toBe('ENG-4471');
  });

  it('hybrid finds the exact identifier', async () => {
    const store = new MemoryStore();
    await store.index(chunks);
    const hits = await store.retrieve('what was the fix for the ECONNRESET in ENG-4471', { mode: 'hybrid', limit: 3 });
    expect(hits.map((h) => h.chunk.docId)).toContain('ENG-4471');
  });

  it('never returns a superseded document revision', async () => {
    const store = new MemoryStore();
    await store.index(chunks);
    const hits = await store.retrieve('how do we deploy to production', { limit: 5 });
    expect(hits.some((h) => h.chunk.content.includes('helm upgrade manually'))).toBe(false);
  });

  it('returns nothing rather than something wrong', async () => {
    const store = new MemoryStore();
    await store.index(chunks);
    const hits = await store.retrieve('the airspeed velocity of an unladen swallow', { minScore: 0.02 });
    expect(hits).toHaveLength(0);
  });
});

describe('L4 write path', () => {
  it('dedupes instead of inserting a 40th copy', async () => {
    const facts = new FactStore();
    const base = { subject: 'user', confidence: 0.8, sourceRunId: 'r1', validFrom: new Date('2025-01-01') };
    await facts.upsert({ ...base, predicate: 'prefers', object: 'pnpm', text: 'the user prefers pnpm' });
    const second = await facts.upsert({
      ...base,
      predicate: 'prefers',
      object: 'pnpm',
      text: 'user prefers pnpm for installs',
    });
    expect(second.action).toBe('reinforced');
    expect(facts.current).toHaveLength(1);
  });

  it('closes contradicting facts instead of deleting them', async () => {
    const facts = new FactStore();
    await facts.upsert({
      subject: 'user',
      predicate: 'prefers',
      object: 'pnpm',
      text: 'prefers pnpm',
      confidence: 0.9,
      sourceRunId: 'r1',
      validFrom: new Date('2025-01-01'),
    });
    const res = await facts.upsert({
      subject: 'user',
      predicate: 'prefers',
      object: 'bun',
      text: 'prefers bun',
      confidence: 0.9,
      sourceRunId: 'r2',
      validFrom: new Date('2025-06-01'),
    });

    expect(res.action).toBe('superseded');
    expect(facts.current).toHaveLength(1);
    expect(facts.all).toHaveLength(2); // audit trail intact
    expect(facts.asOf(new Date('2025-03-01')).map((f) => f.object)).toEqual(['pnpm']);
  });
});
