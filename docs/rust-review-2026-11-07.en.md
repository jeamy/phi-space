# Review of the Rust port, 2026-11-07

A read of the seven crates for bugs, deviations from the TypeScript reference, duplicated and dead code, and the
hot paths (`docs/rust-portierung.en.md`; the audit of 2026-10-31 is `rust-audit-fixes-2026-10-31.en.md`). Three readers
went through `phi-json`/`phi-core`/`phi-store`, `phi-service`/`phi-wire`/`phi-space-server` and `phi-host`; every
finding below was verified at its lines before it was changed. The differential tests (`cargo test`), the TypeScript
suites on both servers and clippy hold the changes. `phi-store/tests/store_walk.rs`
`historical_claims_answer_after_the_store_is_reopened` holds the headline fix: a request whose key is a historical claim is
refused as `IncarnationChanged` with and without a reopen of the store.

## Fixed

### Bugs

| Where | What went wrong | Fix |
|---|---|---|
| `phi-store/src/host.rs`, `phi-core/src/restore.rs` | The historical claims a restore leaves (`restoredClaims`) were written as rows but never read back after a reopen: the head holds an empty map, and only `rpc.claims` had a disk source. A request whose key is a historical claim was admitted as new after a restart; TypeScript (a `DiskMap` for every on-disk part) answers `IncarnationChanged`. | `Space.restored_disk: Option<DiskClaims>` over the `restoredClaims` rows, opened with the document and adopted at the first commit that writes the map (`DiskClaims::adopt_map`), stamped, settled and rolled back like `rpc.claims`; `restored_claim` and `restored_page` read through it; memory keeps only what the current commit wrote. |
| `src/routing-semantics.ts` | Load and capability placement and the HRW tie-break ordered Member ids with `localeCompare`; the Rust router orders by code units, and ICU collation hangs on a process's data. Ids mixing case placed differently under a TypeScript and a Rust Root. | `byCodeUnits` in TypeScript (as `collectAlerts` already does); `workers.ts` likewise. |
| `phi-core/src/restore.rs` | The claim pager of a restore and a transition compared keys in byte order; TypeScript and `DiskClaims::page` use UTF-16 order, so a persisted cursor meant another position when a restore was handed over mid-way. | UTF-16 order. |
| `phi-store/src/sync.rs` | A journal whose `applied` marker was not a whole number opened as applied 0 or 1; TypeScript refuses ("journal applied position exceeds history"). | Refused alike. |
| `phi-store/src/ledger.rs` | An error of the look for the index mark (busy, I/O) counted as "not indexed" and re-ran the index fill. | The error is propagated. |
| `phi-store/src/store.rs` | A Space the registry names without its opened document committed into the default Space's document. | An error (`Unavailable`). |
| `phi-core/src/state.rs` | A stream log with a gap in its revisions indexed out of range in `record` (TypeScript throws there). | The document is refused on loading ("stream.log revisions are not consecutive"). |
| `phi-core/src/run_gates.rs` | `record_gate` silently skipped a gate without a `history` array, so a replayed command was refused "older than the gate" instead of acknowledged; TypeScript fails there. | A `TypeError`, through `complete_fence`. |
| `phi-core/src/claims.rs` | The sweep panicked on a claim the disk failed to read; the per-principal quota treated `agentId: null` and an absent `agentId` as two principals (`principalId` maps both to `null`); the resolution binding required a non-empty string request id where TypeScript takes any truthy value; `notAdmitted` wrote `"authorityId": null` where TypeScript leaves the key out (different wire bytes). | The sweep skips it (its `take_failure` fails the commit); `null` and absent are one; truthiness; the key left out, in TypeScript's place (second, after `spaceId`; `not_committed.rs` compares the bytes). |
| `phi-core/src/member.rs` | `assert_member_admission` lacked the refusal under a pending administrative deletion (`adminMaintenance`); it is `pub` and `phi-service` calls it directly. | Refused as `MemberDrained`. |
| `phi-core` (`space.rs`, `claims.rs`, `run_gates.rs`, `snapshot.rs`) | The rest of the fence of a pending administrative deletion was missing (found by the port of `data-admin.ts`): `count`, `list`, `read_chain`, `changes`, `renew`, `create_txn`, `issue_generation`, `admit`, `resolve_admission`, `decide_not_committed`, a snapshot page and both run-gate functions served a fenced Space, and `serve` handed out waiting takes; TypeScript refuses each (`assertAdminIdle`). | Each refuses with `PermissionError` at the place TypeScript checks; `serve` returns early. |
| Both servers, run gates | A Member answered every refused run gate instruction with `PermissionDenied`, and the run controller kept every failure of a Member as text: a refusal (a Space without a gated profile, a manifest that leaves it out) was sent again every second until the run was stopped, and the admin command completed with the run still `preparing`. | The Member keeps the class as its code (`runGateRefusal`, `phi-host::run_member::refusal`); a refusal names the Member in `pending.refused`, is not sent again, leaves the run out of the server loop, fails the admin command with the Member and its reason, and the next command replaces it. A lost line is retried as before. `run-controller-driver.ts` scripts refusals, `test-run-instructions` checks the classes on both servers, `test-mixed-member` refuses a start and stops it in all four pairings. |
| `test/test-mixed-member.test.ts` | `setup` removed its directory in the first `after` hook. node runs those hooks in the order they were registered, and one that throws skips the rest: the directory went while the Member and the control host still ran, and when a late write made the removal fail, neither was stopped and the run hung until its timeout (seen once in four runs of the Rust control host with a TypeScript Member). | The directory goes in the last hook of `setup`, and its removal cannot throw. |
| `phi-core/src/space.rs` | With the historical claims on the disk (the fix above), `doc_bytes` counted only the copy in memory; TypeScript's `docBytes` serializes the whole map. | The map is counted from its tally (its JSON is the tally less one, `{}` when empty), without reading the rows. `Space::to_json_read` gives the state with the rows read in; the store walk and the replica tool compare that. |
| `phi-host/src/control_host.rs`, `capability.rs` | `capabilityHeartbeat` checked the grant and the host key only before the commit; TypeScript runs `identity.check` inside it too (a key revoked between the check and the commit still wrote its Capability entry). The sibling `replicaNotice` did it right. | `capability::publish` takes the check and runs it in the commit. |
| `phi-host/src/recovery_rpc.rs` | `1e999` parses to infinity; `recovery_bytes` `expect`ed canonical JSON of the wire call before any signature was checked, so an unauthenticated peer of the recovery endpoint could end the thread. | Refused as an invalid recovery call; the reply key likewise; the client refuses non-finite arguments. |
| `phi-host/src/recovery_rpc.rs` | `run_ssh` left the ssh child unreaped when the read failed or the budget was exceeded, and killed without waiting on a timeout. | The reader thread kills on any failure and always waits; a timeout's kill is reaped by that thread. |
| `phi-host/src/gate.rs` | `unchunked` added an unchecked chunk size (a management-API body with `ffffffffffffffff` overflowed in a debug build); the body read had no bound. | Checked arithmetic; the body is cut at 64 MiB. |
| `phi-host/src/remote.rs` | `RemoteKeys::held` grew with every `(peerId, keyId)` a caller named in a frame and never evicted. | Stale entries (`KEEP_MS`) are dropped on every fetch. |
| `phi-host/src/replica_notice.rs`, `replica_transitions.rs` | A gapped journal file turned a notice lookup or `setStandby` into a panic (`expect("a complete chain")`). | An error naming the missing revision. |
| `phi-wire/src/texts.rs` | The text endpoint's idle timeout covered the 8-byte header only; a peer announcing a body and sending nothing held one of the recovery endpoint's 8 connections forever. | The body read is under the timeout too (as `socket.setTimeout` is in TypeScript). |
| `phi-wire/src/lib.rs` | `route` gave back only the first retired service and dropped the others without `Store::close` (several Spaces of one store routed away, or every routed Space at shutdown). | `route` returns every retired service; the shutdown closes each. |
| `phi-service/src/entry.rs` | Four `sort_by` comparators never answered `Equal`; since Rust 1.81 an inconsistent comparator may panic, reachable from a corrupted state document through a read. | Total orders (`utf16_cmp`; `beats` both ways). |

