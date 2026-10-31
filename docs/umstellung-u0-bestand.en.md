# U0 – Inventory and limits for the move away from pi-durable (2026-10-22)

Work package U0 of [umstellung-ohne-pi-durable.en.md](umstellung-ohne-pi-durable.en.md): inventory, baseline tests,
load profile and proposed limits. Nothing in the code has been changed yet except the tool `scripts/durable-imports.mjs`.

## 1. State

| Item | Value |
|---|---|
| Commit | `f0fba2c` (branch `codemode`); the working tree additionally holds the abort of running model calls on stop (`codemode-chat/server/llm.ts`, `model-host.ts`, tests), not yet committed |
| Node | 22.23.1 (Linux x64); Docker image `node:22-bookworm-slim`; the mobile runtime requires Node ≥ 22.19 and already uses `node:sqlite` |
| Disk | project on ext4; `/tmp` is tmpfs (unsuitable for durability measurements) |
| pi-durable | `@earendil-works/pi-durable` and `@earendil-works/chord` with `*` in `package.json` |

## 2. Baseline tests

| Check | Result |
|---|---|
| `npm run typecheck` | no errors |
| `npm test` (root) | 765 tests: 764 passed, 0 failed, 1 skipped, 62 s |
| skipped | "a read-only copy of a real control store bootstraps and replays with identical content": needs `PHI_SPACES_BOOTSTRAP_COPY` (a copy of a real control store) |
| `npm run test:pi-server` | 2 of 2 passed |
| `npm run test:codemode-chat` | 111 of 111 (last full run before this report) |

## 3. Import graph

Produced with `node scripts/durable-imports.mjs` (Markdown) or `--json`; covers `src`, `examples`, `test`, `scripts`,
`help-site` and `codemode-chat`. An import counts as transitive if a file reaches a directly importing file through any
number of local imports.

| Area | directly pi-durable | chord only | of which types only | transitive only |
|---|---|---|---|---|
| `src` | 39 | 10 | 21 | 38 |
| `test` | 54 | 2 | 2 | 61 |
| `examples` | 13 | 0 | 0 | 0 |
| `help-site` | 15 | 5 | 4 | 6 |
| `scripts` | 1 | 0 | 0 | 1 |
| `codemode-chat/server` | 1 (`space-host.ts`) | 0 | 0 | 15 |

In total 348 files, 140 direct, 124 transitive only.

### 3.1 Names in use

| Group | Names (number of files) | Meaning for the replacement |
|---|---|---|
| Context (chord) | `Context` 45, `BACKGROUND_CONTEXT` 54, `awaitWithContext` 2 | abort/deadline context in almost every interface; decision D1 |
| Deltas (chord) | `apply` 3, `applyImmutable` 1 | applying stored document deltas (erasure, replication) |
| Harness | `Harness` 78 (`Harness.open` 90 calls, mostly tests), `createRegistry` 71, `defineExtension` 3, `defineTool` 2, `section` 1 | host creation; the agent extension only in `src/index.ts` and examples |
| Session/transaction | `Session` 10, `Tx` 8, `ConversationId` 1 | called: `commit` 111, `tx.doc` 143, `snapshot` 69, `watchDoc` 11, `tx.retireDoc` 2, `close` 3, `conversation` 1 |
| Documents | `defineDoc` 17, `defineDocFamily` 16 | 33 document kinds (section 4) |
| Storage | `MemoryStorage` 41, `openNodeSqliteStorage` 26, `openNodeJsonlStorage` 18, `Storage` 8, `StorageWrite` 4, `StorageRejected` 1, `DocumentId`/`DocumentRecord`/`Seq` 1 each | backends; the storage layer is partly used directly (3.2) |
| dynamic | `import("@earendil-works/pi-durable")` 14, storage subpaths 2 | in runtime/configuration code and tests |

### 3.2 `Once`

`Once` (`src/client.ts`) has exactly one user: the agent tools in `src/index.ts` (`onceFor`). They write the
task-bound document `phi-spaces.claim` in the same commit as the change to the Space. This is the break named in plan
section 6: once Space and agent live in separate stores, it is no longer atomic. It only concerns the future agent
package; the standalone service does not need `Once`.

### 3.3 Transactions across several document kinds

Files whose transactions touch more than one document kind (collected statically via `tx.doc(…)`, `spaceDoc(…)`,
`registry(tx)`/`hostKey(tx)`; per file, not per commit). With partial storage these changes must land in **one**
SQL transaction; the list is input for the commit contract of U2, where it is confirmed per commit:

| File | Document kinds |
|---|---|
| `src/client.ts`, `src/spaces.ts` | Registry, Space/NamedSpace |
| `src/index.ts` | Claim (task), Registry, Space |
| `src/run-controller.ts` | RunJournal, Space |
| `src/recovery-controller.ts`, `src/control-recovery.ts` | Recovery/control jobs, Registry, Space |
| `src/control-ack.ts` | RecoveryReceipts, Space |
| `src/space-lifecycle.ts` | SpaceLifecycleJournal, Registry, Space |
| `src/data-admin.ts` | DataAdminJournal, Space |
| `src/supervisor.ts` | SupervisorJobs, Space |
| `src/workers.ts` | WorkerJournal, WorkerState |
| `src/router.ts` | RouterJournal, RouterCommands |
| `src/federation-references.ts` | FederationJournalLayout, FederationOperations, RouterCommands, RouterJournal, Space |
| `src/federated-space.ts` | FederationJournalLayout, FederationOperations, FederationRouting, MembershipJournal, ProfileTransitions |
| `src/membership.ts` | FederationRouting, MembershipJournal, MemberTransitions, ProfileTransitions, Space |
| `src/profile-transition.ts` | FederationOperations, FederationRouting, MembershipJournal, ProfileTransitions, Space |
| `src/federation-policy.ts` | ControlReplicaMarker, FederationRouting, ProfileTransitions, Space |
| `src/replica-notice.ts` | FederationRouting, ProfileTransitions, Space |
| `src/capability-directory.ts` | FederationRouting, Space |
| `src/delegation.ts` | ControlReplicaMarker, DelegationEpochs, Space |
| `src/root-erasure.ts` | ErasedEntryDigests, FederationJournalLayout, FederationOperations, RootErasures, RouterCommands, RouterJournal |
| `src/entry-replication.ts` | EntryReplicaPeers, EntryReplicas, EntrySnapshotChunks, EntrySnapshotMaintenance, EntrySnapshotTransfers, EntryStreamCheckpoints |

### 3.4 Couplings below the document interface

These places depend not only on `tx.doc` but on the storage format or on internals of pi-durable's storage:

| File | Coupling | Target package |
|---|---|---|
| `src/primary-sync.ts` | replicates `StorageWrite` batches (pi-durable storage deltas) as the primary/sync journal | U4: own delta format of the new store |
| `src/erasure-sqlite.ts` | SQL directly on pi-durable's schema v1 (`documents`, `document_revisions`), applies deltas with chord | U2: maintenance of the phi-spaces store; the old path only in the legacy tool (U5) |
| `scripts/migrate-namespace.mjs` | offline copy of a pi-durable SQLite v1 | removed (D6) |
| `src/commit-sealed.ts` | `StorageRejected` as the store's error signal | U2: own error type |
| `src/dashboard.ts`, TUI | open JSONL/SQLite stores themselves | U6 |
| `src/index.ts` | agent tools, task document `phi-spaces.claim`, delivery to conversations | U1: separation; U6: separate agent package |
| `codemode-chat/server/space-host.ts` | `Harness.open`, `MemoryStorage`, `openNodeSqliteStorage`, `createModels` | U3: first real user of the standalone service |

## 4. Document catalog

All `defineDoc`/`defineDocFamily` in `src`, examples and help site (family: many documents of one kind with a
key). "Part": partial storage needed in U2 because the document grows with load.

