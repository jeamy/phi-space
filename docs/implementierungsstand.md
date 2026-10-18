# phi-spaces: aktueller Implementierungsstand

Stand: 2026-10-16. Diese Seite ist die Ist-Stand-Referenz für Code und
automatisierte Nachweise. Der [Föderationsplan v3](federation-plan-v3.md) bleibt
der Zielvertrag: Seine Garantien gelten nicht allein deshalb, weil einzelne
Bausteine unten bereits vorhanden sind.

Ergänzung vom 18. Oktober 2026: Die Hilfesystem-/Demo-Befunde F01–F23 wurden
mit gezielten lokalen Regressionstests bearbeitet. Änderungen, Nachweise und
bewusste Grenzen stehen in der [Umsetzungstabelle der Analyse](analyse-hilfesystem-demo-apps-2026-10-18.md#7-schrittweise-umsetzung-vom-18-oktober-2026)
und im [Betriebsvertrag des Hilfesystems](../help-site/README.md#runtime-contract-and-restart).
`PhiSpaces.write` und `RemoteSpace.write` unterstützen eine optionale atomare
Singleton-Erstanlage über `unique`-Schlüsselfelder; ältere Remote-Server ohne
`write.unique` werden dafür abgewiesen. Dies ist eine lokale/RPC-Erweiterung,
keine neue Zusage globaler Eindeutigkeit oder einer abgenommenen Replikation.

Die [Corpus-Konsistenzprüfung vom 18. Oktober](analyse-hilfecorpus-konsistenz-2026-10-18.md)
ergänzt dies um acht zweisprachige Praxisleitfäden, aus TypeScript abgeleitete API-Signaturen,
60 kompilierte Dokumentationsbeispiele sowie geprüfte Navigation, Live-Mirror und Shutdown.
Standalone-Client und frischer Next-Produktionsbuild sind lokal geprüft. Der Bericht trennt
abgeschlossene lokale Korrekturen von weiterhin offenen Deployment-/Last-/Ausfallabnahmen.

## Umfang und Grenzen

Ein Space ist ein persistentes Dokument im `@earendil-works/pi-durable`-Harness.
Der Default-Space (`pi-spaces.space`) und benannte Spaces
(`pi-spaces.named-space`) haben Dokumentversion 5. Eine Registry ordnet Aliase
unveränderlichen `spaceId`s zu; Entry-Views tragen zusätzlich
`gid = <spaceId>/<localId>`.

Der lokale Client `PhiSpaces` und der Dienst `SpaceService` benutzen dieselbe
Kernsemantik. Der Dienst ist über In-Process-, Unix-Socket- und TCP-Transport
nutzbar; `RemoteSpace` implementiert dafür den gemeinsamen Basisvertrag
`SpaceLike`. Gate, Overlay-Identität, Schlüssel-Challenge, Enrollment, Grants und
Supervisor sind zu einer persistenten Host-Laufzeit zusammengeführt. Es gibt
ein persistentes Router-Grundgerüst (AP 2.1) und einen Simulator (AP 2.8),
Phase 2 ist mit dokumentierter Ausnahme für Block 4 abgeschlossen; die Betriebserweiterung (Läufe, Worker, Spaces, Bootstrap, mobile Steuerung) ist umgesetzt; Replikation und Promotion sind begonnen, aber nicht abgenommen. Die [Phase-1b-Abnahme](ap1b-abnahme.md) trennt lokale Nachweise von den
abgeschlossenen Betriebs- und Geräteabnahmen im geprüften F15-Modell.

| Baustein | Vorhanden | Nicht daraus ableitbar |
|---|---|---|
| Core | Entries, Templates, Leases, Txns, Notify, Waiter, Limits, Revisionslog und Abschlussprofile | globale Reihenfolge oder externe Exactly-once-Wirkung |
| Lokaler Client | `PhiSpaces`, benannte Spaces, Claims, Seiten, Changes | Zugriff auf einen fremden Host ohne Dienst |
| Dienst | Rollen-/Typprüfung, signierte Generationen, dauerhafte Pending/Poll, Mailbox-ACK, Token-Seiten und Quoten | Replikation oder abgenommener Recovery-Betrieb |
| Remote | `RemoteSpace`, stabile Retries, Notify/Wait/Events/ACK, Unix/TCP, pi-server-Adapter, Schlüsselbeweis, Enrollment, Grant-Provider und Rotation | automatische Federation-Provisionierung |
| Phase 1b | zwei dauerhafte echte NetBird-Gates auf big, unabhängiges Register auf vpsc, private SSH-/TLS-Zugänge, Control-ACK, Control-/Data-Restore-Controller, Member-Installation, native Android-Keystore-Abnahme, echte Handy–big-Kopplung/Objektzugriff/Rotation sowie verteilte Live-Data-/Control-Restores mit bestätigten Member-ACKs, sichtbare Handy-Schlüsselsteuerung, zehn Minuten Bildschirm-aus/Hintergrund und kontrollierter tiefer Doze-Test | F15-Modell und kontrollierte komponentenbezogene Ausfälle abgenommen; keine Phase-2-/Replikations-/Promotion-Freigabe |
| Router AP 2.1 | Command-Zustandsmaschine, dauerhaft gebundene Unterrequests, Rekonstruktion, getrennte Budgets, feste optionale Journal-Partitionen, unabhängige Admission, Restore-Review und Mailbox-Übernahme | vollständige Phase-2-System- und Lastabnahme |
| AP 2.2–2.5 | signierte RouterLease/Delegation, Policy, HRW, FederatedSpace, Txn-Bindung, Waiter-Wettlauf, Membership und lokale Admission; echte TCP-Gates und persistente Neustartprüfungen | AP 2.6/2.7/2.9, automatische Provisionierung der Root-Komposition und öffentliche virtuelle Space-Adresse |
| Router-Lastfall AP 2.9 | 10.000 Entries, 1.000 Jobs, sechs Worker, 5.000 Router-Operationen auf vier SQLite-Stores; 36 Antwortverluste, Root-Reopen, Ergebnis- und Journalprüfung am gebauten Server-Artefakt | Transport dieses Nachweises mit Fixture-Identitäten im selben Prozess; separate Overlay-Abbruchblöcke 1–3 abgeschlossen; historische native Negativmessungen getrennt dokumentiert; Block 4 per Entscheidung abgeschlossen |
| NetBird-Wire-Prüfung Phase 2 | 1.000 Sieb-Jobs, drei Members, sechs Worker mit realen Peer-Gates, App-Key-Beweis, signierten Grants/RouterLease/Delegation; zusätzlich 10.000 Entries und 15 verlorene erfolgreiche Antworten geprüft; Lease-Deadlock, Parent-Reservierungsfreigabe und typisierte Auflösungsfehler regressionsgesichert | Fixture-Provisionierung in vier Netzräumen auf einem Server; Overlay-Abbruchblöcke 1–3 abgeschlossen; vollständige native Produktions-Abnahme bleibt offen |
| NetBird Member-Prozessabbrüche Phase 2 | 30 tatsächliche Member-SIGKILLs vor Admission/nach dauerhaftem Abschluss; je elf Starts mit gleicher Zielbindung, ein Root-Start; 1.000 Jobs/10.000 Entries; alle 24 Worker-Wirkungsabbrüche bei sechs laufenden Workern; Audit sämtlicher 5.000 ursprünglichen Claims | Phase 2 mit Ausnahme zu Block 4 abgeschlossen; keine Promotion-/Boot-/Power-Loss-Freigabe |
| NetBird ACK-Abbrüche Phase 2 | Sechs tatsächliche Root-SIGKILLs vor/nach ACK auf drei Members bei sechs aktiven Workern und 1.000 Jobs; stabile Gewinner, zwölf zurückgegebene Verlierer; Audit aller Kandidaten, Cursor und 5.072 ursprünglichen Child-Claims; gemeinsame Transport-Proofs regressionsgesichert | Phase 2 mit Ausnahme zu Block 4 abgeschlossen; Liste in der Phase-2-Abnahme |
| NetBird Root-Prozessabbrüche Phase 2 | 10.000 initiale Entries, 1.000 Jobs, sechs feste Worker, drei Members; 30 tatsächliche Root-SIGKILLs an fünf RPC-Effektarten vor/nach Versand bzw. Antwort; 31 Starts mit gleicher Lease/Epoche; Audit aller 5.000 ursprünglichen Member-Claims | Gezielte Root-Journal-Grenzen sind in Block 3 abgenommen; Block 4 per Entscheidung abgeschlossen; historische native Negativmessungen bleiben erhalten; ACK- und Member-Nachweise stehen getrennt |
| Prozess-Crash-Matrix Phase 2 | 20 bestätigte SIGKILL-Fälle auf JSONL/SQLite lokal und am gebauten Server-Artefakt: Journal-, RPC- und ACK-Grenzen; stabile ursprüngliche Requests, Gewinner und Replay; keine offenen Reservierungen | Fixture-RPC und feste Uhr, vier Stores im selben Prozess; separate NetBird-Volllast in Blöcken 1–3 nachgewiesen; physische Ausfalldomänen separat in Block 5 nachgewiesen |
| Simulator AP 2.8 | mehrere echte JSONL-/SQLite-Harnesses, deterministische Transportfehler, Uhrsprünge, Crash/Reopen und unabhängiges Reservierungs-/Request-Gegenmodell | realer Overlay-/Replikations-/Fencing-Nachweis |
| Betrieb | Testbed und Szenario `sieve-remote` | Produktivfreigabe der Federation oder mobiler Bedienabläufe |
| Lauf-, Worker-, Space- und Deployment-Steuerung (Betriebserweiterung B2–B10) | RunGate im Core, `RunController` mit Journal, signierte Gate-Anweisungen an Remote-Members, Admin-Commands, Recovery-Abgleich nach Restore, Worker-Zuweisungen mit lokalem Supervisor, Space-Lebenszyklus, Deployment-Plan/-Apply mit CLI; Abnahmefälle 2, 3, 4, 8–13 lokal, Fall 3 zusätzlich über echtes NetBird | SSH-/NetBird-Provisionierung und Pairing im Bootstrap, mobile Steuerung gegen einen Koordinator auf big; Worker nur als Schleifen im Daemon-Prozess |

## Daten- und Konsistenzmodell

- Einträge haben `{ type, types?, fields }`; `types` enthält den Haupttyp und
  optionale Supertypen. Ein Template kann `type`, `fields` und `id` enthalten;
  `null` bzw. fehlende Template-Felder sind Wildcards. Feldvergleich ist tiefe
  JSON-Gleichheit.
- `write` erzeugt immer einen neuen Entry. Ein `take` ist direkt destruktiv oder
  reserviert unter einer Transaktion; Abort oder Lease-Ablauf stellt ihn wieder
  bereit. Writes einer Transaktion bleiben bis Commit unsichtbar.
- `read` und `take` warten bis Timeout. Die `IfExists`-Varianten warten nur,
  solange passende Entries durch fremde Transaktionen gesperrt sind.
- Claims binden Mutation bzw. blockierendes Read/Take und Ergebnis atomar an
  `{ principal, generation, requestId }`. Ein Retry mit gleichen Argumenten
  erhält das gespeicherte Ergebnis; er wiederholt nicht die Mutation. Das
  betrifft keine externen Nebeneffekte.
- Jede fachliche oder interne State-Änderung erhält eine Revision pro Storage-Txn und Space.
  `readPage` liefert `token`, `rev` und `streamId`; `changes` liefert begrenzte Entry-Batches,
  bei reinen State-Änderungen auch leere Batches. Dies ist kein vollständiger Primary-Replikationsstrom. Bei einer
  abgelaufenen Log-Historie ist ein erneuter Seiten-Snapshot erforderlich.

## Ressourcen- und Zugriffsgrenzen

Standardwerte sind in `DEFAULT_LIMITS` definiert und werden pro Space im
Dokument gespeichert. Dazu gehören 64 KiB je Entry/Handback, 64 MiB
Entry-Felder insgesamt, 32 MiB Claims, 8 MiB Outbox, 128 MiB Gesamtdokument,
192 KiB Commit, 256 KiB Frame, 160 KiB Event und 4 MiB Revisionslog. Weitere
Owner-Quoten begrenzen Entries, Registrierungen, Waiter und Transaktionen. Mailboxes sind auf
8 MiB und höchstens 7 Tage begrenzt, Snapshot-Caches je Space auf 64 MiB/16 Tokens/60 s;
dauerhafte Folgeaufträge auf 16 MiB. Spätere Subscriptions aktualisieren Txn-Reservierungen;
Limits dürfen bestehende Abschlussverpflichtungen nicht unterschreiten.

Conversation-Clients besitzen ihre erstellten Transaktionen, Leases,
Registrierungen und Waiter. Host-Code ohne `as` ist administrativ; nur er kann
Limits ändern. Der Dienst leitet die Identität ausschließlich aus seinem
`IdentityAdapter` ab und prüft Methoden sowie erlaubte Entry-Typen per Policy.

## Nachweise

Die [AP-1-Abnahme](ap1-abnahme.md) beschreibt die neuen Regressionen, das persistente v4-Fixture,
Mailbox-TTL/ACK, Profile, begrenzte Wartung und den echten pi-serverd mit gebautem Bundle.

`npm test` deckt Core, Persistenz, Claims, Budgets, Stream, Dienst,
`RemoteSpace`, Socket, Szenario und TUI ab. Der Socket-Test enthält parallele
Aufrufe, verlorene Antworten, Host-Neustart und TCP auf Loopback. Das Testbed
führt zusätzlich das produktionsnahe Szenario `sieve-remote` über das
NetBird-Overlay aus. Details und die weiterhin offenen Sicherheits- und
Federation-Gates stehen im [Implementierungsplan](implementierungsplan-v3.md)
und in [testumgebung-big.md](testumgebung-big.md).

## Abgrenzung zu älteren Dokumenten

[spaces-v1.md](spaces-v1.md) beschreibt den lokalen Stand vom 2026-10-07 und
bleibt als historische Momentaufnahme erhalten. Seine offenen Punkte L2, L3,
L7 und L13 sind durch Revisionen/Changes, globale IDs, Byte-Budgets und
bytebegrenzte Seiten überholt. Historische v1/v2-Föderationspläne sind keine
Implementierungsvorgabe.

Die nutzbare API steht in [api.md](api.md).

## Mailboxes und Task-Abschluss

Remote-Events adressieren strukturierte Principals. ACK bestätigt ausschließlich einen bereits
ausgelieferten zusammenhängenden Präfix der passenden Epoche, keinen Task-Abschluss. Nach TTL-Verlust
meldet der Server Gap und neue Epoche; nicht bestätigte Take-Events führen zur dauerhaften Freigabe
der zugehörigen Transaktion. ACKed Takes behalten ihre separate Txn-Entscheidung. Abschlussprofile
prüfen vor Commit Ergebnis-Typ, Zuordnungsfelder und Anzahl; das Sieb setzt sie im benannten Space ein.

Pending-RPCs benötigen nach Reopen keinen alten Aufrufer: separate persistente Waiter halten die
Ausführungsdaten, Claims behalten Hash/Deadline/Ergebnisreservierung. `ResultExpired` wiederholt keine Wirkung.
`count`/`stats` und die mitgelieferte Revision stammen im Dienst aus demselben Snapshot.

## Phase 2

[Router und Simulator](ap2-router-und-simulator.md) sowie
[AP 2.2–2.5](ap2-delegation-routing-membership.md) sind implementiert:
RouterLease, Original-Principal-Delegation, persistente Policy, HRW-/Suchregeln,
journalisierte Federation-Operationen und Membership mit Core-Admission.
Die neuen APIs sind serverseitige Bausteine mit echtem Member-RPC-Adapter;
eine virtuelle öffentliche Space-Adresse wird dadurch nicht automatisch gestartet.
Prüfzahlen und gebaute Artefakte stehen in
[checks.json](../test/evidence/ap2-2026-10-11/checks.json).

AP 2.6/2.7 sind um Abschlussbudgets, auditierte lokale Admin-Bausteine,
Restore-Reconciliation und das geschützte Directory erweitert. Der Member-Lasttest
für AP 2.9 und die [Phase-2-Abnahme](ap2-abnahme.md) dokumentieren die Nachweise
und ihre Grenzen. Phase 2 ist mit der ausdrücklichen Ausnahme zu Block 4 abgeschlossen:
Die feste Journal-Aufteilung und das signierte Drei-Member-Sieb über NetBird
sind nachgewiesen. Die Overlay-Abbruchblöcke 1–3 sind inzwischen abgeschlossen,
einschließlich 26 gezielter Journal-Abbrüche unter voller Joblast. Alle acht technischen Abnahmeblöcke sind inzwischen abgeschlossen;
[Gate 4 und finale Betriebswerte](ap2-gate4.md) sind für das nachgewiesene Profil geschlossen; eine uneingeschränkte native Produktionsfreigabe wird nicht erklärt.
Block 5 besitzt den Live-Nachweis zwischen physischem lokalem Rechner und
Server einschließlich isoliertem Member-SIGKILL und gebundenem Lese-Replay. Block 4 ist auf ausdrückliche Entscheidung vom 2026-10-15
abgeschlossen; Block 8 besitzt den Live-Nachweis mit Root-Abbruch und Replay. Die vier Netzräume auf big
ersetzen keine unabhängigen physischen Ausfalldomänen.

`createConfiguredRoot` provisioniert einen nativen Hosted-Agent-Root gemeinsam
mit Control: getrennte aktive Router-/Host-Schlüssel, feste Member-Zieltupel,
unabhängige Boot-/Authority-Prüfungen, persistierte RouterLease und
MemberStatus-Probes. Administrative Membership- und Profilbefehle benötigen den
konfigurierten, aktuell autorisierten Supervisor-Administrator. Ein öffentlicher
virtueller Root-Space-Endpunkt ist dadurch nicht implementiert. Der eigene
Live-Aufbau und eine Fencing-Ablehnung sind geprüft. Block 4 wird gemäß
Auftraggeberentscheidung vom 2026-10-15 nicht erneut geöffnet; historische
native Negativmessungen werden nicht zu bestandenen Tests umgedeutet.

Die lokale batchweise Principal-Löschung und `RootHistoryErasure` besitzen
dauerhaften Fortschritt und Crash-Recovery. Letzteres löscht eigene sowie
betroffene fremde gecachte Parent-/Child-Inhalte, bewahrt gebundene IDs und
verweigert deren Effekt-Replay mit `ResultExpired`. Das ist auf beiden
Speicher-Backends getestet. `DistributedPrincipalErasure` koordiniert nun
fest gebundene Teilnehmer mit unabhängig gespeichertem Fortschritt: alle
Writer sperren, sämtliche Entry-Evidenz erfassen, lokal und in Root-Historien
löschen, Epochen installieren, Archive bereinigen, alle Floors versiegeln
und erst dann Boot-Berechtigungen freigeben. Neustarttests unterbrechen jede
Koordinator-Fortschrittsgrenze vor bzw. nach dauerhaftem CAS. Der Live-Lauf
mit fünf Teilnehmern besteht einschließlich Prozesswechsel vor der Root-
Löschung und originalem `ResultExpired`-Replay nach Neustart.

Unabhängige Lösch-Epochen sperren veraltete Restores und normale Dienste bei
unvollständiger Löschung. `ErasureArchiveController` verwaltet registrierte
Archive, Quarantäne, überprüfte Löschbelege und eine begrenzte Löschfrist.
Das SQLite-Register erzwingt monotone Lösch-Epochen und unveränderliche
Archivbindungen innerhalb seines CAS-Commits. Verspätete Archivregistrierung,
Rücksetzen von Quarantäne und Löschen von Katalogbelegen werden abgelehnt;
die Prüfung der Versiegelung liest den Archivkatalog in derselben Transaktion.
Die Tests prüfen echte Backup-Dateien und Wiederanlauf. `compactErasedSqlite`
konsolidiert ausschließlich sessionweite phi-spaces-Dokumente eines exklusiv
gesperrten SQLite-Stores (pi-durable-Schema 1), bewahrt aktuelle Werte, IDs,
Revisionen und Replay-Belege und entfernt alte Revisionen sowie freie Seiten
mittels Secure-Delete, Checkpoint und VACUUM. Der neue Test prüft den
tatsächlichen Wegfall alter Nutzdatenbytes und die anschließende Wiederöffnung.
Der bestandene Operatorlauf bindet eigene Backups an Hash und Space-Epoche,
prüft tatsächliche DB-/WAL-/SHM-Dateien und leere Archivverzeichnisse und
verweigert den Restore aller fünf alten Backups. Externe
Datenträger-/Provider-Snapshots benötigen weiterhin eigene registrierte
Löschregeln; SQLite-Bereinigung ist kein Nachweis sicheren Medienüberschreibens.

`ProfileTransitionController` friert ruhende Members ein, installiert eine
reine Profiländerung, veröffentlicht die nächste Policy und aktiviert Members
wieder. Unklare Antworten behalten den eingefrorenen Zustand und setzen mit
denselben IDs fort. Crash-/Wiederanlauftests bestehen auf beiden Backends;
der verteilte Live-Nachweis besteht seit 2026-10-15: derselbe Supervisor-
Command schloss nach Root-SIGKILL in `freezing` mit Policy-Version 5 ab,
alle drei Members waren anschließend aktiv. Dabei wurde der Start des
geschützten Control-Listeners vor wiederaufgenommenen Remote-Jobs korrigiert
und durch zwei persistente TCP-Tests abgesichert. RunGate und Replikation
folgen später.

Die Wire-Recovery-Prüfung vom 2026-10-13 ergänzt gezielt verlorene erfolgreiche
RPC-Antworten. Typisierte definitive Fehler bei der Claim-Auflösung führen
jetzt dauerhaft zu `needsReview` statt zu einer Endlosschleife von Transport-
Retries. Vor Annahme ausgefallene Requests benötigen weiterhin eine sichere
autoritative Negativauflösung; vorhandene Status-Delegationen verlangen einen
bereits gebundenen Claim. Details stehen in der [Phase-2-Abnahme](ap2-abnahme.md).

`resolveOperation` ergänzt jetzt die Admission-Auflösung für einen fehlenden
eigenen Claim in einer gültigen, auf dieselbe Primary-Epoche gebundenen
Generation. Der Router prüft alle Ziel-/Request-/Hash-Bindungen und wiederholt
ausschließlich denselben Child. Damit ist der Vor-Versand-RPC-Fall beim
unveränderten Primary schließbar. Bekannte Pending-Claims behalten ihre
Deadline- und Autorisierungsprüfung. Nach Promotion, Restore oder Ablauf
bleibt `needsReview`; terminale `NotCommitted`-Negativclaims mit vollständigem
Promotionsnachweis sind weiterhin ein eigener, nicht abgenommener Schritt.


Der NetBird-Volllastnachweis individueller Member-Prozessabbrüche vom
2026-10-13 schließt Testblock 2. Nach Abschluss von Block 3 umfasst die aktuelle Liste fünf offene
Testblöcke plus Gesamtfreigabe. Bei Transportverlust während der Child-
Vorbereitung bleibt ein bereits gespeicherter Parent jetzt als Pending mit
unverändertem Routingplan wiederaufnehmbar. Die Fehlerklassifikation wird auf
JSONL und SQLite geprüft; fachliche und Berechtigungsfehler bleiben definitive
Fehler. Details und Grenzen stehen in der [Phase-2-Abnahme](ap2-abnahme.md).


Testblock 3 ist seit 2026-10-14 abgenommen: 26 tatsächliche Root-SIGKILLs
vor/nach 13 erfolgreichen Journal-Übergängen über NetBird in fünf vollständigen
1.000-Job-/10.000-Entry-Läufen mit sechs aktiven Workern, jeweils mit Offline-
Audit. Die aktuelle Liste enthält fünf verbleibende Testblöcke. Die native
Root-Konfiguration ist verdrahtet und separat geprüft; ihre produktive
Live-Abnahme ist damit noch nicht erteilt.


Die Fehlerbehandlung unterscheidet außerdem vorläufig unbekannte Wirkungen von
expliziten Transaktions-/Abschlussverletzungen auf dem Wire. Letztere sperren den
Child und Parent dauerhaft zur Prüfung; Wiederanlauf löst keinen zusätzlichen
Effekt aus. Identische signierte Member-Policies werden nach geschützter Abfrage
und erneuter Authority-Prüfung ohne Mutations-Commit bestätigt. Die vollständige
Suite umfasst am 2026-10-14 **462 bestandene Tests**; die noch fehlenden Live-
Abnahmen bleiben davon getrennt.


## Gate 4 (2026-10-15)

Die [finalen Betriebswerte](ap2-gate4.md) sind durch vorhandene Volllastnachweise
und einen ergänzenden gebauten Server-Grenztest festgelegt: Frame 256 KiB, Commit
192 KiB, 32 Verbindungen je Peer / 64 je Listener, Peer-Erkennung 5 Sekunden,
Snapshot 60 Sekunden / 16 Tokens / 64 MiB und Generation eine Stunde. Der Gate
beginnt die Erkennung jetzt bei TCP-Annahme; stumme Verbindungen umgehen weder
Timeout noch Peer-Quota. Zwei neue Gate-Regressionsfälle und eine gebaute
5-Sekunden-Prüfung sichern das ab. Die Schicht-B-Challenge gilt separat 30 Sekunden.
Die Phase-2-Abschlussentscheidung bleibt ausdrücklich auf ihren dokumentierten
Umfang mit Ausnahme für Block 4 begrenzt; Phase 3 ist noch nicht abgenommen.


## Phase 3: erster Replikationsbaustein (2026-10-15)

[Entry-Replikation und weitere Schritte](ap3-replikation.md):
`EntryReplicationController` implementiert persistente Änderungs-IDs/HLC, LWW
mit versionierten Tombstones, Add-Wins-Tags, bytebegrenzte Änderungsseiten und
einen kleinen atomaren Snapshot-Merge auf eigenen Dokumenten. Elf gezielte
Prüfungen decken JSONL und SQLite einschließlich tatsächlicher Commit-Verluste ab.
Der Baustein ist noch nicht in den öffentlichen Space-Dienst, Policy, Boot-
und Löschbarrieren eingebunden; Primary/Standby und Promotion bleiben offen.
Die vorhandene Entry-Changes-API wird nicht als vollständige Primary-Commit-
Historie verwendet. Phase 3 besitzt noch keine Gesamtfreigabe.

Die Abschlussprüfung dieses Bausteins besteht aus 505 grünen Repository-Tests,
24 mobilen Tests sowie elf Fällen am gebauten isolierten Server-Artefakt.
[Nachweise](../test/evidence/ap3-entry-2026-10-15/README.md); keine produktive
Replikation wurde aktiviert.


## Gepagte Entry-Snapshots (2026-10-15)

Der [Snapshot-Transfer](ap3-snapshot-transfer.md) ergänzt AP 3.2 um dauerhaftes
Staging, Hashketten, gespeicherte Seiten-/Quell-Cursor und atomare Sichtbarkeit
durch Generationenverweise. Lokale Overlay-Writes und bestehende Changes-Cursor
bleiben erhalten; Dokumentversion 1 migriert auf Version 2. Zwölf neue Fälle
prüfen beide Backends einschließlich Commit-Verlust an Beginn, jeder Seite
und Abschluss. Öffentlicher Replikationstransport, Generationenpflege und die
produktive Rechte-/Boot-/Löschintegration bleiben offen.

Aktueller Snapshot-Nachweis: 517 Repository-Tests und 24 mobile Tests grün;
23 gebaute Serverfälle bestanden.
[Artefakt- und Quellbindung](../test/evidence/ap3-paged-2026-10-15/README.md).


## Fortlaufender Entry-Stream (2026-10-15)

[Quellgebundene Stream-Cursor und Pull-Worker](ap3-stream-transfer.md) sind
implementiert. Daten und Fortschritt werden im selben Commit gespeichert;
Snapshot-R kann aus einem geprüften veröffentlichten Beleg übernommen werden.
Konkurrenz, Wiederaufnahme, TCP-Ausfall und Abbruch besitzen gezielte Tests auf
JSONL und SQLite. Der Worker startet nur explizit und wird noch nicht als
öffentlicher NetBird-/Space-Dienst provisioniert. Generationenpflege und die
produktive Rechte-/Boot-/Löschintegration bleiben offen.


Aktueller Stream-Nachweis: 530 Repository-Tests und 24 mobile Tests grün;
36 gebaute Serverfälle bestanden. Daten und Cursor überstehen die geprüften
Commit-Verluste gemeinsam; TCP-Wiederanlauf und konkurrierende Worker sind geprüft.
[Artefakt- und Quellbindung](../test/evidence/ap3-stream-2026-10-15/README.md).
Generation-/Belegpflege, reale NetBird-Partition und produktive Einbindung bleiben offen.


## Snapshot-Pflege und synchroner Storage-Baustein (2026-10-15)

[Dauerhafte Generationenpflege](ap3-snapshot-maintenance.md) und
[vollständiger synchroner Storage-Pfad](ap3-primary-sync.md) sind implementiert.
Acht Wartungsfälle und 16 Sync-Fälle prüfen tatsächliche Commit-Verluste auf
JSONL und SQLite. Der Sync-Baustein gilt zunächst für einen dedizierten Store und
ist noch nicht in Policy, öffentlichen Claim-Status, Boot, Löschungen und
Primary-/Standby-Übergänge eingebunden. Phase 3 bleibt ausdrücklich offen.

## Replikatsteuerung (2026-10-16)

[Promotion, degradeToSingle und setStandby](ap3-replica-control.md) sind mit
Simulator-Adapter umgesetzt. Konfigurationswechsel sind Einträge der Sync-Kette,
Übergänge sind per ID journalisiert und nach Abstürzen fortsetzbar, Boot-Zustände
`fenced`/`quarantine` laufen per CAS über das unabhängige Register. Acht Fälle auf
JSONL und SQLite prüfen u. a. Abstürze vor dem Boot-CAS, Forks des alten Primary
und die Ablehnung von Simulator-Nachweisen. Die Abnahme bleibt durch F1/Gate 2
(realer Fencing-Adapter) blockiert; 3.6 ist nur teilweise umgesetzt.

Nachtrag 2026-10-16: Der netcup-Fencing-Adapter mit mTLS-Dienst auf vpsc und ein signierter Replikat-Transport
sind umgesetzt. Ein Fixture-Lauf über echte Hosts hat bestanden, mit nanoi als Primary und 100 als Standby
([Nachweis](../test/evidence/phase3-sync-2026-10-16/README.md)). Der Lauf umfasste:

- Fork ohne ACK;
- netcup-Power-off;
- Promotion, degradeToSingle und setStandby;
- am Ende identische Stände.

Offen bleiben die Einbindung in den produktiven Space-Dienst, `ReplicaConfigNotice`, das Pausieren aller
Schreibquellen und 3.8.

Nachtrag später am 2026-10-16:

- Schreibsperre während Übergängen, vollständiger Boot-Guard und `ReplicaConfigNotice` mit Übernahme im Router
  sind umgesetzt.
- primary/sync-Spaces laufen mit eigenem Store im Federation-Daemon, inklusive Quarantäne-Start.
- Ein echter Daemon-Lauf auf nanoi und 100 hat bestanden
  ([Nachweis](../test/evidence/phase3-daemon-sync-2026-10-16/README.md)): Fork ohne ACK, netcup-Fencing,
  promote, degrade, Quarantäne, setStandby, Schreibvorgänge in beide Richtungen, identische Stände.
- Offen: Router-Übernahme auf echten Hosts (host-a braucht das neue Bündel) und 3.8.

Nachtrag 2026-10-17 (3.8):

- Der Control-Store von host-a lief per Bootstrap auf primary/sync.
- Er durchlief zweimal setStandby → degradeToSingle mit dem Standby `control-standby-nano` auf nanoi und
  netcup-Fencing und endet wieder `single` ([Nachweis](../test/evidence/control-sync-hosta-2026-10-17/README.md)).
- Dabei wurde ein Fehler gefunden und behoben: Der Daemon endete nach SIGTERM nicht, wenn der Hauptstore im
  Sync-Betrieb lief.
- Offen: Promotion des Control-Replikats und Schritt 6.

Nachtrag 2026-10-17 (Router-Pfad echt):

- Ein nativer Root auf host-a hat einen replizierten Member auf nano-test und standby-100 per `addMember`
  aufgenommen und Schreibvorgänge dorthin geroutet.
- Nach Promotion mit netcup-Fencing und Degrade auf 100 hat er die `ReplicaConfigNotice` übernommen und weiter
  geroutet; danach alles zurückgesetzt ([Nachweis](../test/evidence/root-hosta-2026-10-17/README.md)).
- Dabei wurden zwei übersehene Stellen aus 3.8 gefunden und behoben: der Journal-Wächter des Roots und die
  Erneuerung der aufbewahrten Router-Lease verglichen noch die Epoche des Space-Dokuments.
- Der Testbed-Daemon hat dafür den sperrfreien Modus `enroll-key` für zusätzliche Schlüssel eines laufenden Hosts.

Nachtrag 2026-10-17 (Schritt 6):

- Control-Übergänge sind jetzt auch mit installierter Routing-Policy möglich. Der erste Start nach einem Übergang
  gleicht die Policy ab (Marker, `policyVersion`), bevor Grants, Router-Lease oder Root existieren.
- Die Router-Lease erneuert sich über einen Übergang mit gleichem Primary; der Root verteilt die `EpochNotice`.
- Echter Lauf auf host-a mit Root, Member und Policy: `setStandby`, `degrade` mit netcup-Fencing, Root-Neustart
  nach Ablauf der Lease, geroutete Schreibvorgänge danach; alles zurückgesetzt
  ([Nachweis](../test/evidence/step6-hosta-2026-10-17/README.md)).

Nachtrag 2026-10-17 (Promotion des Control-Replikats):

- Container-Fencing (`ContainerFencing` hinter dem mTLS-Fencing-Dienst) und der Wechsel des Control-Hosts unter
  gleicher Autorität (`ControlHostChange`, vom Recovery-Admin signiert, vom Register erst nach der Promotion
  aufgezeichnet, von den Hosts beim Start übernommen) sind umgesetzt.
- Echter Lauf auf big in beide Richtungen: host-a → host-c → host-a, die Members folgten jeweils
  ([Nachweis](../test/evidence/control-promotion-2026-10-17/README.md)).
- Dabei behoben: Berechtigungen der Geschwister-Spaces für das `setStandby`-Ziel, das Fencing-Ziel beim
  Fortsetzen einer Promotion und eine Sperrliste für Quelladressen im Fencing-Dienst.

Nachtrag 2026-10-17 (Router-Wechsel, 3.8 abgeschlossen):

- Ein neuer Router übernimmt das Root-Journal mit `takeover` erst nach Ablauf der vorigen Lease, mit höherer
  Router-Epoche; der Supervisor stellt einem anderen Router keine Lease aus, solange die vorige lebt.
- Hosts folgen einem Control-Wechsel im laufenden Betrieb (Prüfung alle 15 Sekunden, Neustart über Code 75).
- Echter Lauf mit Root und repliziertem Member in beide Richtungen
  ([Nachweis](../test/evidence/root-promotion-2026-10-17/README.md)); host-a danach zurückgesetzt.

Nachtrag 2026-10-17 (lww/set eingebunden):

- Merge-Typen laufen im `space`-Dienst über den Replikations-Baustein; der Root platziert sie nach Schlüssel bzw.
  Feldern und lehnt exklusive Operationen ab.
- Members replizieren ihre Änderungsströme über bewiesene, gepinnte Verbindungen.
- Die Löschung eines Principals ist eine replizierte Änderung mit Schwärzung; physisch entfernt die bestehende
  Offline-Kompaktierung die alten Revisionen.
- Echter Lauf mit nano-test und standby-100: Partition, Konvergenz, verteilte Löschung
  ([Nachweis](../test/evidence/merge-run-2026-10-17/README.md)).
- Kompaktierung (Schritt 4): stabile Stream-Positionen, Versionsvektoren der Members, Untergrenze je Ursprung;
  entfernt werden nur stabile, unsichtbare Ereignisse ([Regeln](ap3-replikation.md)). Periodisch im Daemon über
  `entryReplication.compactEveryMs`. Echter Lauf mit nano-test und standby-100
  ([Nachweis](../test/evidence/compaction-run-2026-10-17/README.md)).

Nachtrag 2026-10-17 (versiegelte Commits): Ein versiegelter, unbestätigter primary/sync-Commit ist öffentlich
`CommitSealed`; der Host klärt ihn mit dem Standby und bedient den Space ohne Neustart wieder
([Ablauf](ap3-primary-sync.md)). Nach einer Promotion beantwortet der Primary einen unbekannten Request älterer
Epoche mit Nachweis per Negativclaim mit `NotCommitted`.
Gesamtbetrieb 3.7 echt gelaufen: zehnminütige Partition, Prozessabbrüche, Failover mit `NotCommitted` und Rückweg
über den produktiven Dienst, jeder entschiedene Schreibvorgang genau einmal
([Nachweis](../test/evidence/phase3-partition-2026-10-17/README.md)). Gefunden und behoben: unbegrenztes Warten des
Primary auf den Standby (`requestTimeoutMs`).
`degradeToSingle` geht auch ohne Fencing-Adapter: Dann wird nur die Standby-Berechtigung dieses Space widerrufen,
der Host bleibt aktiv ([Ablauf](ap3-replica-control.md)).

Set-Lease-Erneuerungen erzeugen nun atomar neue Tags; Owner und Felder bleiben
gebunden, und alte Tags werden nach Ablauf der Erneuerung nicht wieder sichtbar.
Acht zusätzliche persistente Fälle prüfen Replay, Konkurrenz und Lease-Ablauf.


## Laufsteuerung: RunGate, RunController und Lauf-Recovery (2026-10-16)

Umgesetzt sind die Schritte B2–B5 der [Betriebserweiterung](betrieb-und-mobile-steuerung.md#8-umsetzungsstand-und-reihenfolge-der-betriebserweiterung):

- **RunGate im Core:** geschützter Steuerzustand je Lauf im Space-Dokument (kein Entry). Ein
  `CompletionProfile` mit `gateField` (Pflicht: endliches `maxLeaseMs`) macht Tasks nur bei `running` ohne Fence
  nehmbar, auch für wartende Takes und Host-Code; der Take bindet die Txn an die Revision. Pause/Stop installieren
  zuerst einen Fence und wechseln erst ohne gebundene Txn. Dieselbe Revision mit anderem Command ergibt
  `RunGateConflict`. Gesperrte Profile lassen sich unter aktivem Lauf weder lokal noch per Federation-Policy entfernen.
- **RunController** (`src/run-controller.ts`): Journal `pi-spaces.run-controller`, Start mit Vorbereitung hinter
  `preparing`, Pause/Resume/Stop mit ACK-Barriere, `pauseIncomplete` bei fehlenden ACKs, `advance` nach Neustart.
  Offene Übergänge tragen Control-Autorität und -Inkarnation und werden nach einem Wechsel nie erneut gesendet.
- **Remote-Members** (`src/run-member.ts`): signierte Anweisungen und ACKs, Methode `runGateInstruction` im Gate,
  nur registrierte Vorbereiter je Laufart; Admin-Commands `startRun`, `pauseRun`, `resumeRun`, `stopRun`,
  `reconcileRun`, `resolveRunRecovery`; serverseitige Fortsetzung über `control.runs` in `startFederationHost`.
- **Lauf-Recovery:** Recovery-Eintrittssperre je Gate, `RunRecoveryView`, Data-Restore importiert Gates des
  Snapshots als Evidenz (Restore-Stufe `gates`); `reconcile` bestätigt nur eindeutige paused/stopped-Lagen
  automatisch, sonst `needsReview`; `resolve` ist an den View-Hash gebunden und prüft jeden Member per
  Compare-and-Set.

Nachweise: `test/test-run-gate.test.ts`, `test/test-run-member.test.ts`, `test/test-run-recovery.test.ts` (31 Fälle, JSONL und
SQLite, Commit-Fehler, Controller-Neustart, verlorene ACKs, TCP über das zusammengesetzte Gate) und ein Lauf über
das echte NetBird-Overlay zwischen Operator-Host und einem Container auf big
([Nachweis](../test/evidence/run-gate-overlay-2026-10-15/README.md); Schicht A dort als Fixture-Pin).

Grenzen: Gate-Änderungen werden mit festen 1 KiB gegen die Budgets gerechnet, die Historie hält 32 Revisionen je
Lauf, `stopped`-Gates werden noch nicht in Laufhistorie überführt (höchstens 256 Gates je Space). Ein
Control-Restore (Wechsel der Control-Inkarnation) und ein Member unter Restore-Sperre starten `reconcile` beim
nächsten `advance` bzw. Befehl selbst; ohne Befehl oder offenen Übergang bemerkt der Controller einen Data-Restore
erst bei der nächsten Aktion. Die serverseitige Fortsetzungsschleife hat keinen eigenen automatischen Test.


## Worker-Steuerung (2026-10-16)

Schritt B6 der Betriebserweiterung: Der Control-Host hält den Soll-Zustand je Host im Journal
`pi-spaces.worker-assignments` (Admin-Command `setWorkers`, idempotent, monotone Generation). Ein Host holt über die
Gate-Methode `workerAssignments` nur seinen eigenen, signierten Anteil; maßgeblich ist der bewiesene aktive
Host-Schlüssel der Verbindung. Der `WorkerSupervisor` des Hosts nimmt nur gültig signierte, neuere Listen derselben
Control-Identität an, speichert sie und gleicht registrierte Workerarten ab: Skalieren, Stopp nach dem laufenden Task,
Neustart bei neuem Ziel, Ablehnung unbekannter Arten oder fremder Spaces, Backoff bis 5 s, wenn keine Arbeit nehmbar
ist. Nach einem Neustart laufen die gespeicherten Worker auch ohne erreichbaren Koordinator weiter. Der angewendete
Stand gelangt als `metrics.workers` über den vorhandenen Capability-Heartbeat zurück (`appliedWorkers`).

Nachweis: `test/test-workers.test.ts` (11 Fälle, JSONL/SQLite), darunter ein gesperrter Sieblauf, den zwei Worker nach
Pause und Resume vollständig rechnen, und die Gate-Methode über TCP. Grenzen: Worker laufen als asynchrone Schleifen
im Daemon-Prozess und bringen keine CPU-Parallelität; der periodische Heartbeat des Hosts wird noch nicht von
`startFederationHost` selbst gesendet.


## Space-Lebenszyklus (2026-10-16)

Schritt B7: `SpaceLifecycle` legt benannte Spaces idempotent an (vorhandener Alias wird unverändert
wiederverwendet), archiviert sie (lesbar, keine neue Arbeit), reaktiviert sie und löscht nur archivierte, leere
Spaces ohne Federation-Mitgliedschaft, offene Arbeit, aufbewahrte Claims, Mailbox-Ergebnisse oder ungestoppte Läufe.
Die spaceId bleibt als Grabstein in der Registry reserviert; `listSpaces`, `resolveSpaceId` und `snapshotSpace`
kennen gelöschte Spaces nicht mehr. Der Control-Host sendet signierte Anweisungen an den Ziel-Host
(`spaceLifecycleInstruction`); Admin-Commands `createSpace`, `archiveSpace`, `reactivateSpace`, `deleteSpace`.
Nachweis: `test/test-space-lifecycle.test.ts` (JSONL/SQLite, Neustart, TCP über das Gate, Supervisor-Command).


## Deployment-Bootstrap (2026-10-16)

Schritt B8: `validateDeployment` prüft eine deklarative Config (`schemaVersion: 1`, nur Aliase, keine Geheimnisse)
und liefert alle Fehler. Der `DeploymentController` des Koordinators hält die Alias→ID-Zuordnung, plant ohne
Wirkung und wendet idempotent an: Spaces über den Lebenszyklus (B7), Worker als Zuweisung mit Anzahl 0 (B6), Start
getrennt über `startWorkers`. Eine neue Config-Revision verwendet vorhandene Spaces und laufende Worker unverändert
weiter; Konflikte (Host-Wechsel eines Space, geänderte Definition laufender Worker, Space mit anderen Limits) werden
gemeldet statt angewendet. Das CLI `npm run bootstrap` prüft offline (`--check`) und sendet sonst Admin-Commands
über das Gate. Nicht enthalten: SSH-Provisionierung, NetBird-Beitritt, Erstinitialisierung und Pairing; sie bleiben
Voraussetzungen, die der Plan als `blocked` sichtbar macht. Nachweis: `test/test-deployment.test.ts` (JSONL/SQLite, zwei
Stores, Absturz und Wiederaufnahme, CLI als gepairter Admin über das echte Gate).


## Mobile Steuerung (2026-10-16)

Schritt B9 im Nachbarprojekt `pi-termux-mobile`: Die Seite **Spaces-Steuerung** zeigt Vorgänge, Läufe und Worker
und sendet Admin-Commands über die gepairte Control-Verbindung. Die Command-ID wird vor dem Senden im privaten
Profil gespeichert; Wiederholungen, Timeouts und Neustarts verwenden sie erneut, und ein unklarer Ausgang wird als
„Ausgang wird geprüft“ angezeigt. Neue lesende Admin-Commands auf dem Koordinator: `listRuns`, `runStatus`,
`listWorkers` (Soll-Zuweisungen und zuletzt gemeldeter Stand je Host). Nachweis: mobiler Test der Brücke und
Geräteabnahme auf dem Xiaomi gegen einen Koordinator in Produktionskomposition per WLAN, einschließlich Koordinator-Absturz und erneutem Senden derselben ID und über NetBird mit Peer-Identität aus der Management-API ([Nachweis](../test/evidence/b9-device-2026-10-16/README.md)); ein Koordinator auf big steht aus.


## Alarmierung, Audit und Plan-Vorschau (2026-10-16)

Schritt B10 (Teil): `collectAlerts` leitet Hinweise aus Läufen, Worker-Zuweisungen und Host-Berichten ab; ein
Hinweis ist kein Zustandsbeweis. `startAlertMonitor` meldet nur Änderungen, `webhookPublisher` stellt sie als Text
zu (z. B. ntfy). `auditLog` listet Admin-Results ohne Payloads. Laufbefehle mit `dryRun: true` liefern eine Vorschau
(zulässig, Grund, Revision), ohne etwas zu journalisieren. Admin-Commands `listAlerts`/`auditLog`; die mobile
Steuerseite zeigt Hinweise und Audit und stoppt nur nach einer Vorschau. Nachweis: `test/test-alerts.test.ts`,
Geräteprüfung. Offen: feinere Rollen und Zwei-Personen-Freigabe sowie die übrigen Vorschläge aus §7.5.


## Ergebnisexport und Zeitplan für Läufe (2026-10-16)

`RunController.export(runId)` liest mit einem registrierten Exporter je Laufart (z. B. `SIEVE_EXPORTER`) die
Ergebnisse aller Members und meldet Vollständigkeit, fehlende Teile, Manifest- und Ergebnis-Hash; ein Teilresultat
wird als solches ausgewiesen. `RunController.schedule` plant Pause oder Fortsetzung; die serverseitige Schleife gibt
sie zum Zeitpunkt als normales journalisiertes Command aus. Admin-Commands `exportRun`, `scheduleRun`; die mobile
Steuerseite hat dafür Bedienelemente sowie Formulare für Space-Lebenszyklus und Deployment-Plan/-Export.
Nachweis: `test/test-run-export.test.ts`. Die mobilen Dialoge (`confirm`/`prompt`) nutzen die Standarddialoge der
Android-WebView; auf dem Gerät sind sie nicht eigens geprüft.
