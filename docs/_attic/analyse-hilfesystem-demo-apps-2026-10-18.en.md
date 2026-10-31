# Help system and demo apps: renewed implementation review

As of 18 October 2026. Basis: commit `44a924a35422fd903b6f93694f5593cc1e6c2b7b` **including the existing, uncommitted working state**. In particular `help-site/` and the previous analysis were unversioned; root code and documentation already contained changes.

## 1. Result and scope

The original review refuted the statement "all 23 findings fully implemented and verified by automated tests" in the [previous analysis](analyse-hilfesystem-und-demo-apps.en.md). **Implementation status: 23 of 23 findings done (F01–F23). The current implementation status with evidence and limits is in section 7.** The done markers refer to the fixes and local evidence described there. Sections 2–6 document the initial findings and the evidence available at the time; their line references and historical open markers are not a renewed description of the code as now changed. The explicitly named evidence and operating limits remain.

The highest priorities of the initial review were (since done):

1. Chat messages submitted in parallel receive the same sequence number; the snapshot resolution then hides one of them.
2. The Markdown renderer gets stuck in an endless loop on unsupported headings and certain text lines.
3. Admin replay reconstructs a success status without a result after a controller restart; crash window, concurrent commands and binding to command arguments are still insufficiently secured.
4. Scheduled run actions have no execution loop in the help system. Persisted worker assignments are also not applied automatically at start.
5. Enrollment tokens in the web login lose their expiry and role binding; a fixed default password remains active as a fallback.

Examined were the HTTP/WebSocket server, AdminController, SocialSwarm, chat hub and chat engine, stages v1–v6, Markdown/search/article navigation, corpus build as well as the root examples and their tests. The examination is a static review with targeted local reproductions and existing tests. It is no complete security certification, no browser E2E acceptance and no acceptance of the production server or external hosts. No live models were called.

### Evidence classes and priorities

- **R:** reproduced locally, with actual implementations or a bounded child process.
- **S:** demonstrated from current code and call path; the concrete failure sequence was not run separately.
- **L:** clearly delimited architecture, operations or test gap, no claim of an already observed production outage.
- **P1:** fix before a reliable multi-user/operations release; **P2:** correctness or maintainability substantially affected; **P3:** cleanup/clarification.

## 2. Logic errors and functional gaps

### F01 — P1 / R: sequence assignment loses messages in the display

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/examples/shared/chat-core.ts:368`, `:404`, `:860`, `:342`.

`nextSeqForThread()` reads the previous maximum outside the writing transaction. Two `submitMessage()` calls can read the same value. Two reply workers also share no sequence lock. The transactions each protect Msg plus ChatTask, but not the shared sequence assignment. `resolveMessagesForThread()` then uses a map with `seq` as the key and overwrites equally numbered messages.

**Reproduction:** An empty thread, then `Promise.all()` over two submits by different authors and request IDs. Result: `sequences=[1,1]`, two physical Msg entries, only **one** message in the snapshot. This is display/history loss, not deletion of the second Space entry. Forks and LLM history take over the damaged view.

**Measure:** Assign the thread sequence via an atomically advanced counter or a reserved thread entry; use the same rule for user and reply messages. Treat duplicate sequences as an integrity error. **Acceptance:** concurrent submits and workers, all Msg IDs visible exactly once, strictly unique sequences.

### F02 — P1 / R: Markdown parser makes no progress on certain lines

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/client/lib/markdown.ts:48`, `:73`, `:85`, `:158`.

Headings are recognized only with one to three `#`. But the paragraph parser refuses every line that begins with `#` or `|` after whitespace. If no table/heading branch matches either, `i` stays unchanged. The outer loop hangs and keeps appending empty paragraphs.

**Reproduction:** The inputs `#### Heading`, `| orphan` and `#invalid` were each terminated with `ETIMEDOUT` after 600 ms in a separate Node process. Thus a single new or incorrectly formatted help article can block rendering. A search in the current corpus found no hit for these concrete patterns; the error is nevertheless directly reproducible.

**Measure:** Progress guarantee in every parser branch; support H4–H6 or output them as text, likewise unrecognized table lines. **Acceptance:** short deterministic tests for these inputs, indented headings and EOF without a blank line.

### F03 — P1 / R+S: admin idempotency stores no recoverable result

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/server/admin/admin-controller.ts:146`, `:448`, `:725`, `:729`.

`op.result` exists only in RAM. The long-lived `Result` contains `commandId`, `kind`, `state`, `requestedBy` and time, but neither result nor arguments. The reconstruction sets `args: {}` and no `result`. A retry is nevertheless returned as completed.

**Reproduction:** Initialize controller, execute `createSpace`, close controller, initialize a new controller over the same harness, repeat the identical command: first result present, second result missing, status stays `completed`. This isolates the reconstruction; a process kill/SQLite reopen was not performed for this finding.

Further open sub-problems:

- "Pre-persist operation" is only a comment: before execution only the RAM map is changed. Between effect and result write there is a crash window.
- A parallel retry with status `sending` is executed again; there is no shared running promise/claim.
- A reused ID with a different `kind`/different `args` returns the old success instead of a conflict.
- At boot the first result entry found wins. After `failed` and later `completed` of the same ID, the older failure can win.
- `readAll(..., {limit: 10_000})` reads the oldest hits; later completed commands are missing on rebuild.

Individual underlying controllers have their own idempotency and thereby limit some effects. That does not make the WebAdmin guarantee complete, in particular for enrollment and rotation.

**Measure:** Durable command journal with argument hash, result, state transitions and defined resumption; reject the same ID with different content. **Acceptance:** restart replay with an identical result, parallel retry, failure-then-success, more than 10,000 commands and an injected failure between effect and result journal.

### F04 — P1 / R+S: `scheduleRun` takes no effect without an execution loop

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/server/admin/admin-controller.ts:666`; `src/run-controller.ts:243`, `:317`, `:343`; comparison `src/runtime.ts:209`.

