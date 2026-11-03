# Porting phi-spaces to Rust

As of 2026-10-31. **Target and work plan.** R0 to R3 are implemented and accepted, R-D2 is met: The
Cargo workspace contains `phi-json`, `phi-core`, `phi-store`, `phi-service`, `phi-wire`, `phi-host` and `phi-space-server`, and both
projects run on the Rust server. Of R4 the local part is done. R5 and R5b are done and R5b was accepted on 2026-11-01; R6 has begun with its control host (section R6). **Decision 2026-10-31:** The
implementation is completed first; there is no partial port in operation; until then development and testing happen only locally.
`big`, `nano` and their interplay are simulated locally (`docker:local`, several containers and a network between them); every acceptance involving several hosts, replication, fencing or a phone gets such a simulation and does not stay open. The real move on the servers, R8.6 on the hosts and R-D12 come after that. R5b to R8 and M1 have not begun. The decisions R-D0 to R-D11 (section 9)
are made, R-D12 and R-D13 are open and are not approvals.

## 1. Result and scope

The goal is a Space server in Rust. From outside it cannot be told apart from today's `src/standalone.ts`: same
wire protocol, same SQLite file and same semantics. After that the host runtime follows step by step
(gate, auth, enrollment, grants, supervisor). A federation-capable member additionally needs R5b; root federation,
replication and recovery are reserved for R6 and come last or not at all.

**What is ported is `src/`** (≈ 18,000 lines of TypeScript), in this order:

1. Core (`core.ts` and its helpers)
2. phi-spaces store (`store/`)
3. Service and transport (`service.ts`, `socket.ts`, `standalone.ts`)
4. Security layer
5. Operational building blocks

**Not ported:**

| Part | Reason |
|---|---|
| `agent/` | depends on pi-durable, chord and pi-ai, all three exist only in TypeScript |
| Web parts of `codemode-chat/` and `spaces-mmo/` (Next.js, React, PixiJS, three) | browser code; spaces-mmo delivers the page statically in R8 |
| Model process of spaces-mmo (`server/model-host.ts`, `server/llm.ts`) | model calls via pi-ai and the same credentials as `agent/` |
| Server processes of `codemode-chat/` | application *on* phi-spaces; stays a client via `RemoteSpace` |
| `codemode-chat` execution of submissions | pi-codemode executes JavaScript |
| `help-site/` | documentation site |

**Additionally ported (R8):** the server processes of spaces-mmo, namely world, npc and web with accounts, gateway and
chat (about 7,000 lines in `spaces-mmo/server/`). The Space process (`space-host.ts`) is already replaced in R3.

**The TypeScript client stays:**

- `RemoteSpace`, `src/space-client.ts` and `phi-spaces/ws` stay in TypeScript and the public package for the
  projects.
- The package `phi-spaces` therefore loses nothing. It only gets a second server that can run behind the same address.
- A Rust client (`phi-spaces-client` crate) comes first for the tests (section 5). In R8 it becomes
  complete, because the Rust processes of spaces-mmo need it.

## 2. Why the seam lies at the socket

Today the projects reach the Space only through the address of a process of its own:

- **Access:** `connectSpace` (`spaces-mmo/server/space.ts`, `codemode-chat/server/index.ts`) returns a
  `SpaceLike` over `RemoteSpace`.
- **Server:** Only the `space-host.ts` of both projects start `serveSpace(new SpaceService(...))`.
- **Frame on the wire** (`src/socket.ts`): u32 length, u32 call id (big endian), then UTF-8 JSON. Calls
  run in parallel per connection, and the reply carries the id of its call.
- **Methods:** Dispatch is in `SpaceService` (`src/service.ts`, the `switch` from `hello` on): `hello`,
  `generation`, `write`, `read`, `take`, `pollOperation`, `resolveOperation`, `cancelOperation`, `readAll`, `count`,
  `stats`, `batch`, `spaces`, `txn`, `lease`, `changes`, `notify`, `wait`, `events`, `ack`. The commands of the
  control plane are answered by upstream host services only in R5/R5b/R6, not by the standalone service.

This lets the port be pulled forward as a "strangler":

- A Rust binary `phi-space-server --store FILE|memory --listen unix:…|tcp:…` replaces `npm run space-server`.
- Later it also replaces the `space-host` process of a project, with its start profile from R3.
- The functional clients do not change; start scripts, test fixtures and the project bootstrap are adapted.
- Every stage has a checked way back on the same file within its approved version pair and
  rollback window (R4/R8). The file format alone does not guarantee functional backward compatibility.

## 3. Unchanged contracts (byte-exact)

The Rust side must hit these points bit for bit. For each point, phase R0 produces golden vectors from the
TypeScript implementation.

| Contract | Place today | Pitfall |
|---|---|---|
| Canonical JSON (modeled on RFC 8785) | `src/canonical.ts` | The yardstick is the TS behavior, including unpaired surrogates (see below). Keys sorted by **UTF-16 code units**, not by UTF-8 bytes. Numbers in **ECMAScript form** (`1` instead of `1.0`, exponent from 1e21, `-0` → `0`). `serde_json` and `ryu` do not deliver this by themselves |
| Digests | `digestJson` (SHA-256 hex over canonical JSON) | argument, command and binding hashes; request ids in the journal |
| Generations | `claims.ts` (`nonce.HMAC-SHA256(signingKey, canonicalJson({nonce, …rec}))`) | Stored claims must stay valid after the switch; otherwise all running requests expire |
| Numbers | `core.ts`: `FOREVER = Number.MAX_SAFE_INTEGER`, times in ms as JS number | All JSON numbers are evaluated as IEEE-754 doubles as in JS (`phi-json`: `f64`), even when the input text shows an integer. `FOREVER` must come back exactly; `until()` must not overflow |
| JSON values | `Json`/`Fields` in `core.ts` | Templates compare recursively with `core.deepEqual`: object key order does not matter, array order does. Serialization and byte counting, by contrast, follow `JSON.stringify`, including JS property order (index keys first); `preserve_order` alone is not enough |
| Keys | `auth.ts`, `grants.ts`, `enroll.ts` | Ed25519 as raw 32 bytes; ECDSA P-256 as SPKI DER with DER signature (Android keystore); fingerprint = SHA-256 of the Base64-decoded bytes, 32 hex characters |
| SQLite format | `store/sqlite.ts` | Tables `store_meta`, `documents`, `parts` (STRICT), indexes `parts_order`, `parts_at`, `parts_grp`, `parts_open`; `value` is JSON text; document version 5; format number 2 in `store_meta`; WAL; lock file `<file>.owner` |
| Errors | `service.ts` (`fail("StaleEpoch", …)` etc.) | Error names and fields are contract; `RemoteSpace` branches on them (retry, `RequestExpired`) |
| Limits | `DEFAULT_LIMITS` in `core.ts` | frame size, result budget (`frameBytes - 64`), quotas, `jsonBytes` counting (UTF-8 bytes of the `JSON.stringify`) |

**Decision R-D1:** The Rust side reads and writes **the same SQLite file**. There is no additional
Rust-specific format change; existing format and document migrations and the supported versions
must nevertheless be checked. Before taking over, the server checks format, document versions and active features;
unsupported data it refuses before serving and before any functional change. A rejected open
must neither delete data nor create identities anew. The way back is additionally bound to R4/R8.
A format of its own with export/import would be a change of R-D1 and needs a new decision.

**Contract gap JS strings, closed (R-D10):** TS accepted lone surrogates; a Rust `String` cannot hold them.
Texts in the Space have been well-formed since R-D10; the service replaces a lone surrogate at the input with U+FFFD, and a
store with such a value is not opened. Parser limits and invalid UTF-8 are in the negative vectors.

## 4. Target architecture

A Cargo workspace `rust/` in the repository, next to `src/`:

| Crate | Content | corresponds to |
|---|---|---|
| `phi-json` | `Json` type, canonical JSON, `digest_json`, `json_bytes` | `canonical.ts`, `json.ts` |
| `phi-core` | pure semantics: entries, templates, leases, txns, notify, waiters, limits, revision log, claims, mailboxes, RunGate; `now` explicit, no I/O | `core.ts`, `claims.ts`, `stream.ts`, `mailbox.ts`, `paging.ts`, `snapshot.ts`, `member-admission.ts`, `doc.ts` |
| `phi-store` | host with commits on drafts, watches, SQLite ledger with writer thread, parts, `DISK_MAP` | `store/*` |
| `phi-service` | `SpaceService`, role/type checking, pending/poll, quotas, meter | `service.ts`, `spaces.ts`, `meter.ts`, `rpc-domain.ts` |
| `phi-wire` | frame, Unix/TCP server and client | `socket.ts`, parts of `remote.ts` |
| `phi-host` | gate, auth, enroll, grants, rotation, supervisor, runtime | `gate.ts`, `auth.ts`, `enroll.ts`, `grants.ts`, `rotation.ts`, `supervisor.ts`, `runtime.ts` |
| `phi-space-server` (bin) | CLI like `src/standalone.ts` | `standalone.ts` |

**Capabilities and dependencies:** A stage reached does not automatically approve the next.

| Stage | Prerequisite and mandatory scope | Not yet approved |
|---|---|---|
| R3 Standalone | R1/R2; all `METHODS`, claim resolution in the current epoch, cancel, background maintenance, completion profiles for correspondingly configured TS stores; `hello` reports only implemented capabilities | gate, federation member, restore and promotion |
| R3 Project host | additionally the unchanged functional bootstrap and the start profile from R3, with stable peer id | use without limits/lock initialization; public unprotected TCP operation |
| R5 Secure host | R3; gate, key proof, enrollment, grants, rotation and supervisor | routing delegation, member admission, run control; no blanket federation approval |
| R5b Federation member | R5; delegation check, membership/admission, RunGate and member instructions, boot/authority check | Rust root, replication, promotion and complete recovery from R6 |
| R6 Root/replication/recovery | R5b and a separate decision after R-D3; acceptance per operating mode | No inference from single operation to replicated operation |
| Mobile b) | own work package M1 (section 7), R3/R4; for a federated phone host additionally R5/R5b and the required R6 recovery paths | a mere cross-build or R4 alone is not an approval |

Before every acceptance, the concrete list of supported document versions, active features and operating modes
is recorded. A `NotPorted` on a mandatory function or a skipped mandatory test does not satisfy the acceptance.

**Transferring the TypeScript patterns:**

- **Drafts with copy-on-write** (`store/draft.ts`, proxies):
  - In Rust these become explicit working copies per commit: `im` structures or `Arc` plus cloning on first
    write.
  - Table parts get an undo log, as described in U2.
  - Late writing after the end of a commit ("revoked draft") becomes impossible through ownership instead of being checked at runtime.
- **`AsyncLocalStorage`** (`context.ts`, `store/host.ts`) becomes `tokio::task_local!` or an explicit
  context parameter. Explicit is preferable, because the core takes `now` explicitly anyway.
- **Commit order:**
  - One commit task per host serializes the state changes. Following commits may build on predecessors not yet
    durably written; waiting for each individual `fsync` must not defeat batching.
  - A writer thread of its own holds the SQLite connection (today `sqlite-writer.ts` in the worker).
  - Acknowledgment comes only after durable writing (`synchronous=FULL`). External snapshots and new watches
    wait for the running commits and their persistence; a snapshot inside a commit does not wait for itself.
  - Watches are woken only after persistence and summarize what happened during their listener.
    If persistence fails, the host refuses further work until reopening; an error in the
    commit callback or in `prepare`, by contrast, rolls back the draft (contract in `store/host.ts`).
- **`DISK_MAP`:** Claims on disk are queried in a targeted way, never enumerated. In Rust the type gets no
  iterator method at all, so the rule applies already at compile time.

**Crates (approved 2026-10-29, R-D0):**

| Purpose | Crates |
|---|---|
| Runtime, storage, JSON | `tokio`, `rusqlite` (bundled SQLite), `serde`/`serde_json` (`preserve_order`, `arbitrary_precision` off) |
| Canonical JSON | `ryu-js` for the ECMAScript number form, or an own implementation with vectors |
| Cryptography | `sha2`, `hmac`, `ed25519-dalek`, `p256` (ecdsa, DER) |
| Overlay and randomness | `rustls` (TLS register, fencing service), `rand`/`getrandom` |
| CLI and tests | `clap` (optional), `proptest` for differential tests |

## 5. Test strategy: the TypeScript tests as oracle

The ≈ 19,000 test lines in `test/` are the yardstick. They are not rewritten first, but pointed at the
Rust server.

**Group A: already runs through a process or socket.** Here a switch for the server command line suffices:

- `test/test-standalone.test.ts` starts `src/standalone.ts` with `spawn`. If `PHI_SPACES_SERVER_CMD` is set (e.g.
  `rust/target/release/phi-space-server`), it starts that command instead (since R0). The
  examples `examples/sieve.ts` and `examples/cache.ts` with `--remote` also run in it.
- `test/test-socket.test.ts`, by contrast, starts its server in the test process (`serveSpace`). It therefore belongs to
  group B and gets the fixture from R3.

**Group B: service in-process, client via `RemoteSpace`.** This includes `test-remote`, `test-service`, `test-gate`,
`test-auth`, `test-enroll` and `test-scenario`.

- **B3 (R3):** the standalone/service cases from `test-remote`, `test-service`, `test-socket` and `test-scenario`,
  including role/type checking with test identities. **B5 (R5):** gate, auth, enrollment and other cases
  that presuppose the security layer. Federation cases are assigned only to R5b/R6.
- A shared fixture in `test/support/` provides two variants depending on the environment:
  - the in-process `SpaceService` with loopback transport,
  - or an address of a started Rust server.
- Tests that reach into the service (set the clock, read the store directly) need a test RPC for that.
- The test RPC is active only with `--test-hooks` and sets the clock, opens and closes anew and reads the
  store extract.
  It runs on a separate local channel, never on the normal TCP/gate listener. In the production start profile
  it is switched off; negative tests check that these interventions are not reachable there.
- The fixture also needs controlled identities, policy/limit configuration and fault points for
  transport and store. A server address alone does not replace tests with direct access to these objects.
- A case matrix names per suite/test the target phase, Rust fixture and status. B5/R5b/R6 cases stay explicitly open
  in R3; unexpected skips or a fallback to the TS server make the Rust acceptance fail.

**Group C: core and store tests directly on TypeScript objects.** This includes `test-core`, `test-claims`,
`test-stream`, `test-own-store` and `test-persistence`.

- These tests are not moved.
- A **differential harness** plays fixed regression sequences as well as seeded random sequences against both cores:
  the TS core behind a stdin/stdout driver, the Rust core natively. The own stateful generator from R1
  currently takes the role of `proptest`.
- Result, errors and following state are compared canonically per step. In addition, targeted vectors check
  `JSON.stringify` text, property order and byte count; a canonical hash alone cannot check the order.
- The store acceptance from R2 also reproduces persistence, overlapping commits and errors. A test on TS objects that stayed green
  is no evidence for the Rust store.

**Golden vectors (R0):** canonical JSON, in particular numbers, surrogate pairs and key sorting, plus
digests, generations, signatures of both algorithms and SQLite files. The SQLite files come from TS runs;
the Rust side must open them and answer the same.

**Cross operation:** In every phase TS writes a file, Rust opens it and continues working, then the other way round.
`test/support/persistent.ts` (crash/reopen) provides the template.

**Rust client:** The TS suites first check the TS client against both servers. For the Rust client, R8.1 adds
a JSONL driver or an equivalent cross-language adapter that runs the same client scenarios.
What is accepted is the matrix TS/Rust client against TS/Rust server; a server command switch does not swap a client.

## 6. Work packages

Every phase ends with typecheck and `npm test` (unchanged green, the TS server stays the default) as well as
`cargo test` / `cargo clippy` in the workspace. The acceptance named in each case is added.

### R0: Fix the contracts (TypeScript only)

**Work:**

- `docs/wire-protokoll.en.md`: every method with arguments, reply and errors, derived from `service.ts` and
  `remote.ts`.
- Golden vectors under `test/vectors/`, plus a script that produces them from TS.
- The recorder for core operations.
- `PHI_SPACES_SERVER_CMD` in the tests of group A.
- **Measure baseline:** `npm --prefix spaces-mmo run test:perf`, `tests/perf/space-cost.ts` (CPU ms per command in the
  Space process), memory need of the Space process on big and nano.

**Acceptance:** The vectors are checked in and reproducible, and the baseline numbers are in this document.

**Status R0 (2026-10-29):**

- **Protocol:** [wire-protokoll.en.md](wire-protokoll.en.md) describes command line, frame, envelope, roles,
  request identity, values, all methods from `METHODS`, error codes, limits and the store file.
- **Vectors:** `test/vectors/` with `canonical.json`, `crypto.json`, `wire.json` (one session with 48 calls,
  random values as placeholders), `store.sql` and `store.expected.json`. `npm run vectors` writes them from
  `test/vectors/build.ts`. `test/test-vectors.test.ts` (in `npm test`) checks them against the code. `canonical.json`,
  `wire.json` and `crypto.json` are the same on every run; the P-256 signatures are random, are verified and
  kept on rewriting as long as they are valid. The store files are fixed pieces: Every new store has new
  random ids, so only `npm run vectors -- --store` or a schema change rewrites them.
- **Recorder:** The session in `wire.json` records at service level (`runSession`, clock from outside). The
  driver for the pure core (operation sequences over stdin/stdout) comes with its counterpart in R1.
- **Test switch:** `PHI_SPACES_SERVER_CMD` in `test/test-standalone.test.ts`, checked with the TS server as an
  external command.
- **Probe:** `scripts/server-probe.ts` measures the Space server alone (CPU per call, RSS, response times); with
  `--cmd` later the Rust server.

**Baseline values** (this machine: Ryzen 7 3700X, 16 threads, Node 22.23; big and nano in the next paragraph):

| Measurement | Result |
|---|---|
| `server-probe`, SQLite, 8 clients, target 900 calls/s, 24,000 calls (write, read, take) | 666 calls/s (CPU-saturated, 122 %), **1.82 ms server CPU per call**, p50 8.4 ms, p95 24 ms, RSS 120 → 364 MB |
| same, target 300/s | 293/s, 2.79 ms CPU per call (fewer commits per write batch), p50 2.6 ms, p95 37 ms, RSS up to 297 MB |
| `server-probe`, memory store, target 900/s | **82 calls/s, 12.9 ms CPU per call**, p50 80 ms, RSS up to 240 MB |
| same, target 300/s | 66/s, 16.1 ms CPU per call |
| `space-cost.ts` (spaces-mmo, 50 bots, 60 s, Space on SQLite) | 1,383 commands (19.9/s), **15.9 ms Space CPU per player command**, Space process 32 % of one core, p50 21 ms, p95 43 ms, 27 timeouts |
| `test:perf` load (10 players, spaces-mmo) | 66.5 steps/s, step to reply p50 18 ms, p95 38 ms, p99 59 ms |

The spaces-mmo values come from the working state with uncommitted changes in `spaces-mmo/`. The latency test of
`test:perf` failed in the process ("Zu viele Befehle auf einmal").

**big and nano (2026-10-29, 23:25):** same probe, same parameters (SQLite, 8 clients, 400 rounds, target
300 calls/s, 9,600 calls). It ran in a throwaway container from the production image `phi-spaces-mmo:prod`
(Node 22.23, `--network none`, store in the container file system), next to the running services. On big the image was
one minute old (checkout `a0da835`), on nano 13 hours. Probe and container were removed afterwards.

| Machine | CPU | Load before | Server CPU per call | CPU share | p50 / p95 / p99 | RSS |
|---|---|---|---|---|---|---|
| local (for comparison, same parameters) | Ryzen 7 3700X, 16 threads | – | 2.24 ms | 0.67 | 1.9 / 7.0 / 12.2 ms | 122 → 235 MB |
| big | EPYC 9634 (VM), 8 cores, 16 GB | 2.4 | **1.47 ms** | 0.44 | 2.3 / 7.7 / 16.2 ms | 121 → 227 MB |
| nano | QEMU VM, 4 cores, 8 GB | 0.7 | **3.35 ms** | **1.00** | 11.4 / 30.4 / 43.1 ms | 122 → 236 MB |

On nano the Space server needs a whole core at 300 calls/s; it carries no more there. Because nano
carries the accounts Space and the codemode Space, nano is the machine where a port gains the most.

