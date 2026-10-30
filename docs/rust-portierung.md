# Portierung von phi-spaces nach Rust

Stand: 2026-10-29. **Ziel- und Arbeitsplan.** R0 ist umgesetzt (Abschnitt 6, „Stand R0“). Es gibt noch keinen
Rust-Code und keine Cargo-Dateien. Die Entscheidungen R-D0 bis R-D9 (Abschnitt 9) sind am 2026-10-29 getroffen, die genannten
Crates damit freigegeben.

## 1. Ergebnis und Abgrenzung

Ziel ist ein Space-Server in Rust. Er ist von außen nicht vom heutigen `src/standalone.ts` zu unterscheiden: gleiches
Wire-Protokoll, gleiche SQLite-Datei und gleiche Semantik. Danach folgt Schritt für Schritt die Host-Laufzeit
(Gate, Auth, Enrollment, Grants, Supervisor). Föderation und Replikation kommen zuletzt oder gar nicht, siehe 6.6.

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
  `stats`, `batch`, `spaces`, `txn`, `lease`, `changes`, `notify`, `wait`, `events`, `ack`, dazu die Kommandos der
  Kontrollebene.

Damit lässt sich die Portierung als „Würger“ vorziehen:

- Ein Rust-Binary `phi-space-server --store FILE|memory --listen unix:…|tcp:…` ersetzt `npm run space-server`.
- Später ersetzt es auch den `space-host`-Prozess eines Projekts.
- Kein Anwendungscode ändert sich.
- Jede Stufe lässt sich einzeln zurücknehmen: TS-Server wieder starten, dieselbe Datei öffnen.

## 3. Unveränderliche Verträge (byte-genau)

Die Rust-Seite muss diese Punkte bitgleich treffen. Für jeden Punkt erzeugt Phase R0 Golden-Vektoren aus der
TypeScript-Implementierung.

| Vertrag | Ort heute | Falle |
|---|---|---|
| Kanonisches JSON (RFC 8785) | `src/canonical.ts` | Schlüssel sortiert nach **UTF-16-Codeeinheiten**, nicht nach UTF-8-Bytes (Unterschied bei Zeichen jenseits U+FFFF gegen U+E000–U+FFFF). Zahlen in **ECMAScript-Form** (`1` statt `1.0`, Exponent ab 1e21, `-0` → `0`). `serde_json` und `ryu` liefern beides nicht von selbst |
| Digests | `digestJson` (SHA-256 hex über kanonisches JSON) | Argument-, Kommando- und Bindungs-Hashes; Request-Ids im Journal |
| Generationen | `claims.ts` (`nonce.HMAC-SHA256(signingKey, canonicalJson({nonce, …rec}))`) | Gespeicherte Claims müssen nach dem Wechsel gültig bleiben; sonst verfallen alle laufenden Requests |
| Zahlen | `core.ts`: `FOREVER = Number.MAX_SAFE_INTEGER`, Zeiten in ms als JS-Zahl | Auf der Leitung und in der Datei sind alle Zahlen IEEE-754-Doubles. Ganzzahlen ≤ 2^53 als `i64`, Rest `f64`. `FOREVER` muss exakt zurückkommen; `until()` darf nicht überlaufen |
| JSON-Werte | `Json`/`Fields` in `core.ts` | Feldvergleich in Templates (`JSON.stringify`-Gleichheit, `service.ts`); Reihenfolge der Objektschlüssel bleibt beim Durchreichen erhalten (`serde_json` mit `preserve_order`) |
| Schlüssel | `auth.ts`, `grants.ts`, `enroll.ts` | Ed25519 als rohe 32 Byte; ECDSA P-256 als SPKI-DER mit DER-Signatur (Android-Keystore); Fingerprint = SHA-256 der Base64-dekodierten Bytes, 32 Hex-Zeichen |
| SQLite-Format | `store/sqlite.ts` | Tabellen `store_meta`, `documents`, `parts` (STRICT), Indizes `parts_order`, `parts_at`, `parts_grp`, `parts_open`; `value` ist JSON-Text; Dokumentversion 5; Formatnummer 2 in `store_meta`; WAL; Sperrdatei `<datei>.owner` |
| Fehler | `service.ts` (`fail("StaleEpoch", …)` usw.) | Fehlernamen und -felder sind Vertrag; `RemoteSpace` verzweigt darauf (Retry, `RequestExpired`) |
| Grenzen | `DEFAULT_LIMITS` in `core.ts` | Rahmengröße, Ergebnisbudget (`frameBytes - 64`), Quoten, `jsonBytes`-Zählung (UTF-8-Bytes des `JSON.stringify`) |

