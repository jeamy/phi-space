# Die Welt wächst: Archipel, Bewohner, Handel

Stand 2026-10-25, Weltversion 9 (`worlds/leuchtfeuer/world.ts`, Tests in `tests/world.test.ts` und
`tests/economy.test.ts`).

## Wie Welten erweitert werden

Es gibt drei Wege. Alle schreiben dieselben Entries (`Room`, `Exit`, `Item`, `Beacon`, …); die Engine kennt keinen
Unterschied.

1. **Die Weltdatei** (`worlds/<welt>/world.ts`): Räume, Ausgänge, Prototypen, Hilfe, Feuer, NPCs, Märkte, Rezepte,
   Aufträge. Wer sie ändert, erhöht `version`; der erste Welt-Worker, der eine neuere Version sieht, ersetzt beim
   Laden Räume, Ausgänge, Prototypen und Hilfe in einer Transaktion unter dem Weltschloss (`server/engine/loader.ts`).
   Neue NPCs und neue platzierte Dinge kommen dazu; was Spieler aufgehoben haben, kommt nicht zurück; eine NPC-Figur,
   die es schon gibt, bleibt, wo sie steht.
2. **Bauen im Spiel**: Builder legen mit `dig`, `open`, `create`, `spawn`, `set`, `lock`, `tag`, `destroy` Räume und
   Dinge an (`server/engine/commands/builder.ts`). Diese Räume haben keinen Platz auf der Übersichtskarte; die Weltdatei
   berührt sie nie.
3. **Götter** (geplant, [goetter.md](goetter.md)): Modell-NPCs, die nach Regeln Inseln, Aufträge und Ereignisse
   entwerfen; ein Prüfer lässt sie live gehen.

## Der Archipel

25 Räume zu je 24 × 16 Zellen (9 600 Zellen, gut das Zwölffache der ersten beiden Räume) auf fünf Inseln:

| Insel | Räume | Besonderes |
| --- | --- | --- |
| Graue Insel | Graue Bucht, Klippenpfad, Fischerdorf, Torfmoor, Dünen, Salzwiesen, Klippenkopf, Anleger | Start; Markt und Tafel an der Grauen Bucht; Fähren nach allen anderen Inseln |
| Möwenfels | Möwenstrand, Vogelklippen, Möwennest, Alte Warte | Muscheln; das nördlichste Feuer |
| Kupferhafen | Kai, Markt, Werft, Speicher, Hafenviertel | der größte Markt; Holz ist knapp, Perlen und Netze bringen viel |
| Tangriff | Tangstrand, Riffdorf, Wrackbucht, Perlengrund | Tang, Bernstein, Perlen; Markt und Tafel im Riffdorf |
| Nebelholm | Ufer, Moorwald, Steinkreis, Verlorener Hain | niemand hütet das Feuer; wer es entzündet, lichtet die ganze Insel |

- **Gelände aus einem Generator** (`worlds/leuchtfeuer/islands.ts`): Meer an den Seiten, die ein Raum nennt, Strand,
  Gras oder Dünensand, ein Pflasterplatz, Pflasterwege von jeder Tür zur Mitte (ein Weg ins Meer ist ein Steg).
  Derselbe Startwert (die Raum-ID) ergibt immer denselben Boden; der Generator liefert nur Daten, keine Regeln. Die
  Graue Bucht und der Klippenpfad bleiben Zelle für Zelle wie zuvor; sie bekommen nur neue Ausgänge.
- **Ausgänge**: Räume einer Insel, die auf der Übersicht nebeneinander liegen, sind über `nord`/`ost`/`süd`/`west`
  verbunden (Tür in der Mitte der Seite). **Fähren** verbinden die Inseln (Ausgang am Steg, benannt nach der
  Zielinsel, z. B. `kupferhafen`; wo nur eine abgeht, auch `fähre`). Alle Wege schließt Nebel der Stufe 3.
- **Feuer**: eines je Insel, jedes deckt die Räume seiner Insel (das erste weiterhin nur Bucht und Pfad).
- **Flut**: Strände spülen eigenes Strandgut an (Tang am Torfmoor, Bernstein in der Wrackbucht, Perlen im
  Perlengrund). **Sturmflut** (`storm`, alle 20 Spielminuten): sechs Dinge auf einmal an einem Strand, der Hafenkanal
  sagt, wo.
- **Brennstoffe**: Treibholz (10 Minuten), Holzbündel (40), **Tran** (60 Minuten; Marta verkauft ihn auf dem Markt von
  Kupferhafen, die Hüter kaufen ihn, ein Sturm spült selten ein Fass an, ein Auftrag in Kupferhafen will einen für die
  Alte Warte).
