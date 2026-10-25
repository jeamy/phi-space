# Betrieb mit Docker

Aufgebaut wie `codemode-chat/docker/` (siehe `docs/codemode-space-architektur.md` im Root): ein Image, ein Container je
Rolle, alle sprechen nur über den Space und TCP. Dateien: `spaces-mmo/docker/Dockerfile`, `docker-compose.yml`,
`docker-compose.hostnet.yml`; die Skripte stehen in `spaces-mmo/package.json` (`docker:*`).

## Profile

| Profil | Container | Wo |
| --- | --- | --- |
| `nano` | `space` (Welt- und Kontenspeicher als SQLite im Volume `mmo-space-data`), `world-nano` | der Rechner, der den Zustand hält |
| `big` | `web`, `world-big`, `npc` | der Rechner, der die Arbeit macht |
| `dev` | `mmo-dev` (alle Rollen in einem Container, Quelltext eingebunden) | lokal |
| `test` | `mmo-test` (die Testsuite) | überall |
| nano + big | beides auf einer Maschine | lokaler Testaufbau |

`world` lässt sich mehrfach starten (je Rechner ein Arbeiter); `npc` läuft einmal, auf big.

## Ports

| Port | Dienst | Veröffentlicht auf |
| --- | --- | --- |
| 3900 | web (Browser, WebSocket, `/healthz`) | `HOST_BIND` (Standard 127.0.0.1), davor der Reverse Proxy |
| 3950 | Weltspace | `SPACES_MMO_SPACE_BIND` (Standard 127.0.0.1) |
| 3951 | Kontenspeicher (Zugangsdaten, Sitzungen) | `SPACES_MMO_SPACE_BIND` |

Die beiden Space-Ports haben **kein TLS** und behandeln jede Verbindung als Prozess des Spiels; der Kontenspeicher hält
die Zugangsdaten. Sie gehören nie auf eine öffentliche Schnittstelle, nur auf die interne Adresse (LAN/NetBird) oder auf
die Loopback-Adresse hinter einem SSH-Tunnel. Codemode-chat belegt 3700/3800, das Help-System 3500/3600.

## Lokal testen (beide Rollen auf dieser Maschine)

```
npm --prefix spaces-mmo run docker:local:up     # baut das Image, startet space, world-nano, web, world-big, npc
npm --prefix spaces-mmo run docker:local:logs
npm --prefix spaces-mmo run docker:local:down
```

Das Spiel ist dann auf <http://127.0.0.1:3910> erreichbar (Web 3910, Welt 3960, Konten 3961, damit eine laufende
Entwicklungsinstanz auf 3900 nicht stört). `NANO_CPUS` (Standard 2) begrenzt nano wie den kleineren Rechner. Die Tests in
Docker: `npm --prefix spaces-mmo run docker:test`.

## Entwicklung (kompiliert bei jeder Änderung neu)

```
npm --prefix spaces-mmo run docker:dev:up       # baut das Dev-Image, startet einen Container mit allen Rollen
npm --prefix spaces-mmo run docker:dev:logs
npm --prefix spaces-mmo run docker:dev:down
```

Ein Container (`mmo-dev`), der Quelltext des Arbeitsverzeichnisses ist eingebunden (`app/`, `client/`, `server/`, `worlds/`
und `src/` des phi-spaces-Kerns). Die Seite ist auf <http://127.0.0.1:3920> erreichbar (`SPACES_MMO_DEV_PORT`; 3900 und die
3910 des lokalen Testaufbaus bleiben frei). `app/` und `client/` kompiliert Next.js im Dev-Modus neu (Fast Refresh, die Seite
lädt von selbst), und jeder Serverprozess (space, world, npc, web) startet neu, sobald sich `server/`, `worlds/` oder der
Kern ändert. Der Speicher liegt im Volume `mmo-dev-data` und bleibt über Neustarts erhalten; `docker volume rm
phi-spaces-mmo_mmo-dev-data` setzt die Welt zurück.

Modellaufrufe (Modell-NPCs, Übersetzen von Sätzen in Befehle) kosten Tokens und sind im Dev-Container aus, außer er wird
mit `SPACES_MMO_LLM=1` gestartet (`SPACES_MMO_LLM=1 npm --prefix spaces-mmo run docker:dev:up`, oder in der `.env`). Die
Zugangsdaten kommen aus dem pi-CLI-Login des Rechners (`~/.pi/agent`, nur lesend eingebunden; `PI_AUTH_DIR=` schaltet das
ab). Gewählt wird das neueste verfügbare Modell, dessen ID `SPACES_MMO_LLM_MODEL` enthält (Standard `haiku`); die
Grenzen stehen in `.env.example`.

## Produktion: nano und big

Ein Rechner betreibt genau ein Profil. Auf beiden: `git pull --ff-only`, dann das Skript des Rechners.

1. **nano** (hält den Zustand): in `spaces-mmo/.env` `SPACES_MMO_SPACE_BIND=<interne Adresse von nano>`, dann
   `npm --prefix spaces-mmo run docker:nano:up`.
2. **big** (Web, Arbeiter, NPCs): in `spaces-mmo/.env` `SPACES_MMO_SPACE=tcp:127.0.0.1:3950` und
   `SPACES_MMO_ACCOUNTS=tcp:127.0.0.1:3951`, dazu zwei SSH-Tunnel als Benutzer-Units auf big (wie `swarm-nano-tunnel`
   und `codemode-nano-tunnel`) von 127.0.0.1:3950 und :3951 nach nano. Dann
   `npm --prefix spaces-mmo run docker:big:up` (Host-Netzwerk über `docker-compose.hostnet.yml`, web nur auf der
   Loopback-Adresse, davor nginx).
3. `docker:prod:up` ist absichtlich gesperrt, damit nicht beide Profile auf einem Rechner laufen.

Das Image wird auf dem Rechner selbst gebaut (`docker build --network host`: auf dem rootless Docker von nano erreicht ein
Build im Standardnetz die npm-Registry nicht). Der Speicher bleibt beim Neustart der Container im Volume erhalten.

## Einstellungen

Die `.env` (Vorlage `spaces-mmo/.env.example`) wird allen Containern als `env_file` mitgegeben; `environment:` im Compose
überschreibt sie für Adressen und Ports. Das erste Admin-Konto entsteht mit `SPACES_MMO_SETUP_TOKEN` (einmalig, danach
entfernen). Die Image-Datei enthält keine `.env` (`.dockerignore`).

## Nicht enthalten

- Kein Backup-Skript wie `docker:backup` im Chat; der Speicher liegt im Volume, die Sicherung des Verzeichnisses
  übernimmt der Betreiber, bis ein Sicherungsbefehl vorgesehen ist.
