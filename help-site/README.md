# phi-spaces Help & Multiplayer Chat (`help-site`)

[English](README.md) · [Deutsch](README_DE.md)

> Upgrade warning: the complete namespace change includes persistent `phi-spaces.*` document kinds.
> Do not run this version against an existing store without a verified offline migration and recovery copy.
> This change does not automatically migrate stored documents. See the [namespace report](../docs/namensumstellung-2026-10-18.md).

This directory contains the runnable Node.js/React help system, **PHI-SPACES / HELP**: bilingual documentation,
the six-stage Multiplayer Space-Chat workbench, the Social Swarm feed, and authenticated Web Admin.

Checked against the checkout on 2026-10-18. A working demo is not a multi-host or production acceptance result.
See [implementation status](../docs/implementierungsstand.md), the
[Phase-3 acceptance matrix](../docs/abnahme/ap3-abnahme.md), and the
[demo analysis and completed fixes](../docs/_attic/analyse-hilfesystem-demo-apps-2026-10-18.md).

## What the demos demonstrate

The root README explains [tuple spaces, JavaSpaces and phi-spaces](../README.md#tuple-spaces-coordination-through-data).
Here the model is executable: producers publish `SwarmTask`/`ChatTask` Entries rather than calling a particular
worker; workers claim matching tasks and publish results transactionally. A later consumer requires the task's
lease and storage to outlive the delay. A task is data, not a direct reference to its producer.

What **phi-spaces actually implements**:

- `write`, `read` and `take` return Promises. A completed write confirms its storage mutation, not consumer completion.
- A pending `await read/take` suspends its caller, not the entire JavaScript event loop.
  `NO_WAIT` skips waiting for a future match, but does not eliminate operation/commit latency.
- `wait` persists a one-shot registration; `notify` persists a leased subscription. They return registration
  information, with events delivered later. `space_wait` lets an agent finish its turn after registration.
  `startService` runs local maintenance and delivery.
- The Swarm uses one bounded polling dispatcher, not a permanent blocking take per agent.
  Agent counts represent simulated identities, not thousands of processes or simultaneous model calls.
- Storage serialization and CPU work can still occupy the event loop. Async APIs do not remove quotas,
  network failures or the cost of a large Space document.

## Endpoints and operating scope

- **Target public domain:** `https://spaces.eibrain.org`; Chat WebSocket `/ws/chat/:sessionId`,
  feed WebSocket `/ws/feed`. The domain is a deployment target, not evidence that this checkout is published.
- **Local default:** port `3500`, overridden by `PORT` or `HELP_PORT`. Direct startup uses `HELP_BIND`;
  production Docker uses host networking and `HOST_BIND`. Explicitly use `127.0.0.1` for local-only access.
- **Web Admin:** `/?view=admin` controls the configured instance's Spaces, runs, workers, deployment plans,
  alerts and keys after login. It does not automatically authorize control of unrelated hosts.
- **Mobile:** shares operational building blocks with `pi-termux-mobile` (`spaces.html`, `steuerung.html`,
  `runtime/spaces-mobile.mjs`). Android Keystore, enrollment and NetBird operation require separate
  device/host configuration; starting the web demo does not provision them.

## Live demos

### Social Swarm: `/?view=feed`

- **10–50,000 simulated agent identities**, default 100 (`SWARM_AGENTS`), with slider and 1k/5k/10k/50k presets;
  eleven built-in topic channels. `SWARM_RATE` defaults to 5, range 1–40: a generated-task setting, not a throughput guarantee.
- **Real Space pipeline:** one dispatcher reserves up to four tasks together and publishes Posts/Likes,
  history, counters and follow-up tasks in a second Durable commit, with a server-side `CompletionProfile`.
- **Interaction:** operator posts, replies, likes, thread ancestors and nested replies use the same task pipeline.
- **Presence:** `AgentPulse` Entries have 45-second leases; the online list follows valid leases.
- **Durable history:** `feed.more`, `agent.posts` (handle filter) and `ai.posts` (`viaLlm:true`) page across configured
  shards with continuation cursors. A scan fallback is used while the history index migrates.
- **Images:** approximately 5% of generated posts use deterministic SVG cards from `imageSeed`/`imageAlt`, without
  an external image service. User uploads are stored outside the Space document; Posts contain their URLs.
- **Inspector:** Entry counts, revision, pending tasks, posts/minute, dispatcher and LLM metrics; feed deltas use `changes(rev)`.

An optional headless second shard runs in `server/nano-host.ts`, selected through `SWARM_REMOTE`.
It has its own worker and store. This demo wiring is not a general replicated/failover cluster.

### Multiplayer Space-Chat: `/?view=space-chat&session=lobby`

Six selectable stages `v1`–`v6`: memory, durable storage, sockets, authentication, federation, and operations/mobile
building blocks. Named sessions contain threads, forks, Presence/heartbeats, `ScheduledJob`/`TimerLock` alarms and
`SearchTask` subagents as inspectable Entries.

The CLI stages are **local demonstrations**: v3 uses real sockets; v5 uses multiple in-memory Members in one process;
v6 exercises local operational components and example enrollment data. They do not install a multi-host cluster or
pair a real phone automatically. Web stage runs create immutable report mirrors, not executable deployments.

### Optional live models

Both demos work without a model. Credentials alone do not enable live calls: explicitly set `PHI_SPACES_LLM=1`.
Credentials may come from provider environment variables or pi CLI `auth.json` (`PI_AUTH_DIR` for the Docker mount).
`PHI_SPACES_LLM_MODEL`/`PI_MODEL` select the initial model.

The shared picker lists allowed Codestral/Haiku models through `GET /api/llm/models`.
Changes through `POST /api/llm/model`, including `{on:false}`, require an admin session and CSRF token.
Budget: at most six provider calls/minute, two concurrent calls, 400 output tokens/call and 20 seconds/call.
Budget exhaustion or provider failure uses deterministic fallback text. These are process-local limits, not a
global billing quota. Space-Chat exposes model/token metadata in the UI.

## Quick start

Run commands below from the repository root, with dependencies already available. No installation is performed by
the test commands. Review `help-site/.env.example` and create a private `help-site/.env` if needed; do not overwrite
an existing configuration. The supplied template has `HELP_BIND=0.0.0.0`, so override it for local-only use.

### Direct startup

```bash
# Build the bilingual corpus, standalone assets and Next.js production output:
npm --prefix help-site run build

# Local-only production server; uses SQLite by default:
HELP_BIND=127.0.0.1 PHI_SPACES_LLM=0 npm --prefix help-site start

# Alternatively, Next.js development mode:
HELP_BIND=127.0.0.1 PHI_SPACES_LLM=0 npm --prefix help-site run dev

# Root shortcut for development (same bind/environment considerations):
HELP_BIND=127.0.0.1 PHI_SPACES_LLM=0 npm run help
```

Admin login is disabled unless `PHI_SPACES_ADMIN_PASSWORD` is configured. There is no default password.
Peer enrollment tokens are for peer pairing, not web login. Set a private password before using Web Admin.

### CLI stages and local checks

```bash
node --experimental-strip-types help-site/examples/v1-local-memory/run.ts
node --experimental-strip-types help-site/examples/v2-local-durable/run.ts
node --experimental-strip-types help-site/examples/v3-remote-socket/run.ts
node --experimental-strip-types help-site/examples/v4-gated-auth/run.ts
node --experimental-strip-types help-site/examples/v5-federated-cluster/run.ts
node --experimental-strip-types help-site/examples/v6-mobile-control/run.ts

# All help, regression and worker-batch tests; no model calls:
PHI_SPACES_LLM=0 npm --prefix help-site test

# Fresh production build and separate Next.js SSR check:
PHI_SPACES_LLM=0 npm --prefix help-site run test:production
```

### Docker

Configuration: `help-site/docker/Dockerfile` and `help-site/docker/docker-compose.yml`, with four services:

| Service | Purpose |
|---|---|
| `spaces-help-prod` | Production Next.js server, unprivileged user, dropped capabilities, SQLite volume and healthcheck; host networking. |
| `spaces-help-dev` | Next.js development mode; published port and separate SQLite volume. |
| `spaces-help-test` | Fresh corpus/Next.js build and the full help test suite, profile `test`, with SSR enabled. |
| `swarm-nano` | Optional headless worker shard, profile `nano`, separate SQLite volume and socket port 3600. |

Compose requires a private `PHI_SPACES_ADMIN_PASSWORD` during configuration, including test-profile selection.
Production uses a prebuilt `.next` output; development compiles with Turbopack.
Startup time depends on the store and machine; no fixed latency is guaranteed.

```bash
# Full help suite, including integration, regressions, consistency, batches and SSR:
npm --prefix help-site run docker:test

# Production start, logs, stop:
npm --prefix help-site run docker:prod:up
npm --prefix help-site run docker:prod:logs
npm --prefix help-site run docker:prod:down

# Development start, logs, stop:
npm --prefix help-site run docker:dev:up
npm --prefix help-site run docker:dev:logs
npm --prefix help-site run docker:dev:down
```

These commands change local runtime state. Deployment on shared hosts requires separate approval.
Do not expose raw shard TCP sockets publicly without protection: use a trusted network or SSH tunnel.

### Configuration

| Variable | Current behavior |
|---|---|
| `PORT` / `HELP_PORT` | Direct-server port, default 3500; Compose uses `PORT`. |
| `HELP_BIND` | Direct-server bind; use `127.0.0.1` locally. Dev Docker binds internally to `0.0.0.0`. |
| `HOST_BIND` | Production Docker host-network bind; empty defaults to `0.0.0.0`. For dev, controls the published host address. |
| `PHI_SPACES_ADMIN_PASSWORD` | Private web-login password; mandatory for Compose, otherwise login is disabled when absent. |
| `PHI_SPACES_LLM` | Default 0; explicit 1 allows configured live providers and token costs. |
| `PHI_SPACES_LLM_MODEL` / `PI_MODEL` | Initial model selection. |
| `PI_AUTH_DIR` | Host credential directory mounted read-only by Docker; inspect the Compose mount before deployment. With rootless Docker the host user maps to container root, so a `0400` `auth.json` is unreadable for the `node` user: point `PI_AUTH_DIR` at a copy owned by container uid 1000 (copy it in a `--user 0` helper container and `chown 1000:1000`). `auth.json` must be valid JSON (no trailing comma), otherwise the LLM stays off. |
| `HELP_SQLITE` | Direct-start store; default `help-site/.local/spaces-eibrain.sqlite`. Production Compose fixes `/data/spaces-eibrain.sqlite` in its volume. |
| `SWARM_AGENTS` / `SWARM_RATE` | Simulated identities and intent-generation rate, as described above. |
| `SWARM_REMOTE` | Optional hub-side shard endpoint, e.g. `tcp:127.0.0.1:3600` through an SSH tunnel. |
| `SWARM_LLM_RATE` | Share of new hub-shard posts written by a live model, 0..1, default 0.01 (cost guard; only the hub has model access, so posts routed to the second shard never use it). |
| `SWARM_MAX_ENTRIES` | Entry cap per shard database, default 20000, `0` disables. Above it the oldest posts (with their likes and history nodes) are purged in bursts down to 95 %; the feed shows a yellow notice. Test-system limit, not a product limit. |
| `SWARM_HOST_NAME` | Name this host reports in the test-system bar below the live views (default: the machine's hostname; set `big` / `nano` in each host's `.env`). |
| `SWARM_LISTEN`, `SWARM_DB`, `SWARM_TAG`, `SWARM_PRODUCE` | Headless-shard listener, store, ID prefix and optional local intent generation; see `.env.example`. |

<a id="demo-vertrag-und-wiederanlauf"></a>

## Runtime contract and restart

The legacy German anchor above is retained for existing documentation links.

HTTP and WebSocket share the validated Chat command dispatcher. A transactional `ThreadSequence` Entry allocates
sequence numbers; the message and counter commit together. On restart, the hub reloads existing sessions and drains
their durable queues. A failed reply commit releases its task for retry. Slow model replies have bounded fallback.

Stage mirrors are **immutable reports**, including the full `ChatReport` snapshot (schema 1). Pending jobs, searches
and timers remain inspectable but are not executed again. Use a live session for interaction. Re-running a stage
replaces its report in one storage commit.

Public sessions expire after one hour, with at most 64 sessions/hub, 2 MiB of Entry fields/session Space and
16 WebSocket clients/session. Expired sessions stop executing and reject mutations; their history remains for
inspection and counts against quotas. Remove old demo Spaces explicitly through administration and reopen the hub
to free session slots; chat history is not automatically deleted.

Public HTTP mutations allow 60 requests/minute/address. WebSockets are bounded to 256 connections overall and
120 messages/minute/connection. Uploads are limited to 2 MiB/file, 256 files and 64 MiB total. Generated upload files
expire after 24 hours and are cleaned up on the next upload; unrelated files are untouched. Upload quota checks are
serialized. At most one stage run executes globally; overload returns 429, expired sessions return 410.

Admin commands have a durable journal bound to arguments and principal. Enrollment/key rotation commit effect and
result atomically. An interrupted other command can reopen as `needsReview`: inspect its actual effect before using
a new command ID. Failed commands do not execute again under the same ID. Private signing keys are in a host-only
document; journal results use AES-GCM with a key in the same store. This is not disk encryption or a substitute for
access control/backups. Old result records without payload are not reported as successful replay.

Swarm history uses a durable linked index committed with each Post. A page examines at most 512 nodes/shard and
returns at most 200 Posts. Cursors preserve unconsumed candidates; missing shards return a retryable incomplete
result without cursor advance. Filters may produce empty intermediate pages with continuation.
Migration runs in bounded commits in the background, with scan-based paging until ready; its one-time sort uses
memory proportional to old Posts. This is bounded indexed paging, not constant-time access to the underlying
document. Opening a whole thread still reads that thread from its shard.

### Actual Durable worker batches

One storage commit reserves up to four tasks in a 45-second Space transaction. Preparation happens outside the
Durable callback, with at most one model call and at most 20 seconds of waiting. A second commit writes all results,
history nodes, one history head, one counter per affected channel and follow-up answer/AI tasks, then commits the
Space transaction. Feed caches and answer observers change only after success. New batches do not write
`PostEffect` Entries; legacy outbox Entries are still drained. Same-batch duplicate likes use dedup markers.

A semantic failure rolls back the whole completion and explicitly aborts reservations. `ResourceExhausted` halves
the batch size down to one task. A task that still cannot complete is not acknowledged and is retried with warnings.
A storage failure poisons the Durable session; the worker stops when cleanup fails and recovery/reopening is required,
without an async fallback. Normal empty-queue checks do not commit. The dispatcher yields 25 ms between successful
batches and sleeps 500 ms when idle. A custom provider ignoring cancellation may continue after the wait deadline;
its late result is not published as a Post.

Two worker storage commits for four Posts are locally tested, not a claimed overall speedup. Document serialization,
Core scans, producer/remote RPCs, seeds and the legacy outbox remain separate costs. Large-store CPU, event-loop and
HTTP latency need deployment-specific measurements. Local suites are not browser E2E, power-loss or multi-host acceptance.

### Local verification note, 2026-10-18

Both TypeScript checks passed. The root suite passed 740 tests with one optional bootstrap-copy test skipped;
the serial example suite passed 158/158. The full help suite now exits cleanly: 45 passed, with the separately
tested SSR case skipped. A fresh production build and its SSR test passed (1/1). The shutdown race was fixed:
closing during initialization cancels history work and cannot install background timers afterward. Tests explicitly
disable models and operator-configured remote shards before importing the server.

Local browser checks supplement these automated results; they are not exhaustive browser E2E, accessibility,
deployment, phone, large-store performance, power-loss or multi-host acceptance. See the
[completion report (German)](../docs/_attic/analyse-hilfecorpus-konsistenz-2026-10-18.md) for evidence and open gates.

## Maintaining the help corpus

The corpus contains **45 articles / 90 DE–EN records**, nine areas and 14 API reference groups. Eight practical
guides cover first setup, asynchronous interaction, task lifecycle, live synchronization, the Social Swarm
pipeline, failure handling, safe operation, and topology/readiness. Start with the
[complete runnable tutorial](examples/tuple-basics.ts); the [live mirror](examples/shared/live-mirror.ts)
demonstrates paged snapshots, changes, deletion and cursor reset.

Edit `scripts/corpus-articles-data.ts`, `scripts/corpus-workflows-and-api.ts` or
`scripts/corpus-practical-guides.ts`, not generated `corpus/{de,en}` Markdown. `api_facts.json` supplies API
classification; `scripts/api-signatures.ts` derives signatures from actual TypeScript exports. The build validates
links, anchors, translations and catalog references, records the real Git revision/dirty state, and hashes full content.

```bash
# Read-only validation, including compilation of all 60 TypeScript documentation snippets:
npm --prefix help-site run check:docs
# Regenerate corpus/assets, then build Next.js (includes the same validation gate):
npm --prefix help-site run build
```

`client/main.tsx` mounts the standalone app; Next.js imports the shared `HelpApp` without creating a second root.
`tests/help-consistency.test.ts` covers the corpus, renderer, navigation, loaders, tutorial, shutdown and live mirror.

## Documents and layout

- [PLAN.md](PLAN.md): architecture and implementation plan, not standalone proof of current runtime behavior.
- [German architecture comparison](VERGLEICH-EARENDIL-VS-PHI-SPACES.md) and
  [English comparison](COMPARISON-EARENDIL-VS-PHI-SPACES-EN.md): comparison with Earendil's chat architecture.
- [Root API reference](../docs/api.md), [examples](../docs/examples.md), and
  [implementation status](../docs/implementierungsstand.md) define the detailed current contracts.

```text
help-site/
├── README.md / README_DE.md       # English / German overview and operating contract
├── app/                          # Next.js App Router entry
├── corpus/                       # Generated German/English help articles and catalog metadata
├── examples/                     # v1–v6 and shared Chat engine
├── server/
│   ├── index.ts                  # HTTP, Next.js, uploads, API and WebSocket routing
│   ├── llm.ts                    # Optional providers, picker and budget
│   ├── nano-host.ts              # Optional headless shard
│   ├── admin/                    # Authenticated administrative control
│   ├── space-chat/               # Command dispatcher, sessions and stage reports
│   └── social/
│       ├── swarm.ts              # Dispatcher, feed, simulated identities and shard routing
│       ├── batch.ts              # Actual reserve/finish Durable batches
│       └── history.ts            # Durable linked history and cursor paging
├── client/                       # React UI, styles and client lifecycles
├── docker/                       # Images and Compose services
├── deploy/                       # Reverse-proxy/systemd templates
├── scripts/                      # Corpus/assets/Next.js build path
└── tests/
    ├── help-site.test.ts          # Corpus, stages, HTTP/WS, Admin, feed and optional SSR
    ├── regressions.test.ts        # Focused demo regressions
    └── swarm-batch.test.ts        # Commit count, rollback, byte budget, SQLite reopen
```
