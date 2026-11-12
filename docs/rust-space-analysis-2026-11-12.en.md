# Analysis of the Rust Space Implementation vs. TypeScript Reference

As of 2026-11-12 (after decision R-D12: `big` and `nano` run exclusively the Rust implementation; TypeScript remains the local test oracle and in-process library under R-D5/R-D13). Companion documents: [rust-portierung.en.md](rust-portierung.en.md), [wire-protokoll.en.md](wire-protokoll.en.md), [rust-audit-fixes-2026-10-31.en.md](rust-audit-fixes-2026-10-31.en.md), [review-rust-2026-11-01.en.md](review-rust-2026-11-01.en.md) and [rust-review-2026-11-07.en.md](rust-review-2026-11-07.en.md).

This document analyzes the eight Space crates in `rust/`, compares their architecture and semantics systematically against the TypeScript implementation in `src/`, and catalogs newly identified bugs/divergences, dead code, duplicated code and optimization opportunities.

**Second pass (same day, tree `ba69f70`).** The findings below were read again at their lines: B1–B4, the dead-code lists of section 4, and O1–O3 hold as written. Three mechanical scans over the eight Space crates were added: `cargo clippy --workspace --all-targets` (no warning; `src/` holds no `allow(dead_code)`, `todo!`, `unimplemented!`, `TODO` or `FIXME`), a count of every declared name's uses across `rust/` (section 4), and a comparison of function bodies after stripping whitespace and comments (section 5.2). What they changed is marked "second pass": the `valid_id` variants in 5.2 were listed wrongly, 4.2 and 5.2/5.3 gained items, and O6/O7 are new. Nothing here was measured; the optimization items name where the work is, not how much it costs.

---

## 1. Scope and Quantitative Overview

The Cargo workspace in `rust/` comprises ten crates: eight form the **phi-spaces** platform (server, core, store, wire protocol, security/federation host and client), while `mmo-engine` and `mmo-web` are application crates for `spaces-mmo` (phase R8).

| Layer | Rust crate | Files (`src/`) | Lines (`src/`) | TypeScript counterpart (`src/`) |
|---|---|---:|---:|---|
| JSON & digests | `phi-json` | 1 | 443 | `canonical.ts`, `json.ts` |
| Pure Space semantics | `phi-core` | 15 | 7,191 | `core.ts`, `doc.ts`, `claims.ts`, `stream.ts`, `mailbox.ts`, `paging.ts`, `snapshot.ts`, `read-chain.ts`, `member-admission.ts`, `member-transition.ts`, `restore.ts`, `routing-semantics.ts`, `federation-policy.ts`, `federation-journals.ts`, Space-level part of `data-admin.ts` |
| Persistence & sync journal | `phi-store` | 12 | 2,931 | `store/*`, `spaces.ts`, `primary-sync.ts` |
| RPC service & merge replication | `phi-service` | 3 | 4,241 | `service.ts`, `client.ts` (service path), `index.ts` (reaper/delivery), `rpc-domain.ts`, `entry-replication*.ts`, `replication-clock.ts` |
| Framing & event-loop hub | `phi-wire` | 2 | 1,019 | `socket.ts` (server side & framing) |
| Security, federation, recovery | `phi-host` | 42 | 14,161 | `gate.ts`, `auth.ts`, `enroll.ts`, `supervisor.ts`, `grants.ts`, `rotation.ts`, `delegation.ts`, `boot.ts`, `capability-directory.ts`, `membership.ts`, `run-member.ts`, `run-controller.ts`, `workers.ts`, `space-lifecycle.ts`, `deployment.ts`, `alerts.ts`, `data-admin.ts`, `router.ts`, `federated-space.ts`, `federation-rpc.ts`, `root-wire.ts`, `configured-root.ts`, `profile-transition*.ts`, `member-status`, `sync-spaces.ts`, `replica-*.ts`, `control-host-change.ts`, `recovery*.ts`, `control-ack.ts`, `control-recovery.ts`, `tls-register.ts`, `register-service.ts`, `ssh-register.ts`, `ssh-recovery.ts` |
| Server CLI & project profiles | `phi-space-server` | 10 | 2,307 | `standalone.ts`, `configured-runtime.ts`, `configured-recovery.ts`, `recovery-only.ts`, plus `spaces-mmo`, `codemode-chat` and `help-site` `space-host.ts` profiles |
| Remote client & helpers | `phi-spaces-client` | 6 | 1,482 | `remote.ts` (core `SpaceLike` subset), `socket.ts` (client side), `space-client.ts`, `commit-sealed.ts` |
| **Total Space crates** | **8 crates** | **91** | **33,775** | **`src/` total: 108 files, 18,512 lines** |
| *(Sibling app crates)* | `mmo-engine`, `mmo-web` | 90 | 19,796 | `spaces-mmo/server/*` |

The ~1.82x line-count expansion from TypeScript (`18,512` lines) to the eight Rust Space crates (`33,775` lines) comes from explicit typed state/undo structures (`phi-core/src/state.rs`), a custom ECMAScript-compatible JSON parser/serializer (`phi-json`), explicit error/option types in place of structural object literals, inlined project host profiles (`profiles.rs`, `help.rs`) and test drivers (`driver.rs`, `hooks.rs`, `phi-client-driver.rs`).

---

## 2. Architectural Comparison: Rust vs. TypeScript

### 2.1 Execution, Concurrency and Durability Model

