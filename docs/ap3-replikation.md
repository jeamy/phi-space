# Phase 3: Replikation und kontrollierte Übernahme

Stand: 2026-10-15. **Phase 3 ist begonnen, aber nicht abgenommen.**
Phase 2 und ihre dokumentierte Abschlussentscheidung bleiben unverändert.
Der Zielvertrag steht in Abschnitt 7.2 und Stufe 3 des
[Föderationsplans](federation-plan-v3.md).

## Umsetzung und verbleibende Schritte

| Teil | Stand | Verbleibender Nachweis |
|---|---|---|
| 3.1 Entry-Replikation | Persistenter HLC, LWW, versionierte Tombstones, Add-Wins-Tags, Deduplizierung, feste Replikat-Inkarnationen, bytebegrenzter Änderungsabruf und kleiner atomarer Snapshot-Merge implementiert | Lokale und gebaute Invariantentests sind Bausteinnachweise; noch keine produktive NetBird-Replikation |
| 3.2 Große Snapshots und fortlaufender Austausch | Offen | Unveränderliche bytebegrenzte Snapshot-Seiten, dauerhafte Import-Staging-Dokumente und atomarer Wechsel; Wiederaufnahme des Transport-Cursors, Backpressure und zehn reale Minuten Partition |
| 3.3 Einbindung in Spaces und Dienst | Offen | Policy-Modi, Typ-/Owner-Rechte, frische Import-Grants für genau Quelle/Ziel, Boot-Rolle `entryReplica`, Clock-Health, Widerruf, Löschbarrieren und verteilte Principal-Löschung auch dieser Historien; Lease-Renewal für Set-Tags; exklusive Txns/Takes ablehnen |
| 3.4 Vollständige Primary-/Standby-Historie | Offen | Unveränderliches CommitIntent vor Versand, lückenlose Hashkette, persistentes Standby-ACK, lokale Anwendung erst danach; alle Claims, Txns, Sperren, Mailboxes und Root-Dokumente atomar erfassen; keinen Erfolg ohne Standby |
| 3.5 `setStandby` und Single-Umschaltung | Offen | Dauerhaftes Übergangsjournal, Pausieren aller Schreibquellen inklusive Reaper, Standby-Aufbau, Fencing des ausgeschlossenen Hosts und passende externe Boot-Berechtigungen |
| 3.6 Promotion und Quarantäne | Offen | Nur fester synchroner Standby, verifizierter Fencing-Nachweis, lokale Konfiguration/Epoche, keine implizite Single-Freigabe; Negativclaims nur unter den vollständigen Voraussetzungen des Zielvertrags |
| 3.7 Gesamtbetrieb | Offen | Reale unabhängige Hosts, Overlay-Ausfälle, Prozess-/Storage-Grenzen, zehnminütige Partition mit Writes/Deletes/Renewals sowie Verlustfreiheit aller bestätigten Operationen |

## Baustein 3.1

`EntryReplicationController` speichert ein eigenes persistentes Session-Dokument
`pi-spaces.entry-replica`. Konfiguration und Dokumentadresse binden Space-ID,
Autorität, Replikat-ID, Inkarnation, erlaubte Ursprünge und Typregeln. Alle Replikate
verwenden denselben kanonisch gehashten Mitglieder-/Regelvertrag. Änderungen der
Mitgliedschaft oder Inkarnation an einem bestehenden Dokument werden abgewiesen;
Versionierung und Neuaufbau sind spätere explizite Übergänge.

Jede Änderung behält `(originReplicaId, incarnation, seq)`, Principal, absolute
Lease-Deadline, Request-ID und Argument-Hash. Doppelte Zustellung erzeugt keinen
neuen Eintrag. Dieselbe Änderungs-ID mit anderem Inhalt oder dieselbe lokale
Request-ID mit anderen Argumenten wird abgelehnt. Sequenzlücken werden nicht als
bereits empfangene Änderungen markiert; vertauschte Zustellung bleibt möglich.
Weiterleitung verändert weder Ursprung noch Lease und erzeugt keine Core-Events.

LWW erfordert eigene Schlüsselfelder. Die Ordnung lautet
`(hlc.physical, hlc.logical, replicaId)`. Die HLC-Uhr bleibt zusammen mit der
Änderung dauerhaft erhalten. Delete besitzt eine reguläre neuere Version.
Ist die gewinnende Put-Version abgelaufen, bleibt der Schlüssel unsichtbar;
ältere Puts werden nicht wieder sichtbar. Ein neuer Put derselben Felder mit
neuer absoluter Deadline ist die versionierte LWW-Erneuerung.

Beim Set ist jeder Add ein eigener Tag. Remove nennt höchstens 256 zuvor lokal
beobachtete Tags desselben Typs. Ein konkurrierender Add überlebt den Remove.
Import darf den Remove vor dessen Add empfangen; die entfernte Tag-Identität
bleibt erhalten und verhindert spätere Wiederbelebung. Weitergeleitete Änderungen
werden als vertrauenswürdige Replikator-Eingaben behandelt; ein Hash ersetzt keine
Signatur oder Transport-Autorisierung.

## API und Grenzen

Die neue API ist ein **administrativer Baustein**, der noch keinen öffentlichen
Replikationsdienst startet und bestehende `PiSpaces`-Entries nicht automatisch
übernimmt. `mutate(requestId, mutation)` ist ein eigener dauerhafter Schreibpfad;
`read()` liefert dessen Sicht. Die normalen Space-Txns, `take`, Notify, Directory,
Grants oder der Reaper benutzen ihn noch nicht.

