# phi-spaces

[English](README.md) · [Deutsch](README_DE.md)

> **Experimental software — use at your own risk.** APIs, storage formats and operational behavior may change.
> Do not rely on this project for production or irreplaceable data without independent validation, tested backups
> and a recovery plan. Tests cover specific scenarios, not every failure mode; running demos do not establish
> production readiness. Provided without warranty under the [MIT License](LICENSE).

> **Namespace upgrade:** Persistent document kinds now use `phi-spaces.*`; the runtime bundle is
> `phi-spaces.mjs`. This is a breaking storage/integration change. Existing stores require a separately
> verified offline migration before using this version. Document version 5 does not migrate document-kind
> namespaces; an empty new namespace does not mean the previous data was deleted.

phi-spaces is a TypeScript space library implemented as an extension for
[`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable). It is a
general-purpose space for any kind of data that needs to be exchanged: jobs, messages, sensor readings, results,
state, files or events. Agents (conversations) are one typical kind of participant, but not the only one;
programs, services, devices and people can write to and read from a space just as well.

The model comes from Linda tuple spaces and JavaSpaces, which are about decoupled coordination through shared
data rather than about agent communication. The local phi-spaces client is
`PhiSpaces`; this is a TypeScript/JSON implementation, not a JavaSpaces-compatible Java or RMI runtime.

**Status.** The library has a local durable space, named spaces, request claims, revisions and a single-host RPC
service (`SpaceService`, `RemoteSpace`, Unix/TCP sockets), durable mailboxes and a composed federation host
with overlay identity, key proof, enrollment, signed grants and key rotation. Federation routing, membership,
run/worker/Space administration and mobile controls are implemented. Merge replication, primary/sync replication,
promotion and recovery also have implementations and documented tests, but **Phase 3 is not fully accepted**.
Implementation is not a production or failure-model guarantee: see
[current implementation](docs/implementierungsstand.md) and the [Phase-3 acceptance matrix](docs/abnahme/ap3-abnahme.md).
This README was checked against the checkout on 2026-10-18; those documents carry the detailed evidence and open gates.

## Tuple spaces: coordination through data

A tuple space is a shared associative collection: participants publish data and look it up by its contents,
not by a recipient's address. Think of a shared blackboard on which a producer leaves a job and a worker
later claims a matching job. The worker need not know who published it, and the producer need not choose
which worker will execute it. Linda introduced this form of generative communication; tuples outlive the
interaction that created them, enabling communication across both process and time boundaries.
[Source: Gelernter, *Generative Communication in Linda*](https://www.cs.tufts.edu/comp/150FP/archive/david-gelernter/generative-linda.pdf).

JavaSpaces applies that idea to typed Java objects called **Entries**, with template-based lookup, leases
and transactions. A template selects an Entry type and field values; unspecified fields are wildcards.
Entries are exchanged as copies, not live shared object references. The application protocol is a flow of
data through the space rather than direct method calls between the producer and consumer.
[Source: Oracle's JavaSpaces introduction](https://www.oracle.com/technical-resources/articles/javase/javaspaces.html).

### The basic operations

| Operation | Meaning in phi-spaces |
|---|---|
| `write(entry)` | Publish a new Entry; writing again normally creates another Entry, not an update. |
| `read(template)` | Return a matching Entry copy without consuming it. |
| `take(template)` | Claim a matching Entry exclusively; under a transaction, removal becomes final at commit. |
| `notify(template, ...)` | Register interest in matching future writes; this is notification, not exclusive job ownership. |

These names follow JavaSpaces. Linda calls the corresponding publish/consume operations `out` and `in`.
A space is not inherently a FIFO queue, and matching is not a SQL query language.
[Source: JavaSpaces specification, JS.1.3–1.4 and JS.2](https://river.apache.org/release-doc/current/specs/html/js-spec.html).

### Four dimensions of loose coupling

- **Time decoupling:** a producer can publish now and a consumer can act later, without overlapping lifetimes.
  In phi-spaces this depends on the Entry's lease and continued availability of its Space/storage. A durable
  backend can retain it across host-process restarts; `MemoryStorage` cannot.
- **Location decoupling:** producer and consumer need not know each other's network addresses. They must still
  discover/configure and reach the appropriate Space endpoint, with authorization. Location independence does
  not remove service discovery, routing or network failures.
- **Reference decoupling:** participants agree on Entry schemas and templates instead of keeping direct object
  references to one another. They remain coupled to that data contract. There can still be RPC **to the Space**:
  JavaSpaces uses RMI; phi-spaces offers `SpaceService`/`RemoteSpace` over supported transports.
- **Synchronization decoupling:** publishing a job does not require its consumer to be ready or to finish the job.
  This does **not** mean every API operation is asynchronous. JavaSpaces calls are synchronous, and `read`/`take`
  can wait until a match or timeout. phi-spaces returns Promises: awaiting a pending operation does not block
  the JavaScript event loop, but the caller still waits for its result. Use `NO_WAIT`, notifications or durable
  waiters according to the workflow; CPU work and serialization can still occupy the event loop.

Linda's time/process separation is described in the
[original paper](https://www.cs.tufts.edu/comp/150FP/archive/david-gelernter/generative-linda.pdf).
The blocking calls and RMI exceptions are explicit in the
[JavaSpace API](https://river.apache.org/release-doc/current/api/net/jini/space/JavaSpace.html).
The phi-spaces-specific behavior is documented in [our API](docs/api.md).

### Asynchronous interaction actually implemented in phi-spaces

`PhiSpaces` and the common remote interface `SpaceLike` expose Promise-based operations. Their completion
points differ:

- `write` resolves after its storage mutation completes, not after a consumer processes the Entry. It is not
  fire-and-forget: commit latency and errors remain visible to the producer.
- `read`/`take` resolve with a match or `null` at timeout. With `NO_WAIT` they do not wait for a future match,
  but still need time to perform the operation. `await` suspends the caller, not the whole event loop.
- `wait` persists a one-shot registration and resolves with its wait ID rather than holding the call until a
  match. `notify` persists a leased subscription to matching writes. The service later delivers events to the
  target conversation or configured consumer mailbox; `startService` runs local maintenance/delivery.
- The agent tools `space_read`/`space_take` hold the current turn while waiting (capped at 60 seconds).
  `space_wait` releases the turn after registration and can survive process restarts on persistent storage.
  Transactional take-waiters hand back a leased reservation, not an irrevocably consumed job.

Thus phi-spaces implements both caller-waiting async operations and durable, event-driven interaction. It does
not make synchronous serialization/CPU work non-blocking or remove finite Space budgets. See
[`src/client.ts`](src/client.ts), [`src/index.ts`](src/index.ts) and the [waiter API](docs/api.md).

### What phi-spaces adds, and what it does not promise

phi-spaces represents an Entry as `{ type, types?, fields }` with JSON data. It retains the coordination
primitives and adds persistent request identities/replay, named Spaces, revision-based paging, mailboxes,
completion profiles and operational controls. Matching uses deep JSON equality, not Java's serialized-field
comparison. A transaction can reserve a task and publish its result atomically in its owning Space.
Transactions are not a general cross-host two-phase-commit API.

Multiple workers can compete for tasks without the producer assigning a worker. Leased reservations return
unfinished work after abort/expiry, provided the task's own lease has not also expired. An application can use
`CompletionProfile` to require a matching result before its task transaction commits. This does not make an
external HTTP call, payment or file write exactly-once: those effects need their own idempotency or transaction.

The blackboard is a **logical** shared repository; its physical implementation may be local, remote or federated.
The pattern alone does not provide unlimited scaling, replication, failover or partition tolerance. In this
implementation each Space is a document, so large documents, scans and serialization remain real costs.
An asynchronous API is not CPU parallelism, and a logical Space transaction is not automatically one Durable
storage commit. The Social Swarm worker explicitly batches up to four tasks into two storage commits; see
the [Help-Site runtime contract](help-site/README.md#demo-vertrag-und-wiederanlauf).

## Minimal example: publish, inspect, claim, complete

Run this from the repository root with the already available dependencies: save the block as `tuple-demo.ts`,
then use `node --experimental-strip-types tuple-demo.ts`. No model calls or server are needed.

```ts
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx, FOREVER, NO_WAIT, PhiSpaces } from "./src/index.ts";
import { spaces } from "./src/agent.ts";

