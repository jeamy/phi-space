# Architectural Comparison: Earendil Multiplayer Chat (`Pi Durable on Cloudflare`) vs. `pi-spaces` (`v1` In-Memory to `v5`/`v6` Federated Space)

**Date:** October 17, 2026  
**References:**
- Baseline Reference: [Pi Durable on Cloudflare – Multiplayer Chat](https://earendil.com/posts/pi-durable-on-cloudflare/)
- Our Implementation: [`help-site/examples/v1..v6`](file:///media/data/programming/pi-spaces/help-site/examples) and [`help-site/examples/shared/chat-core.ts`](file:///media/data/programming/pi-spaces/help-site/examples/shared/chat-core.ts)
- Contrast to Actor Model: [`examples/chat.ts`](file:///media/data/programming/pi-spaces/examples/chat.ts)
- Target Architecture without Pi-Durable: [`docs/umstellung-ohne-pi-durable.md`](file:///media/data/programming/pi-spaces/docs/umstellung-ohne-pi-durable.md)

---

## 1. Core Paradigm Comparison: Stateful Actor Wrapper vs. Coordination Space (Tuple Space)

Although both architectures historically originated from the `@earendil-works` ecosystem and utilize transactional persistence, they follow two fundamentally different architectural patterns. Furthermore, the project is actively executing a transition plan away from external framework dependencies toward a standalone tuple-space runtime:

| Dimension | Earendil Reference (`Pi Durable on Cloudflare`) | Our `pi-spaces` Approach (`v1` to `v6`) | Status / Notes |
|---|---|---|---|
| **Core Paradigm** | **Stateful Actor per Session (Durable Object)**: Each session is an isolated Cloudflare Durable Object encapsulating WebSockets, an embedded SQLite database, a single alarm timer, and the `pi-durable` harness inside one object instance. | **Decoupled Coordination Space (Tuple Space)**: State lives as a collection of typed, immutable JSON entries (`Thread`, `Msg`, `ChatTask`, `Presence`, `ScheduledJob`, `SearchTask`) inside a space. Clients, workers, and subagents are loosely coupled participants. | ✅ Implemented in code ([`chat-core.ts`](file:///media/data/programming/pi-spaces/help-site/examples/shared/chat-core.ts)). |
| **Where Business Logic Lives** | Inside the methods of the `Session` Durable Object class, directly calling `harness.commit(...)`, `conversation.submit(...)`, and `watchEvents(...)`. | Inside independent workers interacting with the space through the unified `SpaceLike` contract (`write`, `read`, `take`, `wait`, `notify`, `createTransaction`, `commit`). | ✅ Implemented in `processNextChatTask` and `processNextSearchTask`. |
| **Coupling of Web Server & AI Workers** | **Tightly Coupled (In-Object)**: WebSocket termination, conversation state, and model invocations all run inside the same Durable Object instance. | **Freely Composable (`v1`–`v6`)**: Can run in-process (`v1`/`v2`), decoupled across Unix sockets or TCP (`v3`), cryptographically authenticated across host boundaries (`v4`), or federated across multiple servers (`v5`/`v6`). | ⚠️ **Gap:** In `v5-federated-cluster`, the test currently runs in-process with 4 `MemoryStorage` instances rather than over physical TCP sockets. |
| **Platform Dependency** | Tied to **Cloudflare Workers & Durable Objects** (`DurableObjectState`, `ctx.storage.sql`, Hibernatable WebSockets, `alarm()`). | **Platform-Independent (Self-Hosted / On-Prem / VPS / Docker / Mobile)**: Runs anywhere Node.js runs (RAM, local SQLite/JSONL, Docker containers, Linux VPS, Android/Termux). | ✅ Verified on Linux & Android/Termux. |
| **Persistence Dependency** | Hardwired to Cloudflare Edge Storage and `@earendil-works/pi-durable`. | Currently still coupled to `@earendil-works/pi-durable`; architectural roadmap [`docs/umstellung-ohne-pi-durable.md`](file:///media/data/programming/pi-spaces/docs/umstellung-ohne-pi-durable.md) plans an autonomous SQLite engine. | ⚠️ **In Transition:** Moving toward full autonomy from `pi-durable`. |
| **Scaling Model** | **Scale-to-Zero per Session** (hibernates when idle; supports thousands of small, completely isolated sessions on edge infrastructure). | **Horizontal & Vertical Scaling of Workers and Spaces**: Scales from a single space (`v1`–`v4`) to a sharded multi-member cluster (`v5` with HRW routing by `threadId`) and centralized operational control (`v6`). | ✅ HRW routing implemented in core; see Section 2.8 for cluster transaction boundaries. |

> [!NOTE]
> **Coexistence of Two Chat Approaches in the Repository:**  
> The root example [`examples/chat.ts`](file:///media/data/programming/pi-spaces/examples/chat.ts) implements chat as an **Earendil actor network**, where `alice`, `bob`, and `carol` are durable `pi-durable` conversations and the space acts strictly as an event bus.  
> Stages `v1` through `v6` in `help-site/examples/` ([`chat-core.ts`](file:///media/data/programming/pi-spaces/help-site/examples/shared/chat-core.ts)), by contrast, demonstrate the **pure tuple-space architecture**, operating entirely without actor conversations.

---

## 2. Mechanism-by-Mechanism Comparison

### 2.1 Session Isolation and Multi-Conversations (Threads & Forking)

- **Earendil Reference**:
  - Every session URL routes to a dedicated Durable Object instance. Inside that instance, multiple `pi-durable` conversations (`tx.createConversation`, `tx.forkConversation`) are created.
  - **Advantage**: Each session has its own isolated SQLite database at the Cloudflare edge; `forkConversation` is a copy-on-write fork in the document tree with $O(1)$ overhead.
  - **Disadvantage**: Conversations within a large session can never be distributed across multiple nodes, and sessions remain rigid silos.
- **`pi-spaces` Implementation**:
  - Each session is a **named space (`NamedSpace`)** (or, in `v5`, a set of member spaces sharded via HRW by `threadId`). Threads and messages are standard `Thread` and `Msg` entries.
  - **Advantage**: Threads, messages, and pending tasks are regular space entries that can be queried via templates, filtered, archived (`archiveSpace`), and searched cluster-wide.
  - ✅ **$O(1)$ Pointer-Based Thread Forking (Tuple-Level Copy-on-Write):**  
    In [`chat-core.ts`](file:///media/data/programming/pi-spaces/help-site/examples/shared/chat-core.ts), `forkThread()` writes only the new `Thread` metadata entry (`parentThreadId`, `forkUpToSeq`) with 1 `RequestRef` claim ($O(1)$ space entries, zero physical duplication of inherited `Msg` entries). When reading or inspecting threads, `SpaceChatEngine.resolveMessagesForThread()` dynamically resolves inherited ancestor messages up to `forkUpToSeq` across the pointer chain.

---

### 2.2 Reconnect Idempotency (Command Receipts vs. `RequestRef` Claims)

- **Earendil Reference**:
  - Manually defines a custom `ConversationCommandReceipts` document to check whether `conversation.create` was already executed for a given `requestId` before a WebSocket drop.
  - **Disadvantage**: Application developers must design, write, and maintain custom receipt documents for every new command type.
- **`pi-spaces` Implementation**:
  - Uses **built-in core idempotency ([`src/claims.ts`](file:///media/data/programming/pi-spaces/src/claims.ts))**: Every mutating or blocking operation (`write`, `take`, `createTransaction`, `commit`, `abort`, `renew`, `cancel`, `wait`, `notify`) natively accepts `{ request: { principal, generation, requestId } }`.
  - **Advantage**: Universally available for every space operation out of the box, including canonical RFC-8785 argument hashing (`RequestConflict` thrown if retried with altered parameters), 24-hour retention, and `pollOperation` / `resolveOperation` across process restarts.
  - ✅ **Durable Admin Idempotency in Web Admin ([`admin-controller.ts`](file:///media/data/programming/pi-spaces/help-site/server/admin/admin-controller.ts)):** `#operations` is reconstructed at server boot from the durable `Result` entries in `CONTROL_SPACE`, ensuring retried `commandId` requests return their stored result even across process restarts.

---

### 2.3 Ordered Message Processing & Protection Against Incomplete Replies

- **Earendil Reference**:
  - Uses `conversation.submit({ ..., whenBusy: "followUp" })`. While the model is busy, incoming participant messages queue in the conversation's `pi-durable` inbox.
  - **Advantage**: Very concise code for simple 1:1 conversation loops.
  - **Disadvantage**: No declarative, data-layer-enforced contract verifying which result artifacts an external or custom worker must produce before completing a task.
- **`pi-spaces` Implementation**:
  - Submitting a message atomically writes the user `Msg` and a `ChatTask` entry inside a transaction. A worker exclusively reserves the `ChatTask` via `space.take(..., { txn })`.
  - **Advantage 1 (`CompletionProfile`)**: On `commit(txn)`, the space core enforces server-side that for every taken `ChatTask`, exactly one matching reply `Msg` carrying the same `taskId` and `threadId` was written in the same transaction (throwing `CompletionViolation` otherwise!).
  - **Advantage 2 (Worker Decoupling)**: Any number of heterogeneous workers (scripts, local models, remote GPU workers connected via `RemoteSpace`) can process `ChatTask` entries. If a worker crashes mid-generation, its transaction lease expires and the `ChatTask` automatically returns to the space.
  - ✅ **Missing/Deleted Target Handling in Social Swarm ([`swarm.ts`](file:///media/data/programming/pi-spaces/help-site/server/social/swarm.ts)):**  
    When a `like` task targets a missing post, the worker writes a short-lived `Like` dedup-ack entry (60s TTL, `dedup: true`), satisfying the `CompletionProfile` cleanly without retry loops.

---

### 2.4 Real-Time Streaming, Multiplayer Presence & Disconnect Behavior

- **Earendil Reference**:
  - Uses `watchEvents(harness, conversationId)` for token/transcript streaming and attaches participant metadata via `socket.serializeAttachment({ username, conversationId })` on Cloudflare WebSockets.
  - **Advantage**: Token-level streaming during model generation and seamless WebSocket hibernation via Cloudflare edge infrastructure.
  - **Disadvantage**: Presence is coupled to an individual object's WebSocket connection and is not queryable outside that object.
- **`pi-spaces` Implementation**:
  - Participant presence is a first-class **`Presence` entry in the space with a finite lease (e.g. 30 s)**, renewed via heartbeats (`space.renew`) and automatically reaped by `pi-spaces` upon client death.
  - State synchronization uses consistent point-in-time snapshots (`readPage` with `rev`) plus incremental commit deltas (`changes(afterRev)`) or durable consumer mailboxes (`events` + prefix `ack`).
  - **Advantage**: Presence is queryable state in the space and can be inspected across cluster nodes.
  - **Disadvantage / Realistic Boundary**: Because a tuple space publishes transactional entries upon commit, it is optimized for discrete messages rather than sub-millisecond character-by-character token streaming.
  - ⚠️ **Mobile Client Disconnect Behavior:** If a mobile client holding an active `take` transaction loses connection, the task remains locked in the space for the full duration of the transaction lease (e.g., 30–60 s) before other workers can re-claim it.
  - ✅ **Accurate Lease Expiry Tracking ([`chat-core.ts`](file:///media/data/programming/pi-spaces/help-site/examples/shared/chat-core.ts)):** `#presenceExpires` records the actual lease expiration returned by `space.write` and `space.renew`, accurately reflecting heartbeat extensions in snapshots.

---

### 2.5 Scheduled Tasks (`schedule` / Alarms)

- **Earendil Reference**:
  - A Durable Object provides **only a single hardware alarm** (`ctx.storage.setAlarm(timestamp)`). Applications must scan all tasks upon wakeup, compute the minimum deadline, and reprogram the DO alarm.
- **`pi-spaces` Implementation**:
  - A space natively manages **any number of independent leases and waiter deadlines concurrently**.
  - A scheduled reminder is created by writing a `ScheduledJob` entry (`FOREVER`) paired with a `TimerLock` entry (`lease = delayMs`).
  - When `TimerLock` expires, the reaper removes the lock and the job is transactionally transitioned into an executable `ChatTask`.
  - ✅ **Concurrent Multi-Alarm Processing ([`stage-runner.ts`](file:///media/data/programming/pi-spaces/help-site/server/space-chat/stage-runner.ts)):**  
    `tickAlarms()` drains all concurrently triggered alarms in a loop (`for (let i = 0; i < triggered.length; i++) await processNextChatTask()`).

---

### 2.6 Cross-Conversation Search via Subagent (`search_history`)

- **Earendil Reference**:
  - The `search_history` tool spawns a child conversation inside the same session database (`ownership: { kind: "task", taskId: api.taskId }`) and queries other conversations using indexed SQLite tables.
- **`pi-spaces` Implementation**:
  - The primary worker posts a `SearchTask` entry. An independent **Search Subagent Worker** takes the task, searches threads, writes `SubagentStep` entries, and commits the `SearchResult` under a secondary `CompletionProfile`.
  - **Advantage in Stages `v3`–`v5`**: The search subagent can execute as an isolated process on a dedicated server; in Stage `v5`, `federated.readAll` queries all member spaces across the cluster simultaneously.
  - ✅ **Domain-Neutral Stopword Fallbacks & Deduplicated Search:** Because `forkThread` references inherited messages by pointer rather than duplicating them physically, `readAll({ type: "Msg" })` scans only original messages without fork duplicates; pure stopword queries use domain-neutral fallback terms (`["space", "entry", "chat"]`).

---

### 2.7 High Availability, Replication & Disaster Recovery (AP3)

- **Earendil Reference**:
  - Relies completely on Cloudflare's proprietary internal storage replication. Developers have no control over replication topologies, split-brain fencing, or targeted standby promotions.
- **`pi-spaces` Implementation**:
  - Delivers a full-fledged, self-hosted high-availability architecture via **Primary/Sync Replication ([`src/primary-sync.ts`](file:///media/data/programming/pi-spaces/src/primary-sync.ts))** and **Replica Control ([`src/replica-control.ts`](file:///media/data/programming/pi-spaces/src/replica-control.ts))**:
    - **Deterministic Journaling:** Synchronous replication of commit intents to standby replicas before answering clients.
    - **Cryptographic Fencing & Boot Guards:** `SimulatorFencing`, Netcup SCP fencing ([`src/netcup-fencing.ts`](file:///media/data/programming/pi-spaces/src/netcup-fencing.ts)), and Container fencing ([`src/container-fencing.ts`](file:///media/data/programming/pi-spaces/src/container-fencing.ts)) ensure an isolated primary cannot execute rogue commits.
    - **Controlled Promotion & Degradation:** `promoteStandby` and `degradeToSingle` enable zero-data-loss failover with epoch fencing.

---

### 2.8 Cluster Transaction Boundaries in HRW Sharding (Stage v5)

- **Earendil Reference**:
  - Within a single session database, all tables and conversations can be updated atomically within a single local transaction.
- **`pi-spaces` Implementation**:
  - In a federated cluster (`FederatedSpace` with HRW sharding by `threadId`), threads are distributed across different member spaces.
  - ⚠️ **Hard Architectural Boundary:**  
    A transaction in `pi-spaces` is **strictly bound to exactly one member host**. Any attempt within a transaction to write entries destined for different HRW members fails with `RoutingConflict`.
  - **Developer Impact:** Multi-thread operations (such as merging threads or cross-thread batch modifications) cannot run in a single ACID transaction; they require asynchronous saga/task patterns.

---

## 3. Operational Control & Visibility: Specification vs. Reality

| Layer | Specified Target State (Docs) | Actual Implementation in Code | Status |
|---|---|---|---|
| **1. Space & Object Visibility** | Inspection via `listSpaces`, `readPage()`, `changes()` in Live Inspector, `AdminSpaces`, Dashboard, and TUI across all stages (`chat-session-stage-v1..v6`). | Fully functional including real stage snapshot materialization via `mirrorStageSnapshot`. | ✅ Works as documented. |
| **2. Space Lifecycle (`SpaceLifecycle`)** | `apply({ action: "create" \| "archive" \| "reactivate" \| "delete" })` manages spaces locally and across federation. | Backend and Web UI (`AdminSpacesView.tsx`) support all 4 actions including `deleteSpace`. | ✅ Works as documented. |
| **3. Worker Supervision (`WorkerSupervisor`)** | Dynamically starts/stops worker loops (`chat-worker`, `search-subagent`, `sieve`). | Works locally and in admin controller with shared `SIEVE_EXPORTER`. | ✅ Works as documented. |
| **4. Run Gating (`RunGate` / `RunController`)** | `RunController` gates execution with confirmed ACK barriers in Stage `v6`. | Fully implemented and documented in Stage `v6` and `WebAdminController`. | ✅ Works as documented. |
| **5. Bootstrap Config (`DeploymentController`)** | Declarative JSON schema provisions spaces and workers idempotently (in `AdminSpaces` Panel 7). | Fully implemented and tested (`test/test-deployment.test.ts`). | ✅ Works as documented. |

---

## 4. Real-World Trade-Offs of Stages `v1` to `v6`

### Stage `v1`: In-Memory Space (`MemoryStorage` + `PiSpaces`)
- **Pros:** Zero setup, instant boot (< 5 ms), identical transaction, $O(1)$ pointer thread forking, and `CompletionProfile` semantics.
- **Real Boundary:** Volatile; no `RunGate` active in chat.

### Stage `v2`: Local Durable Space (`SQLite` / `JSONL` + `PiSpaces`)
- **Pros:** Full local crash safety (ACID), persistent `RequestRef` claims, timer leases survive reboots.
- **Real Boundary:** Single-owner file locking; no multi-process access without a service layer.

### Stage `v3`: Decoupled Network Space (`SpaceService` + `RemoteSpace` over Socket/TCP)
- **Pros:** Clean process decoupling: host owns storage exclusively; web gateways and workers run as independent processes.
- **Real Boundary:** Serialization overhead; must handle `OutcomeUnknown` on socket drops during commit.

### Stage `v4`: Cryptographically Authenticated Space (`startGate` Layer A/B + 60s Grants)
- **Pros:** Zero-Trust via NetBird identity (Layer A) + Ed25519 challenge (Layer B); 60s short-lived grants; key rotation.
- **Real Boundary:** Requires key provisioning and boot-guard infrastructure.

### Stage `v5`: Federated Cluster (`FederatedSpace` + HRW Routing)
- **Pros:** Horizontal load distribution across member spaces by `threadId`; cluster-wide searches via `federated.readAll`.
- **Real Boundaries:**
  - No cross-member transactions (`RoutingConflict`).
  - In `v5-federated-cluster/run.ts`, the demo runner uses four in-process harnesses for zero-config execution (physical TCP federation tests live in `test/test-federation-runtime.test.ts`).

### Stage `v6`: Mobile & Web Administration (`RunGate` + Mobile Control)
- **Pros:** Unified control from Android phone (`spaces.html`/`steuerung.html`) and web (`AdminSpacesView`). Coordinated run barriers via `RunController`.
- **Real Boundary:** Requires coordinator host topology to operate.

---

## 5. Summary Decision Matrix

| Criterion / Scenario | Recommendation: Earendil Cloudflare DO | Recommendation: `pi-spaces` (`v1`–`v6`) |
|---|---|---|
| **Serverless scale-to-zero for thousands of idle sessions** | **Ideal**: Durable Objects hibernate for free and wake up in milliseconds. | Less suitable: Space hosts run as persistent server processes. |
| **Data sovereignty, on-premise, Linux VPS, Docker, or offline** | Not possible (tied to proprietary Cloudflare infrastructure). | **Ideal (`v1`–`v6`)**: Completely self-hosted on Node.js + SQLite without cloud dependencies. |
| **Strict server-enforced result contracts for AI workers** | Not native; requires custom validation in application logic. | **Ideal**: Server-side `CompletionProfiles` with automatic task reclamation on lease expiry. |
| **Horizontal scaling of large rooms across multiple hosts** | Not possible (a session is confined to a single Durable Object). | **Ideal (`v5`)**: Deterministic HRW sharding distributes threads across multiple hosts. |
| **Auditable high availability and disaster recovery (AP3)** | Proprietary cloud black box. | **Ideal**: Complete transparency with primary-sync journals, fencing, and standby promotion. |
| **Token-by-token streaming (< 10 ms)** | **Ideal**: `watchEvents` streams uncommitted tokens directly from the model. | Not designed for this: Optimized for discrete transactional state transitions upon commit. |
| **Fast thread forking with large history (> 10,000 msgs)** | **Ideal**: $O(1)$ copy-on-write in the document tree. | **Ideal**: $O(1)$ pointer-based copy-on-write resolution (`parentThreadId` + `forkUpToSeq`). |

---

## 6. Documented Gaps & Implementation Status

| ID | Component | Identified Gap / Bug | Status & Resolution |
|---|---|---|---|
| **GAP-1** | `chat-core.ts` | **$O(N)$ Thread Forking Duplication**: Inherited messages were physically re-written one by one. | ✅ **RESOLVED**: `forkThread` writes only the `Thread` entry ($O(1)$); `SpaceChatEngine.resolveMessagesForThread` dynamically resolves ancestor messages up to `forkUpToSeq` via pointer chain. |
| **GAP-2** | Docs / Stages | **`RunGate` availability claimed from v1**: Chat stages v1–v5 contain no `RunGate`. | ✅ **RESOLVED**: Documentation and comparison tables updated (`RunGate` clarified as Stage `v6` capability). |
| **GAP-3** | `stage-runner.ts` | **Dropped multi-alarm processing**: `tickAlarms()` yielded N alarms but triggered only 1 task execution. | ✅ **RESOLVED**: Loop over all fired alarm IDs implemented in `stage-runner.ts`. |
| **GAP-4** | `chat-core.ts` / `swarm.ts` | **Unindexed scans & stopword fallback**: Fallback queried "postgresql"; missing template filters in `swarm.ts`. | ✅ **RESOLVED**: Neutral fallback terms `["space", "entry", "chat"]`; targeted space template filters in `swarm.ts`. |
| **GAP-5** | Docs | **Missing replication coverage (AP3)**: Primary/Sync replication omitted from comparison. | ✅ **RESOLVED**: Added Section 2.7 covering AP3 Primary/Sync replication, fencing, and promotion. |
| **GAP-6** | `AdminSpacesView`| **Missing delete action in UI**: `deleteSpace` existed in backend API but was missing from frontend buttons. | ✅ **RESOLVED**: Added delete button with confirmation dialog in `AdminSpacesView.tsx`. |
| **GAP-7** | `admin-controller`| **Volatile idempotency**: Admin operations stored only in volatile map. | ✅ **RESOLVED**: `#operations` is reconstructed at boot from durable `Result` entries in `CONTROL_SPACE`. |
| **GAP-8** | `v5-cluster` | **In-process demo runner**: `v5-federated-cluster` uses 4 memory harnesses for zero-setup execution. | ℹ️ **Design Choice**: Fast in-process runner for interactive help workbench; physical TCP federation tests run in `test/test-federation-runtime.test.ts`. |
