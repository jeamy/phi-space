# Detailed Architecture, Documentation and Implementation Plan: `PHI-SPACES / HELP` & Multiplayer Space Chat

As of: 2026-10-15
Note: this is the original plan; §2.3 (phase 3), §3, the stage 3 to 5 snippets of §4, §6.2 and §7 were checked against the code in October 2026. What still differs: the frontend is built with Next.js (`app/`) and is one component, `HelpApp` in `client/App.tsx`, which draws the views itself (`client/components/` holds only the live and admin views, the app introductions and the model pickers); the stage runners `examples/v3`, `v4` and `v5` use a smaller API surface than §4 first planned (see there: v5 composes `RouterController` and `FederatedSpace` directly, without `createFederationController`, `takeWaiting` or `RunController`); the corpus has 26 topics, 7 workflows and 14 API articles instead of the 18/7/16 of the original plan; the site gained apps beyond the plan (Social Swarm feed, codemode chat, spaces-mmo and space stats introductions); the default server port is 3500. The server routes of §6.1, §6.3, §8 and the work packages in §9 are the original plan and were not re-checked.
Target directory: `/media/data/programming/phi-spaces/help-site/`
Public target domain: `https://spaces.eibrain.org`
Mobile integration: `pi-termux-mobile` (`/media/data/programming/pi-termux-mobile`, `spaces.html` & `steuerung.html`)
Technical template for the practical example: [Pi Durable on Cloudflare](https://earendil.com/posts/pi-durable-on-cloudflare/) – **completely rethought and implemented with native `phi-spaces` means (in 6 stages `v1` to `v6`)**

---

## 1. Goal and Basic Principle

The goal of this project is a **Next.js and React based web server (`help-site/`)** that fulfils two closely interlocked tasks:

1. **Canonical high-end help system (`PHI-SPACES / HELP`)**:
   - Answers precisely, bound to source code and contracts:
     - **What is `phi-spaces`?** (idea, tuple-space paradigm, delimitation, fields of use)
     - **How is `phi-spaces` built?** (layered architecture from `src/core.ts` via `SpaceService`/`RemoteSpace` and the NetBird gate up to `FederatedSpace`, replication and the operations extension)
     - **What can `phi-spaces` do?** (atomic commits, leases, transactions, claims, mailboxes, CompletionProfiles, binding guarantees vs. explicit limits)
     - **What is the API?** (interactive API & tool finder and a complete reference for `PhiSpaces`, `RemoteSpace`, `SpaceService`, agent tools, `FederationController`, `RunController` and error classes)
     - **How do you build a system with `phi-spaces` step by step?** (from a single Space to the distributed multiplayer system)
2. **Complete implementation and documentation of a `phi-spaces` reference project: "Multiplayer Space Chat"**:
   - The scenario shown in the blog post *Pi Durable on Cloudflare* (shareable session URLs, multiple conversations & forking, idempotent commands on connection loss, multiplayer messages with inbox ordering, live streaming & participant presence, scheduled tasks/alarms, and a subagent for conversation search) is **not** rebuilt with raw Cloudflare Durable Object or internal `pi-durable` session primitives, but **entirely with the means of `phi-spaces`** (`NamedSpace`, `EntryDraft`/`Template`, `RequestRef` claims, `Lease`/`renew`, `Txn` + `CompletionProfile`, `readPage` + `changes`, `notify`/`wait` + consumer mailboxes).

---

## 2. Analysis of the Existing `phi-spaces` Documentation (`docs/`)

The evaluation of all documents in `/media/data/programming/phi-spaces/docs/` yields the following overall picture, which flows into the help corpus as the **single source of truth**:

### 2.1 What is `phi-spaces`?

- `phi-spaces` is a transactional, persistent coordination space (inspired by Linda / JavaSpaces), implemented in TypeScript (ESM) with its own store (SQLite, `src/store/`), without pi-durable (decision D6, `docs/umstellung-u0-bestand.en.md`; `docs/umstellung-ohne-pi-durable.en.md`); the optional `agent/` package connects pi-durable agents.
- **Basic principle**: participants (clients, worker loops, AI agents, coordinators) do not call each other directly but coordinate through typed JSON objects (**entries** `{ type, types?, fields }`) in logical spaces (**Spaces**).
- **Decoupling in space and time**:
  - A producer writes (`write`) a task, message or observation with an expiry time (**lease**).
  - A consumer reads (`read`) or exclusively removes (`take`) matching entries by means of a **template** (`{ type?, fields?, id? }`, where missing or `null` fields act as wildcards).
  - If no matching entry exists yet, the caller either waits in a blocking way (`read`/`take` with `timeout`) or registers a durable, non-blocking job (`wait` / `notify`) that also survives process restarts.

### 2.2 How is `phi-spaces` built? (The 6 architecture layers)

| Layer | Source modules | Tasks and mechanisms |
|---|---|---|
| **1. Pure core & document model** | `src/core.ts`, `src/doc.ts`, `src/spaces.ts`, `src/canonical.ts` | Deterministic state machine with explicit `now`. Document version 5: default Space (`phi-spaces.space`), named Spaces (`phi-spaces.named-space`) and registry (`phi-spaces.registry`, alias $\rightarrow$ immutable `spaceId`). Every entry has a global ID `gid = <spaceId>/<localId>` (`localId` = incarnation + monotonic counter). |
| **2. Claims, streams, pages & mailboxes** | `src/claims.ts`, `src/stream.ts`, `src/snapshot.ts`, `src/paging.ts`, `src/mailbox.ts` | **One commit, one truth:** Space mutation, request claim (`{ principal, generation, requestId }` + RFC 8785 argument hash), revision number (`rev`), mailbox event and byte-budget reservation happen in the same atomic commit. `readPage` delivers consistent, byte-bounded snapshot pages (`token`, `rev`, `streamId`); `changes(afterRev)` delivers commit batches; mailboxes (`events`/`ack`) secure event delivery with prefix ACK and `mailboxEpoch`. |
| **3. Local client, agent tools & service** | `src/client.ts`, `src/index.ts`, `src/service.ts`, `src/remote.ts`, `src/socket.ts`, `src/pi-server.ts`, `src/meter.ts` | `PhiSpaces` (local API) and `RemoteSpace` (network client) implement the same base contract `SpaceLike`. `src/index.ts` provides 8 replay-safe LLM tools (`space_write`, `space_read`, `space_take`, `space_list`, `space_txn`, `space_wait`, `space_notify`, `space_lease`) as well as the reaper & event delivery (`startService`). `SpaceService` serves requests over in-process, Unix socket (`0600`), TCP or `pi-serverd` transport. |
| **4. Overlay gate, auth, grants & recovery (phase 1b)** | `src/gate.ts`, `src/auth.ts`, `src/enroll.ts`, `src/grants.ts`, `src/rotation.ts`, `src/supervisor.ts`, `src/runtime.ts`, `src/boot.ts`, `src/restore.ts`, `src/recovery-*.ts` | **Layer A:** NetBird WireGuard peer identity and groups (`space-hosts`, `space-admin`, `space-observer`). **Layer B:** connection-bound Ed25519/P-256 challenge (30 s). Token/QR enrollment in the control Space, 60-s short-lived grants (`effect` vs. `resolution`), key rotation, external CAS boot register and journaled control/data restore (`restoredUnverified` quarantine until `releaseRestored`). |
| **5. Federation, router & membership (phase 2)** | `src/router.ts`, `src/delegation.ts`, `src/federation-policy.ts`, `src/federated-space.ts`, `src/membership.ts`, `src/capability-directory.ts`, `src/data-admin.ts` | `RouterController` with command state machine (`accepted` $\rightarrow$ `applying` $\rightarrow$ `completed`/`failed`/`needsReview`) and 1–1024 journal partitions. Signed `RouterLease` & original-principal delegation. `FederationPolicy` (`local`, `expand` by type, HRW over a field value, capacity/capability). `FederatedSpace` including the journaled waiter race in `takeWaiting`. Membership (`addMember`, `drain`, `freezeForRemoval`, `EmptyProof`, `removeMember`) and `DistributedPrincipalErasure`. |
| **6. Operations extension (phase 2b) & replication (phase 3)** | `src/run-controller.ts`, `src/run-member.ts`, `src/workers.ts`, `src/space-lifecycle.ts`, `src/deployment.ts`, `src/dashboard.ts`, `src/entry-replication.ts`, `src/primary-sync.ts`, `src/replica-control.ts` | `RunGate` in the core (tasks can only be taken while `running`), `RunController`, signed `WorkerAssignments` + `WorkerSupervisor`, declarative deployment (`npm run bootstrap`), read-only HTTP+SSE dashboard (`src/dashboard.ts`) and TUI (`test/tui/`). Phase 3 building blocks: HLC/LWW/add-wins replication, paged snapshot/stream transfer, primary-sync foundation and Netcup mTLS fencing. |

### 2.3 What can `phi-spaces` do? (Binding guarantees vs. limits)

According to `docs/implementierungsstand.en.md` and `docs/federation-plan-v3.en.md`, the help system must strictly distinguish between **proven guarantees** and **deliberate limits**:

- **Guarantees**:
  - **Atomic commit**: Space mutation, claim result, revision and mailbox event are written indivisibly.
  - **Idempotent retries across restarts**: the same `{ principal, generation, requestId }` with an identical argument hash returns exactly the same result within the retention period without a second mutation; differing arguments throw `RequestConflict`.
  - **Exclusive work assignment (`take` under `txn`)**: at most one active reservation per entry; on `abort` or expiry of the transaction lease the entry returns to the Space automatically.
  - **Server-side result check (`CompletionProfile`)**: a take-transaction commit is rejected with `CompletionViolation` if the required result entries (type, correlating fields, minimum/maximum count) were not written in the same transaction.
  - **Fixed resource and byte budgets (`DEFAULT_LIMITS`)**: 64 KiB per entry, 192 KiB commit batch, 256 KiB frame, 128 MiB total document, 64 MiB entries, 32 MiB claims, 8 MiB outbox/mailbox; reservation for commit *and* abort before every transaction extension.
- **Explicit limits**:
  - No global FIFO guarantee across entries.
  - No general exactly-once for external side effects (HTTP calls, e-mails, model costs) without an own idempotency ID at the target system.
  - `OutcomeUnknown` on a client timeout does *not* mean the operation failed – the client must ask again with the same `requestId` via `pollOperation`.
  - Phases 1, 1b, 2 and 2b are implemented. Phase 3 (replication / promotion) has implementations and documented tests, but its acceptance is not complete (open gates in `docs/_attic/abnahme/ap3-abnahme.en.md`), so the help system must not present it as a production guarantee.

---

## 3. Design and UX Architecture of `PHI-SPACES / HELP`

The design and structural architecture defines the standard for `PHI-SPACES / HELP`:

### 3.1 Visual system, typography and 14 color palettes

- **Typography**:
  - Body text & headings: `--font-geist-sans` (`"Geist"` with a system UI fallback; no font files are bundled), the home headline with tight tracking (`letter-spacing: -0.065em`).
  - Technical identifiers, IDs, badges, numbers, eyebrows and code: `--font-geist-mono` (`"Geist Mono"` with a monospace fallback).
- **Theme engine (`Dark` / `Light` + 14 palettes)**:
  - Persistence in `localStorage` (`phi-spaces-help-locale`, `phi-spaces-help-mode`, `phi-spaces-help-palette`); the language can also come from `?lang=`.
  - `applyThemeToDocument` (`client/lib/palettes.ts`) sets `data-mode="dark|light"` and `data-palette="..."` on `<html>` and writes the palette colors as CSS custom properties on the root element (`--color-a/b/c`, `--editable-input`, label and icon greys); `client/styles/layout.css` derives the surfaces from them.
    - All 14 palettes: `spaces_default` (dark: `#AED83C` / `#152B35` / `#5C8EA0`; light uses `#82A8BA` for the second color), `ocean_pulse`, `amber_signal`, `raspberry_velvet`, `duo_neon`, `infrared_blueprint`, `jade_clay`, `violet_cream`, `pearl_graphite`, `cobalt_saffron`, `classic_amber`, `jade_mono`, `cyan_mono`, `violet_mono`.
    - `--accent-ink` on primary buttons and active badges is `#101010` or `#FFFFFF`, whichever has the higher WCAG contrast against the palette's accent color; `jade_mono` and `classic_amber` always use white.

### 3.2 App shell and 3-column workspace

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ☰  PHI-SPACES / HELP   [ ⌕ Systems, API methods, entry types, stages v1–v6, errors … Ctrl K ]  │
│    [◉ Space Chat] [● Multiplayer Chat (v1–v6)] [⚙ ADMINSPACES]   [DE|EN] [☾|☀] [palette]      │
├─────────────────────────┬──────────────────────────────────────────────┬─────────────────────┤
│ SIDEBAR (280px)         │ MAIN AREA (.content-scroll, up to 1160px)    │ TOC (250px)         │
│ NAVIGATION              │                                              │ ON THIS PAGE        │
│ • Help Overview         │ - home (hero, execution model, area cards,   │ • (headings of the  │
│ • All Content           │   corpus metrics)                            │   article)          │
│ • API & Tool Finder     │ - area (one system area + article cards)     │ ─────────────────── │
│ • Space Chat Feed       │ - browse / search (full text over areas and  │ Help ≠ Live State   │
│ • Codemode chat         │   articles)                                  │ Stable contracts    │
│ • Multiplayer Space-    │ - api-finder (facets over API & tools)       │ here, live data in  │
│   Chat (v1–v6)          │ - article (Markdown, related, provenance)    │ the Chat Inspector  │
│ • spaces-mmo            │ - space-chat / feed (live views + system bar)│ and AdminSpaces.    │
│ • Space stats           │ - intro (short page before each app)         │                     │
│ • AdminSpaces Control   │ - admin (AdminSpaces, login)                 │ (only on articles   │
│ 9 CANONICAL SYSTEMS     │                                              │  with a table of    │
│ 01 … 09                 │                                              │  contents)          │
│ ● spaces.eibrain.org ·  │                                              │                     │
│   corpus hash           │                                              │                     │
└─────────────────────────┴──────────────────────────────────────────────┴─────────────────────┘
```

On narrow screens the sidebar becomes a drawer (`☰`, swipe to close) that also holds the palette picker, and the right column collapses into an "On this page" disclosure inside the article. Without a table of contents the layout has two columns.

### 3.3 The 9 canonical system areas (`corpus/help_product_catalog.json`)

All knowledge about `phi-spaces` is organized into **9 canonical system areas** (`areas` in the catalog; the ninth has `kind: "reference"`, the others `"system"`). The catalog gives each area its articles by ID; the full list of articles is §7:

1. **`01` – Spaces System Map (`spaces_system_map`)**
   - Technical system map for tuple spaces, the 6 architecture layers, the data and consistency model, and binding guarantees and boundaries.
   - Articles: `help.topic.overview`, `help.topic.apps`, `help.topic.architecture_layers`, `help.topic.guarantees_and_boundaries`, `help.topic.comparison_earendil_vs_phi_spaces`, `help.topic.async_interaction`, `help.topic.topology_and_readiness`.
2. **`02` – Core, Entries & Transactions (`core_entries_transactions`)**
   - Pure state machine, document version 5, global IDs (gid), subtypes, wildcard templates, leases, transactions, CompletionProfiles, and byte budgets.
   - Articles: `help.topic.entries_and_templates`, `help.topic.leases_and_transactions`, `help.topic.completion_profiles_and_limits`, `help.topic.task_lifecycle`.
3. **`03` – Claims, Streams & Mailboxes (`claims_streams_mailboxes`)**
   - Idempotent request claims (RequestRef + generation), RFC-8785 argument hashes, byte-bounded snapshot pages (readPage), revision streams (changes), and consumer mailboxes (events/ack).
   - Articles: `help.topic.request_claims_and_generations`, `help.topic.snapshots_and_change_streams`, `help.topic.durable_mailboxes_and_ack`, `help.topic.live_sync_recipe`.
4. **`04` – Local Client & Agent Tools (`client_and_agent_tools`)**
   - Local client PhiSpaces, named spaces (NamedSpace/Registry), reaper and event delivery (startService), plus the 8 replay-safe LLM agent tools.
   - Articles: `help.topic.local_client_and_named_spaces`, `help.topic.agent_tools_and_replay`, `help.topic.first_running_space`, `help.topic.examples`.
5. **`05` – SpaceService, RemoteSpace & Transports (`service_remote_transport`)**
   - Transport-independent SpaceService, role policy, RemoteSpace over Unix socket, TCP, and pi-serverd, plus safe resolution of OutcomeUnknown.
   - Articles: `help.topic.space_service_and_remote_space`, `help.topic.failure_playbook`.
6. **`06` – Overlay Gate, Authentication & Recovery (`gate_auth_recovery`)**
   - Two-layer security (Layer A NetBird peer, Layer B Ed25519/P-256 challenge), token/QR enrollment, 60s grants, key rotation, boot guard, and restore.
   - Articles: `help.topic.gate_auth_grants_and_recovery`, `help.topic.safe_operations`.
7. **`07` – Federation, Router & Membership (`federation_router_membership`)**
   - RouterController with journal partitions, signed RouterLease and delegation, FederationPolicy (HRW/expand), FederatedSpace, waiter race, membership, and principal erasure.
   - Articles: `help.topic.federation_router_and_membership`.
8. **`08` – Operations, Mobile/Web Admin & Replication (`operations_runs_replication`)**
   - RunGate & RunController, WorkerSupervisor, space lifecycle, control via mobile app (pi-termux-mobile) & web admin (AdminSpaces), plus Phase 3 replication.
   - Articles: `help.topic.operations_mobile_and_replication`, `help.topic.social_swarm_pipeline`.
9. **`09` – Step-by-Step (v1–v6) & API Index (`step_by_step_and_api_reference`)**
   - Hands-on guide from a local zero-setup space (v1) to a federated cluster with mobile/web admin (v6) using the Multiplayer Space-Chat, plus the faceted API & Tool Finder.
   - Articles: `help.workflow.overview_v1_to_v6`, `help.workflow.stage_v1_local_memory`, `help.workflow.stage_v2_local_durable`, `help.workflow.stage_v3_remote_socket`, `help.workflow.stage_v4_gated_auth`, `help.workflow.stage_v5_federated_cluster`, `help.workflow.stage_v6_mobile_control`.

### 3.4 Canonical article structure and style rules

Every topic article in `corpus/{de,en}/topics/<topic>.md` follows the standardized structure with explicit, language-independent `{#anchor}` IDs:

```markdown
---
standard: help_topic
id: help.topic.<topic>
title: "<Lokalisierter Titel>"
short: "<Präzise Kurzbeschreibung, max. 240 Zeichen>"
tags: [<sprachunabhängige Suchbegriffe>]
owner: <core|client|tools|remote|security|federation|ops|workflow>
related: [help.topic.*, help.api.*, help.workflow.*]
since: 0.0.1
---

# <Lokalisierter Titel>

## Überblick {#overview}
## Begriffs- und Systemmodell {#concept-model}
## Begriffe und Identitäten {#terms-and-identities}
## Arbeitsablauf {#workflow}
## Regeln, Garantien und Grenzen {#rules-and-boundaries}
## Beispiele {#examples}
## Fehler und Diagnose {#failures-and-diagnostics}
## Technische Referenz {#technical-reference}
## Provenienz und Nachweise {#provenance-and-evidence}
## Siehe auch {#see-also}
```

### 3.5 Interactive API & tool finder

Under the `API & Tools` area, the help system offers a faceted technical finder over all public exports from `src/index.ts` and `docs/api.en.md`:

- **Mode tabs**: `API & Tools` (all API and agent-tool articles, with their count) vs. `Architecture Packages` (the module packages of the index: `core`, `client`, `service`, `remote`, `gate/auth`, `federation`, `ops`).
- **Provider filter chips**: `ALL`, `_CORE`, `_CLIENT`, `_TOOLS`, `_REMOTE`, `_SECURITY`, `_FEDERATION`, `_OPS`, plus a free-text query.
- **4 facet dropdowns** (values from the `api` front matter of the articles):
  1. `Category`: `Mutation`, `Query / Snapshot`, `Transaction / Lease`, `Wait / Mailbox`, `Security / Grant`, `Federation / Routing`, `Operations / RunGate`.
  2. `Execution`: `Atomic Commit`, `Blocking Wait`, `Non-Blocking Event`, `Snapshot / Stream`, `Replay-Safe Tool`, `RPC Retry`, `Crypto Challenge`, `Journaled Command`, `ACK Barrier`.
  3. `Idempotency`: `RequestRef Claim`, `Task Claim (replay: safe)`, `Read-Only Snapshot`, `CAS / Epoch-Bound`.
  4. `Scope`: `Single or RemoteSpace`, `Single Space`, `Conversation-Owned`, `Unix Socket / TCP`, `Control & Data Host`, `Multi-Member Cluster`, `Coordinator Control`.

---

## 4. The 6-Stage Evolution Model ("From the Simplest to the Most Complex incl. Mobile Control": `v1` to `v6`)

So that beginners can start locally right away without hurdles and advanced users can extend the same use case step by step to the fully developed, cryptographically secured multi-member federation **including control and monitoring through the mobile app (`pi-termux-mobile`)**, the multiplayer Space-chat example is implemented and documented in **6 successive, individually executable versions (`v1` to `v6`)**.

Because `PhiSpaces` and `RemoteSpace` fulfil the same base contract `SpaceLike` and `FederatedSpace` provides the distributed counterpart, the **domain chat data model (`Thread`, `Msg`, `ChatTask`, `Presence`, `ScheduledJob`, `SearchTask`) stays identical across all 6 versions** – only the underlying `phi-spaces` infrastructure and operations layer change from stage to stage!

### Overview of the 6 stages

| Version | Directory / mode | Infrastructure & storage | New `phi-spaces` means | Goal & purpose |
|---|---|---|---|---|
| **`v1`** | `examples/v1-local-memory/` | 1 process, `openOwnMemoryHost()` (store in memory), no setup | `PhiSpaces`, `NamedSpace`, `write`/`read`/`take`, `Lease` (`renew`), `Txn` (`createTransaction`/`commit`/`abort`), `CompletionProfile`, `startService` | **Instant start for demos & quick tests**: runs anywhere in < 1 second without files, ports or keys. Shows threads, forking, multiplayer presence and transactional workers. |
| **`v2`** | `examples/v2-local-durable/` | 1 process, persistent phi-spaces store (`openSqliteHost`, SQLite) | `issueGeneration` + `RequestRef` claims (reconnect idempotency), `readPage` snapshots (`rev`), `changes(afterRev)` stream, `TimerLock` leases for `schedule` alarms, `SearchTask`/`SubagentStep`/`SearchResult` | **Local durability & crash recovery**: survives `SIGKILL` and server restarts without data loss or double execution; introduces alarms and the `search_history` subagent. |
| **`v3`** | `examples/v3-remote-socket/` | Separate client/worker connections over Unix socket (`0600`) or TCP (`127.0.0.1`) | `SpaceService`, `serveSpace`, `RemoteSpace`, `socketTransport`, `StaticIdentity`/`GateIdentity`, role `Policy`, consumer mailboxes (`events` + prefix `ack`), `pollOperation` on `OutcomeUnknown` | **Real network decoupling (`RemoteSpace`)**: web gateway, chat worker and search subagent no longer access the harness directly but communicate as remote clients over socket/TCP and mailboxes. |
| **`v4`** | `examples/v4-gated-auth/` | Several processes/hosts behind `startGate` + `CONTROL_SPACE` + `SqliteRecoveryRegister` | **Layer A** (`PeerDirectory`/NetBird roles), **layer B** (`ProvingService` Ed25519/P-256 challenge), token enrollment (`createEnroll`/`bootstrapEnroll`), 60-s grants (`GrantAuthority`/`GrantVerifier`), `rotateKey`, `installBootGuard` | **Zero trust & multi-host security**: every remote worker proves its private key at connection setup, fetches short-lived 60-s grants before mutations and checks boot permissions. |
| **`v5`** | `examples/v5-federated-cluster/` | Coordinator host (`RouterController` + `FederatedSpace`) + 3 member Spaces, simulated in one process | `RouterController` (journal partitions), `FederationPolicy` (`expand` + HRW by `threadId`), `FederatedSpace` (`write`, `readAll`; `takeWaiting` as API), `EntryReplicationController` (LWW presence, phase 3 preview) | **Federated scaling (cluster)**: horizontal distribution of the chat threads by HRW over several member Spaces and cluster-wide reads for the subagent search. |
| **`v6`** | `examples/v6-mobile-control/` | Cluster + `pi-termux-mobile` (`spaces.html` & `steuerung.html`) + web gateway (`spaces.eibrain.org`) | `MobileSpaces` bridge, Android Keystore pairing via QR (`enrollQr`), admin commands (`startRun`/`pauseRun`/`resumeRun`/`stopRun`/`scheduleRun`, `setWorkers`/`listWorkers`, `createSpace`/`archiveSpace`, `listAlerts`, `auditLog`), `WorkerSupervisor` & `RunController` | **Mobile control & monitoring (production ops)**: complete monitoring and administration of the multiplayer Space-chat cluster from the smartphone (`pi-termux-mobile`) and via `https://spaces.eibrain.org`. |

---

### Detailed step-by-step guide from `v1` to `v5` in the help system

For each of the 5 stages, the help system contains a complete, self-contained chapter with architecture diagram, full code, start command and interactive live view:

#### Stage 1 (`v1-local-memory`): The simplest local Space chat (zero setup)

1. **Open the harness & a named Space in memory**:
   - `const host = openOwnMemoryHost()`
   - `await host.commit(async (tx) => { await createSpace(tx, "chat-v1", Date.now()); }, ctx)`
   - `const space = new PhiSpaces(host, ctx, Date.now, meter, undefined, { space: "chat-v1" })`
   - `const stopService = await startService(host, ctx)`
2. **Register the `CompletionProfile`**:
   - `await space.setCompletionProfiles([{ taskType: "ChatTask", resultType: "Msg", matchFields: ["taskId", "threadId"], minResults: 1, maxResults: 1 }])`
3. **Multiplayer participants & presence via leases**:
   - `const presenceLease = await space.write({ type: "Presence", fields: { participantId: "alice", username: "Alice", activeThreadId: "main", status: "online" } }, null, 30_000)`
   - Heartbeat every 10 seconds: `await space.renew(presenceLease.id, 30_000)`
4. **Send a message & answer it transactionally**:
   - The user writes `Msg` + `ChatTask`.
   - The worker starts `const txn = await space.createTransaction(30_000)`, takes `const task = await space.take({ type: "ChatTask" }, 5_000, { txn: txn.id })`, writes the answer `Msg` under `txn.id` and calls `await space.commit(txn.id)`.
5. **Execution**:
   - `node --experimental-strip-types help-site/examples/v1-local-memory/run.ts` (runs through immediately without arguments and shows the complete flow in the terminal or in the browser).

#### Stage 2 (`v2-local-durable`): Persistence (SQLite), idempotency (`RequestRef`), alarms & subagent

1. **Switch from `openOwnMemoryHost()` to `openSqliteHost(dbPath)`**:
   - Exchange of a single line when opening the host: all entries, leases, transactions and claims now survive process restarts.
2. **Reconnect safety with `issueGeneration` & `RequestRef`**:
   - Before the first command, the session opens a generation for each participant: `const { generation } = await space.issueGeneration(principal)`.
   - When creating a thread (`thread.create`), forking (`thread.fork`) and sending a message (`message.submit`), `{ request: { principal, generation, requestId } }` is passed along.
   - If the same message is sent again after a WebSocket interruption, `space.write` returns the stored result thanks to `src/claims.ts` – no duplicate thread and no duplicate message is created.
3. **Live UI synchronization via `readPage` and `changes(afterRev)`**:
   - On connect, the server reads `const snapshot = await space.readPage(null)` and remembers `snapshot.rev`.
   - On every change it calls `const delta = await space.changes(lastRev)` and streams the new commit batches over WebSocket to the connected browsers.
4. **Scheduled tasks (`schedule`) with `ScheduledJob` and `TimerLock` lease**:
   - The `schedule` tool writes `ScheduledJob` (`FOREVER`) and `TimerLock` (`lease = delayMs`).
   - As soon as `TimerLock` expires (removed by `startService` / reaper), `SpaceChatEngine.tickAlarms()` (`examples/shared/chat-core.ts`) detects that a `ScheduledJob` with `status: "pending"` exists without an active `TimerLock` and creates the wakeup `ChatTask` exactly once in a Space transaction.
5. **Cross-conversation search (`search_history`) with subagent worker**:
   - Second `CompletionProfile`: `SearchTask` $\rightarrow$ `SearchResult`.
   - The subagent worker takes `SearchTask` under a transaction, searches all threads with `readAll({ type: "Msg" })`, writes `SubagentStep` entries for sidebar transparency and commits `SearchResult`.

#### Stage 3 (`v3-remote-socket`): Decoupled processes with `SpaceService` and `RemoteSpace`

1. **Space host as its own server endpoint (`serveSpace`)**:
   - The host starts `const service = new SpaceService({ host, ctx, identity: new GateIdentity(), policy: DEFAULT_POLICY })` and listens via `serveSpace(service, { listen: { path: socketPath }, connection: () => ({ peerId, credentials: { roles: ["admin", "member"] } }) })`. The demo uses a Unix socket; `StaticIdentity` and a TCP target are the alternatives.
2. **Web gateway, chat worker and search subagent as `RemoteSpace` clients**:
   - Each service connects via `new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" })`.
   - The application code for `write`, `take`, `readAll`, `createTransaction`, `commit` and `renew` stays **unchanged**, because `RemoteSpace` also implements `SpaceLike`!
3. **Event-driven delivery via consumer mailboxes (`notify`, `events`, `ack`)**:
   - The worker registers a durable subscription: `await workerRemote.notify({ type: "Msg" }, { target: "self", lease: FOREVER, handback })`. `RemoteSpace.wait(template, { take: true, target: "self", timeout, txnLeaseMs })` parks a take the same way, but the demo does not use it.
   - It reads its mailbox via `const page = await workerRemote.events({ waitMs: 50 })` and confirms receipt with `await workerRemote.ack(page.mailboxEpoch, page.next)`; the registration ends with `cancel(lease.id)`.
4. **Handling `OutcomeUnknown`** (API contract, not provoked by the demo):
   - If the connection fails during a commit, the caller catches `OutcomeUnknown` and asks for the actual outcome with `await remoteSpace.pollOperation(request)`.

#### Stage 4 (`v4-gated-auth`): Two-layer security (gate, key challenge & 60-s grants)

1. **Control host and data host with `startFederationHost`**:
   - Two persistent hosts, each with its own store, run behind real TCP gates on `127.0.0.1`; `startFederationHost` composes gate, boot guard (`SqliteRecoveryRegister`, `HostBootState`) and service.
   - Layer A checks the peer identity and groups through a `PeerDirectory`; the demo uses a simulated directory (peer `chat-worker` in the group `space-enroll`, groups mapped to roles by `groupRoles`), production uses `NetbirdDirectory`.
   - Layer B requires an `Ed25519` signature over the connection challenge (`{ gateHostId, observedPeerId, connNonce, protocol, issuedAt }`, valid for 30 s) at connection setup: `controlClient.authenticate()`.
2. **Token enrollment of the chat worker**:
   - The demo writes the one-time token with `bootstrapEnroll(controlStore, ctx, { tokenHash: hashToken(token), allowedPeerId })`; the worker enrolls with `controlClient.enroll(token)` in the `CONTROL_SPACE`. The supervisor command `createEnroll` is the operational path for further tokens; the demo does not use it.
3. **Short-lived 60-second grants (`grantProvider`)**:
   - The data host is started with `grantProvider: () => controlClient.requestGrant("effect")`; the control host signs the grant (`GrantAuthority`, valid for at most 60 s), and the verifier (`GrantVerifier`) checks it before a mutation is applied.
4. **Key rotation during operation (`rotateKey`)**:
   - The worker fetches `rotationChallenge(...)`, calls `rotateKey(challenge, replacementKey.signer)` and authenticates again with the new key; the demo then checks the states of the old and the new key.

#### Stage 5 (`v5-federated-cluster`): Horizontal scaling with `FederatedSpace` & HRW routing

1. **Cluster of coordinator and 3 member Spaces (`member-1`, `member-2`, `member-3`), simulated in one process**:
   - The coordinator host (in memory) carries a `RouterController` (`router-root` plus 2 partition routers, `journalPartitions: 2`) and the `FederatedSpace` `fed-v5`; the three members are separate in-memory hosts. `FederationIO` is an in-process adapter onto the members' `PhiSpaces` objects.
   - The runner composes these classes directly. It does not use `createFederationController`, a gate, a control Space or a signed `RouterLease`.
2. **Declarative `FederationPolicy` for the multiplayer chat**:
   - `Thread`, `Msg` and `ChatTask` are routed by **`expand` with HRW (highest random weight) over the key field `threadId`**: all messages and tasks of the same thread land deterministically on the same member Space, so local transactions and `CompletionProfiles` per thread work without cross-node locking.
   - Cluster-wide reads use `federated.readAll(template, principal)`; it asks every member the template can match, so the `search_history` subagent finds answers from threads on *other* members.
3. **Waiter race (`takeWaiting`), API only**:
   - `federatedSpace.takeWaiting({ type: "ChatTask" }, timeoutMs, txnLeaseMs, request)` takes a task from whichever member has one first. The v5 runner does not call it.
4. **Presence replication (phase 3 preview)**:
   - Two `EntryReplicationController` instances (`rep-1` on `member-1`, `rep-2` on `member-2`) replicate `Presence` entries with HLC + LWW; the runner carries the changes between them itself. Phase 3 is not fully accepted, so this is a preview.
   - Membership commands (`MembershipController`, drain) and run control (`RunController`, `RunGate`) are not part of the v5 runner; they belong to the federation controller and to stage 6.

#### Stage 6 (`v6-mobile-control`): Control & monitoring via the mobile app (`pi-termux-mobile`)

This stage connects the multiplayer Space-chat cluster directly with the existing mobile application in `/media/data/programming/pi-termux-mobile` (`runtime/spaces-mobile.mjs`, `runtime/public/spaces.html`, `runtime/public/steuerung.html`):

1. **Device key & QR/token pairing (`spaces.html`)**:
   - The coordinator creates via the supervisor (`createEnroll`) a time-limited enrollment token bound to the smartphone's NetBird peer ID and provides it as an `enrollQr` string.
   - On the smartphone, `MobileSpaces.call("prepare", ...)` creates a hardware-backed key in the **Android Keystore** (`createAndroidSigner`), pairs the device via `enroll` as `admin` against the `CONTROL_SPACE` and stores the profile with file permissions `0600`.
   - Key proof (`authenticate`) and uninterrupted own-key rotation (`rotate` / `rotationStatus`) can be executed directly from the phone.
2. **Mobile live monitoring of chat Spaces, notices and audit (`spaces.html` & `steuerung.html`)**:
   - **Data Space inspection (`objects`)**: in `spaces.html` the user selects a session/member Space (`dataHost`) and, with a 60-s grant issued by the control host, reads `info()`, `stats()` and the current Space objects (`Thread`, `Msg`, `ChatTask`, `Presence`, `ScheduledJob`, `SearchTask`).
   - **Alarms & notices (`listAlerts`)**: `collectAlerts` (`src/alerts.ts`) immediately reports unusual states in the chat cluster on the phone (e.g. `pauseIncomplete`, `needsReview`, workers without a fresh heartbeat, expiring `RouterLease` or quota pressure).
   - **Audit log (`auditLog`)**: shows on the smartphone all executed admin commands and their `Result` status without secret token payloads.
3. **Mobile control of workers, runs (`RunGate`) and Spaces (`steuerung.html`)**:
   - All control commands on the phone (`ADMIN_KINDS` in `runtime/spaces-mobile.mjs`) store their `commandId = m-<kind>-<hex>` locally in the profile before sending. On a double tap, dead spot or connection loss, the app sends **the same `commandId`** again ("outcome is being checked" instead of double execution!).
   - **Scale chat and subagent workers (`listWorkers` / `setWorkers`)**:
     - Via the *Worker* form in `steuerung.html`, the admin sets from the phone the desired count for `kind: "chat-worker"` or `kind: "search-subagent"` on a target host and target Space (`count: 0..64`).
     - The local `WorkerSupervisor` fetches the signed `WorkerAssignments` through the gate, starts additional worker loops or shuts them down cleanly at `count: 0` after the currently running `ChatTask` transaction has completed.
   - **Pause, resume & schedule chat processing (`startRun` / `pauseRun` / `resumeRun` / `stopRun` / `scheduleRun`)**:
     - Via the `RunController` (`RunGate`), the admin can pause from the smartphone the acceptance of new `ChatTask` takes for a run/Space across all participating members with a confirmed ACK barrier (e.g. for a maintenance window or `scheduleRun`), while running answers still commit cleanly.
   - **Manage session Spaces (`createSpace` / `archiveSpace` / `reactivateSpace` / `deleteSpace`)**:
     - New named chat Spaces can be created idempotently on a host directly from the phone, archived read-only after an event has ended (`archiveSpace` – history stays readable, new `write`/`take`/`txn` are blocked!) or deleted after an emptiness check.

---

### Interactive stage switcher (`v1` to `v6`) & mobile control panel in the web UI

In the web interface (`PHI-SPACES / HELP` $\rightarrow$ **Live Space-Chat**) there is a **6-stage architecture bar (`v1` | `v2` | `v3` | `v4` | `v5` | `v6`)** at the top:

- The user can switch between the 6 stages at any time.
- Depending on the selected stage, the **right inspector panel** shows live the stage-specific internals:
  - In **`v1`**: in-memory entries (`Thread`, `Msg`, `ChatTask`, `Presence`), active leases and transactions.
  - In **`v2`**: additionally SQLite file size, `rev` stream, `RequestRef` claims table, `TimerLock` countdowns and `SubagentStep` traces.
  - In **`v3`**: additionally `SpaceService` socket frames, active consumer mailboxes (`mailboxEpoch`, `seq`, `ackedUpTo`) and retry simulation ("inject reply loss $\rightarrow$ observe automatic `pollOperation`").
  - In **`v4`**: additionally connected peer identities (layer A), public-key fingerprints (layer B), active 60-s grants with expiry countdown and a button *"Rotate worker key live"*.
  - In **`v5`**: additionally the 3 member Spaces (`member-1`, `member-2`, `member-3`) with HRW placement per `threadId` and the `RouterController` command journal (`accepted` $\rightarrow$ `applying` $\rightarrow$ `completed`).
  - In **`v6` (mobile control & monitoring)**:
    - Shows a **QR/token enrollment generator (`enrollQr`)** for pairing `pi-termux-mobile` and an **embedded interactive preview of `spaces.html` and `steuerung.html`**, with which the exact phone commands (`setWorkers`, `pauseRun`/`resumeRun`, `archiveSpace`, `listAlerts`, `auditLog`, repeating the same `commandId` on timeout) can be executed against the Space chat directly in the browser or via the paired smartphone!

---

## 5. The Reference Project: "Multiplayer Space Chat" (Earendil Scenario Implemented with `phi-spaces` Means)

The article [Pi Durable on Cloudflare](https://earendil.com/posts/pi-durable-on-cloudflare/) demonstrates a 90s-style multiplayer chat with five core capabilities. In this project, **all five capabilities are realized exclusively through `phi-spaces` concepts and APIs**.

### 5.1 Comparison: Earendil Cloudflare post vs. the `phi-spaces` implementation

| Requirement from the Earendil article | Implementation there (Cloudflare DO + raw `pi-durable`) | Implementation here **with pure `phi-spaces` means** |
|---|---|---|
| **1. Isolated, shareable sessions per URL** | 1 Cloudflare Durable Object (`Session`) with its own SQLite DB per `sessionId`. | **1 named Space (`NamedSpace`) per `sessionId`** (`createSpace(tx, sessionAlias, now)` / `new PhiSpaces(host, ctx, Date.now, meter, undefined, { space: sessionId })`). Every Space has its own entries, its own revision sequence (`rev`), its own request claims and its own limits. |
| **2. Multiple conversations & forking without duplicates on reconnect** | `tx.createConversation` / `tx.forkConversation` + a separate `ConversationCommandReceipts` document for `requestId`. | **Entries of type `Thread` and `Msg` + native `phi-spaces` request claims (`RequestRef`)**: every `thread.create` and `thread.fork` is executed with `{ principal, generation, requestId }` via `space.write()` or a Space transaction (`space.createTransaction` + `space.commit`). A reconnect retry with the same `requestId` returns the stored result immediately thanks to `src/claims.ts`. When forking, a Space transaction copies or references the parent state up to `forkUpToSeq` atomically. |
| **3. Multiplayer messages with name attribution & ordered processing** | `conversation.submit({ content: attributedPrompt(username, text), requestId, whenBusy: "followUp" })`. | **Transactional `ChatTask` queue in the Space + `CompletionProfile`**: every participant message writes idempotently via `RequestRef` the user `Msg` entry (`{ threadId, seq, author, role: "user", text }`) and a `ChatTask` entry (`{ taskId, threadId, seq, author, text }`). The Space-chat worker takes `ChatTask` exclusively under a Space transaction (`space.take(..., { txn })`), reads the thread history via `space.readAll({ type: "Msg", fields: { threadId } })` and commits the assistant `Msg` under the enforced **`CompletionProfile`** (`ChatTask` $\rightarrow$ exactly 1 `Msg`). Further messages wait in order as `ChatTask` entries in the Space. |
| **4. Live streaming & multiplayer presence over the same WebSocket** | `watchEvents(harness, conversationId)` + WebSocket attachments for presence. | **Combination of `readPage` (snapshot), `changes(afterRev)` (delta stream), consumer mailbox (`notify`/`events`/`ack`) and `Presence` entries with Space leases**: on joining, the participant writes a `Presence` entry (`{ participantId, username, threadId, status }`) with a **Space lease (`ttlMs = 30_000`)**, which is extended via `space.renew(leaseId, 30_000)`. If a client drops out, the `phi-spaces` reaper removes the lease and fires a revision change. The WebSocket initially streams `readPage` (`snapshot`) and then every `changes(afterRev)` batch in real time to all browsers in the same Space. |
| **5. Waking up for scheduled tasks (`schedule` tool / alarms)** | A durable task sleeps until its deadline; `#refreshAlarm()` projects the earliest task deadline onto the single Cloudflare DO `alarm()`. | **Persistent Space waiters / timer leases + `SpaceChatEngine.tickAlarms()`**: when the agent calls the `schedule` tool (e.g. "check the system status / the weather in 2 minutes"), it writes a `ScheduledJob` entry (`{ jobId, threadId, instruction, executeAt, status: "scheduled" }`, `FOREVER`) and a **`TimerLock` entry with `lease = delayMs`** (or registers a persistent `space.wait()` with `timeout = delayMs` and `handback`). After the deadline – even after a complete server restart from SQLite! – the `phi-spaces` reaper (`startService`; `tickAlarms()` in `examples/shared/chat-core.ts`) detects the expired timer and converts the `ScheduledJob` transactionally and idempotently into an executable `ChatTask`. |
| **6. Cross-conversation search via subagent (`search_history`)** | A replay-safe tool creates a child conversation (`ownerTaskId: api.taskId`), searches other conversations with `search_conversations` and returns only the answer. | **Subagent coordination via `SearchTask`, `SubagentStep` and `SearchResult` entries in the Space**: when the main worker/agent calls `search_history(question)`, it writes idempotently (keyed by `searchId = "search:" + taskId`) a `SearchTask` entry (`{ searchId, parentThreadId, question }`) and waits for the result via `space.read({ type: "SearchResult", fields: { searchId } }, timeoutMs)`. A specialized **search subagent worker** takes the `SearchTask` under a Space transaction (`txn`), searches all top-level threads of the Space via `space.readAll({ type: "Msg" })` (ignoring its own subagent traces and earlier search results), records its intermediate steps as `SubagentStep` entries (so they can be inspected live in the UI sidebar!) and commits the final `SearchResult` under its own **`CompletionProfile`**. After a crash and replay, the caller finds the existing `SearchTask` or the finished `SearchResult` immediately via `searchId` / `RequestRef`. |

### 5.2 Data model of the multiplayer Space chat (all entry types in the session Space)

All state of a chat session lies transparently as typed entries in the respective named Space (`space = "chat-session-<id>"`) and can therefore be observed live in the UI inspector:

```ts
// 1. Konversations-Thread (Root oder Fork eines bestehenden Threads)
type ThreadEntry = {
  type: "Thread";
  fields: {
    threadId: string;
    title: string;
    parentThreadId: string | null; // null bei neuem Thread, gesetzt bei Fork
    forkUpToSeq: number | null;    // kopiert/erbt Nachrichten bis einschließlich dieser seq
    createdBy: string;
    createdAt: number;
  };
};

// 2. Kommittierte Chat-Nachricht (User, Assistant oder System-Alarm)
type MsgEntry = {
  type: "Msg";
  fields: {
    msgId: string;
    threadId: string;
    seq: number;
    author: string;                // z.B. "alice", "bob", "pi-agent", "scheduler"
    role: "user" | "assistant" | "alarm";
    text: string;
    taskId: string | null;         // Korrelationsfeld für CompletionProfile!
    subagentSearchId: string | null; // Verweis auf Subagent-Lauf in der Sidebar
    createdAt: number;
  };
};

// 3. Zu bearbeitender Agent-Auftrag (Durable Inbox im Space)
type ChatTaskEntry = {
  type: "ChatTask";
  fields: {
    taskId: string;
    threadId: string;
    triggerSeq: number;
    author: string;
    prompt: string;
    kind: "user_message" | "scheduled_wakeup";
    createdAt: number;
  };
};

// 4. Teilnehmer-Präsenz (mit kurzer Space-Lease, z.B. 30s, erneuert via space.renew)
type PresenceEntry = {
  type: "Presence";
  fields: {
    participantId: string;
    username: string;
    activeThreadId: string;
    status: "online" | "typing" | "idle";
    updatedAt: number;
  };
};

// 5. Geplante Aufgabe (schedule-Tool) + zugehöriger TimerLock mit Lease = delayMs
type ScheduledJobEntry = {
  type: "ScheduledJob";
  fields: {
    jobId: string;
    threadId: string;
    instruction: string;
    requestedBy: string;
    executeAt: number;
    status: "pending" | "triggered";
    createdAt: number;
  };
};

type TimerLockEntry = {
  type: "TimerLock";
  fields: {
    jobId: string;
    threadId: string;
    executeAt: number;
  };
  // Wird mit lease = delayMs geschrieben. Solange TimerLock existiert, ist der Job noch nicht fällig.
  // Läuft die Lease ab (auch nach Server-Pause/Neustart), entfernt der Reaper TimerLock automatisch!
};

// 6. Subagent-Historien-Suche (search_history)
type SearchTaskEntry = {
  type: "SearchTask";
  fields: {
    searchId: string;
    parentThreadId: string;
    parentTaskId: string;
    question: string;
    createdAt: number;
  };
};

type SubagentStepEntry = {
  type: "SubagentStep";
  fields: {
    searchId: string;
    stepIndex: number;
    queryTerm: string;
    matchCount: number;
    matchedSnippets: Array<{ threadId: string; seq: number; author: string; excerpt: string }>;
    createdAt: number;
  };
};

type SearchResultEntry = {
  type: "SearchResult";
  fields: {
    searchId: string;
    parentThreadId: string;
    answer: string;
    citedThreadIds: string[];
    createdAt: number;
  };
};
```

### 5.3 The two `CompletionProfile` contracts of the Space chat

Before the workers start, the host installs two binding completion profiles in the session Space (`space.setCompletionProfiles(...)`):

1. **`ChatTask` completion profile**:

   ```ts
   {
     taskType: "ChatTask",
     resultType: "Msg",
     matchFields: ["taskId", "threadId"],
     minResults: 1,
     maxResults: 1,
   }
   ```

   *Effect*: no `ChatTask` can be removed (committed) from the Space without exactly one associated answer `Msg` with the same `taskId` and `threadId` being written in the same transaction commit.

2. **`SearchTask` completion profile**:

   ```ts
   {
     taskType: "SearchTask",
     resultType: "SearchResult",
     matchFields: ["searchId", "parentThreadId"],
     minResults: 1,
     maxResults: 1,
   }
   ```

   *Effect*: the search subagent can only complete its `SearchTask` if it stores the structured `SearchResult` in the same commit.

### 5.4 The demo walkthrough (1:1 with the Earendil article, but on `phi-spaces`)

Users can play through exactly the sequence from the Earendil post in the browser (also with two browser windows side by side or in the UI's split-screen multiplayer simulator) and observe every Space operation on the right in the **live Space inspector**:

1. **Create a session & open a second participant window**:
   - Creates the named Space `chat-session-<id>` and registers `alice` and `bob` via `Presence` entries with 30-s leases.
2. **Write in thread 1**:
   - `alice` sends: *"We decided to use PostgreSQL for the event store."*
   - `ChatTask` is written $\rightarrow$ taken under transaction `txn` $\rightarrow$ the agent acknowledges and commits `Msg` under `CompletionProfile`.
3. **Create a new thread (or fork a thread from message #1)**:
   - `bob` clicks *"New thread"* or *"Fork from this message"* (secured via `RequestRef` claim).
4. **Ask about an earlier decision in thread 2**:
   - `bob` asks: *"What did we decide regarding the event store?"*
   - The main agent recognizes the question outside the current thread context and writes a `SearchTask` (`search_history`).
   - The **search subagent worker** takes `SearchTask` under its own transaction, searches with `readAll({ type: "Msg" })` for `"event store"` / `"PostgreSQL"`, writes its search steps as `SubagentStep` entries and commits `SearchResult` with a citation of thread 1.
5. **Open the subagent in the sidebar**:
   - All `SearchTask` runs appear in the sidebar; a click shows the exact `SubagentStep` entries, search terms, hits and the transaction ID.
6. **Test a scheduled task (`schedule`)**:
   - `alice` writes: *"Remind us in 15 seconds to check the backup window."*
   - The agent creates a `ScheduledJob` entry (`FOREVER`) and a `TimerLock` entry with `leaseMs = 15_000`.
   - Even if all browser windows are closed or the server worker is paused briefly: as soon as the `TimerLock` lease expires, the `phi-spaces` reaper removes the lock, `tickAlarms()` creates the wakeup `ChatTask` idempotently, and the reminder appears as a `Msg` in the thread.

---

## 6. Technical Architecture of the Node.js + React Server (`help-site/`)

### 6.1 Backend (`help-site/server/`)

- **Runtime**: Node.js (`>= 22.19.0`, directly executable with `node --experimental-strip-types`), persistent phi-spaces store via `openSqliteHost` (default: `.local/help-site-spaces.sqlite`) or optionally `openOwnMemoryHost` for fast automated tests.
- **HTTP endpoints**:
  - `GET /` and static assets (`/assets/*`): serves the built React application (`PHI-SPACES / HELP`).
  - `GET /help/index.json`: serves the validated, bilingual help index (`schema: "phi-spaces-help-site-index-v1"`, `areas`, `apiEntries`, `articles`, `stats`, repository commit provenance).
  - `GET /help/articles/:locale/:type/:slug.md`: serves the Markdown source of an article from `help-site/corpus/`.
  - `POST /api/chat/sessions`: creates or opens a named session Space (`chat-session-<id>`) and returns `{ sessionId, spaceId, url }`.
  - `GET /api/chat/sessions/:sessionId/inspect`: delivers for the live Space inspector the current Space snapshot (`stats`, all entries grouped by `Thread`, `Msg`, `ChatTask`, `Presence`, `ScheduledJob`, `TimerLock`, `SearchTask`, `SubagentStep`, `SearchResult`, active transactions, waiters, claims and next alarm deadline).
- **WebSocket endpoint (`/ws/chat/:sessionId`)**:
  - Implements a clean JSON protocol for the multiplayer chat:
    - **Client $\rightarrow$ server**:
      - `participant.join` (`{ participantId, username, activeThreadId, requestId }`) $\rightarrow$ writes/renews the `Presence` entry with a 30-s lease.
      - `participant.heartbeat` (`{ leaseId }`) $\rightarrow$ calls `space.renew(leaseId, 30_000)`.
      - `thread.create` (`{ title, requestId }`) $\rightarrow$ writes a `Thread` entry with `RequestRef`.
      - `thread.fork` (`{ parentThreadId, upToSeq, title, requestId }`) $\rightarrow$ copies the relevant history / creates the fork `Thread` in a Space transaction with `RequestRef`.
      - `message.submit` (`{ threadId, content, requestId }`) $\rightarrow$ writes user `Msg` + `ChatTask` in one Space transaction with `RequestRef`.
      - `alarm.schedule` (`{ threadId, delayMs, instruction, requestId }`) $\rightarrow$ also allows directly triggering a scheduled job for test purposes.
    - **Server $\rightarrow$ client**:
      - `session.snapshot`: complete initial state from `readPage` (`rev`, `threads`, `messages`, `presence`, `scheduledJobs`, `subagentRuns`, `spaceStats`).
      - `session.changes`: incremental deltas from `space.changes(afterRev)` on every Space commit (new `Msg`, `ChatTask` reservation, `Presence` change, `SubagentStep`, `TimerLock` expiry).

### 6.2 Frontend (`help-site/client/`)

The React frontend is a Next.js 16 / React 19 app. `app/layout.tsx` sets metadata, the `data-mode`/`data-palette` defaults and imports `client/styles/layout.css`; `app/page.tsx` is a server component that reads `public/help/index.json` and renders `<HelpApp initialIndex={...} />`. `client/main.tsx` is only the standalone entry that mounts the same component. There are no per-view files: `HelpApp` in `client/App.tsx` holds the shell and draws the views itself; `client/components/` holds the larger live and admin views.

1. **`client/App.tsx` (`HelpApp`: top bar + 3-column workspace)**:
   - Top bar with `PHI-SPACES / HELP`, global search (`Ctrl K` / `/`), pills for the Space Chat feed, the Multiplayer Chat (v1–v6) and AdminSpaces, the `DE`/`EN` switch, the `Dark`/`Light` switch and the 14-palette picker; the sidebar is described in §3.2.
   - The current view is a `ViewState` (`client/lib/help-navigation.ts`) with the kinds `home`, `area`, `article`, `search`, `browse`, `api-finder`, `space-chat`, `feed`, `intro` and `admin`. `parseHelpView` and `helpUrl` map it to the URL: `?lang=`, `?area=...`, `?article=...#anchor`, `?q=...`, `?owner=...&type=...`, `?view=api-finder` (with `mode`, `oq`, `provider`, `category`, `execution`, `idempotency`, `scope`), `?view=space-chat&session=...&stage=v1..v6`, `?view=feed`, `?view=admin`, `?view=intro&app=...`.
   - Index and articles are loaded from `public/help/index.json` and `/help/articles/...` (`client/lib/index-load.ts`, `article-load.ts`); search is a token/alias scorer (`client/lib/search.ts`).
2. **Home view (in `App.tsx`)**:
   - **Hero**: *"Schreiben. Koordinieren. Überleben."* / *"Write. Coordinate. Survive."* with the buttons *"Start Your First Complete Space"* (`help.topic.first_running_space`), *"Run the examples"* (`help.topic.examples`), *"All apps at a glance"* (`help.topic.apps`), the AdminSpaces login and a link to the GitHub repository.
   - **Section `01` – Canonical model (`execution-model`)**:
     - Lane `LOCAL` (v1–v3 single Space): `01 Input & Claim` (Entry + RequestRef) $\rightarrow$ `02 Atomic Commit` (Txn + CompletionProfile) $\rightarrow$ `03 Reactive Stream` (readPage / changes / Mailbox).
     - Lane `CLUSTER` (v4 gate, v5 routing, v6 ops): `01 Zero-Trust Gate` (Layer A/B + 60s Grant) $\rightarrow$ `02 Router & Sharding` (HRW Policy & Journal) $\rightarrow$ `03 Operations Control` (RunGate & AdminSpaces).
   - **Section `02` – Nine systems (`help-area-grid`)**: the 9 numbered area cards (`01` to `09`) with direct links to their articles.
   - **Section `03` – Source-owned corpus (`corpus-metrics`)**: 4 tiles (number of API and agent-tool articles, "6 Stages", number of validated help identities, `DE / EN` with anchor parity); three of them link to the finder and the listings.
3. **Area, browse and search views (in `App.tsx`)**: the area view lists one system area with its article cards; `browse` lists all content (filter by `owner` and `type`, e.g. the workflows); `search` shows matching areas and articles.
4. **API finder (in `App.tsx`)**:
   - Two tabs (`API & Tools`, `Architecture Packages`), provider chips, a text query and the four facet dropdowns of §3.5; the result list shows the matching API articles with their provider and idempotency model.
5. **Article view (in `App.tsx`)**:
   - Renders the Markdown of an article (`client/lib/markdown.ts`: tables, code blocks, stable `{#anchor}` headings) with breadcrumbs, meta pills, related articles and a footer with the help ID, word count, locale and source commit (`repository@commit`, `+dirty` when applicable); the right column `ON THIS PAGE` shows the table of contents and the "Help ≠ Live State" note.
6. **`client/components/SpaceChatWorkbench.tsx` (the interactive multiplayer example, shown in the live frame with the `SystemBar` below)**:
   - A **stage bar `v1` to `v6`** (default `v2`) with a link to the stage's article and a button that runs and verifies the stage on the server (`POST /api/chat/stages/<stage>/run`) and shows the JSON report.
   - **Left (multiplayer chat)**: participant selection (`alice`, `bob`, ...), thread list and thread creation (`RequestRef`), message form (`write` + `ChatTask`), message list with role and author, alarm form (`ScheduledJob` with `TimerLock`) and the list of scheduled alarms.
   - **Right (live `phi-spaces` inspector, `readPage` + `changes`)**: current Space revision, the installed completion profiles (`ChatTask`→`Msg`, `SearchTask`→`SearchResult`), `Presence` leases (30 s TTL), scheduled alarms and the subagent trace.
   - The data arrive over the WebSocket `/ws/chat/<session>` (`client/lib/chat-connection.ts`, with a polling fallback); actions go to `/api/chat/sessions/<session>/action` with a fresh `requestId` each.
7. **Other components**: `SocialFeedView.tsx` (the Social Swarm feed), `AppIntro.tsx` (the short introduction before each app: swarm, codemode, space-chat, mmo, stats), `AdminSpacesView.tsx` (§6.3), `LlmModelPicker.tsx` and `LlmAllowedModels.tsx` (model choice and its allow-list), `SystemBar.tsx` (hosts and entry caps below the live views).

### 6.3 Protected web admin area (`AdminSpaces`) & production deployment at `https://spaces.eibrain.org`

Besides the public help system and the multiplayer chat demo, the website at **`https://spaces.eibrain.org`** offers a **login-protected area `AdminSpaces` (`?view=admin` or `/admin`)** through which all Spaces, runs, workers, deployments and keys can be controlled and monitored **just like in the mobile app (`spaces.html` + `steuerung.html`)**.

The contract for the HTTPS browser gateway from `docs/federation-plan-v3.en.md` (§3) and `docs/betrieb-und-mobile-steuerung.en.md` (§2, §3: *"Optional HTTPS gateway: login per user"*) is implemented exactly:

```text
   Öffentlicher Browser / Web-Admin             Smartphone (pi-termux-mobile)
          │                                            │
          │ HTTPS / WSS                                │ NetBird WireGuard Overlay
          │ https://spaces.eibrain.org                 │ tcp://100.x.x.x:<gate-port>
          │  ├─ Öffentlich: /help, /chat               │ + Android Keystore Ed25519/P-256
          │  └─ Geschützt:  /admin (Login + CSRF)      │
          ▼                                            │
┌───────────────────────────────┐                      │
│ Reverse Proxy (Nginx / Caddy) │                      │
│ TLS-Terminierung (Let's Encr.)│                      │
└──────────────┬────────────────┘                      │
               │ http://127.0.0.1:3500                 │
               ▼                                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Node.js Host (help-site/server/index.ts + phi-spaces Runtime)             │
│  ├─ Help-Server (/help/index.json, /help/articles/*, React UI)           │
│  ├─ Browser-Chat-Gateway (/api/chat/*, /ws/chat/:sessionId)              │
│  ├─ Web-Admin-Gateway (/api/admin/* -> WebAdminSpaces mit Ed25519-Signer)│
│  ├─ space-gate (auf NetBird-Overlay-IP / lokalem Socket)                 │
│  └─ Control Space, Supervisor, Router & Session-Data-Spaces (SQLite)     │
└──────────────────────────────────────────────────────────────────────────┘
```

#### 1. Login & authentication for the `AdminSpaces` area (`server/admin/admin-controller.ts`)

- **Two-stage security model for the web gateway**:
  1. **User login at the web server (`POST /api/admin/login`)**:
     - Login with admin username + password (hashed with `node:crypto.scryptSync` and compared with `timingSafeEqual`) **or** initial pairing with a one-time enrollment token (`enrollQr` / bootstrap token).
     - After a successful login, the server sets a signed `HttpOnly; Secure; SameSite=Strict` session cookie plus an `X-CSRF-Token` for all writing `/api/admin/*` calls.
     - Strict per-IP rate limits (protection against brute force) and immediate session invalidation on `POST /api/admin/logout`.
  2. **Cryptographic binding to the `CONTROL_SPACE` (`server/admin/admin-controller.ts`)**:
     - The web gateway performs no direct, unauthorized DB writes but uses exactly the same architecture as `MobileSpaces` in `pi-termux-mobile/runtime/spaces-mobile.mjs`:
     - The gateway maintains a private admin profile (`0600`) with its own `Ed25519`/`P-256` key (`provisionFileSigner` / `loadFileSigner` from `src/keys.ts`), authenticates at the `space-gate` via the layer B challenge (`remote.authenticate()`), obtains short-lived 60-second grants (`requestGrant()`) before operations and sends admin commands as `Command` entries into the `CONTROL_SPACE`.

#### 2. Feature scope in the `AdminSpaces` web area (`client/components/AdminSpacesView.tsx`)

After logging in to `AdminSpaces`, **all functions from `spaces.html` and `steuerung.html`** are available on the website in a clear high-end interface:

| Area in `AdminSpaces` | Functions on the website (1:1 with `spaces.html` & `steuerung.html`) | Backend effect in the `CONTROL_SPACE` / data Space |
|---|---|---|
| **1. Identity, pairing & keys (`spaces.html`)** | Check own admin profile (`status`, `authenticate`), rotate own key pair (`rotate`, `rotationStatus`), **create enrollment token & QR code (`createEnroll` / `enrollQr`)** to pair a smartphone (`pi-termux-mobile`) or a new host, and revoke compromised peers (`revokePeer`). | `Supervisor` (`createEnroll`, `rotateKey`, `revokePeer`), `ProvingService` |
| **2. Space inspector (`spaces.html`)** | Select any data Space (`default`, `chat-session-*`, `member-1..3`, `sieve-*`) and examine and filter live `info()`, `stats()` (entries, txns, waiters, byte budgets) and the contained entries (`objects` / `readAll`). | `RemoteSpace.info()`, `stats()`, `readAll()` with 60-s grant |
| **3. Notices & alarms (`steuerung.html`)** | Load and monitor active system warnings (`listAlerts`): incomplete pause (`pauseIncomplete`), open recovery check (`needsReview`), stale worker heartbeats, expiring `RouterLease` or quota warnings. | `collectAlerts` (`src/alerts.ts`) |
| **4. Operations (`steuerung.html`)** | List of all sent admin orders (`operations` / `result`) with status (`sending`, `notSent`, `sent`, `completed`, `failed`, `duplicate`). The `commandId` is stored persistently before sending – a click on *"Check again / send"* on timeout uses exactly the same `commandId` without second execution. | `Command` and `Result` entries in the `CONTROL_SPACE` |
| **5. Runs & `RunGate` control (`steuerung.html`)** | Load active runs (`listRuns`, `runStatus`), start a new sieve or batch run (`startRun`), check the **plan preview (`dryRun: true`)**, **pause (`pauseRun`), resume (`resumeRun`), stop (`stopRun`)** a run across all members with an ACK barrier, schedule it (`scheduleRun`), export results with manifest hash (`exportRun`) and make recovery decisions after a restore (`reconcileRun`, `resolveRunRecovery`). | `RunController` (`src/run-controller.ts`), `RunGate` in the core |
| **6. Worker control (`steuerung.html`)** | Load registered workers (`listWorkers`: desired count against reported actual state from `Capability` heartbeat + age) and set the worker count per host, worker kind (`chat-worker`, `search-subagent`, `sieve`) and target Space (`setWorkers`, `count: 0..64`; `0` stops cleanly after the running task). | `WorkerAssignments` & `WorkerSupervisor` (`src/workers.ts`) |
| **7. Space lifecycle (`steuerung.html`)** | Create or reuse new named Spaces idempotently on a host (`createSpace`), archive existing Spaces read-only (`archiveSpace`), reactivate them (`reactivateSpace`) or delete them after an emptiness check (`deleteSpace`). | `SpaceLifecycle` (`src/space-lifecycle.ts`) |
| **8. Deployment & audit (`steuerung.html`)** | Edit the declarative deployment config (JSON) in the browser, **show the plan (`planDeployment`)**, apply it (`applyDeployment`), export the current state (`exportDeployment`) and view the **audit log (`auditLog`)** of all admin commands (without secret token payloads). | `DeploymentController` (`src/deployment.ts`), `auditLog` (`src/alerts.ts`) |

#### 3. Reverse proxy and server configuration (`help-site/deploy/`)

- `help-site/deploy/nginx-spaces.eibrain.org.conf` and `help-site/deploy/Caddyfile` (including TLS, WebSocket upgrade for `/ws/chat/`, cookie/header forwarding for `/api/admin/` and security headers).
- `help-site/deploy/phi-spaces-help.service` (systemd unit for permanent operation on the server).

---

## 7. Complete Article and Content Catalog (`help-site/corpus/`)

Each of the following articles exists in both **German (`corpus/de/...`)** and **English (`corpus/en/...`)** with identical IDs and anchors; the ID is `help.<kind>.<file name>` (`help.topic.*`, `help.workflow.*`, `help.api.*`). The catalog `corpus/help_product_catalog.json` groups them into the areas of §3.3; `corpus/api_facts.json` holds the checked API facts. The description is the `short` line of the English article.

### 7.1 Concept and architecture topics (`topics/`)

1. `help.topic.agent_tools_and_replay` – **The 8 LLM Agent Tools and Replay Safety**: How AI agents coordinate safely through space_write, space_read, space_take, space_list, space_txn, space_wait, space_notify, and space_lease.
2. `help.topic.apps` – **Apps on phi-spaces**: The five applications at a glance: the agent swarm, codemode chat, Multiplayer Space-Chat, the role-playing game spaces-mmo and the space stats.
3. `help.topic.architecture_layers` – **Architecture Layers and Module Map**: Mapping of the main source modules in src/ across the 6 architecture layers, from the pure state machine and the own store to federation, RunGate, and replication.
4. `help.topic.async_interaction` – **Async Operations, Waiters and Agent Turns**: Calls to a space return a Promise, so your program can do other things meanwhile. Some calls wait for an entry, others report back later by themselves. This guide explains what a call waits for and which way to pick when.
5. `help.topic.comparison_earendil_vs_phi_spaces` – **Concept Comparison: Earendil Multiplayer Chat vs. phi-spaces (v1 to v6)**: Comparison of the Cloudflare Durable Object approach and pi-durable 1.4.0 with the phi-spaces tuple-space model, including pros and cons from In-Memory (v1) to Federated Space (v5/v6).
6. `help.topic.completion_profiles_and_limits` – **CompletionProfiles and Resource Limits**: Server-side result verification when committing take transactions (CompletionProfile) and fixed byte and owner quotas (DEFAULT_LIMITS).
7. `help.topic.durable_mailboxes_and_ack` – **Durable Mailboxes (events / ack), wait, and notify**: How non-blocking wait and notify deliver events into persistent consumer mailboxes, and how prefix ACK differs from a transaction commit.
8. `help.topic.entries_and_templates` – **Entries, Subtypes, and Template Matching**: Structure of entries ({type, types?, fields}), global identities (gid), hierarchical subtypes, and exact wildcard rules during template matching.
9. `help.topic.examples` – **Examples: what exists and how to run it**: Every runnable example at a glance: what it shows, how to start it, and which ones need a real model and cost tokens.
10. `help.topic.failure_playbook` – **Failure Diagnosis and Safe Next Actions**: When a call fails, it is not always clear whether it took effect. This guide shows the safe next step for each failure. The key rule: unknown does not mean failed. So repeat with the same request ID, never with a new one.
11. `help.topic.federation_router_and_membership` – **Federation, Router, HRW Sharding, and Membership**: How createFederationController unites multiple member spaces into a cluster using HRW routing, signed delegations, and journaled waiter races.
12. `help.topic.first_running_space` – **Your First Complete Space: Task to Result**: This example shows the whole path of a task in a space: write it, look at it, claim it, and finish it with a result. You need no model, no credentials, and no server. Node and the repository's existing dependencies are enough.
13. `help.topic.gate_auth_grants_and_recovery` – **Overlay Gate, Layer A/B Auth, 60s Grants, and Recovery**: Two-layer authentication (NetBird peer + Ed25519/P-256 challenge), token/QR enrollment, short-lived 60-second grants, key rotation, boot guard, and restore.
14. `help.topic.guarantees_and_boundaries` – **Binding Guarantees and System Boundaries**: What phi-spaces strictly guarantees for local commits, retries, transactions, restores, and federation, and what is intentionally out of scope.
15. `help.topic.leases_and_transactions` – **Leases, Transactions, and Visibility**: How leases enable self-healing state and how transactions (createTransaction, commit, abort) isolate writes and takes atomically.
16. `help.topic.live_sync_recipe` – **Live UI: Snapshot, Changes and Resynchronization**: A user interface should show the content of a space and stay current. It first loads the complete state and then applies every change. It shows the result only when everything is loaded, so a half list never appears.
17. `help.topic.local_client_and_named_spaces` – **Local Client PhiSpaces, Named Spaces, and startService**: How PhiSpaces operates on the default space or named spaces (NamedSpace) and how startService drives the reaper and event delivery.
18. `help.topic.operations_mobile_and_replication` – **Operations Extension (RunGate, Workers, Mobile/Web Admin) & Phase 3 Replication**: How runs are controlled via RunGate barriers, workers via signed assignments, and spaces via the mobile app (pi-termux-mobile) and web admin area (AdminSpaces).
19. `help.topic.overview` – **phi-spaces System Overview: What It Is And What It Can Do**: An introduction to phi-spaces: what it is, how the transactional tuple-space model works, which problems it solves, and what it can do from a single process up to a federated cluster with mobile and web administration.
20. `help.topic.request_claims_and_generations` – **Request Claims, Generations, and Idempotency**: How phi-spaces prevents duplicate mutations across connection drops or restarts using {principal, generation, requestId} and canonical RFC-8785 hashes.
21. `help.topic.safe_operations` – **Safe Startup, Model Budgets and Backups**: This guide says how to start the help site safely, limit model costs, and back up data. Web login, device pairing, and network permissions are three separate things here. phi-spaces is experimental, so check it yourself before important data depends on it.
22. `help.topic.snapshots_and_change_streams` – **Snapshot Pages (readPage) and Revision Streams (changes)**: How clients read consistent, byte-bounded snapshots via readPage and stream subsequent commits seamlessly via changes(afterRev).
23. `help.topic.social_swarm_pipeline` – **Social Swarm: Data Flow, Batches and Shards**: Social Swarm is a demo of the help site: many simulated characters write posts into a shared feed. It shows how to process many small tasks in bundles, and so cheaply. This guide explains the data flow and what happens when one part fails.
24. `help.topic.space_service_and_remote_space` – **SpaceService, RemoteSpace, and Network Transports**: How SpaceService enforces role policies, how the standalone service runs, and how RemoteSpace communicates over in-process, Unix socket, TCP, or pi-serverd transports with stable retries.
25. `help.topic.task_lifecycle` – **Task Lifecycle and Safe Retries**: A task is an entry in the space. A worker claims it, does the work, and finishes it together with the result. This guide shows that path and what happens on failure, so nothing gets lost or runs twice.
26. `help.topic.topology_and_readiness` – **Topologies, API Boundaries and Readiness**: A running example shows a workflow, but not yet fault-tolerant operation. This guide says for each stage what it really checks and what it does not. That shows you what you have to prove yourself for your use.

### 7.2 Practical workflows and 6-stage guides (`workflows/`)

27. `help.workflow.overview_v1_to_v6` – **Overview: Multiplayer Space-Chat in 6 Stages (v1 to v6)**: How a multiplayer chat is built with phi-spaces: six runnable stages, from a program in memory to operation by phone and web.
28. `help.workflow.stage_v1_local_memory` – **Stage 1 (v1-local-memory): Zero-Setup Local Quickstart**: The simplest runnable version of the chat in memory: threads, forks, presence, and replies inside a transaction.
29. `help.workflow.stage_v2_local_durable` – **Stage 2 (v2-local-durable): SQLite Persistence, Alarms & Subagent**: Extends Stage 1 with storage in a SQLite file, safely repeatable calls, scheduled alarms, and a search across all threads.
30. `help.workflow.stage_v3_remote_socket` – **Stage 3 (v3-remote-socket): SpaceService & RemoteSpace over Socket/TCP**: Separates store, gateway, chat worker, and search subagent: one service exposes the space over socket or TCP, everyone else is a client.
31. `help.workflow.stage_v4_gated_auth` – **Stage 4 (v4-gated-auth): Overlay Gate, Layer A/B, Enrollment & 60s Grants**: Secures the Multiplayer Space-Chat with startFederationHost, cryptographic connection challenge (Ed25519), token enrollment, 60-second grants, and boot guard.
32. `help.workflow.stage_v5_federated_cluster` – **Stage 5 (v5-federated-cluster): Federated Spaces, HRW Sharding & Router**: Distributes threads across 3 member spaces through a router: HRW placement per threadId, cluster-wide reads, and LWW presence, simulated in one process.
33. `help.workflow.stage_v6_mobile_control` – **Stage 6 (v6-mobile-control): Control via Mobile App & Web Admin (spaces.eibrain.org)**: Complete administration and monitoring of the space cluster via the Android app (pi-termux-mobile) and the login-protected AdminSpaces web area.

### 7.3 Structured API entries (`api/`)

34. `help.api.agent_tools` – **Agent Tools (spaces) & startService – Replay-Safe LLM Tools**: Provides AI agents with 8 replay-safe tools with a request identity per call and ownership protection; startService runs the reaper and delivery.
35. `help.api.federation_controller` – **createFederationController & FederatedSpace – Router, HRW Sharding & Membership**: Connects router journal partitions, signed RouterLease, original-principal delegation, HRW policy, waiter race, and membership lifecycle.
36. `help.api.gate_auth_grants` – **Gate, Layer A/B, Enrollment, 60s Grants & Rotation**: Combines NetBird peer resolution (Layer A), Ed25519/P-256 challenge (Layer B), QR/token enrollment, 60s grants, and atomic key rotation.
37. `help.api.operations_runs_workers` – **RunController, WorkerSupervisor, SpaceLifecycle & Alerts – Operations Extension (B2–B10)**: Controls runs via RunGate ACK barriers, assigns signed worker lists to hosts, manages space lifecycles and deployments, and powers AdminSpaces and mobile control.
38. `help.api.phispaces_claims` – **Request Claims & Generations – Restart-Safe Idempotency**: Binds mutations and blocking operations atomically to {principal, generation, requestId} and a canonical RFC-8785 argument hash.
39. `help.api.phispaces_completion_profiles` – **setCompletionProfiles & setLimits – Server-Side Result and Budget Contracts**: Enforces expected result type, correlating fields (equalFields), and count before committing a take transaction; manages byte limits.
40. `help.api.phispaces_lease` – **Leases – renew & cancel**: Extends or cancels the lifetime of owned entries, transactions, notify subscriptions, and waiters (basis for presence & heartbeats).
41. `help.api.phispaces_read` – **read & readIfExists – Non-Destructive Entry Read**: Finds a matching visible entry using a template (missing/null fields are wildcards) and waits up to the timeout.
42. `help.api.phispaces_read_page_changes` – **readPage & changes – Consistent Snapshots and Revision Streams**: Reads byte-bounded pages of an immutable snapshot (with token and rev) and catches up on subsequent commit batches via changes(afterRev).
43. `help.api.phispaces_take` – **take & takeIfExists – Exclusively Remove or Reserve an Entry**: Removes a matching entry immediately or reserves it exclusively under a transaction (returning it on abort or lease expiry).
44. `help.api.phispaces_txn` – **Transactions – createTransaction, commit & abort**: Groups takes (reservations) and writes (invisible drafts) atomically; verifies all CompletionProfiles and byte budgets on commit.
45. `help.api.phispaces_wait_notify_mailbox` – **wait, notify, events & ack – Reactive Delivery and Consumer Mailboxes**: Parks long-lived read/take requests or event subscriptions without blocking a turn; delivers results via durable mailboxes with prefix ACK.
46. `help.api.phispaces_write` – **write – Write an Entry**: Creates a new typed entry with a lifetime; supports request replay, atomic singleton creation through unique, and transient output.
47. `help.api.space_service_and_remote` – **SpaceService, serveSpace & RemoteSpace – Network RPC over Socket & TCP**: Exposes spaces over Unix socket or TCP, also as a standalone service or through pi-serverd, with role policies, and serves RemoteSpace clients with stable retry identity.

---

## 8. Technical Constraints and Compliance with `AGENTS.md`

According to `/media/data/programming/phi-spaces/AGENTS.md`, the following rules apply as binding:

1. **No new npm dependencies without asking**:
   - In `phi-spaces`, `esbuild` (`^0.25.0`), TypeScript (`^7.0.2`) and `@types/node` are already installed (pi-durable, pi-ai and chord only in the `agent/` package).
   - **For the backend (`help-site/server/`)**, **no new dependencies at all** are needed:
     - HTTP server and static delivery use `node:http`, `node:fs/promises` and `node:path` (like `src/dashboard.ts`).
     - The WebSocket server uses a compact, standards-compliant RFC 6455 upgrade handler based on `node:http` and `node:crypto` (without an external `ws` package!).
     - Persistence uses the phi-spaces store (SQLite or memory) via the local library `phi-spaces` (`file:..`).
   - **For the React frontend (`help-site/client/`)** there were two clean ways (option B was implemented: `help-site/package.json` carries `next` 16, `react` 19 and `react-dom` 19; the frontend is built with Next.js, `app/`, and `scripts/build-web.ts`):
     - **Option A (zero install, runnable immediately without `npm install`)**: a lightweight JSX runtime shim in `help-site/client/lib/react-shim.ts` (or a local vendor bundle), compiled with `esbuild` (`--jsx=automatic`) into a single fast browser bundle – entirely without network download or change to `package.json`.
     - **Option B (with approval)**: installation of `react` and `react-dom` after explicit approval by the user.
     - *Recommendation in the plan*: the components in `help-site/client/` are written in clean, standards-compliant `.tsx` (with hooks `useState`, `useEffect`, `useMemo`, `useRef`), so that they build immediately without installation with the zero-install runtime shim via `esbuild` and can at any time run 1:1 with `react`/`react-dom`.
2. **The existing suite stays untouched and green**:
   - The root `tsconfig.json` is not broken; `npm run typecheck` and `npm test` run after every step.

---

## 9. Implementation Phases (Work Packages)

### Phase 1: Canonical help corpus & index generator (`help-site/corpus/` & `help-site/scripts/build-corpus.ts`)

1. Create `help-site/corpus/help_product_catalog.json` with the 9 system areas.
2. Write the bilingual articles (`de` and `en`) for architecture, concepts, guarantees/limits, the 7-stage step-by-step guide, the 3 multiplayer chat documentation chapters and the 14 API reference entries.
3. Implement `help-site/scripts/build-corpus.ts`:
   - Checks frontmatter, `{#anchor}` parity between `de` and `en`, internal `help.*` links and completeness of the catalog.
   - Generates `help-site/dist/public/help/index.json` (including table of contents `toc`, word count, search text, API facets and git commit provenance).

### Phase 2: The 6 executable stages of the multiplayer Space chat (`help-site/examples/v1..v6` & `help-site/server/space-chat/`)

1. **`examples/shared/`**: shared entry schemas (`Thread`, `Msg`, `ChatTask`, `Presence`, `ScheduledJob`, `TimerLock`, `SearchTask`, `SubagentStep`, `SearchResult`), the two `CompletionProfiles` and the deterministic scripted agent.
2. **`examples/v1-local-memory/`**: zero-setup in-memory version (store in memory + `PhiSpaces`), startable directly via CLI or in the browser.
3. **`examples/v2-local-durable/`**: persistent SQLite version with `issueGeneration` / `RequestRef` claims, `readPage`/`changes`, alarms (`tickAlarms()`, `TimerLock` lease expiry) and `search_history` subagent.
4. **`examples/v3-remote-socket/`**: client/server version with `SpaceService` (`serveSpace` over Unix socket/TCP), separate `RemoteSpace` clients for web gateway, chat worker and subagent, and consumer mailbox control (`wait` + `events` + `ack`).
5. **`examples/v4-gated-auth/`**: secured version with `startGate` (layer A peer roles + layer B Ed25519/P-256 challenge), token enrollment in the `CONTROL_SPACE`, 60-second grants (`GrantAuthority`/`GrantVerifier`), live key rotation and `SqliteRecoveryRegister` + `installBootGuard`.
6. **`examples/v5-federated-cluster/`**: cluster version with `RouterController` (`router-root` + 2 partition routers), `FederatedSpace` (4 in-memory hosts: coordinator + 3 member Spaces, HRW routing by `threadId`, cluster-wide `readAll`) and the phase 3 LWW presence preview (`EntryReplicationController`).
7. **`examples/v6-mobile-control/`**: mobile control and monitoring version for `pi-termux-mobile` (`spaces.html` & `steuerung.html`): QR enrollment (`enrollQr`), live object view (`objects`), worker scaling (`setWorkers` / `WorkerSupervisor`), `RunController`/`RunGate` pause/resume/schedule, Space lifecycle (`createSpace`/`archiveSpace`), alerts (`collectAlerts`) and audit log (`auditLog`).
8. **`server/space-chat/stage-runner.ts` & `deploy/`**: unified orchestrator for the web workbench (`v1`–`v6`) as well as reverse proxy and systemd configuration for `https://spaces.eibrain.org`.

### Phase 3: Node.js HTTP/WebSocket server & React UI (`help-site/server/` & `help-site/client/`)

1. **`help-site/server/index.ts`**: Node.js server with help API (`/help/index.json`, `/help/articles/...`), Space-chat REST API (`/api/chat/...`), RFC 6455 WebSocket server (`/ws/chat/:sessionId`) for live `readPage` snapshots and `changes(afterRev)` broadcasts.
2. **`help-site/client/`**:
   - High-end styling (top bar, 14 color palettes, dark/light, DE/EN, 3-column workspace, 2-lane system model, 9 system cards, corpus metrics, API & tool finder, Markdown renderer with `#anchor` support and right-hand TOC column).
   - Integrated **`SpaceChatWorkbench`**: multiplayer chat interface (threads, forking, participant switcher/multi-tab synchronization, countdown for scheduled alarms, subagent trace viewer) combined with the **live `phi-spaces` inspector** (real-time display of `rev`, entries, leases, transactions and claims).

### Phase 4: Verification and tests (`help-site/tests/`)

Implemented are `tests/help-consistency.test.ts`, `tests/help-site.test.ts`, `tests/regressions.test.ts` and more (`npm --prefix help-site test`); the following names are the original plan.

1. **`corpus.test.ts`**: checks schema, DE/EN parity, stable anchors and search function (including short tokens such as `tx`, `gid`, `ack`, `hrw`).
2. **`chat-session.test.ts`**: automated end-to-end test of the whole Earendil demo flow on `phi-spaces`:
   - Idempotent thread create & fork on repeated `requestId`.
   - Multiplayer messages from `alice` and `bob` with `CompletionProfile` check.
   - `Presence` lease renewal and automatic expiry after timeout.
   - Scheduled task (`TimerLock` lease expires $\rightarrow$ wakeup `ChatTask` creates alarm `Msg`, also across reopening a persistent store).
   - `search_history` subagent finds the `"PostgreSQL"` decision from thread 1, writes `SubagentStep` entries and commits `SearchResult` for thread 2.
3. **`server-http.test.ts`**: checks the HTTP routes, the WebSocket handshake/live stream and the built frontend bundle.
4. Final run of `npm run typecheck` and `npm test` in the main project.