| Aspect | TypeScript (`src/`) | Rust (`rust/phi-*`) | Assessment |
|---|---|---|---|
| **Concurrency model** | Single Node.js event loop; `host.commit(async tx => …)` allows `await` inside commit callbacks, serialized by an async queue per host (`src/store/host.ts`). | Single owner thread (`tokio` `current_thread` runtime + `LocalSet`, `Rc`/`RefCell`) per store (`phi-wire/src/lib.rs`). Commits are synchronous closures (`FnOnce(&mut Space)`) with zero `await` points inside a commit. | **Rust is strictly simpler and faster:** impossible for external I/O or interleaving tasks to pause mid-commit; pre-commit network reads happen in `Session::prepare` (`phi-host/src/gate.rs:660`). |
| **Context propagation** | `AsyncLocalStorage` (`src/context.ts`) carries cancellation and ambient transaction/store context. | Explicit parameters (`now: f64`, `Random`, `&Ctx`, `&Owner`). No task-local magic. | Deterministic by construction; eliminates ambient context leaks. |
| **Drafts & rollback** | Recursive JS `Proxy` copy-on-write (`src/store/draft.ts`) + `deepFreeze` in tests; structural diffing of arrays/maps at commit end (`src/store/parts.ts`). | Typed state (`SpaceState`) + explicit undo logs per collection (`Entries::track`, `Tracking` in `phi-core/src/space.rs:425`, lazy `save_rest` / `save_box`). Rollback replays undo entries in reverse. | **Major performance win:** O(changes) per commit instead of O(N) proxy/diff overhead (avoided a measured 21 ms/commit cost at 10k entries). |
| **SQLite persistence** | Eval worker thread (`src/store/sqlite-writer.ts`), WAL + `synchronous=FULL`, commit batching. | Dedicated `phi-store-writer` OS thread (`phi-store/src/writer.rs`), bundled SQLite via `rusqlite`, WAL + `synchronous=FULL`, `mpsc` batching up to journal budget. | Identical file format (`store_meta`, `documents`, `parts`, `.owner` exclusive lock) and crash semantics; 6–10x lower CPU and ~10x lower idle/peak RSS. |
| **Reply durability barrier** | `await host.commit(...)` suspends each RPC handler until the writer worker acknowledges the batch; each waiting call holds one of `maxInflightPerConnection` (32) slots. | `start_commit` pipelines immediately; `Link::reply` (`phi-wire/src/lib.rs:328, 797`) holds outgoing frames until `durable >= mark`. Completed calls waiting only on `fsync` do **not** occupy an `inflight` slot; instead, per-connection held replies are capped at `1024` frames / `8 MiB`. | Prevents connection-slot starvation under bursts while preserving the strict durability contract (even reads wait for preceding handed commits to become durable). |
| **Document memory budget** | `OwnStoreHost` can evict unwatched documents by byte budget (`src/store/host.ts`). | Dropped (`phi-store/src/store.rs:3`): live Spaces stay in memory, deleted Spaces open lazily on snapshot read, and decided claims stay on disk (`DiskClaims`). | Matches effective TS server behavior because `startService` watches every live Space in TS anyway. |
| **Background reaper** | `startService` (`src/index.ts`) watches every Space and runs a maintenance commit round after commits plus timers; `Meter` records delivery counters. | `background.rs` queries `needs_maintenance` / `next_expiry` first (debounced by `watch_debounce_ms`: 20 ms default, 50 ms in profiles) and commits **only** when work is actually due. `Meter` is omitted. | Eliminates empty maintenance commits while remaining state-hash equivalent before/after mutations. |
| **Long-poll cadence** | `POLL_GAP_MS = 25` ms (`src/service.ts:34`), because a snapshot read in TS is relatively expensive. | `POLL_GAP_MS = 2.0` ms (`phi-service/src/lib.rs:30`), because checking `Space` in memory on the owner thread is a direct lookup. | Halved p50 step latency under load (`22 ms -> 11 ms` in `spaces-mmo`). |

### 2.2 JSON, Numbers and Strings (`phi-json` vs. `canonical.ts` / `json.ts`)

Because V8 property order, IEEE-754 number formatting and UTF-16 key sorting are part of the byte-exact hashing and budget contracts, `phi-json` avoids `serde_json` and implements its own `Json` DOM:
- **Property order:** `Object` (`phi-json/src/lib.rs:30`) orders array-index keys (`0 ..= 2^32 - 2`) ascending first and all other keys in insertion order, switching from linear scan to an auxiliary `HashMap<String, usize>` at 32 keys.
- **Numbers:** All numbers are `f64`, formatted via `ryu-js` (`-0.0 -> "0"`), matching ECMAScript `Number::toString` and `FOREVER = 9_007_199_254_740_991.0`.
- **Strings (R-D10):** Stored values use strict `parse` (rejecting unpaired UTF-16 surrogates); incoming wire frames use `parse_repairing` (replacing lone surrogates with `U+FFFD`, matching `wellFormed` in `src/service.ts:136`). Nesting is capped at `MAX_DEPTH = 512`.

### 2.3 Feature Coverage: What Remains TypeScript-Only

Almost the entire server, security and federation surface (R0–R5, R5b, R6a, R6b, R8.1) is ported. The modules in `src/` that are **not** ported (or only partially ported) in `rust/` are:

| `src/` module(s) | Status in Rust | Notes |
|---|---|---|
| `distributed-erasure.ts`, `root-erasure.ts`, `root-erasure-doc.ts`, `erasure-archives.ts`, `erasure-barrier.ts`, `erasure-sqlite.ts`, `store/erasure-own.ts` | **Partially ported (enforcement only)** | Rust ports `validate_erasure_update` (`phi-host/src/register.rs:70`), `BootGuard` erasure-barrier enforcement (`phi-host/src/boot.rs:113`), `FederatedSpace::assert_no_erasure` (`phi-host/src/federated_space.rs:220`), per-Space batched `deletePrincipal` (`phi-core/src/admin.rs`, `phi-host/src/data_admin.rs`), and entry-replication erasure (`phi-service/src/entry.rs:1558`). The offline/coordinator workflows (`DistributedPrincipalErasure`, `RootHistoryErasure`, `ErasureArchiveController`, SQLite WAL/vacuum erasure runner) exist only in TypeScript. |
| `netcup-fencing.ts`, `container-fencing.ts`, `fencing.ts` | **Client side only** | `phi-host/src/replica_transitions.rs` implements `TlsFencing` (the mutual-TLS client talking to the fencing daemon) and `phi-host/src/recovery.rs` implements `verify_ssh_fence`. The fencing daemons/adapters themselves (`NetcupFencing`, `ContainerFencing`) run in TypeScript outside the Space containers. |
| `remote.ts` (security, enrollment, rotation & federation RPC methods) | **Split / partial** | `phi-spaces-client` implements core `SpaceLike` + `space-client.ts` helpers, without `signer`, `authenticate`, `ProofRequired` auto-reprove, `grantProvider`, `delegationProvider`, `agent` (`frame.agent`), `enroll`, or `rotateKey`. Host-to-host authenticated RPCs instead use `phi-host::remote::ControlClient`. |
| `entry-replication-transfer.ts` (wire integration) | **Core logic ported, not wired to gate** | `phi-service/src/entry.rs` ports `start_snapshot`, `snapshot_page`, `begin_snapshot_import`, `import_snapshot_page`, `finish_snapshot_import` and `complete_erasure` (tested via `entry_walk.rs`), but `phi-host/src/gate.rs:607` and `entry_pump.rs` only expose/pull `entryDescribe` and `entryChanges`. |
| `store/documents.ts` (`migrate`), inline head parts | **Refused on open** | Rust requires `REGISTRY_VERSION == 1`, `SPACE_VERSION == 5`, and parts stored as rows (`phi-store/src/host.rs:107`, `ledger.rs:146`), refusing older schemas rather than migrating silently. |
| `client.ts` (`PhiSpaces` in-process API), `meter.ts`, `dashboard*.ts`, `ws.ts` | **By design (R-D5, R7, R8)** | `PhiSpaces` stays TypeScript; `dashboard.ts` and TUI read over sockets (R7); `ws.ts` is ported inside `mmo-web/src/ws.rs` rather than as a library crate. |

