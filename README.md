# pi-spaces

A JavaSpaces-style space (Jini JavaSpaces Service Specification v2.2) as an extension for
[`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable). Many agents
(conversations) share one space, take work from it, and talk to each other through it.

## Layers

| file | what |
|---|---|
| `src/core.ts` | pure spec semantics over a JSON state: entries, templates, leases, transactions, notify |
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
- **Leases**: `ANY`, `FOREVER`, grants are capped (`MAX_LEASE_MS`), negative throws, expired entries are invisible.
- **Transactions**: writes invisible outside until commit, takes lock, reads lock against takes, abort undoes,
  lease expiry aborts. A worker that takes under a transaction and dies returns its job when the lease lapses.
- **notify**: registration with lease, handback, per-registration strictly increasing sequence numbers. A listener is a
  conversation: events are submitted as input with `requestId = eventId:seq`, so redelivery is harmless. Best effort.
- **Waiters (non-blocking wait)**: `space_wait` / `JavaSpace.wait` parks a read or take for a conversation and returns at
  once. When a match appears (or the timeout passes) the space sends the conversation a message. A take-waiter takes the
  entry under a fresh transaction, so a lost delivery is not a lost job: the receiver commits it with `space_txn`,
  otherwise it returns to the space when the transaction lease lapses. Waiters live in the document and survive restarts.
- **snapshot**: a frozen copy only (JavaSpaces' snapshot is a serialization cache).

Not applicable: `RemoteException` (in-process). Ordering is unspecified, as in the spec; do not rely on FIFO.

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

## Develop

```
npm test        # core spec tests + integration (concurrency, crash/reopen on JSONL, notify, blocking)
npm run example
```
