# phi-spaces and pi-durable: what they share and where they differ

As of: **31 October 2026**. Comparison of the current TypeScript code of phi-spaces with
**`@earendil-works/pi-durable` 1.4.0**, the newest npm release at the time of research.
The newer, **unreleased** Earendil development state is treated separately in section 8.

The [upgrade to 1.4.0](upgrade-pi-1.4.0.en.md) has been carried out: the agent package, Codemode and the mobile runtime run on
1.4.0. Section 7 records what had to change for that; section 9 describes the research, Codemode and NPC extension steps.

## 1. Summary and basis of comparison

**phi-spaces and pi-durable are not alternatives of the same kind.**

- **pi-durable** is a persistent agent runtime: conversations, model responses, tool calls,
  task state machines and application documents are stored and continued after restarts.
- **phi-spaces** is a persistent coordination and data service on the tuple-space principle:
  independent processes or agents exchange typed entries, search by template and take over work
  with `take`, transactions and leases.
- Both need atomic state changes, restart recovery, stable identities and observability.
  They apply these mechanisms to different subjects, however.
- Today's Space core needs **neither pi-durable nor Chord or pi-ai**. The separate package `agent/`
  connects it to pi-durable. The earlier description as a pure pi-durable extension is obsolete for the core.
- Together they fit well: **pi-durable executes an agent; phi-spaces coordinates its collaboration
  with other participants.** Neither automatically replaces the guarantees of the other.

### Versions

| Subject | State actually checked | Meaning |
|---|---|---|
| phi-spaces | Package version `0.0.1`, as of 30.10.2026 | The yardstick is the TypeScript code that was read, not just older architecture documentation |
| Local agent connection | `agent/package.json` and lockfile: pi-durable, Chord and pi-ai each exactly `1.4.0` (starting from `1.0.3`) | Exception mobile runtime: pi-client, pi-server and pi-protocol stay on `1.1.0`, see [upgrade](upgrade-pi-1.4.0.en.md) |
| Newest published pi-durable version | npm tag `latest`: **`1.4.0`**, published on **21.10.2026, 22:44:09 UTC** | Main comparison of this document |
| Corresponding Earendil release | Tag `v1.4.0`, commit `4a080252f06caf63a525d7873c5d94d3c23887e0` | README and changelog match the published npm package |
| Newest Earendil development state queried | Commit `c7372af4201aaa0c049f63c198e765cb4a2e3013`, 30.10.2026, 22:08:57 UTC; read in detail was `50af8c160153e3721a18b1a046a4adf201635861` (13:30:54 UTC) | Contains additional changes under `Unreleased`; **not** to be equated with npm 1.4.0 |

The npm archive was read without installing it, and its SHA-512 integrity was checked against the registry.
The online queries took place on 30.10.2026.

**Terminology:** "Pi" denotes Earendil's entire monorepo including the coding agent, pi-ai,
pi-durable, Chord and further packages. This comparison concerns mainly **pi-durable**, not all
functions of this ecosystem across the board. Chord, for example, brings its own RPC and state mechanisms;
pi-durable itself is therefore not yet a phi-spaces-compatible network service. [P1–P4, P8]

## 2. Architecture and basic model

### pi-durable: durable execution around conversations

A `Harness` opens a session over a storage backend. A conversation owns a transcript
of immutable entries. A submission delivers input or an entry to be written.
Inputs start generation tasks, which query models and create tool tasks.
Tasks store their phases and checkpoints; the scheduler continues them after a restart.

A commit can store transcript entries, document changes and task creation together.
Documents can belong to the session, a conversation or a task. Conversation documents
also support historical states and defined fork semantics. That is considerably more than a
persistent list of chat messages. [P3]

### phi-spaces: durable shared workspace

An `OwnStoreHost` holds documents and performs atomic commits. `PhiSpaces` implements the
Space operations on top of it. An entry is domain content with `type`, optional supertypes and `fields`;
it is **not** a pi-durable transcript entry.

Producers need not know the later consumer. A consumer searches, for example, for
`{ type: "Job", fields: { queue: "analysis" } }` and takes over a matching entry with `take`.
A Space transaction can reserve the takeover and make results visible only on commit.
On abort or expiry of the transaction lease the reservation is returned.

`SpaceService` and `RemoteSpace` also provide the semantics across process boundaries.
Model calls, prompt construction and the execution of an arbitrary agent task state machine are
not the job of the Space core. [L1, L3, L4]

### Today's combination

```text
pi-durable harness                         phi-spaces host
Conversations, model and tool tasks        Entries, leases, claims, mailboxes
agent store                                phi-spaces store
             |                                      ^
             +-- agent/: stable request identity ---+
             <--- EventSink / conversation delivery
```

Both hosts may run in the same process, but have **separate storage and commit boundaries**.
The earlier model "agent task claim and Space change in one harness commit" no longer applies.
Before the first domain Space call, the bridge stores that call's request identity as a task memo in the
agent store; only the generation is fetched from the Space before that. The Space stores effect and result atomically under
this identity. A replay thereby calls the same operation again instead of inventing a new one.
If the generation no longer accepts new requests, a replay that has not yet been taken in is rejected with `RequestExpired`.
The promise presupposes that the memo survives the failure; see section 5.3. [L5]

The diagram shows the connection in the same process. Since the upgrade, Codemode chat and spaces-mmo
additionally have a separate agent process: the application talks over Node IPC to
[`durable-worker.ts`](../agent/src/durable-worker.ts), and the harness there does not know the Space.

## 3. What they share