---

## 3. Bugs, Logic Gaps and Semantic Divergences

The following issues were verified directly in the current tree (`fede44f`) and were **not** covered by `rust-review-2026-11-07.en.md`.

### B1 (High — Principal Erasure / Security): `phi-core::snapshot` ignores `snapshotEpoch`

- **Where:** `rust/phi-core/src/snapshot.rs:75, 106` vs. `src/snapshot.ts:29, 40` and `rust/phi-host/src/data_admin.rs:213-214, 266-267`.
- **What goes wrong:** When `DataAdminController::start_deletion` and `advance_deletion` (`phi-host/src/data_admin.rs`) erase a principal's data, they increment `s.state.rest["snapshotEpoch"]` specifically so any multi-page entry snapshot (`ss<hex>`) cached in memory before the deletion becomes invalid (`SnapshotExpired`). In `rust-review-2026-11-07.en.md` (line 71), `snapshot_epoch: 0.0` was left hardcoded because `assert_ported` then rejected `snapshotEpoch`. `assert_ported` (`phi-core/src/space.rs:686`) and `data_admin.rs` were subsequently added, but `phi-core/src/snapshot.rs` still hardcodes `0.0` in both places:
  - Line 75: `if truthy_token.is_some() && found.as_ref().is_none_or(|r| r.stream_id != stream_id || r.snapshot_epoch != 0.0)`
  - Line 106: `Record { snapshot_epoch: 0.0, ... }`
- **Impact:** After `deletePrincipal` completes and lifts `adminMaintenance`, a client holding a pre-deletion snapshot token (`ss...`) can continue paging through the cached `Record` (`0.0 != 0.0` is `false`) until `snapshotTtlMs` (60 s) expires, reading entries of the erased principal that TypeScript immediately rejects with `SnapshotExpired`.
- **Fix:** Read `let snapshot_epoch = space.state.rest.get("snapshotEpoch").and_then(Json::as_f64).unwrap_or(0.0);` in `Snapshots::page`, compare `r.snapshot_epoch != snapshot_epoch` on line 75, and store `snapshot_epoch` in `Record` on line 106.

### B2 (High — Durability / Replay & Erasure Safety): `SpaceHost::claim_failure` ignores `restored_disk`

- **Where:** `rust/phi-store/src/host.rs:241-246` and `rust/phi-store/src/disk.rs:28-49`.
- **What goes wrong:** `SqliteClaims` (`disk.rs`) does not return `Result` from `ClaimSource` methods; instead, on SQLite busy timeouts, I/O errors or corrupt JSON rows, it returns empty results (`None` / `vec![]`) and records the error in `self.failure`. `SpaceHost::start_commit` (`host.rs:155, 159`) checks `self.claim_failure()` before and after running `op` to abort and roll back the commit if a claim read failed. However, `claim_failure` only inspects `rpc.claims` and ignores `self.space.restored_disk`:
  ```rust
  fn claim_failure(&self) -> Option<String> {
      match self.space.state.rpc.as_ref().map(|r| &r.claims) {
          Some(Claims::Disk(d)) => d.take_failure(),
          _ => None,
      }
  }
  ```
- **Impact:** If a read on `restored_disk` (`restoredClaims`) fails with `SQLITE_BUSY` or an I/O error:
  1. `Space::admit` (`claims.rs:154`) sees `self.restored_claim(&key) == None` and admits a historical pre-restore request as a fresh mutation instead of rejecting it with `IncarnationChanged`, committing a duplicate effect.
  2. `Space::erase_batch` (`admin.rs:270`) and `Space::history_step` (`member_transition.rs:148`) see an empty page from `self.restored_page(...)`, assume all historical claims have been processed, and advance to `"generations"` / `"completed"`, leaving historical claims unerased or unmarked on disk.
- **Fix:** Drain both `rpc.claims` and `self.space.restored_disk` in `SpaceHost::claim_failure()` (and check `claim_failure()` on read-only paths such as `lookup` / `poll_operation` as well, or make `SqliteClaims` propagate errors).

### B3 (High — Client Reliability): `phi-spaces-client` timeout cancellation prevents dead-socket teardown and leaks `pending` waiters

