# smmorpg – ein MMORPG auf phi-spaces

Plan für ein browserfähiges Mehrspieler-Rollenspiel, dessen gesamte Welt in einem phi-space liegt. Textbasiert
im Kern (wie ein MUD), mit einer einfachen Kachelgrafik darüber. Vorbild für die Struktur der Spielwelt ist
[Evennia](https://www.evennia.com/docs/latest/Components/Components-Overview.html); die Prozessaufteilung folgt
`codemode-chat/` (siehe `docs/codemode-space-architektur.md` im Root).

Stand: Plan, noch kein Code (2026-10-24).

## Dokumente

| Datei | Inhalt |
| --- | --- |
| [spielidee.md](spielidee.md) | Die Basis-Spielidee „Leuchtfeuer“ und warum sie zu einem Space passt |
| [evennia-abbildung.md](evennia-abbildung.md) | Evennia-Komponenten → Entries, Templates, Leases, Worker |
| [architektur.md](architektur.md) | Prozesse, Datenfluss Browser ↔ Space, Grafik, Einbindung von phi-spaces |
| [phasen.md](phasen.md) | Umsetzung in Phasen mit Abnahmekriterien, offene Entscheidungen |

## Kurzantworten auf die Ausgangsfragen

**Läuft es im Browser wie help-site/codemode-chat?** Ja. Gleiches Muster: Next.js 16 + React 19 als Oberfläche,
ein Web-Prozess mit eigenem WebSocket-Gateway, dahinter der Space-Host als eigener Prozess. Der Browser spricht nie
direkt mit dem Space, er schickt nur Befehle und bekommt Ansichten.

**Text oder Grafik?** Beides, als Hybrid: Befehlszeile und Textlog bleiben die Grundlage (jede Aktion ist ein
Textbefehl, dadurch können auch Agenten spielen). Darüber kommt eine Kachelkarte des aktuellen Raums. Phase 1 kommt
ohne neue Abhängigkeit aus (Canvas 2D, eigener kleiner Renderer); eine Engine wie rot.js oder PixiJS ist eine
spätere Option und braucht Zustimmung (keine neuen Abhängigkeiten ohne Rückfrage). Details in
[architektur.md](architektur.md#grafik).

**Ist die Space-Implementierung von help-site/codemode-chat getrennt?** Ja, die Abhängigkeit geht nur in eine
Richtung: `src/` kennt weder help-site noch codemode-chat. Beide importieren den Kern über relative Pfade
(`../../src/index.ts`, `../../src/store/sqlite.ts`, …), nicht als Paket. Für smmorpg heißt das:

- *Jetzt:* genauso einbinden: eigenes `smmorpg/package.json`, eigene `tsconfig.json`, relative Importe auf
  `../../src/…`. Funktioniert sofort, keine Build-Stufe (`--experimental-strip-types`).
- *Alternativ:* nur über den Draht: `npm run space-server` (`src/standalone.ts`) als eigener Prozess, smmorpg nutzt
  ausschließlich `RemoteSpace` + `socketTransport`. Damit hängt das Spiel nur an der Wire-API.
- *Später, als echtes Paket:* Dafür fehlen im Root-`package.json` ein `exports`-Feld (heute zeigen `main`/`types`
  auf `dist/`, also nur nach `npm run build`). Außerdem steht `@earendil-works/pi-codemode` dort als
  Laufzeitabhängigkeit, obwohl `src/` es nicht importiert (nur `examples/codemode-evolve.ts` und codemode-chat). Das
  ist eine eigene Aufgabe am Root und wird nicht stillschweigend mit smmorpg erledigt.

**Welche Spielidee?** „Leuchtfeuer“: ein Archipel im Nebel. Spieler bergen Strandgut, das die Flut anspült und
wieder fortspült, halten gemeinsam Leuchtfeuer am Brennen und handeln auf einem Markt. Jede dieser Mechaniken ist
eine Space-Operation (`take`, Lease, Transaktion). Siehe [spielidee.md](spielidee.md).

**Evennia als Basis?** Evennias Komponenten (Typeclasses, Objects/Rooms/Exits, Commands/Cmdsets, Scripts, Tags,
Locks, Prototypes, Channels …) lassen sich fast eins zu eins auf Entries und Worker abbilden. Die Typklassen werden
zu Entry-Typen mit Subtyp-Matching. Siehe [evennia-abbildung.md](evennia-abbildung.md).
