# spaces-mmo – MMORPG-Engine auf phi-spaces

`spaces-mmo` (Paket `phi-spaces-mmo`) ist eine browserfähige Mehrspieler-Engine, deren gesamte Welt in einem phi-space
liegt: Text als Grundlage (wie ein MUD), darüber eine Kachelgrafik mit PixiJS. Die Struktur der Spielwelt folgt
[Evennia](https://www.evennia.com/docs/latest/Components/Components-Overview.html), die Prozessaufteilung folgt
`codemode-chat/` (siehe `docs/codemode-space-architektur.md` im Root).

Die erste Spielwelt ist **Leuchtfeuer**, ein Archipel im Nebel. Engine und Welt sind getrennt
(`spaces-mmo/server/` vs. `spaces-mmo/worlds/leuchtfeuer/`), damit später weitere Welten auf derselben Engine laufen.

Stand 2026-10-24: Phase P (phi-spaces als Paket) und Phase 0 (Gast + Login, ein Raum, Text + PixiJS-Karte) sind
umgesetzt; siehe [phasen.md](phasen.md).

## Dokumente

| Datei | Inhalt |
| --- | --- |
| [paket.md](paket.md) | Vorarbeit am Root: phi-spaces als Paket für alle Projekte, die darauf aufbauen |
| [spielidee.md](spielidee.md) | Die Spielwelt „Leuchtfeuer“ und warum sie zu einem Space passt |
| [evennia-abbildung.md](evennia-abbildung.md) | Evennia-Komponenten → Entries, Templates, Leases, Worker |
| [architektur.md](architektur.md) | Prozesse, Datenfluss, Konten und Login, Grafik (PixiJS), Verzeichnisaufbau |
| [modell-npcs.md](modell-npcs.md) | Phase 5: Modell-NPCs als feste Rollen, Wecken durch Ereignisse, Wanderer, Kosten |
| [goetter.md](goetter.md) | Götter: Modell-NPCs, die Inseln, Aufträge und Ereignisse nach Regeln erschaffen; Prüfung statt Freigabe |
| [automaten.md](automaten.md) | Phase 6: Spielerprogramme, Beispielautomaten, kleines Hilfesystem |
| [phasen.md](phasen.md) | Umsetzung in Phasen mit Abnahmekriterien |

## Getroffene Entscheidungen

| # | Frage | Entscheidung |
| --- | --- | --- |
| 1 | Name | Verzeichnis `spaces-mmo/`, Paket `phi-spaces-mmo`; „Leuchtfeuer“ ist die erste Welt |
| 2 | Grafik | PixiJS `8.22.0` von Anfang an (Phase 0 rendert schon eine Kachelkarte); Tilesets aus Intersect-Assets (CC BY 4.0, mit Namensnennung) |
| 3 | Space und Spiel | Bleiben getrennt: kein Spiel- oder Webcode in `src/`; Gateway-Helfer wie `ws.ts` bekommt spaces-mmo als eigene Kopie, wie help-site und codemode-chat |
| 4 | Einbindung | phi-spaces wird **vor Phase 0** ein richtiges Paket (`exports`), und alle Projekte, die darauf aufbauen, importieren `phi-spaces` statt `../../src/…` ([paket.md](paket.md)) |
| 5 | Konten | Ab Phase 0 Gastzugang und Login (Benutzername + Passwort); bei der Registrierung wird der Gast-Fortschritt übernommen ([architektur.md](architektur.md#gastzugang)) |
| 6 | Kampf | Optional: ein abschaltbares Modul, pro Zone eingeschaltet, standardmäßig aus |

## Kurzantworten auf die Ausgangsfragen

**Läuft es im Browser wie help-site/codemode-chat?** Ja. Gleiches Muster: Next.js 16 + React 19 als Oberfläche,
ein Web-Prozess mit eigenem WebSocket-Gateway, dahinter der Space-Host als eigener Prozess. Der Browser spricht nie
direkt mit dem Space, er schickt nur Befehle und bekommt Ansichten.

**Ist die Space-Implementierung getrennt?** Ja, die Abhängigkeit geht nur in eine Richtung: `src/` kennt weder
help-site noch codemode-chat. Heute importieren beide den Kern noch über relative Pfade. Mit [paket.md](paket.md)
wird daraus ein Import `from "phi-spaces"` für alle Projekte.

**Evennia als Basis?** Evennias Komponenten lassen sich fast eins zu eins auf Entries und Worker abbilden. Die
Typklassen werden zu Entry-Typen mit Subtyp-Matching, siehe [evennia-abbildung.md](evennia-abbildung.md).
