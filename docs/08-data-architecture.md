# 08 — Data Architecture (Blueprint §9)

Systems of record and their division of labor:

| Store | Owns | Never stores |
|---|---|---|
| **Postgres** (logical DBs: `core`, `intel`, `timeline`) | identity, tenancy, workspace/repo metadata, agent runs, audit, vector chunks (phase 1) | file contents, hot event streams |
| **NATS JetStream** | in-flight events (hours–days horizon) | anything long-term |
| **S3** | CRDT snapshots, replay segments, graph artifacts, volume snapshots, large agent artifacts | queryable metadata |
| **Redis** | directories (room→relay), presence, rate limits, caches | anything unrecoverable |
| **ClickHouse** (Scale phase) | analytics-grade event history (product + billing queries) | source-of-truth anything |

Multi-tenancy: every row carries `org_id`; **Postgres RLS enabled on all tenant tables** as
defense-in-depth under app-layer scoping (`SET LOCAL app.org_id = …` per transaction).
Tenant-partitionable keyspace everywhere → org-id sharding is a mechanical migration later.

---

## 1. Core relational schema (`core` DB — representative DDL)

```sql
-- ── identity & tenancy ────────────────────────────────────────────────
CREATE TABLE orgs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          citext UNIQUE NOT NULL,
  name          text NOT NULL,
  plan          text NOT NULL DEFAULT 'free',          -- free|team|enterprise
  policy        jsonb NOT NULL DEFAULT '{}',           -- egress tier, agent autonomy, retention
  kms_key_arn   text,                                  -- per-tenant envelope encryption (ent)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  display_name  text NOT NULL,
  avatar_url    text,
  auth_provider text NOT NULL,                          -- oidc issuer key
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_members (
  org_id   uuid REFERENCES orgs(id),
  user_id  uuid REFERENCES users(id),
  role     text NOT NULL CHECK (role IN ('owner','admin','member','guest')),
  PRIMARY KEY (org_id, user_id)
);

-- ── repos & workspaces ────────────────────────────────────────────────
CREATE TABLE repos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id),
  name          citext NOT NULL,
  origin_url    text,                                   -- external remote (GitHub etc.)
  mirror_ref    text NOT NULL,                          -- internal bare-repo location
  default_branch text NOT NULL DEFAULT 'main',
  index_version bigint NOT NULL DEFAULT 0,              -- latest graph artifact version
  UNIQUE (org_id, name)
);

CREATE TABLE workspaces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id),
  repo_id       uuid REFERENCES repos(id),
  name          text NOT NULL,
  env_spec      jsonb NOT NULL,                         -- image, resources, ports
  state         text NOT NULL DEFAULT 'archived',       -- lifecycle enum (doc 05 §5)
  node_lease    jsonb,                                  -- {nodeId, leaseExpiry} single-runner guard
  volume_snap   text,                                   -- s3 key of latest volume snapshot
  mem_snap      text,                                   -- s3 key of latest memory snapshot
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON workspaces (org_id, state);

-- files: METADATA ONLY — content lives in workspace volume + CRDT + git mirror
CREATE TABLE file_meta (
  workspace_id  uuid REFERENCES workspaces(id),
  path          text,
  doc_id        uuid,                                   -- CRDT subdoc id (null if never edited)
  blob_hash     bytea,                                  -- last synced content hash (merkle leaf)
  updated_at    timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, path)
);

-- ── collaboration sessions ────────────────────────────────────────────
CREATE TABLE collab_sessions (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  org_id        uuid NOT NULL,
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  participants  jsonb NOT NULL DEFAULT '[]',            -- [{userId|agentId, joinedAt, leftAt}]
  segment_manifest text                                 -- s3 key of replay manifest (doc 12)
);

-- ── executions ────────────────────────────────────────────────────────
CREATE TABLE executions (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL,
  org_id        uuid NOT NULL,
  session_id    uuid,
  kind          text NOT NULL,                          -- pty|run|agent_tool
  initiator     jsonb NOT NULL,                         -- {type: user|agent, id}
  command       text,
  exit_code     int,
  resource_usage jsonb,                                 -- cpu_ms, max_rss, io_bytes (billing)
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz
) PARTITION BY RANGE (started_at);                      -- monthly partitions, 12mo hot

-- ── agents ────────────────────────────────────────────────────────────
CREATE TABLE agent_runs (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  workspace_id  uuid NOT NULL,
  goal          text NOT NULL,
  status        text NOT NULL,       -- planning|running|awaiting_approval|done|failed|aborted
  graph_version bigint NOT NULL,                        -- pinned intelligence version
  budget        jsonb NOT NULL,      -- {usdCap, tokenCap, spent…} ledger summary
  confidence    real,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE TABLE agent_steps (
  run_id        uuid REFERENCES agent_runs(id),
  step_id       text,
  role          text NOT NULL,                          -- planner|coder|tester|…
  depends_on    text[] NOT NULL DEFAULT '{}',
  state         text NOT NULL,
  attempts      int NOT NULL DEFAULT 0,
  confidence    real,
  PRIMARY KEY (run_id, step_id)
);

-- event-sourced truth for runs (folded state above is a projection)
CREATE TABLE agent_events (
  run_id        uuid,
  seq           bigint,                                 -- per-run monotonic
  hlc           bytea NOT NULL,
  kind          text NOT NULL,                          -- model.call|tool.result|… (doc 07 §1)
  payload       jsonb NOT NULL,                         -- large blobs → artifact refs
  PRIMARY KEY (run_id, seq)
) PARTITION BY HASH (run_id);

-- AI traces: one row per model call (queryable cost/latency analytics)
CREATE TABLE ai_traces (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  run_id        uuid, step_id text,
  model_id      text NOT NULL,
  prompt_hash   bytea NOT NULL,
  input_tokens  int, output_tokens int, cache_read_tokens int,
  cost_usd      numeric(10,6),
  latency_ms    int,
  stop_reason   text,
  otel_trace_id bytea,
  created_at    timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

-- ── approvals & audit ─────────────────────────────────────────────────
CREATE TABLE approvals (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, run_id uuid NOT NULL,
  step_id text, requested_at timestamptz NOT NULL,
  decided_by uuid REFERENCES users(id), decision text,  -- granted|rejected|edited
  decision_detail jsonb, decided_at timestamptz
);

CREATE TABLE audit_log (                                 -- append-only, INSERT-only role
  id bigint GENERATED ALWAYS AS IDENTITY,
  org_id uuid NOT NULL, actor jsonb NOT NULL, action text NOT NULL,
  target jsonb, ip inet, at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
) PARTITION BY RANGE (at);
```

