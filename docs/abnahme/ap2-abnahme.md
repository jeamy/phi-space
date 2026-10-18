# Phase 2: Erweiterungen und Abnahme vom 2026-10-11

**Phase 2 ist mit der dokumentierten Abschlussentscheidung für Block 4 abgeschlossen.**
[Gate 4 und Betriebsgrenzen](ap2-gate4.md) sind für das geprüfte Profil festgelegt.
Eine uneingeschränkte native Produktionsfreigabe ist damit nicht erklärt.
Die nachstehenden datierten Nachweise unterscheiden Baustein-, Last- und Betriebsprüfungen.
Die bisherigen Nachweise zu AP 1b bleiben bestehen.

## Aktuelle verbleibende Testblöcke (2026-10-15)

Die Phase-2-Abnahmen sind in acht technische Blöcke gebündelt; jeder Block
umfasst mehrere Einzeltests. **Alle acht Testblöcke sind abgeschlossen.** Gate 4 ist ebenfalls geschlossen;
der Phase-2-Abschluss gilt mit der unten festgehaltenen Ausnahme zu Block 4
und den [dokumentierten Betriebsgrenzen](ap2-gate4.md).
Block 4 ist auf ausdrückliche Entscheidung des Auftraggebers vom 2026-10-15
abgeschlossen und wird nicht erneut ausgeführt. Die historischen negativen
Messungen weiter unten bleiben als solche erhalten; die Entscheidung erklärt
diese Messungen nicht nachträglich zu bestandenen Tests.

- [x] 1. Mailbox-ACK-Abbrüche über NetBird unter voller Joblast.
- [x] 2. Individuelle Member-Prozessabbrüche und Wiederaufnahme.
- [x] 3. Gezielt unterbrochene Journal-Commits über NetBird.
- [x] 4. Produktive Root-/Directory-Provisionierung samt Boot-/Fencing-Prüfung (Abschlussentscheidung 2026-10-15).
- [x] 5. Nachweis über unabhängige physische Ausfalldomänen (Live-Abnahme 2026-10-15).
- [x] 6. Verteilte Principal-Löschung einschließlich Router-/Parent-Historien (Live-Abnahme 2026-10-15).
- [x] 7. Physische Löschung bzw. verbindliche Löschregeln für Archive und Backups (Live-Abnahme 2026-10-15).
- [x] 8. Kontrollierte Umstellung bestehender Abschlussprofile (Live-Abnahme 2026-10-15).

Datierte Nachträge und Statuszeilen unten beschreiben den Stand des jeweiligen
Laufs. Für aktuell offene Punkte ist ausschließlich die Liste oben maßgeblich.

## AP 2.6

Policy-Profile gelten jetzt auch bei aktiven Members: Jeder Task-Commit prüft
Ergebnisanzahl, Zuordnungsfelder, die gesamte Ergebnisgröße und zusätzliche
unzugeordnete Ergebnisse. Task-Takes begrenzen die Txn-Laufzeit; Erneuerung kann
sie nicht überschreiten. Fehlgeschlagene Commits bleiben abbrechbar.
Lokale Übergangsprofile bleiben für nicht verwaltete Spaces kompatibel.

`DataAdminController` implementiert `purgeTasks` sowie `deletePrincipal` mit
separater Autorisierung pro Command/Space, Autoritätsprüfung im Commit und
pro Batch atomarer, deduplizierter Fortschritts- und Audit-Aufzeichnung. `purgeTasks` löscht ausschließlich
unreservierte profilierte Tasks. Bei der Principal-Löschung werden eigene Entries,
Claims, Generations und Mailboxes entfernt. Fremde Mailboxes mit betroffenen
Entries erhalten eine neue Epoche und Gap; betroffene fremde Claim-Ergebnisse
verfallen ohne erneute Wirkung. Stream-Historie wird verworfen und alte
Snapshot-Tokens werden ungültig. Der Supervisor bindet die Handler nur ein,
wenn ein autorisierter Controller provisioniert ist.

Der lokale Principal-Löschlauf verarbeitet große Bestände in höchstens 32
Mutationen pro Commit und belastet das vorhandene Commit-Budget. Command-ID,
Argument-Hash, Phase, Anzahl und Ziel-Tupel bleiben dauerhaft gespeichert.
Der Space ist währenddessen für neue Wirkungen, Generations und Objektabfragen
gesperrt; Snapshot-Tokens werden zu Beginn und Abschluss ungültig. Nach Crash
oder verlorener Commit-Antwort setzt derselbe Command an der gespeicherten
Phase fort. Scope und Autorität werden vor und innerhalb jedes Batches erneut
geprüft. Ein Inkarnations-/Autoritätswechsel verlangt Review, auch beim Replay
eines bereits abgeschlossenen neuen Lösch-Commands.

**Grenze:** Die Löschung benötigt zunächst einen ruhenden lokalen Space.
Die Sperre bleibt bei Widerruf oder unklarem Restore erhalten. Ein einzelner
Metadaten-Tombstone, der nicht ins Budget passt, wird ohne Teil-Commit
abgewiesen; die laufende Löschung bleibt gesperrt. Der Löschlauf über
Remote-Members und Router-Historien fehlt noch.
Daher ist F9 noch nicht vollständig erfüllt. Profiländerungen an bestehenden
Task-Typen bleiben `MigrationRequired`; ein kontrollierter Umstellungsablauf
wird dadurch nicht ersetzt.

Restore-Reconciliation markiert alle passenden Child-Requests und Parent-
Operationen `needsReview`, einschließlich abgeschlossener Ergebnisse und noch
nicht gesendeter Schritte. Parents speichern den ursprünglichen Ziel-Tupel.
Damit funktioniert die Prüfung auch nach Änderung der Member-Zieladresse.
`ControlAckService` verweigert bei verwalteten Spaces die Restore-Bestätigung,
wenn kein entsprechender Reconciliation-Handler installiert ist. Der Handler
muss vor dem Receipt erfolgreich und wiederholbar ausgeführt werden.

## AP 2.7

`CapabilityDirectory` veröffentlicht Host-Ressourcen, Werkzeuge, Modelle und
Metriken mit 120 Sekunden Lease. `capabilityHeartbeat` ist ein eigener RPC-Pfad:
NetBird-Identität, aktueller App-Schlüssel, Host-Rolle und Grant sind erforderlich.
Die Host-Rolle muss sowohl im aktuellen App-Key als auch im signierten Grant enthalten sein;
die Prüfung wird vor dem Commit erneut vorgenommen. Der Body darf keinen fremden Host vertreten. Unterschiedliche technische
Host-IDs und Peer-IDs benötigen provisionierte `hostBindings`.

`startConfiguredFederation` kann über `capabilities` die lokalen `dataSpaces`
und das Control-Verzeichnis alle 60 Sekunden aktualisieren. Ohne diese explizite
Provisionierung wird kein Heartbeat gestartet. Capability-Veröffentlichung fügt
keinen Routing-Member hinzu. Directory-Entries können von gewöhnlichen Clients
weder hergestellt noch über Take, Txn-Locking oder Lease-Änderungen manipuliert
werden; Supertypes umgehen den Schutz nicht.

`MemberStatusDirectory` prüft Members aus Router-Sicht. Es aktualisiert Revision,
Kapazität und Lag mit einer 30-Sekunden-Lease und erneuert standardmäßig alle
15 Sekunden. Ein veralteter oder fehlgeschlagener Probe entfernt die
Routing-Beobachtungen. Zielwechsel während eines Probes verhindert die
Übernahme. Bei Single-Members ist Replikations-Lag nicht anwendbar (`null`).
`createFederationController` bindet das Verzeichnis bei provisioniertem
`probeStatus` ein; der Betreiber startet dessen `start()`-Schleife und beendet
sie mit dem zurückgegebenen Stopper.