Running Space processes (`docker stats`, read only; three samples 20 s apart, the regions on big about
five minutes after a restart):

| Container | CPU | Memory |
|---|---|---|
| big `phi-spaces-mmo-space-west` / `-ost` / `-nord` / `-sued` | 12–31 % / 14–18 % / 9–14 % / 9–20 %, together 55–70 % of one core | 145–153 / 175 / 131 / 122 MB |
| big `phi-spaces-mmo-web` | 2 % | 100 MB |
| nano `phi-spaces-mmo-space` (accounts) | 1 % | 72 MB |
| nano `phi-spaces-codemode-space` | 8 % | 177 MB |

Every Space process starts with about 60 MB (the processes without a Space: model, npc, world 58–62 MB each, i.e. the
Node base load) and grows with its Space to 120–180 MB. A Rust process should need only a few MB at idle;
that is the second lever from R-D2 (memory), especially on nano with 8 GB.

**Findings from R0:**

1. **Memory store gets slow with the number of requests.** After 2,400 calls a call costs 1.7 ms CPU,
   after 24,000 calls 12.9 to 16 ms. With SQLite it stays at about 2 ms. Presumably the request results stored for 24 h
   grow along in the Space document, while SQLite keeps them as parts on disk. This already affects
   `--store memory` and `SPACES_MMO_MEM=1` today and is to be clarified before R2: The Rust store should not inherit it.
2. **`timeoutMs: null`** gives the default 0 in the service, but −1 in `rpcDomain`, i.e. a different argument hash
   ([wire-protokoll.en.md](wire-protokoll.en.md), section 5). `RemoteSpace` does not send `null`; the Rust side follows
   the TS behavior for now.
3. **R-D2 is a measurement procedure, not a fixed number.** The run at 900/s was CPU-saturated, and a saturated
   server batches more commits; this lowers the CPU per call (1.82 ms versus 2.79 ms at 300/s). For R-D2 therefore:
   - same machine and source state, documented release builds, SQLite with `synchronous=FULL`, same
     limits, retention and load data; TS and Rust each open an identically prefilled store copy;
   - per machine a fixed rate **below the saturation of both variants**, determined beforehand in a trial run.
     300/s is already saturated on nano according to the measurement above and is not an unsaturated comparison point there;
   - `server-probe --cmd` for TS and Rust with warm-up and at least three measurement pairs in alternating order;
     report CPU per successful call, RSS at idle/under sustained load, p50/p95/p99 and error/timeout rates;
   - 1024 calls/s per peer is the standalone default, not a universal upper bound: The project hosts allow
     50,000/s. The respective profile stays the same on both sides; rejected calls do not count as throughput;
   - spaces-mmo (`space-cost.ts`) likewise: measured anew with TS and Rust side by side, not against this table, because
     the game keeps developing until then (R-D8). The process measurement also captures the Rust binary reliably,
     instead of searching only for `server/space-host.ts` in the command line.
   - R-D2 remains the existing basic decision. Minimum memory gain and permissible latency/error-rate regressions
     are to be set before the R3 acceptance (R-D11); an arbitrarily small RSS gain alone is not a reliable approval.

### R1: `phi-json` and `phi-core`

**Work:**

- Canonical JSON and the number rules.
- The pure core with claims, stream and mailbox; RunGate and member admission are completed in R5b.
- Goal: no I/O and no implicit clock; `now`, necessary clock accesses and randomness are injectable. The
  implicit TS clock accesses that still exist are documented below, not yet fixed.

**Acceptance:**

- The JSON/hash golden vectors match without silent exceptions; R-D10 is resolved.
- The differential harness replays the fixed regression sequences without errors.
- The stateful generator finds no deviation from the TS core in 10⁶ random steps; seed,
  source state and tested scope of functions are recorded. `proptest` remains an approved alternative.

**Acceptance status (2026-10-30):** All slices 0–6 are done, R-D10 is decided.

- **Golden vectors:** `phi-json` reproduces the supported values from `canonical.json` and the hash parts of
  `crypto.json`; an unpaired surrogate is refused according to R-D10, repaired in the text of a call. `wire.json` and the store files
  are checked only by R3/R2; they belong to the service and the store, not to the core.
- **Recorded sequences:** There are no specially recorded sequences. Their role is taken by the fixed sequences of
  `tests/boundaries.rs` (every budget limit, retention, eviction) and `tests/state_round_trip.rs`. Both run
  against the TS driver and are green.
- **10⁶ random steps:** A seeded random walk with 10⁶ steps (`PHI_CORE_WALK_STEPS=1000000`, `--release`,
  1,364 s) found no deviation in reply, error or state hash. Instead of `proptest`, an own seeded
  generator runs: It produces sequences with state (ids, generations, keys, cursors from the replies), and every seed is
  repeatable (`PHI_CORE_WALK_SEED`). The shrinking that `proptest` would bring helps little against a process with state;
  on a deviation the walk shows the step and the paths where the states differ. If it should be `proptest`
  after all, it is approved (R-D0).
- **Not in the core:** What is deferred (see below), the Rust core refuses with `NotPorted` before it changes anything.

**Cut (2026-10-29):** R1 runs over several sessions, in slices. Each slice is committed when the comparison tests against
the TS driver are green.

| Slice | Content | Status |
|---|---|---|
| 0 | `phi-json`; TS driver `test/support/core-driver.ts`; state model `phi-core::state` with round-trip check | done |
| 1 | Entries, templates, leases, `settle`, expiry, stream entries, budgets (`charge`, `jsonBytes` sums); plus `count`, `list`, `listPage`, `changes`, `stats`, `nextExpiry` without txn | done |
| 2 | Transactions: `createTxn`, `commitTxn`, `abortTxn`, expiry in `settle`, txn leases, writing, `announce`, reading and taking under a txn, reservations | done |
| 3 | Waiters, parked operations, claims and generations; their events in the outbox and fanout jobs without consumer | done |
| 4 | Notify and mailboxes: subscriptions with throttling and batching, consumers for subscriptions and waiters, fanout jobs with consumer, release of expired takes | done |
| 5 | Snapshots (`snapshot.ts`) with page token; stream and pages under txns came already with slice 2 | done |
| 6 | Contract gaps before R3: `cancelRequest`, `releaseTxn`, `setLimits`, completion profiles, JS strings (R-D10) | done |

**Deliberately deferred:** restore, change of authority, member admission, deletion, admin maintenance, `purgeTasks`,
RunGate and negative claims. Member admission and RunGate are mandatory for R5b, the other extensions belong
to R6. Until then `phi-core::state` carries their fields along unchanged (`rest`); active, not yet supported
features are refused by the Rust server already when taking over a store.

**Cannot be postponed until after R3:** `cancelOperation` calls `claims.cancelRequest`; background delivery
uses `releaseTxn` for undeliverable take events. The project hosts need `setLimits` for their
bootstrap. Completion profiles belong to the TS `hello` capability and to taking over correspondingly configured
standalone stores. These paths are added in slice 6, not treated as accepted through `NotPorted`.

**Status slice 6 (2026-10-30):** `cancelRequest`, `releaseTxn`, `setLimits` and `setCompletionProfiles` are in the
core, in the driver and in the random walk.

- **Completion profiles:** A taken task is held under its transaction (`takenTasks`), its deadline
  limits the lease (`completionDeadline`), the commit checks the results. Waiting requests without a transaction
  also fail with `CompletionViolation`.
- **Locked until R5b:** A profile with `gateField` needs RunGates. `setCompletionProfiles` rejects it with `NotPorted`,
  and an existing document with such a profile is not served.
- **`setLimits`:** All checks against the existing data are there. The values of both project hosts run as a fixed test.
  One deviation remains: JavaScript's `k in DEFAULT_LIMITS` also takes inherited names such as `toString`, Rust does not. That
  is host code and affects no caller.
- **Tests:** A walk of 60,000 steps through the core and one of 4,000 through both stores found no
  deviation. A document that the TS store wrote with profile, limits, open task and waiting request is read by
  the Rust store with the same hash and worked off to the end.
- **Negative check:** 14 built-in faults are caught in `tests/boundaries.rs`. Two survived at first and got their own
  cases: a release that has to go into the queue, and the serving afterwards. The edge of `maxResultBytes` got
  its own case as well.

**Evidence for R-D10 (2026-10-30):**

- **The case is reachable:** `spaces-mmo/server/chat.ts` (`#report`, `text.slice(0, 1000)`) and `npc/minds.ts`
  (`remember`, `note.trim().slice(0, 300)`) cut by UTF-16 units and write the result into entries. An
  emoji at the cut leaves a lone surrogate.
- **Consequence today:** The TS server accepts such a text. The Rust server answers the write with `BadRequest`, and a
  file containing such a value it does not open.
- **Data:** None of the files read contains such a value: four local ones (3,119 rows) and all on big and nano
  (about 374,000 rows in nine files, read only). What counts for the move is the scan immediately before it (R4).

**Implementation of R-D10 (2026-10-30):** The TS service makes texts well-formed at the input, keys too; a call
without a suspicious escape costs only a regex over the text. Rust has `parse_repairing` for this, and `parse` stays strict for
stored values. `canonical.json` (`wellFormed`) and `wire.json` keep both sides equal. spaces-mmo now cuts
stored text with `cutText`: report, NPC memory, input line, `say` and `emote`. Error messages
keep cutting with `slice`, where the repair at the input takes effect.

**Driver and state:**

- **One commit per line:** The driver takes one operation per line and brackets it with `core.beginCommit` like `spaces.ts`.
- **Fixed clock:** The clock is the `now` of the line, also for `Date.now`.
- **Fixed randomness:** `crypto.randomBytes` is a counter stream from the start value. It is passed through
  `syncBuiltinESMExports` into the named imports too, so that nonces, keys and mailbox epochs are the same on
  both sides.
- **Reply:** Each step returns the SHA-256 of the canonical state, on request the whole state too.
- **Rust model:** Every field not yet ported sits in `rest`. Missing and `null` fields remain
  distinguished, because the budgets count in `JSON.stringify` bytes. The check `state_round_trip` keeps
  the canonical form and byte count of every state equal.

**Status slice 1 (2026-10-30):**

- **`phi-core::space`:** A `Space` holds the document and what `core.ts` keeps in WeakMaps next to it: the open
  batch of the running commit, its byte budget and the expiry watermark. The watermark is semantics, not only
  speed: `nextExpiry` answers from it, and it can be stale-low (a taken entry leaves it standing).
  Without living entries it is `Infinity`, and `nextExpiry` then returns `null`.
- **`phi-core::stream`:** `touch`, `record`, `collect` like `stream.ts`, with the same running byte sum.
- **`phi-core::driver`:** the same lines as `core-driver.ts`, on the Rust core.
- **Order:** The checks stand in the order of the TS core, also after `settle`. The driver rolls nothing
  back, so an error keeps what `settle` already did (expiry, `del`, batch, `maintenance`).
- **Refusal:** A document whose `rest` holds more than empty `regs`, `waiters`, `outbox` (since slice 2 also `txns`) and
  `maintenance`, and arguments in shapes that JavaScript would read through coercions (non-strings in `types`, templates
  without an object), the Rust core answers with `NotPorted` before it changes anything. The list is a positive list.
- **Differential test `tests/differential.rs`:** Random walks with their own seed and small limits per walk
  (`maxCommitBytes`, `maxLogBytes`, `maxEntryBytes`, …), so that refusals, deferred expiry and discarded
  batches occur. It compares reply, error class with message and state hash per step. It counts the
  outcomes and fails if one never occurred. On a deviation it replays both cores up to that step
  and shows the paths where the states differ. Default: 12,000 steps,
  `PHI_CORE_WALK_STEPS` for more. A run with 200,000 steps (`--release`) was free of deviations. The seeded walk
  stands in for the `proptest` run of the acceptance (see "Acceptance status").
- **Boundary test `tests/boundaries.rs`:** A random walk rarely hits the one byte at which a limit tips. Per budget
  the Rust core searches the tipping point of a parameterized sequence (filler bytes or the limit itself), and both cores run
  there and at two values beside it. Filler bytes alone are not enough, because a field counts in entry and `put`, i.e. in
  steps of two bytes.
- **Negative check:** Built-in faults by one byte or one comparison (`>` instead of `>=` at `maxEntryBytes`,
  `maxSpaceBytes`, outbox, page budget, `maxLogBytes`; 127 instead of 128 expiry cost; the comma in the batch) fail
  in at least one test. Undetected remains the exact recomputation at exactly `maxLogBytes`. It is
  equivalent as long as the running sum is right.

**Status slice 2 (2026-10-30):**

- **Model:** `phi-core::state` keeps the transactions typed (`TxnRec`: lease, owner, `reserved`,
  `announced`), in the order in which they were opened. That is the order of `Object.values` and thus
  the one in which txns that expire at the same time are aborted.
- **Ports:** `finish` (commit and abort, backwards over the entries, published writes in write order,
  returned takes in reverse), the txn expiry in `settle` (first the entries up to the expiry of the txn, then its
  abort at that time), `reserve` against a txn and the sum of all reservations against `maxJobBytes`.
- **A subtlety:** `createTxn` draws the id before the lease; an invalid lease consumes it anyway.
- **Refusal:** A txn with completion profile, taken tasks, run binding or origin claim
  (`completion`, `takenTasks`, `runs`, `originRequestKey`, `completionDeadline`) the Rust core answers with
  `NotPorted`.
- **Tests:** The random walk opens, uses, extends, aborts and commits txns. The boundary test checks the
  reservation of writes and takes, a commit whose own `settle` first lets entries expire (it then fails
  at `maxCommitBytes`), an expired txn at the commit budget, two txns expiring at the same time and
  `maxJobBytes` over several txns. A run with 200,000 steps (`--release`) was free of deviations.
- **Negative check:** Built-in faults are detected: no reversal of the writes, `returned` not counted, without
  commit cost, `<=` on simultaneous expiry, without the sum of reservations, abort at the wrong time, id after the
  lease, no `announced`, reservation also for own writes. Undetected remains only a case that cannot occur:
  a take on an entry that another txn wrote.

**Status slice 3 (2026-10-30):**

- **Model:** `WaiterRec` and `RpcState` are typed. Claims and generations remain the JSON records of the TS core,
  in the order in which they came.
- **`phi-core::claims`:** `issueGeneration` (HMAC over the canonical form, key and nonce from the randomness source
  of the Space), `admit`, `decide`, `lookup` and the bounded sweep (128 bytes per record, keys in UTF-16 order,
  `sweepAt`).
- **Randomness:** The Space gets a randomness source. The driver gives it the same seeded stream as `core-driver.ts`,
  so that keys, nonces and generations are the same on both sides.
- **Waiters:** `addWaiter` with `refreshReservations`, `cancelWaiter`, leases on waiters, `serve` for waiters with
  and without claim (a take under a fresh txn that remembers the key of a `wait` request), expiry with
  timeout event or decision, `publishCost` with the events of matching waiters, event limits on
  writing (`checkEventSize`, `preflightFanout`).
- **Outbox and jobs:** Events go into the outbox. A concluding event that no longer fits waits in
  a fanout job, and `runJobs` continues it. Consumers and mailboxes come with slice 4.
- **`settle`** can now fail (a result above its reservation, an event that is too large). The error goes
  to the operation as in the TS core, after what had happened up to then.
- **Driver:** `core-driver.ts` got the line `park` (`parkOperation`), the Rust side the same.
- **Tests:** The random walk sets up waiters, parks requests and plays short episodes of a request (generation,
  admission, parking or deciding, repetition, query). The generations are mostly those of the own principal
  and fresh, otherwise almost everything runs into `RequestExpired`. Edge cases: waiters and claims expiring at the same time
  at the commit budget, retention at its edges (the result expires exactly at `admitUntil`) and the txn of a
  served `wait`. A run with 200,000 steps (`--release`) was free of deviations.
- **Negative check:** Built-in faults in cost, expiry order, `ifExists`, `serve` after abort, jobs,
  reservations, lease duration, sweep order and bounds, claim bytes and end of admission fail. Equivalent
  and undetected remain `sweepAt` `now` instead of `now + 1` (times are whole milliseconds) and the recounting of
  txns without a reservation (they write nothing).

**Status slice 4 (2026-10-30):**

- **Model:** `RegRec` and `Mailbox` are typed, the mailboxes in the order in which they came into being.
- **Subscriptions:** `notify` (also under a txn), events on writing and on commit (`notifyWrite`, `emit`),
  the throttling per conversation with counted writes sent on batched (`flushRegs`), expiry (the open
  batch still goes out, a consumer gets `registrationClosed`), cancelling, extending and the end with the txn.
  `publishCost`, `checkEventSize`, `refreshReservations` and `preflightFanout` count the subscriptions along.
- **`phi-core::mailbox`:** mailboxes per principal (`box`, `appendMail`, capacity, batch check on writing),
  pages (`events`) with epoch and gap, `ack` and the bounded maintenance that removes acknowledged and expired
  items. An expired take event puts its txn into the release queue, `settle` aborts it.
- **Jobs with consumer:** A concluding event for a consumer always goes through a fanout job; `runJobs`
  delivers into the mailbox as soon as it has room, and an `ack` makes waiting jobs of the principal due at once.
- **Clock:** Where the TS core itself reads `Date.now()` (a new mailbox, an `ack`), the Rust core reads
  `Space::clock`; the driver sets it, like `core-driver.ts`, to the `now` of the line.
- **Tests:** The random walk subscribes (with and without consumer), gives waiters consumers, pages, appends and
  acknowledges. Short subscription episodes write several matching entries closely one after another, otherwise no
  batching occurs. Edge cases: throttling at exactly one interval, a subscription with an open batch at the
  commit budget, a txn subscription at the outbox limit, `maxMailboxBytes`, mailboxes in `maxDocBytes` and a job
  that an `ack` triggers again. A run with 200,000 steps (`--release`) was free of deviations.
- **Negative check:** Built-in faults in interval limit, batch counter, expiry cost, txn reservation, pre-check under
  txn, jobs with consumer, retrigger after `ack`, cursor, mailbox capacity, TTL, gap and mailbox bytes fail.
- **Equivalent and undetected:** the batch count on writing (`flushRegs` already empties open batches in the `settle`
  of the same operation), duplicate entries of the release queue (processed in the same round), the
  gap check on `ack` (always contiguous prefixes are acknowledged) and `nextExpiry` 0 with a non-empty
  queue (it is emptied right after filling).

**Status slice 5 (2026-10-30):**

- **`phi-core::snapshot`:** A `Snapshots` cache per host, next to the document as in `snapshot.ts`. A reply that
  fits into a page needs no snapshot and no token. A larger one is copied once, its pages come
  via `ss<hex>.<position>` from the copy, bound to stream, principal and request. The cache is
  ordered by use; room is made first by those read to the end, then by the longest unused. Limits: `maxSnapshots`,
  `maxSnapshotBytes`, `snapshotTtlMs`.
- **Driver:** `core-driver.ts` got the line `snapshotPage` (one host per `init`), the Rust side the same.
- **Tests:** The random walk reads snapshot pages (with a foreign token, wrong cursor, other principal), and short
  episodes write several entries and follow the pages to the end. Edge cases: whole reply or snapshot, the
  TTL at exactly its expiry, the eviction order and `maxSnapshotBytes`.

**Finding from slice 0:** `parkOperation` (`core.ts`, `touch(s, Date.now())`) and `ackMailbox` (`mailbox.ts`) read
the clock themselves instead of taking `now`. The Rust core takes `now` as a parameter. In the TS core both places
should get `now`, so that repetitions with a fixed clock are deterministic.

### R2: `phi-store`

**Work:**

- Host with commit contract (4.1/4.2 from `umstellung-ohne-pi-durable.en.md`), parts, `DISK_MAP`.
- SQLite ledger with writer thread; storage mode `memory`.
- Preparation of the operational paths: backup/restore, compaction, clean closing and reopening.
  The request-dependent slowdown of `memory` observed in R0 gets a root cause analysis and a
  growing claim load case; a pure entries optimization does not automatically resolve this finding.

**Acceptance:**

- Cross operation with TS files.
- Crash/reopen as in `test/support/persistent.ts` and `test/test-own-store.test.ts`: SIGKILL before, during and
  after the SQL `COMMIT`, in particular after persistence before acknowledgment. Every acknowledged commit is kept;
  an unacknowledged one may be missing or fully present, never partially. Retries use the original
  request identity and produce no second effect. SIGKILL alone is no physical power-loss evidence.
