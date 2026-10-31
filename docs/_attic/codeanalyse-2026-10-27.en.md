# Code analysis 2026-10-27: core, store, codemode-chat, help-site, spaces-mmo

Continuation of the analysis of 10-18 (`codeanalyse-src-2026-10-18.en.md`). Status of the items implemented.

## Fixed

**Logic gaps**
- L1: `serve()` did not catch `reserve`/`assertMemberTake` errors; a full waiter made other operations fail. Now `ResourceExhausted` → `deferMaintenance`, as in the mailbox path (test in test-core).
- L2: `Watch` never removed its abort listener (a leak per blocking read/take). `finish()` now cleans it up (test in test-own-store).
- L3: `SpaceLike.changes` knows `waitMs`; `PhiSpaces.changes` long-polls through `commitSignal`. Casts in hub.ts/gateway.ts removed.
- L4: "locked" runs through: claim → service reply → RemoteSpace. New optional `SpaceLike.probe(tmpl, timeout, {take})` → `{entry, locked}`; feature flag `read.locked` in the hello. `existing()`/`readExisting` in codemode-chat, spaces-mmo and examples/cache use it instead of the timing heuristic.
- L5: `UniqueConflict` as its own error with an ErrorCode, mapped through service/remote; all `/unique/i` regexes in codemode-chat replaced. `TransactionError` instead of text matching in judge-host/model-host; `historyGone` in swarm.ts/hub.ts/gateway.ts checks `SnapshotExpired`/`RevisionAhead` by instanceof.
- L6: `sqlite.ts drain()` waits for an idle signal instead of a 1 ms busy loop.

**Optimizations**
- O1: `s.outboxBytes` as a running tally instead of `jsonBytes(s.outbox)` on every access (mutation sites update it, reset sites delete it → lazy recompute).
- O2: `listPage` calls `standing()` only once per entry, the view only on a hit.
- O3: `op()` commits only when the document is missing (as readPage does).
- O4: `snap()`/`watch()` read the registry once (`idAndRegistry`).
- O5/D2: `entryBytes(s)` helper, four places merged.
- O6: `entryChangeId` imported statically (merge call).
- O7: the `due()` statement goes through `#prep` (cache by SQL text).

**Dead code**
- Removed `createContextKey`, `withCancel` (context.ts), `PAGE_OVERHEAD` (core.ts), `isSyncStore` (sync-store.ts), `JsonObject` (types.ts), `deadline = r.deadline` in op().
- Subprojects: removed `llmAvailable`, `levelName`, `TickerFields`.

**Duplicated code**
- D1: `deepFreeze` once in host.ts (exported), sqlite.ts imports it.
- D3: `dropWaiter(s, w)` helper.
- D4: `partAt` in host.ts/sqlite.ts instead of a duplicated path reduce.
- D5: `end()`/`revoke()` in draft.ts merged.
- D6: `DEFAULT_POLICY` host/member → `METHODS`.
- D7: sqlite close/abandon use a shared closing sequence (idle waiters resolved on both paths).
- D8: `allowed(id,'resolveOperation')` runs once (kept in the field).

**Subprojects**
- `Gateway`: modelChars/modelNames/protoIcons are instance fields instead of module globals (instances no longer share state).
- `#currentRev` uses `readPage().rev` instead of a binary search over error messages.

## Addendum 2026-10-27, second pass

**Implemented**
- Space helpers in the library (`src/space-client.ts`, from `phi-spaces`): `parseTarget` (replaces five copies of the
  address parser; `parseListen` in `standalone.ts` is the same function), `connectSpace`, `readExisting`/`takeExisting`/
  `StillHeld`, `peek`, `takeAll`, `awaitWork`, `keepAlive`. The per-project values (wait time 10 s or 2 s, timeouts,
  the trace of spaces-mmo) are set by the projects' `server/space.ts`. Without `read.locked` on the server (`UnsupportedOperation`)
  the helper falls back to readIfExists/takeIfExists. Test: `test/test-space-client.test.ts`.
- `ws.ts` once as `phi-spaces/ws` (`src/ws.ts`), the message limit as an option (spaces-mmo 600/min, otherwise 120); the
  three copies are gone. Decision 3 in `spaces-mmo/docs/README.en.md` is changed accordingly.
