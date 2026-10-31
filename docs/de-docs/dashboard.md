# Dashboard: schreibgeschützte Live-Ansicht für Spaces

Stand: 2026-10-28. **Phase 1, implementiert.** Umsetzung des [UI-Plans](../_attic/ui-mockups/UI-PLAN-SUMMARY.en.md) mit den
getroffenen Entscheidungen: ohne Framework und ohne neue Abhängigkeiten, nur lesend, als eigenständiges
Startmodul `src/dashboard.ts`, und nur mit Daten, die es wirklich gibt (Agent-/Mobile-Panels bleiben bis zur
Datenquelle bewusst leer). Das Design folgt den [Mockups](../_attic/ui-mockups/ui-dashboard.en.md) (3-Panel-Layout,
Farbschema, Live-Indikatoren).

## Start

Im Vordergrund (eigenes Terminal, endet mit Strg+C):

```bash
npm run dashboard -- --dir /pfad/zum/store              # Verzeichnis mit store.sqlite (wird angelegt)
npm run dashboard -- --sqlite /pfad/store.sqlite        # Speicherdatei
```

Im Hintergrund mit dem Lifecycle-Skript ([scripts/dashboard.sh](../../scripts/dashboard.sh)):

```bash
npm run dashboard:start          # startet im Hintergrund und wartet auf Bereitschaft
npm run dashboard:status         # läuft? welche Spaces?
npm run dashboard:stop           # sauberer Stopp per SIGTERM
bash scripts/dashboard.sh logs   # Log live verfolgen
```

Das Dashboard öffnet den eigenen SQLite-Speicher und hält dessen Besitzersperre, denn es bedient auch den
Space-Socket. Alte JSONL- oder pi-durable-Bestände im Verzeichnis liest es nicht (Entscheidung D6).

Das Skript konfiguriert sich über Umgebungsvariablen oder die `DASHBOARD_*`-Zeilen der `.env` im Repository-Wurzelverzeichnis
(gesetzte Variablen haben Vorrang; `src/dashboard.ts` liest dieselbe `.env` auch im Vordergrund): `DASHBOARD_APPS`
(App-Quellen, siehe unten), `DASHBOARD_DIR` (Verzeichnis mit `store.sqlite`, Standard
`~/.local/share/phi-spaces/dashboard-store`), `DASHBOARD_SQLITE` (Speicherdatei stattdessen), `DASHBOARD_PORT`
(Standard 8787), `DASHBOARD_BIND` (Standard 127.0.0.1). Weitere Flags nach dem Kommando werden an
`src/dashboard.ts` durchgereicht, z.B. `bash scripts/dashboard.sh start --no-socket`. PID- und Log-Datei
liegen unter `$XDG_RUNTIME_DIR/phi-spaces-dashboard-<uid>/` (Fallback `/tmp`); ein zweiter `start` meldet
den laufenden Prozess, statt einen zweiten zu öffnen.

Optionen des Daemons (gelten für beide Startarten): `--port` (Standard 8787), `--bind` (Standard 127.0.0.1 —
absichtlich nur Loopback), `--socket <pfad>` (Standard `<store>/space.sock`, mit `--no-socket` abstellbar),
`--app id=adresse` (wiederholbar, ersetzt die Standard-Apps), `--no-apps`, `--help`.

Aufruf im Browser: **http://127.0.0.1:8787** (bzw. der gewählte Port).

### Dauerhaft als Dienst (übersteht Neustarts)

`dashboard.sh start` startet den Prozess mit `nohup`: Er läuft weiter, wenn das Terminal geht, aber nach einem Neustart
des Rechners nicht wieder an. Wer das Dashboard dauerhaft betreiben will (so auf big hinter `spaces-stats.eibrain.org`),
legt eine systemd-User-Unit an, nach demselben Muster wie die Tunnel `codemode-nano-tunnel.service` und
`mmo-accounts-tunnel.service`. Voraussetzung: Linger für den Benutzer (`loginctl show-user $USER -p Linger` zeigt `yes`;
sonst einmal `sudo loginctl enable-linger $USER`), damit User-Units ohne Anmeldung starten.

