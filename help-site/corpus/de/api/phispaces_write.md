---
standard: help_api
id: help.api.phispaces_write
title: "write – Entry schreiben"
short: "Legt einen neuen typisierten Entry mit Lebensdauer an; unterstützt Request-Replay, atomare Singleton-Anlage per unique und transiente Ausgaben."
tags: [write, entry, lease, txn, requestref, mutation]
owner: client
related: [help.topic.entries_and_templates, help.api.phispaces_take]
since: 0.0.1
---

# write – Entry schreiben

## Überblick {#overview}

`write` legt einen neuen Eintrag in den Space, den andere Programme dann finden können. Du nutzt es für alles, was geteilt werden soll: Nachrichten, Aufgaben, Zustände. Ein vorhandener Eintrag wird nie überschrieben. Jeder Eintrag läuft nach einer gewählten Zeit ab oder bleibt dauerhaft.

## Technische Referenz {#technical-reference}

`space.write(entry, txn?, lease?, options?)` schreibt einen neuen Entry `{ type, types?, fields }` in den Space und gibt dessen `Lease { id, expires }` zurück. Ohne `lease` gilt `ANY`: Der Space wählt die Dauer.

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
- **Mehrere Schritte**: `batch(ops)` schreibt mehrere Entries samt Commit in einem Aufruf (siehe [Transaktionen](help.api.phispaces_txn#parameters)).
- **Text**: Über den Dienst wird ein unpaariges Surrogat in Strings und Schlüsseln zu U+FFFD, bevor etwas den Aufruf sieht. `cutText(text, max)` aus `phi-spaces` kürzt Text ohne halbes Emoji.

## Parameter und Rückgabewert {#parameters}

| Parameter | Typ | Bedeutung |
| --- | --- | --- |
| `entry` | `EntryDraft` | Entwurf: Pflicht-`type`, optionale Subtypenliste `types` und freie JSON-`fields`. |
| `txn` | `string | null` | ID einer offenen Transaktion; `null` = sofortiger eigenständiger Commit. |
| `lease` | `number` | Lebensdauer in Millisekunden, `FOREVER` für unbegrenzt oder `ANY` (Standard, der Space wählt). |
| `options.unique` | `string[]` | Optionale atomare Erstanlage über Schlüsselfelder, je Space und nicht über Shards. Ein vorhandener Treffer, auch reserviert oder uncommitted, ergibt `UniqueConflict`. Remote benötigt `write.unique`. |
| `options.transient` | `boolean` | Legt keinen Entry an: Der Änderungsstrom trägt ein `put` mit `transient: true`, kein `read`, `take`, `wait`, `count` oder Abo sieht es. Nicht zusammen mit `unique`. Remote benötigt `write.transient`. |
| `options.request` | `RequestRef` | Optionaler Claim `{ principal, generation, requestId }` für neustartfeste Idempotenz. |
| **Rückgabe** | `Promise<Lease>` | `{ id, expires }` – Grundlage für `renew`/`cancel` und Presence-Heartbeats. |

## Typische Anwendungsfälle {#use-cases}

- **Chat-Nachrichten**: `Msg`-Entries mit `FOREVER`-Lease bilden das dauerhafte, anhängbare Gesprächslog.
- **Aufgaben einstellen**: Ein `ChatTask`-Entry aktiviert den Chat-Worker – der Produzent muss den Worker weder kennen noch erreichen.
- **Präsenz**: `Presence`-Entries mit 30-s-Lease; verschwindet ein Client, räumt der Reaper seinen Eintrag automatisch ab.
- **Geplante Aufgaben**: `ScheduledJob` + `TimerLock`-Lease realisieren Alarme und Wartungsfenster ohne eigenen Scheduler-Prozess.
