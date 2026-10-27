# Evennia → phi-spaces

Vorlage: [Evennia Components Overview](https://www.evennia.com/docs/latest/Components/Components-Overview.html).
Evennia hält seine Welt in einer relationalen Datenbank (Django) und Python-Klassen. Bei uns ist die Welt eine Menge
von Entries in einem Space; Verhalten steckt in Workern, die Entries nehmen und schreiben.

## Grundsätze

- **Ein Spielobjekt = ein Entry.** `id` ist die Objekt-ID, `fields` sind seine Attribute.
- **Typklassen = Entry-Typen mit Subtypen.** Templates matchen über Subtypen (`core.matches`: `e.types` enthält
  `t.type`). Ein Schwert hat die Typen `["Object", "Item", "Weapon", "Sword"]`; `readAll({ type: "Item", fields: {
  location: roomId } })` findet es mit allen anderen Gegenständen im Raum.
- **Templates sind Gleichheit pro Feld.** Fehlende oder `null`-Felder sind Wildcards, Werte werden tief verglichen,
  es gibt keine Bereiche und keine „enthält“-Abfrage auf Arrays. Daraus folgt: alles, wonach gesucht wird, ist ein
  eigenes skalares Feld (`location`, `owner`, `zone`) oder ein eigenes Entry (Tags, siehe unten).
- **Änderung = take + write in einer Transaktion.** Ein Objekt wird nicht „bearbeitet“, sondern genommen und neu
  geschrieben. Das ist zugleich das Sperrkonzept: Wer ein Objekt gerade verändert, hält es.
- **Nur die Welt schreibt Weltzustand.** Browser und Agenten schreiben ausschließlich `Intent`-Entries. Durchgesetzt
  über `Policy` in `src/service.ts` (`RolePolicy.types`): Rolle `player` darf nur `Intent` schreiben; Rolle `world`
  darf alles.

## Komponenten im Einzelnen

### Basiskomponenten

| Evennia | phi-spaces | Bemerkung |
| --- | --- | --- |
| Typeclasses | Entry-Typenliste + Verhaltensmodul pro Typ im Welt-Worker | Ein Registry `typeclass → Hooks` (`atGet`, `atDrop`, `atTraverse`, `atTick` …) |
| Objects | Entry `Object` mit `name`, `desc`, `location` | `location` ist eine Entry-ID (Raum, Charakter, Behälter) |
| Rooms | Entry `["Object","Room"]` mit `zone`, `grid` (Kachelkarte, Phase 3) | Kein `location` |
| Exits | Entry `["Object","Exit"]` mit `location` (Startraum), `destination`, `dir` | Durchgang = Hook `atTraverse` |
| Characters | Entry `["Object","Character"]` mit `account`, `location`, `x`, `y` | Spielfigur, auch für NPCs |
| Accounts | Entry `Account{id, name, perms, guest}` (außerhalb der Spielwelt), Identität aus dem Web-Login | Gäste mit Lease; Registrierung wandelt dasselbe Konto um. Passwort-Hash nur als `Credential` im eigenen Space `accounts` |
| Sessions | Entry `Session` mit Lease, gehalten vom Gateway, `renew` solange die WebSocket offen ist | Abbruch → Lease läuft ab → Charakter „schläft“ |
| Scripts | Worker + Entries mit Lease (`Script{target, kind, interval}`) | Zeitlogik ohne eigene Threads |
| Channels | Entry `Channel` + `ChannelMsg{channel, from, text}` mit Lease | Wie `ChatMessage` in codemode-chat |
| Msg / TempMsg | `Msg{to, text}` mit kurzer Lease; TempMsg = gar nicht geschrieben, direkt vom Gateway | Ausgabe an Sessions |
| Attributes | `fields` des Entries | Große/seltene Daten als eigenes Entry `Attr{target, key, value}` |
| NAttributes (nicht persistent) | Speicher im Welt-Worker | Nur Cache, nach Neustart aus dem Space rekonstruierbar |
| Nicks | Entry `Nick{account, from, to}` | Gateway ersetzt vor dem Schreiben des Intents |
| Tags | Entry `Tag{target, key, category}` | Weil Templates kein „Array enthält“ können; Suche: `readAll({type:"Tag", fields:{key, category}})` |
| Aliases | Tag mit `category: "alias"` | |
| Spawner / Prototypes | Entry `Prototype{key, parent, types, fields}` | Spawnen = Prototyp lesen, Vererbung auflösen, Objekt schreiben |
| Help System | Entry `HelpEntry{key, category, text}` | Gleiches Prinzip wie die Hilfeartikel der help-site |
| Permissions | Feld `perms` am Account + Rollen der `Policy` | Builder/Admin entsprechen Evennias Hierarchie |
| Locks | Feld `locks` (Lock-String wie bei Evennia, z. B. `get:perm(Builder) or holds(key_7)`) | Ausgewertet im Welt-Worker vor jedem Hook |
| Portal / Server | Web-Prozess (Gateway) / Space-Host + Welt-Worker | Wie bei Evennia überlebt das Portal einen Neustart der Welt |

### Befehle

| Evennia | phi-spaces | Bemerkung |
| --- | --- | --- |
| Commands | `Intent{actor, session, line, seq}` + Befehlsklasse im Welt-Worker | `parse()` / `func()` wie bei Evennia |
| Command Sets | Befehlsmengen pro Charakter, Raum und getragenem Objekt, beim Ausführen zusammengeführt | Merge-Regeln (Union, Replace, Priorität) wie bei Evennia; Quelle ist der Weltzustand, kein zusätzlicher Speicher |
| Default Commands | `look`, `go`/Richtungen, `get`, `drop`, `give`, `inventory`, `say`, `emote`, `help`, `who` | Phase 0/1 |
| Builder-Befehle | `dig`, `open`, `create`, `spawn`, `set`, `tag`, `lock`, `destroy` | Nur mit `perm(Builder)` |
| Batch Processors | Weltdateien (JSON/TS) → `npm run world:load`; geladen in einer Transaktion | Idempotent über feste IDs |
| Inputfuncs | WebSocket-Nachrichten `{t:"cmd"}`, `{t:"move"}`, `{t:"ping"}` | Grafik-Klicks werden zu Textbefehlen (`move 4 7`) |
| Outputfuncs | Gateway-Frames `{t:"text"}`, `{t:"room"}`, `{t:"delta"}` | Text und Karte getrennt |

### Hilfsmittel

| Evennia | phi-spaces |
| --- | --- |
| EvMenu | Dialog-Entry `Menu{session, node, state}` mit Lease; Knoten als Daten |
| EvTable / EvForm / EvMore | Formatierung im Welt-Worker, Paging im Client |
| EvEditor | Mehrzeiliges Eingabefeld im Browser; Ergebnis als ein Intent |
| FuncParser | Inline-Funktionen in Beschreibungen (`$you()`, `$conj()`), ausgewertet vor der Ausgabe |
| TickerHandler | Ein Ticker-Worker; Abonnements als `Ticker{target, every}` |
| OnDemandHandler | Zeitstempel im Entry, Zustand wird beim Lesen ausgerechnet (Pflanzen wachsen, Feuer brennt herunter) |
| MonitorHandler / Signals | `changes(afterRev)` im Gateway und im Welt-Worker; `notify` für einzelne Muster |

### Web

| Evennia | phi-spaces |
| --- | --- |
| Webclient | Next.js-App: Textlog + Befehlszeile + Kachelkarte |
| Web Admin | Adminbereich wie help-site/codemode-chat (`AdminPanel.tsx`), plus Dashboard (`npm run dashboard`) |
| REST API | Lesende HTTP-Endpunkte des Web-Prozesses (`/api/who`, `/api/room/:id`) |

## Ablauf eines Befehls

```
Browser   ──ws {t:"cmd", line:"get treibholz"}──▶  Gateway (Web-Prozess)
Gateway   ── write Intent{actor, session, line, seq} (Lease 30 s) ──▶  Space
Welt      ── take Intent  (txn) ─────────────────────────────────────▶  Space
Welt      cmdset zusammenführen → Befehl finden → parse → Locks prüfen
Welt      readAll Flotsam{location:raum} → Namensabgleich „treibholz“ im Worker → id
Welt      ── take {id}                                     (txn)
Welt      ── write Item{…, location: charakter}           (txn)
Welt      ── write Msg{to: raum, text:"$you() hebt Treibholz auf."} (txn)
Welt      ── commit
Gateway   changes() → Delta für alle Sessions im Raum → ws {t:"text"}, {t:"delta"}
```

Schlägt der `take` fehl, weil jemand schneller war, bricht die Transaktion ab und der Spieler bekommt „Zu spät –
jemand anderes war schneller.“ Doppelte Gegenstände sind ausgeschlossen, ohne dass der Welt-Worker eine eigene Sperre
braucht.

`seq` pro Session hält die Reihenfolge; mehrere Welt-Worker dürfen parallel arbeiten, solange Befehle desselben
Charakters nacheinander laufen (ein `ActorLock`-Entry pro Charakter, wie `RoomLock` in codemode-chat).

## Bewusste Abweichungen von Evennia

- **Keine Python-Klassenvererbung in der Datenbank.** Typen sind Daten, Verhalten ist Code im Welt-Worker. Ein
  Neustart lädt keine Klassenpfade, sondern liest Typnamen.
- **Kein globaler Objekt-Cache als Wahrheit.** Der Welt-Worker darf cachen, aber die Wahrheit ist der Space. Nach einem
  Absturz ist der Zustand der letzte Commit.
- **Ausgabe ist Weltzustand** (`Msg`-Entries) und nicht ein Funktionsaufruf an Sessions. Dadurch sehen Agenten,
  Zuschauer und ein neu verbundenes Gerät denselben Verlauf.

## Stand Phase 1

Umgesetzt in `server/engine/` (Engine) und `worlds/leuchtfeuer/world.ts` (Welt). Wo die Umsetzung von den Tabellen oben
abweicht:

- **Gegenstände** sind Entries ihres Typklassen-Typs mit den Obertypen `Item` und `Object` (eine Münze: `Coin` <
  `Item` < `Object`); Felder `itemId`, `name`, `aliases`, `desc`, `location` (Raum oder Figur), `x`/`y`, `glyph`,
  `locks`, `proto`. Figuren behalten `room` statt `location`: Eine Figur steht immer in einem Raum.
- **Ausgänge** liegen auf einer Kachel (`x`/`y`) und haben eine Ankunftsstelle (`arrive`). Betreten der Kachel oder
  `go <name>` oder nur der Name führt hindurch. Statt eines `atTraverse`-Hooks prüft der Welt-Worker den Lock
  `traverse`.
- **Hooks** (`atGet`, `atDrop` …) gibt es noch nicht; das Verhalten steckt in den Befehlen, die Typklassen tragen nur die
  Typkette. Das kommt, sobald eine Welt eigenes Verhalten braucht (Phase 2: Feuer, Flut).
- **Command Sets:** Standard (Priorität 0), Builder (1, mit `cmd`-Lock pro Befehl), ein Befehl je Ausgang (10). Sets an
  getragenen Objekten kommen später.
- **Locks:** `all()`, `none()`, `perm(Stufe)`, `id(figur)`, `holds(itemId|prototyp)`, `guest()`, `not`, `and`, `or`,
  Klammern. Stufen Guest < Player < Builder < Admin; ein Admin hat alle, `perm <name> = Builder` vergibt Builder. Ein
  gespeicherter Lock-String, der nicht parst, verweigert.
- **FuncParser:** `$you()` und `$conj(du-form|andere-form)`; deutsche Verben sind unregelmäßig, deshalb nennt `$conj`
  beide Formen. Das Gateway rendert pro Empfänger, auch den Verlauf in der Begrüßung.
- **Prototypen** stehen vollständig in der Welt; `parent` vererbt Felder, die ein Kind leer lässt.
- **Laden der Welt:** unter `Lock{name:"world"}` in einer Transaktion. Fehlende Teile werden immer geschrieben; Räume,
  Ausgänge, Prototypen und Hilfe werden ersetzt, wenn die Welt eine neuere `version` hat (oder `--replace`). Ein
  platzierter Gegenstand entsteht nur beim (Neu-)Laden und nur, wenn es seine `itemId` nirgends gibt.
- **Gegenstandsgrafik:** Glyphen (Kreis, Quadrat, Raute) statt Sprites, weil die Gegenstands-Icons von Intersect-Assets
  meist CC BY-SA 3.0 sind.
- **Reihenfolge pro Figur:** Jede Figur hat ein `ActorToken`. Ein Welt-Worker nimmt es in die Transaktion des Befehls,
  dann den ältesten Auftrag dieser Figur, und legt es beim Commit zurück. Befehle einer Figur laufen so nacheinander und
  in der gesendeten Reihenfolge, Befehle verschiedener Figuren parallel auf mehreren Workern. Stirbt ein Worker, kehrt
  das Token mit seiner Transaktion zurück. Tokens entstehen mit der Figur; für ältere Figuren schreibt sie jeder Worker
  beim Start (unter der Welt-Sperre).
- **Sprache:** Jeder Befehl hat einen englischen Schlüssel und deutsche Aliase (`get`/`nimm`, `dig`/`grabe`,
  `examine`/`untersuche` …); beide gelten immer, ohne Umschalter, und `help` zeigt alle Namen. Gegenstände und Ausgänge
  haben auch englische Aliase (`driftwood`, `shell`, `east`). Ausgaben in der Sprache des Empfängers (`names: {de, en}`,
  siehe [automaten.md](automaten.md#sprache-deutsch-und-englisch)) folgen später; bis dahin sind die Meldungen deutsch.
  Schon platzierte Gegenstände behalten die Aliase, mit denen sie entstanden sind.

## Stand Phase 2

- **Scripts/TickerHandler** sind seit der Weltzeit ([weltzeit.md](weltzeit.md)) `WorldSchedule{scheduleId, dueWorldMs, kind,
  payload}`-Einträge: Jeder Welt-Worker schaut; wer einen fälligen Termin nimmt (in einer Transaktion), führt den Job aus und
  schreibt den nächsten Termin in derselben Transaktion. So läuft jeder Job genau einmal, egal wie viele Worker laufen. Jobs
  (Art `tick`): `fire` (bemerkt erloschene Feuer), `fog` (ein Nebelschritt), `flood` (Strandgut), `storm`, `sweep`, `orders`, `market`.
  Ein neuer Termin ist erst nach seinem Intervall fällig. (Vorher: `Ticker{key, due}` in Echtzeit.)
- **OnDemand statt Zählen:** Die Brenndauer wird nicht heruntergezählt. Der `Flame`-Eintrag sagt, bis zu welcher **Weltzeit** er
  brennt (`until`); die Uhr entscheidet, ob er brennt, und eine angehaltene Welt behält ihr Feuer. Nachlegen nimmt den
  `Beacon`-Eintrag als Sperre, nimmt Brennstoff und alte Flamme und schreibt eine längere (höchstens `fire.maxMs`). Der
  Fire-Termin schreibt nur den Zustand `lit` und die Meldung.
- **Nebel** ist ein `Fog{room, level}`-Eintrag je Raum, den ein Leuchtfeuer abdeckt (`covers`). Ausgänge mit `fogMax`
  sind bei dichterem Nebel zu; der Welt-Worker lehnt den Durchgang ab.
- **Strandgut** sind Gegenstände mit `flotsam: true` und einer Lease (`flood.lifetimeMs`); wer eins aufhebt, schreibt
  es ohne Lease neu, dann bleibt es.
- **Kanäle:** statt eines eigenen `ChannelMsg`-Typs eine `Msg` mit `to: "#hafen"`, die das Gateway an alle schickt.
- **Ruf:** `Contribution{beaconId, charId, pieces, ms}` je Figur und Feuer, unter der Feuer-Sperre hochgezählt.
- **Skript-NPCs** (Prozess `npc`, `server/npc/`): Figuren mit eigenem Konto (`npc: true`), vom Loader angelegt. Sie halten
  eine Session und schreiben nur Intents, einen nach dem anderen. Ihre Namen sind für Registrierungen gesperrt.
- **Spielzeit:** Die Welt hat eine Uhr (`WorldClock`, [weltzeit.md](weltzeit.md)): Brenndauer, Nebelschritt, Flut, Fristen und
  die Timer der NPCs laufen in Weltzeit; `SPACES_MMO_TIME_SCALE` ist nur noch die Anfangsrate einer neuen Uhr. Leases des
  Systems (Sessions, Transaktionen, Rollen) bleiben Echtzeit.

### Kollision

Zwei Figuren stehen nie auf derselben Kachel (`server/engine/occupancy.ts`). Belegt ist eine Kachel nur von Figuren, die
online sind; eine Offline-Figur ist nicht auf der Karte und blockiert niemanden.

- Eine Figur, die online ist, hält ihre Kachel als `Spot`-Entry (`room`, `x`, `y`, `charId`, `name`). Ein Schritt schreibt
  den neuen `Spot` mit der `unique`-Prüfung des Space auf Raum und Kachel und nimmt den alten weg, beides in der
  Transaktion des Befehls. Der Space weist einen zweiten `Spot` auf derselben Kachel ab, auch wenn der erste erst in
  einer offenen Transaktion geschrieben ist. Prüfen und Betreten sind damit ein Schritt, auch über mehrere Welt-Worker
  (Test: zehn Spieler laufen gleichzeitig auf eine Kachel, genau einer kommt an).
- Es gibt keine Sperre je Raum mehr: Schritte im selben Raum laufen nebeneinander, nur zwei Schritte auf dieselbe Kachel
  schließen sich aus. Bis 2026-10-27 nahm jeder Schritt das `RoomToken` seines Raums; alle Schritte eines Raums liefen
  damit nacheinander, und ein Schritt gegen eine besetzte Kachel verlor das Token (siehe [betrieb.md](betrieb.md#last-und-latenz)).
- Der `Spot` einer Figur, die offline gegangen ist, blockiert niemanden: Wer auf die Kachel tritt, übernimmt ihn in seiner
  Transaktion. Der Welt-Worker räumt solche `Spot`s außerdem alle 30 s weg (`SPACES_MMO_SPOT_SWEEP_MS`).
- Leuchtfeuer stehen fest, wo die Weltdefinition sie hinstellt; ihre Kacheln kommen aus der Welt, nicht aus dem Space.
- `step` auf eine besetzte Kachel wird abgelehnt („Dort steht schon …“). `move` sucht einen Weg um Figuren herum. Eine
  belegte Ankunftsstelle eines Ausgangs führt auf die nächste freie Kachel, nie auf eine Ausgangskachel.
- Neue Figuren entstehen auf einer freien Kachel. Beim Verbinden schickt das Gateway `arrive`: Steht inzwischen jemand
  auf der Kachel der Figur, tritt sie auf die nächste freie.

## Stand Phase 4

- **Tausch ohne Treuhand:** Ein `Offer` nennt die angebotenen Gegenstände (sie bleiben im Inventar des Anbieters) und
  die Wünsche (Name und Anzahl). `accept` nimmt in einer Transaktion beide Seiten und schreibt sie getauscht; fehlt
  etwas, bricht alles ab. Ein Angebot lebt zwei Minuten echte Zeit.
- **Markt mit Treuhand:** Beim Einstellen geht die Ware an den Ort `market` (mit `listing` und `seller`), das `Listing`
  hat ein Weltzeit-Ende (`expiresWorldMs`; die Aufräumrunde `sweep` nimmt es). Kaufen nimmt Listing, Münzen und Ware in einer Transaktion. Ein Ticker (`market`) gibt Ware zurück,
  deren Listing es nicht mehr gibt; ein gerade gehaltenes Listing gilt als lebendig.
- **Auftragstafel (Master–Worker):** Die Welt schreibt `Order`-Einträge (Ticker `orders`), ein Spieler nimmt einen per
  `take` und schreibt ihn mit `takenBy` zurück; Liefern verbraucht die Dinge und erzeugt den Lohn.
- **Handwerk:** Rezepte stehen in der Welt; ein Werkzeug trägt `wear` und zerbricht bei 0. Das ist eine Zählung pro
  Benutzung statt OnDemand-Zeit.
- **Gäste** können weder tauschen noch handeln noch Aufträge annehmen; die Liste ansehen dürfen sie.
- **Grenze:** Angebote und Aufträge sind bisher nur Textbefehle; die Seite zeigt sie im Log, ohne eigene Knöpfe.
