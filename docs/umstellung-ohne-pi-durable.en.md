# Moving phi-spaces to a standalone persistent runtime

As of 2026-10-12 (plan); the statuses below continue it. **Detailed target and work plan; U0 to U4, U6 and U8 and parts of U7
are implemented, U5 is dropped (D6); sections 1 to 11 are the original plan and partly name modules that do not exist as
named (for example `src/host.ts`).** U0 has been taken
(2026-10-22): [umstellung-u0-bestand.en.md](umstellung-u0-bestand.en.md), with load profile, proposed limits and
open decisions. The measurement there makes partial storage of large documents (section 5.1) necessary for U2 from the start.

**Status U1 (2026-10-22):**

- **Own context:** `src/context.ts` instead of `@earendil-works/chord` (decision D1).
- **Own store types:** `src/store/types.ts` (`StoreHost`, `StoreTx`, `DocDef`, `DocWatch`) and
  `src/store/documents.ts` (`defineDoc`/`defineDocFamily`). `src` thereby defines all documents and uses only
  these types.
- **Transitional adapter:** A pi-durable session fulfills `StoreHost` structurally. The document definitions
  additionally carry the shape that pi-durable reads.
- **One place of opening:** `src/store/legacy.ts` is the only place in `src` that opens a pi-durable host.
- **Agent parts separated:** They live in `src/agent.ts`; `src/with-agent.ts` exports Space and agent together (for
  the mobile bundle and pi-serverd).
- **Result:**
  - `src/index.ts` loads without pi-durable and chord, verified with a hook that blocks these imports.
  - What remains are only types of the primary/sync replication (`LegacyStorage` in `replica-control`, `configured-runtime`,
    `sync-spaces`), plus a dynamic import in `primary-sync.ts` that loads only when the sync budget is exhausted. Both
    are the documented exception until U4.
  - `compactErasedSqlite` (maintenance of the pi-durable format) is no longer exported from `src/index.ts`.
- **Open in U1:** Tests and examples still open their hosts directly with `Harness.open`. They switch to a
  shared fixture once the phi-spaces store exists (U2/U3), so that they can run against both stores.

**Status U2 (2026-10-22):**

- **Own host** `src/store/host.ts`:
  - Commits run one after another on drafts with copy-on-write (`src/store/draft.ts`).
  - The next commit may begin while the previous one is still being written. It is acknowledged only once it is
    durable; snapshots and watches see only durable states.
  - If a write fails, the host locks itself.
- **Parts** of the two Space documents (`SPACE_PARTS`: entries, claims, generations, log batches):
  - Their records are values. The host freezes new ones when publishing, and the core replaces them instead of
    changing them (`setEntry`, `decide`, `sweep`, marking orphaned claims).
  - Array parts are shallow-copied on first write, and their methods run without a proxy.
  - Table parts are changed in place with an undo log.
- **SQLite store** `src/store/sqlite.ts`:
  - Tables `store_meta`, `documents` (whole value or head), `parts` (one row per record, with order) and
    `migration_runs`.
  - A writer thread (`src/store/sqlite-writer.ts`) writes in batches, default `synchronous=FULL`.
  - Owner lock via a held exclusive lock on `<file>.owner`.
  - A newer format version is rejected; metrics via `stats()`.
- **Claims sweep:** It searches only when something can be due (`rpc.sweepAt`). This also works with pi-durable.
- **Tests:** `PHI_SPACES_STORE=own|own-sqlite` lets the root suite run on the phi-spaces store; so far 16
  test files use the fixture. In addition there is `test/test-own-store.test.ts`: reopening, owner lock, format check,
  batching.
- **Measurements** (10,000 entries, 150,000 claims, full log):

  | Measurement | Result |
  |---|---|
  | Core operation, before (every operation searched all claims) | 542 ms per commit |
  | Core operation, now | 0.2 ms per commit |
  | Commit via the draft | p50 1.2 ms, p95 3.7 ms (target p95 ≤ 5 ms met); memory 237 MB |
  | pi-durable for comparison, only 10,000 entries | 51 ms per commit |

- **Throughput with FULL** (1,000 commits, 32 concurrent writers):

  | Disk | Commits/s | p50 | p95 | Target (≥ 300/s, p95 ≤ 50 ms) |
  |---|---|---|---|---|
  | NVMe SSD | 1,131 | 27.6 ms | 35.8 ms | met |
  | RAID1 of 5,400 rpm hard disks (SMR) | 249 | 119 ms | 203 ms | not met |
  | NVMe SSD, NORMAL for comparison | 1,624 | 18.7 ms | 32.0 ms | |

  On spinning disks an `fsync` costs 30–40 ms. The target is not reachable there with FULL, regardless of the
  software; for operation the store belongs on an SSD.
- **Open in U2:**
  - move more tests to the fixture;
  - rebuild the persistent tests (`test/support/persistent.ts`) for the phi-spaces store;
  - counters instead of a full scan for open claims per sender (`client.ts`);

**Status U2c (2026-10-22):**

- **Crash tests** (`test/test-own-store.test.ts`): A child process writes pairs of entries and is killed hard
  (SIGKILL):
  - at six different points in time in succession on the same file: every acknowledged commit is there afterwards, never
    just half of one;
  - immediately before the SQL `COMMIT` of a batch: the disk holds exactly what was acknowledged;
  - immediately after the `COMMIT`, before the reply: the commits are there, but unacknowledged.

  The stop points are set only by a test switch of the writer thread (`PHI_SPACES_WRITER_PAUSE`).
- **Foreign files:** A SQLite file without `store_meta` (such as a pi-durable store) is rejected, not
  adopted. Importing it is U5.
- **Chat on the phi-spaces store:** `codemode-chat/server/space-host.ts` opens `openSqliteHost` (tests:
  `openOwnMemoryHost`). The file is now called `codemode-space.sqlite`, so that an old pi-durable file does not get in
  the way. The backup with `VACUUM INTO` runs unchanged, even while the Space is writing.
- **Load probe** in the local test environment (big and nano in Docker, without a model):
  - 200 submissions across 5 rooms, at the pace of the web quotas: all accepted (p50 30 ms, p95 206 ms) and all
    evaluated (big 134, nano 66).
  - Afterwards at idle: 23,800 claims per hour (`txn.begin`, `take`, `txn.abort` about 1.9 per second each, plus
    `lease.renew`). That is about ten waiting loops of the roles with 5 s wait time each, roughly five times as much as in
    the U0 survey (4,750 per hour).
- **Found and fixed** (measured on a copy of the live store, 11,700 claims, 13,600 log batches):

  | Cause | before | after |
  |---|---|---|
  | `nextExpiry` (before every operation) went through all claims and copied the limits for each claim; now `rpc.sweepAt` applies | 116 ms per write + take | 17.6 ms |
  | `partChanges` compared every array part completely by ids (13,600 batches for one appended); now comparison by object identity side by side, the full comparison only on moves and insertions | 17.6 ms | 2.1 ms (p95 3.7 ms) |

  Before, idle cost the Space process 28–78 % of one CPU, and reads slowed from 3 ms to up to 360 ms. A random test
  checks that the rows of an array part reproduce the array exactly after every kind of change.
- **Decision (2026-10-22):** both, claims on disk first. Starting point: at 23,800 claims per hour
  and 24 h retention (D4) there would be about 570,000 claims with about 240 MB. The limit of 32 MiB would be reached after about three
  hours, and all claims would sit in memory.

**Status U2d: claims on disk (2026-10-22)**

- **Part on disk:** `rpc.claims` is declared `disk` in `SPACE_PARTS` (`src/store/disk-map.ts`).
  - For the core it remains an object with claims by key; a claim is read only when it is asked for.
  - In memory there are only the open claims (without `decidedAt`) and, until their commit is durable, what commits
    have written or deleted. That way overlapping commits see each other, and a failed commit takes back its
    changes through the same storage.
  - A Space newly created in this process puts its claims on disk with its first commit.
