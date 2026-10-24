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

**`sicht`** (vom Welt-Prozess gebaut, JSON):

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
Welt-Prozess     ── nimmt die Intents wie von Menschen (Locks, Cmdsets, Transaktionen gelten unverändert)
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
| `automat probe` | Probelauf gegen die aktuelle Sicht, ohne auszuführen |

Den Code selbst bearbeitet man im Browser-Editor. Im reinen Textmodus geht das über einen mehrzeiligen Eingabemodus
(EvEditor-Entsprechung).

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