The WebAdmin creates schedules but starts no loop that calls `pending()` and `advance()`. `overview()` uses `list()`, which does not execute schedules. The existing capability timer merely publishes heartbeats. In the federation runtime the corresponding loop already exists; the help system does not use it.

**Reproduction:** Start a run, create an already due pause schedule: status `running`. An explicit `runController.advance(runId)` changes it to `paused`.

**Measure:** Attach a serialized, stoppable advance loop, including error display. **Acceptance:** scheduled pause/resume without a further user command, after restart as well as on a temporary failure.

### F05 — P1 / S: worker target state is not activated automatically after restart

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/server/admin/admin-controller.ts:177` ff., `:276`, `:584`, `:625`, `:712`; `src/workers.ts:110`, `:200`.

`initialize()` constructs `WorkerSupervisor`, but calls neither `reconcile()` initially nor `startWorkerSupervisor()`. Reconcile happens only on certain admin commands. Persisted assignments can therefore exist in the overview without workers running after a server restart.

**Measure:** Initial and periodic reconciliation with clean shutdown. **Acceptance:** save an assignment, reopen the server, demonstrate progress without setting the workers again.

### F06 — P1 / S: web enrollment ignores expiry and assigned role

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/server/admin/admin-controller.ts:91`, `:302`, `:467` ff.

`createEnroll` additionally stores the token in a `Set<string>`. `login()` checks only membership in this set and consumes the token. The 600,000 ms lease of the `Enroll` entry, `allowedPeerId`, role and scope are not checked in the process. Every accepted token creates the same WebAdmin session. Without a restart, an unused token stays usable in the set even after the Space entry has expired; after a restart, by contrast, the whole set is lost.

**Measure:** Separate web login tokens from peer enrollment or check them completely against long-lived, time- and business-bound state. **Acceptance:** expired token rejected, non-admin enrollment grants no admin rights, exactly one consumption even under concurrency and restart.

### F07 — P1 / S: insecure default and inconsistent key identity after restart

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/server/admin/admin-controller.ts:88`, `:109`, `:125`, `:496`.

Without configuration, a fixed default password was accepted at the time (since removed: the controller now generates a random secret or expects `PHI_SPACES_ADMIN_PASSWORD`). This is particularly relevant as soon as the server is published via a proxy. In addition, every controller instance creates a new private key under the same initial key ID `web-admin-key-1` and again writes an active PeerKey. Rotation revokes old records only on an explicit rotation command; the boot path does not.

**Measure:** Outside an explicitly restricted demo mode, reject missing access configuration; keep the identity persistent or unique with regulated replacement. **Acceptance:** two boots over the same store without a duplicate active key ID with different public keys; handle a start configuration without a password explicitly. This is a review of the WebAdmin wrapper, not a statement that the core federation authentication is broken.

### F08 — P2 / R: presence replay can remove the existing presence

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/examples/shared/chat-core.ts:174` ff.

`joinOrRefreshPresence()` deletes the old lease and existing presence entries before attempting the idempotent write with RequestRef. Its `updatedAt` is recomputed on every call. A retry of the same request ID can therefore fail after the deletion with "request ... was used for different arguments".

**Reproduction:** two identical join calls: request conflict, then zero presence entries. With an identical time value, the interaction with the replay of a meanwhile removed lease must also be considered.

**Measure:** Resolve replay before side effects; model renewal/replacement atomically and with a stable request payload. **Acceptance:** identical retry preserves presence, parallel join leaves exactly one valid entry.

### F09 — P2 / S: chat frontend does not renew its presence

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/client/components/SpaceChatWorkbench.tsx:74`; `help-site/server/space-chat/stage-runner.ts:251` ff.

On `onopen` the browser sends exactly one join. There is no `participant.heartbeat`; the 1.5 s timer only loads snapshots. Thus the 30 s lease expires even while the chat is open. The effect dependencies contain only `sessionId`; a change of participant or active thread does not update the registered presence. A reconnect after connection loss is also missing.

**Measure:** Presence lifecycle with heartbeat, metadata update and reconnect. HTTP polling only as a defined fallback. **Acceptance:** visible presence after more than one lease, correct thread/participant change, network interruption.

### F10 — P2 / R: completed subagent search loses assignment and question

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/examples/shared/chat-core.ts:700`, `:973`, `:1019`.

After processing, the SearchTask is consumed. SearchResult does contain `parentThreadId`, but the snapshot intermediate structure does not take over this field. The original question is not persisted in the result. The output therefore falls back to thread `main` and the technical search ID as the question.

**Reproduction:** Search from thread `t`; snapshot: `parentThreadId='main'`, `question='search:task:t:search'`.

**Measure:** Preserve origin and question in the long-lived result and read them in the snapshot. **Acceptance:** display and stage mirror keep the actual origin even after reopen.

