---
standard: help_topic
id: help.topic.durable_mailboxes_and_ack
title: "Dauerhafte Mailboxes (events / ack), wait und notify"
short: "Wie nichtblockierendes wait und notify Ereignisse in persistente Consumer-Mailboxes zustellen und was Präfix-ACK von einem Transaktions-Commit unterscheidet."
tags: [mailbox, events, ack, wait, notify, mailboxepoch]
owner: client
related: [help.topic.snapshots_and_change_streams, help.api.pispaces_wait_notify_mailbox, help.workflow.stage_v3_remote_socket]
since: 0.0.1
---

# Dauerhafte Mailboxes (events / ack), wait und notify

## Überblick {#overview}

Während `read(template, timeout)` und `take(template, timeout)` den aktuellen Aufruf blockieren (max. 60 s in Agent-Tools), erlauben `wait` und `notify` das **langlebige, nichtblockierende Parken** von Such- und Benachrichtigungsaufträgen über Stunden, Tage oder `FOREVER`.

## Begriffs- und Systemmodell {#concept-model}

### wait vs. notify {#wait-vs-notify}

- **`space.notify(template, { target, txn?, lease?, handback? })`**: Jedes Mal, wenn ein passender Entry sichtbar wird, legt der Space ein Event in die Mailbox von `target`.
- **`space.wait(template, { take?, target, timeout, txnLeaseMs?, handback? })`**: Einmaliger Auftrag. Bei `take: true` reserviert der Space den gefundenen Entry sofort in einer **frischen Transaktion** für `target` und legt Entry samt `txnId` in die Mailbox!

### Consumer-Mailbox und Präfix-ACK {#mailbox-and-ack}

Entfernte Clients (`RemoteSpace`) rufen ihre Mailbox über `events` ab und bestätigen verarbeitete Nachrichten per `ack`:

```ts
const page = await remote.events("self", { after: cursor, waitMs: 5_000 });
for (const ev of page.events) {
  // Bei einem Take-Waiter trägt ev.txn die reservierte Transaktion:
  // Ergebnis schreiben und ev.txn committen!
}
if (page.next !== null) {
  await remote.ack("self", page.mailboxEpoch, page.next);
}
```

- **Wichtige Grenze**: `ack(epoch, upTo)` bestätigt ausschließlich, dass der Consumer die Mailbox-Nachrichten bis Sequenz `upTo` erhalten hat – es ist **kein** Transaktions-Commit! Die übergebene Take-Transaktion muss separat mit `commit(ev.txn)` abgeschlossen werden.
- Läuft eine Mailbox wegen 7-Tage-TTL oder 8-MiB-Limit über, erhöht sich `mailboxEpoch`, `gap` wird gemeldet und nicht bestätigte Take-Reservierungen werden wieder freigegeben.

## Siehe auch {#see-also}

- [Stufe 3 (v3-remote-socket): SpaceService, RemoteSpace & Mailboxes](help.workflow.stage_v3_remote_socket#overview)
- [wait, notify, events & ack API](help.api.pispaces_wait_notify_mailbox)
