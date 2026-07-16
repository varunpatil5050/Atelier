# Atelier — AI-Native Collaborative Coding Platform

**Implementation Blueprint · v1.0 · July 2026**

> Codename **Atelier** (a workshop where multiple craftspeople work on one piece).
> Rename freely — every doc refers to services by role, not brand.

Atelier is a browser-based cloud development environment where **humans and autonomous AI
agents are first-class collaborators in the same live workspace**: same CRDT document space,
same terminals, same debugging sessions, same replayable timeline. It combines a multiplayer
IDE, a Firecracker-isolated execution plane, a repository intelligence engine (AST + graph +
embeddings), and an event-sourced multi-agent orchestration system.

This is a production-grade architecture document set, not a tutorial. Read it in order the
first time; afterwards each doc stands alone.

## Document map

| Doc | Covers | Blueprint sections |
|---|---|---|
| [01 — Vision & System Overview](docs/01-vision-and-overview.md) | Product vision, differentiation, full architecture, data flows, request lifecycles | 1, 2 |
| [02 — Tech Stack Decisions](docs/02-tech-stack.md) | Every technology choice with rationale, tradeoffs, rejected alternatives | 3 |
| [03 — Frontend Architecture](docs/03-frontend.md) | IDE shell, editor, state, routing, plugins, a11y, offline | 4 |
| [04 — Real-Time Collaboration Engine](docs/04-collaboration-engine.md) | CRDTs, Yjs vs Automerge, relay design, scaling, persistence, terminals | 5 |
| [05 — Cloud Execution Engine](docs/05-execution-engine.md) | Firecracker/gVisor, warden agent, isolation, hibernation, preview routing | 6 |
| [06 — Repository Intelligence](docs/06-repo-intelligence.md) | tree-sitter, code graph, embeddings, hybrid retrieval, incremental indexing | 7 |
| [07 — Autonomous Agent System](docs/07-agent-system.md) | Conductor orchestrator, agent roster, verification, budgets, approval flows | 8 |
| [08 — Data Architecture](docs/08-data-architecture.md) | Full DDL, partitioning, vector/graph storage, multi-tenancy, event sourcing | 9 |
| [09 — Event-Driven Backend](docs/09-backend-architecture.md) | Service boundaries, NATS JetStream, sagas, idempotency, protobuf contracts | 10 |
| [10 — Observability & Security](docs/10-observability-security.md) | OTel, SLOs, AI tracing, threat model, sandbox security, prompt injection | 11, 12 |
| [11 — Scaling & Performance](docs/11-scale-and-performance.md) | 10 → 1M users, per-plane scaling, performance budgets, caching | 13, 14 |
| [12 — Replayable Development Timeline](docs/12-replay-timeline.md) | Unified event log, snapshots, scrubbing, deterministic agent replay | 15 |
| [13 — CI/CD & Roadmap](docs/13-cicd-roadmap.md) | Monorepo, pipelines, testing strategy, phased roadmap MVP → scale | 16, 17 |
| [14 — Showcase & Open Source Strategy](docs/14-showcase-and-oss.md) | Resume/recruiter positioning, demos, OSS component strategy | 18, 19 |
| [15 — Final Deliverables](docs/15-deliverables.md) | Folder trees, K8s manifests, protobufs, API/WS protocol, GH Actions, Terraform | 20 |

## The one-paragraph architecture

Five planes, each independently scalable, connected by **NATS JetStream** and **gRPC**:

1. **Edge/Web plane** — Next.js app + Monaco-based IDE shell; WebSocket to the collab relay.
2. **Collaboration plane** — Go relay nodes hosting Yjs CRDT rooms (single-homed, consistently
   hashed), persisting update logs to JetStream and snapshots to S3.
3. **Control plane** — Go modular monolith (`core-api`) owning identity, workspaces, repos,
   billing, and the provisioning sagas; Postgres as system of record.
4. **Execution plane** — bare-metal nodes running Firecracker microVMs under a custom `warden`
   agent (gVisor-on-K8s in earlier phases); serves terminals, runs, previews, and agent sandboxes.
5. **Intelligence plane** — Rust `indexer` (tree-sitter → SCIP-like symbol/code graph +
   embeddings) and TypeScript `conductor` (event-sourced multi-agent orchestration on Claude).

Everything user-visible — keystrokes, terminal bytes, agent reasoning steps, execution events —
is an event on a per-session log, which is what makes the **replayable development timeline**
(doc 12) a storage format rather than a feature bolted on later.
