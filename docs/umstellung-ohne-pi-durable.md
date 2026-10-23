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

**Stand U2 (2026-10-22):**

- **Eigener Host** `src/store/host.ts`:
  - Commits laufen nacheinander auf Entwürfen mit Kopieren beim Schreiben (`src/store/draft.ts`).
  - Der nächste Commit darf beginnen, während der vorige noch geschrieben wird. Bestätigt wird er erst, wenn er
    dauerhaft ist; Snapshots und Watches sehen nur dauerhafte Stände.
  - Scheitert ein Schreiben, sperrt sich der Host.
- **Teile** der beiden Space-Dokumente (`SPACE_PARTS`: Einträge, Claims, Generationen, Verlaufs-Batches):
  - Ihre Datensätze sind Werte. Der Host friert neue beim Veröffentlichen ein, und der Kern ersetzt sie statt sie zu
    ändern (`setEntry`, `decide`, `sweep`, Markierung verwaister Claims).
  - Array-Teile werden beim ersten Schreiben flach kopiert, und ihre Methoden laufen ohne Proxy.
  - Tabellen-Teile werden in place mit Rückgängig-Protokoll geändert.
- **SQLite-Speicher** `src/store/sqlite.ts`:
  - Tabellen `store_meta`, `documents` (ganzer Wert bzw. Kopf), `parts` (eine Zeile je Datensatz, mit Ordnung) und
    `migration_runs`.
  - Ein Schreib-Thread (`src/store/sqlite-writer.ts`) schreibt gebündelt, Standard `synchronous=FULL`.
  - Owner-Lock über eine gehaltene exklusive Sperre auf `<Datei>.owner`.
  - Eine neuere Formatversion wird abgewiesen; Kennzahlen über `stats()`.
- **Claims-Bereinigung:** Sie sucht nur, wenn etwas fällig sein kann (`rpc.sweepAt`). Das wirkt auch mit pi-durable.
- **Tests:** `PHI_SPACES_STORE=own|own-sqlite` lässt die Root-Suite auf dem eigenen Speicher laufen; bisher nutzen 16
  Testdateien die Fixture. Dazu kommt `test/test-own-store.test.ts`: Wiederöffnen, Owner-Lock, Formatprüfung,
  Bündelung.
- **Messungen** (10.000 Einträge, 150.000 Claims, voller Verlauf):

  | Messung | Ergebnis |
  |---|---|
  | Kernoperation, vorher (jede Operation durchsuchte alle Claims) | 542 ms je Commit |
  | Kernoperation, jetzt | 0,2 ms je Commit |
  | Commit über den Entwurf | p50 1,2 ms, p95 3,7 ms (Ziel p95 ≤ 5 ms erfüllt); Speicher 237 MB |
  | pi-durable zum Vergleich, nur 10.000 Einträge | 51 ms je Commit |

- **Durchsatz mit FULL** (1.000 Commits, 32 gleichzeitige Schreiber):

  | Datenträger | Commits/s | p50 | p95 | Ziel (≥ 300/s, p95 ≤ 50 ms) |
  |---|---|---|---|---|
  | NVMe-SSD | 1.131 | 27,6 ms | 35,8 ms | erfüllt |
  | RAID1 aus 5.400-U/min-Festplatten (SMR) | 249 | 119 ms | 203 ms | nicht erfüllt |
  | NVMe-SSD, NORMAL zum Vergleich | 1.624 | 18,7 ms | 32,0 ms | |

  Auf drehenden Platten kostet ein `fsync` 30–40 ms. Das Ziel ist dort mit FULL nicht erreichbar, unabhängig von der
  Software; für den Betrieb gehört der Speicher auf eine SSD.
- **Offen in U2:**
  - weitere Tests auf die Fixture umstellen;
  - die persistenten Tests (`test/support/persistent.ts`) für den eigenen Speicher nachbilden;
  - Zähler statt Vollscan für offene Claims je Absender (`client.ts`);

**Stand U2c (2026-10-22):**

- **Absturztests** (`test/test-own-store.test.ts`): Ein Kindprozess schreibt Paare von Einträgen und wird hart beendet
  (SIGKILL):
  - zu sechs verschiedenen Zeitpunkten nacheinander auf derselben Datei: jeder bestätigte Commit ist danach da, nie nur
    ein halber;
  - unmittelbar vor dem SQL-`COMMIT` eines Bündels: auf der Platte steht genau das Bestätigte;
  - unmittelbar nach dem `COMMIT`, vor der Antwort: die Commits sind da, aber unbestätigt.

  Die Haltepunkte setzt nur ein Testschalter des Schreib-Threads (`PHI_SPACES_WRITER_PAUSE`).
