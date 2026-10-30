# Automaten (Phase 6)

Spielerinnen und Spieler bauen kleine Maschinen, die selbstständig in der Welt handeln: sammeln, Feuer hüten, Waren
tragen. Ein Automat ist ein Programm, das im pi-codemode-Sandbox läuft (QuickJS, wie die Beiträge in codemode-chat,
`codemode-chat/server/judge.ts`), und eine Spielfigur, die genau dieselben Befehle benutzt wie ein Mensch.

Niemand muss bei null anfangen: Es gibt eine **Auswahl fertiger Beispielautomaten** zum Übernehmen und Abwandeln und
ein **kleines Hilfesystem**, das im Spiel und im Editor dieselben Texte zeigt.

## Im Spiel

- Ein Automat ist ein Gegenstand (Prototyp `Automat`, gebaut aus Tauwerk, Zahnrad, Gehäuse). Aufgestellt wird er zu
  einer Figur `["Object","Character","Automaton"]` mit `owner`.
- Er läuft mit **Öl**. Öl einfüllen verlängert die Lease seines `Fuel`-Entries; ist das Öl verbraucht, bleibt er
  stehen. So ist das Rechenbudget ein Spielgegenstand und kein Konfigurationswert.
- Jeder Charakter darf höchstens 2 Automaten gleichzeitig betreiben (anfangs; später über Ruf mehr), Gäste 1.
  Bei der Registrierung bleiben die Automaten eines Gastes erhalten.

## Programmiermodell

Ein Automat ist **eine Funktion pro Takt**. Er sieht, was seine Figur sieht, und gibt Befehle zurück. Er hat keinen
Zugriff auf den Space, kein Netz, keine Uhr außer dem übergebenen Takt (`tools: []` im Sandbox, wie beim Judge).

```js
// Wird alle 5 s einmal aufgerufen.
function schritt(sicht, merk) {
  // sicht: was die Figur gerade wahrnimmt (siehe unten), nur lesend
  // merk:  was der letzte Schritt zurückgegeben hat (anfangs {})
  return { tue: ["look"], merk };
}
```

**`sicht`** (vom Welt-Worker gebaut, JSON):

```js
{
  takt: 1834,                                   // fortlaufend, ersetzt die Uhr
  ich:   { name: "Klapper", x: 4, y: 7, inventar: [{ name: "treibholz", anzahl: 2 }], oel: 0.62 },
  raum:  { name: "Graue Bucht", nebel: 1,       // 0 klar … 3 dicht
           ausgaenge: [{ richtung: "nord", ziel: "Klippenpfad" }],
           dinge:  [{ name: "treibholz", typ: "Flotsam", x: 9, y: 11 }],
           leute:  [{ name: "Mira", x: 5, y: 7, automat: false }],
           feuer:  { stand: 0.18, brennstoff: "oel" } },   // nur in Räumen mit Leuchtfeuer
  hoerte: [{ von: "Mira", text: "hallo klapper" }],         // seit dem letzten Schritt
  fehler: "Zu spät – jemand anderes war schneller."         // Ergebnis des letzten Befehls, falls er scheiterte
}
```

**Rückgabe:** `{ tue: string[], merk: object }`

- `tue`: höchstens 2 Befehle pro Schritt, in der gleichen Sprache wie die Befehlszeile (`go nord`, `move 9 11`,
  `get treibholz`, `put öl in feuer`, `say …`). Builder- und Adminbefehle sind für Automaten gesperrt (Cmdset
  `AutomatonCmdSet` ersetzt das Standard-Cmdset).
- `merk`: frei, höchstens 4 KiB als JSON; wird als `AutomatonMemory`-Entry gespeichert und im nächsten Schritt
  übergeben. Damit überlebt ein Automat Neustarts.

**Grenzen:** Quelltext ≤ 8 000 Zeichen, 50 ms und 8 MiB pro Schritt, ein Schritt alle 5 s. Wer die Grenze reißt,
bekommt für diesen Schritt nichts ausgeführt und eine Zeile im Automatenlog; nach 5 Fehlern in Folge hält der Automat
an.