### F11 — P1 / S: chat tasks can remain permanently after a failure or restart

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/server/space-chat/stage-runner.ts:34`, `:44` ff., `:274` ff.; `help-site/examples/shared/chat-core.ts:746`, `:832` ff.

The hub processes tasks event-driven after message arrival or new alarms. There is no general queue drain for existing ChatTasks. If a reply commit fails or the process is terminated after submit, the returned task stays in the Space until a further matching event. On an alarm, processing happens only for newly triggered jobs; an error on the first task aborts the whole loop while jobs may already be `triggered`.

The LLM call also runs inside a 30 s transaction without lease renewal or a time budget set here. A slow provider can make the commit fail although the external service has already been paid for. The 400 ms intervals do not wait for the previous tick.

**Measure:** Persistent task processing independent of the HTTP/WS call, one controlled scheduler, bounded run times and an explicit failure/retry strategy. **Acceptance:** a generator/commit failing once, process reopen with pending tasks and a slow reply; no additional user message necessary.

### F12 — P2 / S: simultaneous session creation creates separate hub states

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/server/space-chat/stage-runner.ts:64–115`.

Between the check of `#sessions` and the final `set()` there are several awaits. Two first accesses can both create and seed an engine. `createSpace` may prevent duplicate Spaces, but not two client sets/engines. The later map entry displaces the earlier one; clients already attached can afterwards be excluded from the broadcast.

**Measure:** One shared initialization promise per normalized session ID. **Acceptance:** parallel first accesses/WS attach return the same engine and the same client set, seed exactly once.

### F13 — P2 / S: stage mirror is neither an atomic replacement nor a complete state copy

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/server/space-chat/stage-runner.ts:126–202`.

The mirroring deletes types one after another and then writes individual entries. ChatTask/SearchTask are not emptied although Thread/Msg are replaced. Pending tasks are not restored from the snapshot. TimerLocks are removed, but not reconstructed for copied pending ScheduledJobs; the alarm ticker can therefore trigger them prematurely. The server ticker and browser accesses can see intermediate states during the import.

The heuristic `msgId.includes(':fork:')` moreover treats every message with this text fragment as a virtual projection. Since request and thread IDs occur in real Msg IDs, legitimate messages can be dropped.

**Measure:** Either an explicitly immutable report copy with the complete schema or an atomically activated, executable restoration including tasks and remaining run times. Mark projections structurally. **Acceptance:** second run, failure mid-import, pending alarm, concurrent access and a real ID with `:fork:`.

### F14 — P2 / S: swarm errors are output as complete empty results

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/server/social/swarm.ts:1458`, `:1476`, `:1511`.

Shard read failures become empty hit lists via `.catch(() => [])`. `feed.more` nevertheless sets `exhausted` solely by page length. If a shard fails, the browser can receive "no further posts" although posts are missing. Agent/AI lists also have no incompleteness marker.

**Measure:** Carry partial failures and completeness in the reply schema; with unknown completeness no final `exhausted`. **Acceptance:** let a shard fail during scrollback, continuation after it returns without omitted posts.

### F15 — P2 / S: swarm scrollback still reads large histories completely

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** same places as F14; `src/core.ts:942` ff.

Template filters reduce hits and transport data but are no secondary index. `feed.more` reads up to a million posts per shard, filters/sorts in the server and only afterwards returns 10–200. The other lists read up to 100,000 hits. This produces repeated linear scans and large intermediate arrays. When the limits are exceeded, newer hits are missing because `readAll` returns the oldest first.

**Measure:** Cursor/byte-based paging with an access path matching the sorting; make limits and incompleteness visible. **Acceptance:** deep pages with bounded memory/transfer needs as well as a data stock above the limit. The old statement "O(N) full scans eliminated" is wrong; the new code comment already names the remaining scan correctly.

### F16 — P2 / S: swarm reserves faulty batches until lease expiry

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/server/social/swarm.ts:786–819`.

`txn` is created in the try. The catch sleeps but can no longer abort the transaction explicitly. An error before commit keeps up to four tasks reserved until the 45 s lease expiry. Errors in `#afterPostCommit` are handled in the same catch although the commit was already successful; the downstream effects have no durable retry queue there.

**Measure:** Keep transaction state outside the try, abort before commit and use own reliably repeatable effects after commit. **Acceptance:** injected write/commit/post-commit error with controlled task and cache states.

### F17 — P2 / S: WebSocket implementation still has protocol and resource gaps

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/server/ws.ts:50–196`; `help-site/server/index.ts:487` ff.

Fragmented texts are meanwhile supported, but unmasked client frames are accepted; RSV bits, version, unexpected continuations, control FIN/length and invalid UTF-8 are not validated completely. Particularly relevant: `fragParts` is bounded only by the sum of payload bytes. Arbitrarily many empty fragments let the array grow; `reduce()` over all fragments is repeated on every frame. Socket backpressure is also not handled when sending.

On upgrade, `attachWebSocket()` is started without rejection handling. The hub handlers are registered only after asynchronous session setup, while frames can already be parsed. Early client messages can thereby get lost.

**Measure:** Bound fragment count and total bytes incrementally, validate connection state strictly, buffer inputs until handler readiness and bound outgoing queues. **Acceptance:** real frames against the parser, including a zero-byte fragment series, early join, slow client and failed initialization. A fake WsConnection test is not sufficient for this.

### F18 — P2 / S: article switch can show stale content under a new title

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/client/App.tsx:174–189`.

The article fetch has neither an AbortController nor a generation/path check on completion. Response A can arrive after response B and overwrite its Markdown. `response.ok` is not checked; an error text can be rendered as an article. A catch handling with a usable error message is missing.

**Measure:** Abort the request or bind completion to the current path, display an error state. **Acceptance:** artificially delayed responses on article/language switch, 404 and network error.