```bash
cat > ~/.config/systemd/user/phi-spaces-dashboard.service <<'EOF'
[Unit]
Description=phi-spaces read-only dashboard (127.0.0.1:8787; settings: DASHBOARD_* in the checkout's .env)
After=network-online.target codemode-nano-tunnel.service mmo-accounts-tunnel.service swarm-nano-tunnel.service

[Service]
WorkingDirectory=/media/docker/spaces
ExecStart=/usr/local/bin/node --no-warnings --experimental-strip-types src/dashboard.ts
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
bash scripts/dashboard.sh stop          # ein per Skript gestarteter Prozess hält sonst Port und Store
systemctl --user daemon-reload
systemctl --user enable --now phi-spaces-dashboard.service
```

`WorkingDirectory` ist der Checkout (auf big `/media/docker/spaces`), `ExecStart` der Pfad von `command -v node`. Die
Unit startet `src/dashboard.ts` direkt im Vordergrund; die Einstellungen liest es selbst aus den `DASHBOARD_*`-Zeilen der
`.env` im Checkout (Store, Port, App-Adressen). Danach:

- Neustart nach `git pull` oder einer Änderung der `.env`: `systemctl --user restart phi-spaces-dashboard`
- Zustand und Log: `systemctl --user status phi-spaces-dashboard`, `journalctl --user -u phi-spaces-dashboard -f`
- Abschalten: `systemctl --user disable --now phi-spaces-dashboard`

Mit der Unit nicht zusätzlich `npm run dashboard:start` benutzen: Zwei Prozesse wollen denselben Port und dieselbe
Besitzersperre des Stores, der zweite bricht ab.

## Apps: die Spaces der Projekte

Die Projekte auf phi-spaces betreiben ihre Spaces in eigenen Prozessen, die jeweils die Besitzersperre ihres Stores
halten. Das Dashboard öffnet diese Stores deshalb nicht, sondern verbindet sich als Client mit ihrem Socket
(`connectSpace`) und benutzt nur Aufrufe, die nichts hinterlassen: `stats` (alle 2 s je App) und `readAll`-Seiten für die
Entry-Liste — kein `read`/`take`, also keine Request-Claims und keine Sperren. Die Entry-Liste liest jeweils die ersten
`after + limit + 1` Entries in einem Aufruf und schneidet im Dashboard (Obergrenze 2000), damit im Space der App kein
Seiten-Snapshot liegen bleibt.

Jede App hat mehrere Standardadressen, versucht in dieser Reihenfolge (die zuletzt erfolgreiche zuerst): der Unix-Socket
eines normalen Starts (`npm start`, `dev`), der Loopback-Port, den `docker:local:up` veröffentlicht, und auf big die
Adresse der Produktion: das lokale Ende des SSH-Tunnels nach nano oder der Loopback-Port eines Space, der auf big läuft.

| App | normaler Start | `docker:local:up` | big |
|---|---|---|---|
| Codemode Chat | `unix:/tmp/codemode-space.sock` | `tcp:127.0.0.1:3810` | `tcp:127.0.0.1:3800` (Tunnel nach nano) |
| spaces-mmo · Welt | `unix:/tmp/spaces-mmo-world.sock` | `tcp:127.0.0.1:3960` | `tcp:127.0.0.1:3950` (Region West auf big, kein Tunnel) |
| Help · Swarm-Shard | `unix:/tmp/swarm-b.sock` | `tcp:127.0.0.1:3600` | `tcp:127.0.0.1:3600` (Tunnel nach nano) |
| Help · Hub (`@*`) | `unix:/tmp/help-space.sock` | – | `tcp:127.0.0.1:3520` (der Hub selbst, kein Tunnel) |

**Öffentlich auf big:** nginx leitet `https://spaces-stats.eibrain.org` (IPv6 `2a0a:4cc0:c0:62f2:8000::1002`, IPv4
gemeinsam) an `127.0.0.1:8787` weiter, mit Let's-Encrypt-Zertifikat (Webroot `/var/www/acme`, wie spaces-mmo), ohne
Login (seit 2026-10-28; das Dashboard hat nur GET-Endpunkte, der Hub der Hilfeseite liefert nur Kennzahlen, der
Konten-Store von spaces-mmo fehlt). Die Entries von Codemode-Chat, spaces-mmo-Welt und Swarm-Shard sind damit
öffentlich lesbar, auch Kontonamen und Nachrichten an einzelne Figuren. `/api/live` ohne Pufferung. Site:
`/etc/nginx/sites-available/spaces-stats.eibrain.org`; die Hilfeseite verlinkt die Seite mit einer Einführung.

