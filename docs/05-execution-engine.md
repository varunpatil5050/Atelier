# 05 — Cloud Execution Engine (Blueprint §6)

The execution plane runs **untrusted code from three sources**: users, users' dependencies
(`npm install` is arbitrary code execution), and AI agents. Design goals: hard multi-tenant
isolation, cold start ≤ 2 s (resume) / ≤ 8 s (cold), hibernation economics that make idle
workspaces nearly free, and streaming I/O into the collaboration plane.

---

## 1. Threat-driven requirements

| Threat | Requirement |
|---|---|
| Kernel exploit from tenant code | Guest kernel ≠ host kernel → **virtualization boundary**, not just namespaces |
| Cross-tenant network access | Per-workspace network namespace, default-deny east-west |
| Data exfil / abuse (cryptomining, spam) | Egress proxy with policy, CPU ceilings, anomaly metering |
| Agent-run code doing agent-level damage | Agent sandboxes = same isolation as user workspaces, *plus* stricter egress + FS scoping |
| Resource starvation of neighbors | cgroup v2 hard limits: cpu.max, memory.max+swap off, io.max, pids.max |

## 2. Isolation technology: Firecracker vs Docker vs gVisor vs Kata

| | Plain Docker/runc | gVisor (runsc) | Kata Containers | **Firecracker microVM** |
|---|---|---|---|---|
| Boundary | shared kernel, namespaces+seccomp | userspace kernel intercepting syscalls | lightweight VM per pod | minimal VMM, VM per workspace |
| Kernel escape blast radius | host | strongly reduced | VM boundary | VM boundary |
| Syscall perf | native | 10–30% penalty (I/O heavy worse) | near-native | near-native |
| Cold start | ~300 ms | ~500 ms | 1–3 s | **~125 ms boot; snapshot-resume ~200 ms–1 s** |
| Memory snapshot/resume | no | no | limited | **yes (uffd-backed, page-lazy)** |
| K8s integration | native | RuntimeClass | RuntimeClass | DIY (or via Kata-fc) |
| Ops complexity | low | low-medium | medium | **high (own the orchestration)** |

**Phased decision:**
- **Phase 1–2 (MVP/Alpha):** gVisor on EKS via RuntimeClass. One `workspace` pod per user
  workspace. Ships isolation *this month* with pure-K8s ops. Accepted costs: I/O syscall
  penalty, no memory snapshots (hibernation = stop + disk only).
- **Phase 3+ (Beta/Prod):** **Firecracker on bare-metal EC2 (`m6i.metal` class) with a custom
  node agent (`warden`)**. Motivations that force the migration: memory-snapshot resume (the
  hibernation/cold-start economics), higher density (no pod overhead; 150–300 microVMs/node),
  and I/O-heavy workloads (installs, builds) hurting under gVisor.
- **Rejected as primary:** Kata (viable, but if we're operating VMs we want Firecracker's
  snapshot API directly), plain Docker (unacceptable boundary for tenant code).

## 3. Node anatomy (Firecracker phase)

```
bare-metal node
├── warden (Go, static binary, systemd)          ← the only privileged process
│   ├── gRPC server (mTLS/SPIRE) ← workspace-orchestrator
│   ├── VM lifecycle: create/boot/pause/snapshot/resume/destroy (Firecracker API socket)
│   ├── device mgmt: tap devices, block devices, vsock
│   ├── PTY/exec mux ↔ guest-agent (vsock) ↔ NATS exec.* subjects
│   ├── preview proxy registrations → preview-router
│   └── node telemetry: density, memory pressure, warm-pool state
├── jailer-wrapped firecracker processes (one per microVM)
│   └── guest: minimal kernel (5.10-lts, custom config) + rootfs
│       └── guest-agent (Go, PID 1 supervisor)
│           ├── PTY manager (creates shells, resize, kill)
│           ├── exec service (run configs, structured lifecycle events)
│           ├── doc-fs sync (CRDT↔disk, doc 04 §3)
│           ├── FS watcher → repo.changed events
│           └── LSP/DAP supervisor (per-language servers)
└── local NVMe: rootfs image cache, snapshot cache, workspace volume staging
```

**Why warden isn't kubelet:** scheduling microVMs is bin-packing on *memory + warm-pool
affinity + snapshot locality* with sub-second placement decisions and per-VM device plumbing
(tap, vsock, block). Modeling each microVM as a K8s pod adds seconds of latency and an
abstraction fighting us at every step. The execution plane instead exposes *node inventory* to
the workspace-orchestrator (control plane), which does placement. Kubernetes still runs
everything else — this is "K8s for the control plane, purpose-built agent for the data plane",
the same conclusion Fly.io/CodeSandbox/Modal reached.

## 4. Workspace filesystem

- **Layered:** base rootfs (per-stack image: `base-node20`, `base-py312`, `base-go122`;
  read-only, content-addressed, cached on NVMe) + **workspace volume** (ext4 on a sparse file
  or EBS attach) mounted at `/workspace` + tmpfs scratch.
- Images built with BuildKit from a devcontainer-compatible spec (`.atelier/env.yaml` →
  supports `devcontainer.json` import); lazy-pulled with eStargz so first-boot doesn't wait
  for full image download.
