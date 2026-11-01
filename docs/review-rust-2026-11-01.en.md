# Review of the Rust port (2026-11-01)

A read-through of `rust/` (phi-json, phi-core, phi-store, phi-service, phi-wire, phi-host, phi-space-server) against the
TypeScript reference in `src/`, looking for logic errors, dead code, duplicate code and optimization opportunities.
`cargo clippy --all-targets` is clean; everything below was found by reading and verified in the code. Nothing was changed.

**Status:** ✅ fixed. ➖ decided against, with the reason. Unmarked: still open.
The companion document for the TypeScript side is `review-typescript-2026-11-01.en.md`.

The differential walks and byte-exact comparisons hold the port on the paths they cover. The deviations below sit outside
them: profile constants, store error paths, fields the walks never set, and the order of checks in the gate.

## 1. Logic errors and deviations (ranked)

### Change production behaviour today

- ✅ **mmo profile serves with the default inflight limit.** `rust/phi-space-server/src/profiles.rs:226` builds
  `ServeOptions::new(listen, peer)` and never sets `max_inflight_per_connection`, so the default 32 applies
  (`rust/phi-wire/src/lib.rs:135`). TS sets 1024 (`spaces-mmo/server/space-host.ts:50`). Under load the Rust world Space
  answers the 33rd concurrent call on a connection with `ResourceExhausted`. The other service numbers match.
- ✅ **Notice methods are answered before `Control::check`.** `rust/phi-host/src/gate.rs:560-583` handles `epochNotice`,
  `membershipInstruction`, `runGateInstruction` and `spaceLifecycleInstruction` before the control-space check at line 592.
  In TS the notice service sits inside `ControlAccess`, so these methods naming the control space are refused for everyone
  (`src/supervisor.ts:190`). On a Rust control host a proven router can raise the epochs of the control Space.
- ✅ **Rotation always issues A-only grants after a recovery.** `rust/phi-host/src/rotation.rs:101` hard-codes
  `allow_a_only: None`. TS reads the register (`access:{authorityId}` → `aOnlyAllowed`) and the restore kind
  (`src/configured-runtime.ts:119`). The refusing branch in `grants.rs:51-55` is reachable only from `tests/grants.rs`.
  *The control host takes it from the register at its start: a recovery writes the policy under the new authority before that authority runs. The `restore.kind` fallback stays out: this core refuses to open a Space under a restore, so it becomes reachable with R6b.*

### Store

- ✅ **Store failure is tracked per host, not per store.** `rust/phi-store/src/host.rs:46` keeps `failure` per `SpaceHost`.
  After a failed batch of Space A, Space B on the same writer still runs `start_commit`, advances its state in memory and
  hands rows over that only fail when B pumps later. TS `OwnStoreHost.#failure` (`src/store/host.ts:119`) is one flag for
  all documents. A store-level flag, or checking the writer's sticky `failed` in `start_commit`, closes it.
- ✅ **The claims reader panics on any SQLite error.** `rust/phi-store/src/disk.rs:26-57` uses only `expect`/`unwrap`.
  `SQLITE_BUSY` after the busy timeout, an I/O error or one unparsable row aborts the whole process; TS throws and the
  one call gets an error reply. `ClaimSource` needs a fallible shape, or the source must map errors to a host failure.
  *The source notes the failure, and `start_commit` rolls back and fails that one call, as TS does.*
- ✅ **Deleted Spaces get a host at open.** `rust/phi-store/src/store.rs:69-72` opens a `SpaceHost` for every registry entry
  except the default, including those with `deletedAt` (`named_ids()` filters them, `open` does not). Each loads its whole
  document and opens its own claims connection for the process lifetime. TS evicts untouched documents.
  *A snapshot read of a deleted Space opens it on demand.*
- ➖ `create_space_with` registers the default Space in a commit of its own before the one that creates the named Space
  (`store.rs:218-222`); TS does both in one commit. Also the alias is looked up before it is validated.
  *Alias order fixed. The separate commit stays: a crash or a failing `op` between them leaves a registered default Space, which is what any first commit makes, so nothing a caller sees differs.*
- ✅ After a sticky `failed`, `Msg::Compact` still runs `VACUUM` on the failed connection (`writer.rs:886-889`), and
  `Store::compact_begin` bypasses the host's failure check.
- ✅ `close()` rolls the owner lock back before the claims read connection is dropped (`host.rs:394-402`); harmless for WAL.
- ✅ In `start_commit` a failing trailing `pump()` returns `Err` although the commit was handed over (`host.rs:156`).

