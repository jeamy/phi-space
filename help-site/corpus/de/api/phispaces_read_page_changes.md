---
standard: help_api
id: help.api.phispaces_read_page_changes
title: "readPage & changes – Konsistente Snapshots und Revisionsströme"
short: "Liest bytebegrenzte Seiten eines unveränderlichen Snapshots (mit token und rev) und holt nachfolgende Commit-Batches über changes(afterRev) auf."
tags: [readpage, changes, readall, count, stats, snapshot]
owner: client
related: [help.topic.snapshots_and_change_streams]
since: 0.0.1
---

# readPage & changes – Konsistente Snapshots und Revisionsströme

## Überblick {#overview}

`readPage` liest den Inhalt eines Space seitenweise, und alle Seiten zeigen denselben Stand. `changes` liefert danach nur noch, was sich seitdem geändert hat. Zusammen laden sie eine Ansicht vollständig und halten sie dann aktuell, ohne dass etwas fehlt oder doppelt kommt.

## Technische Referenz {#technical-reference}

`readPage(template?, options?)` und `changes(afterRev, options?)` ermöglichen konsistentes Initial-Laden und anschlussfähiges Live-Streaming ohne verlorene oder doppelte Ereignisse. Daneben stehen `readAll(template?, { limit?, txn? })`, `count(template?, txn?)` und `stats()` zur Verfügung.

```ts
const firstPage = await space.readPage({ type: "Msg", fields: { threadId: "main" } });
const deltas = await space.changes(firstPage.rev);
const gauges = await space.stats();
```

## Wichtige Methoden {#parameters}

| Methode | Rückgabe | Zweck |
| --- | --- | --- |
| `readPage(template?, opts?)` | `Page { items, next, rev, streamId, token? }` | Unveränderlicher Punkt-in-Zeit-Snapshot, bytebegrenzt seitenweise über `next` fortsetzbar. Passt die Antwort auf eine Seite, entsteht kein Snapshot und kein Token. |
| `changes(afterRev, opts?)` | `Changes { streamId, batches, next, rev, more }` | Alle seit `afterRev` committeten Deltas in Reihenfolge. Mit `waitMs` ein Long Poll bis zum ersten Batch. Ein Cursor außerhalb der gehaltenen Historie löst `SnapshotExpired` oder `RevisionAhead` aus. |
| `readAll(template?, { limit?, txn? })` | `EntryView[]` | Snapshot-Liste ohne eigenes Paging, älteste zuerst. Mit `limit` listet der Space nur so viele. |
| `readChain(template, opts?)` | `ChainPage` | Optional: bis zu 512 verkettete Entries aus einem Snapshot, ohne Commit (Feature `read.chain`). |
| `count(template?, txn?)` / `stats()` | `number` / Gauges | Schnelle Größen- und Füllstandsabfragen für Dashboards. |
| `statsWithRevision()` | `{ stats, rev, streamId, process? }` | Kennzahlen samt Revision; zwei Abfragen ergeben die Commits dazwischen. Remote trägt `process` CPU und Speicher des bedienenden Prozesses. |

## Typische Anwendungsfälle {#use-cases}

- **UI-Bootstrap + Live-Sync**: Der Chat-Client lädt die Thread-Historie per `readPage` und hängt sich anschließend mit `changes(page.rev)` an den Echtzeitstrom – lückenlos und ohne Duplikate.
- **Live Space-Inspector**: Der Inspektor der Workbench und `AdminSpaces` zeigen den aktuellen Bestand der Spaces; das Dashboard liest `statsWithRevision` und `spaces()`.
- **Backfill nach Reconnect**: Nach einer Unterbrechung holt der Client alle verpassten Revisions-Batches über `changes` nach, statt den gesamten Space neu zu laden.
