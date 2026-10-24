# Architektur

## Prozesse

Wie in codemode-chat ist jede Rolle ein eigener Prozess rund um einen Space (vgl. `codemode-chat/server/launch.ts`,
`space-host.ts`):

| Prozess | Aufgabe | Vorlage |
| --- | --- | --- |
| `space` | Hält den Space (eigener SQLite-Store `openSqliteHost`, im Test `openOwnMemoryHost`), bedient ihn über `serveSpace` (Unix-Socket/TCP) | `codemode-chat/server/space-host.ts`, `src/standalone.ts` |
| `world` | Nimmt `Intent`s, führt Befehle aus, Welt-Ticks (Flut, Feuer, Nebel), Spawner | `codemode-chat/server/judge-host.ts` (take unter Transaktion) |
| `npc` | Skript-NPCs, später Modell-NPCs und Automaten; schreiben nur `Intent`s | `codemode-chat/server/agent-host.ts`, `model-host.ts` |
| `web` | Next.js-App, HTTP-API, WebSocket-Gateway, Sessions, Kontingente | `codemode-chat/server/index.ts`, `hub.ts`, `ws.ts`, `quota.ts` |

Alle außer `space` sprechen über `RemoteSpace` + `socketTransport` mit dem Space. `world` und `npc` lassen sich
mehrfach starten. Der Browser lädt keinen Space-Code; `src/` bleibt reiner Server-Code.

```
Browser ──WebSocket──▶ web ──RemoteSpace──▶ space ◀──RemoteSpace── world (1..n)
                                              ▲
                                              └────RemoteSpace──── npc (0..n)
```

## Datenfluss zum Browser

- **Rein:** Der Browser schickt nur Befehle (`{t:"cmd", line}`), Bewegungsklicks werden im Client zu Textbefehlen.
  Das Gateway schreibt daraus `Intent`-Entries und erzwingt Kontingente pro Session und IP (Muster `quota.ts`,
  `CODEMODE_REQ_PER_MIN`).
- **Raus:** `changes(afterRev)` liefert einen globalen Strom aller Commits. Das Gateway liest ihn einmal und filtert pro
  Session nach Interessensbereich (aktueller Raum, Inventar, abonnierte Kanäle). Ein neu verbundener Client bekommt
  zuerst einen Snapshot des Raums (`readAll({fields:{location}})`), danach nur Deltas.
- **Rahmengröße:** `ws.ts` begrenzt Frames auf 1 MiB; das Gateway schickt Räume klein (Kachelkarte komprimiert,
  Beschreibungen nachladbar), wie `hub.ts` bei Code-Snapshots.
- Läuft der `changes`-Cursor hinter die Aufbewahrung, startet das Gateway mit Snapshot neu (wie der Feed-Hub der
  help-site, Commit b85073d).

## Takt

- Bewegung auf einem Raster, ein Schritt pro Befehl, serverseitig geprüft. Der Client interpoliert die Animation
  zwischen zwei Positionen; er sagt nichts voraus, was der Server verwerfen könnte, außer einer optimistischen
  Anzeige der eigenen Figur.
- Welt-Ticks um 1 Hz für Zustand mit sichtbarer Zeit (Nebel, Flut), alles Langsamere über Leases und OnDemand-Rechnung.
- Ziel für Phase 3: Befehl bis Anzeige < 150 ms im LAN, < 400 ms über das Netz.

## Skalierung

- **Phase 0–5:** ein Space für die ganze Welt. Für einige hundert gleichzeitige Spieler reicht ein Space mit einem
  Gateway, das den Strom filtert.
- **Später:** Zonen als benannte Spaces (`src/spaces.ts`, Registry). Ein Wechsel zwischen Zonen ist keine
  gemeinsame Transaktion mehr, weil Transaktionen nur innerhalb eines Spaces gelten. Lösung: zweistufige Übergabe mit
  einem `Travel`-Entry (in Zone A nehmen, in Zone B schreiben, Quittung zurück), idempotent über eine Reise-ID.
- Föderation und Replikation (`src/runtime.ts`, `primary-sync.ts`) stehen bereit, sind aber für das Spiel nicht
  vor Phase 7 nötig.

## Rechte

