---
standard: help_api
id: help.api.phispaces_read_page_changes
title: "readPage & changes – Consistent Snapshots and Revision Streams"
short: "Reads byte-bounded pages of an immutable snapshot (with token and rev) and catches up on subsequent commit batches via changes(afterRev)."
tags: [readpage, changes, readall, count, stats, snapshot]
owner: client
related: [help.topic.snapshots_and_change_streams]
since: 0.0.1
---

# readPage & changes – Consistent Snapshots and Revision Streams

## Overview {#overview}

`readPage` reads the content of a space page by page, and all pages show the same state. `changes` then delivers only what has changed since. Together they load a view completely and keep it current, with nothing missing or repeated.

## Technical Reference {#technical-reference}

`readPage(template?, options?)` and `changes(afterRev, options?)` enable consistent initial loading followed by gapless live streaming. For quick queries, `readAll(template?, { limit?, txn? })`, `count(template?, txn?)`, and `stats()` are also available.

```ts
const firstPage = await space.readPage({ type: "Msg", fields: { threadId: "main" } });
const deltas = await space.changes(firstPage.rev);
const gauges = await space.stats();
```

## Key Methods {#parameters}

| Method | Return | Purpose |
| --- | --- | --- |
| `readPage(template?, opts?)` | `Page { items, next, rev, streamId, token? }` | Immutable point-in-time snapshot, continued page by page via `next` under a byte budget. If the answer fits one page, no snapshot and no token are made. |
| `changes(afterRev, opts?)` | `Changes { streamId, batches, next, rev, more }` | All commit deltas since `afterRev` in order. With `waitMs` a long poll until the first batch. A cursor outside the held history raises `SnapshotExpired` or `RevisionAhead`. |
| `readAll(template?, { limit?, txn? })` | `EntryView[]` | Snapshot list without paging of your own, oldest first. With `limit` the space lists only that many. |
| `readChain(template, opts?)` | `ChainPage` | Optional: up to 512 linked entries from one snapshot, without a commit (feature `read.chain`). |
| `count(template?, txn?)` / `stats()` | `number` / gauges | Fast size and fill-level queries for dashboards. |
| `statsWithRevision()` | `{ stats, rev, streamId, process? }` | Figures with their revision; two queries give the commits in between. Remotely, `process` carries CPU and memory of the serving process. |

## Typical Use Cases {#use-cases}

- **UI bootstrap + live sync**: The chat client loads the thread history via `readPage` and then attaches to the realtime stream with `changes(page.rev)` – gapless and without duplicates.
- **Live Space Inspector**: The workbench inspector and `AdminSpaces` show the current contents of the spaces; the dashboard reads `statsWithRevision` and `spaces()`.
- **Backfill after reconnect**: After an interruption, the client fetches all missed revision batches via `changes` instead of reloading the entire space.
