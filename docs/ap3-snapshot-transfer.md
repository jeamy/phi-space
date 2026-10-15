# Gepagte Replikations-Snapshots

Stand: 2026-10-15. Der administrative Entry-Replikationsbaustein kann große
Snapshots in begrenzten Seiten empfangen und den Fortschritt nach Harness-Neustart
fortsetzen. Die Aktivierung benötigt nur einen kleinen atomaren Commit. Das ist
noch kein öffentlicher NetBird-Replikationsdienst und keine Primary-/Standby-Abnahme.

## Ablauf und atomare Sichtbarkeit

`startSnapshot(pageBytes?)` friert die vollständige logische Entry-Historie bei
Revision R ein. Das Manifest bindet Space, Autorität, Konfiguration, Quelle,
Inkarnation, R, Anzahl/Bytes, Seitenbudget und Ablaufzeit. Die Hashkette bindet
Reihenfolge, Offset und Inhalt jeder Seite bis zum abschließenden Hash. Owner,
Origin-ID, Tombstones, Remove-Tags, HLC und ursprüngliche Lease-Deadline bleiben
unverändert. SHA-256 ersetzt keine Authentifizierung des Replikators.

`beginSnapshotImport(manifest)` reserviert Staging-Kapazität und journalisiert
den Transfer. `importSnapshotPage(id, page)` speichert genau eine Seite atomar
zusammen mit dem nächsten Seitenindex, Offset und Ketten-Hash. Wiederholung einer
bereits gespeicherten Seite liefert nur bei identischem Inhalt denselben Stand.
Eine Seite darf keine Lücke überspringen. Staging-Daten sind für `read()` und
`changes()` unsichtbar. Empfangene HLC-Werte und eigene Sequenzen werden bereits
mit dem Seitenempfang fortgeschrieben: Ein danach entstehender lokaler Write ist
kausal neuer als die empfangene Änderung, auch wenn diese noch nicht sichtbar ist.
Ein Abbruch setzt solche Uhren/Zähler nicht zurück; Sequenzlücken sind zulässig.

`finishSnapshotImport(id)` prüft alle Seiten, Hashkette, Ursprungskonflikte und die
Kapazität erneut. Es veröffentlicht dann nur einen Verweis auf die unveränderlichen
Staging-Seiten und das Ergebnis des Transfers. Es kopiert nicht die große Historie
in einen Commit. Noch unvollständige oder widersprüchliche Transfers verändern
keine sichtbaren Entries.

Lokal entstandene Änderungen bleiben in der laufenden Overlay-Historie. Der
Verweis hält fest, bis zu welchem Overlay-Offset lokale Änderungen **vor** der
neuen Generation liegen. Spätere Writes liegen dahinter. Bei mehreren Generationen
bleibt diese Reihenfolge erhalten. Doppelte Origin-IDs werden nur einmal gelesen.
Bestehende `changes()`-Cursor behalten dadurch ihre Bedeutung; ein spät publizierter
Snapshot sortiert keine schon sichtbaren Änderungen um.

Dokumentversion 2 ergänzt die Generationenverweise. Bestehende Version-1-Historien
werden mit einer leeren Verweisliste übernommen; Entry-IDs, HLC, Requests und
Owner bleiben erhalten. Die tatsächliche Migration wird auf beiden Backends geprüft.

## Methoden

| Methode | Wirkung |
|---|---|
| `startSnapshot(pageBytes?)` | Unveränderliches Export-Manifest mit R und Ablaufzeit |
| `snapshotPage(id, index)` | Bytebegrenzte Seite desselben Snapshots, frisch autorisiert |
| `beginSnapshotImport(manifest)` | Dauerhafter Transferbeginn; dieselbe ID darf ihre Bindung nicht wechseln |
| `snapshotImportStatus(id)` | Dauerhafter Cursor, Manifest, Phase und gegebenenfalls Abschlussresultat |
| `importSnapshotPage(id, page)` | Seite und Fortschritt atomar speichern; identische Wiederholung zulassen |
| `finishSnapshotImport(id)` | Alle Seiten atomar sichtbar machen; unverändertes Abschlussresultat bei Retry |
| `abortSnapshotImport(id)` | Pro Aufruf höchstens eine gespeicherte Staging-Seite leeren; Fortschritt für Wiederaufnahme speichern |

Ein Treiber hält die Snapshot-ID fest und rekonstruiert nach Neustart seinen
nächsten Schritt aus `snapshotImportStatus(id)`. Die vollständige Manifestbindung
liegt zusätzlich im Zieljournal `EntrySnapshotTransfers`. Das Abschlussresultat
enthält `sourceRevision`: `source.changes(sourceRevision)` liefert die Änderungen,
die nach dem Export entstanden sind. Deren fortlaufender Transport und eigener
dauerhafter Stream-Checkpoint sind der nächste Teil von AP 3.2.

