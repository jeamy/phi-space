# The wire protocol of the Space service

As of: 2026-10-29 (R0 of the [Rust port](rust-portierung.en.md)). This page describes what a second
Space server must speak so that `RemoteSpace` (`src/remote.ts`) and the projects cannot tell it from the present
one. The code is authoritative: `src/socket.ts` (frames), `src/service.ts` (envelope, rights, methods),
`src/rpc-domain.ts` (argument hash), `src/standalone.ts` (command line).

The vectors in `test/vectors/` show every rule with an example. `test/test-vectors.test.ts` keeps them equal to the
code; `npm run vectors` writes them anew when the contract changes deliberately (then also this page). P-256
signatures that are still valid and the store files stay in place; `npm run vectors -- --store` writes those anew as well,
as does a change of the store schema.

Not described are the federation methods that gate and runtime answer in front of the service (`challenge`,
`prove`, `enroll`, `grant`, `routerLease`, instructions of the control plane). They belong to R5 and R6.

## 1. Command line of the standalone service

```
phi-space-server --store FILE|memory --listen unix:/path.sock|tcp:HOST:PORT [--peer ID]
```

- **Store:** `FILE` is the phi-spaces SQLite store (section 10), `memory` a Space in memory.
- **Peer:** Every connection is the peer `--peer` (default `local`) with the role `member`.
- **Readiness:** As soon as the service serves, it writes exactly one line to stdout:
  `[phi-spaces] ready on <adresse> (store <FILE|memory>)`. With TCP port 0 the assigned port stands there. Tests
  and probe wait for this line.
- **End:** SIGINT and SIGTERM close service and store; after 3 s the process ends in any case.
- **Background:** Expired leases and deadlines are settled at the due time, events delivered
  (`startService` in `src/index.ts`).
- **Other usage:** Without `--store` or `--listen` there is exit code 2 and a usage line on stderr.

## 2. Frames

| Rule | Value |
|---|---|
| Frame | u32 length (big endian), u32 call id (big endian), then `length` bytes of UTF-8 JSON |
| Largest frame | `maxFrameBytes` = 262,144 bytes including the 8 bytes of header |
| Oversized frame | if a frame announces more than `maxFrameBytes − 8` bytes, the server closes the connection without an answer |
| Parallelism | calls of a connection run concurrently; the answer carries the id of its call and can come in another order |
| Calls per connection | at most 32 at once (`maxInflightPerConnection`); above that immediately `{"ok":false,"error":{"code":"ResourceExhausted",…}}` |
| Connections | at most 64; a further one is closed immediately |
| Idle | a connection without traffic is closed after 5 minutes |
| Unix socket | File with mode 0600. An orphaned socket file is replaced (probe: connection refused), a live server or a non-socket file is not. On close the server removes only its own file (same device and inode) |
| TCP | `setNoDelay`; no TLS: the address lies in the overlay behind the gate or on loopback |
| Internal error | if handling throws, the server answers `Internal` with the text `internal error`; details stay in the log |

The client (`socketTransport`) assigns ids from 1, skips 0 at wraparound and closes the connection when a call
exceeds `requestTimeoutMs`. It discards a late answer.

## 3. Envelope

```
Call  = { method, space?, request?: {generation, requestId}, frame?: {authorityId?, primaryEpoch?, grant?, delegation?, claimReceipt?}, args?: {...} }
Reply = { ok: true, result, claimReceipt? } | { ok: false, error: { code, message, requiredBytes? } }
```

**Flow** (`SpaceService.handle`, in this order):

1. The text is longer than `maxFrameBytes`: `ResourceExhausted`. No JSON: `BadRequest`. A lone surrogate in
   a text or key becomes U+FFFD (section 6) before anything sees the call, so also before the argument hash.
2. `method` is missing or no text: `BadRequest`. Unknown method: `UnsupportedMethod`. `args` no object:
   `BadRequest`.
3. **Identity** from the connection, never from the call. None: `Unauthenticated`.
4. **Rate:** at most `maxCallsPerWindow` calls (1024) per peer and window (1000 ms); above that
   `ResourceExhausted` ("the peer exceeded its call rate"). The table holds at most 10,000 peers.
5. **Role** does not allow the method: `PermissionDenied`.
6. **`frame`:** No object: `BadRequest`. Foreign `authorityId`: `AuthorityMismatch`. Other `primaryEpoch`:
   `StaleEpoch`; `resolveOperation` may name an earlier one.
7. **Request duty:** The changing methods `write`, `read`, `take`, `cancelOperation`, `txn` (except
   `action:"status"`), `lease`, `wait`, `notify`, `ack` and `batch` need `request`; without: `BadRequest`.