## 2. Intelligence schema (`intel` DB)

```sql
CREATE TABLE chunks (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  repo_id       uuid NOT NULL,
  graph_version bigint NOT NULL,
  path          text NOT NULL,
  span          int8range NOT NULL,                     -- byte range
  lang          text NOT NULL,
  symbol_ids    bigint[] NOT NULL DEFAULT '{}',
  content_hash  bytea NOT NULL,
  header        text NOT NULL,                          -- context header (doc 06 §5)
  embedding     vector(1024)                            -- pgvector, phase 1
);
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON chunks (repo_id, path);
CREATE UNIQUE INDEX ON chunks (repo_id, content_hash, span);

CREATE TABLE repo_facts (
  repo_id uuid, fact_key text, fact text NOT NULL,
  evidence jsonb NOT NULL,                              -- [{path, span}]
  confidence real NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (repo_id, fact_key)
);

CREATE TABLE summaries (
  repo_id uuid, scope_path text, level smallint,        -- 0=file 1=module 2=repo
  merkle bytea NOT NULL,                                -- subtree hash for drift invalidation
  body text NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (repo_id, scope_path, level)
);
-- Phase-1 graph tables (symbols, edges) mirror doc 06 §3; replaced by artifacts in Phase 3.
```

## 3. Timeline schema (`timeline` DB) — pointers, not payloads

```sql
CREATE TABLE replay_segments (
  session_id    uuid,
  seq           int,                                    -- segment ordinal
  hlc_range     bytea[2],
  channels      text[] NOT NULL,                        -- crdt|pty|exec|agent|presence
  s3_key        text NOT NULL,
  frame_count   int, bytes int,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE snapshots (
  session_id uuid, hlc bytea, kind text,                -- doc|terminal|full
  s3_key text NOT NULL, PRIMARY KEY (session_id, hlc, kind)
);
```

## 4. Partitioning, indexing, retention strategy

- **Time-range partitioning** on all event-shaped tables (`executions`, `ai_traces`,
  `audit_log`) with `pg_partman`; partitions dropped/exported to S3 parquet per retention
  policy (audit: export, never drop).
- **Hash partitioning** on `agent_events(run_id)` — access is always per-run.
- Index discipline: every index justified by a named query; quarterly `pg_stat_user_indexes`
  reaping. Covering indexes for the two hottest paths: workspace list per org, task list per
  workspace.
- **Caching strategy:** Redis layers — (a) directory data (room→relay, presence) TTL 10s,
  (b) authz decisions `(user, resource, action)` TTL 30s with explicit bust on membership
  change, (c) retrieval results keyed by `(queryHash, graphVersion)` — immutable by
  construction, LRU. Nothing cached without an invalidation story written next to it.

## 5. Event sourcing boundaries

Event-sourced: **agent runs** (`agent_events`) and **sessions** (JetStream → S3 segments).
Deliberately *not* event-sourced: org/user/workspace metadata — CRUD rows with an audit log
give 90% of the value at 10% of the complexity. Being selective here is a senior-engineering
signal, not a compromise: event-source where you need replay/branching (runs, sessions),
audit-log where you need "who changed what" (settings), plain rows elsewhere.
