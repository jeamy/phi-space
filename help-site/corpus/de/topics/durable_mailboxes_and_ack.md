---
standard: help_topic
id: help.topic.durable_mailboxes_and_ack
title: "Dauerhafte Mailboxes (events / ack), wait und notify"
short: "Wie nichtblockierendes wait und notify Ereignisse in persistente Consumer-Mailboxes zustellen und was Präfix-ACK von einem Transaktions-Commit unterscheidet."
tags: [mailbox, events, ack, wait, notify, mailboxepoch]
owner: client
related: [help.topic.snapshots_and_change_streams, help.api.phispaces_wait_notify_mailbox, help.workflow.stage_v3_remote_socket]
since: 0.0.1
---

# Dauerhafte Mailboxes (events / ack), wait und notify

## Überblick {#overview}

Manchmal wartet man nicht Sekunden, sondern Tage auf etwas. Dann soll kein Programm die ganze Zeit blockiert sein. Stattdessen hinterlegst du einen Wunsch: „Sag mir Bescheid, wenn so etwas auftaucht.“ Die Nachricht landet in einem Briefkasten und bleibt dort, bis du sie abholst und bestätigst.

### Technische Details {#technical-details}

Während `read(template, timeout)` und `take(template, timeout)` den aktuellen Aufruf blockieren (max. 60 s in Agent-Tools), erlauben `wait` und `notify` das **langlebige, nichtblockierende Parken** von Such- und Benachrichtigungsaufträgen über Stunden, Tage oder `FOREVER`. Beide brauchen `startService`, damit Zustellung und Reaper im Leerlauf laufen.

## Begriffs- und Systemmodell {#concept-model}

### wait vs. notify {#wait-vs-notify}

- **`space.notify(template, { target, txn?, lease?, handback? })`**: Jedes Mal, wenn ein passender Entry sichtbar wird, legt der Space ein Event in die Mailbox von `target`. `notifyIntervalMs` (Standard 1 s) bündelt schnelle Folgen.
- **`space.wait(template, { take?, target, timeout, txnLeaseMs?, handback? })`**: Einmaliger Auftrag. Bei `take: true` reserviert der Space den gefundenen Entry sofort in einer **frischen Transaktion** für `target` und legt Entry samt `txnId` in die Mailbox.

### Consumer-Mailbox und Präfix-ACK {#mailbox-and-ack}

Entfernte Clients (`RemoteSpace`) rufen ihre Mailbox über `events` ab und bestätigen verarbeitete Nachrichten per `ack`:

```ts
const page = await remote.events({ after: cursor, waitMs: 5_000 });
if (page.gap) throw new Error("Mailbox reset: reload state before processing");
for (const item of page.events) {
  await handleEvent(item.event); // Ergebnis speichern und event.txn committen, bevor es weitergeht.
}
if (page.events.length > 0) {
  await remote.ack(page.mailboxEpoch, page.next);
}
```

- **Wichtige Grenze**: `ack(epoch, upTo)` bestätigt ausschließlich, dass der Consumer die Mailbox-Nachrichten bis Sequenz `upTo` erhalten hat. Es ist **kein** Transaktions-Commit. Die übergebene Take-Transaktion muss separat mit `commit(ev.event.txn)` abgeschlossen werden.
- Bei TTL-Ablauf wechselt `mailboxEpoch`; `gap` meldet den Verlustbereich, und betroffene Take-Reservierungen werden freigegeben. Bei vollem Bytebudget werden neue Wirkungen mit `ResourceExhausted` abgewiesen, nicht still Events verworfen.
- Eine Rolle `observer` darf `notify`, `events` und `ack` für ihre eigene Mailbox benutzen. Wie oft der Dienst bei einem Long Poll nachsieht, steht unter [Wann wartende Aufrufe nachsehen](help.topic.space_service_and_remote_space#polling).

## Siehe auch {#see-also}

- [Stufe 3 (v3-remote-socket): SpaceService, RemoteSpace & Mailboxes](help.workflow.stage_v3_remote_socket#overview)
- [wait, notify, events & ack API](help.api.phispaces_wait_notify_mailbox)