### Core

- ✅ **`issue_generation` ignores `state.primaryEpoch`.** `rust/phi-core/src/claims.rs:117` falls back to 1; TS falls back to
  `s.primaryEpoch ?? 1` (`src/claims.ts:92`). `resolve_admission` (`claims.rs:377`) also drops the
  `s.primaryEpoch !== primaryEpoch` check of `src/claims.ts:230`. The walks never set `primaryEpoch`; phi-service passes it
  explicitly, the driver does not.
- ✅ **`read_chain` refuses a `maxBytes` TS clamps.** `space.rs:2185-2190` checks the safe integer before clamping to the frame,
  TS clamps first (`src/read-chain.ts:11-13`). `maxBytes: 1e16` is valid in TS, an error in Rust. `snapshot.rs:87-91` does it
  the TS way.
- ✅ **Non-finite numbers panic the core.** `.expect("finite")` on canonical JSON of caller values: `claims.rs:89` (`key_of`),
  `claims.rs:36`, `mailbox.rs:22`, `space.rs:747` and `:1752`. The service validates these as strings before the core sees
  them, so it is not reachable over the wire today; the core itself is not total. `member.rs:25` `hrw` swallows the same
  failure with `unwrap_or_default()` and routes silently to the first member.
  *`Json::key_text` for keys; `hrw` now refuses.*
- ➖ `phi-json` `MAX_DEPTH = 512` applies to stored values too; TS has no limit for host-written documents.
  *Kept: parsing is recursive, the limit is what protects the stack. No document written through the service reaches it.*
- ➖ NaN edge cases unreachable with validated inputs: `member.rs:181-186`, `policy.rs:167`, `claims.rs:214`.
  *Kept: unreachable with validated inputs, as the finding says.*

### Host

- ✅ **`revalidate` leaves `busy` set** if its future is dropped mid-await (`gate.rs:331-357`); every later revalidation,
  including the periodic loop, silently returns 0. TS uses `try/finally`. Only the test hook drops it.
- ➖ `holds()` omits TS `why()`'s last check `restore.stage !== "completed"` (`space_lifecycle.rs:55-78`).
  *No change: this core refuses to open a Space with `restore` (`assert_ported`). Belongs to the R6b port.*
- ➖ Membership `apply` never calls the equivalent of `assertAdminIdle` (`membership.rs:361-383`); `adminMaintenance` is unknown
  to the workspace.
  *No change: `assert_ported` refuses `adminMaintenance` at open, so the state cannot occur. Belongs to the port of the data admin.*
- ✅ `delegation.rs:236` `args.as_object().expect("an object")` on wire input in a `pub fn`; safe only because the service
  rejects non-object args first.
- ➖ Stricter than TS, for the record: `grant` refuses when the overlay address maps to another peer (`gate.rs:503`),
  `rotate_key_in` rejects a missing `expiresAt`, `verify_strict`, lease renewal accepts only the current epoch.
  *For the record, no change.*

### Service and wire

- ✅ Snapshot pages are cached per call string (`phi-service/src/lib.rs:396,1230`): alias and id of one Space get two caches,
  a page opened under one and continued under the other gets `SnapshotExpired`. TS has one cache per host.
- `requiredBytes` is recovered by parsing the fifth word of the error message (`lib.rs:1406-1414`); `entry_draft` decides
  batch-vs-single by comparing an error string (`lib.rs:1473`).
- ✅ **The server dies on a transient accept error.** `rust/phi-wire/src/lib.rs:310-314` (`accept().await?`) and `:365`
  (`set_nodelay(true)?`) end the server on EMFILE/ECONNABORTED, `serve_here` returns without `bound.close()`, the socket
  file stays, and every caller exits without `store.close()`. Node tolerates both. A failed second bind also leaves earlier
  socket files (`lib.rs:278-288`).
  *A passing accept error pauses that listener; the bound sockets are closed on every way out. A failing listener ends `serve` with `Err` after a drain, so the store is written although `close` is not called.*
- ✅ Shutdown grace of 3 s exists in `main.rs` and `profiles.rs`, not in `control_host.rs` and `member.rs`.
  *`stopping.rs`, used by all modes.*
- ✅ `USAGE` in `main.rs:25` omits `--control`; `SPACES_MMO_COMPACT_MS` is parsed as `u64` (TS `Number()`); the platform
  string maps only `x86_64`.

