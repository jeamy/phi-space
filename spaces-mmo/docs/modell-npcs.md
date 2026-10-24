# Modell-NPCs (Phase 5)

Figuren, hinter denen ein Modell (Agent aus `agent/`) steckt: eine Leuchtturmwärterin, die um Öl bittet, ein Erzähler
am Abend, ein Fremder im Nebel. Sie spielen über dieselben Textbefehle wie Menschen (`Intent`-Entries) und sind als KI
gekennzeichnet (`von: "npc"` in jeder Sicht und in der Anzeige). Sie kosten Tokens und sind standardmäßig aus
(`SPACES_MMO_LLM=0`).

## Feste Rollen

Welche Modell-NPCs es gibt, legt die Weltdatei fest (`worlds/<welt>/npcs.ts`), nicht der Zufall:

```ts
{ id: "waerterin", name: "Ines", ort: "Graue Bucht", rolle: "Hütet das Leuchtfeuer, bittet um Öl, kennt jede Boje.",
  persona: "…", plan: { tag: "06-22" }, wecken: ["fire.low", "person.enters", "spoken"], budgetTag: 40 }
```

- **Dauerhafte Identität:** Name, Ort, Rolle und eine **Zusammenfassung** dessen, was sie erlebt hat
  (`NpcMemory`-Entry, ≤ 4 KiB, nach jedem Gespräch vom Modell fortgeschrieben). Nach einem Neustart ist sie dieselbe
  Ines und erinnert sich an Stammgäste.
- **Plan:** Zeiten, in denen sie da ist (Ines 6 bis 22 Uhr Weltzeit, danach „zu Hause“; der Erzähler ab Abend). Wer
  nicht da ist, fehlt in der Welt, das ist Teil der Geschichte und kostet nichts.

## Drei Zustände

| Zustand | In der Welt | Modell | Kosten |
| --- | --- | --- | --- |
| **abwesend** | nicht da (Plan, Fähre fort) | nein | keine |
| **döst** | steht an ihrem Platz, Skript-Zeilen („Ines flickt ein Netz.“) | nein | keine |
| **wach** | spricht und handelt | ja | Tokens, zählt auf `SPACES_MMO_NPC_MAX` |

Sie wird **wach**, wenn ein Ereignis aus ihrer `wecken`-Liste eintritt, und schläft nach 5 Minuten ohne Ansprache und
ohne Ereignis wieder ein (der Entry `NpcAwake` hat eine Lease; läuft sie ab, ist sie wieder dösend). Ist
`SPACES_MMO_NPC_MAX` erreicht, wartet sie auf einen freien Platz und bleibt solange dösend (eine Zeile sagt: „Ines
ist in Gedanken.“).

## Ereignisse, die wecken oder Wanderer bringen

Alle Ereignisse kommen aus dem, was die Welt ohnehin schreibt (`changes` des Space, kein Polling):

| Ereignis | Quelle | Wer reagiert |
| --- | --- | --- |
| `person.enters` | Mensch betritt den Raum der Rolle | Rollen mit Ort in diesem Raum (Wärterin, Gerüchteküche) |
| `spoken` | Mensch spricht sie an oder nennt ihren Namen | die Angesprochene |
| `fire.low` | Feuerstand unter 20 % im Raum | Wärterin bittet um Öl; zählt auch als Ruf-Chance für Spieler |
| `fire.out` | Feuer erloschen | Wärterin ruft um Hilfe; Wanderer „Verirrter Fischer“ taucht im Nebel auf |
| `fog.dense` | Nebel Stufe 3 im Raum länger als 2 Minuten | Wanderer „Fremder“ fragt nach dem Weg |
| `tide.storm` | große Flut (viel Strandgut auf einmal) | Wanderer „Schiffbrüchiger“ liegt am Strand und braucht Hilfe |
| `ferry.arrives` | Fähre legt an (fester Plan) | Wanderer „Händler“ bietet Waren an |
| `market.stale` | Angebot am Marktbrett ohne Käufer länger als 30 Minuten | Händlerin macht ein Gegenangebot |
| `newcomer` | ein Gast betritt die Welt zum ersten Mal | Erzähler/Wärterin begrüßt und erklärt in zwei Sätzen |
| `evening` | Weltzeit 20 Uhr | Erzähler beginnt eine Geschichte, wenn Leute in der Taverne sind |
| `creature.appears` | Nebelwesen taucht auf | Wärterin warnt im Kanal *hafen* |

