# Testumgebung auf dem Server `big`

Stand: 2026-10-08. Beschreibt `test/testbed/` und das Vorgehen. Die Umgebung prüft das **gebaute Produktionsartefakt**
unter produktionsnahen Bedingungen und stellt die Hosts bereit, die die Stufen 1b–3 des
[Implementierungsplans](../_attic/implementierungsplan-v3.en.md) brauchen. Sie ersetzt weder NetBird noch einen echten Fencing-Adapter
(Abschnitt 8). **Auf dem Server liegt kein Quellcode.**

**Erster Prüfstand (2026-10-08, auf dem Server ausgeführt, produktionsnahe Fassung):** `purge-sources`, `destroy`, `init --force`,
`test all` (Smoke, fünf Beispiele, Szenario Primzahlsieb), das Szenario in drei Phasen mit `kill runner` dazwischen und `down`;
die Härtung des Containers wurde im laufenden Container geprüft. **In diesem ersten Prüflauf nicht ausgeführt:** `up federation`, `stop`,
`partition`/`heal`. Der erste Build deckte ein veraltetes `package-lock.json` auf (Abschnitt 9). Die Quelltests (Typecheck,
`npm test`, `npm run test:examples`) laufen bewusst nur lokal (Abschnitt 1).

## 1. Zweck und Überblick

Tests und später die Federation-Hosts laufen in Docker-Containern auf einem Server, nicht auf dem eigenen Rechner.
Ein Skript erledigt Einrichtung und Betrieb:

```
lokaler Rechner                              Server big (ssh), Verzeichnis /media/docker/phi-spaces
src/, examples/, scenarios/ (TypeScript)
   │  esbuild (build-artifacts.mjs)
   ▼
dist/testbed-artifacts/                      docker-compose.yml  Dockerfile  .dockerignore  .env   (nur angelegt, wenn fehlend)
  phi-spaces.mjs  examples/*.mjs  ── rsync ─► build/   (nur Artefakte + package.json/-lock.json + MANIFEST.json)
  scenarios/*.mjs  MANIFEST.json                │  docker build auf dem Server
                                                ▼
                                          Image: Node + `npm ci --omit=dev` + Artefakte unter /opt/app
                                          Container (rootless Docker, Benutzer node, NODE_ENV=production,
                                          read-only Dateisystem, keine Capabilities, nur /data beschreibbar):
                                            runner      Smoke, Beispiele, Szenarien
                                            host-a      Koordinator   ┐
                                            host-b      Standby       ├ Profil "federation", Volume /data je Host
                                            member-1/2  Data Members  ┘
```

**Produktionsnähe statt Quellkopie.** Lokal werden dieselben Artefakte gebaut, die auch das mobile Projekt bekommt
(`scripts/bundle-mobile.mjs`): das Bündel `phi-spaces.mjs` (**byte-identisch** zu dem in `pi-termux-mobile/runtime`), die
kompilierten Beispiele und die kompilierten Szenarien (sie importieren das ausgelieferte Bündel, keine zweite Kopie). Nur diese
Dateien, die Abhängigkeitsmanifeste und ein `MANIFEST.json` (Commit, Zeitpunkt, Hashes) gehen auf den Server; `ship` bricht ab,
wenn eine TypeScript-Datei darunter wäre. Das Image enthält Node, die Produktionsabhängigkeiten laut Lock (`npm ci --omit=dev`)
und diese Artefakte. Es gibt keinen eingebundenen Checkout, keinen `ts`-Interpreter-Modus und keine Dev-Abhängigkeiten.

**Was damit geprüft wird und was nicht.** Der Server prüft das Artefakt in einer Produktionsumgebung (echtes Node-Image, reales
Dateisystem, unprivilegierter Benutzer, gehärteter Container, persistente Volumes, Absturz und Neustart). Die Quelltests
(`npm run typecheck`, `npm test`, `npm run test:examples`) greifen auf TypeScript-Quellen zu und laufen deshalb weiter nur lokal.
Sie auf dem Server auszuführen hieße, Quellen dorthin zu kopieren.

## 2. Befund zum Server (geprüft am 2026-10-08, nur lesend)

| Punkt | Befund | Folge |
|---|---|---|
| Zugang | `ssh big` meldet sich als normaler Benutzer an, nicht als `root`. | SSH-Alias `big` verwenden |
| Docker | **rootless**, ein Daemon je Benutzer (Socket unter `/run/user/<uid>/`). Der System-Daemon ist maskiert; **`root` erreicht keinen Daemon.** | Skript läuft als der Daemon-Benutzer, nicht als `root` |
| Verzeichnis | `/media/docker/phi-spaces` existierte, gehörte dem Daemon-Benutzer und war leer. | passt zum Benutzer |
| sudo | `sudo -n` verlangt für diesen Benutzer ein Passwort | kein sudo, `TESTBED_SUDO=no` |
| Ressourcen | geteilter Server mit mehreren laufenden Containern anderer Projekte; die Platte war zu über 90 % belegt | knappe Limits je Container, keine veröffentlichten Ports; `check` zeigt den freien Platz |
| cgroup | v2, systemd-Treiber; Docker meldet `cpuset` und `io.weight` als nicht unterstützt | Speicher-, CPU- und PID-Limits werden gesetzt; ob die CPU-Quota greift, zeigt der erste Lauf |
| Werkzeuge | docker 29.8.2, compose 5.6.0, rsync vorhanden | nichts zu installieren |

„Als root“ aus der Aufgabenstellung wurde deshalb als **Projektwurzel** `/media/docker/phi-spaces` unter dem Benutzer
des Docker-Daemons umgesetzt.

## 3. Voraussetzungen

Lokal: `ssh`, `rsync`, `bash`, `node` und die installierten Entwicklungsabhängigkeiten (`esbuild` baut die Artefakte; für ein
Passwort statt Schlüssel zusätzlich `sshpass`). Auf dem Server: Docker mit
Compose-Plugin und `rsync`. Der Server braucht Zugriff auf Docker Hub und die npm-Registry
(Image `node:22-bookworm-slim`, `npm ci` im Build).

## 4. Konfiguration

Alle Einstellungen kommen aus Umgebungsvariablen oder der Datei `test/testbed/testbed.env` (git-ignoriert, Vorlage
`testbed.env.example`). Umgebungsvariablen haben Vorrang. Die Datei wird nur gelesen und nie ausgeführt.