const registry = createRegistry();
registry.install(spaces);
const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, ctx);
try {
  const producer = new PhiSpaces(harness, ctx);
  await producer.write({ type: "Job", fields: { jobId: "square-7", value: 7 } }, null, FOREVER);
  // The producer need not wait for or address a particular worker.
  const worker = new PhiSpaces(harness, ctx);
  const template = { type: "Job", fields: { jobId: "square-7" } };
  console.log("inspect:", (await worker.read(template, NO_WAIT))?.fields);

  const txn = await worker.createTransaction(30_000);
  try {
    const job = await worker.take(template, NO_WAIT, { txn: txn.id });
    if (!job) throw new Error("No matching job");
    await worker.write({ type: "Result", fields: {
      jobId: job.fields.jobId, squared: Number(job.fields.value) ** 2,
    } }, txn.id, FOREVER);
    await worker.commit(txn.id);
  } catch (error) {
    await worker.abort(txn.id);
    throw error;
  }
  console.log("result:", (await producer.read({ type: "Result" }, NO_WAIT))?.fields);
  console.log("job remaining:", await producer.count(template));
} finally {
  await harness.close(ctx);
}
```

The result is `squared: 49` and `job remaining: 0`. `read` leaves the job available; the transactional `take`
and Result write become final together. This small example runs two clients in one process and uses volatile
memory: it demonstrates coordination, not persistence or network failover. Use a durable backend for restart
survival and `RemoteSpace` for a separate worker process; see [examples](docs/examples.md) and [API](docs/api.md).

## Layers

| file | what |
|---|---|
| `src/core.ts` | pure spec semantics over a JSON state: entries, templates, leases, transactions, notify |
| `src/doc.ts` | the `Space` document of the default space (shared by client and meter, so they do not import each other) |
| `src/spaces.ts` | named spaces: registry (host id, alias → space id), `createSpace`, `listSpaces`, `snapshotSpace` |
| `src/claims.ts` | durable request claims and request generations (idempotent mutations, `pollOperation`, `cancelOperation`) |
| `src/client.ts` | `PhiSpaces`: `write`, `read`, `readIfExists`, `take`, `takeIfExists`, `notify`, `snapshot`, transactions, lease `renew`/`cancel` |
| `src/index.ts` | the public exports; the background service of a space: notify delivery, reaper (`startService`) |
| `src/agent.ts` | the `spaces` extension of a pi-durable agent (tools `space_write/read/take/wait/notify/txn/lease`, prompt section); not exported by `src/index.ts`, it needs pi-durable |
| `src/context.ts` | the invocation context (abort signal, values) |
| `src/store/` | storage boundary: `types.ts` (StoreHost, StoreTx, documents), `documents.ts` (`defineDoc`), `legacy.ts` (the pi-durable host during the move, docs/umstellung-ohne-pi-durable.md) |
| `src/meter.ts` | process-local counters and rates |
| `src/canonical.ts` | canonical JSON (RFC 8785) for field comparison and hashes |
| `src/stream.ts` | bounded revision log and visible-entry change batches |
| `src/service.ts` | authenticated, role-checked single-host space RPC |
| `src/remote.ts`, `src/socket.ts` | retrying remote client and Unix/TCP transport |
| `src/federated-space.ts`, `src/router.ts` | policy-based federation routing and journaled coordination |
| `src/entry-replication.ts`, `src/primary-sync.ts`, `src/replica-control.ts` | merge replication, synchronous commit replication and fenced transitions; acceptance limits apply |
| `src/run-controller.ts`, `src/workers.ts`, `src/space-lifecycle.ts` | run, worker and Space administration |
| `help-site/` | bilingual help, Social Swarm, Space-Chat stages and authenticated Web Admin |

A Space is one document; Durable commits provide atomic state changes. Restart survival requires a persistent backend,
and power-loss/host-loss guarantees depend on storage settings and the deployment's replication/recovery model.
The default space is the Session-scoped document
`phi-spaces.space` (version 5); further named spaces live in the Session-scoped family `phi-spaces.named-space`, keyed by an
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
  conversation: events are submitted as input with `requestId = phi-spaces:eventId:seq`, so redelivery is harmless.
  Best effort.
- **Waiters (non-blocking wait)**: `space_wait` / `PhiSpaces.wait` parks a read or take for a conversation and returns at
  once. When a match appears (or the timeout passes) the space sends the conversation a message. A take-waiter takes the
  entry under a fresh transaction, so a lost delivery is not a lost job: the receiver commits it with `space_txn`,
  otherwise it returns to the space when the transaction lease lapses, or at once if the conversation is gone or
  delivery gives up. Waiters live in the document and survive restarts; `space_wait` waits forever by default.
- **snapshot**: a frozen copy only (JavaSpaces' snapshot is a serialization cache).
- **Named spaces**: `await harness.commit((tx) => createSpace(tx, "sieve-a", Date.now()), ctx)` creates a space (idempotent per
  alias; the alias is a name, the `spaceId` is generated and never changes). `new PhiSpaces(h, ctx, Date.now, meter, as,
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
  pending one (`OperationCancelled`). Generation tokens are HMAC-authenticated and bound to their recorded context;
  claims have their own byte budget
  (`maxClaimBytes`).

Ordering is unspecified, as in the spec; do not rely on FIFO. The local API has no `RemoteException`; remote callers
instead receive a transport outcome or `OutcomeUnknown` and must poll the same request identity.

## Limits and ownership

- **Ownership**: a conversation owns what it creates (entries, transactions, subscriptions, waits) and can only use,
  commit, abort, renew or cancel its own. What host code creates (no owner) is the host's: agents can read and take
  host entries, but never cancel or renew them, nor use host transactions. Host code (`PhiSpaces` without `as`) is
  unrestricted.
- **Quotas** for conversations (host code is exempt), checked on every write, notify, wait and transaction:
  entry or handback up to 64 KiB of JSON, type names up to 128 characters and 16 types,
  20 subscriptions, 20 waits and 20 open transactions per conversation. Entry counts have no default cap
  (both count settings use the JSON-safe `FOREVER` value); byte and storage budgets still apply. Explicit quotas throw
  `LimitError`. Set one with `new PhiSpaces(harness, ctx).setLimits({ maxEntries: 50_000 })`; the values are stored
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
  `createSpaces(new Meter())` and `new PhiSpaces(h, ctx, Date.now, thatMeter)` for your own.

- **By id**: a template may carry `id` (an entry id from an event message); `space_read/take/list` take `id` too.
- **Space size**: `maxSpaceBytes` (default 64 MiB of entry fields) limits the whole space, host writes included.

## Scope

One harness process owns one persistent storage and may expose it as a space service. Named spaces share that
storage; they are not separate hosts. `SpaceService` and `RemoteSpace` let clients in other processes reach that host;
the federation runtime (gate, enrollment, grants, router, `FederatedSpace`, membership) composes several hosts
according to [docs/federation-plan-v3.md](docs/federation-plan-v3.md) — stages 1b and 2 have acceptance evidence
within their documented profiles and exceptions. Stage 3 has working replication/promotion components but
remaining system acceptance gates in [the current matrix](docs/abnahme/ap3-abnahme.md). The operations extension (runs, workers, Space lifecycle, deployment
bootstrap, mobile control) is described in [docs/betrieb-und-mobile-steuerung.md](docs/betrieb-und-mobile-steuerung.md).
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

- `PhiSpaces.count(tmpl)` / `stats()` (pure `core.count`/`core.stats`): gauges from a snapshot, no commit, nobody woken.
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
including compiled example modules. Set `PHI_SPACES_MOBILE_ROOT` for another mobile checkout.
The mobile Android pre-build task rebuilds from phi-spaces source and packages the updated assets;
set `PHI_SPACES_SOURCE` there if this source checkout is elsewhere.

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

`npm run testbed -- <command>` verifies the **built artifact** (the `phi-spaces.mjs` bundle, compiled examples and scenarios; no
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
| [`help-site/`](help-site/README.md) | PHI-SPACES / HELP: bilingual help, batched Social Swarm feed, 6-stage Space-Chat workbench and AdminSpaces | `npm run help` → http://localhost:3500 (default; configurable) |

Live examples pick the model from `PI_PROVIDER`/`PI_MODEL`, otherwise the first one available via environment
API keys or `~/.pi/agent/auth.json` (`examples/live-models.ts`). They cost model tokens. Entry types, patterns,
tests and limits of each example: [docs/examples.md](docs/examples.md) and [docs/examples/](docs/examples/).

Actual research runners are tested with scripted models and persistent storage. Real-model quality and network
integration are not validated by these tests. Research runs require fresh directories; automatic research resume
is unsupported. Citation metrics are unavailable from arXiv metadata and remain null. Example tests do not establish
general production scaling: component/load measurements have their own documented scope. Several async workers
do not provide CPU parallelism.

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
| [ap1b-abnahme.md](docs/abnahme/ap1b-abnahme.md) | phase 1b integration evidence |
| [ap2-abnahme.md](docs/abnahme/ap2-abnahme.md) | phase 2 acceptance |
| [ap3-replikation.md](docs/abnahme/ap3-replikation.md) | phase 3 replication architecture |
| [ap3-abnahme.md](docs/abnahme/ap3-abnahme.md) | phase 3 acceptance criteria, evidence and remaining gates |
| [spaces-v1.md](docs/_attic/spaces-v1.md) | historical local snapshot (2026-10-07) |
| [federation-plan-v3.md](docs/federation-plan-v3.md) | the contract for federated spaces (stages 0–2 implemented, 3 in progress) |
| [implementierungsplan-v3.md](docs/implementierungsplan-v3.md) | readiness, decisions, work packages and progress |
| [betrieb-und-mobile-steuerung.md](docs/betrieb-und-mobile-steuerung.md) | operations extension: runs, workers, Spaces, bootstrap, mobile control, acceptance status |
| [testumgebung-big.md](docs/testumgebung-big.md) | the remote docker test bed |
| [VALIDIERUNG.md](docs/VALIDIERUNG.md) | what was verified locally, and measurements |