- **Fremde Dateien:** Eine SQLite-Datei ohne `store_meta` (etwa ein pi-durable-Speicher) wird abgewiesen, nicht
  übernommen. Ihr Import ist U5.
- **Chat auf dem eigenen Speicher:** `codemode-chat/server/space-host.ts` öffnet `openSqliteHost` (Tests:
  `openOwnMemoryHost`). Die Datei heißt jetzt `codemode-space.sqlite`, damit eine alte pi-durable-Datei nicht im Weg
  liegt. Die Sicherung mit `VACUUM INTO` läuft unverändert, auch während der Space schreibt.
- **Lastprobe** in der lokalen Testumgebung (big und nano in Docker, ohne Modell):
  - 200 Einreichungen über 5 Räume, im Takt der Web-Kontingente: alle angenommen (p50 30 ms, p95 206 ms) und alle
    bewertet (big 134, nano 66).
  - Danach im Leerlauf: 23.800 Claims pro Stunde (`txn.begin`, `take`, `txn.abort` je rund 1,9 pro Sekunde, dazu
    `lease.renew`). Das sind etwa zehn wartende Schleifen der Rollen mit je 5 s Wartezeit, rund fünfmal so viel wie bei
    der Erhebung in U0 (4.750 pro Stunde).
- **Gefunden und behoben** (gemessen auf einer Kopie des Live-Speichers, 11.700 Claims, 13.600 Verlaufs-Batches):

  | Ursache | vorher | nachher |
  |---|---|---|
  | `nextExpiry` (vor jeder Operation) ging alle Claims durch und kopierte je Claim die Grenzwerte; jetzt gilt `rpc.sweepAt` | 116 ms je Schreiben + Nehmen | 17,6 ms |
  | `partChanges` verglich jeden Array-Teil ganz über Ids (13.600 Batches für einen angehängten); jetzt Vergleich über Objektidentität nebeneinander, der volle Vergleich nur bei Verschiebungen und Einfügungen | 17,6 ms | 2,1 ms (p95 3,7 ms) |

  Vorher kostete der Leerlauf den Space-Prozess 28–78 % einer CPU, und Lesezugriffe wurden von 3 ms auf bis zu 360 ms
  langsamer. Ein Zufallstest prüft, dass die Zeilen eines Array-Teils das Array nach jeder Art von Änderung genau
  wiedergeben.
- **Entscheidung (2026-10-22):** beides, zuerst die Claims auf der Platte. Ausgangslage: Bei 23.800 Claims pro Stunde
  und 24 h Aufbewahrung (D4) wären es rund 570.000 Claims mit etwa 240 MB. Die Grenze von 32 MiB wäre nach etwa drei
  Stunden erreicht, und alle Claims lägen im Arbeitsspeicher.

**Stand U2d: Claims auf der Platte (2026-10-22)**

- **Teil auf der Platte:** `rpc.claims` ist in `SPACE_PARTS` als `disk` erklärt (`src/store/disk-map.ts`).
  - Für den Kern bleibt es ein Objekt mit Claims nach Schlüssel; ein Claim wird erst gelesen, wenn er gefragt ist.
  - Im Speicher liegen nur die offenen Claims (ohne `decidedAt`) und, bis ihr Commit dauerhaft ist, was Commits
    geschrieben oder gelöscht haben. So sehen überlappende Commits einander, und ein gescheiterter Commit nimmt seine
    Änderungen über dieselbe Ablage zurück.
  - Ein Space, der in diesem Prozess neu entsteht, legt seine Claims mit dem ersten Commit auf die Platte.
- **Fragen ohne Scan** (`DISK_MAP`, `src/store/types.ts`), beantwortet über Indexspalten `at`, `grp`, `flag` der
  Tabelle `parts`:
  - fällige Claims für den Sweep, in Schlüsselreihenfolge und begrenzt;
  - nächster Fälligkeitszeitpunkt;
  - ob eine Generation noch Claims hat;
  - die offenen Claims (`pendingClaims` in `src/claims.ts`, auch für die Grenzen je Absender in `client.ts`, die
    bisher alle Claims durchsuchten).

  Ein Map-Teil im Speicher (pi-durable, eigener Host im Speicher) beantwortet dieselben Fragen weiter durch Scannen.
- **Strenger Modus:** In den Tests wirft das Aufzählen der Claims auf der Platte (`strictDiskMaps`), so dass ein
  versehentlicher Vollscan auffällt. Das fand den Abschluss eines Entwurfs, die Statistik und einen Test, der absichtlich
  alles liest (jetzt über `entries()`).
- **Format 2** der SQLite-Datei: die Indexspalten; eine Datei im Format 1 wird beim Öffnen umgestellt und je Teil
  einmal nachindiziert (getestet).