Bewusst nicht dabei: der Accounts-Space von spaces-mmo (Zugangsdaten, Sitzungen). Der Store der Hilfeseite liegt im
Web-Prozess; mit `HELP_SPACE_LISTEN` (in der Produktion `tcp:127.0.0.1:3520`, Loopback, nie hinter nginx) serviert er
nur Kennzahlen: seine Rolle darf `hello`, `stats` und `spaces`, kein `readAll`. Er hält den Space `control`
(`PeerKey`, `Enroll`) und die Nachrichten der Chat-Sessions, deshalb zeigt das Dashboard dort keine Entries
(„Einträge nicht freigegeben“), wohl aber jeden Space mit Anzahl je Typ und Speicher. Läuft eine App nicht, erscheint sie
als „offline" mit ihrer Adresse. Andere Adressen: `--app chat=tcp:nano:3800 --app welt=unix:/pfad.sock`, oder in der `.env`
`DASHBOARD_APPS=spaces-mmo=tcp:127.0.0.1:3960|unix:/tmp/spaces-mmo-world.sock,codemode-chat=tcp:127.0.0.1:3810`
(Einträge durch Komma, Alternativen durch `|`; `--app` ersetzt `DASHBOARD_APPS`, beide ersetzen die Standard-Apps; eine
Standard-ID behält ihren Namen und ihren Space).

**Benannte Spaces.** Ohne Angabe fragt das Dashboard den Default-Space des Dienstes ab. Liegen die Daten in einem
benannten Space, kommt er mit `@` an die ID: `id@space=adresse`. Der Swarm-Shard der Hilfeseite hält seine Posts im Space
`social-swarm` (`SWARM_ALIAS`, angelegt in `help-site/server/nano-host.ts`), sein Default-Space bleibt leer; die
Standard-App `help-swarm` fragt deshalb `social-swarm` ab, auch wenn sie in `DASHBOARD_APPS` ohne `@` steht.

**Alle Spaces eines Dienstes.** `id@*=adresse` fragt die Liste des Dienstes ab (Methode `spaces`, [API](../api.en.md)) und
liest die Kennzahlen jedes Spaces (die 100 neuesten), summiert für die App und einzeln in der Tabelle „Spaces“.
Aliase `präfix-<id>` fasst es ab drei gleichen Präfixen zu einer Zeile zusammen (`chat-session-*` mit ihrer Anzahl).
Weil das je Space einen Aufruf kostet, liest es eine solche App nur jede fünfte Runde (bei 2 s also alle 10 s). Die
Standard-App `help-hub` ist so eine App. Welche Daten in welchem Store und Space liegen: [Datenhaltung](../datenhaltung.en.md).

Der Daemon öffnet den Store **exklusiv**: kein zweiter Prozess darf denselben Store halten
(single-owner, siehe [Umstellungsplan](../umstellung-ohne-pi-durable.en.md) 5.2). Ohne `--no-socket` serviert er
zusätzlich den Space-Dienst auf einem Unix-Socket — das ist der einzige Weg, wie in Phase 1 Live-Traffic
entsteht: Beispiele oder Clients verbinden sich über `socketTransport({ path: ".../space.sock" })` und der
Dashboard-Prozess zählt und zeigt deren Operationen. Wer die Socket-Datei öffnen darf (gleicher
Betriebsbenutzer, Dateirechte 0600), ist dort lokaler Admin — Identität kommt aus der vertrauenswürdigen
lokalen Grenze, nie aus gesendeten Bytes; dieselbe Regel wie in [socket.ts](../../src/socket.ts). Der Dashboard
hat selbst **keinen schreibenden Endpunkt**.

## Oberfläche