### Duplicated and dead code

- `phi-host`: `grants.rs` re-matched the algorithm's name (`Algorithm::name`); `recovery_controller::data_role` and
  `delegation::grants_only` had no caller; the file comments of `--member` and `--control` still said entry
  replication, a control host change, `syncSpaces` and the register's ssh line were refused.
- `phi-service`: `entry::KINDS`, `EntryReplication::config`, `rules`, `forget`; `Conn`'s `Default`; `POLL_GAP_MS` was
  `pub` for nothing; `call.get("space").and(space)` was a no-op.
- `phi-wire`: `Owner::with_space`, `TextServer::close`, and two lines after the shutdown's `route` that could never find
  anything.
- `phi-store`: `SyncStoreFile::commit_seq`, `Writer::write`.
- `phi-core`: a no-op `rpc_mut` in `claims.rs`; the module comments of `claims.rs`, `state.rs` and `space.rs` said
  negative claims were refused and that R1 slices 1 to 4 were all that was modelled.

### Hot paths

- `phi-json::utf16_cmp` compares bytes unless a string has a character above the basic plane (every key sort of
  canonical JSON, every digest).
- `phi-service::entry`: `materialize` hashed every event on every read (SHA-256 over canonical JSON); the hash is now
  taken only where a change ID is met twice. `persist_overlay` compared events by serializing both; `deep_equal` now.
- `phi-service`: the merge read compared template
  fields by serializing each; the long-poll's sleep future is made only where it is polled.
- `phi-core::DiskClaims::due` listed keys through `Vec::contains` (quadratic over `limit + held`); a set.
- `phi-store`: the read connection is opened `NO_MUTEX` (one thread uses it).

