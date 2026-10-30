# Portierung von phi-spaces nach Rust

Stand: 2026-10-30. **Ziel- und Arbeitsplan.** R0 ist umgesetzt; der Cargo-Workspace enthält `phi-json`, `phi-core`
und die erste Scheibe von `phi-store`. Die R1-Basisscheiben 0–5 sind umgesetzt, die unten genannten Vertragslücken
sind noch offen. Die Entscheidungen R-D0 bis R-D9 (Abschnitt 9) sind am 2026-10-29 getroffen, die genannten Crates
damit freigegeben. R-D10 bis R-D13 halten offene Entscheidungen aus der Planprüfung fest; sie sind keine Freigaben.

## 1. Ergebnis und Abgrenzung

Ziel ist ein Space-Server in Rust. Er ist von außen nicht vom heutigen `src/standalone.ts` zu unterscheiden: gleiches
Wire-Protokoll, gleiche SQLite-Datei und gleiche Semantik. Danach folgt Schritt für Schritt die Host-Laufzeit
(Gate, Auth, Enrollment, Grants, Supervisor). Ein föderationsfähiger Member braucht zusätzlich R5b; Root-Föderation,
Replikation und Recovery bleiben R6 vorbehalten und kommen zuletzt oder gar nicht.

**Portiert wird `src/`** (≈ 18.000 Zeilen TypeScript), in dieser Reihenfolge:

1. Kern (`core.ts` und seine Helfer)
2. eigener Speicher (`store/`)
3. Dienst und Transport (`service.ts`, `socket.ts`, `standalone.ts`)
4. Sicherheitsschicht
5. Betriebsbausteine

**Nicht portiert wird:**

| Teil | Grund |
|---|---|
| `agent/` | hängt an pi-durable, chord und pi-ai, alle drei gibt es nur in TypeScript |
| Web-Teile von `codemode-chat/` und `spaces-mmo/` (Next.js, React, PixiJS, three) | Browser-Code; spaces-mmo liefert die Seite in R8 statisch aus |
| Model-Prozess von spaces-mmo (`server/model-host.ts`, `server/llm.ts`) | Modellaufrufe über pi-ai und dieselben Zugangsdaten wie `agent/` |
| Server-Prozesse von `codemode-chat/` | Anwendung *auf* phi-spaces; bleibt Client über `RemoteSpace` |
| `codemode-chat` Ausführung von Beiträgen | pi-codemode führt JavaScript aus |
| `help-site/` | Dokumentationsseite |

**Zusätzlich portiert (R8):** die Server-Prozesse von spaces-mmo, nämlich world, npc und web mit Konten, Gateway und
Chat (etwa 7.000 Zeilen in `spaces-mmo/server/`). Der Space-Prozess (`space-host.ts`) ist schon in R3 ersetzt.

**Der TypeScript-Client bleibt:**

- `RemoteSpace`, `src/space-client.ts` und `phi-spaces/ws` bleiben in TypeScript und das öffentliche Paket für die
  Projekte.
- Das Paket `phi-spaces` verliert also nichts. Es bekommt nur einen zweiten Server, der hinter derselben Adresse
  laufen kann.
- Ein Rust-Client (`phi-spaces-client`-Crate) entsteht zuerst für die Tests (Abschnitt 5). In R8 wird er
  vollständig, weil die Rust-Prozesse von spaces-mmo ihn brauchen.

## 2. Warum die Naht am Socket liegt

Die Projekte erreichen den Space heute nur über die Adresse eines eigenen Prozesses:

- **Zugriff:** `connectSpace` (`spaces-mmo/server/space.ts`, `codemode-chat/server/index.ts`) liefert ein
  `SpaceLike` über `RemoteSpace`.
- **Server:** Nur die `space-host.ts` beider Projekte starten `serveSpace(new SpaceService(...))`.
- **Rahmen auf der Leitung** (`src/socket.ts`): u32-Länge, u32-Aufruf-Id (big endian), dann UTF-8-JSON. Aufrufe
  laufen je Verbindung parallel, und die Antwort trägt die Id ihres Aufrufs.
- **Methoden:** Die Verteilung steht in `SpaceService` (`src/service.ts`, der `switch` ab `hello`): `hello`,
  `generation`, `write`, `read`, `take`, `pollOperation`, `resolveOperation`, `cancelOperation`, `readAll`, `count`,
  `stats`, `batch`, `spaces`, `txn`, `lease`, `changes`, `notify`, `wait`, `events`, `ack`. Die Kommandos der
  Kontrollebene beantworten vorgeschaltete Host-Dienste erst in R5/R5b/R6, nicht der Standalone-Dienst.

Damit lässt sich die Portierung als „Würger“ vorziehen:

- Ein Rust-Binary `phi-space-server --store FILE|memory --listen unix:…|tcp:…` ersetzt `npm run space-server`.
- Später ersetzt es auch den `space-host`-Prozess eines Projekts, mit dessen Startprofil aus R3.
- Die fachlichen Clients ändern sich nicht; Startskripte, Test-Fixtures und der Projekt-Bootstrap werden angepasst.
- Jede Stufe hat einen geprüften Rückweg auf derselben Datei innerhalb ihres freigegebenen Versionspaares und
  Rollback-Fensters (R4/R8). Das Dateiformat allein garantiert keine fachliche Rückwärtskompatibilität.

## 3. Unveränderliche Verträge (byte-genau)

Die Rust-Seite muss diese Punkte bitgleich treffen. Für jeden Punkt erzeugt Phase R0 Golden-Vektoren aus der
TypeScript-Implementierung.

| Vertrag | Ort heute | Falle |
|---|---|---|
| Kanonisches JSON (an RFC 8785 angelehnt) | `src/canonical.ts` | Maßstab ist das TS-Verhalten, einschließlich unpaariger Surrogate (siehe unten). Schlüssel sortiert nach **UTF-16-Codeeinheiten**, nicht nach UTF-8-Bytes. Zahlen in **ECMAScript-Form** (`1` statt `1.0`, Exponent ab 1e21, `-0` → `0`). `serde_json` und `ryu` liefern dies nicht von selbst |
| Digests | `digestJson` (SHA-256 hex über kanonisches JSON) | Argument-, Kommando- und Bindungs-Hashes; Request-Ids im Journal |
| Generationen | `claims.ts` (`nonce.HMAC-SHA256(signingKey, canonicalJson({nonce, …rec}))`) | Gespeicherte Claims müssen nach dem Wechsel gültig bleiben; sonst verfallen alle laufenden Requests |
| Zahlen | `core.ts`: `FOREVER = Number.MAX_SAFE_INTEGER`, Zeiten in ms als JS-Zahl | Alle JSON-Zahlen werden wie in JS als IEEE-754-Doubles ausgewertet (`phi-json`: `f64`), auch wenn der Eingabetext eine ganze Zahl zeigt. `FOREVER` muss exakt zurückkommen; `until()` darf nicht überlaufen |
| JSON-Werte | `Json`/`Fields` in `core.ts` | Templates vergleichen rekursiv mit `core.deepEqual`: Objektschlüsselreihenfolge ist egal, Arrayreihenfolge nicht. Serialisierung und Bytezählung folgen dagegen `JSON.stringify`, einschließlich JS-Eigenschaftsordnung (Indexschlüssel zuerst); `preserve_order` allein reicht nicht |
| Schlüssel | `auth.ts`, `grants.ts`, `enroll.ts` | Ed25519 als rohe 32 Byte; ECDSA P-256 als SPKI-DER mit DER-Signatur (Android-Keystore); Fingerprint = SHA-256 der Base64-dekodierten Bytes, 32 Hex-Zeichen |
| SQLite-Format | `store/sqlite.ts` | Tabellen `store_meta`, `documents`, `parts` (STRICT), Indizes `parts_order`, `parts_at`, `parts_grp`, `parts_open`; `value` ist JSON-Text; Dokumentversion 5; Formatnummer 2 in `store_meta`; WAL; Sperrdatei `<datei>.owner` |
| Fehler | `service.ts` (`fail("StaleEpoch", …)` usw.) | Fehlernamen und -felder sind Vertrag; `RemoteSpace` verzweigt darauf (Retry, `RequestExpired`) |
| Grenzen | `DEFAULT_LIMITS` in `core.ts` | Rahmengröße, Ergebnisbudget (`frameBytes - 64`), Quoten, `jsonBytes`-Zählung (UTF-8-Bytes des `JSON.stringify`) |

**Entscheidung R-D1:** Die Rust-Seite liest und schreibt **dieselbe SQLite-Datei**. Es gibt keinen zusätzlichen
Rust-spezifischen Formatwechsel; vorhandene Format- und Dokumentmigrationen sowie die unterstützten Versionen
müssen trotzdem geprüft werden. Vor der Übernahme prüft der Server Format, Dokumentversionen und aktive Features;
nicht unterstützte Bestände verweigert er vor dem Bedienen und vor fachlichen Änderungen. Ein abgelehntes Öffnen
darf weder Daten löschen noch Identitäten neu anlegen. Der Rückweg ist zusätzlich an R4/R8 gebunden.
Ein eigenes Format mit Export/Import wäre eine Änderung von R-D1 und braucht eine neue Entscheidung.

**Offene Vertragslücke: JS-Strings (R-D10).** TS akzeptiert und speichert etwa `{"value":"\ud800"}`; auch
`canonicalJson` schreibt das unpaarige Surrogat als Escape. Rust-`String` kann es nicht halten, und `phi-json`
weist es derzeit ab. Der Golden-Test erwartet diese Ablehnung ausdrücklich: Er belegt die bekannte Abweichung,
nicht die Kompatibilität. Vor R3 ist entweder eine verlustfreie Repräsentation von UTF-16-Codeeinheiten festzulegen
oder eine bewusste gemeinsame Vertragsänderung mit TS-Anpassung und Bestandsprüfung zu beschließen. Verlustbehaftetes
Ersetzen ist kein kompatibler Import. Parsergrenzen und ungültiges UTF-8 gehören ebenfalls in die Negativvektoren.

## 4. Zielarchitektur

Ein Cargo-Workspace `rust/` im Repository, neben `src/`:

| Crate | Inhalt | entspricht |
|---|---|---|
| `phi-json` | `Json`-Typ, kanonisches JSON, `digest_json`, `json_bytes` | `canonical.ts`, `json.ts` |
| `phi-core` | reine Semantik: Entries, Templates, Leases, Txns, Notify, Waiter, Limits, Revisionslog, Claims, Mailboxen, RunGate; `now` explizit, keine I/O | `core.ts`, `claims.ts`, `stream.ts`, `mailbox.ts`, `paging.ts`, `snapshot.ts`, `member-admission.ts`, `doc.ts` |
| `phi-store` | Host mit Commits auf Entwürfen, Watches, SQLite-Ledger mit Schreib-Thread, Teile, `DISK_MAP` | `store/*` |
| `phi-service` | `SpaceService`, Rollen-/Typprüfung, Pending/Poll, Quoten, Meter | `service.ts`, `spaces.ts`, `meter.ts`, `rpc-domain.ts` |
| `phi-wire` | Rahmen, Unix/TCP-Server und -Client | `socket.ts`, Teile von `remote.ts` |
| `phi-host` | Gate, Auth, Enroll, Grants, Rotation, Supervisor, Laufzeit | `gate.ts`, `auth.ts`, `enroll.ts`, `grants.ts`, `rotation.ts`, `supervisor.ts`, `runtime.ts` |
| `phi-space-server` (bin) | CLI wie `src/standalone.ts` | `standalone.ts` |

**Fähigkeiten und Abhängigkeiten:** Eine erreichte Stufe gibt die folgende nicht automatisch frei.

| Stufe | Voraussetzung und Pflichtumfang | Noch nicht freigegeben |
|---|---|---|
| R3 Standalone | R1/R2; sämtliche `METHODS`, Claim-Auflösung im aktuellen Epoch, Cancel, Hintergrundwartung, Abschlussprofile für entsprechend konfigurierte TS-Stores; `hello` meldet nur implementierte Fähigkeiten | Gate, Föderations-Member, Restore und Promotion |
| R3 Projekt-Host | zusätzlich der unveränderte fachliche Bootstrap und das Startprofil aus R3, mit stabiler Peer-ID | Anwendung ohne Limits-/Lock-Initialisierung; öffentlicher ungeschützter TCP-Betrieb |
| R5 Sicherer Host | R3; Gate, Schlüsselbeweis, Enrollment, Grants, Rotation und Supervisor | Routing-Delegation, Member-Admission, Run-Steuerung; keine pauschale Föderationsfreigabe |
| R5b Föderations-Member | R5; Delegationsprüfung, Membership/Admission, RunGate und Member-Instruktionen, Boot-/Autoritätsprüfung | Rust-Root, Replikation, Promotion und vollständiges Recovery aus R6 |
| R6 Root/Replikation/Recovery | R5b und gesonderte Entscheidung nach R-D3; Abnahme je Betriebsmodus | Kein Schluss von Single-Betrieb auf replizierten Betrieb |
| Mobile b) | eigenes Arbeitspaket M1 (Abschnitt 7), R3/R4; für einen föderierten Handy-Host zusätzlich R5/R5b und die benötigten R6-Recovery-Pfade | bloßer Cross-Build oder R4 allein ist keine Freigabe |