| Kind | Version | Scope | File | Family | Remark |
|---|---|---|---|---|---|
| `phi-spaces.space` | 5 | session | `src/doc.ts` | no | Space; base every 500 deltas, migration; **part** |
| `phi-spaces.named-space` | 5 | session | `src/spaces.ts` | yes | named Spaces, as above; **part** |
| `phi-spaces.registry` | 1 | session | `src/spaces.ts` | no | aliases, Space identities, host keys |
| `phi-spaces.claim` | 1 | task | `src/index.ts` | no | agent task claim; goes into the agent package |
| `phi-spaces.router-journal` / `router-command` | 1 | session | `src/router.ts` | yes | router journal and individual commands |
| `phi-spaces.delegation-epochs`, `control-replica-marker` | 1 | session | `src/delegation.ts` | yes | |
| `phi-spaces.federation-routing` | 1 | session | `src/federation-policy.ts` | yes | |
| `phi-spaces.federation-operations` | 1 | session | `src/federated-space.ts` | yes | |
| `phi-spaces.federation-journal-layout` | 1 | session | `src/federation-journals.ts` | yes | |
| `phi-spaces.membership-journal`, `member-transitions` | 1 | session | `src/membership.ts` | yes | |
| `phi-spaces.data-admin` | 1 | session | `src/data-admin.ts` | yes | |
| `phi-spaces.deployment` | 1 | session | `src/deployment.ts` | no | |
| `phi-spaces.entry-replica`, `entry-replica-peers` | 2 / 1 | session | `src/entry-replication.ts` | yes | migration for `peers` |
| `phi-spaces.entry-stream-checkpoints` | 1 | session | `src/entry-replication-stream.ts` | yes | |
| `phi-spaces.entry-snapshot-transfers`, `-chunk`, `-maintenance` | 1 | session | `src/entry-replication-transfer.ts` | yes | |
| `phi-spaces.profile-transitions` | 1 | session | `src/profile-transition-doc.ts` | yes | |
| `phi-spaces.root-erasures`, `erased-entry-digests` | 1 | session | `src/root-erasure-doc.ts` | yes | |
| `phi-spaces.control-recovery-receipts` | 1 | session | `src/control-ack.ts` | no | |
| `phi-spaces.control-recovery-jobs` | 1 | session | `src/control-recovery.ts` | no | |
| `phi-spaces.recovery-jobs` | 1 | session | `src/recovery-controller.ts` | no | |
| `phi-spaces.supervisor-jobs` | 1 | session | `src/supervisor.ts` | no | |
| `phi-spaces.run-controller` | 1 | session | `src/run-controller.ts` | no | |
| `phi-spaces.space-lifecycle` | 1 | session | `src/space-lifecycle.ts` | no | |
| `phi-spaces.worker-assignments`, `worker-supervisor` | 1 | session | `src/workers.ts` | no | |
| `phi-spaces.example-cache-version`, `example-sieve-runs` | 1 | session | `examples/` | no | examples |
| `phi-spaces.research-validation` | 1 | task | `examples/research-support.ts` | no | agent example |
| `phi-spaces.help-web-admin` | 1 | session | `help-site/server/admin/admin-controller.ts` | no | help system |

### 4.1 Contents of the Space document

`SpaceState` (`src/core.ts`) holds in **one** document: `entries`, `txns`, `regs`, `waiters`, `outbox`, `returned`,
`nextId`, `limits`, `spaceId`, `incarnation`, `rpc` (claims and generations), `stream` (change log),
`completionProfiles`, `mailboxes`, `jobs`, `releaseQueue`, `maintenance`, `primaryEpoch`, `acceptedAuthorityId`,
`authorityTransition`, `authorityCounters`, `restore`, `restoredClaims`, `invalidGenerations`, `runGates`, `archived`,
`erasureEpoch`, `adminMaintenance`, `snapshotEpoch`, `membership`.

## 5. Load profile (measured on the codemode chat)

Local Docker test environment (big/nano, all roles over TCP), 9.5 hours mostly idle, plus a few runs:

| Part of the Space document | Size |
|---|---|
| `rpc` (45,171 claims with result) | 27.1 MB |
| `stream` (change log, limit `maxLogBytes` 4 MB) | 4.2 MB |
| `entries` (the actual data) | 0.06 MB |
| whole base (all 500 deltas written in full) | 31.4 MB |

- Claims by method: `txn.begin` 9,793, `lease.renew` 10,533, `take` 8,461, `txn.abort` 8,288, `readIfExists` 4,123,
  `write` 3,821. Almost all idle: wait loops (transaction, waiting `take`, abort every 5 s) and
  lease renewals. On average about 600 bytes per claim (`rpc.bytes` 27,118,868, the value of the limit check).
- Rate: in the hours of pure idle (23:00 to 04:00) about 2,500 claims per hour, so roughly 1.5 MB per hour; with
  the runs and restarts in the evening up to 12,000 per hour.
- Consequence: with 24 h retention (`claimResultMs`), pure idle reaches the limit `maxClaimBytes` (32 MB) after about
  21 h (equilibrium ≈ 36 MB), earlier with some load (in this environment after about 12 h). After that the Space rejects new
  requests.
  Under load (about 140 submissions) the Space process ran permanently at 100 % CPU (writing the base, linear search),
  clients ran into timeouts.
- The cause is the storage model (one document per Space, full base, linear search in memory), not SQLite.

### 5.1 Comparison measurement: SQLite with one row per entry

`node:sqlite`, WAL, 20,000 entries of 2 KB; one commit = write one entry, take one, store one claim:

| Profile | ext4 (project disk) | tmpfs |
|---|---|---|
| `synchronous=NORMAL` | 1.3 ms per commit (≈ 770/s) | 0.04 ms |
| `synchronous=FULL` | 27.7 ms per commit (≈ 36/s) | 0.04 ms |
| Counting via index (type, room) | – | 0.03 ms |

