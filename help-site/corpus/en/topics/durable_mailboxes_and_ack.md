---
standard: help_topic
id: help.topic.durable_mailboxes_and_ack
title: "Durable Mailboxes (events / ack), wait, and notify"
short: "How non-blocking wait and notify deliver events into persistent consumer mailboxes, and how prefix ACK differs from a transaction commit."
tags: [mailbox, events, ack, wait, notify, mailboxepoch]
owner: client
related: [help.topic.snapshots_and_change_streams, help.api.pispaces_wait_notify_mailbox, help.workflow.stage_v3_remote_socket]
since: 0.0.1
---

# Durable Mailboxes (events / ack), wait, and notify

## Overview {#overview}

While `read(template, timeout)` and `take(template, timeout)` block the active call (capped at 60 s in agent tools), `wait` and `notify` allow **long-lived, non-blocking registration** of read/take waiters and subscriptions for hours, days, or `FOREVER`.

## Concept And System Model {#concept-model}

### wait vs. notify {#wait-vs-notify}

- **`space.notify(template, { target, txn?, lease?, handback? })`**: Whenever a matching entry becomes visible, the space appends an event to `target`'s mailbox.
- **`space.wait(template, { take?, target, timeout, txnLeaseMs?, handback? })`**: One-shot waiter. With `take: true`, the space reserves the matched entry inside a **fresh transaction** owned by `target` and delivers both the entry and `txnId` to the mailbox!

### Consumer Mailbox And Prefix ACK {#mailbox-and-ack}

Remote clients (`RemoteSpace`) poll their mailbox via `events` and acknowledge processed prefixes via `ack`:

```ts
const page = await remote.events("self", { after: cursor, waitMs: 5_000 });
for (const ev of page.events) {
  // For a take-waiter, ev.txn holds the reserved transaction:
  // write result and commit ev.txn!
}
if (page.next !== null) {
  await remote.ack("self", page.mailboxEpoch, page.next);
}
```

- **Critical Boundary**: `ack(epoch, upTo)` only acknowledges receipt of mailbox events up to sequence `upTo`—it is **not** a transaction commit! A delivered take transaction must still be committed explicitly via `commit(ev.txn)`.
- If a mailbox overflows its 7-day TTL or 8 MiB limit, `mailboxEpoch` increments, `gap` is reported, and unacknowledged take reservations are released.

## See Also {#see-also}

- [Stage 3 (v3-remote-socket): SpaceService, RemoteSpace & Mailboxes](help.workflow.stage_v3_remote_socket#overview)
- [wait, notify, events & ack API](help.api.pispaces_wait_notify_mailbox)