| Shared principle | pi-durable 1.4.0 | phi-spaces |
|---|---|---|
| Typed state | JSON documents with definition, version and migration | JSON document definitions of phi-spaces (`defineDoc`) with version and migration |
| Atomic local changes | Entries, documents and tasks within a session | Documents and Space state within a store host |
| Persistence before acknowledgement | Published state changes follow the stored commit; how durable it is depends on the backend (section 5.3) | Success replies and watches follow the durable commit, in the default profile with `synchronous=FULL` |
| Restart recovery | Task checkpoints, stored submissions and results | Claims, waiting operations, leases, outbox and operations journals |
| Repeatable requests | Submission `requestId`, task memos and re-attachable nested tools | Generations, request IDs, argument binding and stored results |
| Observation | Document watches, conversation views and task graph | Document watches as well as Space pages, revisions, changes and events |
| Failure containment | Storage failures end the session; crash-loop protection for tasks | Storage errors lock the host; quotas and budgets limit commitments |
| Time and cancellation | Chord context, harness clock and configurable timers | phi-spaces context (`src/context.ts`), explicit core time as well as lease and waiter deadlines |

These similarities are architecturally significant, but they are **no API or file format compatibility**.
`defineDoc`, `commit`, `snapshot` and `watchDoc` have similar names, but different types,
addressing rules and in part different observation semantics. [P3, L2]

Both also avoid an automatic promise of external exactly-once effect.
A stored tool intent or an exclusively taken job does not yet prove whether an external
payment, e-mail or HTTP mutation was executed before a crash.

## 4. Feature comparison

The pi-durable column describes **release 1.4.0**, unless expressly stated otherwise.

| Area | phi-spaces | pi-durable |
|---|---|---|
| Main purpose | Coordinate shared data and work between participants | Operate persistent agents and their execution |
| Central abstraction | Space with entries found by template | Conversation with transcript, submissions and tasks |
| Typical access | `write`, `read`, `take`, `readAll`, `notify`, `wait` | `submit`, `wait`, `commit`, tasks and tools |
| Work distribution | Competing consumers take over matching work from a Space | Scheduler executes owned tasks; no corresponding tuple-space `take` |
| Transactions | Additionally long-lived domain transactions with reservation, commit, abort and lease | Atomic commit callbacks; no comparable leased entry reservation across many calls |
| Lifetime | Entry, transaction and registration leases, explicit renewal | Task lifecycle and stored sleep states; no corresponding general entry lease |
| Long waits | Durable waiters on matching data; read/take waits | Task sleep until a point in time, waiting for tasks or submissions |
| Model integration | Not in the Space core; applications or `agent/` take it on | Built in via pi-ai: generation, model choice and context preparation |
| Tools and prompts | Space tools in the separate agent package | Extension registry, tools, prompt sections, hooks and ExecutionEnv |
| Subagents | Participants can be independent agents; no built-in LLM subagent run | Owned child conversations and child tasks, cancellation cascades |
| Code Mode | Separate Earendil package in examples/applications; no core semantics | Persistent Code Mode integration with deterministic replay journal |
| History and forks | Revision/changes log for Space data; no conversation forks | Transcripts, forks and historical conversation documents |
| Notifications | Template notify, waiters, outbox, durable mailboxes with ACK/TTL/gap | Watches and conversation views; no corresponding Space mailbox ACK semantics |
| Resource rules | Byte budgets, owner quotas, deadlines and reserved result/completion budgets | Among others tool output limits, storage retention, retry and compaction settings |
| Network service | In-process, Unix socket and TCP; adapter for pi-server | Harness/storage library; network hosting is an additional integration |
| Identity and access | Principals, role/type policy; optional gate, key, grant and enrollment layers | Tool/extension selection and host environment; no corresponding Space peer authorization in the harness |
| Distribution and recovery | Router, membership, delegation, primary/sync, fencing and recovery building blocks | Session restart recovery is built in; no comparable Space federation/promotion contract |
| Storage platforms | phi-spaces store for memory and Node SQLite | Memory, SQLite, JSONL, IndexedDB and Cloudflare Durable Object SQLite |
| Observability | `Meter`, store statistics, dashboard, audit and alerts | Token/cost counting, inspect/task graph and pi-telemetry connection |
| Rust | Core, store and standalone service ported and accepted (R0–R3), secure host (R5) in progress; not released across the board as a finished replacement | The checked package is TypeScript/JavaScript; no Rust runtime can be derived from it |

**Important limit:** A pi-durable watch is not a durably acknowledged Space event stream.
Release 1.4.0 limits slow watches and on overflow replaces pending frames with the newest
state. A new observer begins with the current state. Conversely, phi-spaces `changes` are
not a complete store replication stream and not a conversation history. [P3, L3, L4]

## 5. Storage, consistency and durability in detail

### 5.1 Same SQLite, different data models

pi-durable stores separate records for conversations, entries, tasks and submissions as well as
document bases and document revisions. Chord tracks document changes as deltas.
Since 1.4.0 every document definition must explicitly state a `checkpointWhen`:
the application decides when a complete base is written instead of a further delta.
**So pi-durable does not necessarily write the entire application document on every change.**
That is an option, not an automatism: the harness's own documents `agent`, `provider` and `usage`
choose `() => true` themselves and thereby write a base on every commit. [P4, P5]

phi-spaces stores document heads and large collections separately. `SPACE_PARTS` comprises entries,
RPC claims, historical claims after restore, generations and stream batches.
The SQLite store holds the records of the parts in separate `parts` rows.
RPC claims and historical claims are disk parts as whole maps and need not lie completely in
main memory; `DISK_MAP` queries them specifically via keys and indexes. A copy-on-write/undo mechanism of phi-spaces replaces Chord's tracker.
That is a deliberate adaptation to the load profile of a Space service, not a general superiority
of one JSON model over another. [L2, L6]

Search should not be overstated either: the current TypeScript semantics use cached type buckets
under certain conditions. That does **not** make it an arbitrarily field-indexed SQL database.
Template fields are still checked semantically with deep JSON equality. [L1]

### 5.2 Commit processing

