# Testumgebung auf dem Server `big`

Stand: 2026-10-08. Beschreibt `test/testbed/` und das Vorgehen. Die Umgebung führt die vorhandenen Tests aus und
stellt die Hosts bereit, die die Stufen 1b–3 des [Implementierungsplans](implementierungsplan-v3.md) brauchen.
Sie ersetzt weder NetBird noch einen echten Fencing-Adapter (Abschnitt 8).

**Prüfstand (2026-10-08, auf dem Server ausgeführt):** `check`, `up` (Image-Build und Start des Runners), `test quick`
(Typecheck und 108 Tests im Container bestanden), `kill runner` (Container beendet, neu gestartet, danach `exec` möglich,
Volume erhalten) und das Szenario Primzahlsieb aus Abschnitt 10 (create, run, evaluate und ein zweiter Lauf mit `all`).
**Noch nicht ausgeführt:** `up federation`, `stop`, `partition`/`heal`, `test examples`/`all`. Der erste Build deckte ein
veraltetes `package-lock.json` auf (Abschnitt 9).

## 1. Zweck und Überblick

Tests und später die Federation-Hosts laufen in Docker-Containern auf einem Server, nicht auf dem eigenen Rechner.
Ein Skript erledigt Einrichtung und Betrieb:

```
lokaler Rechner                       Server big (ssh), Verzeichnis /media/docker/pi-spaces
test/testbed/testbed.sh  ── ssh ──►   docker-compose.yml  Dockerfile  entrypoint.sh  .env      (nur angelegt, wenn fehlend)
   rsync des Checkouts   ─────────►   repo/                                                      (Quellen, ohne node_modules)
                                      Container (rootless Docker):
                                        runner      Tests: typecheck, npm test, test:examples
                                        host-a      Koordinator   ┐
                                        host-b      Standby       ├ Profil "federation", Volume /data je Host
                                        member-1/2  Data Members  ┘
```

Die Quellen werden bei jedem Lauf per rsync übertragen und in die Container eingebunden (`./repo:/work`).
Das Image enthält nur Node und die gelockten Abhängigkeiten (`npm ci`); es wird nur neu gebaut, wenn sich
`package.json`, `package-lock.json` oder das Dockerfile ändern.

## 2. Befund zum Server (geprüft am 2026-10-08, nur lesend)

| Punkt | Befund | Folge |
|---|---|---|
| Zugang | `ssh big` meldet sich als normaler Benutzer an, nicht als `root`; ein zweiter ssh-Alias führt als `root` auf denselben Host. | Standard ist `big` |
| Docker | **rootless**, ein Daemon je Benutzer (Socket unter `/run/user/<uid>/`). Der System-Daemon ist maskiert; **`root` erreicht keinen Daemon.** | Skript läuft als der Daemon-Benutzer, nicht als `root` |
| Verzeichnis | `/media/docker/pi-spaces` existierte, gehörte dem Daemon-Benutzer und war leer; die anderen Projekte unter `/media/docker` gehören ebenfalls ihm. | passt zum Benutzer |
| sudo | `sudo -n` verlangt für diesen Benutzer ein Passwort | kein sudo, `TESTBED_SUDO=no` |
| Ressourcen | geteilter Server mit mehreren laufenden Containern anderer Projekte; die Platte war zu über 90 % belegt | knappe Limits je Container, keine veröffentlichten Ports; `check` zeigt den freien Platz |
| cgroup | v2, systemd-Treiber; Docker meldet `cpuset` und `io.weight` als nicht unterstützt | Speicher-, CPU- und PID-Limits werden gesetzt; ob die CPU-Quota greift, zeigt der erste Lauf |
| Werkzeuge | docker 29.8.2, compose 5.6.0, rsync vorhanden | nichts zu installieren |

„Als root“ aus der Aufgabenstellung wurde deshalb als **Projektwurzel** `/media/docker/pi-spaces` unter dem Benutzer
des Docker-Daemons umgesetzt. Als `root` ginge es nur mit `TESTBED_DOCKER_HOST` auf den Socket dieses Benutzers, und dann
könnten die Container (deren root dem Host-Benutzer des Daemons entspricht) nicht in root-eigene Verzeichnisse schreiben.
Das ist nicht empfohlen.

## 3. Voraussetzungen

Lokal: `ssh`, `rsync`, `bash` (für ein Passwort statt Schlüssel zusätzlich `sshpass`). Auf dem Server: Docker mit
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
| `TESTBED_REMOTE_DIR` | `/media/docker/pi-spaces` | Projektverzeichnis auf dem Server (absolut, mindestens zwei Ebenen) |
| `TESTBED_SUDO` | `no` | `yes`: Befehle über `sudo -n` |
| `TESTBED_DOCKER_HOST` | automatisch | Docker-Socket, z.B. `unix:///run/user/<uid>/docker.sock`; erkannt, wenn kein System-Socket existiert |
| `TESTBED_PROJECT` | `pi-spaces-test` | Compose-Projektname; Präfix für Container, Netz, Volumes, Image |
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
   - legt `/media/docker/pi-spaces` und `repo/` an, falls sie fehlen;
   - schreibt `docker-compose.yml`, `Dockerfile`, `entrypoint.sh`, `.dockerignore` und `.env`, **nur wenn sie fehlen**;
     weicht eine vorhandene Datei von der Vorlage ab, wird gewarnt und nichts überschrieben (`init --force` überschreibt);
   - überträgt den Checkout per rsync (ohne `.git`, `node_modules`, `dist`, Logs, `.env`);
   - baut das Image (Cache, solange `package*.json` und Dockerfile gleich bleiben);
   - startet **nur die Container, die nicht laufen**; laufende bleiben unberührt (`docker compose up -d`);
   - zeigt den Status.
