# 09 — Event-Driven Backend Architecture (Blueprint §10)

## 1. Microservices vs modular monolith — the honest analysis

Naive microservices would give this system ~14 services on day one and a distributed-systems
tax before there's traffic to justify it. Naive monolith would weld together components with
wildly different scaling shapes (WS fanout vs. CPU-bound parsing vs. GPU-adjacent AI I/O).

**Decision: services are split by *scaling shape and failure domain*, not by noun.**

| Deployable | Language | Why it's separate |
|---|---|---|
| `core-api` | Go | **Modular monolith** for everything CRUD-shaped: identity, orgs, repos, workspaces, billing, approvals. Internal modules (`identity`, `workspace`, `repo`, `billing`) with enforced import boundaries (go arch-test in CI) — extraction-ready but not extracted |
| `room-router` | Go | Tiny, ultra-available; changes rarely; must survive relay deploys |
| `collab-relay` | Go | Stateful (rooms), connection-heavy, drain-based deploys, scales on conns |
| `workspace-orchestrator` | Go | Saga owner for provisioning; scales on fleet events, must be isolated from CRUD latency |
| `warden` | Go | Per-node agent on execution plane (doc 05) |
| `indexer` + `graph-query` | Rust | CPU-bound, batch-shaped, scales on queue depth |
| `intelligence-api` | TS | Retrieval orchestration (fan-out/fuse/rerank), I/O bound |
| `conductor` | TS | Agent step workers, scales on step queue depth, isolated cost blast-radius |
| `model-gateway` | TS | Single choke-point for budgets/caching/provider failover |
| `timeline-compactor` | Go | Background: JetStream → S3 segments |

Splitting later is easy when boundaries are protobuf contracts from day one; merging later is
easy when services share the monorepo. What's forbidden is the middle hell: shared databases
across services (each deployable owns its tables; cross-service data access goes through APIs
or events, no exceptions).

## 2. Synchronous vs asynchronous rules

- **Sync (gRPC):** queries and commands where the caller needs the answer to proceed
  (authz check, retrieval, VM placement). Budgeted timeouts + circuit breakers (fail fast into
  degraded UX).
- **Async (JetStream):** anything that is a *fact* other services react to (`workspace.opened`,
  `repo.changed`, `agent.step.finished`) and any work queue (indexing, embedding, agent steps,
  exec jobs).
- Litmus test: if the producer doesn't need the consumer to exist, it's an event.

## 3. Subject taxonomy & delivery semantics

```
session.{sessionId}.{crdt|pty|exec|presence}      # SESSION stream, interest 48h
repo.{repoId}.{changed|indexed|pushed}            # REPO stream, work-queue 7d
repo.jobs.{repoId}                                # indexing work queue (per-repo ordering)
embed.jobs                                        # embedding batches
agent.task.{created|updated|finished}             # AGENT stream 30d
agent.run.{runId}.step.{stepId}.{event}           # fine-grained run events
agent.jobs.steps                                  # conductor work queue
agent.approval.{requested|granted|rejected}
exec.{wsId}.{lifecycle|stdout|stdin}              # EXEC stream 24h
exec.jobs.{orgId}                                 # sandboxed run queue w/ per-org limits
sys.audit.*  sys.billing.metering.*               # SYS stream 90d → S3
```

- Delivery is **at-least-once everywhere**; JetStream `Nats-Msg-Id` dedup window (2 min)
  suppresses producer-side duplicates; consumer-side **idempotency is mandatory** and
  code-reviewed: keyed upserts, `(runId, stepId, attempt, seq)` keys for effects,
  version-checked applies for projections.
- **Ordering:** guaranteed per subject; consumers needing cross-subject order (timeline) sort
  by HLC within bounded watermarks (doc 12 §2).
- **Poison messages:** per-consumer max-deliver (5) → DLQ subject (`dlq.{consumer}`) with
  alerting; DLQ drain tooling replays after fix. No consumer silently drops.

## 4. Transactional guarantees — the outbox pattern

Every service that writes Postgres *and* publishes events uses a transactional outbox:

```
BEGIN;
  UPDATE workspaces SET state='provisioning' …;
  INSERT INTO outbox(topic, payload, msg_id) VALUES (…);
COMMIT;
-- relay goroutine: poll/NOTIFY outbox → publish w/ Nats-Msg-Id=msg_id → mark sent
```

This kills the "DB committed but event lost" class of bugs. Consumers get at-least-once with
dedup; combined with idempotent handlers → effectively-once processing.