Lesen erfolgt über `readAll`/`space_list` für `Capability` bzw. `MemberStatus`
innerhalb des erteilten Space-Scopes. Data-only-Schlüssel bekommen dadurch
keinen allgemeinen Control-Zugriff. Der zusammengesetzte TCP-Test prüft auch
den echten Host-RPC-Pfad, Fremdhost-Ablehnung und das Control-Schreibverbot.
Die bestehenden produktiven Services wurden noch nicht mit diesen neuen
Directory-/Router-Konfigurationen umgestellt.

## AP 2.9 und Systemabnahme

`test/testbed/scenarios/phase2-load.ts` schreibt 10.000 Entries inklusive Claims
und Stream-Historie auf drei SQLite-Member-Stores. Sechs Worker bearbeiten
1.000 HRW-Sieb-Aufgaben. Task-Take und Ergebnisabschluss liegen in getrennten
dauerhaften Commits. Das Ergebnis wird vollständig gegen eine unabhängig
berechnete Primzahlliste bis 100.000 verglichen. Der Bericht enthält komplette
Dokumentgrößen, Claim-/Stream-Größen, gesampelten RSS, Task-Latenzen und
Batch-Mittelwerte je geschriebenem Entry (keine einzelnen RPC-Latenzen).

Der gebaute Lasttest läuft auf `big` in einem eigenen Container mit Node 22,
2 CPUs, 1 GiB RAM, Read-only-Dateisystem, ohne Capabilities und ohne Netz.
Es werden ausschließlich gebaute `.mjs`-Artefakte übertragen. Die drei Stores
sind echte persistente SQLite-Stores, jedoch keine drei NetBird-Hosts. Deshalb
ersetzt dieser Lauf weder den virtuellen Router noch die Overlay-Abnahme.
Frame 256 KiB, Commit 192 KiB und Generationslaufzeit 1 Stunde bleiben bis zu
deren vollständigem Nachweis Startwerte.

**Journal-Aufteilung implementiert:** Der kompatible Standard behält weiterhin
16 Parents und ein Router-Journal. Für neue Root-Journale kann
`createFederationController({journalPartitions: N, ...})` eine feste Aufteilung
von 1 bis 1024 Partitionen provisionieren. Ein persistentes Manifest bindet
Anzahl und Router-IDs; SHA-256 ordnet jede Parent-ID dauerhaft einer Partition
zu. Alle Kinder und Zukunftsreservierungen eines Parents bleiben beim selben
Router. Je Partition gelten unverändert 16 Parents à 128 KiB sowie die
Router-Budgets von 128 Commands, 32 KiB Index und 4 MiB Journal. Es werden keine
historischen IDs gelöscht. Eine volle Partition lehnt neue Arbeit vor Wirkung
ab; unabhängige Partitionen und bekannte IDs bleiben nutzbar.

Die Gesamtkapazität ist endlich und wird vor dem Betrieb über N festgelegt:
maximal N × 2 MiB Parent-Reservierung und N × 4 MiB Router-Journal, zusätzlich
zum gemeinsamen Control-Router und Manifest. Hash-Verteilung garantiert keine
vollständige Ausnutzung sämtlicher Plätze. Ein geändertes Manifest oder der
stille Wechsel eines vorhandenen Ein-Journal-Bestands wird abgelehnt; eine
Migration vorhandener Historie ist nicht implementiert.

Der neue Lastfall prüft 1000 virtuelle Writes auf drei persistenten Members
bei 256 Partitionen, Neustart und Wiederholung alter IDs. Weitere Fälle prüfen
volle Partitionen, partitionenübergreifende Transaktionsursprünge, Root-
Referenzen vor Remove sowie verlorene Wirkungsantworten. Restore gleicht alle
Router und Parents ab und hält bei einem Crash zwischen Partitionen eine
dauerhafte Gesamtsperre bis zur abgeschlossenen Wiederholung.
Der einzelne Write-Lastfall ersetzt keinen Job-Lebenszyklus oder Overlay-Test.
Der vollständige virtuelle Job-Lauf ist im folgenden Nachtrag separat belegt;
Der signierte Drei-Member-NetBird-Lauf auf big ist nachgewiesen;
unabhängige physische Ausfalldomänen und die vollständige Crash-Matrix
bleiben offen.

| Abnahmepunkt | Nachweis / offener Schritt |
|---|---|
| Signierte Lease, Delegation, Rechte-/Policy-/Epochengrenzen | Delegations-, Routing- und TCP-Tests sowie signierter NetBird-Lauf mit drei Members; produktive Provisionierung offen |
| Stabile Child-IDs, Retry, Restore | Router-/Parent-Tests auf JSONL und SQLite; Reconciliation-Hook bei tatsächlichem Root zu provisionieren |
| Drain, Ergebnis-Commit, Remove, Notify und EmptyProof | Membership- und Core-Tests einschließlich globaler Abschlussbudgets |
| Capability und MemberStatus | JSONL-/SQLite-Tests plus zusammengesetzter Host-TCP-RPC-Test; produktive Provisionierung offen |
| Admin-Purge und F9 | Lokale batchweise Löschung mit Sperre/Crash-Recovery geprüft; verteilter Löschlauf und Router-Historien offen |
| 10.000 Entries, drei Members, 1.000 Jobs, sechs Worker | Member-Lasttest; finaler Bericht in den verlinkten Nachweisen |
| Virtueller Router unter dieser Last | Feste Journal-Aufteilung; vollständiger SQLite-Lastlauf im neuen Szenario separat dokumentiert; Signierter NetBird-Lauf bestanden; volle Crash-Abnahme bleibt offen |
| Crash nach jeder Journal-/RPC-/ACK-Grenze unter voller Last | Vollständige Lastmatrix offen; vorhandene gezielte Crash-Tests bleiben gültig |
| Drei-Member-Sieb über echte NetBird-Verbindungen | 1.000 Jobs / sechs Worker mit signierten Grants, RouterLease und Delegation in vier NetBird-Netzräumen auf big bestanden; Fixture-Provisionierung und ein physischer Server |
| Handy mit aktuellem APK | Installation und Objektlesen über echte NetBird-Verbindung nachgewiesen |
| Gesamtfreigabe Phase 2 / finale Gate-4-Werte | Nicht erteilt |

Nachweise und Prüfzahlen: [Abnahmeverzeichnis](../../test/evidence/ap2-final-2026-10-11/).

## Nachtrag 2026-10-12: lokale batchweise Löschung

Die Tests löschen 240 Entries samt Claims aus einem Bestand über 1 MiB bei
`maxCommitBytes = 4096`. Dabei wird die kombinierte Größe der tatsächlich
persistierten Änderungs-Deltas beider betroffenen Dokumente geprüft. Speicher-
Checkpoints sind vollständige Zustandssnapshots und werden separat von
Mutations-Deltas betrachtet. Alle sechs Phasen werden auf JSONL und SQLite
mit Crash vor dem Commit und verlorener Antwort nach dem Commit geprüft.
Fremde Entries bleiben erhalten; neue Wirkungen sind bis zum Abschluss gesperrt.
Die Löschung betrifft den aktuell zugänglichen Zustand; physische Bereinigung
von Backend-Historien, Snapshots und Backups ist damit nicht nachgewiesen.

Aktuelle Nachweise: [Prüfstand 2026-10-12](../../test/evidence/ap2-batches-2026-10-12/).

## Nachtrag 2026-10-12: partitionierte Root-Journale

[Prüfberichte](../../test/evidence/ap2-journals-2026-10-12/) enthalten die aktuellen
lokalen, Mobile- und Server-Artefaktprüfungen. Die Produktion wurde für diese
Prüfung nicht umgestellt. Der Testtransport der drei persistenten Members ist
simuliert; es wird keine neue NetBird- oder Handy-Abnahme behauptet.

## Vollständiger virtueller Router-Lastfall

