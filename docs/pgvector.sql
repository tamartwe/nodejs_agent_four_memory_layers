-- Production shape of L4. The repo's MemoryStore is an in-memory implementation so the
-- demo runs with zero infrastructure; this is what you actually ship.
--
-- You do not need a separate vector database to do hybrid retrieval. Postgres gives you
-- BM25-ish full text (tsvector / ts_rank_cd) and ANN (pgvector) in the same engine, so you
-- can fuse in SQL and keep your metadata joins and transactions.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE chunks (
  id          bigserial PRIMARY KEY,
  doc_id      text NOT NULL,
  tenant_id   text NOT NULL,
  content     text NOT NULL,
  context     text,                      -- contextual-retrieval prefix, embedded WITH content
  parent_id   bigint,                    -- small-to-big: embed the child, return the parent
  embedding   vector(1024),
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz,               -- NULL = current. Updates are never DELETEs.
  meta        jsonb
);

CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX ON chunks USING gin (tsv);
CREATE INDEX ON chunks (tenant_id) WHERE valid_to IS NULL;

-- m               graph connectivity      build time + memory
-- ef_construction build quality           build time
-- ef_search       recall / latency        THE ONLY ONE TUNABLE AT QUERY TIME
--
-- HNSW builds on an empty table and takes writes well, which is what an agent memory store
-- is. IVFFlat needs data present before building (it learns centroids) and handles churn
-- worse. HNSW builds are parallel now, which matters when you re-embed.

-- ---------------------------------------------------------------------------
-- THE FILTERING TRAP
-- ---------------------------------------------------------------------------
-- With an approximate index the filter is applied AFTER the index scan. HNSW walks the
-- graph, returns ef_search candidates, and only then does Postgres apply your WHERE. With
-- the default ef_search = 40 and a predicate matching 10% of rows you get about 4 rows
-- when you asked for 10 — and sometimes zero, silently. Your agent says "I don't have
-- information about that" and nothing anywhere logs an error.
--
-- pgvector 0.8 fixed this with iterative index scans: the scan keeps pulling candidates
-- until enough rows survive the filter, or it hits a safety limit.

SET hnsw.iterative_scan = strict_order;   -- or relaxed_order (faster, approximate ordering)
SET hnsw.max_scan_tuples = 20000;         -- safety valve
SET hnsw.scan_mem_multiplier = 2;         -- multiple of work_mem, if recall still lags
SET hnsw.ef_search = 100;

-- Alternatives by filter cardinality:
--   low cardinality, stable filter  -> partial index
--     CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops) WHERE tenant_id = 'acme';
--   high cardinality (many tenants) -> partition the table

-- ---------------------------------------------------------------------------
-- HYBRID RETRIEVAL WITH RECIPROCAL RANK FUSION
-- ---------------------------------------------------------------------------
-- BM25 scores and cosine distances live on incomparable scales and both drift with corpus
-- and model. Rank is scale-free. 1/(k + rank) with k = 60 needs no tuning and beats
-- hand-calibrated score blending.
--
-- $1 = query text, $2 = query embedding, $3 = tenant id

WITH params AS (SELECT $1::text AS q, $2::vector AS qv, $3::text AS tenant),
kw AS (
  SELECT c.id,
         row_number() OVER (ORDER BY ts_rank_cd(c.tsv, plainto_tsquery('english', p.q)) DESC) AS rank
  FROM chunks c, params p
  WHERE c.tenant_id = p.tenant
    AND c.valid_to IS NULL
    AND c.tsv @@ plainto_tsquery('english', p.q)
  LIMIT 50
),
vec AS (
  SELECT c.id,
         row_number() OVER (ORDER BY c.embedding <=> p.qv) AS rank,
         1 - (c.embedding <=> p.qv) AS cosine
  FROM chunks c, params p
  WHERE c.tenant_id = p.tenant AND c.valid_to IS NULL
  ORDER BY c.embedding <=> p.qv
  LIMIT 50
)
SELECT COALESCE(kw.id, vec.id) AS id,
       COALESCE(1.0 / (60 + kw.rank), 0) + COALESCE(1.0 / (60 + vec.rank), 0) AS rrf,
       vec.cosine
FROM kw FULL OUTER JOIN vec ON kw.id = vec.id
ORDER BY rrf DESC
LIMIT 30;

-- Apply the absolute relevance floor to `cosine` and to ts_rank_cd — NOT to the rrf score.
-- An RRF score carries no information about absolute relevance: rank 1 of a garbage result
-- set still scores 1/61. (src/l4/store.ts makes the same mistake first, then fixes it.)

-- ---------------------------------------------------------------------------
-- FACTS: bi-temporal, so updates are invalidations rather than deletions
-- ---------------------------------------------------------------------------
CREATE TABLE facts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject     text NOT NULL,
  predicate   text NOT NULL,
  object      text NOT NULL,
  text        text NOT NULL,
  embedding   vector(1024),
  confidence  real NOT NULL DEFAULT 0.5,
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz,
  supersedes  uuid[] NOT NULL DEFAULT '{}',
  source_run  text,
  last_access timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX facts_current ON facts (subject, predicate, object) WHERE valid_to IS NULL;

-- Current state:      WHERE valid_to IS NULL
-- What we believed:   WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1)
-- Audit trail:        it is just there, for the cost of one nullable column.