- **Where:** `rust/phi-spaces-client/src/helpers.rs:47-51`, `remote.rs:190`, `socket.rs:197, 211-224` vs. `src/space-client.ts:28`, `src/remote.ts:152-163`, `src/socket.ts:197`.
- **What goes wrong:**
  1. `connect_space` configures `RemoteSpace` with `call_timeout_ms` (default `30_000` ms) and `SocketTransport` with `request_timeout_ms: Some(call_timeout_ms as u64 + 5_000)` (`35_000` ms).
  2. In TypeScript, `Promise.race` in `RemoteSpace.roundTrip` rejects at 30 s **without** cancelling `socketTransport.request`, so 5 s later `socketTransport`'s 35 s `setTimeout` fires, deletes `id` from `pending`, and calls `s.destroy()` to tear down a half-open/blackholed TCP connection.
  3. In Rust, `RemoteSpace::round_trip` wraps `self.t.request(...)` in `tokio::time::timeout(30s, ...)` (`remote.rs:190`). At 30 s (or earlier when `max_client_wait_ms` clamps `budget`), `timeout` **drops** the `SocketTransport::call` future, cancelling `SocketTransport`'s inner `timeout(35s, rx)` (`socket.rs:213`) before it can ever fire.
  4. Consequently, `c.end("connection lost")` (`socket.rs:218`) is **never** called on a silently blackholed TCP/overlay link: `c.alive` stays `true`, every retry in `RemoteSpace::send` writes onto the same dead socket instead of reconnecting, and `c.pending` (`HashMap<u32, Waiter>`) leaks dead `oneshot::Sender` entries whenever a request future is dropped (by `round_trip` timeout or `await_work` `halt` cancellation in `helpers.rs:101`).
- **Fix:** Add a drop guard in `SocketTransport::call` around `rx.await` that removes `id` from `c.pending` if still present; and when a call is dropped unresolved (or by setting `request_timeout_ms <= call_timeout_ms` / closing the connection on timeout), tear down `Conn` so the next retry reconnects.

### B4 (Medium — Both Rust and TypeScript): `erase_batch` removes `outbox` items without resetting `outbox_bytes`

- **Where:** `rust/phi-core/src/admin.rs:181-195` and `src/data-admin.ts:117`.
- **What goes wrong:** In the `"registrations"` phase of `deletePrincipal`, both implementations remove matching events from `outbox` (`a.remove(i)` / `s.outbox.splice(i, 1)`) without resetting `s.state.outbox_bytes = None` (`delete s.outboxBytes`) or subtracting the removed event sizes. By contrast, `deliver_events` (`phi-service/src/background.rs:51`), `begin_restore` (`restore.rs:143`) and `member_transition_step` (`member_transition.rs:38`) all reset `outbox_bytes = None`.
- **Impact:** After `deletePrincipal` removes outbox items, `outbox_bytes()` stays stale-high until a restore or `deliver_events` commit runs, over-charging `maxOutboxBytes` and `overhead_bytes` / `doc_bytes`. (Because both TS and Rust share this omission, `data-admin-driver.ts` did not flag it; fixing it must update both sides together.)

### B5 (Low — `--profile help` in `phi-space-server`): In-place `EntryRec` relink leaves `EntryRec::size` stale

- **Where:** `rust/phi-space-server/src/help.rs:218-220` (ported from `help-site/server/social/retention.ts:137`).
- **What goes wrong:** When unlinking purged `PostHistoryNode` entries, `s.state.entries.get_mut(at).fields.insert("next", older.as_str().into())` mutates `fields` in place without updating `EntryRec.size: Option<f64>`. When `older` has a different string length than the previous `next` id (e.g. `"e...-100"` -> `""` or different digit count), the cached `e.size` diverges by a few bytes from `bytes(&e.fields)`. (Both TS and Rust also intentionally omit `log_put` for this internal pointer relink.)

### B6 (Low — Minor Divergences & Stale Comments)

1. **`phi-spaces-client` lacks `frame.agent` (M1):** Commit `20971ad` added `RemoteOptions.agent` (`src/remote.ts:66, 156`) and `frame.agent` handling in `phi-service/src/lib.rs:553-561` and `phi-space-server` `--agent-host` (`main.rs:76`), but `phi_spaces_client::Options` (`remote.rs:70`) has no `agent: Option<String>` field yet.
2. **TCP target parsing mismatch:** `phi-wire::Listen::parse` (`phi-wire/src/lib.rs:47-51`) uses `split_once(':')` and `port.parse::<u16>()` (which accepts leading `+`, e.g. `tcp:127.0.0.1:+3600`), whereas `phi_spaces_client::parse_target` (`helpers.rs:18-22`) and TypeScript `parseTarget` (`src/space-client.ts:13`) validate `!port.is_empty() && port.bytes().all(|b| b.is_ascii_digit())`.
3. **`stats.process` fields (`phi-service/src/lib.rs:422-429`):** Reports `heapBytes` equal to `rssBytes` (no allocator heap counter), sets `at` to the service's injected `now` rather than wall-clock `Date.now()` (`src/service.ts:384`), and assumes Linux `USER_HZ = 100` (`* 10.0`) and `4096`-byte pages (`* 4096.0`).
4. **Stale module comments:**
   - `rust/phi-core/src/space.rs:16` still states `"Unsupported document fields (negative claims, for one) are refused with NotPorted"`, although negative claims (`notCommitted`) have been supported since R6b.
   - `rust/phi-host/src/root.rs:2-3` still states `"Replicated Members, a router change, the status heartbeat and epoch notices are not carried; check_start refuses what would rely on them"`, although all four are implemented in `root.rs`.

---

## 4. Dead Code

### 4.1 Zero Callers Anywhere in the Workspace (Including Tests)

| Location | Item | Notes |
|---|---|---|
| `rust/phi-host/src/alerts.rs:30` | `pub fn collect_alerts` | Superseded by `collect_alerts_with` (`alerts.rs:59`), which both `ControlCommands` and `tests/alerts.rs` call directly. |
| `rust/phi-spaces-client/src/error.rs:40` | `pub fn unknown_request` | Convenience accessor on `Error` with zero callers in `phi-spaces-client`, `mmo-engine`, `mmo-web` or tests. |
| `rust/phi-host/src/alerts.rs:13, 83` | `MAX_ERROR` bypassed at line 83 | `const MAX_ERROR: usize = 300;` is used in `audit_log` (line 145), while `collect_alerts_with` (line 83) hardcodes literal `300`. |

### 4.2 Public Functions Used Only by Tests / Cross-Language Drivers (Zero Production Callers)

These items are `pub` solely for differential test drivers (`entry_walk.rs`, `store_walk.rs`, `recovery_cross.rs`, etc.) or represent library building blocks not yet wired into `phi-space-server`:

- **Unwired entry-replication features (`rust/phi-service/src/entry.rs`):** `set_random` (`:402`), `install_snapshot` (`:1065`), `start_snapshot` (`:1218`), `snapshot_page` (`:1244`), `begin_snapshot_import` (`:1275`), `snapshot_import_status` (`:1309`), `import_snapshot_page` (`:1319`), `finish_snapshot_import` (`:1394`), `change_ids_owned_by` (`:1470`), `erase_principal` (`:1479`), `complete_erasure` (`:1517`), `erasure_status` (`:1558`). Only `entry_walk.rs` calls them; `phi-host` neither serves snapshot-transfer RPCs on the gate nor exposes entry principal erasure.
- **Unwired operator / bootstrap helpers:**
  - `phi-store/src/sync_store.rs:134` `pub fn bootstrap_primary_sync` (no CLI subcommand in `--replica-tool`).
  - `phi-store/src/sync.rs:435` `pub fn abandon_transition` (tested, not exposed in `--replica-tool`).
  - `phi-host/src/control_host_change.rs:51` `pub fn record_control_host_change` (operator action; Rust hosts only call `follow_control_host_change`).
  - `phi-host/src/replica_transitions.rs:94, 100` `pub fn release_host_to_quarantine` and `pub fn readmit_space` (tested in `replica_transitions.rs`, not exposed in `--replica-tool`).
- **Second pass, the same class:** `phi-core/src/space.rs:2425` `Space::list_page` and `phi-core/src/mailbox.rs:166` `Space::append_mail_line` (only `driver.rs` and `phi-host/tests/data_admin.rs`); `phi-host/src/control.rs:113, 120, 164` `create_enroll`, `bootstrap_enroll`, `revoke_peer_key` (only the `--test-hooks` of `phi-space-server/src/hooks.rs:280-282`; the admin commands go through `create_enroll_in` / `revoke_peer_keys_in` at `control.rs:610, 614`, and nothing in production calls `bootstrap_enroll`); `phi-spaces-client/src/remote.rs` `RemoteSpace::request_generation` and `cancel_operation` (client API that only `phi-client-driver` calls; `mmo-engine` and `mmo-web` do not).
- **Test-only helpers:** `phi-core/src/admin.rs:134` `Space::put_restored`, `phi-store/src/ledger.rs:190` `SqliteLedger::part_rows`, `phi-store/src/ledger.rs:213` `SqliteLedger::persist`, `phi-store/src/primary.rs:73` `PrimaryGate::into_journal`, `phi-service/src/lib.rs:491` `Service::handle_text` (production `phi-wire` calls `handle_call` on the pre-parsed `Json`).

### 4.3 Over-Broad `pub` Visibility (Used Only Within Their Defining File)

Approximately 50 items are marked `pub` despite having zero references outside their own `.rs` file (not even in tests) and can be narrowed to private or `pub(crate)`:
- **`phi-core`:** `admin::tally_claims`, `restore::run_recovery_id_of`, `space::DEFAULT_LEASE_MS`, `state::MemoryClaims` (`to_object`), `state::RpcState::to_json_with`, `state::StreamState::to_json_with`, `state::StreamOp`.
- **`phi-store`:** `files::{SCHEMA, INDEXES}`, `ledger::Ords`, `ops::{PART_CLEAR, META}`, `parts::DiskIndex`, `primary::POISONED`, `sync::own::{touches, bootstrap_write}`.
- **`phi-service`:** `lib::{EpochForSpace, PromotionProof, entry_error}`, `entry::{validate_clock, compare_clock, advance_clock, REPLICAS, positions_of, merge_runs, Check, stream_identity}`.
- **`phi-wire` & `phi-spaces-client`:** `phi_wire::Hook`, `phi_spaces_client::remote::SleepFn`.
- **`phi-host` & `phi-space-server`:** `control::{ENROLL_TTL_MS, MAX_FAILED_ATTEMPTS, ATTEMPT_INTERVAL_MS, RESULT_RETENTION_MS}`, `control_ack::RECEIPTS`, `data_admin::valid_principal`, `deployment::{Validated, validate_deployment, bind_host, start_workers}`, `federation_rpc::{checked_resolution, delegation_for_call}`, `gate::{GateSession, Netbird::cache_ms, Gate::revalidate}`, `recovery::authority_transition_bytes`, `register::Peers`, `remote::ControlClient::routing_policy`, `replica_notice::notice_of`, `replica_transitions::{Boots, fence_host_boot, revoke_space_permit}`, `replica_transport::{MAX_FRAME_BYTES, STANDBY_ANSWER_MS, CONNECT_MS, MAX_CONNECTIONS, Admitted}`, `root::{RUN_COMMANDS, DATA_ADMIN_COMMANDS, COMMANDS_OF_ROOT, adopt_notices}`, `run_controller::view_of`, `sync_space::{NotServed, Resolved}`, `phi-space-server/src/help::{ALIAS, CLAIM_RESULT_MS}`.

---

## 5. Duplicated Code

### 5.1 Socket Framing, Address Parsing and Wire Client Plumbing (4–5 Copies)

Because `phi-spaces-client` depends only on `phi-json` and `tokio` while `phi-wire` depends on `phi-service`/`phi-store`, low-level wire logic is duplicated across crates:
1. **8-byte length+id framing:** Implemented separately in `phi-wire/src/lib.rs` (`put`, `read_frame`, `frames`), `phi-wire/src/texts.rs` (`connection`), `phi-spaces-client/src/socket.rs` (`frame`, `read_frame`), `phi-host/src/remote.rs` (`exchange` over `phi_wire::put`/`read_frame`), and `phi-host/src/replica_transport.rs` (`SocketTransport`).
2. **Endpoint address parser (`unix:...` / `tcp:host:port`):** Implemented twice with slightly different edge cases in `phi-wire::Listen::parse` (`phi-wire/src/lib.rs:44-58`) and `phi_spaces_client::parse_target` (`phi-spaces-client/src/helpers.rs:15-29`).
3. **TCP connect with optional source-IP bind and `TCP_NODELAY`:** Written three times (`phi-spaces-client/src/socket.rs:145-155`, `phi-host/src/remote.rs:51-59`, `phi-host/src/replica_transport.rs`).
4. **Protocol error code mapping (`ErrorCode` <-> internal class):** Written in `phi-service/src/lib.rs:1617-1644` (server out) and `phi-host/src/root.rs:314-322` (`from_wire`, client in).
5. **Architectural split:** Extracting a tiny zero-IO-or-tokio-only `phi-frame` (or moving `Target`/`frame`/`read_frame`/`parse_target` into `phi-spaces-client` or a shared base crate below `phi-wire`) would unify framing, `HEADER`, `DEFAULT_MAX_FRAME_BYTES` and `parse_target`.

