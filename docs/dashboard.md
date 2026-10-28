# Dashboard: schreibgeschützte Live-Ansicht für Spaces

Stand: 2026-10-07. **Phase 1, implementiert.** Umsetzung des [UI-Plans](ui-mockups/UI-PLAN-SUMMARY.md) mit den
getroffenen Entscheidungen: ohne Framework und ohne neue Abhängigkeiten, nur lesend, als eigenständiges
Startmodul `src/dashboard.ts`, und nur mit Daten, die es wirklich gibt (Agent-/Mobile-Panels bleiben bis zur
Datenquelle bewusst leer). Das Design folgt den [Mockups](ui-mockups/ui-dashboard.md) (3-Panel-Layout,
Farbschema, Live-Indikatoren).

## Start

Im Vordergrund (eigenes Terminal, endet mit Strg+C):

```bash
npm run dashboard -- --dir /pfad/zum/store              # Verzeichnis mit store.sqlite (wird angelegt)
npm run dashboard -- --sqlite /pfad/store.sqlite        # Speicherdatei
```

Im Hintergrund mit dem Lifecycle-Skript ([scripts/dashboard.sh](../scripts/dashboard.sh)):

```bash
npm run dashboard:start          # startet im Hintergrund und wartet auf Bereitschaft
npm run dashboard:status         # läuft? welche Spaces?
npm run dashboard:stop           # sauberer Stopp per SIGTERM
bash scripts/dashboard.sh logs   # Log live verfolgen
```

Das Dashboard öffnet den eigenen SQLite-Speicher und hält dessen Besitzersperre, denn es bedient auch den
Space-Socket. Alte JSONL- oder pi-durable-Bestände im Verzeichnis liest es nicht (Entscheidung D6).

Das Skript konfiguriert sich über Umgebungsvariablen: `DASHBOARD_DIR` (Verzeichnis mit `store.sqlite`, Standard
`~/.local/share/phi-spaces/dashboard-store`), `DASHBOARD_SQLITE` (Speicherdatei stattdessen), `DASHBOARD_PORT`
(Standard 8787), `DASHBOARD_BIND` (Standard 127.0.0.1). Weitere Flags nach dem Kommando werden an
`src/dashboard.ts` durchgereicht, z.B. `bash scripts/dashboard.sh start --no-socket`. PID- und Log-Datei
liegen unter `$XDG_RUNTIME_DIR/phi-spaces-dashboard-<uid>/` (Fallback `/tmp`); ein zweiter `start` meldet
den laufenden Prozess, statt einen zweiten zu öffnen.

Optionen des Daemons (gelten für beide Startarten): `--port` (Standard 8787), `--bind` (Standard 127.0.0.1 —
absichtlich nur Loopback), `--socket <pfad>` (Standard `<store>/space.sock`, mit `--no-socket` abstellbar),
`--app id=adresse` (wiederholbar, ersetzt die Standard-Apps), `--no-apps`, `--help`.

Aufruf im Browser: **http://127.0.0.1:8787** (bzw. der gewählte Port).

## Apps: die Spaces der Projekte

Die Projekte auf phi-spaces betreiben ihre Spaces in eigenen Prozessen, die jeweils die Besitzersperre ihres Stores
halten. Das Dashboard öffnet diese Stores deshalb nicht, sondern verbindet sich als Client mit ihrem Socket
(`connectSpace`) und benutzt nur Aufrufe, die nichts hinterlassen: `stats` (alle 2 s je App) und `readAll`-Seiten für die
Entry-Liste — kein `read`/`take`, also keine Request-Claims und keine Sperren. Die Entry-Liste liest jeweils die ersten
`after + limit + 1` Entries in einem Aufruf und schneidet im Dashboard (Obergrenze 2000), damit im Space der App kein
Seiten-Snapshot liegen bleibt.

| App | Standardadresse |
|---|---|
| Codemode Chat | `unix:/tmp/codemode-space.sock` |
| spaces-mmo · Welt | `unix:/tmp/spaces-mmo-world.sock` |
| Help · Swarm-Shard | `unix:/tmp/swarm-b.sock` |

