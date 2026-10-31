# Gate 4 und Abschluss von Phase 2

Stand: 2026-10-15. **Gate 4 ist für das nachgewiesene Betriebsprofil geschlossen.**
Phase 2 ist mit der ausdrücklich dokumentierten Abschlussentscheidung zu
Block 4 abgeschlossen. Das ist keine uneingeschränkte native Produktionsfreigabe:
Die historischen negativen nativen Lastmessungen bleiben negativ. Block 4 wird
nicht erneut geöffnet. Replikation und Promotion gehören weiterhin zu Phase 3.

## Verbindliche Betriebswerte

| Grenze | Festgelegter Wert | Nachweis und Bedeutung |
|---|---|---|
| Frame | 262.144 Bytes einschließlich 8-Byte-Header | Exakter Roundtrip, größerer Client-Frame abgewiesen; übergroßer angekündigter Server-Frame schließt Verbindung. |
| Commit-Budget | 196.608 Bytes | Drei Txn-Payloads à 60.000 Bytes angenommen, vierter vor Mutation abgewiesen; ursprüngliche Txn abschließbar. Stream-Batch 180.443 Bytes; vollständiges kodiertes StorageWrite-Array 180.747 Bytes auf JSONL und SQLite. |
| Entry-Felder | 65.536 Bytes | Quoten-/AP1-Tests einschließlich fünf Entries nahe der Grenze und unveränderlicher Seiten unter Writes. |
| Verbindungen | 32 je identifiziertem Peer; 64 insgesamt je Listener | Jeweils nächste Verbindung abgewiesen; auch stumme Verbindungen werden jetzt sofort identifiziert und zählen zur Peer-Grenze. |
| Neue Verbindungen | Token-Bucket 32 pro Quelladresse/s, Burst 32 | Vor der Peer-Erkennung; daher keine globale Rate je Peer über mehrere Quelladressen. Bestehende Gate-Regression prüft die Drosselung. |
| Peer-Erkennung | 5.000 ms ab TCP-Annahme | Stummer Socket mit hängendem Directory nach gemessenen 5.010 ms geschlossen; kleine Zeitplanungsabweichung ist keine zusätzliche konfigurierte Frist. |
| Schlüssel-Challenge | 30.000 ms Gültigkeit | Eigener Schicht-B-Vertrag, kein Teil der gemessenen Directory-Laufzeit. |
| Inaktivität / parallele Calls | 300.000 ms; 32 Calls je Verbindung | Socket-Defaults; Idle-Schließung regressionsgeprüft. 32 parallele Calls wurden im neuen Serverlauf nicht separat ausgelastet. |
| Snapshot | 60.000 ms, höchstens 16 Tokens und zusammen 67.108.864 kodierte Bytes je Space/Host-Cache | 10.000 Entries: 47 Seiten in 303 ms, erste Seite 126 ms. Byte-Eviction bei sechster 12-MB-Kopie, Token-Eviction und Ablauf geprüft. |
| Request-Generation | 3.600.000 ms Zulassung neuer IDs | Größter der fünf Journal-Volllastläufe 499.317 ms; dieselbe Generation reicht für diesen Lastfall. Bereits angenommene Pending-Requests dürfen länger fortgeführt werden. |
| Ergebnis-Aufbewahrung | 86.400.000 ms ab Entscheidung | Ablauf-/Replay-Verhalten mit injizierter Uhr geprüft; keine 24-Stunden-Dauermessung. |
| Entries | 10.000 je Space; standardmäßig 1.000 je Owner | Lastinventar verwendet ausdrücklich 10.000 je Owner. Dies ist keine stillschweigende Änderung des Defaults. |
| Weitere Byte-Budgets | Felder 64 MiB; Claims 32 MiB; Outbox 8 MiB; Gesamtdokument 128 MiB; Event 160 KiB; Log 4 MiB; Folgeaufträge 16 MiB | Harte Core-Budgets mit Ablehnung/Backpressure; keine gleichzeitige Vollauslastung aller Budgets vermessen. Mailbox 8 MiB / maximal 7 Tage. |
| Owner-Quoten | je 20 Registrierungen, Waiter und Txns | Für das dokumentierte Worker-Profil beibehalten; keine globale Kapazitätszusage. |
| Verteilter Löschlauf | 32 Participants, 4.096 gesammelte Entry-IDs je Command, ID höchstens 256 Zeichen | Überschreitung bleibt gefenced. Keine unbegrenzte Principal-Löschung zugesagt; produktiven Umfang vor dem Start prüfen. |