| API | Bedeutung |
|---|---|
| `mutate(id, mutation)` | Lokaler Put/Delete/Add/Observed-Remove; eigene Metadaten werden vom Controller vergeben |
| `importChanges(events)` | Atomarer begrenzter Import; Ursprünge und Metadaten erhalten; keine neue Geschäftsoperation |
| `read()` | LWW-Gewinner und noch sichtbare Set-Adds mit Owner und absoluter Deadline |
| `changes(afterRevision, maxBytes)` | Bytebegrenzte Seiten der dauerhaften lokalen Empfangsreihenfolge; enthält auch Tombstones und Remove-Tags |
| `snapshot()` | Unveränderliche Kopie der vollständigen kleinen Historie einschließlich Deduplizierung, mit Bindung und SHA-256 |
| `installSnapshot(snapshot)` | Atomarer Merge mit lokalem Bestand; seit Export entstandene lokale Writes bleiben erhalten |

Der Snapshot ist derzeit ein einzelner kleiner atomarer Import, kein gepagter
Großsnapshot. Der konservative Test `2 × kodierte Änderungsbytes + 16 KiB` muss
in das standardmäßige 192-KiB-Batchbudget passen. Größere Snapshots werden vor
Mutation abgewiesen. Das maximale Batchbudget ist 192 KiB, höchstens 1.024
Änderungen je Import; Änderungsseiten sind höchstens 256 KiB groß.

Die gesamte kodierte Historie einschließlich Konfiguration und Tombstones besitzt
standardmäßig 16 MiB, konfigurierbar von 16 KiB bis 64 MiB. Bei Erschöpfung werden
neue Änderungen abgewiesen. Es gibt keine zeitbasierte Bereinigung und keinen
Verlust von Remove-/Deduplizierungsinformationen. Ein solcher Bestand benötigt
für große Snapshots den noch offenen Teil 3.2. Entry-Felder bleiben auf 64 KiB,
Mitglieder auf 32 und Typregeln auf 64 begrenzt.

Der Betreiber muss `authorize(action)` und `assertActive()` bereitstellen. Beide
werden frisch vor und innerhalb von Änderungen sowie vor Rückgabe von Reads
geprüft. Ohne produktive Quelle-/Ziel-Grants und überprüfte Boot-/Löschbarrieren
ist dies keine Betriebsfreigabe. Die bestehenden Space-Boot- und Löschcontroller
übernehmen diese neue Dokumentfamilie nicht automatisch; die Verbindung ist Teil
3.3. Deshalb wird der Baustein noch nicht für normale Produktionsdaten aktiviert.

`clockUncertaintyMs()` ist verpflichtend: ab 5 Sekunden Unsicherheit werden lokale
neue Änderungen und zeitabhängige Reads gesperrt. Ein beobachteter Rücksprung der
Wanduhr um mehr als 5 Sekunden sperrt ebenfalls. Eingehende HLC-Zeitpunkte von
mehr als 60 Sekunden in der Zukunft werden atomar abgewiesen. Wiederholung einer
bekannten lokalen Request-ID liefert das schon gespeicherte Ergebnis; sie erzeugt
auch bei unsicherer Uhr keine neue Wirkung. Clock-Health-Messung selbst bleibt
eine Aufgabe der späteren Laufzeiteinbindung.

## Prüfumfang

`test-entry-replication.test.ts` führt elf Prüfungen aus: einen reinen HLC-Fall
und je fünf Fälle auf JSONL und SQLite. Sie prüfen simulierte zehn Minuten
Partition, vertauschte/duplizierte Zustellung, dauerhaften HLC nach Neustart,
versionierte Löschung, Ablauf ohne Rückfall auf ältere Werte, Add-Wins,
Remove-vor-Add, unveränderte Owner, sequenztreue Request-Retries, Import ohne
Teilwirkung, Snapshot-Merge und Verlust vor/nach tatsächlichem Storage-Commit.
Weitere Prüfungen betreffen Zukunftsuhren, Widerruf innerhalb des Commit-Pfads,
Konfigurationswechsel, Plain-JSON-Validierung und Backpressure. Kodierte tatsächliche
Storage-Writes bleiben im geprüften 32-KiB-Grenzfall unter dem Batchlimit.

`scenarios/phase3-entry-replication.mjs` kompiliert dieselben Fälle für den
isolierten Server-Test mit der einen ausgelieferten Bibliothek. Die Uhr ist
injiziert, die Replikatoren werden direkt aufgerufen. Dies ist kein Nachweis für
eine zehnminütige reale NetBird-Partition, produktive Replikation, Primary/Standby,
Promotion oder physische Löschung der neuen Historie.


## Nachweisstand vom 2026-10-15

Alle 505 Repository-Tests und 24 mobile Runtime-/Lifecycle-Tests sind bestanden;
die Typprüfung ist grün. Die elf neuen Replikationsfälle bestehen außerdem am
gebauten Server-Artefakt. Bibliothek und mobiles Bundle sind bytegleich. Die
[Nachweise](../test/evidence/ap3-entry-2026-10-15/README.md) halten Quellstände,
Artefakt-Hashes, isolierten Container und vollständige Bereinigung fest. Das ist
der Abschluss des hier beschriebenen ersten Bausteins, keine Phase-3-Gesamtfreigabe.