- **Zwei ältere Fehler im Sweep**, die bei allen Speichern auftraten:
  - Eine Generation, die nicht mehr zulässt, aber noch Claims hat, setzte den nächsten Sweep auf ihren vergangenen
    `admitUntil`. Dann war bei jeder Operation ein Sweep fällig, der nichts fand. Im Chat trifft das jede Generation
    nach einer Stunde.
  - Ein abgebrochener Sweep (mehr als 256 fällige Claims, etwa nach einer Pause) löschte `sweepAt`, so dass jede
    folgende Operation alle Claims durchsuchte; jetzt bleibt er fällig und arbeitet in Schritten weiter. Die Wartung
    erkennt Fortschritt jetzt auch an den Bytes der Claims.
- **Grenzen (D5):** Der Chat setzt für seinen Speicher auf der Platte `maxClaimBytes` 512 MiB und `maxDocBytes`
  640 MiB, das Doppelte eines gemessenen Tages. Die Standardwerte bleiben für Spaces im Speicher.
- **Messung** mit 600.000 entschiedenen Claims über 24 h verteilt, 10 Minuten davon (4.264 Claims) sofort fällig, dann
  2.000-mal Claim plus Schreiben plus Nehmen:

  | Messung | Ergebnis | Ziel (D2) |
  |---|---|---|
  | Öffnen bis bereit | 376 ms | ≤ 2 s |
  | RSS nach Öffnen / nach der Last | 161 MB / 220 MB | ≤ 300 MB |
  | je Operation p50 / p95 / p99 | 1,5 / 3,1 / 4,6 ms | p95 ≤ 5 ms |
  | Rückstand | in Schritten abgeräumt | |

- **Weniger Leerlauf-Claims im Chat:** Die Rollen warten ohne Transaktion auf Arbeit (`awaitWork`, siehe
  [codemode-space-architektur.md](codemode-space-architektur.md)). Gemessen mit dem Stack der Testumgebung als
  lokale Prozesse (Space auf SQLite, Web, Judges big und nano, agents, model), 5 Minuten Leerlauf: 3.480 statt 23.800
  Claims pro Stunde, also rund 84.000 je Tag (Kapazitätswert D2: 150.000).
- **Abfragen ohne Commit (2026-10-23):** In der Docker-Testumgebung brauchte der Space-Prozess im Leerlauf weiter
  40–46 % CPU. Ursache: Der Dienst fragt jeden wartenden Aufruf alle 50 ms ab, und jede Abfrage eines offenen Aufrufs
  lief als Commit mit vollem Settle, das jeden Warter mit jedem Eintrag abglich. Ein offener Aufruf wird aber im Commit
  entschieden, der seinen Eintrag sichtbar macht; eine Abfrage braucht nur dann einen Commit, wenn etwas zeitlich fällig
  ist (`needsMaintenance`) oder die Berechtigung seines Warters verlängert würde. Sonst liest sie nur. Nachbau der
  Testumgebung auf einer Kopie ihres Speichers, 90 s Leerlauf: Space-Prozess vorher
  52 %, nachher 2,8 % beschäftigt. Der Fehler bestand schon vor der Umstellung. In der Docker-Testumgebung (neu
  gebaut, mit 53.000 Claims aus der Nacht): Space-Prozess im Leerlauf 1–6 % CPU, 110 MB Speicher, 296 neue Claims in
  5 Minuten (rund 3.550 pro Stunde).
- **Beobachtung offen:** Der Chat-Test „a person's thumbs-up counts as earlier material …“ lief nach der Umstellung in
  zwei von acht vollen Läufen in die 60-s-Frist des zweiten Board-Laufs, allein (auch unter voller CPU-Last) nie. Ein
  Zusammenhang mit dem Warten ohne Transaktion ist nicht belegt; `boardRun` gibt bei einem Zeitablauf jetzt den Stand
  des Laufs aus, damit der nächste Fehlschlag die Ursache zeigt.

**Stand U3 (2026-10-23):**

- **Eigenständiger Dienst** `src/standalone.ts` (`npm run space-server -- --store FILE|memory --listen unix:…|tcp:…`):
  eigener Speicher (SQLite oder Arbeitsspeicher), `SpaceService` über Unix-Socket oder TCP, Hintergrundarbeit
  (`startService`: Fristen, Leases, Zustellung); jede Verbindung ist ein Peer mit der Rolle `member`.
- **Beispiele:** Sieb und Cache laufen ohne `Harness`/pi-durable auf dem eigenen Speicher. Mit `--remote` laufen sie
  über den Dienst:
  - Das Sieb legt dann alle Aufgaben samt `SieveRun`-Marke in einer Transaktion an: ganz oder gar nicht, und eine
    Wiederholung schreibt nichts.
  - Der Cache (`RemoteCache`) unterscheidet einen gehaltenen Schlüssel von einem fehlenden über `takeIfExists` mit
    Wartezeit. Versionen vergibt er aus einem Zähler je Namensraum. Neue Schlüssel und den ersten Zähler schreibt er
    `unique`.
