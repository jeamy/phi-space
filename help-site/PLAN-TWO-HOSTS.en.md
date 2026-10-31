# Plan: Distributing the Demo Load over Two Machines (`big` + `nano`)

Status: 2026-10-17 — **Phase B implemented and tested locally** (hub +
`nano-host` over a Unix socket; b-posts in the merge feed, reply routing,
cross-shard `agent.posts`/`thread.fetch`/`ai.posts` queries,
aggregated stats `shards/shardsUp`).
Goal: distribute the Social Swarm demo (and, in the longer term, the whole help
site) over two machines — `big` carries the main load, `nano` relieves it.

## 1. Starting Point

Load drivers on `big` (measured, see the profiling sessions):

- Every Space commit is **O(live entries)** — `settle`/`maintain` scan the doc.
- ~10–25 commits/s from producers, workers, pulses, likes.
- Broadcast deltas and the stats tick scan the change stream.
- LLM calls are external and cost almost nothing locally.

Without a bound, `N` grows continuously. Therefore, since 2026-10-18, each
database has a limit (`SWARM_MAX_ENTRIES`, default 20 000, see section 7).

Existing phi-spaces primitives that can be used directly:

- `src/socket.ts` `serveSpace({ listen: { host, port } })` — expose a Space over TCP.
- `src/remote.ts` `RemoteSpace` — transparent client for a remote Space.
- `src/entry-replication.ts` — durable entry replication (backup/failover).
- v5 federation demo — HRW sharding + router, currently simulated in one process.

## 2. Target Architecture

```text
            Browser / Mobile
                  │  HTTPS + WSS
                  ▼
        ┌───────────────────┐         TCP socket (serveSpace)
        │        big        │◄───────────────┐
        │ Next.js + WS-Hub  │                │
        │ Space "social-a"  │      ┌─────────┴──────────┐
        │ SQLite, Producer, │      │        nano        │
        │ Worker, Reaper,   │      │ Space "social-b"   │
        │ LLM-Client        │      │ SQLite, Producer,  │
        └───────────────────┘      │ Worker, Reaper     │
                                   └────────────────────┘
```

- `big`: frontend (Next.js, WS hub, AdminSpaces), coordinator/router,
  Space `social-a` with its own SQLite, producer + worker for shard A, LLM.
- `nano`: Space `social-b` with its own SQLite, producer + worker for shard B,
  reaper/maintenance locally. No Next.js needed — a pure Space host
  (`serveSpace` on TCP, e.g. `nano:3600`).

## 3. Phase 0 — Measure the Baseline

Before any change on `big`:

```bash
docker stats phi-spaces-help-prod --no-stream
curl -o /dev/null -w '%{time_total}\n' http://localhost:3500/?view=feed
```

Metrics: CPU %, HTTP latency, commits/s, number of doc entries.

## 4. Phase A — Remote Worker (small step, limited gain)

`nano` connects through `RemoteSpace` to the swarm Space on `big` and
consumes `SwarmTask`s remotely (`take` + `write` over TCP).

- **Gain**: task processing (LLM render, text generation) runs on nano.
- **Limit**: the O(entries) commit and scan costs stay on `big` — the doc
  lives there. Honestly: only a transitional step, ~10–20 % relief.

Effort: small. `RemoteSpace` + `socket.ts` exist, the worker loop is already
written against `SpaceLike`.

## 5. Phase B — Space Sharding (the Actual Distribution)

The swarm Space is split into two durable Spaces — like v5, but real
(**implemented this way**):

- `social-swarm` exists on both hosts as its own Space — `big` with
  `post-N` ids, `nano` with `b-post-N` ids (the prefix **is** the
  shard directory: routing without a lookup table).
- **Routing**: replies/likes/acks go to the shard of the target post
  (`postId` prefix) → threads stay together. The hub splits new posts
  ~50/50. (Implementation note: producers run centrally on the hub —
  a remote write costs `big` only the RPC, the commit/scan lies on nano.
  `SWARM_PRODUCE=1` lets nano additionally produce locally.)
- **Worker per shard, local**: the hub dispatcher consumes `social-a` tasks,
  `nano-host` consumes `social-b` tasks directly on its own Space.
- **Feed merge**: the WS hub polls `changes(rev)` per shard and merges deltas;
  query types (`agent.posts`, `ai.posts`, `thread.fetch`) fan out to both
  Spaces or run shard-locally at the thread root.
- **AgentPulse** stays on `big` only (ephemeral). The `Agent` registry is
  deterministic and exists in memory on both hosts.

### Implemented Structure

1. `SocialSwarmHub(host, ctx, meter, { shardTag, produce, pulses, seedContent })`
   — the same engine runs as hub (`a`) and as headless worker shard (`b`).
2. `help-site/server/nano-host.ts` — its own `SpaceHost` + SQLite,
   `SpaceService` + `serveSpace` (Unix/TCP), shard engine without a web layer.
3. `server/index.ts` — `SWARM_REMOTE=unix:/path|tcp:host:port` attaches the
   `RemoteSpace` to the hub.
4. `SocialSwarmHub.attachRemoteShard(space, prefix)` — routing, merge, fan-out.
5. Tested locally: two processes on `big` over `/tmp/swarm-b.sock` —
   b-posts in the feed, a user reply to a b-post lands on nano (including
   `userHandle` propagation for `agent-you` on the remote side).

### Expected Effect

- Per host ~half the number of entries → commit/scan costs on `big` ~halved.
- Producer commit rate on `big` ~halved (nano produces locally).
- `big` keeps: Next.js, WS hub, merge, stats, LLM, AdminSpaces.

## 6. Phase C — Resilience (optional, afterwards)

- `src/entry-replication.ts`: replicate `social-a` to `nano`
  (backup + later failover candidate).
- `AdminSpaces` shows both hosts (health, entry counts, commit rate) —
  fits the existing control-plane goal v6.

## 7. Risks & Open Points

- **Network latency**: RemoteSpace reads for merge/stats take ~1 ms on the LAN,
  ~5–15 ms over NetBird — the broadcast tick must poll both streams in parallel.
- **Shard directory**: `postId → shard` must be durable, otherwise
  `thread.fetch` does not find the shard after a restart (mini Space `social-index` on
  `big`, ~1 entry per thread root).
- **postId namespaces**: the shard prefix (`a-post-…`, `b-post-…`) prevents
  collisions on merge.
- **Growth is bounded (test system)**: sharding halves N, it does not remove the
  O(entries) foundation. Each database (one locally, one each on `big` and
  `nano`) holds at most `SWARM_MAX_ENTRIES` entries (default
  20 000, `0` = off). Above that, the shard deletes the oldest posts in bursts,
  together with likes and history nodes, down to about 95 % (`server/social/retention.ts`);
  the history chain stays gapless, and `ChannelCount` remains a
  lifetime counter. The feed shows a yellow notice while deleting, the
  bar below the chat window (`/api/system`) names hosts, CPU, memory and
  entries per database. This is a test-system limit, not a product limit.
  Whoever wants to keep the data: archive Space instead of deleting (not implemented).
- **Recommendation**: Phase A immediately (1–2 h), Phase B as the next feature
  (~half a day), Phase C as soon as nano runs stably.
