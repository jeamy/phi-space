# Analyse: Spielregeln, Abläufe, Spielstufen und Abhängigkeiten (2026-11-19)

Stand der Prüfung: Weltdatei `leuchtfeuer` Version **54** (37 Räume auf 8 Inseln, 9 Feuer, 144 Prototypen, 31 Baupläne,
68 Rezepte, 44 Auftragsarten, 95 NPCs = 37 benannte Figuren + 40 Siedler + 18 Dorfbewohner).

Geprüft wurden:
- Weltdefinition und Schema: `worlds/leuchtfeuer/world.ts`, `worlds/leuchtfeuer/world.json`, `shared/world-def.ts`
- TypeScript-Engine: `server/engine/commands/*.ts`, `server/engine/fire.ts`, `sweep.ts`, `worldevents.ts`, `settings.ts`, `server/world-host.ts`
- NPC-Wirtschaft und Siedler: `server/npc/economy.ts`, `server/npc/settlers.ts`, `server/npc/scripts.ts`
- Durchlauf-Test, Hilfe und Hinweise: `tests/play/epochs.ts`, `client/help/articles.ts`, `client/hints.ts`
- Parität zur Rust-Engine: `rust/mmo-engine/src/commands/mod.rs`, `rust/mmo-engine/src/commands.json`
- Abgleich mit dem Entwurf: `docs/de-docs/siedeln.md`, `spielidee.md`, `welt.md`, `phasen.md`

Nachgeprüft am selben Tag gegen Code, `world.json` und die laufende Welt auf big (nur gelesen): Abschnitt 9 sagt, wie
jede Aussage geprüft wurde, was dabei berichtigt wurde und wie es auf big steht.

---

## 1. Gesamtbewertung

**Was trägt und sauber funktioniert:**
- **Referenzintegrität (100 %):** Jeder Prototyp-Schlüssel in Bauplänen, Reparaturkosten, Rezepten, Aufträgen, NPC-Preisen/`carry`, `shop.prices`/`stock`, `food`, `keeps`, `pack`, `animals`, `wild`, `garden`, `fields`, `trees`, `mill`, `quarry`, `clay`, `salt`, `sand`, `fishing`, `chapel`, `boat`, `cart`, `bank`, `flood`, `storm` und `objects` existiert in `world.prototypes`.
- **Keine Blockade in den Warenketten:** Die Rezepte und die Mühle für sich sind zyklenfrei. Mit Werkzeugen und Fundorten hat der Graph zwei Schleifen (Stein ↔ Spitzhacke: der Steinbruch braucht die Hacke, die Hacke Stein; Netz ↔ Tang/Muschel/Muschelmesser: der Steg braucht das Netz), dazu Saat → Frucht → Saat und Jungtier → Tier; jede hat einen Einstieg von außen (Strandgut, wilde Saat, Gesa), also blockiert keine. Jeder Bauplan lässt sich mit Mitteln seiner eigenen (oder einer früheren) Epoche errichten und reparieren, und mit dem Kauf bei NPCs ist jeder Prototyp erreichbar.
- **TS/Rust-Befehlsparität (100 %):** Beide Engines bieten exakt dieselben **109 Befehle** (99 Standard- + 10 Builder-Befehle) ohne Abweichungen bei Schlüsseln, Aliasen, Locks, `hidden`-Flags oder Hilfezeilen (die Tabelle der heutigen TypeScript-Engine ist bytegleich mit `commands.json`). Das gilt für die Tabelle, nicht für das Verhalten: Die sechs Bugs aus Abschnitt 4 stehen in beiden Engines.

**Wo es hakt:**
- **6 echte Bugs** im Engine-Code, in TypeScript wie in Rust (u. a. Uhr-Verwechslungen zwischen Lebens- und Verfallsuhr, gelöschter Dünger durch Reh-Verbiss, Arten-Mix im Gehege, nie aufgeräumte `Sated`-Einträge, Race Condition bei Straßen).
- **Wichtige Regel-Lücken** zwischen Entwurf und Umsetzung (insbesondere: erloschene Feuer stoppen keine stehenden Gebäude; Leuchttürme sind unbegrenzt stapelbar; Bäume kosten Licht ohne Epochenpunkte; Straßen geben Epochenpunkte ohne Licht; Lagerhaus-Verfall in Siedlungen als Privat-Exploit; fehlendes Quorum im Rathaus).
- **Struktureller Münz-Stillstand in der NPC-Wirtschaft** ohne aktive kaufende Spieler.

---

## 2. Spielstufen (Epochen 1–4) und Lichtpunkte

### 2.1 Ist-Stand der Mechanik
- Epochen gelten **je Insel** (`Epoch`-Entry mit `{ unique: ["island"] }`), berechnet durch `epochTick` in `server/engine/commands/epoch.ts:62-89`.
- Schwellen (`server/settings.ts:24-26`, `worlds/leuchtfeuer/world.ts:767-768`):
  - **Epoche 1 (Fischerdorf):** `< 15` Punkte
  - **Epoche 2 (Dorf):** `≥ 15` Punkte
  - **Epoche 3 (Stadt):** `≥ 40` Punkte
  - **Epoche 4 (Netz):** `≥ 80` Punkte
