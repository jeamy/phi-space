# Review of the TypeScript implementation (2026-11-01)

A read-through of `src/` and `agent/src/` looking for logic errors, dead code, duplicate code and optimization
opportunities, with the same criteria as the Rust review (`review-rust-2026-11-01.en.md`). Everything below was verified in
the code; nothing was changed. Byte-exact behaviour that the Rust port pins as a contract is not listed.

**Status:** `erledigt:` fixed (section 1 in f5a553d). `offen (...)`: still open, with the reason. `S-Dn`: the decisions
of section 9 in [rust-portierung.en.md](rust-portierung.en.md), security and federation.

## 1. Logic errors (ranked)

### Change behaviour today

- erledigt: **`resolutionGrant` is instance state shared by concurrent calls.** `src/service.ts:172,241,250`: assigned before
  `await this.dispatch(...)` and read after it. Two calls with different identities on one `SpaceService` interleave at
  that await, so the type check of a retained result can use another principal's `resolveOperation` grant. Make it a local.
- erledigt: **`rpc-domain.ts` drifts from the domains the client admits with.** `write` (`src/rpc-domain.ts:15`) drops `transient`,
  which `src/client.ts:156` includes; `batch` falls to the default branch while the client admits `core.plain(ops)` with
  `lease` (`src/client.ts:185`). `service.ts:249` then resolves with the wrong hash, gets `RequestConflict`, swallows it at
  `:254`, and no `claimReceipt` appears for `write {transient}` or any `batch`; the Router falls back to the legacy
  resolution path. `delegation.ts:234/326` sign the same divergent hash. No test covers batch or transient with a receipt.
- erledigt: **The admin deletion fence spins the reaper.** `core.settle` returns at once under `adminMaintenance`
  (`src/core.ts:509`) but `nextExpiry`/`needsMaintenance` (`:1081-1115`) have no such guard. `PhiSpaces.maintain()`
  (`src/client.ts:545-555`) sees `more` with an unchanged signature and throws `ResourceExhausted` for every mutation,
  masking `MemberDrained`; the reaper (`src/index.ts:232-237`) arms a 1 ms timer and commits every millisecond for the
  whole deletion. One expired entry is enough. No erasure test starts the maintenance loop.
- erledigt (S-D1): **A signed `recover` instruction can be replayed.** `RunGateInstruction` (`src/run-member.ts:15`) has no issuedAt,
  expiresAt or nonce; `verifyRun` checks issuer and signature only. `recoverRunGate` (`src/core.ts:1454-1458`) fences the
  gate whenever the recoveryId differs from the current one, so a captured `kind:"recover"` re-delivered by any proven
  router, host or admin peer wedges the run; the controller's reconcile hits the commandId dedupe and issues no new recovery.
  The Rust port (`rust/phi-host/src/run_member.rs`) carries the same shape. Fixing it changes the instruction contract.
- erledigt (S-D6, the retry stays unbounded by decision): **Async supervisor commands produce no audit event.** `src/supervisor.ts:101` returns before `onEvent` at `:102`, and
  `resumeJobs` never calls it, so addMember, drain, removeMember, startRun, setWorkers, createSpace and deployment leave no
  trace, contrary to the option doc at `:35`. `src/supervisor.ts:110` `catch{continue;}` swallows every handler exception
  and retries the job every second forever, without a log.
- erledigt: **A transient standby refusal at host start leaves a primary/sync Space unserved.** `src/sync-spaces.ts:116` throws on
  `PrimarySyncBlocked`; `src/replica-transport.ts:32` wraps every standby-side error, including an unreachable standby
  register, in exactly that type. The Space is listed as `failed`, `configured-runtime.ts:144` only logs it and attaches no
  resolver, whereas the same condition at runtime goes through `resolve()` with backoff.
