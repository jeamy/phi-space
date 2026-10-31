# phi-spaces API

As of: 2026-10-31. This reference documents the public TypeScript API
of the local client `PhiSpaces`, the remote client `RemoteSpace`, the
service contract and the agent package. The section [Export overview](#export-overview) names every export that the
other sections do not cover. It describes no federation guarantee; for that,
[federation-plan-v3.en.md](federation-plan-v3.en.md) is authoritative.

## Package and subpaths

Projects built on phi-spaces (codemode-chat, help-site, future ones) include the library as a package:
`"phi-spaces": "file:.."` in their `dependencies` (npm creates a symlink) and imports through the package name.
`exports` points directly at the TypeScript sources; there is no build step, Node strips the types
(`--experimental-strip-types`), because the symlink resolves to the real path outside `node_modules`.

| Import | Source | Content |
| --- | --- | --- |
| `phi-spaces` | `src/index.ts` | Public API (`PhiSpaces`, `RemoteSpace`, `serveSpace`, `SpaceService`, errors, …) |
| `phi-spaces/context` | `src/context.ts` | `Context`, `BACKGROUND_CONTEXT`, `ContextKey`, `withContextValue`, `withAbortSignal`, `awaitWithContext` |
| `phi-spaces/core` | `src/core.ts` | Pure semantics: `matches`, error classes such as `SnapshotExpired`, types, state functions (also as the namespace `core` from `phi-spaces`) |
| `phi-spaces/store/host` | `src/store/host.ts` | phi-spaces store in memory (`openOwnMemoryHost`), `OwnStoreHost`, `Ledger`, `memoryLedger`, `StoredDoc`, `PutDoc`, `CommitSet`, `StoreStats`, `HOST_CLOSED` |
| `phi-spaces/store/sqlite` | `src/store/sqlite.ts` | phi-spaces SQLite store (`openSqliteHost`, `StoreUnavailable`), `SqliteStoreOptions`, `FORMAT_VERSION`, `DEFAULT_MEMORY_BUDGET`, `openFiles`, `hostOver`, `StoreFiles`, `StoreFaults`, `Compaction`, `LedgerReplication` |
| `phi-spaces/store/documents` | `src/store/documents.ts` | Document helpers of the store: `defineDoc`, `defineDocFamily` |
| `phi-spaces/ws` | `src/ws.ts` | WebSocket gateway of the web processes (`upgradeWebSocket(req, socket, head, { maxMessagesPerMin })` with `WsOptions`, returns `WsConnection` or `null`; RFC 6455, text only, frames up to 1 MiB) |
| `phi-spaces/package.json` | `package.json` | The package manifest itself |

Only these subpaths are contract; a new subpath is an API change and belongs in this table.
`npm run check:package` (also part of `npm test`) rejects, in such projects, relative imports into `src/` and
unexported subpaths. Exceptions: the agent package `agent/` (reaches federation internals) and two
individually justified files of the help-site (`scripts/package-imports.mjs`, `ALLOWED`). `pi-codemode` is now only a
development dependency of the root (examples); whoever needs the sandbox carries it themselves.

## Common types

```ts
type EntryDraft = { type: string; types?: string[]; fields: Fields };
type Template = { type?: string | null; fields?: Fields; id?: string | null } | null;
type Lease = { id: string; expires: number };
type RequestRef = { principal: Principal; generation: string; requestId: string };
```

`fields` and `handback` must be JSON. `null` as a template matches every
entry. Missing or `null` template fields are wildcards; a stored JSON `null`
therefore cannot be searched for. `id` is the local ID from
an entry view; `gid` is only the global display form.

Times are milliseconds. `NO_WAIT` (`0`) does not wait,
`ANY` (`-1`) leaves the lease duration to the Space and `FOREVER` stands for an
unlimited duration. Over the wire contract `ANY` is transmitted as `null` and `FOREVER`
as `"forever"`.

## `PhiSpaces`

```ts
const space = new PhiSpaces(harness, ctx, Date.now, meter, conversationId, {
  space: "optional-alias-or-spaceId",
});
```

The signature is `new PhiSpaces(host, ctx, now?, meter?, as?, options?)`. `harness` means, here and below, a `SpaceHost`
(`commit`, `watchDoc`, `snapshot`), for instance the host from `openSqliteHost`; the name dates from before the phi-spaces store.
Without `space` the client uses the default Space. A set
`conversationId` (parameter `as`, a `core.Target`) activates ownership checks; host code omits it.
`PhiSpacesOptions` also contains `authorityId`, `maxPending`, `maxPendingPeer`, `consumer` and `authorization`.
`PhiSpaces` satisfies `SpaceLike`.

| Method | Result | Semantics |
|---|---|---|
| `write(entry, txn?, lease?, { request?, unique? })` | `Lease` | Writes a new entry; under `txn` initially invisible. `unique: ["field"]` checks atomically for an existing entry of the same concrete type with the same key fields, even if it is reserved or still uncommitted. |
| `read(template, timeout, options?)` | `EntryView \| null` | Waits for a visible match. |
| `readIfExists(template, timeout, options?)` | `EntryView \| null` | Waits only for colliding transactions to resolve. |
| `take(template, timeout, options?)` | `EntryView \| null` | Removes immediately or reserves under `txn`. |
| `takeIfExists(template, timeout, options?)` | `EntryView \| null` | Non-blocking take variant, except for locks. |
| `probe(template, timeout, { take?, ... })` | `{ entry, locked }` | Like `readIfExists`/`takeIfExists`, but reports with `locked` whether only held matches were present. |
| `notify(template, options)` | `{ eventId, lease }` | Registers local delivery or principal mailbox events. |
| `wait(template, options)` | `waiterId` | Parks a read/take for conversation or consumer delivery. |
| `readAll(template?, options?)` | `EntryView[]` | Snapshot list, oldest first, all matches, optional limit. |
| `readPage(template?, options?)` | `Page` | Byte-limited snapshot page; continue with `next`. |
| `readChain(template, options?)` | `ChainPage` | Optional `SpaceLike` capability: up to 512 chained entries from an immutable snapshot, without a commit. `head` template or `cursor`, `nextField`, `limit`, `maxBytes`; `next` is the first entry ID not consumed. Remotely a `readAll` variant with the feature `read.chain`; the same role/type rights also apply to the head. |
| `changes(afterRev, options?)` | `Changes` | Visible commit batches after a revision. |
| `count(template?, txn?)` | `number` | Visible matches without commit or waiting. |
| `countWithRevision(template?, txn?)` | count with revision | Like `count`, together with the revision and `streamId` it was read at. |
| `stats()` | `SpaceStats` | Point-in-time gauges including the byte breakdown. |
| `statsWithRevision()` | gauges with revision | Like `stats`, together with revision and `streamId`. |
| `revision()` | `{ rev, streamId }` | Current revision of the change stream. |
| `configuration()` | `{ spaceId?, limits }` | Identity and effective limits of the Space. |
| `commitSignal({ gapMs? })` | `{ wait(ms), stop() }` | Wakes waiters at the next commit instead of polling. |
| `snapshot(entry)` | `Snapshot` | Frozen copy of an `EntryDraft`. |
| `createTransaction(lease?, { request? })` | `Lease` | Creates a transaction. |
| `transactionState(id)` | `{ state, expires? }` | `active` or `inactive`. |
| `commit(txn, { request? })` / `abort(...)` | `void` | Completes an own transaction. |
| `renew(leaseId, ms, { request? })` / `cancel(...)` | expiry time / `void` | Renews or ends own leases. |
| `issueGeneration(principal)` | generation | Opens a claim generation. |
| `pollOperation(request)` / `cancelOperation(request)` | claim status | Reads or ends a known claim operation. |
| `resolveOperation(request, method, argumentHash, primaryEpoch)` | `AdmissionResolution` | Checks known claim bindings or, with a valid generation of the same epoch, permits exclusively a retry of the same ID. |
| `resolveOperationRecord(request, method, argumentHash, primaryEpoch)` | resolution with binding | The same with the binding from which the service builds a `ClaimReceipt`. |
| `resolveNotCommitted(request, method, argumentHash, requestEpoch, primaryEpoch, proofHash)` | `ClaimView` | Negative claim after a promotion (see [Administrative replication maintenance](#administrative-replication-maintenance-and-synchronous-storage)). |
| `beginOperation(template, timeout, options, take, ifExists)` | `ClaimView` | Begins a blocking operation as a durable claim; the path of the service. |
| `events(principal, options?)` / `ack(principal, epoch, upTo, options?)` | mailbox page / ACK position | Own consumer mailbox; a prefix ACK is not a txn commit. |
| `setCompletionProfiles(profiles)` | `void` | Host code only; installs the result contract before work. Setting identical profiles again is a no-op, also with running transactions. |
| `setLimits(partialLimits)` | `Limits` | Host code only: sets limits of this Space. A smaller `maxEventBytes` is refused (`ResourceExhausted`) while an existing registration or wait could produce an event that is too large with it. |

By default there is no entry count quota per Space or owner: `maxEntries` and
`maxEntriesPerOwner` are set to `FOREVER` (`Number.MAX_SAFE_INTEGER`, JSON-safe).
Count quotas explicitly stored with `setLimits` stay in effect; an update removes
no individually set quota. Byte, commit, frame and document budgets still apply.

`read`/`take` additionally accept `OpOptions`: `txn`, an absolute
`deadline`, a durable `request` and locally a `once` hook. A request ID
is intended for robust repetition across restarts: the same identity and
the same arguments return the same stored result; different arguments
lead to `RequestConflict`.

`notify` needs `{ target, txn?, lease?, handback?, request? }`. `wait` takes
`{ take?, target, timeout, txnLeaseMs?, handback?, request? }`; a served
take waiter holds the entry in a fresh transaction until the recipient
commits or its lease expires. Both methods need `startService`,
so that delivery and reaper run while idle.

The optional `write` check `unique` is an atomic check of this single
write, not a permanently registered unique index. All producers of a singleton
type must name the same key fields. Reserved and uncommitted
duplicates are refused as well; the transactional replacement of a reserved
singleton then happens with a normal `write` in the same transaction.
`RemoteSpace` requires the feature `write.unique` for this and refuses older servers
instead of silently dropping the uniqueness check. The promise holds
per Space, not across mutually independent federation members.

**Transient writes.** `write(entry, txn, lease, { transient: true })` creates no entry: the change stream
carries it as a `put` with `transient: true` (at once, or at the commit of `txn`; an abort announces nothing), and no
`read`, `take`, `wait`, `count` or subscription ever sees it. Intended for output that only readers of the stream need (a
message on a screen): no entry, no expiry, no cleanup afterwards. Whoever mirrors the Space from the stream
does not store such a `put`; no `del` follows. Not together with `unique`. `RemoteSpace`
requires the feature `write.transient`.

**Compacting the file.** `OwnStoreHost.compact()` returns the free pages of the SQLite file (expired claims,
removed entries; without it the file only grows). The first call rewrites the file once with `VACUUM` and switches
it to incremental auto-vacuum, after that it only truncates the free pages. It runs in the writer thread between
two batches; commits wait that long. An error in it does not bring the store down, the result carries it
(`{ freedPages, converted, error? }`); a store in memory answers `null`.

**Several steps in one call.** `batch(ops, { request? })` (local and `RemoteSpace`, feature `batch`) executes
steps in one commit under one request, all or (if one throws) none: `{ op: "begin", lease? }`,
`{ op: "write", entry, txn?, lease?, unique?, transient? }`, `{ op: "take" | "read", template, txn? }` and
`{ op: "commit" | "abort", txn }`. `txn: "$"` means the transaction that a `begin` earlier in the same batch
opened. Result per step: a `Lease` (begin, write), `{ entry, locked? }` (take, read; they never wait) or
`null`. Each step needs the right its own call would need, with the same type checks; at most 64
steps. In this way, for instance, the writes of a transaction together with its commit cost one round and one commit instead of one per
step. A Space with merge types (entry replication) does not offer `batch`.

## Named Spaces and background service

`createSpace(tx, alias, now)` creates a named Space in the harness commit;
`listSpaces(host, ctx)` lists alias, `spaceId`, incarnation and creation time.
`startService(harness, ctx, { space? })` starts the reaper and local event
delivery. Without `space` it also watches named Spaces created later.
It is composed of `startMaintenance` (reaper) and `startDelivery` (delivery on every change, retry by timer);
`deliverEvents` runs one delivery pass and returns the count. `ServiceOptions` contains `now`, `onError`,
`retryMs`, `meter`, `space` and `watchDebounceMs` (collapses maintenance runs triggered by the watch; 0 is the default).
Events go to conversations: `EventSink` is this interface, `ServiceHost` a store host that optionally
offers it, and `withEventSink(host, sink)` routes the events of a Space host to the conversations of a separate
agent host.

## phi-spaces store

phi-spaces keeps its documents itself ([umstellung-ohne-pi-durable.en.md](umstellung-ohne-pi-durable.en.md)). Old
pi-durable stores are not taken over (decision D6).

- `openSqliteHost(path, options?)` opens a host on a SQLite file:
  - WAL mode, one writer thread;
  - an owner lock in `path.owner`: a second process gets `StoreUnavailable`;
  - a file that is not a phi-spaces store is also refused with `StoreUnavailable`.
- `openOwnMemoryHost()` keeps everything in memory (tests, throwaway Spaces).
- `OwnSyncStore(path)` is the same store without a host. The tools of
  primary/sync replication need it. `primarySyncStorage(store, journal, peer, options)` turns it into a
  `ReplicatedOwnStore`, whose `open()` returns the replicated host.
- `OWN_SYNC_FACTORIES` are the factories of these Spaces for `openSyncSpace` and `startConfiguredFederation`.

A journal of a pi-durable store is refused with `PrimarySyncBlocked`.

## Revisions and pages

`Page` contains `{ items, next, token?, rev, streamId }`. The opaque cursor `next` is passed to
`readPage(..., { after: next })`; optionally `token` can be passed explicitly.
All pages read the same immutable snapshot, also with concurrent writes or lease expiry.
Token binding: Space/stream, owner, template and txn. TTL/eviction/host reopen → `SnapshotExpired`;
then read a new first page. Changes after the snapshot revision are caught up through `changes`.
`Changes` contains `{ streamId, batches, next, rev, more }`, with complete batches per page.
`ResponseBudgetTooSmall {requiredBytes}` changes neither cursor nor ACK position.

## `RemoteSpace` and `SpaceService`

`RemoteSpace` implements the same core methods over a `Transport`.
`statsWithRevision()`, as with the local `PhiSpaces`, returns the gauges with the revision and `streamId` they were
read at; two queries thus give the commits in between (the dashboard derives "commits/min" from this).
In addition there are `info()` (the `hello` answer), `probe`, `readPage`, `requestBound(call)` (a prepared call with identity),
`requestGeneration()`, the federation calls `requestMembership`, `requestRouterLease`, `requestRoutingPolicy`,
`entryDescribe` and `entryChanges`, the key calls `authenticate()`, `enroll(token)` and `enrollStatus(request?)` as well as
`counters` (`{ retries, unknown }`, what the connection has cost so far). `RemoteOptions` carries, among others,
`attempts` (5), `backoffMs` (100), `maxBackoffMs` (2,000) and `callTimeoutMs` (35,000).
`spaces()` lists the Spaces of the service (`spaceId`, `alias`, `createdAt`). Through the service `statsWithRevision()`
also carries `process: { cpuMs, rssBytes, heapBytes, at }`: CPU time and memory of the process serving the Space
(older servers leave it out).
`inProcessTransport(service, connection)` is for local tests;
`socketTransport({ path })` and `socketTransport({ host, port })` establish
Unix and TCP connections respectively. The server is started with
`serveSpace(service, { listen: target, connection })`.
With `identifyOnConnect: true` identity resolution begins at TCP accept;
without this option it begins at the first frame. `startGate` always sets the option
and limits peer detection to five seconds by default. In this way
silent identified sockets also consume the peer quota; a hanging
directory closes them after expiry. The layer B challenge is valid separately for 30 seconds.
The [final operating limits](_attic/abnahme/ap2-gate4.en.md) apply to the tested load profile.

Before use `RemoteSpace` calls `hello`, opens a generation and
gives every mutation a request ID. On a lost answer it repeats with
the same identity. `OutcomeUnknown` therefore does not mean that the effect
failed: keep following the same request ID with `pollOperation`
or use `cancelOperation` deliberately.

### Client helpers (`src/space-client.ts`)

What every process needs that uses a Space elsewhere; the values that differ per project are parameters.

| Function | Content |
| --- | --- |
| `cutText(text, max)` | the first `max` UTF-16 units, without half an emoji at the cut |
| `parseTarget(spec)` | `unix:/path`, `tcp:host:port` or a bare path → `ListenTarget` (`parseListen` in `src/standalone.ts` is the same function) |
| `connectSpace(spec, { callTimeoutMs = 30 s, connectTimeoutMs = 5 s, attempts = 3, … })` | `{ space: RemoteSpace, close }`; the socket request may take 5 s longer than the call |
| `readExisting` / `takeExisting(space, tmpl, waitMs, { txn })` | `readIfExists`/`takeIfExists` that distinguishes a missing from a held entry: `null` means gone, a failure only because of held matches throws `StillHeld` (via `probe`; without `probe`, `null` counts as gone) |
| `peek(space, tmpl, { txn })` | The first match as a snapshot (`readAll` with `limit: 1`), without a claim |
| `takeAll(space, tmpl, { txn })` | Takes every match free now, returns the count (one `take` per entry; held ones stay) |
| `awaitWork(space, tmpl, waitMs, halt?)` | One blocking `read` without a transaction: `true` as soon as work is there; `false` after expiry or `halt` |
| `keepAlive(space, lease, leaseMs)` | Renews a lease every `leaseMs / 3` while long work runs inside it; returns the stop function |

The service accepts the methods `hello`, `generation`, `write`, `read`,
`take`, `pollOperation`, `resolveOperation`, `cancelOperation`, `readAll`, `count`, `stats`, `spaces`, `txn`,
`lease`, `changes`, `wait`, `notify`, `events`, `ack` and `batch` (`METHODS`). `spaces` lists the Spaces of the host (`spaceId`, `alias`, `createdAt`), also those created at
runtime; the role `observer` may use it. Mutations need `{ generation, requestId }`.
`read` and `take` can return `{ state: "pending" }` and are continued through
`pollOperation`. `readAll` is the paginated page call.

`wait`, `notify`, `events` and `ack` are implemented and address the own
consumer mailbox (`target: "self"` or the own `hello.principal`). `events({ mailboxEpoch?, after?, maxBytes?, waitMs? })` returns
`{ mailboxEpoch, events, next, more, gap? }`; `ack(epoch, upTo)` confirms a
delivered prefix. After an epoch change continue with the new cursor supplied.
A delivered take carries its own txn; it is explicitly committed/aborted.

`withSpaceService(existingServerServices, service, trustedConnection)` extends the existing
pi-server with `serviceId: "space"`. The client uses
`piServerTransport(call => client.request({ serverId }, call))`. In the sibling project
Space RPC is explicitly activated with `PI_SERVERD_SPACE_PRINCIPAL` and `PI_SERVERD_SPACE_ROLES`.
An identity sent by the client does not overwrite the trusted connection context.

The service authenticates through `IdentityAdapter`, not through principals
transmitted by the client. `Policy` limits methods and entry types per role.
A type grant also applies to subtypes: a write is allowed as soon as the type or one of the
declared supertypes is released. Since the writer names the supertypes itself, a
role with a grant on `Job` can also write `{ type: "X", types: ["Job"] }`. Type grants are thus
no integrity boundary for subtypes; whoever must trust a type needs a federation type policy
with fixed supertypes or own checks of the fields.
`StaticIdentity` is a local configuration/test adapter. TCP alone offers no
federation authentication; the connection-bound overlay/challenge layer
is provided by `startGate` (layer A) and `ProvingService` (layer B), composed by `startFederationHost`.

## Errors and limits

`IllegalArgumentError`, `PermissionError`, `TransactionError`, `LimitError`
`CompletionViolation`, `MailboxEpochMismatch`, `InvalidAck`, `ResponseBudgetTooSmall`,
`UniqueConflict` (a `write` with `unique` whose key fields an entry of the type already carries; code `UniqueConflict`),
`SnapshotExpired`/`RevisionAhead` (a `changes` cursor outside the held history)
and `ResourceExhausted` describe local semantics and budget violations respectively.
The service serializes them as error codes; the remote client reconstructs
known error classes as `RemoteError` or the special local class.
A maximum client wait raises `OutcomeUnknown`, but lets the
host operation run on. Unclassified errors arrive as `Internal` with the fixed message
`internal error`; only the host logs the actual error (`console.error`).
`ResponseBudgetTooSmall` and `StalePolicyVersion` are no exports of the package root; they
come through the namespace `core` or `phi-spaces/core`. `RemoteSpace` throws `UnsupportedOperation` when the server lacks
a required feature.

The API guarantees no FIFO selection and no exactly-once execution
outside atomic Space mutations. Applications must secure external effects through
their own idempotency ID or a shared transaction.

## Phase 1b runtime and grants

`startFederationHost(harness, context, options)` starts the persistent composition
of gate, layers A/B, control permissions, enrollment, rotation, supervisor and
maintenance. `options` contains `hostId`, `authorityId`, `keys`, `verifier`, gate configuration
and `boot: { external, installed }`. Only the control side sets
`control: { host: harness, authority }`. Without boot register/installation
the start fails; `unsafeSkipBootGuardForTests` is exclusively for fixtures.

`GrantAuthority.issue(connection, purpose)` needs a fresh overlay identity,
a provisioned signer and the current key directory. `purpose` is
`effect` or `resolution`. `GrantVerifier.check(token, identity, call, connection)`
checks signature, principal, proven app key, scope, authority and deadline.

A `RemoteSpace` receives through `grantProvider(call)`, before every domain call
and every retry, a current grant; this frame changes neither domain
arguments nor request identity. The control connection offers:

- `requestGrant(purpose = "effect")`
- `lookupPeerKey(peerId, keyId)` for proven hosts/admins
- `rotationChallenge(algorithm, publicKey)`
- `rotateKey(challenge, replacementSigner)` with old and new signature
- `rotationStatus(commandId)` for the own result

Own rotation uses its own generation call and also works
with a key limited to data Spaces; no control
entries are released by this. Old keys are revoked atomically, roles and scope
taken over. Grants and a successful rotation are no evidence of external
exactly-once effect.

The recovery exports (`SqliteRecoveryRegister`, `RecoveryCoordinator`,
`installAuthorityTransition`, `installBootGuard`, `beginRestore`, `restoreBatch`,
`completeRestore`, `releaseRestored`) are building blocks for an administrative
path. Fencing, admission lock, registry update, control ACK and boot installation
must be proven by the calling service. Details and open wiring are in
[ap1b-abnahme.md](_attic/abnahme/ap1b-abnahme.en.md).

## Provisioned operation and private recovery access

`startConfiguredFederation(host, ctx, privateConfigFile)` checks private
key/configuration files, ownership of the listen IP according to NetBird,
external authority and boot permission. The returned `service` serves the
native pi-server adapter: its peer ID and groups are determined anew on the server side per
call. `trustedConnection()` creates the matching context;
`close()` ends gate, supervisor, maintenance and own register connections.
Configuration and SSH endpoints are explained in [ap1b-betrieb.md](_attic/abnahme/ap1b-betrieb.en.md).

- `provisionFileSigner(path, algorithm)` once creates a private
  desktop/service key; `loadFileSigner(path)` loads it without a substitute identity.
- `serveRegister(register, socket, { writable })` separates reader and operator;
  `SocketRecoveryRegister` and `SshRecoveryRegister` allow member read access.
- `serveRecovery({ path, hostId, operator, supervisor?, handle })` demands
  signed, time-limited requests for the fixed host target.
  `RecoveryClient.call(method, args, requestId?)` sends these requests. An exactly repeated signed
  call receives the first answer within its validity window, without the handler running again;
  a newly signed call with the same `requestId` is executed normally.
- `RecoveryController.submit(request)`, `advance(recoveryId)`,
  `status(recoveryId)` and `release({ commandId, recoveryId, scope })`
  form a journaled data restore. `dataRecoveryHandler(controller)`
  binds exclusively these methods to the private service.
- `verifySshFence(register, hostId, targets)` demands, through a fixed
  provisioned SSH access, a stopped service and a durable
  restart lock; sync/replica configurations are refused.

The recovery controller needs privileged `commit`/`snapshot` functions
of the same harness, bound before the normal boot guard is installed.
A second harness opened at the same time is no substitute for this.
These functions and the writing register capability stay exclusively
in the private recovery service. The snapshot loader and the actual durable
control ACK channel are provided explicitly by administration. `ControlRecoveryController` and `MemberTransitionInstaller` implement the
control/member flow; `startRecoveryOnly` binds it to a separate private
service under exclusive harness ownership, without the normal gate/agent start.
Distributed live data/control restores with confirmed member ACKs are evidenced
([implementation status](implementierungsstand.en.md), Phase 1b).

- `TlsRecoveryRegister` / `serveTlsRegister`: independent register with pinned
  CA trust and released client certificates; reader, explicitly limited
  `writeKeys` and operator CAS are separated on the server side.
- `ControlAckService.acknowledge(tuple, requireHostKey?)`: durable receipt for
  the registered data transition; current authority/boot/transition versions
  and, with a host signature, the still active enrolled key are checked again in
  the commit.
- `MemberTransitionInstaller.advance(proof)`: stopped normal operation with
  restart lock, bounded cleanup, historical pending claims, invalid
  generations, `orphanedAfterRestore`, epoch 1 and local/external ACK. An external ACK lost after
  a local ACK is published again on retry.
- `ControlRecoveryController.submit(request)`, `advance(recoveryId)`,
  `authorizeKey(recoveryId, key)` and `status(recoveryId)`: import with new
  authority, closed old rights, first explicit admin release,
  confirmed member ACKs and expiry of the old grant/lease deadline.
- `controlRecoveryHandler(controller, member)` accepts only the pinned
  recovery operator. `startRecoveryOnly(host, ctx, configFile, assertQuiesced)`
  starts exclusively the private socket for this.
- `startMemberRecoveryOnly(host, ctx, configFile, assertQuiesced)` starts the
  member socket intended exclusively for OP-signed `installAuthority`.
  The configuration contains a public `operator` pin and a
  `registerTls` access with write rights only for the own boot/ACK entry;
  private OP/control signing keys are not required. Normal operation
  must be stopped and persistently locked against restart.

## `RouterController` (AP 2.1)

```ts
const router = new RouterController({
  host: harness, ctx, routerId, authorityId,
  target: idempotentRpcTarget,
  assertAuthority: verifyCurrentRouterOwnership,
});
await router.recover();
await router.submit({ id, area, blocksArea: false, steps });
const state = await router.advance(id);
```

`steps` contain an immutable target `{hostId, spaceId, authorityId,
dataIncarnation, primaryEpoch}`, principal, generation, RPC method, arguments
and optionally `resultBudgetBytes`. The controller assigns stable sub-request IDs;
target adapters must use them unchanged as RPC `requestId`.

| Method | Effect |
|---|---|
| `recover()` | Reconstructs bindings and reservations; resolves old sub-requests, sends no new effect |
| `submit(spec)` | Persists a command; the same ID with different arguments is `RouterConflict` |
| `advance(id)` | Continues bound steps; unresolved transports stay `applying` |
| `get(id)` | Returns the current command including partial results and review evidence |
| `ingest(spec, ack)` | Durable deduplicated intake before a mailbox ACK |
| `reconcileDataRestore({hostId, spaceId, oldIncarnation, recoveryId})` | Persists restore reviews while keeping historical results |
| `review(id, admin, note, releaseArea, authorize)` | Separate authorized audit; does not turn `needsReview` into success |

`RouterBlocked` blocks missing reconstruction/authority or dependent areas;
`RouterBudgetExceeded` refuses new work before an effect. `RouterTarget` is
deliberately an adapter contract. Productive RouterLease/delegation is AP 2.2.
Details and simulator: [AP 2.1/2.8](_attic/abnahme/ap2-router-und-simulator.en.md).

## Federation controller (AP 2.2–2.5)

`createFederationController` connects `RouterController`, `FederationRpc`,
`FederatedSpace`, `FederationPolicyAuthority` and `MembershipController`.
`renewableRouterLease` takes care of the signed lease. The root composition
executes the `lease` callback outside journal commits; there a
renewal may use the control host itself. Within a journal commit
it checks the already obtained lease and the current control counters again.
An expired or replaced lease continues to be refused. If the
control Space lies in a primary/sync main store, `controlEpoch` supplies the
control epoch from the journal; guard and lease renewal then compare
that instead of the epoch of the Space document. `alignControlReplicaIn` performs at start the policy step of the
last control transition (`lastConfigTransition`, marker `ControlReplicaMarker`); `RemoteSpace.sendEpochNotice`
delivers the `EpochNotice` of a supervisor. The separately
injected `assertAuthority` stays a pure authority check; it must not
request a nested commit on the same host. `MemberLifecycle` installs
signed control instructions; `startConfiguredFederation` activates this with
`membership: {memberId, spaceId}`. These APIs belong to the server-side router;
they do not replace the signatures of the existing `RemoteSpace`.

Optionally `journalPartitions` (1 to 1024, default 1) provisions fixed,
persistent parent/router partitions. The return value additionally contains
`partitionRouters`; `router` stays the shared control router. The count
and IDs are immutable after initialization. Existing history is
not migrated automatically, and old request IDs are not discarded.
Each partition keeps the previous individual budgets; the total reservation
grows with the fixed count. The default stays compatible with old
single-journal stocks. Direct `FederatedSpace` composition requires a matching number of
distinct `partitionRouters` as well as `initializeJournals()` before
operation; all routers must be reconstructed beforehand. The factory takes over
initialization and reconstruction before its return. Cross-partition
transactions read their original child binding from the original partition.

Restore sets a persistent total lock before the first reconciliation and lifts
it only after all partitions. An interrupted reconciliation is continued with
the same restore tuple. Member removal takes into account
the manifest and all associated router/parent references.

Parameters, returns, rights, budgets and limits:
[Delegation, routing and membership](_attic/abnahme/ap2-delegation-routing-membership.en.md).

## Directory and local admin building blocks (AP 2.6/2.7)

`RemoteSpace.publishCapability(report)` publishes a `CapabilityReport`
through the protected control RPC `capabilityHeartbeat`. The report contains
`hostId`, `resources`, `tools`, `models` and `metrics`. The current host key,
host role, grant and a matching peer/host binding are required.
Lease and timestamp are set by the receiver: 120 seconds and its clock respectively.
Normal `write`, take, txn locking and lease changes on directory entries
are not available to clients, not even through supertypes.

`CapabilityDirectory.heartbeat(report, authenticatedIdentity)` is the internal
host API; its identity must come from the proven connection state.
`MemberStatusDirectory.refresh()` adopts current probes bound to the target
tuple. `start()` renews them every 15 seconds and returns an
asynchronous stopper. Status lease: 30 seconds. Failed or stale
probes remove capacity/capability observations from the routing table.
Directory publication registers no routing member.

The provisioned runtime configuration `capabilities` can contain `dataSpaces`,
`tools`, `models` and, in the control, `hostBindings`. The latter maps
technical peer IDs to the own host IDs. The runtime publishes automatically only
with this explicit configuration, at intervals of 60 seconds.
Reading happens through `readAll({type:"Capability"})` or the existing
`space_list`, within the own Space scope.

`DataAdminController.execute(commandId, kind, spaceId, admin, input)` accepts
`kind = "purgeTasks" | "deletePrincipal"`. Input is a task template or
a structured principal. The `authorize` provided by the operator
checks the separate scope per kind/Space; `assertAuthority` checks the current
authority. `spaceId` must be the immutable Space ID; aliases are
refused. Both checks run again in the commit. Every successful batch and
its progress are atomic; the same command ID with changed content is refused.
A `dataAdmin` provisioned in the control runtime binds the supervisor
commands with `args.spaceId` and `args.template` or `args.principal`.

`purgeTasks` accepts only profiled, unreserved tasks. `deletePrincipal`
first presupposes a quiescent local Space. `execute` processes
the deletion run in bounded commits until completion. Alternatively
`startDeletion(commandId, spaceId, admin, principal)` and
`advanceDeletion(commandId, spaceId, admin, principal)` start a run or exactly
one batch; the result contains phase and batch count. The same command
continues after a restart or lost answer. Meanwhile
a persistent Space lock blocks new effects and object queries. A changed
target tuple requires review. Remote members and router histories are thereby
not yet deleted.

`FederatedSpace.reconcileDataRestore({hostId,spaceId,oldIncarnation,recoveryId})`
marks child requests and parents `needsReview`, without new effects.
It must be bound as a reconciliation hook before the control restore confirmation.
Managed Spaces receive no control receipt without this hook.
[Acceptance status and limits](_attic/abnahme/ap2-abnahme.en.md).

`PhiSpaces.resolveOperation` receives a `RequestRef` including principal;
`RemoteSpace.resolveOperation` receives `{generation, requestId}` and uses
the authenticated identity. Method and hash denote the original
normalized claim arguments (`write`, `take`, `txn.begin` and so on). The new
wire call requires, with delegation, a signed `targetRequest` reference
with the same bindings. The local control/admin checks are also repeated on
resolution. A signed generation now contains its
issuing primary epoch; older generations stay compatible for existing claims,
but allow no new negative-claim evidence.

`AdmissionResolution.state === "notAdmitted"` means exclusively that
the identical request can be sent again to the unchanged primary.
The answer is no terminal `NotCommitted` and allows no
replacement ID. Known claims still return `pending`, `done` or `cancelled`
with existing retention/restore markers. For old members without
`resolveOperation` the router falls back to `pollOperation` for known claims;
an unknown outcome stays conservatively `needsReview` there.


### Native root and administration building blocks (2026-10-14)

`startConfiguredFederation` optionally accepts, in control mode, `root` with
a fixed root ID, separate `keyFile`/`hostKeyFile`, private `leaseFile`,
`journalPartitions` and provisioned `members`. A member binds its
target tuple, peer ID, app key pin and its overlay address. `createConfiguredRoot`
checks the independent boot/control authorization and active keys; it returns
the server-side federation controllers as well as `close()`. With
`allowMembershipCommands` and `adminPeer` the real supervisor
handlers process membership and profile commands in the authorized admin context.
This creates no public virtual root Space RPC endpoint.

`ProfileTransitionController.execute(id, nextPolicy)` replaces exclusively
completion profiles at a policy version raised by one. Open root jobs,
transactions and membership changes prevent the start. `start` and `advance`
allow individual, durably journaled progress; the same ID binds
the same policy. Members are frozen, switched and activated only after
publication of the new policy. The supervisor command is called
`migrateProfiles`, with `args.policy`; the controller must be provisioned.
Ordinary `setPolicy` changes to existing profiles stay blocked.

`RootHistoryErasure` removes, under separate operator authorization and
proven exclusive fencing, principal content from root parent/child
histories. Captured entry digests include affected foreign cached results.
Old request IDs stay bound and return `ResultExpired`; they are
not released for new effects. `DataAdminController` stays responsible for the
local data content. A complete distributed deletion run does not
arise from these two building blocks alone.

`ErasureArchiveController` requires operator authorization, a
`destroy` function and an independent `verifyDeletion` check. It registers
archives, begins an erasure epoch, quarantines older archives, processes
deletion deadlines and seals the epoch after a checked local completion.
`assertRestore(spaceId, artifactId)` checks catalog and current epoch; the
restore caller must additionally bind the actual archive bytes to the
registered hash. Incomplete deletions, old snapshot epochs and
overdue archives block normal services through the independent register
entry. `SqliteRecoveryRegister` checks erasure epoch and archive catalog atomically
within the CAS commit, also behind mTLS: epochs begin at one, rise
only after a completed previous deletion run including archive deletion,
and keep command hash and deletion deadline. Archive IDs, hashes, epochs and kinds
are immutable; quarantine and destruction cannot be reset. A
late registration of an old backup fails at the current floor.
The complete backup/restore operational integration is still outstanding.
Other `RecoveryRegister` implementations must guarantee the same atomic
constraints; mere caller checks are not sufficient for this.


### Fresh checks and bound claim answers

`RecoveryRegister.getMany(keys)` is optional. TLS clients activate the bounded
batch call explicitly with `batchReads: true`; at most 32 unique keys
are read per batch. Each batch opens a new mutually authenticated
TLS connection. Without opt-in, individual queries remain. A `unixPath` transport
requires an absolute socket path and an explicitly pinned TLS server name.

`SpaceKeyDirectory.findMany(keys)` and `inspect(keys)` read a normal,
protected control snapshot every time. `inspect` returns its state and the
keys derived from it together; it stores neither state nor authentication for later calls.

`RemoteSpace.requestBoundWithClaim(call)` requests, in addition to the normal result,
optionally a bound claim receipt. The service resolves for this the actually stored
original claim; the router checks host, Space, authority, incarnation, epoch,
principal, generation, request ID, method and argument hash. The raw RPC result
does not replace this receipt. If it is missing with an older service, a separate
claim resolution stays necessary. Restored, expired or contradictory
results continue to lead to review.

`RouterStepSpec.generationAdmitUntil` records the confirmed admission deadline. A
transaction sequence may use the original generation only within this deadline and
with identical binding. This replaces no app key proof, grant or
delegation evidence. Missing deadlines in older journal entries lead to the previous
fresh generation call.

### Distributed principal erasure and SQLite histories

`DistributedPrincipalErasure({register, archives, driver, authorize})` has
`advance(plan)` and `execute(plan)`. A plan binds `id`, `principal`, up to
32 unique Space target tuples with exactly one root and `retentionMs` (at most
24 hours). The progress address is `erasure-command:<id>` in the
independent register. Changed arguments under the same ID are
refused. The current collection limit is 4096 entry IDs (each at most 256 characters);
exceeding it stops the command under the existing locks.
Driver calls must be repeatable for the same command binding
and prove exclusively stopped writers. Before every maintenance step
all locks are checked; release presupposes all sealed floors.
The CLI [run-distributed-erasure.ts](../test/testbed/run-distributed-erasure.ts)
binds this for the test federation to real processes, local deletion receipts,
archive files and the independent mTLS register entries.

`compactErasedSqlite(path, assertExclusiveFenced)` (in `src/erasure-sqlite.ts`, no package export) cleans a stopped
phi-spaces SQLite store after a deletion. The store keeps no
revision history. Bytes of deleted rows can however remain in free pages and in the
WAL. The call takes the owner lock, rewrites the file with
secure delete and VACUUM, empties the WAL and checks integrity.
Refused are:

- symlink files;
- a running host (it holds the lock);
- every file that is not a phi-spaces store. This also applies to old
  pi-durable stores (decision D6).

The caller must already have completed the logical principal deletion
and hold the exclusive independent fence during the whole call. It
replaces no deletion rule for external copies.


## Entry replication: administrative Phase 3 building block

`EntryReplicationController` uses a separate document, no automatic
replication of existing `PhiSpaces` entries. Configuration, call methods,
trust boundary and operating restrictions are in
[Phase 3](_attic/abnahme/ap3-replikation.en.md). The exported HLC functions are
`advanceHybridClock`, `compareHybridClock` and `validateHybridClock`. The clock
must be stored atomically with the change; the controller takes care of this.
`EntryReplicas` is an internal administrative document family and no
unauthorized RPC import path. Through the `space` service merge types (`SpaceServiceOptions.merge`) go with
`write`, `read`, `readAll` and `count`; `lease cancel` deletes and `lease renew` renews the visible version
(only its owner; the answer of `renew` names the new ID). `changeForRequest(requestId)` returns the own
change for a local request ID for retries. Primary/standby and promotion are not provided by this.


### Paged snapshot import

`EntryReplicationController.startSnapshot` and `snapshotPage` export a
history frozen at R. `beginSnapshotImport`, `importSnapshotPage`,
`snapshotImportStatus`, `finishSnapshotImport` and `abortSnapshotImport`
manage durable pages and the import cursor. Only the finish makes all
pages visible atomically. `sourceRevision` in the finish result names the starting point
for changes arising afterwards. Limits, resumption, abort and
trust scope: [Snapshot transfer](_attic/abnahme/ap3-snapshot-transfer.en.md).


### Durable entry stream

`describeStream`, `streamChanges`, `startStreamImport`, `streamImportStatus` and
`importStreamPage` bind the continuous exchange to a fixed source. Import
and cursor progress are atomic. `EntryReplicationPump` offers a bounded
step and an explicitly started, abortable pull loop. Per source the
last range receipt stays repeatable; older ranges require reading
the checkpoint again. Adapters, return values and limits are in the
[stream protocol](_attic/abnahme/ap3-stream-transfer.en.md). `SpaceService` does not offer these administrative
methods (`METHODS`). A federation host with `entryExport` answers `entryDescribe` and `entryChanges` in front of
the service; `RemoteSpace.entryDescribe()` and `entryChanges(after, maxBytes)` are the client side.


### Administrative replication maintenance and synchronous storage

`EntryReplicationController.startSnapshotMaintenance(id, pageBytes?)`,
`advanceSnapshotMaintenance(id)` and `snapshotMaintenanceStatus()` copy and
publish a complete prefix and then retire old
chunk documents. `forgetSnapshotReceipt(id)` removes only expired, no longer
live receipts. Origin/request/conflict information and cursors are kept.
[Details](_attic/abnahme/ap3-snapshot-maintenance.en.md).

Compaction (lww/set step 4): `compactionStatus()` names the blocking reason, event count, removable events
and lower bound; `compact(id)` performs a compaction completely, `startCompaction(id, pageBytes?)` starts
it as a maintenance generation (continue with `advanceSnapshotMaintenance`, abort while copying with
`abortSnapshotMaintenance`). `recordPeerVector(description)` stores the
vector a peer reports in `describeStream()`; `EntryReplicationPump` calls it itself. The option
`requestRetentionMs` (default 24 hours) keeps own changes for retries. Stream pages carry `positions`
when they are not contiguous. [Rules](_attic/abnahme/ap3-replikation.en.md).

`PrimarySyncJournal`, `primarySyncStorage`, `recoverPrimarySync` and
`materializeSyncHistory` form the administrative synchronous storage path.
It has fixed configuration pins, a durable hash chain, standby ACK and
atomic data markers; an unclear sealed candidate returns `CommitSealed`. In the service this becomes the
error code `CommitSealed`, in the client `CommitSealedPending` (subclass of `OutcomeUnknown`); `sealedResolver`,
`sealedCandidateOf` and `SyncSpace.resolve()/unserve()` resolve the candidate in the running host
([flow](_attic/abnahme/ap3-primary-sync.en.md)). After a promotion `resolveOperation` answers an unknown request
of an older epoch with evidence (`promotionEvidence`, service option `promotionProof`) through a negative claim with `NotCommitted`
(`claims.decideNotCommitted`, `PhiSpaces.resolveNotCommitted`, error class `claims.NotCommitted`).
These building blocks alone activate no sync policy; transitions and promotion are below.
[Trust scope and operating limits](_attic/abnahme/ap3-primary-sync.en.md).

Configuration changes are entries of the chain (`applyConfigTransition`,
`recoverSealedWithoutStandby`, `PrimarySyncJournal.catchUp`; `durabilityOf(config)` reads the durability,
`lastConfigTransition` the last change). Built on this are
`degradeToSingle`, `promote` and `setStandby` with `FencingAdapter`
(`SimulatorFencing` only with `allowSimulator`, `unconfiguredFencing` as a placeholder),
`fenceHostBoot`, `revokeSpacePermit` (degradeToSingle with `revokeStandbySpace`), `releaseHostToQuarantine` as well as `assertSyncPrimary`,
`assertSyncStandby` and `assertQuarantine`. Failed transitions throw
`ReplicaTransitionBlocked`. [Replica control](_attic/abnahme/ap3-replica-control.en.md).

`NetcupFencing` (with `NetcupScp`, `fileTokenProvider`, `fileFenceState`) is the
netcup adapter; `serveFencing` offers an adapter over mTLS only for
operator certificates, `TlsFencing` is the matching client. Error: `NetcupError`.
`ContainerFencing.release` aborts if the unit still carries another `zz-*-fenced.conf` drop-in
(for instance from an earlier version); it is not removed automatically.
Without a stored fence state (autostart or restart policy) `NetcupFencing.release` and
`ContainerFencing.release` abort instead of guessing a value.

`PrimarySyncJournal.beginTransition`, `openTransitionIds` and `abandonTransition` control the write lock
during a transition. `installBootGuard(..., { replicaConfig })` binds primary/sync Spaces to the
journal configuration. `readmitSpace` (operator) and `installAdmittedPermit` (host) readmit the remaining Spaces
of a fenced host individually. `signedReplicaPeer` and `replicaSyncHandler` form the signed
replica transport. `replicaConfigNotice`, `signReplicaConfigNotice` and `adoptReplicaConfigNotice` carry a
new replica configuration into the member table of the router. Adoption is possible only if the register
admits the new primary with exactly these values. Delegations carry `targetReplicaConfigVersion`, and
`DelegationVerifier({ replicaConfig })` answers `ReplicaConfigPending` until adoption. `ReplicaConfigPending` and `StalePolicyVersion`
are separate error codes (classes in `core`); the router waits or prepares never-admitted steps anew through
`RouterTarget.reprepare` and resolves open steps at the installed successor of their binding
([replica control](_attic/abnahme/ap3-replica-control.en.md)). A primary
publishes its notice with `RemoteSpace.publishReplicaNotice` on the `ReplicaNoticeBoard` of the control Space;
the native root adopts it in the heartbeat (`adoptReplicaNotices`) and addresses members through their provisioned
`replicas`.

`openSyncSpace` opens a primary/sync Space with its own store, replica listener, boot guard and notice.
`startFederationHost({ syncSpaces })` and `startConfiguredFederation(host, ctx, file, { openSyncStorage,
openSyncHarness })` bind such Spaces into the federation host. Without the two factories every Space lies in the
phi-spaces store (`OWN_SYNC_FACTORIES`). `SyncSpaceConfig.journal` sets the journal limits
(`maxIntentBytes`, `maxHistoryBytes`). An exhausted budget refuses the commit with `SyncJournalFull` (no package export, subclass of `PrimarySyncBlocked`) (in the service
`ResourceExhausted`), without locking the host. `createSpace(tx, alias, now, { spaceId,
incarnation })` creates a Space with a given identity.


For set rules `EntryMutation` now additionally supports
`{kind: "renew", type, tag, fields, owner, expiresAt}`. This exclusively renews
a locally live observed tag, keeps fields/owner and atomically creates a
new tag together with the removal of the old one. The request ID stays replayable. This is
still the administrative entry API, no automatic redirection of normal
`PhiSpaces.renew` calls.


## Run control (operations extension)

Contract and acceptance: [Operations and mobile control](betrieb-und-mobile-steuerung.en.md) §6 and §8.

### RunGate in the core

`CompletionProfile.gateField` (must be in `equalFields`, `maxLeaseMs` is then mandatory) binds tasks to the
RunGate of their run. All functions are host code and not reachable through Space RPC.

| Function | Effect |
|---|---|
| `core.applyRunGate(s, now, {runId, commandId, kind, revision, recoveryId?, expect?})` | `kind`: `prepare`, `release`, `pause`, `resume`, `stop`. Returns `RunGateAck {phase: "applied" \| "fenced", state, revision, spaceId, incarnation, authorityId, boundTxns}`. The same revision with the same command returns the stored confirmation; with another command `RunGateConflict`. |
| `core.runGateView(s, runId)` | reading view of gate, fence, recovery and bound txns |
| `core.recoverRunGate(s, now, {runId, recoveryId})` | installs the recovery entry lock and returns `RunRecoveryView` (`stable` only without a bound txn) |
| `core.assertGatedProfilesKept(s, profiles)` | Check before every profile change |

Errors: `RunGateConflict` (revision, command, state, recovery), `CompletionViolation` (result without a bound
txn or with a foreign run). Gated tasks are writable only in `preparing`.

### `RunController`

```ts
const runs = new RunController({ host, ctx, member: spaceId => RunMember, identity?: async () => ({ authorityId, incarnation }) });
await runs.start(commandId, { runId, kind, config, members });
await runs.pause(commandId, runId); await runs.resume(commandId, runId); await runs.stop(commandId, runId);
await runs.advance(runId);            // continue open transitions, idempotent
await runs.reconcile(commandId, runId, recoveryId, manifest?);
await runs.resolve(commandId, runId, { expectedViewHash, decision: "pause" | "stop" | "resume" });
await runs.status(runId); await runs.pending();
```

A change of the control identity or a member under a restore lock starts `reconcile` automatically
(recovery `control-<inkarnation>` or `runRecoveryIdOf(restoreId)`); open jobs are never sent again in this.

Reading: `runs.list(limit)` as well as the admin commands `listRuns`, `runStatus` and `listWorkers` (assignments plus
the last reported state per host).

`RunView.state` is `preparing`, `running`, `pausing`, `pauseIncomplete`, `paused`, `resuming`, `stopping`,
`stopped`, `reconciling` or `needsReview`; `pending` names applied, fenced and missing members,
`recovery` the views, the view hash, parked jobs and reported changes. `RunBusy` reports a still
open transition or a running recovery. Commands with the same ID and the same content are idempotent.

Members: `localRunMember(host, ctx, spaceId, prepare)` for own Spaces, `remoteRunMember({spaceId, authorityId,
peerId, signer, memberPin, send})` for foreign hosts; `send` is for instance `RemoteSpace.requestRunGate`. On the
member host `RunGateService({..., controllerPin, preparers})` checks signature, authority and local Space; it is
passed as `runGates` to `startFederationHost`. `runCommands(runs)` returns the supervisor handlers for
`startRun`, `pauseRun`, `resumeRun`, `stopRun`, `reconcileRun` and `resolveRunRecovery`; with `control.runs`
`startFederationHost` continues open transitions on the server side.

Sieve: `SIEVE_GATED_PROFILE`, `configureGatedSieveSpace(host, space)` and `prepareSieveRun(host, config, {space, gate})`
in `examples/sieve.ts`. `SIEVE_COMPLETION_PROFILE` now also checks `rangeStart` and `rangeEnd`.

### Worker control

```ts
const workers = new WorkerAssignments({ host, ctx, authorityId, peerId, signer, identity?: async () => ({ incarnation }) });
await workers.set(commandId, { assignmentId, hostId, kind, targetSpace, count, runId? }); // count 0 stops after the task
await workers.forHost(hostId); await workers.list();

const sup = new WorkerSupervisor({ host, ctx, hostId, authorityId, controllerPin, kinds: { sieve: SIEVE_WORKER_KIND },
  fetch: () => remote.workerAssignments(), backoff?: { minMs, maxMs }, sleep?, space? });
await sup.reconcile();                 // one pass: fetch, check, store, scale -> WorkerSummary
const stop = startWorkerSupervisor(sup, { intervalMs, publish: summary => heartbeat({ ...report, metrics: { workers: summary } }) });
await sup.acceptControlIdentity(incarnation); // after a checked control restore
```

A worker kind is `{ step({ space, spaceId, runId?, signal }): Promise<boolean>, requiresRun? }`: one task per
step, `false` when none can be taken right now. The stop is checked between steps, waits it aborts
at once. `WorkerSummary` names per assignment `desired`, `active`, `stopping`, `tasks`, `errors`, `lastError` and
`rejected`, plus `generation`, `blocked` and `fetchError`. `appliedWorkers(controlState, now)` reads the last
state per host from the capability entries; `at` shows how old it is. With `control.workers`
`startFederationHost` offers the gate method `workerAssignments` and the admin command `setWorkers`;
`RemoteSpace.workerAssignments()` calls it. Workers are loops in the process, not threads.

### Space lifecycle

```ts
const life = new SpaceLifecycle({ host, ctx });
await life.apply({ commandId, action: "create", alias, limits?, profiles? }); // { spaceId, alias, state, existed? }
await life.apply({ commandId, action: "archive" | "reactivate" | "delete", spaceId });
```

Errors: `SpaceInUse` with a reason (membership, entries, open work, claims, mailboxes, runs, restore),
`RunGateConflict` for an alias with other limits/profiles, `PermissionError` for default and control Space.
An archived Space (`SpaceState.archived`) refuses writes, takes, txns, waiting takes and registrations.
Remote: `SpaceLifecycleService` (as `spaceLifecycle` to `startFederationHost`), `RemoteSpace.requestSpaceLifecycle`,
`signLifecycle`/`verifyLifecycle`; `spaceCommands({authorityId, peerId, signer, hostPin, send})` returns the
supervisor handlers, which are bound through `control.spaces`.

### Deployment bootstrap

```ts
validateDeployment(config) // { config?, configHash?, errors[] }
const deploy = new DeploymentController({ host, ctx, ports: {
  hostStatus: capabilityHostStatus(host, ctx, controlSpaceId), createSpace: spaceCommands(...).createSpace, workers, controlSpaceId } });
await deploy.bindHost(alias, hostId);
await deploy.plan(config);       // { ready, configHash, steps: [{ key, action, status, detail }] }
await deploy.apply(config);      // { state: "applying" | "blocked" | "completed", steps }
await deploy.startWorkers(commandId, deployment);
await deploy.export(deployment);
```

`deploymentCommands(deploy)` returns the supervisor handlers `planDeployment`, `applyDeployment`, `bindHostAlias`,
`startWorkers` and `exportDeployment`; `startFederationHost` binds them through `control.deployment`.
CLI: `npm run bootstrap -- --check|--plan|--apply|--bind a=id|--start-workers|--export` (exit 0 ok, 1 invalid
config, 2 refused/blocked, 3 no result yet).

### Alerting, audit and preview

```ts
await collectAlerts({ runs?, workers?, host, ctx, controlSpaceId, staleMs? }); // Alert[] { key, severity, source, subject, message }
const monitor = startAlertMonitor({ collect, publish: webhookPublisher("https://ntfy.example/topic"), intervalMs });
await auditLog(host, ctx, controlSpaceId, { limit });                            // without result payloads
await runs.preview("start" | "pause" | "resume" | "stop", runId, spec?);        // { allowed, reason?, revision?, state? }
```

Admin commands: `listAlerts`, `auditLog` (every control runtime) as well as `dryRun: true` on `startRun`, `pauseRun`,
`resumeRun`, `stopRun`.

### Result export and schedule

```ts
new RunController({ ..., exporters: { sieve: SIEVE_EXPORTER }, space: spaceId => SpaceLike });
await runs.export(runId);   // { complete, expected, found, missing, manifestHash, resultHash, summary }
await runs.schedule(commandId, runId, { kind: "pause" | "resume", at, cancel? });
```

Admin commands `exportRun` and `scheduleRun` (`scheduleId`, `kind`, `at`, `cancel`).

## Agent package (`agent/`)

`agent/` is a separate, private package (`phi-spaces-agent`, own dependencies pi-durable, chord, pi-ai) without `main` and
`exports`; it is included through file paths and is not part of the `phi-spaces` contract. The agents connect to
a separate Space host, not to their agent store: every tool call gets a request identity that is in the agent store before the
first Space call, so a repeated call receives the first result.

| File | Export | Content |
| --- | --- | --- |
| `agent/src/index.ts` (entry, from `agent.ts`) | `createSpaces(spaces)` | The pi-durable extension with the Space tools (`space_write`, `space_take`, …) over an `AgentSpaces` |
| | `localSpaces(host, { space?, meter?, now? })` | `AgentSpaces` on a Space host in this process |
| | `AgentSpaces` | Where the tools act: `space(id, ctx)`, `generation(id, ctx)`, `request(id, generation, requestId)` |
| | `conversationPrincipal(id)` | The principal of a conversation in the claims (`conversation-<id>`) |
| | `agentContext(context)` | Passes abort and context values on to the agent runtime when the standalone Space calls it |
| | `withAgentEventSink(host, harness)` | Delivers the events of a Space host to the conversations of an agent harness |
| `agent/src/with-agent.ts` (entry of the mobile bundle and of pi-serverd) | everything from `src/index.ts` and `agent.ts` | Space and agent tools in one process; `withEventSink` is `withAgentEventSink` here, plus `openDurableSqliteStorage` |
| `agent/src/storage.ts` | `openDurableSqliteDatabase`, `openDurableSqliteStorage` | SQLite of the agent store with the sync policy from [agenten-stromausfalltest.en.md](agenten-stromausfalltest.en.md) |
| | `openDurableJsonlStorage`, `durableJsonlFileSystem` | JSONL with the same promises; acknowledgements follow the flush of file and directory |
| | `syncDirectory`, `ensureDurableDirectory` | Sync a directory, create one durably |
| `agent/src/durable-client.ts` | `DurableAgentClient` | Optional process boundary: `new DurableAgentClient(store, { modelsModule?, timeoutMs?, maxTokens? })`, `run(request, callbacks, signal?)`, `close()`. Imports no pi-durable or chord; the worker is `agent/src/durable-worker.ts` |
| `agent/src/durable-protocol.ts` | `AgentRequest`, `AgentAnswer`, `AgentUsage`, `AgentCallbacks`, `ParentMessage`, `WorkerMessage` | Structural IPC types of this boundary |
| `agent/src/live-models.ts` | `liveModels()` | Real models for the live examples (`PI_PROVIDER`, `PI_MODEL`; credentials from the environment or `~/.pi/agent/auth.json`) |

## Export overview

These tables name, per area, the exports of `phi-spaces` that the sections above do not cover. Document types
(`defineDoc`/`defineDocFamily`) are the state storage of the respective controller; they are exported so that host code can read them in
a commit, and are no separate write path.

### Client, context and metering

| Export | Content |
| --- | --- |
| `SpaceHost`, `PhiSpacesOptions`, `Req`, `Once`, `Taken`, `ChainOptions` | Client types: required host, options, request identity with `unique`/`transient`, once hook, entry view, `readChain` options |
| `BatchOp`, `BatchResult` | Step and result of `batch` |
| `WAKE_DEBOUNCE_MS` | Pause (20 ms plus jitter) between a change and the next attempt of a blocked read/take |
| `DEFAULT_LIMITS`, `UnknownLeaseError`, `Json`, `Fields`, `Template` | Default limits, error of an unknown lease, JSON types, template |
| `Space` | Document of the default Space |
| `ContextKey`, `withContextValue`, `withAbortSignal`, `awaitWithContext` | Typed context key, context with a value or an additional abort signal, waiting until completion or abort (the promise goes on) |
| `Meter`, `Counter`, `COUNTERS`, `MeterSnapshot` | Process-local counters `writes`, `reads`, `takes`, `misses`, `events`, `failures`, `retries` with rates; `meter` is the default instance, `Live` a sample |
| `formatStatus`, `formatWidget`, `watchLive` | Status line, multi-line display, sampling of gauges and rates every `intervalMs` without a commit |
| `canonicalJson` | Canonical JSON (RFC 8785, [wire protocol](wire-protokoll.en.md)) |

### Named Spaces, claims and mailbox

| Export | Content |
| --- | --- |
| `snapshotSpace(host, spaceId, ctx)` | Committed state of a Space without a commit; `undefined` if it does not exist |
| `resolveSpaceId(tx, space)`, `spaceDoc(tx, space)` | Alias or ID to `spaceId`, document of a Space in the commit |
| `Registry`, `RegistryState`, `NamedSpace`, `SpaceInfo`, `DEFAULT_ALIAS`, `UnknownSpaceError` | Register of the Spaces, document family of named Spaces, description of a Space (a deleted one keeps its ID with `deletedAt`), alias `default`, error |
| `claims`, `Principal` | Namespace `src/claims.ts` (among others `decideNotCommitted`, `NotCommitted`); `{ peerId, agentId? }` |
| `RequestExpired`, `IncarnationChanged`, `OperationCancelled` | Generation no longer admits the ID; generation of an earlier incarnation; request cancelled before the decision |
| `argHash(method, args)`, `ClaimView`, `ClaimState` | Canonical hash of the domain arguments, view and state of a claim |
| `principalId(principal)`, `MailboxPage`, `MailItem`, `MailboxState` | Canonical principal ID, page, item and state of the mailboxes |

### Service and transport

| Export | Content |
| --- | --- |
| `PROTOCOL_VERSION`, `METHODS`, `Method` | Protocol version 1 and the methods of the service |
| `DEFAULT_POLICY`, `RolePolicy`, `Identity`, `principalKey` | Default roles ([wire protocol](wire-protokoll.en.md) section 4), right of a role, identity, owner key of a principal |
| `Call`, `Reply`, `ErrorCode`, `Connection` | Call and reply envelope, error codes, what a transport knows about a connection |
| `MergeAdapter`, `MergeTypeNotExclusive` | lww/set types of a Space through its replication controller; exclusive operation on such a type |
| `ServeOptions`, `SpaceServer`, `SocketTransport`, `ConnectOptions`, `RemoteOptions` | Options and returns of `serveSpace`, `socketTransport` and `connectSpace` |
| `RoutedServices`, `RoutedAttachment`, `RoutedCall` | Structural types of the pi-server adapter |

### Gate, keys, enrollment and supervisor

| Export | Content |
| --- | --- |
| `Gate`, `GateOptions`, `PeerDirectory`, `PeerInfo`, `GroupRoles`, `NetbirdDirectoryOptions` | Return and options of `startGate`, the peer directory |
| `NetbirdDirectory`, `DirectoryDown` | Layer A against the NetBird API (`GET /api/peers`, cached); directory unreachable |
| `GateIdentity`, `DEFAULT_GROUP_ROLES`, `rolesOf(groups, map)` | The principal is the peer ID, roles come from groups; privileged roles only after a key proof |
| `ProvingService`, `ProvingOptions`, `AuthState`, `Challenge`, `AUTH_PROTOCOL`, `CHALLENGE_TTL_MS`, `DEFAULT_PRIVILEGED` | Layer B: `challenge` and `prove` in front of the service, state per connection, challenge 30 s |
| `KeyDirectory`, `MemoryKeyDirectory`, `PeerKeyRec`, `Algorithm` | Key directory (in memory for tests and tools), entry in the control Space, `ed25519` or `ecdsa-p256` |
| `generateKey(algorithm, keyId)`, `Signer`, `signedBytes(challenge)`, `verifySignature` | Create a key pair, signer, signed bytes of a challenge, check |
| `EnrollmentService`, `EnrollmentOptions`, `EnrollRec` | `enroll` and `enrollStatus` for peers with the role `unpaired` |
| `createEnroll`, `bootstrapEnroll`, `revokePeerKey` | Processing in the supervisor, token of the first admin, revoke a key |
| `newEnrollToken`, `hashToken`, `enrollQr`, `keyFingerprint` | 256-bit token, SHA-256 of the token, content of the QR code (secret, never log), ID of a public key |
| `BootstrapClosed`, `CONTROL_SPACE`, `ENROLL_TTL_MS`, `UNPAIRED_ROLE`, `ENROLLABLE_ROLES` | Bootstrap already used; alias `control`, token deadline 5 min, role name, assignable roles |
| `SupervisorOptions`, `ControlAccess`, `ControlAccessOptions` | Options of `Supervisor`; access rules of the control Space (`Command`, `Result`, `PeerKey` only for admins) |
| `COMMAND_KINDS`, `CommandKind`, `CommandResult`, `RESULT_RETENTION_MS` | Built-in commands `createEnroll`, `revokePeer`, `rotateKey`, their result, retention 7 days |
| `RotationService`, `createRotationChallenge`, `rotateKeyIn`, `rotationBytes`, `RotationChallenge` | Server side of own key rotation |
| `GrantDenied`, `Grant`, `SignedGrant`, `verifyDetached` | Refused grant, grant and its signed form, check of a detached signature |
| `FederationHostOptions`, `FederationConfig`, `RootConfig` | Options of `startFederationHost`, configuration file of `startConfiguredFederation`, its `root` part |
| `startQuarantineReplicas(ctx, configFile, factories, { pollMs? })` | Quarantine start: opens only journals and replica listeners of its primary/sync Spaces, serves nothing |

### Recovery and boot

| Export | Content |
| --- | --- |
| `privateFile(path)` | Reads a private file; symlinks, foreign owners and too wide rights are refused |
| `RegisterConflict`, `RegisterRecord`, `RegisterTlsClient`, `RegisterTlsIdentity` | CAS conflict, value with version, access to the TLS register |
| `RecoveryBlocked`, `AuthorityTransition`, `SignedAuthorityTransition`, `AuthorityRecord` | Authority change and its entry in the register |
| `BootBlocked`, `HostBootState`, `SpaceBootPermit` | Boot guard: lock, state of a host, permit per Space |
| `RecoveryCall`, `SignedRecoveryCall`, `recoveryBytes(call)` | Signed call of the private recovery service |
| `sshRecoveryTransport(target, timeoutMs?)` | Transport to this service over SSH |
| `startConfiguredRecovery(host, raw, ...)`, `PrivateRecoveryConfig` | Starts the private recovery service from the configuration |
| `RecoveryJobs`, `RecoveryJob`, `DataRestoreRequest`, `RecoveryControllerOptions` | Journal and types of `RecoveryController` |
| `snapshotHash(state)`, `RestoreArgs`, `RestoreState` | Hash of a Space state, arguments and state of a restore |
| `ControlRecoveryJobs`, `ControlRestoreRequest`, `ControlRestoreJob`, `ControlRecoveryOptions`, `ReauthorizeKey` | Journal and types of `ControlRecoveryController` |
| `MemberAuthorityAck`, `MemberTransitionOptions`, `MemberRecoveryOnlyConfig`, `RecoveryOnlyConfig` | Member transition and configurations of the recovery-only starts |
| `RecoveryReceipts`, `ControlAck` | Document and content of durable control receipts |
| `signControlHostChange`, `verifyControlHostChange`, `ControlHostChange`, `SignedControlHostChange` | Change of the control host under the same authority, signed by the recovery admin |
| `recordControlHostChange`, `followControlHostChange`, `ControlHostChangeBlocked` | Entry in the register after the promotion; a host follows it before anything else at start |

### Replication, fencing and sync Spaces

| Export | Content |
| --- | --- |
| `PrimarySyncConfig`, `PrimaryCommitIntent`, `PrimaryConfigIntent`, `PrimaryBootstrapIntent`, `PrimaryIntent`, `PrimarySyncAck`, `PrimarySyncPeer` | Configuration, entries of the hash chain, standby confirmation and interface |
| `bootstrapPrimarySync(raw, journal, ctx, o?)`, `captureStore(storage, ctx)` | Bring an existing, exclusively opened store under primary/sync; complete content with digest |
| `PromotionEvidence`, `CommitSealed`, `FenceProof`, `StandbyTarget` | Promotion evidence, sealed commit, fencing evidence, target of `setStandby` |
| `openSyncSpaces`, `SealedSyncSpace` | Opens every configured Space on its own; one that does not open stays unserved and blocked |
| `latestReplicaConfigNotice(journal, dataIncarnation)`, `ReplicaConfigNotice`, `SignedReplicaConfigNotice` | Notice of the newest completed transition and its types |
| `ReplicaTransportRefused`, `ReplicaPin` | Refused replica transport, pinned host |
| `memoryFenceState()`, `NetcupServerPin`, `NetcupFenceState` | Fence state in memory, pin of a server, storage of the old autostart |
| `ContainerFencingError`, `ContainerPin`, `CommandRunner`, `execRunner` | Error and pin of the container adapter, command execution without a shell |
| `ReplicationConflict`, `entryChangeId`, `EntryReplicationConfig`, `EntryReplicationRule`, `ReplicatedEntryChange`, `ReplicatedEntryView`, `EntryReplicationSnapshot`, `EntryReplicationOptions` | Types and helpers of entry replication |
| `ReplicationClockError`, `HybridClock` | Error and value of the hybrid clock |
| `EntrySnapshotChunks`, `EntrySnapshotTransfers`, `EntrySnapshotMaintenance`, `EntrySnapshotMaintenanceJob`, `EntrySnapshotManifest`, `EntrySnapshotPage`, `EntrySnapshotImport` | Documents and types of snapshot transfer and maintenance |
| `EntryStreamCheckpoints`, `EntryStreamCursorConflict`, `EntryReplicationUnavailable`, `EntryStreamIdentity`, `EntryStreamDescription`, `EntryStreamPage`, `EntryStreamCheckpoint`, `EntryStreamResult` | Document, errors and types of the entry stream; `EntryReplicationUnavailable` is the only retryable source error |
| `EntryReplicationSource`, `EntryReplicationStep`, `EntryReplicationPumpOptions` | Source, step and options of `EntryReplicationPump` |

### Router, delegation and federation

| Export | Content |
| --- | --- |
| `DEFAULT_ROUTER_LIMITS`, `RouterLimits`, `RouterOptions`, `RouterCommandSpec`, `RouterCommand`, `RouterStep`, `RouterReceipt`, `TargetBinding`, `CommandState`, `RouterOperation`, `RouterJournal` | Limits, options, job types and journal of `RouterController` |
| `RouterLeaseAuthority`, `RouterLease`, `SignedRouterLease` | The control host commits a lease before signing it |
| `signDelegation`, `delegationForCall`, `DelegationDenied`, `Delegation`, `SignedDelegation`, `TargetRequest`, `SignedEpochNotice` | Delegation of a call to a member and its types |
| `rpcDomain(call, principal)` | Domain form of a call, basis of the argument hash ([wire protocol](wire-protokoll.en.md) section 5) |
| `validateFederationPolicy`, `verifyFederationPolicy`, `FederationPolicy`, `FederationRule`, `FederationMember`, `FederationCompletionProfile`, `SignedFederationPolicy` | Check and types of the routing policy |
| `hrw(value, ids)`, `writeMember`, `searchMembers`, `normalizeFederatedEntry` | Rendezvous hash, target member of a write, search members of a template, normal form of an entry |
| `RoutingConflict`, `MigrationRequired`, `MemberDrained`, `CapacityUnavailable`, `NoCapableMember` | Routing errors |
| `FederationRouting`, `RoutingState`, `controlAlignmentBlocker` | Routing document and its state; check before a control transition |
| `FederationUnavailable`, `FederationPending`, `FederationIO`, `FederationOperation`, `FederationOperations`, `FederationRequest` | Errors, input/output interface, journal and types of `FederatedSpace` |
| `MembershipInstruction`, `MembershipProof`, `SignedMembership`, `signMembership`, `verifyMembership`, `MembershipJournal`, `MembershipTransport`, `memberReferencesIn` | Signed membership instructions, journal, transport, open references of a member |
| `CAPABILITY_LEASE_MS`, `CAPABILITY_HEARTBEAT_MS`, `MEMBER_STATUS_LEASE_MS` | 120 s, 60 s and 30 s of the directory |
| `FederationJournalLayout`, `validateJournalPartitions`, `operationPartition`, `parentJournalKey`, `partitionRouterId` | Fixed partition layout and its mapping |
| `ProfileTransitions`, `RootErasures` | Journals of `ProfileTransitionController` and `RootHistoryErasure` |
| `ErasureArchive`, `checkErasureBarrier(register, spaceId, state, now?)`, `ErasureBarrier` | Archive entry; lock of a Space from the deletion state |
| `DistributedErasurePlan`, `ErasureParticipant`, `DistributedErasureDriver` | Plan, participants and driver of `DistributedPrincipalErasure` |

### Runs, workers, Spaces and deployment

| Export | Content |
| --- | --- |
| `RunGateCommand`, `RunGateKind`, `RunGateState`, `RunGateEvidence` | Types of the RunGate in the core; `RunGateEvidence` is the compact evidence from a restored snapshot |
| `RunJournal`, `RunExporter`, `RunIdentity`, `RunMember`, `RunSpec`, `RunStatus` | Journal, result reader per run kind, control identity of a transition, interface of a member, run description, state |
| `RunGateInstruction`, `RunPin`, `RunPreparer`, `SignedRun`, `signRun`, `verifyRun` | Signed instructions to members; `RunPreparer` is registered host code, never a shell command |
| `WorkerJournal`, `WorkerKind`, `WorkerList`, `WorkerPin`, `WorkerSpec`, `SignedWorkers`, `verifyWorkers`, `workerCommands`, `abortableSleep` | Journal and types of worker control, admin command `setWorkers`, abortable wait |
| `SpaceLifecycleJournal`, `SpaceAction`, `SpaceLifecycleRequest`, `SpaceLifecycleResult`, `SpaceLifecycleInstruction`, `SignedLifecycle`, `LifecyclePin` | Journal and types of the Space lifecycle |
| `DeploymentState`, `DeploymentConfig`, `DeploymentPlan`, `DeploymentPorts`, `PlanStep` | State and types of the deployment bootstrap |

### `phi-spaces/core`

State functions are host code: they work on a `SpaceState` in the commit and are not reachable through Space RPC.

| Export | Content |
| --- | --- |
| `Target`, `Probe`, `EntryRec`, `TxnRec`, `RegRec`, `WaiterRec`, `SpaceEvent`, `FanoutJob`, `RunGateRec` | Recipient, search result and the records in the Space document |
| `DEFAULT_LEASE_MS`, `MAX_TIMER_MS`, `MAX_LIST`, `CHANGES_OVERHEAD` | 1 h, 2^31 − 1, largest `limit` of the tool `space_list`, 160 bytes of envelope |
| `until(now, ms)`, `deadlineOf(now, timeout)`, `timerDelay(ms)` | Absolute time without overflow, timeout as a deadline, safe `setTimeout` delay |
| `initialState()`, `migrate(v, from)`, `plain(v)`, `previewOf(s)` | Empty state, migration, copy from a draft, detached copy for a dry run |
| `seal(s)`, `beginCommit(s)`, `touch(s, now)`, `maintenanceStep(s, cost, now, cursor)` | Commit budget and revision: finish, begin, note a change, reserve a bounded maintenance step |
| `limitsOf(s)`, `docBytes(s)`, `overheadBytes(s)`, `outboxBytes(s)`, `claimBytes(s)` | Effective limits and byte tallies |
| `gidOf(spaceId, id)`, `view(e, spaceId?)`, `streamIdOf(s)`, `deepEqual(a, b)` | Global ID, entry view, stream ID, deep comparison |
| `settle(s, now)`, `nextExpiry(s)`, `needsMaintenance(s, now)` | Settle what has expired, next expiry, whether maintenance is due |
| `assertNotArchived(s)`, `assertAdminIdle(s)` | Locks for archived Spaces and a running administrative deletion |
| `announce(...)` | Transient write ([`PhiSpaces`](#phispaces)) |
| `createTxn`, `commitTxn`, `abortTxn`, `releaseTxn` | Transactions; `releaseTxn` aborts from the host side if it is still active |
| `addWaiter`, `cancelWaiter`, `parkOperation` | Parked reads/takes; `parkOperation` is the execution state of a blocking RPC |
| `listPage(...)` | Byte-limited page of `list` |
| `importRestoredEntry`, `releaseRestoredEntry`, `fenceGatesForRestore`, `importRestoredGate` | Building blocks of restore |
| `closeRegistrationsForRemoval(s, now)` | Closes registrations when a Space is removed |

### `phi-spaces/store/*`

| Export | Content |
| --- | --- |
| `Ledger`, `memoryLedger()`, `StoredDoc`, `PutDoc`, `CommitSet` | Storage of committed documents and what a commit hands it; `memoryLedger` keeps nothing |
| `StoreStats`, `HOST_CLOSED` | Write figures of the host, message of a closed host |
| `SqliteStoreOptions` | Among others `memoryBudget`, `hotMs` and the synchronicity (FULL is the default) |
| `FORMAT_VERSION`, `DEFAULT_MEMORY_BUDGET` | File format 2 (newer ones are refused, older ones migrated), 40,000 records in memory |
| `openFiles(path)`, `StoreFiles`, `hostOver(files, options)` | Open a file as its owner, host over opened files |
| `Compaction`, `LedgerReplication`, `StoreFaults` | Result of `compact`, what primary/sync does to batches, fault injection for tests |
