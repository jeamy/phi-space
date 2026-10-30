---
standard: help_topic
id: help.topic.snapshots_and_change_streams
title: "Snapshot-Seiten (readPage) und Revisionsströme (changes)"
short: "Wie Clients mit readPage konsistente, bytebegrenzte Snapshots lesen und über changes(afterRev) lückenlos nachfolgende Commits streamen."
tags: [readpage, changes, snapshot, stream, revision, rev, pagination]
owner: client
related: [help.topic.durable_mailboxes_and_ack, help.api.phispaces_read_page_changes]
since: 0.0.1
---

# Snapshot-Seiten (readPage) und Revisionsströme (changes)

## Überblick {#overview}

Eine Live-Ansicht, etwa ein Chat, muss zweierlei können: den aktuellen Stand laden und danach jede Änderung mitbekommen. Dafür gibt es zwei Werkzeuge. Das eine liefert ein Foto des Space, bei Bedarf in mehreren Seiten. Das andere liefert alles, was seit diesem Foto passiert ist. Zusammen geht nichts verloren.

### Technische Details {#technical-details}

`phi-spaces` kombiniert **unveränderliche Punkt-in-Zeit-Snapshots (`readPage`)** mit einem **monotonen Revisionsstrom (`changes`)**. So bleiben Oberflächen wie der Multiplayer Space-Chat oder das Space-Dashboard synchron.

## Begriffs- und Systemmodell {#concept-model}

### Konsistente Seiten mit readPage {#read-page}

```ts
const page = await space.readPage(template, { maxBytes: 65536 });
// page = { items: EntryView[], next: string | null, token?: string, rev: number, streamId: string }
```

- Passt die ganze Antwort auf eine Seite, entsteht **kein Snapshot** und kein `token`; `next` ist dann `null`, und die meisten Lesevorgänge sind damit erledigt.
- Passt sie nicht, legt die erste Seite im Space-Cache einen Snapshot zur Revision `page.rev` an (TTL: 60 s, max. 16 aktive Tokens / 64 MiB je Space).
- Folgeaufrufe mit `space.readPage(template, { after: page.next, token: page.token })` lesen garantiert **denselben unveränderlichen Snapshot**, selbst wenn parallel neue Entries geschrieben werden oder Leases ablaufen.
- Nach Host-Neustart oder Ablauf der 60-s-TTL wirft der nächste Seitenabruf `SnapshotExpired`; der Client liest dann einfach eine neue erste Seite.
- `ResponseBudgetTooSmall` meldet mit `requiredBytes`, dass das nächste Element nicht ins Budget passt. Der Cursor bleibt unverändert.
- `readAll(template, { limit })` listet nur so viele Treffer. Ohne Limit liefert es alle, älteste zuerst.

### Inkrementelles Aufholen mit changes(afterRev) {#changes-stream}

```ts
const delta = await space.changes(page.rev, { maxBytes: 65536 });
// delta = { streamId: string, batches: ChangeBatch[], next: number, rev: number, more: boolean }
```

- Jeder Commit im Space erhöht die Revision `rev` um 1.
- `changes(afterRev)` liefert alle seit `afterRev` sichtbar gewordenen Entry-Batches in Commit-Reihenfolge. Eine Seite enthält nur vollständige Batches.
- Mit `waitMs` wird daraus ein Long Poll: Die Antwort kommt beim ersten Batch oder nach Ablauf der Wartezeit.
- Ist das Revisionslog (`maxLogBytes`, Standard 4 MiB) bereits über `afterRev` hinaus rotiert, wirft der Aufruf `SnapshotExpired`, und der Client liest einen frischen `readPage`-Snapshot als neue Baseline. `RevisionAhead` meldet einen Cursor jenseits der aktuellen Revision.
- Ein `write` mit `transient: true` erscheint nur hier: als `put` mit `transient: true`, ohne Entry und ohne späteres `del`.

## Siehe auch {#see-also}

- [Dauerhafte Mailboxes (events / ack), wait und notify](help.topic.durable_mailboxes_and_ack#overview)
- [readPage & changes API](help.api.phispaces_read_page_changes)