Bereits vollständig empfangene Snapshots dürfen auch nach Token-Ablauf und
Quell-Neustart fertiggestellt werden: Die Seiten sind dauerhaft und vollständig
geprüft. Fehlende Seiten eines abgelaufenen oder auf der Quelle verlorenen Tokens
lassen sich nicht neu anfordern. Dann den alten Import wiederaufnehmbar abbrechen
und ein neues Manifest verwenden. Ein veröffentlichter Snapshot ist nicht abbrechbar.

## Feste Grenzen und Backpressure

| Ressource | Grenze |
|---|---|
| Export-Tokens | Höchstens 16 je Host/Replica-Dokument, zusammen 64 MiB kodierte Inhalte |
| Token-Laufzeit | 60 Sekunden; Quell-Harness-Neustart beendet den In-Memory-Export |
| Seiten | Höchstens 2.048 je Snapshot, höchstens 1.024 Änderungen je Seite |
| Seitenbytes | Standard 90.112 bei 192-KiB-Commitbudget; `2 × pageBytes + 16 KiB` muss in das Ziel-Commitbudget passen; mindestens 1.024 Bytes |
| Aktive Transfers | Einer je Ziel-Replica-Dokument; einschließlich Abbruchphase |
| Transfer-/Generationenbelege | Höchstens 16; abgeschlossene und abgebrochene Belege bleiben erhalten |
| Reserviertes Staging | Höchstens zweimal `maxHistoryBytes`; Reservierung = Inhaltsbytes + 1.024 Bytes je Seite |
| Logische Historie | Weiterhin standardmäßig 16 MiB, maximal 64 MiB, einschließlich dauerhafter Konflikt-/Deduplizierungsdaten |

Die Quote berücksichtigt auch bereits veröffentlichte Seiten. Es gibt noch keine
automatische Bereinigung alter veröffentlichter Generationen/Belege. An den Grenzen
werden neue Transfers abgewiesen; es werden weder Tombstones noch Replay-Belege
verworfen. Beim abgeschlossenen Abbruch wird die Staging-Reservierung freigegeben.
Das Leeren aktiver Staging-Seiten ist keine physische Löschgarantie für alte
Backend-Revisionen. Laufende Transfers benötigen unveränderte Budgeteinstellungen.

Gleichzeitige lokale Writes können die Historie während des Downloads füllen.
Dann darf der Abschluss mit Backpressure scheitern; lokale Writes gehen dabei
nicht verloren. Nach Rechteentzug, Fencing, falscher Manifestbindung oder einem
veränderten Abschluss-Hash bleibt die Aktivierung gesperrt. Neue Snapshot- und
Staging-Dokumente benötigen dieselbe noch offene produktive Boot-/Löschintegration
wie die Entry-Replikation selbst; sie werden nicht automatisch auf Produktivdaten aktiviert.

## Tests und verbleibender Betrieb

Zwölf neue Fälle prüfen JSONL und SQLite: echte Version-1-Migration, Snapshots
oberhalb des einzelnen Commitbudgets, unveränderliche Seiten, lokale Writes während
des Imports, kausale HLC, stabile vollständige Cursor-Reihenfolge über mehrere
Generationen, ungültige Seiten/Bindungen, Ablauf und Abbruch sowie Backpressure.
Vor und nach tatsächlichem Storage-Commit werden Beginn, jede Seite und Abschluss
unterbrochen, Ziel-Harness neu geöffnet und dieselben IDs wiederholt. Reale
StorageWrite-Größen für Seiten, Veröffentlichung und nachfolgende Overlays werden
gegen das 32-KiB-Testbudget geprüft. Der veröffentlichende Commit bleibt im Test
unter 12 KiB, obwohl der Snapshot größer als das Commitbudget ist.

Der gebaute Serverfall führt diese zwölf und die elf bisherigen Entry-Invarianten
im isolierten Produktionsmodus-Container aus. Dies bleibt ein Bausteinnachweis;
realer Transport mit zehn Minuten Partition, Stream-Checkpoint, Dienst-/Grant-/
Boot-/Löschintegration und Primary/Standby besitzen eigene offene Abnahmen.
Siehe [Phase 3](ap3-replikation.md).


## Aktueller Nachweis

517 Repository-Tests, 20 mobile Runtime-Tests und vier mobile Lifecycle-Tests sind
grün; Typprüfung und Linkprüfung sind bestanden. Die 23 gebauten Replikationsfälle
bestehen außerdem auf big. Beide Backends übertragen im großen Fall 353.186 Bytes
in 20 Seiten. Der getrennte 32-KiB-Grenzfall misst maximal 3.743 Bytes (JSONL)
bzw. 3.746 Bytes (SQLite) je StorageWrite-Array und 2.433 Bytes für die
Veröffentlichung. [Artefakte und Nachweise](../test/evidence/ap3-paged-2026-10-15/README.md).
Der Testcontainer ist entfernt; Bestandscontainer blieben unverändert.
