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

Um eine Live-Oberfläche – wie unseren Multiplayer Space-Chat oder das Space-Dashboard – synchron zu halten, kombiniert `phi-spaces` **unveränderliche Punkt-in-Zeit-Snapshots (`readPage`)** mit einem **monotonen Revisionsstrom (`changes`)**.

## Begriffs- und Systemmodell {#concept-model}

### Konsistente Seiten mit readPage {#read-page}

```ts
const page = await space.readPage(template, { maxBytes: 65536 });
// page = { items: EntryView[], next: string | null, token?: string, rev: number, streamId: string }
```

- Die erste Seite erzeugt im Space-Cache einen Snapshot zur Revision `page.rev` (TTL: 60 s, max. 16 aktive Tokens / 64 MiB je Space).
- Folgeaufrufe mit `space.readPage(template, { after: page.next, token: page.token })` lesen garantiert **denselben unveränderlichen Snapshot**, selbst wenn parallel neue Entries geschrieben werden oder Leases ablaufen.
- Nach Host-Neustart oder Ablauf der 60-s-TTL wirft der nächste Seitenabruf `SnapshotExpired`; der Client liest dann einfach eine neue erste Seite.

### Inkrementelles Aufholen mit changes(afterRev) {#changes-stream}

```ts
const delta = await space.changes(page.rev, { maxBytes: 65536 });
// delta = { streamId: string, batches: ChangeBatch[], next: number, rev: number, more: boolean }
```

- Jeder Commit im Space erhöht die Revision `rev` um 1.
- `changes(afterRev)` liefert alle seit `afterRev` sichtbar gewordenen Entry-Batches in Commit-Reihenfolge.
- Ist das Revisionslog (4 MiB Ringpuffer) bereits über `afterRev` hinaus rotiert, liest der Client einen frischen `readPage`-Snapshot als neue Baseline.

## Siehe auch {#see-also}

- [Dauerhafte Mailboxes (events / ack), wait und notify](help.topic.durable_mailboxes_and_ack#overview)
- [readPage & changes API](help.api.phispaces_read_page_changes)