Bewusst nicht dabei: der Accounts-Space von spaces-mmo (Zugangsdaten, Sitzungen). Der eigene Space der Hilfeseite liegt im
Web-Prozess ohne Socket; sichtbar ist von ihr nur der Swarm-Shard (`nano-host.ts`). Läuft eine App nicht, erscheint sie
als „offline" mit ihrer Adresse. Andere Adressen: `--app chat=tcp:nano:3800 --app welt=unix:/pfad.sock`.

Der Daemon öffnet den Store **exklusiv**: kein zweiter Prozess darf denselben Store halten
(single-owner, siehe [Umstellungsplan](umstellung-ohne-pi-durable.md) 5.2). Ohne `--no-socket` serviert er
zusätzlich den Space-Dienst auf einem Unix-Socket — das ist der einzige Weg, wie in Phase 1 Live-Traffic
entsteht: Beispiele oder Clients verbinden sich über `socketTransport({ path: ".../space.sock" })` und der
Dashboard-Prozess zählt und zeigt deren Operationen. Wer die Socket-Datei öffnen darf (gleicher
Betriebsbenutzer, Dateirechte 0600), ist dort lokaler Admin — Identität kommt aus der vertrauenswürdigen
lokalen Grenze, nie aus gesendeten Bytes; dieselbe Regel wie in [socket.ts](../src/socket.ts). Der Dashboard
hat selbst **keinen schreibenden Endpunkt**.

## Oberfläche

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
| `GET /api/spaces/{id}/entries?after&limit` | Entries neueste zuerst, Cursor `next` (max 100/Seite, 500 Ceiling) |
| `GET /api/metrics` | `Meter.snapshot(10)`, Uptime, Socket-Verbindungen |
| `GET /api/apps` | die App-Quellen: online, Fehler, Alias, `stats`, Verlauf der Entry-Zahl |
| `GET /api/apps/{id}/entries?after&limit&type` | Entries einer App, älteste zuerst; `after`/`next` sind Positionen (max 200/Seite, bis 2000) |
| `GET /palettes.js` | die geteilten Paletten ohne Typen |
| `GET /api/live` | Server-Sent Events |

**SSE-Vertrag.** Nach dem Verbinden sendet der Server sofort `hello` (vollständiger Space-Zustand), danach
bei jeder Commits `space` (Gauges des betroffenen Spaces, gebündelt über `flushMs`=200 ms), bei Registry-Änderungen
`spaces`, alle paar Sekunden `metrics` und `apps` (nur die Apps, deren Stand sich seit der letzten Abfrage geändert hat;
`hello` enthält alle). `EventSource` verbindet nach einem Abriss selbst neu; nach dem
Reconnect liefert `hello` wieder den vollen Stand — es gibt kein Event-Replay und dadurch keine verlorene
Aktualisierung. Watches (`watchDoc`) wecken den Server, die Korrektheit hängt nicht von einem Signal ab
(siehe Umstellungsplan 4.2): ein Neustart rekonstruiert alles aus Snapshots.

## Grenzen von Phase 1

- Nur lesend; es gibt absichtlich keinen Schreib-, Steuer- oder Agent-Endpunkt.
- Das `Meter` ist **prozesslokal** ([meter.ts](../src/meter.ts)): gezählt wird der Verkehr dieses Prozesses
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
und eine fehlende App als „offline". Einzel: `node --experimental-strip-types --test test/test-dashboard.test.ts`.

## Nächste Phasen (Vorschlag)

1. Heartbeat-Entry-Typ für Agents/Termux (Datenquelle für die rechten Panels).
2. Schreibaktionen über die bestehende Rollen-/Policy-Infrastruktur der `SpaceService` (falls gewünscht).
3. Anbindung an den geplanten eigenständigen Dienst (`src/daemon.ts`, U3) statt eigenem Store-Öffner;
   die Dashboard-Grenze (`SpaceHost`, `Meter`) bleibt davon unberührt.
