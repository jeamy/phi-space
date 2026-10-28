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
3. `docker:prod:up` ist absichtlich gesperrt: beide Profile auf einem Rechner startet nur `docker:single:up` (unten).

### Alles auf einem Rechner (Space auf big)

Der Space-Prozess braucht einen schnellen Kern, nicht viele: auf nano (kleine VM) rechnete ein Kern im Vergleich
(JSON kodieren und lesen) etwa dreimal so lange wie auf big ([lasttest-2026-10-28.md](lasttest-2026-10-28.md)), und der
Lasttest sättigte genau diesen Kern. `docker:single:up` startet beide Profile auf einem Rechner: `space` und `world-nano`
im Docker-Netz (der Space nur auf `127.0.0.1:3950`/`3951`), web, world-big, npc und model im Host-Netz wie bisher, die
den Space jetzt ohne Tunnel auf demselben Port erreichen. In der `.env` von big dazu `NANO_HOST_NAME=big` (die
Systemleiste nennt sonst „nano“).

Umzug von nano nach big (Auszeit wenige Minuten; nano behält seine Dateien für den Rückweg):

```sh
# big: vorher, ohne Auszeit
cd /media/docker/spaces && git pull --ff-only && npm --prefix spaces-mmo run docker:image
# nano: anhalten (Space und Welt-Worker; das Volume bleibt)
cd /home/mux/spaces && npm --prefix spaces-mmo run docker:nano:down
# big: Tunnel aus (er belegt 3950/3951), Dateien herüber, alles starten
systemctl --user disable --now mmo-nano-tunnel
docker volume create phi-spaces-mmo_mmo-space-data
ssh nano "tar -C /home/mux/.local/share/docker/volumes/phi-spaces-mmo_mmo-space-data/_data --exclude='*.owner*' --exclude='*-shm' -cf - ." \
  | docker run --rm -i -v phi-spaces-mmo_mmo-space-data:/data phi-spaces-mmo:prod tar -xf - -C /data
npm --prefix spaces-mmo run docker:single:up
```

Kopiert werden die Stores mit ihrem WAL, ohne die Besitzer-Sperren (`*.owner*`, sie gehören dem angehaltenen Prozess)
und ohne `-shm`. Ein Space einer älteren phi-spaces-Version bietet `batch` und transientes Schreiben nicht an; die
Prozesse fragen das beim Verbinden ab und schreiben dann wie vorher (der Rückweg auf nano mit altem Stand geht also).
Zurück: `docker:single:down` auf big, `systemctl --user enable --now mmo-nano-tunnel`, auf nano `docker:nano:up`,
auf big `docker:big:up`.

### Zwei Spaces auf zwei Rechnern (Stand seit 2026-10-28)

Die Testumgebung soll beide Rechner nutzen, und der Welt-Space braucht den schnellen Kern. Deshalb dient jeder Rechner
einen der beiden Spaces (`SPACES_MMO_SPACES` des Space-Prozesses):

| Rechner | Prozesse | `.env` |
| --- | --- | --- |
| big | Welt-Space und der Welt-Worker, der die Befehle ausführt (Profil `nano`), web, world-big (Termine, Aufräumen), npc, model (Profil `big`): `docker:single:up` | `SPACES_MMO_SPACES=world`, `SPACES_MMO_ACCOUNTS=tcp:127.0.0.1:3951`, `SPACES_MMO_ACCOUNTS_PORT=3971` (der unbenutzte Konten-Port des Containers, 3951 gehört dem Tunnel), `NANO_HOST_NAME=big` |
| nano | Konten-Space (Zugangsdaten, Web-Sitzungen): `docker:accounts:up` | `SPACES_MMO_SPACES=accounts` |

Das Web auf big erreicht den Konten-Space über die Benutzer-Unit `mmo-accounts-tunnel` (`deploy/`, nur Port 3951). Jeder
Befehl bleibt neben dem Welt-Space; über das Netz gehen Anmeldung, Registrierung und das Prüfen einer Web-Sitzung.