## Ablauf im System

```
Welt-Ticker  ── alle 5 s: fällige Automaten (Fuel-Lease lebt, nicht pausiert)
Automaten-Worker ── take AutomatonDue{id} ──▶ Sicht bauen ──▶ Sandbox: schritt(sicht, merk)
                 ── write Intent{actor: automat, line} je Befehl, write AutomatonMemory, write AutomatonLog (Lease 1 h)
Welt-Worker     ── nimmt die Intents wie von Menschen (Locks, Cmdsets, Transaktionen gelten unverändert)
```

Der Automaten-Worker ist ein eigener Prozess (`automaton-host.ts`), wie die Judges in codemode-chat ein eigener
Prozess sind: Fremdcode läuft nie im Welt- oder Web-Prozess. Er darf nur `Intent`, `AutomatonMemory` und
`AutomatonLog` schreiben (`Policy`).

## Beispielautomaten (Auswahl)

Im Spiel: `automat vorlagen` listet sie, `automat vorlage <name>` lädt eine in den Editor. Im Browser: eine Liste mit
Schwierigkeit, Kurzbeschreibung und „Übernehmen“. Sie sind nach Schwierigkeit geordnet und bauen aufeinander auf.

| Name | Stufe | Lernt man dabei | Was er tut |
| --- | --- | --- | --- |
| **Grüßer** | 1 | `schritt`, `tue`, `sicht.leute` | Grüßt jede Person, die neu in den Raum kommt |
| **Strandläufer** | 1 | `sicht.dinge`, `move`, `get` | Läuft zum nächsten Strandgut und hebt es auf |
| **Feuerwärter** | 2 | Schwellwerte, Inventar | Legt Öl nach, sobald das Feuer unter 25 % fällt |
| **Bote** | 2 | `merk`, Ausgänge, Routen | Trägt Waren zwischen zwei Räumen hin und her |
| **Nebelboje** | 2 | `say` auf Kanälen, Änderungen erkennen | Meldet im Kanal *hafen*, wenn sich der Nebel ändert |
| **Händler** | 3 | Markt-Befehle, `fehler` auswerten | Stellt Angebote ein, wenn genug Ware da ist, und zieht sie bei Nebel zurück |

### Grüßer

```js
function schritt(sicht, merk) {
  const kannte = merk.kannte ?? [];
  const neu = sicht.raum.leute.filter((p) => !p.automat && !kannte.includes(p.name));
  return {
    tue: neu.slice(0, 2).map((p) => `say Willkommen in ${sicht.raum.name}, ${p.name}!`),
    merk: { kannte: sicht.raum.leute.map((p) => p.name) },
  };
}
```

### Strandläufer

```js
function schritt(sicht, merk) {
  const gut = sicht.raum.dinge.filter((d) => d.typ === "Flotsam");
  if (gut.length === 0) return { tue: [], merk };
  const nah = (d) => Math.abs(d.x - sicht.ich.x) + Math.abs(d.y - sicht.ich.y);
  const ziel = gut.sort((a, b) => nah(a) - nah(b))[0];
  if (nah(ziel) === 0) return { tue: [`get ${ziel.name}`], merk };
  return { tue: [`move ${ziel.x} ${ziel.y}`], merk };   // der Server geht einen Schritt und sucht den Weg
}
```

### Feuerwärter

```js
function schritt(sicht, merk) {
  const feuer = sicht.raum.feuer;
  const oel = sicht.ich.inventar.find((i) => i.name === "öl");
  if (feuer && feuer.stand < 0.25 && oel) return { tue: ["put öl in feuer"], merk };
  if (!oel) return { tue: ["say Mir geht das Öl aus."], merk: { ...merk, gewarnt: sicht.takt } };
  return { tue: [], merk };
}
```

### Bote