`test/testbed/scenarios/phase2-router-load.ts` erweitert den Prüfstand um den
vollständigen Job-Lebenszyklus über `FederatedSpace` und `RouterController`:
1.000 Task-Writes, 1.000 Transaktionsbeginne, 1.000 Takes, 1.000 Ergebnis-Writes
und 1.000 Commits. Sechs Worker verwenden die HRW-Bindung des jeweiligen
`taskId`; jede Transaktion bleibt an genau einen Member gebunden. 9.000
Hintergrund-Entries werden zuvor lokal in begrenzten Member-Commits angelegt.
Damit liegen vor der Verarbeitung insgesamt 10.000 Entries auf drei echten
SQLite-Member-Stores. Der Root verwendet einen vierten SQLite-Store und
1.024 vorab festgelegte Journal-Partitionen. Die Entry-Quote je Owner ist
explizit auf 10.000 gesetzt; Frame, Commit und Generationslaufzeit behalten
ihre Standardbudgets.

Der Testtransport ruft den echten `SpaceService` innerhalb eines Prozesses
mit Fixture-Identitäten auf. Grants, signierte Delegation und NetBird sind
kein Bestandteil dieses Lastfalls. Verlorene Antworten werden nach einer
dauerhaften Zielwirkung erzeugt; Wiederholungen behalten Parent- und Child-ID.
Anschließend wird der Root-Harness aus SQLite neu geöffnet und historische
Writes/Commits werden erneut abgefragt. Genau 1.000 einzigartige Ergebnisse,
keine verbleibenden Tasks, vollständiger Primzahlvergleich und genau 5.000
abgeschlossene Parents/Child-Commands sind Pflichtprüfungen.

[Messwerte und Nachweise](../../test/evidence/ap2-router-load-2026-10-12/)
dokumentieren den konkreten Serverlauf. Er ersetzt weiterhin weder die
Drei-Host-NetBird-Abnahme noch die vollständige Crash-Grenzen-Matrix.

Der gebaute Serverlauf bestand am 2026-10-12 mit 2 CPUs und 1 GiB RAM in
227,518 Sekunden. Alle sechs Worker arbeiteten (168/168/168/168/168/160 Jobs).
36 nach dauerhafter Wirkung verlorene Antworten wurden mit 36 Parent-Retries
aufgelöst. Nach Root-Reopen blieben exakt 1.000 Ergebnisse und null Tasks;
9.592 Primzahlen mit Summe 454.396.537 stimmen mit der vollständigen Referenz
überein. Alle 5.000 Parents und Child-Commands sind abgeschlossen. Die größte
Partition enthält 13 Parents bei einem Limit von 16.

| Messgröße | p95 | p99 |
|---|---:|---:|
| Virtueller Task-Write | 37,361 ms | 46,875 ms |
| Transaktion beginnen | 345,461 ms | 392,522 ms |
| Task nehmen | 361,182 ms | 435,501 ms |
| Ergebnis schreiben | 360,337 ms | 418,621 ms |
| Commit | 381,789 ms | 461,725 ms |
| Vollständiger Job | 1.309,129 ms | 1.382,079 ms |

Dies sind Latenzen der jeweiligen virtuellen API-Aufrufe einschließlich
Warteschlange, Persistenz und ggf. Retry; keine reinen Netzwerk-RPC-Latenzen.
Der gesampelte Spitzen-RSS beträgt 270.274.560 Byte (rund 258 MiB). Die drei
Member-Dokumente wachsen von 7.847.685/7.661.269/7.751.204 auf
9.118.310/8.809.195/8.852.772 Byte einschließlich Claims und Stream.
Root-Parents belegen 3.683.379 Byte, die Router-Indizes 1.478.811 Byte;
für Commands sind 130.028.248 Byte reserviert. Reservierungen sind keine
Messung der tatsächlichen Command-Dokumentbytes oder des physischen Speichers.
Die Worker erhalten unterschiedliche Task-IDs; Konkurrenz mehrerer Worker um
denselben Task wird durch die separaten Wettlauf-/Crash-Tests geprüft.
Frame 256 KiB, Commit 192 KiB und Generation eine Stunde bleiben bis zur
vollständigen Overlay-/Crash-Abnahme Startwerte. Eine Gesamtfreigabe Phase 2
ist weiterhin nicht erteilt.

## NetBird-Wire-Prüfung und zusätzliche Crash-Grenzen

`test/testbed/scenarios/phase2-netbird.ts` ergänzt eine isolierte Wire-Fixture
mit einem Router und drei Members in vier echten NetBird-Netzräumen auf big.
Die Gate-Schicht fragt die NetBird-Management-API ab, prüft den App-Key und
verifiziert signierte Original-Grants, RouterLease und Delegation. Eigene
SQLite-Stores und TCP-Port 7423 trennen den Lauf von den bestehenden Gates.
Eine temporäre Vier-Peer-Gruppe und eine auf TCP 7423 begrenzte Policy werden
nach dem Lauf wieder entfernt. Der Zustand wird mit neuen Fixture-Schlüsseln
provisioniert; Enrollment, unabhängiges Boot-Register, OS-Fencing und
Produktiv-Provisionierung werden in dieser Prüfung nicht erneut abgenommen.
Die vier Netzräume teilen einen physischen Server; das ist kein Nachweis
unabhängiger VPS-Ausfalldomänen.

Der erste große Wire-Lauf blieb während einer Lease-Erneuerung stehen:
`lease()` konnte innerhalb eines Journal-Commits einen weiteren Commit auf
demselben Control-Harness anfordern. Die Root-Komposition erfragt/erneuert
Leases jetzt außerhalb der Journal-Transaktionen. Innerhalb prüft sie den
zuletzt erhaltenen signierten Lease sowie aktuelle Control-Zähler erneut;
Ablauf oder Supersession führen weiterhin zur Ablehnung. Die JSONL-/SQLite-
Regression lässt den Lease-Callback selbst auf demselben Host committen und
verlangt, dass er niemals innerhalb eines offenen Journal-Commits läuft.

Weitere 16 Fälle prüfen Kandidatenaufnahme, Gewinnerwahl, Parent-Abschluss
und Mailbox-ACK, jeweils vor Commit bzw. bei verlorener Antwort, auf JSONL
und SQLite. Nach Reopen bleibt genau ein Gewinner committet; der andere
Entry ist wieder verfügbar, ohne offene Transaktionen. Wiederholung eines
bereits abgeschlossenen Parents gibt ungenutzte Child-Zukunftsreservierungen
idempotent frei. Damit ist auch die Lücke zwischen Parent-Abschluss und
Freigabe des reservierten Child-Budgets geschlossen.

[Nachweise](../../test/evidence/ap2-netbird-2026-10-12/) dokumentieren den konkreten
Wire-Lauf und die aktuellen Artefaktprüfungen. Die vollständige Crash-Matrix
unter voller Overlay-Last bleibt ein separater Abnahmeschritt; die zusätzlichen
gezielten Fälle ersetzen sie nicht. Phase 2 ist insgesamt weiterhin offen.

Der korrigierte NetBird-Lauf bestand am 2026-10-12 in 395,538 Sekunden:
1.000 Jobs, 1.000 eindeutige Ergebnisse, null verbleibende Tasks und der
vollständige Primzahlvergleich bis 100.000 (9.592 Primzahlen, Summe
454.396.537). Die sechs Worker bearbeiteten 167/167/167/167/166/166 Jobs.
Alle drei Member-Pfade waren aktive NetBird-P2P-Verbindungen. Der Lauf
überschritt mehrere Lease-Erneuerungsintervalle, ohne den früheren Deadlock.
Jeder Testprozess hatte eine eigene Grenze von 2 CPUs/1 GiB RAM; dies ist
kein gemeinsames Ressourcenbudget für alle vier Prozesse. Der erste,
festgefahrene Lauf ist als fehlgeschlagener Versuch separat dokumentiert.