**Live je App.** Jede Messung (alle 2 s, eine App mit `@*` alle 10 s) wird ein Punkt; das Dashboard hält die letzten 450
(15 Minuten) und zeigt sie in der Detailansicht der App als sechs Kurven: die Antwortzeit des Space (Dauer des
`stats`-Aufrufs), CPU und Arbeitsspeicher des Space-Prozesses, Speicher im Space (gesamt, Claims), Entries und davon
Nachrichten (`Msg`), Commits je Minute. CPU und Speicher meldet der Space-Dienst selbst mit jeder `stats`-Antwort
(`process: { cpuMs, rssBytes, heapBytes, at }`, [API](../api.en.md)); ein Space-Prozess einer älteren phi-spaces-Version meldet
sie nicht, dann sagt die Karte das. Die Kurven kommen einmal mit der App-Liste (`/api/apps`, `hello`), danach mit jeder
Messung nur der neue Punkt (`point` im SSE-Ereignis `apps`).

**Kurve vergrößern, 7 Tage Verlauf.** Ein Klick auf eine der sechs Kurven (oder Enter) öffnet sie groß in einem Dialog,
mit den Zeiträumen 15 min · 1 h · 6 h · 24 h · 7 Tage; Esc, ✕ oder ein Klick daneben schließt ihn. 15 min sind die
Live-Punkte und laufen mit. Für die längeren Zeiträume fasst das Dashboard die Messungen jeder App zu einem Mittel je
Minute zusammen (`src/dashboard-history.ts`) und behält davon 7 Tage; der Dialog holt sie von
`/api/apps/{id}/history?range=<ms>` und frischt jede Minute auf. Die Antwort hat höchstens 720 Punkte: Bei 24 h und
7 Tagen werden benachbarte Minuten gemittelt, die jüngsten 15 Minuten sind die einzelnen Messungen. Eine Pause (das
Dashboard lief nicht, die App war offline) unterbricht die Kurve, statt sie zu überbrücken. Der Standardstart schreibt
die Minuten nach `<store>/history.jsonl` (eine JSON-Zeile je Minute und App, auf big im `DASHBOARD_DIR`): Ein Neustart
verliert höchstens die laufende Minute; beim Öffnen und alle 6 Stunden wird die Datei ohne die abgelaufenen Zeilen neu
geschrieben (etwa 10.000 Zeilen je App, wenige MB). `startDashboard` ohne `historyFile` (die Tests) hält sie nur im
Speicher.


Links die Apps (Status-Punkt online/beschäftigt/offline, Entries, Typen, Speicher, Verlauf als Sparkline) und darunter
die Spaces des eigenen Stores. In der Mitte die Detailansicht der Auswahl: Kennzahlen (Entries, Typen, Txn, Wartend,
Outbox, Speicher), der Verlauf der Entry-Zahl, Balken „Entries nach Typ" (die größten 12, der Rest zusammengefasst; ein
Klick filtert die Entry-Liste), ein gestapelter Balken „Stand der Entries" (sichtbar/gesperrt/uncommitted/abgelaufen, mit
Legende) und Balken „Speicher nach Teil" (`stats.bytes`). Darunter die Entries (bei Apps älteste zuerst, seitenweise; im
eigenen Store neueste zuerst, dazu Transaktionen und Waiter); lange Felder klappen auf. Rechts „Apps im Vergleich"
(Entries und Speicher je App), die Prozessmetriken mit Sparklines (writes/reads/takes aus dem `Meter`) und der
Platzhalter „Agents & Mobiles": der Space-Kern kennt keine Agent-Ressourcen; sobald Geräte Heartbeats in einen Space
schreiben (künftige Phase, vgl. `CapabilityReport` in `capability-directory.ts`), können dort echte Daten erscheinen.

**Theme.** Dieselben 14 Paletten und dieselben Bedienelemente wie Hilfeseite, Codemode-Chat und spaces-mmo: Modus
(☾/☀) und Palette oben rechts, gemerkt im Browser (`dashboard.mode`, `dashboard.palette`; ohne Wahl folgt der Modus
`prefers-color-scheme`). `src/dashboard/palettes.ts` ist eine Kopie von `client/lib/palettes.ts` der Projekte
(`test/test-shared-copies.test.ts` hält sie gleich; `tsconfig.json` lässt sie aus, sie benutzt das DOM); der Server
liefert sie ohne Typen als `/palettes.js`. Die Flächen leiten sich wie in den Projekten per `color-mix` aus den
Palettenfarben ab.

## Schnittstellen

