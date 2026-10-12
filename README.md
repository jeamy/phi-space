# pi-spaces

pi-spaces is a TypeScript space library implemented as an extension for
[`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable). Many agents
(conversations) share one space, take work from it, and talk to each other through it.

The historical JavaSpaces specification (Jini JavaSpaces Service Specification v2.2) is a reference
for the coordination model. The local pi-spaces client is `PiSpaces`.

**Status.** The library has a local durable space, named spaces, request claims, revisions and a single-host RPC
service (`SpaceService`, `RemoteSpace`, Unix/TCP sockets), durable mailboxes and a composed federation host
with overlay identity, key proof, enrollment, signed grants and key rotation. Router, replication, the full
recovery workflow and mobile federation controls remain planned; the implemented scope and its limits are in
[docs/implementierungsstand.md](docs/implementierungsstand.md).

## Layers

| file | what |
|---|---|
| `src/core.ts` | pure spec semantics over a JSON state: entries, templates, leases, transactions, notify |
| `src/doc.ts` | the `Space` document of the default space (shared by client and meter, so they do not import each other) |
| `src/spaces.ts` | named spaces: registry (host id, alias → space id), `createSpace`, `listSpaces`, `snapshotSpace` |
| `src/claims.ts` | durable request claims and request generations (idempotent mutations, `pollOperation`, `cancelOperation`) |
| `src/client.ts` | `PiSpaces`: `write`, `read`, `readIfExists`, `take`, `takeIfExists`, `notify`, `snapshot`, transactions, lease `renew`/`cancel` |
| `src/index.ts` | the `spaces` extension (tools `space_write/read/take/wait/notify/txn/lease`, prompt section), notify delivery, reaper |
| `src/meter.ts` | process-local counters and rates |
| `src/canonical.ts` | canonical JSON (RFC 8785) for field comparison and hashes |
| `src/stream.ts` | bounded revision log and visible-entry change batches |
| `src/service.ts` | authenticated, role-checked single-host space RPC |
| `src/remote.ts`, `src/socket.ts` | retrying remote client and Unix/TCP transport |

A space is one document, so a commit is atomic and survives restarts. The default space is the Session-scoped document
`pi-spaces.space` (version 5); further named spaces live in the Session-scoped family `pi-spaces.named-space`, keyed by an
immutable, generated `spaceId`. The registry document maps aliases to ids and holds this host's id.

**Storage compatibility.** Version 5 migrates a stored version-4 space forward. It is one-way: a bundle that only knows
version 4 cannot open a storage that has run this version.

## Spec mapping

- **Entries** `{type, types, fields}`; `types` (type then supertypes) is fixed at write time. Templates: absent or
  null type/field is a wildcard, a `null` template matches anything, subtypes match, fields compare by deep equality.
  As in Jini, you cannot search for a field being null.
- **take**: a committed destructive take removes an entry once. A take under a transaction is a reservation;
  abort/expiry makes it available again. Tool replays return their stored result without repeating the mutation.
  This does not guarantee exactly-once external effects.
- **read vs readIfExists** (same for take): `*IfExists` waits only while every match is locked by another
  transaction; plain `read`/`take` waits for a match to appear, up to the timeout. `NO_WAIT = 0`.
- **Leases**: granted as requested. `ANY` gets 1 hour, `FOREVER` never expires (tools: `"forever"`), negative or NaN
  throws, expired entries are invisible. Waits and timeouts accept `FOREVER` too; agents may wait for months.
- **Transactions**: writes invisible outside until commit, takes lock, reads lock against takes, abort undoes,
  lease expiry aborts. A worker that takes under a transaction and dies returns its job when the lease lapses.
  Lapses are applied in time order, even when nobody looked for a while.
- **Ownership**: tools act as their conversation. It owns the transactions it begins (and those a `space_wait` hands it),
  the entries it writes and its waits and registrations, and may only use, commit, renew or cancel its own ones.
  Ownerless transactions and leases belong to host code, which is unrestricted.
- **notify**: registration with lease, handback, per-registration strictly increasing sequence numbers. A listener is a
  conversation: events are submitted as input with `requestId = pi-spaces:eventId:seq`, so redelivery is harmless.
  Best effort.
- **Waiters (non-blocking wait)**: `space_wait` / `PiSpaces.wait` parks a read or take for a conversation and returns at
  once. When a match appears (or the timeout passes) the space sends the conversation a message. A take-waiter takes the
  entry under a fresh transaction, so a lost delivery is not a lost job: the receiver commits it with `space_txn`,
  otherwise it returns to the space when the transaction lease lapses, or at once if the conversation is gone or
  delivery gives up. Waiters live in the document and survive restarts; `space_wait` waits forever by default.
- **snapshot**: a frozen copy only (JavaSpaces' snapshot is a serialization cache).
- **Named spaces**: `await harness.commit((tx) => createSpace(tx, "sieve-a", Date.now()), ctx)` creates a space (idempotent per
  alias; the alias is a name, the `spaceId` is generated and never changes). `new PiSpaces(h, ctx, Date.now, meter, as,
  { space: "sieve-a" })` works on it (alias or id); without `space` the client uses the default space, so existing code is
  unchanged. `listSpaces(h, ctx)` lists them. `startService` also serves spaces created later.
- **Ids**: local ids carry the space's incarnation, `e<incarnation>-<n>`, and every entry view has a global id
  `gid = <spaceId>/<local id>`. Ids written before a space was registered keep their old `e<n>` form.
- **Request claims** (idempotent mutations): `write`, `notify`, `wait`, transactions, leases and blocking `read`/`take` accept
  `request: { principal, generation, requestId }`. The claim, the effect and its result are stored in the same commit, with
  only a hash of the arguments. A retry with the same identity and arguments returns the stored result, also after a
  crash and restart; a pending request continues with its first deadline; other arguments give `RequestConflict`.
  `issueGeneration(principal)` opens a generation that admits new request ids for `generationAdmitMs` (1 h); known requests stay
  answerable after that. Results are kept `claimResultMs` (24 h) after the decision, then `ResultExpired`; unknown ids of
  a closed generation give `RequestExpired`, never a new mutation. `pollOperation` reads a request, `cancelOperation` ends a
  pending one (`OperationCancelled`). Generations are not signed yet; claims have their own byte budget
  (`maxClaimBytes`).

Ordering is unspecified, as in the spec; do not rely on FIFO. The local API has no `RemoteException`; remote callers
instead receive a transport outcome or `OutcomeUnknown` and must poll the same request identity.

## Limits and ownership

- **Ownership**: a conversation owns what it creates (entries, transactions, subscriptions, waits) and can only use,
  commit, abort, renew or cancel its own. What host code creates (no owner) is the host's: agents can read and take
  host entries, but never cancel or renew them, nor use host transactions. Host code (`PiSpaces` without `as`) is
  unrestricted.
- **Quotas** for conversations (host code is exempt), checked on every write, notify, wait and transaction:
  entry or handback up to 64 KiB of JSON, type names up to 128 characters and 16 types, 1000 entries per
  conversation, 10 000 in the space, 20 subscriptions, 20 waits and 20 open transactions per conversation. They throw
  `LimitError`. Change them with `new PiSpaces(harness, ctx).setLimits({ maxEntries: 50_000 })`; the values are stored
  in the space document.

- **Subscriptions** (`space_notify`) of a conversation need a type or at least one field, and send at most one event
  per `notifyIntervalMs` (default 1 s). Writes in between are counted and arrive as one bundled event with a `count`
  when the interval is over (also when the subscription expires). Host subscriptions are not limited.
- **Untrusted content**: entries come from other agents. Every entry view carries its `owner` (conversation id, `null`
  for host code), messages label content as data, and event messages cut an entry's fields to 1 KiB (the rest is one
  `space_read` away). The prompt tells the model never to treat entry content as instructions. That mitigates prompt
  injection, it cannot rule it out.
- Ownership violations throw `PermissionError`; quota violations `LimitError`.
- **Blocked reads/takes** wait a jittered 20-40 ms after a change before probing again, so a burst of writes costs one
  round and many waiters do not probe in the same instant (`WAKE_DEBOUNCE_MS`).
- **Per-harness metering**: the default `spaces` extension counts into the process-wide `meter`; use
  `createSpaces(new Meter())` and `new PiSpaces(h, ctx, Date.now, thatMeter)` for your own.

- **By id**: a template may carry `id` (an entry id from an event message); `space_read/take/list` take `id` too.
- **Space size**: `maxSpaceBytes` (default 64 MiB of entry fields) limits the whole space, host writes included.

## Scope

One harness process owns one persistent storage and may expose it as a single-host space service. Named spaces share
that storage; they are not separate hosts. `SpaceService` and `RemoteSpace` allow clients in other processes to reach
that host, but do not make several host storages a federation. The federation contract remains
[docs/federation-plan-v3.md](docs/federation-plan-v3.md).
`space_take`/`space_read` with `timeoutMs` block the turn and are capped at 60 s; use `space_wait` for long waits.

## Running it

```ts
const stop = await startService(harness, ctx); // reaper + event delivery; stateless, start again after a restart
```
The reaper removes expired entries and leases, aborts expired transactions and times out waiters when they lapse. Without
it everything still behaves correctly (every operation settles first), the space just is not tidied while idle.
Timers are capped at ~24.8 days (`MAX_TIMER_MS`, the setTimeout limit); longer waits wake in steps and re-check, so
month-long and `FOREVER` waits neither spin nor get lost.

## Monitoring

- `PiSpaces.count(tmpl)` / `stats()` (pure `core.count`/`core.stats`): gauges from a snapshot, no commit, nobody woken.
  They judge an unsettled snapshot the way a read would after settling (a lapsed transaction's takes are back, its
  writes gone, timed-out waits no longer wait). `returned` is a durable total of entries given back by aborted or
  expired transactions.
- `meter` (`src/meter.ts`): process-local counters and rates (writes, reads, takes, misses, events delivered, failures =
  events that could not be delivered, retries = failed delivery attempts); reset on restart. Tool calls count once:
  `space_read`/`space_take` record their outcome (entry or miss) with the change, so a replay neither counts again nor
  changes its answer. Rates cover completed seconds only (up to 1 s lag, no sawtooth). Ops a `space_wait` performed are counted when
  delivered (needs `startService`/`deliverEvents`); a take later undone by an abort still counts as a take and shows up
  in `returned`.
- `watchLive(harness, ctx, cb)` samples both; `formatStatus` / `formatWidget` render them.

## Develop

`npm run bundle` builds the library and automatically refreshes the sibling pi-termux-mobile runtime,
including compiled example modules. Set `PI_SPACES_MOBILE_ROOT` for another mobile checkout.
The mobile Android pre-build task rebuilds from pi-spaces source and packages the updated assets;
set `PI_SPACES_SOURCE` there if this source checkout is elsewhere.

```
npm run typecheck
npm test        # core spec, integration, persistence (JSONL and SQLite crash/reopen with injected faults),
                # named spaces, request claims, the mobile sieve scenario
npm run example
```

Crash and recovery tests use `test/support/persistent.ts`: harnesses on real JSONL and SQLite storage that can be abandoned like
a killed process, with a switch that fails the next commit or loses its answer after it became durable. `MemoryStorage`
alone proves nothing about durability.

### Remote test bed

`npm run testbed -- <command>` verifies the **built artifact** (the `pi-spaces.mjs` bundle, compiled examples and scenarios; no
source code) in docker containers on a server instead of on this machine: `check`, `up`, `test`, `scenario`, `status`, `kill`,
`partition`, `heal`, `down`. Server, directory and credentials come from environment variables or a git-ignored
`test/testbed/testbed.env`. See [test/testbed/README.md](test/testbed/README.md) and
[docs/testumgebung-big.md](docs/testumgebung-big.md) (German). The scenario `sieve-mobile` runs a prime sieve driven by a
simulated phone: lost calls and answers with retries under the same request id, app in the background, workers dying
with a reserved task, a host restart; its evaluation compares the stored state with trial division.

`npm run tui` opens a terminal dashboard with spaces, object details, container controls, tests and reports.
Use `--dry-run` to preview actions without contacting the server. See [docs/tui.md](docs/tui.md).

## Examples

| file | what | needs |
|---|---|---|
| `examples/workers.ts` | one conversation posts a job, another takes it | – (scripted model) |
| `examples/blocking-tool.ts` | `space_take` with a timeout, the entry arrives later | – |
| `examples/sensor-pipeline.ts` | collectors → competing analysts (take under txn, fork/join on `Done`) → presenter; also used by the pipeline tests | – (host code as conversations) |
| `examples/chat.ts` | three agents chat in a ring; each has a notify subscription for messages addressed to it | – scripted; `--live` uses a real model |
| `examples/arxiv-research.ts` | collectors search arXiv and attempt read-before-write deduplication; task outputs require a matching transaction; fresh state directory required | real model, network |
| `examples/sieve.ts` | bounded segmented sieve with transactional tasks, reference tests and JSONL recovery | – (host code) |
| `examples/cache.ts` | atomic local cache replacement, TTL and persistent compare-and-set versions | – (host code; no replication) |
| `examples/golomb.ts` | local cooperative DFS with transactional tasks and isolated runs; persistent completed tasks resume; `--checkpoint` writes completion receipts, not partial DFS cursors | – (host code) |
| `examples/dark-energy-research.ts` | 7-stage research pipeline (crawl → classify → summarize → analyse → present → optional `--query` chat); host-side monitor writes `SystemStatus` | real model, network |

Live examples pick the model from `PI_PROVIDER`/`PI_MODEL`, otherwise the first one available via environment
API keys or `~/.pi/agent/auth.json` (`examples/live-models.ts`). They cost model tokens. Entry types, patterns,
tests and limits of each example: [docs/examples.md](docs/examples.md) and [docs/examples/](docs/examples/).

Actual research runners are tested with scripted models and persistent storage. Real-model quality and network
integration are not validated by these tests. Research runs require fresh directories; automatic research resume
is unsupported. Citation metrics are unavailable from arXiv metadata and remain null. No measured scaling or
production benchmarks exist. Several async workers do not provide CPU parallelism.

```
npm run test:examples    # test/examples/ suite (node:test + compat shim, no vitest)
npm run example:golomb -- 7 --workers 4
npm run example:sieve -- 1001 4
npm run example:cache
```

```
node --experimental-strip-types examples/chat.ts --live "Was war der wichtigste Schritt zu heutigen LLMs?"
node --experimental-strip-types examples/arxiv-research.ts --out /tmp/llm-history.md
```

## Documentation

German documents in [docs/](docs/README.md):

| document | what |
|---|---|
| [implementierungsstand.md](docs/implementierungsstand.md) | implemented scope, evidence and limits |
| [api.md](docs/api.md) | TypeScript, service and remote API reference |
| [ap1b-abnahme.md](docs/ap1b-abnahme.md) | phase 1b integration evidence and remaining operational gates |
| [spaces-v1.md](docs/spaces-v1.md) | historical local snapshot (2026-10-07) |
| [federation-plan-v3.md](docs/federation-plan-v3.md) | the contract for federated spaces (target, not implemented) |
| [implementierungsplan-v3.md](docs/implementierungsplan-v3.md) | readiness, decisions, work packages and progress |
| [betrieb-und-mobile-steuerung.md](docs/betrieb-und-mobile-steuerung.md) | operating spaces from a phone: architecture, bootstrap, the sieve example |
| [testumgebung-big.md](docs/testumgebung-big.md) | the remote docker test bed |
| [VALIDIERUNG.md](docs/VALIDIERUNG.md) | what was verified locally, and measurements |