- Rückfall: Fällt der gehaltene Bestand unter eine Schwelle, stuft `epochTick` automatisch zurück. Stehende Bauten arbeiten weiter; gesperrt sind nur neue Aktionen mit Epochenprüfung (`bau`, `flur anlegen`, `einstallen` für `rind` ab Epoche 3, `straße plane` ab Epoche 2, `beam` ab der Epoche der Einstellung `beam.epoch`: Vorgabe 4, auf big steht sie auf 1).
- Lichtkapazität je Feuer (`server/engine/commands/build.ts:129-143`):
  ```text
  Kapazität = min(40, 20 + 5 * aktiveSpieler7d) + 20 * (Epoche - 1) + 20 * LeuchttürmeAmFeuer
  ```
  (Gäste und Siedler zählen nicht zu `aktiveSpieler7d`; Siedler dürfen höchstens `1 - settlers.reserve` = 75 % belegen.)

### 2.2 Erreichbarkeit nach Inseltyp

Die Graue Insel hat **2 Feuer** (`feuer-bucht`, `feuer-anleger`), alle anderen **7 Inseln** haben **1 Feuer** (`world.ts:570-580`).

| Inseltyp | Epoche 1 → 2 (15 Pkt.) | Epoche 2 → 3 (40 Pkt.) | Epoche 3 → 4 (80 Pkt.) |
| --- | --- | --- | --- |
| **Einzel-Feuer (7 Inseln)** | Kapazität: 20 (0 Sp.) / 25 (1 Sp.) / 40 (4+ Sp.). Siedler allein: 15. **Erreichbar.** | Kapazität: 40 (0 Sp.) / 45 (1 Sp.) / 60 (4+ Sp.). **Mit ≥1 Spieler erreichbar.** | Ohne Leuchtturm: 60 (0 Sp.) / 65 (1 Sp.) / 70 (2 Sp.) / 75 (3 Sp.) / 80 (4+ Sp.). **Mit 1–3 Spielern nur mit Leuchtturm erreichbar** (+20 Kapazität bei 3 Pkt. Kosten → 85–100). |
| **Graue Insel (2 Feuer)** | Kapazität: 40 / 50 / 80. **Erreichbar.** | Kapazität: 80 / 90 / 120. **Erreichbar.** | Kapazität ohne Leuchtturm: 120 / 130 / 160. **Ohne Leuchtturm erreichbar.** |

Ein einzelner Spieler kann Epoche 4 über das Kontolimit (`build.max3 = 18` gezählte Bauten + ungezählte Ställe/Tonnen/Scheuchen + 3 Beete + 1 Flur) auf jeder Insel erreichen — auf den 7 Einzel-Feuer-Inseln jedoch nur mit mindestens einem Leuchtturm.

### 2.3 Gefundene Inkonsistenzen (Epochen & Licht)

- **E1 – Bäume verbrauchen Licht, geben aber keine Epochenpunkte:**
  - `plantTree` (`server/engine/commands/trees.ts:76-90`) zieht `trees.points` (`1`) vom Feuer ab.
  - `islandPoints` (`server/engine/commands/epoch.ts:31-44`) summiert nur `Building`, `Bed`, `Field` und `routePoints` — `Tree`-Einträge fehlen.
  - **Folge:** Auf knappen Einzel-Feuer-Inseln (z. B. 1 Spieler in Epoche 2 mit 45 Licht für 40 Punkte) kann das Pflanzen von Bäumen den Epochenaufstieg blockieren.
- **E2 – Straßen umgehen Lichtpunkte, zählen aber für Epochen:**
  - `straße plane` (`server/engine/commands/road.ts:229-268`) prüft weder ein brennendes Feuer noch Lichtpunkte (`lightFor` wird nicht aufgerufen), aber `routePoints` (`road.ts:127-131`, aufgerufen in `epoch.ts:42`) addiert `2` Punkte pro fertiger Straße.
  - Zusätzlich prüft `routePoints` nicht `untilWorldMs > now` — eine abgelaufene Straße zählt einen Tick zu lange, bis `roadTick` sie löscht.
- **E3 – Leuchtturm beliebig stapelbar; `lightRooms` auf 7 Inseln wirkungslos:**
  - `leuchtturm` (`worlds/leuchtfeuer/world.ts:697`) hat kein `onePerRoom: true` und kein Limit pro Feuer (`build.ts:139, 374`). Jeder Leuchtturm kostet 3 Lichtpunkte und liefert +20 (`+17` netto) → Licht ohne Obergrenze je Feuer. Begrenzt ist es nur durch das Kontolimit (18 Bauten in der Stadt, 20 im Netz) und die Kosten je Turm (16 Stein, 10 Ziegel, 2 Tran, 40 Arbeit).
  - `lightRooms: 1` erweitert die Deckung auf Nachbarräume derselben Insel (`fire.ts:87-92`). Da auf 7 von 8 Inseln das einzige Feuer ohnehin bereits alle Räume der Insel deckt, hat `lightRooms` nur auf der Grauen Insel eine Wirkung.