- **Nachweis** `test/test-standalone.test.ts`: Dienst und Beispiele laufen als Prozesse unter `test/support/no-durable.mjs`,
  einem Loader-Hook, der pi-durable, chord und pi-ai verweigert (eine Gegenprobe zeigt, dass er greift).
  - Sieb und Cache über Unix-Socket (SQLite) und TCP (Arbeitsspeicher) liefern dasselbe wie im Prozess.
  - Harter Neustart (SIGKILL) des Dienstes auf SQLite:
    - ein wartendes `take` bekommt den Eintrag, der nach dem Neustart geschrieben wird, genau einmal;
    - ein `take`, dessen Frist während des Ausfalls abläuft, endet mit `null`, ohne zu hängen;
    - ein entschiedenes `write` liefert bei Wiederholung dasselbe Ergebnis ohne zweiten Eintrag.
  - Ein Worker, der mit einer Siebaufgabe stirbt: Seine Transaktion läuft auf dem Dienst ab, ein anderer Worker
    erledigt die Aufgabe.
- **Meter, Reaper, Mailboxen, Fanout/Release** laufen im selben `startService`; die Root-Suite deckt sie auf
  `PHI_SPACES_STORE=own-sqlite` ab.
- **Rest bis U4:** Statisch hängen `src/index.ts` und damit die Beispiele noch über den dynamischen Import in
  `primary-sync.ts` und die Typen der Primary/Sync-Replikation an pi-durable (siehe U1). Zur Laufzeit lädt der Dienst es
  nicht. Direkte Importe in den Beispielen: 11 statt 13 (`scripts/durable-imports.mjs`).

**Entscheidung D6 (2026-10-23):** Alte pi-durable-Bestände werden verworfen ([umstellung-u0-bestand.md](umstellung-u0-bestand.md)).
U5 entfällt. Es folgen U6 bis U8: Agent-Paket, pi-durable aus Hauptpaket und Tests, Betriebsabnahme.

**Stand U8, Schritt 1 (2026-10-23): Tests nur noch auf dem eigenen Speicher.**

- **Testhilfen:**
  - `test/support/persistent.ts` kennt nur noch `own-sqlite`. Fehlerprädikate sehen eine `FaultBatch`:
    - `ops`: die Zeilen des Stapels;
    - `changes`: je Dokument die geänderten Felder auf oberster Ebene, je Teil der Datensatz.
  - `faults.observe` zeigt die Zeilen jedes Commits; die Messungen der Commit-Größe nutzen es.
  - `test/support/host.ts`: `own-sqlite` (streng) ist der Standard, `PHI_SPACES_STORE=own` hält den Speicher im
    Speicher.
- **Entfernte Tests:** Tests, die nur pi-durable selbst prüften, sind entfernt:
  - Basis alle 500 Deltas;
  - Revisionshistorie in `document_revisions`;
  - das Agenten-Replay in test-persistence.
- **Integrationstests geteilt:**
  - `test/integration.test.ts`: Space-Tests auf dem eigenen Speicher.
  - `test/agent-integration.test.ts`: Agenten-, Werkzeug- und Zustelltests. Sie laufen bis U6 auf pi-durable und
    ziehen dann ins Agent-Paket.
- **Inspektor:** Der Testbed-Inspektor (TUI) liest eigene SQLite-Speicher aus einer privaten Sicherungskopie. Die
  Besitzersperre bleibt beim Daemon.
- **Zwei Fehler im eigenen Speicher gefunden** (bisher liefen die Tests dafür auf pi-durable):
  - **Geschlossener, fehlgeschlagener Speicher:** Er wartete auf seinen Schreiber und hielt so die Besitzersperre. Jetzt
    beendet `close` den Schreiber sofort, wie ein beendeter Prozess.
  - **`SyncSpace`-Schließen:** `close` und ein neues `serve` warteten nicht auf ein laufendes `unserve` des
    Sealed-Resolvers. Das neue Öffnen fand deshalb den Speicher noch gesperrt.
- **Lesen während eines versiegelten Commits:** Ein Lesezugriff zeigt nie einen Commit, den der Standby noch nicht
  bestätigt hat. Der Test prüft genau diese Eigenschaft statt eines festen Zählerstands.

**Stand U8, Schritt 2 (2026-10-23): pi-durable aus `src`, außer der Agentenseite.**

