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

`readPage(template?, options?)` und `changes(afterRev, options?)` ermöglichen konsistentes Initial-Laden und anschlussfähiges Live-Streaming ohne verlorene oder doppelte Ereignisse. Daneben stehen `readAll(template?, { limit?, txn? })`, `count(template?, txn?)` und `stats()` zur Verfügung.

## Technische Referenz {#technical-reference}

```ts
const firstPage = await space.readPage({ type: "Msg", fields: { threadId: "main" } });
const deltas = await space.changes(firstPage.rev);
const gauges = await space.stats();
```

## Wichtige Methoden {#parameters}

| Methode | Rückgabe | Zweck |
| --- | --- | --- |
| `readPage(template?, opts?)` | `Page { items, next, rev, streamId, token? }` | Unveränderlicher Punkt-in-Zeit-Snapshot, bytebegrenzt seitenweise über `token` fortsetzbar. |
| `changes(afterRev, opts?)` | `Changes { streamId, batches, next, rev, more }` | Alle seit `afterRev` committeten Deltas in Reihenfolge; bei veraltetem Log wird `SnapshotExpired` ausgelöst. |
| `readAll(template?, { limit?, txn? })` | `EntryView[]` | Bequemer Komplettabruf ohne Paging (für kleine Ergebnismengen). |
| `count(template?, txn?)` / `stats()` | `number` / Gauges | Schnelle Größen- und Füllstandsabfragen für Dashboards. |

## Typische Anwendungsfälle {#use-cases}

- **UI-Bootstrap + Live-Sync**: Der Chat-Client lädt die Thread-Historie per `readPage` und hängt sich anschließend mit `changes(page.rev)` an den Echtzeitstrom – lückenlos und ohne Duplikate.
- **Live Space-Inspector**: Der Inspektor der Workbench und `AdminSpaces` nutzen `readPage`/`readAll`/`stats`, um den aktuellen Bestand jedes Spaces (v1–v6) anzuzeigen.
- **Backfill nach Reconnect**: Nach einer Unterbrechung holt der Client alle verpassten Revisions-Batches über `changes` nach, statt den gesamten Space neu zu laden.