**pi-durable 1.4.0:** The session serializes commit callback, preparation, storage completion and
adoption on one mutation line. This line stays occupied during the storage call.
At this state, the more extensive group commit implementation of `main` must not be assumed. [P6]

**phi-spaces:** Commit callbacks also run in order, but the next one may already build on the
prepared state while earlier commits are still being written.
A writer thread bundles incoming changes into SQLite transactions.
Replies and external observers still wait for durable storage.
If writing fails, the host locks itself instead of continuing to acknowledge unsaved changes. [L2]

This is **not a distributed transaction** between several hosts. A pi-durable commit does not
automatically encompass a separate Space store, an external service or a second harness either.

### 5.3 "Durable" depends on the backend and the failure model

| Point | phi-spaces SQLite | pi-durable 1.4.0 |
|---|---|---|
| Default sync profile | WAL with **`synchronous=FULL`** | Node SQLite according to the documentation WAL with **`synchronous=NORMAL`** |
| Consequence | Acknowledgement after SQLite COMMIT in the FULL profile | Process-crash persistence; the most recent commits can be lost on power or host failure |
| Alternative | `NORMAL` can be chosen explicitly, with a weaker failure promise | JSONL `{ fsync: true }` flushes sidecars, not necessarily every commit marker; other backends have their own contracts |
| Several writing processes | Store owner lock via exclusively locked `.owner` file | One owner presupposed; according to the README no cross-process storage locking |
| Memory backend | No persistence | No persistence |

FULL is no proof against defective disks, file system errors or controllers that do not keep
flush promises. Local SIGKILL tests also do not demonstrate a real power loss.
Replication, backup and restoration are separate questions. [P3, L2, L6]

**Consequence for the combination:** The table compares the defaults, not the durability of an interplay.
The agent stores, opened more weakly at first, have since been hardened: [`agent/src/storage.ts`](../agent/src/storage.ts) in the phi-spaces agent package
opens the pi-durable stores `SqliteStorage` and `JsonlStorage` with stricter settings; it changes neither
pi-durable nor the phi-spaces store. The worker and the mobile runtime use SQLite
`synchronous=FULL`, checked before the schema is opened. Research runs use JSONL with `{ fsync: true }`
plus an additional flush of the commit marker and the directory entries. The upstream option alone would
not be sufficient for that. The research manifest and atomic exports are likewise synchronized.