**Entscheidung R-D1:** Die Rust-Seite liest und schreibt **dieselbe SQLite-Datei**. Damit gibt es keine Migration,
und der Rückweg ist trivial. Die Alternative wäre ein eigenes Format mit Export/Import nach dem Muster von
`umstellung-ohne-pi-durable.md` §7. Sie wird nur gewählt, falls R2 zeigt, dass das Teilformat in Rust unvertretbar
teuer ist.

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

**Übertragung der TypeScript-Muster:**

- **Drafts mit Kopieren beim Schreiben** (`store/draft.ts`, Proxys):
  - In Rust werden das explizite Arbeitskopien je Commit: `im`-Strukturen oder `Arc` plus Klonen beim ersten
    Schreiben.
  - Tabellen-Teile bekommen ein Rückgängig-Protokoll, wie in U2 beschrieben.
  - Spätes Schreiben nach Commit-Ende („revoked draft“) wird durch Ownership unmöglich statt zur Laufzeit geprüft.
- **`AsyncLocalStorage`** (`context.ts`, `store/host.ts`) wird zu `tokio::task_local!` oder einem expliziten
  Kontext-Parameter. Explizit ist vorzuziehen, weil der Kern ohnehin `now` explizit nimmt.
- **Commit-Reihenfolge:**
  - Ein Commit-Task je Host serialisiert die Commits.
  - Ein eigener Schreib-Thread hält die SQLite-Verbindung (heute `sqlite-writer.ts` im Worker).
  - Bestätigt wird erst nach dem dauerhaften Schreiben.
  - Watches werden nach dem Veröffentlichen geweckt und fassen zusammen, was während ihres Listeners geschah
    (Vertrag in `store/host.ts`, Kopfkommentar).
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

- Eine gemeinsame Fixture in `test/support/` liefert je nach Umgebung zwei Varianten:
  - den In-Process-`SpaceService` mit Loopback-Transport,
  - oder eine Adresse eines gestarteten Rust-Servers.
- Tests, die in den Dienst hineingreifen (Uhr setzen, Store direkt lesen), brauchen dafür ein Test-RPC.
- Das Test-RPC ist nur mit `--test-hooks` aktiv und setzt die Uhr, öffnet und schließt neu und liest den
  Speicherauszug.
- Pro Suite wird in R3 vermerkt, ob sie mitläuft oder warum nicht.

**Gruppe C: Kern- und Store-Tests direkt auf TypeScript-Objekten.** Dazu gehören `test-core`, `test-claims`,
`test-stream`, `test-own-store` und `test-persistence`.

- Diese Tests werden nicht umgezogen.
- Ein **Differenz-Harness** zeichnet stattdessen Operationsfolgen samt Ergebnissen aus dem TS-Kern als JSONL auf.
- Der Rust-Kern spielt sie nach und vergleicht Ergebnis und Folgezustand kanonisch.
- `proptest` erzeugt zusätzlich zufällige Folgen, und beide Kerne laufen nebeneinander: Der TS-Kern hinter einem
  kleinen stdin/stdout-Treiber, der Rust-Kern nativ.

**Golden-Vektoren (R0):** kanonisches JSON, insbesondere Zahlen, Surrogatpaare und Schlüsselsortierung, dazu
Digests, Generationen, Signaturen beider Algorithmen und SQLite-Dateien. Die SQLite-Dateien stammen aus TS-Läufen;
die Rust-Seite muss sie öffnen und gleich beantworten.

**Kreuzbetrieb:** In jeder Phase schreibt TS eine Datei, Rust öffnet sie und arbeitet weiter, dann umgekehrt.
`test/support/persistent.ts` (Crash/Reopen) liefert die Vorlage.

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
   - gleicher Rechner, gleicher Commit, SQLite-Store;
   - feste, ungesättigte Rate (300/s), `server-probe --cmd` für TS und Rust direkt nacheinander;
   - die Grenze von 1024 Aufrufen/s je Peer ist Vertrag, Durchsatz darüber kein Maß;
   - spaces-mmo (`space-cost.ts`) ebenso: TS und Rust nebeneinander neu gemessen, nicht gegen diese Tabelle, weil sich
     das Spiel bis dahin weiterentwickelt (R-D8).

### R1: `phi-json` und `phi-core`

**Arbeit:**

- Kanonisches JSON und die Zahlenregeln.
- Der reine Kern mit Claims, Stream, Mailbox und RunGate.
- Keine I/O, keine Uhr: `now` ist ein Parameter wie in `core.ts`.

**Abnahme:**

