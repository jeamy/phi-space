# phi-spaces und pi-durable: Gemeinsamkeiten und Unterschiede

Stand: **31. Oktober 2026**. Vergleich des aktuellen TypeScript-Codes von phi-spaces mit
**`@earendil-works/pi-durable` 1.4.0**, der zum Recherchezeitpunkt neuesten npm-Veröffentlichung.
Der neuere, **unveröffentlichte** Earendil-Entwicklungsstand wird in Abschnitt 8 gesondert behandelt.

Das [Upgrade auf 1.4.0](../upgrade-pi-1.4.0.en.md) ist ausgeführt: Agentenpaket, Codemode und mobile Runtime laufen auf
1.4.0. Abschnitt 7 hält fest, was sich dafür ändern musste; Abschnitt 9 beschreibt die Recherche-, Codemode- und NPC-Ausbauschritte.

## 1. Kurzfassung und Vergleichsgrundlage

**phi-spaces und pi-durable sind keine gleichartigen Alternativen.**

- **pi-durable** ist eine persistente Agentenlaufzeit: Conversations, Modellantworten, Werkzeugaufrufe,
  Task-Zustandsmaschinen und anwendungseigene Dokumente werden gespeichert und nach Neustarts fortgesetzt.
- **phi-spaces** ist ein persistenter Koordinations- und Datendienst nach dem Tuple-Space-Prinzip:
  unabhängige Prozesse oder Agenten tauschen typisierte Entries aus, suchen per Template und übernehmen Arbeit
  mit `take`, Transaktionen und Leases.
- Beide brauchen atomare Zustandsänderungen, Wiederanlauf, stabile Identitäten und Beobachtbarkeit.
  Sie wenden diese Mechanismen aber auf unterschiedliche Gegenstände an.
- Der heutige Space-Kern benötigt **weder pi-durable noch Chord oder pi-ai**. Das separate Paket `agent/`
  verbindet ihn mit pi-durable. Die frühere Beschreibung als reine pi-durable-Erweiterung ist für den Kern überholt.
- Zusammen passen sie gut: **pi-durable führt einen Agenten aus; phi-spaces koordiniert dessen Zusammenarbeit
  mit anderen Teilnehmern.** Keines der beiden ersetzt automatisch die Garantien des anderen.

### Versionsstand

| Gegenstand | Tatsächlich geprüfter Stand | Bedeutung |
|---|---|---|
| phi-spaces | Paketversion `0.0.1`, Stand 30.10.2026 | Maßstab ist der gelesene TypeScript-Code, nicht nur ältere Architekturdokumentation |
| Lokale Agentenanbindung | `agent/package.json` und Lockfile: pi-durable, Chord und pi-ai jeweils exakt `1.4.0` (ausgehend von `1.0.3`) | Ausnahme mobile Runtime: pi-client, pi-server und pi-protocol bleiben auf `1.1.0`, siehe [Upgrade](../upgrade-pi-1.4.0.en.md) |
| Neueste veröffentlichte pi-durable-Version | npm-Tag `latest`: **`1.4.0`**, veröffentlicht am **21.10.2026, 22:44:09 UTC** | Hauptvergleich dieses Dokuments |
| Zugehöriger Earendil-Release | Tag `v1.4.0`, Commit `4a080252f06caf63a525d7873c5d94d3c23887e0` | README und Changelog stimmen mit dem veröffentlichten npm-Paket überein |
| Neuester abgefragter Earendil-Entwicklungsstand | Commit `c7372af4201aaa0c049f63c198e765cb4a2e3013`, 30.10.2026, 22:08:57 UTC; ausführlich gelesen wurde `50af8c160153e3721a18b1a046a4adf201635861` (13:30:54 UTC) | Enthält zusätzliche Änderungen unter `Unreleased`; **nicht** mit npm 1.4.0 gleichzusetzen |

Das npm-Archiv wurde ohne Installation gelesen und seine SHA-512-Integrität gegen die Registry geprüft.
Die Online-Abfragen erfolgten am 30.10.2026.

**Begriffsklärung:** „Pi“ bezeichnet Earendils gesamtes Monorepo einschließlich Coding-Agent, pi-ai,
pi-durable, Chord und weiterer Pakete. Dieser Vergleich betrifft vor allem **pi-durable**, nicht pauschal
alle Funktionen dieses Ökosystems. Chord bringt beispielsweise eigene RPC- und Zustandsmechanismen mit;
pi-durable selbst ist deshalb noch kein phi-spaces-kompatibler Netzwerkdienst. [P1–P4, P8]

## 2. Architektur und Grundmodell

### pi-durable: dauerhafte Ausführung rund um Conversations

Ein `Harness` öffnet eine Session über einem Storage-Backend. Eine Conversation besitzt ein Transkript
unveränderlicher Entries. Eine Submission stellt Eingabe oder einen zu schreibenden Eintrag zu.
Eingaben starten Generation-Tasks, die Modelle anfragen und Werkzeug-Tasks erzeugen.
Tasks speichern ihre Phasen und Checkpoints; der Scheduler setzt sie nach einem Neustart fort.

Ein Commit kann Transkripteinträge, Dokumentänderungen und Task-Erzeugung zusammen speichern.
Dokumente können zur Session, zu einer Conversation oder zu einem Task gehören. Conversation-Dokumente
unterstützen auch historische Stände und definierte Fork-Semantik. Das ist deutlich mehr als eine
persistente Chat-Nachrichtenliste. [P3]

### phi-spaces: dauerhafter gemeinsamer Arbeitsraum

Ein `OwnStoreHost` hält Dokumente und führt atomare Commits aus. `PhiSpaces` implementiert darauf die
Space-Operationen. Ein Entry ist fachlicher Inhalt mit `type`, optionalen Supertypen und `fields`;
es ist **kein** pi-durable-Transkripteintrag.

Produzenten müssen den späteren Verbraucher nicht kennen. Ein Verbraucher sucht beispielsweise
`{ type: "Job", fields: { queue: "analysis" } }` und übernimmt einen passenden Entry mit `take`.
Eine Space-Transaktion kann die Übernahme reservieren und Ergebnisse erst bei Commit sichtbar machen.
Bei Abort oder Ablauf der Transaktionslease wird die Reservierung zurückgegeben.

`SpaceService` und `RemoteSpace` stellen die Semantik auch über Prozessgrenzen bereit.
Modellaufrufe, Promptaufbau und die Ausführung einer beliebigen Agenten-Task-Zustandsmaschine sind
keine Aufgabe des Space-Kerns. [L1, L3, L4]

### Heutige Kombination

```text
pi-durable-Harness                         phi-spaces-Host
Conversations, Modell- und Tool-Tasks       Entries, Leases, Claims, Mailboxes
Agentenspeicher                           phi-spaces-Store
             |                                      ^
             +-- agent/: stabile Request-Identität --+
             <--- EventSink / Conversation-Zustellung
```

Beide Hosts dürfen im selben Prozess laufen, haben aber **getrennte Speicher und Commit-Grenzen**.
Das frühere Modell „Agenten-Task-Claim und Space-Änderung in einem Harness-Commit“ gilt heute nicht mehr.
Die Brücke speichert vor dem ersten fachlichen Space-Aufruf dessen Request-Identität als Task-Memo im
Agentenspeicher; nur die Generation wird davor beim Space geholt. Der Space speichert Wirkung und Ergebnis unter
dieser Identität atomar. Ein Replay ruft dadurch dieselbe Operation wieder auf, statt eine neue zu erfinden.
Nimmt die Generation keine neuen Anfragen mehr an, wird ein noch nicht aufgenommenes Replay mit `RequestExpired`
abgelehnt. Die Zusage setzt voraus, dass das Memo den Ausfall überlebt; siehe Abschnitt 5.3. [L5]

Das Diagramm zeigt die Anbindung im selben Prozess. Seit dem Upgrade gibt es für Codemode-Chat und spaces-mmo
zusätzlich einen getrennten Agentenprozess: Die Anwendung spricht über Node-IPC mit
[`durable-worker.ts`](../../agent/src/durable-worker.ts), das dortige Harness kennt den Space nicht.

## 3. Gemeinsamkeiten