## 2. Dead code

- ✅ No callers: `Driver::clock_of` (`phi-core/src/driver.rs:88`), `Object::insert_at` (`phi-json/src/lib.rs:83`, only its
  own test; it also breaks the sorted-prefix invariant `insert` relies on), `Entries::as_slice` (`state.rs:195`, the
  `Deref` impl covers it), `apply_ops` (`phi-store/src/ops.rs:37`), `SpaceHost::parts` (`host.rs:405`),
  `membership::space_id` (`membership.rs:430`).
- ✅ Written, never read: `Proof.scope`/`Proof.at` (`auth.rs:118`), `PeerInfo.name` (`gate.rs:28`), `RemoteKeys.policy_at`
  (`remote.rs:124`), `PartRow.part` (`parts.rs:46`), `GrantAuthority.allow_a_only` outside tests.
  *`GrantAuthority.allow_a_only` is read now.*
- ✅ Never constructed: `WriteOp::PartClear` and `WriteOp::Meta` (`ops.rs:11-12`).
- ✅ Dead conditions: `host.contains(':')` after `split_once(':')` (`phi-wire/src/lib.rs:45`); the guard
  `Some(name) if name != "state"` after a `Some("state")` arm (`hooks.rs:285`).
- ➖ `sweep`'s `pick` closure is used only in the Disk arm, the Memory arm re-implements the predicate (`claims.rs:423-452`).
  *Kept: the Memory arm also computes `next` while filtering, so it cannot share the closure.*
- ✅ `pub` items used only in their own file or in tests: `control.rs` `hash_token`, `has_admin_key`, `revoke_peer_keys_in`,
  `create_enroll_in` and its constants; `run_member.rs` `verify_run`, `sign_run`; `membership.rs` `verify_membership`;
  `space_lifecycle.rs` `verify_lifecycle`, `sign_lifecycle`; `gate.rs` `GroupRoles`, `PeerInfo`, `roles_of`;
  `register.rs` `Peers`; `ledger.rs` `backup`, `whole_ops`, `part_rows`, `documents`; `host.rs` `stored`.
  *File-only functions are private now; types and what tests use stay `pub`.*
- ✅ Stale doc comments: `phi-json/src/lib.rs:389`, `ledger.rs:604`, `store.rs:40`; an import after a function in `host.rs:12-20`.

## 3. Duplicate code

- **Signed envelopes.** Verification is written five times (`auth::verify_value` plus inline copies in
  `space_lifecycle.rs:34-40`, `membership.rs:34-43`, `delegation.rs:153-159`, `control_host.rs:118-125`), signing four times
  (`run_member.rs:34-42`, `space_lifecycle.rs:44-51`, `membership.rs:421-427`, `control_host.rs:89-96`). The domain strings
  are spelled out in eight files. `gate.rs` `notice` and `notice_args` differ only in the argument key.
- ✅ **UTF-16 string order** four times: `phi-json::utf16_cmp`, `space.rs:71` `js_cmp`, `state.rs` `js_order`, `member.rs:15`
  `sorted`; `policy.rs:30` sorts by bytes instead.
  *`phi_json::utf16_cmp`. `policy.rs` now sorts as TS does.*
- ✅ **Safe-integer checks** five ways (`snapshot.rs:32`, `mailbox.rs:13`, `run_gates.rs:18`, `policy.rs:13`, inline in
  `claims.rs:364` and `space.rs:2178`); the 64-hex-digit check three times (`control.rs:70`, `register.rs:38`, `boot.rs:71`).
  *`phi_json::safe_integer` and `is_sha256_hex`; the `safe(Option<&Json>)` wrappers stay in their files.*
- Per-file helpers: `text`/`str_of`, `num_of`/`number` (with defaults 0.0 in `run_gates.rs`/`membership.rs`, NaN elsewhere),
  `illegal`, `denied`, `exhausted`, `conflict`, `strings`, `safe`; `run_member::algorithm_name` is `Algorithm::name`.
- `write` and `announce` repeat the type-limit checks and the "type first, no duplicates" fold (`space.rs:1649-1672`
  vs `:1796-1813`).
- phi-space-server: runtime plus signal boilerplate five times (`main.rs`, `profiles.rs`, `control_host.rs`, `member.rs`,
  `register.rs`); `control_host.rs` and `member.rs` share group roles, listen parsing, `key_of`, the peer check and the
  serve tail; `hooks.rs` repeats the seed-to-signer pattern four times; `profiles.rs:141` reads `/dev/urandom` by hand next
  to the imported `system_random`.
