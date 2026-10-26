# Umsetzungsplan

Jede Phase endet mit einem spielbaren Stand und automatischen Tests (`node:test`, die Tests starten die Prozesse wie
`test:codemode-chat`). Nach jeder Änderung: Typecheck und Tests von spaces-mmo, außerdem Root-`npm run typecheck` und
`npm test`, falls der Root berührt wurde. Entscheidungen: siehe [README.md](README.md#getroffene-entscheidungen).

## Phase P – phi-spaces als Paket (Vorarbeit am Root)

Ausführlich in [paket.md](paket.md): `exports` mit Quell-Bedingung, `pi-codemode` nach `devDependencies`,
codemode-chat und help-site auf `import … from "phi-spaces"` umstellen, Prüfskript gegen relative `src/`-Importe.

**Abnahme:** alle bestehenden Suiten grün; spaces-mmo-Gerüst startet nur über `phi-spaces`, lokal und im Docker-Image.

## Phase 0 – Gerüst (Gast + Login, ein Raum, Text + Karte)

**Stand 2026-10-24: umgesetzt.** 12 Abnahmetests grün (`npm test` in `spaces-mmo/`), Typecheck grün, im Headless-
Chromium geprüft (Gast, `look`, `say`, Klick auf die Karte, Telefonbreite). Starten: `npm run build`, dann `npm start`
(Port 3900; `SPACES_MMO_MEM=1` hält alles im Speicher). Abweichungen vom Plan: `accounts` als eigener Store/Socket,
`x-mmo`-Header statt CSRF-Token ([architektur.md](architektur.md#konten-und-login)); zusätzlich getestet: Neustart des
Space-Prozesses auf SQLite.

- `spaces-mmo/package.json` (`phi-spaces-mmo`), `tsconfig.json`, `server/launch.ts` mit space, world, web; Space im
  Speicher (Tests) und auf SQLite.
- **Login** (siehe [architektur.md](architektur.md#konten-und-login)): Registrieren, Anmelden, Abmelden, Cookie +
  CSRF, Zugangsdaten im eigenen Space `accounts`, erster Admin per Einrichtungstoken.
- **Gastzugang** (siehe [architektur.md](architektur.md#gastzugang)): „Als Gast spielen“, Gastkonto mit Lease,
  Aufräum-Worker, Registrierung aus der Gastsitzung übernimmt den Fortschritt.
- Ein Charakter pro Konto, eine `Session` mit Lease, ein Raum mit festem Raster.
- Befehle: `look`, `say`, `who`, `help`, `move x y`.
- Browser: Login-Seite, Textlog + Befehlszeile, `MapView` mit PixiJS (Boden + Figuren, noch ohne Interpolation).

**Abnahme:** Zwei angemeldete Browser sehen sich gegenseitig auf der Karte und im `say`. Falsches Passwort zehnmal →
gesperrt für eine Minute. Zwei gleichzeitige Registrierungen desselben Namens: genau eine gelingt. Ein Gast hebt
etwas auf, registriert sich und hat danach denselben Charakter mit demselben Inventar; wird `web` zwischen Schritt 1
und 2 der Umwandlung abgeschossen, spielt der Gast weiter und der Name ist nach Ablauf der Lease wieder frei. Ein
Gastkonto ohne Aktivität verschwindet nach Ablauf seiner Lease samt Charakter. Wird ein Tab
geschlossen, verschwindet die Figur nach Ablauf der Session-Lease aus `who`. Neustart von `world` oder `web` meldet
niemanden ab und verliert nichts.

## Phase 1 – Weltkern nach Evennia

**Stand 2026-10-24: umgesetzt.** Beide Abnahmen als Tests (`tests/phase1.test.ts`, mit zwei Welt-Workern bzw. einem
Welt-Worker, der mitten im `give` per SIGKILL stirbt), dazu Ausgänge, Gegenstände, Builder, Locks, Tags und Laden der
Welt; Unit-Tests für Lock-Parser, FuncParser, Cmdset-Merge und Typklassen (`tests/engine.test.ts`). Neu dabei:
`step <dx> <dy>` (Klick und Pfeiltaste, relativ), `perm` (Admin vergibt Builder), `tag`, `lock`, `examine`;
`npm run world:load [-- --replace]`. Abweichungen und Grenzen: [evennia-abbildung.md](evennia-abbildung.md#stand-phase-1).

- Typklassen-Registry, Objects/Rooms/Exits/Characters, `location`-Modell; Engine und Welt getrennt
  (`server/engine/` vs. `worlds/leuchtfeuer/`).
- Commands + Cmdsets mit Merge-Regeln; `go`/Richtungen, `get`, `drop`, `give`, `inventory`, `emote`.
- Tags, Locks (Lock-Strings), Permissions, Prototypen + Spawner, Hilfeeinträge.
- Builder-Befehle (`dig`, `open`, `create`, `spawn`, `set`, `destroy`); Weltdateien laden (`world:load`).
- FuncParser-Grundform (`$you()`, `$conj()`).
- Karte: Ausgänge und Gegenstände als Sprites, Raumwechsel lädt die neue Karte.

**Abnahme:** 20 simulierte Spieler tippen gleichzeitig `get münze` auf eine Münze, genau einer bekommt sie. Ein
`give` überträgt einen Gegenstand nur ganz oder gar nicht, auch wenn `world` mitten in der Transaktion abgeschossen
wird.

## Phase 2 – Zeit: Flut, Feuer, Nebel

**Stand 2026-10-25: umgesetzt.** Abnahme als Tests (`tests/phase2.test.ts`, Spielzeit beschleunigt über
`SPACES_MMO_TIME_SCALE`): Ein Feuer erlischt zur berechneten Zeit von selbst (der `Flame`-Eintrag nennt die Weltzeit, bis zu der er brennt; seit der Weltzeit, [weltzeit.md](weltzeit.md)), der Nebel steigt auf 3 und schließt die Ausgänge, Nachlegen senkt ihn und öffnet sie. Bo pendelt über mehr
als eine Spielstunde zwischen den Räumen, ohne dass sich Einträge ansammeln. Dazu Flut (Strandgut mit Weltzeit-Ende,
höchstens 4 je Raum), Kanal `hafen`, `ruf`, Ines als Feuerwärterin, die warnt und grüßt. Abweichungen:
[evennia-abbildung.md](evennia-abbildung.md#stand-phase-2). Außerdem: Seiten erkennen einen neuen Build und laden neu;
zwei Figuren stehen nie auf derselben Kachel (Raum-Token, `tests/collision.test.ts`); Leertaste hebt auf.

Diese Phase implementiert skalierte Dauern, noch keine Uhr mit Weltstunde oder Welttag. Der persistierte Zeit- und
Scheduler-Vertrag ist in [weltzeit.md](weltzeit.md) geplant.

- Ticker-Worker, Scripts als Entries, OnDemand-Rechnung.
- Strandgut mit Lease, Leuchtfeuer mit erneuerbarer Lease, Nebelstufen pro Raum.
- Kanäle (`ChannelMsg`), Ruf-Zähler pro Feuer.
- Skript-NPCs (Prozess `npc`): Wärter, Fährmann (nur `Intent`s).

**Abnahme:** Ohne Nachlegen erlischt ein Feuer zur berechneten Zeit, der Nebel steigt und Ausgänge schließen sich.
Nach dem Nachlegen ist es umgekehrt. Ein Fährmann-NPC fährt seine Route über Stunden ohne Leak (Entry-Anzahl bleibt
beschränkt).

## Phase 3 – Grafik ausbauen (PixiJS)

**Stand 2026-10-25: umgesetzt.**
- **Grafik:** Wasser und Ufer als Autotiles (RPG-Maker-VX-Blöcke aus Viertelkacheln, die drei Wellenbilder animiert);
  Figuren gleiten mit Laufbildern von Kachel zu Kachel; das Feuer flackert.
- **Nebel:** ein Schleier mit Aussparungen um die eigene Figur und um ein brennendes Feuer.
- **Bedienung:** Zoom 1×/2×/3× mit Kamera, die der eigenen Figur folgt; Ziehen schaut sich um; langes Drücken oder
  Rechtsklick öffnet ein Kontextmenü; Umschalter „Nur Text“; ohne WebGL weiter als Text.
- **Namen:** In vollen Räumen stehen nur der eigene Name und die von Figuren in der Nähe.
- **Gemessen** (`tests/phase3.test.ts`, Latenz allein mit `npm run test:perf`): Begrüßung 3 KB bei 12 Figuren (Grenze 64 KiB); vom Schritt bis zur
  Positionsmeldung im Mittel 105 ms bei 90 % unter 186 ms (Ziel unter 150 ms); jeder Spieler bekommt nur seinen Raum.
- **Im Headless-Chromium** mit 30 Figuren, davon 29 laufende Bots: 38 Bilder/s bei Zoom 1, 37 bei Zoom 2. Das ist
  Software-Rendering ohne Grafikchip; auf einem echten Telefon ist es nicht gemessen.
- **Ein Texturatlas** ist nicht nötig: Die wenigen Blätter werden einmal geladen und ihre Ausschnitte zwischengespeichert.

- Deltas statt Snapshots, Interpolation der Bewegungen, Nebel-Ebene mit Maske, Feuer als animiertes Sprite.
- Tilesets aus Intersect-Assets mit `CREDITS.md`, Autotiles (Wasser, Ufer), Texturatlas der Welt Leuchtfeuer,
  Figuren aus `entities`, ganzzahliger Zoom, Touch (Tippen, Ziehen, Kontextmenü).
- Gateway: Interessensbereich pro Session; Umschalter „nur Text“; Fallback ohne WebGL.

**Abnahme:** Latenzziele aus [architektur.md](architektur.md#takt). Frames bleiben unter 64 KiB pro Raum-Snapshot.
Spielbar am Telefon. 30 Figuren in einem Raum laufen auf einem Mittelklasse-Telefon flüssig (≥ 30 fps).

## Phase 3b – optionale 3D-Ansicht (parallel)

**Stand 2026-10-25: erster Prototyp umgesetzt.** Die Arbeit ist vom Weltmodell entkoppelt und kann parallel zu den
weiteren Engine-Phasen fortgesetzt werden.

- `MapRenderer` gibt dieselben Serveransichten und Rastereingaben entweder an PixiJS oder Three.js weiter; Text,
  2D und 3D sind im laufenden Client umschaltbar.
- Three.js `0.186.1` ist exakt gepinnt und wird nur für die 3D-Ansicht dynamisch geladen. Ein Fehler fällt zuerst
  auf 2D und danach auf den vollständig spielbaren Textmodus zurück.
- `terrainHeight` ist versioniert, deterministisch und rein visuell. Instanzierte Geländekacheln, Figuren,
  Spielobjekte, Nebel, Kameranachführung, Drehung, Zoom und Raster-Klicks sind vorhanden.
- Ein fokussierter Test prüft deterministische und begrenzte Höhen sowie unbekannte Kacheltypen.

**Noch keine Abnahme:** Low-Poly-Assets und Wasser-Shader, GPU- und Speicherbudgets auf einem Zieltelefon sowie ein
Browser-E2E-Vergleich der 2D-/3D-Rastereingaben. Diese Punkte blockieren weder Weltlogik noch die Phasen 4 bis 7.

## Phase 4 – Handel und Wirtschaft

**Stand 2026-10-25: umgesetzt** (`tests/phase4.test.ts`).
- **Tausch:** `offer <dinge> an <person> [für <dinge>]`, `accept`, `decline`, `offer zurück`.
- **Marktbrett:** an der Grauen Bucht, Preise in Münzen; die Ware wartet treuhänderisch am Ort `market`, ein Ticker
  bringt sie nach abgelaufenem Angebot zurück.
- **Handwerk:** `craft` mit Muschelmesser und Holzbündel; Werkzeug nutzt sich mit jeder Benutzung ab.
- **Auftragstafel:** Ein Ticker hängt bis zu drei Aufträge aus; nehmen, liefern, Lohn in Münzen.
- **Erhaltungs-Fuzz:** 6 Spieler, 2 Welt-Worker, 15 s zufällige Tausche, Käufe, Rücknahmen und Geschenke; im
  gemessenen Lauf gelangen 56. Jeder der 42 eingesetzten Gegenstände existiert danach genau einmal, bei einem Spieler
  oder am Markt hinter einem lebenden Angebot.
- **Senken:** Brennstoff verbrennt, Werkzeug zerbricht, Aufträge verbrauchen die gelieferten Dinge. Münzen entstehen
  nur als Lohn der Tafel.

- Direkter Tausch (`offer`/`accept`) als eine Transaktion; Marktbrett (Angebote als Entries mit Lease).
- Rezepte/Handwerk über Prototypen; Auftragstafel als Master-Worker.
- Senken gegen Inflation: Brennstoff verbrennt, Werkzeug nutzt sich ab (OnDemand).

**Abnahme:** Fuzz-Test mit vielen gleichzeitigen Tauschen und Abbrüchen; die Summe aller Gegenstände ist danach
gleich der Summe davor plus Spawns minus Verbrauch (Erhaltungsprüfung).

## Phase 4b – Archipel und Bewohner

**Stand 2026-10-25: umgesetzt** (`tests/world.test.ts`, `tests/economy.test.ts`); ausführlich in [welt.md](welt.md).
- **Welt**: 25 Räume auf fünf Inseln (Generator `worlds/leuchtfeuer/islands.ts`), Fähren, ein Feuer je Insel,
  Strandgut je Strand, Sturmflut, neue Dinge und Rezepte, drei Märkte und Auftragstafeln.
- **Bewohner**: 16 Skript-NPCs (Sammler, Hüter, Händler, Handwerker, Plauderer) handeln, tauschen und reden über
  dieselben Befehle wie Spieler, ohne Modellaufrufe. Modellrollen hören nur Menschen.
- **Übersichtskarte** oben links.

**Abnahme:** jeder Raum vom Start aus erreichbar, jeder Weg in jedem Raum begehbar; alle NPCs zugleich spielen
lassen ändert die Zahl der Münzen nicht.

## Phase 5 – Modell-NPCs (kosten Tokens, nur nach Freigabe)

**Stand 2026-10-25: umgesetzt, nur mit geskripteten Modellen getestet** (`tests/phase5.test.ts`); ein Live-Lauf mit
einem echten Modell steht aus und braucht Freigabe.
- **Ines** ist eine Modellrolle: geweckt durch schwaches oder erloschenes Feuer, Ansprache oder jemanden, der
  hereinkommt; wach antwortet sie mit dem Modell (nur `say`/`emote`) und merkt sich mit `NOTE:` etwas.
- **Der Fremde** ist ein Wanderer, der nur bei länger dichtem Nebel erscheint.
- **Grenzen:** `SPACES_MMO_NPC_MAX`, Tagesbudget je Rolle, gemeinsame Kontingente. Rollen gehen per Lease an einen
  npc-Prozess; stirbt er, übernimmt ein anderer.
- **Kennzeichnung:** Modellrollen sind auf der Karte und im Log als KI gekennzeichnet.
- **Abweichungen:** [modell-npcs.md](modell-npcs.md#stand).
- **Dazu: Eingaben in natürlicher Sprache** ([architektur.md](architektur.md#eingaben-in-natürlicher-sprache)) und
  Knöpfe für Tausch, Markt und Aufträge.

Ausführlich in [modell-npcs.md](modell-npcs.md): feste Rollen, die bei Ereignissen aufwachen (döst/wach/abwesend), Wanderer durch Ereignisse, `SPACES_MMO_NPC_MAX` zählt nur die wachen.

- `npc`-Prozess nutzt das `agent/`-Paket; Agenten spielen über dieselben Befehle wie Menschen.
- Kontingente pro Tag/Minute wie `CODEMODE_LLM_PER_DAY`, `CODEMODE_LLM_PER_MIN`; standardmäßig aus
  (`SPACES_MMO_LLM=0`).
- Tests mit geskripteten Modellen (Systemnachrichten vor dem Prüfen der letzten Nachricht herausfiltern, siehe
  `docs/examples.md`).

## Phase 5b – Götter (Modell-NPCs, die die Welt erweitern)

Ausführlich in [goetter.md](goetter.md): Inseln, Aufträge, Ereignisse und Geschichten in Stufe 1, Gegenstände, Wesen und Markt in Stufe 2, neue Welten als Entwurf in Stufe 3. Ein Prüfer lässt Entwürfe live gehen, der Admin kann abschalten und zurückrollen.

## Phase 6 – Automaten (Spielerprogramme)

Ausführlich in [automaten.md](automaten.md): Vorlagen mit Feldern, Regelbaukasten, Vormachen und Assistent (Beschreibung zu Code) von Anfang an; Modell-NPCs dürfen Automaten bauen. Deutsch und Englisch umschaltbar (Befehle immer in beiden, Code und Texte je Nutzer).

- Spieler schreiben kleine Programme (`schritt(sicht, merk) → { tue, merk }`), die im pi-codemode-Sandbox laufen
  (wie die Beiträge in codemode-chat), in einem eigenen Automaten-Prozess.
- Ein Automat ist ein Spielgegenstand mit eigener Figur; sein Budget ist Öl (Lease), ist es leer, bleibt er stehen.
- Auswahl von sechs getesteten Beispielautomaten (Grüßer, Strandläufer, Feuerwärter, Bote, Nebelboje, Händler),
  nach Schwierigkeit geordnet, im Spiel und im Editor übernehmbar.
- Kleines Hilfesystem aus einer Quelle: Artikel im Format der codemode-chat-Hilfe, im Spiel als `help automat …`,
  im Editor als Referenz, „?“-Tipps und Probelauf.

**Abnahme:** siehe [automaten.md](automaten.md#abnahme).

## Phase 7 – Betrieb und Skalierung

- Zonen als benannte Spaces mit `Travel`-Übergabe; Adminbereich; Dashboard-Anbindung; Docker-Profile wie codemode-chat
  (nano/big).
- Starten von Containern auf einem gemeinsamen Server (`big`) nur nach Rückfrage.

## Modul K – Kampf (optional)

Kein Teil des Kerns; ein Engine-Modul `server/engine/combat/`, das jederzeit ab Phase 2 dazukommen kann.

- **Abschaltbar:** standardmäßig aus; eine Zone schaltet es ein (`Room.fields.combat = true`, z. B. die dichten
  Nebelzonen). Wo es aus ist, gibt es die Befehle gar nicht (Cmdset `CombatCmdSet` hängt nur an solchen Räumen).
- **Rundenbasiert:** ein `Encounter`-Entry pro Begegnung mit Lease; Züge alle 3 s, jeder Teilnehmer gibt einen
  Befehl (`hit`, `guard`, `flee`, `use <ding>`); der Welt-Worker wertet eine Runde in einer Transaktion aus.
- **Gegner:** Nebelwesen als NPC-Figuren; nur PvE. PvP höchstens später und nur in eigens markierten Zonen.
- **Folgen milde:** Wer verliert, wird zum nächsten brennenden Leuchtfeuer zurückgetragen und verliert einen Teil des
  getragenen Strandguts, keine Ausrüstung.
- Automaten dürfen nicht kämpfen (Cmdset der Automaten enthält keine Kampfbefehle).

**Abnahme:** Mit ausgeschaltetem Modul sind keine Kampfbefehle erreichbar und alle anderen Suiten unverändert grün.
Eine Runde mit gleichzeitigen Befehlen vieler Teilnehmer wird genau einmal ausgewertet, auch nach einem Absturz von
`world` mitten in der Runde.

## Noch offen

Nichts Grundsätzliches. Entschieden seit dem ersten Entwurf:

- Tileset: Intersect-Assets, Tilesets unter CC BY 4.0, mit `CREDITS.md` ([architektur.md](architektur.md#grafiken-intersect-assets)).
- `pixi.js` exakt `8.22.0`.
- `agent/` bleibt in Phase P bei relativen Importen ([paket.md](paket.md#agent)).
