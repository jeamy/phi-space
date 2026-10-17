# Phase 3: Replikation und kontrollierte Übernahme

Stand: 2026-10-17. **Phase 3 ist begonnen, aber nicht abgenommen.**
Phase 2 und ihre dokumentierte Abschlussentscheidung bleiben unverändert.
Der Zielvertrag steht in Abschnitt 7.2 und Stufe 3 des
[Föderationsplans](federation-plan-v3.md).

## Umsetzung und verbleibende Schritte

| Teil | Stand | Verbleibender Nachweis |
|---|---|---|
| 3.1 Entry-Replikation | Persistenter HLC, LWW, versionierte Tombstones, Add-Wins-Tags, Deduplizierung, feste Replikat-Inkarnationen, bytebegrenzter Änderungsabruf und kleiner atomarer Snapshot-Merge implementiert | Lokale und gebaute Invariantentests sind Bausteinnachweise; noch keine produktive NetBird-Replikation |
| 3.2 Große Snapshots und fortlaufender Austausch | [Snapshot-Teil](ap3-snapshot-transfer.md) und [Pull-Worker mit atomarem Stream-Cursor](ap3-stream-transfer.md) implementiert und als administrative Bausteine geprüft | [Generationenpflege](ap3-snapshot-maintenance.md) implementiert und geprüft; reale zehnminütige NetBird-Partition zwischen zwei Hosts als Komponentenlauf bestanden ([Nachweis](../test/evidence/ap3-overlay-2026-10-15/README.md)); produktive Einbindung offen |
| 3.3 Einbindung in Spaces und Dienst | Offen | Policy-Modi, Typ-/Owner-Rechte, frische Import-Grants für genau Quelle/Ziel, Boot-Rolle `entryReplica`, Clock-Health, Widerruf, Löschbarrieren und verteilte Principal-Löschung auch dieser Historien; Set-Renewal ist als atomare Version umgesetzt; exklusive Txns/Takes im öffentlichen Adapter noch ablehnen |
| 3.4 Vollständige Primary-/Standby-Historie | [Synchroner Storage-Unterbau](ap3-primary-sync.md), signierter Transport, primary/sync-Spaces im Federation-Daemon, Bootstrap bestehender Stores und kontrollierte Übergänge umgesetzt; echte Läufe bestanden | `CommitSealed` öffentlich mit Klärung im laufenden Host; `NotCommitted` mit Negativclaim für primary/sync-Spaces und Haupt-Store |
| 3.5 `setStandby` und Single-Umschaltung | [Umgesetzt](ap3-replica-control.md): Übergangsjournal, degradeToSingle, setStandby für ein leeres Quarantäne-Ziel, Schreibsperre aller Quellen inklusive Reaper, Boot-Fencing und externe Berechtigungen; mit netcup- und Container-Fencing echt gelaufen | — |
| 3.6 Promotion und Quarantäne | [Umgesetzt](ap3-replica-control.md): nur fester synchroner Standby mit aktiver Berechtigung, verifizierter Nachweis, neue Epoche, Quarantäne nur über `release`; netcup- und Container-Fencing real, Boot-Guard für Replikatversion und Durability, Promotion des Control-Replikats echt gelaufen | Negativclaims umgesetzt; Root bei Control-Promotion echt gelaufen |
| 3.7 Gesamtbetrieb | Teilweise | Zehnminütige reale Partition mit Writes/Deletes/Renewals auf der Komponentenebene bestanden (Fixture-Identität, kein Snapshot unter Last); offen: dasselbe über den produktiven Dienst mit Schlüsselbeweis/Grants/Boot, Overlay-Ausfälle, Prozess-/Storage-Grenzen und Verlustfreiheit aller bestätigten Operationen im Primary-/Standby-Betrieb |

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

Die Methoden `snapshot()` und `installSnapshot()` bleiben ein einzelner kleiner
atomarer Import. Große Bestände verwenden den neuen [gepagten Transfer](ap3-snapshot-transfer.md). Der konservative Test `2 × kodierte Änderungsbytes + 16 KiB` muss
in das standardmäßige 192-KiB-Batchbudget passen. Größere Snapshots werden vor
Mutation abgewiesen. Das maximale Batchbudget ist 192 KiB, höchstens 1.024
Änderungen je Import; Änderungsseiten sind höchstens 256 KiB groß.

