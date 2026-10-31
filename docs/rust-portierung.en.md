# Porting phi-spaces to Rust

As of 2026-10-31. **Target and work plan.** R0 to R3 are implemented and accepted, R-D2 is met: The
Cargo workspace contains `phi-json`, `phi-core`, `phi-store`, `phi-service`, `phi-wire`, `phi-host` and `phi-space-server`, and both
projects run on the Rust server. Of R4 the local part is done, R5 has begun (slices 1 to 3, section R5). **Decision 2026-10-31:** The
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
- **Slots per connection:** A call that is only waiting for the `fsync` no longer occupies, unlike in TS, any of the 32 slots, the limit counts only waiting calls. On one thread a burst runs through to its end and otherwise filled the slots at once (107 timeouts in the first second at 200 figures). Held-back replies are limited to 1024 per connection.
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

**Status 2026-10-31:** Slice 1 stands: `phi-host::auth` checks key proofs against `test/vectors/crypto.json`, including the refusals from `test-auth` per connection. Ed25519 checks strictly: Small keys and non-canonical signatures that OpenSSL accepts, Rust rejects; no key of phi-spaces produces them. Slice 2: `phi-host::grants` issues grants and checks them, with the cases from `test-grants`, as far as they concern the grant itself; Ed25519 signatures are byte-equal with the vectors. Slice 3: `phi-service` asks `Options.authorize` (`Authorization`) per call, checks again in the commit, renews `authorizedUntil` of waiting work and checks commit and renew against the original rights. The walk compares this with TS on every third seed value, `tests/authorized.rs` aims at the paths it rarely hits; of 11 built-in faults all are caught. The fields from `claimMetadata` come with R5b. Slice 4: `phi-host::gate` is the gate with layer B on the socket (`phi_wire::Front`, `Conn.identity`); `test-gate` and `test-auth` run against the binary through `test/support/gate-under-test.ts` and `--test-hooks` (`gate`), 14 of 14 built-in faults are caught. The directory speaks plain HTTP so far, https comes with the TLS register. This host mode exists only behind `--test-hooks`; a production host needs R5b. Slice 5: `phi-host::control` is pairing, the wire rules of the control space and the supervisor on the service's store, `Store::create_space` makes a named Space at run time (TypeScript reads it); `test-enroll` and `test-supervisor` run against the binary, except their cases of `asyncCommands` and the TypeScript store's fault injection, and 20 of 20 built-in faults are caught. Slice 6: `phi-host::rotation` is own-key rotation with its `rotateKey` command and the `grant` call, which asks the directory afresh; `test/test-rotation.test.ts` is new, because in TypeScript only the federation runtime reached these on the wire, and runs on both servers. `asyncCommands` comes with its handlers (R5b); TLS for the directory and the TLS register follow.

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
| R-D3 | Port federation, redesign or leave in TS | **decided 2026-10-29:** decide only after its acceptance |
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
