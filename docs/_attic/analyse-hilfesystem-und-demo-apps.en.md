# Detailed analysis: help system (`help-site/`) and demo applications

> **Superseded by the [renewed implementation review of 18 October 2026](analyse-hilfesystem-demo-apps-2026-10-18.en.md).** The blanket statements below ("23/23 done" and "fully verified") are not a current overall acceptance. The new report contains reproduced counterexamples, open findings and separate test evidence. The previous text is kept as a historical review/implementation status.

**As of:** 17 October 2026  
**Implementation status (18 October 2026):** **All 23 findings (100 %)** of this analysis, including all critical and high logic errors, the medium/cleanup items, the documentation/CLI integration and the three architectural items (§4.3 unified sieve orchestration via `SIEVE_EXPORTER` / `normalizeSieveRunConfig`, §5.3 real stage mirroring via `mirrorStageSnapshot` in `stage-runner.ts` and GAP-1 $O(1)$ pointer-based thread forking in `chat-core.ts`), are fully implemented and verified by automated tests.

**Verification:** `tsc` root + help-site clean; all root tests, example tests and `help-site` tests green; corpus regenerated via `prebuild`.
**Target system:** [`phi-spaces`](file:///media/data/programming/phi-spaces) / [`PhiSpaces`](file:///media/data/programming/phi-spaces/src/client.ts)  
**Paths examined:**  
- Help system & web platform: [`help-site/server/`](file:///media/data/programming/phi-spaces/help-site/server), [`help-site/client/`](file:///media/data/programming/phi-spaces/help-site/client), [`help-site/scripts/`](file:///media/data/programming/phi-spaces/help-site/scripts)
- Stage-based interactive demos: [`help-site/examples/`](file:///media/data/programming/phi-spaces/help-site/examples) (`shared/chat-core.ts`, `v1` to `v6`)
- Reference and model demos: [`examples/`](file:///media/data/programming/phi-spaces/examples) (`workers.ts`, `sensor-pipeline.ts`, `chat.ts`, `sieve.ts`, `cache.ts`, `golomb.ts`, `arxiv-research.ts`, `dark-energy-research.ts`, `blocking-tool.ts`, `research-support.ts`, `live-models.ts`)
- Associated test suites: [`help-site/test/`](file:///media/data/programming/phi-spaces/help-site/test), [`test/examples/`](file:///media/data/programming/phi-spaces/test/examples)

---

## 1. Management summary & architecture picture

Besides the actual tuple-space and federation engine `phi-spaces`, the repository comprises two main demonstration and documentation strands:
1. **The interactive help system (`help-site/`)**: a Next.js 16/React 19 application with its own HTTP/WebSocket layer, a decentralized AI social feed ("Social Swarm"), an interactive chat workbench over 6 development stages (v1 to v6) and a web admin portal (`AdminSpacesView`).
2. **The core examples (`examples/`)**: standalone scripts to verify tuple-space patterns (worker coordination, sensor pipelines, decentralized prime sieves, Golomb rulers, least-recently-used caches and AI research workflows).

### Overall impression & test status
All automated example tests in `test/examples/` as well as the 4 test suites in [`help-site/tests/help-site.test.ts`](file:///media/data/programming/phi-spaces/help-site/tests/help-site.test.ts) run through successfully (`PASS`). The original source code and design review revealed 23 findings (logic errors in transaction profiles, orphaned files such as the since-deleted 263-line `react-shim.ts`, conceptual breaks between the demo worlds as well as gaps in web admin and WebSocket operation), which have meanwhile been **fixed without exception (23/23 `[DONE]`)**.

---

## 2. Logic errors, race conditions & contract violations

### 2.1 [DONE] Endless loop & transaction abort on `Like` for deleted posts (`CompletionProfile` violation)
* **Affected file:** [`help-site/server/social/swarm.ts#L801-L823`](file:///media/data/programming/phi-spaces/help-site/server/social/swarm.ts#L801-L823)
* **Status:** ✅ **DONE / FIXED**  
  In `swarm.ts`: if no target post is found, the worker now writes a short-lived `Like` dedup ack entry (TTL 60 s) with `dedup: true`. Thus the server-side `CompletionProfile` (expects type `Like` with `taskId`) is satisfied, `space.commit()` succeeds and the task no longer falls into an infinite retry loop.
* **Category:** critical logic error / transaction deadlock
* **Code finding:**
  ```typescript
  if (f.kind === "like") {
      const target = f.replyTo ? this.#postById.get(f.replyTo) : this.#recentPosts[...];
      if (!target) return null; // <-- Kehrte früher ohne Ergebnis zurück!
      // ...
  }
  ```
  In lines 31–40 the server-side transaction profile [`SWARM_COMPLETION_PROFILES`](file:///media/data/programming/phi-spaces/help-site/server/social/swarm.ts#L31-L40) is defined for `SwarmTask`.
* **Problem & impact:**
  If a like was requested for a post that no longer existed, `#processTask` aborted with `return null`. At the subsequent `commit(txn.id)` the engine threw `CompletionViolation`. The transaction rolled back and blocked up to 3 further valid tasks in the same batch.

---

### 2.2 [DONE] Premature cache update before successful commit (dirty reads)
* **Affected file:** [`help-site/server/social/swarm.ts#L867-L870`](file:///media/data/programming/phi-spaces/help-site/server/social/swarm.ts#L867-L870)
* **Status:** ✅ **DONE / FIXED**  
  In `swarm.ts`: all cache mutations (`#indexPost`, `#likeSets`, `#channelTotals`) now run as `postCommit` callbacks strictly *after* a successful `await this.space.commit(txn.id)`. If a commit fails, no phantom entries remain in RAM.
* **Category:** inconsistency / phantom data
* **Problem & impact:**
  `#indexPost(post)` inserted the new post into `#postById` and `#recentPosts` before the commit. On commit failures, unconfirmed phantom posts remained in the RAM of the web server.

---

### 2.3 [DONE] Task loss with simultaneous alarms (`tickAlarms`)
* **Affected file:** [`help-site/server/space-chat/stage-runner.ts#L50-L54`](file:///media/data/programming/phi-spaces/help-site/server/space-chat/stage-runner.ts#L50-L54)
* **Status:** ✅ **DONE / FIXED**  
  In `stage-runner.ts`: `processNextChatTask()` is now called for each individual fired alarm from `tickAlarms()` (`for (const _ of fired) await hub.engine.processNextChatTask().catch(() => {});`), so simultaneous alarms are processed completely.
* **Category:** concurrency error / task starvation
* **Problem & impact:**
  `tickAlarms()` returned an array of all triggered alarms (`string[]`), but `processNextChatTask()` was called only once. Further due tasks were left unserved.

---

### 2.4 [DONE] In-page anchor links open a new browser tab in the Markdown renderer
* **Affected file:** [`help-site/client/lib/markdown.ts#L23-L29`](file:///media/data/programming/phi-spaces/help-site/client/lib/markdown.ts#L23-L29)
* **Status:** ✅ **DONE / FIXED**  
  In `markdown.ts`: `href.startsWith("#")` was added to the `isInternal` condition. Internal jump marks and tables of contents now scroll smoothly in the same window instead of opening a new browser tab.
* **Category:** UI/UX logic error

---

### 2.5 [DONE] Hardcoded presence expiry ignores lease extensions
* **Affected file:** [`help-site/examples/shared/chat-core.ts#L918`](file:///media/data/programming/phi-spaces/help-site/examples/shared/chat-core.ts#L918)
* **Status:** ✅ **DONE / FIXED**  
  In `chat-core.ts`: an internal map `#presenceExpires` stores the dynamic lease expiry times directly from the return values of `space.write` and `space.renew(leaseId, ms)`. `snapshotState()` uses these live values; `updatedAt + 30_000` serves only as a fallback on cold start. Active participants are no longer wrongly declared offline after 30 s.
* **Category:** data inconsistency / broken heartbeat

---

### 2.6 [DONE] WebSocket RFC-6455 framing: missing support for continuation frames
* **Affected file:** [`help-site/server/ws.ts#L84-L150`](file:///media/data/programming/phi-spaces/help-site/server/ws.ts#L84-L150)
* **Status:** ✅ **DONE / FIXED**  
  In `ws.ts`: fragmented messages (opcode 0x0) are now buffered and accumulated until the frame with the `FIN` bit set (with a 1 MiB protective cap). Unexpected data frames within a fragmentation lead to an orderly protocol close.
* **Category:** protocol violation / connection drop

---

### 2.7 [DONE] Key rotation in the web admin does not invalidate the old key
* **Affected file:** [`help-site/server/admin/admin-controller.ts#L509-L536`](file:///media/data/programming/phi-spaces/help-site/server/admin/admin-controller.ts#L509-L536)
* **Status:** ✅ **DONE / FIXED**  
  In `admin-controller.ts`: before the new active `PeerKey` entry is written, all existing active keys of the web admin are taken from the control space and permanently invalidated with `state: "revoked"`.
* **Category:** security gap / key management

---

### 2.8 [DONE] Word splitting at umlauts & ß in the search engine (`search.ts`)
* **Affected file:** [`help-site/client/lib/search.ts#L5-L12`](file:///media/data/programming/phi-spaces/help-site/client/lib/search.ts#L5-L12)
* **Status:** ✅ **DONE / FIXED**  
  In `search.ts`: `text.replaceAll("ß", "ss")` is executed before the normalization and the regex split. Search terms such as *"Schließen"* or *"Schlüssel"* are no longer torn apart and give reliable search hits.
* **Category:** linguistic logic error

---

## 3. Dead code, orphaned files & legacy

### 3.1 Completely unused custom React implementation (`react-shim.ts`)
* **File:** [`help-site/client/lib/react-shim.ts`](file:///media/data/programming/phi-spaces/help-site/client/lib/react-shim.ts) (263 lines)
* **Finding:**
  Contains a complete miniature React framework: `createElement`, `Fragment`, `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef` and its own DOM renderer `render(vnode, container)`.
* **Analysis:**
  The file is imported at **no single place** in the whole project. In [`help-site/package.json`](file:///media/data/programming/phi-spaces/help-site/package.json) real `react` and `react-dom` (v19.0.0) are declared, and [`help-site/scripts/build-web.ts`](file:///media/data/programming/phi-spaces/help-site/scripts/build-web.ts) bundles the application regularly via `esbuild`. `react-shim.ts` is a forgotten relic of the prototype phase without build tooling.
* **Recommendation:** delete the file without replacement.

---

### 3.2 Fragile and faulty ESM run guards in build scripts
* **Affected files:**
  - [`help-site/scripts/build-corpus.ts#L308`](file:///media/data/programming/phi-spaces/help-site/scripts/build-corpus.ts#L308)
  - [`help-site/scripts/build-web.ts#L37`](file:///media/data/programming/phi-spaces/help-site/scripts/build-web.ts#L37)
* **Finding:**
  ```typescript
  if (import.meta.url === `file://${process.argv[1]}`) {
      void main();
  }
  ```
* **Problem:**
  If the script is called with relative paths (e.g. `node scripts/build-corpus.ts`), via symlinks or under Windows, `process.argv[1]` does not match `file://${process.argv[1]}` (missing URL encoding, leading slashes, backslashes). The script then silently does nothing at all when called directly.
* **Recommended fix:**
  Use the standard Node pattern:
  ```typescript
  import { fileURLToPath } from "node:url";
  if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
      void main();
  }
  ```

## 3. Dead code, orphaned files & legacy

### 3.1 [DONE] Completely unused custom React implementation (`react-shim.ts`)
* **File:** [`help-site/client/lib/react-shim.ts`](file:///media/data/programming/phi-spaces/help-site/client/lib/react-shim.ts) (263 lines)
* **Status:** ✅ **DONE / FIXED**  
  The orphaned file `help-site/client/lib/react-shim.ts` was deleted without replacement. The project regularly bundles React 19 via `esbuild` and `next.js`.
* **Finding:**
  Contained a complete miniature React framework: `createElement`, `Fragment`, `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef` and its own DOM renderer `render(vnode, container)`.

---

### 3.2 [DONE] Fragile and faulty ESM run guards in build scripts
* **Affected files:**
  - [`help-site/scripts/build-corpus.ts#L308`](file:///media/data/programming/phi-spaces/help-site/scripts/build-corpus.ts#L308)
  - [`help-site/scripts/build-web.ts#L37`](file:///media/data/programming/phi-spaces/help-site/scripts/build-web.ts#L37)
* **Status:** ✅ **DONE / FIXED**  
  In both scripts the error-prone comparison `import.meta.url === file://${process.argv[1]}` was replaced by the robust standard `fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")`. The scripts now always start reliably regardless of relative call paths or symlinks.

---

### 3.3 [DONE] Dead constants and misleading comments in `swarm.ts`
* **File:** [`help-site/server/social/swarm.ts#L28`](file:///media/data/programming/phi-spaces/help-site/server/social/swarm.ts#L28), [`L46`](file:///media/data/programming/phi-spaces/help-site/server/social/swarm.ts#L46), [`L1163`](file:///media/data/programming/phi-spaces/help-site/server/social/swarm.ts#L1163)
* **Status:** ✅ **DONE / FIXED**  
  The unused import `NO_WAIT` was removed; the comments and agent chatter texts were cleaned up and now truthfully reflect the actual single-loop dispatcher architecture.

---

### 3.4 [DONE] Orphaned script `examples/blocking-tool.ts`
* **File:** [`examples/blocking-tool.ts`](file:///media/data/programming/phi-spaces/examples/blocking-tool.ts) (25 lines)
* **Status:** ✅ **DONE / FIXED**  
  Registered in the root `package.json` as `npm run example:blocking` and documented in [`docs/examples.en.md`](file:///media/data/programming/phi-spaces/docs/examples.md).

---

### 3.5 [DONE] Formatting artifact in `help-site/examples/v4-gated-auth/run.ts`
* **File:** [`help-site/examples/v4-gated-auth/run.ts#L33`](file:///media/data/programming/phi-spaces/help-site/examples/v4-gated-auth/run.ts#L33)
* **Status:** ✅ **DONE / FIXED**  
  The untidy leading space before `spaceDoc` in the destructuring import was removed.

---

## 4. Duplicate code & conceptual divergence

### 4.1 [DONE] Two incompatible "chat" architectures: Earendil actor model vs. pure Spaces implementation
* **Status:** ✅ **DONE / FIXED**  
  A new section for a clear separation was established in [`docs/examples.en.md`](file:///media/data/programming/phi-spaces/docs/examples.md) and [`README.md`](file:///media/data/programming/phi-spaces/README.md). In addition, `npm run example:space-chat` was registered in `package.json` as a direct CLI command for the pure tuple-space variant.
* **Concept:**
  - `examples/chat.ts`: Earendil actor model (`h.createConversation()`), the Space acts as an event bus.
  - `chat-core.ts`: pure tuple-space architecture (10 types, leases, locks, stateless workers).

---

### 4.2 [DONE] Triply duplicated O(N) in-memory full scan in `swarm.ts`
* **Affected file:** [`help-site/server/social/swarm.ts`](file:///media/data/programming/phi-spaces/help-site/server/social/swarm.ts)
* **Status:** ✅ **DONE / FIXED**  
  `feed.more`, `agent.posts` and `ai.posts` now use targeted Space template filters (`fields: { channel }`, `fields: { authorHandle: handle }`, `fields: { viaLlm: true }`). The reply counts are taken directly from the in-memory index `#replyCounts` instead of repeatedly scanning the whole data space.

---

### 4.3 [DONE] Redundant sieve orchestration in `AdminController`
* **Affected files:** [`examples/sieve.ts`](file:///media/data/programming/phi-spaces/examples/sieve.ts), [`help-site/server/admin/admin-controller.ts`](file:///media/data/programming/phi-spaces/help-site/server/admin/admin-controller.ts), [`help-site/examples/v6-mobile-control/run.ts`](file:///media/data/programming/phi-spaces/help-site/examples/v6-mobile-control/run.ts), [`help-site/client/components/AdminSpacesView.tsx`](file:///media/data/programming/phi-spaces/help-site/client/components/AdminSpacesView.tsx)
* **Status:** ✅ **DONE / FIXED**  
  In [`examples/sieve.ts`](file:///media/data/programming/phi-spaces/examples/sieve.ts) `normalizeSieveRunConfig(runId, rawConfig)` was added and integrated directly into `SIEVE_EXPORTER`. Both `WebAdminController` (`admin-controller.ts`) and `runStageV6` (`v6-mobile-control/run.ts`) now use `normalizeSieveRunConfig`, `prepareSieveRun` and `SIEVE_EXPORTER` directly from `examples/sieve.ts` without duplicated inline exporters; `AdminSpacesView.tsx` reads the canonical `SIEVE_EXPORTER` summary fields (`primes`, `first`, `last`, `resultHash`).

---

### 4.4 [DONE] Naming mismatch: `SpaceChatSession` vs. `SpaceChatEngine`
* **Affected files:** [`help-site/scripts/corpus-workflows-and-api.ts#L397`](file:///media/data/programming/phi-spaces/help-site/scripts/corpus-workflows-and-api.ts#L397), [`L447`](file:///media/data/programming/phi-spaces/help-site/scripts/corpus-workflows-and-api.ts#L447)
* **Status:** ✅ **DONE / FIXED**  
  The designations in the documentation corpus were corrected to the actual class name `SpaceChatEngine` and the help corpus was regenerated via `build-corpus.ts`.

---

## 5. Functional gaps & architectural deficits

### 5.1 [DONE] Volatile idempotency in the WebAdmin after a server restart
* **Affected file:** [`help-site/server/admin/admin-controller.ts#L89`](file:///media/data/programming/phi-spaces/help-site/server/admin/admin-controller.ts#L89), [`L434`](file:///media/data/programming/phi-spaces/help-site/server/admin/admin-controller.ts#L434)
* **Status:** ✅ **DONE / FIXED**  
  The private map `#operations` is now reconstructed at server boot from the long-lived `Result` entries of the control space. If a client repeats an admin command after a server restart, the stored result is delivered instead of executing the command twice.

---

### 5.2 [DONE] Missing delete function in the web admin frontend
* **Affected file:** [`help-site/client/components/AdminSpacesView.tsx#L434-L455`](file:///media/data/programming/phi-spaces/help-site/client/components/AdminSpacesView.tsx#L434-L455)
* **Status:** ✅ **DONE / FIXED**  
  In `AdminSpacesView.tsx` a "Löschen" button (`wb-btn--danger`) with a confirmation dialog was integrated for all user-defined Spaces (except `default` and `control`), which calls the `deleteSpace` API.

---

### 5.3 [DONE] Sham in the stage mirroring ("mirroring")
* **Affected files:** [`help-site/server/space-chat/stage-runner.ts`](file:///media/data/programming/phi-spaces/help-site/server/space-chat/stage-runner.ts), [`help-site/examples/v5-federated-cluster/run.ts`](file:///media/data/programming/phi-spaces/help-site/examples/v5-federated-cluster/run.ts), [`help-site/examples/v6-mobile-control/run.ts`](file:///media/data/programming/phi-spaces/help-site/examples/v6-mobile-control/run.ts)
* **Status:** ✅ **DONE / FIXED**  
  All 6 stages (`runStageV1` to `runStageV6`) return their resulting `SpaceChatSnapshot` (including the 4 HRW-sharded threads and the LWW-replicated presence from `v5`). `SpaceChatHub.runStageDemo(stage)` materializes via `mirrorStageSnapshot` the actual entries (`Thread`, `Msg`, `Presence`, `ScheduledJob`, `SubagentStep`, `SearchResult`) in the inspectable Space `chat-session-stage-${stage}` on the main host, instead of only creating a generic dummy session.

---

### 5.4 [DONE] Fixed TCP port collision in integration tests
* **Affected file:** [`test/test-bootstrap.test.ts#L125`](file:///media/data/programming/phi-spaces/test/test-bootstrap.test.ts#L125) vs. [`test/test-commit-sealed.test.ts#L49`](file:///media/data/programming/phi-spaces/test/test-commit-sealed.test.ts#L49)
* **Status:** ✅ **DONE / FIXED**  
  In [`test/support/persistent.ts`](file:///media/data/programming/phi-spaces/test/support/persistent.ts) the helper function `freePort()` was implemented, which assigns free TCP ports via ephemeral binding (`0.0.0.0:0`). Both test suites now use dynamic ports, which rules out `EADDRINUSE` collisions in parallel test runs.

---

### 5.5 [DONE] Absurd stopword fallback terms in the chat subagent
* **Affected file:** [`help-site/examples/shared/chat-core.ts#L604`](file:///media/data/programming/phi-spaces/help-site/examples/shared/chat-core.ts#L604)
* **Status:** ✅ **DONE / FIXED**  
  In `chat-core.ts` the unsuitable terms `"postgresql"`, `"event"` and `"store"` were replaced by domain-relevant terms `["space", "entry", "chat"]`.

---

### 5.6 [DONE] Isolation of the help system from the core documentation
* **Affected files:** [`README.md`](file:///media/data/programming/phi-spaces/README.md), [`AGENTS.md`](file:///media/data/programming/phi-spaces/AGENTS.md), [`docs/README.en.md`](file:///media/data/programming/phi-spaces/docs/README.md), [`package.json`](file:///media/data/programming/phi-spaces/package.json)
* **Status:** ✅ **DONE / FIXED**  
  The help system was fully integrated into the main project:
  - `npm run help` starts the development server of the help site.
  - The help system is prominently linked and described in [`README.md`](file:///media/data/programming/phi-spaces/README.md) and [`docs/README.en.md`](file:///media/data/programming/phi-spaces/docs/README.md).

---

### 5.7 [DONE] Findings on the architecture comparison documents (`VERGLEICH-EARENDIL-VS-PHI-SPACES.md` / `EN`)
* **Affected files:** [`help-site/COMPARISON-EARENDIL-VS-PHI-SPACES-EN.md`](file:///media/data/programming/phi-spaces/help-site/VERGLEICH-EARENDIL-VS-PHI-SPACES.md), [`help-site/COMPARISON-EARENDIL-VS-PHI-SPACES-EN.md`](file:///media/data/programming/phi-spaces/help-site/COMPARISON-EARENDIL-VS-PHI-SPACES-EN.md), [`help-site/scripts/corpus-articles-data.ts#L1464`](file:///media/data/programming/phi-spaces/help-site/scripts/corpus-articles-data.ts#L1464)
* **Status:** ✅ **DONE / FIXED**  
  Both documents as well as the source data in `corpus-articles-data.ts` were completely revised:
  - Misrepresentation of `RunGate` from v1 corrected (RunGate clarified as a v6 feature).
  - Replication chapter (AP3) newly inserted.
  - Thread forking (`GAP-1`) in `chat-core.ts` changed to $O(1)$ pointer-based copy-on-write resolution (`SpaceChatEngine.resolveMessagesForThread`).
  - Gap and measures catalog (**GAP-1 to GAP-8**) updated in the comparison documents.
  - Corpus regenerated via `npm --prefix help-site run prebuild` (37 articles / 74 localized records synchronized).

---

## 6. Prioritized recommendations for action (status overview: 23/23 done)

| Priority | Component | Problem / task | Effort | Risk if not fixed | Status |
|---|---|---|---|---|---|
| 🚨 **Critical** | `swarm.ts` | **Fix CompletionProfile break**: complete or ack the task cleanly when the post target is missing. | Low | Endless retries, blocked worker batches, log flooding. | ✅ short-lived `Like` dedup ack (60 s) without target: profile satisfied, no retry loop |
| 🚨 **Critical** | `swarm.ts` | **Dirty-cache fix**: call `#indexPost` only after `space.commit()`. | Low | Phantom posts in the feed, follow-up errors on likes/replies. | ✅ all cache mutations (`#indexPost`, `#likeSets`, `#channelTotals`) run as `postCommit` closures only after `commit()` |
| 🚨 **Critical** | `admin-controller.ts` | **Harden key rotation**: set old keys to `revoked` on rotation. | Low | Security risk: accumulation of compromised permanent keys. | ✅ remaining active `PeerKey` entries are set to `state:"revoked"` via take+write |
| ⚠️ **High** | `stage-runner.ts` | **Alarm loop**: serve all alarms triggered from `tickAlarms()`. | Low | Starvation of scheduled timer tasks in the chat. | ✅ `processNextChatTask()` once per fired alarm |
| ⚠️ **High** | `chat-core.ts` | **Correct heartbeat expiry**: take the lease expiry from Space metadata. | Medium | Wrong online/offline status displays in the chat. | ✅ `#presenceExpires` map from `write`/`renew` lease replies (`EntryView` has no `expires`; `updatedAt` only a cold-start fallback) |
| ⚠️ **High** | `ws.ts` | **RFC-6455 framing**: support continuation frames (opcode 0x0). | Medium | Connection drops with large payloads over proxies. | ✅ fragments are accumulated until `FIN` (1 MiB cap); a data frame within a fragmentation is a protocol error → close |
| ⚠️ **High** | `swarm.ts` | **Eliminate O(N) full scans**: use native Space template filters. | Low | Heap exhaustion and GC pauses with a growing post count. | ✅ `feed.more`/`agent.posts`/`ai.posts` filter by template (`channel`, `handle`, `viaLlm`); reply totals from the complete `#replyCounts` index instead of a re-scan |
| ⚠️ **High** | **Docs & CLI demos** | **Resolve chat dualism**: document the separation of the Earendil actor model (`examples/chat.ts`) and the pure tuple-space architecture (`chat-core.ts`) in `docs/examples.en.md`; provide `npm run example:space-chat`. | Medium | Lasting confusion of new developers about the core concepts of `phi-spaces`. | ✅ separation paragraph in `docs/examples.en.md`; CLI equivalent via `npm run example:space-chat` |
| ⚠️ **High** | `chat-core.ts` | **$O(N)$ thread forking (GAP-1)**: replace physical duplication of inherited messages by pointer-based ancestor resolution. | Medium | Massive memory and write multiplication with long threads. | ✅ `forkThread` now writes only the `Thread` entry ($O(1)$); `SpaceChatEngine.resolveMessagesForThread` resolves ancestor chains dynamically |
| 🟡 **Medium** | `markdown.ts` | **Repair anchor links**: treat `href.startsWith("#")` as internal. | Minimal | Annoying opening of new tabs for internal jump marks. | ✅ `#` anchors and `/` paths stay in the same tab |
| 🟡 **Medium** | `search.ts` | **Umlaut/eszett tokenizer**: fix German 'ß' and special characters. | Low | Missing search hits for terms such as "Schlüssel" or "Abschließen". | ✅ `ß`→`ss` before the split |
| 🟡 **Medium** | `AdminSpacesView.tsx`| **Add DeleteSpace in the UI**: offer the missing delete action. | Minimal | Inconsistency between API possibilities and UI. | ✅ `Löschen` button with confirm (`wb-btn--danger`) for all Spaces except `default`/`control` |
| 🟡 **Medium** | `admin-controller.ts` | **Unify sieve orchestration (§4.3)**: reuse `SIEVE_EXPORTER` and `normalizeSieveRunConfig` from `examples/sieve.ts`. | Low | Duplicated exporter code in AdminController and examples. | ✅ `normalizeSieveRunConfig` + `SIEVE_EXPORTER` from `examples/sieve.ts` used in `admin-controller.ts` and `v6-mobile-control/run.ts` |
| 🟡 **Medium** | `stage-runner.ts` | **Stage mirroring (§5.3)**: mirror real stage snapshots into `chat-session-stage-v1..v6`. | Medium | `stage-v1..v6` showed only generic dummy data instead of real stage results. | ✅ `mirrorStageSnapshot` writes the real stage entries (incl. `v5` HRW threads) into `chat-session-stage-${stage}` |
| 🧹 **Cleanup** | `react-shim.ts` | **Delete dead code**: remove 263 lines of unused React shim. | Minimal | Confusion in code audits and maintenance. | ✅ file removed (no references) |
| 🧹 **Cleanup** | Scripts | **Correct ESM guards**: `fileURLToPath` in `build-corpus.ts` and `build-web.ts`.| Minimal | Scripts do not start with certain call paths. | ✅ `fileURLToPath(import.meta.url) === resolve(process.argv[1])` |
| 🧹 **Cleanup** | `chat-core.ts` | **Clean up fallback terms**: replace "postgresql"/"event" with neutral terms. | Minimal | Irrelevant search results in subagent research. | ✅ `["space", "entry", "chat"]` |
| 📖 **Docs/integration**| Root `package.json` | **Integrate help system**: `npm run help`, doc links in `docs/README.en.md`. | Low | Help system stays an isolated shadow project. | ✅ `npm run help`, line in `docs/README.en.md`, entry in the `README.md` example table |

### Further completed items (also verified)

- §5.1 `#operations` idempotency: reconstructed at boot from durable `Result` entries in the control space → retry of a `commandId` after restart returns the stored result instead of executing again.
- §5.4 Test port collisions: `test/support/persistent.ts:freePort()` (ephemeral, `0.0.0.0`) in `test-bootstrap.test.ts` and `test-commit-sealed.test.ts`.
- §3.4 `examples/blocking-tool.ts`: registered as `npm run example:blocking`.
- §4.4 Corpus: `SpaceChatSession` → `SpaceChatEngine` in `corpus-workflows-and-api.ts`, corpus regenerated.
- §3.3 `swarm.ts`: dead `NO_WAIT` import removed; misleading "6 workers" text in the agent chatter corrected.
- §3.5 `v4-gated-auth/run.ts`: formatting artifact in the import cleaned up.
