---
standard: help_api
id: help.api.pispaces_read_page_changes
title: "readPage & changes – Consistent Snapshots and Revision Streams"
short: "Reads byte-bounded pages of an immutable snapshot (with token and rev) and catches up on subsequent commit batches via changes(afterRev)."
tags: [readpage, changes, readall, count, stats, snapshot]
owner: client
related: [help.topic.snapshots_and_change_streams]
since: 0.0.1
---

# readPage & changes – Consistent Snapshots and Revision Streams

## Overview {#overview}

`readPage(template?, options?)` and `changes(afterRev, options?)` enable consistent initial loading followed by gapless live streaming. For quick queries, `readAll(template?, { limit?, txn? })`, `count(template?, txn?)`, and `stats()` are also available.

## Technical Reference {#technical-reference}

```ts
const firstPage = await space.readPage({ type: "Msg", fields: { threadId: "main" } });
const deltas = await space.changes(firstPage.rev);
const gauges = await space.stats();
```

## Key Methods {#parameters}

| Method | Return | Purpose |
| --- | --- | --- |
| `readPage(template?, opts?)` | `Page { entries, rev, token? }` | Immutable point-in-time snapshot, continued page-by-page via `token` under a byte budget. |
| `changes(afterRev, opts?)` | `Changes { rev, batches, gaps? }` | All commit deltas since `afterRev` in order; `gaps` marks compacted ranges. |
| `readAll(template?, { limit?, txn? })` | `EntryView[]` | Convenience full read without paging (for small result sets). |
| `count(template?, txn?)` / `stats()` | `number` / gauges | Fast size and fill-level queries for dashboards. |

## Typical Use Cases {#use-cases}

- **UI bootstrap + live sync**: The chat client loads the thread history via `readPage` and then attaches to the realtime stream with `changes(page.rev)` – gapless and without duplicates.
- **Live Space Inspector**: The workbench inspector and `AdminSpaces` use `readPage`/`readAll`/`stats` to display the current contents of every space (v1–v6).
- **Backfill after reconnect**: After an interruption, the client fetches all missed revision batches via `changes` instead of reloading the entire space.