**Wanderer** sind eigene Rollen (`wanderer: true`) mit Lebensdauer: Sie erscheinen nur durch ihr Ereignis, höchstens
einmal je Ereignis und 30 Minuten, bleiben bis ihr Anliegen erledigt ist oder 10 Minuten ohne Ansprache vergangen sind
und gehen dann in der Geschichte weiter („Der Fremde verschwindet im Nebel“). Ein Wanderer ohne Anwesende wird gar
nicht erst wach: Erscheint er, wenn niemand im Raum ist, bleibt er stumm und geht nach 2 Minuten.

Das Wecken ist billig, weil das Skript nur Ereignisse zählt; erst die erste Antwort ruft das Modell.

## Kosten und Grenzen

- `SPACES_MMO_LLM` (aus/an), `SPACES_MMO_NPC_MAX` (gleichzeitig **wache** NPCs, Standard 10), Tageskontingent je NPC
  (`budgetTag` in der Rolle, Modellaufrufe pro Weltzeit-Tag) und ein gemeinsames Kontingent wie in codemode-chat
  (`quota.ts`). Alle Werte im Konfigurationsfenster des Admins ([automaten.md](automaten.md#einstellungen-für-betreiber)).
- **Budget leer:** der NPC bleibt, schweigt und zeigt eine Skriptzeile („Ines brütet über dem Feuer.“) bis zum
  nächsten Tag. Er verschwindet nicht.
- Pro wachem NPC höchstens ein Modellaufruf zugleich, höchstens 6 pro Minute; Antworten auf `Intent`s mehrerer Spieler
  werden zu einem Aufruf zusammengefasst.
- Das Modell sieht dieselbe `sicht` wie ein Automat (Raum, Leute, Gehörtes), ergänzt um seine `NpcMemory`; es sieht nie
  Konten, Passwörter oder Daten anderer Räume.
- Eigene Automaten und die Wartezeit für Codewechsel: [automaten.md](automaten.md#agenten-als-besitzer-von-automaten).

## Prozess

Der Prozess `npc` (`server/npc-host.ts`) hält je Rolle einen kleinen Zustandsautomaten (abwesend/döst/wach), schreibt
Skriptzeilen und nur im Zustand *wach* Modellantworten als `Intent`s. Er darf nur `Intent`, `NpcMemory`, `NpcAwake` und
`NpcLog` schreiben. Er lässt sich mehrfach starten (die Rollen verteilen sich über eine Lease je Rolle).

## Abnahme

- Mit `SPACES_MMO_LLM=0` laufen alle Rollen als dösende Skript-NPCs, kein Modellaufruf.
- Mit geskripteten Modellen (Systemnachrichten vor dem Prüfen der letzten Nachricht herausfiltern, siehe
  `docs/examples.md`): `fire.low` weckt Ines, nach 5 Minuten ohne Ansprache schläft sie wieder ein, `NpcAwake` läuft ab.
- `SPACES_MMO_NPC_MAX=1` und zwei Weckereignisse: genau eine Rolle ist wach, die andere wartet und kommt dran, sobald
  die erste einschläft. Schlafende und abwesende zählen nicht.
- Ein Wanderer erscheint nur durch sein Ereignis, höchstens einmal je 30 Minuten, und geht nach Erledigung oder nach
  10 Minuten ohne Ansprache.
- Leeres Tagesbudget: kein Modellaufruf, Skriptzeile statt Antwort, am nächsten Tag geht es weiter.
- Neustart des `npc`-Prozesses: Zustände und `NpcMemory` bleiben, kein Doppelstart einer Rolle bei zwei Prozessen.
- Ein Live-Lauf mit echtem Modell nur auf ausdrückliche Freigabe.
