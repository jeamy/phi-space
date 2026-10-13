# Phase 2: Erweiterungen und Abnahme vom 2026-10-11

**Phase 2 ist noch nicht abgenommen.** Die nachstehenden Nachweise unterscheiden
Bausteintests, den Member-Lasttest und den noch offenen Verbundbetrieb.
Die bisherigen Nachweise zu AP 1b bleiben bestehen.

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

Nachweise und Prüfzahlen: [Abnahmeverzeichnis](../test/evidence/ap2-final-2026-10-11/).

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

Aktuelle Nachweise: [Prüfstand 2026-10-12](../test/evidence/ap2-batches-2026-10-12/).

## Nachtrag 2026-10-12: partitionierte Root-Journale

[Prüfberichte](../test/evidence/ap2-journals-2026-10-12/) enthalten die aktuellen
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

[Messwerte und Nachweise](../test/evidence/ap2-router-load-2026-10-12/)
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

[Nachweise](../test/evidence/ap2-netbird-2026-10-12/) dokumentieren den konkreten
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
[Nachweise](../test/evidence/ap2-wire-recovery-2026-10-13/) enthalten die
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
[Nachweise](../test/evidence/ap2-admission-2026-10-13/) unterscheiden diesen
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
[Nachweise](../test/evidence/ap2-process-crashes-2026-10-13/).

**Grenze:** Der gekillte Prozess besitzt alle vier Stores; RPC verwendet
Fixture-Identitäten im selben Prozess und die Uhr ist fest. Dies ergänzt die
bisherigen Fehler-/Reopen-Tests um echten Prozessverlust, erfüllt aber noch
nicht die vollständige Crash-Matrix unter NetBird-Volllast, unabhängigem
Host-Ausfall oder Produktions-Boot/Fencing. Strom-/Datenträgerausfall wird
nicht geprüft. Phase 2 bleibt offen.