- **Questions without a scan** (`DISK_MAP`, `src/store/types.ts`), answered via index columns `at`, `grp`, `flag` of the
  table `parts`:
  - due claims for the sweep, in key order and bounded;
  - next due time;
  - whether a generation still has claims;
  - the open claims (`pendingClaims` in `src/claims.ts`, also for the per-sender limits in `client.ts`, which
    previously searched all claims).

  A map part in memory (pi-durable, phi-spaces host in memory) keeps answering the same questions by scanning.
- **Strict mode:** In the tests, enumerating the claims on disk throws (`strictDiskMaps`), so that an
  accidental full scan stands out. This found the completion of a draft, the statistics and a test that deliberately reads
  everything (now via `entries()`).
- **Format 2** of the SQLite file: the index columns; a file in format 1 is converted on opening and re-indexed once
  per part (tested).
- **Two older bugs in the sweep**, which occurred with all stores:
  - A generation that no longer admits but still has claims set the next sweep to its past
    `admitUntil`. Then every operation had a sweep due that found nothing. In the chat this hits every generation
    after one hour.
  - An aborted sweep (more than 256 due claims, for example after a pause) cleared `sweepAt`, so that every
    following operation searched all claims; now it stays due and continues in steps. Maintenance
    now also recognizes progress by the bytes of the claims.
- **Limits (D5):** For its store on disk the chat sets `maxClaimBytes` to 512 MiB and `maxDocBytes` to
  640 MiB, twice a measured day. The default values remain for Spaces in memory.
- **Measurement** with 600,000 decided claims spread over 24 h, 10 minutes of them (4,264 claims) due immediately, then
  2,000 times claim plus write plus take:

  | Measurement | Result | Target (D2) |
  |---|---|---|
  | Open until ready | 376 ms | ≤ 2 s |
  | RSS after opening / after the load | 161 MB / 220 MB | ≤ 300 MB |
  | per operation p50 / p95 / p99 | 1.5 / 3.1 / 4.6 ms | p95 ≤ 5 ms |
  | Backlog | cleared in steps | |

- **Fewer idle claims in the chat:** The roles wait for work without a transaction (`awaitWork`, see
  [codemode-space-architektur.en.md](codemode-space-architektur.en.md)). Measured with the stack of the test environment as
  local processes (Space on SQLite, web, judges big and nano, agents, model), 5 minutes idle: 3,480 instead of 23,800
  claims per hour, so about 84,000 per day (capacity value D2: 150,000).
- **Queries without a commit (2026-10-23):** In the Docker test environment the Space process still needed
  40–46 % CPU at idle. Cause: The service polls every waiting call every 50 ms, and every poll of an open call
  ran as a commit with full settle, which matched every waiter against every entry. But an open call is decided in the commit
  that makes its entry visible; a poll needs a commit only if something is due by time
  (`needsMaintenance`) or the authorization of its waiter would be extended. Otherwise it only reads. Rebuild of the
  test environment on a copy of its store, 90 s idle: Space process before
  52 %, after 2.8 % busy. The bug existed before the move. In the Docker test environment (rebuilt,
  with 53,000 claims from the night): Space process at idle 1–6 % CPU, 110 MB memory, 296 new claims in
  5 minutes (about 3,550 per hour).
- **Observation open:** The chat test "a person's thumbs-up counts as earlier material …" ran into the 60 s deadline of the
  second board run in two of eight full runs after the move, alone (also under full CPU load) never. A
  connection with waiting without a transaction is not proven; `boardRun` now prints the state of the run on a
  timeout, so that the next failure shows the cause.

**Status U3 (2026-10-23):**

- **Standalone service** `src/standalone.ts` (`npm run space-server -- --store FILE|memory --listen unix:…|tcp:…`):
  phi-spaces store (SQLite or memory), `SpaceService` over Unix socket or TCP, background work
  (`startService`: deadlines, leases, delivery); every connection is a peer with the role `member`.
- **Examples:** Sieve and cache run without `Harness`/pi-durable on the phi-spaces store. With `--remote` they run
  over the service:
  - The sieve then creates all tasks together with the `SieveRun` marker in one transaction: all or nothing, and a
    repetition writes nothing.
  - The cache (`RemoteCache`) distinguishes a held key from a missing one via `takeIfExists` with
    a wait time. It assigns versions from a counter per namespace. New keys and the first counter it writes
    `unique`.
- **Evidence** `test/test-standalone.test.ts`: Service and examples run as processes under `test/support/no-durable.mjs`,
  a loader hook that refuses pi-durable, chord and pi-ai (a negative check shows that it takes effect).
  - Sieve and cache over Unix socket (SQLite) and TCP (memory) deliver the same as in-process.
  - Hard restart (SIGKILL) of the service on SQLite:
    - a waiting `take` receives the entry written after the restart, exactly once;
    - a `take` whose deadline passes during the outage ends with `null` without hanging;
    - a decided `write` returns the same result on repetition without a second entry.
  - A worker that dies with a sieve task: Its transaction expires on the service, another worker
    completes the task.
- **Meter, reaper, mailboxes, fanout/release** run in the same `startService`; the root suite covers them on
  `PHI_SPACES_STORE=own-sqlite`.
- **Remainder until U4:** Statically, `src/index.ts` and with it the examples still hang on pi-durable via the dynamic import in
  `primary-sync.ts` and the types of the primary/sync replication (see U1). At runtime the service does not load it. Direct imports in
  the examples: 11 instead of 13 (`scripts/durable-imports.mjs`).

**Decision D6 (2026-10-23):** Old pi-durable data is discarded ([umstellung-u0-bestand.en.md](umstellung-u0-bestand.en.md)).
U5 is dropped. U6 to U8 follow: agent package, pi-durable out of the main package and tests, operational acceptance.

**Status U8, step 1 (2026-10-23): tests only on the phi-spaces store.**

- **Test helpers:**
  - `test/support/persistent.ts` knows only `own-sqlite` now. Fault predicates see a `FaultBatch`:
    - `ops`: the rows of the batch;
    - `changes`: per document the changed top-level fields, per part the record.
  - `faults.observe` shows the rows of every commit; the measurements of the commit size use it.
  - `test/support/host.ts`: `own-sqlite` (strict) is the default, `PHI_SPACES_STORE=own` keeps the store in
    memory.
- **Removed tests:** Tests that only tested pi-durable itself are removed:
  - base every 500 deltas;
  - revision history in `document_revisions`;
  - the agent replay in test-persistence.
- **Integration tests split:**
  - `test/integration.test.ts`: Space tests on the phi-spaces store.
  - `test/agent-integration.test.ts`: agent, tool and delivery tests. Until U6 they run on pi-durable and
    then move into the agent package.
- **Inspector:** The test bed inspector (TUI) reads phi-spaces SQLite stores from a private backup copy. The
  owner lock stays with the daemon.
- **Two bugs found in the phi-spaces store** (the tests for it previously ran on pi-durable):
  - **Closed, failed store:** It waited for its writer and thereby kept the owner lock. Now
    `close` ends the writer immediately, like a terminated process.
  - **`SyncSpace` close:** `close` and a new `serve` did not wait for a running `unserve` of the
    sealed resolver. The new opening therefore still found the store locked.
- **Reading during a sealed commit:** A read never shows a commit that the standby has not yet
  acknowledged. The test checks exactly this property instead of a fixed counter value.

**Status U8, step 2 (2026-10-23): pi-durable out of `src`, except the agent side.**