```js
// Route: von "Graue Bucht" nach "Kontor" und zurück; trägt Treibholz.
const WEG = { "Graue Bucht": "nord", "Klippenpfad": "ost", "Kontor": null };
const ZURUECK = { "Kontor": "west", "Klippenpfad": "süd", "Graue Bucht": null };
function schritt(sicht, merk) {
  const traegt = sicht.ich.inventar.some((i) => i.name === "treibholz");
  const hin = traegt;
  const richtung = (hin ? WEG : ZURUECK)[sicht.raum.name];
  if (richtung) return { tue: [`go ${richtung}`], merk };
  if (hin) return { tue: ["drop treibholz"], merk };
  return { tue: ["get treibholz"], merk };
}
```

Nebelboje und Händler stehen vollständig in den Vorlagen (`spaces-mmo/worlds/leuchtfeuer/automata/*.js`), hier nur beschrieben.

### Vorlagen sind getestet

Jede Vorlage hat **Szenen** wie die Fälle eines Codemode-Tasks: eine feste `sicht`, ein `merk`, und die erwarteten
Befehle.

```js
// spaces-mmo/worlds/leuchtfeuer/automata/feuerwaerter.cases.js
[{ sicht: { raum: { feuer: { stand: 0.1 } }, ich: { inventar: [{ name: "öl", anzahl: 1 }] } }, erwartet: ["put öl in feuer"] },
 { sicht: { raum: { feuer: { stand: 0.9 } }, ich: { inventar: [{ name: "öl", anzahl: 1 }] } }, erwartet: [] }]
```

Die Tests laufen im echten Sandbox (wie `judgeInSlot`). Eine Vorlage, die ihre Szenen nicht besteht, wird nicht
ausgeliefert.

## Sprache: Deutsch und Englisch

Jede Nutzerin und jeder Nutzer wählt die Sprache (`de` oder `en`, Voreinstellung nach der Oberfläche). Die Beispiele
in diesem Dokument sind die deutsche Fassung.

- **Befehle gelten immer in beiden Sprachen.** Jeder Befehl hat `key` und `aliases` (`go`/`gehe`, `get`/`nimm`,
  `say`/`sage`); ein Umschalter ist nicht nötig, und Automaten, Menschen und Agenten können mischen. Gegenstände
  werden über `name` und `aliases` gefunden (`get treibholz` und `get driftwood`).
- **Anzeigenamen:** Prototypen, Gegenstände und Räume bekommen `names: { de, en }` neben `name`. Die Ausgabe nimmt die
  Sprache des Empfängers, `name` bleibt der Schlüssel und die Rückfallsprache.
- **Code pro Automat:** Das Feld `lang` am Automaten (`de`/`en`, bei `automat vorlage` aus der Sprache der Nutzerin,
  mit `automat sprache en` änderbar) bestimmt die Namen der Schnittstelle. Der Quelltext wird so gespeichert, wie er
  geschrieben wurde.

| Deutsch | Englisch |
| --- | --- |
| `schritt(sicht, merk)` | `step(view, memo)` |
| `{ tue, merk }` | `{ do, memo }` |
| `sicht.takt`, `.ich`, `.raum`, `.hoerte`, `.fehler` | `view.tick`, `.me`, `.room`, `.heard`, `.error` |
| `raum.ausgaenge`, `.dinge`, `.leute`, `.feuer`, `.nebel` | `room.exits`, `.items`, `.people`, `.fire`, `.fog` |
| `ich.inventar`, `.oel`; `anzahl`, `richtung`, `ziel`, `stand`, `brennstoff` | `me.inventory`, `.oil`; `count`, `direction`, `target`, `level`, `fuel` |