| Gemeinsames Prinzip | pi-durable 1.4.0 | phi-spaces |
|---|---|---|
| Typisierter Zustand | JSON-Dokumente mit Definition, Version und Migration | JSON-Dokumentdefinitionen von phi-spaces (`defineDoc`) mit Version und Migration |
| Atomare lokale Änderungen | Entries, Dokumente und Tasks innerhalb einer Session | Dokumente und Space-Zustand innerhalb eines Store-Hosts |
| Persistenz vor Bestätigung | Veröffentlichte Zustandsänderungen folgen dem gespeicherten Commit; wie haltbar er ist, hängt vom Backend ab (Abschnitt 5.3) | Erfolgsantworten und Watches folgen dem dauerhaften Commit, im Standardprofil mit `synchronous=FULL` |
| Wiederanlauf | Task-Checkpoints, gespeicherte Submissions und Ergebnisse | Claims, wartende Operationen, Leases, Outbox und Betriebsjournale |
| Wiederholbare Anfragen | Submission-`requestId`, Task-Memos und wiederanbindbare verschachtelte Tools | Generationen, Request-IDs, Argumentbindung und gespeicherte Ergebnisse |
| Beobachtung | Dokument-Watches, Conversation-Views und Task-Graph | Dokument-Watches sowie Space-Seiten, Revisionen, Changes und Events |
| Fehlerbegrenzung | Storage-Ausfälle beenden die Session; Crash-Loop-Schutz für Tasks | Speicherfehler sperren den Host; Quoten und Budgets begrenzen Verpflichtungen |
| Zeit und Abbruch | Chord-Context, Harness-Uhr und konfigurierbare Timer | phi-spaces-Context (`src/context.ts`), explizite Kernzeit sowie Lease- und Waiter-Fristen |

Diese Ähnlichkeiten sind architektonisch bedeutsam, aber **keine API- oder Dateiformatkompatibilität**.
`defineDoc`, `commit`, `snapshot` und `watchDoc` heißen ähnlich, besitzen jedoch unterschiedliche Typen,
Adressierungsregeln und teilweise andere Beobachtungssemantik. [P3, L2]

Beide vermeiden außerdem eine automatische Zusage für externe Exactly-once-Wirkung.
Ein gespeicherter Tool-Intent oder ein exklusiv übernommener Job beweist noch nicht, ob eine externe
Zahlung, E-Mail oder HTTP-Mutation vor einem Absturz ausgeführt wurde.

## 4. Funktionsvergleich

Die pi-durable-Spalte beschreibt **Release 1.4.0**, sofern nicht ausdrücklich anders angegeben.

| Bereich | phi-spaces | pi-durable |
|---|---|---|
| Hauptzweck | Gemeinsame Daten und Arbeit zwischen Teilnehmern koordinieren | Persistente Agenten und ihre Ausführung betreiben |
| Zentrale Abstraktion | Space mit per Template auffindbaren Entries | Conversation mit Transkript, Submissions und Tasks |
| Typischer Zugriff | `write`, `read`, `take`, `readAll`, `notify`, `wait` | `submit`, `wait`, `commit`, Tasks und Tools |
| Arbeitsverteilung | Konkurrierende Verbraucher übernehmen passende Arbeit aus einem Space | Scheduler führt besitzgebundene Tasks aus; kein entsprechendes Tuple-Space-`take` |
| Transaktionen | Zusätzlich langlebige fachliche Transaktionen mit Reservierung, Commit, Abort und Lease | Atomare Commit-Callbacks; keine gleichartige geleaste Entry-Reservierung über viele Aufrufe |
| Lebensdauer | Entry-, Transaktions- und Registrierungsleases, explizite Erneuerung | Task-Lebenszyklus und gespeicherte Schlafzustände; keine entsprechende allgemeine Entry-Lease |
| Lange Wartezeiten | Dauerhafte Waiter auf passende Daten; Read-/Take-Waits | Task-Schlaf bis Zeitpunkt, Warten auf Tasks oder Submissions |
| Modellintegration | Nicht im Space-Kern; Anwendungen oder `agent/` übernehmen sie | Eingebaut über pi-ai: Generation, Modellwahl und Kontextaufbereitung |
| Werkzeuge und Prompts | Space-Werkzeuge im separaten Agent-Paket | Extension-Registry, Tools, Promptabschnitte, Hooks und ExecutionEnv |
| Unteragenten | Teilnehmer können unabhängige Agenten sein; kein eingebauter LLM-Unteragentenlauf | Besitzgebundene Child-Conversations und Child-Tasks, Abbruchkaskaden |
| Code Mode | Separates Earendil-Paket in Beispielen/Anwendungen; keine Kernsemantik | Persistente Code-Mode-Integration mit deterministischem Replay-Journal |
| Historie und Forks | Revisions-/Changes-Protokoll für Space-Daten; keine Conversation-Forks | Transkripte, Forks und historische Conversation-Dokumente |
| Benachrichtigungen | Template-Notify, Waiter, Outbox, dauerhafte Mailboxes mit ACK/TTL/Gap | Watches und Conversation-Views; keine entsprechende Space-Mailbox-ACK-Semantik |
| Ressourcenregeln | Byte-Budgets, Owner-Quoten, Fristen und reservierte Ergebnis-/Abschlussbudgets | Unter anderem Tool-Ausgabelimits, Speicherretention, Retry- und Compaction-Einstellungen |
| Netzwerkdienst | In-Process, Unix-Socket und TCP; Adapter für pi-server | Harness-/Storage-Bibliothek; Netzwerkhosting ist zusätzliche Integration |
| Identität und Zugriff | Principals, Rollen-/Typ-Policy; optionale Gate-, Schlüssel-, Grant- und Enrollment-Schichten | Tool-/Extension-Auswahl und Host-Umgebung; keine entsprechende Space-Peer-Autorisierung im Harness |
| Verteilung und Recovery | Router, Membership, Delegation, Primary/Sync, Fencing und Recovery-Bausteine | Session-Wiederanlauf ist eingebaut; kein gleichartiger Space-Föderations-/Promotion-Vertrag |
| Speicherplattformen | phi-spaces-Store für Memory und Node-SQLite | Memory, SQLite, JSONL, IndexedDB und Cloudflare-Durable-Object-SQLite |
| Beobachtbarkeit | `Meter`, Store-Statistiken, Dashboard, Audit und Alerts | Token-/Kostenzählung, Inspect/Task-Graph und pi-telemetry-Anbindung |
| Rust | Kern, Store und Standalone-Dienst portiert und abgenommen (R0–R3), sicherer Host (R5) in Arbeit; nicht pauschal als fertiger Ersatz freigegeben | Geprüftes Paket ist TypeScript/JavaScript; keine daraus ableitbare Rust-Laufzeit |

**Wichtige Grenze:** Ein pi-durable-Watch ist kein dauerhaft bestätigter Space-Event-Stream.
Release 1.4.0 begrenzt langsame Watches und ersetzt bei Überlauf ausstehende Frames durch den neuesten
Zustand. Ein neuer Beobachter beginnt mit dem aktuellen Zustand. Umgekehrt sind phi-spaces-`changes`
kein vollständiger Store-Replikationsstrom und keine Conversation-Historie. [P3, L3, L4]

## 5. Speicher, Konsistenz und Haltbarkeit im Detail

### 5.1 Gleiches SQLite, andere Datenmodelle

pi-durable speichert getrennte Records für Conversations, Entries, Tasks und Submissions sowie
Dokumentbasen und Dokumentrevisionen. Chord verfolgt Dokumentänderungen als Deltas.
Seit 1.4.0 muss jede Dokumentdefinition ausdrücklich ein `checkpointWhen` angeben:
Die Anwendung entscheidet, wann statt eines weiteren Deltas eine vollständige Basis geschrieben wird.
**pi-durable schreibt also nicht zwangsläufig bei jeder Änderung das gesamte Anwendungsdokument.**
Das ist eine Möglichkeit, kein Automatismus: Die Harness-eigenen Dokumente `agent`, `provider` und `usage`
wählen selbst `() => true` und schreiben damit bei jedem Commit eine Basis. [P4, P5]

phi-spaces speichert Dokumentköpfe und große Sammlungen getrennt. `SPACE_PARTS` umfasst Entries,
RPC-Claims, historische Claims nach Restore, Generationen und Stream-Batches.
Der SQLite-Store hält die Datensätze der Teile in getrennten `parts`-Zeilen.
RPC-Claims und historische Claims sind als ganze Maps Disk-Teile und müssen nicht vollständig im
Arbeitsspeicher liegen; `DISK_MAP` fragt sie gezielt über Schlüssel und Indizes ab. Ein Copy-on-write-/Undo-Mechanismus von phi-spaces ersetzt Chords Tracker.
Das ist eine gezielte Anpassung an das Lastprofil eines Space-Dienstes, keine allgemeine Überlegenheit
eines JSON-Modells gegenüber einem anderen. [L2, L6]

