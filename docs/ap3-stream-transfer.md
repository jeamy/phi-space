# Fortlaufender Entry-Austausch mit dauerhaftem Cursor

Stand: 2026-10-15. Der administrative Replikationsbaustein besitzt einen
fortlaufenden Pull-Worker. Daten und Quell-Cursor werden gemeinsam atomar
committed. Das ergänzt den [gepagten Snapshot-Transfer](ap3-snapshot-transfer.md);
ein öffentlicher Space-/NetBird-Replikationsdienst wird dadurch noch nicht gestartet.

## Quellbindung und Commit

`describeStream()` benennt Space, Autorität, Konfigurationshash, Quell-Replikat,
Inkarnation und die daraus deterministisch abgeleitete Stream-ID. Die Revision
zählt die unveränderliche lokale Empfangsreihenfolge. Der Worker erhält diese
Identität als expliziten Pin; eine abweichende Quelle beendet den Austausch.
Jeder Schritt fragt die Quelle erneut ab. Er hält keine Rechte-/Grant- oder
Challenge-Zustände über diesen Adapter hinweg fest.

`streamChanges(after, maxBytes)` liefert einen bytebegrenzten, ungeteilten Bereich.
`after`, `next`, Anzahl und Inhalt müssen zusammenpassen. Der SHA-256 bindet die
feste Quellidentität, den Bereich und die Events. Der veränderliche aktuelle
Head und `more` gehören nicht zu dieser Bereichsidentität: Ein Bereich bleibt
wiederholbar, wenn die Quelle inzwischen weitere Änderungen angehängt hat.
Hash und Pin ersetzen keine authentifizierte Transportverbindung.

`startStreamImport(source, snapshotId?)` erzeugt einen dauerhaften Quell-Checkpoint
in `pi-spaces.entry-stream-checkpoints`. Ohne Snapshot beginnt er bei null. Ein
Snapshot darf ihn auf R vorsetzen, wenn dessen abgeschlossener Beleg und die
tatsächlich veröffentlichte Generation exakt zu dieser Quelle gehören. Ein
bestehender weiter fortgeschrittener Cursor wird niemals zurückgesetzt.

`importStreamPage(page)` nimmt nur den Bereich ab dem gespeicherten Cursor an.
Die importierten Events, HLC/Sequenzen und der neue Cursor werden im selben
Storage-Commit gespeichert. Ein verlorener Reply nach dem Commit erzeugt daher
keine zweite Wirkung. Auch bereits bekannte weitergeleitete Events dürfen den
Quell-Cursor fortschreiben; sie erzeugen keine neuen lokalen Änderungen.

Pro Quelle bleibt die letzte Bereichsquittung erhalten. Deren identische
Wiederholung liefert das gespeicherte Resultat; veränderter Inhalt wird abgewiesen.
Ältere oder überlappende Bereiche liefern `EntryStreamCursorConflict`, ohne etwas
anzuwenden. Der Treiber liest dann den aktuellen Checkpoint neu. Es wird keine
unbegrenzte zweite Reply-Historie aufgebaut. Die eigentlichen Origin-IDs und
Deduplizierungsinformationen verbleiben in der Entry-Historie.

## API und Worker

| Methode / Typ | Wirkung |
|---|---|
| `describeStream()` | Gebundene Quellidentität und aktuelle Revision |
| `streamChanges(after, maxBytes)` | Bytebegrenzter, integritätsgeprüfter Bereich der Quelle |
| `startStreamImport(source, snapshotId?)` | Checkpoint bei null oder nach geprüftem Snapshot initialisieren; keinen Cursor zurücksetzen |
| `streamImportStatus(source)` | Dauerhaften Cursor und letzte Quittung frisch autorisiert lesen |
| `importStreamPage(page)` | Events und Cursor atomar übernehmen |
| `EntryReplicationSource` | Expliziter Adapter mit read-only `describe` und `changes`, jeweils mit optionalem AbortSignal |
| `EntryReplicationPump.step(signal?)` | Einen Bereich ziehen; Ergebnis `applied`, `idle` oder bei Konkurrenz `raced` |
| `EntryReplicationPump.run(signal)` | Explizit gestartete Pull-Schleife bis Abbruch oder dauerhaftem Fehler |

Bei `raced` ist `revision` ausdrücklich `null`: Der Worker kennt aus dem
Checkpoint nur den neuen Quell-Cursor, keine aktuelle lokale Entry-Revision.
`applied` kann `added: 0` liefern, wenn der Bereich ausschließlich schon bekannte
Events enthält. Bei `idle` bleibt die letzte Reply-Quittung erhalten.

