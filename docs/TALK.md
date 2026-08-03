# Speaker notes: mapping the repo to the talk

| Slides | Section | Code | Live |
|---|---|---|---|
| 3-4 | The 15-line agent | `src/agent/loop.ts` → `runStrawman` | `npm run act0` |
| 5-10 | Four layers, four failure modes | — | — |
| 11-17 | L1 working memory | `src/l1/` | `npm test -- l1-leak` |
| 18-22 | L2 invariants, safe cuts | `src/l2/invariants.ts` | `npm run act1` |
| 23-24 | Prefix caching economics | `src/model/pricing.ts`, `client.ts` | `npm run act2` |
| 25-29 | Token counting, buffer, rollups | `src/l2/tokens.ts`, `buffer.ts`, `rollup.ts` | — |
| 30-36 | L3 tool state, spilling, resume | `src/l3/` | `npm run act3`, `act5` |
| 37-43 | L4 retrieval and the write path | `src/l4/`, `docs/pgvector.sql` | `npm run act4` |
| 44-46 | The whole stack | `src/agent/loop.ts` | `npm run act5` |

## Running order on stage

```
npm run act0    # 20 turns -> 5.2M tokens, $40, event loop p99 ~500ms
npm run act1    # overflow -> naive fix -> a DIFFERENT 400
npm run act2    # 57% vs 95% cache hit rate on the identical conversation
npm run act3    # heapUsed 85 KB while arrayBuffers grows 120 MB
npm run act4    # cosine returns a real, well-formed, wrong ticket
npm run act5    # all four layers, then crash at step 12 and resume
```

Everything is deterministic and offline by default (`ScriptedModel` + `ToyTopicEmbedder`),
so none of it depends on conference wifi. Set `ANTHROPIC_API_KEY` and swap in `LiveModel`
to run the same acts against the real API.

## Numbers to have memorized

- Cache: read **0.1x**, 5-min write **1.25x**, 1-hour write **2x** base input. Break-even
  after one read (5-min) or two (1-hour). Up to 4 breakpoints. Prefix order: tools →
  system → messages.
- Cache reads don't count toward ITPM on current models.
- Chars per token: English ~4, code ~3, JSON ~2.8, Hebrew/CJK ~1.6, base64 ~1.4.
- `hnsw.ef_search` default **40**. A predicate matching 10% of rows returns ~4 of your 10.
- RRF constant `k = 60`. Retrieve 30-50, rerank to 5-10.
- Fact dedup threshold: cosine ~0.93-0.95.

## The four takeaways

1. **Memory isn't storage, it's selection.** Every layer is an eviction policy in disguise.
2. **The window is a cache, so *when* you evict matters more than *what*.**
3. **Anything that owns a socket needs a lifecycle.** Thread the `AbortSignal` to the syscall.
4. **Retrieval quality is decided on the write path.** Vectors are for paraphrase at scale;
   everything else has a better index.