- **Primary/sync:** only the phi-spaces store now.
  - `primarySyncStorage`, `captureStore`, `bootstrapPrimarySync` and the tools take a `SyncStore`.
  - The proxy around pi-durable's storage, `store/legacy-sync.ts` and the base upper bound for pi-durable are removed.
  - A journal of a pi-durable store is rejected with `PrimarySyncBlocked`. This applies to a stored
    format `pi-durable` and to entries from the time before the format was stored (test in
    test-primary-sync).
- **`openSyncSpace`:** Without factories it opens the phi-spaces store.
- **Further removals:**
  - `store/legacy.ts`; the dashboard opens the phi-spaces store;
  - the pi-durable half of `compactErasedSqlite`;
  - `scripts/migrate-namespace.mjs` with its test;
  - the unused table `migration_runs`.
- **`src/index.ts`** exports the phi-spaces store:
  - `openSqliteHost`, `openOwnMemoryHost`, `OwnStoreHost`, `StoreUnavailable`;
  - `OwnSyncStore`, `ReplicatedOwnStore`, `OWN_SYNC_FACTORIES`.
- **Writer thread as eval worker:** It is created from the source text of its functions. That way the phi-spaces store
  also runs from a bundle (mobile runtime, test bed artifacts). Before, the bundle pointed to a
  `sqlite-writer.ts` that was not shipped.
- **Test bed:** The daemon (`federation-host.ts`) and the scenarios `phase3-sync-node` and `sieve-mobile` run on
  the phi-spaces store.
- **Guard:** `npm run check:durable` (`scripts/durable-imports.mjs --check`) runs before `npm test`. It fails
  if a file outside the allowlist reaches pi-durable, chord or pi-ai, directly or through its imports.
  - pi-ai alone is allowed in `codemode-chat/`.
  - The list shrinks with U6 and the tools.
- **Evidence:** The root suite without `agent-integration` runs with `NODE_OPTIONS=--import=./test/support/no-durable.mjs`.
  - Except for the two tests of the native pi-server acceptance (`test-pi-server`) it is green.
  - These two tests check the mobile agent runtime; they follow with U6.
- **Remains until U6:**
  - `src/agent.ts` and `src/with-agent.ts`;
  - the `definition` bridge in `store/documents.ts`, through which pi-durable's harness serves the same documents.
  - On the phone `pi-serverd` keeps serving its Space through the harness of the agent sessions.

**Status U6 (2026-10-23): agent package.**