## Grundlage der Entscheidung

Die vorhandene [Router-Lastmessung](../../../../test/evidence/ap2-router-load-2026-10-12/README.md)
belegt 10.000 Entries, 1.000 Jobs, drei Members und sechs Worker mit 5.000
abgeschlossenen Root-Operationen auf SQLite. 36 verlorene Wirkungsantworten
wurden über dieselben IDs aufgelöst. 227,5 Sekunden Gesamtlaufzeit und rund
258 MiB gemessener RSS gelten für den dort beschriebenen In-Process-Transport.
API-p95/p99 sind keine reinen Netzwerk-Latenzen.

Die [fünf NetBird-Journalläufe](../../../../test/evidence/ap2-netbird-journal-2026-10-14/README.md)
belegen die signierte Overlay-Strecke unter 1.000 Jobs mit sechs Workern,
26 gezielte Journal-SIGKILLs, 25.294 geprüfte Original-Claims, keine offenen
Transaktionen und keine ungenutzten Future-Reservierungen. Laufzeiten:
443.914 bis 499.317 ms. ACK- und Member-Abbrüche besitzen ihre separaten
abgeschlossenen Nachweise in der [Phase-2-Abnahme](../ap2-abnahme.en.md).

Der [ergänzende Grenztest](../../../../test/evidence/ap2-gate4-2026-10-15/README.md)
misst Snapshot-, Frame-, Commit-, Verbindungs- und Laufzeitgrenzen an gebauten
Artefakten im Produktionsmodus auf big mit 2 CPUs und 1 GiB RAM. Peak-RSS beim
Snapshot-Test: 244.903.936 Bytes. Die Anschlussprüfung misst ausschließlich
den korrigierten Handshake und reale kodierte Storage-Writes; sie wiederholt
keinen Job-Lastlauf. Alle eigenen Container wurden entfernt, Bestandscontainer
blieben unverändert.

## Reichweite des Abschlusses

Die Werte sind die festgelegte Baseline für dieses Arbeitsprofil. Snapshot-Seiten
müssen innerhalb ihrer festen TTL vollständig gelesen werden; Laststeigerungen,
langsame Links oder mehr als das geprüfte Inventar brauchen eine neue Dimensionierung.
Ein abgelaufener Token erfordert einen neuen Snapshot. Die 64-MiB-Snapshotgrenze
zählt kodierte Inhalte, nicht den vollständigen JavaScript-Heap. Gleichzeitige
Snapshots mehrerer Spaces/Hosts erhöhen den Prozessverbrauch zusätzlich.

Das Commit-Budget arbeitet mit konservativen fachlichen Reservierungen.
Der gemessene StorageWrite-Grenzfall ist keine allgemeine formale Begrenzung
aller Root-/Admin-Multidokument-Transaktionen auf 192 KiB. Die vollständige
physische Schreibverstärkung wurde nicht gemessen. Historische Root-Reservierungsbytes
werden daher ausdrücklich nicht als tatsächliche Commit-/Plattenbytes verwendet.

Phase 2 ist **mit der bestehenden Ausnahme für Block 4** abgeschlossen. Die
nachgewiesenen Lastpfade nutzen Fixture-Provisionierung; der zusätzliche
physische Member-/Lösch-/Profilnachweis ersetzt keine bestandene native
1.000-Job-Produktionsmessung. Eine öffentliche virtuelle Space-Adresse wird
nicht automatisch angeboten. Externe Wirkungen benötigen weiterhin Idempotenz
oder eine gemeinsame Transaktion. Power-Loss, Host-/Plattenverlust, Standby,
Replikation und Promotion sind durch diesen Abschluss nicht freigegeben.

Als nächster Umsetzungsschritt folgt Phase 3 nach dem Zielvertrag. Deren
Fencing-, Import- und Übernahmeprüfungen erhalten eigene Nachweise.