- Alle Golden-Vektoren stimmen.
- Der Differenz-Harness spielt die aufgezeichneten Folgen fehlerfrei nach.
- `proptest` findet in 10⁶ Zufallsschritten keine Abweichung zum TS-Kern.

**Schnitt (2026-10-29):** R1 läuft über mehrere Sitzungen, in Scheiben. Jede Scheibe wird committet, wenn die
Vergleichstests gegen den TS-Treiber grün sind.

| Scheibe | Inhalt | Stand |
|---|---|---|
| 0 | `phi-json`; TS-Treiber `test/support/core-driver.ts`; Zustandsmodell `phi-core::state` mit Round-Trip-Prüfung | erledigt |
| 1 | Entries, Templates, Leases, `settle`, Ablauf, Stream-Einträge, Budgets (`charge`, `jsonBytes`-Summen); dazu `count`, `list`, `listPage`, `changes`, `stats`, `nextExpiry` ohne Txn | erledigt |
| 2 | Transaktionen: `createTxn`, `commitTxn`, `abortTxn`, Ablauf in `settle`, Txn-Leases, Schreiben, `announce`, Lesen und Nehmen unter einer Txn, Reservierungen | erledigt |
| 3 | Wartende, geparkte Operationen, Claims und Generationen | offen |
| 4 | Notify und Mailboxen | offen |
| 5 | Stream und Seiten unter Txns, Snapshots (`snapshot.ts`), Seiten-Token | offen |

**Bewusst zurückgestellt:** Restore, Wechsel der Autorität, Member-Admission, Löschung, Admin-Wartung, `purgeTasks`,
Abschlussprofile und RunGate. Der Standalone-Server braucht sie für R3 nicht. Ihre Felder führt `phi-core::state`
unverändert mit (`rest`). Ist eines davon in einem Dokument aktiv, verweigert der Rust-Kern Operationen, statt zu
raten.

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
  steht für den `proptest`-Lauf der Abnahme, bis der eingerichtet ist.
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

**Befund aus Scheibe 0:** `parkOperation` (`core.ts`, `touch(s, Date.now())`) und `ackMailbox` (`mailbox.ts`) lesen
die Uhr selbst, statt `now` zu übernehmen. Der Rust-Kern nimmt `now` als Parameter. Im TS-Kern sollten beide Stellen
`now` bekommen, damit Wiederholungen mit fester Uhr deterministisch sind.

### R2: `phi-store`

**Arbeit:**

- Host mit Commit-Vertrag (4.1/4.2 aus `umstellung-ohne-pi-durable.md`), Teile, `DISK_MAP`.
- SQLite-Ledger mit Schreib-Thread; Speicher-Modus `memory`.

**Abnahme:**

- Kreuzbetrieb mit TS-Dateien.
- Crash/Reopen-Fälle wie in `test/support/persistent.ts`, mit SIGKILL zwischen Persistieren und Bestätigen.
- Dieselben Zeilen in `documents`/`parts` nach gleichen Operationen, kanonisch verglichen.

### R3: `phi-service`, `phi-wire`, `phi-space-server`

**Arbeit:**

- Alle Methoden aus Abschnitt 2 und Pending/Poll.
- Quoten (`maxCallsPerWindow`, `maxPendingPerPrincipal`, `maxPendingPerPeer`), `wakeOnCommit` und
  `maxInflightPerConnection`.
- Identität über den `connection`-Rückruf: Unix-Socket fest, TCP hinter dem Gate.

**Abnahme:**

- Gruppen A und B laufen mit `PHI_SPACES_SERVER_CMD` gegen den Rust-Server.
- Die Beispiele sieve und cache laufen mit `--remote`.
- `npm --prefix spaces-mmo test` und `npm run test:codemode-chat` laufen, wenn deren `space-host` durch das
  Rust-Binary ersetzt ist: Startschalter `SPACES_MMO_SPACE_SERVER` bzw. `CODEMODE_SPACE_SERVER`.
- Die Perf-Messungen aus R0 sind wiederholt. Erwartet wird weniger CPU je Kommando; ist das nicht so, lohnt der Rest
  der Portierung nicht (Entscheidungspunkt R-D2).

### R4: Betrieb einer Anwendung auf Rust

**Arbeit:**

- Docker-Images von spaces-mmo und codemode-chat bekommen das Rust-Binary als Space-Rolle.
- Zuerst `docker:local:up` auf diesem Rechner.
- Danach, **nach Rückfrage**, der nano-Accounts-Space und die big-Weltregionen.
- Rückweg: TS-`space-host` auf derselben Datei starten.

**Abnahme:**

- Eine Woche Betrieb ohne Abweichung.
- Das Dashboard zeigt die Spaces über ihre Sockets unverändert an.