Vor jeder Abnahme wird die konkrete Liste unterstützter Dokumentversionen, aktiver Features und Betriebsmodi
festgehalten. Ein `NotPorted` bei einer Pflichtfunktion oder ein übersprungener Pflicht-Test erfüllt die Abnahme nicht.

**Übertragung der TypeScript-Muster:**

- **Drafts mit Kopieren beim Schreiben** (`store/draft.ts`, Proxys):
  - In Rust werden das explizite Arbeitskopien je Commit: `im`-Strukturen oder `Arc` plus Klonen beim ersten
    Schreiben.
  - Tabellen-Teile bekommen ein Rückgängig-Protokoll, wie in U2 beschrieben.
  - Spätes Schreiben nach Commit-Ende („revoked draft“) wird durch Ownership unmöglich statt zur Laufzeit geprüft.
- **`AsyncLocalStorage`** (`context.ts`, `store/host.ts`) wird zu `tokio::task_local!` oder einem expliziten
  Kontext-Parameter. Explizit ist vorzuziehen, weil der Kern ohnehin `now` explizit nimmt.
- **Commit-Reihenfolge:**
  - Ein Commit-Task je Host serialisiert die Zustandsänderungen. Nachfolgende Commits dürfen auf noch nicht
    dauerhaft geschriebenen Vorgängern aufbauen; das Warten auf jeden einzelnen `fsync` darf das Batching nicht aufheben.
  - Ein eigener Schreib-Thread hält die SQLite-Verbindung (heute `sqlite-writer.ts` im Worker).
  - Bestätigt wird erst nach dem dauerhaften Schreiben (`synchronous=FULL`). Externe Snapshots und neue Watches
    warten auf die laufenden Commits und deren Persistierung; ein Snapshot im Commit wartet nicht auf sich selbst.
  - Watches werden erst nach der Persistierung geweckt und fassen zusammen, was während ihres Listeners geschah.
    Scheitert eine Persistierung, verweigert der Host weitere Arbeit bis zum Wiederöffnen; ein Fehler im
    Commit-Callback oder in `prepare` nimmt dagegen den Entwurf zurück (Vertrag in `store/host.ts`).
- **`DISK_MAP`:** Claims auf der Platte werden gezielt abgefragt, nie aufgezählt. In Rust bekommt der Typ gar keine
  Iterator-Methode, damit gilt die Regel schon beim Kompilieren.

**Crates (freigegeben 2026-10-29, R-D0):**

| Zweck | Crates |
|---|---|
| Laufzeit, Speicher, JSON | `tokio`, `rusqlite` (gebündeltes SQLite), `serde`/`serde_json` (`preserve_order`, `arbitrary_precision` aus) |
| Kanonisches JSON | `ryu-js` für die ECMAScript-Zahlenform, oder eine eigene Umsetzung mit Vektoren |
| Kryptografie | `sha2`, `hmac`, `ed25519-dalek`, `p256` (ecdsa, DER) |
| Overlay und Zufall | `rustls` (TLS-Register, Fencing-Dienst), `rand`/`getrandom` |
| CLI und Tests | `clap` (optional), `proptest` für Differenztests |

## 5. Prüfstrategie: die TypeScript-Tests als Orakel

Die ≈ 19.000 Testzeilen in `test/` sind der Maßstab. Sie werden nicht zuerst umgeschrieben, sondern auf den
Rust-Server gerichtet.

**Gruppe A: läuft schon über einen Prozess oder Socket.** Hier genügt ein Schalter für die Server-Kommandozeile:

- `test/test-standalone.test.ts` startet `src/standalone.ts` mit `spawn`. Steht `PHI_SPACES_SERVER_CMD` (z. B.
  `rust/target/release/phi-space-server`), startet er stattdessen dieses Kommando (seit R0). Darin laufen auch die
  Beispiele `examples/sieve.ts` und `examples/cache.ts` mit `--remote`.
- `test/test-socket.test.ts` startet seinen Server dagegen im Testprozess (`serveSpace`). Er gehört damit zu
  Gruppe B und bekommt die Fixture aus R3.

**Gruppe B: Dienst in-process, Client über `RemoteSpace`.** Dazu gehören `test-remote`, `test-service`, `test-gate`,
`test-auth`, `test-enroll` und `test-scenario`.

- **B3 (R3):** die Standalone-/Dienstfälle aus `test-remote`, `test-service`, `test-socket` und `test-scenario`,
  einschließlich Rollen-/Typprüfung mit Testidentitäten. **B5 (R5):** Gate-, Auth-, Enrollment- und sonstige Fälle,
  die die Sicherheitsschicht voraussetzen. Föderationsfälle werden erst R5b/R6 zugeordnet.
- Eine gemeinsame Fixture in `test/support/` liefert je nach Umgebung zwei Varianten:
  - den In-Process-`SpaceService` mit Loopback-Transport,
  - oder eine Adresse eines gestarteten Rust-Servers.
- Tests, die in den Dienst hineingreifen (Uhr setzen, Store direkt lesen), brauchen dafür ein Test-RPC.
- Das Test-RPC ist nur mit `--test-hooks` aktiv und setzt die Uhr, öffnet und schließt neu und liest den
  Speicherauszug.
  Es läuft auf einem gesonderten lokalen Kanal, nie auf dem normalen TCP-/Gate-Listener. Im Produktionsstartprofil
  ist es abgeschaltet; Negativtests prüfen, dass diese Eingriffe dort nicht erreichbar sind.
- Die Fixture braucht außerdem kontrollierte Identitäten, Policy-/Limit-Konfiguration und Fehlerpunkte für
  Transport und Store. Eine Server-Adresse allein ersetzt Tests mit direktem Zugriff auf diese Objekte nicht.
- Eine Fallmatrix nennt je Suite/Test die Zielphase, Rust-Fixture und den Status. B5/R5b/R6-Fälle bleiben in R3
  ausdrücklich offen; unerwartete Skips oder ein Rückfall auf den TS-Server lassen die Rust-Abnahme scheitern.

**Gruppe C: Kern- und Store-Tests direkt auf TypeScript-Objekten.** Dazu gehören `test-core`, `test-claims`,
`test-stream`, `test-own-store` und `test-persistence`.

- Diese Tests werden nicht umgezogen.
- Ein **Differenz-Harness** spielt feste Regressionsfolgen sowie gesäte zufällige Folgen gegen beide Kerne:
  Der TS-Kern hinter einem stdin/stdout-Treiber, der Rust-Kern nativ. Der eigene zustandsbehaftete Generator aus R1
  übernimmt derzeit die Rolle von `proptest`.
- Ergebnis, Fehler und Folgezustand werden je Schritt kanonisch verglichen. Zusätzlich prüfen gezielte Vektoren
  `JSON.stringify`-Text, Eigenschaftsordnung und Bytezahl; ein kanonischer Hash allein kann die Ordnung nicht prüfen.
- Die Store-Abnahme aus R2 bildet auch Persistierung, überlappende Commits und Fehler nach. Ein grün gebliebener
  Test auf TS-Objekten ist kein Nachweis für den Rust-Store.

**Golden-Vektoren (R0):** kanonisches JSON, insbesondere Zahlen, Surrogatpaare und Schlüsselsortierung, dazu
Digests, Generationen, Signaturen beider Algorithmen und SQLite-Dateien. Die SQLite-Dateien stammen aus TS-Läufen;
die Rust-Seite muss sie öffnen und gleich beantworten.

**Kreuzbetrieb:** In jeder Phase schreibt TS eine Datei, Rust öffnet sie und arbeitet weiter, dann umgekehrt.
`test/support/persistent.ts` (Crash/Reopen) liefert die Vorlage.

**Rust-Client:** Die TS-Suiten prüfen zunächst den TS-Client gegen beide Server. Für den Rust-Client kommt in R8.1
ein JSONL-Treiber oder ein gleichwertiger sprachübergreifender Adapter hinzu, der dieselben Client-Szenarien ausführt.
Abgenommen wird die Matrix TS-/Rust-Client gegen TS-/Rust-Server; ein Server-Kommando-Schalter tauscht keinen Client aus.

## 6. Arbeitspakete

Jede Phase endet mit Typecheck und `npm test` (unverändert grün, der TS-Server bleibt Standard) sowie
`cargo test` / `cargo clippy` im Workspace. Hinzu kommt die jeweils genannte Abnahme.

### R0: Verträge festschreiben (nur TypeScript)

**Arbeit:**

- `docs/wire-protokoll.md`: jede Methode mit Argumenten, Antwort und Fehlern, abgeleitet aus `service.ts` und
  `remote.ts`.
- Golden-Vektoren unter `test/vectors/`, dazu ein Skript, das sie aus TS erzeugt.
- Der Aufzeichner für Kernoperationen.
- `PHI_SPACES_SERVER_CMD` in den Tests der Gruppe A.
- **Baseline messen:** `npm --prefix spaces-mmo run test:perf`, `tests/perf/space-cost.ts` (CPU-ms je Kommando im
  Space-Prozess), Speicherbedarf des Space-Prozesses auf big und nano.

**Abnahme:** Die Vektoren sind eingecheckt und reproduzierbar, und die Baseline-Zahlen stehen in diesem Dokument.

**Stand R0 (2026-10-29):**

- **Protokoll:** [wire-protokoll.md](wire-protokoll.md) beschreibt Kommandozeile, Rahmen, Umschlag, Rollen,
  Request-Identität, Werte, alle Methoden aus `METHODS`, Fehlercodes, Grenzen und die Speicherdatei.
- **Vektoren:** `test/vectors/` mit `canonical.json`, `crypto.json`, `wire.json` (eine Sitzung mit 48 Aufrufen,
  Zufallswerte als Platzhalter), `store.sql` und `store.expected.json`. `npm run vectors` schreibt sie aus
  `test/vectors/build.ts`. `test/test-vectors.test.ts` (in `npm test`) prüft sie gegen den Code. `canonical.json`,
  `wire.json` und `crypto.json` sind bei jedem Lauf gleich; die P-256-Signaturen sind zufällig, werden verifiziert und
  beim Neuschreiben behalten, solange sie gelten. Die Store-Dateien sind feste Stücke: Jeder neue Store hat neue
  Zufalls-Ids, deshalb schreibt nur `npm run vectors -- --store` oder eine Schemaänderung sie neu.
- **Aufzeichner:** Die Sitzung in `wire.json` zeichnet auf Dienstebene auf (`runSession`, Uhr von außen). Der
  Treiber für den reinen Kern (Operationsfolgen über stdin/stdout) entsteht mit seinem Gegenstück in R1.
- **Testschalter:** `PHI_SPACES_SERVER_CMD` in `test/test-standalone.test.ts`, geprüft mit dem TS-Server als
  externem Kommando.
- **Probe:** `scripts/server-probe.ts` misst den Space-Server allein (CPU je Aufruf, RSS, Antwortzeiten); mit
  `--cmd` später den Rust-Server.

**Ausgangswerte** (dieser Rechner: Ryzen 7 3700X, 16 Threads, Node 22.23; big und nano im nächsten Absatz):

| Messung | Ergebnis |
|---|---|
| `server-probe`, SQLite, 8 Clients, Ziel 900 Aufrufe/s, 24.000 Aufrufe (write, read, take) | 666 Aufrufe/s (CPU-gesättigt, 122 %), **1,82 ms Server-CPU je Aufruf**, p50 8,4 ms, p95 24 ms, RSS 120 → 364 MB |
| dasselbe, Ziel 300/s | 293/s, 2,79 ms CPU je Aufruf (weniger Commits je Schreibstapel), p50 2,6 ms, p95 37 ms, RSS bis 297 MB |
| `server-probe`, Speicher-Store, Ziel 900/s | **82 Aufrufe/s, 12,9 ms CPU je Aufruf**, p50 80 ms, RSS bis 240 MB |
| dasselbe, Ziel 300/s | 66/s, 16,1 ms CPU je Aufruf |
| `space-cost.ts` (spaces-mmo, 50 Bots, 60 s, Space auf SQLite) | 1.383 Kommandos (19,9/s), **15,9 ms Space-CPU je Spielerkommando**, Space-Prozess 32 % eines Kerns, p50 21 ms, p95 43 ms, 27 Zeitüberschreitungen |
| `test:perf` Last (10 Spieler, spaces-mmo) | 66,5 Schritte/s, Schritt bis Antwort p50 18 ms, p95 38 ms, p99 59 ms |

Die spaces-mmo-Werte stammen vom Arbeitsstand mit uncommitteten Änderungen in `spaces-mmo/`. Der Latenztest von
`test:perf` schlug dabei fehl („Zu viele Befehle auf einmal“).