- **Persistent volumes:** workspace volume is the durable artifact. Idle → volume snapshot to
  S3 (block-diff via reflink-aware differ); destroy → snapshot retained per retention policy.
  Restore = S3 → NVMe stage → boot. EBS multi-attach is *not* used (workspace runs on exactly
  one node at a time; enforced by orchestrator lease in Postgres).
- **Git:** the workspace clone is the working truth; server-side mirror (bare repo per repo in
  the control plane's git service) enables indexing without a live workspace and agent
  branches without touching user working trees.

## 5. Lifecycle & hibernation

```
REQUESTED → SCHEDULED → PROVISIONING → RUNNING ⇄ PAUSED(hot) → HIBERNATED(warm) → ARCHIVED(cold)
                                          │
                                          └→ SNAPSHOTTING → (resume path)
```

- **PAUSED (hot, seconds–minutes idle):** Firecracker pause; memory retained; resume <100 ms.
  Used aggressively between bursts of activity (typing pauses don't count — only full
  disconnect).
- **HIBERNATED (warm, minutes–days):** memory snapshot + device state → local NVMe (and
  async → S3); VM destroyed. Resume: uffd lazy-paging from snapshot → **~500 ms–1.5 s** to an
  *identical* running state — shells, REPLs, dev servers all alive. This is the flagship demo:
  close laptop mid-debug, reopen tomorrow, the debugger is still at your breakpoint.
- **ARCHIVED (cold):** volume snapshot only in S3; full boot path (~8 s: stage volume 3s, boot
  1s, services 4s).
- Policies per plan tier: e.g. pause@2min disconnect, hibernate@30min, archive@7d.

## 6. Cold-start reduction stack

1. Warm pools of pre-booted generic microVMs per stack (kernel+base rootfs booted, guest-agent
   idle) → "provisioning" = attach volume + netns + identity ≈ 300 ms.
2. Snapshot-resume for anything previously run (§5).
3. eStargz lazy image pull + NVMe content cache with LRU.
4. Predictive warm-up: workspace-orchestrator subscribes to `session.presence` (user opened
   dashboard → prewarm their most-recent workspace) — cheap, dramatic perceived-latency win.

## 7. Networking

- Per-VM tap device in an isolated netns; no VM↔VM L2/L3 path (no shared bridge; per-VM /30
  point-to-point to host).
- **Egress:** default-deny except through the node-local **egress proxy** (Envoy):
  DNS-pinned allowlist per policy tier (package registries, github.com, org-configured hosts);
  agent sandboxes get a stricter tier (registries only by default). All flows logged
  (metered, feeds abuse detection).
- **Ingress = preview routing:** guest declares listening ports (guest-agent netlink watch) →
  warden registers `{wsId, port} → nodeIp:mappedPort` with **preview-router**;
  `https://{port}--{wsId}.preview.atelier.dev` terminates TLS at the edge (wildcard cert),
  authenticates (workspace membership cookie or public-share token), and proxies WS-capable
  traffic to the node. Private-by-default; public sharing mints a scoped token.

## 8. Execution & streaming

- **Interactive PTYs:** doc 04 §7 covers the collab semantics; transport is guest-agent →
  vsock → warden → NATS `exec.{wsId}.stdout` → relay → clients, with seq numbers and ring
  buffers at the warden for gap replay.
- **Structured runs** (run configs, tasks, agent tool executions): `exec.run.requested`
  {cmd, cwd, env, limits, artifactGlobs} → guest-agent runs under a dedicated cgroup slice →
  lifecycle events (`started/exited{code}/oomkilled`) + streamed output + collected artifacts
  to S3. Runs are first-class timeline events → replayable.
- **Execution queues:** agent-initiated runs enqueue on JetStream work-queue
  `exec.jobs.{orgId}` with per-org concurrency budgets (consumer `MaxAckPending` per org) —
  a runaway agent can't monopolize the plane. Interactive human commands bypass the queue
  (direct PTY) but count against cgroup limits.

## 9. Resource limits & autoscaling

- Per-VM: vCPU (cpu.max on the firecracker thread cgroup), memory.max (VM ballon + hard cap),
  io.max on the block device, pids via guest cgroups; per-org aggregate caps enforced by the
  orchestrator at admission.
- **Plane autoscaling:** orchestrator tracks fleet headroom (schedulable memory, warm-pool
  depth). Below watermark → scale-up via ASG (metal instances, 5–8 min lead — hence
  predictive watermarks sized to absorb a demo-day spike); scale-down = cordon → drain
  (hibernate idle VMs, live-migrate-by-snapshot the rest) → terminate.
- Density target: 256 GB node ≈ 200 hibernation-heavy workspaces or ~60 hot ones; cost model
  in doc 11 §4.

## 10. Warden internals worth building carefully

- **Jailer:** every firecracker process wrapped in FC's jailer (chroot, dedicated uid/gid,
  cgroup, seccomp) — defense-in-depth *around* the VMM itself.
- **Crash containment:** warden supervises FC processes; guest panic → event → auto-restart
  from last snapshot with exponential backoff; node-level warden crash → systemd restart →
  state resync from FC API sockets + orchestrator reconciliation (orchestrator holds desired
  state in Postgres; warden is level-triggered, reconciling like a kubelet).
- **Everything is an event:** VM lifecycle transitions publish to `exec.{wsId}.lifecycle` —
  the IDE status pill, the timeline, and billing metering are all just consumers.
