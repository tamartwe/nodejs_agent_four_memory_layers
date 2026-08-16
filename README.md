# The Four Memory Layers of a Node.js AI Agent — demo code

Every demo here talks to a real model. Nothing is stubbed, scripted, or faked.
The numbers printed on stage are the numbers the API returned.

## Setup

```bash
npm install
cp .env.example .env      # add your keys
npm run demo:4:seed       # warm the embedding cache — do this before the talk
```

Node 20.11+. `--env-file` and `--expose-gc` are already wired into the npm scripts.
Everything is TypeScript, run directly via `tsx` (`node --import tsx`) — there is no
build step. `npm run typecheck` runs `tsc --noEmit`; `npm run lint` runs ESLint
(Airbnb base + `airbnb-typescript`).

`ANTHROPIC_API_KEY` is required for everything.
`VOYAGE_API_KEY` is required for Layer 4 only (there is no embeddings endpoint on the
Messages API; Voyage is the recommended pairing). Embeddings are cached to
`.cache/embeddings.json`, so after seeding, Layer 4 runs offline for the retrieval half.

## Run order

| # | Command | What the audience should watch |
|---|---|---|
| 0 | `npm run demo` or `npm run demo:0` | The first tool loop: model calls `searchFlights`, the tool returns 2 results, the model answers with the cheapest flight. |
| 1 | `npm run demo:1:before` → `demo:1:after` → `demo:1:compare` | Safe working memory: broken global run contexts versus scoped cleanup, bounds, cancellation, and small checkpoints. |
| 2 | `npm run demo:2:before` → `:after` → `:compare` | Full transcript stays stored; model input is a bounded, token-aware context window. |
| 3 | `npm run demo:3:before` → `:after` | `pending=` column and `transcript=` column. Before: stale pending entries after every tool failure. |
| 4 | `npm run demo:4:before` → `:after` | Signal ratio. And Q3, where before invents an answer and after says "I don't have that." |
| 5 | `npm run demo:5` | The `◀ SUPERSEDED` marker at turn 8, then the audit trail. |

Each `before`/`after` pair is the same prompts, same model, same tools. The only
variable is the memory strategy.

## Cost

A full before+after pass of all five is roughly 250k–400k input tokens on Sonnet-class
pricing. Layer 2 `before` is the expensive one — that is the point of it. Set
`TURNS=6` to shorten Layer 1 and 3 for a dry run.

## Where the numbers come from

- Token counts: `usage.input_tokens` off the real response. Never estimated.
- Heap: `process.memoryUsage().heapUsed` after two forced GC passes (`--expose-gc`).
- Leak proof: `FinalizationRegistry` in `01-working-memory/workingMemory.ts` reports
  scopes created vs collected. It is used to *observe*, never to clean up.

## Layout

```
src/
  lib/            client + usage meter, tools, embeddings, heap/reporting
  00-basic-agent/ first flight-search tool loop
  01-working-memory/   deterministic safe working-memory demo
  02-conversation-history/  ConversationWindow: budget, pin, compact, summarise
  03-tool-state/  ToolRunState: finally-delete, handle-based offload
  04-storage/     MemoryStore: bm25 + vector + RRF, gate, rerank
  05-long-term-context/  StructuredMemory: supersession, and the full stack
```

## The one-line version of each layer

1. **Working memory** — if it has no global home, it cannot leak. Scope it, dispose it in `finally`.
2. **Conversation history** — storage is solved; what you *send* is not. Budget tokens, not turns.
3. **Tool state** — `delete()` belongs in `finally`. Big results belong behind a handle, not in the transcript.
4. **Long-term storage** — vectors are one arm, not the system. Gate, fuse, rerank, budget, and let it say "nothing."

And the closing one: memory that appends contradictions is not memory. Supersede.