- Fault points for full disk (`SQLITE_FULL`), writer failure and persistence errors: no success acknowledgment,
  no watch on non-durable state, host locked until reopen; what was already acknowledged is kept.
- Overlapping commits see the changes of their predecessors even before their persistence; external snapshots and
  watches see only durable state. Callback/`prepare` errors roll back the whole commit. Batching,
  watch batching and closing with waiting commits are checked separately.
- Backup during running writes, restore and continued writing, compaction between writer batches as well as
  owner lock/format/document version checks; Rust counterparts to `test/test-own-store-ops.test.ts`.
- The same rows in `documents`/`parts` after the same operations, compared canonically.

**Cut (2026-10-30):** R2 runs in slices like R1.

| Slice | Content | Status |
|---|---|---|
| 0 | Crate `phi-store`: open file (owner lock as in TS, WAL, schema, format 1→2), load document from head and part rows, row ops, writer thread with batches, memory ledger | done |
| 1 | Host: one commit per operation with rollback, part changes with `ord`; the Rust core in host mode (watermark, budget and open batch renewed per commit; claims as `DISK_MAP` with the disk branches of the TS core); TS store driver and random walk against it | done |
| 2 | Crash and reopening at the commit boundaries; write errors, full disk, writer failure and locked host after persistence error | done |
| 3 | Claims really on disk (read in a targeted way instead of held in memory), memory budget of the host | done except the memory budget (comes with the host for several Spaces, R3) |
| 4 | Backup/restore under load, compaction and shutdown; growing claim stock in SQLite and `memory` | done |

**Findings before slice 1:**

- **Claims on disk:** On SQLite, `rpc.claims` is a `DISK_MAP` from the first persisting on. The
  TS core thereby takes other branches than in the R1 driver: `docBytes`, `nextExpiry` (0 without `sweepAt`), `serve` (no search
  for the `originRequestKey` of a `wait` request), `previewOf` and the sweep (`disk.due` sorts via SQL by
  bytes, not by UTF-16, with limit and group filter). Slice 1 reproduces these branches. Only slice 3 loads
  the claims truly lazily.
- **Lifetime:** The host lets the core run on a new draft per commit, snapshots are new objects.
  Watermark, commit budget and open batch therefore begin anew per commit, and a failing operation is
  rolled back. The Rust host must do exactly the same.
- **Cost (measured 2026-10-30):** A copy of the entries and a comparison by value cost at 10,000 entries
  21 ms per commit (`--release`), against 1.5–3.4 ms server CPU per call in R0. The Rust Space therefore remembers what
  a commit changes in the parts (entries, claims, generations, stream batches), with an undo log for the
  rollback, and writes O(changes). The head is written whole per commit as in the TS store; its copy for
  the rollback costs the same O(head). The core changes the arrays only by appending, removing and replacing in
  place: exactly the case `alongside` in `parts.ts`, so the `ord` follow without comparison.
- **Old versions:** A document under the version of its definition (TS: `migrate`) is refused by the Rust store
  for now. Before R4 this is checked on store copies of the target applications; a necessary TS migration is a
  documented preparation step, not a silent Rust migration.

**Status slice 0 (2026-10-30):** `rusqlite` with bundled SQLite. `store.sql` is opened, every document
loaded and written to a new file that holds the same rows (`documents`, `parts`, `store_meta` without
store id, counters and index marks). The read session of the TS store on the Rust file answers exactly like
`store.expected.json`. TS and Rust store turn each other away through the same owner lock. The index columns of the
claims and the counter per batch (`commit_seq`) are checked specifically.

**Status slice 1 (2026-10-30):**

- **Changes instead of copies:** `phi-core` keeps the entries as its own type `Entries`, which changes only through methods
  with an undo log (append, remove, change in place). Claims and generations change
  via `claim_put`/`generation_put`, the stream functions return the discarded batches.
  `begin_tracked_commit` copies only the head (without entries, log and claims), `end_commit` returns the changes,
  `rollback` undoes them. The head is never serialized with its parts (`to_json_head`).
- **Host mode:** Per commit, watermark, budget and open batch begin anew, as on the draft of the TS host.
  `claims_on_disk` applies as soon as the RPC state is stored. The core thereby takes the disk branches: `docBytes`
  via the sum, `nextExpiry` 0 without `sweepAt`, no search for the key of a `wait` request in `serve`,
  and the sweep via `due`/`nextAt`.
- **`phi-store::SpaceHost`:** One commit per operation. If it fails, it is rolled back and nothing is written.
  If it succeeds, the head (only if it or a part changed) and the changed part rows go to the
  writer thread, acknowledged only after writing. The `ord` of the arrays follow the rule `alongside` with the
  growing maximum, as in `parts.ts`. A document of an older version (TS: `migrate`) is rejected.
- **Driver:** `test/support/store-driver.ts` plays the lines of `core-driver.ts` as commits of the
  `NamedSpace` document through the TS store (own SQLite file or memory). `core-driver.ts` exports `apply`,
  `install`, `reseed` and `tick` for this.
- **Check `phi-store/tests/store_walk.rs`:** The random walk from R1 (now `phi-core/tests/common/walk.rs`, used by
  both crates) runs through both hosts into one file each. Compared are reply and state hash per
  step and at the end the rows of both files (`documents`, `parts`, values canonical). Default is 2,000 steps,
  `PHI_STORE_WALK_STEPS` for more. The fsync per commit makes the walk slow (about 60 ms per step for both
  sides together).
- **Disk branches:** They hardly differ from the memory branch in the random walk. `docBytes` yields the same number,
  because the sum counts exactly the JSON bytes without brackets; `sweepAt` is always set; the sweep returns the same
  sets. Observable is only `serve`: A fixed case (`a_served_wait_with_its_claim_on_the_disk`) pins it down.
- **Negative check:** Detected are a wrong `ord` counter (the files differ), a watermark that
  stays across commits, a host without disk branch and a host without rollback.

**Status slice 2 (2026-10-30):**

- **Crash** (`phi-store/tests/crash.rs`, like `test/test-own-store.test.ts`): A child process (the test program
  itself, or `store-crash-child.ts`) commits pairs of entries until it is killed with SIGKILL. Killed at an
  arbitrary time, every acknowledged pair is there and none only half; Rust and TS store read the
  crashed file the same, also that of a TS child. Stopped before the `COMMIT` of the third batch
  (`PHI_SPACES_WRITER_PAUSE`, the switch of the TS writer), exactly the acknowledged commits are there; stopped after,
  the third is there, unacknowledged. The lock of the dead owner is free.
- **Write errors** (`tests/failures.rs`): full disk (`max_pages`, `SQLITE_FULL`), an error before the
  `COMMIT`, a lost reply after it and a vanished writer thread (`Fault`, like `StoreFaults` in the TS store).
  The failing commit is not acknowledged, the host accepts nothing more until reopening and does not even let the
  operation run, what was acknowledged is kept.
- **Repetition:** A request whose reply was lost (admission, effect and decision in one commit like
  `client.ts` `mutate`) is repeated under its original identity. It gets the stored result
  and has no second effect.
- **Negative check:** A writer that acknowledges before the `COMMIT` and a host that keeps working after the error
  fail.
- **Finding from the long store walk:** The TS draft changes map parts (claims, generations) in place and
  rolls back a failed commit by assignment (`draft.ts`). A key that the commit deleted stands
  afterwards at the end of the map instead of in its place. Later sweeps go by this order when the budget suffices only for
  a part. The Rust host now rolls back map parts the same way. After that, a store walk with
  20,000 steps (`--release`, 1,304 s) was free of deviations in replies, states and the rows of both files.
- **Overlapping commits** came with slice 4 (see there).

**Status slice 3 (2026-10-30):**

- **`Claims` in `phi-core`:** The claims are a map in memory or a disk part (`DiskClaims`, like
  `disk-map.ts`). The disk part holds only what is not yet durable, and the open claims (without `decidedAt`).
  Everything else it reads from the store through a `ClaimSource`: `get`, `due`, `nextAt`, `group`. The core chooses its
  branches by this kind, like `core.ts` by `diskMapOf`; the flag from slice 1 is dropped.
- **`phi-store::disk::SqliteClaims`:** The queries of `sqlite.ts` `#source` over a read connection of its own, with
  the same SQL texts. A loaded document gets a disk part at once; a map that is still in memory
  becomes one after its first durable commit (`DiskMap.adopt`). After every durable commit the disk part
  releases what was written (`settle`).
- **No enumeration:** Where the core would have to read the whole map (old states without sum, `assert_ported`, the search in
  `serve`), it takes, like TypeScript, the disk branch or reads only what lies in memory. `DiskClaims::entries`
  deliberately reads everything and counts along (`enumerations`).
- **Check `tests/claims_on_disk.rs`:** 600 claims are admitted and decided; memory holds none of them,
  no operation reads the whole map, the sweep cleans up in steps of 40 records (commit budget), and
  the same rows through the TS store give the same states. The store walk runs with the claims on disk.
- **Memory budget:** The TS host evicts documents that have been untouched the longest and reloads them on demand.
  The Rust host so far carries one Space document; the budget comes with the host for several Spaces (R3).
- **Finding:** A newly loaded document has its generations in the order of the SQL query (`ORDER BY part,
  ord`, with equal `ord` by key), not in insertion order. If a sweep suffices only for a part,
  it thus depends on whether the TS host evicted the document in between. The Rust host must use the same query
  when evicting, then the same holds for it.

**Status slice 4 (2026-10-30):**

- **Cause of the slowdown of `memory` (finding 1 from R0):** The assumption was only partly right. A profile in the
  slowed section shows 68 % in `pendingClaims` (`client.ts` `beginOperation` searches all claims per request),
  12 % in `finalize` (`draft.ts` runs over the stream log) and 11 % in `#weigh` (`host.ts` counts the map keys per
  commit). So these are O(claims) loops per call, not the size of the document. With SQLite they do not take effect,
  because there only the open claims are in memory. The TS code is unchanged, the finding still holds there.
- **The Rust store does not inherit this:** Claims in memory are `MemoryClaims` (access O(1) instead of the list in `Object`,
  order like a JavaScript object). `assert_ported` checks them only on loading. `pendingClaims` itself comes with R3.
- **Measurement (`tests/operations.rs`):** 200 requests, release build. SQLite in tmpfs: 28 ms at 1,000 claims, 38 ms at
  22,200; a run up to 40,000 claims stayed at 0.15 ms per request. The memory host stays equally flat (debug build:
  25 ms at 100, 27 ms at 3,300). On `/dev/md0` the same requests cost 3.9 to 5.8 ms: That is the disk
  (checkpoints), not the code. `PHI_STORE_GROW_DIR` chooses the directory, `PHI_STORE_CLAIMS` the stock.
- **Overlapping commits:** `SpaceHost::start_commit` hands over the rows without waiting; the next commit builds on it
  at once. `durable(seq)`, `committed()` and watches see only what is durable, `pump` takes in what was acknowledged. The host
  stays synchronous, Tokio is not needed yet; R3 must drive `pump`. Disk parts carry for this per entry the number
  of their commit (`stamp`), like `DiskMap`. A failed batch makes all overlapping commits fail, readers too.
- **Watches** report only durable commits, batched to the newest number. The value is read via `committed()`.
- **Batching and closing:** What arrives during a batch goes into the next (19 commits in one batch). `close`
  writes everything still in flight; afterwards the WAL is dissolved and the lock is free.
- **Backup/restore:** `backup` (`VACUUM INTO`) next to running writes yields a prefix of the commits, the integrity
  is right, and the copied state keeps writing without touching the original. Rust and TS store read it the same.
- **Compaction** runs as in the TS writer between two batches: the first time `VACUUM`, afterwards
  `incremental_vacuum`. Rows stay the same, the file shrinks to less than half.
- **Checks on opening:** Format 1→2 including filling the index columns, older document version, parts inline in the head and
  negative or restored claims. The Rust store refuses the last three instead of damaging the document; a
  head with inline parts would until then have lost data.
- **Store walk:** With an odd seed the commits run overlapping, the rows of both files must still be equal.
  A run with 8,000 steps (`--release`, 506 s) was free of deviations.
- **Negative check:** Without stamp, with a watch without notification, without batching and without inline check, one test fails each.
- **After slice 3** the store walk with 20,000 steps was free of deviations.
- **Remains for R3:** memory budget and several Spaces, `pendingClaims`, `migrate` of older documents, inline parts.

### R3: `phi-service`, `phi-wire`, `phi-space-server`

**Work:**

- All `METHODS` from section 2 and pending/poll, including `cancelOperation` and resolution in the current
  epoch. The paths named in R1 slice 6 and the JSON contract decision are prerequisites.
- Background service corresponding to `startService`: deadlines/leases even without incoming RPCs, claim maintenance,
  outbox delivery or its error/release paths, mailbox and fanout maintenance.
- Quotas (`maxCallsPerWindow`, `maxPendingPerPrincipal`, `maxPendingPerPeer`), `wakeOnCommit` and
  `maxInflightPerConnection`.
- Identity from the connection: fixed in standalone; TCP only on loopback or an equivalently sealed
  internal network. An integrated gate comes only in R5. Identity must never be taken from the call.
- Project start profiles with the same bootstrap semantics as the previous `space-host.ts`. Whether a thin
  TS wrapper executes the bootstrap or the Rust binary gets project profiles remains an implementation choice.
  Locks and limits are set up before the ready message; the general standalone default is kept.

**Mandatory matrix for the project start profiles** (derived from the host files, keep in sync on changes):

| Contract | spaces-mmo | codemode-chat |
|---|---|---|
| Stores/listeners | world and accounts separate; selection via `SPACES_MMO_SPACES`, region file names and the respective addresses; both roles startable together or separately | one store/listener; `CODEMODE_SQLITE`, `CODEMODE_LISTEN`, `CODEMODE_MEM` |
| Peer id | `peer-mmo-world` or `peer-mmo-web` | `peer-codemode` |
| Service quotas | 50,000 calls/window, 4096 pending per principal/peer, 1024 inflight/connection, `wakeOnCommit` | 50,000 calls/window, 4096 pending per principal/peer; other values as in the previous host |
| Space limits | owner limits 1000 each; claim retention and generation admission 10 min by default, log 512 KiB, the respective ENV overrides | owner limits 1000 each; other retention/log defaults as before |
| SQLite limits | `maxClaimBytes` 512 MiB, `maxDocBytes` 640 MiB | `maxClaimBytes` 1024 MiB, `maxDocBytes` 1280 MiB; `CODEMODE_MAX_CLAIM_MIB`/`CODEMODE_MAX_DOC_MIB` override them, invalid values and document ≤ claims abort the start |
| Bootstrap/operation | `NAMES_LOCK`, `WORLD_LOCK`, `NPC_LOCK` without duplicates; process presence; compaction with `SPACES_MMO_COMPACT_MS`; maintenance debounce as before | process presence, maintenance debounce as before |
| Starter contract | previous ENV selection, ready/error/shutdown behavior and metrics stay usable for launcher and tests | likewise for the codemode launcher and its tests |

Existing files keep store/host/Space ids, incarnation, signing keys and peer/owner bindings.
A test switch must not silently start the old TS host instead of the Rust server.

**Slices:**

| Slice | Content | Status |
|---|---|---|
| 0 | Core gaps via the driver: `needsMaintenance`, `pendingClaims` (targeted query, no enumeration), `resolveAdmission`, `readChain` | done |
| 1 | Store host with several documents in one commit: registry (with `hostKey`), default Space, named Spaces | done |
| 2 | `phi-service` synchronous: `handle_text` with injected clock and randomness, `wire.json` exact, seeded walk against a TS driver around `handleText`, reply byte-exact | done |
| 3 | Background: reaper, outbox decision table from `deliverEvents`, mailbox and claim maintenance | done |
| 4 | `phi-wire`, `phi-space-server`: one owner thread per store, replies only after `durable`, long polls, CLI and ready line like `standalone.ts` | done; `test-standalone` runs against the binary |
| 5 | Group A and B3 against the Rust server, `--test-hooks`, case matrix | done, matrix below |
| 6 | Start profiles, `SPACES_MMO_SPACE_SERVER`, `CODEMODE_SPACE_SERVER`; a missing binary aborts and never falls back to TS | done |
| 7 | TS→Rust→TS with open work, measurement per R-D2/R-D11 | done, measured values below |

**Measurement per R-D2/R-D11 (2026-10-31, this machine, TS against Rust each):**

| Load profile | CPU | p50 | p95 | p99 | RSS peak | Timeouts |
|---|---|---|---|---|---|---|
| `server-probe`, SQLite, 300/s | 2.04 → 0.35 ms per call | 1.49 → 0.36 ms | 6.04 → 1.06 ms | 13.3 → 1.74 ms | 257 → 28 MB | |
| `server-probe`, SQLite, target 900/s | 1.60 → 0.26 ms (729/s → 900/s) | 6.66 → 0.31 ms | 20.5 → 0.73 ms | 29.2 → 1.25 ms | 371 → 27 MB | |
| `server-probe`, memory, 7,200 calls | 3.14 → 0.61 ms | 19.6 → 0.68 ms | 44.9 → 12.0 ms | 60.2 → 18.4 ms | 179 → 31 MB | |
| `space-cost`, 50 figures, 60 s | 12.8 → 3.8 ms per command | 20 → 10 ms | 32–40 → 21 ms | | | 18–22 → 17–20 |
| `space-cost`, 200 figures, 60 s | 10.7 → 3.8 ms per command | 31–33 → 11 ms | 81–112 → 31 ms | | | 73–92 → 71–89 |
| `test:perf`, load, 10 players | | 11 → 11 ms | 26 → 17 ms | 36 → 20 ms | | 0 → 0 |

All Rust values come from the same binary, the state of this commit. R-D2 is thereby met: The CPU per command falls by a factor of 2.8 to 3.4, in the pure service by 6 and more; the RSS by a factor of 10. p95 and p99 are better in every profile, timeouts not more frequent. The timeouts at 200 figures are in both servers almost only moves without a reply. `tests/perf/latency.test.ts` failed on both servers equally because of itself: It sent steps faster than the page and ran into the gateway's throttle, a discarded step gets no reply. At the pace of the page (`WALK_MS`) it measures a median of 26 ms on both servers. The memory store grows in both servers with the claims (O(n)) and is only for tests. The numbers apply to the local machine; a measurement on `big`/`nano` is outstanding and changes services running there, so it belongs to R4.

**What the measurement and the project tests found:**

- **Gap in the long poll:** 25 ms from TS doubled p50 and worsened p95 (22/41 ms). A look in Rust is a query, the gap is now 2 ms.
- **Slots per connection:** A call that is only waiting for the `fsync` no longer occupies, unlike in TS, any of the 32 slots, the limit counts only waiting calls. On one thread a burst runs through to its end and otherwise filled the slots at once (107 timeouts in the first second at 200 figures). Outstanding replies are limited to 1024 and 8 MiB per connection, including the buffer of a blocked socket writer. Exceeding either limit closes the connection; overload replies consume the same budget. See the [audit fixes](rust-audit-fixes-2026-10-31.en.md).
- **Counting without a copy:** `pending_counts` copied all claims on every read in the memory store; that made Rust slower than TS there at first.
- **Ready line:** It appears only when limits and locks are on disk.
- **Bug in `spaces-mmo/server/gateway.ts`, independent of Rust:** A figure is not in the stream between two commits of its arrival: A `take` under a transaction reports the `del` at once, the `put` comes with the commit. TS behaves the same (34 of 34 moves in the same test with spacing in the stream). If the `hello` met this gap, it never followed; the faster server hit it in 2 of 6 runs. Now the next write of the figure brings the `hello`, the message comes only after 2 s.
- **Default walk of `phi-core`:** At 12,000 steps it missed its coverage already before R3 (`probe locked`); the default is now 24,000.

**Case matrix R3:** All suites run with `PHI_SPACES_SERVER_CMD=rust/target/release/phi-space-server` against the process; `test/support/service-under-test.ts` starts it per test with `--test-hooks` (identities, policy and limits of the case, one socket per peer, the hooks on a Unix socket of their own). If the binary is missing, the test fails, there is no fallback to TS. `rust/phi-space-server/tests/process.rs` checks that the hooks are not reachable without the switch.

