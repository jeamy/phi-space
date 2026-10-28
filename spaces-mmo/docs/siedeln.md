# Siedeln und Bauen (Entwurf)

Stand 2026-10-28. Noch nicht gebaut; ein Vorschlag, wie Leuchtfeuer über Sammeln, Feuer und Handel hinaus wächst:
Häuser, Gärten, Werkstätten, Straßen, Kirchen, Kaufhäuser, später Eisenbahn. Er baut auf [spielidee.md](spielidee.md),
[welt.md](welt.md), [goetter.md](goetter.md) und [automaten.md](automaten.md) auf.

## Richtung: weder Civilization noch Age of Empires

| | Civilization | Age of Empires | Leuchtfeuer |
| --- | --- | --- | --- |
| Takt | Runden | Echtzeit, schnell | Echtzeit, langsam (Welt-Ticks, Spielminuten) |
| Wer spielt | ein Reich gegen andere | ein Volk gegen andere | alle zusammen gegen den Nebel |
| Ziel | Sieg (Eroberung, Forschung …) | Sieg (Armee) | die Welt licht und belebt halten, kein Ende |
| Kern | Technologiebaum, Epochen | Rohstoffe → Armee | Rohstoffe → gemeinsame Bauten |

Beide Vorbilder sind Spiele gegeneinander mit einem Ende. Leuchtfeuer ist gewaltarm, ohne Ende und gemeinsam
([spielidee.md](spielidee.md), „Rahmen“); ein Reich, das ein anderes erobert, passt dazu nicht.

**Vorschlag: eine gemeinsame Aufbausimulation.** Am nächsten liegen Siedler- und Anno-artige Warenketten, die viele
gemeinsam bedienen. Von Civilization kommen nur die **Epochen**, als Fortschritt der ganzen Welt, nicht eines Spielers:
wenn genug gebaut und erhalten ist, schaltet die Welt die nächste Stufe frei. Von Age of Empires kommt nichts außer
dem Gefühl, dass Arbeit sichtbar die Karte verändert.

Der Zielkonflikt bleibt derselbe: was man sammelt, kann man ins eigene Haus stecken oder in das, was allen gehört
(Feuer, Straße, Kirche).

## Licht ist Bauland

Gebaut wird nur, wo ein Feuer den Nebel fernhält. Ein Bau braucht Licht, und jeder Bau verbraucht etwas davon:

- Ein **Feuer** deckt Räume ([welt.md](welt.md)); ein **Leuchtturm** (Ausbau eines Feuers) deckt mehr Räume oder
  brennt länger je Brennstoff.
- Erlischt das Feuer, verfallen die Bauten in seinem Licht nicht sofort, aber sie **arbeiten nicht** (keine Ware, kein
  Markt), und der Nebel nagt an ihnen (Verfall, unten).
- Damit bleibt die Kernidee tragend: Wer baut, hat einen Grund, das Feuer zu halten.

## Was man baut

Nach Epochen; jede Stufe setzt die vorige voraus.

### Epoche 1: Hütten (Fischerdorf)

| Bau | Kosten (Beispiel) | Wirkung |
| --- | --- | --- |
| **Hütte** | 6 Treibholz, 2 Tangseile | eigener Ort: Truhe (Lager), Ausloggen ohne Verlust, Rückkehrpunkt |
| **Trockengestell** | 4 Holz | macht aus Tang langsam Tangseil |
| **Räucherei** | 8 Holz, 4 Steine | Fisch → Räucherfisch (Ware, Nahrung für Arbeiter) |
| **Steg** | 6 Holz | ein neuer Ausgang ins Wasser, Boote legen dort an |

### Epoche 2: Dorf (Werkstätten und Wege)

| Bau | Wirkung |
| --- | --- |
| **Werkstatt** (Tischlerei, Seilerei, Schmiede) | Rezepte, die es ohne sie nicht gibt; ein Werkzeug hält dort länger |
| **Pflasterweg** | Zellen, die man schneller begeht; ein Weg zwischen zwei Räumen kürzt den Ausgang |
| **Lagerhaus** | gemeinsames Lager eines Dorfs: alle mit Recht legen ein und entnehmen (Treuhand wie beim Markt) |
| **Brunnen, Backhaus** | Nahrung: wer satt ist, trägt mehr oder arbeitet schneller |
| **Kapelle** | Ort der Götter ([goetter.md](goetter.md)): Opfergaben, Segen (ein Effekt mit Lease), Fest |