418 lokale Tests, 183 Tests am gebauten Server-Artefakt, 24 Mobile-/Remote-
Tests und die Beispieltests sind im isolierten, aktuellen Quellstand geprüft.
Die Lease-Regression schlägt mit dem alten Controller auf beiden Backends
gezielt fehl und besteht mit dem korrigierten Controller. Der Operator-Treiber
`test/testbed/netbird/run-phase2-sieve.py` führt den Aufbau und die eigene
Bereinigung reproduzierbar aus. Seine Bereinigung verwendet tatsächlich
von diesem Lauf erzeugte Container-IDs und die selbst erzeugten Policy-/
Gruppen-IDs. Vorhandene Testzustände werden nicht überschrieben.

## Wire-Recovery unter Last vom 2026-10-13

Der NetBird-Treiber unterstützt `--rpc-faults` und
`--rpc-fault-boundary afterReply|beforeSend|both`. Für jeden der drei Members
werden Task-Write, Transaktionsbeginn, Take, Result-Write und Commit getrennt
getroffen. Der Standard `afterReply` verwirft je eine tatsächlich erfolgreiche
Wire-Antwort pro Kombination, insgesamt 15 Antworten. Der Parent wiederholt
seine bestehende ID und löst den ursprünglichen Child-Request auf. Er erzeugt
keinen Ersatzauftrag und wechselt nicht zu einem anderen Member.

`--entries 10000 --jobs 1000` provisioniert außerdem 9.000 unveränderte
Hintergrund-Entries in begrenzten lokalen Bootstrap-Commits vor Aktivierung
der Fixture-Policy. Die 1.000 fachlichen Jobs und ihre fünf Effekte laufen
über den signierten Root-/Member-Wire-Pfad. Initiales Inventar, vollständiger
Primzahlvergleich, eindeutige Ergebnisse, leere Task-Menge und erhaltenes
Hintergrundinventar werden geprüft. Hintergrund-Provisionierung ist keine
Abnahme des produktiven Membership-Aufnahmeprotokolls.

Ein erster `beforeSend`-Versuch zeigte eine Fehlerklassifikationslücke:
`RemoteSpace` wandelt `PermissionDenied`, `RequestExpired`, `ResultExpired`
und `IncarnationChanged` in konkrete Fehlerklassen um; der RPC-Adapter
erkannte bisher nur `RemoteError` mit Code. Die konkreten Fehler führten
dadurch wiederholt zu `unknown` statt zum dauerhaften Zustand `needsReview`.
Der Adapter erkennt jetzt beide Formen. Die JSONL-/SQLite-Regression prüft
alle vier Wire-Antworten, erhaltenen Review-Zustand nach Rekonstruktion,
genau einen Sendeversuch und null fachliche Wirkungen.

**Verbleibende Recovery-Grenze:** Ohne angenommenen Claim verweigert die
Delegationsprüfung den `targetRequest` des Statusabrufs. Das liefert keinen
verbindlichen Negativnachweis, dass der ursprüngliche Request niemals wirken
kann. Ein Ausfall vor Annahme wird deshalb konservativ `needsReview`; der
Treiber darf hier keinen automatischen Ersatzrequest oder grünen Lastlauf
erzwingen. Die autoritative Negativauflösung mit allen Bindungs-/Historien-
prüfungen und die vollständige Prozess-/Journal-/Mailbox-ACK-Matrix unter
Overlay-Last bleiben offen. Die 15 Antwortverluste ersetzen diese Matrix
nicht. Phase 2 bleibt ohne Gesamtfreigabe.

Der vollständige Antwortverlust-Lauf bestand mit 10.000 Entries, 1.000 Jobs
und sechs Workern in 462,309 Sekunden. Alle 15 Fehlerstellen wurden getroffen
und mit 15 Wiederholungen derselben Parent-IDs aufgelöst. Die Worker
bearbeiteten 167/167/167/166/167/166 Jobs; alle 1.000 Ergebnisse waren eindeutig,
keine Tasks blieben übrig und die 9.000 Hintergrund-Entries blieben erhalten.
Der Referenzvergleich ergab 9.592 Primzahlen bis 100.000, Summe 454.396.537.
422 lokale Tests, 185 Tests am gebauten Server-Artefakt und 24 Mobile-/Remote-
Runtime-Tests bestanden. Der alte Adapter scheitert gezielt auf beiden
Backends an der neuen Fehlerklassifikations-Regression.
[Nachweise](../../test/evidence/ap2-wire-recovery-2026-10-13/) enthalten die
Berichte und die getrennt bezeichneten Fehlerversuche.

Der separate echte NetBird-Versuch mit `beforeSend` bestätigt den sicheren
Abbruch mit dem korrigierten Artefakt: genau eine abgewiesene Statusauflösung,
anschließend `FederationUnavailable: child needs review`, ohne die frühere
Retry-Schleife. Der erwartete Prüfzustand ist nachgewiesen; dieser Versuch
ist ausdrücklich kein bestandener fachlicher Lastlauf. Beide isolierten
Läufe haben ihre eigenen Container, Gruppen und Policies vollständig entfernt.

## Aktuelle Admission-Auflösung vom 2026-10-13

`resolveOperation` schließt den vorstehend beschriebenen Vor-Versand-Fall
beim unveränderten Primary. Die Delegation kann den noch fehlenden eigenen
Claim nur mit gültiger signierter Generation, aktuellem Principal-/Space-/
Autoritäts-/Inkarnationsbezug sowie Ausstellungs- und Ziel-Epoche prüfen.
Generation und Request-ID bleiben unverändert; der verspätete Originalaufruf
und der Retry treffen denselben Claim. Der Router prüft die vollständige
Antwortbindung gegen seinen gespeicherten Child und gibt keine Ersatz-ID
oder Ausweichroute frei. Definitive Bindungs- und Berechtigungsfehler bleiben
`needsReview`. Für ältere Members wird nur die bisherige bekannte-Claim-
Auflösung weiter verwendet.

Die aktuellen JSONL-/SQLite-Tests prüfen fehlenden Claim ohne Zustandsänderung,
Reopen, verspätetes Original und parallelen Retry mit genau einer Wirkung,
fremde/gefälschte/abgelaufene Generationen, Epochenwechsel, Restore-Markierung,
Methoden-/Hash-Konflikte und weiterhin ablaufende Pending-Claims. Signierte
TCP-Tests kombinieren Vor-Versand-Ausfall und verlorene erfolgreiche Antwort
mit identischer Generation/Request-ID. Der NetBird-Smoke-Test traf alle
30 Kombinationen (fünf Effekte × drei Members × zwei RPC-Grenzen).

Das frühere `beforeSend`-Prüfergebnis ist historisch gültig für den damaligen
Adapter. Der neue gleiche-Epoche-Pfad ersetzt den dortigen pauschalen Review
bei einer noch gültigen Generation. Nach Promotion, verlorener Historie,
Restore, abgelaufener oder älterer Generation ohne Epochenbindung bleibt
kein solcher Retry-Nachweis verfügbar. Ein terminaler Negativclaim samt
Promotions-/Fencing-Nachweis aus Plan 6.2 ist damit nicht implementiert.
Prozess-, Journal- und Mailbox-ACK-Crash-Matrix sowie Produktions-Provisionierung
bleiben getrennte offene Abnahmen.

