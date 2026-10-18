---
standard: help_api
id: help.api.pispaces_wait_notify_mailbox
title: "wait, notify, events & ack – Reactive Delivery and Consumer Mailboxes"
short: "Parks long-lived read/take requests or event subscriptions without blocking a turn; delivers results via durable mailboxes with prefix ACK."
tags: [wait, notify, events, ack, mailbox]
owner: client
related: [help.topic.durable_mailboxes_and_ack]
since: 0.0.1
---

# wait, notify, events & ack – Reactive Delivery and Consumer Mailboxes

## Overview {#overview}

`wait` and `notify` register durable subscriptions in the space document. Consumers poll delivered events via `events(principal, { mailboxEpoch?, after?, maxBytes? })` and confirm processed prefixes via `ack(principal, epoch, upTo)` across restarts.

## Technical Reference {#technical-reference}

```ts
const waitId = await space.wait(
  { type: "ChatTask" },
  { take: true, target: conversationId, timeout: FOREVER, txnLeaseMs: 60_000, handback: { worker: "w1" } }
);
const mailboxPage = await space.events(principal, { after: lastSeq });
if (mailboxPage.gap) throw new Error("Mailbox reset: reload state before processing");
for (const item of mailboxPage.events) await handleEvent(item.event); // Commit any take reservation first.
if (mailboxPage.events.length > 0) {
  await space.ack(principal, mailboxPage.mailboxEpoch, mailboxPage.next);
}
```

## Key Methods {#parameters}

| Method | Purpose |
| --- | --- |
| `wait(template, opts)` | Parks a long-lived read/take wish (`take: true` reserves automatically under an implicit transaction with `txnLeaseMs`); delivers matches to the `target` mailbox. |
| `notify(template, opts)` | Subscribes to changes matching a template and delivers events into the caller's principal mailbox. |
| `events(principal, { mailboxEpoch?, after?, maxBytes? })` | Byte-bounded page of delivered events after sequence `after`; a `mailboxEpoch` mismatch reports a `gap` instead of silent loss. |
| `ack(principal, epoch, upTo)` | Acknowledges a processed sequence prefix; acknowledged events are removed; TTL expiry can also remove events with a gap. |

## Typical Use Cases {#use-cases}

- **Event-driven worker**: Instead of blocking in `take(..., FOREVER)`, the worker parks a durable take wish with `wait`; `pi-spaces` places won tasks including the `handback` context into its mailbox.
- **Robust consumer**: The worker processes `events` pages and acks only after a successful `commit` – on restart, unacknowledged events are delivered again (at-least-once).
- **Notify streams**: UI or audit consumers subscribe via `notify({ type: "Msg" })` and stay informed about matching writes (not a complete deletion/change history) through `events`/`ack`, even across process restarts.