Die vollständige Zuordnung steht in einer Tabelle `automata/keys.ts` (eine Quelle für Worker, Editor-Vervollständigung,
Referenzartikel und Assistent). Der Worker benennt die Schlüssel von `sicht` vor dem Aufruf um und liest die Rückgabe
nach dem Aufruf zurück. Der Sandbox sieht nur die Namen der gewählten Sprache. `do` ist in JavaScript ein
Schlüsselwort, als Objektschlüssel aber erlaubt; Vorlagen benutzen `{ do: [...] }` und nie eine Variable `do`.

Unverändert in beiden Sprachen: Typ-Kennungen (`Flotsam`, `Automaton`), Befehlsargumente, die Gegenstände benennen
(beide Sprachen werden verstanden), und die JavaScript-Wörter (`if`, `const`, `return`). „Alles auf Deutsch“ gilt
daher für unsere Schnittstelle, nicht für die Sprache selbst.

Was für beide Sprachen vorhanden sein muss:

- **Vorlagen:** je Vorlage eine deutsche und eine englische Fassung (`feuerwaerter.js`/`fire-keeper.js`) mit denselben
  Szenen; ein Test führt beide gegen dieselben Szenen aus und vergleicht die Befehle.
- **Hilfeartikel und Fehlermeldungen** in beiden Sprachen (`help automat` und die Referenz im Editor zeigen die Sprache
  der Nutzerin).
- **Assistent und Regelbaukasten:** schreiben in der Sprache des Automaten.
- **Modell-NPCs:** ihr Automat nimmt die Sprache des NPC (Voreinstellung `en`, weil Modelle englischen Code verlässlicher
  schreiben).

## Einstieg ohne Programmierkenntnisse

Wer nie programmiert hat, soll trotzdem einen eigenen Automaten haben. Dafür gibt es vier Wege, die dieselbe
`schritt`-Funktion erzeugen; welchen man wählt, ist Geschmack, und man kann jederzeit zum nächsten wechseln.

1. **Vorlage mit Feldern.** Jede Vorlage nennt ihre Stellschrauben (Feuerwärter: „Öl nachlegen unter [25] %“,
   Bote: „Ware [treibholz], von [Graue Bucht] nach [Kontor]“). Man füllt Felder aus, der Editor setzt sie in den
   Code ein. Die Felder stehen als Kommentarzeile `// @param schwelle: Zahl 0..1 = 0.25` in der Vorlage, so bleibt der
   Code die einzige Quelle.
2. **Regelbaukasten.** Eine Liste „Wenn <Bedingung>, dann <Befehl>“, Bedingungen und Befehle aus Auswahllisten, die
   aus dem Schema von `sicht` und der Befehlsliste des `AutomatonCmdSet` kommen. Die Regeln sind Daten und werden zu
   Code übersetzt; „Als Code anzeigen“ zeigt das Ergebnis und führt zum Code-Editor.
3. **Vormachen.** `automat aufnehmen` merkt die eigenen Befehle (sie stehen als `Intent`-Entries im Space), `automat
   aufnehmen ende` bietet daraus eine Routine an („Diese 4 Befehle in Schleife?“) und erzeugt den Code.
4. **Beschreiben (Assistent).** Man schreibt in einem Satz, was der Automat tun soll. Ein Agent erzeugt `schritt`
   (siehe unten). Von Anfang an Teil dieser Phase, nicht erst später.

Im Code-Editor selbst hilft eine **Vervollständigung aus dem Schema**: `sicht.raum.` bietet `dinge`, `leute`,
`feuer` an, `tue` kennt die erlaubten Befehle. Ohne Modell, aus einer Typdeklaration für `sicht`, die zugleich die
Referenz „Was ein Automat sieht“ speist. Der Editor ist CodeMirror 6 (neue Abhängigkeit, vor dem Einbau
freigeben lassen; bis dahin ein einfaches Textfeld).

### Probelauf gegen die Vergangenheit

Der Automaten-Worker bewahrt die letzten 20 `sicht`-Werte je Automat im `AutomatonLog` (Lease 1 h). Der Probelauf
kann den Code gegen diese echten Sichten laufen lassen und zeigt, was er getan hätte, neben dem, was der alte Code
getan hat. Das ist der Prüfstand für alle vier Wege.