Der vollständige aktuelle Admission-Lauf bestand mit 10.000 Entries, 1.000
Jobs und sechs Workern in 438,837 Sekunden. Alle 30 RPC-Fehlerstellen wurden
mit 30 Wiederholungen derselben Parents aufgelöst. 1.000 eindeutige Ergebnisse,
null Tasks, 9.000 erhaltene Hintergrund-Entries und der vollständige
Primzahlvergleich sind bestätigt. Ein zusätzlicher Audit auf privaten Kopien
der abgeschlossenen Stores prüfte alle 5.000 Parents/Children sowie jeden
ursprünglichen faulted Member-Claim einschließlich Argument-Hash und Ziel.
Keine ungenutzte Child-Zukunftsreservierung blieb übrig.
428 lokale Tests, 199 Server-Artefakt-Tests, eine aktualisierte 43-Fälle-
Kompatibilitätsprüfung am Server (mit 42 überlappenden Fällen und einem neuen
Legacy-Fall) und 24 Mobile-/Remote-Tests bestanden.
[Nachweise](../../test/evidence/ap2-admission-2026-10-13/) unterscheiden diesen
aktuellen Wire-Nachweis von der weiterhin offenen Prozess-/Journal-/ACK-Matrix.


## Echte Prozessabbrüche an Journal-, RPC- und ACK-Grenzen (2026-10-13)

Das neue Szenario `phase2-process-crashes` bestand lokal und als gebautes
Server-Artefakt dieselben 20 Fälle: JSONL/SQLite × vor/nach × Candidate-Commit,
Winner-Commit, Parent-Abschluss, Mailbox-ACK und Router-RPC-Versand/Antwort.
Jeder Abbruch ist ein bestätigter SIGKILL. Root und drei Members werden danach
mit denselben Stores in einem frischen Prozess geöffnet; ein zweiter frischer
Prozess prüft den abgeschlossenen Replay.

Alle Fälle behalten den Gewinner und die ursprünglichen Target-, Principal-,
Generation-, Request-ID-, Methoden-, Argument- und Hash-Bindungen. Genau ein
Gewinner wird konsumiert, zwei Verlierer zurückgegeben. Keine Transaktion,
kein Mailbox-Ereignis und keine ungenutzte Zukunftsreservierung bleibt offen.
Typecheck und 428 Regressionstests bestanden. Bestehende Serverdienste bleiben
aktiv; die Produktionsbibliothek und der Mobile-Bundle bleiben unverändert.
[Nachweise](../../test/evidence/ap2-process-crashes-2026-10-13/).

**Grenze:** Der gekillte Prozess besitzt alle vier Stores; RPC verwendet
Fixture-Identitäten im selben Prozess und die Uhr ist fest. Dies ergänzt die
bisherigen Fehler-/Reopen-Tests um echten Prozessverlust, erfüllt aber noch
nicht die vollständige Crash-Matrix unter NetBird-Volllast, unabhängigem
Host-Ausfall oder Produktions-Boot/Fencing. Strom-/Datenträgerausfall wird
nicht geprüft. Phase 2 bleibt offen.


## NetBird-Volllast mit 30 tatsächlichen Root-Abbrüchen (2026-10-13)

Der vollständige Wire-Lauf mit 10.000 initialen Entries, 1.000 Jobs, sechs
fest zugeordneten Workern und drei persistenten Members bestand nach 30
SIGKILL-Abbrüchen des Roots. Geprüft wurden vor Versand und nach erfolgreicher
Antwort jeweils Task-Schreiben, Txn-Beginn, Take, Result-Schreiben und
Txn-Commit auf allen drei Members. Task-Schreibabbrüche liegen während der
Bestandserzeugung; die Verarbeitungsabbrüche folgen dem geprüften Gesamtbestand.
Der Treiber beobachtete für jeden Abbruch Exit 137 und keinen OOM-Kill.
Alle 31 Root-Starts behalten dieselbe Lease-ID und Router-Epoche.
Ein zunächst als Container-PID 1 gestarteter Root wurde vom Treiber wegen
fehlender tatsächlicher Abbrüche abgelehnt; Docker-Init behebt diesen Testaufbau.

Der Root setzt nur seine gespeicherten Operationen mit festen Principal-/Job-
Zuordnungen fort. Abgeschlossene Job-IDs und Producer-Fortschritt sind atomar
im privaten Fixture-Verzeichnis gespeichert. Unbestätigte Abschlüsse werden
mit denselben Parent-/Child-Identitäten wiederholt. Die Lease wird auf derselben
Epoche erneuert; bei verfallener oder überholter Lease bricht der Test ab.
Policy und Member-Targets werden beim Neustart geprüft und nicht neu installiert.

Der Lauf dauerte 727,978 Sekunden einschließlich Root-Neustarts.
1.000 eindeutige Ergebnisse, null verbliebene Tasks, 9.000 erhaltene
Hintergrund-Entries und der vollständige Primzahlvergleich sind bestätigt.
Der anschließende Audit privater Kopien prüfte 5.000 abgeschlossene Parents,
5.000 abgeschlossene Children und alle 5.000 ursprünglichen Member-Claims
mit Target-, Principal-, Generation-, Request-ID-, Methoden- und Hash-Bindung.
Alle 30 unterbrochenen Requests sind darunter; keine ungenutzte
Zukunftsreservierung und keine aktive Member-Transaktion blieb übrig.
Typecheck und 428 Regressionstests bestanden; der erweiterte Audit ist auch
gegen den vorherigen Admission-Volllastlauf geprüft.
[Nachweise](../../test/evidence/ap2-netbird-process-crashes-2026-10-13/).

**Grenzen dieses Root-RPC-Nachweises:** Er betrifft Root-Abbrüche bei laufenden
Members und deckt gezielte Mailbox-ACKs, explizite Journal-Commit-Grenzen
oder individuelle Member-Abbrüche nicht ab. Separate ACK- und Member-Nachweise
stehen in den folgenden Abschnitten; explizite Root-Journal-Grenzen bleiben offen. Die vier Netzräume bleiben auf einem physischen Server;
Produktions-Provisionierung, unabhängige Boot-/Fencing-Berechtigung und die
weiteren Admin-/Profil-Gates bleiben offen. Phase 2 ist nicht vollständig
abgenommen. Temporäre Fixture-Container und NetBird-Objekte wurden entfernt;
bestehende Produktionsdienste bleiben aktiv.


## ACK-Abbrüche bei sechs laufenden Workern (2026-10-13)

**Testblock 1 ist abgenommen.** Der korrigierte NetBird-Volllastlauf mit 10.000
initialen Entries und 1.000 Jobs bestand sechs bestätigte Root-SIGKILLs:
vor Versand und nach erfolgreicher ACK-Antwort auf jedem der drei Members.
Bei jedem Abbruch liefen alle sechs Job-Worker. Der Root prüft vor dem Abbruch
den bereits dauerhaft gespeicherten Kandidaten im Parent-Journal. Die sieben
Starts behalten Lease-ID und Epoche. Der Lauf dauerte 512,945 Sekunden.

Sechs zusätzliche Waiting-Take-Rennen behalten je einen identischen Gewinner
beim Replay; zwölf Verlierer sind wieder verfügbar. Ihre 18 Probe-Entries sind
zusätzlich zum anfänglich geprüften 10.000er Job-/Hintergrundbestand angelegt.
Alle 1.000 Sieb-Ergebnisse und 9.000 Hintergrund-Entries bleiben korrekt.
Der Audit privater Store-Kopien prüft 5.024 Parents, 5.072 Children samt
ursprünglichen Member-Claims sowie die sechs ACK-Kandidaten und Mailbox-Cursor.
Drei vor Versand unterbrochene ACK-IDs bleiben nicht angenommen; drei nach
Antwort unterbrochene ACK-Claims sind abgeschlossen. Ein ACK-Replay darf eine
neue Request-ID verwenden, erhält aber denselben Member, Principal,
Mailbox-Epoche und bestätigten Präfix. Die Parent-/Child-Identitäten der
Datenwirkungen bleiben unverändert. Keine aktive Transaktion, kein Gap und
keine ungenutzte Zukunftsreservierung blieb zurück.

