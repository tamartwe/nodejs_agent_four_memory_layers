# Demo 1 - Safe Working Memory

## 1. The Scenario

Working memory is temporary state used during one agent execution: scratchpad notes, partial model output, raw tool responses, per-run caches, and trace/span handles. It should normally disappear when the run finishes.

This demo uses deterministic fake model and tool calls. It makes no network requests and needs no API keys.

## 2. Code Before The Fix

The intentionally broken implementation is in `before.ts`. It is labelled demo-only and keeps the bad choices visible:

```ts
export const unsafeRunRegistry = new Map<string, UnsafeRunContext>();

unsafeRunRegistry.set(context.runId, context);
context.rawToolResponses.push(rawResponse);
context.cache.set(cacheKey, candidate.rawFareRules);
unsafePersistedRuns.set(context.runId, serializeWholeContext(context));
```

## 3. Why It Leaks

1. A request creates a `RunContext`.
2. The context is added to a process-global registry.
3. Tool responses, cache entries, timers, listeners, and trace handles are attached to it.
4. The run completes.
5. The global registry still references the context.
6. Because the context remains reachable, garbage collection cannot reclaim it.
7. Repeating the process grows retained memory with the number of completed runs.

Problem sections:

| Problem | What remains reachable | Owner | Why GC cannot release it | Growth pattern |
|---|---|---|---|---|
| Global registry | Entire `UnsafeRunContext` | `unsafeRunRegistry` | The map is process-global and entries are never deleted | One retained context per run |
| Raw responses | Full flight search JSON | `context.rawToolResponses` and `context.trace` | The context is still reachable | Several large payloads per run |
| Unbounded cache | Fare-rule strings | `context.cache` | No entry limit and context survives | Candidate count times steps |
| Timers/listeners | Closures that capture context | `unsafeActiveTimers` and `unsafeTraceBus` | Closures keep the context graph alive | One timer and one listener per run |
| Persistence | Full serialized context | `unsafePersistedRuns` | The snapshot contains raw data and scratch state | Persisted bytes scale with payload size |

## 4. The Five Design Decisions

| Decision | Before | After | Failure prevented |
|---|---|---|---|
| Scope | Process-global completed contexts | One `RunScope` per execution | Finished runs staying reachable |
| Bounds | No step, tool, cache, time, or size limits | Typed `AgentLimits` constants | Runaway loops and payload growth |
| Cancel | Timeout rejects caller only | One `AbortController`; signal reaches fake model and tools | Background operations and late side effects |
| Cleanup | Success path only, and incomplete | `try/finally` disposes registry entry, cache, raw responses, timers, spans | Leaks after success, error, timeout, or cancel |
| Persist | Whole context is serialized | Small `PersistedCheckpoint` only | Durable storage filling with prompts/raw data |

## 5. Code After The Fix

The corrected implementation is in `after.ts` and `workingMemory.ts`.

```ts
return withRunScope({ runId, limits, parentSignal }, async (scope) => {
  try {
    // model/tool work receives scope.signal
  } finally {
    // withRunScope removes the active registry entry and disposes the scope
  }
});
```

The persisted checkpoint is deliberately small:

```ts
interface PersistedCheckpoint {
  runId: string;
  status: WorkflowStatus;
  currentStep: number;
  selectedFlightId?: string;
  idempotencyKey: string;
  expiresAt: string;
}
```

## 6. How To Run The Comparison

```bash
npm run demo:1:before
npm run demo:1:after
npm run demo:1:compare
npm test
npm run typecheck
```

Use `RUNS=40 npm run demo:1:compare` to make the before/after gap more obvious.

## 7. Expected Output

Before:

- The active-run registry grows with completed runs.
- Raw tool responses remain reachable.
- Persisted bytes grow because the whole context is serialized.
- Timers and trace handles remain attached.

After:

- The active-run registry returns to zero.
- Raw responses are summarized and discarded.
- Cache entries never exceed the configured bound.
- Checkpoints remain small.
- Cancellation stops child operations.

Exact heap values vary because V8 garbage collection is nondeterministic. Registry size, raw-response counts, timer counts, trace counts, and persisted bytes are the deterministic evidence.

## 8. 60-Second Live-Demo Script

1. Run `npm run demo:1:before`.
2. Point at `registry`, `raw`, `cache`, and `persisted` increasing each run.
3. Open `before.ts` and show the global `unsafeRunRegistry`.
4. Run `npm run demo:1:after`.
5. Point at `registry=0`, `raw=0`, and small checkpoint bytes.
6. Run `npm run demo:1:compare`.
7. Close with: "Working memory is safe only when it has an owner and a guaranteed end."

## 9. Slide Snippets

Broken:

```ts
unsafeRunRegistry.set(context.runId, context);
context.rawToolResponses.push(rawResponse);
unsafePersistedRuns.set(context.runId, serializeWholeContext(context));
```

Corrected:

```ts
try {
  const raw = await searchFlights(input, { signal: scope.signal });
  const summary = summarizeFlights(raw);
  scope.rawToolResponses.length = 0;
  checkpointStore.save(checkpointFor(runId, 'waiting_for_approval', step, summary.cheapestFlightId));
} finally {
  span.dispose();
}
```

Bounds:

```ts
export const DEFAULT_LIMITS = {
  maxSteps: 5,
  maxExecutionMs: 1_000,
  maxToolCalls: 4,
  maxCacheEntries: 8,
  maxRawToolResponseBytes: 12_000,
};
```

## 10. Production Considerations Not Implemented

- Real distributed locks for multiple Node.js workers.
- Durable checkpoints in PostgreSQL or Redis.
- Trace export to OpenTelemetry.
- Idempotency enforcement at the booking/payment boundary.
- Tenant-aware retention policies.
- Backpressure for high-volume tool calls.
