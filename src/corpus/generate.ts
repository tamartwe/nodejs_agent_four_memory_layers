import type { Chunk } from '../l4/store.js';
import type { GoldenCase } from '../l4/eval.js';

/**
 * A deterministic synthetic corpus: issue tickets plus runbook docs.
 *
 * The important property is that ENG-4471 has plausible NEIGHBOURS (ENG-4470, ENG-4481)
 * on the same topic. That is what makes act4 honest: cosine always returns something, and
 * what it returns is a real, well-formed, WRONG ticket.
 */
const TOPICS = [
  {
    key: 'connectivity',
    title: 'ECONNRESET from an upstream service',
    body: 'The socket connection to the upstream service is reset under load. Connections drop mid-request and the caller sees a network error.',
  },
  {
    key: 'timeout',
    title: 'Requests time out under load',
    body: 'Slow queries cause the request deadline to expire. The handler hangs waiting on a stalled upstream call and latency spikes.',
  },
  {
    key: 'retry',
    title: 'Retry storm after upstream failure',
    body: 'Workers retry in lockstep without jitter, so the backoff schedule re-hits the rate limit forever. Add jitter and an idempotency key.',
  },
  {
    key: 'auth',
    title: 'Session token expires early',
    body: 'JWT validation rejects a valid session because the login token refresh runs after expiry, returning 401 to authenticated users.',
  },
  {
    key: 'memory',
    title: 'Heap grows across long-running jobs',
    body: 'RSS climbs while heapUsed stays flat. Buffers retained by pending requests are never released, ending in an OOM.',
  },
  {
    key: 'database',
    title: 'Connection pool exhausted',
    body: 'Postgres connections are not returned to the pool during a transaction rollback, so queries queue and the migration deadlocks.',
  },
  {
    key: 'deploy',
    title: 'Rollback leaves stale containers',
    body: 'The deployment pipeline does not drain old pods, so a release keeps serving the previous build until the next deploy.',
  },
  {
    key: 'cache',
    title: 'Stale cache after invalidation',
    body: 'Redis TTL outlives the write, so an evicted key is repopulated with the old value and clients read stale data.',
  },
  {
    key: 'queue',
    title: 'Consumer lag grows overnight',
    body: 'The worker backlog builds because the job consumer processes messages slower than the producer emits them.',
  },
  {
    key: 'api',
    title: 'Endpoint returns 500 on empty body',
    body: 'The route handler assumes a JSON request body, so an empty HTTP request throws before validation returns a 400.',
  },
  {
    key: 'testing',
    title: 'Flaky spec in CI',
    body: 'The test depends on wall-clock ordering, so the assertion fails intermittently in the pipeline but passes locally.',
  },
  {
    key: 'security',
    title: 'Unsanitized input reaches the query builder',
    body: 'A user-controlled field is interpolated into SQL, creating an injection vector that the sanitizer does not cover.',
  },
];

export interface Corpus {
  chunks: Chunk[];
  golden: GoldenCase[];
}

export function buildCorpus(issueCount = 800): Corpus {
  const chunks: Chunk[] = [];

  for (let i = 0; i < issueCount; i++) {
    const id = `ENG-${4000 + i}`;
    const topic = TOPICS[i % TOPICS.length];
    const variant = Math.floor(i / TOPICS.length);
    chunks.push({
      id: `chunk:${id}`,
      docId: id,
      date: `2025-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
      context: `Issue ${id} in the platform tracker, category: ${topic.key}.`,
      content: `${id}: ${topic.title} (report ${variant}). ${topic.body}`,
      validTo: null,
      meta: { topic: topic.key },
    });
  }

  // The star of act4. Same topic as its neighbours, different resolution.
  const target = chunks.find((c) => c.docId === 'ENG-4471')!;
  target.content =
    'ENG-4471: ECONNRESET from the payments provider during checkout. ' +
    'Root cause: the HTTP keep-alive agent reused a socket the provider had already half-closed. ' +
    'Fix: set maxSockets and keepAliveMsecs on the agent, and retry once on ECONNRESET with an idempotency key so the charge is not duplicated.';
  target.context = 'Issue ENG-4471 in the platform tracker, category: connectivity. RESOLVED.';

  // Runbooks: the "which version is current" problem, modelled with valid_to.
  chunks.push({
    id: 'chunk:runbook-deploy-v1',
    docId: 'RUNBOOK-DEPLOY',
    date: '2023-04-02',
    context: 'Deployment runbook, superseded revision.',
    content:
      'Deploy process: build the docker image, push to the registry, then run helm upgrade manually against production.',
    validTo: '2025-01-15', // superseded — must NOT be retrieved
  });
  chunks.push({
    id: 'chunk:runbook-deploy-v2',
    docId: 'RUNBOOK-DEPLOY',
    date: '2025-01-15',
    context: 'Deployment runbook, current revision.',
    content:
      'Deploy process to production: the CI pipeline builds and pushes the image, then the release job runs helm upgrade against production with automatic rollback on failed health checks.',
    validTo: null,
  });
  chunks.push({
    id: 'chunk:runbook-oncall',
    docId: 'RUNBOOK-ONCALL',
    date: '2025-06-01',
    context: 'On-call runbook, current revision.',
    content:
      'When connections to a provider drop repeatedly, check the keep-alive agent settings before blaming the network, then retry with jitter and an idempotency key.',
    validTo: null,
  });

  const golden: GoldenCase[] = [
    {
      query: 'what was the fix for the ECONNRESET in ENG-4471',
      relevantIds: ['ENG-4471'],
      note: 'exact identifier — lexical must win',
    },
    { query: 'ENG-4471', relevantIds: ['ENG-4471'], note: 'bare id' },
    {
      query: 'our stripe integration keeps disconnecting mid-charge',
      relevantIds: ['ENG-4471'],
      note: 'paraphrase with ZERO lexical overlap — vectors must win',
    },
    {
      query: 'the checkout keeps aborting when we contact the card processor',
      relevantIds: ['ENG-4471'],
      note: 'paraphrase',
    },
    {
      query: 'how do we deploy to production',
      relevantIds: ['RUNBOOK-DEPLOY'],
      note: 'versioned doc — must return the CURRENT revision',
    },
    { query: 'why does RSS climb while heapUsed stays flat', relevantIds: ['ENG-4004'], note: 'concept' },
  ];

  return { chunks, golden };
}
