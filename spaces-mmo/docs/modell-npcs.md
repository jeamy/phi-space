# Modell-NPCs (Phase 5)

**NPC** steht für *Non-Player Character*, eine Nicht-Spieler-Figur: eine Figur der Welt, die kein Mensch steuert,
sondern ein Skript oder ein Sprachmodell (hier Ines, die Wärterin des Leuchtfeuers, Bo, der Fährmann, und der Fremde
im Nebel). NPCs haben ein registriertes Konto (kein Gastkonto) und dürfen alles, was angemeldete Spieler dürfen:
sprechen, laufen, aufheben, ablegen, nachlegen, weitergeben, tauschen, am Markt kaufen und verkaufen, herstellen,
Aufträge annehmen. Bauen und Rechte vergeben dürfen sie nicht, so wenig wie ein Spieler ohne Bau- oder Adminrecht.

Figuren, hinter denen ein Modell (Agent aus `agent/`) steckt: eine Leuchtturmwärterin, die um Treibholz bittet, ein Erzähler
am Abend, ein Fremder im Nebel. Sie spielen über dieselben Textbefehle wie Menschen (`Intent`-Entries) und sind als KI
gekennzeichnet (`von: "npc"` in jeder Sicht und in der Anzeige). Sie kosten Tokens und sind standardmäßig aus
(`SPACES_MMO_LLM=0`).

## Feste Rollen

Welche Modell-NPCs es gibt, legt die Weltdatei fest (`worlds/<welt>/npcs.ts`), nicht der Zufall:

```ts
{ id: "waerterin", name: "Ines", ort: "Graue Bucht", rolle: "Hütet das Leuchtfeuer, bittet um Treibholz, kennt jede Boje.",
  persona: "…", plan: { tag: "06-22" }, wecken: ["fire.low", "person.enters", "spoken"], budgetTag: 40 }
```

- **Dauerhafte Identität:** Name, Ort, Rolle und eine **Zusammenfassung** dessen, was sie erlebt hat
  (`NpcMemory`-Entry, ≤ 4 KiB, nach jedem Gespräch vom Modell fortgeschrieben). Nach einem Neustart ist sie dieselbe
  Ines und erinnert sich an Stammgäste.
- **Plan:** Zeiten, in denen sie da ist (Ines 6 bis 22 Uhr Weltzeit, danach „zu Hause“; der Erzähler ab Abend; Vertrag
  und Implementierungsweg siehe [weltzeit.md](weltzeit.md)). Wer
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
| `fire.low` | Feuerstand unter 20 % im Raum | Wärterin bittet um Treibholz; zählt auch als Ruf-Chance für Spieler |
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
- **Nur Menschen wecken:** Nachrichten tragen die `fromId` des Sprechers; was NPCs sagen (auch die Bewohner aus
  [welt.md](welt.md)), weckt keine Modellrolle und hält sie nicht im Gespräch.
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

## Stand

Umgesetzt in `server/npc/minds.ts`, `server/npc/scripts.ts`, `server/npc-host.ts`, `server/llm.ts`; Abnahme in
`tests/phase5.test.ts` mit einem geskripteten Modell (`tests/fake-llm.ts`). Abweichungen vom Entwurf oben:

- **Rollen in der Weltdatei:** in `worlds/leuchtfeuer/world.ts` (Feld `model` an den NPCs, `wanderer` für Wanderer),
  nicht in einer eigenen `npcs.ts`. Rollen bisher: Ines (Wärterin) und der Fremde (Wanderer bei `fog.dense`).
- **Kein Plan (abwesend nach Uhrzeit):** Die Welt hat noch keine Weltzeit; Ines ist immer da, der Fremde nur durch
  sein Ereignis. Der noch nicht implementierte Vertrag steht in [weltzeit.md](weltzeit.md).
- **Ereignisse:** bisher `fire.low`, `fire.out`, `spoken`, `person.enters`, `offer` (jemand bietet ihr einen Tausch
  an), `fog.dense`. Die npc-Prozesse lesen dafür
  alle paar Spielsekunden den Space (Feuer, Nebel, Nachrichten, Anwesende), statt dem Änderungsstrom zu folgen.
- **Was ein Modell darf:** jeden Befehl eines angemeldeten Spielers, der etwas bewirkt (`say`, `emote`, `move`,
  `step`, `go`, `get`, `drop`, `put`, `give`, `offer`, `accept`, `decline`, `market`, `craft`, `order`); das Modell
  bekommt die Hilfetexte der Befehle selbst (`server/npc/minds.ts`), die Liste kann also nicht vom Spiel abweichen.
  Befehle, die nur etwas zeigen (`look`, `inventory`, `who`, …), fehlen: ihre Antwort käme nach der des Modells, und was
  sie zeigen, steht schon in der Lage. Höchstens vier Zeilen je Antwort, dazu eine `NOTE:`-Zeile fürs Gedächtnis
  (`NpcMemory`, höchstens 4 KiB, älteste Notizen fallen weg). Die Zeilen laufen wie die eines Spielers als `Intent`
  durch den Welt-Worker (Reichweite, Kollision, Sperren, Transaktion); was misslingt, misslingt wie bei einem Spieler.
- **Was ein Modell sieht (die Lage):** Gedächtnis, Ort, Anwesende, Feuerstand und -position, die eigene Position, was
  es trägt, was im Raum liegt (mit Zellen), die Ausgänge, Tauschangebote an es, am Markt das Marktbrett, Ereignis und
  Gehörtes; nie Konten. Bittet jemand Ines, Holz nachzulegen, tut sie es, wenn sie Holz trägt, und sagt sonst, warum
  nicht; bietet man ihr Holz an, nimmt sie es an.