### F19 — P1 / L: public demo endpoints have insufficient resource limits

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/server/index.ts:212` ff., `:306` ff., `:321` ff.; `help-site/server/llm.ts:77` ff.; `help-site/server/space-chat/stage-runner.ts:24`.

Publicly reachable are session creation, stage runs, uploads and global switching of the LLM model. Credentials activate the model by default. Chat requests can thus trigger external costs. Uploads are limited to 2 MiB per file but have no total quota/retention; sessions stay in RAM and in the store. Stage runs have no global concurrency limit. These are limits for a publicly offered service, not automatically errors of a deliberately open local example.

**Measure:** Make the public demo policy explicit: quotas, session/upload lifetime, stage semaphore, budget for model calls, permission for global configuration. **Acceptance:** exceeding a limit leads to a defined reply without resource growth; LLM stays explicitly off in tests.

### F20 — P2 / S: sieve exporter checks more weakly than the local result collection

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `examples/sieve.ts:125–161`.

`collectSieveResults()` demands exactly one hit per task, correct range limits and an ascending sorted, valid number sequence. `SIEVE_EXPORTER`, by contrast, picks the first hit of the first matching member and counts its `primes`; duplicates, contradictory member results and wrong ranges are not rejected. `complete` here means only that all task IDs have some hit.

**Measure:** Use a shared result validation and define an explicit rule for equal or contradictory results of several members. **Acceptance:** wrong range, duplicate, conflict between members, missing task ID. This is no evidence of a wrong prime algorithm; it concerns the export trust boundary.

### F21 — P2 / S: thread and fork inputs have insufficient invariants

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**Evidence:** `help-site/examples/shared/chat-core.ts:231–305`.

`createThread` binds idempotency to RequestRef, not to a unique `threadId`. Different requests can create the same business ID several times. `forkThread` checks neither the existence of the parent nor valid fork boundaries or cycles. The resolution silently aborts cycles with an empty list. Moreover the default `createdAt` for normal threads is a fixed historical value; new live threads thereby receive no actual creation time.

**Measure:** Check business uniqueness and parent/sequence invariants atomically; use `now()` for live creation and set deterministic time only in fixtures. **Acceptance:** duplicate IDs, missing parent, self-fork/cycle, negative/non-integer boundary, real chronological sorting.

## 3. Dead code and duplication

### F22 — P3 / compiler evidence: concrete unused symbols

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

In addition to the normal type check, `tsc -p help-site/tsconfig.json --noEmit --incremental false --noUnusedLocals --noUnusedParameters` was run. In the examined area it reports:

| File | Symbol / finding | Classification |
|---|---|---|
| `examples/sieve.ts:8` | import `Space` | removable import |
| `help-site/examples/v4-gated-auth/run.ts:22` | import `FOREVER` | removable import |
| `help-site/examples/v5-federated-cluster/run.ts:10` | import `createSpace` | removable import |
| `help-site/client/components/AdminSpacesView.tsx:26` | `selectedSpaceInspect` is set, never read | ineffective state; remove the setter at `:170` or bind a display to it |
| same file `:36`, `:38` | `setSieveStart`, `setSieveBlock` | values are used, setters not; no completely dead sieve configuration |
| `App.tsx`, `AdminSpacesView.tsx`, `LlmModelPicker.tsx`, `SpaceChatWorkbench.tsx` | default import `React` | unused with the automatic JSX runtime |
| `help-site/server/social/swarm.ts:709`, `:719`, `:725` | parameter `agent` | check signature cleanup or missing personalization |

The additional compiler run also reports symbols in `src/`; these are not counted here as separate help system findings. A CLI script that is not imported is not automatically dead code. `react-shim.ts` no longer exists in the current tree; the earlier finding is closed in that respect. The six stage runners are wired in and not to be deleted wholesale.

### F23 — P2 / S: business duplication is already drifting apart

**Status: Done.** For implementation and targeted evidence see [section 7.1](#71-evidence-per-finding); for remaining evidence and operating limits see [section 7.3](#73-current-check-and-remaining-limits).

**HTTP/WS actions:** `help-site/server/index.ts:239` ff. and `server/space-chat/stage-runner.ts:239` ff. implement thread/fork/submit/alarm/presence separately. Alarm defaults differ (2,000/3,000 ms), presence names as well. Unknown actions end without an error as a snapshot or `{ok:true}`. Recommendation: a transport-neutral validated command dispatcher, separate transport adapters; check the same parameter/error cases over both paths.

**Sieve results:** shared exporter and config normalization are already wired in. The still duplicated result check has different semantics (F20). No renewed complete rewrite of the orchestration is necessary.

**Corpus build:** `help-site/package.json` runs `prebuild`; `build-web.ts` then calls `buildCorpus()` again. Double generation in the normal build is redundant. Generated `corpus/de|en`, `public/help` and `dist/public/help`, however, are deliberate outputs, not source copies to be maintained independently. Changes belong in seed/fact files.

**Two UI deliveries:** the Next app and the esbuild standalone share `HelpApp` but have different start/asset paths. The test generates standalone artifacts; the Next production test expects an existing `.next` build. That is no complete acceptance of a clean production build. Fix one canonical build path plus a clearly labelled test fallback.

**Root tests:** Some older chat/research tests define their own faux pipelines instead of importing the runners completely. These tests remain useful as semantic tests but alone do not prove the current CLI wiring. `test/examples/recovery.test.ts` meanwhile checks actual runners and closes part of this gap. This distinction must be preserved in statements about test coverage.

## 4. Reassessment of the previous done statements

| Previous item | Current finding |
|---|---|
| Like without target / CompletionProfile | Ack write present; the original missing result write is closed. Do not derive a comprehensive batch failure acceptance from it (F16). |
| Premature post/like cache updates | `postCommit` callbacks present. Errors after commit and batch rollback separately open. |
| Process all alarms | Loop present; not sufficient on worker failure, restart and overlapping ticks (F11). |
| Presence expiry correct | local expiry map present; browser does not renew and join replay removes presence (F08/F09). |
| WebSocket complete | Continuations present, protocol/resource gaps remain (F17). |
| Admin key rotation | Revocation in the rotation branch present; boot identity and atomic rotation remain to be checked separately (F07). |
| Admin replay after restart | only status reconstructed, result missing; guarantee still open (F03). |
| Full scans eliminated | only template filters added; large scans/materialization remain (F15). |
| O(1) fork | no physical copying in the fork write; reading/snapshot is not O(1). Sequence and validation errors remain (F01/F21). |
| Stage mirroring real | real report data is imported; no complete/atomic state copy (F13). |
| Sieve unified | shared exporter/normalizer present, validation drifts (F20). |
| React shim / old names / CLI wiring | Shim removed, `SpaceChatEngine` used, CLI and doc wiring present. Further unused symbols separately F22. |
| Links / search normalization | internal anchor handling and ß normalization present. No evidence of complete Markdown coverage (F02). |
| Dynamic test ports | avoids fixed port collisions; "collisions ruled out" is too strong if a free port is closed and bound again later. |
| Run guards | URL decoding/resolve improved; symlink equality does not follow automatically. Node already normalizes normal CLI paths; the old reasoning about relative paths was too sweeping. |
| Comparison documents / 23 of 23 | an editorial update is no comprehensive implementation/operations acceptance. |

The old file additionally contains duplicate chapters 3.1/3.2, both open and done versions, and absolute `file://` links. It is kept for traceability but is marked as superseded with this report.