Die gesamte kodierte Historie einschließlich Konfiguration und Tombstones besitzt
standardmäßig 16 MiB, konfigurierbar von 16 KiB bis 64 MiB. Bei Erschöpfung werden
neue Änderungen abgewiesen. Es gibt keine zeitbasierte Bereinigung und keinen
Verlust von Remove-/Deduplizierungsinformationen. Ein solcher Bestand verwendet für große Snapshots den implementierten
gepagten Teil 3.2 und den implementierten Cursor-Worker. Entry-Felder bleiben auf 64 KiB,
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

`test/test-entry-replication.test.ts` führt elf Prüfungen aus: einen reinen HLC-Fall
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


## Checkpoint des Bausteins 3.1 vom 2026-10-15

Alle 505 Repository-Tests und 24 mobile Runtime-/Lifecycle-Tests sind bestanden;
die Typprüfung ist grün. Die elf neuen Replikationsfälle bestehen außerdem am
gebauten Server-Artefakt. Bibliothek und mobiles Bundle sind bytegleich. Die
[Nachweise](../test/evidence/ap3-entry-2026-10-15/README.md) halten Quellstände,
Artefakt-Hashes, isolierten Container und vollständige Bereinigung fest. Das ist
der Abschluss des hier beschriebenen ersten Bausteins, keine Phase-3-Gesamtfreigabe.


## Nachweis des Snapshot-Teils 3.2 vom 2026-10-15

Gepagte Snapshots mit dauerhaftem Importfortschritt und atomarer Veröffentlichung
sind umgesetzt und im isolierten Server-Bausteintest geprüft. 517 Repository-Tests
und 24 mobile Tests sind grün; 23 Replikationsfälle bestehen zusätzlich am gebauten
Server-Artefakt. [Details und Betriebsgrenzen](ap3-snapshot-transfer.md).
Dieser Checkpoint belegt den Snapshot-Teil. Der aktuelle fortlaufende Austausch
ist im [Stream-Nachtrag](ap3-stream-transfer.md) beschrieben; Generationenpflege
und reale Overlay-Partition bleiben offen.


Aktueller Stream-Nachweis: 530 Repository-Tests und 24 mobile Tests grün;
36 gebaute Serverfälle bestanden. Daten und Cursor überstehen die geprüften
Commit-Verluste gemeinsam; TCP-Wiederanlauf und konkurrierende Worker sind geprüft.
[Artefakt- und Quellbindung](../test/evidence/ap3-stream-2026-10-15/README.md).
Generation-/Belegpflege, reale NetBird-Partition und produktive Einbindung bleiben offen.


## Generationenpflege und synchroner Storage-Unterbau (2026-10-15)

Die [Generationenpflege](ap3-snapshot-maintenance.md) entfernt redundante Kopien
seitenweise und erhält die vollständige kausale Historie. Der
[synchrone Storage-Baustein](ap3-primary-sync.md) versiegelt vollständige Batches vor
Versand und wendet sie erst nach dauerhafter Standby-Annahme lokal an. Beides ist
implementiert und gezielt geprüft. Dies schließt nicht die offenen Integrations-,
Fencing- und Übergangspunkte der obigen Tabelle. Phase 3 bleibt bis zu diesen
Nachweisen offen.


### Set-Lease-Erneuerung

`mutate(id, {kind: "renew", type, tag, fields, owner, expiresAt})` ersetzt einen
lokal sichtbaren, noch lebenden Set-Tag durch einen neuen Origin-Tag. Felder und
Owner müssen unverändert bleiben. Die neue Version entfernt den beobachteten alten
Tag im selben Event/Commit. Ein konkurrierender Remove des alten Tags entfernt
die Erneuerung nicht; nach deren Ablauf wird der alte Tag nicht wieder sichtbar.
Die Erneuerung kann vor dem ursprünglichen Add eintreffen. Bei späterem Empfang
wird die kausale Feld-/Owner-Bindung nachgeprüft; Selbstreferenzen sind ungültig.
Acht Fälle prüfen dies einschließlich tatsächlicher Commit-Verluste auf beiden
Backends. Der öffentliche SpaceLike-/Lease-Adapter ist weiterhin Teil von 3.3.


## Reale Partition über NetBird (2026-10-15)

