# Betrieb mit Docker

Aufgebaut wie `codemode-chat/docker/` (siehe `docs/codemode-space-architektur.md` im Root): ein Image, ein Container je
Rolle, alle sprechen nur über den Space und TCP. Dateien: `spaces-mmo/docker/Dockerfile`, `docker-compose.yml`,
`docker-compose.hostnet.yml`; die Skripte stehen in `spaces-mmo/package.json` (`docker:*`).

## Profile

| Profil | Container | Wo |
| --- | --- | --- |
| `nano` | `space` (Welt- und Kontenspeicher als SQLite im Volume `mmo-space-data`), `world-nano` (führt alle Befehle aus) | der Rechner, der den Zustand hält |
| `big` | `web`, `world-big` (nur Termine der Welt und Aufräumen, `SPACES_MMO_WORLD_INTENTS=0`), `npc`, `model` (übersetzt freie Sätze in Befehle) | der Rechner, der die Arbeit macht |
| `dev` | `mmo-dev` (alle Rollen in einem Container, Quelltext eingebunden) | lokal |
| `test` | `mmo-test` (die Testsuite) | überall |
| nano + big | beides auf einer Maschine | lokaler Testaufbau |

`world` lässt sich mehrfach starten; Befehle führt aber nur der Arbeiter neben dem Space aus (`world-nano`), weil ein
Befehl rund ein Dutzend Aufrufe nacheinander an den Space macht (siehe [Last und Latenz](#last-und-latenz)). `npc` und
`model` laufen einmal, auf big.

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
überschreibt sie für Adressen und Ports. Das erste Admin-Konto entsteht mit `SPACES_MMO_SETUP_TOKEN` (beim Registrieren unter „Einrichtungstoken“).
Ein schon bestehendes Konto wird Admin, wenn es sich mit dem Token anmeldet („Anmelden“, „Einrichtungstoken (macht
dieses Konto zum Admin)“). Wer keine weiteren Admins will, entfernt den Token danach. Der Knopf „Admin“ (oben neben
„Abmelden“, auf dem Handy im Menü ⋯) öffnet das Fenster für Modelle und Grenzen. Die Image-Datei enthält keine `.env` (`.dockerignore`).

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

## Last und Latenz

Gemessen wird mit `tests/perf/load.test.ts` (`npm run test:perf`): der Space auf SQLite, alle NPC-Rollen, mehrere Spieler,
die im Takt der Seite laufen (ein Schritt je 150 ms, höchstens acht der Antwort voraus), und ein Proxy, der die Verbindung
zwischen big und nano verzögert (`LOAD_PLAYERS`, `LOAD_SECONDS`, `LOAD_DELAY_MS` je Richtung, `LOAD_WORLDS=near|far|both`
für den Ort der Welt-Worker). Gemessen wird die Zeit vom Schritt bis zu seiner Bestätigung an der eigenen Figur.

Stand 2026-10-27, auf dem Entwicklungsrechner (Docker, alle Spieler im selben Raum):

| Fall | vorher | nachher |
| --- | --- | --- |
| 5 Spieler, keine NPCs | Median 65 ms, p99 110 ms | Median 21 ms, p99 52 ms (3 Spieler) |
| 10 Spieler, alle NPCs | 0,3 Schritte/s beantwortet, Median 5–10 s | Median 19 ms, p99 206 ms |
| 20 Spieler, alle NPCs, Ping 10 ms | – | Median 38 ms, p99 112 ms |
| 20 Spieler, alle NPCs, Ping 20 ms | – | Median 55 ms, p99 119 ms |
| 20 Spieler, Ping 20 ms, Welt-Worker auf big | – | Median 3,2 s |
| 30 Spieler, alle NPCs | – | gesättigt bei rund 135 Schritten/s (Median 1,8 s) |

Was es langsam machte, und was sich geändert hat:

- **Verlorene Raum-Tokens.** Ein Schritt gegen eine besetzte Kachel wurde abgelehnt, aber trotzdem bestätigt; das Token des
  Raums blieb dabei genommen und ging mit dem Commit verloren. Jede weitere Bewegung im Raum wartete dann 5 s darauf. Die
  Belegung läuft jetzt über `Spot`-Entries mit `unique` ([evennia-abbildung.md](evennia-abbildung.md#kollision)), ohne
  Sperre je Raum.
- **Abfragen alle 50 ms.** Der Space-Dienst sah bei wartenden Aufrufen (blockierendes Lesen, `changes`) nur alle 50 ms nach;
  das kostete jeden Schritt zweimal bis zu 50 ms. Er wird jetzt beim Commit geweckt (`src/service.ts`, `commitSignal`).
- **Ein Befehl nach dem anderen.** Der Welt-Worker bedient jetzt bis zu `SPACES_MMO_WORLD_LANES` (16) Figuren zugleich, jede
  der Reihe nach, und nimmt die Figuren in der Reihenfolge ihres ältesten Befehls dran: Wer viel tippt, hält eine Spur.
- **Lesen mit Commit.** `readIfExists(…, NO_WAIT)` ist ein Aufruf mit Claim, den der Space committet; Prüfungen ohne Warten
  lesen jetzt als Schnappschuss (`peek`, `readAll`). Ein Schritt liest weder Konto noch Befehlssätze noch (für die Räume der
  Welt) den Raum.
- **Die Änderungshistorie.** Der Space kopierte und durchlief bei jedem Commit die ganze Historie des Änderungsstroms (4 MiB,
  tausende Stapel). Der Kern durchläuft sie nicht mehr (`src/store/draft.ts`), und spaces-mmo hält 512 KiB
  (`SPACES_MMO_LOG_BYTES`): bei voller Last einige Sekunden; ein Web-Prozess, der weiter zurückfällt, liest die Welt neu
  (`[gateway] change stream: …; reading the world again`).
- **Die Zählung der Historie.** Der Kern zählte je Operation ein Byte zu viel (das Komma vor der ersten eines Stapels); der
  Überschuss blieb im Zähler, nach 2,6 Millionen Revisionen rund 2,6 MB. Mit 512 KiB lag der Zähler des Produktivspace
  dauerhaft über der Grenze, und jeder Commit verwarf die ganze Historie; das Gateway las die Welt dann in einer Schleife neu.
  Die Zählung ist jetzt genau, und ein vorgelaufener Zähler wird neu gerechnet, sobald nur noch ein Stapel übrig wäre.
- **Grenzen des Dienstes.** Alle Prozesse sind gegenüber dem Space ein Teilnehmer; dessen Grenzen (1024 Aufrufe je Sekunde,
  128 wartende Aufrufe, 32 Aufrufe je Verbindung) sind für das ganze Spiel bemessen worden.

**Wo die Welt-Worker laufen:** Ein Befehl macht rund ein Dutzend Aufrufe nacheinander an den Space. Neben dem Space (nano)
kostet das Millisekunden, über die Verbindung zwischen den Rechnern ein Vielfaches des Pings je Aufruf. Deshalb führt
`world-nano` alle Befehle aus; `world-big` läuft mit `SPACES_MMO_WORLD_INTENTS=0` und bedient nur die Termine der Welt und
das Aufräumen.

**Grenze:** Der Space-Prozess ist ein Thread. Bei rund 135 Schritten je Sekunde (etwa 20 Spieler, die ohne Pause laufen) ist
er auf dem Entwicklungsrechner voll; darüber staut es sich. Weitere Schritte wären im Kern: ein Index der Entries nach Typ
(jedes `readAll` durchläuft heute alle Entries) und mehrere Operationen in einem Aufruf.

**Gegen Fluten:** Das Gateway begrenzt je Konto (über alle offenen Seiten zusammen) Schritte auf 8 auf einmal und 10 je
Sekunde und getippte Befehle auf `SPACES_MMO_CMD_BURST` (20) auf einmal und `SPACES_MMO_CMD_PER_SEC` (5) je Sekunde; ein
Konto hat höchstens vier Seiten offen, eine fünfte schließt die älteste.

**Diagnose:** `SPACES_MMO_TRACE=1` (Aufrufe je Prozess und Methode alle 10 s), `SPACES_MMO_SLOW_MS=200` (der Welt-Worker
meldet jeden Befehl, der später als das nach dem Tippen beantwortet wurde, mit seiner eigenen Laufzeit).

Die NPC-Skripte schauen in eigenem Takt: Händler und Arbeiter alle 8 s, ein Wanderer in Abwesenheit alle 10 s, Ines und wache
Wanderer alle 3 s. Im Dev-Container lassen sich NPCs auswählen: `SPACES_MMO_DEV_NPCS=ines,bo npm --prefix spaces-mmo run
docker:dev:up`.

## Lasttest gegen die laufende Welt

`tests/perf/live-load.ts` lässt `LOAD_BOTS` Gastfiguren (Standard 100) `LOAD_SECONDS` lang (Standard 600) über den
Web-Prozess spielen, wie Seiten es tun: Gast-Login per HTTP, Befehle über den Spiel-Socket. Sie heben Treibholz und
Muscheln auf, tragen das Holz zum Feuer und legen nach, verkaufen Muscheln an Kalle, schauen auf den Markt und gehen
durch die Ausgänge, mit 1 bis 3 s Pause zwischen zwei Befehlen. Gemessen wird jeder Befehl vom Senden bis zur ersten
Antwort für die Figur (eigene Position, eigene Ausgabe, Fehler, nächster Raum), in `LOAD_OUT/commands.jsonl`.
Die Figuren sprechen nie frei (kein Satz für das Modell); Modell-NPCs können aber aufwachen, wenn sie einen Raum
betreten (Tagesbudget). Jede Figur schickt ein eigenes `x-forwarded-for` aus 198.18.0.0/15, sonst stoppt die
Gast-Quote je Adresse; das wirkt nur über den Loopback-Port (Peer 127.0.0.1), nicht von außen.

```sh
# auf big, neben dem Web-Prozess (Node ohne node_modules genügt)
cd /media/docker/spaces/spaces-mmo && LOAD_OUT=/tmp/mmo-load node tests/perf/live-load.ts
# danach: die Figuren entfernen (Münzen zurück an Kalle, Gastkonten weg, den Rest räumt die Welt selbst)
docker cp tests/perf/live-load-cleanup.ts phi-spaces-mmo-web-1:/opt/phi-spaces/spaces-mmo/live-load-cleanup.ts
# (nicht nach /tmp im Container: das ist ein tmpfs, docker cp landet darunter)
docker cp /tmp/mmo-load/bots.json phi-spaces-mmo-web-1:/opt/phi-spaces/spaces-mmo/load-bots.json
docker exec -w /opt/phi-spaces/spaces-mmo phi-spaces-mmo-web-1 node --experimental-strip-types live-load-cleanup.ts load-bots.json
docker exec phi-spaces-mmo-web-1 rm -f /opt/phi-spaces/spaces-mmo/live-load-cleanup.ts /opt/phi-spaces/spaces-mmo/load-bots.json
```

Ergebnis eines Laufs mit 100 Figuren: [lasttest-2026-10-28.md](lasttest-2026-10-28.md).

## Nicht enthalten

- Kein Backup-Skript wie `docker:backup` im Chat; der Speicher liegt im Volume, die Sicherung des Verzeichnisses
  übernimmt der Betreiber, bis ein Sicherungsbefehl vorgesehen ist.
