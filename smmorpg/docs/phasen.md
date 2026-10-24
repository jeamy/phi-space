# Umsetzungsplan

Jede Phase endet mit einem spielbaren Stand und automatischen Tests (`node:test`, die Tests starten die Prozesse wie
`test:codemode-chat`). Nach jeder Änderung: Typecheck und Tests von smmorpg, außerdem Root-`npm run typecheck`, falls
`src/` berührt wurde.

## Phase 0 – Gerüst (Text, ein Raum)

- `smmorpg/package.json`, `tsconfig.json`, `server/launch.ts` mit den vier Prozessen; Space im Speicher und auf SQLite.
- Gast-Login, eine `Session` mit Lease, ein Charakter, ein Raum.
- Befehle: `look`, `say`, `who`, `help`.
- Browser: Textlog + Befehlszeile über WebSocket.

**Abnahme:** Zwei Browser sehen gegenseitig `say`. Wird ein Tab geschlossen, verschwindet die Figur nach Ablauf der
Session-Lease aus `who`. Neustart des `world`-Prozesses verliert nichts.

## Phase 1 – Weltkern nach Evennia

- Typklassen-Registry, Objects/Rooms/Exits/Characters, `location`-Modell.
- Commands + Cmdsets mit Merge-Regeln; `go`/Richtungen, `get`, `drop`, `give`, `inventory`, `emote`.
- Tags, Locks (Lock-Strings), Permissions, Prototypen + Spawner, Hilfeeinträge.
- Builder-Befehle (`dig`, `open`, `create`, `spawn`, `set`, `destroy`); Weltdateien laden (`world:load`).
- FuncParser-Grundform (`$you()`, `$conj()`).

**Abnahme:** 20 simulierte Spieler tippen gleichzeitig `get münze` auf eine Münze, genau einer bekommt sie. Ein
`give` überträgt einen Gegenstand nur ganz oder gar nicht, auch wenn `world` mitten in der Transaktion abgeschossen
wird.

## Phase 2 – Zeit: Flut, Feuer, Nebel

- Ticker-Worker, Scripts als Entries, OnDemand-Rechnung.
- Strandgut mit Lease, Leuchtfeuer mit erneuerbarer Lease, Nebelstufen pro Raum.
- Kanäle (`ChannelMsg`), Ruf-Zähler pro Feuer.
- Skript-NPCs: Wärter, Fährmann (nur `Intent`s).

**Abnahme:** Ohne Nachlegen erlischt ein Feuer zur berechneten Zeit, der Nebel steigt und Ausgänge schließen sich.
Nach dem Nachlegen ist es umgekehrt. Ein Fährmann-NPC fährt seine Route über Stunden ohne Leak (Entry-Anzahl bleibt
beschränkt).

## Phase 3 – Grafik

- Raumraster (`grid`), Positionen `x`/`y`, Bewegung per Klick oder Pfeiltaste → `move x y`.
- Eigener Canvas-2D-Renderer mit Tileset, Interpolation, Nebel als Overlay.
- Textlog bleibt; Umschalter „nur Text“.
- Gateway: Raum-Snapshot + Deltas, Interessensbereich pro Session.

**Abnahme:** Latenzziele aus [architektur.md](architektur.md#takt). Frames bleiben unter 64 KiB pro Raum-Snapshot.
Spielbar am Telefon (Touch).

## Phase 4 – Handel und Wirtschaft

- Direkter Tausch (`offer`/`accept`) als eine Transaktion; Marktbrett (Angebote als Entries mit Lease).
- Rezepte/Handwerk über Prototypen; Auftragstafel als Master-Worker.
- Senken gegen Inflation: Brennstoff verbrennt, Werkzeug nutzt sich ab (OnDemand).

**Abnahme:** Fuzz-Test mit vielen gleichzeitigen Tauschen und Abbrüchen; die Summe aller Gegenstände ist danach
gleich der Summe davor plus Spawns minus Verbrauch (Erhaltungsprüfung).

## Phase 5 – Modell-NPCs (kosten Tokens, nur nach Freigabe)

- `npc`-Prozess nutzt das `agent/`-Paket; Agenten spielen über dieselben Befehle wie Menschen.
- Kontingente pro Tag/Minute wie `CODEMODE_LLM_PER_DAY`, `CODEMODE_LLM_PER_MIN`; standardmäßig aus
  (`SMMORPG_LLM=0`).
- Tests mit geskripteten Modellen (Systemnachrichten vor dem Prüfen der letzten Nachricht herausfiltern, siehe
  `docs/examples.md`).

## Phase 6 – Automaten (Spielerprogramme)

- Spieler schreiben kleine Programme, die im pi-codemode-Sandbox laufen (wie die Beiträge in codemode-chat).
- Ein Automat hat einen eigenen Charakter, ein Befehlsbudget und eine Lease; erlischt das Budget, schläft er.

## Phase 7 – Betrieb und Skalierung

- Zonen als benannte Spaces mit `Travel`-Übergabe; Adminbereich; Dashboard-Anbindung; Docker-Profile wie codemode-chat
  (nano/big).
- Starten von Containern auf einem gemeinsamen Server (`big`) nur nach Rückfrage.

## Offene Entscheidungen

1. **Name:** Verzeichnis `smmorpg` (wie gewünscht) – Spielname „Leuchtfeuer“ oder ein anderer?
2. **Grafik:** Phase 3 ohne Abhängigkeit (Empfehlung) oder gleich rot.js/PixiJS? Tileset (Kenney CC0) ins Repo?
3. **Gemeinsamer Code:** `ws.ts` und Space-Helfer kopieren (Empfehlung für den Anfang) oder gleich nach `src/web/`
   ziehen?
4. **Paketierung von phi-spaces:** `exports`-Feld und pi-codemode aus den Laufzeitabhängigkeiten des Roots nehmen –
   jetzt, später, oder gar nicht?
5. **Konten:** Gäste only für den Anfang, oder sofort Login wie die help-site?
6. **Kampf:** ganz weglassen, optional, oder Teil des Kerns?