- **E4 – Gärtner erhöhen `lightGrowth` nicht:**
  - `noteBuilder` (`server/engine/commands/build.ts:145-150, 377`) wird nur bei `bau` aufgerufen, nicht bei `umgraben`, `flur anlegen` oder `pflanze <baum>`. Wer nur gärtnert, verbraucht Licht, erweitert aber die Feuerkapazität nicht — im Widerspruch zur Gleichwertigkeit von Bauten und Gärten (`siedeln.md:20-24`).
- **E5 – `epoch.force` in `epochOf` nicht begrenzt:**
  - `epochTick` (`epoch.ts:66`) begrenzt `epoch.force` auf `w.epochs.names.length`, `epochOf` (`epoch.ts:50`) jedoch nicht. Ohne Wirkung, solange die Welt vier Epochen hat: Die Einstellung selbst endet bei 4 (`server/settings.ts:35`).

---

## 3. Abhängigkeiten, Warenketten und Weltdefinition (`world.ts`)

### 3.1 Sackgassen-Prototypen (W1)
Vier Prototypen haben **keine spielerische Senke** (weder Rezept, Bau, Reparatur, Nahrung, Tierfutter, Opfergabe, Auftrag noch Werkzeug — sie lassen sich nur an NPCs oder im Kaufhaus verkaufen):
1. `borsten` (`world.ts:437`): nur von Gesa angekauft (`world.ts:242`). Dass sie in `shop.prices` fehlen, ist kein Befund: Das Kaufhaus führt nur Erzeugnisse, rund 50 Rohwaren (Fleisch, Felle, Talg, Federn, Saat, Tiere) fehlen dort ebenso.
2. `kerze` (`world.ts:481`): nur von Marta (`L225`) und im Kaufhaus angekauft. **Text-Widerspruch:** Die Beschreibung lautet *„Die Kapelle und die Schenken zahlen gut dafür“*, aber `kerze` fehlt sowohl in `chapel.offerings` (`world.ts:830`) als auch in `orders.kinds` (`world.ts:929-974`).
3. `kissen` (`world.ts:485`): nur von Marta (`L225`) und im Kaufhaus angekauft; kein Auftrag, kein Nutzen (z. B. kein Schlaf-Bonus).
4. `gehaeuse` (`world.ts:496`): bewusster Platzhalter für die noch ungebauten Automaten (Phase 6), aktuell reine Handelsware.

### 3.2 NPC-Bestand (`carry`) vs. Hilfetext (W2)
`restock()` (`server/engine/commands/trade.ts:534`) füllt nur Artikel nach, die in `npc.carry` stehen und einen Verkaufspreis (`> 0`) haben.
- Der Hilfetext (`world.ts:543`) sagt: **„Gesa verkauft Küken und Ferkel“** und **„Wilma … verkauft Wurst, Speck und Salz“**.
- Tatsächlich fehlen `kueken` und `ferkel` in Gesas `carry` (`world.ts:243`, obwohl in `prices` auf `L242`) und `salz` in Wilmas `carry` (`world.ts:230`, obwohl in `prices` auf `L229`).
- **Folge:** Keiner der drei Artikel ist jemals bei diesen NPCs vorrätig, solange ihn nicht zuvor ein Spieler verkauft hat.
- Dasselbe Muster bei Gesa für `gerste`, `samen-ruebe`, `leinsamen` und `flachs` (Verkaufspreis, kein Bestand). Es blockiert nichts: Gerste, Rübe und Flachs wachsen wild, und die Hilfe sagt das so (`articles.ts:1933-1937`).

### 3.3 Auftragstafeln: fehlende Epochen-Filter und unattraktive Löhne (W3)
- **Keine Epochenprüfung:** `trade.ts:517` hängt beliebige `orders.kinds` eines Raums aus, unabhängig von der Insel-Epoche. Am `kupferhafen-markt` erfordern **12 von 23** Auftragsarten Waren, die erst ab Epoche 2 oder 3 herstellbar sind (`brot`, `segel`, `kuchen`, `tuch`, `decke`, `bratwurst`, `gaensebraten`, `trueffel` ab dem Dorf; `met`, `festessen`, `faehrproviant`, `stiefel` ab der Stadt). `eier`, `honig` und `grillhaehnchen` gehen schon im Fischerdorf.
- **14 Aufträge zahlen weniger als der beste NPC-Ankaufspreis der Welt** (nicht immer im selben Raum: Marta und Wilma stehen in Kupferhafen), z. B.:
  - `holz`: 1 Münze für 2 `treibholz` (Hinnerk im selben Raum zahlt 4)
  - `buendel`: 2 Münzen (Hinnerk zahlt 5)
  - `kuchen`: 18 Münzen für 2 Stück (Marta zahlt 32)
  - `kaese`: 9 Münzen (Marta zahlt 14)
  - `segel`: 12 Münzen (Marta zahlt 16)
  - `proviant`: 14 Münzen (Wilma zahlt 16)
  Da Aufträge die primäre Münzquelle für Spieler sind, setzen diese Löhne falsche Anreize.