- **Primary/Sync:** nur noch der eigene Speicher.
  - `primarySyncStorage`, `captureStore`, `bootstrapPrimarySync` und die Werkzeuge nehmen einen `SyncStore`.
  - Der Proxy um pi-durables Storage, `store/legacy-sync.ts` und die Basis-Obergrenze für pi-durable sind entfernt.
  - Ein Journal eines pi-durable-Speichers wird mit `PrimarySyncBlocked` abgewiesen. Das gilt für ein gespeichertes
    Format `pi-durable` und für Einträge aus der Zeit, bevor das Format gespeichert wurde (Test in
    test-primary-sync).
- **`openSyncSpace`:** Ohne Fabriken öffnet es den eigenen Speicher.
- **Weitere Entfernungen:**
  - `store/legacy.ts`; das Dashboard öffnet den eigenen Speicher;
  - die pi-durable-Hälfte von `compactErasedSqlite`;
  - `scripts/migrate-namespace.mjs` mit seinem Test;
  - die ungenutzte Tabelle `migration_runs`.
- **`src/index.ts`** exportiert den eigenen Speicher:
  - `openSqliteHost`, `openOwnMemoryHost`, `OwnStoreHost`, `StoreUnavailable`;
  - `OwnSyncStore`, `ReplicatedOwnStore`, `OWN_SYNC_FACTORIES`.
- **Schreib-Thread als Eval-Worker:** Er entsteht aus dem Quelltext seiner Funktionen. So läuft der eigene Speicher
  auch aus einem Bundle (mobile Laufzeit, Testbed-Artefakte). Vorher verwies das Bundle auf eine
  `sqlite-writer.ts`, die nicht mitgeliefert wurde.
- **Testbed:** Der Daemon (`federation-host.ts`) und die Szenarien `phase3-sync-node` und `sieve-mobile` laufen auf
  dem eigenen Speicher.
- **Wächter:** `npm run check:durable` (`scripts/durable-imports.mjs --check`) läuft vor `npm test`. Er schlägt fehl,
  wenn eine Datei außerhalb der Erlaubnisliste pi-durable, chord oder pi-ai erreicht, direkt oder über ihre Importe.
  - pi-ai allein ist in `codemode-chat/` erlaubt.
  - Die Liste schrumpft mit U6 und den Werkzeugen.
- **Nachweis:** Die Root-Suite ohne `agent-integration` läuft mit `NODE_OPTIONS=--import=./test/support/no-durable.mjs`.
  - Bis auf die zwei Tests der nativen pi-server-Abnahme (`test-pi-server`) ist sie grün.
  - Diese zwei Tests prüfen die mobile Agentenlaufzeit; sie folgen mit U6.
- **Bleibt bis U6:**
  - `src/agent.ts` und `src/with-agent.ts`;
  - die `definition`-Brücke in `store/documents.ts`, über die pi-durables Harness dieselben Dokumente bedient.
  - Auf dem Telefon bedient `pi-serverd` seinen Space weiter über den Harness der Agentensitzungen.

**Stand U6 (2026-10-23): Agent-Paket.**

- **Paket `agent/`** mit eigenen Abhängigkeiten (pi-durable, chord, pi-ai, exakt auf die Versionen der Wurzel gepinnt;
  das Lockfile ist aus dem der Wurzel abgeleitet und enthält dieselben Versionen):
  - `src/agent.ts`: die Space-Werkzeuge;
  - `src/with-agent.ts`: Einstieg des Mobil-Bundles;
  - `src/live-models.ts`, `examples/`, `test/`.
  - Die Wurzel kennt pi-durable nicht mehr. Der Wächter `npm run check:durable` prüft das, auch quer in `agent/`.
- **Der Space ist ein eigener Host** (der eigene Speicher), nicht der Speicher der Agenten.
  - Jeder Werkzeugaufruf bekommt eine Request-Identität des Spaces: die Generation der Conversation und die Task-ID
    des Aufrufs. Sie wird vor dem ersten Space-Aufruf als Memo im Agentenspeicher festgehalten.
  - Der Space hält Operation und Ergebnis zusammen. Ein nach einem Absturz wiederholter Aufruf erhält das erste
    Ergebnis (Test: Agentenspeicher JSONL, Space SQLite; eine zufällige Request-ID je Ausführung lässt ihn
    scheitern).
  - Blockierende Aufrufe behalten ihre erste Frist im Claim des Spaces.
  - Die frühere Atomarität mit dem Harness-Commit (`Once`) gibt es für Agenten nicht mehr. Das ist der API-Bruch aus
    Abschnitt 6, ausdrücklich so beschlossen.
- **Zustellung** (`deliverEvents`): `withEventSink(host, sink)` koppelt die Conversations eines Agentenhosts an den Space.
  - Ohne verbundenen Agentenhost warten Ereignisse im Postausgang. Nichts wird verworfen oder freigegeben.
  - Für eine nicht mehr existierende Conversation oder eine abgelaufene Reservierung wird verworfen.
  - Tests ohne Agent in der Wurzel; mit Agent in `agent/test`.