- erledigt: **A cancelled agent request is stored as the job's final error.** `agent/src/durable-worker.ts:235-241` writes
  `job.error` also for the caller's abort; `run()` (`:183`) returns the saved error for every later run of the same
  `(session, requestId)`. codemode-chat uses `requestId: call.callId` (`codemode-chat/server/durable-agent.ts:34`), so an
  aborted call can never be retried under its id. spaces-mmo uses random ids and is unaffected.
- erledigt: **`awaitWork` leaks one abort listener per call.** `src/space-client.ts:73` adds an `abort` listener that is never
  removed when the read wins. codemode-chat (`model-host.ts:151`, `exec.ts:39`) and spaces-mmo (`engine/handover.ts:111`)
  call it in every idle wait with a process-lifetime signal.

### Transport and store

- erledigt: `src/ws.ts:127` only marks `closed` on `end`; nothing ends the socket, and `stop()`/`close()` return early once `closed`.
  Behind `http.createServer` (allowHalfOpen) a client FIN leaves the TCP socket until the peer resets.
- erledigt: `src/socket.ts:89,93` ignores `socket.write()`'s return and never pauses `data`; a peer flooding frames beyond
  `maxInflight` without reading gets unbounded `writableLength`. `ws.ts:58` caps this, the socket server does not.
- erledigt: `src/store/sqlite.ts:323-331` `#fail` never `unref()`s the worker that `#send` ref'd; after a failed batch the worker keeps
  the process alive until `close()`. `sqlite.ts:448` `hostOver` awaits only the first `message`; a worker `error` before
  "opened" hangs `openSqliteHost`.
- erledigt: `src/socket.ts:192` `nextId++ >>> 0 || nextId++` throws past 2^32; `:96` logs a refused peer as "internal error".

### Core and client

- erledigt: `PermissionDenied` claim errors surface locally as `TransactionError` (`src/client.ts:534` checks only
  `CompletionViolation`).
- offen (kein Aufrufer in Produktion, Vertragsfläche für den Rust-Port; gehört zum Totcode-Abschnitt): `listPage`'s cursor is the trailing number of the id (`src/core.ts:1166-1190`); `beginRestore` resets `nextId` while
  imported entries keep their numbers, so pages after a restore skip entries. No production caller.
- erledigt: Delivery swallows the real failure (`src/index.ts:112-114`); `onError` only ever sees the synthetic "gave up" message.
- offen (eine Prüfung in `setLimits` lehnt gültige Konfigurationen ab, kleine `maxCommitBytes` mit Standard-`maxEventBytes`; der Fehler braucht eine Prüfung gegen die tatsächlichen Ereignisse): `setLimits` (`src/core.ts:246-267`) does not keep `maxEventBytes + overhead` or the registration lapse cost within
  `maxCommitBytes`; a misconfiguration defers forever and spins the reaper as above.
- erledigt: A claim already `resultExpired` but within `claimResultMs` is neither eligible nor counted into the next sweep
  (`src/claims.ts:211-217`), so `sweepAt` can park at `MAX_SAFE_INTEGER` until another `dueAt` lowers it.

### Security and federation

