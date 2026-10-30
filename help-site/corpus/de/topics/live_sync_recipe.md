---
standard: help_topic
id: help.topic.live_sync_recipe
title: "Live-UI: Snapshot, Changes und Wiederaufbau"
short: "Eine Oberfläche soll den Inhalt eines Space zeigen und aktuell bleiben. Dazu lädt sie erst den vollständigen Stand und wendet danach jede Änderung an. Erst wenn alles geladen ist, zeigt sie das Ergebnis, damit nie eine halbe Liste erscheint."
tags: [sync, snapshot, streamId, SnapshotExpired, RevisionAhead, cursor, delete]
owner: client
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Live-UI: Snapshot, Changes und Wiederaufbau

## Eine vollständige Baseline veröffentlichen {#overview}

Eine Oberfläche soll den Inhalt eines Space zeigen und aktuell bleiben. Dazu lädt sie erst den vollständigen Stand und wendet danach jede Änderung an. Erst wenn alles geladen ist, zeigt sie das Ergebnis, damit nie eine halbe Liste erscheint.

## Algorithmus {#recipe}

Eine erste Snapshot-Seite ist nicht die ganze Historie. Erst alle Seiten desselben Snapshots laden, dann nachfolgende Deltas vollständig anwenden und den neuen Zustand atomar der UI übergeben.

1. readPage(null) liefert items, next, rev, streamId und bei mehreren Seiten ein token.
2. Eine frische Map nach Entry-ID anlegen; Folgeseiten mit unverändertem Template/token und after: next laden, bis next null ist. Revision und Stream müssen gleich bleiben.
3. changes(baselineRev) lesen und put als Ersatz/Einfügen sowie del als Entfernung anwenden. Auch leere Batches tragen Revisionen. Ein put mit transient: true ist nur eine Ausgabe: anzeigen, aber nicht in die Map legen; ein del folgt nicht.
4. Mit delta.next fortsetzen, solange more true ist; Cursor erst nach erfolgreicher Verarbeitung übernehmen.
5. Bei SnapshotExpired, RevisionAhead oder anderem streamId die alte Projektion vollständig ersetzen, nicht eine neue erste Seite anhängen.
6. Nur den vollständig aufgebauten Zustand veröffentlichen; bei Fehlern bisherigen UI-Zustand sichtbar lassen und Retry anbieten.

## Getesteter Helfer {#code}

help-site/examples/shared/live-mirror.ts implementiert Baseline und Deltas dieses Ablaufs mit maximal drei Wiederaufbauversuchen. Wer transiente Ausgaben schreibt, filtert deren put selbst heraus. Der Helfer spiegelt den ganzen Space; Filter erst auf die fertige Projektion anwenden, damit put/del bei wechselnden Feldwerten korrekt bleiben. Aufruf in einem asynchronen Ablauf:

```ts
import { refreshMirror } from "./help-site/examples/shared/live-mirror.ts";
const mirror = await refreshMirror(space);
const updated = await refreshMirror(space, mirror);
console.log(updated.streamId, updated.rev, updated.entries.size);
```


## Fehlerfälle und Test {#boundaries}

Snapshot-Tokens sind prozesslokal und laufen ab; eine Antwort, die auf eine Seite passt, hat gar keinen Token. Die Revisionshistorie ist begrenzt. changes nimmt waitMs als Long Poll bis zum ersten Batch; RemoteSpace meldet einen nötigen Neuaufbau als SnapshotExpired. ResponseBudgetTooSmall verlangt ein ausreichendes Bytebudget, nicht stilles Überspringen eines Entries. Tests müssen mehrere Seiten, parallele Writes/Deletes, Replay derselben Deltas, Streamwechsel und verworfenen Teilaufbau abdecken. Der Snapshot-/Changes-Strom ist kein vollständiger Storage-Replikationsstrom.
