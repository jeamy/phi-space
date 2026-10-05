# pi-spaces

A JavaSpaces-style space (Jini JavaSpaces Service Specification v2.2) as an extension for
[`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable). Many agents
(conversations) share one space, take work from it, and talk to each other through it.

## Layers

| file | what |
|---|---|
| `src/core.ts` | pure spec semantics over a JSON state: entries, templates, leases, transactions, notify |
| `src/doc.ts` | the `Space` document definition (shared by client and meter, so they do not import each other) |
| `src/client.ts` | `JavaSpace`: `write`, `read`, `readIfExists`, `take`, `takeIfExists`, `notify`, `snapshot`, transactions, lease `renew`/`cancel` |
| `src/index.ts` | the `spaces` extension (tools `space_write/read/take/wait/notify/txn/lease`, prompt section) and notify delivery |

The space is one Session-scoped document, so it is committed atomically and survives restarts.

## Spec mapping

- **Entries** `{type, types, fields}`; `types` (type then supertypes) is fixed at write time. Templates: absent or
  null type/field is a wildcard, a `null` template matches anything, subtypes match, fields compare by deep equality.
  As in Jini, you cannot search for a field being null.
- **take**: never returns the same entry twice. Tool calls are exactly-once across replay: the result is recorded in a
  task document in the same commit that removes the entry.
- **read vs readIfExists** (same for take): `*IfExists` waits only while every match is locked by another
  transaction; plain `read`/`take` waits for a match to appear, up to the timeout. `NO_WAIT = 0`.
- **Leases**: granted as requested. `ANY` gets 1 hour, `FOREVER` never expires (tools: `"forever"`), negative or NaN
  throws, expired entries are invisible. Waits and timeouts accept `FOREVER` too; agents may wait for months.
- **Transactions**: writes invisible outside until commit, takes lock, reads lock against takes, abort undoes,
  lease expiry aborts. A worker that takes under a transaction and dies returns its job when the lease lapses.
  Lapses are applied in time order, even when nobody looked for a while.
- **Ownership**: tools act as their conversation. It owns the transactions it begins (and those a `space_wait` hands it),
  the entries it writes and its waits and registrations, and may only use, commit, renew or cancel its own or ownerless
  ones. Host code (`new JavaSpace(harness, ctx)` without `as`) is unrestricted.
- **notify**: registration with lease, handback, per-registration strictly increasing sequence numbers. A listener is a
  conversation: events are submitted as input with `requestId = pi-spaces:eventId:seq`, so redelivery is harmless.
  Best effort.
- **Waiters (non-blocking wait)**: `space_wait` / `JavaSpace.wait` parks a read or take for a conversation and returns at
  once. When a match appears (or the timeout passes) the space sends the conversation a message. A take-waiter takes the
  entry under a fresh transaction, so a lost delivery is not a lost job: the receiver commits it with `space_txn`,
  otherwise it returns to the space when the transaction lease lapses, or at once if the conversation is gone or
  delivery gives up. Waiters live in the document and survive restarts; `space_wait` waits forever by default.
- **snapshot**: a frozen copy only (JavaSpaces' snapshot is a serialization cache).

Not applicable: `RemoteException` (in-process). Ordering is unspecified, as in the spec; do not rely on FIFO.

## Limits and ownership

- **Ownership**: a conversation owns what it creates (entries, transactions, subscriptions, waits) and can only use,
  commit, abort, renew or cancel its own. What host code creates (no owner) is the host's: agents can read and take
  host entries, but never cancel or renew them, nor use host transactions. Host code (`JavaSpace` without `as`) is
  unrestricted.
- **Quotas** for conversations (host code is exempt), checked on every write, notify, wait and transaction:
  entry or handback up to 64 KiB of JSON, type names up to 128 characters and 16 types, 1000 entries per
  conversation, 10 000 in the space, 20 subscriptions, 20 waits and 20 open transactions per conversation. They throw
  `LimitError`. Change them with `new JavaSpace(harness, ctx).setLimits({ maxEntries: 50_000 })`; the values are stored
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
  `createSpaces(new Meter())` and `new JavaSpace(h, ctx, Date.now, thatMeter)` for your own.

## Scope

One harness process is the "space service"; "many agents" means many conversations in it. Pi Durable allows one
process per storage. Spaces across several processes would need changes to pi itself.
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

- `JavaSpace.count(tmpl)` / `stats()` (pure `core.count`/`core.stats`): gauges from a snapshot, no commit, nobody woken.
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

```
npm test        # core spec tests + integration (concurrency, crash/reopen on JSONL, notify, blocking)
npm run example
```