Der erste volle Lauf fand eine Challenge-Kollision bei paralleler Abfrage und
Worker-Wirkung. Mehrere `RemoteSpace`-Instanzen auf demselben Transport dürfen
nicht gleichzeitig Challenge/Sign/Prove durchführen: der Server hält eine
offene Challenge pro Verbindung. Die Client-Bibliothek ordnet jetzt komplette
Proof-Abläufe pro Transport; andere Verbindungen bleiben unabhängig.
Fehlgeschlagene Proofs geben die Warteschlange frei; Host-/Peer-Pinning,
Schlüsselprüfung und frische Proofs bleiben bestehen. Die Kollision ist mit
Ed25519 und P-256 über echte TCP-Verbindungen reproduziert und regressionsgesichert.
432 lokale Tests, zehn gebaute Server-Authentifizierungsfälle, 24 Mobile-Tests
und Typecheck bestanden. Der Mobile-Bundle ist synchronisiert; ein neuer
Handy-Deployment-Nachweis wird damit nicht behauptet.
[Nachweise](../../test/evidence/ap2-netbird-ack-2026-10-13/).

Dieser ACK-Nachweis umfasst keine Member-Abbrüche oder sämtliche expliziten
Journal-Grenzen über NetBird. Der anschließende Member-Nachweis folgt unten. Alle Fixture-Container und temporären NetBird-Objekte
sind entfernt; vorhandene Dienste bleiben aktiv. Die Gesamtfreigabe bleibt offen.


## Individuelle Member-Abbrüche unter NetBird-Volllast (2026-10-13)

**Testblock 2 ist abgenommen.** Der volle Lauf mit 10.000 initialen Entries,
1.000 Jobs, drei Members und sechs Workern bestand 30 tatsächliche Member-
SIGKILLs: fünf Effektarten × drei Members × vor Annahme/nach dauerhaftem
Abschluss vor Antwort. Sechs Abbrüche betreffen die Task-Produktion; bei allen
24 Abbrüchen an Worker-Wirkungen laufen sechs Worker. Der Root startet einmal
und endet regulär; jeder Member startet elfmal auf seinem ursprünglichen Store.
Space-ID, Inkarnation, Autorität, Primary-Epoche, Membership und Policy bleiben
unverändert. Hintergrund-Entries werden beim Reopen nicht erneut angelegt.
Der Lauf dauerte 435,357 Sekunden einschließlich Member-Neustarts.

Vor jedem Abbruch prüft der Test den ursprünglichen Claim: 15 Requests sind
noch nicht angenommen, 15 bereits abgeschlossen. Nach Wiederaufnahme prüfen
private Kopien der read-only gemounteten Stores alle 5.000 ursprünglichen
Child-Claims samt Principal, Generation, Request-ID, Target und Argument-Hash.
Alle 5.000 Parents/Children sind abgeschlossen; keine aktive Transaktion oder
ungenutzte Zukunftsreservierung bleibt zurück. 1.000 eindeutige Ergebnisse,
null Tasks, 9.000 Hintergrund-Entries und der vollständige Primzahlvergleich
sind bestätigt.

Der Probelauf fand eine Admission-Lücke: Ein Transportverlust bei Proof oder
Generation vor Child-Dispatch ließ den schon gespeicherten Parent-Aufruf
abbrechen. Dieser typisierte Transportfehler meldet jetzt `FederationPending`
mit derselben Parent-ID; Routingplan und Reservierung bleiben bestehen.
Erst solange kein Child journalisiert ist, darf eine neue Generation beschafft
werden. Journalisierte Child-IDs werden unverändert wiederholt. Fachliche,
Berechtigungs- und Autoritätsfehler werden nicht in Pending umgedeutet.
Der Testtreiber wiederholt Pending mit 30 Sekunden Retry-Frist, ohne bestehende
Transaktions-Deadlines zu verlängern. Zwei positive und zwei negative Fälle
für JSONL/SQLite, 436 lokale Tests, vier gebaute Server-Recovery-Tests,
24 Mobile-Tests und Typecheck bestehen. Ein Fehler der Bericht-Dateirechte
im 60-Job-Probelauf ist vor dem erfolgreichen Volllastlauf behoben; fehlgeschlagene
Läufe werden getrennt dokumentiert.
Ein erster Volllastlauf scheiterte an einem hängenden SSH-Beobachter im
Testtreiber: Ein abgebrochener Member blieb unerreichbar; der Root beendete
seinen Pending-Retry nach der gesetzten Frist. SSH-Aufrufe sind jetzt begrenzt;
der Member-Beobachter prüft und startet die eigenen Container gebündelt auf
dem Server. Die erfolgreiche Abnahme nutzt eine frische Fixture. Ein verweigertes
vorhandenes Testverzeichnis berechtigt nicht zur Übernahme seiner CID-Dateien;
diese Aufräumgrenze ist separat mit dem laufenden eigenen Fixture geprüft.

[Nachweise](../../test/evidence/ap2-netbird-member-crashes-2026-10-13/).

Alle eigenen Fixture-Container und temporären NetBird-Objekte sind entfernt;
bestehende Produktionsdienste bleiben aktiv. Der Nachweis ersetzt weder
Promotion/Boot/Fencing noch unabhängige physische Ausfalldomänen oder Power-Loss-
Prüfung. **Sechs Testblöcke sowie die Gesamtfreigabe bleiben offen.** Als nächstes
folgt Testblock 3 mit gezielt unterbrochenen expliziten Root-Journal-Commits.


## Journal-Commit-Abbrüche über NetBird (2026-10-14)

**Testblock 3 ist abgenommen.** Fünf frische Volllastläufe mit jeweils
10.000 initialen Entries und 1.000 Jobs decken 13 erfolgreiche Journal-
Zustandsübergänge unmittelbar vor und nach dem tatsächlichen atomaren
`Storage.commit` ab. Alle 26 Root-Abbrüche sind bestätigte SIGKILLs;
bei jedem liefen sechs Job-Worker. Geprüft sind Parent-Aufnahme, Future-
Reservierung, Child-Aufnahme, Child-Bindung, Parent-ready, Child-inflight,
Child-Abschluss, Registrierung, Kandidat, Gewinner, Parent-Abschluss,
Reservierungsfreigabe und Cursor-Fortschritt bei einem Read-Miss.

Die Klassifikation prüft Dokumentfamilie, konkrete Parent-/Child-ID und
materialisierte Vor-/Nachzustände. Nach dem Commit werden Zustand und
Commit-Sequenz erneut vom Backend gelesen. Jeder anschließende Audit arbeitet
auf privaten Kopien geschlossener, read-only gemounteter Stores und prüft alle
ursprünglich journalisierten Child-Claims und die 26 Abbruchstellen. Vor der
dauerhaften Child-Aufnahme verworfene Identitäten bleiben nicht angenommen;
danach bleiben Generation, Request-ID, Principal, Target und Argumente erhalten.
Waiting-Take-Proben behalten einen Gewinner und geben die Verlierer zurück.
Keine aktive Transaktion oder ungenutzte Reservierung bleibt offen.

Der erste kleine Lauf erkannte die zunächst nicht erfasste Dokument-Erstanlage
und scheiterte korrekt bei 22 statt 26 Abbrüchen. Nach Korrektur bestehen die
vier Erstanlage-Proben samt Audit und alle fünf vollständigen Läufe.
Zusätzliche Probe-Entries zählen nicht zum anfänglich geprüften 10.000er Bestand.
[Nachweise](../../test/evidence/ap2-netbird-journal-2026-10-14/).

Die Abnahme umfasst erfolgreiche Daten-/Wettlauf-Journale. Fehler-/Review-,
Restore-, Lösch- und Profilumstellungsabläufe haben eigene Abnahmen.
Die fünf übrigen Testblöcke und die Gesamtfreigabe bleiben offen.

## Fortsetzung der Blöcke 4–8 am 2026-10-14