### Epoche 3: Stadt (Handel und Verwaltung)

| Bau | Wirkung |
| --- | --- |
| **Kaufhaus** | ein Markt mit festem Lager, Preisen nach Angebot und Nachfrage, Aufträgen an Lieferanten |
| **Kontor, Bank** | Wechsel, Kredit mit Frist (eine Schuld ist ein Entry mit Lease: läuft sie ab, verfällt das Pfand) |
| **Kirche, Glockenturm** | Fest der ganzen Insel; die Glocke ruft (Nachricht an alle Räume, ein Termin der Weltuhr) |
| **Rathaus** | Regeln einer Siedlung: wer bauen darf, Steuern ins Lagerhaus, Abstimmungen (Vorschläge und Stimmen wie auf der Arbeitstafel von codemode-chat) |
| **Werft** | größere Boote: mehr Ladung, neue Fahrten in den Nebel ([spielidee.md](spielidee.md), „Erkunden“) |
| **Leuchtturm** | Ausbau eines Feuers (oben) |

### Epoche 4: Netz (Infrastruktur)

| Bau | Wirkung |
| --- | --- |
| **Straße** | verbindet Räume über Inselgrenzen nicht, aber innerhalb einer Insel; Karren fahren darauf |
| **Karren, Fuhrwerk** | ein Automat ([automaten.md](automaten.md)) mit Ladung, der eine Route fährt |
| **Fährlinie mit Fahrplan** | Fähren fahren zu Zeiten, die Überfahrt ist ein eigener Raum ([welt.md](welt.md), „Noch offen“) |
| **Inselbahn** | Gleise sind Zellen, ein Zug ist ein Automat mit Fahrplan; Bahnhöfe sind Ausgänge; Ladung wie ein Lagerhaus auf Rädern |
| **Signalfeuer-Kette** | Feuer, die sich gegenseitig sehen, teilen ihr Licht: eine Kette brennt nur, solange jedes Glied brennt |

Eisenbahn passt zum Ton (Inseln, Nebel, Holz und Kohle), aber erst spät: sie lohnt erst, wenn es viele Waren gibt, die
weit müssen. Kohle (aus dem Torfmoor, später Bergbau) wäre ihr Brennstoff und ein neuer Zielkonflikt mit dem Feuer.

## Gärten

Gärten gibt es ab der ersten Epoche, und viele davon: sie sind der leiseste, häufigste Bau, für Gäste wie für
Siedler. Ein Garten macht Zeit sichtbar, und Zeit ist das, was der Space mit Leases ohnehin trägt.

- **Beet anlegen**: eine Fläche im Licht umgraben (Spaten, `grabe`), mit `unique` auf die Zellen wie jeder Bau. Kleine
  Beete vor der Hütte, Gemeinschaftsgärten an Dorfplatz und Kapelle, Obstwiesen, Parks in der Stadt.
- **Säen und pflanzen**: Samen, Zwiebeln, Setzlinge und junge Bäume sind Dinge; `pflanze tulpe` setzt sie in eine
  freie Zelle des Beets. Daraus wird eine **Pflanze**, die in Stufen wächst (Saat, Keim, Blüte oder Frucht, verwelkt),
  jede Stufe eine Frist in Weltzeit ([weltzeit.md](weltzeit.md)).
- **Pflege**: Gießen (`gieße`, Wasser aus Brunnen oder Regentonne) und Jäten erneuern die Lease der Pflanze; wer sie
  vergisst, lässt sie welken. Nebel lässt Pflanzen langsamer wachsen, Licht schneller: Gärten sind ein weiterer Grund,
  das Feuer zu halten. Ein Garten ist Teamarbeit wie ein Feuer (Gießdienst, Beiträge sichtbar).
- **Ernten**: Gemüse (Kartoffel, Kohl, Bohnen, Möhren, Kürbis), Kräuter (Heilkraut, Salzmiere), Obst von Bäumen (Apfel,
  Birne, Quitte), Blumen (Tulpe, Rose, Strandnelke, Dünenrose, Nebelblume nur auf Nebelholm). Ernte ist ein `take`:
  zehn Leute am selben Apfelbaum, jeder Apfel geht an genau einen.