- **Dokumentenbrücke entfernt:** Der Harness bedient keine Space-Dokumente mehr. `definition` und `checkpointWhen` sind
  aus `store/` raus.
- **Mobile Laufzeit** (`../pi-termux-mobile`, lokal geändert, nicht eingecheckt):
  - `pi-serverd.mjs` öffnet den Space in `space.sqlite` (eigener Speicher), getrennt von `harness.sqlite`;
  - `common.mjs` exportiert `createSpaces`, `localSpaces`, `openSqliteHost`, `withEventSink`;
  - Abnahme: der gebaute Bundle läuft im echten `pi-serverd` (Test `agent/test/pi-server.test.ts`), der Space
    überlebt den Daemon; die 20 Tests der Laufzeit sind grün.
  - Nicht belegt: `node:sqlite` und `worker_threads` auf dem Gerät (Android/Termux). Das braucht einen Gerätelauf.
- **Werkzeuge und Testbed** laufen auf dem eigenen Speicher: Beispiele, Hilfeseite (Server, Beispiele, Tests,
  Korpus), `federation-host`, Szenarien, Audits (`test/testbed/read-store.ts`). Die Testbed-Szenarien mit
  `SIGKILL` (`phase2-process-crashes`) laufen lokal: 10 von 10 Fällen.
- **U8, Paketgrenze:** Die Wurzel hängt nur noch von `pi-codemode` ab (Beispiel `codemode-evolve`). pi-durable, chord
  und pi-ai sind aus `package.json` und Lockfile der Wurzel raus; `codemode-chat` nennt `pi-codemode` selbst.
  - Die Docker-Images von Chat und Hilfeseite installieren die Abhängigkeiten des Agent-Pakets mit (für
    `agent/src/live-models.ts`, also pi-ai). **Nicht gebaut/geprüft:** die Image-Builds laufen nicht lokal.
  - Alle Suiten nach dem Entfernen: Wurzel 572/573 (1 übersprungen), Beispiele 84, Agent 89, Chat 112,
    Hilfeseite 52/53 (1 übersprungen).
- **Testbed auf `big` (2026-10-23, mit Freigabe):** Die Artefakte (kein pi-durable darin) wurden gebaut, verschickt und der
  `runner` neu erzeugt. `test all` ist grün:
  - Smoke: 0 TypeScript-Dateien im Image und auf dem Server;
  - Beispiele `sensor-pipeline`, `cache`, `sieve`, `golomb`;
  - `sieve-mobile` und `sieve-remote --kill-host` mit echtem SIGKILL.
  - Die Liste in `testbed.sh` folgt den verschobenen Beispielen.
  - **Nicht angefasst:** die Föderations- und Overlay-Container (`host-a/b`, `member-1/2`, `nb-*`, seit 5 Tagen mit dem
    alten Image). `destroy` würde auch die NetBird-Peer-Anmeldungen der `nb-*`-Volumes löschen. Ihre alten Stores
    werden vom neuen Code abgewiesen (D6). Neuaufbau (`destroy --yes`, `up federation`, `netbird setup`): eigene Freigabe.
- **U7, erste Messung (D2-Kapazität), `scripts/capacity-probe.ts`:** 20 benannte Spaces mit je 10 000 Einträgen (je
  ca. 130 Byte Nutzlast) in einem Speicher:
  - Schreiben: 352 s (200 000 Einträge, 500 parallele `write`);
  - Datei: 265 MB;
  - Öffnen des Speichers: 48 ms (Budget ≤ 2 s: erfüllt);
  - alle 20 Spaces einmal anfassen: 4,5 s; **RSS 386 MB, Heap 259 MB**.
  - **Budget nicht erfüllt:** Das Profil sind 100 Spaces zu 10 000 Einträgen bei ≤ 300 MB RSS. Der Host hält jedes
    einmal geladene Dokument für immer im Speicher (`#docs`), also rund 13 MB je angefasstem 10k-Space und hochgerechnet
    über 1 GB für 100. Bleiben die Spaces kalt, ist das kein Problem; das Budget gilt aber für das Profil.
  - **Nächster Schritt (nicht begonnen):** ein Speicherbudget für geladene Dokumente, das kalte Dokumente ohne
    Beobachter, Entwurf und ausstehende Schreibung verdrängt. Das berührt `OwnStoreHost` und braucht eine
    Entscheidung zur Verdrängungsregel.
- **Bleibt:** U7 (Rest: Plattenvoll, Backup/Restore, Entry-Match-Index, Dauerlast) und die Betriebsprobe der Föderation
  auf `big`.

**Stand U4 (2026-10-23):**

