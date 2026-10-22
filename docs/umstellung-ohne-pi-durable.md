# Umstellung von phi-spaces auf eine eigenständige persistente Laufzeit

Stand: 2026-10-12. **Detaillierter Ziel- und Arbeitsplan; noch nicht implementiert.** U0 ist erhoben
(2026-10-22): [umstellung-u0-bestand.md](umstellung-u0-bestand.md), mit Lastprofil, vorgeschlagenen Grenzwerten und
offenen Entscheidungen. Die Messung dort macht die Teilablage großer Dokumente (Abschnitt 5.1) für U2 von Beginn an nötig.

**Stand U1 (2026-10-22):**

- **Eigener Kontext:** `src/context.ts` statt `@earendil-works/chord` (Entscheidung D1).
- **Eigene Speichertypen:** `src/store/types.ts` (`StoreHost`, `StoreTx`, `DocDef`, `DocWatch`) und
  `src/store/documents.ts` (`defineDoc`/`defineDocFamily`). `src` definiert damit alle Dokumente und nutzt nur noch
  diese Typen.
- **Übergangsadapter:** Eine pi-durable-Session erfüllt `StoreHost` strukturell. Die Dokumentdefinitionen tragen
  zusätzlich die Form, die pi-durable liest.
- **Ein Öffnungsort:** `src/store/legacy.ts` öffnet als einzige Stelle in `src` einen pi-durable-Host.
- **Agent-Teile getrennt:** Sie liegen in `src/agent.ts`; `src/with-agent.ts` gibt Space und Agent zusammen aus (für
  das Mobil-Bundle und pi-serverd).
- **Ergebnis:**
  - `src/index.ts` lädt ohne pi-durable und chord, geprüft mit einem Hook, der diese Importe sperrt.
  - Übrig sind nur Typen der Primary/Sync-Replikation (`LegacyStorage` in `replica-control`, `configured-runtime`,
    `sync-spaces`), dazu ein dynamischer Import in `primary-sync.ts`, der nur bei erschöpftem Sync-Budget lädt. Beides
    ist die dokumentierte Ausnahme bis U4.
  - `compactErasedSqlite` (Wartung des pi-durable-Formats) ist nicht mehr über `src/index.ts` exportiert.
- **Offen in U1:** Tests und Beispiele öffnen ihre Hosts noch direkt mit `Harness.open`. Sie wechseln auf eine
  gemeinsame Fixture, sobald es den eigenen Speicher gibt (U2/U3), damit sie gegen beide Speicher laufen können.

Ziel ist ein phi-spaces, das ohne Installation, Import oder laufenden Prozess von
`@earendil-works/pi-durable` langlebige Spaces bereitstellt. Schwerpunkt sind atomare
Speicherung, Wiederaufnahme nach Ausfällen und kontrollierte Übernahme vorhandener Daten.
Die bestehenden Space-, RPC- und Sicherheitssemantiken bleiben erhalten.

Der [Implementierungsstand](implementierungsstand.md) beschreibt weiterhin den aktuellen
Code. Der [Föderationsvertrag v3](federation-plan-v3.md), der
[Implementierungsplan v3](implementierungsplan-v3.md) und die
[Betriebsverträge](betrieb-und-mobile-steuerung.md) gelten fachlich weiter. Dieser Plan
ersetzt künftig deren Harness-/Storage-Anbindung, aber erklärt keine offene
Replikations-, Promotion- oder Betriebsabnahme für abgeschlossen. Änderungen an den
maßgeblichen Verträgen werden vor dem jeweiligen Implementierungsschritt eingearbeitet.

## 1. Ergebnis und Abgrenzung

Das Zielprodukt besitzt:

- einen eigenständigen `SpaceHost` mit transaktionalem Speicher, Snapshots, Watches,
  Wartung, Mailboxes und Wiederaufnahme persistenter Aufträge;
- einen persistenten SQLite-Speicher als ersten Produktionsbackend und einen
  ausdrücklich flüchtigen Memory-Backend ausschließlich für Tests;
- einen eigenständig startbaren Space-Dienst über die vorhandenen Unix-/TCP-Protokolle;
- unveränderte fachliche APIs von `PhiSpaces`, `SpaceService` und `RemoteSpace`, soweit
  sie nicht unmittelbar Harness-, Dokument- oder Task-Typen offenlegen;
- ein versioniertes Export-/Importverfahren für bestehende JSONL-/SQLite-Bestände;
- eine separat paketierte, optionale Agent-Anbindung. Nur diese darf weiterhin
  `pi-durable` benötigen. Der eigenständige Server muss ohne sie vollständig arbeiten.

Nicht Teil dieses Umbaus sind eine neue Agent-Engine, die Ablösung von NetBird,
Änderungen am Matching oder eine gleichzeitige SQL-Normalisierung sämtlicher Entries.
Die Entfernung von `pi-durable` aus der gesamten mobilen Agent-Anwendung wäre ein
separates Vorhaben: `runtime/common.mjs` verwendet es dort auch für Sessions,
Coding-Tools und Agent-Ausführung. Hier wird die Lebensdauer der Spaces davon entkoppelt.

## 2. Im aktuellen Checkout belegte Abhängigkeiten

Die Tabelle ist die Ausgangsliste für AP U0. Private Dokumentfamilien müssen ebenfalls
inventarisiert werden; ein Export nur öffentlich erreichbarer Space-Entries ist unvollständig.
Die Tabelle selbst ist manuell erhoben und daher nicht die maßgebliche Quelle: U0 leitet die
vollständige Liste aus dem tatsächlichen Importgraphen ab (jede Datei mit direktem oder
transitivem Import aus `@earendil-works/pi-durable`), statt sich auf diese Einstiegshilfe zu
verlassen.