| Variable | Standard | Bedeutung |
|---|---|---|
| `TESTBED_SSH_TARGET` | `big` | ssh-Alias oder `user@host` |
| `TESTBED_SSH_USER`, `_PORT`, `_KEY`, `_OPTS` | – | überschreiben die ssh-Konfiguration |
| `TESTBED_SSH_PASSWORD` | – | Passwort über `sshpass`; ein Schlüssel ist vorzuziehen |
| `TESTBED_SSH_BATCH` | `1` | `0` erlaubt Passphrase-/Passwortabfragen im Terminal |
| `TESTBED_REMOTE_DIR` | `/media/docker/phi-spaces` | Projektverzeichnis auf dem Server (absolut, mindestens zwei Ebenen) |
| `TESTBED_SUDO` | `no` | `yes`: Befehle über `sudo -n` |
| `TESTBED_DOCKER_HOST` | automatisch | Docker-Socket, z.B. `unix:///run/user/<uid>/docker.sock`; erkannt, wenn kein System-Socket existiert |
| `TESTBED_PROJECT` | `phi-spaces-test` | Compose-Projektname; Präfix für Container, Netz, Volumes, Image |
| `TESTBED_NODE_IMAGE` | `node:22-bookworm-slim` | Basisimage |
| `TESTBED_RUNNER_MEM` / `_CPUS` | `2g` / `2.0` | Limits des Runners |
| `TESTBED_MEM_LIMIT` / `_CPUS` / `_PIDS_LIMIT` | `512m` / `0.5` / `1024` | Limits je Host-Container; `0` schaltet ein Limit ab |

Die Limits werden beim ersten `init` in die `.env` auf dem Server geschrieben. Spätere Änderungen dort bearbeiten
(oder die `.env` löschen und `init` erneut ausführen). Zugangsdaten gelangen nie auf den Server.
Gelesen werden nur `TESTBED_*`-Schlüssel; nicht erkannte Zeilen werden gemeldet und ignoriert.

## 5. Vorgehen

Alle Befehle: `npm run testbed -- <befehl>` oder `bash test/testbed/testbed.sh <befehl>`.

1. **Einmalig:** `cp test/testbed/testbed.env.example test/testbed/testbed.env` und anpassen (auf dem Standardserver genügt der Standard).
2. **Prüfen:** `check`. Nur lesend: Werkzeuge, ssh, Benutzer, Docker (rootless?), Compose, rsync, Verzeichnis, freier Platz,
   vorhandene Container des Projekts. Mit `--dry-run` zeigt jeder Befehl, was er auf dem Server tun würde.
3. **Starten:** `up` (oder `up federation`). Das Skript
   - legt `/media/docker/phi-spaces` und `build/` an, falls sie fehlen;
   - schreibt `docker-compose.yml`, `Dockerfile`, `.dockerignore` und `.env`, **nur wenn sie fehlen**;
     weicht eine vorhandene Datei von der Vorlage ab, wird gewarnt und nichts überschrieben (`init --force` überschreibt);
   - baut die Artefakte lokal (`build`) und überträgt nur diese nach `build/` (`ship`);
   - baut das Image auf dem Server (die Schicht mit den Produktionsabhängigkeiten bleibt im Cache, solange sich die
     Manifeste nicht ändern);
   - gleicht Container mit Image und Konfiguration ab (`docker compose up -d`); bei Änderungen können auch laufende Container neu erstellt und ihre Prozesse unterbrochen werden; persistente Volumes bleiben erhalten;
   - zeigt den Status.
4. **Testen:** `test` (Standard `all`) führt vorher `up core` aus, liefert also den aktuellen Stand aus, und prüft im Runner:
   `smoke` (das Bündel lädt und exportiert, was die Laufzeit braucht; Node-Version, `NODE_ENV`, Benutzer und Artefakt-Commit
   werden ausgegeben; **keine TypeScript-Datei** im Image und unter `/media/docker/phi-spaces`), `examples` (die kompilierten
   Beispiele `sensor-pipeline`, `cache`, `sieve 1001 2` mit „168 primes“ und `golomb 5`) und `scenario` (Primzahlsieb mit
   simuliertem Handy `sieve-mobile`, Abschnitt 10, danach `sieve-remote`). Einzeln: `test smoke|examples|scenario`. Alle Schritte laufen auch bei einem Fehlschlag
   durch; der Exit-Code ist dann 1.
5. **Beobachten:** `status`, `logs <dienst> [zeilen]`, `exec <dienst> <befehl…>` (mit Terminal, wenn vorhanden).
6. **Beenden:** `down` entfernt Container und Netz, behält Volumes und die ausgelieferten Artefakte. `destroy --yes` entfernt
   zusätzlich Volumes und Image. Das Verzeichnis und `build/` löscht das Skript nie. Eine Quellkopie aus früheren Versionen
   des Skripts (`repo/`) entfernt `purge-sources`.

## 6. Container und ihre Verwendung

Alle Container laufen im Leerlauf (`sleep infinity`, `init: true`, `restart: unless-stopped`) und sind gehärtet:
Benutzer `node` (nicht root), `NODE_ENV=production`, schreibgeschütztes Wurzeldateisystem mit `tmpfs` auf `/tmp`, alle
Capabilities entfernt, `no-new-privileges`, keine Ports. Beschreibbar ist nur `/data`. Prozesse starten Szenarien und
später die Dienste mit `exec`. Jeder Host hat ein eigenes Volume `/data`, so dass kein Storage zwischen Hosts geteilt wird
(ein Datenbankverzeichnis wird nie von mehreren Prozessen geöffnet) und ein Absturz die Daten erhält.

| Dienst | Profil | Rolle (v3) | Verwendung |
|---|---|---|---|
| `runner` | immer | Läufer für Artefakte | Smoke, kompilierte Beispiele, Szenarien; Crash-/Reopen-Fälle auf echtem Dateisystem (SQLite) |
| `host-a` | `federation` | Koordinator | ab Stufe 1b: Gate, Supervisor, Recovery Space, Control Space, Router |
| `host-b` | `federation` | fester Standby | ab Stufe 3: synchroner Standby, Promotion |
| `member-1`, `member-2` | `federation` | Data Members | ab Stufe 2: expand/HRW mit mehreren Members, Worker |

**Heute ist nichts davon implementiert:** Die vier Federation-Container sind leer und dienen dazu, die Topologie bereitzuhalten.
Für weitere Members die Datei `docker-compose.yml` auf dem Server erweitern (und die Vorlage in `test/testbed/docker/compose.yml`
angleichen, sonst warnt `init`). Umgebungsvariablen je Container: `TESTBED_ROLE`, `TESTBED_HOST_ID`.

## 7. Fehlerinjektion

| Befehl | Wirkung | Prüft z.B. |
|---|---|---|
| `kill <dienst>` | SIGKILL, danach sofort `start` (Absturz plus Neustart); das Volume bleibt | Absturz und Wiederöffnen (Stufe 1, 3) |
| `stop <dienst>` | sauberer Stopp; bleibt aus bis `up` | Ausfall eines Hosts, Standby-Ausfall |
| `partition <dienst>` | trennt vom Testnetz, der Container läuft weiter | Partition, Split-Brain-Fälle, Grant-/Lease-Ablauf |
| `heal <dienst>` | verbindet wieder (mit Dienstnamen als Alias) | Rejoin |