Die native Root-Provisionierung, Root-/Child-Historienlöschung, unabhängigen
Löschbarrieren, der Archivkatalog und die kontrollierte Profilumstellung sind
implementierte Bausteine. Ihre Grenzen und noch fehlenden Betriebsbindungen
stehen im [Implementierungsstand](../implementierungsstand.md#phase-2).
Sie ersetzen die offenen Live-Abnahmen nicht.

Ein definitiver Child-Fehler führte bisher in zusammengesetzten Schreib-/Take-
Operationen zu wiederholtem `FederationPending`; bei einer Suchoperation konnte
er außerdem übersprungen werden. Definitive Fehler und `needsReview` markieren
nun den Parent dauerhaft `needsReview`. Auch wartende Race-Operationen behalten
diese Sperre beim Replay. Acht neue Tests prüfen Write, Read, Take und Race auf
JSONL und SQLite nach Wiederanlauf ohne einen zusätzlichen Effekt. Typecheck und
die vollständige Suite bestehen mit **462/462 Tests**.

Die eigene native Live-Umgebung umfasst Root sowie drei Members auf big, dem
lokalen Rechner und vpsc. Sie verwendet ausschließlich ihre eigenen neuen
Stores und einen getrennten NetBird-Test-Scope. Ein unabhängiges Root-Fencing
verweigert normale Journaloperationen. Nach einem Verbindungsabbruch zum lokalen
Member wurde der ursprüngliche zweite Schreibauftrag mit derselben Parent-,
Child- und Member-Request-ID abgeschlossen. Dieser einzelne Wiederaufnahmebeleg
ist noch keine erfolgreiche native Sieb-/Job-Abnahme. Die Blöcke 4–8 bleiben offen.


Zusätzlich verweigert der eigene Root unter laufender Job-Produktion nach
unabhängigem Boot-Fencing weitere Operationen. Der anschließend neu gestartete
Root behält seine ursprüngliche Lease-ID und Router-Epoche; die drei Member-
Runtimes bleiben dabei unverändert. Das verwendete Data-Leserzertifikat kann
am unabhängigen Register lesen, bekommt beim CAS-Versuch aber die erwartete
Berechtigungsablehnung.

Die gemessenen Register-Lesezeiten betragen am lokalen Member im Mittel rund
450 ms und am Root rund 58 ms (je zehn Abfragen, keine Gate-4-Perzentile).
Der native Smoke-Treiber verwendet sechs Agenten mit ausdrücklich **höchstens
einer gleichzeitig offenen Transaktion**. Dadurch wird keine Abnahme für sechs
gleichzeitig offene native Root-Transaktionen behauptet. Die bisherigen
Lastnachweise der Blöcke 1–3 behalten ihre eigene dokumentierte Nebenläufigkeit.


Die Fortsetzung ergänzt zwei weitere sicherheitsrelevante Korrekturen:
Identische signierte Member-Policies benötigen keinen erneuten Mutations-Commit;
der normale geschützte Snapshot und eine erneute Authority-Prüfung bleiben
verpflichtend. Tatsächliche Profil-/Policy-Änderungen laufen weiterhin über
vollständig geprüfte Commits. Zwei neue Backend-Tests prüfen dabei insbesondere
Widerruf während der Abfrage und ungültige Signaturen.

Explizite Wire-Antworten `TransactionError` und `CompletionViolation` werden
bei Effect-Dispatch und Claim-Auflösung konservativ als `needsReview` erfasst.
Sie sind weder ein Transportausfall noch ein Nachweis einer erfolgreichen
Wirkung. Zwei neue TCP-/Backend-Tests prüfen, dass nach der Antwort und nach
Wiederanlauf kein weiterer Effekt gesendet wird. Beim eigenen nativen Lauf sind
alle zwölf Schreib-Parents abgeschlossen; die ersten beiden Transaktionen
sind vor der Take-Admission abgelaufen. Dieser Lauf bleibt daher ein negativer
Betriebsnachweis und gibt Phase 2 nicht frei. Die ursprünglichen IDs und ihre
Historien werden nicht durch Ersatz-IDs oder gelöschte Journale verdeckt.


Die [Nachweise der nativen Fortsetzung](../../test/evidence/ap2-native-root-2026-10-14/README.md)
enthalten Tests, Artefakt-Prüfsummen, Fencing, die CAS-Ablehnung und den dauerhaft
prüfpflichtigen ursprünglichen Request. Die eigene Testumgebung ist anschließend
beendet: sechs Container, sechs genau zugeordnete Firewall-Ausnahmen und die
temporären NetBird-Objekte sind entfernt. Die eigenen vier Boot-Einträge und die
eigene Autorität sind gefenced; die Stores bleiben als Nachweis erhalten. Alle
drei geschützten bestehenden Services sind weiterhin aktiv, ebenso das vorhandene
Tailscale auf vpsc und NetBird am lokalen Rechner.


Am 2026-10-14 wurden die Registerregeln für Block 7 zusätzlich abgesichert:
Lösch-Epochen können auch durch einen authentifizierten Operator-CAS nicht
zurückgesetzt werden. Command-Hash und Frist bleiben gebunden; eine weitere
Epoche beginnt erst nach abgeschlossenem Löschlauf und Archivlöschung.
Archivbindungen und Löschbelege bleiben erhalten, Quarantäne und Zerstörung
sind irreversibel. Die Archiv- und Floor-Prüfungen laufen innerhalb derselben
SQLite-Schreibtransaktion: Eine verspätete Registrierung eines Backups aus einer
älteren Epoche scheitert auch nach bereits erfolgter Versiegelung.

Die [Register-Nachweise](../../test/evidence/ap2-erasure-register-2026-10-14/README.md)
enthalten Zwei-Verbindungs-/Wiederanlauf- und mTLS-Prüfungen, **463/463** Tests,
**24/24** mobile Tests, Typecheck und 29 gebaute Artefakte. Der gemeinsame
Live-Registerdienst wurde nicht aktualisiert oder neu gestartet. Backup-/Restore-
Einbindung und aktive Backend-Historien sind weiterhin offen; Block 7 und die
Blöcke 4–8 insgesamt erhalten dadurch keine Freigabe.


## Native Root-Latenz: frische Prüfungen bündeln

Die [Latenz-Nachweise](../../test/evidence/ap2-native-performance-2026-10-14/README.md)
trennen den negativen Take, lesende Messungen und die weiterhin separate Live-Abnahme.
Ein einzelner lesender Root-Aufruf benötigte zunächst 19,4 Sekunden und 141
Registerabfragen. Root-Zustand und Schlüssel werden nun aus einem gemeinsamen,
normal durch BootGuard geschützten Control-Snapshot geprüft; Authority, Erasure und
Boot stammen aus einem frisch authentifizierten Register-Batch. Journal-Commits
behalten ihre frischen Autoritätsprüfungen. Es gibt keinen Authentifizierungs- oder
TLS-Sitzungscache.

Transaktionsfolgen können die noch offene, ursprüngliche Request-Generation bei
identischer Ziel-, Principal- und Policy-Bindung verwenden. Jeder Effekt behält eine
eigene dauerhafte Request-ID, einen frischen App-Key-Beweis sowie Grant und Delegation;
der Member prüft die Zulassung erneut. Eine Inline-Antwort zählt nur mit vollständig
geprüfter Bindung und Auflösung des tatsächlich gespeicherten Claims als abgeschlossen.
Legacy-Antworten benötigen weiterhin die gesonderte Auflösung.

Typecheck, **151** gezielte Prüfungen und **473/473** vollständige Tests bestehen.
Neue native Testläufe erhalten einen eigenen Objekt-/Request-Namensraum und messen
Begin, Take, Ergebnis und Commit getrennt. Frühere negative Claims bleiben erhalten.
Diese Implementierungs- und Testnachweise schließen Block 4 noch nicht.

## Block 8: Live-Profilumstellung nach Root-Abbruch (2026-10-15)

Im neuen, getrennten Scope `ap2-remaining-20261015` wurde der autorisierte
Supervisor-Command `ap2-remaining-20261015-profiles` nach dauerhaftem Eintritt
in `freezing` per gezieltem Root-SIGKILL unterbrochen. Die ursprüngliche
Command-ID und der gespeicherte Fortschritt blieben bestehen. Dabei zeigte
sich ein Wiederanlauffehler: Remote-Supervisor-Jobs liefen vor dem Control-
Listener an, den Members für frische Schlüsselabfragen benötigen.

`startFederationHost` öffnet nun den vollständig durch Boot-, Proof-, Grant-
und Control-Regeln geschützten Listener vor dem ersten Supervisor-Durchlauf.
Zwei zusätzliche persistente TCP-Tests prüfen diese Reihenfolge für JSONL
und SQLite. Nach Deployment des gebauten Fixes schloss derselbe Live-Command
ab: Policy-Version 5, `maxResultCount=2`, alle drei Members wieder `active`
und mit genau dem neuen Abschlussprofil. Die bestehenden Umstellungstests
prüfen weiterhin Antwortverlust, Commit-Abbrüche und Rechte-/Zielbindungen.

Nachweis: [profile-transition.json](../../test/evidence/ap2-remaining-2026-10-15/profile-transition.json).
Block 4 wird dadurch nicht erneut ausgeführt oder bewertet.

## Block 5: Zwei physische Hosts und isolierter Member-Ausfall (2026-10-15)

Der bestehende NetBird-Peer des lokalen physischen Rechners wurde als vierter
Member `d` in den eigenen Scope aufgenommen. Root und drei weitere Members
blieben auf `big`; der lokale Rechner verwendet sein vorhandenes NetBird,
keinen zweiten VPN-Tunnel. Der zusätzliche SSH-Unix-Socket dient ausschließlich
dem unabhängigen Recovery-Register und transportiert weiterhin frisches mTLS.
DMI-Proben unterscheiden den lokalen MSI-Rechner vom netcup-KVM-Server.
Der Nachweis betrifft zwei physische Betriebsumgebungen, keine Standby-
Promotion und keinen simulierten Stromausfall.

Ein signierter Root-Schreibaufruf legte einen `DomainProbe` ausschließlich auf
Member `d` ab. Nach SIGKILL genau dieses Members meldete dessen Abfrage einen
Ausfall, während Root und die übrigen Members weiterhin antworteten. Der
ursprüngliche Lese-Parent `domain-probe-read` wurde nach Wiederöffnung mit
unveränderter Zielbindung fortgesetzt und las genau den persistierten Nonce.
Ein zunächst noch unaufgelöster Child wurde mit derselben Parent-ID fortgesetzt;
es wurde kein neuer Datenlauf erzeugt. Beide Parents sind dauerhaft `done`.

Die lokale Eingangs-Firewall erhielt ausschließlich zwei dokumentierte Regeln
für Root-Peer, lokale NetBird-Adresse und Testport 7432.
Nachweis: [physical-domains.json](../../test/evidence/ap2-remaining-2026-10-15/physical-domains.json).

## Blöcke 6 und 7: Verteilte Löschung mit Backend- und Archivnachweis (2026-10-15)

Der echte Verbund umfasste Root/Control und vier Data-Members auf zwei Space-
Hosts; sein Recovery-Register lief unabhängig auf `vpsc`. Neun persönliche
Prüf-Entries wurden auf drei Members angelegt. Eine zusätzliche lesende
Prüfung der unveränderten Root-Sicherung bestätigt vor dem Löschen die
Nutzdaten sowohl im eigenen als auch im fremden gecachten Parent-Ergebnis.

`DistributedPrincipalErasure` band alle fünf Ziel-Tupel und denselben
Command `erase-20261015-remaining` an einen unabhängigen CAS-Fortschritt.
Alle Writer wurden unabhängig gesperrt und tatsächlich gestoppt. Erst nach
Anlage sämtlicher Lösch-Floors und Sammlung aller Entry-IDs begannen lokale
Löschungen. Nach deren Abschluss endete der erste Koordinatorprozess am
dauerhaften Checkpoint `root`; ein neuer Prozess setzte denselben Command
fort und bereinigte eigene und betroffene fremde Parent-/Child-Historien.

Danach wurden alle fünf lokalen Epochen und installierten Berechtigungen
aktualisiert, die aktiven SQLite-Historien konsolidiert und die zuvor
registrierten, per SHA-256 gebundenen Backups quarantänisiert und gelöscht.
Die Einzelbelege prüfen tatsächliche Datenbank-, WAL- und SHM-Dateien auf
verbliebene Prüfnutzdaten und verlangen leere eigene Archivverzeichnisse.
Alle fünf Floors sind `sealed`, alle Archive `destroyed`, `archivesPending`
ist überall `false`. Ein Restore jedes alten Archivs wurde ausdrücklich
mit der Löschpolicy-Ablehnung zurückgewiesen; Transportfehler zählen nicht
als bestandener Restore-Negativtest.

Nach erneuter Boot-Freigabe und Neustart von Root und allen vier Members
lieferten ursprünglicher Write-Parent, eigener Read-Parent und fremder
Read-Parent jeweils `ResultExpired`; keine Prüfeinträge waren mehr sichtbar.
Keine frühere Root-Operation wurde mit einer neuen Request-ID wiederholt.

Nachweise: [Löschlauf](../../test/evidence/ap2-remaining-2026-10-15/distributed-erasure.json),
[Dateiprüfungen](../../test/evidence/ap2-remaining-2026-10-15/file-verification.json),
[Fortschrittsfolge](../../test/evidence/ap2-remaining-2026-10-15/erasure-progress.jsonl),
[alte Cache-Inhalte vorhanden](../../test/evidence/ap2-remaining-2026-10-15/privacy-before-erasure.json),
[Prüfstand](../../test/evidence/ap2-remaining-2026-10-15/validation.json).

Der abschließende Quellstand besteht Typecheck, 492 phi-spaces-Tests,
20 mobile Runtime-Tests, vier mobile Lifecycle-Tests und zwei zusätzliche
Python-Prüfungen mit echten SQLite-WAL-Daten. Letztere bestätigen konsistente
Backups, unveränderte Bindung beim Replay und Löschverweigerung bei falschem
Hash. Die SQLite-Bereinigung behauptet kein sicheres Überschreiben von
Speichermedien; zusätzliche externe Kopien unterliegen weiterhin der
verbindlichen Registrierung und Löschpolicy. Die Gesamtfreigabe/Gate 4 bleibt
von diesen abgeschlossenen Testblöcken getrennt.

Nach Sicherung der Nachweise wurden ausschließlich die eigenen Abnahme-
Fixtures unabhängig gesperrt und beendet. Zwei eigene lokale Firewallregeln,
drei eigene NetBird-Policies und Gruppen, beide SSH-Weiterleitungen und die
exakt ergänzte eingeschränkte SSH-Autorisierungszeile wurden entfernt.
Der eigene Register-Container wurde beendet und entfernt; seine Datenbank,
die versiegelten Löschbelege und die Stores bleiben erhalten. Die geprüften
Bestandsdienste auf `big` und `vpsc` behielten Container-ID, Startzeit und
Neustartzähler: [Aufräumnachweis](../../test/evidence/ap2-remaining-2026-10-15/cleanup.json).


## Gate 4 und Abschlussentscheidung (2026-10-15)

Der ergänzende gebaute Server-Grenztest und die gezielte Handshake-Anschlussprüfung
sind bestanden. Die [Betriebsgrenzen und Reichweite](ap2-gate4.md) sind verbindlich
dokumentiert. Alle acht Blöcke und Gate 4 sind geschlossen; es bleibt kein
Phase-2-Testblock offen. Die ausdrückliche Abschlussentscheidung zu Block 4 wird
als Ausnahme fortgeführt und erklärt die dortigen negativen nativen Messungen
nicht zu bestandenen Tests. Der nächste Planabschnitt ist Phase 3.