- **Vermehren**: Blühende Pflanzen geben Samen; zwei Sorten nebeneinander kreuzen sich manchmal zu einer neuen Farbe
  oder Form (seltene Sorten, Züchtung). Bäume wachsen über viele Spieltage und bleiben lange; ein alter Baum steht im
  Ruf seiner Pflanzer.
- **Kaufen und tauschen**: Samenhändler auf den Märkten (ein neuer NPC, Gärtnerin), Blumen am Marktbrett, Tausch von
  Ablegern zwischen Spielern (`offer` wie heute). Seltene Sorten haben Preise, Sträuße sind Geschenke an NPCs und
  Opfer an der Kapelle.
- **Wozu**: Gemüse ist Nahrung (Räucherei, Backhaus, Arbeiter), Kräuter sind Zutaten (Heiltrank, Farbe), Obstbäume
  liefern Holz, wenn man sie fällt (Zielkonflikt: Holz jetzt oder Äpfel jedes Jahr), Blumen schmücken (Ruf einer
  Siedlung, Feste, Blumenschau mit Preis der Tafel), Hecken und Bäume brechen den Wind der Sturmflut.
- **Jahreszeiten** (später): was wann blüht, Frost im Winter, Ernte im Herbst; ein Erntefest der Insel an der Kirche.
- **Automaten**: ein Gießroboter ist ein naheliegender erster Automat ([automaten.md](automaten.md)), mit Wasser als
  Budget.

| Gartenmechanik | Space-Operation |
| --- | --- |
| Pflanze wächst | Stufe als Entry, nächste Stufe ein Termin der Weltuhr |
| Gießen, Jäten | `renew` der Lease der Pflanze |
| Welken | Lease läuft ab, die Welt schreibt eine welke Pflanze (oder Kompost) |
| Ernte | `take` jeder Frucht: genau einer bekommt sie |
| Kreuzung | Ticker liest Nachbarn im Beet, schreibt selten eine neue Sorte als Samen |

Viele Gärten heißen viele Entries mit Lease und Termin. Eine Pflanze schreibt nur, wenn sie die Stufe wechselt (nicht
je Tick), damit 10 000 Pflanzen den Space nicht stärker belasten als ein paar Dutzend Figuren.

## Wie ein Bau entsteht: die Baustelle

Kein Spieler baut allein ein Haus in einem Befehl. Eine Baustelle ist ein Ort, an dem viele zuarbeiten:

1. `bau hütte` auf freier, lichter Fläche legt eine **Baustelle** an: eine Entry mit dem Plan (was fehlt) und einer
   Lease (bleibt sie leer, verschwindet sie).
2. Jeder kann liefern (`liefere 3 treibholz an baustelle`) oder Arbeit leisten (`arbeite an baustelle`). Lieferung und
   Fortschritt sind eine Transaktion: die Ware ist weg, der Fortschritt steht, nie halb.
3. Fehlt nichts mehr, wird aus der Baustelle der **Bau** (in derselben Transaktion). Wer beigetragen hat, steht auf
   einer Tafel am Bau (wie heute die Beiträge an einem Feuer: Ruf).
4. **Aufträge**: Eine Baustelle kann ihre fehlenden Teile an die Auftragstafel hängen ([phasen.md](phasen.md),
   Phase 4); Sammler-NPCs und Automaten liefern dann zu.

## Verfall und Unterhalt

Ohne Senken wächst die Welt nur noch (mehr Entries, mehr Last, keine Ziele mehr). Deshalb verfällt, was niemand pflegt:

- Jeder Bau hat einen **Zustand** mit Lease. Nebel, Sturmflut und Zeit verringern ihn; `repariere` mit Material
  erneuert ihn (`renew`, wie das Nachlegen am Feuer).
- Ein verfallener Bau wird zur **Ruine** (gibt einen Teil des Materials zurück, kann wieder aufgebaut werden) und
  verschwindet später ganz.
- Gemeinsame Bauten (Straße, Kirche, Kaufhaus) kosten **Unterhalt** aus dem Lagerhaus ihrer Siedlung; fehlt er, hören
  sie auf zu arbeiten.

## Siedlungen und Besitz