Die Uhrversatz-Fälle (F6) sind damit nicht abgedeckt. Ein Datenträger-Verlust (Restore) eines einzelnen Hosts geht nur von
Hand: Container stoppen und sein Volume mit `docker volume rm` entfernen.

## 8. Grenzen

- Kein NetBird: Overlay-Identität, Testmatrix 4.6 und Management-Ausfälle (Gate 5) brauchen eine echte NetBird-Umgebung.
  Stufe 1b kann hier zunächst mit dem Test-Identitätsadapter geprüft werden.
- Kein echter Fencing-Adapter (Gate 2): Der Container-Runtime-Adapter aus v3 5.5 verlangt einen *anderen* Host. `kill`/`stop`
  zeigen das Verhalten, ersetzen aber nicht den Nachweis „gestoppt und gegen Neustart gesperrt“ beim Anbieter.
- Alle Container teilen sich Kernel, Uhr und Platte von `big`. Latenz-, Uhr- und IOPS-Aussagen (Gate 3, 4) sind auf dem
  geteilten Server nur Richtwerte, und die Container anderer Projekte beeinflussen die Messung.
- Rootless Docker mit `slirp4netns`: Netzwerkdurchsatz ist nicht repräsentativ.
- Zwei gleichzeitige Läufe (zwei Entwickler) auf demselben Verzeichnis sind nicht abgesichert; es gibt keine Sperre.
- Der Server hat wenig freien Platz (`check` zeigt ihn). Image und Volumes sind klein (der Spike mit 10 000 Entries
  belegt 4 MB, das Image einige hundert MB), `destroy --yes` räumt bei Bedarf auf.

## 9. Fehlersuche

| Meldung / Symptom | Ursache und Abhilfe |
|---|---|
| `cannot run commands on big (ssh/sudo)` | `check` ausführen. Schlüssel/Agent prüfen; bei Passphrase `TESTBED_SSH_BATCH=0` |
| `sudo: interactive authentication is required` | `TESTBED_SUDO=yes` ist gesetzt, aber `sudo` verlangt ein Passwort. Auf `big` wird kein sudo gebraucht |
| `docker: NOT REACHABLE` | Daemon des Benutzers läuft nicht (`systemctl --user status docker` auf dem Server) oder anderer Socket: `TESTBED_DOCKER_HOST` |
| `docker.sock: no such file` als `root` | Der Daemon gehört einem anderen Benutzer; als dieser arbeiten (der normale ssh-Alias) |
| `image build failed` | Auf dem Server `cd /media/docker/phi-spaces && docker compose build runner` für die volle Ausgabe; meist Netzzugang oder Plattenplatz |
| `TypeScript source found in … refusing to ship` | Ein Build hätte Quellcode in die Artefakte gelegt; `build-artifacts.mjs` prüfen |
| `smoke` meldet TypeScript-Dateien auf dem Server | Rest einer früheren Version: `purge-sources`; sonst nachsehen, was unter `/media/docker/phi-spaces` liegt |
| `npm ci` meldet `lock file ... does not satisfy` | `package-lock.json` passt nicht zu `package.json`. Das war hier der Fall (esbuild fehlte im Lock). Lokal `npm install --package-lock-only` und die Änderung prüfen |
| `Permission denied (publickey)` mit einem fremden Benutzernamen | `test/testbed/testbed.env` enthält einen aktiven Platzhalter (`TESTBED_SSH_USER=deploy`). Zeile entfernen oder einkommentiert lassen; Umgebungsvariablen haben Vorrang, `TESTBED_SSH_USER=` (leer) nimmt den Benutzer aus `~/.ssh/config` |
| `… on the server differs from the template` | Server-Datei wurde geändert oder die Vorlage wurde aktualisiert: Unterschied prüfen, dann `init --force` |
| `Cannot find package` im Container | Ein neuer Import ist nicht in `package.json`/`package-lock.json` (Produktionsabhängigkeit): ergänzen, dann `up` |
| Das Szenario startet das Sieb-Beispiel (CLI-Ausgabe, Fehler „Sieve needs a runId“) | Ein eingebettetes Beispiel führt seinen Direktstart-Block aus; `build-artifacts.mjs` neutralisiert `import.meta.url` in Beispielen für Szenarien |
| Container startet immer wieder neu | `logs <dienst>`; `stop` hält ihn an, `down` entfernt ihn |

## 10. Szenario: Primzahlsieb mit simuliertem Handy

`test/testbed/scenarios/sieve-mobile.ts` spielt den Bedienablauf aus [betrieb-und-mobile-steuerung.md](../betrieb-und-mobile-steuerung.en.md)
Abschnitt 6 mit einem simulierten mobilen Gerät nach. Es nutzt den benannten Space `sieve-a` (Doc-Version 5), dauerhafte
Request-Claims (Stufe 1) und den phi-spaces-Store (SQLite) auf dem Volume `/data`. Drei getrennte Aufrufe, wie bei einem Handy, das einen Lauf
startet, später zurückkehrt und das Ergebnis ansieht:

| Phase | Befehl | Was geschieht | Was dabei gestört wird |
|---|---|---|---|
| **Erstellen** | `scenario sieve-mobile create --fresh` | Das Handy legt Generation und Lauf-ID ab (bevor es etwas sendet), der Host bereitet 8 Blöcke vor; ein zweiter „Doppeltipp“ folgt | Anfragen und Antworten gehen verloren; der Host bricht nach 3 Blöcken ab; das Handy wiederholt mit derselben Request-ID |
| **Aufruf** | `scenario sieve-mobile run [--host-restart]` | Host-Worker sieben die Blöcke, das Handy fragt den Fortschritt ab, geht ins Hintergrund, kommt zurück und holt das Ergebnis | Worker sterben mit einer reservierten Aufgabe (sie kommt nach Lease-Ablauf zurück); optional Neustart des Hosts bei halbem Fortschritt; verlorene Aufrufe |
| **Auswertung** | `scenario sieve-mobile evaluate` | prüft den gespeicherten Zustand gegen eine unabhängige Referenz, schreibt `report.json`, Exit-Code 0 oder 1 | – |
| alles | `scenario sieve-mobile all` | create, run, evaluate nacheinander | wie oben |

Geprüft werden: genau ein Lauf-Eintrag (Doppeltipp und Wiederholungen erzeugen keinen zweiten), keine Aufgabe übrig, keine
offene Transaktion, genau ein Ergebnis je Block, jeder Block gleich dem Probedivisionsergebnis, Gesamtergebnis gleich der
Referenz (168 Primzahlen unter 1001), und je gesendeter Anfrage genau ein entschiedener Claim (Lauf plus ein Claim je Block).
Eine Probe mit absichtlich verfälschtem Zustand (doppeltes, falsches Ergebnis) lässt die Auswertung fehlschlagen.