## 5. Verification of this review

All model calls were disabled by `PHI_SPACES_LLM=0`. Existing dependencies were used, none were installed. The help system tests generate local corpus/standalone build artifacts and start local test servers; the tests close them again.

| Check | Result / limit of the statement |
|---|---|
| `npm run typecheck` | successful |
| `./node_modules/.bin/tsc -p help-site/tsconfig.json --noEmit --incremental false` | successful |
| additional `--noUnusedLocals --noUnusedParameters` | reports the symbols listed above; expected diagnostic failure, no normal type check error |
| `PHI_SPACES_LLM=0 npm --prefix help-site test` | **5 tests passed**, including existing Next production artifacts and a local two-shard test |
| `PHI_SPACES_LLM=0 npm run test:examples`, without sandbox restrictions | **158 tests, 60 suites, all passed** |
| `PHI_SPACES_LLM=0 npm test`, without sandbox restrictions | **731 tests: 730 passed, 1 skipped, 0 failed**, run time about 78 s |
| bounded local reproductions | F01, F02, F03, F04, F08, F10 confirmed |

The bootstrap test with a real control store copy was skipped because `PHI_SPACES_BOOTSTRAP_COPY` was not set. No real store copy was obtained or changed.

The first restricted example test run reported two failed test files (`golomb`, `recovery`); the unrestricted repeat run was green. The first restricted root run also delivered failures/stalled progress and ended at the set 180 s timeout (exit 124). These results must not be passed off as product regressions without an individual root-cause analysis. Decisive here are the separately listed repeat runs and targeted reproductions.

The five help system tests mainly demonstrate normal flows: corpus schema/anchors, sequential stages, HTTP/admin happy path, existing Next SSR build and two-shard behavior. They do **not** check the concurrency/replay errors reproduced above, browser heartbeats or real WebSocket frame edge cases. Stage v2 uses orderly close/reopen; that is no evidence of power loss or hard process abort.

The reproductions were run with a temporary script `/tmp/phi-spaces-help-review.mjs`. Logs of this session are under `/tmp/phi-spaces-review-*.log`; they are local, not permanently versioned auxiliary artifacts. The concrete inputs and results are therefore additionally documented at each R finding.

## 6. Recommended implementation and acceptance

1. **Data/display integrity:** close F01/F02/F03/F08 first. Take over the six local reproductions as small, targeted regression tests; test cases should check observable behavior.
2. **Execution and restart paths:** close F04/F05/F11/F12. Centralize the server lifecycle: start, recovery, worker/scheduler loops, stop and error states.
3. **Access and resource contract:** solve F06/F07/F17/F19 before a public operations release. Distinguish public demo actions from global admin/cost decisions and enforce limits technically.
4. **Correct inspection:** close F10/F13/F14/F15/F18/F20/F21. Partial failures and incomplete results must stay visible; no success display without matching evidence.
5. **Cleanup and docs:** handle F22/F23. Only afterwards update older done markers with concrete test names and results. Document changes to core contracts and demo restrictions separately.

A renewed release should name, per finding, code change, specific regression test and remaining limits. A green overall test run alone does not replace the missing failure-path tests.

## 7. Step-by-step implementation of 18 October 2026

Implemented first were data integrity and parser, then admin journal and lifecycles, then transport/resource limits, history queries and cleanup. Changes already present in the working tree were preserved. No dependencies were installed, no models called and no external services published. Changes to running foreign test/demo processes were not part of this implementation.

### 7.1 Evidence per finding