The limit is set by the `fsync` per commit. For FULL a batched commit is therefore needed (several Space commits in
one SQL transaction with one `fsync`, acknowledging all of them only afterwards).

## 6. Proposed limits (for approval)

| Limit | Proposal | Measured in |
|---|---|---|
| Commit latency, one Space commit, profile NORMAL | p95 ≤ 5 ms, p99 ≤ 20 ms | U2 |
| Commit latency, profile FULL with batching | p95 ≤ 50 ms at ≥ 300 commits/s | U2 |
| Write volume per commit | proportional to the changed entries/claims; no full base of a Space | U2 |
| Capacity | 10,000 entries per Space, 100 Spaces, 150,000 claims (24 h idle of the chat with reserve) | U2/U7 |
| Matching | `take`/`read` by type and fields without a full scan (index) | U2 |
| Memory of the Space process | ≤ 300 MB RSS at the capacity profile | U7 |
| Start (reopen) at the capacity profile | ≤ 2 s until ready | U2/U7 |
| RPO | 0 for acknowledged commits in profile FULL within the tested failure model | U7 |
| RTO local (process restarted) | ≤ 5 s | U7 |
| Platforms | Linux x64 Node ≥ 22.19 (native and Docker), Android/Termux Node ≥ 22.19 | U2/U6 |

## 7. Target mapping

| Today (pi-durable) | Target |
|---|---|
| `Harness.open` + `createRegistry` + `registry.install(spaces)` | `openSpaceHost({ store })` in `src/host.ts` (U1 type, U2/U3 implementation); tests through a shared fixture |
| `Session.commit(fn)` | `SpaceHost.commit(fn)` with a serial queue and batched `fsync` |
| `tx.doc(Def)`, `tx.doc(Family, key, seed)`, `tx.retireDoc` | `StoreTx.doc`/`retire` with own document definitions (`src/store/documents.ts`) |
| `Session.snapshot` | consistent read snapshot (SQLite read transaction) |
| `Session.watchDoc` | wake-up signal after commit, registration before the first check |
| Space document as a whole | partial storage: entries, claims, generations, change log, mailboxes each as their own rows; the rest (limits, identity, counters, txns) as a head row |
| `MemoryStorage` | `src/store/memory.ts` (tests only) |
| `openNodeSqliteStorage` / `openNodeJsonlStorage` | `src/store/sqlite.ts`; JSONL is dropped (only a legacy reader in U5) |
| `checkpointWhen` / base every 500 deltas | dropped for the Space; small journals continue as whole values |
| `StorageWrite` replication (`primary-sync.ts`) | own delta format from the partial storage (U4) |
| `erasure-sqlite.ts` | maintenance of the phi-spaces store (U2) |
| chord `Context` / `BACKGROUND_CONTEXT` | decision D1 |
| Agent parts of `src/index.ts`, `Once` | separate package (U1 separate, U6 package); `Once` there only on its own documents |
| `examples/` (13 direct imports) | switch to the phi-spaces host (U3), agent examples into the agent package (U6) |
| `help-site` (15 direct pi-durable, 5 chord only) | own application with its own store and admin document: move in U6 |

## 8. Open decisions

- **D1 – chord: decided (2026-10-22): own context.** An own context (abort signal and deadline) replaces
  `Context`/`BACKGROUND_CONTEXT` of `@earendil-works/chord` in U1; applying deltas (`apply`) gets its own
  implementation. The package thereby becomes free of `@earendil-works/*`.
- **D2 – limits: decided (2026-10-22):** the proposals in section 6 apply.
- **D3 – default profile: decided (2026-10-22):** FULL with batched commit is the default; NORMAL only when chosen
  explicitly.
- **D5 – byte budgets:** The 32 MiB for claims are a sub-budget of the whole document (128 MiB), which today lives entirely
  in memory and is written in full as the base (`DEFAULT_LIMITS`, [ap2-gate4](_attic/abnahme/ap2-gate4.en.md): "no 24-hour
  endurance measurement"). With partial storage, claims live as rows on disk; their limits are redefined in U2
  (count and bytes on disk instead of a share of a document in memory).
- **D4 – claims in the chat: decided (2026-10-22):** retention stays 24 h (contract); row storage carries it.
- **D6 – old pi-durable data: decided (2026-10-23):** It is discarded, not carried over. U5 (export/import)
  is dropped. The test bed on `big` is also set up again with empty stores on the phi-spaces store. A journal or
  a file in pi-durable format is rejected with a clear message.

## 9. Next step

U1: introduce own types for host, store transaction and documents, with pi-durable behind them as a transitional adapter,
all tests unchanged and green; then U2 with partial storage and batched commit.