| Route | Inhalt |
|---|---|
| `GET /` | statische UI (`src/dashboard/`, ES-Module, Web Components, kein Build-Schritt) |
| `GET /api/spaces` | alle Spaces mit Gauges (`core.stats`: entries, byType, txns, waiters, outbox, …) |
| `GET /api/spaces/{id-oder-alias}` | Detail: Gauges, aktive Transaktionen, wartende Operationen |
| `GET /api/spaces/{id}/entries?after&limit` | Entries neueste zuerst, Cursor `next` (Standard 100 je Seite, höchstens 500) |
| `GET /api/metrics` | `Meter.snapshot(10)`, Uptime, Socket-Verbindungen |
| `GET /api/apps` | die App-Quellen: Adressen, benutzte Adresse, online, Fehler, Alias, `stats`, Verlauf der Entry-Zahl |
| `GET /api/apps/{id}/history?range` | Verlauf einer App für `range` ms (1 min bis 7 Tage, Standard 15 min): `points` mit denselben Feldern wie die Live-Punkte, höchstens 720 |
| `GET /api/apps/{id}/entries?after&limit&type` | Entries einer App, älteste zuerst; `after`/`next` sind Positionen (max 200/Seite, bis 2000) |
| `GET /palettes.js` | die geteilten Paletten ohne Typen |
| `GET /api/live` | Server-Sent Events |

**SSE-Vertrag.** Nach dem Verbinden sendet der Server sofort `hello` (vollständiger Space-Zustand), danach
bei jeder Commits `space` (Gauges des betroffenen Spaces, gebündelt über `flushMs`=200 ms), bei Registry-Änderungen
`spaces`, alle paar Sekunden `metrics` und nach jeder App-Abfrage `apps` (alle Apps mit Stand, Verlauf und Aktivität;
`hello` enthält sie ebenso). `EventSource` verbindet nach einem Abriss selbst neu; nach dem
Reconnect liefert `hello` wieder den vollen Stand — es gibt kein Event-Replay und dadurch keine verlorene
Aktualisierung. Watches (`watchDoc`) wecken den Server, die Korrektheit hängt nicht von einem Signal ab
(siehe Umstellungsplan 4.2): ein Neustart rekonstruiert alles aus Snapshots.

## Grenzen von Phase 1

- Nur lesend; es gibt absichtlich keinen Schreib-, Steuer- oder Agent-Endpunkt.
- Das `Meter` ist **prozesslokal** ([meter.ts](../../src/meter.ts)): gezählt wird der Verkehr dieses Prozesses
  (Socket-Clients und eigene Läufe), nicht der anderer Hosts oder Stores.
- Entries/Paginierung liest den vollen Snapshot und schneidet serverseitig — bei sehr großen Spaces ist
  das ein bekanntes Budget-Ziel der Store-Arbeitspakete (U2), kein UI-Thema.
- Die Authentifizierung ist die lokale Grenze (Loopback-Bindung + Socket-Dateirechte). Kein TLS, kein JWT —
  für ein entferntes Dashboard gelten die bestehenden Gate-/Overlay-Wege statt einer neuen Auth-Schicht.
- Agent-/Mobile-Daten existieren nicht im Kern; die Panels zeigen das offen an, statt Daten zu erfinden.

## Tests

`test/test-dashboard.test.ts` (läuft mit in `npm test`): HTTP-Projektion (Spaces, Detail, Entries, Metrics,
405/404, Statische UI) und der SSE-Vertrag (`hello`, `space` nach einem Commit, `metrics`-Push) gegen einen
In-Memory-Host, dazu eine App über einen echten Unix-Socket (Stats, Typen, Seiten, Typfilter, eine spätere Änderung)
und eine fehlende App als „offline"; der Verlauf (Mittel je Minute, Datei übersteht einen Neustart, nach 7 Tagen weg,
Ausdünnen und Lücken) und der Endpunkt `/history`. Einzel: `node --experimental-strip-types --test test/test-dashboard.test.ts`.

## Nächste Phasen (Vorschlag)

1. Heartbeat-Entry-Typ für Agents/Termux (Datenquelle für die rechten Panels).
2. Schreibaktionen über die bestehende Rollen-/Policy-Infrastruktur der `SpaceService` (falls gewünscht).
3. Anbindung an den eigenständigen Dienst (`src/standalone.ts`, U3) statt eigenem Store-Öffner;
   die Dashboard-Grenze (`SpaceHost`, `Meter`) bleibt davon unberührt.