| Bereich | Aktuelle Kopplung | Erforderlicher Ersatz |
|---|---|---|
| `src/core.ts`, Claims, Streams, Mailboxes | weitgehend reine Zustandsfunktionen, explizites `now` | Funktionen und Invarianten erhalten; sämtliche transitiven Imports prüfen |
| `src/doc.ts`, `src/spaces.ts` | `defineDoc`, `defineDocFamily`, Registry; Space-Dokumentversion 5 | eigene Dokumentdefinitionen, persistente Identitäten, Migrationen |
| `src/client.ts` | `SpaceHost = Pick<Session, "commit" \| "watchDoc" \| "snapshot">`, `Tx`, `Once` | eigene Host-/Transaktionstypen; gleichwertige Commit-Grenzen |
| `src/service.ts`, `src/enroll.ts`, `src/meter.ts` | Transaktions-Autorisierung, Session-/Harness-Typen | eigene Typen und Zugriffsverträge |
| `src/index.ts` | Tools, Task-Claim, Conversation-Zustellung, Reaper und öffentliche Exporte gemischt | unabhängiger Einstiegspunkt, Wartungsmodul, separater Agent-Adapter |
| `src/router.ts`, `src/federated-space.ts`, `src/federation-controller.ts`, `src/capability-directory.ts`, `src/rotation.ts` | Router-Journal, einzelne Router-Commands, Federation-Operations, Capability-/Member-Status-Verzeichnis und Schlüsselrotation, alle als `SpaceHost`-Konsumenten | persistente Mehrdokument-Transaktionen und Wiederaufnahme |
| `src/delegation.ts`, `src/federation-policy.ts` | Delegation-Epochen, Routing-Policy | unveränderte Bindungen und versionierte Datensätze |
| `src/membership.ts`, `src/data-admin.ts`, `src/supervisor.ts`, `src/member-transition.ts` | Member-Transitions (`member-transition.ts` importiert `Session` direkt), Membership-/Admin-/Supervisor-Journale | vollständige Übernahme einschließlich laufender Batches und Budgets |
| `src/runtime.ts` | Kompositionswurzel des persistenten Hosts (Gate → Enrollment → Control → Proof → Space); importiert `Harness` direkt aus `@earendil-works/pi-durable` | eigene Kompositionswurzel ohne Harness-Typ im Signaturgraphen |
| `src/control-ack.ts`, `src/recovery-controller.ts`, `src/control-recovery.ts` | Recovery-Receipts, Restore- und Release-Aufträge | wiederaufnehmbare, atomare Verwaltung mit Space-Änderungen |
| `src/boot.ts`, `src/recovery-only.ts`, konfigurierte Laufzeiten | Harness-Wrapping und privilegierte Recovery-Zugriffe | explizite bewachte Host-Zugänge und abgegrenzte Recovery-Capability |
| `src/pi-server.ts` | struktureller Dienstadapter | erhalten; eigenständige Space-Laufzeit dahinter einsetzen |
| Tests, Beispiele, Testbed, TUI-Inspector | Harness-Erzeugung, JSONL-/SQLite-Öffnen, Agent-Fixtures | Backend-neutrale Fixtures; unabhängige und Agent-Tests trennen |
| `scripts/bundle-mobile.mjs`, `package.json`, TypeScript-Konfiguration | gemeinsamer Einstiegspunkt und externe `@earendil-works/*`-Imports | getrennte Artefakte und tatsächlich unabhängiger Paketgraph |
| Nachbarprojekt `pi-termux-mobile/runtime/common.mjs` | Agent-Datenbank und Harness-Lebenszyklus | eigene Space-Datenbank und eigener Betriebslebenszyklus |

Zusätzlich zu Entries umfasst der Bestand unter anderem Leases, Reservierungen,
Transaktionen, Claims/Generationen, Waiter, Subscriptions, Outbox, Mailboxes/ACKs,
Fanout-/Release-Cursor, Abschlussprofile, Quoten, Snapshot-Token, Revisionshistorie,
Enrollment-/Schlüsselstatus, Recovery-Zustände und Routing-/Membership-Bindungen.
Dokumentarten, Familienschlüssel, Scopes und Schema-Versionen werden maschinenlesbar erfasst.

Aktuell verwendet der installierte JSONL-Adapter standardmäßig `fsync=false`, der
installierte SQLite-Adapter WAL mit `synchronous=NORMAL`. Das unabhängige
`SqliteRecoveryRegister` in `src/recovery-register.ts` setzt hingegen `FULL`.
Diese Feststellungen betreffen die gelesenen Implementierungen, nicht eine vollständige
Bestandsaufnahme aller laufenden Hosts und deren Konfiguration.

## 3. Garantien und Ausfallmodell

| Fehlerfall | Verbindliches Ziel | Grenze und erforderlicher Nachweis |
|---|---|---|
| Prozess beendet, `SIGKILL`, App-Prozess weg | jeder bestätigte Commit bleibt; Wiederaufnahme aus persistiertem Zustand | Kindprozess mit echter Datei und Neustart testen |
| Commit erfolgreich, Antwort verloren | gleicher Request erhält das gespeicherte Ergebnis, keine zweite Mutation | stabile Identität, Argumentbindung und Aufbewahrungsfristen |
| Stromausfall/Kernel-Absturz | bestätigte lokale Commits bleiben bei funktionierender Sync-/Hardware-Kette | FULL-Konfiguration plus gesonderte Systemausfalltests; `SIGKILL` genügt nicht |
| Voller Datenträger, I/O-Fehler | keine falsche Erfolgsantwort, keine halben Mehrdokument-Änderungen | Fehler vor/während/nach Commit getrennt injizieren |
| Datenträger oder Host verloren | Wiederherstellung aus unabhängigem Backup | Datenverlustfenster entspricht Backup-Alter; nicht automatisch RPO 0 |
| Netzwerkpartition/alter Primary | keine unberechtigten Writes oder stale Service-Antworten | bestehende Authority-/Boot-Regeln; echte Übernahme benötigt Fencing |
| Zweiter lokaler Serverprozess | zweiter Owner wird vor Dienststart abgewiesen | Betriebssystem-/DB-gestützte Sperre, keine bloße PID-Datei |
| Veraltetes oder beschädigtes Format | Start gesperrt oder expliziter Recovery-Modus | niemals stillschweigend einen leeren Ersatz-Space erzeugen |

