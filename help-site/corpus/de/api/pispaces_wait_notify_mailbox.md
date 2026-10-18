---
standard: help_api
id: help.api.pispaces_wait_notify_mailbox
title: "wait, notify, events & ack – Reaktive Zustellung und Consumer-Mailboxes"
short: "Parkt langlebige Read/Take-Wünsche oder Event-Abos ohne Turn-Blockade; liefert Ergebnisse über dauerhafte Mailboxes mit Präfix-ACK."
tags: [wait, notify, events, ack, mailbox]
owner: client
related: [help.topic.durable_mailboxes_and_ack]
since: 0.0.1
---

# wait, notify, events & ack – Reaktive Zustellung und Consumer-Mailboxes

## Überblick {#overview}

`wait` und `notify` registrieren dauerhafte Aufträge im Space-Dokument. Über `events(principal, { mailboxEpoch?, after?, maxBytes? })` und `ack(principal, epoch, upTo)` verarbeiten Consumer die ausgelieferten Ereignisse zuverlässig über Neustarts hinweg.

## Technische Referenz {#technical-reference}

```ts
const waitId = await space.wait(
  { type: "ChatTask" },
  { take: true, target: principal, timeout: FOREVER, txnLeaseMs: 60_000, handback: { worker: "w1" } }
);
const mailboxPage = await space.events(principal, { after: lastSeq });
if (mailboxPage.next !== null) {
  await space.ack(principal, mailboxPage.mailboxEpoch, mailboxPage.next);
}
```

## Wichtige Methoden {#parameters}

| Methode | Zweck |
| --- | --- |
| `wait(template, opts)` | Parkt einen langlebigen Read-/Take-Wunsch (`take: true` reserviert automatisch unter einer impliziten Transaktion mit `txnLeaseMs`); liefert die Treffer an die Mailbox von `target`. |
| `notify(template, opts)` | Abonniert Änderungen auf ein Template und liefert Events in die eigene Principal-Mailbox. |
| `events(principal, { mailboxEpoch?, after?, maxBytes? })` | Bytebegrenzte Seite ausgelieferter Ereignisse ab Sequenz `after`; `mailboxEpoch`-Mismatch meldet eine `gap` statt stiller Verluste. |
| `ack(principal, epoch, upTo)` | Bestätigt ein verarbeitetes Sequenz-Präfix; erst ge-ack-te Ereignisse werden dauerhaft verworfen. |

## Typische Anwendungsfälle {#use-cases}

- **Ereignisgesteuerter Worker**: Statt `take(..., FOREVER)` zu blockieren, parkt der Worker einen dauerhaften Take-Wunsch mit `wait`; `pi-spaces` legt gewonnene Tasks samt `handback`-Kontext in seine Mailbox.
- **Robuster Consumer**: Der Worker verarbeitet `events`-Seiten und ackt erst nach erfolgreichem `commit` – bei Neustart werden unbestätigte Ereignisse erneut geliefert (At-least-once).
- **Notify-Streams**: UI- oder Audit-Consumer abonnieren `notify({ type: "Msg" })` und bleiben über `events`/`ack` über alle Raum-Änderungen informiert, auch über Prozessneustarts hinweg.