8. **Space limit:** The call is larger than `maxFrameBytes` of the Space: `ResourceExhausted`.
9. **Answer:** The method runs. If the answer does not fit the frame: `ResourceExhausted`.

**Default Space:** `space` is missing or is `"default"`. An untouched store creates it at the first `hello`.

## 4. Identity, roles and types

Roles (`DEFAULT_POLICY`):

| Role | Methods |
|---|---|
| `admin` | all |
| `host`, `member` | all from `METHODS` |
| `resolution` | `hello`, `pollOperation`, `resolveOperation`, `cancelOperation`, `txn`, `lease` |
| `observer` | `hello`, `generation`, `read`, `pollOperation`, `resolveOperation`, `cancelOperation`, `readAll`, `count`, `stats`, `spaces`, `changes`, `notify`, `events`, `ack` |
| `unpaired` | `hello`, `generation` |

**Types:** A role can be limited to types; supertypes count. With a limit:

- Templates without a type are refused.
- `stats`, `spaces` and `changes` need a role without a type limit.

The principal is `{peerId, agentId?}`. As an owner it appears as `principalId` = `canonicalJson([peerId, agentId ?? null])`,
so `"[\"local\",null]"` (vectors: `crypto.json` → `derived.principalId`).

## 5. Request identity

- **Generation:** `generation` issues one. It admits new request ids for one hour (`generationAdmitMs`).
  Its form is `g<32 hex>.<64 hex>`: nonce, then HMAC-SHA256 with the signing key of the Space over
  `canonicalJson({nonce, ...rec})`. The key is used as UTF-8 text, not as the bytes of its hex form
  (`crypto.json` → `generations`).
- **Request id:** chosen by the client, a non-empty text; only frame and claim storage set a length limit
  (`maxClaimBytes`). With the same generation and the same arguments
  a repetition returns the stored answer (effect exactly once). With other arguments comes
  `RequestConflict`.
- **Stored results** stay for 24 h (`claimResultMs`); after that `ResultExpired`.
- **Argument hash:** `digestJson({method, args})` over the domain form of the call (`src/rpc-domain.ts`). Example:
  `take` with `ifExists:true` is called `takeIfExists`, `txn` is called `txn.begin` and so on. `resolveOperation` compares it,
  delegation and router sign it (`crypto.json` → `derived.argumentHash`).
- **Repetition in the client:** Only a transport failure is repeated, with the same identity (5 attempts,
  backoff 100 ms to 2 s). An `ok:false` answer is an answer and is never repeated.

**Open point:** For `timeoutMs: null` the service inserts the default 0, `rpcDomain` however −1. A
`resolveOperation` with the hash from `rpcDomain` then does not match the stored request. `RemoteSpace` does not send
`null`. Until this is settled, the rule for Rust is: as TypeScript.

## 6. Values

| Value | Form |
|---|---|
| Time | ms since 1970 as a JSON number; `FOREVER` = 9,007,199,254,740,991 (2^53 − 1) means "never" |
| Duration (`leaseMs`, `timeoutMs`, `ms`, `txnLeaseMs`) | integer ≥ 0 or `"forever"`. Missing: lease `ANY` (−1, the Space chooses: 1 h), timeout `NO_WAIT` (0) |
| Template | `null` (everything) or `{type?, fields?, id?}`. `type` also matches supertypes (`types`). A field with `null` is a wildcard. Values compare deeply |
| Entry (answer) | `{id, gid, type, types, fields, owner}`; `types` begins with `type`; `gid` = `<spaceId>/<id>`; `owner` is the principalId |
| Lease | `{id, expires}` |
| Ids | `e`, `t` and `n` with incarnation and running number, e.g. `e0a1b2c3d-4` |
| Stream | `streamId` = `<spaceId>:<incarnation>`, `rev` the revision of the Space |

**Texts are well-formed (R-D10):** A lone surrogate, for instance from a `slice` in the middle of an emoji, reaches the wire only as
an escape like `\ud83d`. The service replaces it by U+FFFD, as `String.prototype.toWellFormed` does
(`wellFormed` in `src/service.ts`). So a store holds only texts that every implementation can hold. This applies
at the entrance of the service; host code using `PhiSpaces` directly must take care of it itself. A store with such a value
is not opened by the Rust store. Projects cut text with `cutText` (`phi-spaces`).

All numbers are IEEE-754 doubles; integers above 2^53 do not occur. Canonical JSON (for hashes and
signatures, never for the wire itself) follows RFC 8785 (`canonical.json`):