### R5: Host-Laufzeit und Sicherheit (`phi-host`)

**Arbeit:**

- Gate (NetBird-Peers und -Gruppen), Schlüssel-Challenge (Ed25519/P-256).
- Enrollment und Pairing, Grants und Rotation, Supervisor mit Kontroll-Space.
- TLS-Register (`tls-register.ts`) mit `rustls`.

**Abnahme:**

- `test-gate`, `test-auth`, `test-enroll`, `test-supervisor`, `test-grants` und `test-federation-runtime` laufen
  gegen den Rust-Host.
- Eine echte Handy-Kopplung über das Testbett (`docs/testumgebung-big.md`, `scenario sieve-mobile`), nach Rückfrage.

### R6: Föderation, Replikation, Recovery (zurückgestellt)

**Inhalt:**

- `router.ts`, `delegation.ts`, `federated-space.ts`, `membership.ts`.
- `entry-replication*.ts`, `primary-sync.ts`, `replica-control.ts`, Fencing (netcup, container).
- `recovery*.ts`, `restore.ts`, `boot.ts`.
- `run-controller.ts`, `workers.ts`, `space-lifecycle.ts`, `deployment.ts`, `alerts.ts`.

**Zurückgestellt, weil:**

- Replikation und Promotion sind laut `implementierungsstand.md` „begonnen, nicht abgenommen“. Einen nicht
  abgenommenen Entwurf zu portieren, verdoppelt nur die offene Arbeit.
- **Entscheidung R-D3:** erst abnehmen, dann portieren, oder in Rust neu entwerfen. Bis dahin läuft ein
  Föderations-Host weiter in TypeScript.
- Die Rust-Space-Server sind dann Member hinter dem TS-Root. Das geht, weil Member nur das Wire-Protokoll und die
  signierten Instruktionen sprechen.

### R7: Werkzeuge (optional)

- `dashboard.ts` und die TUI lesen nur. Sie können in TS bleiben, weil sie über Sockets lesen.
- Eine Portierung (`ratatui`) lohnt nur, wenn ein Rust-Binary ohne Node auf den Servern gewünscht ist.
- `scripts/bootstrap-spaces.ts` folgt `deployment.ts` in R6.

### R8: Server-Prozesse von spaces-mmo

Setzt R3 voraus und kann parallel zu R4–R7 laufen. Die Prozesse sind heute Clients des Spaces und tragen keinen
eigenen Zustand: Die Welt liegt im Welt-Space, die Konten liegen im Accounts-Space (`spaces-mmo/docs/architektur.md`).
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
  Bed, Building, Listing, Offer, Order usw.) und die Weltversion (heute 17). Sie sind die Schnittstelle zwischen den
  Prozessen und bleiben in einem gemischten Betrieb gleich.
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
| R8.1 | `phi-spaces-client` vollständig: `RemoteSpace`-Semantik (stabile Request-Ids, Retries, Notify/Wait/Events/ACK, Pending/Poll) und die Helfer aus `src/space-client.ts` (`parseTarget`, `connectSpace`, `readExisting`, `StillHeld`, `takeAll`, `awaitWork`, `keepAlive`) | Gruppe-A/B-Tests mit dem Rust-Client gegen TS- und Rust-Server |
| R8.2 | Crate `mmo-engine`: alle Kommandos und Ticks | Vergleichstest: dieselbe Intent-Folge mit fester Uhr und festem Startwert gegen zwei Speicher-Spaces, einmal TS-, einmal Rust-Engine; Entries und Nachrichten kanonisch gleich. Dazu die Engine-Tests (`engine`, `world`, `weltzeit`, `garden`, `build`, `economy`, `collision`, `translate`, `help`) als Vektoren |
| R8.3 | Binary `mmo-world` | `npm --prefix spaces-mmo test` mit `SPACES_MMO_WORLD_CMD`. Gemischter Betrieb: ein TS- und ein Rust-Worker an derselben Welt, `phase1`–`phase5` grün. `test:perf` (Schrittlatenz) und `live-load.ts` gegen die R0-Baseline |
| R8.4 | Binary `mmo-npc` | `economy`, `errands`, `phase2`, `phase5` mit `SPACES_MMO_NPC_CMD`; Rollen-Claims zwischen TS- und Rust-Prozess geteilt, keine Rolle doppelt |
| R8.5 | Binary `mmo-web`: HTTP, WebSocket-Gateway, Konten, Chat, Regionen, Einstellungen, statische Seite und Grafiken | alle Tests mit `SPACES_MMO_WEB_CMD`; Anmeldung mit Konten aus einem TS-Lauf; `walk-play` und `regions-live`; einmal von Hand im Browser auf `docker:local:up` |
| R8.6 | Docker: `spaces-mmo/docker/` baut die Rust-Binaries (musl) ins Image; der Model-Prozess bleibt ein Node-Container | `docker:local:up` ganz in Rust bis auf model; danach nano und big **nur nach Rückfrage**. Rückweg: die TS-Prozesse auf denselben Spaces starten |

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