## Left open, and why

| Where | Finding | Why it stays |
|---|---|---|
| `phi-host/src/root.rs` `open`/`run` | One `tokio::sync::Mutex` guards the whole `FederatedSpace` for the length of a Root call; a `rootTakeWaiting` with an hour's timeout holds every other Root call of every host behind it. TypeScript's `rootCall` awaits each method on a shared object, so calls interleave at every await. | `FederatedSpace` takes `&mut self` through its awaits (the race loop polls Members between journal commits). Letting calls interleave means interior mutability at every await point of a 1,000-line file, held against `federated-driver.ts`; a change of that size needs its own acceptance (`both`, `root-replica` in all pairings), not a line in a review. Until then the Root serializes its calls, which the local federation never saturates. |
| `phi-store/src/host.rs` `commit` | On an op error the host waits for every pending batch to be durable, and a store failure meanwhile replaces the op's error; TypeScript rethrows the op's error at once. | Deliberate: a read inside the failed op may have seen what is not durable, and a failed store is reported by the next call anyway. |
| `phi-core/src/snapshot.rs` | `snapshot_epoch` is constant 0, never the state's `snapshotEpoch`. | `assert_ported` refuses a document with `snapshotEpoch`; the field comes with the port of the snapshot epoch, where a test must force it. |
| `phi-core/src/snapshot.rs` | The owner check is structural; TypeScript compares by reference. | TypeScript is the odd one; no driver passes a fresh owner object. |
| `phi-host/src/delegation.rs` `raise` | The epochs document is committed on every delegated call even when nothing changed. | TypeScript does the same, and the walks compare revisions. |
| `phi-host/src/federation_rpc.rs` | A fresh grant and lease per call, the key proven per call; TypeScript reuses a router lease for 20 s. | The TypeScript Root proves per invoke as well ("each invoke still freshly proves its key"); the lease comes from `retain_lease`, which reads the lease file. A cache belongs with a measurement of the Root under load. |
| `phi-host/src/gate.rs` `grant` | `directory.refresh()` on every grant. | TypeScript's `refreshIdentity` refreshes too. |
| `phi-host/src/sync_space.rs` | `promotion_proof` takes the journal lock blocking where `journal_of` polls with `try_lock`. | The writer releases the journal before the standby's `accept`, so the hold is bounded by `seal`; the two styles should become one when the journal gets an async lock. |
| `phi-store/src/writer.rs` | The waker mutex is held while `wake()` runs; `primary.rs` holds the journal mutex across the marker read on the writer thread. | No waker of ours calls `set_waker`; the second is a bounded SQLite read. |
| `phi-store`, `phi-core` | The primary commit path serializes a batch several times (`delta_bytes`, `deltas`, `copy`, two hashes, `canonical`); `Entries::changed` drops the byte memo on every push; `log_put`, `notify_write` and the waiter paths clone entries that a borrow could serve; `Claims::get` clones the record; `mailboxes_bytes` clones every mailbox; the restore batch clones the snapshot's entries per call. | Each is a measurable, local change on a path the differential walks hold; they go one by one with `space-cost.ts` before and after, not blind. Noted here as the list to work through. |
| `phi-host` | Membership and profile ledgers (`profile_transition.rs`, `membership_control.rs`) each define `hash`, `set`, `empty_operations`, `ops`, `put`, `valid_id` (the two `valid_id` differ: 64 characters and `._-` against 128 and `._:-`, each as its TypeScript counterpart); `ROUTING`/`PROFILES` constants twice; the domain-text helpers (`"{domain}\n{canonical}"`) in seven modules. | Byte-for-byte parity with two TypeScript modules that differ the same way; a shared helper would hide that the limits differ. The sign/verify helpers differ in what they return (`Option`, `expect`, `bool`); folding them is a cleanup without a test to gain. |
| `phi-space-server` | `register_client`, `main_sync` → `SyncSpaceConfig`, the "ms since epoch" clock and the `{ok, result}` reply encoding each written two to four times; three tokio runtimes during a Member's start; the key file read several times at start. | Start-up code; folding it is a cleanup, not a fix. |
| `phi-service` `admit` | The arguments are copied before `admit` (`json_copy`) and cloned again inside. | The copy is JSON's numeric semantics (a non-finite number becomes `null`, as in TypeScript; `tests/overflow.rs`), not a plain clone; a removal broke that and was taken back. Only the inner clone could go. |
| `phi-service/src/entry.rs` `stored`/`Tx::doc` | The cached state document (up to `maxHistoryBytes`) is cloned two or three times per controller step. | Needs the cache to hand out `Rc<Json>` and the draft to work on indices; a change of the controller's shape, after the lazy hash above is measured. |
| `phi-host/src/alerts.rs` | The alert texts of hosts, runs and workers are German ("Zuweisungen nicht abrufbar", "letzter Heartbeat vor … s", "Änderung (Generation …) von Host … noch nicht übernommen", …). | Byte-for-byte parity with `src/alerts.ts`; both change together. |