RPO bezeichnet das tolerierte Datenverlustfenster, RTO die Wiederanlaufzeit. Für lokal
bestätigte Commits gilt als Ziel RPO 0 innerhalb des getesteten Ausfallmodells. Für
Backup-Restore werden Intervall, maximal akzeptiertes Alter und gemessene RTO vor
Betriebsfreigabe festgelegt. Automatische Verfügbarkeit bei Verlust des Hosts bleibt
an die gesonderte Replikations-/Fencing-Abnahme gebunden.

### 3.1 Unveränderliche Semantik

1. Space-Mutation, RPC-Claim/Ergebnis, Revision, Mailbox-Ereignis und Budgetbuchung
   werden zusammen festgeschrieben. Dasselbe gilt für gekoppelte Journal-Dokumente.
2. Speichertransaktion und fachliche Space-Transaktion sind verschieden: Eine
   langfristige Reservierung ist persistierter Zustand, keine offen gehaltene SQL-Transaktion.
3. `OutcomeUnknown` bleibt ein unbekanntes Ergebnis. Ein Timeout wird nicht zu einem
   Beweis, dass nichts passiert ist; Wiederholungen nutzen dieselbe Request-Identität.
4. `spaceId`, Inkarnation, lokale IDs/Zähler, Host-Schlüssel, Principal-Bindungen,
   Authority und Epochen werden bei verlustfreier Migration nicht neu erfunden.
5. Ein Retry-Schutz gilt nur innerhalb seines vereinbarten Generation-/Claim-Vertrags.
   Nach Ablauf wird explizit abgewiesen; ein abgelaufener Request wird nicht neu ausgeführt.
6. Externe Nebenwirkungen werden durch eine lokale SQL-Transaktion nicht automatisch exakt
   einmal ausgeführt. Dafür braucht der Empfänger Deduplizierung oder ein eigenes Abschlussprotokoll.
7. Epoch-Zähler allein sperren keinen früheren Primary. Recovery-Register,
   `authorityId`, unabhängige Boot-Erlaubnis, `needsReview`, `EmptyProof` und
   reservierte Abschlussverpflichtungen behalten ihre Bedeutung.
8. Langlebigkeit bedeutet keine automatische Unendlichkeit aller Leases. Der bisherige
   Standard von einer Stunde bleibt kompatibel; dauerhafte Entries verwenden `FOREVER`.
   Auch nach langer Offline-Zeit laufen abgelaufene Leases fachlich ab.

## 4. Zielarchitektur und Schnittstellen

Geplante Module; die Namen sind noch keine existierende API:

| Modul | Verantwortung |
|---|---|
| `src/store/types.ts`, `src/store/documents.ts` | eigene Dokumentdefinitionen, `StoreTx`, Versionen und Serialisierungsregeln |
| `src/store/sqlite.ts`, `src/store/memory.ts` | atomare Ablage, Isolation, Snapshots, Wiederöffnen |
| `src/host.ts` | `SpaceHost`, Commit-Queue, Owner-Schutz, Watches, Shutdown und Health |
| `src/maintenance.ts`, `src/delivery.ts` | Reaper, langlebige Aufträge, wiederholbare Zustellung |
| `src/daemon.ts` | Konfiguration, Standalone-Start und Signalbehandlung |
| `src/index.ts` | unabhängige öffentliche Exporte ohne Agent-Import |
| separates Adapterpaket | Tool-Definitionen, Conversation-Anbindung und Agent-Kompatibilität |
| separates Legacy-Migrationswerkzeug | altes Format lesen; kein Legacy-Import im Produktivserver |

Der eigene `SpaceHost` bietet `commit`, `snapshot`, `watchDoc`, `close` und einen
expliziten Gesundheits-/Bereitschaftsstatus. Die erste Fassung behält bewusst das
Dokumentmodell bei. Dadurch lassen sich reine Zustandslogik und vorhandene Tests
wiederverwenden. `Session`, `Harness`, `Tx`, `ConversationId` oder fremde Doc-Tokens
dürfen nicht in den unabhängigen öffentlichen Deklarationen verbleiben.

### 4.1 Commit-Vertrag

- Ein Host verarbeitet schreibende Commits in einer Queue. Ein Commit darf mehrere
  Dokumente atomar verändern. Dokumentzugriffe derselben Transaktion liefern denselben Draft.
- Ein Draft ist vom veröffentlichten Zustand isoliert. Abbruch, Callback-Fehler und
  Validierungsfehler verwerfen alle Änderungen. Mutationen nach Callback-Ende dürfen
  weder laufende noch spätere Commits beeinflussen; Ergebniswerte werden abgelöst.
- Reihenfolge: Admission/Boot-Prüfung, Transaktionsbeginn, Zustand laden, Callback,
  Schema-/Quoten-/Authority-Prüfung, persistieren, SQL-COMMIT, Cache-Publikation,
  Watch-Signal, Antwort. Sicherheitssensitive Leseantworten bleiben ebenfalls bewacht.
- SQL-COMMIT ist die lokale Entscheidungsgrenze. Ein Fehler danach wird nicht als
  sicherer Rollback gemeldet. Bei unklarem Storage-Zustand wird der Host gesperrt und
  aus dem Speicher rekonstruiert; ein veralteter RAM-Cache darf nicht weiterarbeiten.
- Abbruch vor Commit darf zurückrollen. Abbruch nach Commit hebt den Commit nicht auf.
  Callbacks werden nicht unsichtbar erneut ausgeführt; automatische Wiederholung
  könnte Zeitwerte, Zufallswerte und externe Effekte ändern.