| Finding | Status | Implementation | Targeted evidence |
|---|---|---|---|
| F01 | Done | `ThreadSequence` per thread; exclusive transactional take, Msg/task and new counter value committed together. Atomic optional `write(..., {unique})` check protects the first creation also with concurrent engines and via RPC. Display deduplicates by Msg ID; old sequence collisions stay visible and appear as `integrityIssues`. | Two engines, eight parallel submits, two reply workers, parallel retry, aborted write without consumed sequence, fork sequence; local/RPC singleton including reserved entry; old collision stays visible. |
| F02 | Done | H1–H6 and indented headings; unknown block lines are consumed as text. | `#### Heading`, `| orphan`, `#invalid`, indentation and EOF in the actual renderer. |
| F03 | Done | Host-internal durable command journal with canonical argument/principal binding, result and states; shared running promise per ID and serialized web commands. No 10,000 truncation. Enrollment and rotation commit effect and result atomically. Interrupted other commands are shown as `needsReview`; no automatic re-execution. Failed IDs stay terminal. | Result equality under concurrency and SQLite close/reopen, conflict with other arguments, rebuild of 10,001 commands, interrupted command triggers no new effect. |
| F04 | Done | Serialized run-advance loop, first pass at start, repetition every 250 ms after completion; errors isolated per run and visible in the overview. Shutdown waits for a running pass. | A due pause takes effect without a further user command. |
| F05 | Done | Initial reconcile and periodic WorkerSupervisor; persistent control keys keep the pin identity stable. Shutdown stops loops before harness close. | A persisted assignment is active after controller reinitialization without `setWorkers`. |
| F06 | Done | Peer enrollment and web login separated. Web login accepts only the configured password; no peer token grants web admin rights. The long-lived `Enroll` entries keep hash, role, peer binding and lease for the actual enrollment RPC. | Member token is rejected in the controller and HTTP login. No additional RAM token list any more. |
| F07 | Done | No password fallback in controller, UI or Compose. Without configuration, web login stays disabled; Compose requires a password. Admin/control keys are kept in the private host document. Rotation replaces keys and revokes predecessors in one commit. Journal results are stored with AES-GCM. | Same public key after SQLite reopen; exactly one active admin key before/after parallel rotation replay; old default password rejected. |
| F08 | Done | Presence replacement under a Space mutex and a transaction; business replay before deletion, stable fingerprint check. | Two engines with the same join, identical lease and exactly one entry; deviating retry removes nothing. |
| F09 | Done | Shared client lifecycle with 10 s refresh, complete metadata and 1.5 s reconnect. Effect reacts to session, participant and thread; HTTP polling only without a WS connection. | Actual lifecycle helper with controlled timers over more than one lease, metadata change, disconnect and cleanup. No browser E2E evidence. |
| F10 | Done | `SearchResult` stores question and parent; snapshot takes over both even without a SearchTask. | A completed search from thread `t` keeps origin and question with a new engine. |
| F11 | Done | Hub loads existing sessions; controlled queue drain independent of HTTP/WS, no overlapping scheduler passes. Aborted tasks are processed again. Model time budget at most 20 s with AbortSignal; reply transaction 60 s, sequence reservation only after reply generation. Reminder replay uses the same long-lived job. | Pending task before hub close, resumption and a commit failure once; slow generator is aborted and completed deterministically. SQLite stage checks the alarm after reopen. |
| F12 | Done | Shared initialization promise per normalized session ID. | Parallel first accesses return exactly the same session object; seed happens only once. |
| F13 | Done | Explicitly immutable report copy instead of an executable restoration. Entire stage snapshot including pending/search/timer data stored as `ChatReport`; Thread/physical Msg for inspection. Replacement in one host commit, no executable tasks/timers in the mirror. Projections carry `projectionOf`, no ID substring heuristic. | Two actual stage runs, constant message count, six visible v1 messages; mutations on the report session rejected. |
| F14 | Done | History queries take all configured shards into account, also during cooldown. A failure returns `complete:false`, `exhausted:false`, error and unchanged cursors. UI shows the error and keeps previous results. | Injected shard failure, rejected page, subsequent retry returns the most recent hits again. |
| F15 | Done | Durable chained post index, written atomically with every post. Cursor per shard; at most 512 checked nodes and 200 output posts. Merge continues at hits not selected. Same query for feed, agent and AI; filter views have continuation. Migration of old posts is resumable in bounded commits and not visible as a finished index until completion. | Two-shard pages without missing/duplicate IDs; migration over several commits, injected abort and resumption without duplicate index nodes. No million-post load acceptance. |
| F16 | Done | Transaction kept outside the try; errors before commit abort immediately. Since the durable batch rework, follow-up SwarmTasks stand directly atomically with the post in the completion commit; existing `PostEffect` entries are still processed. Cache updates only after commit; no downstream error repeats the original post. | Injected error in post/follow-up completion: reservations released again, no phantom post, exactly one original post, follow-up reply and consistent history index. Supplementary commit/recovery evidence see section 7.4. |
| F17 | Done | Strict handshake/mask/opcode/FIN/RSV/UTF-8/close check; 1 MiB message, 1,024 fragments, bounded input queue and socket write buffer. Early frames stay buffered until handler readiness; handlers run in order. Attach rejections close the connection. | Real encoded frames over duplex: early text, fragmentation, unmasked, unexpected continuation, fragmented control frame, invalid UTF-8, series of empty fragments; outgoing backpressure and faulty handshake. |
| F18 | Done | Abort/invalidation function for the article fetch; `response.ok` and visible error state. Even a fetcher that ignores abort can no longer publish old content. | Delayed responses B before A, 404 and network error in the actual loader. No browser E2E evidence. |
| F19 | Done | Explicit activation of live LLM, shared budget of six calls/min, two concurrent and 400 output tokens/call. Global model change needs admin+CSRF. Session/Space/client/WS/HTTP limits, one-hour session validity, serialized stage runs. Upload quota 64 MiB/256 files, 24 h expiry and serialized intake. | 64 parallel session creations, 65th rejected; parallel upload quota and retention; HTTP 401/403 for model changes; LLM off in all tests. No real paid provider test. |
| F20 | Done | Shared `validateSieveResult` check for collector and exporter. Exactly one result per task and member; identical replicas accepted, contradictory member results rejected. | Invalid range, duplicate results, identical multi-member results and existing sieve example tests. |
| F21 | Done | Atomically unique thread ID, business replay with input check, real creation time. Fork needs an existing parent, an integer non-negative boundary within the history and a new ID. Immutable parent references prevent later cycles; old cycles are reported as errors. | Duplicate IDs under concurrency, other request, missing parent, negative/fractional/too large boundary, valid fork and correct first own sequence. |
| F22 | Done | Listed imports, ineffective inspect state and unused setters removed; fixed sieve values stay explicit constants. Unused swarm parameters and wrappers dropped by unification removed. | Additional noUnused run reports no files in `help-site/` or `examples/sieve.ts`; existing separate core warnings are not passed off as cleaned. |
| F23 | Done | One transport-neutral command dispatcher; uniform defaults and errors for unknown actions. Sieve check shared. One corpus build in the npm/Docker build path. Standalone uses exclusively its own assets; Next has an explicitly chosen delivery mode. Production check builds fresh beforehand. | HTTP error case and dispatcher test, actual stages v1–v6, shared sieve tests, fresh Next build with SSR test. Old faux pipelines remain labelled as semantic tests. |