- **Primary/Sync auf dem eigenen Speicher:**
  - **Journal hinter einer Speicher-Schnittstelle** (`src/store/sync-store.ts`): Hash-Kette, Konfigurationsschritte,
    Fencing und der eine offene Kandidat bleiben ein Code-Pfad (`src/primary-sync.ts`). Ein Speicher bringt die Form
    seiner Schreibvorgänge (Codec), die Marke, atomares Anwenden, `capture` und die Leerprüfung mit.
  - **pi-durable** ist ein solcher Speicher (`src/store/legacy-sync.ts`), der eigene SQLite-Speicher der andere
    (`src/store/sync-sqlite.ts`, Codec `src/store/own-sync-codec.ts`).
  - **Formatbindung:** Ein leeres Journal bindet sich beim ersten Gebrauch an eine Speicherart, an den Speicher, den es
    antreibt, oder an die Marke des ersten angenommenen Eintrags. Ein Journal mit älteren Einträgen gilt als
    pi-durable. Ein Journal der anderen Art wird abgewiesen; replizierte Bestände zieht U5 um.
- **Der eigene Primary:**
  - Ablauf je Bündel: versiegeln, bei `sync` auf den Standby warten, Zeilen und Marke (`store_meta`) in einer
    SQL-Transaktion schreiben, erst dann bestätigen. Es ist immer nur ein Bündel unterwegs, geschnitten an der Größe
    eines Journaleintrags.
  - Ein Fehler nach dem Versiegeln ist `CommitSealed`. Danach nimmt der Speicher nichts mehr an, bis er wieder
    geöffnet und der Kandidat aufgelöst ist.
  - Das Budget des Journals prüft `Ledger.prepare` vor der Veröffentlichung. Eine Ablehnung hinterlässt keine Spur
    (Entwurf, Reihenfolgen und Claim-Überlagerung werden zurückgenommen), und der Host bleibt nutzbar.
  - Das Anwenden auf eine gestoppte Datei (Standby, Wiederherstellung, Bootstrap) und der Schreib-Thread nutzen
    dieselben Zeilen (`src/store/sqlite-ops.ts`).
- **Fabriken:** `sync-spaces` und `configured-runtime` nehmen beide Speicherarten; ohne Fabriken des Daemons gilt der
  eigene Speicher (`OWN_SYNC_FACTORIES`). Der Testbed-Daemon auf `big` bleibt ausdrücklich bei pi-durable, bis U5 seine
  replizierten Bestände umzieht.
- **Nachweis:** `test/support/persistent.ts` hat own-sqlite als drittes Backend.
  - Mit eigener Fehlerinjektion: „vor dem Commit“ und „Antwort verloren“.
  - Die Prädikate der Tests sehen die Zeilen des eigenen Speichers als geänderte Dokumente.
  - Ein abgestürzter Host gibt seinen Owner-Lock frei.

  Damit laufen auf dem eigenen Speicher dieselben Tests wie auf pi-durable: Primary/Sync, Replica-Control (Promotion,
  degradeToSingle, setStandby), Bootstrap, CommitSealed, NotCommitted, Degrade/Revoke, Configured Root, Router,
  Delegation, föderierter Space, Restore, Erasure, Deployment, Run-Recovery. Root-Suite: 996 von 997 (einer
  übersprungen wie bisher).
- **Snapshot-Verdrängung (behoben, 2026-10-23):** Der Chat-Test „code full of control characters …“ scheiterte in etwa
  einem von fünf Läufen, schon vor U4. Der Web-Teil liest einen Raum über ein seitenweises Snapshot; laufende
  Beobachter erzeugten währenddessen neue, und der Space verdrängte bei mehr als 16 den ältesten, also den gerade
  gelesenen. Jetzt gehen zuerst Snapshots, die bis zum Ende gelesen sind, dann der am längsten nicht benutzte (jede
  Seite zählt als Benutzung). Ein Test liest einen Snapshot seitenweise, während zehn andere entstehen und gelesen
  werden; der Chat-Test lief danach 8 von 8.
- **Prüfung nach der Prüfung:**
  - Ein abgewiesener Eintrag bindet ein leeres Standby-Journal nicht mehr; die Bindung wird in derselben Transaktion
    wie der erste angenommene Eintrag geschrieben.
  - Das Gate zieht beim Versiegeln genau die zugelassenen Bytes ab, sonst wäre das Budget unter Bündelung langsam
    vollgelaufen.
  - Die Fehlerprädikate sehen bei einem Dokumentkopf nur die geänderten Felder, wie bei pi-durable. Mit `FAULT_LOG=1`
    verglichen, greifen die Fehler im föderierten Space auf beiden Speichern an denselben Commits.