| Suite | Tests | Against Rust | TS only, with reason |
|---|---|---|---|
| `test-standalone` | 4 | 4 | |
| `test-remote` | 12 | 11 | Creating Spaces at runtime: host operation, belongs to R5b |
| `test-service` | 12 | 10 | `linked pages` accesses the state (`readChain` is in the core's walk); lost reply at the store: `phi-store/tests/failures.rs`, `crash.rs` |
| `test-socket` | 8 | 7 | The same service at a new listener is a wish of the host; restart and TCP are in `test-standalone` |
| `test-socket`, "requestTimeoutMs" | | counts along | Checks the client against a stub, runs on TS in both cases |
| `test-service`, `cutText` | | counts along | Pure function of the client |
| `test-scenario` | 2 | 0 | Test bed `sieve-mobile`, comes with R4 |
| Gate, auth, enrollment (B5) | | open | R5 |
| Federation | | open | R5b, R6 |

**Decisions from the slices:**

- **Supported documents:** Registry version 1, Space and named Space version 5, parts as rows. `migrate` and inline parts are not ported: The stores on this machine and all vectors are like this, any other state is rejected on opening. R4 checks this on big and nano before the move.
- **Memory budget:** dropped. The TS host only evicts documents from memory that nobody watches; `startService` watches every Space. The Rust service therefore keeps every Space in memory, the claims stay on disk.
- **Named Spaces:** They come into being only through host code, never through a call. The Rust service serves those that are in the file.
- **Background:** The Rust service asks the document for the next due time instead of committing a maintenance round after every commit as TS does. The state cannot tell the difference, because every operation maintains itself before a mutation; the walk compares the hash after TS rounds that Rust leaves out. Commits are checked for new due times at most every `watch_debounce_ms` (default 20 ms). The meter of `deliverEvents` is dropped: The service delivers nothing, it only discards.
- **Delivery:** The Rust server has no conversations. Events with a numeric target wait in the outbox, events without such a target or with a missing transaction are discarded and release their transaction. `retryAt` and `tries` from a file of an agent host are honored as in TS.
- **One thread:** `phi-wire` serves all sockets, long polls and the background on the thread that owns the store (tokio `current_thread`). Only the SQLite writer is another thread; it wakes the owner after every batch. A call runs without `await` to its end.
- **Reply only after `durable`:** Every reply carries the mark of the commits handed over up to then, a read too: It sees what is committed and is held back until it is on disk. If the store fails, everything not yet durable is answered with `Internal`.
- **Start profiles:** `phi-space-server --profile mmo|codemode` reads the same environment as the respective `server/space-host.ts` and prints the same ready line. Limits apply in both profiles before the first call; in TS `spaces-mmo` sets them only after starting the socket. One owner thread runs per store, a panic ends the whole process. `skipUnchangedRecords` is dropped: In TS the switch saves the search for changes in the draft, the Rust store tracks them while writing. Both profiles start on copies of stores that TS wrote, and TS opens them again afterwards. The `.env` is still read by the TS starter. The hosts in Docker still start TS, see R4.
- **Injected faults in `phi-service`:** 10 of 12 are caught, the edge cases in `tests/edges.rs` and `tests/background.rs`, because a walk does not hit the byte. Two remain undetected: The abort "a maintenance item cannot fit the configured commit budget" is not reachable via the API, because `setLimits` prevents the situation (TS has no test for it either), and the `settle` after a `pending` admission changes nothing, because `maintain` has just run at the same time.
- **Panic:** A panic ends the process. What was acknowledged is on disk, a half commit does not continue.
- **Watermark:** A failed commit also restores the expiry watermark of the state it found; the walk found this.

**Acceptance:**

- Group A and the cases assigned as B3 run with `PHI_SPACES_SERVER_CMD` against the Rust server; the
  case matrix from section 5 shows the actual process and all B5/R5b/R6 cases not yet due.
- The examples sieve and cache run with `--remote`.
- `npm --prefix spaces-mmo test` and `npm run test:codemode-chat` run when their `space-host` is replaced by the
  Rust binary: start switch `SPACES_MMO_SPACE_SERVER` or `CODEMODE_SPACE_SERVER`.
- Both projects start on fresh and existing stores; limits, locks, identities and process presence
  correspond to the mandatory matrix. TS→Rust→TS with open claims/txns and unchanged request ids is checked.
- The perf measurements from R0 are repeated according to the corrected procedure; CPU or memory must win according to
  R-D2 without violating the latency/error-rate limits fixed beforehand (R-D11).

### R4: Operating an application on Rust

**Status 2026-10-31:** The local part is done, the move on the servers has not begun.

- **Image:** The stage `production-rust` of the two Dockerfiles puts the binary into the production image, `npm run docker:image:rust` builds `:prod` and `:rust`. `docker/docker-compose.rust.yml` (per project) contains only the Space containers. `docker:rust:up|down|logs` runs as a compose project of its own with its own volumes on the ports of `docker:local`. `docker:nano:up` and `docker:big:up` do not read the file and stay on TS.
- **`spaces-mmo`:** Five Space containers on Rust (2–10 MB RSS each under light load), four world workers and web on TS, 5 guests for 60 s via `live-load.ts` without errors in the logs. `npc` and `model` did not run along, because the local `.env` switches model calls on.
- **Switching back `spaces-mmo`:** With the workers stopped, all five stores were switched with `kill -9` from Rust to TS and back. All entries except the `Process` entries of the Space processes were equal in both switches (1,226 entries). The state came from the run; active txns and waiting requests are not checked by this run, `test/test-server-handover.test.ts` does that.
- **`codemode-chat`:** Space on Rust, judge and web on TS, start and switching back work. The store was empty, so only the start is proven here; data is proven by the `.local` copies from R3 slice 7.
- **Build from the working tree:** The image takes over unversioned files. If their typecheck fails, the build fails; this applies to `docker:image` just the same.

**Still open:** R-D12, inventory check and backup on `big` and `nano`, move after asking, test bed `sieve-mobile` (`test-scenario`), a week of operation, switching back with running work in operation, the dashboard against the Rust server.

**Work:**

- Docker images of spaces-mmo and codemode-chat get the Rust binary as the Space role.
- First `docker:local:up` on this machine.
- Then, **after asking**, the nano accounts Space and the big world regions.
- Before switching: consistent backup, inventory check (also for lone surrogates, R-D10) and documented
  TS/Rust version pair.
  First stop the previous owner, then open the file with the new server; never two owners in parallel.
- Record the rollback window and permissible schema/feature changes (R-D12). Way back within this window:
  TS `space-host` with the same start profile on the same file. After incompatible changes a
  rollback migration of its own or an explicitly decided restore with named data loss is needed; no blind downgrade.

**Acceptance:**

- A week of operation without deviation at documented load, with monitored errors, timeouts, maintenance backlog,
  file growth and memory need. The approved version pair is not changed silently in the process.
- The dashboard shows the Spaces over their sockets unchanged.
- A rehearsed switch back keeps entries, generations, decided and waiting requests, active txns,
  mailboxes/ACK cursors as well as application sessions and running world schedules.

### R5: Secure host (`phi-host`)

**Status 2026-10-31:** Slice 1 stands: `phi-host::auth` checks key proofs against `test/vectors/crypto.json`, including the refusals from `test-auth` per connection. Ed25519 checks strictly: Small keys and non-canonical signatures that OpenSSL accepts, Rust rejects; no key of phi-spaces produces them. Slice 2: `phi-host::grants` issues grants and checks them, with the cases from `test-grants`, as far as they concern the grant itself; Ed25519 signatures are byte-equal with the vectors. Slice 3: `phi-service` asks `Options.authorize` (`Authorization`) per call, checks again in the commit, renews `authorizedUntil` of waiting work and checks commit and renew against the original rights. The walk compares this with TS on every third seed value, `tests/authorized.rs` aims at the paths it rarely hits; of 11 built-in faults all are caught. The fields from `claimMetadata` come with R5b. Slice 4: `phi-host::gate` is the gate with layer B on the socket (`phi_wire::Front`, `Conn.identity`); `test-gate` and `test-auth` run against the binary through `test/support/gate-under-test.ts` and `--test-hooks` (`gate`), 14 of 14 built-in faults are caught. The directory speaks plain HTTP so far, https comes with the TLS register. This host mode exists only behind `--test-hooks`; a production host needs R5b. Slice 5: `phi-host::control` is pairing, the wire rules of the control space and the supervisor on the service's store, `Store::create_space` makes a named Space at run time (TypeScript reads it); `test-enroll` and `test-supervisor` run against the binary, except their cases of `asyncCommands` and the TypeScript store's fault injection, and 20 of 20 built-in faults are caught. Slice 6: `phi-host::rotation` is own-key rotation with its `rotateKey` command and the `grant` call, which asks the directory afresh; `test/test-rotation.test.ts` is new, because in TypeScript only the federation runtime reached these on the wire, and runs on both servers. Slice 7: `phi-host::tls` and `phi-host::register` are TLS on rustls: the directory over https, and the register with client, server (`phi-space-server --tls-register`) and the erasure rules on the same file. The register test of `test-recovery-boundaries` runs against the binary, the Rust client against the TypeScript server, and `tests/erasure_policy.rs` holds 20,000 seeded updates against TypeScript. `asyncCommands` comes with its handlers (R5b), and the acceptance of `test-federation-runtime`'s security cases with the composition of R5b.

**Work:**

- Gate (NetBird peers and groups), key challenge (Ed25519/P-256).
- Enrollment and pairing, grants and rotation, supervisor with control Space.
- TLS register (`tls-register.ts`) with `rustls`.
- This stage does not yet take over a federation member. Today's `startFederationHost` composition must not be
  rebuilt as a production host by leaving out its boot/authority check; this integration follows R5b.

**Acceptance:**

- B5 with `test-gate`, `test-auth`, `test-enroll`, `test-supervisor`, `test-grants` and the security sub-cases
  of `test-federation-runtime` runs against the Rust host. The case matrix delimits member/boot/recovery cases.
- Expired/revoked authorizations, foreign signatures and reconnections must not execute existing
  pending operations without authorization; the check covers expiry and renewed authorization.

### R5b: Federation-capable member behind a TS root

**Accepted 2026-11-01.**

**Status 2026-10-31:** Begun. Slice 1: `phi-core::run_gates` is `applyRunGate` with the takes, writes, renewals and commits it rules; a gated completion profile is no longer refused. The walk runs gated profiles and `tests/run_gates.rs` aims at the rest, line for line against TypeScript. The recovery operations on gates (entry fence, restored evidence) come with R6; their branches in `applyRunGate` are ported but only reachable there, as is `check_run_bindings`. Slice 2: `phi-core::member` is `member-admission.ts`: placement of managed writes, drain with its bounded allowance, and the refusals of a Member that is not serving; the service asks it for new requests. `tests/member.rs` holds it against TypeScript. Slice 3: `phi-core` has `recoverRunGate`, and `phi-host::run_member` takes signed RunGate instructions on the gate (`runGateInstruction`) with registered preparers; `test/test-run-instructions.test.ts` runs on both servers. Slice 4: `phi-host::membership` is `MemberLifecycle`: all ten actions, the signed policy and the journal of proofs in one commit with the Space (`Space.doc_writes`). `test/test-member-instructions.test.ts` runs on both servers, and the journal goes from Rust to TypeScript and back in the file. `validateFederationPolicy` is the controller's and comes with R6. Slice 5: the service takes what a delegated call brings (`Authorization`: transport peer, epochs, policy version, `check_commit`). Slice 6: `phi-host::delegation` is the Member's side of `delegation.ts` with `check` and `epochNotice`; `test/test-delegated-calls.test.ts` runs on both servers, with leases and grants of a TypeScript control host. Issuing leases and replicated Members come with R6. Slice 7: `phi-host::boot` is the boot guard: the gate reads the register before a call, the service checks each read and commit against that read (`phi_service::Guard`), and a failed or old read blocks; reads of overlapping calls do not disturb each other. A primary/sync or standby permit stays blocked until R6. `test/test-boot-guard.test.ts` runs on both servers. Slice 8: `phi-space-server --store FILE --member CONFIG.json` is a Member from the config of `startConfiguredFederation`: its keys come from the control host (`keyLookup`), asked before each call and kept for moments only, its authority is read with the boot record, and what it does not carry (root, primary/sync, entry replication, recovery) ends the start. `test/test-mixed-member.test.ts` runs it behind a TypeScript control host with the TLS register and the management API, and the TypeScript Member through the same scenario. `asyncCommands` belongs to the control host's supervisor, so to R6. Slice 9: `phi-host::space_lifecycle` takes `spaceLifecycleInstruction`, the core has `archived`, and `Store::create_space_with`/`delete_space` put each step in one commit with its journal line. `test/test-lifecycle-instructions.test.ts` runs on both servers and the file goes from Rust to TypeScript; a Space that no permit names is refused by the boot guard on both, so `create` on a guarded host waits for provisioning. `test/test-mixed-member.test.ts` now has a router's delegated calls with the policy the control host signs, drain, retries of signed instructions and a restart.

**Operating states of a Rust Member (2026-11-01).** Served: a Member behind a TS control host with the local role, grants, delegated calls, the policy read per delegated call, membership instructions, boot and authority fence. Locked, refused at the start or per call instead of ignored: a root, primary/sync and standby permits, entry replication, recovery, `registerSshTarget`/`registerReadSocket`, `mode: control`. With `runGates` and `spaceLifecycle` in its config it takes those instructions; without them it answers "run gates not configured" and "space lifecycle not configured", as `startConfiguredFederation` does. A control host change (`recoveryAdmin`, an `installed-authority` record) ends the start as well: following one is R6.

Slice 10: the start of a Member. Only an active authorization boots it, the active external permit of a Space with the same data incarnation is installed locally (`installAdmittedPermit`), the authority is checked before anything is served, and `phi-host::capability` publishes the heartbeat at the control host and in the configured data Spaces. `test/test-mixed-member.test.ts` has the pairing of a device at the control host, then its work on the Member, as the local simulation of the phone pairing.

**Case matrix of the R5b acceptance (2026-11-01).** Pause and stop in mixed operation run on configured hosts since `runGates` and `spaceLifecycle` are config fields, on both servers, with the preparer `tasks`: the tasks a run's manifest names. A Member's admission follows the policy the control host signs, read with each call that brings a grant (`refreshPolicy`); a policy that cannot be read stops the call. A real phone paired at the control host and worked on the Rust Member over WLAN, through a kill, cut-offs and a fence ([evidence](../test/evidence/rust-member-device-2026-11-01/README.md)); it reads there, and a Space on a phone needs M1.

**Local federation (2026-11-01).** `npm run testbed:federation` runs a TS control host, the TLS register and one Member, Rust or TS, in containers with their own addresses on their own network (`test/testbed/local-federation/`, project `phi-federation`, beside the other local containers). The scenario kills the Member with SIGKILL, cuts off the control host and the register, fences the host, and holds what each Member answered against the other: all 17 steps alike.

| Suite | Member side, and where it runs against Rust | Stays on the control side (R6) |
| --- | --- | --- |
| `test-federation-runtime` | boot authorization, grant-only access, capability publication and refused forgeries (`test-mixed-member`, `test-boot-guard`, `test-gate`), expiry and resolution (`test-delegated-calls` on the wire, `phi-service/tests/authorized.rs` against TypeScript), key rotation (`test-rotation`), restart with waiting work (`test-mixed-member`) | a sync Space in its own store, the control host's supervisor |
| `test-delegation` | both signatures, active keys, policy change, epochs, alias epoch notice (`test-delegated-calls`, `test-mixed-member`), delegated events (`phi-service/tests/authorized.rs`); a new epoch between authorization and commit cannot arrive here, both run in one step of the owner thread, and the commit checks again (`a_commit_rechecks_the_rights_on_its_entries`); a replicated Member's configuration and NotCommitted with promotion evidence (`test-delegated-calls`, R6b NotCommitted) | Root lease issuing, Root composition |
| `test-membership` | lost reply and replay, EmptyProof with entries a transaction holds, the pinned instruction on the wire (`test-member-instructions`, `test-mixed-member`) | Root references, resuming add and remove, primary/sync Spaces |
| `test-run-member` | signed instructions on the wire (`test-run-instructions`) | controller restart, admin commands |
| `test-run-gate` | gates in the core (`phi-core/tests/run_gates.rs` against TypeScript) | the controller's run |
| `test-bootstrap` | none: primary/sync, locked at the boot guard | all |
| `test-space-lifecycle` | signed instructions, journal, archive, delete (`test-lifecycle-instructions`) | `spaceCommands`, supervisor |

This stage presupposes R5 and is mandatory before a Rust server replaces a present-day TS member. It ports
the member side of the contracts that already exist, no new Rust root and no replication. If it stays open,
the federation members also stay in TS; the Rust standalone is no replacement.

**Work:**

- Delegation check and epoch/policy binding (`delegation.ts`), including the authorization of waiting work.
- Signed membership instructions and local admission (`membership.ts`, `member-admission.ts`): drain,
  freeze and bounded completion apply equally to local and remote access.
- RunGate in the core, signed `runGateInstruction` and ACKs (`run-member.ts`); additional member instructions
  for the approved control scope, such as Space lifecycle, must not be silently ignored.
- Boot authorization, local installation and authority check from `boot.ts`/`runtime.ts` including the required
  register/recovery read contract. Unsupported recovery/replication states stay locked instead of being served.
  The controllers and the complete recovery flows remain R6.

**Acceptance:**

- The member/boot sub-cases of `test-federation-runtime` as well as the assigned cases from `test-delegation`,
  `test-membership`, `test-run-member`, `test-run-gate` and `test-bootstrap` run against Rust.
- Mixed operation TS root→Rust member with retry, restart, drain, pause/stop and invalid/outdated
  instructions; supported and locked operating states are documented explicitly.
- A real phone pairing via the test bed (`docs/testumgebung-big.en.md`, `scenario sieve-mobile`), after asking.
  The phone can keep using the TS Space meanwhile; a Rust Space on the phone additionally needs M1.

### R6: Root federation, replication, recovery (deferred)

**Split 2026-11-01.** R6a is what TypeScript has accepted: the control host (`--control`: keys, policy, leases, capability directory, supervisor commands, run controller, workers, Space commands, deployment, alerts, data administration), then router, `federated-space.ts` and `configured-root.ts` from the accepted phase 2. R6b waits for R-D3, because TypeScript has not accepted it: `entry-replication*.ts`, `primary-sync.ts`, `sync-spaces.ts`, `replica-*.ts`, fencing, `control-host-change.ts`, `recovery*.ts`, `restore.ts`, bootstrap.

**R6a, slice 1 (2026-11-01):** `phi-space-server --store FILE --control CONFIG.json` is a control host: pairing, grants, `keyLookup`, `routingPolicy` under its signature, the capability directory and the supervisor's own commands (`phi-host::control_host`). Slice 2 adds `routerLease`, issued and renewed as `RouterLeaseAuthority` does. A root, delegated calls to the control Space, `asyncCommands` and a recovery's access policy are not carried yet; what would rely on them is refused at the start. `test/test-mixed-member.test.ts` takes the control host's server from `PHI_SPACES_CONTROL_CMD` beside the Member's, and `npm run testbed:federation -- both` runs all four pairings. While a Rust control host runs, a test reaches its store only with that host down.

**R6a, slice 3 (2026-11-01):** The supervisor's `setPolicy` command runs on a control host: `phi-core::policy::validate_federation_policy` is `validateFederationPolicy`, held against the TypeScript function by `phi-core/tests/policy.rs` (`PHI_POLICY_CASES`, seeded random policies, 30000 passed), and `phi-host::control::Routing` installs the checked policy and answers a stale or refused one as a failed command. `test-mixed-member` sets the policy over the wire, a Member follows the new version.

**R6a, what is open (2026-11-01).** Done: the control host's keys, policy, leases, capability directory and own supervisor commands (slices 1 to 3), and the placement of `routing-semantics.ts` and `federation-journals.ts` (`phi-core::routing`, held against TypeScript by `phi-core/tests/routing.rs`). In this order:

1. The journal documents as vectors, before any code that writes them: `FederationJournalLayout`, `RouterJournal`, `RouterCommands`, `FederationOperations`, `FederationRouting` and the lease file. A router takes over another router's journal, so TS and Rust must read each other's.
2. The client: what the Root needs of `remote.ts` (`authenticate`, grants, delegation, `sendEpochNotice`) as its own piece; `phi-host::remote` today knows key lookup and policy only.
3. `RouterController` on the store (`submit`, `ingest`, `advance`, `recover`, `review`).
4. `FederatedSpace` and `federation-rpc.ts`.
5. The composition of `configured-root.ts`: `assertRoot`, lease retain and takeover, heartbeat, epoch notices. `AsyncLocalStorage` becomes explicit parameters.
6. Harness: `test-configured-root` calls `createConfiguredRoot` in-process, so `PHI_SPACES_CONTROL_CMD` does not reach a Rust Root. It needs a mode that starts the binary, and the local federation a scenario in which the control host carries `root` (the `router` container is a TS client script today).
7. The control host's commands: asynchronous supervisor commands, then `run-controller.ts`, `workers.ts`, the controller side of `space-lifecycle.ts`, `deployment.ts`, `alerts.ts`, `data-admin.ts`.

Not ported with the Root, because it is R6b: `replicas` per Member, `ReplicaNoticeBoard` and `adoptReplicaConfigNotice`, `controlEpoch` of a replicated main store, `reconcileDataRestore`. A config with any of them, or a restore in progress, is refused at the start.

**R6a, router (2026-11-01).** `phi-host::router` is `RouterController`: submit, advance, recover, review and future reservations. `test/support/router-driver.ts` and `phi-host/tests/router.rs` walk the same lines through both, with lost replies, refusals, wrong receipts, restarts, crashes at the checkpoints and a lost authority, and compare each answer, the journal index and every command document byte for byte, which also holds the shapes of item 1 for these two families. Not there yet: the `RouterEnv` over the control store and the Members, the commit hooks and `recoverMany` that `FederatedSpace` uses. `reconcileDataRestore` stays R6b.

**R6a, the Root's wire adapter (2026-11-01).** `phi-host::federation_rpc` is `FederationRpc`: proof, grant and signed delegation per call, and the check of claims and witnesses. `test/support/rpc-driver.ts` and `phi-host/tests/federation_rpc.rs` run both over a scripted line and compare every frame with its signature and every receipt. A successor of a replicated Member and a policy raised by a replica notice are refused here; they come with R6b.

**R6a, `FederatedSpace` (2026-11-01).** `phi-host::federated_space` holds writes, reads, transactions and races, with the router's commit hooks and `recoverMany`. `test/support/federated-driver.ts` and `phi-host/tests/federated_space.rs` walk both over real routers and scripted Members, in one and in three partitions, and compare every answer, every call to a Member and every journal document. Where TypeScript stumbles with a `TypeError` over a shape it never gets in operation (a write retried under the id of a read, a race whose registration came back null), Rust refuses by name. Not covered by the walk: the branch where a parent does not fit into the commit of its child, which needs a parent larger than a child may be. `reconcileDataRestore` stays R6b.

**R6a, the Root on the wire (2026-11-01, decision R-D11).** In TypeScript the Root had no wire: hosted agents called `root.space` in one Node process, which a Rust binary cannot offer. **Decided:** both servers answer `rootWrite`, `rootRead`, `rootTake`, `rootBegin`, `rootFinish`, `rootTakeWaiting`, `rootReadWaiting`, `rootResume`, `rootReadAll` and `rootCount` (`src/root-wire.ts`, `phi-host::root`). The caller proves an active host key of this very peer; the principal is this peer and the agent it names. A journal's refusal keeps its class as the code, so a client knows to `rootResume`. `phi-space-server --control` carries `root`; `test-mixed-member` runs it in all four pairings against real Members, with a restart. A Rust Member now serves primary epoch 1, as TS does: with 0 every delegated effect failed with `StaleEpoch`.

Not carried yet, refused at the start where a config asks for it: `replicas`. `ProfileTransitionController` is open. Each journal commit waits for the disk with `drain`, on the owner thread.

**R6a, the Root in the local federation (2026-11-01).** `npm run testbed:federation -- both` now runs the Root on the control host in all four pairings: a retried write, a conflict, a Member killed under a write and resumed, the Root killed, and its journal handed to the other server and back by a recreated container. No effect doubles and every pairing answers alike. A Rust Root recovers its journals at the start.

**R6a, membership (2026-11-01).** The supervisor runs asynchronous commands: a command with effects on other hosts becomes a job in the same commit that takes it, runs outside the commits, and a transport error leaves it for the next pass. `addMember`, `drain` and `removeMember` are the first (`phi-host::membership_control`, with `allowMembershipCommands` and `adminPeer`). `test/support/membership-driver.ts` and `phi-host/tests/membership_control.rs` compare every answer, every signed instruction, the routing, the journal and the policy counter; `test-mixed-member` adds and drains a Member by command in all four pairings. Supervisor and Root hold one routing document. Not reached by the walk: references that appear between the last check and the removal commit, and a policy newer than the transition's own, which take a concurrent writer. `removeMember` on real Members is not in the mixed test yet, it needs a second Member.

**R6a, status, epoch notices, router change (2026-11-02).** The Rust Root runs its heartbeat (`statusIntervalMs`, 1000..15000): `phi-host::member_status` asks each Member what it is and writes the routing and a `MemberStatus` entry in one commit, `test/support/status-driver.ts` and `phi-host/tests/member_status.rs` compare every refusal, the routing and the entries over Members that fail, answer nonsense or too late, move or leave under a probe. Like TypeScript it reports `free` and `lag` as unknown, so only capabilities reach the routing from here; a rule `by: capacity` has no figures on either side. After a router change or a control transition each active Member gets the supervisor's signed `EpochNotice` once. `takeover` and `takeoverWaitMs` adopt a journal whose lease record is lost or overtaken, and a bounded wait that runs out ends the start. `test-mixed-member` holds all of it in the four pairings: the status in the control store, the refused start without `takeover`, and the raised epochs in the Member's store. A control transition's marker is read, but only R6b sets it. Two faults in the TypeScript Root came up: a new transport object per call kept `orderedProof` from ordering the proofs, so the heartbeat and a journal call on one connection overwrote each other's challenge; and closing failed a running probe by its connection, which was then recorded as a Member gone. There is one transport per Member now, and a closing Root writes nothing more.

**R6a, profile migration and the supervisor's views (2026-11-02).** `phi-host::profile_transition` is `ProfileTransitionController`: `migrateProfiles` freezes, installs and resumes every Member under signed instructions, the policy rises in between. `test/support/profile-driver.ts` and `phi-host/tests/profile_transition.rs` compare every answer, instruction, the routing, the ledger and the counter, also for lost lines, wrong proofs, unsettled work and targets that move under a frozen transition; `test-mixed-member` runs the command against real Members in all four pairings and finds the profile in the Member's store. `listAlerts` and `auditLog` are on every Rust control host (`phi-host::alerts`, `test/support/alerts-driver.ts`). `collectAlerts` now sorts by code units instead of `localeCompare`, whose order hangs on the ICU data of a process and which a second server cannot repeat.

**R6a, what item 7 turned out to be (2026-11-02).** `RunController`, `WorkerAssignments`, `spaceCommands`, `DeploymentController` and `DataAdminController` are not built by `configured-runtime.ts`: only the library composition `createFederationRuntime` takes them, in tests and test bed scenarios. A configured TypeScript control host answers none of those commands, and its config has no keys for them. So the binary has nothing to replace there yet: alerts on runs and workers stay out with them. Porting them means deciding first what configures them on a host.

**R6b, the first acceptance: primary/sync with the primary killed (2026-11-02).** `npm run testbed:federation -- replica` runs a primary/sync Space on two hosts of the configured runtime (`replica.ts`, `replica-host.ts`, the compose profile `replica`), with a client writing through the gate. Five writes are answered; the standby is cut off, and the sixth write on the same session is answered `CommitSealedPending` and stays a sealed candidate on the primary. The primary is killed with `SIGKILL`. The standby is promoted to epoch 2 behind `ContainerFencing`, which runs on this machine outside the fenced containers (`fencing-service.ts`, mutual TLS); a fenced host that an operator starts by hand is refused with `BootBlocked`, and its client is not served; with the host state check of `configured-runtime.ts` taken out, the boot guard of `boot.ts` refuses it instead. Without a standby, the promoted host's next commit is sealed; `degradeToSingle` completes it at epoch 3. The old primary goes through quarantine, its history set aside, and `setStandby` makes it the sync standby again. In the end both stores hold the same twelve entries and the same journal head, and the fork is in neither. Two things a client should know were found on the way. A new session's first commit is its registration (`rpc.generations`), so that is what a sealed primary refuses: `CommitSealed`, and the write itself never ran; the client writes again. Docker does not restart a container killed with `docker kill`, under any restart policy. Of systemd, only the unit is stood in for: `systemctl` is answered over the container, and `start` obeys the drop-in as `ConditionPathExists` would, so that no unit of this machine's user is touched. docker, the restart policy and the drop-in file are real; with the restart policy left as it was, the adapter refuses its proof and the scenario fails.

**R6b, entry replication with a Member cut off (2026-11-02).** `npm run testbed:federation -- entry` replicates an lww type (`Sensor` by `sensorId`) and a set type (`Tag`) of the default Space between the two replica hosts, each pulling the other's stream over its gate. A client writes through the gates: one host is cut off and killed while the other is written, and it comes back and catches up. Then the other host is cut off while a tag is removed among the writes, and it takes over the removal. Last, the same key is written on both, one after the other, and the later write wins on both. In the end both gates and both stores, read with the daemon stopped, hold the same three entries. A `take` of a merge type is answered `MergeTypeNotExclusive`, and a cut-off host serves no client. With the lww order turned around, or a set removal ignored, the scenario fails.

**R6b, a control host change (2026-11-02).** `npm run testbed:federation -- change` runs the control host on a primary/sync main store (bootstrapped single, then `setStandby` to a second control host; every Space of the store follows as a sibling), with a TypeScript Member that pins the recovery admin's key. A client takes a grant and writes a Job. The control host is killed. Without it, the Member answers no call, not even one with a grant taken before (the call times out), and no new grant is to be had. A change recorded before the promotion is refused by the register. The standby is promoted behind `ContainerFencing` and made single (epoch 3), a change signed by a key nobody pins is refused, and the recovery admin's change is recorded. The promoted host serves as control host under its own ID, key and address. The Member follows the change, exits as the daemon does (75), comes back through its restart policy, and works against the new control host: a new grant, a Job written, the earlier Job still there. A grant of the old control host's key is refused with `PermissionError`, and the old host, started by hand, is refused with `BootBlocked` by a boot check. The old primary's applied history is a prefix of the promoted one. Out of this scenario: the Root, whose journal on the control host is not moved by the change, and a Rust Member, which refuses `recoveryAdmin` at its start. Both are open items. `host.ts` now ends a TypeScript host on `controlChanged`, as `federation-host.ts` does.

**R6b, a data restore (2026-11-02).** `npm run testbed:federation -- restore` restores a data Space from its backup onto another host while the host it lived on is lost. The target checks the fence over real ssh: `fence-ssh` runs `sshd` in its own container, one login per fenced host, each bound by `ForceCommand` to `phi-spaces-fence-status`, which reads the container's state, restart policy and drop-in through the docker socket of this machine (the stand-in for a status command on the docker host). The test image carries `openssh-client` and `openssh-server` for that. The target gets the control host's receipt over its private recovery endpoint. A killed host that may still come back is no source to restore over: the target refuses with "not independently stopped and restart-locked". Once the host is fenced, the restore runs blocked, waiting, completed; the placement names the target, and the source stays fenced. A client is answered from the backup: what was written after it is gone, a restored entry is not taken before the operator releases it, a new write is answered, and after the release the entry is taken. The old host, started by hand, is refused by a boot check. With the fence status check of `src/fencing.ts` taken out, the scenario fails.

**R6b, a control restore (2026-11-02).** `npm run testbed:federation -- control-restore` restores the control Space from its backup onto a second host under a new authority, while the control host is lost.
- The old control host is fenced. The target and the Member are stopped and restart-locked by the fencing service, and each runs its recovery-only service (`replica-host.ts recovery`), quiesced by what the ssh fence status says.
- The target imports the backup (importing, members, waiting). The Member installs the new authority. The first admin key and new keys for the Member host and the client are authorized; an old key is not revived (`RegisterConflict`). After the old grants have expired, the restore completes: the authority record names the target, active, under a new ID.
- The operator points the Member at the new control host. The client is answered under the new authority with its new key: the Job from before is there, a new one is written. A grant held from before the loss, presented with the new key, is refused by its signature ("invalid grant signature"), and the old key with "the key is revoked".
- The authority record is the one `provision.ts` writes, without a lineage. With the check that refuses an old key taken out, the scenario fails.

What it found, for the port and for TypeScript:
- **No restore in place.** A control restore onto the host it is restoring cannot finish. Its first submit meets `RegisterConflict`, because the fence check changes the same `boot:` record between its read and its write. A retry gets on, but every later fence check of the source sets the host back to `fenced`, and the Member step needs `quarantine`. Only a restore onto another host completes, and there the submit went through at once.
- **The routing table was lost (fixed 2026-11-02).** `FederationRouting` is a document beside the control Space, not part of its snapshot, so the first runs found the new control host without Members: a policy naming one was refused ("default member is not registered"), the Member refused work ("no federation policy installed"), and a configured control host takes no `addMember` command (its config builds no `MembershipController`). Now `controlBackup(host, controlSpaceId, ctx)` writes the backup with the routing Members, and the restore sets them back as it imports: confirmed hosts under the new authority at epoch 1, the others as `recoveryBlocked`, without capacity and capabilities. The policy stays empty for the first admin, who sets it by command. The scenario backs up with `controlBackup` and needs no store write of its own; `test-recovery-boundaries` holds the Members, and fails with the restore of them taken out.
- **Crashes without a name (fixed 2026-11-02).** An authority record without `lineage`, as `provision.ts` writes it, made the coordinator stumble with a `TypeError`. A missing lineage now counts as empty, and anything but an object is refused by name. Each host needs `installed-authority` provisioned, and `confirmedMembers` must name the target itself.
- **Admin rights.** A grant's roles are the overlay groups ∩ the key's roles, so the first admin needs a peer in `space-admin`.

With this, the R6b acceptances of R-D3 have run in TypeScript: primary/sync with the primary killed, promotion and fencing, `degradeToSingle` and `setStandby`, a control host change, a data and a control restore, entry replication with a Member cut off. Each records what clients were answered and what the stores hold. Open: the Root during a control host change, and a Rust Member with `recoveryAdmin`.

**R6b, what is open (2026-11-02).** The port, in this order. Each step lands in a pairing of the local federation and takes one refusal off the Rust start (`syncSpaces`, `entryReplication`, `recovery`, `recoveryAdmin`; all four are taken off):

0. The R6b formats as vectors, before any Rust code writes them (`test/vectors/replication.json`, `npm run vectors`): the primary/sync journal file and its intents (v1 commit, v2 config, v3 bootstrap, the hash chain), the `sync-marker:` meta, the signed replica requests and answers, `ReplicaConfigNotice`, the signed control host change and authority transition, the `RecoveryCall` envelope, the control backup with its routing, and the register records (`boot:`, `placement:`, `authority:` with and without lineage, `data-transition:`, `control-transition:`, `authority-ack:`, `host-key:`, `installed-authority:`).
1. Replication in `phi-store`: `PrimarySyncJournal`, `OwnSyncStore`, `primarySyncStorage`, `recoverPrimarySync`, `materializeSyncHistory`, `bootstrapPrimarySync`, held against TypeScript on the same files and handed over in both directions. First settle the commit path: a primary/sync commit waits up to 15 s for its standby, and that wait must not hold the single-threaded service (today a Rust journal commit blocks on `drain`).
2. Replication on the host: the signed transport and notices, `promote`, `degradeToSingle`, `setStandby`, release and readmission, the fencing clients, then `syncSpaces`, the sealed resolver and the quarantine start in `phi-space-server` (`mainSync` moved to step 6, 2026-11-02: its gate `run.ts change` needs the control host change too), with the operator tool of `replica-host.ts` (`status`, `promote`, `degrade`, `set-standby`, `wipe`) as its CLI. Gate: `run.ts replica` with a TypeScript primary and a Rust standby, and the other way round.
3. Restore in `phi-core`: `restore`, `restoredClaims`, `invalidGenerations`, `authorityTransition`, what `restoredUnverified` does, `fenceGatesForRestore`; `assert_ported` widens only with core-driver walks that produce such states.
4. Recovery on the host: the data recovery controller, the control ACK, control recovery, the Member installer, the recovery-only services and the ssh fence check. Gate: `run.ts restore` and `run.ts control-restore` with Rust hosts.
5. Entry replication (`entry-replication*.ts`): its own differential walk of the merge rules. Gate: `run.ts entry` with a Rust host.
6. Following a control host change, `recoveryAdmin` on a Rust Member, and `mainSync` (a control host on a primary/sync main store, its sibling Spaces following the transitions) with recording the change on a Rust control host. Gate: `run.ts change` with a Rust Member, then with Rust control hosts.

**R6b, step 0 (2026-11-02).** `test/vectors/replication.ts` writes `replication.json`: the signed texts of the replica transport (a request, an answer, a refusal, with the body hash), a `ReplicaConfigNotice`, a control host change, an authority transition (`authorityTransitionBytes`, now exported from `src/recovery.ts`) and a recovery call, all with the ed25519 key of `crypto.json`, so every run writes the same file. Beside it, as SQL like `store.sql`, a primary/sync history: a store bootstrapped single (v3), two commits (v1), the configuration entry of a standby (v2) and one commit the standby confirmed (v1), as `primary.journal.sql`, `standby.journal.sql` and `primary.store.sql`, and in `journal.expected.json` what reading them answers, the standby's history materialized into a new store included. Only `--store` writes these anew (minted ids). `test-vectors` holds both against TypeScript, the journal's schema included; `phi-host/tests/replication_vectors.rs` rebuilds every text from its value in Rust and signs it to the same signature. The register records and the control backup come from the transition and recovery code itself; the drivers of steps 2 and 4 hold them.

**R6b, step 1, the journal (2026-11-02).** `phi_store::sync::SyncJournal` is `PrimarySyncJournal`: the hash chain in its own SQLite file, the three entry versions, the configuration derived from the chain, the format binding, accept and catch-up, transition records, the applied position and the budgets. `test/support/journal-driver.ts` and `phi-store/tests/sync_journal.rs` drive a primary's journal and a standby's through both, each on its own file, with faults on purpose (a changed hash, a marker that does not bind, a row touching the marker, a gap, the wrong standby, a refused permit, oversized entries, a full history, another genesis on reopening): every answer and in the end every row agree (`PHI_SYNC_WALK_STEPS`, `PHI_SYNC_WALK_SEED`; 40 000 steps passed, about a third of the seals and of the configuration entries succeed). The journals of `test/vectors` open in Rust and answer as `journal.expected.json`. With the check of a row touching the marker taken out, or the epoch rule loosened, the walk fails. The first difference the walk found: an entry of a journal not yet bound to a store kind is refused, as `PrimarySyncJournal.codec` does. Next in step 1: the store side (`OwnSyncStore`: marker, commit of deltas, capture, materialize, bootstrap, recovery of the candidate) and the commit path of a primary.

**R6b, step 1, the store side (2026-11-02).** `phi_store::sync_store` is the own store under the journal, opened by its owner without a host: `SyncStoreFile` (marker, commit of the deltas with `meta` and `partClear`, capture and its digest), `bootstrap_primary_sync`, `materialize_sync_history`, `recover_primary_sync` with the standby as `Peer`, `recover_sealed_without_standby` and `apply_config_transition`, which answers `CommitSealed` once it has sealed. `phi-store/tests/sync_store.rs` keeps a primary's journal and store and a standby's on both sides (the same driver): a store bootstrapped in chunks, the standby caught up and made the sync standby, commits sealed and resolved with its confirmation, its history materialized, configuration changes, a candidate completed under a fencing proof, rows written past the journal, a stray marker, refused permits, and two edges built on purpose (a replica store with data of its own, a marker that looks like an interrupted apply). Every answer and in the end every row of both stores agree (`PHI_SYNC_STORE_STEPS`, 20 000 steps passed). With the check of the data marker in `apply` or of an empty replica store taken out, the walk fails. Next in step 1: the commit path of a primary's host.

**R6b, step 1, the commit path of a primary: what it has to be (2026-11-02).** Read from `src/store/sqlite.ts` and `src/store/sync-sqlite.ts`, and from the Rust writer, service and wire:
- **The batch.** The TypeScript host seals a whole writer batch as one entry (`replication.seal(rows)`), waits for the standby, writes the rows and the marker in one transaction, then marks the entry applied. The Rust writer batches the same way, so it gets a `Replication` (a `Send` trait object, implemented in `phi-host` with a blocking signed transport, the 15 s answer limit and the register check on a runtime of its own) that it calls before `BEGIN`; `phi-store` stays free of `phi-host`. Only the held replies wait; the service thread never does.
- **Failure.** In TypeScript every failed batch fails the store for good (`#fail`), before sealing too. Only a sealed one is `CommitSealed` for its commits, and `PrimarySyncBlocked` ("poisoned by a sealed candidate…") for everything after it, and only then is `onPoisoned` told, which makes the sealed resolver reopen. Rust's writer already fails for good; it keeps the two answers per commit.
- **The budget.** TypeScript checks it per commit before the commit is published (`admit`, through the host's `gate`), so a `SyncJournalFull` leaves no trace and the host usable. Rust checks it on the owner thread in the same place, counting `JSON.stringify` of the TypeScript-shaped rows.
- **The answers.** `phi-wire` answers every held reply with `INTERNAL` once the store failed. In TypeScript the answer carries no request target: the client takes it from its own call (`remote.ts`, `CommitSealedPending`). Once `onPoisoned` has named the candidate, `SpaceService` answers every call and every error with `sealedReply` ("a commit of this Space is sealed but not confirmed (revision N)…"), the poisoned refusal included, until the resolver unserves the Space. So a held reply of a failed batch gets that one text while a candidate is named, and `INTERNAL` otherwise.
- **The deltas.** A Rust primary seals deltas made from its own `WriteOp`s, in the exact TypeScript shape (`doc`, `retire`, `part` with `at`, `grp`, `flag` as `null`, `partDel`, `partClear`, the marker as `meta`). A cross test commits through a Rust primary's host, lets the TypeScript journal accept and materialize every entry, and compares the stores' rows and digests.

**R6b, step 1, the commit path of a primary (2026-11-02).**
- **Hook.** `phi_store::primary` is `primaryReplication`. `SqliteLedger::open_primary` gives the writer a `Replication` that runs on the writer's thread. It seals each batch under the journal, waits for the standby (a `SyncPeer`; `phi-host` will put the signed transport behind it), and writes the rows and the marker (`WriteOp::Meta`) in one transaction. The journal stays behind a mutex, which is not held while the standby is waited for.
- **Batches.** The writer cuts batches at the entry's budget, and every commit goes into at most one batch.
- **Failure.** Any failure after sealing names the candidate (`PrimaryGate::sealed`). The batch's commits fail as `CommitSealed`, and everything after them with the poisoned refusal. If `applied` fails, TypeScript leaves that batch's commits unanswered (`#reply`); Rust fails them with the store.
- **Budget.** `SpaceHost` builds a commit's rows without changing anything (`plan`, from `Space::pending_changes`). A primary's `admit` counts the bytes `JSON.stringify` gives for the TypeScript-shaped rows (`WriteOp::delta`) and checks them before the commit is published. A refused commit is rolled back and answered `ResourceExhausted` ("primary/sync journal: …"), and the store goes on.
- **Answers.** While a candidate is named, `phi-service` answers every call and every error with `sealed_reply`, and `phi-wire` sends that text in place of a held reply.
- **Tests:**
  - `phi-store/tests/primary_cross.rs` (`PHI_PRIMARY_CROSS_STEPS`) runs the walk of R1 through a Rust primary whose standby is the TypeScript journal. Some walks overlap their commits, some have small budgets, and some cut the standby off once and resolve the candidate with `recover_primary_sync` before going on. At the end, TypeScript materializes the standby's history.
  - Over 20 000 steps (4 837 entries, 25 candidates resolved, 17 commits refused), both stores held the same rows, marker and commit count, and both journals the same head. Every refused commit left the Space as it was.
  - The byte count matches `Buffer.byteLength(JSON.stringify(rows))`, escapes and number forms included. A burst of admitted commits fills the history before it is sealed.
  - `phi-service/tests/primary_sealed.rs` holds the answers. Six faults built on purpose fail these tests: a wrong batch hash in the marker, a missing marker, a renamed delta field, no rollback on refusal, no named candidate, and no count of pending bytes.
- **Not yet:**
  - Rust emits no `partClear`, so a TypeScript-built and a Rust-built entry of the same commit can differ while materializing to the same rows; the cross test compares rows, not ops.
  - The service does not yet call a resolver when the candidate is named (`onSealed`), and nothing serves a primary/sync Space. Both are step 2.
  - ~~Nothing yet holds `phi-wire` sending the sealed text for a held reply over a socket.~~ Held since step 2 by `phi-wire/tests/spaces.rs`; end to end by `run.ts replica`.

**R6b, step 2, the signed replica transport (2026-11-02).** `phi_host::replica_transport` is `src/replica-transport.ts`:
- **Client.** `SignedReplicaPeer` (`signedReplicaPeer`) signs each request under the request domain tag with the host's key and checks the answer against the pinned key of the other replica, bound to the request's nonce, method and both host IDs. A failed check or a lost line is `ReplicaError::Transport` (`ReplicaTransportRefused`); a signed refusal of the journal is `ReplicaError::Refused` (`StandbyRefused`, "standby refused: …"). It is the primary's `SyncPeer`, so the writer waits on the standby through it.
- **Line.** `SocketTransport` is `socketTransport` as `src/sync-spaces.ts` sets it up: from the host's overlay address, 8 s to connect, 15 s for an answer (`STANDBY_ANSWER_MS`), frames of at most 1 MiB, the connection dropped after any failure and nothing repeated. It blocks, because the writer's thread calls it; the connection is opened on a runtime of its own off the calling thread, since std cannot bind before it connects.
- **Listener.** `ReplicaSyncHandler` admits a request (pinned sender, addressed to this host, a timestamp within 60 s, a fresh nonce, the body's hash) and signs the journal's answer or refusal; `journal_answer` lets the journal decide `head`, `accept` and `catchUp` with the permit checks the host gives. `serve_replica` is the listener: at most four connections, only from the peers' addresses, and a request the handler does not take answered as an internal error, as `serveSpace` answers a handler that throws.
- **Tests.** `phi-host/tests/replica_transport.rs` puts both sides on a real socket against TypeScript (`test/support/journal-driver.ts`: `pin`, `listen`, `peer`, `peerCall`): a Rust primary's entries to a TypeScript standby's listener and a TypeScript primary's to a Rust standby's. The ACKs and heads agree, refusals arrive signed with the journal's message, and a foreign key, a sender claiming another host, an answer for another host, a replayed or altered request, a connection from another address and catch-up outside quarantine are refused on both sides. The handler's own checks (stale, replayed, altered, a rebound or forged answer) are held in process as `test/test-replica-transport.test.ts` holds them. Six faults built on purpose fail these tests: no nonce binding, no replay check, another domain tag, no body hash, no quarantine check, no freshness.

**R6b, step 2, Spaces with a store of their own behind one transport (2026-11-02).** A federation host serves a primary/sync Space from its own store beside its main store, and `src/runtime.ts` picks the service by the call's `space`. `phi-wire` now does the same:
- **Slots.** Every store behind the transport is a slot of its own (`Served`): its durable mark, its handed count for long polls, its reaper and delivery, its failure. A held reply rests on the slot it was made in, so a write to the Space waits for that store's disk and a read of the main store does not.
- **Routing.** `ServeOptions::spaces` and `Owner::route` route the calls naming one of a Space's names (its alias and ID) as `space`, to its own service or to an answer that stands for it (`Route::Answer`, the `CommitSealed` of `sealedService` while a candidate is resolved). The host swaps it while serving; the service it takes out comes back after what it made durable has left, and a call still waiting on it ends with that store's last answer. `Owner::failed` resolves when the Space's store fails (the `onSealed` of `src/sync-spaces.ts`). `ServeOptions::tasks` runs host work with an `Owner` for as long as the server does.
- **Tests.** `phi-wire/tests/spaces.rs`: a Space reached by alias and ID beside the host's own store, swapped for an answer, served again from its reopened file and taken out. A primary whose standby is cut off answers the held reply over the socket with `sealed_reply`, as every later call, and its closed store lets go of the journal. The whole Rust suite and the TypeScript socket suites against the binary (`test-standalone`, `test-remote`, `test-service`, `test-socket`, `test-gate`, `test-auth`) pass.

**R6b, step 2, a primary/sync Space on a host (2026-11-02).** `phi_host::sync_space` is `openSyncSpace` and `sealedResolver` of `src/sync-spaces.ts`, `phi_host::replica_control` the permit checks of `src/replica-control.ts`:
- **Journal.** One journal per Space, shared (`phi_store::primary::SharedJournal`) by the primary's writer, the replica listener and the resolver; the owner thread never blocks on it (it waits a turn while a recovery holds it).
- **Permits.** `assert_permit`, `assert_sync_standby`, `assert_quarantine` and `install_admitted_permit` decide on a boot record read just before, with TypeScript's messages; `RegisterLine` reads the register on a thread of its own, for the owner thread and for the writer's thread, which checks the primary permit around every seal. The listener reads the record before the journal decides, and the journal's own checks still come first. `BootGuard::replica` admits a primary permit for a Space this host serves from its journal, only as the primary of the journal's configuration (`replicaMismatch`), and reads its erasure barrier with the rest.
- **Serving.** `SyncSpace::serve` installs the admitted permit, resolves the at most one candidate with the standby (`recover_primary_sync`, off the owner thread), opens the store over the journal and creates the Space with its fixed identity (`Store::create_space_as`, `createSpace` with `{spaceId, incarnation}`). `start` sorts a failed start as TypeScript does: an empty replica waits for setStandby, a refusing standby or an unresolved candidate goes to the resolver, anything else leaves the Space unserved.
- **Resolver.** Once the served store fails, the Space's names answer `CommitSealed` (`sealedService`), its store is closed, and `resolve` is tried with backoff (1 s doubling to 30 s) until the Space is served again or the host has lost its primary permit.
- **Tests.** `phi-host/tests/sync_space.rs` runs two hosts in one process over loopback with a register in a file: writes confirmed by the standby; the standby cut off, the held reply and every later call `CommitSealed`; the standby back, the candidate confirmed and applied and the Space served again; the primary permit revoked, the resolver stops and the Space keeps answering `CommitSealed`. With the sealed answer, the retry or the standby's confirmation in the recovery taken out, it fails. `replica_control`'s rules are unit tests.
- **Found on the way.** A recovery holding the journal must not lock it again for the permit check; the check takes the configuration read before.


**R6b, step 2, the Rust replica host (2026-11-02).**
- **Daemon.** `phi-space-server --member` takes `syncSpaces`. Each Space is opened beside the host's store with its own service, the host's checks (grants and delegation, boot guard) and the epoch of its journal; it is routed by alias and ID and followed by its resolver. A host in quarantine opens only the journals and listeners and ends once the register names it active again (`startQuarantineReplicas`). It prints the lines the testbed waits for (`{"ready":true}`, `{"quarantine":true}`, `{"leftQuarantine":true}`), and a fenced start ends with `BootBlocked: …`.
- **Transitions.** `phi_host::replica_transitions` holds `promote`, `degradeToSingle` (with a fencing proof or a revoked standby permit) and `setStandby`, and the operator's `releaseHostToQuarantine` and `readmitSpace`: journal transitions resumable under their ID, `casBoot` on the register, `TlsFencing` to the fencing service (the register's line protocol). `phi-space-server --replica-tool CONFIG.json REQUEST` is the operator's tool of `replica-host.ts` (`status`, `wipe`, `promote`, `degrade`, `set-standby`); what the stores hold (`status` with `materialize`) is still read by the TypeScript tool. `phi-host/tests/replica_transitions.rs`: promotion and degradation behind verified proofs, an unverified claim and the wrong versions refused, a refused transition blocking the next until abandoned, a completed one repeated without change, its ID bound to it; with the proof check or the fencing of the old primary taken out, it fails.
- **Acceptance.** `npm run testbed:federation -- replica A-B` picks the runtime of each replica host (`ts` or `rust`, `REPLICA_A_IMPL`/`REPLICA_B_IMPL`). `rust-ts` (a Rust primary, killed, fenced, back through quarantine as the standby) and `ts-rust` (a Rust standby promoted, degraded and running setStandby) passed with the TypeScript tool, `rust-rust` with the Rust tool too, and `ts-ts` still passes with the notice check: the write nobody confirmed answered `CommitSealedPending` over the socket, the fenced Rust host refused to boot, and both stores held the same twelve entries and snapshot.
- **Deviation found.** A Rust store registers the default Space in a commit of its own before it creates the first named Space; TypeScript does both in one. A Rust primary's history therefore has one entry more; both are valid chains and materialize to the same Space.
- **Notices.** `phi_host::replica_notice` derives the ReplicaConfigNotice of the last completed transition from its configuration entry and signs it as TypeScript does (`test/vectors/replication.json`); a Rust primary leaves it in the control Space every minute (`replicaNotice`, `publishNotices`). `run.ts replica` now also holds that no host reported a refused notice.
- **Moved to step 6:** `mainSync`, a control host whose main store runs on primary/sync (its sibling Spaces follow the transitions, `mainReplica`, `mainTransition` and `mainPromotionProof` for delegation). **Not yet:** the membership of a replicated Space (no gate uses it). The Rust tool read no `status` with `materialize` then (since: the operator's tool for a main store in Rust).


**R6b, step 3, restore in the core (2026-11-02).** `phi_core::restore` is `src/restore.ts`:
- **Port.** `begin_restore` empties the Space under a new incarnation (four seeded random bytes) and epoch and fences its run gates; `restore_batch` installs the snapshot stage by stage (entries, then the historical and current claims in key order, the generations, the run gates) as far as the commit's budget goes and continues from its cursors; `complete_restore` and `release_restored` as in TypeScript, with `importRestoredEntry`, `releaseRestoredEntry`, `fenceGatesForRestore` and `importRestoredGate`. The claims follow the history a restore leaves: `claimBytes` counts `restoredClaims` and `invalidGenerations`, `overheadBytes` the restore and the authority transition, `admit` refuses a replay of a historical request, `validateGeneration` a restored generation, `lookup` answers `restoredHistory` and `unknownOutcome`, and `resolveAdmission` needs an uninterrupted history. `assert_ported` admits `restore`, `restoredClaims` (without negative claims), `invalidGenerations`, `restoredBytes` and `authorityTransition`.
- **Not here.** The stages of a Member's authority transition run inside the host's commit (`member-transition.ts`, they read the permit); they move to step 4 with the Member installer. The core takes only the field, set by a line of its own (`setAuthorityTransition`). Negative claims (`decideNotCommitted`) were not ported then (since: R6b, NotCommitted after a promotion). Historical claims are kept in the document as JSON (the store's rows of them are read into it).
- **Tests.** The core driver gained `keepSource` (the state kept as the snapshot, its hash), `beginRestore`, `restoreBatch`, `completeRestore`, `releaseRestored` and `setAuthorityTransition`. The differential walk keeps a snapshot with entries and requests, restores it (now and then with the wrong hash, incarnation or epoch, a control kind, an ID outside the gate pattern), runs its batches under small budgets so they are cut short, completes it a minute later, releases restored entries, and polls and retries the requests of before. Every answer and state hash agrees; the walk fails if no restore begins, is cut short in the claims, waits, completes or releases, or if no historical claim is polled or replayed. Six faults built on purpose fail it: history not counted, a replay admitted, no `restoredHistory`, restored entries not unverified, gates not fenced, generations not invalidated. The store walks run without restores until the store keeps restored history. First difference found: an empty `spaceId` is no Space identity to a restore, as in TypeScript.

**R6b, step 3, restore in the store (2026-11-02).**
- **Rows.** A tracked commit now records what a restore replaces as a whole (`Changes::cleared`, `log_replaced`) and the historical claims it changes (`Changes::restored`). The Rust store writes them as the TypeScript store does: the maps on the disk (`rpc.claims`, `restoredClaims`) with `partClear` and then their records, the generations key by key, the replaced log compared with its rows as `store/parts.ts` compares an array (a batch that stays keeps its order). `restoredClaims` is a part of its own with the claim index; the head keeps an empty map. On the disk their bytes are the tally (`restoredBytes`, `Space::restored_on_disk`), as for TypeScript's `DiskMap`; in memory their JSON size. A failed commit after a restore gets the claims and the stream back. A Rust host no longer refuses a store with `restoredClaims`; it still refuses negative claims.
- **A TypeScript store bug, found by the store walk.** A map part on the disk replaced as a whole was adopted over rows its own commit had not cleared yet (the write is queued): `DiskMap.adopt` took over the open records of the map it replaced. A restore on a TypeScript host so kept the open requests of before in its claims, and a second restore the history of the first, until the store was reopened. `DiskMap.adopt` now reads the disk only once the commit that wrote the map is durable (`src/store/disk-map.ts`); `test/test-recovery.test.ts` holds two restores over a stored Space before and after a reopen and fails without the fix. Rust's `DiskClaims::adopt` had the same flaw and has the same fix.
- **Tests.** The store walks and the primary cross test run with restores again: answers, state hashes and every row of both files agree, the journal entries of a Rust primary included.
- **A difference the longer walk found (not of the restore).** core.ts keeps the expiry watermark on the published entries array (`committedWatermarks`), so a store's next commit that finds the entries unchanged starts from what the last one set (`setWatermark`, not a draft-only mark); the Rust store started every commit without one, and `nextExpiry` answered FOREVER where TypeScript answers `null` (Infinity, after the last entry expired). A tracked commit now starts from the watermark the entries it begins with carry (`committed_watermark`); `store_walk.rs` holds the case.

**R6b, step 4, a Member's authority transition in the core (2026-11-03).** The stages `MemberTransitionInstaller` runs on each Space of a Member are one function now, `memberTransitionStep(s, now, {recoveryId, newAuthorityId})` in `src/member-transition.ts` (the installer's commit calls it unchanged), and `phi_core::member_transition` is its port: the Space's work cleared, its transactions aborted one per commit, its open requests made history, its decided claims marked `orphanedAfterRestore` (on the disk walked in key order from `claimCursor`, through a new `page` of the claims on the disk, `ClaimSource::after`), its historical claims likewise from `historyCursor`, its generations invalid, then `acceptedAuthorityId`, `rpc.authorityId` and epoch 1. The core driver runs it as `memberTransitionStep`; the core walk (150 000 steps) and the store walk (8 000) run transitions over unfinished ones and agree in every answer, state hash and row, and fail without them reaching each stage, a ResourceExhausted, a request kept as history, a claim and a historical claim marked, a generation invalidated, and (the store walk) the claims on the disk walked. Six faults built on purpose fail them: a request left open, mailboxes not cleared, a generation left valid, a transaction not aborted, no cursor on the disk, the mailboxes not given back by a rollback.
- **Two differences found on the way.** A tracked commit that replaced the outbox, the jobs and the mailboxes as a whole (a restore, now also a transition) and then failed left them empty in memory: they are saved once before (`save_cleared_work`) and a rollback gives them back. And the permit of a routed write (`permitRoutedWrite`) lasted beyond its commit in a Rust store; member-admission.ts keeps it by the commit's draft, so it now ends with the commit there too (the core driver keeps one state, as before).

**R6b, step 4, recovery on the host: the building blocks (2026-11-03).**
- **Endpoint.** `phi_host::recovery_rpc` is `src/recovery-service.ts` and `src/ssh-recovery.ts`: the signed envelope (the vector's `recoveryCall`), the private socket (its directory private to the user, frames of 256 KiB, eight connections, four calls in flight each: `phi_wire::texts`, a frame server for a handler of texts, as `serveSpace` with a `handleText` of its own), the minute a call is valid, the three roles (the pinned operator; the supervisor only for its five methods; a host only for `controlAck`), a replayed envelope answered with the first reply while the handler runs once, `RequestConflict` and `PermissionDenied`. `RecoveryClient` reaches an endpoint over its socket or a provisioned ssh forced command; ssh runs on a thread of its own (no new dependency, no tokio feature).
- **Authority.** `phi_host::recovery` holds `reserve` (`RecoveryCoordinator`), `verify_authority_transition`, `install_authority_transition` and `verify_ssh_fence` (F15).
- **Controllers.** `recovery_controller` (`RecoveryController` and `dataRecoveryHandler`), `control_ack` (`ControlAckService`), `control_recovery` (`ControlRecoveryController`, `controlRecoveryHandler`, `MemberTransitionInstaller` over `phi_core::member_transition`, the Member's recovery-only handler). They work on a `StoreLine`, the host's store behind the transport or one a recovery-only service holds alone, without the boot guard, and await every commit until it is durable (`phi_wire::Owner::durable`), as TypeScript awaits `host.commit`. Where TypeScript reads register versions again inside a commit, Rust reads them right before it: the commit runs at once on the owner thread, so nothing lies between.
- **Store.** A commit that restores a Space names its new incarnation in the registry in the same commit (`Space::registry_incarnation`), as `RecoveryController.advance` and the control restore change `Registry.spaces[id].incarnation`.
- **Tests.** `phi-host/tests/recovery_cross.rs` runs 37 steps through both: `test/support/recovery-driver.ts` builds a directory (a data source and its backup, the target, a control host and its backup with its routing Members, a control target, a Member with work, the register and each installed register), and each side runs the steps on a copy: a data restore refused before the source is fenced and then completed with the control host's receipt, its release, a control restore under a new authority with the target's own installation and the Member's, a first admin key and an old key refused, refusals on the way. The fence checks are the real ones over `ssh`, answered by a stand-in on PATH; randomness is the drivers' seeded stream. Every answer and every row of every file agree (a document's JSON compared as a value, and the index marks a Rust store sets when it opens every Space at once left out). Six faults built on purpose fail it: no revoke before the import, no registry incarnation, no ACK published, Members not blocked, an old key revived, a release not bound to its arguments. `phi-host/tests/recovery_rpc.rs` holds the endpoint's roles, window, replay and codes.

**R6b, step 4, recovery in `phi-space-server` (2026-11-03).**
- **Daemon.** A Member and a control host take `recovery`: the private endpoint beside the normal runtime (`writerTls` or `writerSshTarget` for the operator's register, the snapshot directory, the fence targets, the control endpoint over its socket or ssh), with the data recovery controller where a writer is provisioned and the control host's receipt on a control host, as `startConfiguredRecovery`. `writerSocket` (the register's socket service, not ported) is refused by name. A host follows an installed successor of a control restore (`installed-authority`: its authority and control key; one for another control host needs it reprovisioned); an installed change of the control host itself still stops a Rust start (step 6).
- **Recovery-only.** `phi-space-server --store FILE --recovery-only CONFIG.json RECOVERY.json` is `startRecoveryOnly` (a control host: control restore, its own installation, key authorization) and `startMemberRecoveryOnly` (a Member: the signed installation only), by the config's mode; the normal runtime counts as stopped and restart-locked as the independent fence status says (`fenceStatus`, the test bed's `assertQuiesced`).
- **Acceptance.** `npm run testbed:federation -- restore C-M-B` and `-- control-restore C-M-B` pick the runtime of the control host, the Member and the restore target (`host.ts` and `replica-host.ts` start `phi-space-server` on the same files). `restore` passed as `ts-ts-ts`, `ts-ts-rust` (a Rust target behind a TypeScript control host's receipt), `rust-ts-ts` (a Rust control host's receipt) and `rust-rust-rust`; `control-restore` as `ts-ts-ts`, `ts-ts-rust` (the Rust control target restores, installs, authorizes, completes and then serves under the new authority), `ts-rust-ts` (a Rust Member installs over its recovery-only service and comes back under the new authority) and `rust-rust-rust`. The scenarios' assertions hold for each: the client answered from the backup, the release, the fenced host refused to boot, an old key not revived, a grant of the old authority refused by its signature and the old key as revoked. The federation (`both`) and `replica rust-rust` still pass.
- **Held to its runtime.** Both runtimes answer the scenarios alike, so each scenario holds every container it starts to the runtime it was asked for (`docker top`: `phi-space-server` runs in it or not), the recovery-only services included.
- **ssh.** The operator's register over ssh (`writerSshTarget`, `registerSshTarget`) and a recovery call over ssh (`controlEndpoint.sshTarget`) are held by `phi-host/tests/recovery_ssh.rs` through a stand-in for ssh that answers the forced commands on this machine (`test/support/ssh-stand-in.ts`): reads, writes, a conflict, the read-only login, a refused login and an invalid target answer as TypeScript's `SshRecoveryRegister` through the same stand-in; with the conflict taken out of the mapping it fails. The forced commands themselves (the server side of the register and recovery logins) are not part of this repository.
- **A-only after a control restore.** Without an `access:` policy, a control host whose Space was restored under a new authority (`restore.kind` "control") gives no A-only grant, as `allowAOnly` decides; with a policy, the policy does.
- **The registry in a commit.** A commit borrows the registry and copies it only when it names a new incarnation.

**R6b, step 5, entry replication (2026-11-03).**
- **The controller.** `phi_service::entry` is `src/entry-replication*.ts` and `src/replication-clock.ts` whole: the hybrid clock, local changes of lww and set types with their retries, imports with every check (`equivalent` of an original and its redaction, the floor, an origin's monotonic clock, a remove or renewal and what it names), erasure and redaction with the renewal fixpoint, the materialized history over snapshot segments, `read`, `changes` and the v1 snapshot, the pull stream with its checkpoints, positions and peer vectors, the paged snapshot transfer and its export cache, maintenance and compaction (`plan`, dropped runs and the floor), `forgetSnapshotReceipt` and `compact`. Its six document families stay beside the Spaces: a step reads them and commits only them (`Store::commit_documents`, no Space and no registry touched, as `host.commit` of such a step), and what it committed is kept until the file has it, since `stored_document` reads only what is durable.
- **The walk.** `phi-service/tests/entry_walk.rs` runs three replicas, each on its own file, through `test/support/entry-driver.ts` and through Rust on a copy: local changes, retries, erasures, imports changed on purpose, the stream between replicas, whole and broken-off snapshot transfers, maintenance and compaction runs, writes of one lww key on two replicas at the same moment, a renewal made after its tag's owner was erased elsewhere, a quiet federation drained and compacted, restarts, a check that refuses and a clock that may not be trusted. Every answer agrees, then every row of every file; then each side opens the other's files and goes on (`PHI_ENTRY_WALK_STEPS`, 1500 by default; seeds 1 to 4 passed, 6466 to 6946 calls each). The walk of the default seed must reach finished and aborted imports, a changed page imported again, seeded streams, positions that are not contiguous, redactions in the stream and a renewal redacted with its tag, compactions that drop changes, finished maintenance and compaction generations, and a compaction blocked by a peer that lowered its vector; other seeds explore and may miss one of the rarer states. Six faults built on purpose fail it: the lww tie-break turned around, a set remove ignored, the floor check left out, `mergeRuns` without adjacent runs, the renewal fixpoint skipped, and a redaction that does not replace its original.
- **What the walk taught the generator.** A request ID used again after its change was compacted away is a new change, and every replica that still holds the old one refuses the stream for good with "origin request ID reused"; the retention of own changes (24 h by default) exists for that, and the walk retries only within it. A change forged with another sequence or request ID passes where its original is not held yet and poisons that replica the same way, and a lowered peer vector marks the peer regressed for good: both only in the walk's last phase.
- **On the wire.** `SpaceService.mergeCall` is in the Rust service (`Service::merge`): writes, reads, `readAll` and `count` of the merge types, `take`, `wait` and transactions refused with `MergeTypeNotExclusive`, a lease renewed or cancelled as a new version, its retry answered from the stored change, and `batch` refused on such a Space. `phi-service/tests/merge_service.rs` holds every reply byte for byte against the service driver with `merge` on (`PHI_MERGE_WALK_STEPS`). It found that the first Rust port created the default Space with the first merged write, which TypeScript does not: the documents of entry replication are not the Space's.
- **On the host.** The gate serves `entryDescribe` and `entryChanges` to proven service peers that the replication pins (`phi_host::entry_pump`), every refusal as `PermissionDenied`; one pump per peer pulls its stream over the peer's gate, retries a failed line with a growing pause, and starts again five seconds after any other failure; `compactEveryMs` runs `compact`. `phi-space-server` takes `entryReplication` on a Member and on a control host, as `startConfiguredFederation` does, with its start checks (an unknown Space, `compactEveryMs`); no acceptance runs it on a control host yet. A pump and the compaction timer read the register with every Space of the store before the controller's checks, as the gate does before a call: the guard's last read is shared with the calls it guards, and their erasure barriers are part of it. What the controller keeps of its documents holds an empty entry for every chunk it retired, so it grows by a few keys with each compaction on a host that runs long.
- **Acceptance.** `npm run testbed:federation -- entry A-B` picks the runtime of replica-a and replica-b (`replica-host.ts` starts `phi-space-server --member` on the same files, and prints its ready line for the scenario). It passed as `ts-ts`, `ts-rust`, `rust-ts` and `rust-rust`, each container held to its runtime (`docker top`, after the restart too): a host cut off and killed catches up, a removal made while the other was cut off arrives, the later of two writes of one key wins on both, a `take` is `MergeTypeNotExclusive`, and the TypeScript reader of the stopped stores finds the same three entries in a file a Rust host wrote.

**R6b, step 6, a control host change (2026-11-03).**
- **The change.** `phi_host::control_host_change` is `src/control-host-change.ts`: a change verified against the pinned recovery admin key, recorded in the authority record only once the register shows the promotion, and followed by a host. `phi-host/tests/control_host_change.rs` runs 23 steps through TypeScript and Rust on copies of the same register files: a register not provisioned, an unpinned signature, a malformed change, a target that is not the primary yet, an old host still holding a permit, the change recorded and recorded again, a recovery ID used for another change, a host that follows it once and then has nothing to follow, one whose installed authority disagrees. Every answer and every record agree; three faults built on purpose fail it.
- **A Rust Member follows.** `phi-space-server --member` takes `recoveryAdmin`: before anything else at its start it follows a recorded change, and an installed change replaces the control host, its address and its key in the config, as `startConfiguredFederation` does; while it runs it asks the register every 15 s and ends with 75 once it followed one, printing `controlHostChanged`.
- **A Rust control host on a primary/sync main store.** `phi-space-server --control` takes `mainSync`. A host that is not the journal's primary, or is in quarantine, only listens as the main store's replica (`mainReplicaListening`); the primary recovers the store under the journal and serves it (`SyncSpace` with the host's own store in place of a Harness, without a replica listener). Every Space of the store is admitted only as the primary of the journal's configuration, the policy step of the last control transition runs before anything is served (`align_control_replica`, `alignControlReplicaIn`), and router leases and epoch notices carry the journal's control epoch. A control host takes `recoveryAdmin` as a Member does. `phi-host/tests/control_align.rs` holds the policy step against TypeScript on copies of one store (no routing, routing without a policy, a policy, an open profile transition, a policy of another authority; each transition twice, then the next): every answer and every row agree.
- **Ordering.** The old control host started by hand must fail on its main store before it follows anything: following first, it would read the change and stop with a wrong identity instead of `BootBlocked`. The main store is recovered first, then the change followed, then the installed authority read.
- **Not carried.** At this step a promoted control host answered a `resolveOperation` of an earlier epoch with `IncarnationChanged` where TypeScript, with the journal's promotion evidence, answers `NotCommitted` (carried since: R6b, NotCommitted after a promotion). `syncSpaces` on a control host stays refused. The operator's tool for a main store (`status`, `promote`, `degrade`, `set-standby`) was then the TypeScript one on the Rust host's files (carried since: R6b, the operator's tool for a main store in Rust).
- **A difference seen in the scenario.** Without its control host, a TypeScript Member gives a call with a held grant no answer before the client's timeout (its key lookup throws); a Rust Member answers `PermissionDenied` "unknown key for this peer". Both refuse; the answers differ.

**R6b, NotCommitted after a promotion (2026-11-03).** v3 6.2: a request unknown on a promoted primary, of an epoch before the promotion, is answered `NotCommitted` only with the journal's evidence, by a durable negative claim that a late original call meets.
- **Core.** `Space::decide_not_committed` is `claims.decideNotCommitted`: the binding checked, a known claim answered as it is (another method or hash a `RequestConflict`), a retained and admitting generation of an earlier epoch, an uninterrupted history, then a terminal claim with `error` and `notCommitted` against `maxClaimBytes`, due for its retention like any decided claim. `admit` meets it with `NotCommitted` before a pending or expired answer. A document or a store row with negative claims is no longer refused. The core driver has `decideNotCommitted`; the walk's own episode makes such claims and the required outcomes name each answer (decided, known, `TypeError`, `IncarnationChanged`, `RequestConflict`, a late admit `NotCommitted`); `boundaries.rs` holds the claim at `maxClaimBytes` and at its retention edge. Five faults built on purpose fail them: the late admit checked after the retention, the epoch compared with `>`, the bytes not counted, no due time, the history check left out.
- **Evidence.** `phi_store::sync::promotion_evidence` is `promotionEvidence`: this host the primary with nothing unresolved, the chain covering the request's epoch, every configuration since and the hash of that body. The journal walk (`sync_journal.rs`) asks it as either replica for earlier, current and malformed epochs, against TypeScript; it must find evidence and refuse it.
- **Service.** `resolveOperation` takes an `IncarnationChanged` miss, or a `notAdmitted` of another epoch, to `promotion_proof`; with evidence it decides the claim in a commit under the call's authorization, without it the miss stands. The service asks `epoch_for_space` for a Space's epoch at each call (the frame check, `generation`, `hello`, receipts), as `epochForSpace`; `space_epoch` is the federation host's (a replicated Space's journal, else the Space's own, else 1, 0 for none), and a resolution's binding names the Space's own epoch where it has one. `phi-service/tests/not_committed.rs` holds every reply and state against the service driver (`epochs` on init, an `epoch` line sets the epoch and the evidence), in memory, by alias and on a store file.
- **Hosts.** A served primary/sync Space reads its epoch from its journal at each call and gives its evidence (`SyncSpace::serve_options`); a Member's own Spaces their own epoch; a control host on a primary/sync main store the journal's epoch for every Space in it and the journal's evidence (`mainPromotionProof`).
- **Delegation of a replicated Member.** `DelegationVerifier` takes `replica_config` (the boot guard's view of each served primary/sync Space): the epoch comes from the configuration, new work under another configuration version is `ReplicaConfigPending` until the router adopts it, follow-ups of earlier work keep their binding, and a missing resolution of an earlier epoch reaches the service. `test/test-delegated-calls.test.ts` has a replicated Member (`Replicated` of gate-under-test: version, epoch and evidence from files) and runs on both servers: pending until adopted, a promotion, an epoch ahead refused, a follow-up under its original binding, a resolution without and with evidence, the late original. Four faults built on purpose fail it on the Rust server: either `ReplicaConfigPending` check left out or narrowed, the epoch taken from the document instead of the configuration, the evidence never asked.
- **Acceptance.** `run.ts replica` resolves the fork write, sealed only on the killed primary, on the promoted host after degradeToSingle: `NotCommitted`, the original sent again meets the claim, and the count stays. It passed as `ts-ts`, `ts-rust`, `rust-ts` and `rust-rust`; `change rust-rust`, `both`, `restore` and `control-restore rust-rust-rust` and `entry rust-rust` pass again.
- **Still not carried.** At this point the Rust control host took no delegated calls (since: R6b, a control host as Member); `syncSpaces` on a control host stays refused.

**R6b, a control host as Member (2026-11-03).** In TypeScript any host takes what a Member takes (`startConfiguredFederation`); the Rust control host refused it.
- **Acceptance first.** No TypeScript acceptance had a control host serve as a Member, so `test-mixed-member` gained one before the port ("a control host is also a Member"): a router's delegated generation, write and count on the control host's own Space under the policy it signs, a version it does not sign refused, its signed membership instructions to itself as Member c (a forged one refused), a run prepared, released and stopped on that Space, a second Space archived and reactivated, the Member's Space and an unpermitted create refused, and a type the policy gives Member a refused there.
- **Port.** The control host builds its `DelegationVerifier` as `verifierFor(host, mainReplica)`: itself the supervisor with its own key, its own policy read from its routing document (`Routing::installed`; `DelegationOptions.policy` now takes the store), the replica configuration of a primary/sync main store. Its grants and delegations go through `authorize` instead of grants only. `membership`, `runGates` and `spaceLifecycle` come from one function for both hosts (`member_instructions`), pinned to the host itself on a control host. `test-mixed-member` passes in all four pairings, its refusal lists hold what each host refuses today (two were stale since steps 4 to 6), and three faults built on purpose fail the new case on the Rust control host: the policy version off by one, the instruction pin on the host ID, the supervisor on the host ID.
- **Found on the way.** The Rust control host served no `replicaNotice`: a Member's notices reached only a TypeScript control host, and every `replica` run so far had one (carried since: R6b, the notice board). Open on the control side then: `adoptReplicaConfigNotice`, `replicas` per Member of the Root and the successor of a replicated Member in `FederationRpc`, `reconcileDataRestore` (carried since: the sections below). `syncSpaces` on a control host stays refused; no TypeScript acceptance runs it.

**R6b, the notice board on a Rust control host (2026-11-03).** `phi_host::replica_notice::publish` is `ReplicaNoticeBoard.publish`: a notice whose issuer is its primary, a Space ID of at most 128, at most 4096 bytes; published by a proven host under a host grant whose host binding names the issuer or whose proven key signed it; the grant and the key checked before the commit and in it; one entry per Space and issuer, the older ones taken, the same notice again not stored. The control host's gate serves `replicaNotice` with every refusal as `PermissionDenied`. `run.ts replica A-B-C` now takes the control host's runtime too, holds every container to its runtime, and at the end reads the control Space: exactly the promoted primary's notice of the last transition (version 4, epoch 3, `standby-1`). It passed as `ts-ts-ts`, `rust-rust-rust` and `ts-ts-rust`; with the older notices not taken it fails with three.

**R6b, the operator's tool for a main store in Rust (2026-11-03).** `phi-space-server --store FILE --replica-tool CONFIG REQUEST` works on a control host's main store (`mainSync`, the host's store as its harness) as on a Member's primary/sync Space: `status`, `wipe`, `promote`, `degrade`, `set-standby`. The transitions take the main store's sibling Spaces (`Common.sibling_spaces`, `siblingSpaces` of src/replica-control.ts): their permits follow role and versions on this host with their own data incarnations, the setStandby target gets them with this host's, and a sibling without a permit stops the transition until it is given one (`replica_transitions.rs`). `status` with `materialize` applies the accepted history and reads the Space (its `Ledger` entries and the hash of its document). The test bed now runs the tool of the host's runtime for both: `replica ts-rust` compares the materialized snapshot of the TypeScript tool on replica-a with that of the Rust tool on replica-b, and `change rust-rust` and `rust-ts` move the main store with the Rust tool; `replica rust-rust` passes too.

**R6b, a data restore reconciled in the journals (2026-11-03).**
- **Where it stands in operation.** `startConfiguredFederation` does not hand `reconcileDataRestore` to the recovery service, so a configured TypeScript control host refuses the receipt of a data restore of a Space the routing names ("managed Data restore requires Router/parent reconciliation before acknowledgement"); the Rust control host refuses it with the same words. Only the library functions remained.
- **Port.** `RouterController::reconcile_data_restore` is `reconcileDataRestore` of src/router.ts (every command with a step on the restored binding to review, its outcomes kept, nothing sent again); `FederatedSpace::reconcile_data_restore` is that of src/federated-space.ts: the binding checked, the restore held in the journal layout while it runs (another one refused, a broken one retried), every router reconciled, the parents with a target on the binding, a Member of it or a reconciled child to review, one parent document per commit, then the layout freed.
- **Tests.** The router walk (`router.rs`) and the walk of `FederatedSpace` (`federated_space.rs`) reconcile late in each walk or season against `router-driver.ts` and `federated-driver.ts`, with unknown hosts, other incarnations, bad IDs and an unknown key; both must reach a reconciliation that sends something to review. Faults built on purpose: the command's own state left out and the layout never freed fail them; a parent found only through its children is not reached, since the walk's parents name the binding of their children themselves.

**R6b, the Root with a replicated Member (2026-11-03).**
- **Acceptance first.** No local scenario had a Root route to a replicated Member (`phase3-final-root` runs on big only), so `run.ts root-replica A-B-C` was written and passed in TypeScript before the port: the Root on the control host routes the replicated Member `r` (the primary/sync Space of replica-a and replica-b, `replicas` in the Root's provisioning); a write lands on the primary; with the standby cut off the next is sealed on the primary only and not answered as written; the primary is killed, the standby promoted and degraded to single behind the container fencing adapter; the Root adopts the promoted primary's notice (Member `r` at replica-b, epoch 3, configuration 3, single) and routes there; the sealed write resumed through the Root runs there exactly once, as its fork was never committed; the next write lands there too, three in all.
- **Port.** `MemberEnd` carries the replica hosts' endpoints (`endpointOf`, `provisionedTarget`); a Root's line follows the routing target to its host, the status probe, the start check and the membership pin accept a target on a replica host; the Root checks every endpoint's overlay pin at its start (the provisioned ones were not checked before). `Root::adopt_notices` is `adoptAll` with `adoptReplicaConfigNotice` before every heartbeat: the notice's shape, its primary's signature with the provisioned key, the register's permit read before and again before the commit, no open profile transition, the routing document's Member, replication, primary rules and policy version raised, `noticePolicyVersions`, in one commit with the control Space's counter (`phi_host::replica_notice`). `FederationRpc` takes the successor of a binding (`bound`): such a Member only resolves the bound request, under the bound epoch, and `reprepare` prepares a step anew under the current policy when every version since its own came from an adopted notice.
- **Tests.** `federation_rpc.rs` now also routes replicated Members whose target moved on (another host, a higher epoch, another incarnation) under policy versions that notices raised, against `rpc-driver.ts` (whose challenge now answers the installed target's host); it must reach a reprepared step, and with successors left out it fails. `root-replica` passed as `ts-ts-ts`, `ts-ts-rust` and `rust-rust-rust`; with the Root's line on the provisioned host it fails. Its sealed write is sealed at its generation already, so the gate never binds a step to the old primary: the successor path is held by the cross test only. `both` and `test-mixed-member` in all pairings pass again.
- **Not reached by the gate.** Its sealed write is sealed at its generation already, so no step is bound to the old primary; see the tests above.
- **A difference seen.** In front of TypeScript replica hosts a TypeScript Root answered the sealed write `Unavailable` (the Member's sealed commit), a Rust Root `FederationPending`; in front of Rust replica hosts the Rust Root answered `Unavailable`. Each left it unresolved and resumable, and its resumption ran it once.

**R6b, acceptance in TypeScript in the local federation (R-D3).** Before any port, each with kills and cut-offs: primary/sync with the primary killed, promotion with the container fencing adapter, `degradeToSingle` and `setStandby`, a control host change, a control and a data restore, entry replication with a Member cut off. Each scenario holds what clients were answered and what the stores contain afterwards.

**Content:**

- `router.ts`, `federated-space.ts` and the root/controller sides of delegation and membership; the member contracts
  needed for R5b are not postponed to R6.
- `entry-replication*.ts`, `primary-sync.ts`, `replica-control.ts`, fencing (netcup, container).
- `recovery*.ts`, `restore.ts` and the complete boot/recovery composition beyond the check paths from R5b.
- `run-controller.ts`, `workers.ts`, the controller side of `space-lifecycle.ts`, `deployment.ts`, `alerts.ts`.

**Deferred because:**

- Replication and promotion are, according to `implementierungsstand.en.md`, "begun, not accepted". Porting a draft that
  has not been accepted only doubles the open work.
- **Decision R-D3:** first accept, then port, or redesign in Rust. Until then a root
  or a host with replication/recovery keeps running in TypeScript.
- After **separate acceptance of R5b**, Rust members can run behind the TS root. Shared frames alone
  are not enough: The signed instructions must be checked and executed with the same admission/RunGate semantics.
  Replicated members or members in recovery are not approved by this.

### R7: Tools (optional)

- `dashboard.ts` and the TUI only read. They can stay in TS because they read over sockets.
- A port (`ratatui`) pays off only if a Rust binary without Node is wanted on the servers.
- `scripts/bootstrap-spaces.ts` follows `deployment.ts` in R6.

### R8: Server processes of spaces-mmo

Presupposes R3 and the measurement decision R-D2 and can run in parallel to R4–R7. Today the processes are clients of the
Space and carry no durable game state of their own: The world lives in the world Space, the accounts live in the
accounts Space (`spaces-mmo/docs/architektur.en.md`). Caches, connections and running tasks stay process-local.
Therefore here too one can swap process by process. Several world workers may run at the same time; every
intent is taken by exactly one. So a Rust worker can work next to a TS worker on the same world.

**Scope:**

| Process | Files in `spaces-mmo/server/` | Lines (approx.) | Target |
|---|---|---|---|
| world | `world-host.ts`, `engine/*` (commands, cmdsets, locks, FuncParser, typeclasses, prototypes, world time and clock, schedules, fire/flood/fog/storm, gardens, trade, building, sweep, regions and handover, translation rules, help) | 4,500 | Rust |
| npc | `npc-host.ts`, `npc/*` (scripts, economy, role claims, model roles) | 1,000 | Rust |
| web | `index.ts`, `accounts.ts`, `gateway.ts`, `chat.ts`, `region-spaces.ts`, `settings.ts` | 1,750 | Rust |
| shared | `space.ts`, `model.ts`, `env.ts`, `launch.ts`, `migrate-regions.ts`, `world-load.ts` | 700 | Rust |
| model | `model-host.ts`, `llm.ts` | 220 | stays TS |
| space | `space-host.ts` | 100 | dropped, Rust server from R3 |

**Contracts that must stay:**

- **Entry fields** from `model.ts` (Intent, Character, Item, Room, Exit, Msg, Session, Translate, WorldClock,
  Bed, Building, Listing, Offer, Order etc.) and the world version (`WorldDef.version` in the source state recorded for the acceptance). They are the interface between the processes and stay the same in mixed operation.
- **Gateway frames** (`ClientFrame`/`ServerFrame` in `gateway.ts`, chat frames in `chat.ts`). The browser client
  depends on them.
- **Accounts:** scrypt with N=16384, r=8, p=1 and 64 bytes length, salt and hash hex; session cookie `mmo_sid`, only its
  hash stored. Existing accounts must be able to log in after the switch.
- **HTTP API:** paths, header `x-mmo: 1`, cookie SameSite=Strict, rate limits
  (`SPACES_MMO_REQ_PER_MIN`, `SPACES_MMO_GUESTS_PER_HOUR`), setup token.
- **Environment variables** of the processes, as they stand in the header comments, so that `docker/` and `launch.ts`
  stay unchanged.

**Preparatory work in TypeScript (R8.0):**

1. **World definition as data.** `worlds/leuchtfeuer/world.ts` and `islands.ts` become a JSON file that
   both sides read. This already corresponds to the rule "a world brings data, never rules" (`engine/world.ts`).
2. **Model calls only in the model process.** The model roles of the NPCs (`npc/minds.ts`) call `complete()`
   directly today. Instead they write a request as an entry, as `Translate` already does, and the model process
   answers. After that the npc process needs no pi-ai.
3. **Shared types for the browser.** The client imports types from `server/gateway.ts`, `chat.ts` and `model.ts`
   as well as `formatWorldTime`/`shownWorldMs` from `engine/worldtime.ts`. The types move to `spaces-mmo/shared/` and
   are generated from Rust in R8. The two functions remain as a small TS copy with test vectors, as
   `test/test-shared-copies.test.ts` checks it for other copies.
4. **Static page.** The Next app is a single page (`app/page.tsx`). With `output: "export"` it becomes
   static files that any web server can deliver. The check of the build id (`.next/BUILD_ID`) moves into a
   file that the export writes along.
5. **Randomness and clock injectable.** The engine uses `randomBytes`/`randomInt` and `Date.now()`. Both come via
   the context, so that both sides run in the comparison tests with a fixed start value and a fixed clock.
6. **Test setup with commands.** `tests/stack.ts` already starts space and world as processes, the web part runs in the
   test process (`startServer`). New: `SPACES_MMO_WORLD_CMD`, `SPACES_MMO_NPC_CMD`, `SPACES_MMO_WEB_CMD` choose the
   program, and web then runs as a process too.

**Steps:**

| Step | Content | Acceptance |
|---|---|---|
| R8.1 | `phi-spaces-client` complete: `RemoteSpace` semantics (stable request ids, retries, notify/wait/events/ACK, pending/poll) and the helpers from `src/space-client.ts` (`parseTarget`, `connectSpace`, `readExisting`, `StillHeld`, `takeAll`, `awaitWork`, `keepAlive`) | client scenarios of groups A/B via the adapter from section 5 against TS and Rust server; security cases only with R5/R5b |
| R8.2 | Crate `mmo-engine`: all commands and ticks | comparison test: the same intent sequence with fixed clock and fixed start value against two memory Spaces, once TS, once Rust engine; entries and messages canonically equal. Plus the engine tests (`engine`, `world`, `weltzeit`, `garden`, `build`, `economy`, `collision`, `translate`, `help`) as vectors |
| R8.3 | Binary `mmo-world` | `npm --prefix spaces-mmo test` with `SPACES_MMO_WORLD_CMD`. Mixed operation: one TS and one Rust worker on the same world, `phase1`–`phase5` green. `test:perf` and `live-load.ts`: TS/Rust at the same source state per the R-D2 procedure, not against the historical R0 table |
| R8.4 | Binary `mmo-npc` | `economy`, `errands`, `phase2`, `phase5` with `SPACES_MMO_NPC_CMD`; role claims shared between TS and Rust process, no role twice |
| R8.5 | Binary `mmo-web`: HTTP, WebSocket gateway, accounts, chat, regions, settings, static page and graphics | all tests with `SPACES_MMO_WEB_CMD`; login with accounts from a TS run; `walk-play` and `regions-live`; once by hand in the browser on `docker:local:up` |
| R8.6 | Docker: `spaces-mmo/docker/` builds the Rust binaries (musl) into the image; the model process stays a Node container | `docker:local:up` entirely in Rust except model; then nano and big **only after asking**. Way back only to the checked TS version pair within the rollback window |

The deterministic engine comparison also controls tick/timer order and the randomness sources of the clients
involved; it starts with logically identical Spaces and processes the same inputs step by step. A fixed clock and
seed alone do not make parallel workers deterministic. Mixed operation is checked separately with competing
intents, role claims, lease expiry, worker abort and schedules.

**Way back and engine freeze (R-D12):** Freezing the TS worker after R8.3 permits no unlimited
downgrade. Until the end of the agreed rollback window, entry schemas, world definition and rules
stay compatible with the recorded TS state and switching back is tested. Changes that break this
end the way-back commitment for this version pair and need a new migration/approval plan.

**Limits of R8:**

- The browser page (`client/`, `app/`, PixiJS and three) stays TypeScript.
- The model process stays TypeScript (R-D7).
- codemode-chat is not part of this phase.

## 7. Mobile runtime

`npm run bundle` builds `dist/phi-spaces.mjs` (Space and agent, `agent/src/with-agent.ts`) for `pi-termux-mobile`
(Node under Android). The agent stays TypeScript, so the bundle stays.

**Options for the Space part on the phone (decision R-D4):**

| Option | Advantage | Disadvantage |
|---|---|---|
| a) Keep the TS Space in the bundle | nothing to do | two implementations in the long run, and the differential tests must stay |
| b) Rust binary for `aarch64-linux-android` as a process of its own, the bundle speaks `RemoteSpace` over a Unix socket | one implementation, seam like everywhere | cross-build, a second process under Doze |
| c) Rust as a Node addon (napi) or WASM in the bundle | one process | new build chain, and SQLite in WASM needs its own VFS |

**Recommendation:** a) until M1 is accepted, then b). R4 alone is not enough. The keystore signatures stay on the
Java/Android side; the server only checks them.

### M1: Mobile process and agent binding

**Prerequisites:** R3/R4 for a local Space; for today's federated phone host additionally R5/R5b
and the R6 recovery paths actually needed. Without their acceptance the federated host stays in TS.

**Work:**

- Connect `AgentSpaces` over the socket: separate conversation principals, generations and request identities remembered
  in the agent store before the call stay preserved. A single fixed standalone peer id does not replace
  `localSpaces`; the local authentication/assignment of the conversations needs a defined contract.
- Replace the previous `withEventSink` bridge across the process boundary: deliver events/mailboxes to
  conversations, use idempotent submit ids and acknowledge only after durable acceptance. Undeliverable
  takes must release their txn according to the previous contract; process aborts must not silently lose anything.
- Android cross-build for `aarch64-linux-android`, SQLite/file permissions, start order, ready/shutdown contract,
  shared process supervision, socket reconnect and restart under Doze.

**Acceptance:** Agent replay and conversation isolation against TS and Rust Space, abort of both processes at the
submit/ACK boundaries, continuation of open waits/txns after reconnect; device check with background/Doze as well as
keystore/pairing check for the federated mode. Real device/test bed runs happen after asking.
Choice b) does not automatically end the TS reference or the in-process API (R-D5/R-D13).

## 8. Risks

| Risk | Countermeasure |
|---|---|
| Deviation in canonical JSON (numbers, UTF-16 sorting) makes claims invalid | golden vectors from R0 and cross operation; check generations from TS files in Rust |
| JS strings or parser limits are treated differently in Rust | resolve R-D10 before R3; check acceptance and rejection against TS, do not count a known deviation as golden success |
| Subtle semantics in the core (waiter race, lease limits at `FOREVER`, txn abort) | differential harness with fixed sequences and stateful generator; `proptest` optional |
| Two implementations drift apart as long as both live | changes to the wire protocol and the core only with vector update; both servers in CI (`npm test` with and without `PHI_SPACES_SERVER_CMD`) |
| The gain is small: Node with SQLite is already fast, latency lies rather in the network | measurement point R-D2 after R3, before R4–R6 begin |
| Effort | R0–R3 comprise about 6,000 lines of TS, namely core, store, service and socket. R5 adds about 1,500, R6 the rest (about 9,000) |
| Game rules in two languages drift apart; a frozen TS worker is no longer backward compatible | mixed operation for R8.3; afterwards Rust engine, TS state frozen; rollback only within the versions kept compatible and the period from R-D12 |
| New game features (see `spaces-mmo/docs/phasen.en.md`) during R8.2 | branch R8.2 off the current state; every change to the TS engine code gets a comparison case and is followed up in Rust before R8.3 is accepted (R-D8) |
| New toolchain on big/nano | statically linked binary (musl) into the existing Docker images; nothing is installed on the servers |

## 9. Decisions

| No. | Question | Decision |
|---|---|---|
| R-D0 | Approval of the crates from section 4 | **decided 2026-10-29:** approved |
| R-D1 | Same SQLite file or own format | **decided 2026-10-29:** same file |
| R-D2 | Continue after R3? | **decided 2026-10-29:** only if the CPU per command in the Space process falls clearly (goal: at least a factor of 2) or the memory need falls; corrected measurement procedure in "Status R0", finding 3; open quantitative addition R-D11 to be clarified before acceptance |
| R-D3 | Port federation, redesign or leave in TS | **decided 2026-11-01:** R6b is accepted in TypeScript first, in the local federation (kills, cut-offs, fencing), and ported afterwards |
| R-D4 | Space on the phone | **decided 2026-10-29:** a), later b) |
| R-D5 | Does the TS server stay permanently? | **decided 2026-10-29:** TS stays as reference and for in-process use (`PhiSpaces`), at least until R-D4 b). The phone switch alone does not end these two tasks; a later removal needs R-D13 |
| R-D6 | World definition as JSON instead of TS | **decided 2026-10-29:** JSON (R8.0) |
| R-D7 | Model calls of spaces-mmo | **decided 2026-10-29:** leave in the TS model process (pi-ai: model list, environment keys and `~/.pi/agent/auth.json` with OAuth), connect NPC roles via entries. Rejected: direct HTTP calls from Rust, because the credentials would then be managed in two places |
| R-D8 | Game development during R8.2 | **decided 2026-10-29:** keep developing in TS, Rust follows |
| R-D9 | Additional crates for R8: `axum` or `hyper` (HTTP), `tokio-tungstenite` (WebSocket), `scrypt`, `ts-rs` (TS types from Rust), `tower-http` (static files) | **decided 2026-10-29:** approved |
| R-D10 | Lossless JS strings or a joint contract change? | **decided 2026-10-30:** contract change. Texts in the Space are well-formed: The service replaces a lone surrogate at the input with U+FFFD, Rust likewise (`parse_repairing`); a store with such a value is not opened. Before the move in R4 the stores are read again |
| R-D11 | Quantitative addition to R-D2 | **decided 2026-10-30:** if the CPU misses the factor of 2, the RSS must fall by at least 50 %; p95 and p99 per load profile not worse than TS; no additional errors or timeouts |
| R-D12 | Rollback window and compatible version pairs | **open, before R4 and again before R8.3:** set duration, TS/Rust versions, supported schemas/features and downgrade limits; check switching back with running work |
| R-D13 | Later removal of the TS reference/in-process implementation | **open, no part of the phone approval:** only with a replacement for reference tests and `PhiSpaces` in-process use or an explicitly decided API change; until then TS is kept |

Security and federation decisions from the reviews of 2026-11-01 (`review-typescript-2026-11-01.en.md`, `review-rust-2026-11-01.en.md`). They bind both servers; "open" names what is still to be built.

| No. | Question | Decision |
|---|---|---|
| S-D1 | A signed `recover` instruction could be replayed: no expiry, no nonce, and every differing `recoveryId` fenced the gate anew | **decided 2026-11-01:** the instruction carries `expiresAt`, 60 s after issue, and a Member host refuses an expired one; no nonce list, the gate's history already dedupes gate commands. Done in TS and Rust (f5a553d) |
| S-D2 | Grant scope checked against the raw `call.space` on direct calls, against the alias on delegated calls | **decided 2026-11-01:** always against the alias; the gate resolves `call.space` before the check, as the delegated path does. Open: TS and Rust together, with the next R6a slice |
| S-D3 | `createEnroll` without `scope` gives a key with `scope: []` that passes no Space and says nothing | **decided 2026-11-01:** refused with `IllegalArgumentError`; no silent default. Open: TS and Rust together |
| S-D4 | Two defaults for the group `space-hosts`: `["member"]` in `gate.ts`, `["member","host","router"]` in `configured-runtime.ts` | **decided 2026-11-01:** one default, exported from `gate.ts`, with the deployment's roles `["member","host","router"]` (that is what the local federation runs); `configured-runtime.ts` and `profiles.rs` take it from there. Open |
| S-D5 | `enroll` answered every failure as "enrollment refused" without audit; `rotation` mapped `IllegalArgumentError` to `PermissionDenied` | **decided 2026-11-01:** the device's answer stays the generic refusal (it learns nothing about tokens), the audit event `failed` carries the error's name; `rotation` answers `BadRequest` for `IllegalArgumentError` and `PermissionDenied` otherwise, the wire has no code for `BootBlocked`. Done |
| S-D6 | Asynchronous supervisor commands produced no audit event and handler errors were swallowed and retried forever | **decided 2026-11-01:** `onEvent` fires for an asynchronous command when its result is written; a handler's exception goes to `onError`; the retry stays unbounded, because no transport error proves that the remote effect did not happen. Done (f5a553d) |
| S-D7 | The server-side run loop dropped every error | **decided 2026-11-01:** logged. Done (f5a553d) |
| S-D8 | A Space deleted between `listSpaces` and `snapshotSpace` made a delegated call fail with a TypeError | **decided 2026-11-01:** `DelegationDenied`. Done (f5a553d) |
| S-D9 | A revoked key keeps working on an open connection until the next revalidation | **decided 2026-11-01:** kept, as plan 4.4 says: revalidation every 15 s, the grant TTL of 60 s is the bound; recorded here as the contract |
| S-D10 | The one-attempt-per-minute enrollment limit is per process and not durable | **decided 2026-11-01:** kept; the durable bound is the `attempts` counter (3 per token). A durable limit would cost a commit per failed attempt |
| S-D11 | A `commandId` re-submitted after `RESULT_RETENTION_MS` (7 days) acts twice | **decided 2026-11-01:** that window is the contract; callers use ids that do not recur after it, as `rotate:<peer>:<nonce>` does |