Nicht übertreiben sollte man auch die Suche: Die aktuelle TypeScript-Semantik nutzt unter bestimmten
Bedingungen gecachte Typ-Buckets. Das macht sie **nicht** zu einer beliebig feldindizierten SQL-Datenbank.
Template-Felder werden weiterhin semantisch mit tiefer JSON-Gleichheit geprüft. [L1]

### 5.2 Commit-Verarbeitung

**pi-durable 1.4.0:** Die Session serialisiert Commit-Callback, Vorbereitung, Storage-Abschluss und
Übernahme auf einer Mutationslinie. Diese Linie bleibt während des Storage-Aufrufs belegt.
Auf diesem Stand darf man nicht die weitergehende Group-Commit-Implementierung von `main` voraussetzen. [P6]

**phi-spaces:** Commit-Callbacks laufen ebenfalls geordnet, aber der nächste darf bereits auf dem
vorbereiteten Zustand aufsetzen, während vorherige Commits noch geschrieben werden.
Ein Schreibthread bündelt eingegangene Änderungen in SQLite-Transaktionen.
Antworten und externe Beobachter warten weiterhin auf dauerhafte Speicherung.
Scheitert das Schreiben, sperrt sich der Host, statt ungespeicherte Änderungen weiter zu bestätigen. [L2]

Das ist **keine verteilte Transaktion** zwischen mehreren Hosts. Auch ein pi-durable-Commit umfasst
nicht automatisch einen separaten Space-Store, einen externen Dienst oder ein zweites Harness.

### 5.3 „Durable“ hängt vom Backend und Ausfallmodell ab

| Punkt | phi-spaces-SQLite | pi-durable 1.4.0 |
|---|---|---|
| Standard-Sync-Profil | WAL mit **`synchronous=FULL`** | Node-SQLite laut Dokumentation WAL mit **`synchronous=NORMAL`** |
| Konsequenz | Bestätigung nach SQLite-COMMIT im FULL-Profil | Prozess-Crash-Persistenz; jüngste Commits können bei Strom-/Hostausfall verloren gehen |
| Alternative | `NORMAL` ausdrücklich wählbar, mit schwächerem Ausfallversprechen | JSONL `{ fsync: true }` flusht Sidecars, nicht zwingend jeden Commit-Marker; andere Backends haben eigene Verträge |
| Mehrere schreibende Prozesse | Store-Owner-Lock über exklusiv gesperrte `.owner`-Datei | Ein Besitzer vorausgesetzt; laut README kein prozessübergreifendes Storage-Locking |
| Memory-Backend | Keine Persistenz | Keine Persistenz |

FULL ist kein Beweis gegen defekte Datenträger, Dateisystemfehler oder Controller, die Flush-Zusagen
nicht einhalten. Lokale SIGKILL-Tests belegen außerdem keinen realen Stromverlust.
Replikation, Sicherung und Wiederherstellung sind separate Fragen. [P3, L2, L6]

**Folge für die Kombination:** Die Tabelle vergleicht die Standards, nicht die Haltbarkeit eines Zusammenspiels.
Die zunächst schwächer geöffneten Agentenspeicher sind inzwischen gehärtet: [`agent/src/storage.ts`](../../agent/src/storage.ts) im phi-spaces-Agentenpaket
öffnet die pi-durable-Speicher `SqliteStorage` und `JsonlStorage` mit strengeren Einstellungen; es ändert weder
pi-durable noch den phi-spaces-Store. Der Worker und die mobile Runtime verwenden SQLite
`synchronous=FULL`, vor der Schemaöffnung geprüft. Rechercheläufe verwenden JSONL mit `{ fsync: true }`
plus zusätzlichem Flush des Commit-Markers und der Verzeichniseinträge. Allein die Upstream-Option wäre
dafür nicht ausreichend. Recherchemanifest und atomare Exporte werden ebenfalls synchronisiert.