Optionen (Auszug): `--end`, `--block`, `--workers`, `--work-ms` (simulierte Rechenzeit je Block), `--drop` (Anteil gestörter
Aufrufe, Standard 0,3), `--offline-ms`, `--crash-workers`, `--lease-ms`, `--crash-create`, `--host-restart`, `--seed`. Alle
Optionen: `scenario sieve-mobile help`. Der Zustand liegt in `/data/sieve-mobile` und übersteht `kill` und `down`; `--fresh`
verwirft ihn.

Auf dem Server läuft jeweils die kompilierte Fassung gegen das ausgelieferte Bündel. Beispiel mit Absturz des Containers
zwischen den Phasen:

```sh
npm run testbed -- scenario sieve-mobile create --fresh
npm run testbed -- kill runner                      # Container stirbt, das Volume bleibt
npm run testbed -- scenario sieve-mobile run --host-restart --drop 0.4 --workers 3
npm run testbed -- scenario sieve-mobile evaluate   # Exit-Code 0 = bestanden
```

**Was das Szenario nicht abbildet:** ein echtes Handy, Funknetz oder NetBird (die Verbindung ist ein Zufallsmodell auf Aufrufebene),
mehrere Hosts (alles läuft in einem Container und einem Prozess; ein Host-„Neustart“ beendet die Worker und öffnet den
Storage neu, ist aber kein Absturz mitten im Commit) und das Pausieren über ein RunGate (das Szenario nutzt es nicht; der RunGate ist implementiert, siehe Betrieb Abschnitt 6). Das
Vorbereiten der Aufgaben ist nicht gegen vorzeitige Bearbeitung abgesichert (Betrieb Abschnitt 6, `preparing`). Als
Regressionstest läuft eine kleine Fassung der TypeScript-Quelle lokal in `npm test` (`test/test-scenario.test.ts`); auf dem Server
läuft die kompilierte Fassung (`scenarios/sieve-mobile.mjs`).

## 11. TUI und lesende Space-Inspektion

`npm run tui` bietet Space-/Objektansicht, Containeraktionen, Teststart und Auswertungen.
`npm run testbed -- inspect runner` liest bestätigte Daten der phi-spaces-Stores (SQLite) und Szenarioberichte im laufenden Container;
`start <dienst>` startet einen vorhandenen gestoppten Container ohne Build oder Auslieferung.
Der Inspector wird als `tools/inspect.mjs` mitgeliefert. Bei vorhandener alter Dockerfile zuerst `init --force`,
dann `up core` ausführen. Bedienung, Freigaben, Snapshot-Grenzen und gesperrte geplante Funktionen: [tui.md](../tui.en.md).

## 12. NetBird (Gate 5, Arbeitspaket 1b.1)

Der NetBird-Management-Server läuft auf `big` als eigenes Compose-Projekt (`spacebird`) im Verzeichnis `<dir>/netbird`, getrennt vom
Spaces-Testbed: `down` und `destroy` des Testbeds berühren ihn nicht. Aufbau nach NetBirds eigenem `getting-started.sh`
(v0.80) für einen externen Reverse Proxy: ein kombinierter Server-Container (Management, Signal, Relay, STUN) und das
Dashboard, beide nur auf `127.0.0.1` veröffentlicht (Standard 18081 und 18080). Als Identity Provider dient der eingebaute Dex.
Host: `spacebird.eibrain.org` (zeigt auf big, `TESTBED_NETBIRD_DOMAIN`).

**Befund (2026-10-08, nur lesend):** `/dev/net/tun` ist für alle les- und schreibbar; Ports ab 1024 sind frei bindbar
(`ip_unprivileged_port_start = 1024`); nginx belegt 80/443; `mux` hat kein sudo, nginx und Zertifikat muss die Serveradministration
einrichten.

```sh
npm run testbed -- --dry-run netbird up      # zeigt, was geschehen würde
npm run testbed -- netbird up                # schreibt Compose/Konfiguration (Schlüssel neu, Modus 600), zieht Images, startet
npm run testbed -- netbird nginx bootstrap   # nur Port 80, damit certbot das Zertifikat holen kann
npm run testbed -- netbird nginx             # die vollständige Site
npm run testbed -- netbird status            # Container, Image-Stand, Erreichbarkeit über https
```

nginx und Zertifikat (als root auf big; das Skript tut das nie selbst):

1. Ausgabe von `netbird nginx bootstrap` nach `/etc/nginx/sites-available/spacebird.eibrain.org`, nach `sites-enabled` verlinken,
   `nginx -t && systemctl reload nginx`.
2. `certbot certonly --webroot -w /var/www/html -d spacebird.eibrain.org`.
3. Dieselbe Datei durch die Ausgabe von `netbird nginx` ersetzen, `nginx -t && systemctl reload nginx`.

**STUN (UDP 3478)** ist standardmäßig nur auf Loopback veröffentlicht: Peers auf demselben Host brauchen ihn nicht. Für Peers außerhalb
(z. B. ein echtes Handy) `TESTBED_NETBIRD_STUN_BIND=0.0.0.0` setzen und UDP 3478 in der Firewall öffnen; nginx kann UDP nicht
weiterleiten.

**Version festhalten:** `TESTBED_NETBIRD_VERSION` (Server) steht auf 0.80.0; das Dashboard hat eine eigene Versionierung (`TESTBED_NETBIRD_DASHBOARD_VERSION`, Standard `latest`, der Digest steht in `netbird status`). Für den Nachweis zu Gate 5
`netbird status` (Image-Digest) in Abschnitt 4.6 des Föderationsplans eintragen. Die Linux-Agenten (Sidecar mit `NET_ADMIN` und `/dev/net/tun`,
gemeinsamer Netzwerk-Namespace) und die Testmatrix 4.6 folgen, sobald der Server erreichbar ist; der Userspace-WireGuard-Modus war unter
rootless Docker nicht nötig (Kernel-WireGuard, siehe Ergebnis unten).

### Gruppen, Setup-Keys und Policies einrichten

Voraussetzung: ein Service-User (Rolle Network Admin) im Dashboard und dessen Token in `<dir>/netbird/secrets.env` auf dem Server
(`NB_PAT=<token>`, Modus 600). Das Token verlässt den Server nie und wird nicht ausgegeben.

```sh
npm run testbed -- --dry-run netbird setup
npm run testbed -- netbird setup                 # idempotent; --rotate-keys erzeugt neue Setup-Keys
```