Die Schleife startet nicht automatisch mit einem Host. Sie fragt standardmäßig
alle 1.000 ms nach. Nur ausdrücklich als `EntryReplicationUnavailable` klassifizierte
temporäre Quellfehler werden erneut versucht, mit 100 ms bis maximal 5.000 ms
Backoff. Rechte-, Konfigurations-, Quota- und lokale Storage-Fehler beenden den
Worker. Nach einem lokalen Harness-Neustart wird ein neuer Controller/Worker mit
demselben dauerhaften Quell-Checkpoint aufgebaut.

Quellaufrufe sind standardmäßig auf 5.000 ms begrenzt und erhalten ein AbortSignal.
Ein Abbruch beendet auch das Warten auf einen nicht kooperierenden read-only
Quelladapter; dessen späteres Ergebnis wird nicht mehr importiert. Ein bereits
laufender lokaler Commit darf atomar fertig werden. Sein Resultat bleibt über
den Checkpoint rekonstruierbar. `onProgress` wird erst nach dem Schritt aufgerufen.

## Grenzen und Vertrauensbereich

- Höchstens 32 Quell-Checkpoints je Replica-Dokument, nur konfigurierte Ursprünge.
- Höchstens 1.024 Änderungen und 256 KiB je Stream-Antwort.
- Der Worker fordert standardmäßig 90.112 Bytes bei 192-KiB-Commitbudget an;
  `2 × pageBytes + 16 KiB` muss in das Zielbudget passen.
- Poll-, Retry- und Timeout-Werte sind auf 10 bis 60.000 ms beschränkt.
- Die bestehende begrenzte Entry-Historie und Snapshot-Staging-Quota gelten weiter.

Die Optionen `authorize` und `assertActive` bleiben verpflichtende frische
Betreiberprüfungen. Der Source-Adapter muss Quelle und Transport tatsächlich
prüfen und temporäre Netzwerkfehler passend klassifizieren. Die vorhandene
`SpaceService`-RPC-Allowlist wird nicht stillschweigend um einen Importpfad ergänzt.
Schicht-B-/Grant-Einbindung, Boot-Rolle, Löschbarrieren einschließlich dieser neuen
Checkpoint-Dokumente und die produktive Clock-Health-Anbindung gehören zu AP 3.3.

## Nachweise und verbleibende Arbeit

13 neue Fälle prüfen JSONL und SQLite: Snapshot-Startpunkt, Commit-Verlust vor/nach
Checkpoint-Beginn und jeder Stream-Seite, identische Wiederholung, unveränderte
letzte Quittung nach leerem Poll, Rechteentzug innerhalb des Commit-Pfads,
veränderte Quellen/Bereiche, konkurrierende Worker und monotone Cursor.

Ein echter Loopback-TCP-Server wird geschlossen und auf demselben Port erneut
geöffnet. Der Worker setzt mit demselben Cursor fort. Bidirektionale Worker
konvergieren nach einer **simulierten** zehnminütigen Partition ohne Echo-Wachstum;
abgelaufene LWW-Gewinner machen alte Versionen nicht wieder sichtbar. Eigene
Prüfungen begrenzen hängende Quellaufrufe und beenden die Schleife bei Abbruch
oder dauerhaftem Fehler.

Eine reale zehnminütige NetBird-Partition zwischen unabhängigen Hosts und die
Pflege alter Snapshot-Generationen/Belege bleiben offen. Primary/sync, Standby,
Fencing-Übergänge und Promotion sind dadurch nicht abgenommen.


## Aktueller Nachweis

530 Repository-Tests, 20 mobile Runtime-Tests und vier Lifecycle-Tests bestehen.
Typprüfung und lokale Dokumentlinks sind geprüft. Auf big bestehen alle 36
gebauten Fälle (11 Entry-, 12 Snapshot- und 13 Stream-Fälle). Der getrennte
32-KiB-Grenzfall misst auf beiden Backends maximal 7.386 Bytes für das gemeinsame
StorageWrite-Array aus Daten und Checkpoint. Das misst keine Disk-/fsync-Verstärkung.
[Artefakte und Nachweise](../test/evidence/ap3-stream-2026-10-15/README.md).
Der eigene Testcontainer ist entfernt; Bestandscontainer blieben unverändert.