### 3.4 Weitere Welt-Funde (W4–W5)
- **W4 – 15 verderbliche gekochte Speisen ohne Lagerbehälter (`world.keeps`):** `fass` konserviert Säfte, Suppen, Eintopf und alle 9 rohen Fleischsorten (`world.ts:814`), `obstkiste` Äpfel und Birnen (`L815`). 15 gekochte Gerichte mit `turns: 5d` (`kohlroulade`, `grillhaehnchen`, `entenbraten`, `gaensebraten`, `lammbraten`, `schweinebraten`, `bratwurst`, `steak`, `rinderbraten`, `schmalzbrot`, `ruehrei`, `pfannkuchen`, `kuchen`, `honigbrot`, `festessen`) haben keinen `keeps`-Behälter.
- **W5 – Kleine NPC-Arbitrage über Inseln hinweg:** `tran` (Marta verkauft für 6, Nele/Thies kaufen für 7) und `holzbuendel` (Bente verkauft für 5, Nele/Thies kaufen für 6; Jorin verkauft gefertigte Bündel für 4).

---

## 4. Echte Bugs im Engine-Code

| ID | Datei & Stelle | Befund | Auswirkung |
| --- | --- | --- | --- |
| **B1** | `server/engine/commands/build.ts:872, 975` | `WorkRest` (`build.ts:446`, `field.ts:80`), `Blessing` (`chapel.ts:36`) und `BeamRest` (`beam.ts:74`) schreiben `untilWorldMs` auf der **Lebensuhr (`worldNowOf`)**, `buildSweep` vergleicht aber gegen die **Verfallsuhr (`decayNowOf`)**. | Bei `life > decay` (z. B. 24:1) bleiben abgelaufene Einträge ~24× länger unaufgeräumt; bei `decay > life` werden aktive Segen/Ruhezeiten vorzeitig gelöscht. |
| **B2** | `server/engine/commands/interior.ts:108` | `dropInterior` legt Nachlässe (`Estate`) für Innenraum-Gegenstände mit `worldNowOf` statt `decayNowOf` an; `buildSweep` (`build.ts:968`) prüft gegen `decayNowOf`. | Bei `life > decay` laufen Innenraum-Nachlässe faktisch nie ab. |
| **B3** | `server/engine/commands/wild.ts:72-77` vs. `field.ts:279` | `graze()` berechnet `f.yields` nach einem Reh-Biss neu (`harvestOf(...)`) und ignoriert `f.dunged`. | Ein einziger Reh-Biss löscht den gesamten Düngebonus, lässt `f.dunged = true` aber stehen, sodass nicht nachgedüngt werden kann. |
| **B4** | `server/engine/commands/animals.ts:109` | `einstallen` prüft `if (has && n && has.key !== k.key)` nur auf erwachsene Tiere (`n`) statt `n + small`. | Enthält ein Gehege nur Jungtiere (`n === 0, small > 0`), lässt sich eine andere Tierart einstallen und überschreibt `b.herd.kind`. |
| **B5** | `server/engine/commands/food.ts:38` vs. `build.ts:975` | `Sated`-Einträge werden weder in `buildSweep` noch in `sweepTick` abgeräumt. | Abgelaufene `Sated`-Einträge bleiben im Space, höchstens einer je Figur, die je gegessen hat (der nächste Bissen ersetzt ihn): Aufräumarbeit, kein Leck. |
| **B6** | `server/engine/commands/road.ts:241, 262` | `Route` wird ohne `{ unique: ["pair"] }` geschrieben (anders als `Settlement`, `Motion`, `Show`, `Epoch`, `Plot`). | Zwei gleichzeitige `straße plane`-Befehle zweier Figuren können doppelte Straßen zwischen denselben zwei Räumen anlegen: Der Welt-Prozess bedient bis zu 16 Figuren zugleich, jede in ihrer Transaktion (`server/world-host.ts`, `LANES`). Auf big gibt es bisher kein doppeltes Paar. |

### 4.1 Wie die Uhren auf big stehen (gelesen am 2026-11-19)

In allen vier Regionen läuft die Lebensuhr 24-fach (`clock.life=24`), die Verfallsuhr in Echtzeit: Die Lebensuhr steht
bei Welttag 448, die Verfallsuhr bei Tag 25, also 424 Tage auseinander. nano hält nur den Konten-Space und hat keine
Weltuhr. Damit gilt dort:

- **B1:** Der Sweep räumt keinen einzigen `WorkRest`-, `Blessing`- oder `BeamRest`-Eintrag ab. In den vier Regionen
  liegen 43 `WorkRest` und 3 `BeamRest`, alle nach der Lebensuhr abgelaufen, keiner davon für den Sweep fällig. Es bleibt
  bei einem Eintrag je Figur (die nächste Arbeit ersetzt ihn); niemand ruht deshalb länger oder kürzer, denn gelesen
  werden die Einträge gegen die Lebensuhr. Vorzeitig gelöscht wird nichts, weil die Verfallsuhr hinterherläuft.
- **B2:** Ein Nachlass aus einem Innenraum bekäme ein Ende bei Lebenstag 448 + 30 und läge nach der Verfallsuhr rund 454
  echte Tage statt 30. Zurzeit gibt es keinen solchen Nachlass.
- **B5:** 24 `Sated`-Einträge, 23 davon abgelaufen.
- **B6:** 32 Straßen, kein Paar doppelt.

---

## 5. Regel-Lücken und Abläufe (Entwurf vs. Umsetzung)

