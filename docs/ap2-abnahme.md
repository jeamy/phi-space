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
atomarer, deduplizierter Audit-Aufzeichnung. `purgeTasks` löscht ausschließlich
unreservierte profilierte Tasks. Bei der Principal-Löschung werden eigene Entries,
Claims, Generations und Mailboxes entfernt. Fremde Mailboxes mit betroffenen
Entries erhalten eine neue Epoche und Gap; betroffene fremde Claim-Ergebnisse
verfallen ohne erneute Wirkung. Stream-Historie wird verworfen und alte
Snapshot-Tokens werden ungültig. Der Supervisor bindet die Handler nur ein,
wenn ein autorisierter Controller provisioniert ist.

**Grenze:** Principal-Löschung setzt derzeit einen ruhenden lokalen Space voraus
und lehnt Änderungen oberhalb `maxCommitBytes` atomar ab. Der mehrstufige
Löschlauf über große Bestände, Remote-Members und Router-Historien fehlt noch.
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
Der Body darf keinen fremden Host vertreten. Unterschiedliche technische
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
| Admin-Purge und F9 | Lokaler, atomarer, auditierter Baustein geprüft; verteilter/batchweiser Löschlauf offen |
| 10.000 Entries, drei Members, 1.000 Jobs, sechs Worker | Member-Lasttest; finaler Bericht in den verlinkten Nachweisen |
| Virtueller Router unter dieser Last | Nicht erfüllt: dokumentierte Historiengrenzen |
| Crash nach jeder Journal-/RPC-/ACK-Grenze unter voller Last | Vollständige Lastmatrix offen; vorhandene gezielte Crash-Tests bleiben gültig |
| Drei-Member-Sieb über echte NetBird-Verbindungen | Offen; Member-Lasttest ist ausdrücklich kein Ersatz |
| Handy mit aktuellem APK | Installation und Objektlesen über echte NetBird-Verbindung nachgewiesen |
| Gesamtfreigabe Phase 2 / finale Gate-4-Werte | Nicht erteilt |

Nachweise und Prüfzahlen: [Abnahmeverzeichnis](../test/evidence/ap2-final-2026-10-11/).