- Copies that must stay (Next.js bundles nothing outside the project; `env.ts` resolves paths from its own location):
  `client/lib/palettes.ts`, `client/lib/markdown.ts`, `server/env.ts`; `test/test-shared-copies.test.ts` compares them.
- `takeAll`: the seven `while (await take(…, NO_WAIT))` loops in codemode-chat call the helper.
- codemode-chat `snapshot()`: pages that connect or load (many at once after a restart of the web process) get the same
  snapshot for at most 2 s as long as the Space revision is unchanged (read before the reads); after that it is released.
  A push comes because something changed and builds its own (without an additional revision query), so the cost per push is
  unchanged, bounded by the `limit`s from the first pass. `session()` reads the CodeTask rows once for the snapshot.
  The limit checks and the deletion of a block still read fresh (several processes).
- spaces-mmo `Gateway.#follow`: the start reads all types page by page (`readPage`, 256 KiB per page) instead of with
  an unbounded `readAll`.
- help-site: the remote-shard part of `SocialSwarmHub` is `RemoteShard` (`server/social/remote-shard.ts`). Fixed on the way:
  the join read the revision only after the posts (changes in between were lost), now the revision of the first page
  applies; and `readAll` with `limit: 4000` returned the *oldest* 4,000 posts (entry order), so with a larger shard old
  posts ended up in the index. Now all pages (at most 256 KiB each) are read and only the last 4,000 are kept.
- Remains of D1/D3: `deepFreeze` once in `store/types.ts` (`disk-map.ts` also had a copy), the last
  `s.waiters.splice` in `core.ts` uses `dropWaiter`.
- Documentation error: `SpaceLike.probe` reads by default (`take: true` takes); the comment said the opposite.
- The test `swarm-retention` ("history has moved past the hub's cursor") still threw a plain `Error`; since L5 the hub
  recognizes only `SnapshotExpired`/`RevisionAhead`, so the test now throws `SnapshotExpired`.

**Deliberately left open, with reason**
- `takeAll` as its own RPC: would have to go through claims/idempotency, member admission, gate roles, replication and
  feature negotiation (nano and big are not updated at the same time). The callers mostly delete 0–2 entries.
- `#remoteCall` (help-site, now `RemoteShard.call`): not a duplicate; `RemoteSpace` bounds only the single attempt
  and repeats it; the total time against a dead shard is bounded only by this timeout.
- `#syncRemoteShard`: a `count` per `replyTo` would be hundreds of calls instead of one read round on join; reading
  stayed (now in pages).
- `#pageScan`: fallback until the history index exists (commented as such).
- `existsOrHeld()` in spaces-mmo: superfluous after L4, the `StillHeld` branches are short.
- `formatStatus`/`formatWidget`/`watchLive`, `LiveMirror`, `runTupleBasics`, `SWARM_CLAIM_RESULT_MS`: used by tests,
  examples or the documentation.
- The list of the 72 exports used only internally (`out-dead.txt`) is not available; without a tool (knip/ts-prune) it cannot
  be verified reliably.
- `help-site/dist/` is not checked in (`help-site/.gitignore`), nothing to do there.
- `theme.ts`/`ThemeControls.tsx` and `launch.ts` stay different per project (language, `prefers-color-scheme`, roles).

## Open after the first pass (status before the addendum)
- `SocialSwarmHub` god class (1.8k lines): the `#remote*` shard logic can be extracted.
- `hub.ts snapshot()` reads 11 types completely per push; a snapshot cache per revision or readPage with a budget would be the lever.
- `#syncRemoteShard`/`#pageScan` (help-site) read all posts instead of targeted counting/pages; commented fallbacks until the history index exists.
- `takeAll(tmpl)` as a library operation instead of `while (await take(tmpl, NO_WAIT))` (7× in the projects); would need its own RPC.
- `#remoteCall` timeout next to `RemoteSpace.callTimeoutMs` (both, defensive).
- `help-site/dist/` contains generated artifacts next to the sources (build output in the checkout).
- Drifting copies markdown.ts/palettes.ts/ws.ts/theme.ts/launch.ts, ~1.2k lines (for the answer to the summary see the report).