- **Startausstattung mit festen IDs** (`npc-<id>-<proto>-<n>`): eine neue Weltversion legt an, was davon nirgends mehr
  existiert; so erreicht ein neues Ding der Weltdatei auch einen NPC, den es schon gibt.
- **Neue Dinge und Rezepte**: Tang → Tangseil; zwei Tangseile + Messer → Netz; Bernstein + zwei Muscheln + Tangseil +
  Messer → Bernsteinkette. Perle und Bernstein sind Funde.
- **Märkte und Tafeln** an der Grauen Bucht, in Kupferhafen und im Riffdorf; jedes Brett hat seine eigenen Angebote
  und Aufträge (Aufträge gelten je Ort, `kinds[].rooms`). Den eigenen Auftrag liefert man an jeder Tafel ab.

## Die Bewohner

16 neue Skript-NPCs (`server/npc/economy.ts`), ohne Modellaufrufe. Sie handeln nur über die Befehle eines Spielers
(`npc.act` → `Intent`); jeder Tausch, Kauf und jedes Nachlegen ist damit dieselbe Transaktion wie bei Menschen, nichts
geht verloren oder doppelt. Ein Befehl gilt als erledigt, wenn der Welt-Worker seine Transaktion abgeschlossen hat
(das Lesen des `ActorToken` wartet darauf), sonst sähe die nächste Runde des Skripts noch die alte Welt.

| Rolle | Wer | Was |
| --- | --- | --- |
| `sammler` | Hanne, Henning, Jan | sammelt in seinen Räumen, was die Flut bringt, und stellt es auf seinem Markt ein |
| `huter` | Mats, Svea, Greta, Nele | hält das Feuer seiner Insel am Brennen; sammelt oder kauft Holz dafür |
| `haendler` | Kalle, Ruben, Marta | reist zwischen den Märkten seiner Route (Marta bleibt), kauft billig, verkauft teurer |
| `handwerker` | Jorin, Piet | sammelt und kauft Zutaten, stellt her (und ersetzt sein Werkzeug), verkauft das Ergebnis |
| `plauderer` | Tilde, Lotte, Kaspar, Eske | geht umher, erzählt Geschichten und Wahres: Preise, erloschene Feuer, gute Aufträge, auch auf dem Hafenkanal |

- **Preise** je NPC und Prototyp (`prices: { proto: [kauft bis, verkauft für] }`). Angebote an einen NPC beantwortet
  er danach: was er bekommt, ist wert, was er zahlen würde; was er hergibt, kostet, was er verlangt; Münzen zählen
  eins. Ein Geschenk nimmt er an. Sonst lehnt er ab und sagt, was er höchstens gibt.
- **Von sich aus**: Händler, Hüter und Handwerker bieten Anwesenden Münzen für Dinge, die sie suchen (je Person und
  Ding höchstens alle zehn Spielminuten). Wer einen NPC anspricht, erfährt, was er kauft und verkauft.
- **Startausstattung** (`carry`): Münzen, Holz, ein Messer; einmal, wenn die Welt die Figur anlegt. Münzen entstehen
  sonst nur als Lohn der Tafeln.
- **Modellrollen** hören nur Menschen: Gerede von NPCs weckt Ines nicht und kostet keinen Aufruf (`fromId` jeder
  Nachricht, NPCs beginnen mit `npc-`).
- **Wer spielt**: `SPACES_MMO_NPCS` nennt die Rollen eines npc-Prozesses (Komma-Liste; leer: alle). Die Tests der
  früheren Phasen spielen nur Ines, Bo und den Fremden; `tests/economy.test.ts` spielt die Bewohner selbst, einer davon
  alle zugleich mit Münzbilanz.

## Übersichtskarte

Oben links über der Karte (`client/Atlas.tsx`): alle Räume an ihrem Platz, eine Zelle ein Pixel, darauf Nebel,
brennende Feuer, Menschen (helle Punkte) und NPCs (dunkle Punkte), Fähren gestrichelt, der eigene Raum umrandet,
die Inselnamen. Antippen vergrößert, „Karte“ klappt sie ein (im Browser gemerkt). Das Gateway schickt das Gelände
einmal je Verbindung (`atlas`) und danach höchstens einmal je Sekunde den Zustand (`atlasState`).

## Noch offen

- Münzen sammeln sich bei Sammlern, die sie nie ausgeben; Händler können mit der Zeit leer laufen, bis Spieler kaufen.
  Ein Kreislauf (Sammler liefern Aufträge ab, kaufen Werkzeug) folgt, wenn sich das im Betrieb zeigt.
- Modellrollen gibt es weiterhin nur zwei (Ines, der Fremde); weitere kosten Tokens und brauchen eine Freigabe.
- Fähren fahren sofort; Abfahrtszeiten und eine Überfahrt als eigener Raum sind möglich, aber nicht gebaut.
