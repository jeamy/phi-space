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
| Accounts | Entry `Account` (außerhalb der Spielwelt), Identität aus dem Web-Login | Gäste: kurzlebige Accounts mit Lease |
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