The new specific tests are in [`help-site/tests/regressions.test.ts`](../../help-site/tests/regressions.test.ts); existing HTTP/stage/shard tests in [`help-site/tests/help-site.test.ts`](../../help-site/tests/help-site.test.ts) were extended by actual access and dispatcher error cases. The current operating contract including limits and `needsReview` is in the [help system README](../../help-site/README.md#runtime-contract-and-restart). The optional atomic unique check is described in the [API](../api.en.md).

### 7.2 Supplementary corrections from the implementation

In `src/core.ts`, which had meanwhile been changed elsewhere during the work, a new expiry watermark optimization was present. A watermark unknown after reopen was treated like `Infinity`; as a result the first necessary entry sweep did not happen. Only the cold first scan and the handling of unknown watermarks on import were corrected. A targeted test reconstructs a stored state without a cache and checks its expiry.

The existing reaper integration test also assumed that several asynchronous setup steps safely stay under a 150 ms lease. Under parallel test load the lease had already expired before the first assertion; on a failed assertion the cleanup was missing. The test now uses a controlled semantic clock, waits for the background reaper by pure snapshot inspection and cleans up in finally.

### 7.3 Current check and remaining limits

The following results apply to the implementation, not to the historical review in section 5:

| Check | Result |
|---|---|
| Root typecheck `npm run typecheck` | successful |
| Help typecheck `tsc -p help-site/tsconfig.json --noEmit --incremental false` | successful |
| Help system tests with `PHI_SPACES_LLM=0` | 26 tests: 25 passed, 1 separate Next production case deliberately left out |
| `PHI_SPACES_LLM=0 npm --prefix help-site run test:production` | fresh corpus/standalone/Next build successful; subsequent Next SSR test passed |
| `PHI_SPACES_LLM=0 npm run test:examples` | 158 tests, 60 suites, all passed |
| `PHI_SPACES_LLM=0 npm test -- --test-concurrency=4` | 731 tests: 730 passed, 1 bootstrap-copy test skipped, 0 failures |
| Additional noUnused diagnostic run | no findings in help system/sieve; 13 already existing findings in separate core files |

Logs of the local runs: `/tmp/phi-spaces-fixes-help-final.log`, `/tmp/phi-spaces-fixes-production.log`, `/tmp/phi-spaces-fixes-examples-final.log`, `/tmp/phi-spaces-fixes-root-final.log` and `/tmp/phi-spaces-fixes-unused.log`. These temporary files are not permanently versioned CI evidence. Earlier runs had failures from the since-corrected cold expiry cache, the time-dependent reaper test and a stricter sieve error message; the table names the successful runs executed afterwards.

The implementation closes the described application errors with the named local evidence. It is still **not** a browser E2E, container, production, multi-host, power loss or paid provider acceptance. Docker files were adapted, but no containers were built or started. The bootstrap test with a real store copy stays deliberately skipped without `PHI_SPACES_BOOTSTRAP_COPY`.

Deliberate limits: `needsReview` demands a business review on an unclear outcome instead of an exactly-once claim across several controllers. Stage mirrors are reports and not executable backups. The first-time history migration needs linear memory for sorting; in the Space itself, ID probes and commit costs remain dependent on the entry count. An upload retention run removes only generated files and happens at the next upload; chat histories are not deleted automatically on session expiry and still count toward the quota. The model budget limits are local process limits, not a cross-tenant billing system.

### 7.4 Addendum: real durable batches in the SocialSwarm worker

**Status: Done (implementation and local check).** No deployment and no load acceptance of the production 34k-entry store.

The previous logical Space transaction was no storage batch: every `PhiSpaces.take`/`write`/transaction call opened `host.commit` separately. In particular `appendHistory` needed three such calls per post; post, channel counter, outbox and task reservation were added. Thus the document serialization stayed in the hot path despite several tasks per Space transaction.

Implemented in [`batch.ts`](../../help-site/server/social/batch.ts) and [`swarm.ts`](../../help-site/server/social/swarm.ts):

1. A dispatcher reserves up to four tasks in **one** durable commit. It still uses `core.createTxn` and `core.probe`, i.e. the normal reservation, lease and CompletionProfile rules. The transaction is valid for 45 seconds.
2. Text, target post and model preparation run **outside** the durable callback. At most one model call per batch; the worker wait time is limited to 20 seconds. A non-cooperative custom provider can continue running afterwards, but its late result is not published.
3. A second durable commit writes all posts/likes, history nodes and follow-up jobs, replaces the history head once and each affected channel counter once and executes `core.commitTxn`. The atomic commit byte limit stays effective. Neither is anything written past the entry list directly nor is the completion check bypassed.
4. New follow-up SwarmTasks stand directly in the completion commit instead of needing a further outbox pass. Existing `PostEffect` entries remain compatible and are emptied via the old path. Feed caches and reply observers are updated/started only after successful completion. Duplicate likes in the same batch are detected.
5. Business errors roll back the entire completion and trigger an explicit abort of the reservation. On exceeding bytes the batch size halves down to one; a task that remains faulty is not confirmed and is retried with a warning. A storage error still poisons the session; after failed cleanup the worker stops instead of writing on unconfirmed. Reopening/recovery is then necessary.
6. A snapshot pre-check prevents normal empty-queue commits. Between successful batches there is a 25 ms yield, with an empty queue a 500 ms pause. Snapshot scans are still not free.

Targeted evidence in [`swarm-batch.test.ts`](../../help-site/tests/swarm-batch.test.ts):

| Check | Evidence |
|---|---|
| Real storage bundling | Four tasks including post, history, counters and follow-up job: **exactly two `Storage.commit` calls**, i.e. 0.5 worker commits per task with a full batch of four. |
| Actual dispatcher | An initialized hub processes four jointly enqueued posts with exactly two worker commits, four visible feed posts and without new `PostEffect` entries. |
| Atomicity/completion | A missing result discards all posts, history nodes and counters; abort releases all four tasks, repetition creates exactly four posts. |
| Byte limit | Four large posts exceed the commit budget without visible partial results; the same tasks can be completed individually after abort. |
| Mixed results | Post/like batches satisfy the CompletionProfile check and receive correct channel totals over several batches. |
| Storage error | An injected storage rejection then locks abort and further reservations as a poisoned session; no async fallback. |
| Slow provider | Even a generator without its own deadline ends the worker wait time; a timely result is preserved. |
| SQLite reopen | An open reservation stays reserved after close/reopen and can be aborted explicitly; after renewed completion and a further reopen exactly one post/history node, no renewed task processing. This is no kill/power loss test. |

The existing F16 error injection was moved to the actual durable completion: post and follow-up errors leave neither phantom cache nor duplicate posts and the reply is generated after repetition. The F15 migration test takes into account the internal retry of transient errors introduced meanwhile; it checks incompleteness during the interruption as well as idempotent completion.

Current local checks of the addendum:

- Root and help typecheck successful.
- Help suite: 34 tests, of which 33 passed and the separate Next SSR case deliberately skipped; including eight new batch tests.
- Root suite: 737 tests, of which 736 passed, one optional bootstrap-copy test skipped, no failures.
- Examples with `--test-concurrency=1`: 158/158 passed. Two previous parallel runs failed solely at the unchanged Golomb BitSet time limit (109 and 119 ms instead of under 100 ms); the limit was not loosened.

Logs: `/tmp/phi-spaces-help-batch-final.log`, `/tmp/phi-spaces-root-batch-tests.log`, `/tmp/phi-spaces-examples-batch-serial.log`; temporary local evidence, no versioned CI artifact. The earlier Next production evidence from section 7.3 was not run again for this purely server-side addendum.

**Remaining performance limits:** The count tests measure real storage calls, not a blanket CPU/throughput factor. A single commit still serializes the large document, and core operations can search the entries linearly. Producer intents, remote RPCs, seeds and old outbox entries still use their previous call paths; their commits are not included in the two worker commits. CPU, event-loop delay and HTTP p95/p99 on the large store and on `big` were not measured. The observed 4:38 minutes of offline migration come from the user report, not from this test run. No container/host was restarted or published.

### 7.5 Completion of the help corpus consistency corrections

**Status: Done (local implementation and check).** The additional findings C01–C14,
eight new bilingual practical guides and all still open operations/publication gates
are in the [detailed final report](analyse-hilfecorpus-konsistenz-2026-10-18.en.md).

- [x] API schemas, code examples, mailbox/snapshot semantics and stage topology corrected.
- [x] Corpus/link/anchor/language check, real API signatures and 60 compiled TS examples integrated.
- [x] Navigation, search filters, language/stage URLs, renderer and index error handling corrected.
- [x] Complete tutorial and live synchronization example including failure/delete cases tested.
- [x] Shutdown race and test isolation fixed; help suite ends cleanly.
- [x] Standalone React start corrected; fresh production build and SSR test passed.
- [x] Root/help README language versions updated, experimental notice and MIT license added.
- [x] Done markers and documentation index reconciled with current evidence.

Current corpus: 45 articles/90 language records, nine areas, 14 API groups.
Help suite: 44 passed and one separately successfully checked SSR case skipped.
Root: 740 passed, one optional bootstrap-copy test skipped; examples 158/158.
The previous sections document their respective historical check runs. Browser smoke tests
now complement the local evidence; complete browser/device, container, large-store and
target operations acceptances remain explicitly separate and are listed in the final report.
