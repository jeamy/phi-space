# Dauerhafte Pflege von Snapshot-Generationen

Stand: 2026-10-15. Die Pflege ersetzt redundante physische Kopien durch eine neue
gepagte Generation. Sie entfernt **keine** Origin-Events, Tombstones, Remove-Tags,
HLC-Informationen oder Request-Deduplizierung. Die Bedingung eines gemeinsamen
Kausalstands für eine spätere echte Historienverkürzung bleibt unverändert.

## Ablauf und API

`startSnapshotMaintenance(requestId, pageBytes?)` erfasst den vollständigen
aktuellen logischen Präfix und reserviert einen dauerhaften Wartungsauftrag.
`advanceSnapshotMaintenance(requestId)` kopiert pro Aufruf eine Seite, veröffentlicht
den neuen Kopf atomar oder entfernt ein altes Seitendokument. Der Zustand ist über
`snapshotMaintenanceStatus()` abrufbar. Der letzte Auftrag bleibt wiederholbar;
eine Änderung seines Seitenbudgets wird abgewiesen. Ein älterer noch belegter
Auftrag darf nicht erneut gestartet werden. Nach dem bewussten Vergessen seiner
abgelaufenen Belege muss der Betreiber weiterhin neue Auftrags-IDs verwenden.

Die Zustände sind `copying`, `cleaning`, `completed`. Während des Kopierens bleibt
die alte Generation lesbar. Bei Veröffentlichung werden alle damals erfassten
Overlay-Events und Generationen durch genau eine Referenz ersetzt. Neue lokale
Writes und Stream-Imports laufen weiter und bleiben als nachfolgendes Overlay in
derselben Reihenfolge erhalten. Der Source-Cursor zählt unverändert dieselben
Events. Es wird kein neues fachliches Event erzeugt.

Ein weiterer Snapshot-Import bleibt bis zum Wartungsabschluss gesperrt. Bereits
laufende Imports müssen vorher abgeschlossen oder abgebrochen werden. Das verhindert
einen konkurrierenden Wechsel der erfassten Generationen. Der reservierte neue
Bestand darf das normale Staging-Budget vorübergehend bis zur festen Wartungsgrenze
`3 × maxHistoryBytes + 2 MiB` überschreiten. Es gibt höchstens einen Auftrag und
höchstens 17 Transferbelege inklusive Wartungsreserve. Seiten bleiben auf 2.048
begrenzt, das bestehende atomare Commitbudget gilt unverändert.

Alte Referenzen werden erst nach der atomaren Veröffentlichung unzugänglich.
Danach wird je Commit ein altes Chunk-Dokument über `retireDoc` stillgelegt.
Dessen Transfer wird `retiring`, nach letzter Seite `retired`; erst dann sinkt
`retainedBytes` um dessen Reservation. Abbrüche vor oder nach jedem Commit setzen
anhand des gespeicherten Fortschritts fort. Ein neues Harness braucht keinen
flüchtigen Export-Cache: Seiten werden aus dem weiterhin unveränderten Präfix
reproduziert und gegen das dauerhafte Manifest geprüft.

`forgetSnapshotReceipt(snapshotId)` entfernt genau einen abgelaufenen Beleg in
`retired` oder `aborted`. Die frische Uhrprüfung bleibt verpflichtend. Lebende
Generationen und laufende Wartung sind ausgeschlossen. Eine erneute Aufnahme des
alten Manifests scheitert anschließend an dessen Ablauf. Bereits initialisierte
Stream-Checkpoints behalten ihre verifizierte Seed-Bindung unabhängig vom alten
Beleg; neue Seeds brauchen einen noch nachweisbaren veröffentlichten Snapshot.

Die Freigabe ist eine logische Speicherbereinigung. Historische JSONL-/SQLite-
Revisionen werden damit nicht physisch vom Datenträger gelöscht; dafür gelten
weiter die exklusiven Backend-Wartungs- und Löschverfahren. Das ist insbesondere
keine Principal-Löschung und keine Freigabe veralteter Backups.

## Nachweise

Acht zusätzliche Fälle prüfen JSONL und SQLite: tatsächliche Commit-Verluste vor
und nach Start, jeder Kopierseite, Veröffentlichung und jeder Stilllegung;
Neustarts, monotone Stream-Cursor, Request-Replay, Tombstones und entfernte Set-Tags,
Widerruf innerhalb des Commits, aktive Importkonflikte, Ablauf und Belegbereinigung.

Der große Fall führt drei Generationenwechsel mit 72 Events und jeweils 4 KiB
Payload durch. Bestehende Stream-Reihenfolge und Origin-IDs bleiben exakt erhalten;
der Overlay-Bestand wird leer. Tatsächliche StorageWrite-Arrays bleiben im
32-KiB-Testbudget. Die Messwerte und gebauten Serverfälle stehen in den aktuellen
[Nachweisen](../test/evidence/ap3-next-2026-10-15/README.md).
