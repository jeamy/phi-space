---
standard: help_api
id: help.api.phispaces_take
title: "take & takeIfExists – Entry exklusiv entnehmen oder reservieren"
short: "Entfernt einen passenden Entry sofort destruktiv oder reserviert ihn exklusiv unter einer Transaktion (Rückkehr bei Abort/Lease-Ablauf)."
tags: [take, takeifexists, exclusive, reservation, txn]
owner: client
related: [help.topic.leases_and_transactions, help.api.phispaces_txn]
since: 0.0.1
---

# take & takeIfExists – Entry exklusiv entnehmen oder reservieren

## Überblick {#overview}

`take` holt einen passenden Eintrag aus dem Space, und nur ein Aufrufer bekommt ihn. Das ist der Grundbaustein für Aufgaben: Mehrere Worker warten, einer gewinnt. Mit einer Transaktion ist die Entnahme vorläufig, und der Eintrag kommt zurück, wenn die Arbeit scheitert.

## Technische Referenz {#technical-reference}

Ohne `txn` ist die Entnahme sofort endgültig. Mit `{ txn }` wird der Entry für diese Transaktion reserviert und kehrt bei `abort(txn)` oder Ablauf der Transaktions-Lease automatisch in den Space zurück.

```ts
const txn = await space.createTransaction(30_000);
const task = await space.take({ type: "ChatTask", fields: { threadId: "main" } }, 5_000, { txn: txn.id });
```

- Steht der Entry-Typ unter einem `RunGate`, sind Entries nur nehmbar, solange der `RunGate` des Laufs auf `running` steht.
- `takeIfExists` wartet nur, solange Treffer gehalten werden. `takeExisting(space, template, waitMs, { txn })` unterscheidet zusätzlich fehlend von gehalten und wirft dann `StillHeld`.
- `takeAll(space, template, { txn })` nimmt jeden jetzt freien Treffer und liefert die Anzahl; gehaltene bleiben.
- `awaitWork(space, template, waitMs, halt?)` wartet auf Arbeit, ohne etwas zu halten: ein blockierendes `read` ohne Transaktion.

## Parameter und Rückgabewert {#parameters}

| Parameter | Typ | Bedeutung |
| --- | --- | --- |
| `template` | `Template` | Suchmuster wie bei `read`; höchstens ein Consumer gewinnt den exklusiven Zugriff. |
| `timeout` | `number` | Wartezeit in ms bis ein passender Entry verfügbar ist (`NO_WAIT`/`FOREVER` möglich). |
| `options.txn` | `string` | Optional: Reserviert den Entry unter der Transaktion statt ihn sofort zu löschen. |
| **Rückgabe** | `Promise<EntryView | null>` | Der entnommene bzw. reservierte Entry – oder `null` bei Timeout. |

## Typische Anwendungsfälle {#use-cases}

- **Worker-Reservierung**: Der Chat-Worker führt `take({ type: "ChatTask" }, FOREVER, { txn })` aus, schreibt die Antwort-`Msg` unter derselben `txn` und ruft `commit(txn)` – Aufgabe und Ergebnis erscheinen atomar.
- **Crash-Sicherheit**: Stürzt der Worker ab, läuft die Transaktions-Lease ab und der `ChatTask` kehrt automatisch in den Space zurück, wo ein anderer Worker ihn übernimmt.
- **Timer-Abrüstung**: Der Reaper entfernt abgelaufene `TimerLock`-Entries; `tickAlarms()` macht fällige `ScheduledJob`s danach zu `ChatTask`s.