**big und nano (2026-10-29, 23:25 Uhr):** gleiche Probe, gleiche Parameter (SQLite, 8 Clients, 400 Runden, Ziel
300 Aufrufe/s, 9.600 Aufrufe). Sie lief in einem Wegwerf-Container aus dem Produktions-Image `phi-spaces-mmo:prod`
(Node 22.23, `--network none`, Store im Container-Dateisystem), neben den laufenden Diensten. Auf big war das Image eine
Minute alt (Checkout `a0da835`), auf nano 13 Stunden. Probe und Container sind danach entfernt.

| Rechner | CPU | Last vorher | Server-CPU je Aufruf | CPU-Anteil | p50 / p95 / p99 | RSS |
|---|---|---|---|---|---|---|
| lokal (zum Vergleich, gleiche Parameter) | Ryzen 7 3700X, 16 Threads | – | 2,24 ms | 0,67 | 1,9 / 7,0 / 12,2 ms | 122 → 235 MB |
| big | EPYC 9634 (VM), 8 Kerne, 16 GB | 2,4 | **1,47 ms** | 0,44 | 2,3 / 7,7 / 16,2 ms | 121 → 227 MB |
| nano | QEMU-VM, 4 Kerne, 8 GB | 0,7 | **3,35 ms** | **1,00** | 11,4 / 30,4 / 43,1 ms | 122 → 236 MB |

Auf nano braucht der Space-Server bei 300 Aufrufen/s einen ganzen Kern; mehr trägt er dort nicht. Weil nano
Accounts-Space und codemode-Space trägt, ist nano der Rechner, auf dem eine Portierung am meisten bringt.

Laufende Space-Prozesse (`docker stats`, nur gelesen; drei Stichproben im Abstand von 20 s, die Regionen auf big etwa
fünf Minuten nach einem Neustart):

| Container | CPU | Speicher |
|---|---|---|
| big `phi-spaces-mmo-space-west` / `-ost` / `-nord` / `-sued` | 12–31 % / 14–18 % / 9–14 % / 9–20 %, zusammen 55–70 % eines Kerns | 145–153 / 175 / 131 / 122 MB |
| big `phi-spaces-mmo-web` | 2 % | 100 MB |
| nano `phi-spaces-mmo-space` (Accounts) | 1 % | 72 MB |
| nano `phi-spaces-codemode-space` | 8 % | 177 MB |

Jeder Space-Prozess startet mit etwa 60 MB (die Prozesse ohne Space: model, npc, world je 58–62 MB, also die
Node-Grundlast) und wächst mit seinem Space auf 120–180 MB. Ein Rust-Prozess sollte im Leerlauf nur wenige MB
brauchen; das ist der zweite Hebel aus R-D2 (Speicher), besonders auf nano mit 8 GB.

**Befunde aus R0:**

1. **Speicher-Store wird mit der Zahl der Requests langsam.** Nach 2.400 Aufrufen kostet ein Aufruf 1,7 ms CPU,
   nach 24.000 Aufrufen 12,9 bis 16 ms. Mit SQLite bleibt es bei etwa 2 ms. Vermutlich wachsen die 24 h gespeicherten
   Request-Ergebnisse im Space-Dokument mit, während SQLite sie als Teile auf der Platte hält. Das betrifft
   `--store memory` und `SPACES_MMO_MEM=1` heute schon und ist vor R2 zu klären: Der Rust-Store soll es nicht erben.
2. **`timeoutMs: null`** gibt im Dienst den Standard 0, in `rpcDomain` aber −1, also einen anderen Argument-Hash
   ([wire-protokoll.md](wire-protokoll.md), Abschnitt 5). `RemoteSpace` sendet `null` nicht; die Rust-Seite folgt
   vorerst dem TS-Verhalten.
3. **R-D2 ist ein Messverfahren, keine feste Zahl.** Der Lauf mit 900/s war CPU-gesättigt, und ein gesättigter
   Server fasst mehr Commits zusammen; das senkt die CPU je Aufruf (1,82 ms gegen 2,79 ms bei 300/s). Für R-D2 gilt
   deshalb:
   - gleicher Rechner und Quellstand, dokumentierte Release-Builds, SQLite mit `synchronous=FULL`, gleiche
     Limits, Retention und Lastdaten; TS und Rust öffnen je eine gleich vorgefüllte Store-Kopie;
   - pro Rechner eine feste Rate **unterhalb der Sättigung beider Varianten**, vorab in einem Probelauf bestimmt.
     300/s sind auf nano laut obiger Messung bereits gesättigt und dort kein ungesättigter Vergleichspunkt;
   - `server-probe --cmd` für TS und Rust mit Aufwärmphase und mindestens drei Messpaaren in wechselnder Reihenfolge;
     CPU je erfolgreichem Aufruf, RSS im Leerlauf/unter Dauerlast, p50/p95/p99 und Fehler-/Timeout-Raten berichten;
   - 1024 Aufrufe/s je Peer sind der Standalone-Standard, keine universelle Obergrenze: Die Projekt-Hosts erlauben
     50.000/s. Das jeweilige Profil bleibt auf beiden Seiten gleich; abgewiesene Aufrufe zählen nicht als Durchsatz;
   - spaces-mmo (`space-cost.ts`) ebenso: TS und Rust nebeneinander neu gemessen, nicht gegen diese Tabelle, weil sich
     das Spiel bis dahin weiterentwickelt (R-D8). Die Prozessmessung erfasst auch das Rust-Binary zuverlässig,
     statt ausschließlich nach `server/space-host.ts` in der Kommandozeile zu suchen.
   - R-D2 bleibt die bestehende Grundentscheidung. Mindest-Speichergewinn und zulässige Latenz-/Fehlerratenregressionen
     sind vor der R3-Abnahme festzulegen (R-D11); ein beliebig kleiner RSS-Gewinn allein ist keine belastbare Freigabe.

### R1: `phi-json` und `phi-core`

**Arbeit:**

- Kanonisches JSON und die Zahlenregeln.
- Der reine Kern mit Claims, Stream und Mailbox; RunGate und Member-Admission werden in R5b vervollständigt.
- Ziel: keine I/O und keine implizite Uhr; `now`, notwendige Uhrzugriffe und Zufall sind injizierbar. Die
  noch vorhandenen impliziten TS-Uhrzugriffe sind unten dokumentiert, nicht bereits behoben.

**Abnahme:**

- Die JSON-/Hash-Golden-Vektoren stimmen ohne stillschweigende Ausnahmen; R-D10 ist aufgelöst.
- Der Differenz-Harness spielt die festen Regressionsfolgen fehlerfrei nach.
- Der zustandsbehaftete Generator findet in 10⁶ Zufallsschritten keine Abweichung zum TS-Kern; Saat,
  Quellstand und getesteter Funktionsumfang werden festgehalten. `proptest` bleibt eine freigegebene Alternative.

**Stand der Abnahme (2026-10-30):** Alle sechs Basisscheiben 0–5 sind erledigt. Die vollständige
Kompatibilitätsabnahme ist wegen R-D10 und der unten genannten Pflicht-Ergänzungen noch offen.

- **Golden-Vektoren:** `phi-json` reproduziert die unterstützten Werte aus `canonical.json` und die Hash-Teile von
  `crypto.json`; das unpaarige Surrogat wird abweichend von TS verweigert (R-D10). `wire.json` und die Store-Dateien
  prüft erst R3/R2, sie gehören zum Dienst und zum Store, nicht zum Kern.
- **Aufgezeichnete Folgen:** Es gibt keine eigens aufgezeichneten Folgen. Ihre Rolle übernehmen die festen Folgen von
  `tests/boundaries.rs` (jede Budgetgrenze, Aufbewahrung, Verdrängung) und `tests/state_round_trip.rs`. Beide laufen
  gegen den TS-Treiber und sind grün.
- **10⁶ Zufallsschritte:** Ein gesäter Zufallsgang mit 10⁶ Schritten (`PHI_CORE_WALK_STEPS=1000000`, `--release`,
  1 364 s) fand keine Abweichung in Antwort, Fehler oder Zustands-Hash. Statt `proptest` läuft ein eigener gesäter
  Generator: Er erzeugt Folgen mit Zustand (Ids, Generationen, Schlüssel, Cursor aus den Antworten), und jede Saat ist
  wiederholbar (`PHI_CORE_WALK_SEED`). Das Schrumpfen, das `proptest` brächte, hilft gegen einen Prozess mit Zustand
  wenig; bei einer Abweichung zeigt der Gang den Schritt und die Pfade, an denen sich die Zustände unterscheiden. Soll
  es trotzdem `proptest` sein, ist es freigegeben (R-D0).
- **Nicht im Kern:** Was zurückgestellt ist (siehe unten), verweigert der Rust-Kern mit `NotPorted`, bevor er etwas
  ändert.

**Schnitt (2026-10-29):** R1 läuft über mehrere Sitzungen, in Scheiben. Jede Scheibe wird committet, wenn die
Vergleichstests gegen den TS-Treiber grün sind.

| Scheibe | Inhalt | Stand |
|---|---|---|
| 0 | `phi-json`; TS-Treiber `test/support/core-driver.ts`; Zustandsmodell `phi-core::state` mit Round-Trip-Prüfung | erledigt |
| 1 | Entries, Templates, Leases, `settle`, Ablauf, Stream-Einträge, Budgets (`charge`, `jsonBytes`-Summen); dazu `count`, `list`, `listPage`, `changes`, `stats`, `nextExpiry` ohne Txn | erledigt |
| 2 | Transaktionen: `createTxn`, `commitTxn`, `abortTxn`, Ablauf in `settle`, Txn-Leases, Schreiben, `announce`, Lesen und Nehmen unter einer Txn, Reservierungen | erledigt |
| 3 | Wartende, geparkte Operationen, Claims und Generationen; ihre Ereignisse in der Outbox und Fanout-Jobs ohne Consumer | erledigt |
| 4 | Notify und Mailboxen: Abonnements mit Drosselung und Bündeln, Consumer für Abonnements und Wartende, Fanout-Jobs mit Consumer, Freigabe abgelaufener Takes | erledigt |
| 5 | Snapshots (`snapshot.ts`) mit Seiten-Token; Stream und Seiten unter Txns kamen schon mit Scheibe 2 | erledigt |
| 6 | Vertragslücken vor R3: `cancelRequest`, `releaseTxn`, `setLimits`, Abschlussprofile (erledigt, Stand unten); JS-Strings (R-D10) | offen: nur noch R-D10 |

**Bewusst zurückgestellt:** Restore, Wechsel der Autorität, Member-Admission, Löschung, Admin-Wartung, `purgeTasks`,
RunGate und negative Claims. Member-Admission und RunGate sind Pflicht für R5b, die übrigen Erweiterungen gehören
zu R6. Ihre Felder führt `phi-core::state` bis dahin unverändert mit (`rest`); aktive, noch nicht unterstützte
Features verweigert der Rust-Server schon bei der Übernahme.

**Nicht bis nach R3 verschiebbar:** `cancelOperation` ruft `claims.cancelRequest` auf; die Hintergrundzustellung
verwendet `releaseTxn` bei nicht zustellbaren Take-Ereignissen. Die Projekt-Hosts brauchen `setLimits` für ihren
Bootstrap. Abschlussprofile gehören zur TS-`hello`-Capability und zur Übernahme entsprechend konfigurierter
Standalone-Stores. Diese Pfade werden in Scheibe 6 ergänzt, nicht durch `NotPorted` als abgenommen behandelt.

**Stand Scheibe 6 (2026-10-30):** `cancelRequest`, `releaseTxn`, `setLimits` und `setCompletionProfiles` sind im
Kern, im Treiber und im Zufallsgang; offen bleibt nur R-D10.

- **Abschlussprofile:** Eine genommene Aufgabe wird unter ihrer Transaktion festgehalten (`takenTasks`), ihre Frist
  begrenzt die Lease (`completionDeadline`), der Commit prüft die Ergebnisse. Auch wartende Requests ohne Transaktion
  scheitern mit `CompletionViolation`.
- **Gesperrt bis R5b:** Ein Profil mit `gateField` braucht RunGates. `setCompletionProfiles` weist es mit `NotPorted`
  ab, und ein bestehendes Dokument mit einem solchen Profil wird nicht bedient.
- **`setLimits`:** Alle Prüfungen gegen den Bestand sind da. Die Werte beider Projekt-Hosts laufen als fester Test.
  Eine Abweichung bleibt: JavaScripts `k in DEFAULT_LIMITS` nimmt auch geerbte Namen wie `toString`, Rust nicht. Das
  ist Host-Code und betrifft keinen Aufrufer.
- **Tests:** Ein Gang mit 60 000 Schritten durch den Kern und einer mit 4 000 durch beide Stores fanden keine
  Abweichung. Ein Dokument, das der TS-Store mit Profil, Limits, offener Aufgabe und wartendem Request schrieb, liest
  der Rust-Store mit gleichem Hash und arbeitet es zu Ende ab.