- **R1 – Erloschene Feuer stoppen keine stehenden Gebäude (größte Regel-Lücke):**
  - Laut `siedeln.md:103-104` sollen Bauten bei erloschenem Feuer stillstehen (keine Ware, kein Markt).
  - Im Code prüft **keines** der Module für stehende Gebäude (`mill.ts`, `quarry.ts`, `shop.ts`, `chapel.ts`, `townhall.ts`, `festival.ts`, `animals.ts`, `fishing.ts`, `trade.ts`, `cart.ts`, `interior.ts`, `build.ts` für `liefere`/`arbeite`/`repariere`/`truhe`) auf `isLit` oder `fogOf`.
  - Tatsächliche Folgen eines erloschenen Feuers sind derzeit nur: Nebelanstieg, blockierte Nebel-Ausgänge (außer kürzestem Weg zum Licht), langsameres Pflanzen-/Baumwachstum (bis 2,5×), Wild-Spawns (`fog > 0`), Sperre für *neue* Bauvorhaben/Beete/Äcker/Bäume, Unterbrechung von Signalfeuer-Ketten und `beam`-Sperre innerhalb der Region.
- **R2 – Siedlungs-Lagerhaus-Exploit über Verfall:**
  - `abriss` (`build.ts:826`) und `antrag abriss` (`townhall.ts:73-74, 154`) verbieten den Abriss eines gefüllten Lagerhauses in einer Siedlung.
  - Lässt der Besitzer das Lagerhaus aber absichtlich verfallen, verschiebt `buildSweep` (`build.ts:934-939`) den gesamten Inhalt der Siedlung in den privaten `Estate`-Nachlass des Besitzers.
- **R3 – Rathaus-Abstimmungen ohne Quorum:**
  - Der Antragsteller stimmt automatisch mit `ja` (`townhall.ts:110`), und nach Ablauf reicht `yes > no` (`townhall.ts:143`). Eine einzelne 1:0-Stimme kann fremde Bauten abreißen (`antrag abriss`) oder Steuern erhöhen (`antrag steuer`).
- **R4 – Alles-oder-nichts beim Entladen (`packAfter`):**
  - `karren entlade` (`cart.ts:98`) und `zug abholen` (`cart.ts:237`) brechen vollständig ab, wenn `packMax` überschritten würde (`commands.ts:123`). Anders als `nachlass` (`build.ts:847-858`) gibt es kein Teilentladen.
- **R5 – Verwaiste `ShopOrder`-Einträge:**
  - Beim Abriss oder Verfall eines Kaufhauses werden dessen `ShopOrder`-Einträge nicht gelöscht, sondern nur beim Lesen ausgefiltert (`trade.ts:472-474`).
- **R6 – Feuer-Broadcasts verfehlen Leuchtturm-/Ketten-Räume:**
  - `feed` und `fireTick` (`server/engine/fire.ts:51, 75`) senden Meldungen an das statische `beacon.covers` statt an das dynamische `coversOf(space, w)`.
- **R7 – Kleinere Unstimmigkeiten:**
  - `feedKeeper` (`animals.ts:249-273`) vergibt im Gegensatz zu `feedHerd` (`animals.ts:201`) kein `creditDeed(c, "tiere")`.
  - `settlementRanks` (`settlement.ts:102`) filtert abgelaufene Bauten (`untilWorldMs > now`) nicht heraus.
  - Rohe Prototyp-Schlüssel in Fehlermeldungen (`quarry.ts:21`, `trade.ts:427, 431, 496`).
  - Unbenutzte Variablen: `now` in `garden.ts:280, 362`, `bays` in `fishing.ts:140`.

---

## 6. NPC-Wirtschaft und Siedler-Abläufe

### 6.1 Münzkreislauf
- **Münzquellen (Prägung):** Nur Spieler-Lieferungen an Auftragstafeln (`order liefere`, `trade.ts:503`) und von Spielern gewonnene Feste (`festival.ts:140-143`, 10 Münzen; NPC-Sieger erhalten nur Ehre).
- **Münzsenken (Vernichtung):** `beam` (`beam.ts:71`), `zug`/`zug sende` (`cart.ts:256, 268`), `einschiffen` (`fishing.ts:172`, auch für NPCs über `byTrain`/`byShip` in `economy.ts:112, 147`) sowie `spoil()` in `server/world-host.ts:295-307`, das NPC-Münzen oberhalb von `coinMax = 50` löscht.

