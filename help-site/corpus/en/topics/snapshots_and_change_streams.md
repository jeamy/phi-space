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

To keep a live UI—such as our Multiplayer Space-Chat or the Space Dashboard—in sync, `phi-spaces` combines **immutable point-in-time snapshots (`readPage`)** with a **monotonic revision stream (`changes`)**.

## Concept And System Model {#concept-model}

### Consistent Pagination With readPage {#read-page}

```ts
const page = await space.readPage(template, { maxBytes: 65536 });
// page = { items: EntryView[], next: string | null, token?: string, rev: number, streamId: string }
```

- The first page pins a snapshot at revision `page.rev` in the space cache (TTL: 60 s, max 16 tokens / 64 MiB per space).
- Subsequent calls with `space.readPage(template, { after: page.next, token: page.token })` read **the exact same immutable snapshot**, even while concurrent writes or lease expirations occur.
- After a host restart or 60 s TTL expiry, continuing throws `SnapshotExpired`, signaling the client to re-baseline from page 1.

### Incremental Catch-Up With changes(afterRev) {#changes-stream}

```ts
const delta = await space.changes(page.rev, { maxBytes: 65536 });
// delta = { streamId: string, batches: ChangeBatch[], next: number, rev: number, more: boolean }
```

- Every space commit increments `rev` by 1.
- `changes(afterRev)` returns all committed entry batches after `afterRev` in commit order.
- If the revision log (4 MiB ring buffer) has rotated past `afterRev`, the client re-baselines with a fresh `readPage` snapshot.

## See Also {#see-also}

- [Durable Mailboxes (events / ack), wait, and notify](help.topic.durable_mailboxes_and_ack#overview)
- [readPage & changes API](help.api.phispaces_read_page_changes)