### Assistent: Beschreibung zu Code

Ablauf wie Task und Judge in codemode-chat: ein Agent schreibt, der Sandbox prüft.

```
Spielerin: "Bring Treibholz zum Kontor und warte bei Nebel"
Assistent (Agent, Prozess npc/assistant)
   1. schreibt schritt(sicht, merk) und 2-4 Szenen (sicht, erwartet) dazu
   2. lässt beides im Sandbox laufen (Grenzen wie oben); scheitert es, bekommt er die Fehlermeldung und
      versucht es erneut (höchstens 3 Versuche)
   3. liefert Code, Szenen und eine Erklärung in einem Satz je Block zurück
Spielerin: sieht Code + Probelauf, ändert oder übernimmt ("automat code übernehmen")
```

- Das Modell läuft nur beim Schreiben. Der fertige Automat ist eine gewöhnliche Funktion und kostet im Betrieb nur Öl.
- Tokens: eigenes Kontingent pro Konto und Tag (wie `CODEMODE_LLM_PER_DAY`/`_PER_MIN`, Variable
  `SPACES_MMO_ASSISTANT_PER_DAY`), standardmäßig aus (`SPACES_MMO_LLM=0`); die Vorlagen, der Regelbaukasten und das
  Vormachen funktionieren ohne.
- Der Assistent sieht nur die Beschreibung, die Referenzartikel, die Vorlagen und den Code des eigenen Automaten,
  nie Daten anderer Spieler. Sein Ergebnis wird nie ausgeführt, bevor die Spielerin es übernommen hat.
- Tests mit geskripteten Modellen (Systemnachrichten vor dem Prüfen der letzten Nachricht herausfiltern, siehe
  `docs/examples.md`); ein Live-Lauf nur auf ausdrückliche Freigabe.

### Agenten als Besitzer von Automaten

Modell-NPCs (Phase 5) dürfen Automaten bauen und programmieren, mit denselben Regeln wie Menschen:

- Der NPC ist eine Figur mit `owner`-Rolle; die Grenze von 2 Automaten und das Öl gelten für ihn genauso.
- Er benutzt dieselben Befehle: `automat vorlage <name>`, dann `automat code`, `automat probe`, `automat start`. Es gibt
  keinen Sonderzugang. Der Quelltext (≤ 8 000 Zeichen, auch mehrzeilig) steht nicht in der Befehlszeile, sondern im
  Feld `payload` des `Intent`-Entries; die Zeile bleibt `automat code`. Der Browser-Editor und Agenten benutzen dasselbe
  Feld, nur der reine Textmodus braucht den mehrzeiligen Eingabemodus.
- Für das Schreiben gilt dieselbe Schleife wie beim Assistenten (schreiben, Probelauf, nachbessern), und die Tokens
  zählen auf das Kontingent des NPC (`SPACES_MMO_LLM`), nicht auf das einer Spielerin.