### 6.2 Strukturelle Engpässe
- **N1 – Dauerhafte Pleite aller 8 Hüter (`huter`):** Hüter starten mit 4–8 Münzen, kaufen nur Brennstoff (`buys = 3, sells = 0`) und verkaufen nichts. `restock()` füllt bewusst keine Münzen nach (`trade.ts:534`). Nach wenigen Käufen stehen sie dauerhaft bei 0 Münzen.
- **N2 – Ausbluten der 7 Händler (`haendler`):** Händler kaufen zahlreiche reine Ankauf-Waren (z. B. Marta: 57 Ankauf / 33 Verkauf; Wilma: 34 / 7; Hauke/Bente/Momme: 21 / 5), die `shipOff()` (`trade.ts:567-590`) täglich **ohne Münz-Rückfluss** entfernt. Gleichzeitig zahlen sie Fahrpreise und kaufen von Sammlern/Siedlern, die Münzen nur ansammeln, bis `spoil()` alles über 50 Münzen vernichtet. Ohne kaufende Spieler laufen die Händler leer und können nichts mehr ankaufen.
- **N3 – Siedler-Eigenheiten (`server/npc/settlers.ts`):**
  - Bauen `PLANS = ["huette", "regentonne", "huehnerstall"]` (`L36`), rufen aber nie `einstallen` auf → Siedler-Hühnerställe bleiben leer.
  - Stellen Überschuss pauschal zu `2 + (round % 3)` Münzen ans Marktbrett (`L277`), unabhängig vom Warenwert; überteuerte Kleinteile blockieren bis zum Ablauf das 3-Angebote-Limit.
  - Essen, was sie an Essbarem gerade tragen (`L133-134`); sie stellen Nahrung nicht gezielt her und kaufen keine (am Marktbrett kaufen sie nur, was ihrer Baustelle fehlt, `L275-276`).
- **N4 – Asymmetrien in `server/npc/economy.ts`:**
  - `sammler` (`L360-384`) ruft nie `answerWanted` auf.
  - `handwerker` (`L470-496`) läuft vor `craft` nicht zu einem Bau — funktioniert heute nur, weil alle 5 Rezepte von Jorin/Piet kein `at` erfordern.

---

## 7. Testabdeckung, Hilfe, Dokumentation und offene Pläne

- **End-to-End-Epochentest (`tests/play/epochs.ts`):**
  - Prüft alle 4 Epochen über echte WebSocket-Befehle, nutzt aber gezielte Abkürzungen (`SPACES_MMO_NPCS: ""`, `work.rest: 0`, `epoch.force: 1|2|3|4`, direkte `place()`/`spawn()`/`Flame`/`Route`-Einträge). Dadurch deckt der Test Befehls-Semantik ab, aber keine organischen Progressions-, Licht- oder Wirtschafts-Engpässe.
  - Nicht abgedeckt in `epochs.ts`: `bienenstock`, `metzgerei`/`schlachte`, `salzgarten`/`harke`, `gerberei`, `gewaechshaus`, `trees` (`baum`/`fälle`), `interior` (`betrete`/`einladen`/`ausladen`), `sleep` (`schlafe`), `scenery` (`räume`), `siteorder` (`aushang`), `fest`/`zeige`, `segle`, `order`, echtes `beam <ziel>`.
- **Spielerhilfe und Hinweise (`client/help/articles.ts`, `client/hints.ts`):**
  - Alle 31 Baupläne und 68 Rezepte sind dokumentiert; `tests/help-prices.test.ts` sichert Preise und Abnehmer ab.
  - In `help.game.commands` (`articles.ts:405+`) fehlen **7 aktive Befehle**: `räume`, `betrete`, `einladen`, `ausladen`, `schlafe`, `baum`, `fälle` (das eine `einladen` dort gehört zu `gruppe …`).
  - In `help.game.village` (`#epochs`-Tabelle) fehlt **Bienenstock** in der Epoche-1-Zeile (`Fischerdorf`).
  - `client/hints.ts:15, 31` schlägt `bau <plan>` vor, ohne die aktuelle Insel-Epoche zu prüfen, und löst `stands`/`of`-Ersetzungen (`scheit` → `treibholz`) nicht selbst auf.
- **Abgleich mit `docs/de-docs/siedeln.md`:**
  - Der Kopfteil (`siedeln.md:3-8`, *„Stand der Umsetzung 2026-10-31“*) ist veraltet; im unteren Verlauf (`L1070-1151`) sind die Schritte 1–8 korrekt als umgesetzt dokumentiert.
  - **Noch nicht umgesetzt (offene Entwurfspunkte):** Automaten (Phase 6, Öl-Tank, `AutomatonCmdSet`, `Zahnrad`), Taubenschlag/Brieftauben, Kirche/Glockenturm, Brunnen, Trockengestell, Pflasterweg, Kräutergarten, Hecke, Botanischer Garten, Torf/Kohle/Eisenerz/Bergbau, Singvogel/Falke/Ochse/Pferd & wilde Vögel, Frost/Blüh-/Aussaatkalender, Grundstücks-Übergabe (`uebergib`/`verkaufe` auf Bauten), Innenräume für öffentliche Bauten (Kaufhaus/Rathaus) sowie optionaler Kampf (Modul K).

---

## 8. Priorisierte Maßnahmenliste

### Priorität 0 – Klare Engine-Bugs (behoben am 2026-11-19, in TypeScript und Rust)

Auf big und nano läuft nur die Rust-Engine; jede Änderung steht deshalb zweimal. Der Weg ist der von R8.2
(`docs/rust-portierung.en.md`, R-D8): erst TypeScript, dann die eingefrorene Vergleichs-Engine auf diesen Commit ziehen
(`FROZEN` in `rust/mmo-engine/tests/common/mod.rs`), dann dieselbe Änderung in Rust mit einer Vergleichszeile im Walk.
So ist es geschehen: TypeScript in `6cfb0cf`, `FROZEN` zeigt darauf, Rust im Commit danach
(`docs/rust-portierung.en.md`, Checkpoint 18).