- Keys sorted by UTF-16 code units: `😀` before `` before `￿`.
- Numbers in ECMAScript form: `1e+21`, `1e-7`, `100000000000000000000`, `-0` as `0`.
- Non-finite numbers are refused.
- U+2028 and U+007F stay unescaped.
- A lone surrogate is written as `\ud800`. `canonical.json` shows this, but per section 6 it no longer
  occurs; what the service makes of it is stated there under `wellFormed`.

## 7. Methods

`changing` means: needs `request`. The answers can be seen in `wire.json` in one run.

| Method | Arguments | Answer |
|---|---|---|
| `hello` | `protocol: 1` (otherwise `UnsupportedProtocol`) | `{protocol, hostId, spaceId, alias, incarnation, streamId, rev, authorityId, primaryEpoch, role:"single", principal, roles, features, limits, capabilities}` |
| `generation` | — | `{generation, admitUntil}` |
| `write` (changing) | `entry: {type, types?, fields}`, `leaseMs?`, `txn?`, `unique?: [field name]`, `transient?` | Lease. `unique`: conflict → `UniqueConflict` |
| `read` / `take` (changing) | `template`, `timeoutMs?`, `waitMs?` (≤ 25 s, default `maxPollMs`), `txn?`, `ifExists?`, `deadline?` | `{state:"done", entry\|null, locked?}` or `{state:"pending", deadline}` |
| `pollOperation` | `targetRequest: {generation, requestId}`, `waitMs?` | ClaimView `{state, deadline, method, result?, locked?, error?, …}` |
| `resolveOperation` | `targetRequest`, `method`, `argumentHash`, `primaryEpoch` | ClaimView or `{state:"notAdmitted", …}`; wrong hash → `RequestConflict` |
| `cancelOperation` (changing) | `targetRequest` | ClaimView |
| `readAll` | `template`, `maxBytes?`, `limit?`, `cursor?`, `token?`, `txn?`; or `chain: {head?, cursor?, nextField?, limit?, maxBytes?}` | `{items, next, rev, streamId, token?}` |
| `count` | `template`, `txn?` | `{value, rev, streamId}` |
| `stats` | — | Figures of the Space and `process: {cpuMs, rssBytes, heapBytes, at}` |
| `batch` (changing) | `ops`: 1 to 64 steps `begin`, `commit`, `abort`, `write`, `take`, `read`; each step needs the right of its method | one result per step |
| `spaces` | — | `[{spaceId, alias, createdAt}]` |
| `txn` (changing except `status`) | `action: begin` with `leaseMs?`; `commit`, `abort`, `status` with `id` | `begin`: Lease; `{state:"committed"}`, `{state:"aborted"}`, `status`: `{state}` |
| `lease` (changing) | `action: renew` with `id`, `ms`; `cancel` with `id` | `{expires}` or `{state:"cancelled"}`; unknown → `TransactionError` |
| `changes` | `afterRev`, `waitMs?`, `maxBytes?`, `streamId?` | `{streamId, batches:[{rev, at, ops}], next, rev, more}` or `{resync:true, reason, streamId?}` |
| `notify` (changing) | `template`, `leaseMs?`, `txn?`, `handback?`, `consumer?` | `{eventId, lease}` |
| `wait` (changing) | `template`, `timeoutMs?`, `deadline?`, `take?` (default true), `txnLeaseMs?`, `handback?`, `consumer?` | `{id}` |
| `events` | `mailboxEpoch?`, `after?`, `waitMs?`, `maxBytes?`, `consumer?` | `{mailboxEpoch, events:[{seq, at, event}], next, more, gap?}` |
| `ack` (changing) | `mailboxEpoch`, `upTo`, `consumer?` | `{mailboxEpoch, acked}` |

**Long polls** (`pollOperation`, `changes`, `events`, `read`/`take` with `waitMs`):

- They wait at most until `waitMs`, never beyond `maxPollMs` (25 s).
- Without `wakeOnCommit` they look every 50 ms.
- With `wakeOnCommit` they wake at the first commit and after that look at most every 25 ms; after
  1 s at the latest they look even without a commit (for decisions that come without a commit, such as an expired deadline).

**Page budget:** `maxBytes` applies at most up to `frame − 21`, the result budget of an operation up to `frame − 64`.
If the next whole element does not fit, `ResponseBudgetTooSmall` comes with `requiredBytes`. If it is larger than
the frame itself, `ResourceExhausted` comes.

`consumer` must, if given, be the own principal; otherwise `PermissionDenied`.

## 8. Error codes

`code` is contract, `message` free text. `RemoteSpace` turns these codes into own error classes; the others
become `RemoteError`.