Das Skript (`test/testbed/netbird/setup.sh`, läuft auf dem Server) legt die Gruppen aus dem Föderationsplan 4.1 an (`space-hosts`,
`space-admin`, `space-observer`), zwei wiederverwendbare Setup-Keys (`testbed-hosts` tritt `space-hosts` bei, `testbed-admin` tritt
`space-admin` bei; 30 Tage; der Wert wird nur bei der Erzeugung angezeigt und steht danach als `NB_KEY_HOSTS` / `NB_KEY_ADMIN` in
`secrets.env`) und zwei Policies: `space-port` (Hosts, Admins und Observer → Hosts, nur TCP auf `TESTBED_NETBIRD_SPACE_PORT`, ein
Platzhalter 7421, bis es das space-gate gibt) und `space-admin-ssh` (Admins → Hosts, TCP 22). Zum Schluss listet es alle Policies und
die Peers mit ID, Overlay-Adresse und Gruppen (Nachweis für Gate 5).

**Die Standard-Policy „Default“ erlaubt jedem Peer alles.** Solange sie aktiv ist, wirken die Gruppenregeln nicht. Das Skript schaltet
sie nicht von selbst ab (sonst könnte ein Fehler dich aussperren); nach dem ersten Lauf und dem Beitritt der Test-Peers im Dashboard
unter Access Control → Policies abschalten und die Testmatrix 4.6 darauf laufen lassen. Die Logik des Skripts ist gegen eine Mock-API
geprüft, nicht gegen den echten Server: Felder der NetBird-API können abweichen.

### Agent-Peers (Profil `overlay`)

Vier Agent-Container (`nb-host-a`, `nb-host-b`, `nb-member-1`, `nb-member-2`, Image `netbirdio/netbird:0.80.0`) treten dem Overlay mit dem
Setup-Key `testbed-hosts` bei und erscheinen im Dashboard als `host-a`, `host-b`, `member-1`, `member-2` in der Gruppe `space-hosts`.
Der Key steht in `<dir>/netbird/peer-hosts.env` (Modus 600; nur `NB_SETUP_KEY` und `NB_MANAGEMENT_URL`, nie das API-Token); `netbird setup`
schreibt die Datei. Die Agenten brauchen `/dev/net/tun` und `NET_ADMIN` und laufen deshalb nicht im gehärteten Profil der Node-Container.
Die Host-Container des Profils `federation` laufen im Netzwerk-Namespace ihres Agenten (`network_mode: service:nb-<host>`);
`wt0` ist ihr einziger Weg zu den anderen.

```sh
npm run testbed -- init --force          # neue Compose-Vorlage auf den Server (ändert nichts an laufenden Containern)
npm run testbed -- netbird setup         # schreibt peer-hosts.env (idempotent)
npm run testbed -- --dry-run up overlay
npm run testbed -- up overlay            # startet nur die vier Agenten
npm run testbed -- logs nb-host-a        # Verbindungsaufbau, WireGuard-Modus
```

## Nachweis: TUI auf big (2026-10-08)