- **Package `agent/`** with its own dependencies (pi-durable, chord, pi-ai, pinned exactly to the versions of the root;
  the lockfile is derived from the root's and contains the same versions):
  - `src/agent.ts`: the Space tools;
  - `src/with-agent.ts`: entry of the mobile bundle;
  - `src/live-models.ts`, `examples/`, `test/`.
  - The root no longer knows pi-durable. The guard `npm run check:durable` checks this, also across `agent/`.
- **The Space is a host of its own** (the phi-spaces store), not the agents' store.
  - Every tool call gets a request identity of the Space: the generation of the conversation and the task ID
    of the call. It is recorded as a memo in the agent store before the first Space call.
  - The Space holds operation and result together. A call repeated after a crash receives the first
    result (test: agent store JSONL, Space SQLite; a random request ID per execution makes it
    fail).
  - Blocking calls keep their first deadline in the claim of the Space.
  - The earlier atomicity with the harness commit (`Once`) no longer exists for agents. This is the API break from
    section 6, decided explicitly.
- **Delivery** (`deliverEvents`): `withEventSink(host, sink)` couples the conversations of an agent host to the Space.
  - Without a connected agent host, events wait in the outbox. Nothing is discarded or released.
  - For a conversation that no longer exists or an expired reservation, it is discarded.
  - Tests without an agent in the root; with an agent in `agent/test`.
- **Document bridge removed:** The harness no longer serves Space documents. `definition` and `checkpointWhen` are
  out of `store/`.
- **Mobile runtime** (`../pi-termux-mobile`, changed locally, not checked in):
  - `pi-serverd.mjs` opens the Space in `space.sqlite` (phi-spaces store), separate from `harness.sqlite`;
  - `common.mjs` exports `createSpaces`, `localSpaces`, `openSqliteHost`, `withEventSink`;
  - acceptance: the built bundle runs in the real `pi-serverd` (test `agent/test/pi-server.test.ts`), the Space
    survives the daemon; the 20 tests of the runtime are green.
  - Not proven: `node:sqlite` and `worker_threads` on the device (Android/Termux). That needs a device run.
- **Tools and test bed** run on the phi-spaces store: examples, help site (server, examples, tests,
  corpus), `federation-host`, scenarios, audits (`test/testbed/read-store.ts`). The test bed scenarios with
  `SIGKILL` (`phase2-process-crashes`) run locally: 10 of 10 cases.
- **U8, package boundary:** The root now depends only on `pi-codemode` (example `codemode-evolve`). pi-durable, chord
  and pi-ai are out of the root's `package.json` and lockfile; `codemode-chat` names `pi-codemode` itself.
  - The Docker images of chat and help site install the dependencies of the agent package as well (for
    `agent/src/live-models.ts`, that is pi-ai). **Not built/checked:** the image builds do not run locally.
  - All suites after the removal: root 572/573 (1 skipped), examples 84, agent 89, chat 112,
    help site 52/53 (1 skipped).
- **Test bed on `big` (2026-10-23, with approval):** The artifacts (no pi-durable in them) were built, shipped and the
  `runner` recreated. `test all` is green:
  - smoke: 0 TypeScript files in the image and on the server;
  - examples `sensor-pipeline`, `cache`, `sieve`, `golomb`;
  - `sieve-mobile` and `sieve-remote --kill-host` with a real SIGKILL.
  - The list in `testbed.sh` follows the moved examples.
  - **Not touched:** the federation and overlay containers (`host-a/b`, `member-1/2`, `nb-*`, for 5 days with the
    old image). `destroy` would also delete the NetBird peer registrations of the `nb-*` volumes. Their old stores
    are rejected by the new code (D6). Rebuild (`destroy --yes`, `up federation`, `netbird setup`): own approval.
- **U7, first measurement (D2 capacity), `scripts/capacity-probe.ts`:** 20 named Spaces with 10,000 entries each (about
  130 bytes payload each) in one store:
  - writing: 352 s (200,000 entries, 500 parallel `write`);
  - file: 265 MB;
  - opening the store: 48 ms (budget ≤ 2 s: met);
  - touch all 20 Spaces once: 4.5 s; **RSS 386 MB, heap 259 MB**.
  - **Budget not met:** The profile is 100 Spaces of 10,000 entries at ≤ 300 MB RSS. The host keeps every
    document, once loaded, in memory forever (`#docs`), so about 13 MB per touched 10k Space and extrapolated
    over 1 GB for 100. If the Spaces stay cold, this is no problem; but the budget applies to the profile.
  - **Memory budget (2026-10-24):** `OwnStoreHost` keeps a weight per loaded document (1 plus entries of its
    parts, disk maps do not count; a Space counts about double per entry, its change log counts too) and
    evicts, above the budget (`memoryBudget`, default 40,000), the documents untouched the longest. Never
    evicted are documents with an observer, with a commit in progress (not yet durable), that of the running commit and
    those used in the last 250 ms (`hotMs`). Eviction happens only between commits and after
    snapshots. For this the SQLite ledger forgets its state (`forget`: order maps, disk maps); the
    memory ledger cannot reload and never evicts. Counter: `host.cached`. Test: `test/test-own-store.test.ts`.
  - **Measured, 100 Spaces × 10,000 entries** (writing 28 min, file 1.3 GB, measured in a fresh process):
    opening 54–70 ms (budget ≤ 2 s: met); **RSS 251–259 MB** (budget ≤ 300 MB: met; before extrapolated over
    1 GB); touching all 100 Spaces once 22–24 s (per evicted 10k Space about 0.25 s of re-reading). At 50,000 the
    RSS was 300 MB; at 20 Spaces: unlimited 386 MB, 100,000 → 319, 50,000 → 281, 25,000 → 250 (the RSS follows the
    heap with delay, because V8 holds the garbage of the loads).
  - **Finding from the endurance run, fixed:** Without the grace window, with more active Spaces than
    fit in the budget, the LRU rule evicted exactly the documents that were needed again right away: the write rate collapsed from 1000 to
    10 per second, latency rose to 0.5–1 s. With `hotMs` a working set that is too large costs memory instead of
    re-reading.
  - **Endurance load, `scripts/endurance-probe.ts`:** 5 Spaces, 2 producers and 2 consumers each, 10 min, closing
    and reopening every 60 s: 119,698 items, each taken exactly once (0 lost, 0 duplicates, 0 errors), 10
    reopenings. The file reaches 80 MB and stays there, WAL 4 MB, the write rate falls from 1000 to about 165–250 per
    second (p50 8 → 25–45 ms) once the change log has reached its 4 MB per Space, and then stays
    stable. RSS reaches 520–660 MB with 5 saturated Spaces (about 100 MB per Space with a full log): whoever runs many
    simultaneously active Spaces plans for this or lowers `maxLogBytes`.
  - **Disk full, `test/test-own-store-ops.test.ts`** (`maxPages` limits the file like a full disk): the
    commit that no longer fits fails; the host accepts nothing afterwards (`failed`); every acknowledged commit
    is there after reopening, in order, without a half commit; `integrity_check` is `ok`; with space it continues.
  - **Backup/restore, same place:** `VACUUM INTO` while writing delivers a state that can be opened, passes
    `integrity_check` and contains exactly a prefix of the commits (none half). Restoring = the file
    is the store of a new place, which keeps writing; the original stays untouched. Backup interval and RTO remain
    operator profile (U0), the mechanics are proven here.
  - **Entry match index: not needed.** Reading, counting and taking by a field are a linear search: with 10,000
    entries 7–14 ms per operation (taking and writing back 22 ms), roughly 1 µs per entry, so at 100,000 about
    140 ms. For the profile (10,000 per Space) that suffices; an index becomes necessary only when Spaces regularly hold more than
    50,000 entries and are searched by exact field.
- **Platforms (decision 2026-10-24):** Supported and tested are Linux (server, Docker, development) and
  Android (Termux, Xiaomi M2007J17G, Node 26.4.0). Tests for other platforms are provided by whoever needs them;
  with that the platform tests item in U7 is closed.
- **Backup in operation:** Retention is set in the environment (`CODEMODE_BACKUP_KEEP`, default 7, `.env`); the
  interval is not a variable but the rate at which `npm --prefix codemode-chat run docker:backup` (or
  `server/backup.ts`) is called, so a timer of the operator (cron or systemd timer). The largest
  data loss window is then the interval; the age of the oldest backup is interval times `CODEMODE_BACKUP_KEEP`.
- **Docker images (2026-10-24):** `phi-spaces-codemode:prod` and `:dev-test` as well as `phi-spaces-help:prod`, `:nano`
  and `:dev-test` build with the agent package (typecheck and Next.js build in the image); the tests run green in the container
  (chat 112, help site 53). The first container run of the chat had a non-reproducible failure
  ("a person's thumbs-up counts as earlier material in its own room only"), the second was green.
- **Remains:** RPO/RTO in the operator profile (U0: the operator sets interval and age) and the operational trial of
  the federation on `big`.

**Status U4 (2026-10-23):**

- **Primary/sync on the phi-spaces store:**
  - **Journal behind a store interface** (`src/store/sync-store.ts`): hash chain, configuration steps,
    fencing and the one open candidate remain one code path (`src/primary-sync.ts`). A store brings the shape of
    its write operations (codec), the marker, atomic apply, `capture` and the emptiness check.
  - **pi-durable** is one such store (`src/store/legacy-sync.ts`), the phi-spaces SQLite store the other
    (`src/store/sync-sqlite.ts`, codec `src/store/own-sync-codec.ts`).
  - **Format binding:** An empty journal binds itself on first use to a store kind, to the store it
    drives, or to the marker of the first accepted entry. A journal with older entries counts as
    pi-durable. A journal of the other kind is rejected; replicated data is moved by U5.
- **The phi-spaces primary:**
  - Sequence per batch: seal, with `sync` wait for the standby, write rows and marker (`store_meta`) in one
    SQL transaction, only then acknowledge. Only one batch is in flight at a time, cut at the size
    of a journal entry.
  - An error after sealing is `CommitSealed`. After that the store accepts nothing until it is opened again
    and the candidate is resolved.
  - The journal's budget is checked by `Ledger.prepare` before publication. A rejection leaves no trace
    (draft, orders and claim overlay are rolled back), and the host stays usable.
  - Applying to a stopped file (standby, restore, bootstrap) and the writer thread use
    the same rows (`src/store/sqlite-ops.ts`).
- **Factories:** `sync-spaces` and `configured-runtime` take both store kinds; without factories of the daemon the
  phi-spaces store applies (`OWN_SYNC_FACTORIES`). The test bed daemon on `big` explicitly stays with pi-durable until U5 moves its
  replicated data.
- **Evidence:** `test/support/persistent.ts` has own-sqlite as a third backend.
  - With its own fault injection: "before the commit" and "reply lost".
  - The predicates of the tests see the rows of the phi-spaces store as changed documents.
  - A crashed host releases its owner lock.

  With that, the same tests run on the phi-spaces store as on pi-durable: primary/sync, replica control (promotion,
  degradeToSingle, setStandby), bootstrap, CommitSealed, NotCommitted, degrade/revoke, configured root, router,
  delegation, federated Space, restore, erasure, deployment, run recovery. Root suite: 996 of 997 (one
  skipped as before).
- **Snapshot eviction (fixed, 2026-10-23):** The chat test "code full of control characters …" failed in about
  one of five runs, even before U4. The web part reads a room through a paged snapshot; running
  observers created new ones in the meantime, and with more than 16 the Space evicted the oldest, which was the one just
  being read. Now snapshots read to the end go first, then the one unused the longest (every
  page counts as use). A test reads a snapshot page by page while ten others are created
  and read; the chat test afterwards ran 8 of 8.
- **Check after the check:**
  - A rejected entry no longer binds an empty standby journal; the binding is written in the same transaction
    as the first accepted entry.
  - The gate deducts exactly the admitted bytes when sealing, otherwise the budget would have slowly filled up under batching.
  - For a document head, the fault predicates see only the changed fields, as with pi-durable. Compared with `FAULT_LOG=1`,
    the faults in the federated Space hit the same commits on both stores.
- **What the phi-spaces store showed along the way** (fixed, with tests):
  - Drafts were finished individually and revoked immediately; a value that moved from one document to another
    hit a revoked proxy.
  - An object assigned in this commit and read again through the draft came back with drafts inside it.
  - A draft over a frozen value (a record of a part in another document) violated a proxy invariant;
    it now uses an empty stand-in target.
  - `setMetadata` changed a claim in place instead of replacing it.
  - A fresh `rpc` state had no `sweepAt` and triggered an unnecessary maintenance commit.
  - A part that sat in the head of a document (written before the definition had parts) was lost on loading;
    now it is kept and written as rows with the next commit.
  - On a lost reply, the commits of the batch were never completed.
- **Open:**
  - ~~Three rare administration paths read all claims per step~~ (done, 2026-10-23): restore, marking on
    member change and deletion by principal go through a key cursor (`DISK_MAP.page`) that sits in the
    restore, transition or command state. Each step continues after the last processed claim
    instead of searching from the start. A test walks page by page through a claim map while overlapping commits delete and add claims.
    A state from before the byte ledger (`rpc.bytes` missing) is still recounted completely once.
  - ~~`restoredClaims` in the head of the Space document~~ (done, 2026-10-23): The historical claims after a restore
    are a part on disk like `rpc.claims`.
    - Their bytes are kept by the ledger `restoredBytes`; `claimBytes` therefore does not recount them at every admission.
    - Restore, member change and deletion walk through them with a key cursor (`claimPage`).
    - A marked claim is replaced instead of changed.
  - Strict run of the whole root suite (`PHI_SPACES_STRICT_DISK_MAPS=1 npm test`): Apart from the paths named, only
    test code enumerates claims that deliberately serializes or compares snapshots completely. Fixed along the way:
    - the pre-check of a key rotation that copied the whole control Space (`core.previewOf`);
    - the check against `maxDocBytes` on deletion (`core.docBytes`);
    - replacing a whole claim map on disk, now an operation `partClear`.
  - ~~Maintenance of a stopped store~~ (done, 2026-10-23): `compactErasedSqlite` recognizes the phi-spaces store
    and hands it to `src/store/erasure-own.ts`. That runs under owner lock and fencing check: empty the WAL,
    `VACUUM` with `secure_delete`, empty the WAL again, integrity check.
    - There are no revisions here.
    - Deleted rows are overwritten in the file by the SQLite bundled in Node (`SECURE_DELETE`).
    - What remains are old page images in the WAL of a killed process. A test shows that the deleted data
      is there and afterwards nowhere.
  - Static imports of pi-durable in `src`: `agent.ts` (U6), `store/legacy.ts` and `store/legacy-sync.ts` (until
    U5/U8), type imports in `primary-sync.ts` and `replica-control.ts` for the pi-durable path.

The goal is a phi-spaces that provides durable Spaces without installing, importing or running
`@earendil-works/pi-durable`. The focus is atomic
storage, resumption after outages and controlled takeover of existing data.
The existing Space, RPC and security semantics are preserved.

The [implementation status](implementierungsstand.en.md) continues to describe the current
code. The [federation contract v3](federation-plan-v3.en.md), the
[implementation plan v3](_attic/implementierungsplan-v3.en.md) and the
[operations contracts](betrieb-und-mobile-steuerung.en.md) remain valid in substance. This plan
will in future replace their harness/storage binding, but does not declare any open
replication, promotion or operations acceptance complete. Changes to the
authoritative contracts are worked in before the respective implementation step.

## 1. Result and scope

The target product has:

- a standalone `SpaceHost` with transactional storage, snapshots, watches,
  maintenance, mailboxes and resumption of persistent jobs;
- a persistent SQLite store as the first production backend and an
  explicitly volatile memory backend exclusively for tests;
- a standalone startable Space service over the existing Unix/TCP protocols;
- unchanged functional APIs of `PhiSpaces`, `SpaceService` and `RemoteSpace`, as far as
  they do not directly expose harness, document or task types;
- a versioned export/import procedure for existing JSONL/SQLite data;
- a separately packaged, optional agent binding. Only this may continue to
  require `pi-durable`. The standalone server must work completely without it.

Not part of this rebuild are a new agent engine, replacing NetBird,
changes to matching, or a simultaneous SQL normalization of all entries.
Removing `pi-durable` from the whole mobile agent application would be a
separate undertaking: `runtime/common.mjs` uses it there also for sessions,
coding tools and agent execution. Here the lifetime of the Spaces is decoupled from it.

## 2. Dependencies evidenced in the current checkout

The table is the starting list for work package U0. Private document families must also be
inventoried; an export of only publicly reachable Space entries is incomplete.
The table itself was compiled manually and is therefore not the authoritative source: U0 derives the
complete list from the actual import graph (every file with a direct or
transitive import from `@earendil-works/pi-durable`) instead of relying on this
starting aid.

| Area | Current coupling | Required replacement |
|---|---|---|
| `src/core.ts`, claims, streams, mailboxes | largely pure state functions, explicit `now` | keep functions and invariants; check all transitive imports |
| `src/doc.ts`, `src/spaces.ts` | `defineDoc`, `defineDocFamily`, registry; Space document version 5 | own document definitions, persistent identities, migrations |
| `src/client.ts` | `SpaceHost = Pick<Session, "commit" \| "watchDoc" \| "snapshot">`, `Tx`, `Once` | own host/transaction types; equivalent commit boundaries |
| `src/service.ts`, `src/enroll.ts`, `src/meter.ts` | transaction authorization, session/harness types | own types and access contracts |
| `src/index.ts` | tools, task claim, conversation delivery, reaper and public exports mixed | independent entry point, maintenance module, separate agent adapter |
| `src/router.ts`, `src/federated-space.ts`, `src/federation-controller.ts`, `src/capability-directory.ts`, `src/rotation.ts` | router journal, individual router commands, federation operations, capability/member status directory and key rotation, all as `SpaceHost` consumers | persistent multi-document transactions and resumption |
| `src/delegation.ts`, `src/federation-policy.ts` | delegation epochs, routing policy | unchanged bindings and versioned records |
| `src/membership.ts`, `src/data-admin.ts`, `src/supervisor.ts`, `src/member-transition.ts` | member transitions (`member-transition.ts` imports `Session` directly), membership/admin/supervisor journals | complete takeover including running batches and budgets |
| `src/runtime.ts` | composition root of the persistent host (gate → enrollment → control → proof → Space); imports `Harness` directly from `@earendil-works/pi-durable` | own composition root without a harness type in the signature graph |
| `src/control-ack.ts`, `src/recovery-controller.ts`, `src/control-recovery.ts` | recovery receipts, restore and release jobs | resumable, atomic management together with Space changes |
| `src/boot.ts`, `src/recovery-only.ts`, configured runtimes | harness wrapping and privileged recovery access | explicit guarded host access and a delimited recovery capability |
| `src/pi-server.ts` | structural service adapter | keep; put the standalone Space runtime behind it |
| Tests, examples, test bed, TUI inspector | harness creation, JSONL/SQLite opening, agent fixtures | backend-neutral fixtures; separate independent and agent tests |
| `scripts/bundle-mobile.mjs`, `package.json`, TypeScript configuration | shared entry point and external `@earendil-works/*` imports | separate artifacts and a truly independent package graph |
| Neighbor project `pi-termux-mobile/runtime/common.mjs` | agent database and harness lifecycle | own Space database and own operational lifecycle |

In addition to entries, the data comprises among others leases, reservations,
transactions, claims/generations, waiters, subscriptions, outbox, mailboxes/ACKs,
fanout/release cursors, completion profiles, quotas, snapshot tokens, revision history,
enrollment/key state, recovery states and routing/membership bindings.
Document kinds, family keys, scopes and schema versions are recorded in machine-readable form.

Currently the installed JSONL adapter uses `fsync=false` by default, the
installed SQLite adapter WAL with `synchronous=NORMAL`. The independent
`SqliteRecoveryRegister` in `src/recovery-register.ts`, by contrast, sets `FULL`.
These findings concern the implementations read, not a complete
inventory of all running hosts and their configuration.

## 3. Guarantees and failure model

| Failure case | Binding target | Limit and required evidence |
|---|---|---|
| Process terminated, `SIGKILL`, app process gone | every acknowledged commit stays; resumption from persisted state | test with a child process, real file and restart |
| Commit succeeded, reply lost | the same request receives the stored result, no second mutation | stable identity, argument binding and retention periods |
| Power loss/kernel crash | acknowledged local commits stay with a working sync/hardware chain | FULL configuration plus separate system outage tests; `SIGKILL` is not enough |
| Disk full, I/O error | no false success reply, no half multi-document changes | inject errors before/during/after commit separately |
| Disk or host lost | recovery from an independent backup | data loss window corresponds to backup age; not automatically RPO 0 |
| Network partition/old primary | no unauthorized writes or stale service replies | existing authority/boot rules; real takeover needs fencing |
| Second local server process | second owner is rejected before service start | operating system/DB-backed lock, not a mere PID file |
| Outdated or damaged format | start locked or explicit recovery mode | never silently create an empty replacement Space |

RPO denotes the tolerated data loss window, RTO the restart time. For local
acknowledged commits the target is RPO 0 within the tested failure model. For
backup restore, interval, maximum accepted age and measured RTO are set before
operations approval. Automatic availability on loss of the host remains
tied to the separate replication/fencing acceptance.

### 3.1 Unchanged semantics

1. Space mutation, RPC claim/result, revision, mailbox event and budget booking
   are committed together. The same applies to coupled journal documents.
2. Storage transaction and functional Space transaction are different: A
   long-lived reservation is persisted state, not an open SQL transaction.
3. `OutcomeUnknown` remains an unknown outcome. A timeout does not become
   proof that nothing happened; repetitions use the same request identity.
4. `spaceId`, incarnation, local IDs/counters, host keys, principal bindings,
   authority and epochs are not reinvented in a lossless migration.
5. A retry protection applies only within its agreed generation/claim contract.
   After expiry it is rejected explicitly; an expired request is not executed again.
6. External side effects are not executed exactly once automatically by a local SQL transaction.
   For that the receiver needs deduplication or its own completion protocol.
7. Epoch counters alone do not lock out a former primary. Recovery register,
   `authorityId`, independent boot permission, `needsReview`, `EmptyProof` and
   reserved completion obligations keep their meaning.
8. Durability does not mean automatic infinity of all leases. The previous
   default of one hour stays compatible; durable entries use `FOREVER`.
   Even after a long offline time, expired leases expire in substance.

## 4. Target architecture and interfaces

Planned modules; the names are not yet an existing API:

| Module | Responsibility |
|---|---|
| `src/store/types.ts`, `src/store/documents.ts` | own document definitions, `StoreTx`, versions and serialization rules |
| `src/store/sqlite.ts`, `src/store/memory.ts` | atomic storage, isolation, snapshots, reopening |
| `src/host.ts` | `SpaceHost`, commit queue, owner protection, watches, shutdown and health |
| `src/maintenance.ts`, `src/delivery.ts` | reaper, long-lived jobs, repeatable delivery |
| `src/daemon.ts` | configuration, standalone start and signal handling |
| `src/index.ts` | independent public exports without an agent import |
| separate adapter package | tool definitions, conversation binding and agent compatibility |
| separate legacy migration tool | read the old format; no legacy import in the production server |

The own `SpaceHost` offers `commit`, `snapshot`, `watchDoc`, `close` and an
explicit health/readiness status. The first version deliberately keeps the
document model. This allows pure state logic and existing tests to be
reused. `Session`, `Harness`, `Tx`, `ConversationId` or foreign doc tokens
must not remain in the independent public declarations.

### 4.1 Commit contract

- A host processes writing commits in a queue. A commit may change several
  documents atomically. Document accesses of the same transaction return the same draft.
- A draft is isolated from the published state. Abort, callback errors and
  validation errors discard all changes. Mutations after the end of the callback may
  influence neither running nor later commits; result values are detached.
- Order: admission/boot check, transaction begin, load state, callback,
  schema/quota/authority check, persist, SQL COMMIT, cache publication,
  watch signal, reply. Security-sensitive read replies remain guarded as well.
- SQL COMMIT is the local decision boundary. An error after it is not reported as a
  safe rollback. If the storage state is unclear, the host is locked and
  reconstructed from storage; a stale RAM cache must not continue working.
- Abort before commit may roll back. Abort after commit does not undo the commit.
  Callbacks are not executed again invisibly; automatic repetition
  could change time values, random values and external effects.
- No external writing effects in the callback. Required asynchronous
  authorization checks are time-limited and integrated with the existing guards.
  Nested commits are rejected. The serial commit queue
  rules out deadlocks between commits of the same host; the
  remaining lock interactions outside the queue are tested, such as a long-running
  snapshot reader against the storage writer or a cross-host recovery/
  boot call that waits for the completion of a local commit.
- Registry/Space creation, router journal/command and recovery/membership updates
  demonstrably receive the same multi-document atomicity as today.

The boot check cannot be an atomic distributed commit with the external register.
Its existing limits are documented; the rebuild must not derive a new
fencing guarantee from it. Privileged recovery access is not passed on to service code as a freely
available unchecked host.

### 4.2 Watch and snapshot contract

Snapshots are detached, consistent values; multi-document inspection uses a
consistent read snapshot. Watches fire only after commit. Combining
registration and the initial state check rules out lost wakeups.
Watches are local wake-up signals, not durable event delivery. On overflow
a renewed state check follows. Persistent mailboxes, claims and cursors continue
to carry the functional reliability. A restart scans all Spaces and open
jobs; correctness must not depend on a signal missed before the crash.

## 5. Storage decision and long-term operation

### 5.1 SQLite as the first production backend

Planned are `node:sqlite`, WAL and `synchronous=FULL`, without a new npm package.
The SQLite store does not use pi-durable files directly. In WAL mode FULL synchronizes
every commit; NORMAL can lose acknowledged transactions on a system outage.
The actual hardware/file system chain remains part of the failure model.
Source: [SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous).

On opening, the supported Node/SQLite version, PRAGMA values, write permissions,
schema version and owner protection are checked. A requested persistent profile must
not fall back unnoticed to memory or weaker sync settings.
The concrete supported Node versions are determined and pinned on Linux and Android/Termux;
`node:sqlite` and the backup functions used must be available there. Reference: [Node SQLite API](https://nodejs.org/api/sqlite.html).

Planned minimal schema:

| Table | Content |
|---|---|
| `store_meta` | format version, store ID, global commit counter, migration/activation status |
| `documents` | composite key of namespace/kind/family key, schema version, document revision, JSON content |
| `migration_runs` | export ID, manifest hash, verified import progress and completion status |

The existing functional journals initially remain documents. A global
storage commit counter is not the Space revision and not a replication protocol.
Format version and document version are kept separately. Several previous
harness sessions are mapped explicitly to stores/namespaces on import;
name conflicts must not be masked by merging `default`.

For the first stage, complete changed document values are stored.
This simplifies the correctness check, but can cause high
write and copy costs with large Space documents. Before production approval, small mutations
on large documents are measured. If this exceeds the budget set in U0,
U2 is to be extended by atomic partial storage or a bounded delta/checkpoint strategy.
An unmeasured full serialization of up to 128 MiB is not an accepted solution.

Compared with the default implementation of pi-durable, this changes:

- Durability: pi-durable fixes `synchronous=NORMAL`; in WAL mode this
  synchronizes only at checkpoint, acknowledged commits can be
  lost on a system outage. The installed JSONL adapter also runs by default with
  `fsync=false`. Here `synchronous=FULL` is the binding profile.
- Schema: pi-durable stores an agent-centered model (`conversations`,
  `entries`, `tasks`, `submissions`, `documents` with the scopes `session`,
  `conversation`, `task`). The phi-spaces store knows only `store_meta`, `documents`
  with a composite namespace/kind/family key, and `migration_runs`;
  Spaces are no longer scopes below a session.
- Revision storage: pi-durable holds documents as an append-only chain of `base` and
  `delta` revisions and assembles them on reading. The phi-spaces store keeps
  the two growing document kinds `phi-spaces.space` and `phi-spaces.named-space` in parts from the
  start (one row per entry, claim, generation and
  log batch, plus a head row); the measurement gate is already exceeded with the load profile from
  [U0](umstellung-u0-bestand.en.md) (31 MB per Space after 9.5 h,
  decided 2026-10-22). All other document kinds store complete values.
- File format: no compatibility. Data is taken over via the versioned
  export/import, not by reading existing pi-durable files.
- Operation: pi-durable opens with fixed PRAGMA values and `busy_timeout`. The phi-spaces
  store checks versions, PRAGMAs, write permissions and schema on opening, requires
  its own owner lock (5.2) and a proven backup path (5.3).

What stays the same are the substructure (`node:sqlite`/`DatabaseSync`, WAL, serialized
operation queue, `BEGIN IMMEDIATE` transactions) and the document model itself.

### 5.2 Owner, files and maintenance

- One active owner per store, local file systems in the approved operating profile.
  SQLite write locks alone do not prevent two running reapers/dispatchers.
- In U2 a process lock that can be realized without a new dependency is proven,
  such as a separate local SQLite lock file with a held exclusive lock.
  A crash must release it; deleting a stale PID and automatically killing foreign
  processes are not a normal takeover path. The platforms checked are named.
- Controlled shutdown: close admission, finish running commits,
  stop background work, close watches, close the database, release the owner.
  Correctness must presuppose neither checkpoint nor shutdown.
- WAL size, long readers, checkpoint progress, free space, sync latency,
  queue length, last successful backup and resumption errors become measurable.
- Maintenance is bounded and resumable. Quotas and completion reserves prevent
  full mailboxes or new traffic from displacing completions already promised.
- Unknown newer schema versions lock opening. Supported older versions
  migrate with backup and atomic completion. No silent format downgrade.

### 5.3 Backups and restore

Backups must capture a consistent state; copying only the opened
main file is not an approved WAL backup path. Planned is the available
SQLite/Node backup API, otherwise a proven offline backup.
Source: [SQLite Backup API](https://www.sqlite.org/backup.html).

Every backup carries format version, store ID, commit state, time, sizes and checksums.
Export/backup are first written temporarily, checked, synchronized and only
then published durably, including the directory entry. Backups
are additionally kept on an independent medium/host, with private access; contained
host keys and enrollment data are not printed in logs.

A restore test opens the backup in isolation and checks integrity, relations,
counts and selected operation histories. The isolated copy must not go online as an old
primary. An outdated backup goes through the existing restore contract
with a new data incarnation, authority/boot reconciliation and, where applicable, `needsReview`.
The external recovery register and local boot installation are not blindly reset from the
Space backup. No automatic repair by deleting the WAL.

## 6. Background work and agent integration

Reaper, fanout, releases, pending requests and supervisor/router/recovery jobs are started
by the Space host and reconstructed from persistent state. They must not
depend on an open conversation, a UI poll or a running agent.

`deliverEvents` today uses numeric conversation IDs and `conversation.submit`.
The new host needs an explicit delivery adapter with stable consumer identity,
event ID, ACK and repetition semantics. Repeated delivery with
deduplication at the receiver is permitted. A missing adapter initially means "not connected"
and must not automatically delete all events or release all reservations.
Consumers removed for good, expired leases and terminal delivery errors need
explicit, tested release rules; endless reservations are avoided.

The previous task-scoped `phi-spaces.claim` from `src/index.ts` is not rebuilt as a new
agent engine. The optional adapter maps stable tool call IDs to
Space request identities. The mapping is persisted in the agent system before the first call;
Space mutation and result lie together atomically in the Space store.
After an agent crash the same mapping is reused. Request deadlines
must fit the permitted replay duration; expired calls are not reinvented.

**Compatibility boundary:** A previous `Once` hook that changes arbitrary agent documents and
Space state in the same harness commit is no longer atomic across two databases.
The independent `Once` variant may touch only the store's own documents. Cross-cutting
flows are moved to persistent requests/outbox or explicitly rejected as an
API break. Neither adapter nor documentation may feign the old atomicity.
Open legacy tool calls are ended before the cutover or migrated with a proven
identity mapping; unknown mappings block the migration.

## 7. Migrating existing data safely

### 7.1 Export format

A separate, version-bound legacy tool reads JSONL and SQLite with the
matching old libraries. It works on a consistent backup of the
stopped data; opening by the old harness must not trigger agent tasks,
maintenance or external effects on the original. A pure reader or an
isolated replay path is to be proven in U5.

The manifest contains export format, source backend/version, session/namespace mapping,
document kinds and versions, all family keys, identities, commit reference,
counts, byte sizes and checksums. A payload takes over the entire functional
state including private journals. Unknown document kinds are classified;
unknown Space-related state locks the import instead of being silently discarded.
Pure agent histories stay in the agent database. Task claims and consumer bindings
are handled separately according to section 6.

The importer validates schema, references, IDs/counters, budgets and checksums and
writes into a new target store that cannot yet be activated. Large imports occur
in bounded batches; export ID and manifest hash bind every restart to exactly
the same source. `ready` is set atomically only after complete checking.
A partial import must never be opened publicly.

### 7.2 Cutover with a write pause

1. **Inventory and trial:** record all stores/sessions, formats, roles and agent bindings;
   run the import on copies and measure the duration of the write pause.
2. **Close admission:** stop new mutations, clarify in-flight results,
   halt background writers and agent tool calls. Functional long-lived
   transactions/waiters may remain, provided they are fully migrated.
3. **Decommission the source:** stop all writers and secure the owner. Create source backup and
   manifest. Lock the old start configuration against unintended restart.
4. **Import and check:** create the new store, compare complete states,
   check private journals and references. No second functional execution for
   "validation" on the store activated later; trial runs use throwaway copies.
5. **Check authority:** with a lossless format change on the same host, identities/incarnation
   are preserved. Role change, older snapshot or host change
   need the existing recovery/fencing procedure, not a mere path change.
6. **Activate:** check exclusive owner and boot permission, switch the configuration atomically
   to the new store, first a controlled read/health check,
   then open write admission and background work.
7. **Follow-up check:** repeat identical requests, check pending completions, mailbox ACKs,
   restart and long-term leases; activate monitoring and backup of the new format.

No dual writes to old and new store: without a shared transaction two
diverging truths could arise. The clock keeps running during the write pause;
leases/grants are neither extended nor reset to the export time.
Overdue work is processed in a bounded way before normal readiness.

### 7.3 Way back

Before the first new functional commit, the new store can be discarded and the
unchanged source reactivated after an owner/authority check. Background
mutations also count as new commits.

After the first new commits, switching back to the old backup is **not** a
lossless rollback. The approved standard path is error correction on the new
format or its recovery. A later reverse exporter would be a separate, fully
tested migration package. A restore with accepted data loss
needs an explicit operator decision and the recovery contract.

## 8. Work packages and order

All packages were **planned/open** at the plan state (implementation status: see the statuses at the top; U5 is dropped by D6). Sizes S/M/L are relative efforts, not schedules.
A package counts as done only with an artifact, acceptance criteria and reproducible evidence.

| WP | Prerequisite / size | Concrete work | Completion criterion |
|---|---|---|---|
| **U0 – Inventory and contracts** | start / M | create the complete import/type graph and document catalog; record the current git state and local changes; run existing tests as baseline; record errors/skips separately; set supported platforms and p95/p99, memory, startup, RPO/RTO budgets | every persistent data type and every harness function has a target mapping; operating profile and measurement limits documented |
| **U1 – Own host boundary** | U0 / M | define own doc/tx/host types; initially a legacy adapter for comparison tests; separate `index.ts` from tools; move out reaper/delivery; make privileged recovery access explicit | core and host contract tests succeed unchanged in substance; independent import graph contains no durable types |
| **U2 – SQLite store** | U1 / L | implement schema, queue, draft isolation, atomic multi-document commits, FULL, owner protection, watch races, error classification and format migration; add memory backend; load probe of large documents | new conformance and real crash tests passed; isolation and sync profile proven; set load limits met |
| **U3 – Local standalone service** | U2 / L | port `PhiSpaces`, registry, service, meter, reaper, mailboxes, fanout/release and standalone start; request replay/deadline resumption; check `SpaceLike` and RPC | sieve/cache without model and without installed pi-durable over Unix/TCP; restart keeps pending operations and results |
| **U4 – Federation and recovery** | U3 / L | port router, delegation, policy, membership, admin batches, supervisor, control ACK and restore journals; check boot/read guards and recovery capability | relevant AP1b/AP2/simulator cases passed on the new store; fencing/restore guarantees not weakened |
| **U5 – Export/import** | U0, U2; final acceptance after U4 / L | implement version-bound legacy reader, manifest, session mapping, private document export, resumable import, report, trial cutover and rollback limits | JSONL and SQLite including running jobs fully migrated; partial import locked; restart/retry after import correct |
| **U6 – Adapter, mobile and tools** | U3, U4, U5 / L | separate agent package and tool identities; mobile Space database/lifecycle; pi-server binding; switch examples, TUI, inspector, test bed and bundles | Space service survives agent restart; old clients compatible; native/mobile acceptance with built artifacts; legacy tasks handled in a controlled way |
| **U7 – Operations acceptance** | U4–U6 / L | independent backups/restore, I/O/capacity errors, system outages, endurance load and platform tests; migration trial with realistic sizes | matrix from section 9 complete with evidence; no open critical bugs; RPO/RTO in the approved profile proven |
| **U8 – Package cutover and cleanup** | U7 / M | remove `pi-durable` from main package, lockfile, types and runtime graph; move old test paths into a separate legacy/adapter package; update README/API/operations contracts | clean offline installation from prepared artifacts starts independently; complete mandatory suite and import/bundle check succeed |

The packages complete in this order: U0 before U1 before U2 before U3 before U4 before U6 before U7 before U8.
U5 is explicitly excepted: export design and legacy reader may
begin in parallel to U3/U4 once U0 and U2 are complete (see the prerequisite column above); final acceptance and
approval of U5 for the productive cutover, by contrast, presuppose U4 and the complete
target document catalog and thus lie in time after U4. No package may leave central atomicity or recovery obligations
open by pointing to a later phase.

## 9. Test and acceptance matrix

| Check | Setup | Success criterion |
|---|---|---|
| Semantics comparison | same deterministic operation sequences against legacy and new host, same time/IDs | same results, errors and functional states |
| Multi-document atomicity | registry+Space, claim+mutation, router index+command; abort at every boundary | exclusively the old or the completely new state |
| Isolated drafts | mutated return values, late async work, callback errors | no mutation outside the authorized commit |
| Concurrency | parallel takes/writes, snapshots during commit, second owner | no double take, consistent reads, second service locked |
| Commit/reply gap | terminate child process after DB COMMIT before reply | retry returns the original result, no second mutation |
| Real process aborts | terminate child process before/during/after commit and checkpoint | acknowledged operations kept; unacknowledged ones resolvable by request |
| System outage | hard-reset own VM/test device, keep ACK list externally | all previously externally observed ACKs present after restart |
| Storage errors | full disk, read-only, I/O/sync error | no false ACKs; no service operation with an unclear cache |
| Long lifetime | `FOREVER`, finite leases, offline past deadline, clock jumps | durable entries stay, expired work settled correctly |
| Watches/pending | commit in the registration window, signal overflow, disconnect, restart | no lost completion; timeout/cancel and poll semantics kept |
| Background work | crash between fanout/release/admin batches | cursors, budgets and reservations continued consistently |
| Agent bridge | Space replies, agent crashes before result journal; receiver ACK lost | identical tool request/event, no second Space mutation |
| Migration | both legacy backends, several sessions, private families, open txns/claims/jobs | manifest complete; identities/references kept; unknown state blocks |
| Version change | older fixtures, current version, unknown future version, aborted migration | atomic migration or clearly locked start |
| Recovery/fencing | old snapshot, outdated authority, register unreachable, old primary | no release by mere restart/import; existing locks take effect |
| Backup | back up under load, restore in isolation, tamper with checksums | consistent valid backup; error detected; no silent data recreation |
| Capacity/endurance | 1/10/100 Spaces, 10,000 entries in the Space, document/mailbox/claim limits | U0 budgets met; WAL/queues/heaps do not grow uncontrolled |
| Package independence | open main package with prepared dependencies without pi-durable; check declarations and bundle graph | core, local host and remote service fully usable |
| Device/service integration | built pi-server adapter, Android/Termux, background/Doze and process restart | documented mobile limits; agent outage does not end Space persistence |

The existing helpers in `test/support/persistent.ts` simulate with `crash(h)` an
abandon/reopen in the same process and inject storage errors. That stays useful,
but does not replace a child process or power loss check. New evidence is
filed with commit ID, runtime version, storage profile, commands and logs under `test/evidence/`.
Skips do not count as passed device/service acceptance.

After every change package: `npm run typecheck` and `npm test`. In addition,
`npm run test:examples`, the independent host suite, migration suite and
`npm run test:pi-server` are run according to the package. Before native acceptance,
the checked artifact is built; bundle synchronization into the neighbor project is done
deliberately with a matching `PHI_SPACES_MOBILE_ROOT`. Install no dependencies automatically.
Remote test bed first with `--dry-run`; the first real shipping/container start on
`big` and paid live model tests need the intended approval.

## 10. Compatibility, risks and approval decisions

| Topic | Plan decision / remaining gate |
|---|---|
| RPC and `SpaceLike` | keep; test old remote clients against the new service; error codes/claim deadlines unchanged |
| Direct harness/doc/`Once` users | targeted API migration with examples; no hidden alias types on pi-durable |
| New storage | SQLite/FULL intended; Linux/Termux versions and owner lock must pass U2 |
| Large documents | full values simpler at first; load gate can force partial storage before approval |
| Source formats | inventory and pin the legacy versions actually in use; reject unknown versions |
| Downtime | offline cutover intended; set the tolerated pause from the U5 trial before operation |
| Backup age / restart | set operator profile in U0 and measure in U7; no freely invented availability promise |
| Local durability vs. HA | independent host is locally durable; replication/promotion remain their own contract |
| Model/agent functions | separate and optional; the existing agent app may continue to use pi-durable |
| New dependencies | none planned; if platform/lock/backup evidence requires them, decision before introduction |

Approval of a standalone version presupposes U0–U8. An initially local
test version may be available earlier, but is marked explicitly as such.
Before any production move there are a concrete migration report, a checked
backup, measured downtime and a named way back.

## 11. Documents and deliverables

In the course of implementation, `README.en.md`, `AGENTS.md`, `docs/api.en.md`,
`docs/implementierungsstand.en.md`, `docs/_attic/implementierungsplan-v3.en.md`,
`docs/federation-plan-v3.en.md`, `docs/betrieb-und-mobile-steuerung.en.md`,
`docs/_attic/abnahme/ap1b-betrieb.en.md`, test bed/TUI guides and example contracts are adapted.
Historical documents remain historical evidence and are not rewritten retroactively
for the new store. The mobile integration receives its own
migration/operating instructions in the neighbor project.

Deliverables are: independent package including types, standalone service,
SQLite store, optional agent package, legacy exporter/importer, migration report,
backup/restore tools, repeatable crash/outage tests and an acceptance report
with explicitly named limits. The sections 1 to 11 describe the planned move;
what of it is implemented is shown by the statuses at the top.