1. **B1 und B5** (`build.ts` `buildSweep`, `build.rs` `build_sweep`): Die Schleife über `WorkRest`, `Blessing`,
   `BeamRest` vergleicht gegen die Lebensuhr und nimmt `Sated` mit. Auf big räumt der erste Sweep danach rund 70
   Einträge ab. Test: `tests/interior.test.ts` (die Uhren 100 Tage auseinander), Walk `sweeping`.
2. **B2** (`interior.ts` `dropInterior`, `interior.rs`): Der Nachlass eines Innenraums endet auf der Verfallsuhr.
   Nachlässe, die schon mit dem falschen Ende geschrieben wurden, behalten es; auf big gibt es keinen. Test wie bei 1.
3. **B3** (`wild.ts` `graze`, `wild.rs`): Nach dem Neuberechnen gilt der Düngefaktor wieder, wie `dünge` ihn anwendet
   (`Math.ceil(count * dung.factor)`). Test: `tests/prey.test.ts`, Walk `the_wild` (der Acker wird vor dem Nebel gedüngt).
4. **B4** (`animals.ts` `einstallen`, `animals.rs`): „eine Art je Stall“ zählt die Jungtiere mit. Test:
   `tests/animals.test.ts` (ein Schaf zu einem Ferkel), Walk `keeping_animals`.
5. **B6** (`road.ts` `roadSave`, `road.rs` `road_save_as`): Nur der erste Eintrag einer Straße (in `plan`) wird mit
   `{ unique: ["pair"] }` geschrieben; wer zu spät kommt, liest „Eine Straße nach … plant gerade jemand anderes.“ Die
   späteren Schreibvorgänge ersetzen den Eintrag in derselben Transaktion und bleiben ohne `unique`, wie bei `Epoch`.
   Test: `tests/cart.test.ts` (zwei planen zugleich, eine Straße steht).

### Priorität 1 – Spielregeln und Balance (umgesetzt am 2026-11-20, in TypeScript und Rust)

1. **E1:** Ein Baum zählt mit seinem Lichtpunkt zum Bestand seiner Insel (`epoch.ts` `islandPoints`; `epoche` nennt die
   Bäume), und die Grenze von 8 Bäumen gilt je Konto auf jeder Insel statt in der ganzen Welt (`trees.ts`).
2. **E2:** Straßen bleiben ein gemeinsames Werk ohne Licht und zählen 2 Punkte; behoben ist nur, dass eine abgelaufene
   Straße bis zum nächsten Tick weiterzählte (`road.ts` `routePoints`).
3. **E4:** Wer ein Beet umgräbt, einen Acker anlegt oder einen Baum pflanzt, zählt wie ein Bauender zu den Aktiven
   seines Feuers (`noteBuilder` in `garden.ts`, `field.ts`, `trees.ts`).
4. **E3:** Ein Feuer trägt einen Leuchtturm; ein zweiter wird abgelehnt, gebaut oder abgesteckt (`build.ts`). Türme, die
   schon stehen, bleiben.
5. **E5:** nicht angefasst (ohne Wirkung, oben).
6. **R1:** Der Entwurf folgt dem Code: Bauten arbeiten bei erloschenem Feuer weiter, und `siedeln` nennt, was ein
   erloschenes Feuer tatsächlich kostet.
7. **R2:** Fällt ein Lagerhaus in einer Siedlung, liegt sein Inhalt offen an seinem Platz (im Raum, auf seiner Ecke) statt
   im Nachlass des Besitzers (`build.ts` `buildSweep`). Die Truhe jedes anderen Baus bleibt Nachlass.
8. **R3:** `antrag abriss` und `antrag steuer` brauchen zwei Ja-Stimmen, wo zwei oder mehr Siedler wohnen
   (`townhall.ts`, die Siedler wie bei der Straßenwahl gezählt: Menschen mit Hütte oder Siedlerrang); abgelehnt wird mit
   „Dafür braucht es 2 Stimmen“.
9. **R4:** `karren entlade` und `zug abholen` nehmen, was die Tasche noch trägt; der Rest bleibt auf dem Karren oder am
   Bahnhof (`cart.ts`).
10. **R5:** Der Sweep räumt die Aufträge eines Kaufhauses ab, das nicht mehr steht (`build.ts`).
11. **R6:** „flammt auf“, „brennt“ und „ist erloschen“ hören alle Räume, die das Licht gerade deckt (`fire.ts`).
12. **R7:** Das Füttern eines fremden Wächters gibt den Dienst „tiere“; `settlementRanks` zählt nur stehende Bauten; die
    Fehlermeldungen nennen Dinge beim Namen („Dir fehlt: 3× Tang“); die drei unbenutzten Variablen sind weg (nur
    TypeScript).

### Priorität 2 – Wirtschaft und Welt (umgesetzt am 2026-11-20, Welt Version 55)