The [regressions](../agent/test/storage.test.ts) check sync policy, marker order, a simplified
file-cache loss model and refused acknowledgement on flush errors.
A [VM experiment](agenten-stromausfalltest.en.md#result-of-30102026) tested the agent store in both profiles:
"weak" means the pi-durable stores with the pi-durable defaults, "strong" the same stores opened via `agent/src/storage.ts`.

**What happens on a commit.** In a loop, each probe writes a counter with a checksum and prints an acknowledgement after each
finished commit. Acknowledged means: the store's commit promise has been honored, the application may
continue working. The question of the experiment is whether every acknowledged counter is still there after the failure.

| Profile | Opened with | Sequence up to the acknowledgement | When the data is really on the disk |
|---|---|---|---|
| pi-durable SQLite, weak | `openNodeSqliteStorage`: WAL, `synchronous=NORMAL`, checkpoint every 1000 pages | Append pages to the WAL with `write`, acknowledge. No flush | Only at the checkpoint, triggered by the commit that lifts the WAL above 1000 pages, and before that commit's acknowledgement: flush WAL, write pages to the main file, flush main file. At 4 pages per commit every 250 commits |
| pi-durable SQLite, strong | `openDurableSqliteStorage` from `agent/src/storage.ts`: the same database, set to `synchronous=FULL` before the schema is opened and checked; directory flushed | Append pages to the WAL, flush WAL, acknowledge | Before every acknowledgement |
| pi-durable JSONL, weak | `openNodeJsonlStorage`: without `fsync` | Append record to the sidecar file, append commit marker to `main.jsonl`, rewrite sidecar as `.reclaim` file and rename, acknowledge. No flush, not even for new file names | Whenever the kernel writes it back by itself; after the failure the whole file can be missing |
| pi-durable JSONL, strong | `openDurableJsonlStorage` from `agent/src/storage.ts`: `{ fsync: true }` plus file system wrapper | Append sidecar, flush sidecar (pi-durable); flush directory, append marker, flush marker, flush directory (`agent/src/storage.ts`); flush marker again, write and flush `.reclaim` file, rename (pi-durable), flush directory (`agent/src/storage.ts`); acknowledge | Before every acknowledgement, the marker after its data |
| phi-spaces store, weak | `openSqliteHost(pfad, { synchronous: "NORMAL" })`: chosen explicitly, checkpoint every 1000 pages | Writer thread puts all waiting commits into one SQLite transaction, appends it to the WAL, acknowledges them together. No flush | Only at the checkpoint: at 2 pages per document commit every 500 commits, with Space writes at 6 to 12 pages per write correspondingly earlier |
| phi-spaces store, strong | `openSqliteHost(pfad)`: default `synchronous=FULL` | As weak, but the WAL is flushed before the joint acknowledgement | Before every acknowledgement, one flush for all commits of the group |

A flush is `fsync`, with SQLite depending on the Node build also `fdatasync` (VM with the official Node 22.23.1: `fsync`, development machine: `fdatasync`); it ends only when the drive reports the data
as secured. Without a flush it lies only in the kernel's page cache after `write`. The sequences are [recorded with `strace`](../test/evidence/power-loss-2026-10-30/syscalls.en.md).
The per-commit recording ran on the development machine (SQLite 3.51.2), the one at hard power-off in the VM. It shows the order of the syscalls, not the drive.
With 8 writers the phi-spaces store had 81 acknowledgements on 32 WAL flushes, pi-durable SQLite 47 on 50.

**What happens on failure.** None of this dies with the process; the page cache survives a process crash. Only a
power or host failure hits it. Two methods reproduce that:

1. **Replay:** In the guest, dm-log-writes records every write to the test disk in order, as soon as a flush completes it; after
   acknowledgements a mark goes into the log. Afterwards the disk is rebuilt up to a randomly chosen mark,
   with exactly what had been flushed by then. That is the state after a loss of
   page and disk cache at this point. Mounting replays the ext4 journal, and the probe checks the acknowledged counter.
2. **Hard power-off:** The host ends the running VM with `virsh destroy` after 6 to 20 s; the acknowledgements are collected outside
   the VM. After the restart the probe checks the highest value that reached the host. There is only this one
   cut per run, and it lies where the clock happens to put it.

**What follows from this.** In the weak SQLite profile, the replay loses the commits since the last checkpoint, so depending on the
cut 1 to almost 250 with pi-durable and up to almost 500 with the phi-spaces store. The replay is sensitive there because it hits points
across the whole window. In the weak JSONL profile, almost everything new is missing without a flush, hence loss at every cut.

| Profile | Replay: cuts with loss | Hard power-off: runs with loss |
|---|---|---|
| SQLite strong | 0 of 38 | 0 of 3 |
| JSONL strong | 0 of 37 | 0 of 3 |
| SQLite weak (`NORMAL`) | 77 of 115, up to 249 commits | 0 of 9 |
| SQLite weak with `strace` | not checked | 4 of 9, 86 to 233 commits |
| JSONL weak (without `fsync`) | 115 of 115 | 9 of 9 |

The 0 of 9 demonstrate no durability: the weak profile writes for a while without a flush and then hangs in the
checkpoint on the disk. Without `strace` the power-off always hit this waiting period, a moment without unflushed commits: all nine
runs ended at a persisted state of 250·n − 11 (for example 4739, 6239), and the recording shows the first checkpoint exactly in
commit 239. The repetition with `strace` streamed out of the VM demonstrates this directly. `strace` lengthens the writing phase; the flush still took
61 to 70 % of the run time. In all 5 runs without loss the last call was a still open `fsync` of the WAL,
in all 4 runs with loss a `pwrite`; the state there fell back to the last checkpoint (for example 4239 at 4353 acknowledgements).
Whether `NORMAL` loses data at power-off thus depends only on where the cut lies. Durability costs a lot; the rates are in the table below.

**Comparison with the phi-spaces store:** The same experiment ran on the same VM and disk with an
[identically built probe](../agent/test/power-loss-own-probe.ts) against the phi-spaces store: once the same document, once
real `PhiSpaces` writes. For the phi-spaces store, strong stands for `synchronous=FULL`, weak for `NORMAL`.

| Store | Replay: cuts with loss | Hard power-off: runs with loss |
|---|---|---|
| phi-spaces store, document, strong | 0 of 38 | 0 of 3 |
| phi-spaces store, Space writes, strong | 0 of 38 | 0 of 3 |
| phi-spaces store, document, weak | 33 of 38, up to 497 commits | 0 of 3 |
| phi-spaces store, Space writes, weak | 26 of 38, up to 84 commits | 0 of 3 |
| Strong with 8 writers: document / Space writes / pi-durable SQLite | 0 of 38 per row | not checked |

The Space-write probe checks every acknowledged entry individually with a checksum; with 8 writers a number counts as acknowledged only when all smaller ones are.

In the profiles and cuts examined, there was no loss in the strong profile; with `NORMAL` both systems lost acknowledged data.
The cuts of one cell are not independent failures: the 37 or 38 come from three write runs. What was checked is a small counter or
a series of individual entries, not conversations, tasks or document deltas, and only at marks, not specifically in critical write and replace steps.
For those cases the experiment says nothing. In the experiment, the difference of the defaults followed from the setting: phi-spaces takes `FULL` by itself,
pi-durable `NORMAL`. In the phi-spaces agent package, `agent/src/storage.ts` replaces this `NORMAL` with `FULL`.

Median (smallest to largest value) of commits per second on the same disk: [5 runs of 20 s each](../agent/test/power-loss-rate.mjs) in mixed
order, fresh ext4, no run discarded, hard-disk RAID, host load value 4.3 to 10.6 due to unrelated load:

| Store | strong, 1 writer | strong, 8 writers | weak, 1 | weak, 8 |
|---|---|---|---|---|
| pi-durable SQLite | 2.9 (1.9–6.2) | 5.4 (2.6–6) | 237 (187–462) | 212 (175–525) |
| pi-durable JSONL | 0.7 (0.4–1.4) | 0.7 (0.6–1.4) | 207 (21–965) | 346 (127–819) |
| phi-spaces store, document | 4.1 (2.9–5.7) | 6.1 (2–24) | 299 (249–924) | 1397 (597–3027) |
| phi-spaces store, Space writes | 2.9 (0.1–5) | 9.8 (6.7–12.6) | 73 (24–125) | 179 (70–237) |

The ranges overlap almost everywhere; the series does not support a general performance comparison. In the strong profile, with 8 writers,
it yields no assured lead for any of the stores. The bundling itself is demonstrated: the writer thread of the phi-spaces store puts several commits
on one flush (81 acknowledgements on 32 WAL flushes in the recording), pi-durable 1.4.0 does not do this (section 5.2). Clear are only the gap
from strong to weak and the lead of the phi-spaces store with 8 writers in the weak document profile. The Space writes bear the cost of the Space semantics and are not to be equated with a
document commit. The experiment measures this small load, not the agent runtime.

Also still open are the behavior of the drive, that is whether it keeps flushes and how it writes sectors, and any other file system. Workflow resumption so far remains demonstrated by
process-crash tests, not by a complete power-loss end-to-end acceptance.

Lost or damaged agent data can still lose the request identity or consumption not yet booked in the
Space; FULL is no substitute for backups or a joint commit of both stores.
Against simultaneous processes, `durable-worker.ts` additionally secures the store with an
`.owner` file, because pi-durable itself has no cross-process locking.

### 5.4 Repetition is secured at different levels

**pi-durable:** `submit` with the same request ID finds the existing submission of the same conversation.
The checked 1.4.0 code verifies the submission type, but not additionally the equality of all
re-supplied content. A request ID must therefore not be reused for inputs that differ in substance.
Task memos and keys of nested tool calls stabilize re-attachment.
An interrupted tool is only executed again with `replay: "safe"`; external effects
still need their own idempotence. [P3, P7]

**phi-spaces:** The claim binds principal, Space, generation and request ID as well as method and argument hash.
Different arguments for the same identity yield `RequestConflict`. Effect and result are stored
together; pending operations can continue to be queried. Expired results are reported with
`ResultExpired`, not executed anew. With an uncertain transport result the client must keep the
original identity; a timeout does not prove that nothing happened. [L4]

A transaction lease thereby only guarantees the return of a job that was not completed.
If a worker crashes after an external effect, another worker can later take the job
over again. For the outside world, this pattern too needs an idempotency key or another
explicit completion contract.

## 6. Operations, security and limits

phi-spaces has considerably more **Space-specific** operational logic: HMAC-secured generations,
key challenge, enrollment, grants, role/type checks, router, membership, RunGates,
worker assignments, host changes and recovery journals.
These layers replace neither general operating-system sandboxing nor application authentication.

In particular, `src/standalone.ts` starts with a static identity: whoever reaches the socket can
use the Space under this identity. For outside participants the appropriate gate/auth
composition is therefore necessary; an openly reachable TCP port is not automatically secured by it. [L3, L7]

pi-durable, by contrast, offers tools, extensions and an abstracted execution environment.
A Code Mode sandbox or a tool selection is not the same as the cryptographic identity of a
remote Space participant. Nor does it follow from this juxtaposition that the entire
Pi/Chord ecosystem has no network or security building blocks. [P3, P8]

**Implemented does not mean accepted without restriction:** phi-spaces contains extensive
federation, replication, fencing and recovery building blocks. No blanket
production approval for all topologies and failure models may be derived from that.
The respective acceptances distinguish local tests, real NetBird connections, process kills and
further operating models. The Rust port is likewise a separate, still ongoing step. [L6, L7]

Older sections of `implementierungsstand.en.md` still name JSONL and harnesses; a note at the top of the page puts
them in context. For today's storage dependency, the dependencies in `package.json`, `src/store/`,
`src/standalone.ts` and the later U6 documentation are authoritative.

## 7. What release 1.4.0 changes compared to the earlier version 1.0.3

Between 1.0.3 and 1.4.0 the following functions, among others, were published: [P4]

| Release | Changes relevant to this comparison |
|---|---|
| 1.1.0 | Cloudflare Durable Object SQLite, historical context queries, scan direction, task/tool times and incremental context cache |
| 1.2.0 | Nested tool calls, structured tool results and persistent Code Mode; changes to storage errors; document cache and optimized array appends |
| 1.3.0 | SQLite table prefixes and coordinated database access for several Pi storages in the same Cloudflare Durable Object |
| 1.4.0 | IndexedDB, persistent task sleep states, host wake interface, crash-loop protection, telemetry as well as explicit document checkpoint rules |

Thus, for example, "pi-durable can only do Node SQLite/JSONL" would be wrong today.
The blanket claim that every change must always walk all large arrays completely also
ignores published optimizations. Whether these sufficiently improve the concrete Space load profile
has to be measured.

### What the upgrade of the agent connection required

The upgrade has been carried out; details are in [upgrade-pi-1.4.0.en.md](upgrade-pi-1.4.0.en.md). Two changes were mandatory:

1. Since 1.2.0 the result channel of tools is called **`output`** instead of `content`; 1.4.0 reads `result.output`.
   `agent/src/agent.ts` and the remaining tools have been converted.
2. In 1.4.0 `checkpointWhen` is mandatory. The document family `phi-spaces.agent-generation` writes every
   change as a base (`() => true`).

1.4.0 migrates pi-durable SQLite to schema 2 on opening; according to the changelog, opening with 1.3.0
or older is not possible afterwards. Agent databases must therefore be backed up first; the database of the mobile runtime
was backed up and migrated on 30.10.2026. A way back leads only through the backup.

The phi-spaces store is not affected by this and did not become a pi-durable store again.
Its format 2 is, moreover, completely independent of the pi-durable schema, which is also called "2". [L2, L5, P4]

## 8. Newest Earendil code: additional changes on main

The queried commit `50af8c160153e3721a18b1a046a4adf201635861` is newer than the release.
Its `package.json` still says `1.4.0`, but its changelog contains an extensive
**`Unreleased` section**. The package version number alone is therefore not enough for identification.
The following statements apply exclusively to this development state. [P9–P11]

Up to commit `c7372af4201aaa0c049f63c198e765cb4a2e3013` only two entries were added to the changelog:
`GenerationHooks.beforeProviderRequest` replaces the provider request of a call, and the ranking of `tool_search` and `searchTools()` is corrected.
The code of this newer commit was not read.

### 8.1 The storage architectures partly converge

- **Group commit:** pi-durable, too, releases the mutation line during the storage write and combines
  several commits in one backend call. Read/write dependencies ensure that
  subsequent work does not simply run past still unacknowledged predecessors.
- **New storage contract:** `commit(batches, receive, context)` processes groups, each with its own sequence
  and durability receipt. This is an incompatible change for backends and wrappers that do not come from pi-durable itself.
- **`StoreStorage`:** A new backend places durable records and documents in Chord v2's store.
  Chord objects and durable sessions can share its commit queue and outbox.
  This is **not** the phi-spaces store and establishes no compatibility with its `parts` format.

So "only phi-spaces has group commit" is already wrong as a general statement about the newest
Earendil code. Compared to the published 1.4.0, the difference described in section 5.2
remains.

### 8.2 Visibility and persistence are partly separated

At this `main` state there are **deferred commits** for certain existing conversation documents
with `history: "latest"` and `fork: "initial"`. They may be published in memory before they are
written. A later dependent commit, close or deadline forces storage.

Streaming intermediate states use this by default with
`settings.progress.persistWithinMs = 1000`. In a crash, roughly one second of
displayed intermediate state can thereby be lost; in 1.4.0 it is at most around 100 ms, which however had not yet been
displayed there. Other kinds of write force immediate persistence;
completed results are not simply "only in RAM" across the board.
With `persistWithinMs: 0` the additional waiting period disappears. The commit nevertheless remains a held one:
it is still adopted in memory first and written only afterwards.

**For a fair comparison this is decisive:** "Everything visible has already been stored" fits
the pi-durable release checked here, but not without restriction the newest development state.
phi-spaces continues to acknowledge its Space commits only after the durable write. [P9, P11, L2]

### 8.3 Further changes not yet released

- Watches and observers get new, tagged interfaces; `watchEvents()` is removed.
  Conversation views become bounded transcript windows, complemented by `ConversationTranscript`.
- `HarnessOptions.readOnly`, continue submissions, turn limits and atomic submission admission
  within a commit extend host integration.
- Run-end tasks add work after an answer. New error states make unanswered
  runs visible. At the restart limit, tasks are ended instead of remaining parked as in 1.4.0.
- A model request running during a host failure is no longer re-sent on opening; the attempt counts
  as failed and is subject to `settings.retry`. That does not rule out double computation, but changes
  the behavior of 1.4.0 described in the integration limits.
- Caches, streaming processing and storage retention are optimized.

These changes make pi-durable neither a tuple space nor a finished distributed
Space service. They do, however, put into perspective comparisons that regard pi-durable only as an old, strictly serially storing
agent library. No approval for phi-spaces follows from this yet.

## 9. Classification for this project

### Which system when?

| Need | Suitable starting point |
|---|---|
| An agent should continue model/tool work after process restarts | pi-durable |
| Conversation forks, prompt construction, model context and compaction | pi-durable |
| Independent workers should take over matching jobs exclusively | phi-spaces |
| Shared data, leased reservations, durable template waits | phi-spaces |
| Several persistent agents should cooperate on shared work | Both: agent runtime plus Space service |
| A small agent application only needs some atomically co-stored state | pi-durable documents first; a separate Space service is not automatically necessary |
| A non-agentic service needs a coordinated work depot | phi-spaces without pi-durable |

### What would a replacement cost?

**Replacing pi-durable with phi-spaces:** Model loop, conversation/transcript model, tool task
execution, replay policy, prompt/context management and compaction would additionally have to be implemented
or provided by another agent runtime. Persistent Space entries alone do not deliver that.

**Replacing phi-spaces with pi-durable:** Template matching, competing `take`, leased
transactions, request claims, events/mailbox ACKs, quotas and the required network/operations contracts
would have to be created anew as an application layer. Persistent tasks and documents alone do not deliver that either.

**Practical conclusion:** The current separation makes sense in domain terms.
An upgrade of `agent/` and a reassessment of the Space storage are two different decisions.
Earendil's further development is especially relevant for group commit, the Chord store and storage optimizations;
it does not automatically eliminate the project's specialized coordination requirements.

### Where pi-durable is sensibly used today

The separation is: **pi-durable inside an agent, phi-spaces across agents**.
An agent needs a different state than the application it works for.

| Area | Benefit of pi-durable | What stays in the Space |
|---|---|---|
| Mobile and remote coding sessions | Conversations, model context, coding tools, subagents and resumption of interrupted agent work | Shared assignments, results and their permissions |
| Space tools in `agent/` | Task memos preserve the identity of a tool call across replay | Request claims, effect and first result of the Space operation |
| Research examples | Persistent conversations and tools for collector, analysis and report | Sources, work assignments, completion markers and domain results |

The mobile runtime keeps the session catalog together with the conversations in the agent store.
That avoids an independently written JSON side file. The Space tools, by contrast, use
a separate host; `withAgentEventSink` explicitly bridges the context boundary.
See [agent connection](../agent/src/agent.ts) and
[upgrade including the mobile runtime](upgrade-pi-1.4.0.en.md).

**Important:** An application does not become durably agentic merely by using pi-ai or
pi-codemode. pi-ai supplies model calls; pi-codemode supplies the sandbox.
Only the pi-durable harness takes on durable agent execution.

### Extension in three consecutive steps

#### Step 1: Resume research runs as a whole

The [research examples](../agent/examples/research-support.ts) already have persistent agents,
but reject an existing run directory at the starting point. Individual persistent conversations
are not yet a safe resumption of the entire team.

The integration must therefore record a durable run identity and configuration, the conversations
already created and the phase reached. Start messages and phase assignments need
stable identities, so that a crash between effect and receipt creates no second chain of work.
An explicit resume uses the existing IDs; deviating topics or run types are
rejected. A fresh run must not silently adopt foreign or old directories.

Acceptance: interruption and reopening, no duplicate teams or tasks, renewed output of a
finished report, rejected configuration conflicts and continued errors on incomplete phases.

**Integrated:** [ResearchRun](../agent/examples/research-run.ts) implements explicit `--resume`,
the shared launcher owner lock, atomically stored team IDs and deduplicated phase handoffs.
The [regressions](../agent/test/examples/recovery.test.ts) also check SIGKILL during a running
analysis: the same team assignment before and after resumption, the phase only once, no remaining task, one report. Limits with expired Space claims and CLI examples are in [examples.en.md](examples.en.md).

#### Step 2: Longer agent sequences in Codemode chat

The [model process](../codemode-chat/server/model-host.ts) already has a durable Space queue:
`LlmCall` is taken over under a renewed transaction and completed together with `LlmResult`.
On process failure the assignment becomes available again. The pi-durable connection does not replace this mechanism.

The switchable pi-durable connection enables multi-step work within one assignment:
keeping context, using tools and continuing intermediate steps after a restart.
Assignment identity and result assignment stay in the Space. Simple evaluations, votes and
single text answers do not automatically need a separate durable conversation.

Acceptance: switched-off path unchanged, scripted multi-step agent, stable request key
on repetition, reopening of the agent store and observance of run cancellation and budgets.

**Integrated:** [Durable code contributions](../codemode-chat/server/durable-agent.ts) use a separate
agent process, an isolated `verify_code` check and at most four model attempts.
The existing Space queue is retained; quotas and budget reservations are checked per attempt.
The path is active by default and can be switched off with `CODEMODE_DURABLE_AGENT=0`.
Configuration and limits: [Codemode architecture](codemode-space-architektur.en.md#durable-code-agents).

#### Step 3: Selected model NPCs

The [NPC management](../spaces-mmo/server/npc/minds.ts) already stores role ownership, wake state and
memories in the world Space. For that alone pi-durable would be no improvement.
An optional durable session is worthwhile for selected conversation partners or quest givers
whose multi-step dialogue and model context should survive an NPC process.

The world worker stays authoritative for actions: the agent proposes commands; reach,
collisions, ownership, permissions and transactions continue to be checked by the game world.
Game time and world ticks are not replaced by the wall-clock time of an agent timer.

Acceptance: default activation, explicit switch-off or targeted selection, dialogue after reopening, separation of
NPC sessions and unchanged behavior for all non-selected NPCs.

**Integrated:** [Selected NPC dialogues](../spaces-mmo/server/npc/durable.ts) keep their context in
separate world/role sessions. Budgets and model approval stay in the Space; old world actions are
not replayed automatically. After 64 answers the active context is restarted
with the Space summary. The default is now the durable dialogue for all model roles, without switching on the paid
model approval. `SPACES_MMO_DURABLE_NPCS=0` deactivates it; a role list restricts it.
Configuration, costs and retention: [model NPCs](../spaces-mmo/docs/modell-npcs.en.md#durable-dialogues).

### Limits of the integration

- No return to pi-durable as Space storage and no incorporation into replication, fencing or the Rust core.
- No second leading copy of world, run or assignment state in the agent store.
- No Space transaction held open for hours during human approvals.
- Stable IDs and idempotent handoffs do not replace a joint atomic commit of both stores.
  The promise of stable IDs and idempotent handoffs is demonstrated for process crashes; for power failures there is only the VM evidence on the individual store (section 5.3).
- Resumption is bound to the agent store. Each Codemode model process has its own; if another process
  takes over the `LlmCall` from the queue after a failure, it lacks the conversation, intermediate steps
  and previous consumption. The assignment then starts anew; continuation applies only when the same store is reopened.
- The selected NPCs keep their conversation, but use a random
  `requestId` per model call ([durable.ts](../spaces-mmo/server/npc/durable.ts)). A repetition there is a new dialogue turn,
  unlike the stable identities from steps 1 and 2.
- Model providers and other external services do not automatically guarantee exactly-once:
  a network call repeated after a crash can be executed and billed again.
- Live model calls and deployments are no offline acceptance and need their own approval.

### No inadmissible performance or migration conclusions

The local conversion documents contain measurements of the document model of that time.
They are **not a current, controlled benchmark against pi-durable 1.4.0 or its newest main**.
New is only the small commit measurement from section 5.3; it replaces no benchmark. A reliable test would have to use identical payload,
disk, sync setting, parallelism, claim retention and failure cases.
On `main` the deferred progress persistence would additionally have to be matched.

The storage files are not interchangeable. Today's phi-spaces store rejects foreign SQLite formats
and old pi-durable replication journals. Decision D6 provides for no import of old pi-durable
Space holdings. This is **no call to delete agent stores or existing data**;
nothing was deleted or migrated in this research. [L2, L6]

### Check run

Offline state of 31.10.2026 (mobile runtime of 30.10.2026):

| Check | Result |
|---|---|
| Core | 606 passed, 1 skipped, import boundaries without pi-durable passed |
| Agent package | 108 of 108 passed |
| Codemode chat | 127 of 127 passed; with the agent path on (`test:durable`) 127 of 127, no deviation |
| spaces-mmo | 177 of 177 passed; with the agent paths on (`test:durable`) 177 of 177, no deviation; under load tests failed sporadically on timeouts, on both paths and without a model |
| Help site | 59 passed, 1 skipped |
| Mobile runtime | 22 of 22 passed, spaces-mobile 6 of 6 |

`test-env.ts` of both projects switches off the agent paths for the general suites. `npm run test:durable` of each project runs the same `tests/*.test.ts`
with the path on, always with faux models ([codemode](../codemode-chat/tests/test-env-durable.ts), [spaces-mmo](../spaces-mmo/tests/test-env-durable.ts)):
the project's own fake answers inside the agent worker ([durable-fake-models.ts](../agent/test/durable-fake-models.ts)), so its scenarios pass through the real worker, conversation
and storage. Fake teams reach the Space and its gates over a connection of the worker, usage passes through exactly, and a stop reaches them as the worker's abort signal.

| Matrix | Tests | Answers through the worker | Deviations |
|---|---|---|---|
| Codemode chat | 127 of 127 passed | 66 | none |
| spaces-mmo | 177 of 177 passed | 8 | none |

The deviation lists ([codemode](../codemode-chat/tests/durable-deviations.ts), [spaces-mmo](../spaces-mmo/tests/durable-deviations.ts)) are empty: no test had to be skipped or changed.
The run ends with an error if no answer passed through a worker. What the matrix does not cover by its nature:

- Codemode: only `contribute` calls on code tasks take the path. Text tasks, critiques, votes and judges run as in the general suites, even with the matrix on.
- The bridged fake answers at once, without a `verify_code` round. The sandbox tool between two answers is covered by [durable.test.ts](../codemode-chat/tests/durable.test.ts) and [durable-interrupt.test.ts](../codemode-chat/tests/durable-interrupt.test.ts).
- spaces-mmo: most tests have no model. Only 8 answers ran through the worker, all in tests naming `tests/fake-llm.ts`; the rest of the 177 prove only that the switch breaks nothing.

Failures after the last model answer are now checked as well ([durable-interrupt.test.ts](../codemode-chat/tests/durable-interrupt.test.ts)): the model process by SIGKILL between the answer and the commit of `LlmResult`,
and the agent worker by SIGKILL between the conversation's last answer and the job's stored answer. In both cases the answer arrives once, no model is asked again and no attempt is admitted again.
Besides these, the scenarios from before hold: a whole run across all processes, two contributions at once, kills between two model answers, restart after a finished result; for the [NPC](../spaces-mmo/tests/durable-npcs.test.ts) closing, reopening and SIGKILL after a dialogue.

The matrix found a bug, now fixed: a provider's failure reached the caller only as `Agent submission unanswered`, because the worker recorded only exceptions and a provider reports its failure as a message. The caller now gets the provider's words.
The worker test found a bug, now fixed: after the worker's death every further contribution failed until the model process restarted.
The assignment that the dead worker was processing still ends with an error result; only a new assignment with the same `callId` continues.

Admission is enforced at the actual provider call: exceptions in a pi-durable hook alone are
not sufficient for that. This is secured with counted actual faux provider calls.

On the phone 1.4.0 has started: the agent database is migrated to schema 2, its integrity check passed.
The user interface was not checked there. The check runs contained no live model calls.
None of this is an unrestricted production approval.

## 10. Sources and verifiability

### Official Earendil sources

- **P1:** [npm registry of pi-durable](https://registry.npmjs.org/@earendil-works%2Fpi-durable): `dist-tags.latest`, publication time and package metadata; queried on 30.10.2026.
- **P2:** [Published npm archive 1.4.0](https://registry.npmjs.org/@earendil-works/pi-durable/-/pi-durable-1.4.0.tgz): README, changelog, JavaScript and type definitions; SHA-512 checked against the registry.
- **P3:** [Release README, pinned to the release commit](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/README.md): concepts, replay, storage, tools and documents.
- **P4:** [Release changelog](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/CHANGELOG.md): changes and breaking changes up to 1.4.0.
- **P5:** [Release document definitions](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/documents.ts) and [SQLite schema](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/storage/sqlite/schema.ts).
- **P6:** [Release session](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/session/session.ts): commit serialization.
- **P7:** [Release submission admission](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/harness/submissions.ts): request ID reuse.
- **P8:** [Pi monorepo README at the checked development state](https://github.com/earendil-works/pi/blob/50af8c160153e3721a18b1a046a4adf201635861/README.md): delimitation of the packages and the overall project.
- **P9:** [Unreleased changelog at the checked main commit](https://github.com/earendil-works/pi/blob/50af8c160153e3721a18b1a046a4adf201635861/packages/durable/CHANGELOG.md): changes expressly not yet released.
- **P10:** [StoreStorage at the checked main commit](https://github.com/earendil-works/pi/blob/50af8c160153e3721a18b1a046a4adf201635861/packages/durable/src/storage/store/storage.ts): Chord v2 store connection.
- **P11:** [Session at the checked main commit](https://github.com/earendil-works/pi/blob/50af8c160153e3721a18b1a046a4adf201635861/packages/durable/src/session/session.ts): group commit and deferred commits.

### Local phi-spaces sources

- **L1:** [Core semantics](../src/core.ts), [Space document and parts](../src/doc.ts), [public API](api.en.md).
- **L2:** [Host](../src/store/host.ts), [store types](../src/store/types.ts), [document definitions](../src/store/documents.ts), [SQLite](../src/store/sqlite.ts), [writer thread](../src/store/sqlite-writer.ts), [DiskMap](../src/store/disk-map.ts).
- **L3:** [Standalone service](../src/standalone.ts), [service](../src/service.ts), [remote client](../src/remote.ts), [pi-server adapter](../src/pi-server.ts), [standalone regressions](../test/test-standalone.test.ts).
- **L4:** [Claims](../src/claims.ts), [local client](../src/client.ts), [mailbox](../src/mailbox.ts), [changes](../src/stream.ts).
- **L5:** [Agent connection](../agent/src/agent.ts), [agent package](../agent/package.json), [agent lockfile](../agent/package-lock.json), [integration regressions](../agent/test/agent.test.ts).
- **L6:** [Conversion including later U2/U6/U4 states](umstellung-ohne-pi-durable.en.md), [inventory and decision D6](umstellung-u0-bestand.en.md), [Rust port plan](rust-portierung.en.md).
- **L7:** [Federation runtime](../src/runtime.ts), [gate](../src/gate.ts), [auth](../src/auth.ts), [replication control](../src/replica-control.ts), [federation plan](federation-plan-v3.en.md), [phase acceptances](implementierungsstand.en.md).

**Limit of the evidence:** The original upstream research was source-based; the local
1.0.3 holdings of that time were no compatibility evidence for 1.4.0. Subsequently the release packages were updated to 1.4.0
and the local integrations described here were checked offline (section 9).
That replaces neither Earendil's complete test matrix nor live quality, performance or migration checks.
The newer `main` was still not installed or executed.