- **Gegenprobe:** 14 eingebaute Fehler fallen in `tests/boundaries.rs` auf. Zwei überlebten zuerst und bekamen eigene
  Fälle: eine Freigabe, die in die Warteschlange muss, und das Bedienen danach. Die Kante von `maxResultBytes` bekam
  ebenfalls einen eigenen Fall.

**Belege zu R-D10 (2026-10-30):**

- **Der Fall ist erreichbar:** `spaces-mmo/server/chat.ts` (`#report`, `text.slice(0, 1000)`) und `npc/minds.ts`
  (`remember`, `note.trim().slice(0, 300)`) kürzen nach UTF-16-Einheiten und schreiben das Ergebnis in Entries. Ein
  Emoji an der Schnittstelle hinterlässt ein einzelnes Surrogat.
- **Folge heute:** Der TS-Server nimmt so einen Text an. Der Rust-Server antwortet auf den Write `BadRequest`, und eine
  Datei, die so einen Wert enthält, öffnet er nicht.
- **Bestand:** Vier lokale Store-Dateien (3 119 Zeilen) enthalten keinen solchen Wert. big und nano sind nicht geprüft.

**Treiber und Zustand:**

- **Ein Commit je Zeile:** Der Treiber nimmt eine Operation je Zeile und klammert sie wie `spaces.ts` mit
  `core.beginCommit`.
- **Feste Uhr:** Die Uhr ist das `now` der Zeile, auch für `Date.now`.
- **Fester Zufall:** `crypto.randomBytes` ist ein Zählerstrom aus dem Startwert. Er wird über
  `syncBuiltinESMExports` auch in die benannten Importe gereicht, so dass Nonces, Schlüssel und Mailbox-Epochen auf
  beiden Seiten gleich sind.
- **Antwort:** Je Schritt kommt der SHA-256 des kanonischen Zustands zurück, auf Wunsch auch der ganze Zustand.
- **Rust-Modell:** Jedes noch nicht portierte Feld steht in `rest`. Fehlende und `null`-Felder bleiben
  unterschieden, weil die Budgets auf `JSON.stringify`-Bytes rechnen. Die Prüfung `state_round_trip` hält
  kanonische Form und Bytezahl jedes Zustands gleich.

**Stand Scheibe 1 (2026-10-30):**

- **`phi-core::space`:** Ein `Space` hält das Dokument und das, was `core.ts` in WeakMaps daneben führt: den offenen
  Batch des laufenden Commits, dessen Bytebudget und den Ablauf-Wasserstand. Der Wasserstand ist Semantik, nicht nur
  Tempo: `nextExpiry` antwortet aus ihm, und er kann veraltet niedrig sein (eine genommene Entry lässt ihn stehen).
  Ohne lebende Entries ist er `Infinity`, und `nextExpiry` liefert dann `null`.
- **`phi-core::stream`:** `touch`, `record`, `collect` wie `stream.ts`, mit derselben laufenden Bytesumme.
- **`phi-core::driver`:** dieselben Zeilen wie `core-driver.ts`, auf dem Rust-Kern.
- **Reihenfolge:** Die Prüfungen stehen in der Reihenfolge des TS-Kerns, auch nach `settle`. Der Treiber rollt nichts
  zurück, ein Fehler behält also, was `settle` schon getan hat (Ablauf, `del`, Batch, `maintenance`).
- **Verweigerung:** Ein Dokument, dessen `rest` mehr hält als leere `regs`, `waiters`, `outbox` (seit Scheibe 2 auch `txns`) und
  `maintenance`, und Argumente in Formen, die JavaScript über Umwandlungen läse (nicht-Strings in `types`, Templates
  ohne Objekt), beantwortet der Rust-Kern mit `NotPorted`, bevor er etwas ändert. Die Liste ist eine Positivliste.
- **Differenztest `tests/differential.rs`:** Zufallsgänge mit eigener Saat und je Gang kleinen Limits
  (`maxCommitBytes`, `maxLogBytes`, `maxEntryBytes`, …), damit Verweigerungen, aufgeschobener Ablauf und verworfene
  Batches vorkommen. Er vergleicht Antwort, Fehlerklasse mit Meldung und Zustands-Hash je Schritt. Er zählt die
  Ausgänge und schlägt fehl, wenn einer nie vorkam. Bei einer Abweichung spielt er beide Kerne bis zu diesem Schritt
  nach und zeigt die Pfade, an denen sich die Zustände unterscheiden. Vorgabe: 12 000 Schritte,
  `PHI_CORE_WALK_STEPS` für mehr. Ein Lauf mit 200 000 Schritten (`--release`) war abweichungsfrei. Der gesäte Gang
  steht für den `proptest`-Lauf der Abnahme (siehe „Stand der Abnahme“).
- **Grenztest `tests/boundaries.rs`:** Ein Zufallsgang trifft selten das eine Byte, an dem ein Limit kippt. Je Budget
  sucht der Rust-Kern den Kipppunkt einer parametrierten Folge (Füllbytes oder das Limit selbst), und beide Kerne laufen
  dort und je zwei Werte daneben. Füllbytes allein reichen nicht, weil ein Feld in Entry und `put` zählt, also in
  Schritten von zwei Bytes.
- **Gegenprobe:** Eingebaute Fehler um ein Byte oder einen Vergleich (`>` statt `>=` bei `maxEntryBytes`,
  `maxSpaceBytes`, Outbox, Seitenbudget, `maxLogBytes`; 127 statt 128 Ablaufkosten; das Komma im Batch) schlagen
  in mindestens einem Test fehl. Unentdeckt bleibt die exakte Neuberechnung bei genau `maxLogBytes`. Die ist
  gleichwertig, solange die laufende Summe stimmt.

**Stand Scheibe 2 (2026-10-30):**

- **Modell:** `phi-core::state` führt die Transaktionen typisiert (`TxnRec`: Lease, Eigentümer, `reserved`,
  `announced`), in der Reihenfolge, in der sie geöffnet wurden. Das ist die Reihenfolge von `Object.values` und damit
  die, in der gleichzeitig abgelaufene Txns abgebrochen werden.
- **Ports:** `finish` (Commit und Abbruch, rückwärts über die Entries, veröffentlichte Writes in Schreibreihenfolge,
  zurückgegebene Takes in umgekehrter), der Txn-Ablauf in `settle` (erst die Entries bis zum Ablauf der Txn, dann ihr
  Abbruch zu deren Zeit), `reserve` gegen eine Txn und die Summe aller Reservierungen gegen `maxJobBytes`.
- **Eine Feinheit:** `createTxn` zieht die Id vor dem Lease; eine ungültige Lease verbraucht sie trotzdem.
- **Verweigerung:** Eine Txn mit Abschlussprofil, genommenen Aufgaben, Run-Bindung oder Herkunfts-Claim
  (`completion`, `takenTasks`, `runs`, `originRequestKey`, `completionDeadline`) beantwortet der Rust-Kern mit
  `NotPorted`.
- **Tests:** Der Zufallsgang öffnet, nutzt, verlängert, bricht ab und committet Txns. Der Grenztest prüft die
  Reservierung von Writes und Takes, einen Commit, dessen eigenes `settle` erst Entries ablaufen lässt (er scheitert
  dann an `maxCommitBytes`), eine abgelaufene Txn am Commit-Budget, zwei gleichzeitig ablaufende Txns und
  `maxJobBytes` über mehrere Txns. Ein Lauf mit 200 000 Schritten (`--release`) war abweichungsfrei.
- **Gegenprobe:** Eingebaute Fehler werden erkannt: keine Umkehr der Writes, `returned` nicht gezählt, ohne
  Commit-Kosten, `<=` bei gleichzeitigem Ablauf, ohne Summe der Reservierungen, Abbruch zur falschen Zeit, Id nach dem
  Lease, kein `announced`, Reservierung auch für eigene Writes. Unentdeckt bleibt nur ein Fall, der nicht eintreten
  kann: ein Take auf einen Entry, den eine andere Txn schrieb.

**Stand Scheibe 3 (2026-10-30):**

- **Modell:** `WaiterRec` und `RpcState` sind typisiert. Claims und Generationen bleiben die JSON-Sätze des TS-Kerns,
  in der Reihenfolge, in der sie kamen.
- **`phi-core::claims`:** `issueGeneration` (HMAC über die kanonische Form, Schlüssel und Nonce aus der Zufallsquelle
  des Space), `admit`, `decide`, `lookup` und der begrenzte Sweep (128 Bytes je Satz, Schlüssel in UTF-16-Ordnung,
  `sweepAt`).
- **Zufall:** Der Space bekommt eine Zufallsquelle. Der Treiber gibt ihm denselben gesäten Strom wie `core-driver.ts`,
  so dass Schlüssel, Nonces und Generationen auf beiden Seiten gleich sind.
- **Wartende:** `addWaiter` mit `refreshReservations`, `cancelWaiter`, Leases auf Wartende, `serve` für Wartende mit
  und ohne Claim (ein Take unter frischer Txn, die sich den Schlüssel einer `wait`-Anfrage merkt), Ablauf mit
  Timeout-Ereignis oder Entscheidung, `publishCost` mit den Ereignissen passender Wartender, Ereignisgrenzen beim
  Schreiben (`checkEventSize`, `preflightFanout`).
- **Outbox und Jobs:** Ereignisse gehen in die Outbox. Ein abschließendes Ereignis, das nicht mehr passt, wartet in
  einem Fanout-Job, und `runJobs` setzt ihn fort. Consumer und Mailboxen kommen mit Scheibe 4.
- **`settle`** kann jetzt scheitern (ein Ergebnis über seiner Reservierung, ein zu großes Ereignis). Der Fehler geht
  wie im TS-Kern an die Operation, nach dem, was bis dahin geschah.
- **Treiber:** `core-driver.ts` hat die Zeile `park` (`parkOperation`) bekommen, die Rust-Seite dieselbe.
- **Tests:** Der Zufallsgang stellt Wartende, parkt Anfragen und spielt kurze Episoden einer Anfrage (Generation,
  Zulassung, Parken oder Entscheiden, Wiederholung, Abfrage). Die Generationen sind meist die des eigenen Prinzipals
  und frisch, sonst läuft fast alles in `RequestExpired`. Grenzfälle: gleichzeitig ablaufende Wartende und Claims am
  Commit-Budget, Aufbewahrung an ihren Rändern (das Ergebnis läuft genau bei `admitUntil` ab) und die Txn eines
  bedienten `wait`. Ein Lauf mit 200 000 Schritten (`--release`) war abweichungsfrei.
- **Gegenprobe:** Eingebaute Fehler in Kosten, Ablaufreihenfolge, `ifExists`, `serve` nach Abbruch, Jobs,
  Reservierungen, Lease-Dauer, Sweep-Ordnung und -Grenzen, Claim-Bytes und Zulassungsende schlagen fehl. Gleichwertig
  und unentdeckt bleiben `sweepAt` `now` statt `now + 1` (Zeiten sind ganze Millisekunden) und das Nachzählen von
  Txns ohne Reservierung (sie schreiben nichts).

**Stand Scheibe 4 (2026-10-30):**

- **Modell:** `RegRec` und `Mailbox` sind typisiert, die Mailboxen in der Reihenfolge, in der sie entstanden.
- **Abonnements:** `notify` (auch unter einer Txn), Ereignisse beim Schreiben und beim Commit (`notifyWrite`, `emit`),
  die Drosselung je Gespräch mit gezählten und gebündelt nachgesandten Writes (`flushRegs`), Ablauf (das offene
  Bündel geht noch hinaus, ein Consumer bekommt `registrationClosed`), Kündigen, Verlängern und das Ende mit der Txn.
  `publishCost`, `checkEventSize`, `refreshReservations` und `preflightFanout` zählen die Abonnements mit.
- **`phi-core::mailbox`:** Mailboxen je Prinzipal (`box`, `appendMail`, Kapazität, Bündelprüfung beim Schreiben),
  Seiten (`events`) mit Epoche und Lücke, `ack` und die begrenzte Wartung, die Quittiertes und Abgelaufenes
  entfernt. Ein abgelaufenes Take-Ereignis stellt seine Txn in die Freigabe-Warteschlange, `settle` bricht sie ab.
- **Jobs mit Consumer:** Ein abschließendes Ereignis für einen Consumer geht immer über einen Fanout-Job; `runJobs`
  liefert in die Mailbox, sobald sie Platz hat, und ein `ack` macht wartende Jobs des Prinzipals sofort fällig.
- **Uhr:** Wo der TS-Kern selbst `Date.now()` liest (eine neue Mailbox, ein `ack`), liest der Rust-Kern
  `Space::clock`; der Treiber setzt sie wie `core-driver.ts` auf das `now` der Zeile.