`run-phase3-overlay.py` hat die Entry-Replikation zwischen dem Operator-Host und einem Container auf big über
NetBird geprüft: 600,4 Sekunden Partition (nur die eigenen Replikations-Listener gestoppt), währenddessen auf
beiden Seiten Writes, Erneuerungen, ein Delete und während der Partition ablaufende Gewinner. Nach Neustart beider
Harnesses und Austausch sind beide Sichten gleich (Revision 90), Gelöschtes und Abgelaufenes blieb unsichtbar, und
Wartung plus erneuter Austausch erzeugte kein Echo. Eigene Regeln, Gruppe, Policy und Container wurden entfernt.
Grenzen: Komponenten-Fixture mit Peer-IP-Pin und privatem Token, kein Snapshot unter Last, kein produktiver Dienst.
[Nachweis](../test/evidence/ap3-overlay-2026-10-15/README.md).


## Testserver für Fencing und Promotion (2026-10-16)

Für 3.3–3.6 steht der netcup-Server `nanoi` als Test-Primary bereit, der tatsächlich abgeschaltet werden darf;
vpsc dient als Backup-/Register-Host. Einrichtung und Grenzen: [Testumgebung §18](testumgebung-big.md#18-testserver-nanoi-phase-3-test-primary-und-fencing-ziel).
Für den Fencing-Adapter fehlen noch der netcup-REST-API-Zugang und die Entscheidung F1.

## Einbindung von lww/set in Dienst und Router (Entwurf, 2026-10-17)

Die Bausteine aus 3.1/3.2 halten replizierte Entries in einem eigenen Dokument (`EntryReplicas`), nicht als normale
Space-Entries. Die Einbindung bildet die öffentlichen Space-Operationen auf diesen Baustein ab. Sie läuft in fünf
Schritten; jeder Schritt hat eigene Tests auf beiden Backends.

**1. Policy-Modus und öffentlicher Adapter**

- **Feste Konfiguration:** Die Replikationskonfiguration eines Merge-Members wird provisioniert und ist fest, wie
  bei primary/sync. Sie umfasst Space, Replikat-ID, Inkarnation, die Mitglieder mit ihren Inkarnationen und die
  Regeln (Typ, Variante, bei `lww` die Schlüsselfelder). Eine Änderung verlangt einen ausdrücklichen Neuaufbau, weil
  der Controller seine Konfiguration bindet.
- **Policy:** Eine `sync`-Regel mit `variant: lww|set` ist nur gültig, wenn jedes ihrer Members eine
  `entryReplication` gleicher Regeln trägt und keine primary-Replikation hat. Die Variante und bei `lww` die
  Schlüsselfelder müssen übereinstimmen. Damit fällt die Sperre „sync activation requires phase 3 implementation“
  für diese Varianten.
- **Member-Dienst:** Der `space`-Dienst leitet Operationen auf Merge-Typen an den Controller.
  - `write`: bei `lww` ein `put`; der Schlüssel kommt aus den Schlüsselfeldern, fehlende Felder sind ein Fehler.
    Bei `set` ein `add` mit eindeutigem Tag. Die Request-ID wird zur Request-ID der Änderung, Wiederholungen sind
    idempotent.
  - `read`, `readAll` und `count` nutzen die konvergierende Sicht (gewinnende `lww`-Version, nicht entfernte
    `set`-Tags, abgelaufene Versionen unsichtbar). Antworten tragen `replicated: true`, denn sie können veraltet
    sein.
  - Löschen: bei `lww` ein Tombstone mit eigener HLC-Version, bei `set` ein Remove der beobachteten Tags.
  - `take`, Txns, `wait` und Lease-Eingriffe auf Merge-Typen werden mit `MergeTypeNotExclusive` abgewiesen
    (v3 7.2: keine exklusive Vergabe).
- **Root:** Für eine Merge-Regel wählt der Root den Ziel-Member deterministisch per HRW.
  - Schreiben: bei `lww` über den kanonischen Schlüssel (fehlende Schlüsselfelder sind ein Fehler), bei `set` über
    die kanonischen Felder.
  - Lesen: bei `lww` mit vollständigem Schlüssel im Template beim Schlüssel-Member, sonst bei genau einem Member per
    HRW über den Typ. Mehrere Members zu befragen würde nach der Replikation Einträge doppelt zählen.
  - Exklusive Operationen (`take`, Rennen, Txns) lehnt er ab, bevor ein Member angesprochen wird
    (`MergeTypeNotExclusive`).
  - Vor Schritt 2 sieht ein Lesen nur, was beim gelesenen Member liegt.

**Stand:** Schritt 1 ist umgesetzt (Dienst-Adapter, Policy-Validierung, Platzierung, Ablehnung im Root, provisionierte
`entryReplication` in der Runtime).

**2. Import über den Dienst:** Die Members ziehen die Änderungen der anderen mit dem vorhandenen Stream-Worker.

- **Konfiguration:** `entryReplication` nennt die gemeinsame logische `spaceId` (Teil des Vertrags-Hashes, auf allen
  Members gleich) und `peers`, also die anderen Members mit Replikat-ID, Host, NetBird-Peer und Adresse.
- **Export:** `entryDescribe` und `entryChanges` beantwortet der Eingangsdienst nur einem bewiesenen Dienst-Peer
  (Schlüsselbeweis gegen das Schlüsselverzeichnis, Rolle `host`, `router` oder `admin`), der als Peer dieser
  Replikation gepinnt ist. Ein widerrufener Schlüssel beendet den Zugriff damit sofort.
- **Import:** Je Peer zieht ein `EntryReplicationPump` den Strom. Netzfehler gelten als vorübergehend und werden
  wiederholt; jeder andere Fehler stoppt den Worker, wird protokolliert und nach einer Pause neu versucht. Die
  Identität der Quelle muss der gepinnten Replikat-ID entsprechen.
- **Abweichung vom ersten Entwurf:** Statt eigener Import-Grants der Control-Instanz gelten die gepinnte
  Peer-Liste und der Schlüsselbeweis; Widerruf läuft über das Schlüsselverzeichnis. Eine eigene Boot-Rolle
  `entryReplica` gibt es nicht; „aktiv“ heißt aktive Boot-Berechtigung für den Space. Die Uhr-Unsicherheit ist
  ein Konfigurationswert (Standard 1 s); eine gemessene Clock-Health fehlt noch.
- **Geprüft:** zwei vollständig konfigurierte Hosts mit Gates replizieren `lww` in beide Richtungen und
  konvergieren; ein bewiesener, aber nicht gepinnter Host bekommt nichts (`test/test-operations.test.ts`).

**3. Löschung eines Principals (Entwurf):** Die Löschung ist selbst eine replizierte Änderung mit eigener HLC-Version,
`erase {principal}`. Sie konvergiert wie jede andere Änderung.

- **Abdeckung:** alle Änderungen mit `owner` gleich dem Principal und einer Uhr vor der Löschung. Ein gleichzeitiger
  Schreibvorgang mit späterer HLC bleibt; der Ablauf widerruft deshalb zuerst den Schlüssel des Principals.
- **Schwärzen:** Eine abgedeckte Änderung (`put`, `add`, `delete`, `renew`) wird durch eine geschwärzte Form ersetzt.
  - Erhalten bleiben ID, Uhr, Typ, Owner, die ursprüngliche Argument-Prüfsumme und die ID der Löschung.
  - Statt der Schlüsselfelder trägt sie bei `lww` nur einen Hash des kanonischen Schlüssels.
  - `remove` enthält keine Inhalte und bleibt.
- **Konvergenz:**
  - Ein geschwärzter `lww`-Put konkurriert über den Schlüssel-Hash weiter um seinen Schlüssel und verbirgt ihn, wenn
    er gewinnt (wie ein Tombstone). So lebt keine ältere Version eines anderen Owners wieder auf.
  - Ein geschwärztes `set`-Add und jedes `renew` auf ein geschwärztes Add sind unsichtbar.
  - Decken mehrere Löschungen eine Änderung ab, gilt die mit der kleinsten ID.
- **Import:** Eine geschwärzte Form ist ohne die Löschung gültig, die Seiten können in beliebiger Reihenfolge kommen.
  - Eine geschwärzte Form ersetzt ein lokales Original mit gleicher ID und gleicher Argument-Prüfsumme.
  - Ein Original, das nach seiner Schwärzung eintrifft, wird an `hash(mutation) === argumentHash` erkannt und
    verworfen.
  - Nur ein gepinnter, bewiesener Peer kann so etwas liefern; er könnte ohnehin Tombstones schicken.
- **Physisch:**
  - Das Overlay wird beim Anwenden der Löschung umgeschrieben.
  - Die logische Sicht und jeder Export sind immer geschwärzt.
  - Snapshot-Segmente baut die vorhandene Wartung aus der geschwärzten Sicht neu; die alten Chunks werden
    entfernt.
  - Ein laufender eingehender Transfer wird abgebrochen und der Export-Cache verworfen.
  - Lokal abgeschlossen ist die Löschung erst nach diesen Schritten (`erasureStatus`).
- **Verteilt:** Gelöscht überall heißt: Jedes gepinnte Member meldet die Löschung als lokal abgeschlossen. Ein
  ausgefallenes Member hält die Löschung offen; das wird ehrlich gemeldet.
- **Root:** Ein über den Root geschriebener Merge-Eintrag liegt auch in dessen Journal. Die Root-Historienlöschung
  muss die Merge-Änderungs-IDs des Principals mit einsammeln.

**Stand von Schritt 3:**

- **Baustein** (`erasePrincipal`, `erasureStatus`, `completeErasure`, `changeIdsOwnedBy`): umgesetzt und geprüft
  (`test/test-entry-erasure.test.ts`).
  - Drei Replikate, eines hinkt hinterher; geschwärzte Formen kommen vor der Löschung an; Originale treffen nach
    ihrer Schwärzung ein.
  - Kein älterer Wert lebt wieder auf.
  - Erneuerungen geschwärzter Tags werden ebenfalls geschwärzt, unabhängig von ihrer Uhr, weil sie dieselben Felder
    kopieren.
  - Snapshot-Segmente werden über die Wartung bereinigt.
  - Nach `compactErasedSqlite` enthält die SQLite-Datei die gelöschten Inhalte nicht mehr.
- **Offline-Ablauf des Testbed-Daemons:**
  - `erase-evidence` liefert zusätzlich die Merge-Änderungs-IDs des Principals für die Root-Journale.
  - `erase-local` löscht im Baustein und schließt die Löschung lokal ab; der Status steht im Ergebnis (`merge`).
  - Danach entfernt der bestehende Schritt `erase-compact` die alten Revisionen.
  - Jeder Merge-Member durchläuft diesen Ablauf; „überall gelöscht“ heißt, jeder meldet `complete`.
- **Echter Lauf** mit zwei Merge-Members über NetBird, Partition und Löschung bestanden
  ([Nachweis](../test/evidence/merge-run-2026-10-17/README.md)).

**4. Kompaktierung (umgesetzt):** Entfernt werden Ereignisse, die die Sicht nicht mehr beeinflussen, sobald sie
kausal stabil sind. Ein Zufallstest vergleicht jedes kompaktierende Replikat nach jedem Schritt mit einem nicht
kompaktierenden Schatten, der genau dieselben Eingaben bekommt.

- **Stabile Positionen:**
  - Jedes Ereignis hat eine feste Stream-Position in der logischen Reihenfolge. Entfernte Positionen stehen als
    Bereiche in `dropped` und werden nie wieder vergeben; ohne Bereiche gilt Position = Index + 1.
  - `describeStream().revision` ist die Kopfposition. `streamChanges(after)` liefert Ereignisse mit Positionen
    größer als `after`.
  - Seiten nennen ihre Positionen in `positions` nur, wenn sie nicht lückenlos sind; sonst bleibt das alte Format.
  - Liegt hinter dem letzten Ereignis nur noch Entferntes, ist die Seite leer und `next` die Kopfposition.
  - Snapshot-Manifeste trennen `revision` (Kopfposition der Quelle, Startpunkt des Streams) von `eventCount`.
- **Versionsvektoren:**
  - `describeStream()` meldet je Ursprung die lückenlos empfangene Sequenz (`vector`).
  - Die Pumpe speichert den Vektor jedes Peers mit Zeitpunkt (`recordPeerVector`, Dokument
    `pi-spaces.entry-replica-peers`).
  - Meldet ein Peer weniger als zuvor, gilt er als zurückgefallen und die Kompaktierung bleibt aus. Ein aus einer
    Sicherung wiederhergestelltes Replikat braucht deshalb eine neue Inkarnation.
- **Stabilität:**
  - A braucht von jedem konfigurierten Member einen Vektor und hält selbst dessen eigene Änderungen bis dorthin.
    Sonst meldet `compactionStatus()` den Grund in `blocked`.
  - Die Untergrenze je Ursprung ist das Minimum aller Vektoren; stabil ist, was darunter liegt.
- **Regeln:** Kandidat ist ein stabiles Ereignis, das aus einem stabilen Grund unsichtbar ist; `erase` ist nie
  Kandidat.
  - **lww:** Überholte Versionen sind Kandidaten. Der Gewinner (Tombstone, geschwärzt oder seit mehr als 60 Sekunden
    abgelaufen) ist es nur zusammen mit allen älteren Versionen seines Schlüssels.
  - **set:** Kandidat ist ein Tag, das ein stabiles Remove oder eine stabile Erneuerung entfernt hat oder das ein
    stabiles `erase` geschwärzt hat.
  - Ein abgelaufenes Tag ist Kandidat, wenn seine Ablaufzeit plus 60 Sekunden vor jedem Vektor-Zeitpunkt liegt. So
    sind Erneuerungen von vor dem Ablauf schon da.
  - Ein Remove und eine Erneuerung bleiben, solange eines ihrer Tags bleibt.
  - Ein Tag bleibt, solange eine noch nicht stabile Erneuerung es nennt. Sonst könnte ein später eintreffendes
    `erase` die Erneuerung nicht mehr schwärzen. Jedes `erase`, das älter ist als eine stabile Erneuerung, ist schon
    hier; regelmäßig erneuerte Einträge behalten deshalb nur ihre letzte Erneuerung.
  - Eigene Änderungen bleiben mindestens `requestRetentionMs` (Standard 24 Stunden), damit ein Retry seine Änderung
    findet. Danach erzeugt ein Retry eine neue Änderung.
- **Untergrenze:** Bei der Veröffentlichung wird die Untergrenze gespeichert. Eine unbekannte Änderung darunter
  wurde entfernt und wird verworfen, ob sie über den Stream, `importChanges` oder einen Snapshot kommt.
- **Ablauf:**
  - `compact(id)` startet mit `startCompaction` eine Wartungsgeneration. Sie hält die Entscheidung im Job fest und
    kopiert nur die verbleibenden Ereignisse.
  - Die Veröffentlichung setzt Segment, `dropped` und Untergrenze atomar; danach werden die alten Chunks eingezogen.
  - Ändert ein eintreffendes `erase` die kopierte Quelle, bricht `compact` die Generation ab
    (`abortSnapshotMaintenance`) und der nächste Lauf beginnt neu. Abgelaufene Belege früherer Generationen entfernt
    `compact` vorher, damit periodische Läufe nicht an der Grenze von 17 Belegen hängen bleiben.
  - Den Speicherplatz gibt erst die Offline-Kompaktierung frei (wie bei der Löschung).
  - Im Daemon läuft das mit `entryReplication.compactEveryMs` periodisch (mindestens 1000; sinnvoll sind Minuten,
    weil ein Beleg erst nach 60 Sekunden entfernt werden kann).
- **Löschnachweis für den Root:** Kompaktierte Änderungen eines Principals fehlen in `changeIdsOwnedBy`. Der Root
  erkennt replizierte Sichten in seinen Journalen deshalb auch an ihrem `owner` und löscht sie ohne Nachweis-ID.
- **Tests** (`test/test-entry-compaction.test.ts`):
  - Positionen und alter Cursor nach dem Entfernen.
  - Zufallstest mit acht Saaten, teils mit einem nie kompaktierenden Replikat.
  - Gezielte Fälle: fehlender, hinterherhinkender und zurückgefallener Vektor; Remove mit instabilem Tag;
    Tombstone mit älterem gleichzeitigem Put; Erneuerung mit späterem `erase`; Ablauf mit Erneuerung; Retry in der
    Aufbewahrung; Snapshot nach der Kompaktierung; 20 Läufe nacheinander; `erase` während des Kopierens;
    Erneuerungskette.
  - Jede Regel ist durch Mutationsproben belegt: Ohne sie schlägt mindestens ein Test fehl.
  - Der Laufzeittest kompaktiert periodisch zwischen zwei Hosts über bewiesene Verbindungen.
- **Echter Lauf** mit nano-test und standby-100: periodische Kompaktierung auf beiden Hosts, Sichten unverändert,
  Ströme danach weiter ([Nachweis](../test/evidence/compaction-run-2026-10-17/README.md)).

**5. Echter Lauf:** bestanden mit nano-test und standby-100: Replikation, Partition mit gleichzeitigen Writes
und Konvergenz, verteilte Löschung mit physischer Kompaktierung auf beiden Hosts
([Nachweis](../test/evidence/merge-run-2026-10-17/README.md)).