- erledigt (S-D5; the audit event `failed` now carries the error's name): `enroll` maps any non-`EnrollError` (commit failure, `BootBlocked`) to the generic "enrollment refused" and skips the audit
  event (`src/enroll.ts:242-243`); `rotation.ts:96` likewise maps `IllegalArgumentError` to `PermissionDenied`.
- erledigt (S-D7): `src/runtime.ts:209` `runs.advance(id).catch(()=>{})` drops every error.
- offen, decided S-D2 (always the alias; TS and Rust together with the next R6a slice): Grant scope is matched against the raw `call.space` for direct calls (`src/grants.ts:60-63`) but against the alias for
  delegated calls (`delegation.ts:415`); deny-direction only, but inconsistent.
- offen, decided S-D3 (`createEnroll` without `scope` is refused; TS and Rust together): `key.scope` defaults to `[]` (`grants.ts:31`, `enroll.ts:106`), so a key enrolled without scope passes no space and no error
  says why.
- offen, decided S-D4 (one default exported from `gate.ts`, with the deployment's `["member","host","router"]`): Two defaults for the same group: `DEFAULT_GROUP_ROLES` maps `space-hosts → ["member"]` (`gate.ts:93`), the deployed default
  `["member","host","router"]` (`configured-runtime.ts:316`).
- erledigt (S-D8): `src/delegation.ts:322` `(await snapshotSpace(...))!` on a Space deleted between `listSpaces` and here yields a TypeError.
- erledigt: `src/replica-control.ts:49` throw is unreachable (the loop rethrows at attempt 7); `src/alerts.ts:48-58` two overlapping
  passes race on `known`; `agent/src/durable-worker.ts:251-269` treats any unknown IPC message as `run`;
  `agent/src/durable-client.ts:72-76` dispatches every message twice.
- Checked and found sound: writer ordering and ack after COMMIT, seal-before-write, crash/reopen, owner lock, draft rollback,
  RemoteSpace retries, FrameReader partial frames, challenge TTL and single use, enroll ordering, revoke ordering, grant
  timestamps and scope, delegation binding chain, journal idempotence, replica transport nonce/timestamp/bodyHash, erasure
  precedence, fencing fail-closed. No secret is compared with `===`.
- Recorded as contracts, not changed (S-D9 to S-D11): a revoked key works on an open connection until the next
  revalidation (15 s; the grant TTL of 60 s is the bound); the one-attempt-per-minute enrollment limit is per process, the
  durable bound is the `attempts` counter; a `commandId` is deduplicated for `RESULT_RETENTION_MS` (7 days).

## 2. Dead code

- teilweise (`snapshot(entry)` und `Snapshot` entfernt; `once` hat noch einen Integrationstest): JavaSpaces-compat shims: `PhiSpaces.snapshot(entry)` and type `Snapshot` (`src/client.ts:386,29`, no caller);
  `OpOptions.once`/`Once` (`client.ts:28,36,446-455`, one integration test), superseded by `request` claims.
- `core.listPage` (`src/core.ts:1175`): no production caller (`readPage` uses `snapshotPage`); the client doc comments at
  `client.ts:74,338` still name it. It is core-driver contract surface for the Rust port.
- teilweise (`frameFraction`, `privilegedRoles` entfernt; `JsonValue` und `why`s `now` werden doch gebraucht, der `mode`-Parameter offen): Declared, never read: `RemoteOptions.frameFraction` (`src/remote.ts:85`), `JsonValue` (`src/store/types.ts:7`),
  `privilegedRoles` (`gate.ts:103`, `auth.ts:108`, no caller passes it), `why(s, now)`'s `now` (`space-lifecycle.ts:30`),
  the `mode` parameter of `FencingAdapter.release` (dropped by both adapters).
- Unreachable: `src/core.ts:786` (both callers check first), `src/ws.ts:88` (the data handler rejects earlier),
  `src/store/sqlite.ts:231` (the fallback never runs and would redo the ord bookkeeping without `undo`),
  `src/index.ts:189` `watchOf` default-Space fallback.
- Stale from the earlier plan stage: `unconfiguredFencing` (`src/replica-control.ts:33-36`, one test);
  `allowFutureModes` (`routing-semantics.ts:117`) passed only by tests; `sealedCandidateOf` aliased twice.
- Test-only helpers in production code: `createEnroll`/`writeEnroll` (`enroll.ts:91-138`), `revokePeerKey` (`:185`),
  `router.ingest` (`router.ts:300`).
- erledigt: Exported but imported nowhere (the `export` is the dead part): `gidOf`, `MAX_TIMER_MS`, `WAKE_DEBOUNCE_MS`, `COUNTERS`,
  `newIncarnation`, `HOST_CLOSED`, `memoryLedger`, `memoryFenceState`; `enroll.ts` `ATTEMPT_INTERVAL_MS`,
  `MAX_FAILED_ATTEMPTS`, `validateCreateEnroll`, `EnrollError`, `EnrollOutcome`, `CreateEnrollOptions`; `delegation.ts`
  `DelegationEpochs`, `ROUTER_CHANGE_SKEW_MS`; `router.ts` `RouterCommitHook`; `runtime.ts` `UnresolvedSyncSpace`;
  `configured-runtime.ts` `SyncSpaceFactories`; `run-member.ts` `verifyRun`; `workers.ts` `verifyWorkers`;
  `supervisor.ts` `COMMAND_KINDS`/`CommandKind` (re-exported by `index.ts`, consulted nowhere); `primary-sync.ts`
  `validateConfigTransition`, `SyncDelta`; `entry-replication.ts` `EntryReplicaPeers`, `EntryPeerVectors`,
  `EntryVersionVector`, `EntryCompactionStatus`, `ENTRY_EXPIRY_GRACE_MS`, `RedactedMutation`; `dashboard.ts` `sumStats`,
  `DEFAULT_APPS`, `ALL_SPACES` and its option types; `data-admin.ts` `DataAdminJournal`.
- teilweise (`rotation.ts` importiert statisch; `sweepCursor`, die Altzustand-Suche und `migrate` bleiben wegen gespeicherter Zustände): Compat shims that still run: `delete st.sweepCursor` (`claims.ts:227`), the O(claims) scan for pre-key states
  (`core.ts:968`), `migrate(v, _from)` ignoring `_from`; `rotation.ts:73,75` `await import("./spaces.ts")` twice although
  `spaceDoc` is statically imported.
- teilweise (`store/cold.ts` und `gate.ts` korrigiert, `supervisor.ts:4` offen): Stale comments: `types.ts:21` and `claims.ts:202` refer to `store/cold.ts` (now `disk-map.ts`); `gate.ts:12-13` "Not here
  yet: layer B and the grants"; `supervisor.ts:4` "first part".

## 3. Duplicate code

- teilweise (`signedBy`, `signatureOf` und `publicKeyObject` ersetzen die Prüfung in Run, Lifecycle, Workers, Membership und Delegation sowie das SPKI-Präfix; die Policy, der Router-Lease und die Replikations-Helfer sind offen): **Signed envelopes.** Seven verifiers of the shape `{value,issuer,algorithm,signature}` plus pin: `verifyRun`,
  `verifyLifecycle`, `verifyWorkers`, `verifyMembership`, `verifyFederationPolicy`, `DelegationVerifier.supervisor`, and
  `federation-controller.ts:60-63` with the router-lease domain inline. Eight matching sign helpers. Five more detached-signature
  helpers in replication: `replica-transport.ts:18-22`, `replica-notice.ts`, `control-host-change.ts`, `recovery.ts`,
  `recovery-service.ts`. The signature primitive itself twice: `auth.ts:288-307` and `grants.ts:74-76`, both with the SPKI
  prefix as a literal.
- teilweise (`batch` hat mit `batchStep` eine einzige Abbildung, und ein Test verlangt für jede mutierende Methode einen Receipt, sodass Abweichungen auffallen; `write`, `read`, `txn` und `lease` bleiben von Hand): `rpc-domain.ts` mirrors `dispatch`'s argument mapping by hand (`service.ts:162` vs `rpc-domain.ts:328` `duration`), which
  is how the drift in section 1 happened. One table of "wire args → admission args" used by both.
- Alias → document resolution three times (`client.ts:110-127`, `index.ts:178-191`, `spaces.ts:527-532`); `snap()` and
  `watch()` snapshot the Registry twice each. (erledigt: `findControlSpace`) "Find the control space id by alias" seven times (`enroll.ts:67,178,330`,
  `supervisor.ts:50,167`, `runtime.ts:183,186`).
- teilweise (`client.ts` nutzt `principalId`, die Formprüfung läuft in drei Dateien über `validPrincipal`; `samePrincipal`, die `canonicalJson(consumer)`-Stellen im Kern und die strengere Prüfung in `entry-replication.ts` bleiben, weil sie Extra-Felder oder Zeichen anders behandeln): Principal keying four ways: `canonicalPrincipal` (`client.ts:559`), `principalId` (`mailbox.ts:122`), `samePrincipal`
  (`claims.ts:73`), `canonicalJson(consumer)` in `core.ts:369,705`. Principal shape validation four times (`data-admin.ts:33`,
  `distributed-erasure.ts:30`, `root-erasure.ts:21`, `entry-replication.ts:130`).
- erledigt: Role derivation: `gate.ts:94` `rolesOf` (dedupe, sort) vs inline `groups.flatMap(...)` in `configured-runtime.ts:348,424`
  and `configured-root.ts:544`, which neither dedupe nor sort.
- teilweise (`proven` und `isHost` ersetzen die Kopien; die abweichenden Rollenmengen und Fehlercodes bleiben absichtlich): `runtime.ts:119-151`: five copies of "authenticate + proof + keys.find + active + role check" with divergent role sets and
  error codes.
- The placement rule three times: `member-admission.ts:62-76`, `membership.ts:451-463`, `routing-semantics.ts:289-301`;
  `membership.ts:433-448` and `:480-495` build the policy with stock rules twice verbatim.
- `announce` and `write` repeat the type/fields/limits validation (`core.ts:625-635` vs `:648-658`); `service.ts:312-318`
  vs `:384-391` for `write` and the batch step. The `registrationClosed` literal four times; the miss/locked decision four
  times.
- teilweise (`openEnroll` und `signedChallenge` erledigt; Revoke-a-PeerKey bleibt, die drei Stellen schreiben verschieden): `EnrollRec` built three times (`enroll.ts:106,134,160`); revoke-a-PeerKey three times (`enroll.ts:116,190`,
  `rotation.ts:40`). `remote.ts:256-260` vs `:278-282` challenge fetch and signing copied between `authenticate()` and
  `enroll()`.
- teilweise (`releaseLock` erledigt, `partAt` und `isDiskMap` offen): Store: `host.ts:261` re-implements `partAt` inline while it is imported at `:12`; the owner-lock release
  (`ROLLBACK` + `close()`) four times (`sqlite.ts:366,374`, `sync-sqlite.ts:109`, `erasure-own.ts:29`);
  `disk-map.ts:161` `isDiskMap` equals `diskMapOf(v) !== undefined`.
- Replication: boot-permit-matches-config in `replica-notice.ts:52` and `replica-control.ts:81`; the "install the external
  permit if it differs" CAS three times; `latestReplicaConfigNotice` scans the chain twice; fence state files twice
  (`netcup-fencing.ts:59-67`, `container-fencing.ts:47-86`); `recovery-controller.ts` and `control-recovery.ts` share the
  job snapshot, restore loop and per-key CAS; `deployment.ts:159-160` validates twice.
- Three copy semantics for one job: `jsonCopy`, `core.plain`, `structuredClone`; `same` as canonical equality in
  `delegation.ts:58` and as digest equality in `routing-semantics.ts:252`; `federation-rpc.ts:154,207-213` the same error
  class list twice.

## 4. Optimization opportunities that matter

- **Per-write repeated serialization** (`src/core.ts:644-697`): one write clones or stringifies `fields` about six times
  and walks the registrations four times (`checkEventSize`, `publishCost`, `preflightFanout`, `notifyWrite`), each
  re-stringifying every handback. `overheadBytes` (`:271`) stringifies waiters, regs, txns, jobs, run gates and mailboxes on
  every write; `reserve` (`:424`) stringifies `s.jobs` (up to 16 MiB) on every write and transactional take.
- **The expiry watermark never survives a commit on the own store.** `expiryWatermarks` is keyed by the state object
  (`core.ts:560`), but every commit works on a fresh draft proxy (`store/draft.ts:257`, `store/host.ts:215`), so the first
  `expire()`/`nextExpiry()` of every commit does the full scan the watermark was meant to avoid. Keying it by
  `committedArray(s.entries)`, as `entrySums`/`typeBuckets` do (`:278,472`), makes it effective.
- `serve` is O(waiters × entries) per write, commit, abort and settle (`core.ts:920-978`); inside a commit the entries
  array is a copy and has no type bucket.
- `changes` stringifies the whole log suffix twice (`core.ts:1243-1248`, `stream.ts:96`, `paging.ts:288`) and skips
  linearly although revisions are consecutive; `snapshotPage` serializes a large result three times (`snapshot.ts:245-271`).
- Named spaces: every `readAll`/`count`/`stats`/`pollOperation` takes three snapshots (`client.ts:111-120`);
  `pollOperation` is polled every 50 ms per waiting call.
- **A delegated call on a Member** costs `listSpaces`, `snapshotSpace`, two remote `keyLookup`s, a remote `routingPolicy`
  with signature check and a commit (`delegation.ts:298-455`); under the boot guard each snapshot costs two register reads
  and each commit at least two. A per-connection memo bounded by the grant TTL (60 s, already the revocation bound) would
  remove most of it. `gate.ts:208-219` `revalidate` calls `keys.find` per connection every 15 s although `findMany`
  exists; `supervisor.ts:109` opens a write commit per pending job per second to read `hasAdminKey`;
  `auth.ts:136-151` re-parses every reply to maybe rewrite one error code.
- Replication: two full-table SUM scans per primary commit (`primary-sync.ts:156,121` via `sync-sqlite.ts:160`); the
  previous intent is parsed per commit for one hash (`sync-sqlite.ts:171`); entry replication materializes the whole
  history per write (`entry-replication.ts:259-274`, hashing every event and loading every chunk); the replica notice
  scan walks the journal backwards every heartbeat and publishes a control commit even when unchanged
  (`replica-notice.ts:102-140`); journal open re-validates every intent and keeps one config copy per revision
  (`primary-sync.ts:111`); `setStandby` retries replay from revision 1 (`replica-control.ts:268-273`).
- Store and transport: `remote.ts:155` encodes every call into a byte copy just to measure it (`Buffer.byteLength` is used at
  `:240`); `mutate` and `send` deep-copy the args twice; `sqlite.ts:125,131` re-prepares statements on every cache miss;
  the replicated store serializes each batch three to four times (`sync-sqlite.ts:158,173`, `sqlite.ts:249`);
  `socket.ts:25` `Buffer.concat` per chunk and two copies per reply body; `disk-map.ts:53` `has` parses and freezes a
  record to test presence; `host.ts:248` loads a whole document to test existence.
- Smaller: `finish` splices inside the loop (`core.ts:995`); `refreshReservations` recomputes `publishCost` per entry per
  subscription; `restore.ts:156,171` and `member-transition.ts:345-364` stringify all entries per claim; `membership.ts:190`
  shallow-copies the state per entry; `configured-runtime.ts:418` builds a `CapabilityDirectory` per Space per heartbeat and
  passes a host id as a peer id.

## 5. Suggested order

1. `resolutionGrant` as a local; one wire-to-domain table for `service.ts`, `rpc-domain.ts` and `client.ts`, with a test for
   batch and transient receipts.
2. The admin fence in `nextExpiry`/`needsMaintenance`, and `maintain()` distinguishing "fenced" from "cannot fit".
3. Audit and logging in the supervisor, `enroll` and the run loop.
4. The sync-spaces start path treating a standby refusal like the runtime does; the agent worker not persisting aborts.
5. `awaitWork` listener, `ws.ts` half-close, socket backpressure.
6. The `recover` replay: nonce or expiry in `RunGateInstruction`, in TS and Rust together.
7. The shared helpers (envelope, role derivation, control-space id, principal key) and the watermark key.