### 5.2 JavaScript Coercion & Validation Micro-Helpers Across Crates

- **`truthy` (4 copies):** `phi_core::space::truthy` (`space.rs:90`), `phi_service::entry::truthy` (`entry.rs:93`), `phi_host::alerts::truthy` (`alerts.rs:55`), `phi-space-server/src/help.rs:248` (plus `claim_flag` in `state.rs:586`). Belongs once in `phi-json`.
- **`js_string` (4 copies):** `phi_core::space::js_string` (`space.rs:67`), `phi_service::entry::js_string` (`entry.rs:102`), `phi_host::control_recovery`, `phi_host::workers` (plus `help::stringify` and `alerts::string`). Belongs once in `phi-json`.
- **`js_number` (3 copies):** `phi_host::entry_pump::js_number` (`entry_pump.rs:160`), `phi_host::run_controller`, `phi_host::workers`. Belongs once in `phi-json`.
- **`valid_id` (8 functions of that name, five rules; corrected in the second pass):**

  | Rule | Where |
  |---|---|
  | `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}` | `phi-core/src/run_gates.rs:17` (takes `Option<&Json>`), `phi-host/src/data_admin.rs:24`, `grants.rs:17` (`agent_id_ok`), `phi-store/src/sync.rs:52` (`reason_like`); the last three have the same body |
  | the same, less `constructor`, `prototype`, `__proto__` | `phi-host/src/federated_space.rs:40`, `membership_control.rs:34` (same body) |
  | `[A-Za-z0-9][A-Za-z0-9._:-]{0,95}` | `phi-host/src/workers.rs:19`, `space_lifecycle.rs:25` (same body), `run_controller.rs:47` (by bytes; the same set, since every character is ASCII) |
  | `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, less the three names | `phi-host/src/profile_transition.rs:39` |
  | `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` | `phi-service/src/entry.rs:67` (`id_text`) |

  The lengths and the `:` differ on purpose (each is the regex of its TypeScript module), so one validator would be wrong; one function taking the length, the `:` and the reserved names, with a named constant per rule, keeps the differences visible.
- **`hash` / `canonical` / `copy` wrappers (9–13 copies):** Almost every module in `phi-host`, `phi-core` and `phi-store` defines local `fn hash(v: &Json)` and `fn canonical(v: &Json)`. Five of the `hash` wrappers have the same body (`phi-core/src/policy.rs:13`, `routing.rs:12`, `phi-host/src/federated_space.rs:25`, `membership.rs:22`, `membership_control.rs:20`); the others differ only in the error they map to.
- **Functions with the same body (second pass):**

  | Body | Copies |
  |---|---|
  | `v.get(k).and_then(Json::as_f64).unwrap_or(f64::NAN)` | 8: `number` / `num` / `n` in `phi-core/src/member.rs:13`, `restore.rs:12`, `phi-store/src/sync.rs:60`, `phi-service/src/entry.rs:132`, `phi-host/src/register.rs:59`, `delegation.rs:22`, `replica_notice.rs:12`, `replica_transitions.rs:18`. `phi_json::num_of` (`phi-json/src/lib.rs:333`) is this without the default. |
  | `v.get(k).and_then(Json::as_str).unwrap_or("")` | 3: `phi-store/src/sync.rs:61`, `phi-service/src/entry.rs:131`, `phi-host/src/control.rs:52`; `phi_json::text` is this without the default. |
  | `set(v, k, x)`: insert into a `Json::Object` | 6: `phi-host/src/federated_space.rs:26`, `federation_rpc.rs:56`, `membership_control.rs:21`, `router.rs:43`, `deployment.rs:49`, `run_controller.rs:53` |
  | `value(r)` and `version(r)` of a register record | 4 each: `phi-host/src/control_ack.rs:16-17`, `control_recovery.rs:21-22`, `recovery.rs:15-16`, `recovery_controller.rs:16-17` |
  | `with(rec, changes)`: a record with fields replaced | 3: `phi-host/src/control_recovery.rs:26`, `control.rs:62`, `recovery_controller.rs:19` |
  | `names(v)`: an array of strings | 3: `phi-core/src/routing.rs:15`, `member.rs:14`, `phi-host/src/federated_space.rs:38` |
  | `cut(t, n)`: `slice(0, n)` by UTF-16 units | 3: `phi-host/src/alerts.rs:27`, `run_controller.rs:52`, `workers.rs:73` |
  | wall clock in ms | 2: `phi-host/src/recovery_rpc.rs:57` (`now_ms`), `phi-spaces-client/src/remote.rs:35` (`wall_ms`) |
  | `sign_lifecycle` / `verify_lifecycle` | 2 each: `phi-host/src/space_lifecycle.rs:31, 37` and `space_commands.rs:24, 28` |
  | `DiskClaims::adopt` / `adopt_map` | `phi-core/src/state.rs:613, 621`: the same body over `MemoryClaims::iter` and `Object::iter`; one function over an iterator of `(&str, &Json)` serves both. |

### 5.3 Controller & Startup Duplication in `phi-host` and `phi-space-server`

- **Federation journal helpers (`phi-host`):** `empty_routing` (4 files: `root.rs`, `federated_space.rs`, `membership_control.rs`, `profile_transition.rs`) and `empty_operations` (3 files: `federated_space.rs`, `membership_control.rs`, `profile_transition.rs`), plus identical ledger `ops`/`put`/`set` wrappers in `membership_control.rs` and `profile_transition.rs`.
- **`phi-space-server` startup plumbing:**
  - `main_sync` -> `SyncSpaceConfig` synthesis is duplicated between `control_host.rs:283-291` and `replica_tool.rs:36-41`.
  - `RegisterClient` TLS construction is duplicated between `member.rs:222-225` and `replica_tool.rs:23-26`.
  - `key_of(c, "keyFile")` reads and PEM-decodes the host's key file from disk up to **five separate times** during `--control` / `--member` startup (`control_host.rs:72, 174, 246, 247, 269`; `member.rs:325, 428, 432, 435, 491, 495`), and `member::run` builds up to three temporary `tokio` runtimes before entering `serve_gate` (`member.rs:275, 281, 300`).

---

## 6. Optimization Opportunities (Ranked by Impact)

### O1 (High — Every Federated Read & Commit): Cache `installedRegisterFile` in `BootGuard`

- **Where:** `rust/phi-host/src/boot.rs:216-220` (`BootGuard::space`).
- **Finding:** While external register records are pre-fetched into `BootGuard::seen` (`RefCell<Option<Seen>>`), `BootGuard::space` executes `self.installed.get(&format!("installed:{}:{id}", self.host_id))` — a synchronous SQLite `SELECT` on `installedRegisterFile` + JSON parse + **two** full `canonical()` serializations (`permit.canonical() != local.canonical()`) — on **every single `snap_of` and `commit_on`**! Furthermore, `Service::read_all` (`phi-service/src/lib.rs:1433-1437`) calls `snap` / `snap_of` twice in a row on the common path, doubling this work on every page read.
- **Lever:** Cache `installed:{host}:{space}` records (and their canonical digest/text) in memory inside `SqliteRegister` or `BootGuard`, invalidating only when `compare_and_set` writes to `installed` (`admit_at_start`, `install_admitted_permit`, recovery). Also remove the redundant second `self.snap_of(...)` call in `Service::read_all` (`phi-service/src/lib.rs:1436`) when line 1434 did not commit.

### O2 (High — Core Hot Path): Zero-Allocation `Json::json_bytes` and Direct `ryu-js` Buffer Writes

- **Where:** `rust/phi-json/src/lib.rs:295-298, 358, 383, 394`.
- **Finding:**
  1. `Json::json_bytes(&self)` (`lib.rs:394`) calls `self.to_json_text().len()`, allocating and formatting an entire JSON `String` on the heap just to measure its UTF-8 byte length and immediately drop it. `json_bytes` is called constantly across `Space::write`, `overhead_bytes`, `doc_bytes`, `claim_bytes`, `mailboxes_bytes`, `byte_page`, `publish_cost` and `stream::batch_bytes`.
  2. `write_text` (`lib.rs:358`) calls `number_text(*n)`, which allocates a fresh `String` for **every number** in every serialized JSON document instead of writing `ryu_js::Buffer::new().format_finite(*n)` directly into `out: &mut String`.
  3. `write_canonical` (`lib.rs:383`) allocates a `Vec<&(String, Json)>` for every object, even 2–4 field objects (`Principal`, `RequestRef`, `HybridClock`).
- **Lever:**
  1. Implement `Json::json_bytes(&self) -> usize` as a pure arithmetic/visitor pass (summing escaped string byte lengths, `ryu_js::Buffer` slice lengths, colons and commas with **zero** heap allocations).
  2. Write `ryu_js::Buffer` slices straight into `out: &mut String` in `write_text`.
  3. Use a stack `SmallVec<[&(String, Json); 16]>` (or stack array for `<= 16` keys) in `write_canonical`.

### O3 (Medium/High — Space Write & Read Scaling): Incremental `Entries` Byte Memo and `overhead_bytes` Tallies

- **Where:** `rust/phi-core/src/state.rs:171-227` and `rust/phi-core/src/space.rs:839-864, 1873`.
- **Finding:**
  1. `Entries::changed()` (`state.rs:171`) wipes `memo.bytes = None` and clears the entire `memo.types` bucket map on every `push`, `remove`, `retain` and `get_mut`. In mixed read/write workloads (e.g. `spaces-mmo` regions with 3,000–4,000 entries), every `write` forces the very next `write` (`entry_bytes()` at `space.rs:1869`) to scan all N entries again, and forces the next typed `read`/`count` to rebuild `of_type` over all N entries.
  2. `Space::overhead_bytes()` (`space.rs:852`) re-serializes `regs`, `waiters`, `txns`, `runGates`, `jobs` and `mailboxes` (`Mailbox` structs cloned at `mailbox.rs:263`) to JSON text on **every** `Space::write`.
- **Lever:**
  1. Update `memo.bytes` incrementally in `Entries::push` / `remove` / `get_mut` when `e.size` is known (invalidate only if `size` is `None`), keeping `entry_bytes()` O(1) across writes.
  2. Maintain per-type index sets or invalidate only the affected `e.types` buckets on `push`/`remove`, and untouched `types` on `get_mut` (since an entry's `types` are immutable after creation!). Because `get_mut` (lease renewal, `taken_by`, `read_by`, `written_under`) **never** changes `e.types` or array indices, `Entries::get_mut` does not need to invalidate `memo.types` at all, and only changes `memo.bytes` if `fields`/`size` changed!
  3. Cache byte tallies for `regs`, `waiters`, `txns` and `jobs` (as already done for `stream.bytes`, `rpc.bytes` and `outbox_bytes`), and compute `mailboxes_bytes` without cloning `Mailbox` structs (`mailbox.rs:258-265`).

### O4 (Medium — Primary/Sync & Store Commit Path): Eliminate Redundant Batch Re-Serialization and Mutex Overhead

- **Where:** `rust/phi-store/src/primary.rs:57, 134, 149`, `sync.rs:260, 286, 328, 344`, `host.rs:546`, `disk.rs:24`.
- **Finding:**
  1. On a primary/sync store, a single batch of `WriteOp`s is converted to `Json` and serialized/parsed 4–5 times before reaching SQLite (`PrimaryGate::admit` -> `delta_bytes`; `Primary::seal_batch` -> `deltas` + `hash`; `SyncJournal::seal` -> `copy` (`parse(&canonical(v))`) + `hash` + `validate` -> `canonical` + two SHA-256 hashes; `SignedReplicaPeer::accept` -> `copy` + canonical signature).
  2. `SqliteClaims::open` (`phi-store/src/disk.rs:24`) opens its SQLite connection with default flags (full SQLite internal mutex) and wraps it in a `std::sync::Mutex<Connection>`, even though `Space` is strictly single-threaded (`OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX` + `RefCell` avoids double locking on every claim lookup).
- **Lever:** Carry pre-encoded delta JSON text/bytes from `PrimaryGate::admit` into `Writer` so `seal_batch` hashes and seals without rebuilding/reparsing `Json` trees; replace `parse(&canonical(v))` (`sync::copy`) with an in-memory key-sorting clone (`Json::canonical_clone`); open `SqliteClaims` read-only with `NO_MUTEX`.

### O5 (Medium — Federation Root & Entry Replication): Concurrency and Materialization Caching

- **Where:** `rust/phi-host/src/root.rs:454`, `rust/phi-service/src/entry.rs:242-280`, `rust/phi-service/src/lib.rs:1098`, `rust/phi-spaces-client/src/socket.rs:204`.
- **Finding:**
  1. **Root mutex (`phi-host/src/root.rs`):** `Root` holds a single `tokio::sync::Mutex<FederatedSpace>` across the entire duration of a `root*` call, so a blocking `rootTakeWaiting` / `rootReadWaiting` serializes all other Root calls (already noted as deferred in `rust-review-2026-11-07.en.md`, still open if Root concurrency grows).
  2. **Entry replication (`phi-service/src/entry.rs` & `lib.rs:1098`):** Every `merge_call` `read`, `readAll` or `count` calls `m.controller.read(&self.store)`, which clones the cached state document (`Json`) and re-runs full event materialization + erasure fixpoint on every read even when no local write or stream import occurred since the last read. Caching the materialized `Rc<Vec<Json>>` keyed by `(state_seq, erasure_count, expired_watermark)` makes repeated merge reads O(matches) instead of O(history).
  3. **Client socket writes (`phi-spaces-client/src/socket.rs:204`):** `out.write_all(&frame(id, &text))` allocates and copies `8 + text.len()` bytes per call; writing the 8-byte header + `text.as_bytes()` via `write_vectored` (or into a reusable buffer inside `Conn::writer`) removes one full payload copy per RPC.

### O6 (Unmeasured — Every Binary): No Release Profile (second pass)

- **Where:** `rust/Cargo.toml` (only `[profile.dev.package.*]` entries); the images build with `cargo build --release --locked` (`spaces-mmo/docker/Dockerfile:81`, `help-site/docker/Dockerfile:155`, `codemode-chat/docker/Dockerfile:77`, `test/testbed/local-federation/Dockerfile:8`), and nothing sets `CARGO_PROFILE_*` or `RUSTFLAGS`.
- **Finding:** The servers on `big` and `nano` run cargo's default release profile: no LTO across the eight crates and 16 codegen units. The hot path crosses crate borders on every call (`phi-wire` → `phi-service` → `phi-core` → `phi-json`), where only functions marked `#[inline]` or generic ones are inlined without LTO.
- **Lever:** `[profile.release]` with `lto = "thin"` (or `"fat"`) and `codegen-units = 1`, measured with `scripts/server-probe.ts` and `spaces-mmo/tests/perf/space-cost.ts` before it is kept; it lengthens the image build. `panic = "abort"` is not part of this: it changes what a panic on the writer thread or in a task does.