- **Wach und Rollen:** `NpcAwake` (Lease 5 Spielminuten, bei jeder Ansprache erneuert) und `NpcOwner` (Lease je Rolle,
  `SPACES_MMO_NPC_ROLE_LEASE_MS`) werden unter `Lock{name:"npc"}` geschrieben; so sind nie mehr als
  `SPACES_MMO_NPC_MAX` wach und keine Rolle läuft doppelt. Eine übernommene Rolle startet mit frischem Skript.
- **Budget leer:** eine Dös-Zeile der Rolle („Ines flickt ein Netz.“) statt der Antwort; volles NPC_MAX: „ist in
  Gedanken.“
- **Zusammenfassen mehrerer Spieler** zu einem Aufruf: Alles, was seit der letzten Runde gesagt wurde, geht in einen
  Aufruf. Höchstens ein Aufruf je NPC zugleich ergibt sich aus der Runde; eine eigene Grenze von 6 pro Minute gibt es
  nicht (die gemeinsame Minutengrenze gilt).
- **Kennzeichnung:** Figuren und Nachrichten von Modellrollen tragen `ai` und erscheinen als „Name (KI)“ bzw. mit
  „KI“-Marke im Log.

## Dauerhafte Dialoge

Alle Modellrollen behalten standardmäßig ihren Gesprächskontext über einen NPC-Prozessneustart hinweg.
`SPACES_MMO_DURABLE_NPCS=0` schaltet zurück auf einzelne Modellaufrufe; eine Liste wie `ines,fremder` beschränkt
die dauerhaften Dialoge auf diese Rollen. Nicht-Modell-NPCs bleiben reine Skriptrollen.
`SPACES_MMO_LLM=1`, Zugangsdaten und die Modellfreigabe des Admins bleiben erforderlich.

```sh
SPACES_MMO_LLM=1 node --experimental-strip-types spaces-mmo/server/npc-host.ts
```

Die [Anbindung](../server/npc/durable.ts) startet den getrennten Agentenprozess erst bei einem ausgewählten
Modell-NPC. Standardpfad ist `<SPACES_MMO_DATA oder .local>/npc-agents/<Welt-ID>/<Region oder world>.sqlite`.
`SPACES_MMO_DURABLE_STORE` überschreibt ihn. Jede Welt/Region bekommt damit eine eigene Datei;
weitere NPC-Prozesse derselben Welt/Region brauchen jeweils einen ausdrücklich anderen Pfad.
Ein Speicher gehört genau einem Worker. Die Rollenverteilung bleibt die geleaste `NpcOwner`-Verteilung im
Space; die Agentendatenbank ist keine zweite Rollenverwaltung und wird nicht über Hosts repliziert.
Sie verwendet WAL/`synchronous=FULL` statt des Upstream-Standards NORMAL.
[Sync-Policy und Stromausfall-Testgrenzen](../../docs/agenten-stromausfalltest.md) sind separat dokumentiert.

- Eine Sitzung ist nach Welt-ID und NPC-ID getrennt; andere Rollen und Welten sehen deren Dialog nicht.
- Je Antwort höchstens ein Modellversuch und 200 Ausgabetokens, ohne automatische SDK-/Harness-Retries oder
  Compaction-Aufrufe. Freigabe und bestehende NPC-/UTC-Budgets werden unmittelbar vor dem wirklichen Modellaufruf
  geprüft, nicht nur in einem unverbindlichen Harness-Hook.
- Die letzte Lage ist maßgeblich. Nach einem Neustart wird bei einer neuen Lage ein noch offener alter Turn
  abgebrochen, statt alte Spielbefehle nachträglich auszuführen.
- Das Ergebnis geht durch dieselbe Zeilen-/Befehlsprüfung und dann als `Intent` zum World-Worker. Der Agent hat
  keine direkten Welt-, Shell- oder Dateiwerkzeuge. Abschalten des NPC-Prozesses bricht seine Agentenantwort ab.
- `NpcMemory` und `NOTE:` bleiben die fachliche Zusammenfassung im Space. Nach 64 abgeschlossenen Dialogantworten
  beginnt eine neue Conversation mit der aktuellen Lage und dieser Zusammenfassung. Das begrenzt den aktiven
  Kontext, löscht aber keine früheren Transkripte.

Die bestehende Quotenlogik zählt **Aufrufe, nicht Tokens oder Euro**. Gesprächshistorie erhöht die Eingabetokens
und kann deshalb auch bei gleicher Aufrufzahl mehr kosten. Transkripte enthalten Spieleräußerungen; Zugriff,
Aufbewahrung und Sicherung des Agentenspeichers sind separat zu planen.
Die Compose-NPC-Services mounten dafür `mmo-agent-data` unter `/data` und verwenden getrennte Welt-/Regionsdateien;
der Dev-Container verwendet sein vorhandenes `/data`-Volume. Eigene abweichende Pfade müssen zusätzlich gemountet
werden. Kein Deployment erfolgt automatisch.

[Offline-Regressionsprüfung](../tests/durable-npcs.test.ts): Wiederöffnung mit Dialoghistorie, Isolation nach
Rolle/Welt, unveränderter nicht ausgewählter Pfad, NPC-Budget, Admin-Abschaltung und keine direkt erzeugten Intents.
`SPACES_MMO_DURABLE_MODELS_MODULE` ist ausschließlich für Fixtures mit `SPACES_MMO_TEST=1` gedacht.
