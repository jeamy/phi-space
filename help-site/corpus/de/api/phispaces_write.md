---
standard: help_api
id: help.api.phispaces_write
title: "write – Entry schreiben"
short: "Schreibt einen typisierten Entry mit Lease; unterstützt Request-Replay und atomare Singleton-Erstanlage per unique."
tags: [write, entry, lease, txn, requestref, mutation]
owner: client
related: [help.topic.entries_and_templates, help.api.phispaces_take]
since: 0.0.1
---

# write – Entry schreiben

## Überblick {#overview}

`space.write(entry, txn?, lease?, options?)` schreibt einen neuen Entry `{ type, types?, fields }` in den Space und gibt dessen `Lease { id, expires }` zurück. Es gibt kein Überschreiben bestehender Entries.

## Technische Referenz {#technical-reference}

```ts
const lease = await space.write(
  { type: "Msg", fields: { threadId: "main", seq: 1, text: "Hallo" } },
  txnId ?? null,
  FOREVER,
  { request: { principal, generation, requestId: "msg-1" } }
);
```

- **Unter Transaktion (`txn`)**: Der geschriebene Entry ist bis `commit(txn)` nur für Lese-/Take-Aufrufe derselben Transaktion sichtbar.
- **Idempotenz**: Mit `options.request` liefert eine Wiederholung mit denselben Argumenten dieselbe `Lease` zurück, ohne einen zweiten Entry anzulegen.

## Parameter und Rückgabewert {#parameters}

| Parameter | Typ | Bedeutung |
| --- | --- | --- |
| `entry` | `EntryDraft` | Entwurf: Pflicht-`type`, optionale Subtypenliste `types` und freie JSON-`fields`. |
| `txn` | `string | null` | ID einer offenen Transaktion; `null` = sofortiger eigenständiger Commit. |
| `lease` | `number` | Lebensdauer in Millisekunden oder `FOREVER` für unbegrenzt. |
| `options.unique` | `string[]` | Optionale atomare Erstanlage über Schlüsselfelder; keine globale Unique-Zusage über Shards. Remote benötigt write.unique. |
| `options.request` | `RequestRef` | Optionaler Claim `{ principal, generation, requestId }` für neustartfeste Idempotenz. |
| **Rückgabe** | `Promise<Lease>` | `{ id, expires }` – Grundlage für `renew`/`cancel` und Presence-Heartbeats. |

## Typische Anwendungsfälle {#use-cases}

- **Chat-Nachrichten**: `Msg`-Entries mit `FOREVER`-Lease bilden das dauerhafte, anhängbare Gesprächslog.
- **Aufgaben einstellen**: Ein `ChatTask`-Entry aktiviert den Chat-Worker – der Produzent muss den Worker weder kennen noch erreichen.
- **Präsenz**: `Presence`-Entries mit 30-s-Lease; verschwindet ein Client, räumt der Reaper seinen Eintrag automatisch ab.
- **Geplante Aufgaben**: `ScheduledJob` + `TimerLock`-Lease realisieren Alarme und Wartungsfenster ohne eigenen Scheduler-Prozess.