**Empfehlung:** a) bis R4 abgenommen ist, dann b). Die Keystore-Signaturen bleiben auf der Java/Android-Seite; der
Server prüft sie nur.

## 8. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Abweichung im kanonischen JSON (Zahlen, UTF-16-Sortierung) macht Claims ungültig | Golden-Vektoren aus R0 und Kreuzbetrieb; Generationen aus TS-Dateien in Rust prüfen |
| Feine Semantik im Kern (Waiter-Wettlauf, Lease-Grenzen bei `FOREVER`, Txn-Abbruch) | Differenz-Harness und `proptest` statt Lesen und Nachbauen |
| Zwei Implementierungen laufen auseinander, solange beide leben | Änderungen am Wire-Protokoll und am Kern nur mit Vektor-Update; beide Server in CI (`npm test` mit und ohne `PHI_SPACES_SERVER_CMD`) |
| Der Gewinn ist klein: Node mit SQLite ist schon schnell, die Latenz liegt eher im Netz | Messpunkt R-D2 nach R3, bevor R4–R6 beginnen |
| Aufwand | R0–R3 umfassen etwa 6.000 Zeilen TS, nämlich Kern, Store, Dienst und Socket. R5 fügt etwa 1.500 hinzu, R6 den Rest (etwa 9.000) |
| Spielregeln in zwei Sprachen laufen auseinander, solange TS- und Rust-Worker gemischt laufen | gemischter Betrieb nur für die Abnahme von R8.3; danach wird die Engine nur noch in Rust geändert, der TS-Worker friert ein |
| Neue Spielfunktionen (siehe `spaces-mmo/docs/phasen.md`) während R8.2 | R8.2 vom aktuellen Stand abzweigen; jede Änderung am TS-Engine-Code bekommt einen Vergleichsfall und wird in Rust nachgezogen, bevor R8.3 abgenommen wird (R-D8) |
| Neue Toolchain auf big/nano | Statisch gelinktes Binary (musl) in die bestehenden Docker-Images; auf den Servern wird nichts installiert |

## 9. Entscheidungen

| Nr. | Frage | Entscheidung |
|---|---|---|
| R-D0 | Freigabe der Crates aus Abschnitt 4 | **entschieden 2026-10-29:** freigegeben |
| R-D1 | Gleiche SQLite-Datei oder eigenes Format | **entschieden 2026-10-29:** gleiche Datei |
| R-D2 | Weiter nach R3? | **entschieden 2026-10-29:** nur, wenn die CPU je Kommando im Space-Prozess deutlich sinkt (Ziel: mindestens Faktor 2) oder der Speicherbedarf sinkt; gemessen nach dem Verfahren aus „Stand R0“, Befund 3 |
| R-D3 | Föderation portieren, neu entwerfen oder in TS lassen | **entschieden 2026-10-29:** erst nach deren Abnahme entscheiden |
| R-D4 | Space auf dem Handy | **entschieden 2026-10-29:** a), später b) |
| R-D5 | Bleibt der TS-Server dauerhaft? | **entschieden 2026-10-29:** ja, als Referenz und für In-Process-Nutzung (`PhiSpaces`), bis R-D4 b) umgesetzt ist |
| R-D6 | Weltdefinition als JSON statt TS | **entschieden 2026-10-29:** JSON (R8.0) |
| R-D7 | Modellaufrufe von spaces-mmo | **entschieden 2026-10-29:** im TS-Model-Prozess lassen (pi-ai: Modellliste, Umgebungsschlüssel und `~/.pi/agent/auth.json` mit OAuth), NPC-Rollen über Entries anbinden. Verworfen: direkte HTTP-Aufrufe aus Rust, weil die Zugangsdaten dann an zwei Stellen verwaltet würden |
| R-D8 | Spielentwicklung während R8.2 | **entschieden 2026-10-29:** in TS weiterentwickeln, Rust zieht nach |
| R-D9 | Zusätzliche Crates für R8: `axum` oder `hyper` (HTTP), `tokio-tungstenite` (WebSocket), `scrypt`, `ts-rs` (TS-Typen aus Rust), `tower-http` (statische Dateien) | **entschieden 2026-10-29:** freigegeben |