- **Tests:** Der Zufallsgang abonniert (mit und ohne Consumer), gibt Wartenden Consumer, blättert, hängt an und
  quittiert. Kurze Abonnement-Episoden schreiben mehrere passende Entries dicht hintereinander, sonst kommt keine
  Bündelung vor. Grenzfälle: die Drosselung bei genau einem Intervall, ein Abonnement mit offenem Bündel am
  Commit-Budget, ein Txn-Abonnement an der Outbox-Grenze, `maxMailboxBytes`, Mailboxen in `maxDocBytes` und ein Job,
  den ein `ack` wieder anstößt. Ein Lauf mit 200 000 Schritten (`--release`) war abweichungsfrei.
- **Gegenprobe:** Eingebaute Fehler in Intervallgrenze, Bündelzähler, Ablaufkosten, Txn-Reservierung, Vorprüfung unter
  Txn, Jobs mit Consumer, Wiederanstoß nach `ack`, Cursor, Mailbox-Kapazität, TTL, Lücke und Mailbox-Bytes schlagen fehl.
- **Gleichwertig und unentdeckt:** die Bündelzahl beim Schreiben (offene Bündel leert `flushRegs` schon im `settle`
  derselben Operation), doppelte Einträge der Freigabe-Warteschlange (in derselben Runde verarbeitet), die
  Lückenprüfung beim `ack` (quittiert werden immer zusammenhängende Präfixe) und `nextExpiry` 0 bei nicht leerer
  Warteschlange (sie wird gleich nach dem Füllen geleert).

**Stand Scheibe 5 (2026-10-30):**

- **`phi-core::snapshot`:** Ein `Snapshots`-Cache je Host, neben dem Dokument wie in `snapshot.ts`. Eine Antwort, die
  in eine Seite passt, braucht keinen Snapshot und kein Token. Eine größere wird einmal kopiert, ihre Seiten kommen
  über `ss<hex>.<Position>` aus der Kopie, gebunden an Stream, Prinzipal und Anfrage. Der Cache ist nach Gebrauch
  geordnet; Platz machen zuerst die zu Ende gelesenen, dann die am längsten unbenutzten. Grenzen: `maxSnapshots`,
  `maxSnapshotBytes`, `snapshotTtlMs`.
- **Treiber:** `core-driver.ts` hat die Zeile `snapshotPage` (ein Host je `init`), die Rust-Seite dieselbe.
- **Tests:** Der Zufallsgang liest Snapshot-Seiten (mit fremdem Token, falschem Cursor, anderem Prinzipal), und kurze
  Episoden schreiben mehrere Entries und folgen den Seiten bis zum Ende. Grenzfälle: ganze Antwort oder Snapshot, die
  TTL bei genau ihrem Ablauf, die Reihenfolge der Verdrängung und `maxSnapshotBytes`.

**Befund aus Scheibe 0:** `parkOperation` (`core.ts`, `touch(s, Date.now())`) und `ackMailbox` (`mailbox.ts`) lesen
die Uhr selbst, statt `now` zu übernehmen. Der Rust-Kern nimmt `now` als Parameter. Im TS-Kern sollten beide Stellen
`now` bekommen, damit Wiederholungen mit fester Uhr deterministisch sind.

### R2: `phi-store`

**Arbeit:**

- Host mit Commit-Vertrag (4.1/4.2 aus `umstellung-ohne-pi-durable.md`), Teile, `DISK_MAP`.
- SQLite-Ledger mit Schreib-Thread; Speicher-Modus `memory`.
- Vorbereitung der Betriebspfade: Backup/Restore, Kompaktierung, sauberes Schließen und Wiederöffnen.
  Die in R0 beobachtete Request-abhängige Verlangsamung von `memory` bekommt eine Ursachenprüfung und einen
  wachsenden Claim-Lastfall; eine reine Entries-Optimierung erledigt diesen Befund nicht automatisch.

**Abnahme:**

- Kreuzbetrieb mit TS-Dateien.
- Crash/Reopen wie in `test/support/persistent.ts` und `test/test-own-store.test.ts`: SIGKILL vor, während und
  nach dem SQL-`COMMIT`, insbesondere nach Persistierung vor Bestätigung. Jeder bestätigte Commit bleibt erhalten;
  ein unbestätigter kann fehlen oder vollständig vorhanden sein, nie teilweise. Retries benutzen die ursprüngliche
  Request-Identität und erzeugen keinen zweiten Effekt. SIGKILL allein ist kein physischer Power-Loss-Nachweis.
- Fehlerpunkte für volle Platte (`SQLITE_FULL`), Writer-Ausfall und Persistierungsfehler: keine Erfolgsbestätigung,
  keine Watch auf undauerhaften Zustand, Host bis Reopen gesperrt; bereits Bestätigtes bleibt erhalten.
- Überlappende Commits sehen die Änderungen ihrer Vorgänger auch vor deren Persistierung; externe Snapshots und
  Watches sehen nur dauerhaften Zustand. Callback-/`prepare`-Fehler nehmen den ganzen Commit zurück. Batching,
  Watch-Bündelung und Schließen mit wartenden Commits werden getrennt geprüft.
- Backup während laufender Writes, Restore und Weiterschreiben, Kompaktierung zwischen Writer-Batches sowie
  Owner-Lock/Format-/Dokumentversionsprüfung; Rust-Gegenstücke zu `test/test-own-store-ops.test.ts`.
- Dieselben Zeilen in `documents`/`parts` nach gleichen Operationen, kanonisch verglichen.

**Schnitt (2026-10-30):** R2 läuft wie R1 in Scheiben.

| Scheibe | Inhalt | Stand |
|---|---|---|
| 0 | Crate `phi-store`: Datei öffnen (Owner-Lock wie TS, WAL, Schema, Format 1→2), Dokument aus Kopf und Teil-Zeilen laden, Zeilen-Ops, Schreib-Thread mit Batches, Speicher-Ledger | erledigt |
| 1 | Host: ein Commit je Operation mit Rücknahme, Teil-Änderungen mit `ord`; der Rust-Kern im Host-Modus (Wasserstand, Budget und offener Batch je Commit neu; Claims als `DISK_MAP` mit den Plattenzweigen des TS-Kerns); TS-Store-Treiber und Zufallsgang gegen ihn | erledigt |
| 2 | Absturz und Wiederöffnen an den Commit-Grenzen; Schreibfehler, voller Datenträger, Writer-Ausfall und gesperrter Host nach Persistierungsfehler | erledigt |
| 3 | Claims wirklich auf der Platte (gezielt gelesen statt im Speicher), Speicherbudget des Hosts | erledigt bis auf das Speicherbudget (kommt mit dem Host für mehrere Spaces, R3) |
| 4 | Backup/Restore unter Last, Kompaktierung und Shutdown; wachsender Claim-Bestand in SQLite und `memory` | erledigt |

**Befunde vor Scheibe 1:**

- **Claims auf der Platte:** Auf SQLite ist `rpc.claims` vom ersten Persistieren an ein `DISK_MAP`. Damit nimmt der
  TS-Kern andere Zweige als im Treiber von R1: `docBytes`, `nextExpiry` (0 ohne `sweepAt`), `serve` (keine Suche
  nach dem `originRequestKey` einer `wait`-Anfrage), `previewOf` und der Sweep (`disk.due` sortiert per SQL nach
  Bytes, nicht nach UTF-16, mit Limit und Gruppenfilter). Scheibe 1 bildet diese Zweige nach. Erst Scheibe 3 lädt
  die Claims wirklich lazy.
- **Lebensdauer:** Der Host lässt den Kern je Commit auf einem neuen Entwurf laufen, Snapshots sind neue Objekte.
  Wasserstand, Commit-Budget und offener Batch beginnen also je Commit neu, und eine scheiternde Operation wird
  zurückgenommen. Der Rust-Host muss das genauso tun.
- **Kosten (gemessen 2026-10-30):** Eine Kopie der Entries und ein Vergleich nach Wert kosten bei 10 000 Entries
  21 ms je Commit (`--release`), gegen 1,5–3,4 ms Server-CPU je Aufruf in R0. Der Rust-Space merkt sich deshalb, was
  ein Commit an den Teilen ändert (Entries, Claims, Generationen, Stream-Batches), mit einem Undo-Protokoll für die
  Rücknahme, und schreibt O(Änderungen). Der Kopf wird wie im TS-Store je Commit ganz geschrieben; seine Kopie für
  die Rücknahme kostet dasselbe O(Kopf). Die Arrays ändert der Kern nur durch Anhängen, Entfernen und Ersetzen an
  Ort und Stelle: genau der Fall `alongside` in `parts.ts`, also folgen die `ord` ohne Vergleich.
- **Alte Versionen:** Ein Dokument unter der Version seiner Definition (TS: `migrate`) verweigert der Rust-Store
  vorerst. Vor R4 wird das an Store-Kopien der Zielanwendungen geprüft; eine nötige TS-Migration ist ein
  dokumentierter Vorbereitungsschritt, keine stillschweigende Rust-Migration.

**Stand Scheibe 0 (2026-10-30):** `rusqlite` mit gebündeltem SQLite. `store.sql` wird geöffnet, jedes Dokument
geladen und in eine neue Datei geschrieben, die dieselben Zeilen hält (`documents`, `parts`, `store_meta` ohne
Store-Id, Zähler und Index-Marken). Die Lesesitzung des TS-Stores auf der Rust-Datei antwortet genau wie
`store.expected.json`. TS- und Rust-Store weisen einander über dieselbe Owner-Sperre ab. Die Index-Spalten der
Claims und der Zähler je Batch (`commit_seq`) sind eigens geprüft.

**Stand Scheibe 1 (2026-10-30):**

- **Änderungen statt Kopien:** `phi-core` führt die Entries als eigenen Typ `Entries`, der sich nur über Methoden
  mit Undo-Protokoll ändert (Anhängen, Entfernen, Ändern an Ort und Stelle). Claims und Generationen ändern sich
  über `claim_put`/`generation_put`, die Stream-Funktionen geben die verworfenen Batches zurück.
  `begin_tracked_commit` kopiert nur den Kopf (ohne Entries, Log und Claims), `end_commit` liefert die Änderungen,
  `rollback` macht sie rückgängig. Der Kopf wird nie mit seinen Teilen serialisiert (`to_json_head`).
- **Host-Modus:** Je Commit beginnen Wasserstand, Budget und offener Batch neu, wie auf dem Entwurf des TS-Hosts.
  `claims_on_disk` gilt, sobald der RPC-Zustand gespeichert ist. Damit nimmt der Kern die Plattenzweige: `docBytes`
  über die Summe, `nextExpiry` 0 ohne `sweepAt`, keine Suche nach dem Schlüssel einer `wait`-Anfrage in `serve`,
  und der Sweep über `due`/`nextAt`.
- **`phi-store::SpaceHost`:** Ein Commit je Operation. Scheitert sie, wird zurückgenommen und nichts geschrieben.
  Gelingt sie, gehen der Kopf (nur wenn er oder ein Teil sich änderte) und die geänderten Teil-Zeilen an den
  Schreib-Thread, bestätigt erst nach dem Schreiben. Die `ord` der Arrays folgen der Regel `alongside` mit dem
  wachsenden Höchstwert, wie in `parts.ts`. Ein Dokument einer älteren Version (TS: `migrate`) wird abgewiesen.
- **Treiber:** `test/support/store-driver.ts` spielt die Zeilen von `core-driver.ts` als Commits des
  `NamedSpace`-Dokuments über den TS-Store (eigene SQLite-Datei oder Speicher). `core-driver.ts` exportiert dafür
  `apply`, `install`, `reseed` und `tick`.
- **Prüfung `phi-store/tests/store_walk.rs`:** Der Zufallsgang aus R1 (jetzt `phi-core/tests/common/walk.rs`, von
  beiden Crates genutzt) läuft durch beide Hosts in je eine Datei. Verglichen werden Antwort und Zustands-Hash je
  Schritt und am Ende die Zeilen beider Dateien (`documents`, `parts`, Werte kanonisch). Vorgabe sind 2 000 Schritte,
  `PHI_STORE_WALK_STEPS` für mehr. Das fsync je Commit macht den Gang langsam (etwa 60 ms je Schritt für beide
  Seiten zusammen).
- **Plattenzweige:** Sie unterscheiden sich im Zufallsgang kaum vom Speicherzweig. `docBytes` ergibt dieselbe Zahl,
  weil die Summe genau die JSON-Bytes ohne Klammern zählt; `sweepAt` ist immer gesetzt; der Sweep liefert dieselben
  Mengen. Beobachtbar ist nur `serve`: Ein fester Fall (`a_served_wait_with_its_claim_on_the_disk`) hält ihn fest.
- **Gegenprobe:** Erkannt werden ein falscher `ord`-Zähler (die Dateien unterscheiden sich), ein Wasserstand, der
  über Commits bleibt, ein Host ohne Plattenzweig und ein Host ohne Rücknahme.

**Stand Scheibe 2 (2026-10-30):**

