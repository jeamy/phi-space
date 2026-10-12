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

**Nachgewiesene Systemlücke:** `FederatedSpace` behält höchstens 16 verschiedene
Parent-Operationen; das Router-Journal begrenzt ebenfalls die aufbewahrte
Historie. Der neue Test prüft die Ablehnung der 17. Operation ohne zusätzliche
Wirkung und die Wiederauflösung einer bekannten ID nach Neustart. Unbegrenztes
Hochsetzen oder Löschen der Historie würde Budgets bzw. Dedup verletzen.
Für die Abnahme sind eine begrenzte, generationengebundene Aufbewahrung oder
Journal-Aufteilung sowie deren Crash- und Retry-Nachweise nötig.

| Abnahmepunkt | Nachweis / offener Schritt |
|---|---|
| Signierte Lease, Delegation, Rechte-/Policy-/Epochengrenzen | Bestehende Delegations-, Routing- und TCP-Tests; keine neue Overlay-Abnahme |
| Stabile Child-IDs, Retry, Restore | Router-/Parent-Tests auf JSONL und SQLite; Reconciliation-Hook bei tatsächlichem Root zu provisionieren |
| Drain, Ergebnis-Commit, Remove, Notify und EmptyProof | Membership- und Core-Tests einschließlich globaler Abschlussbudgets |
| Capability und MemberStatus | JSONL-/SQLite-Tests plus zusammengesetzter Host-TCP-RPC-Test; produktive Provisionierung offen |
| Admin-Purge und F9 | Lokale batchweise Löschung mit Sperre/Crash-Recovery geprüft; verteilter Löschlauf und Router-Historien offen |
| 10.000 Entries, drei Members, 1.000 Jobs, sechs Worker | Member-Lasttest; finaler Bericht in den verlinkten Nachweisen |
| Virtueller Router unter dieser Last | Nicht erfüllt: dokumentierte Historiengrenzen |
| Crash nach jeder Journal-/RPC-/ACK-Grenze unter voller Last | Vollständige Lastmatrix offen; vorhandene gezielte Crash-Tests bleiben gültig |
| Drei-Member-Sieb über echte NetBird-Verbindungen | Offen; Member-Lasttest ist ausdrücklich kein Ersatz |
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