## 5. Saga: workspace provisioning (the canonical example)

Orchestrated saga (explicit orchestrator > choreography for anything with compensations —
debuggability wins):

| Step | Action | Compensation |
|---|---|---|
| 1 | reserve quota (core-api) | release quota |
| 2 | allocate/stage volume (S3→node NVMe) | release volume claim |
| 3 | place VM (orchestrator → warden.CreateVM) | warden.DestroyVM |
| 4 | attach net + identity (SPIFFE SVID, egress tier) | revoke identity |
| 5 | boot / snapshot-resume; health gate | destroy |
| 6 | clone/sync repo into volume (skip on resume) | none (volume discarded by 2⁻¹) |
| 7 | emit `workspace.ready`; update state row | emit `workspace.failed` |

Saga state machine persists in Postgres (`saga_instances`: id, kind, step, state, payload,
attempt, next_retry_at); crash-safe, resumable, visible in an internal admin UI. Retries with
decorrelated jitter; steps are idempotent (warden CreateVM with same idempotency key returns
the existing VM).

**Distributed locking:** single-runner-per-workspace enforced by lease in Postgres
(`node_lease` with expiry, compare-and-swap updates) — *not* Redis locks; correctness locks
live in the consistent store, Redis only holds convenience state.

## 6. Protobuf contracts (`proto/` tree, buf-managed, breaking-change CI)

```protobuf
syntax = "proto3";
package atelier.exec.v1;

service Warden {
  rpc CreateVM(CreateVMRequest) returns (CreateVMResponse);
  rpc SnapshotVM(SnapshotVMRequest) returns (SnapshotVMResponse);
  rpc ResumeVM(ResumeVMRequest) returns (ResumeVMResponse);
  rpc DestroyVM(DestroyVMRequest) returns (DestroyVMResponse);
  rpc Exec(stream ExecInput) returns (stream ExecOutput);   // bidi: stdin/resize ↔ out/lifecycle
}

message CreateVMRequest {
  string idempotency_key = 1;
  string workspace_id = 2;
  string org_id = 3;
  EnvSpec env = 4;                  // image ref, resources, egress tier
  oneof source { string volume_snapshot_key = 5; string memory_snapshot_key = 6; }
}

message ExecOutput {
  string stream_id = 1;
  uint64 seq = 2;
  oneof payload { bytes stdout = 3; bytes stderr = 4; Lifecycle lifecycle = 5; }
}
```

```protobuf
package atelier.events.v1;         // envelope for ALL JetStream payloads

message EventEnvelope {
  string event_id = 1;             // ulid; doubles as Nats-Msg-Id
  bytes  hlc = 2;                  // hybrid logical clock (doc 12)
  string org_id = 3;
  Actor  actor = 4;                // {type: USER|AGENT|SYSTEM, id}
  google.protobuf.Any payload = 5;
  string schema_version = 6;
}
```

Schema evolution rules: additive fields only within a major version; new majors are new
subjects (`…v2`) with dual-publish migration windows; `buf breaking` gates CI.

## 7. Service interaction flow example — "agent step needs to run tests"

```
conductor(step worker) ──gRPC──▶ orchestrator.AcquireSandbox(runId)      [sync: needs answer]
  orchestrator: lease check → warden.CreateVM(snapshot clone)            [sync chain]
conductor ──publish──▶ exec.jobs.{orgId} {runId, cmd:"pnpm test …"}      [async: queued, budgeted]
warden(consumer) → guest exec → stream exec.{wsId}.stdout                 [events]
warden ──publish──▶ exec result event {exit, artifacts}                   
conductor(consumer) → fold into step state → gates → step.finished        [events]
relay(subscribed to run events) → IDE agent panel updates live            [fanout]
```

Every hop carries the OTel trace context inside the envelope → one flame graph across five
services and two languages (doc 10).

## 8. Resilience defaults (applied platform-wide)

- Timeouts: every sync call has one (default 2 s intra-plane, explicit override with comment).
- Retries: only on idempotent operations, budgeted (max 2), decorrelated jitter, retry
  budgets per client (10% of calls) to prevent retry storms.
- Circuit breakers on all cross-plane gRPC clients; degraded modes are designed, not
  discovered (intelligence down → editor still types; model-gateway down → agents pause with
  status, humans unaffected; Postgres down → relay keeps rooms alive read-write with
  persistence buffering to JetStream).
- Load shedding: gateway sheds by endpoint class (agent task creation before workspace open;
  everything before CRDT sync).