- **Absturz** (`phi-store/tests/crash.rs`, wie `test/test-own-store.test.ts`): Ein Kindprozess (das Testprogramm
  selbst, oder `store-crash-child.ts`) committet Paare von Entries, bis er mit SIGKILL getötet wird. Zu einem
  beliebigen Zeitpunkt getötet, ist jedes bestätigte Paar da und keines nur halb; Rust- und TS-Store lesen die
  abgestürzte Datei gleich, auch die eines TS-Kindes. Vor dem `COMMIT` des dritten Batches angehalten
  (`PHI_SPACES_WRITER_PAUSE`, der Schalter des TS-Schreibers), sind genau die bestätigten Commits da; danach angehalten,
  ist der dritte da, unbestätigt. Die Sperre des toten Eigentümers ist frei.
- **Schreibfehler** (`tests/failures.rs`): voller Datenträger (`max_pages`, `SQLITE_FULL`), ein Fehler vor dem
  `COMMIT`, eine verlorene Antwort danach und ein verschwundener Schreib-Thread (`Fault`, wie `StoreFaults` im TS-Store).
  Der scheiternde Commit wird nicht bestätigt, der Host nimmt bis zum Wiederöffnen nichts mehr an und lässt die
  Operation gar nicht erst laufen, Bestätigtes bleibt erhalten.
- **Wiederholung:** Eine Anfrage, deren Antwort verloren ging (Zulassung, Wirkung und Entscheidung in einem Commit wie
  `client.ts` `mutate`), wird unter ihrer ursprünglichen Identität wiederholt. Sie bekommt das gespeicherte Ergebnis
  und hat keine zweite Wirkung.
- **Gegenprobe:** Ein Schreiber, der vor dem `COMMIT` bestätigt, und ein Host, der nach dem Fehler weiterarbeitet,
  fallen durch.
- **Befund aus dem langen Store-Gang:** Der TS-Entwurf ändert Map-Teile (Claims, Generationen) an Ort und Stelle und
  nimmt einen gescheiterten Commit durch Zuweisung zurück (`draft.ts`). Ein Schlüssel, den der Commit löschte, steht
  danach am Ende der Map statt an seinem Platz. Spätere Sweeps gehen nach dieser Reihenfolge, wenn das Budget nur für
  einen Teil reicht. Der Rust-Host nimmt Map-Teile jetzt genauso zurück. Danach war ein Store-Gang mit
  20 000 Schritten (`--release`, 1 304 s) abweichungsfrei in Antworten, Zuständen und den Zeilen beider Dateien.
- **Überlappende Commits** kamen mit Scheibe 4 (siehe dort).

**Stand Scheibe 3 (2026-10-30):**

- **`Claims` in `phi-core`:** Die Claims sind eine Map im Speicher oder ein Plattenteil (`DiskClaims`, wie
  `disk-map.ts`). Der Plattenteil hält nur, was noch nicht dauerhaft ist, und die offenen Claims (ohne `decidedAt`).
  Alles andere liest er über eine `ClaimSource` aus dem Store: `get`, `due`, `nextAt`, `group`. Der Kern wählt seine
  Zweige nach dieser Art, wie `core.ts` nach `diskMapOf`; das Flag aus Scheibe 1 entfällt.
- **`phi-store::disk::SqliteClaims`:** Die Abfragen von `sqlite.ts` `#source` über eine eigene Leseverbindung, mit
  denselben SQL-Texten. Ein geladenes Dokument bekommt sofort einen Plattenteil; eine Map, die noch im Speicher ist,
  wird es nach ihrem ersten dauerhaften Commit (`DiskMap.adopt`). Nach jedem dauerhaften Commit gibt der Plattenteil
  das Geschriebene frei (`settle`).
- **Kein Aufzählen:** Wo der Kern die ganze Map lesen müsste (alte Zustände ohne Summe, `assert_ported`, die Suche in
  `serve`), nimmt er wie TypeScript den Plattenzweig oder liest nur, was im Speicher liegt. `DiskClaims::entries`
  liest bewusst alles und zählt mit (`enumerations`).
- **Prüfung `tests/claims_on_disk.rs`:** 600 Claims werden zugelassen und entschieden; der Speicher hält keinen davon,
  keine Operation liest die ganze Map, der Sweep räumt in Schritten von 40 Datensätzen (Commit-Budget) auf, und
  dieselben Zeilen durch den TS-Store geben dieselben Zustände. Der Store-Gang läuft mit den Claims auf der Platte.
- **Speicherbudget:** Der TS-Host verdrängt Dokumente, die am längsten unberührt sind, und lädt sie bei Bedarf neu.
  Der Rust-Host trägt bisher ein Space-Dokument; das Budget kommt mit dem Host für mehrere Spaces (R3).
- **Befund:** Ein neu geladenes Dokument hat seine Generationen in der Reihenfolge der SQL-Abfrage (`ORDER BY part,
  ord`, bei gleichem `ord` nach dem Schlüssel), nicht in Einfügereihenfolge. Reicht ein Sweep nur für einen Teil,
  hängt es also davon ab, ob der TS-Host das Dokument zwischendurch verdrängt hat. Der Rust-Host muss beim
  Verdrängen dieselbe Abfrage nehmen, dann gilt dasselbe für ihn.

**Stand Scheibe 4 (2026-10-30):**

- **Ursache der Verlangsamung von `memory` (Befund 1 aus R0):** Die Vermutung traf nur teilweise zu. Ein Profil im
  verlangsamten Abschnitt zeigt 68 % in `pendingClaims` (`client.ts` `beginOperation` durchsucht je Anfrage alle Claims),
  12 % in `finalize` (`draft.ts` läuft über den Stream-Log) und 11 % in `#weigh` (`host.ts` zählt die Map-Schlüssel je
  Commit). Es sind also O(Claims)-Schleifen je Aufruf, nicht die Größe des Dokuments. Mit SQLite greifen sie nicht,
  weil dort nur die offenen Claims im Speicher liegen. Der TS-Code ist unverändert, der Befund gilt dort weiter.
- **Der Rust-Store erbt das nicht:** Claims im Speicher sind `MemoryClaims` (Zugriff O(1) statt der Liste in `Object`,
  Reihenfolge wie ein JavaScript-Objekt). `assert_ported` prüft sie nur beim Laden. `pendingClaims` selbst kommt mit R3.
- **Messung (`tests/operations.rs`):** 200 Anfragen, Release-Build. SQLite im tmpfs: 28 ms bei 1 000 Claims, 38 ms bei
  22 200; ein Lauf bis 40 000 Claims blieb bei 0,15 ms je Anfrage. Der Speicher-Host bleibt ebenso flach (Debug-Build:
  25 ms bei 100, 27 ms bei 3 300). Auf `/dev/md0` kosten dieselben Anfragen 3,9 bis 5,8 ms: Das ist die Platte
  (Checkpoints), nicht der Code. `PHI_STORE_GROW_DIR` wählt das Verzeichnis, `PHI_STORE_CLAIMS` den Bestand.
- **Überlappende Commits:** `SpaceHost::start_commit` übergibt die Zeilen, ohne zu warten; der nächste Commit baut sofort
  darauf auf. `durable(seq)`, `committed()` und Watches sehen nur Dauerhaftes, `pump` nimmt Bestätigtes auf. Der Host
  bleibt synchron, Tokio ist noch nicht nötig; R3 muss `pump` antreiben. Plattenteile tragen dafür je Eintrag die Nummer
  ihres Commits (`stamp`), wie `DiskMap`. Ein gescheiterter Batch lässt alle überlappenden Commits scheitern, auch Leser.
- **Watches** melden nur dauerhafte Commits, gebündelt auf die neueste Nummer. Den Wert liest man über `committed()`.
- **Bündeln und Schließen:** Was während eines Batches ankommt, geht in den nächsten (19 Commits in einem Batch). `close`
  schreibt alles noch Unterwegsene; danach ist die WAL aufgelöst und die Sperre frei.
- **Backup/Restore:** `backup` (`VACUUM INTO`) neben laufenden Writes ergibt einen Präfix der Commits, die Integrität
  stimmt, und der kopierte Stand schreibt weiter, ohne das Original zu berühren. Rust- und TS-Store lesen ihn gleich.
- **Kompaktierung** läuft wie im TS-Schreiber zwischen zwei Batches: beim ersten Mal `VACUUM`, danach
  `incremental_vacuum`. Zeilen bleiben gleich, die Datei schrumpft auf weniger als die Hälfte.
- **Prüfungen beim Öffnen:** Format 1→2 samt Füllen der Index-Spalten, ältere Dokumentversion, Teile inline im Kopf und
  negative oder restaurierte Claims. Die letzten drei verweigert der Rust-Store, statt das Dokument zu beschädigen; ein
  Kopf mit Inline-Teilen hätte bis dahin Daten verloren.
- **Store-Gang:** Bei ungerader Saat laufen die Commits überlappend, die Zeilen beider Dateien müssen trotzdem gleich sein.
  Ein Lauf mit 8 000 Schritten (`--release`, 506 s) war abweichungsfrei.
- **Gegenprobe:** Ohne Stempel, mit Watch ohne Meldung, ohne Bündeln und ohne Inline-Prüfung schlägt je ein Test fehl.
- **Nach Scheibe 3** war der Store-Gang mit 20 000 Schritten abweichungsfrei.
- **Bleibt für R3:** Speicherbudget und mehrere Spaces, `pendingClaims`, `migrate` älterer Dokumente, Inline-Teile.

### R3: `phi-service`, `phi-wire`, `phi-space-server`

**Arbeit:**

- Alle `METHODS` aus Abschnitt 2 und Pending/Poll, einschließlich `cancelOperation` und Auflösung im aktuellen
  Epoch. Die in R1 Scheibe 6 genannten Pfade und die JSON-Vertragsentscheidung sind Voraussetzungen.
- Hintergrunddienst entsprechend `startService`: Fristen/Leases auch ohne eingehende RPCs, Claim-Wartung,
  Outbox-Zustellung beziehungsweise deren Fehler-/Freigabepfade, Mailbox- und Fanout-Wartung.
- Quoten (`maxCallsPerWindow`, `maxPendingPerPrincipal`, `maxPendingPerPeer`), `wakeOnCommit` und
  `maxInflightPerConnection`.
- Identität aus der Verbindung: im Standalone fest; TCP nur auf Loopback oder einem gleichwertig abgeschotteten
  internen Netz. Ein integriertes Gate kommt erst in R5. Identität darf nie aus dem Aufruf übernommen werden.
- Projekt-Startprofile mit derselben Bootstrap-Semantik wie die bisherigen `space-host.ts`. Ob ein schmaler
  TS-Wrapper den Bootstrap ausführt oder das Rust-Binary Projektprofile bekommt, bleibt Implementierungswahl.
  Locks und Limits sind vor der Bereitschaftsmeldung eingerichtet; der allgemeine Standalone-Standard bleibt erhalten.

**Pflichtmatrix für die Projekt-Startprofile** (aus den Host-Dateien abgeleitet, bei Änderungen synchron halten):

| Vertrag | spaces-mmo | codemode-chat |
|---|---|---|
| Stores/Listener | world und accounts getrennt; Auswahl per `SPACES_MMO_SPACES`, Region-Dateinamen und jeweilige Adressen; beide Rollen gemeinsam oder getrennt startbar | ein Store/Listener; `CODEMODE_SQLITE`, `CODEMODE_LISTEN`, `CODEMODE_MEM` |
| Peer-ID | `peer-mmo-world` bzw. `peer-mmo-web` | `peer-codemode` |
| Dienstquoten | 50.000 Aufrufe/Fenster, 4096 Pending je Prinzipal/Peer, 1024 Inflight/Verbindung, `wakeOnCommit` | 50.000 Aufrufe/Fenster, 4096 Pending je Prinzipal/Peer; übrige Werte wie im bisherigen Host |
| Space-Limits | Owner-Limits je 1000; Claim-Retention und Generation-Zulassung standardmäßig 10 min, Log 512 KiB, jeweilige ENV-Overrides | Owner-Limits je 1000; sonstige Retention-/Log-Standards wie bisher |
| SQLite-Limits | `maxClaimBytes` 512 MiB, `maxDocBytes` 640 MiB | `maxClaimBytes` 512 MiB, `maxDocBytes` 640 MiB |
| Bootstrap/Betrieb | `NAMES_LOCK`, `WORLD_LOCK`, `NPC_LOCK` ohne Duplikate; Prozesspräsenz; Kompaktierung mit `SPACES_MMO_COMPACT_MS`; Wartungs-Debounce wie bisher | Prozesspräsenz, Wartungs-Debounce wie bisher |
| Starter-Vertrag | bisherige ENV-Auswahl, Ready-/Fehler-/Shutdown-Verhalten und Metriken bleiben für Launcher und Tests nutzbar | ebenso für den codemode-Launcher und seine Tests |

Bestehende Dateien behalten Store-/Host-/Space-Ids, Inkarnation, Signierschlüssel und Peer-/Owner-Bindungen.
Ein Testschalter darf nicht unbemerkt den alten TS-Host statt des Rust-Servers starten.

**Abnahme:**

