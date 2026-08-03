# The Four Memory Layers Every Node.js Agent Needs

Companion repo for the talk. Every claim in the talk is a command you can run here.

Most agent memory implementations are one vector database and a prayer. The problem isn't
the tooling — it's that memory in agents isn't one problem, it's four, and each one needs a
different solution.

An LLM has **no memory**. The model is a pure function: `response = f(weights, tokens_in)`.
Everything we call "agent memory" is a program that decides which tokens go into the next
request. So memory is not a storage problem — storage is trivial. It's a **selection problem
under a hard constraint**, with a cost gradient (tokens are money and latency) and a quality
gradient (irrelevant tokens actively degrade output).

## The four layers

| | Layer | The question it answers | Lifetime | Lives in |
|---|---|---|---|---|
| **L1** | Working memory | "What am I doing right now?" | one run | V8 heap |
| **L2** | Conversation history | "What has been said?" | one session | heap → Redis/PG |
| **L3** | Tool call state | "What did I dispatch, and did it come back?" | one run, but with *resources* | heap + OS handles |
| **L4** | Long-term retrieval | "What do I know that isn't in front of me?" | forever | Postgres/pgvector |

Each fails in a way that looks like a *different* bug, which is why teams misdiagnose:

| Layer | Failure mode | What it looks like | What gets blamed |
|---|---|---|---|
| L1 | Leak / unbounded scratch | RSS climbs, p99 climbs, OOM at 3am | "Node memory leak" |
| L2 | Bad eviction | Agent forgets what it decided 3 steps ago; API 400s | "the model is dumb" |
| L3 | Orphaned calls | Hung runs, duplicate side effects | "flaky tool API" |
| L4 | Retrieval noise | Confidently wrong answers | "bad embeddings" |

**None of these are fixed by a better model.** All four are fixed by a better program.

## Quick start

```bash
npm install
npm test          # 24 tests, including two unit tests for memory leaks
npm run act0      # then act1 ... act5
```

Node 22+. No API key, no database, no network: the model is a deterministic `ScriptedModel`
with an honest prefix-cache simulator, and the embedder is a deterministic local one. Set
`ANTHROPIC_API_KEY` and swap in `LiveModel` to run the same code against the real API.

## The five acts

Each act breaks something, then fixes it. Run them in order.

### `npm run act0` — the strawman
`messages.push()` in a loop. Works beautifully for six turns. At twenty turns, with one
`read_file` on a large file, the transcript is **5.2M tokens and $40** — and the event loop
p99 is ~500 ms, because `JSON.stringify` on a 20 MB result is synchronous.

### `npm run act1` — overflow, then a *different* 400
Context overflow is not an edge case, it's a certainty. The obvious fix (drop the oldest 10
messages) turns a context-overflow 400 into a **tool-pairing 400**: you cut between a
`tool_use` and its `tool_result`. `assertWellFormed()` catches it in CI instead of at 2am
inside a retry loop.

The rule: you can only cut at **turn boundaries**. A single agent turn with 30 tool calls is
**atomic** — if one turn exceeds the budget, no eviction policy saves you and L3 has to spill.

### `npm run act2` — the cost cliff
Eviction now works. Same conversation, same model, same answers. The only difference is
*when* we evict:

```
A: evict every turn      cache hit 57.6%   $0.96
B: high/low watermark    cache hit 94.9%   $0.32     <- 3x cheaper
```

Prompt caching is a **prefix match**: change one token near the front and everything after
it is a miss. Evicting one message per turn changes the front of the array every turn.
Waiting until 80% and then trimming to 50% keeps the prefix byte-identical between
evictions. One scheduling decision.

*(The gap widens with the size of the stable prefix. A 100k-token prefix on a 50-turn
session is closer to 7x.)*

Corollary: **injecting retrieved documents at the top of the prompt destroys your cache
every turn.** Retrieval output belongs below the cache breakpoint.

### `npm run act3` — the leak
```
LEAKY     heapUsed 85.4 KB   arrayBuffers 120.0 MB   rss 129.8 MB
CORRECT   heapUsed  2.6 MB   arrayBuffers      0 B   rss   2.9 MB
```

`heapUsed` is flat while you leak 120 MB. That's why people debug the wrong graph for two
days: **Buffers don't live in `heapUsed`**, they live in `external`/`arrayBuffers`.

The cause is code that looks correct:

```ts
// Promise.race settles — but it does NOT cancel the loser.
const result = await Promise.race([callTool(input), timeout(30_000)]);
```

The losing call keeps its socket, keeps buffering the response, and keeps its closure alive.
The fix is cancellation, not racing: `AbortSignal.any([ctx.signal, AbortSignal.timeout(ms)])`
threaded all the way to the syscall. A tool handler that accepts a signal and ignores it is
worse than one that doesn't accept it, because it lies to the caller.

### `npm run act4` — when vectors help, and when they're expensive noise
```
Q: "what was the fix for the ECONNRESET in ENG-4471"
  vector   -> ENG-4060, ENG-4432, ENG-4228     <- real tickets. wrong tickets.
  lexical  -> ENG-4471
  hybrid   -> ENG-4471, ENG-4228, ENG-4060

Q: "our stripe integration keeps disconnecting mid-charge"
  vector   -> ENG-4471, ENG-4108, ENG-4672
  lexical  -> (nothing above the score floor)
  hybrid   -> ENG-4471, ENG-4108, ENG-4672
```

**Cosine always returns something.** There is no "no results" — so ask about `ENG-4471` and
get `ENG-4470`: a real, well-formed, wrong answer the model has no way to detect. Neither leg
is sufficient; that's what RRF is for.

| Query shape | Vectors? | Use instead |
|---|---|---|
| paraphrase, concept, no lexical overlap | ✅ | — |
| exact identifiers, error codes, versions | ❌ | BM25 / exact index |
| structured predicates ("orders over $500") | ❌ | SQL |
| "what did the user say they preferred?" | ❌ | L2 rollup / fact store |
| "did I already do X in this run?" | ❌ | L3 registry |
| corpus < ~2k chunks | ❌ | put it in context, or BM25 |

> Vectors are for **recall over paraphrase at scale**. Everything else has a better index.

The act also covers the half nobody builds: the **write path**. Dedup (exact triple first,
cosine second), contradiction handling (`valid_to`, never `DELETE`), and decay. "Retrieves
signal, not garbage" is achieved at `INSERT` time.

### `npm run act5` — all four layers, then crash and resume
Full run with the metrics panel, then the process is killed at step 12 and resumed from the
write-ahead step log without re-running any completed step. Idempotency keys are **derived**,
not random — `randomUUID()` per attempt defeats the entire mechanism.

## Layout

```
src/
  l1/  run-context.ts   AsyncLocalStorage, cancellation tree, disposal
       budget.ts        the token accountant
       metrics.ts       heap + event-loop instrumentation
       leak-probe.ts    FinalizationRegistry (demo only, never correctness)
  l2/  types.ts         the Messages shape
       invariants.ts    assertWellFormed, safeCutPoints
       tokens.ts        estimation that doesn't assume English
       buffer.ts        watermark eviction, rollup bridging, archival
       rollup.ts        structured summaries (incl. the `rejected` field)
  l3/  registry.ts      the tool-call state machine
       executor.ts      parallel batches, completeness, isolation
       spill.ts         pointers instead of values
       steplog.ts       write-ahead log, idempotency, resume
  l4/  store.ts         hybrid retrieval, MMR, the context packer
       bm25.ts          the leg that gets identifiers right
       fusion.ts        RRF + MMR
       facts.ts         dedup, invalidation, decay
       eval.ts          recall / mrr / ndcg / contextPrecision
docs/pgvector.sql       the production version of L4
docs/TALK.md            slide-to-code mapping and speaker notes
```

## Things worth stealing

- **`test/l1-leak.test.ts` and `test/l3-leak.test.ts`** — unit tests for memory leaks. Most
  people have never seen one.
- **`assertWellFormed`** — eviction is a function that must preserve an invariant, so test
  it like one.
- **`estimateTokens`** — the universal `length / 4` heuristic is calibrated on English prose.
  Hebrew runs closer to 1–2 chars per token. Budget a Hebrew product with `/4` and you
  overflow the window by 2–3x, then blame the model.
- **`materialize()`** — give the agent a pointer and a dereference tool, not the value. It's
  exactly virtual memory: the transcript is a small address space, the spill store is disk,
  and `read_result` is the page fault.
- **`contextPrecision`** — the L4→L2 bridge metric. Recall@10 of 0.9 with contextPrecision
  of 0.2 means retrieval found the answer and buried it in noise.

## License

MIT