- Keine externen schreibenden Effekte im Callback. Erforderliche asynchrone
  Autorisierungsprüfungen werden zeitlich begrenzt und mit den bestehenden Guards
  integriert. Verschachtelte Commits werden abgewiesen. Die serielle Commit-Queue
  schließt Deadlocks zwischen Commits desselben Hosts aus; getestet werden die
  verbleibenden Lock-Interaktionen außerhalb der Queue, etwa ein lang laufender
  Snapshot-Reader gegen den Storage-Writer oder ein host-übergreifender Recovery-/
  Boot-Aufruf, der auf den Abschluss eines lokalen Commits wartet.
- Registry/Space-Erzeugung, Router-Journal/Command sowie Recovery-/Membership-Updates
  erhalten nachweislich dieselbe Mehrdokument-Atomarität wie heute.

Die Boot-Prüfung kann kein atomarer verteilter Commit mit dem externen Register sein.
Ihre bisherigen Grenzen werden dokumentiert; die Umstellung darf daraus keine neue
Fencing-Garantie ableiten. Privilegierte Recovery-Zugriffe werden nicht als frei
verfügbarer ungeprüfter Host an Service-Code weitergegeben.

### 4.2 Watch- und Snapshot-Vertrag

Snapshots sind abgelöste, konsistente Werte; Mehrdokument-Inspektion nutzt einen
konsistenten Lese-Snapshot. Watches werden erst nach Commit ausgelöst. Die Verbindung
von Registrierung und initialer Zustandsprüfung schließt verlorene Wakeups aus.
Watches sind lokale Wecksignale, keine dauerhafte Ereigniszustellung. Bei Überlauf
folgt eine erneute Zustandsprüfung. Persistente Mailboxes, Claims und Cursor tragen
weiterhin die fachliche Zuverlässigkeit. Neustart scannt alle Spaces und offenen
Aufträge; die Korrektheit darf nicht von einem vor dem Absturz verpassten Signal abhängen.

## 5. Speicherentscheidung und Langzeitbetrieb

### 5.1 SQLite als erster Produktionsbackend

Geplant sind `node:sqlite`, WAL und `synchronous=FULL`, ohne neues npm-Paket.
Der SQLite-Speicher nutzt keine pi-durable-Dateien direkt. FULL synchronisiert im
WAL-Modus jeden Commit; NORMAL kann bestätigte Transaktionen bei Systemausfall verlieren.
Die tatsächliche Hardware-/Dateisystemkette bleibt Teil des Ausfallmodells.
Quelle: [SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous).