Die neue Inspector-Dockerfile ist ausgeliefert. `npm run tui -- --action test-all --allow-remote`
bestand Smoke, fünf Beispiele und das Sieb-Szenario. Die interaktive TUI liest Spaces/Objekte und
Berichte vom Runner. Stopp/Start ist nun ebenfalls geprüft; Space-Objekte und Bericht blieben erhalten.
Der gehärtete Runner läuft weiter. Vollständiger Umfang und Protokollorte: [tui.md](../tui.en.md#server-evidence-of-2026-10-08).

**Ergebnis des ersten Laufs (2026-10-08):** Alle vier Agenten verbinden sich mit dem Management, Signal und Relay von `spacebird.eibrain.org`
und erhalten Overlay-Adressen aus 100.89.0.0/16. Der Agent läuft auch unter rootless Docker mit **Kernel-WireGuard** (`Interface type:
Kernel`, Gerät `wt0`); der befürchtete Userspace-Modus war nicht nötig. Verbindungen entstehen verzögert (lazy): `Peers count 0/4`, bis
Verkehr fließt; danach P2P über die Docker-Bridge (Ping `nb-host-a` → `nb-host-b`, 0 % Verlust, 2–22 ms). Offene Warnung im Log:
`src_valid_mark` lässt sich im Container nicht setzen (`/proc/sys` schreibgeschützt); das betrifft nur Routing über fremde Netze, nicht
das Overlay. Noch nicht geprüft: die Wirkung der Policies, solange die Policy „Default“ aktiv ist, die Gruppenzuweisung des Handys und das
Verhalten bei Entfernen eines Peers aus der Gruppe (Testmatrix 4.6).

**Wirkung der Policies (2026-10-08, „Default“ abgeschaltet):** Von `host-a` zu `host-b`, beide in `space-hosts`: TCP 7421 offen; TCP 8080 und
TCP 22 sowie ICMP blockiert. Das entspricht den Policies `space-port` (nur 7421) und `space-admin-ssh` (nur Admin-Geräte; Hosts untereinander
dürfen kein SSH). Gemessen mit `nc -w 4` gegen Test-Listener in `nb-host-b`. Offen aus Testmatrix 4.6: Gruppenwechsel und Entfernen eines Peers
im laufenden Betrieb, Verhalten des Handys (`space-admin`) und die Peer-ID-Abfrage über die Management-API mit dem Service-User.

**Entfernen eines Peers aus der Gruppe (2026-10-08):** `member-2` wurde im Dashboard aus `space-hosts` entfernt. Danach: `host-a` → `member-2`
und `member-2` → `host-a` auf TCP 7421 blockiert (vorher über die Gruppe erlaubt), `member-2` sieht keinen anderen Peer mehr (`Peers count 0/0`),
`host-a` führt `member-2` nicht mehr in der Peer-Liste; `host-a` → `host-b` bleibt offen. Die Änderung kam ohne Neustart der Agenten an. Das
Handy `a34xeea` (`space-admin`) erscheint in der Peer-Liste der Hosts (Status Idle, Verbindung entsteht bei Verkehr). Nicht gemessen: wie schnell
die Änderung ankommt (hier nach wenigen Sekunden bis Minuten seit Entfernen; Zeitpunkt nicht protokolliert).

## 16. Pairing (4.5)

`src/enroll.ts` bringt den App-Schlüssel eines Geräts in den Control Space, ohne dass ein Klartext-Token irgendwo landet.

- **Admin-Seite:** `newEnrollToken()` erzeugt lokal 256 Bit, `hashToken()` bildet SHA-256; nur der Hash geht in `createEnroll` (idempotent, höchstens 5 min Laufzeit, Rollen `host`, `member`, `observer`)
  bzw. `bootstrapEnroll` (der einzige Weg zu einer Admin-Rolle, an die Peer-ID des ersten Admin-Geräts gebunden). Der QR-Inhalt (`enrollQr`) trägt Endpunkt, Control-Space-ID und Token und wird nie geloggt.
- **Gerät:** Ein Peer in der Gruppe `space-enroll` hat am Gate nur die Rolle `unpaired` (Methoden `hello` und `generation`, dazu `enroll` und `enrollStatus` im `EnrollmentService`). Mit `RemoteSpace.enroll(token)` auf dem
  Control Space (`space: "control"`) holt es die Challenge, signiert sie mit dem **neuen** Schlüssel und sendet `enroll`. Der Token liegt nur im flüchtigen Speicher des Handlers und wird sofort gehasht.
- **Reihenfolge der Prüfung (wie 4.5):** Token mit diesem Hash vorhanden (sonst nur das Limit je Peer) → gebundene Peer-ID (ein fremder Peer verbrennt keinen Token) → Ablauf und Versuchszähler →
  Signatur und Schlüsselformat (nur ein Fehler hier erhöht `attempts`; drei Fehler machen den Token ungültig). Bei Erfolg geschehen Tokenverbrauch, `PeerKey` und der Ergebnisclaim in **einem** Commit.
  Ein Wiederholversuch mit derselben Anfrageidentität (neue Challenge, neue Signatur) wird aus dem Claim beantwortet, auch wenn der Token längst verbraucht ist. Höchstens ein Versuch je Peer und Minute.
  Jede Ablehnung hat dieselbe Antwort, ein abgewiesenes Gerät erfährt nichts über Token.
- **Bootstrap:** Der lokal bereitgestellte Supervisor legt einmalig den Token des ersten Admin an; ein verlorener, noch unbenutzter Token wird ersetzt (der alte Hash wird ungültig); mit dem ersten
  Verbrauch ist die Befugnis für immer geschlossen (`BootstrapClosed`).
- **Schlüssel:** `SpaceKeyDirectory` liest die `PeerKey`-Einträge des Control Space als Verzeichnis für Schicht B; `revokePeerKey` widerruft, das Gate trennt die Verbindungen mit dem Schlüssel beim nächsten Tick.

`test/test-enroll.test.ts` (Gate, Management-Nachbildung, Testhost): Bootstrap und Wiederholung, Ersatz eines verlorenen Tokens, Host-Token und Rollenbegrenzung, kein Klartext-Token im Control Space, in Claims und Ereignissen,
die Reihenfolge der Prüfungen, Ratenbegrenzung, Ablauf, einheitliche Ablehnung, nur ungepaarte Peers, `enrollStatus` nur für die eigene Anfrage, Widerruf eines gepaarten Schlüssels.
Noch nicht: der Supervisor als Prozess, der `createEnroll` aus einem Command eines gepaarten Admin verarbeitet (5.1), Schlüsselrotation (`rotateKey`) und der Lauf auf echten Geräten. Inzwischen umgesetzt: die Verarbeitung von `createEnroll` im Supervisor (Abschnitt 17), `rotateKey` (`src/rotation.ts`) und die Kopplung auf echten Geräten ([Implementierungsstand](../implementierungsstand.en.md)).

## 17. Supervisor des Control Space (5, 5.1)

`src/supervisor.ts` ist der einzige Schreiber des Control Space außer den `Command`-Einträgen der Admins. Erster Teil, die Kommandos ohne Router:

- `createEnroll` → ein `Enroll`-Eintrag (nur der Hash des Tokens erreicht den Supervisor); Rollen `host`, `member`, `observer`.
- `revokePeer` → alle aktiven `PeerKey` des Peers werden `revoked`; das Gate trennt die Verbindungen, die diesen Schlüssel bewiesen haben, beim nächsten Tick (15 s).

Jedes Kommando ist **ein Commit**: der `Command` wird genommen, die Wirkung angewendet und das `Result {commandId, kind, state, error?, result?, requestedBy, at}` geschrieben (7 Tage aufbewahrt). Ein Absturz
hinterlässt entweder das Kommando oder sein Ergebnis; eine wiederholte `commandId` wirkt nie zweimal (das zweite Kommando wird ohne neues Ergebnis verworfen). Ungültige Argumente und unbekannte Kommandos werden zu
`failed`-Ergebnissen, nichts wird teilweise angewendet. Der Schreiber eines Kommandos (der Eigentümer des Eintrags) muss beim Verarbeiten einen **aktiven Admin-Schlüssel** im Control Space haben, also ein gepaarter Admin,
nicht „wer auf diesem Host ist“; ein Admin, der sich selbst widerruft, verliert damit sofort seine Befugnis.

`ControlAccess` ist die Netzseite: Auf dem Control Space dürfen über die Leitung nur Admins mit bewiesenem Schlüssel `Command`s schreiben und `Command`, `Result` und `PeerKey` lesen; `Enroll` (Token-Hashes) und
`Bootstrap` verlassen den Host nie, `take`, `stats`, `changes` und `txn` gibt es dort nicht, jeder andere (Member, Admin-Gruppe ohne Beweis, ungepaarte Peers) ist ausgeschlossen. Die Pairing-Pfade (`hello`, `generation`,
`challenge`, `prove`, `enroll`, `enrollStatus`) bleiben davon unberührt. Reihenfolge der Schichten: Gate → `EnrollmentService` → `ControlAccess` → `ProvingService` → `SpaceService`.

`test/test-supervisor.test.ts`: Ablauf Command → Supervisor → Result → `enroll` → `revokePeer` über das Gate; Idempotenz; fehlgeschlagene Kommandos; nur Admins mit Beweis; Schreiber ohne Admin-Schlüssel und der Selbstwiderruf; ein Fehler
vor dem Commit hinterlässt das Kommando, die Wiederholung ergibt genau ein Ergebnis und eine Wirkung (JSONL und SQLite).
Noch nicht: `rotateKey` (verlangt den Beweis beider Schlüssel durch das Gerät), das Router-Journal und die Router-Kommandos (`setLimits`, `addMember`, ...), `restoreDataSpace`/`releaseRestored`, die Ausführung als eigener Prozess auf big. Inzwischen umgesetzt: `rotateKey`, Router-Journal und -Kommandos, `restoreDataSpace`/`releaseRestored` und der Betrieb auf big ([Implementierungsstand](../implementierungsstand.en.md)).

## 18. Testserver nanoi (Phase 3, Test-Primary und Fencing-Ziel)

Stand 2026-10-16. `nanoi` ist ein eigener netcup-KVM-Server (Debian 13, 4 Kerne, 7,8 GB RAM, 157 GB), erreichbar
nur von big aus (`ssh nanoi` mit dort hinterlegtem Schlüssel, Benutzer root). Er ist für Tests reserviert, auf denen
ein Host tatsächlich abgeschaltet werden darf: Test-Primary für primary/sync, `setStandby` und Promotion; vpsc ist
der Backup-/Register-Host, big bleibt wegen seiner übrigen Dienste kein Fencing-Ziel.

| Bereich | Einrichtung |
|---|---|
| Netz | **nur IPv6** (netcup-Image ohne IPv4). `spacebird.eibrain.org` hat seit 2026-10-16 den AAAA-Eintrag `2a0a:4cc0:c0:62f2:8000::1000` (big, nginx auf `[::]:443`). nanoi löst ihn über den netcup-Resolver auf; der vorübergehende `/etc/hosts`-Eintrag ist entfernt. |
| NetBird | Client 0.80.0 aus dem signierten Repository `pkgs.netbird.io`, auf die Server-Version gepinnt (`apt-mark hold`); Peer `nano-test`, 100.89.28.88, Gruppe `space-hosts` über den vorhandenen Setup-Key `testbed-hosts` (von big direkt weitergereicht, nie ausgegeben). Verbindungen zu IPv4-Peers laufen über das Relay. |
| Firewall | `pi-nft-host.service` lädt `/etc/nftables-pi-host.nft`: eingehend nur SSH, ICMP/ICMPv6, WireGuard (UDP 51820) und alles über `wt0`; ausgehend frei. Beim Einrichten mit Totmannschalter angewendet und per neuer SSH-Verbindung geprüft. |
| Laufzeit | Debian `docker.io`; Image `phi-spaces-test-node:local` von big übertragen (Node v22.23.3, Produktionsabhängigkeiten). Verzeichnisse `/opt/phi-spaces/artifacts` und `/var/lib/phi-spaces` (0700). Es werden wie auf big nur gebaute Artefakte ausgeliefert. |
| Zeit | systemd-timesyncd aktiv, synchronisiert (Voraussetzung für die HLC-Uhrprüfung). |

| Federation-Member | Container `phi-spaces-nano` (Benutzer `node`, read-only, keine Capabilities, 2 CPU/2 GiB, Host-Netz) mit Daten in `/var/lib/phi-spaces/nano` (`/data/nano`); eigenständig gebündelter Daemon `federation-host.mjs` aus `test/testbed/federation-host.ts`; Dienst `phi-spaces-nano.service`. Host `nano-test`, Member von Control `phase1b-host-a`, Gate `100.89.28.88:7421`, eigener Ed25519-Host-Schlüssel (`keyId b37f6846…`, seit 2026-10-18) beim Control-Supervisor als `host` enrolled. |
| Register | eigenes Reader-Zertifikat `CN=phi-spaces-register-reader-nano` aus der Operator-CA `phi-spaces-recovery-ca` (Fingerprint `ce6431f5…`, kein Operator-Recht), Zugriff über IPv6 auf `2a02:c207:2252:8263:8000::`:17422 mit `serverName: phi-spaces-register`; externer `boot:nano-test` (Version 1) per Operator-CAS geschrieben |
| NetBird-Abfragen | lesender Management-Token wie bei member-1 (`management-token`, 0600) |

Geprüft: Neustart von nanoi, danach Firewall, Docker, NetBird und `phi-spaces-nano` aktiv und `ready`; ein Admin
(`lux27`) authentifiziert sich über das Overlay am Gate von nanoi (Schlüssel über den Control-Host nachgeschlagen)
und liest dessen Data Space.

Ersteinrichtung des Enrollments: nanoi lag beim Beitritt in `space-hosts` und galt damit als gekoppelt; das Gate
verlangt dann einen Schlüsselbeweis und lehnt die Erstkopplung ab. `nano-test` wurde deshalb nur für das Enrollment
nach `space-enroll` verschoben, mit einer eigenen befristeten Gruppe (nur `host-a`) und Policy für TCP 7421; danach
zurück nach `space-hosts`, eigene Gruppe/Policy gelöscht. Für künftige Hosts ist das der Ablauf, solange keine
dauerhafte Enrollment-Policy besteht.

Änderungen auf vpsc für IPv6-Clients: Der Register-TLS-Dienst lauscht auf `::` (dual-stack, IPv4-Clients
unverändert geprüft), `tls.json` gibt den Fingerprint von nanoi frei (Sicherung `tls.json.before-nano-20261016`);
ufw erlaubt 17422 zusätzlich nur von nanoi. vpsc hatte keine funktionierende IPv6-Default-Route: `fe80::1` aus der
netplan-Konfiguration antwortet nicht, der Router meldet sich als `fe80::2dc:ff:fe00:2`. Diese Route ist zur
Laufzeit gesetzt und in netplan ergänzt (Sicherung `50-cloud-init.yaml.bak.20261016-ipv6gw`, nur `netplan generate`,
kein Neuanwenden); von außen ist nur `…8263:8000::` erreichbar, nicht `…8263::1`.

Fencing: netcup-SCP-Zugang (Offline-Refresh-Token) und Fencing-Dienst liegen auf vpsc, nicht auf nanoi.
Details in [ap3-replica-control.md](../_attic/abnahme/ap3-replica-control.en.md#netcup-adapter). nanoi ist Server 964249 mit
MAC `2a:38:5f:38:de:22`; nur dieser Server steht in der Liste der Ziele. Ein echter Abschaltlauf ist am 2026-10-16 bestanden
([Nachweis](../../test/evidence/f1-netcup-2026-10-16/README.en.md)).

Nach einem harten Ausschalten bleibt `/var/lib/phi-spaces/nano/owner.lock` liegen, und `phi-spaces-nano` startet
nicht von selbst. Vorgehen:

1. Prüfen, dass die eingetragene PID im Container nicht mehr existiert.
2. Erst dann die Sperre löschen.
3. `systemctl start phi-spaces-nano` ausführen.

## 19. Test-Standby 100 (Phase 3, fester synchroner Standby zu nanoi)

Stand 2026-10-16. Host `100` ist ein physischer Server im Heimnetz: 192.168.1.100, Ubuntu 26.04, 8 Kerne, 31 GB RAM.
Er dient zugleich als NFS-Server im LAN. Zugang über `ssh 100` (Benutzer `virtual`) bzw. `ssh 100i` (root). Nach
außen geht er nur über IPv4, mit derselben öffentlichen Adresse wie lux27 (`212.186.197.226`).

| Bereich | Einrichtung |
|---|---|
| Rolle | Fester Standby zu nanoi als Primary. Promotion auf 100 nach netcup-Fencing von nanoi ist möglich. `degradeToSingle` auf nanoi bleibt gesperrt, weil es für 100 keinen Fencing-Adapter gibt (keine Power-API). |
| NetBird | Client 0.80.0 aus `pkgs.netbird.io` (Schlüssel von nanoi übernommen), `apt-mark hold`. Auf 100 lag eine ältere Konfiguration für netbird.io, die nach der Installation kurz wieder aktiv wurde. Sie bleibt als inaktives Profil `default` erhalten; aktiv ist das neue Profil `spacebird` mit Peer `standby-100`, 100.89.187.150, Gruppe `space-hosts`, Peer-ID `db96lcflh8lg008bddjg`. Sicherung des vorherigen Zustands: `/root/netbird-state.before-spacebird-20261016`. Zu nanoi (nur IPv6) läuft die Verbindung über das Relay. |
| Firewall | `pi-nft-host.service` mit `/etc/nftables-pi-host.nft`, Policy `accept`, damit LAN-Dienste (NFS, SSH) unverändert bleiben. Über `wt0` werden nur neue Verbindungen auf TCP 7421 angenommen; 7421 ist außerhalb des Overlays gesperrt. |
| Laufzeit | Docker, Image `phi-spaces-test-node:local` von big; Daemon-Artefakt identisch mit nanoi. Container `phi-spaces-standby` (read-only, keine Capabilities, 2 CPU/2 GiB, Host-Netz), Daten in `/var/lib/phi-spaces/standby`; Dienst `phi-spaces-standby.service`. |
| Federation-Member | Host `standby-100`, Member von Control `phase1b-host-a`, Gate `100.89.187.150:7421`, eigener Ed25519-Schlüssel (`keyId 29728525…`, seit 2026-10-18), als `host` enrolled. Ablauf wie bei nanoi: befristete Gruppe `standby-enroll-20261016` mit Policy, danach gelöscht. |
| Register | Reader-Zertifikat `CN=phi-spaces-register-reader-standby-100` (Fingerprint `d7f89b33…`, Schlüssel auf 100 erzeugt), Zugriff über `207.180.233.218:17422`. `tls.json` auf vpsc ergänzt (Sicherung `tls.json.before-standby-100-20261016`). `boot:standby-100` (Version 1) per Operator-CAS. Keine neue ufw-Regel nötig: Die Adresse ist schon für den Operator freigegeben, getrennt wird über das Zertifikat. |
| NetBird-Abfragen | lesender Management-Token wie bei nanoi |

Geprüft:

- Ein Admin (lux27) liest über das Overlay den Data Space von `standby-100`.
- nanoi erreicht `standby-100:7421` über das Relay.
- Nach einem Neustart von 100 kamen Firewall, NetBird (Profil `spacebird`), Docker, NFS und `phi-spaces-standby`
  von selbst wieder. Der Dienst war danach `ready`, und das Admin-Lesen klappte erneut.

## 20. Neuaufbau unter phi-spaces (2026-10-18)

Die Föderation auf big, vpsc, nanoi und 100 lief bis zum 2026-10-18 unter den alten Namen. Ihre Daten waren mit
der neuen Version nicht übernehmbar (Dokumenttyp-Namespace, Signaturdomänen, SSH-Befehle; die Phase-3-Stores waren
repliziert, siehe [Namensumstellung](../namensumstellung-2026-10-18.en.md)). Sie wurde deshalb gestoppt, gesichert und
unter den neuen Namen frisch aufgesetzt; die Altbestände sind entfernt.

| Bereich | Stand |
|---|---|
| Artefakte | gepinnt auf Commit `0d17ca9` (sauberer Worktree); Bundle-Hash `d20f60d4…`, Daemon `federation-host.mjs` im Image `8a6e8e73…`, eigenständiger Daemon für nanoi/100 `dabaaede…` |
| PKI | neue CA `CN=phi-spaces-recovery-ca` (EC P-256); Register-Server `CN=phi-spaces-register-server` (SAN `207.180.233.218`, `2a02:c207:2252:8263:8000::`, `phi-spaces-register`), Fencing-Server `CN=phi-spaces-fencing-server`, Operator, Reader (big), Reader nano, Reader standby-100 (Schlüssel auf 100). Replica-Control-Zertifikate wurden nicht neu ausgestellt (nicht freigegeben, ungenutzt). CA und Operator liegen lokal unter `~/.local/share/phi-spaces-ops/pki` |
| vpsc | `phi-spaces-recovery-register(-tls).service`, `phi-spaces-fencing.service` unter `~/.local/share/phi-spaces-{recovery,fencing}`; frische Register-Datenbank; netcup-Token und Fence-Zustand verschoben (nicht kopiert) nach `~/.config/phi-spaces-fencing` bzw. `state/` |
| NetBird | Stack `spacebird` unverändert, Verzeichnis jetzt `/media/docker/phi-spaces/netbird`; Testbed-Peers neu (host-a `100.89.103.95`, member-1 `100.89.136.73`, host-b `100.89.90.236`, member-2 `100.89.226.1`), alte Testbed-Peers gelöscht |
| Föderation | Authority `a-ddb275ab…`, Control-Space `sp-be8af63f…` auf `phase1b-host-a` (mit Recovery-Socket und Recovery-Admin-Pin); Members `phase1b-member-1`, `nano-test`, `standby-100` als `host` enrolled; Admin `lux27` neu gekoppelt (`keyId b3004c21…`). Neuer Recovery-Operator-Schlüssel `de22259f…` |
| big | Units `phi-spaces-phase1b-{host-a,member-1}.service` aktiv, die drei Restore-Abnahme-Units umbenannt und deaktiviert; Forced Commands unter `~/.local/share/phi-spaces-operations`; lokale SSH-Aliase `phi-spaces-*` |
| Handy | `xi` (Xiaomi M2007J17G) mit neu gebauter Debug-APK (Bundle `d20f60d4…`); neuer Keystore-Schlüssel `c5c68f25…` (Alias `phi-spaces/…`) als `member` mit Scope `jobs` gekoppelt, Data-Host `phase1b-member-1`; Objektzugriff über das Overlay geprüft. Das alte Profil liegt auf dem Gerät als `space-profile.legacy-20261018.json`, der alte Keystore-Eintrag bleibt ungenutzt |
| nicht neu aufgesetzt | der Haupt-Store von host-a als primary/sync (`main-sync`, zuletzt `single` mit einem nicht mehr vorhandenen Peer) |

Geprüft: alle vier Dienste `ready` und nach Neustart wieder `ready`; der Admin liest über das Overlay den Data Space
`jobs` von member-1, nano-test und standby-100 und den Control-Space (vier PeerKeys); nanoi erreicht
`standby-100:7421`; F15-Status über `phi-spaces-fence-host-a`/`-member-1` und der SSH-Registerleser antworten;
der Fencing-Dienst erneuert das netcup-Token unter dem neuen Pfad.

Die Sicherungen der Altbestände (`~/legacy-backup-20261018` auf big, vpsc und lokal,
`/root/backup/legacy-backup-20261018` auf nanoi und 100) wurden am 2026-10-19 nach der Abnahme gelöscht.
Die Help-Site läuft aus dem Checkout `/media/docker/spaces` (`npm run docker:prod:down` / `docker:prod:up` im
Verzeichnis `help-site`); die früheren Release-Verzeichnisse `/media/docker/phi-spaces-release-*` sind entfernt.

