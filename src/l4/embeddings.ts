/**
 * A deterministic, offline embedder so the demo runs on conference wifi and gives the
 * SAME result every time you present it.
 *
 * It projects text onto a small set of hand-built topic axes. That is enough to reproduce
 * the two behaviours act4 needs to show, and it reproduces them honestly:
 *
 *   - paraphrase matching works    ("connection keeps dropping" ~ "socket reset, retry")
 *   - EXACT IDENTIFIERS DO NOT     (ENG-4471 contributes almost nothing to a topic axis,
 *                                   which is precisely why real embeddings retrieve
 *                                   ENG-4470 and call it a match)
 *
 * Swap in a real bi-encoder via the Embedder interface for production. Nothing else changes.
 */
export interface Embedder {
  readonly dims: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

const TOPICS: Record<string, string[]> = {
  connectivity: [
    'connection',
    'connect',
    'socket',
    'econnreset',
    'econnrefused',
    'dropped',
    'drop',
    'reset',
    'network',
    'tcp',
    'disconnect',
    'refused',
    'unreachable',
  ],
  timeout: ['timeout', 'timed', 'slow', 'hang', 'hanging', 'stall', 'deadline', 'latency', 'expired'],
  retry: ['retry', 'retries', 'backoff', 'jitter', 'idempotent', 'idempotency', 'redelivery', 'reattempt'],
  auth: [
    'auth',
    'authentication',
    'login',
    'token',
    'jwt',
    'oauth',
    'session',
    'credential',
    'unauthorized',
    '401',
    'permission',
  ],
  payments: ['payment', 'checkout', 'charge', 'card', 'billing', 'refund', 'invoice', 'stripe', 'order'],
  database: ['database', 'db', 'postgres', 'query', 'sql', 'index', 'migration', 'deadlock', 'transaction', 'pool'],
  memory: ['memory', 'heap', 'leak', 'rss', 'gc', 'oom', 'buffer', 'allocation', 'garbage'],
  deploy: ['deploy', 'deployment', 'release', 'rollback', 'ci', 'pipeline', 'build', 'docker', 'kubernetes', 'helm'],
  cache: ['cache', 'caching', 'redis', 'invalidate', 'ttl', 'stale', 'evict', 'eviction'],
  logging: ['log', 'logging', 'trace', 'observability', 'metric', 'monitor', 'alert', 'dashboard'],
  frontend: ['ui', 'react', 'render', 'component', 'css', 'browser', 'client', 'page'],
  queue: ['queue', 'worker', 'job', 'consumer', 'producer', 'kafka', 'rabbitmq', 'backlog', 'lag'],
  security: ['security', 'vulnerability', 'cve', 'exploit', 'injection', 'xss', 'csrf', 'sanitize'],
  testing: ['test', 'tests', 'flaky', 'spec', 'coverage', 'mock', 'fixture', 'assertion'],
  config: ['config', 'configuration', 'env', 'environment', 'variable', 'setting', 'flag', 'toggle'],
  api: ['api', 'endpoint', 'rest', 'graphql', 'request', 'response', 'http', 'route', 'handler'],
};

const TOPIC_NAMES = Object.keys(TOPICS);
const WORD_TO_TOPICS = new Map<string, number[]>();
TOPIC_NAMES.forEach((name, ti) => {
  for (const w of TOPICS[name]) {
    const list = WORD_TO_TOPICS.get(w) ?? [];
    list.push(ti);
    WORD_TO_TOPICS.set(w, list);
  }
});

export function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [];
}

export class ToyTopicEmbedder implements Embedder {
  readonly dims = TOPIC_NAMES.length + 32; // topic axes + a small lexical tail

  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dims);
    const words = tokenize(text);

    for (const w of words) {
      const topics = WORD_TO_TOPICS.get(w) ?? stemLookup(w);
      for (const t of topics) v[t] += 1;
      // A weak lexical tail: this is the part real bi-encoders are ALSO weak at, which is
      // why identifiers need BM25 rather than a vector.
      const h = hash32(w) % 32;
      v[TOPIC_NAMES.length + h] += 0.12;
    }

    normalize(v);
    return v;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

function stemLookup(word: string): number[] {
  for (const [key, topics] of WORD_TO_TOPICS) {
    if (word.length > 4 && (word.startsWith(key) || key.startsWith(word))) return topics;
  }
  return [];
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function normalize(v: Float32Array): void {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return;
  // Normalizing IN PLACE is the point: the surrounding module's whole reason for using
  // Float32Array over number[] is to avoid the extra allocation a copy-then-return
  // would reintroduce.
  // eslint-disable-next-line no-param-reassign
  for (let i = 0; i < v.length; i++) v[i] /= norm;
}

/**
 * Store vectors as Float32Array, not number[]. A 1024-dim number[] is ~8KB of boxed
 * doubles plus object overhead; the Float32Array is 4KB flat and cosine() over it is
 * several times faster. On 50k cached vectors that is 400MB vs 200MB.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both are L2-normalized
}