- Gateway, Welt und NPC melden sich mit eigenen Rollen beim Space an. `Policy` (`src/service.ts`): `world` darf
  alle Typen, `npc` und `web` dürfen nur `Intent`, `Session`, `ChannelMsg` schreiben und lesen alles Öffentliche.
- Spieler haben keinen direkten Zugang zum Space; ihre Identität kennt nur das Gateway (Gast-Token oder Login wie
  bei der help-site).
- Builder- und Admin-Rechte sind Weltrecht (`perms` am Account, Locks), keine Space-Rollen.

## Grafik

Ziel: Hybrid-Oberfläche. Links Kachelkarte des Raums, rechts oder unten Textlog und Befehlszeile. Ohne Grafik (Screen
Reader, schwaches Gerät, Agent) bleibt das Spiel voll spielbar.

**Modell:** Ein Raum hat ein kleines Raster (z. B. 24×16 Kacheln, `grid`-Feld: Bodenlayer als Zeichenkette,
Kachel-IDs aus einem Tileset). Objekte im Raum haben `x`, `y`. Ausgänge liegen am Rand oder auf Türkacheln.
Weltkarte = Graph der Räume, kein endloses Gebiet.

**Renderer, Optionen:**

| Option | Neue Abhängigkeit? | Passt, weil | Bedenken |
| --- | --- | --- | --- |
| Eigener Canvas-2D-Renderer | Nein | Rasterkarte + Sprites aus einem Atlas sind ~300 Zeilen; React steuert nur den Rahmen | Kein Partikel-/Shader-Kram |
| ASCII/Glyphen im DOM | Nein | Sofort fertig, MUD-Gefühl, barrierearm | Wenig „Grafik“ |
| rot.js | Ja (klein, ohne weitere Abhängigkeiten) | Roguelike-Display (Glyphen *und* Kacheln), Sichtfeld, Wegfindung, Karten-Generatoren | Wegfindung/Sichtfeld gehören eigentlich auf den Server, dort auch nutzbar |
| PixiJS | Ja | Schnelle WebGL-Sprites, Animation, Zoom | Nur Renderer, mehr Gewicht |
| Phaser / Kaplay | Ja | Ganze Spiel-Engines | Bringen eigene Spielschleife und Physik mit; bei uns ist der Server die Wahrheit, das meiste davon bliebe ungenutzt |

**Empfehlung:** Phase 3 mit eigenem Canvas-Renderer (keine Abhängigkeit). Wird mehr gebraucht, ist rot.js die erste
Wahl, weil es auch serverseitig (Sichtfeld im Nebel, Wegfindung für NPCs, Inselgenerierung) nützt. Grafiken: ein
freies Tileset (z. B. Kenney, CC0) als Datei im Repo, kein Paket. Beides erst nach Rückfrage.

## Verzeichnisaufbau (geplant)

```
smmorpg/
  package.json          eigenes Paket wie codemode-chat (next, react, react-dom)
  tsconfig.json         eigene; nicht Teil des Root-`tsc`
  server/
    launch.ts           startet space, world, npc, web (Entwicklung)
    space-host.ts       Space-Prozess
    world-host.ts       Befehle, Ticks, Spawner
    npc-host.ts         Skript-NPCs (später Agenten)
    index.ts            Web-Prozess + Gateway
    world/              typeclasses/, commands/, cmdsets.ts, locks.ts, prototypes.ts, funcparser.ts
  client/               React-Oberfläche, Renderer, Textlog
  app/                  Next.js-Routen
  world/                Weltdateien (Räume, Prototypen, Hilfe) zum Laden
  tests/                node:test, starten die Prozesse wie test:codemode-chat
  docs/                 dieses Verzeichnis
```

Gemeinsames mit codemode-chat (`ws.ts`, `space.ts`-Helfer wie `keepAlive`, `takeExisting`) wird zunächst
kopiert. Beim zweiten Verbraucher lohnt ein gemeinsamer Ort, etwa `src/web/`. Das wäre eine Änderung am Root und wird
eigens entschieden.

## Einbindung von phi-spaces

Siehe [README.md](README.md#kurzantworten-auf-die-ausgangsfragen). Kurz: relative Importe auf `../../src/index.ts`
(wie codemode-chat); `npm run check:durable` gilt auch hier, also kein pi-durable, chord oder pi-ai im Spiel. Modell-NPCs
gehen über das `agent/`-Paket als eigener Prozess.