- Gruppe A und die als B3 zugeordneten Fälle laufen mit `PHI_SPACES_SERVER_CMD` gegen den Rust-Server; die
  Fallmatrix aus Abschnitt 5 zeigt den tatsächlichen Prozess und alle noch nicht fälligen B5/R5b/R6-Fälle.
- Die Beispiele sieve und cache laufen mit `--remote`.
- `npm --prefix spaces-mmo test` und `npm run test:codemode-chat` laufen, wenn deren `space-host` durch das
  Rust-Binary ersetzt ist: Startschalter `SPACES_MMO_SPACE_SERVER` bzw. `CODEMODE_SPACE_SERVER`.
- Beide Projekte starten auf frischen und bestehenden Stores; Limits, Locks, Identitäten und Prozesspräsenz
  entsprechen der Pflichtmatrix. TS→Rust→TS mit offenen Claims/Txns und unveränderten Request-Ids ist geprüft.
- Die Perf-Messungen aus R0 sind nach dem korrigierten Verfahren wiederholt; CPU oder Speicher müssen entsprechend
  R-D2 gewinnen, ohne die vorab festgelegten Latenz-/Fehlerratengrenzen zu verletzen (R-D11).

### R4: Betrieb einer Anwendung auf Rust

**Arbeit:**

- Docker-Images von spaces-mmo und codemode-chat bekommen das Rust-Binary als Space-Rolle.
- Zuerst `docker:local:up` auf diesem Rechner.
- Danach, **nach Rückfrage**, der nano-Accounts-Space und die big-Weltregionen.
- Vor dem Umschalten: konsistente Sicherung, Bestandsprüfung und dokumentiertes TS-/Rust-Versionspaar.
  Erst den bisherigen Besitzer stoppen, dann die Datei mit dem neuen Server öffnen; nie zwei Besitzer parallel.
- Rollback-Fenster und zulässige Schema-/Featureänderungen festhalten (R-D12). Rückweg innerhalb dieses Fensters:
  TS-`space-host` mit demselben Startprofil auf derselben Datei. Nach inkompatiblen Änderungen braucht es eine
  eigene Rückmigration oder einen ausdrücklich beschlossenen Restore mit benanntem Datenverlust; kein blinder Downgrade.

**Abnahme:**

- Eine Woche Betrieb ohne Abweichung bei dokumentierter Last, mit überwachten Fehlern, Timeouts, Wartungsrückstand,
  Dateiwachstum und Speicherbedarf. Das freigegebene Versionspaar wird dabei nicht stillschweigend geändert.
- Das Dashboard zeigt die Spaces über ihre Sockets unverändert an.
- Ein geprobter Rückwechsel erhält Entries, Generationen, entschiedene und wartende Requests, aktive Txns,
  Mailboxen/ACK-Cursor sowie Anwendungssitzungen und laufende Weltzeitpläne.

### R5: Sicherer Host (`phi-host`)

**Arbeit:**

- Gate (NetBird-Peers und -Gruppen), Schlüssel-Challenge (Ed25519/P-256).
- Enrollment und Pairing, Grants und Rotation, Supervisor mit Kontroll-Space.
- TLS-Register (`tls-register.ts`) mit `rustls`.
- Diese Stufe übernimmt noch keinen Föderations-Member. Die heutige `startFederationHost`-Komposition darf nicht
  unter Weglassen ihrer Boot-/Autoritätsprüfung als Produktionshost nachgebaut werden; diese Integration folgt R5b.

**Abnahme:**

- B5 mit `test-gate`, `test-auth`, `test-enroll`, `test-supervisor`, `test-grants` und den Sicherheitsteilfällen
  von `test-federation-runtime` läuft gegen den Rust-Host. Die Fallmatrix grenzt Member-/Boot-/Recovery-Fälle ab.
- Abgelaufene/widerrufene Berechtigungen, fremde Signaturen und erneute Verbindungen dürfen keine bestehenden
  Pending-Operationen unberechtigt ausführen; die Prüfung umfasst Ablauf und erneute Autorisierung.

### R5b: Föderationsfähiger Member hinter einem TS-Root

Diese Stufe setzt R5 voraus und ist Pflicht, bevor ein Rust-Server einen heutigen TS-Member ersetzt. Sie portiert
die Member-Seite der bereits vorhandenen Verträge, keinen neuen Rust-Root und keine Replikation. Bleibt sie offen,
bleiben auch die Föderations-Members in TS; der Rust-Standalone ist kein Ersatz.

**Arbeit:**

- Delegationsprüfung und Epoch-/Policy-Bindung (`delegation.ts`), einschließlich der Autorisierung wartender Arbeit.
- Signierte Membership-Instruktionen und lokale Admission (`membership.ts`, `member-admission.ts`): Drain,
  Freeze und bounded completion gelten für lokale und entfernte Zugriffe gleichermaßen.
- RunGate im Kern, signierte `runGateInstruction` und ACKs (`run-member.ts`); ergänzende Member-Instruktionen
  für den freigegebenen Steuerungsumfang, etwa Space-Lifecycle, dürfen nicht still ignoriert werden.
- Boot-Autorisierung, lokale Installation und Autoritätsprüfung aus `boot.ts`/`runtime.ts` samt benötigtem
  Register-/Recovery-Lesevertrag. Nicht unterstützte Recovery-/Replikationszustände bleiben gesperrt statt bedient
  zu werden. Die Controller und die vollständigen Recovery-Abläufe bleiben R6.

**Abnahme:**

- Die Member-/Boot-Teilfälle von `test-federation-runtime` sowie die zugeordneten Fälle aus `test-delegation`,
  `test-membership`, `test-run-member`, `test-run-gate` und `test-bootstrap` laufen gegen Rust.
- Gemischter Betrieb TS-Root→Rust-Member mit Retry, Neustart, Drain, Pause/Stop und ungültigen/veralteten
  Instruktionen; unterstützte und gesperrte Betriebszustände sind ausdrücklich dokumentiert.
- Eine echte Handy-Kopplung über das Testbett (`docs/testumgebung-big.md`, `scenario sieve-mobile`), nach Rückfrage.
  Das Handy kann dabei weiter den TS-Space verwenden; ein Rust-Space auf dem Handy braucht zusätzlich M1.

### R6: Root-Föderation, Replikation, Recovery (zurückgestellt)

**Inhalt:**

- `router.ts`, `federated-space.ts` und die Root-/Controller-Seiten von Delegation und Membership; die für
  R5b nötigen Member-Verträge werden nicht erst auf R6 verschoben.
- `entry-replication*.ts`, `primary-sync.ts`, `replica-control.ts`, Fencing (netcup, container).
- `recovery*.ts`, `restore.ts` und vollständige Boot-/Recovery-Komposition über die Prüfpfade aus R5b hinaus.
- `run-controller.ts`, `workers.ts`, die Controller-Seite von `space-lifecycle.ts`, `deployment.ts`, `alerts.ts`.

**Zurückgestellt, weil:**

- Replikation und Promotion sind laut `implementierungsstand.md` „begonnen, nicht abgenommen“. Einen nicht
  abgenommenen Entwurf zu portieren, verdoppelt nur die offene Arbeit.
- **Entscheidung R-D3:** erst abnehmen, dann portieren, oder in Rust neu entwerfen. Bis dahin läuft ein
  Root beziehungsweise ein Host mit Replikation/Recovery weiter in TypeScript.
- Nach **gesonderter Abnahme von R5b** können Rust-Members hinter dem TS-Root laufen. Gemeinsame Rahmen allein
  reichen nicht: Die signierten Instruktionen müssen geprüft und mit derselben Admission-/RunGate-Semantik
  ausgeführt werden. Replizierte oder im Recovery befindliche Members sind dadurch noch nicht freigegeben.

### R7: Werkzeuge (optional)

- `dashboard.ts` und die TUI lesen nur. Sie können in TS bleiben, weil sie über Sockets lesen.
- Eine Portierung (`ratatui`) lohnt nur, wenn ein Rust-Binary ohne Node auf den Servern gewünscht ist.
- `scripts/bootstrap-spaces.ts` folgt `deployment.ts` in R6.

### R8: Server-Prozesse von spaces-mmo

Setzt R3 und den Messentscheid R-D2 voraus und kann parallel zu R4–R7 laufen. Die Prozesse sind heute Clients des
Spaces und tragen keinen eigenen dauerhaften Spielzustand: Die Welt liegt im Welt-Space, die Konten liegen im
Accounts-Space (`spaces-mmo/docs/architektur.md`). Caches, Verbindungen und laufende Aufgaben bleiben prozesslokal.
Deshalb lässt sich auch hier Prozess für Prozess tauschen. Mehrere World-Worker dürfen gleichzeitig laufen; jeder
Intent wird von genau einem genommen. So kann ein Rust-Worker neben einem TS-Worker an derselben Welt arbeiten.

**Umfang:**

| Prozess | Dateien in `spaces-mmo/server/` | Zeilen (etwa) | Ziel |
|---|---|---|---|
| world | `world-host.ts`, `engine/*` (Kommandos, Cmdsets, Locks, FuncParser, Typeclasses, Prototypen, Weltzeit und Uhr, Zeitpläne, Feuer/Flut/Nebel/Sturm, Gärten, Handel, Bauen, Sweep, Regionen und Übergabe, Übersetzungsregeln, Hilfe) | 4.500 | Rust |
| npc | `npc-host.ts`, `npc/*` (Skripte, Wirtschaft, Rollen-Claims, Modellrollen) | 1.000 | Rust |
| web | `index.ts`, `accounts.ts`, `gateway.ts`, `chat.ts`, `region-spaces.ts`, `settings.ts` | 1.750 | Rust |
| gemeinsam | `space.ts`, `model.ts`, `env.ts`, `launch.ts`, `migrate-regions.ts`, `world-load.ts` | 700 | Rust |
| model | `model-host.ts`, `llm.ts` | 220 | bleibt TS |
| space | `space-host.ts` | 100 | entfällt, Rust-Server aus R3 |

**Verträge, die bleiben müssen:**

- **Entry-Felder** aus `model.ts` (Intent, Character, Item, Room, Exit, Msg, Session, Translate, WorldClock,
  Bed, Building, Listing, Offer, Order usw.) und die Weltversion (`WorldDef.version` im für die Abnahme festgehaltenen
  Quellstand). Sie sind die Schnittstelle zwischen den Prozessen und bleiben in einem gemischten Betrieb gleich.
- **Gateway-Rahmen** (`ClientFrame`/`ServerFrame` in `gateway.ts`, Chat-Rahmen in `chat.ts`). Der Browser-Client
  hängt daran.
- **Konten:** scrypt mit N=16384, r=8, p=1 und 64 Byte Länge, Salz und Hash hex; Sitzungs-Cookie `mmo_sid`, nur sein
  Hash gespeichert. Bestehende Konten müssen sich nach dem Wechsel anmelden können.
- **HTTP-API:** Pfade, Header `x-mmo: 1`, Cookie SameSite=Strict, Ratenbegrenzungen
  (`SPACES_MMO_REQ_PER_MIN`, `SPACES_MMO_GUESTS_PER_HOUR`), Setup-Token.
- **Umgebungsvariablen** der Prozesse, wie sie in den Kopfkommentaren stehen, damit `docker/` und `launch.ts`
  unverändert bleiben.

**Vorarbeiten in TypeScript (R8.0):**

1. **Weltdefinition als Daten.** `worlds/leuchtfeuer/world.ts` und `islands.ts` werden zu einer JSON-Datei, die
   beide Seiten lesen. Das entspricht schon der Regel „eine Welt bringt Daten, nie Regeln“ (`engine/world.ts`).
2. **Modellaufrufe nur im Model-Prozess.** Die Modellrollen der NPCs (`npc/minds.ts`) rufen heute `complete()`
   direkt auf. Sie schreiben stattdessen eine Anfrage als Entry, wie es `Translate` schon tut, und der Model-Prozess
   antwortet. Danach braucht der npc-Prozess kein pi-ai mehr.
3. **Geteilte Typen für den Browser.** Der Client importiert Typen aus `server/gateway.ts`, `chat.ts` und `model.ts`
   sowie `formatWorldTime`/`shownWorldMs` aus `engine/worldtime.ts`. Die Typen ziehen nach `spaces-mmo/shared/` und
   werden in R8 aus Rust erzeugt. Die beiden Funktionen bleiben als kleine TS-Kopie mit Testvektoren, wie
   `test/test-shared-copies.test.ts` es für andere Kopien prüft.
4. **Seite statisch.** Die Next-App ist eine einzige Seite (`app/page.tsx`). Mit `output: "export"` wird sie zu
   statischen Dateien, die jeder Webserver ausliefern kann. Die Prüfung der Build-Id (`.next/BUILD_ID`) zieht in eine
   Datei, die der Export mitschreibt.
5. **Zufall und Uhr injizierbar.** Die Engine nutzt `randomBytes`/`randomInt` und `Date.now()`. Beides kommt über
   den Kontext, damit beide Seiten in den Vergleichstests mit festem Startwert und fester Uhr laufen.