- Gegen Wildwuchs: höchstens 1 Automat je Modell-NPC, ein Codewechsel je 10 Minuten (vom Admin im Konfigurationsfenster einstellbar, siehe [Einstellungen für Betreiber](#einstellungen-für-betreiber)), und die Automaten eines NPC tragen
  im Namen und in `sicht` das Kennzeichen `von: "npc"`, damit Spieler sie von menschlichen unterscheiden.

## Kleines Hilfesystem

Drei Teile, eine Quelle:

1. **Hilfeartikel** in einer Datei `spaces-mmo/worlds/leuchtfeuer/help/automaten.ts`, im Format von `codemode-chat/client/help/articles.ts`
   (`id`, `section`, `title`, `short`, `body` als Markdown mit `{#anker}`). Ein Ladeskript schreibt sie zusätzlich als
   `HelpEntry`-Entries in den Space, damit `help` im Spiel dieselben Texte zeigt.
2. **Im Spiel:** `help automat` (Überblick), `help automat sicht`, `help automat tue`, `help automat merk`,
   `help automat grenzen`, `help automat befehle`, `help automat vorlagen`. Kurze Texte, jeweils mit einem Beispiel.
3. **Im Editor (Browser):**
   - Neben dem Code ein aufklappbarer Bereich „Referenz“ mit denselben Artikeln.
   - Ein „?“ an jedem Feld und Knopf (Muster `codemode-chat/client/HelpTip.tsx`).
   - **Probelauf:** führt `schritt` gegen die Szenen der gewählten Vorlage oder gegen die aktuelle Sicht der eigenen
     Figur aus und zeigt, welche Befehle herauskämen, ohne sie auszuführen. Fehlermeldungen des Sandbox werden in
     Spielsprache übersetzt („`sicht.raum.feuer` ist hier leer – in diesem Raum brennt kein Feuer“).

Artikelliste (klein gehalten):

| id | Titel |
| --- | --- |
| `help.automat.start` | Dein erster Automat in 3 Minuten (Grüßer übernehmen, Öl einfüllen, starten) |
| `help.automat.sicht` | Was ein Automat sieht |
| `help.automat.tue` | Befehle zurückgeben, und welche erlaubt sind |
| `help.automat.merk` | Sich etwas merken |
| `help.automat.grenzen` | Takt, Zeit, Speicher, Öl; was passiert, wenn er hängt |
| `help.automat.fehler` | Häufige Fehler und ihre Bedeutung |
| `help.automat.vorlagen` | Die Beispielautomaten und in welcher Reihenfolge man sie liest |

## Befehle

| Befehl | Wirkung |
| --- | --- |
| `automat vorlagen` | Listet die Beispielautomaten |
| `automat vorlage <name>` | Lädt eine Vorlage in den Editor des eigenen Automaten |
| `automat zeige [<automat>]` | Zeigt Code, Ölstand, Status |
| `automat start` / `automat stop` | Startet oder pausiert |
| `automat log` | Die letzten 20 Zeilen: ausgeführte Befehle, Fehler, Grenzverletzungen |
| `automat probe` | Probelauf gegen die aktuelle Sicht oder die letzten 20 gespeicherten, ohne auszuführen |
| `automat aufnehmen` / `automat aufnehmen ende` | Eigene Befehle aufzeichnen und daraus eine Routine erzeugen |
| `automat beschreibe <Satz>` | Der Assistent schreibt Code zu der Beschreibung (Kontingent) |
| `automat code [übernehmen]` | Setzt den Quelltext; `übernehmen` nimmt den Vorschlag des Assistenten |

Den Code selbst bearbeitet man im Browser-Editor. Im reinen Textmodus geht das über einen mehrzeiligen Eingabemodus
(EvEditor-Entsprechung).

## Einstellungen für Betreiber

**Stand 2026-10-27: umgesetzt** für die Modelle und die Grenzen, die es schon gibt (`client/AdminPanel.tsx`,
`server/settings.ts`, `tests/admin.test.ts`): Ein Admin sieht in der Kopfzeile des Spiels „Admin“ (auf dem Handy hinter
„⋯“). Oben stehen die **Modelle** wie im Admin-Panel von codemode-chat und im Feed des Help-Systems: Modell-NPCs und
Übersetzen an/aus, alle Modelle mit Zugangsdaten nach Anbieter gruppiert (ein Kästchen je Anbieter, Filter), dazu das
Modell, das verwendet wird; „Standard“ kehrt zum neuesten Modell zu `SPACES_MMO_LLM_MODEL` (sonst Haiku) zurück. Die
Liste der Modelle veröffentlicht der Modellprozess als `ModelInfo`-Entry, denn nur er hat Zugangsdaten. Freischalten
lassen sich Modellaufrufe im Fenster nicht: Ohne `SPACES_MMO_LLM=1` in der `.env` bleiben sie aus, das Fenster kann sie
nur zusätzlich abschalten. Darunter die **Grenzen**:

| Feld | Umgebungsvariable | Standard |
| --- | --- | --- |
| Modellaufrufe je Minute (alle Prozesse) | `SPACES_MMO_LLM_PER_MIN` | 20 |
| Modellaufrufe je Tag (alle Prozesse) | `SPACES_MMO_LLM_PER_DAY` | 500 |
| Übersetzungen je Konto und Tag | `SPACES_MMO_TRANSLATE_PER_DAY` | 200 |
| Übersetzungen je Gast und Tag | `SPACES_MMO_TRANSLATE_GUEST_PER_DAY` | 20 |
| Wache Modell-NPCs zugleich | `SPACES_MMO_NPC_MAX` | 10 |
| Modellaufrufe je NPC und Welttag (−1: das Budget der Rolle) | `SPACES_MMO_NPC_BUDGET_DAY` | −1 |
| Getippte Befehle auf einmal je Konto | `SPACES_MMO_CMD_BURST` | 20 |
| Getippte Befehle je Sekunde je Konto | `SPACES_MMO_CMD_PER_SEC` | 5 |
| Punkte einer Insel für das Dorf (Epoche 2, [siedeln.md](siedeln.md)) | `SPACES_MMO_EPOCH_DORF` | 15 |
| Punkte einer Insel für die Stadt (Epoche 3) | `SPACES_MMO_EPOCH_STADT` | 40 |
| Punkte einer Insel für das Netz (Epoche 4) | `SPACES_MMO_EPOCH_NETZ` | 80 |

Jeder Prozess liest die `Setting`-Entries höchstens alle `SPACES_MMO_SETTINGS_MS` (5 s). Noch offen aus dem Entwurf
unten: die Felder der Automaten und des Assistenten (die es noch nicht gibt), die Grenzen des Web-Prozesses für Anfragen
und Gäste und das Admin-Log.

Entwurf: Der Admin meldet sich im Browser an und öffnet das **Konfigurationsfenster**. Dort stehen die Grenzen und
Kontingente als Formularfelder mit Beschriftung, Einheit, Standardwert und „?“-Hilfe, kein Befehl nötig. „Speichern“
schreibt sie als `Setting`-Entries in den Space; sie bleiben damit über Neustarts erhalten und gelten auf jedem
Prozess, der den Space benutzt, ohne Neustart (die Prozesse lesen sie beim nächsten Schritt oder über `watch`).

Reihenfolge, wer gewinnt: **gespeicherter Wert im Space → Umgebungsvariable (`.env`) → eingebauter Standard.** Die
`.env` liefert also die Anfangswerte, das Fenster überschreibt sie; „Zurücksetzen“ löscht den Eintrag im Space, und
wieder gilt die `.env`. Das Fenster zeigt je Feld, woher der Wert gerade kommt.

| Feld | Umgebungsvariable | Standard |
| --- | --- | --- |
| Modell-NPCs erlaubt | `SPACES_MMO_LLM` | aus |
| Assistent: Läufe je Konto und Tag | `SPACES_MMO_ASSISTANT_PER_DAY` | 10 |
| Modell-NPCs gleichzeitig **wach** (Höchstzahl) | `SPACES_MMO_NPC_MAX` | 10 |
| Automaten gleichzeitig in der ganzen Welt (Höchstzahl) | `SPACES_MMO_AUTOMATA_MAX` | 100 |
| Codewechsel eines Modell-NPC: Wartezeit (Minuten) | `SPACES_MMO_NPC_CODE_COOLDOWN_MIN` | 10 |
| Anfragen je Minute und Verbindung | `SPACES_MMO_REQ_PER_MIN` | 120 |
| Gäste je Stunde | `SPACES_MMO_GUESTS_PER_HOUR` | 5 |
| Registrierungen je Tag | `SPACES_MMO_REGISTRATIONS_PER_DAY` | 20 |
| Lebensdauer von Gästen | `SPACES_MMO_GUEST_TTL_MS` | 7 Tage |

Die Höchstzahlen zählen die laufenden Figuren; ist die Grenze erreicht, wird ein weiterer Modell-NPC nicht gestartet
bzw. `automat start` abgelehnt („Die Welt ist voll, versuche es später“), und das Fenster zeigt, wie viele gerade laufen.
Die Grenzen je Besitzer (2 Automaten, Gäste 1) bleiben davon unberührt.

Nicht im Fenster, nur in der `.env`: alles, was den Prozess selbst betrifft (Adressen, Pfade, `SPACES_MMO_SPACE`,
`SPACES_MMO_LISTEN`, `SPACES_MMO_DATA`) und alle Geheimnisse (`SPACES_MMO_SETUP_TOKEN`, Passwörter). Das Fenster zeigt
und speichert nie ein Geheimnis. Jede Änderung steht mit Wer und Wann im Admin-Log.

Schreiben darf nur eine Admin-Sitzung (dieselbe Anmeldung wie sonst); der Server prüft Typ und Grenzen jedes Feldes
(eine Wartezeit unter 1 Minute oder ein Kontingent über dem Höchstwert wird abgelehnt, das Fenster zeigt den Grund).

## Sicherheit und Fairness

- Fremdcode läuft nur im Automaten-Worker im Sandbox, nie im Welt- oder Web-Prozess. Der Code ist ein Datenwert, den der
  Wrapper per indirektem `eval` ausführt (wie in `judge.ts`); Builtins, auf die der Wrapper sich verlässt, werden vorher
  gesichert.
- Automaten unterliegen denselben Locks und Kontingenten wie ihr Besitzer, zählen aber nicht als Menschen
  (`automat: true` in jeder Sicht). Ein Raum kann Automaten aussperren (Lock `enter:not automaton()`).
- Gegen Farmen: Strandgut wird pro Raum und Tick begrenzt gespawnt; Automaten haben bei `get` eine kleine Verzögerung
  gegenüber Menschen (einen Takt).
- Ruf durch Automaten zählt halb.

## Abnahme

- Alle sechs Vorlagen bestehen ihre Szenen im echten Sandbox.
- Ein Strandläufer und ein Mensch, die gleichzeitig nach demselben Treibholz greifen: genau einer bekommt es, der
  andere sieht die Fehlermeldung (Automat in `sicht.fehler`).
- Ein Automat mit Endlosschleife hält nach 5 Schritten an, ohne andere Automaten zu verzögern.
- Ein Neustart des Automaten-Workers: alle laufenden Automaten machen mit ihrem `merk` weiter.
- `help automat` im Spiel und die Referenz im Editor zeigen denselben Text (Test vergleicht beide Ausgaben).
- Ein Assistent-Lauf mit geskriptetem Modell liefert Code, der die eigenen Szenen besteht; ein Lauf, der dreimal
  scheitert, liefert keinen Code und verbraucht nur das Kontingent, nicht den Besitzer-Slot.
- Ein Modell-NPC baut einen Automaten über dieselben Befehle; der zweite wird abgelehnt (1 je NPC), ein Codewechsel
  innerhalb der eingestellten Wartezeit ebenso; eine im Fenster geänderte und gespeicherte Wartezeit gilt ab dem nächsten Versuch und nach einem Neustart weiter.
- Ein Mensch ohne Code kommt über Vorlage + Felder zu einem laufenden Automaten (Test spielt den Weg durch).
- Dieselbe Vorlage in `de` und `en` besteht dieselben Szenen und liefert gleiche Befehle; ein Automat mit `lang: "en"`
  sieht nur englische Schlüssel (Test greift auf `sicht.raum` und bekommt `undefined`).
- Zwei Nutzer in verschiedenen Sprachen spielen im selben Raum; jeder sieht Räume, Gegenstände und Hilfe in seiner
  Sprache, und `get treibholz` und `get driftwood` finden denselben Gegenstand.
