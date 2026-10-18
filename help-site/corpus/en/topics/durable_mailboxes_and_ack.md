---
standard: help_topic
id: help.topic.durable_mailboxes_and_ack
title: "Durable Mailboxes (events / ack), wait, and notify"
short: "How non-blocking wait and notify deliver events into persistent consumer mailboxes, and how prefix ACK differs from a transaction commit."
tags: [mailbox, events, ack, wait, notify, mailboxepoch]
owner: client
related: [help.topic.snapshots_and_change_streams, help.api.phispaces_wait_notify_mailbox, help.workflow.stage_v3_remote_socket]
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
const page = await remote.events({ after: cursor, waitMs: 5_000 });
if (page.gap) throw new Error("Mailbox reset: reload state before processing");
for (const item of page.events) {
  await handleEvent(item.event); // Must persist result and commit event.txn before returning.
}
if (page.events.length > 0) {
  await remote.ack(page.mailboxEpoch, page.next);
}
```

- **Critical Boundary**: `ack(epoch, upTo)` only acknowledges receipt of mailbox events up to sequence `upTo`—it is **not** a transaction commit! A delivered take transaction must still be committed explicitly via `commit(ev.event.txn)`.
- TTL expiry changes mailboxEpoch, reports gap and releases affected take reservations. Byte exhaustion rejects new effects with ResourceExhausted instead of silently dropping events.

## See Also {#see-also}

- [Stage 3 (v3-remote-socket): SpaceService, RemoteSpace & Mailboxes](help.workflow.stage_v3_remote_socket#overview)
- [wait, notify, events & ack API](help.api.phispaces_wait_notify_mailbox)