6. **Testaufbau mit Kommandos.** `tests/stack.ts` startet space und world schon als Prozesse, der web-Teil läuft im
   Testprozess (`startServer`). Neu: `SPACES_MMO_WORLD_CMD`, `SPACES_MMO_NPC_CMD`, `SPACES_MMO_WEB_CMD` wählen das
   Programm, und web läuft dann ebenfalls als Prozess.

**Schritte:**

| Schritt | Inhalt | Abnahme |
|---|---|---|
| R8.1 | `phi-spaces-client` vollständig: `RemoteSpace`-Semantik (stabile Request-Ids, Retries, Notify/Wait/Events/ACK, Pending/Poll) und die Helfer aus `src/space-client.ts` (`parseTarget`, `connectSpace`, `readExisting`, `StillHeld`, `takeAll`, `awaitWork`, `keepAlive`) | Client-Szenarien der Gruppen A/B über den Adapter aus Abschnitt 5 gegen TS- und Rust-Server; Sicherheitsfälle erst mit R5/R5b |
| R8.2 | Crate `mmo-engine`: alle Kommandos und Ticks | Vergleichstest: dieselbe Intent-Folge mit fester Uhr und festem Startwert gegen zwei Speicher-Spaces, einmal TS-, einmal Rust-Engine; Entries und Nachrichten kanonisch gleich. Dazu die Engine-Tests (`engine`, `world`, `weltzeit`, `garden`, `build`, `economy`, `collision`, `translate`, `help`) als Vektoren |
| R8.3 | Binary `mmo-world` | `npm --prefix spaces-mmo test` mit `SPACES_MMO_WORLD_CMD`. Gemischter Betrieb: ein TS- und ein Rust-Worker an derselben Welt, `phase1`–`phase5` grün. `test:perf` und `live-load.ts`: TS/Rust am selben Quellstand nach dem R-D2-Verfahren, nicht gegen die historische R0-Tabelle |
| R8.4 | Binary `mmo-npc` | `economy`, `errands`, `phase2`, `phase5` mit `SPACES_MMO_NPC_CMD`; Rollen-Claims zwischen TS- und Rust-Prozess geteilt, keine Rolle doppelt |
| R8.5 | Binary `mmo-web`: HTTP, WebSocket-Gateway, Konten, Chat, Regionen, Einstellungen, statische Seite und Grafiken | alle Tests mit `SPACES_MMO_WEB_CMD`; Anmeldung mit Konten aus einem TS-Lauf; `walk-play` und `regions-live`; einmal von Hand im Browser auf `docker:local:up` |
| R8.6 | Docker: `spaces-mmo/docker/` baut die Rust-Binaries (musl) ins Image; der Model-Prozess bleibt ein Node-Container | `docker:local:up` ganz in Rust bis auf model; danach nano und big **nur nach Rückfrage**. Rückweg nur auf das geprüfte TS-Versionspaar innerhalb des Rollback-Fensters |

Der deterministische Engine-Vergleich steuert auch Tick-/Timer-Reihenfolge und die Zufallsquellen der beteiligten
Clients; er startet mit logisch identischen Spaces und verarbeitet dieselben Eingaben schrittweise. Feste Uhr und
Saat allein machen parallele Worker nicht deterministisch. Gemischter Betrieb wird separat mit konkurrierenden
Intents, Rollen-Claims, Lease-Ablauf, Worker-Abbruch und Zeitplänen geprüft.

**Rückweg und Engine-Freeze (R-D12):** Das Einfrieren des TS-Workers nach R8.3 erlaubt keinen unbegrenzten
Downgrade. Bis zum Ende des vereinbarten Rollback-Fensters bleiben Entry-Schemata, Weltdefinition und Regeln
zum festgehaltenen TS-Stand kompatibel und der Rückwechsel wird getestet. Änderungen, die das brechen, beenden
die Rückwegzusage für dieses Versionspaar und brauchen einen neuen Migrations-/Freigabeplan.

**Grenzen von R8:**

- Die Browser-Seite (`client/`, `app/`, PixiJS und three) bleibt TypeScript.
- Der Model-Prozess bleibt TypeScript (R-D7).
- codemode-chat ist nicht Teil dieser Phase.

## 7. Mobile Laufzeit

`npm run bundle` baut `dist/phi-spaces.mjs` (Space und Agent, `agent/src/with-agent.ts`) für `pi-termux-mobile`
(Node unter Android). Der Agent bleibt TypeScript, also bleibt das Bundle.

**Optionen für den Space-Teil auf dem Handy (Entscheidung R-D4):**

| Option | Vorteil | Nachteil |
|---|---|---|
| a) TS-Space im Bundle behalten | nichts zu tun | zwei Implementierungen auf Dauer, und die Differenztests müssen bleiben |
| b) Rust-Binary für `aarch64-linux-android` als eigener Prozess, das Bundle spricht `RemoteSpace` über einen Unix-Socket | eine Implementierung, Naht wie überall | Cross-Build, ein zweiter Prozess unter Doze |
| c) Rust als Node-Addon (napi) oder WASM im Bundle | ein Prozess | neue Build-Kette, und SQLite in WASM braucht eigenes VFS |

**Empfehlung:** a) bis M1 abgenommen ist, dann b). R4 allein reicht nicht. Die Keystore-Signaturen bleiben auf der
Java/Android-Seite; der Server prüft sie nur.

### M1: Mobile Prozess- und Agent-Anbindung

**Voraussetzungen:** R3/R4 für einen lokalen Space; für den heutigen föderierten Handy-Host zusätzlich R5/R5b
und die konkret benötigten R6-Recovery-Pfade. Ohne deren Abnahme bleibt der föderierte Host in TS.

**Arbeit:**

- `AgentSpaces` über den Socket anbinden: getrennte Conversation-Prinzipale, Generationen und vor dem Aufruf
  im Agent-Store gemerkte Request-Identitäten bleiben erhalten. Eine einzige feste Standalone-Peer-ID ersetzt
  `localSpaces` nicht; die lokale Authentisierung/Zuordnung der Conversations braucht einen festgelegten Vertrag.
- Die bisherige `withEventSink`-Brücke über die Prozessgrenze ersetzen: Events/Mailboxen an Conversations
  zustellen, idempotente Submit-Ids verwenden und erst nach dauerhafter Annahme quittieren. Nicht zustellbare
  Takes müssen ihre Txn gemäß bisherigem Vertrag freigeben; Prozessabbrüche dürfen nichts still verlieren.
- Android-Cross-Build für `aarch64-linux-android`, SQLite-/Dateirechte, Startreihenfolge, Ready-/Shutdown-Vertrag,
  gemeinsame Prozessüberwachung, Socket-Reconnect und Wiederanlauf unter Doze.

**Abnahme:** Agent-Replay und Conversation-Isolation gegen TS- und Rust-Space, Abbruch beider Prozesse an den
Submit-/ACK-Grenzen, Weiterlauf offener Waits/Txns nach Reconnect; Geräteprüfung mit Hintergrund/Doze sowie
Keystore-/Pairing-Prüfung für den föderierten Modus. Reale Geräte-/Testbettläufe erfolgen nach Rückfrage.
Die Auswahl b) beendet weder die TS-Referenz noch die In-Process-API automatisch (R-D5/R-D13).

## 8. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Abweichung im kanonischen JSON (Zahlen, UTF-16-Sortierung) macht Claims ungültig | Golden-Vektoren aus R0 und Kreuzbetrieb; Generationen aus TS-Dateien in Rust prüfen |
| JS-Strings oder Parsergrenzen werden in Rust anders behandelt | R-D10 vor R3 auflösen; Annahme und Ablehnung gegen TS prüfen, nicht eine bekannte Abweichung als Golden-Erfolg zählen |
| Feine Semantik im Kern (Waiter-Wettlauf, Lease-Grenzen bei `FOREVER`, Txn-Abbruch) | Differenz-Harness mit festen Folgen und zustandsbehaftetem Generator; `proptest` optional |
| Zwei Implementierungen laufen auseinander, solange beide leben | Änderungen am Wire-Protokoll und am Kern nur mit Vektor-Update; beide Server in CI (`npm test` mit und ohne `PHI_SPACES_SERVER_CMD`) |
| Der Gewinn ist klein: Node mit SQLite ist schon schnell, die Latenz liegt eher im Netz | Messpunkt R-D2 nach R3, bevor R4–R6 beginnen |
| Aufwand | R0–R3 umfassen etwa 6.000 Zeilen TS, nämlich Kern, Store, Dienst und Socket. R5 fügt etwa 1.500 hinzu, R6 den Rest (etwa 9.000) |
| Spielregeln in zwei Sprachen laufen auseinander; ein eingefrorener TS-Worker ist nicht mehr rückwärtskompatibel | gemischter Betrieb für R8.3; danach Rust-Engine, TS-Stand eingefroren; Rollback nur innerhalb der kompatibel gehaltenen Versionen und Frist aus R-D12 |
| Neue Spielfunktionen (siehe `spaces-mmo/docs/phasen.md`) während R8.2 | R8.2 vom aktuellen Stand abzweigen; jede Änderung am TS-Engine-Code bekommt einen Vergleichsfall und wird in Rust nachgezogen, bevor R8.3 abgenommen wird (R-D8) |
| Neue Toolchain auf big/nano | Statisch gelinktes Binary (musl) in die bestehenden Docker-Images; auf den Servern wird nichts installiert |

## 9. Entscheidungen

| Nr. | Frage | Entscheidung |
|---|---|---|
| R-D0 | Freigabe der Crates aus Abschnitt 4 | **entschieden 2026-10-29:** freigegeben |
| R-D1 | Gleiche SQLite-Datei oder eigenes Format | **entschieden 2026-10-29:** gleiche Datei |
| R-D2 | Weiter nach R3? | **entschieden 2026-10-29:** nur, wenn die CPU je Kommando im Space-Prozess deutlich sinkt (Ziel: mindestens Faktor 2) oder der Speicherbedarf sinkt; korrigiertes Messverfahren in „Stand R0“, Befund 3; offene quantitative Ergänzung R-D11 vor Abnahme klären |
| R-D3 | Föderation portieren, neu entwerfen oder in TS lassen | **entschieden 2026-10-29:** erst nach deren Abnahme entscheiden |
| R-D4 | Space auf dem Handy | **entschieden 2026-10-29:** a), später b) |
| R-D5 | Bleibt der TS-Server dauerhaft? | **entschieden 2026-10-29:** TS bleibt als Referenz und für In-Process-Nutzung (`PhiSpaces`), mindestens bis R-D4 b). Der Handy-Wechsel allein beendet diese beiden Aufgaben nicht; ein späterer Entfall braucht R-D13 |
| R-D6 | Weltdefinition als JSON statt TS | **entschieden 2026-10-29:** JSON (R8.0) |
| R-D7 | Modellaufrufe von spaces-mmo | **entschieden 2026-10-29:** im TS-Model-Prozess lassen (pi-ai: Modellliste, Umgebungsschlüssel und `~/.pi/agent/auth.json` mit OAuth), NPC-Rollen über Entries anbinden. Verworfen: direkte HTTP-Aufrufe aus Rust, weil die Zugangsdaten dann an zwei Stellen verwaltet würden |
| R-D8 | Spielentwicklung während R8.2 | **entschieden 2026-10-29:** in TS weiterentwickeln, Rust zieht nach |
| R-D9 | Zusätzliche Crates für R8: `axum` oder `hyper` (HTTP), `tokio-tungstenite` (WebSocket), `scrypt`, `ts-rs` (TS-Typen aus Rust), `tower-http` (statische Dateien) | **entschieden 2026-10-29:** freigegeben |
| R-D10 | Verlustfreie JS-Strings oder gemeinsame Vertragsänderung? | **offen, vor R3:** UTF-16-Codeeinheiten einschließlich unpaariger Surrogate verlustfrei halten oder TS-Vertrag bewusst ändern, Bestände prüfen und beide Seiten/Vektoren anpassen; die derzeitige Rust-Ablehnung ist keine Freigabe |
| R-D11 | Quantitative Ergänzung zu R-D2 | **offen, vor R3-Abnahmemessung:** Mindest-RSS-Gewinn sowie zulässige p95/p99-, Fehler- und Timeout-Regressionsgrenzen je Lastprofil festlegen; nicht erst nach Sichtung der Ergebnisse |
| R-D12 | Rollback-Fenster und kompatible Versionspaare | **offen, vor R4 und erneut vor R8.3:** Dauer, TS-/Rust-Versionen, unterstützte Schemata/Features und Downgrade-Grenzen festlegen; Rückwechsel mit laufender Arbeit prüfen |
| R-D13 | Späterer Entfall der TS-Referenz/In-Process-Implementierung | **offen, kein Teil der Handy-Freigabe:** erst mit Ersatz für Referenztests und `PhiSpaces`-In-Process-Nutzung oder einer ausdrücklich beschlossenen API-Änderung; bis dahin bleibt TS erhalten |