### O7 (Low/Medium — Lease Calls on Large Spaces): Linear Lookups by Id (second pass)

- **Where:** `rust/phi-core/src/space.rs:2474` (`leased`), `:840, 844, 868` (`reg_at`, `waiter_at`, `txn_at`), `rust/phi-core/src/state.rs:197` (`Entries::remove`).
- **Finding:** `leased` (every `renew` and `cancel`) finds its entry with `entries.iter().position(|e| e.id == id)`, a string comparison per entry, and then scans waiters, transactions and registrations as well. `Entries::remove` shifts the tail of the `Vec` and clones the removed record into the undo log.
- **Lever:** Only if a profile shows it (a region of `spaces-mmo` holds 3,000–4,000 entries, a keep-alive renews every third of its lease): an id → position index beside `Memo`, rebuilt as `of_type` is. Whether TypeScript does better here was not compared.

---

## 7. Summary Priority List

1. **Fix B1 (`phi-core/src/snapshot.rs`):** Bind `Record.snapshot_epoch` to `state.rest["snapshotEpoch"]` so principal erasure immediately invalidates cached snapshots, matching `src/snapshot.ts`.
2. **Fix B2 (`phi-store/src/host.rs`):** Check `self.space.restored_disk` in `SpaceHost::claim_failure()` so SQLite errors on `restoredClaims` abort the commit rather than silently admitting historical replays or skipping erasure pages.
3. **Fix B3 (`phi-spaces-client/src/socket.rs`):** Add a cancellation/timeout drop guard on `SocketTransport::call` so `RemoteSpace` call timeouts tear down stalled TCP connections and clean up `c.pending` entries, matching `src/socket.ts` + `src/remote.ts`.
4. **Fix B4 (`phi-core/src/admin.rs` + `src/data-admin.ts`):** Reset `outbox_bytes` (`outboxBytes`) when `erase_batch` removes outbox items, in lockstep across Rust and TypeScript.
5. **Quick-win optimizations O1 + O2 + O3 (`Entries::get_mut` bucket preservation):** Cache `installedRegisterFile` reads in `BootGuard`, make `Json::json_bytes` zero-allocation, write `ryu-js` buffers directly into `String`, and keep `Entries` type buckets across `get_mut` mutations (which never alter `EntryRec::types` or positions).
6. **Measure O6:** a release profile with LTO and one codegen unit is a change of four lines; the probe says whether it is worth the longer build.
7. **Duplicates (5.2):** the helpers with the same body (`num`, `text`, `set`, `value`/`version`, `with`, `names`, `cut`) belong once in `phi-json` or one `phi-host` module; `valid_id` as one function with its five rules named.