Der Wechsel von „alles auf big“ dazu: auf big `docker:single:down`, den Konten-Store von big nach nano kopieren (er ist
der neuere), auf nano `docker:accounts:up`, auf big die Tunnel-Unit einschalten und `docker:single:up`.

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

**Stand 2026-10-28 (nach dem Lasttest).** Gemessen mit `tests/perf/space-cost.ts`: die CPU-Zeit des Space-Prozesses je
Spielerbefehl (50 Figuren aus `live-load.ts`, 45 s, SQLite, alle NPCs, Entwicklungsrechner). Sie sagt, wie viele Befehle
ein Kern trägt; die Antwortzeit auf einem schnellen, nicht gesättigten Rechner sagt das nicht.

| Stand | CPU je Befehl | Median |
| --- | --- | --- |
| vorher | 26,2 ms | 31 ms |
| Index nach Typ im Kern | 24,3 ms | 31 ms |
| dazu `batch` im Welt-Worker | 18,7 ms | 21 ms |
| dazu transiente Nachrichten | 16,0 ms | 21 ms |
| dazu weniger Arbeit je Commit | 15,0 ms | 20 ms |

- **Index nach Typ.** Ein Lesen mit Typ (`readAll`, `count`, Seiten) geht über die Entries dieses Typs, nicht über alle;
  der Kern hält die Liste je Typ für einen festgeschriebenen Stand, bis ein Commit ihn ändert.
- **Ein Befehl, zwei Aufrufe.** Der Welt-Worker öffnet die Transaktion und nimmt Token und Befehl in einem `batch`, und
  schickt am Ende alle Schreibvorgänge des Befehls mit dem Commit in einem zweiten (`bufferedTxn` in `server/space.ts`).
  Nur ein `write` mit `unique` (eine Zelle belegen) geht sofort, damit „besetzt“ gleich zurückkommt.
  `SPACES_MMO_BATCH=0` schaltet es ab.
- **Lesen aus dem Spiegel.** Der Befehls-Worker hält eine Kopie der Welt (`Mirror` in `server/space.ts`, aus dem
  Änderungsstrom wie der Web-Prozess) und beantwortet die Lesezugriffe eines Befehls ohne Transaktion selbst, auf seinem
  eigenen Kern; je Befehl fragt er den Space nur nach der Revision. Mit 200 Figuren lokal: 1.043 statt 1.818 Aufrufe je
  Sekunde, Median 125 statt 445 ms ([lasttest-2026-10-28.md](lasttest-2026-10-28.md), dritter Lauf).
  `SPACES_MMO_MIRROR=0` schaltet ihn ab.
- **Nachrichten ohne Entry.** Was nur auf Bildschirmen erscheint, geht als transientes Schreiben in den Änderungsstrom
  und wird nie gespeichert (`msgOptions` in `engine/context.ts`). Entries bleiben, was jemand später liest: Gesprochenes
  im Raum (die NPC-Skripte hören zu), Kanäle, alles an eine NPC. Ein neu gestarteter Web-Prozess hat dafür keinen
  Rückblick auf andere Nachrichten. `SPACES_MMO_MSG_TRANSIENT=0` behält jede.
- **Weniger Arbeit je Commit.** Eine Antwort wird einmal in JSON gewandelt (vorher zweimal), die Größe aller Entries
  einmal je festgeschriebenem Stand gezählt (vorher bei jedem Schreiben), das Ende einer Transaktion geht über eine Kopie
  der Liste statt über den Entwurf. Wartende Commits schrieb der Store schon vorher gebündelt.

**Die Datei klein halten.** Der Space-Prozess gibt die freien Seiten seiner Dateien zurück (`OwnStoreHost.compact`):
einmal beim Start, bevor er bedient (beim ersten Mal schreibt ein `VACUUM` die Datei einmal neu und stellt sie auf
inkrementelles Auto-Vacuum um, bei 350 MB einige Sekunden), danach alle `SPACES_MMO_COMPACT_MS` (10 Minuten, 0 aus)
zwischen zwei Schreib-Batches. Commits in dieser Zeit warten kurz. Das Log sagt, wie viele Seiten zurückgingen.