Die [Regressionen](../../agent/test/storage.test.ts) prüfen Sync-Policy, Marker-Reihenfolge, ein vereinfachtes
Dateicache-Verlustmodell und verweigerte Bestätigung bei Flush-Fehlern.
Ein [VM-Versuch](../agenten-stromausfalltest.en.md#result-of-30102026) prüfte den Agentenspeicher in beiden Profilen:
„Schwach“ sind die pi-durable-Speicher mit den pi-durable-Standards, „stark“ dieselben Speicher, geöffnet über `agent/src/storage.ts`.

**Was bei einem Commit geschieht.** Jede Probe schreibt in einer Schleife einen Zähler samt Prüfsumme und gibt nach jedem
fertigen Commit eine Bestätigung aus. Bestätigt heißt: Das Commit-Versprechen des Speichers ist eingelöst, die Anwendung darf
weiterarbeiten. Die Frage des Versuchs ist, ob jeder bestätigte Zähler nach dem Ausfall noch da ist.

| Profil | Geöffnet mit | Ablauf bis zur Bestätigung | Wann die Daten wirklich auf der Platte sind |
|---|---|---|---|
| pi-durable SQLite, schwach | `openNodeSqliteStorage`: WAL, `synchronous=NORMAL`, Checkpoint alle 1000 Seiten | Seiten mit `write` ans WAL anhängen, bestätigen. Kein Flush | Erst beim Checkpoint, den der Commit auslöst, der das WAL über 1000 Seiten hebt, und vor dessen Bestätigung: WAL flushen, Seiten in die Hauptdatei schreiben, Hauptdatei flushen. Bei 4 Seiten je Commit alle 250 Commits |
| pi-durable SQLite, stark | `openDurableSqliteStorage` aus `agent/src/storage.ts`: dieselbe Datenbank, vor der Schemaöffnung auf `synchronous=FULL` gestellt und geprüft; Verzeichnis geflusht | Seiten ans WAL anhängen, WAL flushen, bestätigen | Vor jeder Bestätigung |
| pi-durable JSONL, schwach | `openNodeJsonlStorage`: ohne `fsync` | Datensatz an die Sidecar-Datei anhängen, Commit-Marker an `main.jsonl` anhängen, Sidecar neu als `.reclaim`-Datei schreiben und umbenennen, bestätigen. Kein Flush, auch nicht für neue Dateinamen | Wenn der Kernel es von selbst zurückschreibt; nach dem Ausfall kann die ganze Datei fehlen |
| pi-durable JSONL, stark | `openDurableJsonlStorage` aus `agent/src/storage.ts`: `{ fsync: true }` plus Dateisystem-Hülle | Sidecar anhängen, Sidecar flushen (pi-durable); Verzeichnis flushen, Marker anhängen, Marker flushen, Verzeichnis flushen (`agent/src/storage.ts`); Marker erneut flushen, `.reclaim`-Datei schreiben und flushen, umbenennen (pi-durable), Verzeichnis flushen (`agent/src/storage.ts`); bestätigen | Vor jeder Bestätigung, der Marker nach seinen Daten |
| phi-spaces-Store, schwach | `openSqliteHost(pfad, { synchronous: "NORMAL" })`: ausdrücklich gewählt, Checkpoint alle 1000 Seiten | Schreibthread legt alle wartenden Commits in eine SQLite-Transaktion, hängt sie ans WAL an, bestätigt sie gemeinsam. Kein Flush | Erst beim Checkpoint: bei 2 Seiten je Dokument-Commit alle 500 Commits, bei Space-Writes mit 6 bis 12 Seiten je Write entsprechend früher |
| phi-spaces-Store, stark | `openSqliteHost(pfad)`: Standard `synchronous=FULL` | Wie schwach, aber vor der gemeinsamen Bestätigung wird das WAL geflusht | Vor jeder Bestätigung, ein Flush für alle Commits der Gruppe |

Ein Flush ist `fsync`, bei SQLite je nach Node-Build auch `fdatasync` (VM mit dem offiziellen Node 22.23.1: `fsync`, Entwicklungsrechner: `fdatasync`); er endet erst, wenn das Laufwerk die Daten gesichert
meldet. Ohne Flush liegen sie nach `write` nur im Seitencache des Kernels. Die Abläufe sind [mit `strace` mitgeschnitten](../../test/evidence/power-loss-2026-10-30/syscalls.en.md).
Der Mitschnitt je Commit lief auf dem Entwicklungsrechner (SQLite 3.51.2), der beim harten Aus in der VM. Er zeigt die Reihenfolge der Syscalls, nicht das Laufwerk.
Mit 8 Schreibern kamen beim phi-spaces-Store 81 Bestätigungen auf 32 WAL-Flushes, bei pi-durable SQLite 47 auf 50.

**Was beim Ausfall geschieht.** Mit dem Prozess stirbt nichts davon, der Seitencache überlebt einen Prozessabsturz. Erst ein
Strom- oder Hostausfall trifft ihn. Zwei Verfahren stellen das nach:

1. **Replay:** Im Gast zeichnet dm-log-writes jeden Schreibvorgang auf die Testplatte der Reihe nach auf, sobald ein Flush ihn abschließt; nach
   Bestätigungen kommt eine Marke ins Protokoll. Danach wird die Platte bis zu einer zufällig gewählten Marke neu aufgebaut,
   mit genau dem, was bis dahin geflusht war. Das ist der Zustand nach einem Verlust von
   Seiten- und Plattencache an dieser Stelle. Einhängen spielt das ext4-Journal ein, die Probe prüft den bestätigten Zähler.
2. **Hartes Aus:** Der Host beendet die laufende VM mit `virsh destroy` nach 6 bis 20 s, die Bestätigungen werden außerhalb
   der VM gesammelt. Nach dem Neustart prüft die Probe den höchsten Wert, der den Host erreicht hat. Es gibt nur diesen einen
   Schnitt je Lauf, und er liegt, wo die Uhr ihn trifft.

**Was daraus folgt.** Im schwachen SQLite-Profil gehen beim Replay die Commits seit dem letzten Checkpoint verloren, also je nach
Schnitt 1 bis knapp 250 bei pi-durable und bis knapp 500 beim phi-spaces-Store. Das Replay ist dort empfindlich, weil es Stellen
im ganzen Fenster trifft. Im schwachen JSONL-Profil fehlt ohne Flush fast alles Neue, daher Verlust an jedem Schnitt.

| Profil | Replay: Schnitte mit Verlust | Hartes Aus: Läufe mit Verlust |
|---|---|---|
| SQLite stark | 0 von 38 | 0 von 3 |
| JSONL stark | 0 von 37 | 0 von 3 |
| SQLite schwach (`NORMAL`) | 77 von 115, bis zu 249 Commits | 0 von 9 |
| SQLite schwach mit `strace` | nicht geprüft | 4 von 9, 86 bis 233 Commits |
| JSONL schwach (ohne `fsync`) | 115 von 115 | 9 von 9 |

Die 0 von 9 belegen keine Haltbarkeit: Das schwache Profil schreibt eine Weile ohne Flush und hängt dann im
Checkpoint auf der Platte. Ohne `strace` traf das Ausschalten immer diese Wartezeit, einen Moment ohne ungeflushte Commits: Alle neun
Läufe endeten bei einem persistierten Stand von 250·n − 11 (etwa 4739, 6239), und der Mitschnitt zeigt den ersten Checkpoint genau im
Commit 239. Die Wiederholung mit aus der VM gestreamtem `strace` belegt das direkt. `strace` verlängert die Schreibphase, der Flush nahm
noch 61 bis 70 % der Laufzeit ein. In allen 5 Läufen ohne Verlust war der letzte Aufruf ein noch offener `fsync` des WAL,
in allen 4 Läufen mit Verlust ein `pwrite`; der Stand fiel dort auf den letzten Checkpoint zurück (etwa 4239 bei 4353 Bestätigungen).
Ob `NORMAL` beim Ausschalten Daten verliert, hängt also nur davon ab, wo der Schnitt liegt. Die Haltbarkeit kostet viel, die Raten stehen in der Tabelle unten.

**Vergleich mit dem phi-spaces-Store:** Derselbe Versuch lief auf derselben VM und Platte mit einer
[gleich aufgebauten Probe](../../agent/test/power-loss-own-probe.ts) gegen den phi-spaces-Store: einmal dasselbe Dokument, einmal
echte `PhiSpaces`-Writes. Beim phi-spaces-Store steht stark für `synchronous=FULL`, schwach für `NORMAL`.

| Speicher | Replay: Schnitte mit Verlust | Hartes Aus: Läufe mit Verlust |
|---|---|---|
| phi-spaces-Store, Dokument, stark | 0 von 38 | 0 von 3 |
| phi-spaces-Store, Space-Writes, stark | 0 von 38 | 0 von 3 |
| phi-spaces-Store, Dokument, schwach | 33 von 38, bis zu 497 Commits | 0 von 3 |
| phi-spaces-Store, Space-Writes, schwach | 26 von 38, bis zu 84 Commits | 0 von 3 |
| Stark mit 8 Schreibern: Dokument / Space-Writes / pi-durable-SQLite | 0 von 38 je Zeile | nicht geprüft |

Die Probe der Space-Writes prüft jeden bestätigten Entry einzeln mit Prüfsumme; bei 8 Schreibern gilt eine Nummer erst als bestätigt, wenn alle kleineren es sind.

In den untersuchten Profilen und Schnittpunkten gab es im starken Profil keinen Verlust, mit `NORMAL` verloren beide Systeme Bestätigtes.
Die Schnitte einer Zelle sind keine unabhängigen Ausfälle: Die 37 oder 38 stammen aus drei Schreibläufen. Geprüft wurde ein kleiner Zähler oder
eine Reihe einzelner Entries, nicht Conversations, Tasks oder Dokument-Deltas, und nur an Marken, nicht gezielt in kritischen Schreib- und Ersetzungsschritten.
Für diese Fälle sagt der Versuch nichts. Im Versuch folgte der Unterschied der Standards aus der Einstellung: phi-spaces nimmt von selbst `FULL`,
pi-durable `NORMAL`. Im phi-spaces-Agentenpaket ersetzt `agent/src/storage.ts` dieses `NORMAL` durch `FULL`.

Median (kleinster bis größter Wert) der Commits je Sekunde auf derselben Platte: [je 5 Läufe von 20 s](../../agent/test/power-loss-rate.mjs) in gemischter
Reihenfolge, frisches ext4, kein Lauf verworfen, Festplatten-RAID, Lastwert des Hosts 4,3 bis 10,6 durch Fremdlast:

| Speicher | stark, 1 Schreiber | stark, 8 Schreiber | schwach, 1 | schwach, 8 |
|---|---|---|---|---|
| pi-durable SQLite | 2,9 (1,9–6,2) | 5,4 (2,6–6) | 237 (187–462) | 212 (175–525) |
| pi-durable JSONL | 0,7 (0,4–1,4) | 0,7 (0,6–1,4) | 207 (21–965) | 346 (127–819) |
| phi-spaces-Store, Dokument | 4,1 (2,9–5,7) | 6,1 (2–24) | 299 (249–924) | 1397 (597–3027) |
| phi-spaces-Store, Space-Writes | 2,9 (0,1–5) | 9,8 (6,7–12,6) | 73 (24–125) | 179 (70–237) |

Die Bereiche überlappen fast überall, die Messreihe trägt keinen allgemeinen Leistungsvergleich. Im starken Profil gibt sie mit 8 Schreibern
keinen gesicherten Vorsprung für einen der Speicher her. Das Bündeln selbst ist belegt: Der Schreibthread des phi-spaces-Stores legt mehrere Commits
auf einen Flush (81 Bestätigungen auf 32 WAL-Flushes im Mitschnitt), pi-durable 1.4.0 tut das nicht (Abschnitt 5.2). Deutlich ist nur der Abstand
von stark zu schwach und der Vorsprung des phi-spaces-Stores mit 8 Schreibern im schwachen Dokumentprofil. Die Space-Writes tragen die Kosten der Space-Semantik und sind nicht mit einem
Dokument-Commit gleichzusetzen. Der Versuch misst diese kleine Last, nicht die Agentenlaufzeit.

Offen bleiben außerdem das Verhalten des Laufwerks, also ob es Flushes einhält und wie es Sektoren schreibt, und jedes andere Dateisystem. Die Workflow-Wiederaufnahme bleibt bisher durch
Prozessabsturztests belegt, nicht durch eine vollständige Stromausfall-End-to-End-Abnahme.

Verlorene oder beschädigte Agentendaten können weiterhin die Request-Identität oder noch nicht im Space
gebuchten Verbrauch verlieren; FULL ist kein Ersatz für Sicherung oder einen gemeinsamen Commit beider Speicher.
Gegen gleichzeitige Prozesse sichert `durable-worker.ts` den Speicher zusätzlich mit einer
`.owner`-Datei ab, weil pi-durable selbst kein prozessübergreifendes Locking hat.

### 5.4 Wiederholung ist auf verschiedenen Ebenen abgesichert

**pi-durable:** `submit` mit derselben Request-ID findet die vorhandene Submission derselben Conversation.
Der geprüfte 1.4.0-Code prüft dabei den Submission-Typ, aber nicht zusätzlich die Gleichheit sämtlicher
erneut mitgelieferter Inhalte. Eine Request-ID darf daher nicht für fachlich andere Eingaben wiederverwendet werden.
Task-Memos und Schlüssel verschachtelter Tool-Aufrufe stabilisieren die Wiederanbindung.
Ein unterbrochenes Tool wird nur mit `replay: "safe"` erneut ausgeführt; externe Wirkungen benötigen
trotzdem eigene Idempotenz. [P3, P7]

**phi-spaces:** Der Claim bindet Principal, Space, Generation und Request-ID sowie Methode und Argumenthash.
Andere Argumente zur selben Identität ergeben `RequestConflict`. Wirkung und Ergebnis werden gemeinsam
gespeichert; ausstehende Operationen können weiter abgefragt werden. Abgelaufene Ergebnisse werden mit
`ResultExpired` gemeldet, nicht neu ausgeführt. Bei ungewissem Transportergebnis muss der Client die
ursprüngliche Identität beibehalten; ein Timeout beweist nicht, dass nichts passiert ist. [L4]

Eine Transaktionslease garantiert dabei nur die Rückgabe eines nicht abgeschlossenen Jobs.
Wenn ein Worker nach einer externen Wirkung abstürzt, kann ein anderer Worker den Job später erneut
übernehmen. Für die Außenwelt braucht auch dieses Muster einen Idempotenzschlüssel oder einen anderen
expliziten Abschlussvertrag.

## 6. Betrieb, Sicherheit und Grenzen

phi-spaces verfügt über wesentlich mehr **Space-spezifische** Betriebslogik: per HMAC gesicherte Generationen,
Schlüssel-Challenge, Enrollment, Grants, Rollen-/Typprüfung, Router, Membership, RunGates,
Worker-Zuweisungen, Host-Wechsel und Recovery-Journale.
Diese Schichten ersetzen weder ein allgemeines Betriebssystem-Sandboxing noch Anwendungsauthentifizierung.

Insbesondere startet `src/standalone.ts` mit einer statischen Identität: Wer den Socket erreicht, kann
den Space unter dieser Identität benutzen. Für fremde Teilnehmer ist daher die passende Gate-/Auth-
Komposition nötig; ein offen erreichbarer TCP-Port ist dadurch nicht automatisch abgesichert. [L3, L7]

pi-durable bietet dagegen Tools, Extensions und eine abstrahierte Ausführungsumgebung.
Eine Code-Mode-Sandbox oder eine Tool-Auswahl ist nicht dasselbe wie die kryptographische Identität eines
entfernten Space-Teilnehmers. Ebenso folgt aus dieser Gegenüberstellung nicht, dass das gesamte
Pi-/Chord-Ökosystem keine Netzwerk- oder Sicherheitsbausteine besitzt. [P3, P8]

**Implementiert ist nicht gleich uneingeschränkt abgenommen:** phi-spaces enthält umfangreiche
Föderations-, Replikations-, Fencing- und Recovery-Bausteine. Daraus darf keine pauschale
Produktionsfreigabe für alle Topologien und Ausfallmodelle abgeleitet werden.
Die jeweiligen Abnahmen unterscheiden lokale Tests, reale NetBird-Verbindungen, Prozessabbrüche und
weitergehende Betriebsmodelle. Die Rust-Portierung ist ebenfalls ein gesonderter, noch laufender Schritt. [L6, L7]

Ältere Abschnitte von `implementierungsstand.md` nennen noch JSONL und Harnesses; ein Hinweis am Seitenanfang ordnet
sie ein. Für die heutige Speicherabhängigkeit sind die Abhängigkeiten in `package.json`, `src/store/`,
`src/standalone.ts` und die spätere U6-Dokumentation maßgeblich.

## 7. Was Release 1.4.0 gegenüber der früheren Version 1.0.3 verändert

Zwischen 1.0.3 und 1.4.0 wurden unter anderem folgende Funktionen veröffentlicht: [P4]

| Release | Für diesen Vergleich relevante Änderungen |
|---|---|
| 1.1.0 | Cloudflare-Durable-Object-SQLite, historische Kontextabfragen, Scan-Richtung, Task-/Tool-Zeiten und inkrementeller Kontextcache |
| 1.2.0 | Verschachtelte Tool-Aufrufe, strukturierte Tool-Ergebnisse und persistenter Code Mode; Änderungen an Storage-Fehlern; Dokumentcache und optimierte Array-Anhänge |
| 1.3.0 | SQLite-Tabellenpräfixe und koordinierter Datenbankzugriff für mehrere Pi-Storages im selben Cloudflare Durable Object |
| 1.4.0 | IndexedDB, persistente Task-Schlafzustände, Host-Wake-Schnittstelle, Crash-Loop-Schutz, Telemetrie sowie explizite Dokument-Checkpoint-Regeln |

Damit wäre beispielsweise „pi-durable kann nur Node-SQLite/JSONL“ heute falsch.
Auch die pauschale Behauptung, jede Änderung müsse immer alle großen Arrays vollständig durchlaufen,
ignoriert veröffentlichte Optimierungen. Ob diese das konkrete Space-Lastprofil ausreichend verbessern,
muss gemessen werden.

### Was das Upgrade der Agentenanbindung verlangte

Das Upgrade ist ausgeführt; Einzelheiten stehen in [upgrade-pi-1.4.0.md](../upgrade-pi-1.4.0.en.md). Zwei Änderungen waren zwingend:

1. Seit 1.2.0 heißt der Ergebniskanal von Werkzeugen **`output`** statt `content`; 1.4.0 liest `result.output`.
   `agent/src/agent.ts` und die übrigen Werkzeuge sind umgestellt.
2. In 1.4.0 ist `checkpointWhen` verpflichtend. Die Dokumentfamilie `phi-spaces.agent-generation` schreibt jede
   Änderung als Basis (`() => true`).

1.4.0 migriert pi-durable-SQLite beim Öffnen auf Schema 2; laut Changelog ist anschließend kein Öffnen mit 1.3.0
oder älter möglich. Agentendatenbanken müssen deshalb vorher gesichert werden; die Datenbank der mobilen Runtime
wurde am 30.10.2026 gesichert und migriert. Ein Rückweg führt nur über die Sicherung.

Der phi-spaces-Store ist davon nicht berührt und wurde nicht wieder zu einem pi-durable-Store.
Sein Format 2 ist zudem völlig unabhängig vom ebenfalls „2“ genannten pi-durable-Schema. [L2, L5, P4]

## 8. Neuester Earendil-Code: zusätzliche Änderungen auf main

Der abgefragte Commit `50af8c160153e3721a18b1a046a4adf201635861` ist neuer als der Release.
Seine `package.json` nennt noch `1.4.0`, sein Changelog enthält aber einen umfangreichen
**`Unreleased`-Abschnitt**. Die Paketversionsnummer allein reicht deshalb zur Identifikation nicht.
Die folgenden Aussagen gelten ausschließlich für diesen Entwicklungsstand. [P9–P11]

Bis zum Commit `c7372af4201aaa0c049f63c198e765cb4a2e3013` kamen im Changelog nur zwei Einträge hinzu:
`GenerationHooks.beforeProviderRequest` ersetzt den Provider-Request einer Anfrage, und die Rangfolge von `tool_search` und `searchTools()` ist korrigiert.
Der Code dieses neueren Commits wurde nicht gelesen.

### 8.1 Die Speicherarchitekturen nähern sich teilweise an

- **Group Commit:** Auch pi-durable gibt die Mutationslinie während des Storage-Schreibens frei und fasst
  mehrere Commits in einem Backend-Aufruf zusammen. Lese-/Schreibabhängigkeiten sorgen dafür, dass
  nachfolgende Arbeit nicht beliebig an noch unbestätigten Vorgängern vorbeiläuft.
- **Neuer Storage-Vertrag:** `commit(batches, receive, context)` verarbeitet Gruppen mit je eigener Sequenz
  und Haltbarkeitsquittung. Das ist eine inkompatible Änderung für Backends und Wrapper, die nicht aus pi-durable selbst stammen.
- **`StoreStorage`:** Ein neues Backend legt Durable-Records und -Dokumente in Chord v2s Store ab.
  Chord-Objekte und Durable-Sessions können dessen Commit-Warteschlange und Outbox teilen.
  Das ist **nicht** der phi-spaces-Store und stellt keine Kompatibilität mit dessen `parts`-Format her.

Damit ist „nur phi-spaces besitzt Group Commit“ bereits als allgemeine Aussage über den neuesten
Earendil-Code falsch. Gegenüber dem veröffentlichten 1.4.0 bleibt die in Abschnitt 5.2 beschriebene
Differenz bestehen.

### 8.2 Sichtbarkeit und Persistenz werden teilweise getrennt

Auf diesem `main`-Stand gibt es **deferred commits** für bestimmte bestehende Conversation-Dokumente
mit `history: "latest"` und `fork: "initial"`. Sie dürfen im Speicher veröffentlicht werden, bevor sie
geschrieben sind. Ein späterer abhängiger Commit, Close oder eine Frist erzwingt die Speicherung.

Streaming-Zwischenstände nutzen das standardmäßig mit
`settings.progress.persistWithinMs = 1000`. Bei einem Absturz kann dadurch ungefähr eine Sekunde
angezeigter Zwischenstand verloren gehen; in 1.4.0 sind es höchstens rund 100 ms, die dort aber noch nicht
angezeigt wurden. Andere Schreibarten erzwingen unmittelbare Persistenz;
abgeschlossene Ergebnisse sind nicht einfach pauschal „nur im RAM“.
Mit `persistWithinMs: 0` entfällt die zusätzliche Wartefrist. Der Commit bleibt aber ein gehaltener:
Er wird weiterhin zuerst im Speicher übernommen und erst danach geschrieben.

**Für einen fairen Vergleich ist das entscheidend:** „Alles Sichtbare wurde bereits gespeichert“ passt
zum hier geprüften pi-durable-Release, aber nicht uneingeschränkt zum neuesten Entwicklungsstand.
phi-spaces bestätigt seine Space-Commits weiterhin erst nach dem dauerhaften Schreiben. [P9, P11, L2]

### 8.3 Weitere noch nicht veröffentlichte Änderungen

- Watches und Observer erhalten neue, getaggte Schnittstellen; `watchEvents()` wird entfernt.
  Conversation-Views werden begrenzte Transkriptfenster, ergänzt um `ConversationTranscript`.
- `HarnessOptions.readOnly`, Continue-Submissions, Turn-Limits und atomare Submission-Zulassung
  innerhalb eines Commits erweitern die Host-Integration.
- Run-End-Tasks ergänzen Arbeiten nach einer Antwort. Neue Fehlerzustände machen nicht beantwortete
  Runs sichtbar. Am Restart-Limit werden Tasks beendet, statt wie in 1.4.0 geparkt zu bleiben.
- Ein beim Hostausfall laufender Modell-Request wird beim Öffnen nicht mehr neu gesendet; der Versuch zählt
  als gescheitert und unterliegt `settings.retry`. Das schließt doppelte Berechnung nicht aus, ändert aber
  das in den Integrationsgrenzen beschriebene Verhalten von 1.4.0.
- Caches, Streaming-Verarbeitung und Speicherhaltung werden optimiert.

Diese Änderungen machen pi-durable weder zu einem Tuple Space noch zu einem fertigen verteilten
Space-Dienst. Sie relativieren aber Vergleiche, die pi-durable nur als alte, strikt seriell speichernde
Agentenbibliothek betrachten. Eine Freigabe für phi-spaces folgt daraus noch nicht.

## 9. Einordnung für dieses Projekt

### Wann welches System?

| Bedarf | Passender Ausgangspunkt |
|---|---|
| Ein Agent soll Modell-/Tool-Arbeit nach Prozessneustarts fortsetzen | pi-durable |
| Conversation-Forks, Promptaufbau, Modellkontext und Compaction | pi-durable |
| Unabhängige Worker sollen passende Jobs exklusiv übernehmen | phi-spaces |
| Gemeinsame Daten, geleaste Reservierungen, dauerhafte Template-Waits | phi-spaces |
| Mehrere persistente Agenten sollen über gemeinsame Arbeit kooperieren | Beide: Agentenlaufzeit plus Space-Dienst |
| Kleine Agentenanwendung braucht nur etwas atomar mitgespeicherten Zustand | Zunächst pi-durable-Dokumente; ein separater Space-Dienst ist nicht automatisch nötig |
| Ein nicht agentischer Dienst benötigt eine koordinierte Arbeitsablage | phi-spaces ohne pi-durable |

### Was würde ein Ersatz kosten?

**pi-durable durch phi-spaces ersetzen:** Modellschleife, Conversation-/Transkriptmodell, Tool-Task-
Ausführung, Replay-Politik, Prompt-/Kontextverwaltung und Compaction müssten zusätzlich implementiert
oder durch eine andere Agentenlaufzeit bereitgestellt werden. Persistente Space-Entries allein liefern das nicht.

**phi-spaces durch pi-durable ersetzen:** Template-Matching, konkurrierendes `take`, geleaste
Transaktionen, Request-Claims, Events/Mailbox-ACKs, Quoten und die benötigten Netzwerk-/Betriebsverträge
müssten als Anwendungsschicht neu entstehen. Persistente Tasks und Dokumente allein liefern das ebenfalls nicht.

**Praktische Schlussfolgerung:** Die aktuelle Trennung ist fachlich nachvollziehbar.
Ein Upgrade von `agent/` und eine Neubewertung des Space-Speichers sind zwei verschiedene Entscheidungen.
Die Earendil-Weiterentwicklung ist besonders bei Group Commit, Chord-Store und Speicheroptimierungen relevant;
sie beseitigt nicht automatisch die spezialisierten Koordinationsanforderungen des Projekts.

### Wo pi-durable heute sinnvoll eingesetzt ist

Die Trennung lautet: **agentenintern pi-durable, agentenübergreifend phi-spaces**.
Ein Agent benötigt einen anderen Zustand als die Anwendung, für die er arbeitet.

| Bereich | Nutzen von pi-durable | Was im Space bleibt |
|---|---|---|
| Mobile und entfernte Coding-Sitzungen | Conversations, Modellkontext, Coding-Tools, Subagenten und Wiederaufnahme unterbrochener Agentenarbeit | Gemeinsame Aufträge, Ergebnisse und deren Berechtigungen |
| Space-Werkzeuge in `agent/` | Task-Memos bewahren die Identität eines Werkzeugaufrufs über Replay hinweg | Request-Claims, Wirkung und erstes Ergebnis der Space-Operation |
| Recherchebeispiele | Persistente Conversations und Werkzeuge für Sammler, Analyse und Bericht | Quellen, Arbeitsaufträge, Abschlussmarker und fachliche Ergebnisse |

Die mobile Runtime hält den Session-Katalog zusammen mit den Conversations im Agentenspeicher.
Das vermeidet eine unabhängig geschriebene JSON-Nebendatei. Die Space-Werkzeuge verwenden dagegen
einen getrennten Host; `withAgentEventSink` überbrückt die Kontextgrenze ausdrücklich.
Siehe [Agentenanbindung](../../agent/src/agent.ts) und
[Upgrade einschließlich Mobile-Runtime](../upgrade-pi-1.4.0.en.md).

**Wichtig:** Eine Anwendung wird nicht schon dadurch dauerhaft agentisch, dass sie pi-ai oder
pi-codemode verwendet. pi-ai liefert Modellaufrufe; pi-codemode liefert die Sandbox.
Erst das pi-durable-Harness übernimmt die dauerhafte Agentenausführung.

### Ausbau in drei aufeinanderfolgenden Schritten

#### Schritt 1: Rechercheläufe als Ganzes wiederaufnehmen

Die [Recherchebeispiele](../../agent/examples/research-support.ts) haben bereits persistente Agenten,
lehnen am Ausgangspunkt aber ein vorhandenes Laufverzeichnis ab. Einzelne persistente Conversations
sind noch keine sichere Wiederaufnahme des gesamten Teams.

Die Integration muss deshalb eine dauerhafte Laufidentität und Konfiguration, die bereits erzeugten
Conversations sowie die erreichte Phase festhalten. Startnachrichten und Phasenaufträge brauchen
stabile Identitäten, damit ein Absturz zwischen Wirkung und Quittung keine zweite Arbeitskette erzeugt.
Ein explizites Resume verwendet die vorhandenen IDs; abweichende Themen oder Laufarten werden
abgelehnt. Ein frischer Lauf darf keine fremden oder alten Verzeichnisse stillschweigend übernehmen.

Abnahme: Unterbrechung und Wiederöffnung, keine doppelten Teams oder Aufgaben, erneute Ausgabe eines
fertigen Berichts, abgelehnte Konfigurationskonflikte und weiterhin Fehler bei unvollständigen Phasen.

**Integriert:** [ResearchRun](../../agent/examples/research-run.ts) implementiert explizites `--resume`,
den gemeinsamen Launcher-Owner-Lock, atomar gespeicherte Team-IDs und deduplizierte Phasenübergaben.
Die [Regressionen](../../agent/test/examples/recovery.test.ts) prüfen auch SIGKILL während einer laufenden
Analyse: dieselbe Teamzuordnung vor und nach der Wiederaufnahme, die Phase nur einmal, keine übrige Aufgabe, ein Bericht. Grenzen bei abgelaufenen Space-Claims und CLI-Beispiele stehen in [examples.md](../examples.en.md).

#### Schritt 2: Längere Agentenabläufe im Codemode-Chat

Der [Modellprozess](../../codemode-chat/server/model-host.ts) besitzt schon eine dauerhafte Space-Queue:
`LlmCall` wird unter einer erneuerten Transaktion übernommen und zusammen mit `LlmResult` abgeschlossen.
Beim Prozessausfall wird der Auftrag wieder verfügbar. Die pi-durable-Anbindung ersetzt diesen Mechanismus nicht.

Die abschaltbare pi-durable-Anbindung ermöglicht mehrstufige Arbeit innerhalb eines Auftrags:
Kontext behalten, Werkzeuge verwenden und Zwischenschritte nach einem Neustart fortsetzen.
Auftragsidentität und Ergebniszuordnung bleiben im Space. Einfache Bewertungen, Abstimmungen und
einzelne Textantworten brauchen nicht automatisch eine separate dauerhafte Conversation.

Abnahme: ausgeschalteter Pfad unverändert, geskripteter mehrstufiger Agent, stabiler Request-Schlüssel
bei Wiederholung, Wiederöffnung des Agentenspeichers und Beachtung von Run-Abbruch und Budgets.

**Integriert:** [Dauerhafte Code-Beiträge](../../codemode-chat/server/durable-agent.ts) verwenden einen separaten
Agentenprozess, eine isolierte `verify_code`-Prüfung und höchstens vier Modellversuche.
Die vorhandene Space-Queue bleibt erhalten; Quoten und Budgetreservierungen werden pro Versuch geprüft.
Der Pfad ist standardmäßig aktiv, mit `CODEMODE_DURABLE_AGENT=0` abschaltbar.
Konfiguration und Grenzen: [Codemode-Architektur](../codemode-space-architektur.en.md#durable-code-agents).

#### Schritt 3: Ausgewählte Modell-NPCs

Die [NPC-Verwaltung](../../spaces-mmo/server/npc/minds.ts) speichert Rollenbesitz, Wachzustand und
Erinnerungen bereits im World-Space. Dafür allein wäre pi-durable keine Verbesserung.
Eine optionale dauerhafte Sitzung lohnt sich für ausgewählte Gesprächspartner oder Questgeber,
deren mehrstufiger Dialog und Modellkontext einen NPC-Prozess überleben sollen.

Der World-Worker bleibt für Handlungen maßgeblich: Der Agent schlägt Befehle vor; Reichweite,
Kollisionen, Eigentum, Berechtigungen und Transaktionen werden weiter von der Spielwelt geprüft.
Spielzeit und Welt-Ticks werden nicht durch die Wandzeit eines Agenten-Timers ersetzt.

Abnahme: Standardaktivierung, ausdrückliche Abschaltung oder gezielte Auswahl, Dialog nach Wiederöffnung, Trennung der
NPC-Sitzungen und unverändertes Verhalten für alle nicht ausgewählten NPCs.

**Integriert:** [Ausgewählte NPC-Dialoge](../../spaces-mmo/server/npc/durable.ts) behalten ihren Kontext in
getrennten Welt-/Rollen-Sitzungen. Budgets und Modellfreigabe bleiben im Space; alte Weltaktionen werden
nicht automatisch nachgespielt. Nach 64 Antworten wird der aktive Kontext mit der Space-Zusammenfassung
neu begonnen. Standard ist jetzt der dauerhafte Dialog für alle Modellrollen, ohne die kostenpflichtige
Modellfreigabe einzuschalten. `SPACES_MMO_DURABLE_NPCS=0` deaktiviert ihn; eine Rollenliste schränkt ihn ein.
Konfiguration, Kosten und Aufbewahrung: [Modell-NPCs](../../spaces-mmo/docs/modell-npcs.en.md#durable-dialogues).

### Grenzen der Integration

- Keine Rückkehr zu pi-durable als Space-Speicher und kein Einbau in Replikation, Fencing oder Rust-Kern.
- Keine zweite führende Kopie von Welt-, Run- oder Auftragszustand im Agentenspeicher.
- Keine stundenlang offen gehaltene Space-Transaktion während menschlicher Freigaben.
- Stabile IDs und idempotente Übergaben ersetzen keinen gemeinsamen atomaren Commit beider Speicher.
  Die Zusage stabiler IDs und idempotenter Übergaben ist für Prozessabstürze belegt; für Stromausfälle gibt es nur die VM-Nachweise zum einzelnen Speicher (Abschnitt 5.3).
- Wiederaufnahme ist an den Agentenspeicher gebunden. Jeder Codemode-model-Prozess hat seinen eigenen; übernimmt
  nach einem Ausfall ein anderer Prozess den `LlmCall` aus der Queue, fehlen ihm Conversation, Zwischenschritte
  und bisheriger Verbrauch. Der Auftrag beginnt dann neu, die Fortsetzung gilt nur beim Wiederöffnen desselben Speichers.
- Die ausgewählten NPCs behalten ihre Conversation, verwenden aber pro Modellaufruf eine zufällige
  `requestId` ([durable.ts](../../spaces-mmo/server/npc/durable.ts)). Eine Wiederholung ist dort ein neuer Dialogzug,
  anders als bei den stabilen Identitäten aus Schritt 1 und 2.
- Modellanbieter und sonstige externe Dienste garantieren nicht automatisch Exactly-once:
  Ein nach einem Absturz wiederholter Netzwerkaufruf kann erneut ausgeführt und berechnet werden.
- Live-Modellaufrufe und Deployments sind keine Offline-Abnahme und benötigen eigene Freigabe.

### Keine unzulässigen Leistungs- oder Migrationsschlüsse

Die lokalen Umstellungsdokumente enthalten Messungen des damaligen Dokumentmodells.
Sie sind **kein aktueller, kontrollierter Benchmark gegen pi-durable 1.4.0 oder dessen neuestes main**.
Neu ist nur die kleine Commit-Messung aus Abschnitt 5.3, sie ersetzt keinen Benchmark. Ein belastbarer Test müsste identische Nutzlast,
Datenträger, Sync-Einstellung, Parallelität, Claim-Aufbewahrung und Fehlerfälle verwenden.
Auf `main` wäre zusätzlich die verzögerte Fortschrittspersistenz anzugleichen.

Die Speicherdateien sind nicht austauschbar. Der heutige phi-spaces-Store weist fremde SQLite-Formate
und alte pi-durable-Replikationsjournale zurück. Entscheidung D6 sieht keinen Import alter pi-durable-
Space-Bestände vor. Das ist **keine Aufforderung, Agentenspeicher oder vorhandene Daten zu löschen**;
bei dieser Recherche wurde nichts gelöscht oder migriert. [L2, L6]

### Prüflauf

Offline-Stand vom 31.10.2026 (mobile Runtime vom 30.10.2026):

| Prüfung | Ergebnis |
|---|---|
| Kern | 606 bestanden, 1 übersprungen, Importgrenzen ohne pi-durable bestanden |
| Agentenpaket | 108 von 108 bestanden |
| Codemode-Chat | 127 von 127 bestanden; mit eingeschaltetem Agentenpfad (`test:durable`) 127 von 127, keine Abweichung |
| spaces-mmo | 177 von 177 bestanden; mit eingeschalteten Agentenpfaden (`test:durable`) 177 von 177, keine Abweichung; unter Last schlugen Tests vereinzelt durch Zeitüberschreitung fehl, auf beiden Pfaden und ohne Modell |
| Hilfeseite | 59 bestanden, 1 übersprungen |
| Mobile Runtime | 22 von 22 bestanden, spaces-mobile 6 von 6 |

`test-env.ts` beider Projekte schaltet die Agentenpfade für die allgemeinen Suiten ab. `npm run test:durable` jedes Projekts führt dieselben `tests/*.test.ts`
mit eingeschaltetem Pfad aus, immer mit Faux-Modellen ([Codemode](../../codemode-chat/tests/test-env-durable.ts), [spaces-mmo](../../spaces-mmo/tests/test-env-durable.ts)):
Das Fake des Projekts antwortet im Agent-Worker ([durable-fake-models.ts](../../agent/test/durable-fake-models.ts)), seine Szenarien laufen also durch den echten Worker, die Konversation
und den Speicher. Fake-Teams erreichen Space und Gates über eine Verbindung des Workers, der Verbrauch kommt genau durch, und ein Stopp erreicht sie als Abbruchsignal des Workers.

| Matrix | Tests | Antworten durch den Worker | Abweichungen |
|---|---|---|---|
| Codemode-Chat | 127 von 127 bestanden | 66 | keine |
| spaces-mmo | 177 von 177 bestanden | 8 | keine |

Die Abweichungslisten ([Codemode](../../codemode-chat/tests/durable-deviations.ts), [spaces-mmo](../../spaces-mmo/tests/durable-deviations.ts)) sind leer: Kein Test musste übersprungen oder geändert werden.
Der Lauf endet mit einem Fehler, wenn keine Antwort durch einen Worker ging. Was die Matrix ihrer Natur nach nicht abdeckt:

- Codemode: Nur `contribute`-Aufrufe zu Code-Aufgaben nehmen den Pfad. Textaufgaben, Kritiken, Stimmen und Richter laufen auch in der Matrix wie in den allgemeinen Suiten.
- Das angebundene Fake antwortet sofort, ohne `verify_code`-Runde. Das Sandbox-Werkzeug zwischen zwei Antworten decken [durable.test.ts](../../codemode-chat/tests/durable.test.ts) und [durable-interrupt.test.ts](../../codemode-chat/tests/durable-interrupt.test.ts) ab.
- spaces-mmo: Die meisten Tests haben kein Modell. Nur 8 Antworten liefen durch den Worker, alle in Tests, die `tests/fake-llm.ts` nennen; die übrigen der 177 zeigen nur, dass der Schalter nichts zerbricht.

Ausfälle nach der letzten Modellantwort sind jetzt ebenfalls geprüft ([durable-interrupt.test.ts](../../codemode-chat/tests/durable-interrupt.test.ts)): der Modellprozess per SIGKILL zwischen der Antwort und dem Commit von `LlmResult`
und der Agent-Worker per SIGKILL zwischen der letzten Antwort der Konversation und der gespeicherten Antwort des Auftrags. In beiden Fällen kommt die Antwort einmal an, kein Modell wird erneut gefragt und kein Versuch erneut zugelassen.
Daneben gelten die bisherigen Szenarien: ein ganzer Lauf über alle Prozesse, zwei Beiträge gleichzeitig, Abbrüche zwischen zwei Modellantworten, Neustart nach fertigem Ergebnis; beim [NPC](../../spaces-mmo/tests/durable-npcs.test.ts) Schließen, Wiederöffnen und SIGKILL nach einem Dialog.

Die Matrix fand einen Fehler, jetzt behoben: Das Scheitern eines Providers kam beim Aufrufer nur als `Agent submission unanswered` an, weil der Worker nur Ausnahmen festhielt und ein Provider sein Scheitern als Nachricht meldet. Jetzt erhält der Aufrufer die Worte des Providers.
Der Worker-Test fand einen Fehler, jetzt behoben: Nach dem Tod des Workers scheiterte jeder weitere Beitrag, bis der Modellprozess neu startete.
Der Auftrag, den der tote Worker bearbeitete, endet weiterhin mit einem Fehlerergebnis; erst ein neuer Auftrag derselben `callId` setzt fort.

Die Zulassung wird am tatsächlichen Provideraufruf erzwungen: Ausnahmen in einem pi-durable-Hook allein sind
dafür nicht ausreichend. Das ist mit gezählten tatsächlichen Faux-Provider-Aufrufen abgesichert.

Auf dem Telefon lief 1.4.0 an: Die Agentendatenbank ist auf Schema 2 migriert, ihre Integritätsprüfung bestanden.
Die Bedienoberfläche wurde dort nicht geprüft. Die Prüfläufe enthielten keine Live-Modellaufrufe.
Das alles ist keine uneingeschränkte Produktionsfreigabe.

## 10. Quellen und Nachprüfbarkeit

### Offizielle Earendil-Quellen

- **P1:** [npm-Registry von pi-durable](https://registry.npmjs.org/@earendil-works%2Fpi-durable): `dist-tags.latest`, Veröffentlichungszeit und Paketmetadaten; abgefragt am 30.10.2026.
- **P2:** [Veröffentlichtes npm-Archiv 1.4.0](https://registry.npmjs.org/@earendil-works/pi-durable/-/pi-durable-1.4.0.tgz): README, Changelog, JavaScript und Typdefinitionen; SHA-512 gegen Registry geprüft.
- **P3:** [Release-README, fest auf Release-Commit](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/README.md): Konzepte, Replay, Storage, Tools und Dokumente.
- **P4:** [Release-Changelog](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/CHANGELOG.md): Änderungen und Breaking Changes bis 1.4.0.
- **P5:** [Release-Dokumentdefinitionen](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/documents.ts) und [SQLite-Schema](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/storage/sqlite/schema.ts).
- **P6:** [Release-Session](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/session/session.ts): Commit-Serialisierung.
- **P7:** [Release-Submission-Zulassung](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/harness/submissions.ts): Request-ID-Wiederverwendung.
- **P8:** [Pi-Monorepo-README am geprüften Entwicklungsstand](https://github.com/earendil-works/pi/blob/50af8c160153e3721a18b1a046a4adf201635861/README.md): Abgrenzung der Pakete und des Gesamtprojekts.
- **P9:** [Unreleased-Changelog am geprüften main-Commit](https://github.com/earendil-works/pi/blob/50af8c160153e3721a18b1a046a4adf201635861/packages/durable/CHANGELOG.md): ausdrücklich noch nicht veröffentlichte Änderungen.
- **P10:** [StoreStorage am geprüften main-Commit](https://github.com/earendil-works/pi/blob/50af8c160153e3721a18b1a046a4adf201635861/packages/durable/src/storage/store/storage.ts): Chord-v2-Store-Anbindung.
- **P11:** [Session am geprüften main-Commit](https://github.com/earendil-works/pi/blob/50af8c160153e3721a18b1a046a4adf201635861/packages/durable/src/session/session.ts): Group Commit und deferred commits.

### Lokale phi-spaces-Quellen

- **L1:** [Kernsemantik](../../src/core.ts), [Space-Dokument und Teile](../../src/doc.ts), [öffentliche API](../api.en.md).
- **L2:** [Host](../../src/store/host.ts), [Store-Typen](../../src/store/types.ts), [Dokumentdefinitionen](../../src/store/documents.ts), [SQLite](../../src/store/sqlite.ts), [Schreibthread](../../src/store/sqlite-writer.ts), [DiskMap](../../src/store/disk-map.ts).
- **L3:** [Standalone-Dienst](../../src/standalone.ts), [Dienst](../../src/service.ts), [Remote-Client](../../src/remote.ts), [pi-server-Adapter](../../src/pi-server.ts), [Standalone-Regressionen](../../test/test-standalone.test.ts).
- **L4:** [Claims](../../src/claims.ts), [lokaler Client](../../src/client.ts), [Mailbox](../../src/mailbox.ts), [Changes](../../src/stream.ts).
- **L5:** [Agentenanbindung](../../agent/src/agent.ts), [Agent-Paket](../../agent/package.json), [Agent-Lockfile](../../agent/package-lock.json), [Integrationsregressionen](../../agent/test/agent.test.ts).
- **L6:** [Umstellung einschließlich späterer U2-/U6-/U4-Stände](../umstellung-ohne-pi-durable.en.md), [Bestandsaufnahme und Entscheidung D6](../umstellung-u0-bestand.en.md), [Rust-Portierungsplan](../rust-portierung.en.md).
- **L7:** [Federationslaufzeit](../../src/runtime.ts), [Gate](../../src/gate.ts), [Auth](../../src/auth.ts), [Replikationskontrolle](../../src/replica-control.ts), [Föderationsplan](../federation-plan-v3.en.md), [Phasenabnahmen](../implementierungsstand.en.md).

**Nachweisgrenze:** Die ursprüngliche Upstream-Recherche war quellenbasiert; der damalige lokale
1.0.3-Bestand war kein Kompatibilitätsnachweis für 1.4.0. Anschließend wurden die Release-Pakete auf 1.4.0
aktualisiert und die hier beschriebenen lokalen Integrationen offline geprüft (Abschnitt 9).
Das ersetzt weder Earendils vollständige Testmatrix noch Live-Qualitäts-, Leistungs- oder Migrationsprüfungen.
Der neuere `main` wurde weiterhin nicht installiert oder ausgeführt.