- **Was der eigene Speicher dabei gezeigt hat** (behoben, mit Tests):
  - Entwürfe wurden einzeln abgeschlossen und sofort widerrufen; ein Wert, der von einem Dokument in ein anderes
    wanderte, traf einen widerrufenen Proxy.
  - Ein in diesem Commit zugewiesenes Objekt, das über den Entwurf wieder gelesen wurde, kam mit Entwürfen darin
    zurück.
  - Ein Entwurf über einem eingefrorenen Wert (ein Datensatz eines Teils in einem anderen Dokument) verletzte eine
    Proxy-Invariante; er nutzt jetzt ein leeres Stellvertreter-Ziel.
  - `setMetadata` änderte einen Claim in place, statt ihn zu ersetzen.
  - Ein frischer `rpc`-Zustand hatte kein `sweepAt` und löste einen unnötigen Wartungs-Commit aus.
  - Ein Teil, der im Kopf eines Dokuments stand (geschrieben, bevor die Definition Teile hatte), ging beim Laden
    verloren; jetzt bleibt er erhalten und wird mit dem nächsten Commit als Zeilen geschrieben.
  - Bei einer verlorenen Antwort wurden die Commits des Bündels nie abgeschlossen.
- **Offen:**
  - ~~Drei seltene Verwaltungswege lesen je Schritt alle Claims~~ (erledigt, 2026-10-23): Restore, Markieren beim
    Mitgliederwechsel und Löschen nach Principal gehen über einen Schlüssel-Cursor (`DISK_MAP.page`), der im
    Restore-, Übergangs- bzw. Befehlszustand steht. Jeder Schritt setzt hinter dem zuletzt bearbeiteten Claim fort,
    statt von vorn zu suchen. Ein Test läuft seitenweise durch eine Claim-Map, während überlappende Commits Claims
    löschen und hinzufügen. Ein Zustand aus der Zeit vor der Byte-Bilanz (`rpc.bytes` fehlt) wird weiterhin einmal
    komplett nachgezählt.
  - ~~`restoredClaims` im Kopf des Space-Dokuments~~ (erledigt, 2026-10-23): Die historischen Claims nach einem Restore
    sind ein Teil auf der Platte wie `rpc.claims`.
    - Ihre Bytes führt die Bilanz `restoredBytes`; `claimBytes` zählt sie also nicht bei jeder Zulassung neu.
    - Restore, Mitgliederwechsel und Löschen gehen mit Schlüssel-Cursor durch sie (`claimPage`).
    - Ein markierter Claim wird ersetzt statt geändert.
  - Strenger Lauf der ganzen Root-Suite (`PHI_SPACES_STRICT_DISK_MAPS=1 npm test`): Außer den genannten Wegen zählt
    nur Testcode Claims auf, der Snapshots absichtlich ganz serialisiert oder vergleicht. Behoben wurden dabei:
    - die Vorprüfung einer Schlüsselrotation, die den ganzen Control-Space kopierte (`core.previewOf`);
    - die Prüfung gegen `maxDocBytes` beim Löschen (`core.docBytes`);
    - das Ersetzen einer ganzen Claim-Map auf der Platte, jetzt ein Vorgang `partClear`.
  - ~~Wartung eines gestoppten Speichers~~ (erledigt, 2026-10-23): `compactErasedSqlite` erkennt den eigenen Speicher
    und gibt ihn an `src/store/erasure-own.ts` weiter. Das läuft unter Owner-Lock und Fencing-Prüfung: WAL leeren,
    `VACUUM` mit `secure_delete`, WAL noch einmal leeren, Integritätsprüfung.
    - Revisionen gibt es hier keine.
    - Gelöschte Zeilen überschreibt das in Node gebündelte SQLite (`SECURE_DELETE`) schon in der Datei.
    - Übrig bleiben alte Seitenbilder im WAL eines getöteten Prozesses. Ein Test zeigt, dass die gelöschten Daten
      dort stehen und danach nirgends mehr.
  - Statische Importe von pi-durable in `src`: `agent.ts` (U6), `store/legacy.ts` und `store/legacy-sync.ts` (bis
    U5/U8), Typ-Importe in `primary-sync.ts` und `replica-control.ts` für den pi-durable-Pfad.

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
  `delta`-Revisionen und setzt sie beim Lesen zusammen. Der eigene Speicher legt die
  beiden wachsenden Dokumentarten `phi-spaces.space` und `phi-spaces.named-space` von
  Anfang an in Teilen ab (je eine Zeile pro Eintrag, Claim, Generation und
  Verlaufs-Batch, dazu eine Kopfzeile); das Messgate ist mit dem Lastprofil aus
  [U0](umstellung-u0-bestand.md) bereits überschritten (31 MB je Space nach 9,5 h,
  entschieden 2026-10-22). Alle übrigen Dokumentarten speichern vollständige Werte.
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