**Gegen Fluten:** Das Gateway begrenzt je Konto (über alle offenen Seiten zusammen) Schritte auf 8 auf einmal und 10 je
Sekunde und getippte Befehle auf `SPACES_MMO_CMD_BURST` (20) auf einmal und `SPACES_MMO_CMD_PER_SEC` (5) je Sekunde; ein
Konto hat höchstens vier Seiten offen, eine fünfte schließt die älteste.

**Diagnose:** `SPACES_MMO_TRACE=1` (Aufrufe je Prozess und Methode alle 10 s), `SPACES_MMO_SLOW_MS=200` (der Welt-Worker
meldet jeden Befehl, der später als das nach dem Tippen beantwortet wurde, mit seiner eigenen Laufzeit).

Die NPC-Skripte schauen in eigenem Takt: Händler und Arbeiter alle 8 s, ein Wanderer in Abwesenheit alle 10 s, Ines und wache
Wanderer alle 3 s. Im Dev-Container lassen sich NPCs auswählen: `SPACES_MMO_DEV_NPCS=ines,bo npm --prefix spaces-mmo run
docker:dev:up`.

## Regionen

Die Welt läuft auf Wunsch als vier Spaces, je Region einer ([welt-aufteilen.md](welt-aufteilen.md)): Compose-Profil
`regions`. Je Region ein Space-Prozess (`world-<region>.sqlite` im Volume `mmo-space-data`, Port auf dem Loopback: West
3950, Nord 3952, Ost 3953, Süd 3954), ein Welt-Worker, ein NPC- und ein Modell-Prozess; dazu der Web-Prozess im
Host-Netz. Der Konten-Space bleibt, wo er ist (nano, über den Tunnel auf 3951).

`.env` auf big dafür:

```sh
SPACES_MMO_WEB_REGIONS=west=tcp:127.0.0.1:3950,nord=tcp:127.0.0.1:3952,ost=tcp:127.0.0.1:3953,sued=tcp:127.0.0.1:3954
```

Umzug einer Welt, die als ein Space lief (einmal; die alte Datei bleibt):

```sh
npm --prefix spaces-mmo run docker:single:down                     # die alte Welt anhalten
cp …/world.sqlite …/world.sqlite.before-regions                     # Sicherung im Volume
docker compose … --profile regions up -d space-west space-nord space-ost space-sued
# das Volume mit world.sqlite einhängen: ohne verweigert das Skript (die Datei fehlt), statt nichts zu verschieben
docker compose … --profile regions run --rm --no-deps -v mmo-space-data:/data -e SPACES_MMO_DATA=/data \
  -e SPACES_MMO_REGIONS=west=tcp:space-west:3950,nord=tcp:space-nord:3950,ost=tcp:space-ost:3950,sued=tcp:space-sued:3950 \
  world-west node --experimental-strip-types server/migrate-regions.ts
npm --prefix spaces-mmo run docker:regions:up                      # Welt-Worker, NPCs, Modelle, Web
```

Das Skript nennt vorher, was die alte Welt hält, und danach je Region, was es geschrieben hat. Danach über alle vier
Regionen zusammen nachzählen: Figuren und Münzen wie vorher plus die der NPCs, die die neue Weltversion dazubringt;
eine andere Zahl heißt, dass etwas fehlt oder doppelt ist.

Zurück zu einem Space: `docker:regions:down`, dann `docker:single:up` (es liest wieder `world.sqlite`, den Stand vor dem
Umzug).

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

Ergebnis eines Laufs mit 100 Figuren: [lasttest-2026-10-28.md](lasttest-2026-10-28.md). Die Kosten je Befehl ohne
Server: `LOAD_BOTS=50 LOAD_SECONDS=60 node --no-warnings --experimental-strip-types --import ./tests/test-env.ts
tests/perf/space-cost.ts` (ein Stack wie auf den Servern, eine JSON-Zeile mit CPU-ms des Space-Prozesses je Befehl).

## Nicht enthalten

- Kein Backup-Skript wie `docker:backup` im Chat; der Speicher liegt im Volume, die Sicherung des Verzeichnisses
  übernimmt der Betreiber, bis ein Sicherungsbefehl vorgesehen ist.