- Eine **Siedlung** entsteht, wenn in einem Raum genug Hütten stehen; sie hat ein Lagerhaus, einen Namen und Regeln.
- **Besitz** ist eine Entry mit `unique` auf die Fläche: zwei Spieler können nie dieselbe Zelle bebauen, auch wenn sie
  zugleich `bau` tippen.
- **Rechte** (wer im Haus etwas nehmen, auf der Fläche bauen, im Lagerhaus entnehmen darf) sind Locks wie heute an
  Ausgängen (`locks`, [phasen.md](phasen.md), Phase 1).
- Gäste können zuarbeiten (liefern, arbeiten), aber nichts besitzen; Besitz braucht ein Konto (wie Handel heute).

## Was die Space-Semantik trägt

| Spielmechanik | Space-Operation |
| --- | --- |
| Baustelle beliefern | `take` der Ware + `write` des Fortschritts in einer Transaktion |
| Fertigstellen | Baustelle `take`, Bau `write`, Beiträge `write`, eine Transaktion |
| Fläche belegen | `write` mit `unique` auf (Raum, Zelle) |
| Verfall | Lease des Zustands läuft ab; `renew` beim Reparieren |
| Unterhalt | Ticker nimmt aus dem Lagerhaus, sonst setzt er den Bau auf „steht still“ |
| Karren, Zug, Fähre | Automaten mit Fahrplan (Termine der Weltuhr, [weltzeit.md](weltzeit.md)) |
| Abstimmung im Rathaus | Vorschläge und Stimmen als Entries, Ende mit Lease |
| Epoche erreicht | eine Welt-Entry; Rezepte und Baupläne prüfen sie |

## Was das für den Betrieb heißt

- **Mehr Entries, die bleiben.** Bauten sind dauerhaft; jede Insel mit einer Stadt hat Hunderte. Lesen nach Typ ist
  indiziert ([lasttest-2026-10-28.md](lasttest-2026-10-28.md)), aber ein Raum mit vielen Bauten braucht einen
  Index nach Raum oder eigene Typen je Bauart.
- **Mehr Ticker** (Verfall, Unterhalt, Werkstätten, Züge). Sie gehören in Welt-Worker, nicht in den Space-Prozess; ein
  Ticker, der nichts ändert, schreibt nichts (wie `fireTick`).
- **Die Welt aufteilen** ([welt-aufteilen.md](welt-aufteilen.md)) wird mit Städten wahrscheinlicher: eine Insel je
  Space passt zu Siedlungen, die je Insel wirtschaften; Bahn und Fähre sind dann die Übergaben zwischen Spaces.
- **Karte**: Bauten brauchen Grafik (Sprites je Bauart und Zustand: Baustelle, fertig, verfallen, Ruine).

## Reihenfolge

1. **Hütte und Baustelle** (Epoche 1, ohne Siedlung): Bauplan als Prototyp, `bau`, `liefere`, `arbeite`, Fertigstellen,
   Truhe, Verfall. Abnahme: 20 Spieler beliefern dieselbe Baustelle gleichzeitig, sie wird genau einmal fertig, kein
   Teil geht verloren oder doppelt.
2. **Gärten**: Beet, Samen, Pflanzen mit Wachstumsstufen, Gießen, Ernte, Gärtnerin auf den Märkten. Abnahme: 1 000
   Pflanzen wachsen einen Spieltag lang, der Space schreibt nur bei Stufenwechseln.
3. **Werkstätten und Lagerhaus**, neue Rezepte, Aufträge der Baustellen an der Tafel; Sammler-NPCs beliefern Baustellen.
4. **Siedlung, Rathaus, Kapelle** (Rechte, Abstimmungen, Feste mit den Göttern).
5. **Kaufhaus, Kontor, Leuchtturm**.
6. **Straßen, Karren, Fahrplan-Fähren**, dann die **Inselbahn** als Automat.

## Offene Fragen

- Wie viel Fläche hat ein Raum für Bauten (heute 24 × 16 Zellen), und wachsen Räume oder entstehen neue (Götter)?
- Bauen Götter mit (eine Kirche, die ein Gott „annimmt“), oder bleiben sie bei Räumen und Wegen?
- Gibt es Wettbewerb zwischen Siedlungen (Ruf, Feste, Preise) ohne Kampf, und wie viel davon?
- Soll eine Epoche zurückfallen können, wenn zu viel verfällt?