1. **W2:** Gesa führt 2 Küken und 1 Ferkel, Wilma 4 Salz.
2. **W1:** `kerze` ist eine Opfergabe der Kapelle. `borsten`, `kissen` und `gehaeuse` bleiben reine Handelsware.
3. **W3:** Auftragsarten tragen die Epoche ihrer Waren (`orders.kinds[].epoch`, 16 ab dem Dorf, 4 ab der Stadt), und
   eine Tafel hängt nur aus, was die Epoche ihrer Insel hergibt (`trade.ts` `ordersTick`). 15 Aufträge zahlen jetzt eine
   Münze mehr als der beste Händler ihrer Insel (für `proviant` und `kaese`: der Welt): `holz` 5, `muscheln` 3,
   `buendel` 6, `seile` 7, `kaiholz` 7, `riffholz` 7, `schaerenholz` 5, `schaerenmuscheln` 4, `rauchbuendel` 9,
   `krabbenholz` 7, `segel` 17, `kuchen` 33, `tuch` 17, `proviant` 17, `kaese` 15.
4. **N1 / N2:** Die Münzen eines NPCs, der ankauft, wachsen wie sein Warenbestand nach: eine je Welttag, bis zu dem, womit
   er anfing (`trade.ts` `restock`).
5. **W4** (Welt Version 56): Ein **Speiseschrank** aus der Werkstatt (5 Bohlen, 1 Leinen, mit Muschelmesser) hält in
   der Truhe die 15 gekochten Gerichte doppelt so lange. Nur Weltdatei: `keeps` ist generisch.
6. **W5:** Jorin verkauft das Holzbündel für 5 statt 4; damit zahlt auf keiner Insel ein Händler mehr, als ein anderer
   dort verlangt (ein Test hält das fest). Der Handel zwischen den Inseln (Tran, Bündel) bleibt: Die Überfahrt kostet 3.
7. **N3:** Siedler bauen eine Vogelscheuche statt eines Hühnerstalls, der leer stand (`PLANS`), und verlangen am
   Marktbrett eine Münze mehr, als der beste Händler ihrer Insel zahlt, statt pauschal 2 bis 4 (`askingPrice` in
   `server/npc/settlers.ts`, `asking_price` in Rust). Leere Ställe verfallen von selbst.
8. **N4:** Kein Verhalten geändert. Ein Test schlägt fehl, sobald ein NPC in `crafts` ein Rezept bekommt, das einen Bau
   braucht; dass Sammler keine Gesuche beantworten, bleibt.

### Priorität 3 – Dokumentation und Spielerführung (umgesetzt am 2026-11-20)

1. Die 7 Befehle stehen in `help.game.commands`, Bienenstock und Bäume in der Epochentabelle, dazu die neuen Regeln
   (Bäume je Insel, ein Leuchtturm je Feuer, Aufträge nach Epoche, zwei Stimmen für Abriss und Steuer), deutsch und
   englisch.
2. Der Hinweis „Fehlt so ein Bau, kann man ihn bauen“ nennt die Epoche des Bauplans („ab Dorf“).
3. Kopfteil von `siedeln` (deutsch und englisch) und die beiden Verzeichnisse der Dokumente sind nachgezogen.

---

## 9. Nachprüfung (2026-11-19)

Jede Aussage dieser Analyse wurde ein zweites Mal geprüft; was nicht stimmte, ist oben berichtigt.

| Aussage | Wie geprüft | Ergebnis |
| --- | --- | --- |
| Kopfzahlen der Welt | aus `world.json` gezählt | stimmen |
| Referenzintegrität | alle 1137 Prototyp-Verweise in `world.json` aufgelöst | keiner fehlt |
| Zyklenfreiheit | Graph aus Rezepten, Mühle, Fundorten, Tieren, Kulturen, Bäumen; Epoche jeder Ware als Fixpunkt | Schleifen mit Einstieg von außen, keine Blockade; kein Bauplan braucht eine spätere Epoche (oben berichtigt) |
| Befehlsparität | Tabelle aus der heutigen TypeScript-Engine mit `tests/r8/commands.ts` neu erzeugt | bytegleich mit `rust/mmo-engine/src/commands.json` |
| Abschnitt 2 (Schwellen, Formel, Tabelle, E1–E5) | Code und Einstellungen gelesen, Tabelle nachgerechnet | stimmen; E3 und E5 eingeordnet |
| W1, W2, W4, W5 | aus `world.json` berechnet | stimmen; W2 um Gesas Saat ergänzt |
| W3 | Lohn gegen den besten Ankaufspreis, Epoche der verlangten Waren | 14 unterbezahlte Aufträge stimmen; 12 statt 15 Auftragsarten brauchen spätere Epochen |
| B1–B6 | Code gelesen, in TypeScript und Rust | alle sechs in beiden Engines; B6 kann eintreten (16 Bahnen) |
| R1–R7 | Code gelesen, `siedeln.md` verglichen | stimmen |
| Münzquellen und -senken | jede Stelle, die Münzen erzeugt oder verbraucht | stimmen |
| N1–N4 | `world.json` gezählt, Skripte gelesen | stimmen; N3 genauer gefasst |
| Abschnitt 7 | `epochs.ts`, `articles.ts`, `hints.ts`, Code nach den offenen Entwurfspunkten durchsucht | stimmt; 6 statt 7 fehlende Befehle |
| Uhren und Bestand auf big | `WorldClock`, `Setting` und die betroffenen Eintragsarten der vier Regionen gelesen | Abschnitt 4.1 |