4. **Testen:** `test` (Standard `quick` = typecheck + `npm test`), `test unit`, `test examples`, `test all`.
   Argumente für eine einzelne Suite nach `--`: `test unit -- --test-name-pattern=claims`. `test` führt vorher `up core` aus,
   überträgt also den aktuellen Stand. Alle Suiten laufen auch bei einem Fehlschlag durch; der Exit-Code ist dann 1.
5. **Beobachten:** `status`, `logs <dienst> [zeilen]`, `exec <dienst> <befehl…>` (mit Terminal, wenn vorhanden).
6. **Beenden:** `down` entfernt Container und Netz, behält Volumes und `repo/`. `destroy --yes` entfernt zusätzlich
   Volumes und Image. Das Verzeichnis selbst und `repo/` löscht das Skript nie.

## 6. Container und ihre Verwendung

Alle Container laufen im Leerlauf (`sleep infinity`, `init: true`, `restart: unless-stopped`); Prozesse starten Tests und
später die Dienste mit `exec`. Jeder Host hat ein eigenes Volume `/data`, so dass kein Storage zwischen Hosts geteilt wird
(ein Datenbankverzeichnis wird nie von mehreren Harnesses geöffnet) und ein Absturz die Daten erhält.

| Dienst | Profil | Rolle (v3) | Verwendung |
|---|---|---|---|
| `runner` | immer | Testläufer | `typecheck`, `npm test`, `npm run test:examples`; Crash-/Reopen-Tests auf echtem Dateisystem (JSONL, SQLite) |
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
| `image build failed` | Auf dem Server `cd /media/docker/pi-spaces && docker compose build runner` für die volle Ausgabe; meist Netzzugang oder Plattenplatz |
| `npm ci` meldet `lock file ... does not satisfy` | `package-lock.json` passt nicht zu `package.json`. Das war hier der Fall (esbuild fehlte im Lock). Lokal `npm install --package-lock-only` und die Änderung prüfen |
| `Permission denied (publickey)` mit einem fremden Benutzernamen | `test/testbed/testbed.env` enthält einen aktiven Platzhalter (`TESTBED_SSH_USER=deploy`). Zeile entfernen oder einkommentiert lassen; Umgebungsvariablen haben Vorrang, `TESTBED_SSH_USER=` (leer) nimmt den Benutzer aus `~/.ssh/config` |
| `… on the server differs from the template` | Server-Datei wurde geändert oder die Vorlage wurde aktualisiert: Unterschied prüfen, dann `init --force` |
| Tests laufen, aber `Cannot find package` | `package.json`/`package-lock.json` geändert: `up` erneut (baut das Image neu) |
| Container startet immer wieder neu | `logs <dienst>`; `stop` hält ihn an, `down` entfernt ihn |

## 10. Szenario: Primzahlsieb mit simuliertem Handy

`test/testbed/scenarios/sieve-mobile.ts` spielt den Bedienablauf aus [betrieb-und-mobile-steuerung.md](betrieb-und-mobile-steuerung.md)
Abschnitt 6 mit einem simulierten mobilen Gerät nach. Es nutzt den benannten Space `sieve-a` (Doc-Version 5), dauerhafte
Request-Claims (Stufe 1) und JSONL-Storage auf dem Volume `/data`. Drei getrennte Aufrufe, wie bei einem Handy, das einen Lauf
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

Beispiel mit Absturz des Containers zwischen den Phasen:

```sh
npm run testbed -- scenario sieve-mobile create --fresh
npm run testbed -- kill runner                      # Container stirbt, das Volume bleibt
npm run testbed -- scenario sieve-mobile run --host-restart --drop 0.4 --workers 3
npm run testbed -- scenario sieve-mobile evaluate   # Exit-Code 0 = bestanden
```

**Was das Szenario nicht abbildet:** ein echtes Handy, Funknetz oder NetBird (die Verbindung ist ein Zufallsmodell auf Aufrufebene),
mehrere Hosts (alles läuft in einem Container und einem Harness-Prozess; ein Host-„Neustart“ beendet die Worker und öffnet den
Storage neu, ist aber kein Absturz mitten im Commit) und das Pausieren über ein RunGate (noch nicht implementiert). Das
Vorbereiten der Aufgaben ist nicht gegen vorzeitige Bearbeitung abgesichert (Betrieb Abschnitt 6, `preparing`). Als
Regressionstest läuft eine kleine Fassung in `npm test` (`test-scenario.test.ts`).
