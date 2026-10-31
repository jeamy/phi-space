# spaces-mmo: Mehrspieler-Engine auf phi-spaces

`spaces-mmo` ist ein Spiel für viele Leute im Browser, und zugleich die Engine dafür. Die erste Welt heißt
**Leuchtfeuer**: ein Archipel im Nebel, in dem die Spieler gemeinsam Feuer hüten, sammeln, handeln, bauen und Gärten
anlegen. Spielen geht mit Karte in 2D oder 3D oder nur mit Text.

Das Paket heißt `phi-spaces-mmo`. Die ganze Welt liegt in phi-spaces, kein Spielzustand im Browser. Text ist die Grundlage (wie in einem MUD), darüber liegen eine Kachelgrafik mit PixiJS
und eine 3D-Ansicht mit Three.js. Die Struktur der Spielwelt folgt
[Evennia](https://www.evennia.com/docs/latest/Components/Components-Overview.html), die Prozessaufteilung folgt
`codemode-chat/` (siehe `docs/codemode-space-architektur.en.md` im Root). Engine (`server/`) und Welt
(`worlds/leuchtfeuer/`) sind getrennt, damit weitere Welten auf derselben Engine laufen können.

## Stand 2026-10-30

Das Spiel ist spielbar, von der ersten Anmeldung bis zum Dorf. Es fehlen noch Automaten, Götter und die großen Bauten
der späteren Epochen. Für den Betrieb ist es auf die Rechner big und nano ausgelegt ([betrieb.md](../betrieb.en.md)).

| Bereich | Stand |
| --- | --- |
| Phasen P bis 4b ([phasen.md](../phasen.en.md)) | gebaut: Konten, Weltkern, Feuer und Nebel, Grafik, Handel, Archipel und Bewohner |
| Phase 3b, 3D-Ansicht | gebaut, ohne Abnahme auf einem Zieltelefon; eigene Low-Poly-Modelle sind dazugekommen (`client/props3d.ts`) |
| Phase 5, Modell-NPCs ([modell-npcs.md](../modell-npcs.en.md)) | gebaut, mit geskripteten Modellen getestet; Modellaufrufe nur mit `SPACES_MMO_LLM=1` |
| Welt | acht Inseln, 37 Räume, neun Feuer (`worlds/leuchtfeuer/world.ts`); dazu 40 Siedler, von denen standardmäßig mindestens 30 Figuren spielen |
| Chat ([siedeln.md](../siedeln.en.md), Schritt 0) | gebaut: zu zweit und in Gruppen, Ende-zu-Ende verschlüsselt |
| Bauen und Gärten (Schritte 1 und 2) | gebaut: Hütte, Truhe, Verfall; Beete, Kreuzen, Hasen, Zaun, Vogelscheuche |
| Äcker und Hof (Schritt 3) | gebaut: Fluren mit Fruchtfolge, Mühle, Backhaus, Tiere, Webstuhl, Wild, Wächter |
| Epochen und Siedlungen (Schritt 4) | gebaut: Inseln werden zum Dorf; Siedlungen mit Rängen und Tür. Stadt und Netz haben noch keine Pläne |
| Regionen ([welt-aufteilen.md](../welt-aufteilen.en.md)) | gebaut: vier Regionen auf big, Konten-Space auf nano ([betrieb.md](../betrieb.en.md)) |
| Geplant | Götter ([goetter.md](../goetter.en.md)), Automaten ([automaten.md](../automaten.en.md)), Zonen und Kampf ([phasen.md](../phasen.en.md)), ab Schritt 5 in [siedeln.md](../siedeln.en.md) Werkstätten bis Inselbahn |

## Starten

Der Quelltext startet ohne Container, mit allen Prozessen auf einem Rechner. Modellaufrufe bleiben dabei aus.

```sh
npm --prefix spaces-mmo run build
npm --prefix spaces-mmo start                 # Port 3900; SPACES_MMO_MEM=1 hält alles im Speicher
npm --prefix spaces-mmo test                  # die Tests starten die Prozesse selbst
npm --prefix spaces-mmo run typecheck
```

Mit Docker gibt es `docker:local:up` (big und nano zusammen auf dieser Maschine, Port 3910, Image vorher mit
`docker:image`) und `docker:dev:up` (ein Container, der Quelltext eingebunden, kompiliert bei jeder Änderung neu,
Port 3920). Produktion: `docker:nano:up` und `docker:big:up` auf dem jeweiligen Rechner. Einzelheiten stehen in
[betrieb.md](../betrieb.en.md).

## Dokumente

Für den Einstieg reichen [spielidee.md](../spielidee.en.md) und [architektur.md](../architektur.en.md). Die Hilfe für Spieler liegt
nicht hier, sondern in `client/help/articles.ts` (im Spiel unter „?“) und als Themen in `worlds/leuchtfeuer/world.ts`
(`help <thema>`).

| Datei | Inhalt |
| --- | --- |
| [spielidee.md](../spielidee.en.md) | Die Spielwelt „Leuchtfeuer“ und warum sie zu einem Space passt |
| [architektur.md](../architektur.en.md) | Prozesse, Datenfluss, Konten und Login, Grafik (PixiJS), Verzeichnisaufbau |
| [betrieb.md](../betrieb.en.md) | Docker: Image, Profile nano/big/dev, lokaler Testaufbau, Produktion, Last und Latenz |
| [phasen.md](../phasen.en.md) | Umsetzung in Phasen mit Abnahmekriterien |
| [siedeln.md](../siedeln.en.md) | Siedeln, Bauen und Gärtnern: Entwurf und Reihenfolge; die Schritte 0 bis 4 sind gebaut, der Rest ist Plan |
| [paket.md](../paket.en.md) | Vorarbeit am Root: phi-spaces als Paket für alle Projekte, die darauf aufbauen |
| [evennia-abbildung.md](../evennia-abbildung.en.md) | Evennia-Komponenten → Entries, Templates, Leases, Worker |
| [weltzeit.md](../weltzeit.en.md) | Persistierte Weltuhr, Kalender, Scheduler, Neustart- und Mehrhost-Vertrag |
| [welt.md](../welt.en.md) | Wie Welten wachsen; der Archipel, die Bewohner und ihr Handel, die Übersichtskarte (Stand 2026-10-25, 25 Räume auf fünf Inseln; später um drei Inselgruppen erweitert, jetzt 37 Räume auf acht Inseln) |
| [welt-aufteilen.md](../welt-aufteilen.en.md) | Die Welt in Regionen-Spaces: wie es gebaut ist und der Entwurf davor |
| [modell-npcs.md](../modell-npcs.en.md) | Phase 5: Modell-NPCs als feste Rollen, Wecken durch Ereignisse, Wanderer, Kosten, dauerhafte Dialoge |
| [goetter.md](../goetter.en.md) | Plan: Modell-NPCs, die Inseln, Aufträge und Ereignisse nach Regeln erschaffen; Prüfung statt Freigabe |
| [automaten.md](../automaten.en.md) | Phase 6, Plan: Spielerprogramme, Beispielautomaten, kleines Hilfesystem |
| [lasttest-2026-10-28.md](../lasttest-2026-10-28.en.md) | Lasttests auf big und nano: Antwortzeiten, Engpass, Vorschläge |
| [messung-vpsc-2026-10-29.md](../messung-vpsc-2026-10-29.en.md) | Messung: wie viel ein Kern auf vpsc als Host für Regionen leistet |

## Getroffene Entscheidungen

Diese Fragen wurden zu Beginn entschieden. Geändert hat sich seitdem nur Entscheidung 3, am 27.10.2026.

| # | Frage | Entscheidung |
| --- | --- | --- |
| 1 | Name | Verzeichnis `spaces-mmo/`, Paket `phi-spaces-mmo`; „Leuchtfeuer“ ist die erste Welt |
| 2 | Grafik | PixiJS `8.22.0` rendert die 2D-Karte; die optionale 2,5D-Ansicht verwendet Three.js `0.186.1`. Beide sind nur Ansichten desselben autoritativen Rasters und exakt gepinnt. Tilesets stammen aus Intersect-Assets (CC BY 4.0, mit Namensnennung). |
| 3 | Space und Spiel | Bleiben getrennt: kein Spielcode in `src/`. Was alle Projekte gleich brauchen, liegt einmal in der Bibliothek statt als Kopie: das WebSocket-Gateway (`phi-spaces/ws`) und die Space-Helfer (`connectSpace`, `readExisting`/`StillHeld`, `awaitWork`, `keepAlive`, `takeAll` aus `phi-spaces`); geändert am 27.10.2026, weil die Kopien auseinanderliefen |
| 4 | Einbindung | phi-spaces wird **vor Phase 0** ein richtiges Paket (`exports`), und alle Projekte, die darauf aufbauen, importieren `phi-spaces` statt `../../src/…` ([paket.md](../paket.en.md)) |
| 5 | Konten | Ab Phase 0 Gastzugang und Login (Benutzername + Passwort); bei der Registrierung wird der Gast-Fortschritt übernommen ([architektur.md](../architektur.en.md#guest-access)) |
| 6 | Kampf | Optional: ein abschaltbares Modul, pro Zone eingeschaltet, standardmäßig aus |

## Kurzantworten auf die Ausgangsfragen

Diese Fragen standen am Anfang des Projekts. Die Antworten gelten weiter.

**Läuft es im Browser wie help-site/codemode-chat?** Ja. Gleiches Muster: Next.js 16 + React 19 als Oberfläche,
ein Web-Prozess mit eigenem WebSocket-Gateway, dahinter die Space-Prozesse. Der Browser spricht nie
direkt mit einem Space, er schickt nur Befehle und bekommt Ansichten.

**Ist die Space-Implementierung getrennt?** Ja, die Abhängigkeit geht nur in eine Richtung: `src/` kennt weder
help-site noch codemode-chat noch spaces-mmo. spaces-mmo hängt als `"phi-spaces": "file:.."` am Paket und importiert
`phi-spaces` ([paket.md](../paket.en.md)).

**Evennia als Basis?** Evennias Komponenten lassen sich fast eins zu eins auf Entries und Worker abbilden. Die
Typklassen werden zu Entry-Typen mit Subtyp-Matching, siehe [evennia-abbildung.md](../evennia-abbildung.en.md).
