---
standard: help_topic
id: help.topic.snapshots_and_change_streams
title: "Snapshot Pages (readPage) and Revision Streams (changes)"
short: "How clients read consistent, byte-bounded snapshots via readPage and stream subsequent commits seamlessly via changes(afterRev)."
tags: [readpage, changes, snapshot, stream, revision, rev, pagination]
owner: client
related: [help.topic.durable_mailboxes_and_ack, help.api.phispaces_read_page_changes]
since: 0.0.1
---

# Snapshot Pages (readPage) and Revision Streams (changes)

## Overview {#overview}

A live view, such as a chat, has to do two things: load the current state and then notice every change. Two tools provide this. One gives you a photo of the space, in several pages if needed. The other gives you everything that has happened since that photo. Together, nothing gets lost.

### Technical Details {#technical-details}

`phi-spaces` combines **immutable point-in-time snapshots (`readPage`)** with a **monotonic revision stream (`changes`)**. This keeps views such as the Multiplayer Space-Chat or the Space Dashboard in sync.

## Concept And System Model {#concept-model}

### Consistent Pagination With readPage {#read-page}

```ts
const page = await space.readPage(template, { maxBytes: 65536 });
// page = { items: EntryView[], next: string | null, token?: string, rev: number, streamId: string }
```

- If the whole answer fits on one page, **no snapshot** is made and there is no `token`; `next` is then `null`, and most reads end here.
- If it does not fit, the first page pins a snapshot at revision `page.rev` in the space cache (TTL: 60 s, max 16 tokens / 64 MiB per space).
- Subsequent calls with `space.readPage(template, { after: page.next, token: page.token })` read **the exact same immutable snapshot**, even while concurrent writes or lease expirations occur.
- After a host restart or 60 s TTL expiry, continuing throws `SnapshotExpired`, signaling the client to re-baseline from page 1.
- `ResponseBudgetTooSmall` reports through `requiredBytes` that the next element does not fit the budget. The cursor stays as it was.
- `readAll(template, { limit })` lists only that many matches. Without a limit it returns all of them, oldest first.

### Incremental Catch-Up With changes(afterRev) {#changes-stream}

```ts
const delta = await space.changes(page.rev, { maxBytes: 65536 });
// delta = { streamId: string, batches: ChangeBatch[], next: number, rev: number, more: boolean }
```

- Every space commit increments `rev` by 1.
- `changes(afterRev)` returns all committed entry batches after `afterRev` in commit order. A page holds only complete batches.
- With `waitMs` it becomes a long poll: the answer comes at the first batch or when the wait ends.
- If the revision log (`maxLogBytes`, default 4 MiB) has rotated past `afterRev`, the call throws `SnapshotExpired` and the client re-baselines with a fresh `readPage` snapshot. `RevisionAhead` reports a cursor beyond the current revision.
- A `write` with `transient: true` appears only here: as a `put` with `transient: true`, with no entry and no later `del`.

## See Also {#see-also}

- [Durable Mailboxes (events / ack), wait, and notify](help.topic.durable_mailboxes_and_ack#overview)
- [readPage & changes API](help.api.phispaces_read_page_changes)