- Framing exists in `phi-wire::put`/`frames` and again by hand in `phi-host/src/remote.rs:39-55` with its own 16 MiB limit.
- Store: the registry document is rebuilt three times in `store.rs` (`:158,226,257`); `disk.rs` `num()` equals `ops.rs`
  `at_value()`; `rows()`/`ids_of()` differ only in the row mapper; `load()` and `document()` run the same SELECT.
- Service: the guard preamble three times although `guarded()` exists (`lib.rs:624-656`); the retained-result type check
  three times (`:550,873,1002`); write argument assembly in `write_call` and the batch step; deadline parsing and the
  `maxBytes` clamp repeated.
- Journal-cache pattern (`RefCell<Option<..>>` with fallback) four times: `membership.rs:129`, `space_lifecycle.rs:118`,
  `control.rs:434`, `delegation.rs:166`. `control_host.rs:58-70` `key_lookup` re-implements `SpaceKeys::find`.

## 4. Optimization opportunities that matter

- ✅ **Whole state cloned per tracked commit.** `space.rs:426` `let head = self.state.clone()` after taking out entries, log,
  claims and generations; mailboxes, outbox and jobs (up to tens of MiB) are copied on every commit. TS drafts are
  copy-on-write. Keep those as undo logs or `mem::take` them too.
  *Outbox, jobs and mailboxes are left out of the head; a commit saves what it changes on the first change (`save_rest`, `save_box`), and `rollback` puts them back. `tests` in `space.rs` hold each case.*
- ✅ **`jobs()` clones the job array** (`space.rs:663`, bounded by `maxJobBytes` 16 MiB) and is called per queued event,
  before every mutation via `needs_maintenance` and in every `settle`; `run_jobs` clones it again plus each job's events.
  *`jobs()` is a slice. `run_jobs` still copies the jobs once, in a commit that has jobs to run.*
- ✅ **Mailbox page clones the whole mailbox** three times (`mailbox.rs:175,199,222` plus `byte_page`).
  *Page and ack read by reference; the page is a slice of the events.*
- **Each frame is parsed up to four times**: `keys_of`, `call`, `later` in the gate (`gate.rs:456,541,641`) and once more
  in the service.
- `Store::spaces()` clones and sorts the registry per request (`store.rs:265`), hit from `Control::check`, `SpaceKeys::find`,
  `prepare` and the boot loop; an alias→id map is O(1). `host_of` is a linear scan per commit.
- `Template::matches` builds a `Json::String` per scanned entry for id templates (`space.rs:216`); no type buckets or
  entry-byte cache as in `core.ts:278-286,472-487`.
- `Object::remove` reindexes the whole map (`phi-json/src/lib.rs:89-93`); `sweep` removes up to 256 generations per commit.
- `DiskClaims.held` and `txns` are linear `Vec`s (`state.rs:516,562-578,607-630,809`): O(held × due), O(entries × txns).
- Write path: three owned Strings per `WriteOp::Part` row (`host.rs:310-356`); `join_parts` clones and re-sorts rows at open
  (`parts.rs:481-496`).
- Service: `look()` clones the whole `Ctx` per look of a parked call (`lib.rs:868`); `rate()` allocates a String per call
  (`:558-577`); `background.rs:39` scans a `Vec` with a fresh `to_json_text` per outbox item.
- Wire: every commit wakes every parked long poll and every connection's reply task (`lib.rs:160,172`), parity with TS;
  after a store failure `take_durable` wakes all writers on every `committed()` for the rest of the process (`:173-175`).
- Smaller: `overhead_bytes` re-serializes regs, waiters, txns, gates and jobs per write (parity); `Entries::get_mut` clones
  the full record into the undo log per call; `stream::touch` drops with `Vec::remove(0)` in a loop.

## 5. Suggested order

1. mmo inflight limit, notice methods behind `Control::check`, `allow_a_only` from the register.
2. Store: one failure flag, a fallible claims reader, no hosts for deleted Spaces.
3. Core: `primaryEpoch` fallback and epoch check, `read_chain` clamp order, total canonicalization.
4. Wire: survive accept errors, close the bound sockets on error, one runtime helper for the four modes.
5. The shared helpers (envelope, UTF-16 order, safe integer, field accessors) into `phi-json`/`phi-core`.
6. The clones in `begin_tracked_commit`, `jobs()` and the mailbox page.