Beim Öffnen werden unterstützte Node-/SQLite-Version, PRAGMA-Werte, Schreibrechte,
Schema-Version und Owner-Schutz geprüft. Ein angefordertes persistentes Profil darf
nicht unbemerkt auf Memory oder schwächere Sync-Einstellungen zurückfallen.
Die konkreten unterstützten Node-Versionen werden auf Linux und Android/Termux
ermittelt und gepinnt; `node:sqlite` und die verwendeten Backup-Funktionen müssen dort
vorhanden sein. Referenz: [Node SQLite API](https://nodejs.org/api/sqlite.html).

Geplantes minimales Schema:

| Tabelle | Inhalt |
|---|---|
| `store_meta` | Formatversion, Store-ID, globaler Commit-Zähler, Migrations-/Aktivierungsstatus |
| `documents` | zusammengesetzter Schlüssel aus Namespace/Art/Familienschlüssel, Schema-Version, Dokumentrevision, JSON-Inhalt |
| `migration_runs` | Export-ID, Manifest-Hash, verifizierte Import-Fortschritte und Abschlussstatus |

Die vorhandenen fachlichen Journale bleiben zunächst Dokumente. Ein globaler
Storage-Commit-Zähler ist nicht die Space-Revision und kein Replikationsprotokoll.
Formatversion und Dokumentversion werden getrennt geführt. Mehrere bisherige
Harness-Sessions werden beim Import explizit auf Stores/Namespaces abgebildet;
Namenskonflikte dürfen nicht durch Zusammenlegen von `default` kaschiert werden.

Für die erste Ausbaustufe werden vollständige geänderte Dokumentwerte gespeichert.
Das vereinfacht die Korrektheitsprüfung, kann aber bei großen Space-Dokumenten hohe
Schreib- und Kopierkosten verursachen. Vor Produktionsfreigabe werden kleine Mutationen
an großen Dokumenten gemessen. Überschreitet dies das in U0 festgelegte Budget, ist
U2 um atomare Teilablage oder eine begrenzte Delta-/Checkpoint-Strategie zu erweitern.
Eine ungemessene Vollserialisierung von bis zu 128 MiB ist keine akzeptierte Lösung.

Gegenüber der Standardimplementierung von pi-durable ändert sich damit:

- Haltbarkeit: pi-durable setzt fest `synchronous=NORMAL`; im WAL-Modus wird dabei
  nur beim Checkpoint synchronisiert, bestätigte Commits können bei Systemausfall
  verloren gehen. Der installierte JSONL-Adapter läuft zudem standardmäßig mit
  `fsync=false`. Hier gilt `synchronous=FULL` als verbindliches Profil.
- Schema: pi-durable speichert ein agentenzentriertes Modell (`conversations`,
  `entries`, `tasks`, `submissions`, `documents` mit den Scopes `session`,
  `conversation`, `task`). Der eigene Speicher kennt nur `store_meta`, `documents`
  mit zusammengesetztem Namespace-/Art-/Familienschlüssel und `migration_runs`;
  Spaces sind keine Scopes unterhalb einer Session mehr.
- Revisionsablage: pi-durable hält Dokumente als Append-only-Kette aus `base`- und
  `delta`-Revisionen und setzt sie beim Lesen zusammen. Stufe 1 speichert
  vollständige Dokumentwerte; Teilablage bleibt dem Messgate in U2 vorbehalten.
- Dateiformat: keine Kompatibilität. Bestände werden über den versionierten
  Export/Import übernommen, nicht durch Lesen vorhandener pi-durable-Dateien.
- Betrieb: pi-durable öffnet mit festen PRAGMA-Werten und `busy_timeout`. Der eigene
  Store prüft beim Öffnen Versionen, PRAGMAs, Schreibrechte und Schema, verlangt
  einen eigenen Owner-Lock (5.2) und einen nachgewiesenen Backup-Pfad (5.3).

Gleich bleiben der Unterbau (`node:sqlite`/`DatabaseSync`, WAL, serialisierte
Operationsqueue, `BEGIN IMMEDIATE`-Transaktionen) und das Dokumentmodell selbst.

### 5.2 Owner, Dateien und Wartung

- Ein aktiver Owner pro Store, lokale Dateisysteme im freigegebenen Betriebsprofil.
  SQLite-Write-Locks allein verhindern keine zwei laufenden Reaper/Dispatcher.
- In U2 wird ein ohne neue Dependency realisierbarer Prozess-Lock nachgewiesen,
  etwa eine separate lokale SQLite-Lockdatei mit gehaltenem exklusivem Lock.
  Absturz muss ihn freigeben; Stale-PID-Löschen und automatisches Töten fremder
  Prozesse sind kein normaler Übernahmepfad. Die geprüften Plattformen werden benannt.
- Kontrolliertes Shutdown: Admission schließen, laufende Commits abschließen,
  Hintergrundarbeit stoppen, Watches schließen, Datenbank schließen, Owner freigeben.
  Korrektheit darf weder Checkpoint noch Shutdown voraussetzen.
- WAL-Größe, lange Reader, Checkpoint-Fortschritt, freier Speicher, Sync-Latenz,
  Queue-Länge, letzte erfolgreiche Sicherung und Wiederaufnahmefehler werden messbar.
- Wartung ist begrenzt und wiederaufnehmbar. Quoten und Abschlussreserven verhindern,
  dass volle Mailboxes oder neuer Verkehr bereits zugesagte Abschlüsse verdrängen.
- Unbekannte neuere Schema-Versionen sperren das Öffnen. Unterstützte ältere Versionen
  migrieren mit Sicherung und atomarem Abschluss. Kein stiller Format-Downgrade.

### 5.3 Backups und Restore

Backups müssen einen konsistenten Zustand erfassen; das Kopieren nur der geöffneten
Hauptdatei ist kein freigegebener WAL-Backup-Pfad. Geplant ist die verfügbare
SQLite-/Node-Backup-API, andernfalls eine nachgewiesene Offline-Sicherung.
Quelle: [SQLite Backup API](https://www.sqlite.org/backup.html).

Jede Sicherung erhält Formatversion, Store-ID, Commit-Stand, Zeit, Größen und Prüfsummen.
Export/Backup werden zunächst temporär geschrieben, geprüft, synchronisiert und erst
anschließend einschließlich Verzeichniseintrag dauerhaft veröffentlicht. Sicherungen
liegen zusätzlich auf einem unabhängigen Medium/Host, mit privatem Zugriff; enthaltene
Host-Schlüssel und Enrollment-Daten werden nicht in Logs ausgegeben.

Ein Restore-Test öffnet die Sicherung isoliert und prüft Integrität, Beziehungen,
Counts und ausgewählte Operationsverläufe. Die isolierte Kopie darf nicht als alter
Primary online gehen. Ein veraltetes Backup durchläuft den vorhandenen Restore-Vertrag
mit neuer Dateninkarnation, Authority-/Boot-Abgleich und gegebenenfalls `needsReview`.
Externes Recovery-Register und lokale Boot-Installation werden nicht aus dem
Space-Backup blind zurückgesetzt. Keine automatische Reparatur durch Löschen der WAL.

## 6. Hintergrundarbeit und Agent-Integration

Reaper, Fanout, Releases, Pending-Requests und Supervisor-/Router-/Recovery-Jobs werden
vom Space-Host gestartet und aus persistentem Zustand rekonstruiert. Sie dürfen nicht
von einer offenen Conversation, einem UI-Poll oder einem laufenden Agent abhängen.

`deliverEvents` verwendet heute numerische Conversation-IDs und `conversation.submit`.
Der neue Host benötigt einen expliziten Zustelladapter mit stabiler Consumer-Identität,
Event-ID, ACK und Wiederholungssemantik. Zulässig ist wiederholte Zustellung mit
Deduplizierung am Empfänger. Ein fehlender Adapter bedeutet zunächst „nicht verbunden“
und darf nicht automatisch alle Ereignisse löschen oder alle Reservierungen freigeben.
Endgültig entfernte Consumer, abgelaufene Leases und terminale Zustellfehler benötigen
explizite, getestete Release-Regeln; endlose Reservierungen werden vermieden.

Der bisherige task-scoped `phi-spaces.claim` aus `src/index.ts` wird nicht als neue
Agent-Engine nachgebaut. Der optionale Adapter bildet stabile Tool-Aufruf-IDs auf
Space-Request-Identitäten ab. Die Zuordnung wird vor dem ersten Aufruf im Agent-System
persistiert; Space-Mutation und Ergebnis liegen im Space-Store atomar zusammen.
Nach einem Agent-Absturz wird dieselbe Zuordnung wiederverwendet. Request-Fristen
müssen zur erlaubten Replay-Dauer passen; abgelaufene Aufrufe werden nicht neu erfunden.

**Kompatibilitätsgrenze:** Ein bisheriges `Once`-Hook, das beliebige Agent-Dokumente und
Space-State im selben Harness-Commit ändert, ist über zwei Datenbanken nicht mehr atomar.
Die unabhängige `Once`-Variante darf nur eigene Store-Dokumente berühren. Übergreifende
Abläufe werden auf persistente Requests/Outbox umgestellt oder ausdrücklich als
API-Bruch abgewiesen. Weder Adapter noch Dokumentation dürfen alte Atomarität vortäuschen.
Offene Legacy-Tool-Aufrufe werden vor dem Cutover beendet oder mit nachgewiesener
Identitätszuordnung migriert; unbekannte Zuordnungen blockieren die Migration.

## 7. Bestehende Daten sicher migrieren

### 7.1 Exportformat

Ein separates, versionsgebundenes Legacy-Werkzeug liest JSONL und SQLite mit den
passenden alten Bibliotheken. Es arbeitet auf einer konsistenten Sicherung des
angehaltenen Bestands; das Öffnen durch den alten Harness darf keine Agent-Tasks,
Wartung oder externen Effekte auf dem Original auslösen. Ein reiner Leser oder ein
isolierter Replay-Pfad ist in U5 nachzuweisen.

Das Manifest enthält Exportformat, Quell-Backend/-Version, Session-/Namespace-Zuordnung,
Dokumentarten und -versionen, alle Familienschlüssel, Identitäten, Commit-Bezug,
Anzahlen, Bytegrößen und Prüfsummen. Ein Payload übernimmt den gesamten fachlichen
Zustand einschließlich privater Journale. Unbekannte Dokumentarten werden klassifiziert;
unbekannter Space-bezogener Zustand sperrt den Import statt still verworfen zu werden.
Reine Agent-Historien bleiben in der Agent-Datenbank. Task-Claims und Consumer-Bindungen
werden nach Abschnitt 6 gesondert behandelt.

Der Importer validiert Schema, Referenzen, IDs/Zähler, Budgets und Checksummen und
schreibt in einen neuen, noch nicht aktivierbaren Zielstore. Große Importe erfolgen
in begrenzten Batches; Export-ID und Manifest-Hash binden jeden Wiederanlauf an exakt
dieselbe Quelle. `ready` wird erst nach vollständiger Prüfung atomar gesetzt.
Ein Teilimport darf nie öffentlich geöffnet werden.

### 7.2 Cutover mit Schreibpause

1. **Inventur und Probe:** alle Stores/Sessions, Formate, Rollen und Agent-Bindungen
   erfassen; Import auf Kopien und Dauer der Schreibpause messen.
2. **Admission schließen:** neue Mutationen stoppen, Inflight-Ergebnisse klären,
   Hintergrundschreiber und Agent-Tool-Aufrufe anhalten. Fachliche langlebige
   Transaktionen/Waiter dürfen bestehen bleiben, sofern vollständig migriert.
3. **Quelle stilllegen:** alle Writer stoppen und Owner sichern. Quell-Sicherung und
   Manifest erstellen. Alte Startkonfiguration gegen unbeabsichtigten Neustart sperren.
4. **Import und Prüfung:** neuen Store erstellen, vollständige Zustände vergleichen,
   private Journale und Referenzen prüfen. Keine zweite fachliche Ausführung zur
   „Validierung“ auf dem später aktivierten Store; Probeläufe verwenden Wegwerfkopien.
5. **Authority prüfen:** bei verlustfreiem Formatwechsel auf demselben Host bleiben
   Identitäten/Inkarnation erhalten. Rollenwechsel, älterer Snapshot oder Hostwechsel
   benötigen das bestehende Recovery-/Fencing-Verfahren, keine bloße Pfadänderung.
6. **Aktivieren:** exklusiven Owner und Boot-Erlaubnis prüfen, Konfiguration atomar
   auf den neuen Store umstellen, zunächst kontrollierte Lese-/Health-Prüfung,
   danach Schreibadmission und Hintergrundarbeit öffnen.
7. **Nachkontrolle:** identische Requests wiederholen, Pending-Abschlüsse, Mailbox-ACKs,
   Restart und Langzeit-Leases prüfen; Monitoring und Backup des neuen Formats aktivieren.

Keine Dual-Writes auf alten und neuen Store: ohne gemeinsame Transaktion könnten zwei
abweichende Wahrheiten entstehen. Die Uhr läuft während der Schreibpause weiter;
Leases/Grants werden weder verlängert noch auf den Exportzeitpunkt zurückgesetzt.
Überfällige Arbeit wird vor normaler Bereitschaft begrenzt aufgearbeitet.

### 7.3 Rückweg

Vor dem ersten neuen fachlichen Commit kann der neue Store verworfen und die
unveränderte Quelle nach Owner-/Authority-Prüfung wieder aktiviert werden. Auch
Hintergrundmutationen zählen als neue Commits.

Nach ersten neuen Commits ist ein Zurückschalten auf die alte Sicherung **kein**
verlustfreier Rollback. Der freigegebene Standardweg ist Fehlerbehebung auf dem neuen
Format oder dessen Recovery. Ein späterer Reverse-Exporter wäre ein eigenes,
vollständig getestetes Migrationspaket. Ein Restore mit akzeptiertem Datenverlust
braucht eine ausdrückliche Betreiberentscheidung und den Recovery-Vertrag.

## 8. Arbeitspakete und Reihenfolge

Alle Pakete sind **geplant/offen**. Größen S/M/L sind relative Aufwände, keine Termine.
Ein Paket gilt erst mit Artefakt, Abnahmekriterien und reproduzierbarem Nachweis als fertig.

| AP | Voraussetzung / Größe | Konkrete Arbeiten | Abschlusskriterium |
|---|---|---|---|
| **U0 – Inventur und Verträge** | Start / M | vollständigen Import-/Typgraphen und Dokumentkatalog erstellen; aktuellen Git-Stand und lokale Änderungen festhalten; bestehende Tests als Baseline ausführen; Fehler/Skips getrennt erfassen; unterstützte Plattformen sowie p95-/p99-, Speicher-, Startup-, RPO-/RTO-Budgets festlegen | jeder persistente Datentyp und jede Harness-Funktion hat Zielzuordnung; Betriebsprofil und Messgrenzen dokumentiert |
| **U1 – Eigene Host-Grenze** | U0 / M | eigene Doc-/Tx-/Host-Typen definieren; zunächst Legacy-Adapter für vergleichende Tests; `index.ts` von Tools trennen; Reaper/Delivery auslagern; privilegierte Recovery-Zugriffe explizit machen | Kern- und Host-Vertragstests unverändert fachlich erfolgreich; unabhängiger Importgraph enthält keine Durable-Typen |
| **U2 – SQLite-Store** | U1 / L | Schema, Queue, Draft-Isolation, atomare Mehrdokument-Commits, FULL, Owner-Schutz, Watch-Rennen, Fehlerklassifikation und Formatmigration implementieren; Memory-Backend ergänzen; Lastprobe großer Dokumente | neue Conformance- und echte Crash-Tests bestanden; Isolation und Sync-Profil nachgewiesen; festgelegte Lastgrenzen eingehalten |
| **U3 – Lokaler eigenständiger Dienst** | U2 / L | `PhiSpaces`, Registry, Service, Meter, Reaper, Mailboxes, Fanout/Release und Standalone-Start portieren; Request-Replay/Deadline-Wiederaufnahme; `SpaceLike` und RPC prüfen | Sieb/Cache ohne Modell und ohne installiertes pi-durable über Unix/TCP; Restart erhält Pending-Operationen und Ergebnisse |
| **U4 – Federation und Recovery** | U3 / L | Router, Delegation, Policy, Membership, Admin-Batches, Supervisor, Control-ACK und Restore-Journale portieren; Boot-/Read-Guards und Recovery-Capability prüfen | relevante AP1b-/AP2-/Simulator-Fälle auf neuem Store bestanden; Fencing-/Restore-Garantien nicht abgeschwächt |
| **U5 – Export/Import** | U0, U2; Endabnahme nach U4 / L | versionsgebundenen Legacy-Leser, Manifest, Session-Zuordnung, privaten Dokumentexport, wiederaufnehmbaren Import, Report, Probe-Cutover und Rollback-Grenzen implementieren | JSONL und SQLite inklusive laufender Jobs vollständig migriert; Teilimport gesperrt; Restart/Retry nach Import korrekt |
| **U6 – Adapter, Mobile und Werkzeuge** | U3, U4, U5 / L | separates Agent-Paket und Tool-Identitäten; mobile Space-Datenbank/Lebenszyklus; pi-server-Anbindung; Beispiele, TUI, Inspector, Testbed und Bundles umstellen | Space-Dienst überlebt Agent-Neustart; alte Clients kompatibel; native/mobile Abnahme mit gebauten Artefakten; Legacy-Tasks kontrolliert behandelt |
| **U7 – Betriebsabnahme** | U4–U6 / L | unabhängige Backups/Restore, I/O-/Kapazitätsfehler, Systemausfälle, Dauerlast und Plattformtests; Migrationsprobe mit realistischen Größen | Matrix aus Abschnitt 9 vollständig mit Nachweisen; keine offenen kritischen Fehler; RPO/RTO im freigegebenen Profil belegt |
| **U8 – Paket-Cutover und Bereinigung** | U7 / M | `pi-durable` aus Hauptpaket, Lockfile, Types und Runtime-Graph entfernen; alte Testpfade in separates Legacy-/Adapter-Paket verlagern; README/API/Betriebsverträge aktualisieren | saubere Offline-Installation aus vorbereiteten Artefakten startet unabhängig; komplette Pflichtsuite und Import-/Bundle-Prüfung erfolgreich |

Die Pakete schließen in dieser Reihenfolge ab: U0 vor U1 vor U2 vor U3 vor U4 vor U6 vor U7 vor U8.
U5 ist davon ausdrücklich ausgenommen: Exportentwurf und Legacy-Leser dürfen parallel zu U3/U4
beginnen, sobald U0 und U2 abgeschlossen sind (siehe Voraussetzungsspalte oben); Endabnahme und
Freigabe von U5 für den produktiven Cutover setzen dagegen U4 und den vollständigen
Ziel-Dokumentkatalog voraus und liegen damit zeitlich nach U4. Kein Paket darf durch den Hinweis
auf eine spätere Phase zentrale Atomaritäts- oder Recovery-Verpflichtungen offenlassen.

## 9. Prüf- und Abnahmematrix

| Prüfung | Aufbau | Erfolgskriterium |
|---|---|---|
| Semantikvergleich | gleiche deterministische Operationsfolgen gegen Legacy- und neuen Host, gleiche Zeit/IDs | gleiche Ergebnisse, Fehler und fachliche Zustände |
| Mehrdokument-Atomarität | Registry+Space, Claim+Mutation, Router-Index+Command; Abbruch an jeder Grenze | ausschließlich alter oder vollständig neuer Zustand |
| Isolierte Drafts | mutierte Rückgabewerte, späte Async-Arbeit, Callback-Fehler | keine Mutation außerhalb des autorisierten Commits |
| Konkurrenz | parallele Takes/Writes, Snapshots während Commit, zweiter Owner | keine doppelte Entnahme, konsistente Reads, zweiter Dienst gesperrt |
| Commit/Antwort-Lücke | Kindprozess nach DB-COMMIT vor Antwort beenden | Retry liefert ursprüngliches Ergebnis, keine zweite Mutation |
| Echte Prozessabbrüche | Kindprozess vor/während/nach Commit und Checkpoint beenden | bestätigte Operationen erhalten; unbestätigte anhand Request klärbar |
| Systemausfall | eigene VM/Testgerät hart zurücksetzen, ACK-Liste extern führen | alle vorher extern beobachteten ACKs nach Restart vorhanden |
| Storage-Fehler | voller Datenträger, Read-only, I/O-/Sync-Fehler | keine falschen ACKs; kein Dienstbetrieb mit unklarem Cache |
| Lange Lebensdauer | `FOREVER`, endliche Leases, offline über Deadline, Uhrsprünge | dauerhafte Entries bleiben, abgelaufene Arbeit korrekt abgewickelt |
| Watches/Pending | Commit im Registrierungsfenster, Signalüberlauf, Disconnect, Restart | kein verlorener Abschluss; Timeout/Cancel- und Poll-Semantik erhalten |
| Hintergrundarbeit | Crash zwischen Fanout-/Release-/Admin-Batches | Cursor, Budgets und Reservierungen konsistent fortgesetzt |
| Agent-Brücke | Space antwortet, Agent stürzt vor Ergebnisjournal ab; Empfänger-ACK verloren | identischer Tool-Request/Event, keine zweite Space-Mutation |
| Migration | beide Legacy-Backends, mehrere Sessions, private Familien, offene Txns/Claims/Jobs | Manifest vollständig; Identitäten/Referenzen erhalten; unbekannter Zustand blockiert |
| Versionswechsel | ältere Fixtures, aktuelle Version, unbekannte Zukunftsversion, abgebrochene Migration | atomare Migration oder klar gesperrter Start |
| Recovery/Fencing | alter Snapshot, veraltete Authority, Register nicht erreichbar, alter Primary | keine Freigabe durch bloßen Neustart/Import; bestehende Sperren greifen |
| Backup | unter Last sichern, isoliert wiederherstellen, Checksummen manipulieren | konsistente gültige Sicherung; Fehler erkannt; keine stille Datenneuanlage |
| Kapazität/Dauerlauf | 1/10/100 Spaces, 10 000 Entries im Space, Dokument-/Mailbox-/Claim-Grenzen | U0-Budgets eingehalten; WAL/Queues/Heaps wachsen nicht unkontrolliert |
| Paket-Unabhängigkeit | Hauptpaket mit vorbereiteten Abhängigkeiten ohne pi-durable öffnen; Deklarationen und Bundlegraph prüfen | Core, lokaler Host und Remote-Dienst vollständig nutzbar |
| Geräte-/Dienstintegration | gebauter pi-server-Adapter, Android/Termux, Hintergrund/Doze und Prozessneustart | dokumentierte mobile Grenzen; Agent-Ausfall beendet keine Space-Persistenz |

Die bisherigen Helfer in `test/support/persistent.ts` simulieren mit `crash(h)` ein
Abandon/Reopen im selben Prozess und injizieren Storage-Fehler. Das bleibt nützlich,
ersetzt aber keine Kindprozess- oder Stromausfallprüfung. Neue Nachweise werden mit
Commit-ID, Laufzeitversion, Storage-Profil, Befehlen und Logs unter `test/evidence/`
ablegt. Skips zählen nicht als bestandene Geräte-/Dienstabnahme.

Nach jedem Änderungspaket: `npm run typecheck` und `npm test`. Zusätzlich werden
`npm run test:examples`, die unabhängige Host-Suite, Migrationssuite und
`npm run test:pi-server` entsprechend dem Paket ausgeführt. Vor nativer Abnahme wird
das geprüfte Artefakt gebaut; Bundle-Synchronisierung in das Nachbarprojekt erfolgt
bewusst mit passendem `PHI_SPACES_MOBILE_ROOT`. Keine Abhängigkeiten automatisch installieren.
Remote-Testbed zunächst mit `--dry-run`; der erste echte Versand/Containerstart auf
`big` und kostenpflichtige Live-Modelltests benötigen die vorgesehene Freigabe.

## 10. Kompatibilität, Risiken und Freigabeentscheidungen

| Thema | Planentscheidung / verbleibendes Gate |
|---|---|
| RPC und `SpaceLike` | beibehalten; alte Remote-Clients gegen neuen Dienst testen; Fehlercodes/Claim-Fristen unverändert |
| Direkte Harness-/Doc-/`Once`-Nutzer | gezielte API-Migration mit Beispielen; keine versteckten Alias-Typen auf pi-durable |
| Neuer Speicher | SQLite/FULL vorgesehen; Linux-/Termux-Versionen und Owner-Lock müssen U2 bestehen |
| Große Dokumente | Vollwerte zunächst einfacher; Lastgate kann vor Freigabe Teilablage erzwingen |
| Quellformate | tatsächlich eingesetzte Legacy-Versionen inventarisieren und pinnen; unbekannte Versionen ablehnen |
| Stillstandszeit | Offline-Cutover vorgesehen; tolerierte Pause anhand U5-Probe vor Betrieb festlegen |
| Backup-Alter / Wiederanlauf | Betreiberprofil in U0 festlegen und in U7 messen; keine frei erfundene Verfügbarkeitszusage |
| Lokale Haltbarkeit vs. HA | unabhängiger Host ist lokal dauerhaft; Replikation/Promotion bleiben eigener Vertrag |
| Modell-/Agent-Funktionen | separat und optional; bestehende Agent-App darf pi-durable weiterhin verwenden |
| Neue Dependencies | keine geplant; falls Plattform-/Lock-/Backup-Nachweis sie erfordert, Entscheidung vor Einführung |

Die Freigabe einer eigenständigen Version setzt U0–U8 voraus. Eine zunächst lokale
Testversion darf früher bereitstehen, wird aber ausdrücklich als solche markiert.
Vor jeder Produktionsumstellung liegen ein konkreter Migrationsreport, eine geprüfte
Sicherung, gemessene Stillstandszeit und ein benannter Rückweg vor.

## 11. Dokumente und Liefergegenstände

Im Zuge der Umsetzung werden `README.md`, `AGENTS.md`, `docs/api.md`,
`docs/implementierungsstand.md`, `docs/implementierungsplan-v3.md`,
`docs/federation-plan-v3.md`, `docs/betrieb-und-mobile-steuerung.md`,
`docs/abnahme/ap1b-betrieb.md`, Testbed-/TUI-Anleitungen und Beispielverträge angepasst.
Historische Dokumente bleiben historische Nachweise und werden nicht rückwirkend
auf den neuen Speicher umgeschrieben. Die mobile Integration erhält eigene
Migrations-/Betriebsanweisungen im Nachbarprojekt.

Liefergegenstände sind: unabhängiges Paket samt Typen, eigenständiger Dienst,
SQLite-Store, optionales Agent-Paket, Legacy-Exporter/Importer, Migrationsreport,
Backup-/Restore-Werkzeuge, wiederholbare Crash-/Ausfalltests sowie ein Abnahmebericht
mit ausdrücklich benannten Grenzen. Bis dahin beschreibt dieses Dokument ausschließlich
die geplante Umstellung.