| Code | When | Class in the client |
|---|---|---|
| `BadRequest` | Form of the arguments, invalid values | `IllegalArgumentError` |
| `Unauthenticated` | Connection without identity | `RemoteError` |
| `PermissionDenied` | Role or type limit | `PermissionError` |
| `UnsupportedMethod` / `UnsupportedProtocol` | unknown method, other `protocol` | `RemoteError` |
| `UnknownSpace` | `space` unknown | `RemoteError` |
| `AuthorityMismatch` / `StaleEpoch` | `frame` does not match | `RemoteError` |
| `RequestConflict` | Request id with other arguments, wrong argument hash | `RequestConflict` |
| `RequestExpired` | Generation unknown, foreign, expired or wrongly signed | `RequestExpired` |
| `ResultExpired` | stored result expired | `ResultExpired` |
| `IncarnationChanged` / `NotCommitted` | Request of an earlier incarnation or epoch | of the same name |
| `OperationCancelled` | Operation cancelled | `OperationCancelled` |
| `ResourceExhausted` | a limit (frame, commit, rate, pending, memory) | `ResourceExhausted` |
| `ResponseBudgetTooSmall` | Page too small for the next element; `requiredBytes` | `ResponseBudgetTooSmall` |
| `SnapshotExpired` / `RevisionAhead` | Page token expired, revision ahead | of the same name |
| `TransactionError` | Transaction or lease unknown or not active | `TransactionError` |
| `CompletionViolation` | Completion profile violated | `CompletionViolation` |
| `UniqueConflict` | `unique` finds another entry | `UniqueConflict` |
| `MailboxEpochMismatch` / `InvalidAck` | Mailbox epoch, ACK above the position | of the same name |
| `CommitSealed` | primary/sync: commit sealed, not confirmed; keep polling the request | `CommitSealedPending` |
| `MergeTypeNotExclusive` | exclusive operation on a merge type | of the same name |
| `ReplicaConfigPending` / `StalePolicyVersion` / `RoutingConflict` / `MemberDrained` / `MigrationRequired` / `ProofRequired` | Federation (R6) | |
| `Internal` | everything else; text always `internal error` | `RemoteError` |

## 9. Limits

`DEFAULT_LIMITS` in `src/core.ts`, a Space can have its own (`hello` → `limits`):

| Limit | Value |
|---|---|
| `maxFrameBytes` | 262,144 |
| `maxEntryBytes` | 65,536 |
| `maxCommitBytes` | 196,608 |
| `maxEventBytes` | 163,840 |
| `maxTypeChars` / `maxTypes` | 128 / 16 |
| `maxRegsPerOwner`, `maxWaitersPerOwner`, `maxTxnsPerOwner` | 20 each |
| `maxSpaceBytes` | 64 MiB |
| `claimResultMs` / `generationAdmitMs` | 24 h / 1 h |
| `maxPollMs` (service) | 25,000 |
| `maxPendingPerPrincipal` / `maxPendingPerPeer` (service) | 32 / 128 |

## 10. Store file

The phi-spaces store (`src/store/sqlite.ts`) has these tables, all `STRICT`:

- `store_meta(key, value)` with `format_version` (currently 2), `store_id` and `commit_seq`.
- `documents(kind, key, version, value)`: one document per row, `value` is JSON text, `key` `""` for documents
  without a key.
- `parts(kind, key, part, id, ord, value, at, grp, flag)`: one record of a part per row.

In addition there are the indexes `parts_order`, `parts_at`, `parts_grp` and `parts_open`, WAL mode and a lock file
`<datei>.owner` with an exclusive lock while the store is open.

A file with tables but without `store_meta` is refused, as is one with a higher format number.
`store.sql` is such a file as SQL; `store.expected.json` shows what reading answers.

## 11. Vectors and replay

| File | Content |
|---|---|
| `canonical.json` | Inputs as JSON text with canonical form, SHA-256, `jsonBytes` and `JSON.stringify` text; numbers by bit pattern; a lone surrogate |
| `crypto.json` | Generations, proof and grant with Ed25519 (deterministic) and P-256 (random, verify only), test keys from fixed secrets, fingerprints, token hashes, argument hashes |
| `wire.json` | a session against `SpaceService.handleText`: peer `local`/`member`, clock fixed from `t0` and moved by the script, no background service |
| `store.sql` / `store.expected.json` | a store file after such a session and the answers of a reading session (clock `t0 + 5000`) |

**Replaced random values:** `wire.json` holds placeholders `<hostN>`, `<spaceN>`, `<incarnationN>`, `<generationN>`
and `<mailboxN>`, numbered by first occurrence. Each first appears in an answer. A replayer learns
the real value from this answer and inserts it into the following calls. `stats.process` becomes `"<process>"`.

**Comparison for a second implementation:** Answer by answer after the replacement, without `error.message`. For this
its server must let the clock be set from outside (R3: `--test-hooks`).
