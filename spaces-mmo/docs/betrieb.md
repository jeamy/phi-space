# Betrieb mit Docker

Aufgebaut wie `codemode-chat/docker/` (siehe `docs/codemode-space-architektur.md` im Root): ein Image, ein Container je
Rolle, alle sprechen nur über den Space und TCP. Dateien: `spaces-mmo/docker/Dockerfile`, `docker-compose.yml`,
`docker-compose.hostnet.yml`; die Skripte stehen in `spaces-mmo/package.json` (`docker:*`).

## Profile

| Profil | Container | Wo |
| --- | --- | --- |
| `nano` | `space` (Welt- und Kontenspeicher als SQLite im Volume `mmo-space-data`), `world-nano` | der Rechner, der den Zustand hält |
| `big` | `web`, `world-big`, `npc`, `model` (übersetzt freie Sätze in Befehle) | der Rechner, der die Arbeit macht |
| `dev` | `mmo-dev` (alle Rollen in einem Container, Quelltext eingebunden) | lokal |
| `test` | `mmo-test` (die Testsuite) | überall |
| nano + big | beides auf einer Maschine | lokaler Testaufbau |

`world` lässt sich mehrfach starten (je Rechner ein Arbeiter); `npc` und `model` laufen einmal, auf big.

**Modellzugang:** Wie codemode-chat und das Help-System lesen `npc` und `model` die Anmeldung der pi-CLI des Hosts:
`${PI_AUTH_DIR:-$HOME/.pi/agent}` wird schreibgeschützt nach `/home/node/.pi/agent` eingebunden (alternativ API-Schlüssel
wie `ANTHROPIC_API_KEY` in `.env`). Modellaufrufe kosten Tokens und laufen nur mit `SPACES_MMO_LLM=1` in `.env`; ohne
bleiben die Modell-NPCs bei ihren Skripten und freie Sätze bei den kostenlosen Regeln. Die Meldung `[llm] no models`
heißt: weder Schlüssel noch pi-Anmeldung im Container.

Auf big läuft Docker rootless: dort gehört das eingebundene `~/.pi/agent` im Container root, und der Benutzer `node`
kann `auth.json` nicht lesen (ebenfalls `[llm] no models`). Wie codemode-chat und das Help-System nutzt spaces-mmo dort
eine Kopie, die der Container-Benutzer `node` besitzt (auf dem Host uid 100999), und setzt in `spaces-mmo/.env`
`PI_AUTH_DIR=/home/mux/.pi/agent-node`. Die Kopie entsteht (und nach einer neuen pi-Anmeldung erneut) mit

```sh
mkdir -p -m 755 ~/.pi/agent-node && cp ~/.pi/agent/auth.json ~/.pi/agent-node/
docker run --rm -v ~/.pi/agent-node:/d node:22-bookworm-slim sh -c 'chown 1000:1000 /d/auth.json && chmod 400 /d/auth.json'
```

Danach `npm --prefix spaces-mmo run docker:big:up`; `docker exec phi-spaces-mmo-npc-1 cat /home/node/.pi/agent/auth.json
>/dev/null` prüft, ob `node` die Datei lesen kann.

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
npm --prefix spaces-mmo run docker:local:up     # baut das Image, startet space, world-nano, web, world-big, npc, model
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

## Wenn „the generation exceeds maxClaimBytes“ erscheint

Jeder Aufruf jedes Prozesses hinterlässt einen Request-Claim, dessen Ergebnis der Space `claimResultMs` lang behält
(Standard des Kerns: 24 Stunden). Die Prozesse fragen mehrmals je Sekunde; nach etwa einem Tag ist `maxClaimBytes` voll, und
der Space lehnt neue Anfragen ab (Web und Modellprozess melden den Fehler, die Welt steht). `server/space-host.ts` setzt
deshalb `claimResultMs` auf **10 Minuten** (`SPACES_MMO_CLAIM_RESULT_MS`); ein wiederholter Aufruf kommt innerhalb seines
Wiederholungsfensters (30 s Zeitgrenze, drei Versuche), die Genau-einmal-Zusicherung bleibt. Ein schon volles Volume
räumt sich nach dem Neustart des Space selbst auf (rund 250 Claims je Sekunde); die Datei `world.sqlite` schrumpft dabei nicht.
Das Help-System hat denselben Wert (`claimResultMs` 15 Minuten).

Dazu gehört `generationAdmitMs` (Kern-Standard 1 Stunde): Der Space behält den Hash eines Claims, bis seine Generation keine
neuen Anfragen mehr annimmt. Mit nur zehn Minuten gehaltener Ergebnisse säßen tausende abgelaufene, aber noch gehaltene
Claims im Space, und der Sweep jedes Commits läse sie wieder (gemessen: 53 % der CPU des Space-Prozesses in der
Datenbankabfrage `due`). Beide Werte sind deshalb gleich; das Help-System setzt sie ebenfalls gleich.

## Last des Space-Prozesses

Jeder Aufruf (auch ein Lesen) ist eine Transaktion mit Claim; der Space-Prozess ist ein einzelner Thread. Die meisten Aufrufe
machen die NPC-Skripte (jede Runde mehrere Lesezugriffe): mit allen NPCs sind es rund 30 Aufrufe je Sekunde, und die
Antwort auf einen Schritt kann dann Sekunden dauern. Deshalb: Händler und Arbeiter schauen alle 8 s (statt 5 s), ein
Wanderer in Abwesenheit alle 10 s, und das Warten auf einen Befehl (`act`) fragt mit wachsendem Abstand (50, 100, 200,
250 ms) statt alle 50 ms. Ines und wache Wanderer bleiben bei 3 s, weil Spieler auf sie warten. Im Dev-Container lassen sich
NPCs auswählen: `SPACES_MMO_DEV_NPCS=ines,bo npm --prefix spaces-mmo run docker:dev:up`.

## Nicht enthalten

- Kein Backup-Skript wie `docker:backup` im Chat; der Speicher liegt im Volume, die Sicherung des Verzeichnisses
  übernimmt der Betreiber, bis ein Sicherungsbefehl vorgesehen ist.
