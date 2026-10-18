---
standard: help_topic
id: help.topic.live_sync_recipe
title: "Live UI: Snapshot, Changes and Resynchronization"
short: "The first snapshot page is not the complete history. Read every page of the same snapshot, apply all subsequent deltas, then publish the resulting state atomically to the UI."
tags: [sync, snapshot, streamId, SnapshotExpired, RevisionAhead, cursor, delete]
owner: client
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Live UI: Snapshot, Changes and Resynchronization

## Publish a Complete Baseline {#overview}

The first snapshot page is not the complete history. Read every page of the same snapshot, apply all subsequent deltas, then publish the resulting state atomically to the UI.

## Algorithm {#recipe}

1. readPage(null) returns items, next, token, rev and streamId.
2. Build a fresh Map keyed by Entry ID; fetch continuation pages using the same template/token and after: next until next is null. Revision and stream identity must remain unchanged.
3. Read changes(baselineRev); apply put as replacement/insertion and del as removal. Empty batches still carry revisions.
4. Continue from delta.next while more is true; advance the cursor only after processing succeeds.
5. On SnapshotExpired, RevisionAhead or a different streamId, replace the entire old projection rather than appending a fresh first page.
6. Publish only the complete new state; keep the old UI visible on errors and offer retry.

## Tested Helper {#code}

help-site/examples/shared/live-mirror.ts implements this recipe with at most three baseline attempts. It mirrors the whole Space; apply filters afterward so put/del remain correct when fields change. Call from an async workflow:

```ts
import { refreshMirror } from "./help-site/examples/shared/live-mirror.ts";
const mirror = await refreshMirror(space);
const updated = await refreshMirror(space, mirror);
console.log(updated.streamId, updated.rev, updated.entries.size);
```


## Failures and Test {#boundaries}

Snapshot tokens are process-local and expire; revision history is bounded. ResponseBudgetTooSmall requires enough bytes, not silently skipping an Entry. Tests must cover multiple pages, concurrent writes/deletes, replayed deltas, stream changes and discarded partial rebuilds. Snapshot/changes is not a complete storage replication stream.
