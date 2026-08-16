# Layer 3 Tool State Demo

Slide 2: **A tool call can outlive the request that started it.**

This is a small plain Node.js teaching demo. It uses no APIs, LLMs, queues, databases, or frameworks.

## Run

```bash
npm run demo:3:before
npm run demo:3:after
npm run demo
```

## BEFORE

`before.js` stores a pending tool call in an in-memory `Map`.

Flow:

1. HTTP request starts.
2. Fake long-running tool call is submitted.
3. Pending promise is stored in memory.
4. Request returns `202 Accepted`.
5. Request ends.
6. Process restart clears memory.
7. Tool completes.
8. Result has no owner and cannot resume the workflow.

Teaching point:

> A `Promise` is not workflow state. A `Map` is not durable ownership.

## AFTER

`after.js` writes a durable execution record to `tool-state.json`:

```js
{
  callId,
  workflowId,
  toolName,
  status,
  attempt,
  idempotencyKey,
  resultRef,
  createdAt,
  updatedAt
}
```

Flow:

1. Request starts.
2. Tool call is submitted.
3. Execution record is written.
4. Request returns `202 Accepted`.
5. Process restarts.
6. Tool completes.
7. A new worker reads the ledger.
8. Workflow resumes from `workflowId`, `callId`, `status`, and `resultRef`.

Teaching point:

> The request is short-lived. The workflow needs durable state.

## Slide Script

Run:

```bash
npm run demo:3:before
```

Say:

> The request returned successfully, but the only owner of the tool call was an in-memory promise. After restart, the result is detached from the workflow.

Then run:

```bash
npm run demo:3:after
```

Say:

> Same request, same tool call, but now the workflow is resumable because the execution record survived the worker.
