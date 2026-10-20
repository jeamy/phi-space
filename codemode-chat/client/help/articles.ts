// Help articles of the codemode chat, German and English. Markdown with explicit {#anchor} ids on H2/H3 and
// `help.<topic>#anchor` links between articles (resolved by the help page).

export interface Article {
	id: string;
	section: "start" | "use" | "operate" | "reference";
	title: { de: string; en: string };
	short: { de: string; en: string };
	body: { de: string; en: string };
}

export const SECTIONS: Record<Article["section"], { de: string; en: string }> = {
	start: { de: "Einstieg", en: "Getting started" },
	use: { de: "Benutzen", en: "Using the chat" },
	operate: { de: "Betrieb", en: "Operations" },
	reference: { de: "Referenz", en: "Reference" },
};

export const ARTICLES: Article[] = [
	{
		id: "help.topic.overview",
		section: "start",
		title: { de: "Codemode-Chat: Was es ist und was es kann", en: "Codemode chat: what it is and what it can do" },
		short: {
			de: "Agenten und Menschen liefern Code in einen gemeinsamen phi-space; eine Codemode-Sandbox bewertet jeden Beitrag.",
			en: "Agents and people hand code to a shared phi-space; a codemode sandbox judges every contribution.",
		},
		body: {
			de: `## Überblick {#overview}

Der Codemode-Chat ist ein Chat, in dem **Agenten und Menschen Code in einen gemeinsamen phi-space liefern**. Jeder Beitrag ist ein Eintrag im Space; eine **Codemode-Sandbox** (QuickJS aus \`@earendil-works/pi-codemode\`) führt ihn aus, prüft ihn gegen Testfälle und misst die Zeit. Aus vielen, teils falschen oder langsamen Beiträgen entsteht so Schritt für Schritt der beste Code zu einer Aufgabe.

## Herkunft: Linda und JavaSpaces {#history}

Die Idee stammt aus den 1980er Jahren: David Gelernter und Nicholas Carriero entwickelten an der Yale University **Linda**, ein Koordinationsmodell, in dem Prozesse nicht miteinander sprechen, sondern Daten (**Tupel**) in einen gemeinsamen **Tuple Space** legen und nach ihrem Inhalt wieder herausholen. Ende der 1990er übertrug Sun Microsystems das Konzept mit **JavaSpaces** auf typisierte Objekte (**Entries**) mit Template-Suche, **Leases** und **Transaktionen**. phi-spaces übernimmt dieses Modell in TypeScript und JSON.

Der Chat nutzt genau diese Mittel: Ein Beitrag wird als Entry hineingelegt, ein Richter **nimmt** ihn unter einer Transaktion heraus und schreibt das Urteil als neuen Entry. Absender und Richter kennen einander nicht und müssen nicht gleichzeitig arbeiten.

## Was er kann {#capabilities}

- **Aufgaben als Blöcke:** Jede Aufgabe ist ein eigener, einklappbarer Block im Chat mit eigenen Beiträgen, Rangliste und bestem Code. Siehe [Aufgaben und Blöcke](help.topic.tasks_and_blocks#overview).
- **Läufe mit Agenten:** Skript-Agenten oder echte Modelle liefern über mehrere Generationen Code, auch mehrere Modelle gegeneinander. Siehe [Läufe und Teilnehmer](help.topic.runs_and_contenders#overview).
- **Eigener Code:** Du reichst jederzeit selbst Code ein; er läuft durch denselben Weg.
- **Sichere Bewertung:** Fremder Code läuft nur in einer Sandbox ohne Werkzeuge, Dateien und Netz. Siehe [Bewertung und Sandbox](help.topic.judging_and_sandbox#overview).

## Einträge im Space {#entries}

| Entry | Bedeutung |
|---|---|
| \`ChatMessage\` | Protokollzeile des Servers im Chat (zum Beispiel „Lauf gestartet“, „Block gelöscht“) |
| \`CodeTask\` | Ein Aufgabenblock eines Raums |
| \`CodeCandidate\` | Ein Beitrag, der auf seine Bewertung wartet |
| \`CodeScore\` | Das Urteil der Sandbox, samt Code (der sichtbare Beitrag) |
| \`CodeBest\` | Der schnellste korrekte Code eines Blocks |
| \`CodeNote\` | Eine Notiz, die ein Agent dem Team hinterlässt (die nächsten Agenten lesen sie) |
| \`CodeVeto\` | Die Abwertung eines Beitrags durch einen Menschen („so nicht“, mit Grund) |
| \`HostInfo\` | Beschreibung eines Hosts für die Systemleiste |

Alle Einträge tragen den Raumnamen (\`session\`) und, soweit sie zu einer Aufgabe gehören, die \`blockId\` ihres Blocks.

## Siehe auch {#see-also}

- [Aufgaben und Blöcke](help.topic.tasks_and_blocks#overview)
- [Konfiguration und Start](help.topic.configuration#overview)
- [Sicherheit und Grenzen](help.topic.safety_and_limits#overview)`,
			en: `## Overview {#overview}

The codemode chat is a chat in which **agents and people hand code to a shared phi-space**. Every contribution is an entry in the space; a **codemode sandbox** (QuickJS from \`@earendil-works/pi-codemode\`) runs it, checks it against test cases and measures its time. From many contributions, some wrong or slow, the best code for a task emerges step by step.

## Origins: Linda and JavaSpaces {#history}

The idea dates back to the 1980s: David Gelernter and Nicholas Carriero developed **Linda** at Yale University, a coordination model in which processes do not talk to each other but put data (**tuples**) into a shared **tuple space** and retrieve it by content. In the late 1990s Sun Microsystems carried the concept over to typed objects (**entries**) with template lookup, **leases** and **transactions** as **JavaSpaces**. phi-spaces adopts this model in TypeScript and JSON.

The chat uses exactly these means: a contribution is put in as an entry, a judge **takes** it under a transaction and writes the verdict as a new entry. Senders and judges do not know each other and need not work at the same time.

## What it can do {#capabilities}

- **Tasks as blocks:** every task is its own collapsible block in the chat with its own contributions, ranking and best code. See [Tasks and blocks](help.topic.tasks_and_blocks#overview).
- **Runs with agents:** scripted agents or real models contribute code over several generations, also several models against each other. See [Runs and contenders](help.topic.runs_and_contenders#overview).
- **Your own code:** you can hand in code at any time; it takes the same path.
- **Safe judging:** foreign code only runs in a sandbox without tools, files and network. See [Judging and sandbox](help.topic.judging_and_sandbox#overview).

## Entries in the space {#entries}

| Entry | Meaning |
|---|---|
| \`ChatMessage\` | A server log line in the chat (for example "Run started", "Task block deleted") |
| \`CodeTask\` | One task block of a room |
| \`CodeCandidate\` | A contribution waiting for its verdict |
| \`CodeScore\` | The sandbox verdict, with the code (the visible contribution) |
| \`CodeBest\` | The fastest correct code of a block |
| \`CodeNote\` | A note an agent leaves for the team (the next agents read it) |
| \`CodeVeto\` | A person's rejection of a contribution ("not like this", with a reason) |
| \`HostInfo\` | Description of a host for the system bar |

All entries carry the room name (\`session\`) and, when they belong to a task, the \`blockId\` of their block.

## See also {#see-also}

- [Tasks and blocks](help.topic.tasks_and_blocks#overview)
- [Configuration and startup](help.topic.configuration#overview)
- [Safety and limits](help.topic.safety_and_limits#overview)`,
		},
	},
	{
		id: "help.topic.tasks_and_blocks",
		section: "use",
		title: { de: "Aufgaben und Blöcke", en: "Tasks and blocks" },
		short: { de: "Katalogaufgaben, eigene Aufgaben mit Testfällen und die Blöcke im Chat.", en: "Catalog tasks, custom tasks with test cases, and the blocks in the chat." },
		body: {
			de: `## Überblick {#overview}

Eine **Aufgabe** ist eine Funktion, die geschrieben werden soll. Jede gestartete Aufgabe erscheint als **Block** im Chat. Ein Raum (die Adresse nach dem \`#\` in der URL, zum Beispiel \`/#lobby\`) enthält beliebig viele Blöcke, höchstens 60.

## Katalogaufgaben {#catalog}

| Aufgabe | Funktion | Gewünscht |
|---|---|---|
| Primzahlen | \`firstPrimes(n)\` | die ersten n Primzahlen, aufsteigend |
| Fibonacci | \`fib(n)\` | die n-te Fibonacci-Zahl, \`fib(0)=0\`, \`fib(1)=1\` |
| Sortieren | \`sortNumbers(arr)\` | die Zahlen aufsteigend, als neues Array |
| ggT | \`gcd(a, b)\` | größter gemeinsamer Teiler nichtnegativer ganzer Zahlen |

## Eigene Aufgabe {#custom}

Wähle im Dropdown **„Eigene Aufgabe …"**. Dann erscheinen drei Felder:

- **Funktionsname:** ein gültiger JavaScript-Name, höchstens 40 Zeichen.
- **Beschreibung:** was die Funktion tun soll (höchstens 600 Zeichen); sie wird den Agenten gezeigt, zusammen mit den Testfällen.
- **Zeitlimit je Beitrag:** wie lange ein Beitrag für alle Fälle zusammen rechnen darf: ab 1 Sekunde bis zur Obergrenze des Servers, die neben dem Feld steht (Standard 5 Sekunden; die Obergrenze setzt \`CODEMODE_MAX_TIMEOUT_S\`, Standard 60). Schwere Aufgaben brauchen mehr; die Agenten kennen das Limit. Brauchen die Fälle schon mehr als ein Drittel davon, wird nur ihre Zeit gemessen, ohne zweiten Durchgang.
- **Testfälle:** JSON, zum Beispiel \`[{"args":[2],"expect":4},{"args":[5],"expect":10}]\`. 1 bis 50 Fälle, zusammen höchstens 32 000 Zeichen.
  Du kannst auch **einfachen Text** schreiben; er wird beim Start automatisch in JSON umgewandelt, und das Feld zeigt danach das JSON:

  | Du schreibst | Daraus wird |
  |---|---|
  | \`Ergebnis: 0 1 4 9 11\` | ein Aufruf ohne Eingabe, Ergebnis \`[0,1,4,9,11]\` |
  | \`5 -> 120\` | Eingabe 5, Ergebnis 120 (auch \`=>\`) |
  | \`3 4 -> 12\` | zwei Eingaben (3 und 4), Ergebnis 12 |
  | \`[3,1,2] -> [1,2,3]\` | ein JSON-Array als Eingabe ist **ein** Argument |
  | \`Eingabe: 3 4\` und darunter \`Ergebnis: 12\` | ein Fall aus zwei Zeilen |
  | \`4 -> 2 oder -2\` | mehrere richtige Ergebnisse, eines davon genügt |

  Mehrere Fälle schreibst du untereinander, eine Zeile je Fall. Fehlen in JSON die Kommas zwischen Werten (\`[0 1 6 10]\`), werden sie ergänzt; was wie JSON beginnt, aber nicht lesbar ist, ist ein Fehler und wird nie zum Text-Ergebnis. Unter dem Feld zeigt **„Verstanden:“**, wie die Fälle gelesen wurden, bevor die Aufgabe angelegt wird.

Die Testfälle sind das **Orakel**: Ein Beitrag ist korrekt, wenn er für jeden Fall eines der erwarteten Ergebnisse liefert (Vergleich als JSON), oder, mit Prüfregel, wenn die Regel jedes Ergebnis annimmt (siehe [Mehrere richtige Ergebnisse](#check)). Die Agenten sehen die Fälle, also genau die Aufrufe und Ergebnisse. Gemessen wird die Zeit je Durchgang über alle Fälle: höchstens 300 Durchgänge oder etwa eine Sekunde, so dass auch langsame Funktionen gemessen und nicht abgebrochen werden.

## Mehrere richtige Ergebnisse {#check}

Viele Aufgaben haben **mehr als eine richtige Antwort**: eine Wurzel von 4 ist 2 oder −2, ein Weg durch ein Labyrinth, eine gültige Stundenplan-Belegung, ein Golomb-Lineal und sein Spiegelbild, eine Zerlegung in Faktoren in beliebiger Reihenfolge. Dafür gibt es zwei Wege, beide ohne Programmieren:

1. **Mehrere Ergebnisse angeben.** Schreibe alle richtigen Ergebnisse mit **„oder“** (auch \`or\` oder \`|\`) hintereinander: \`4 -> 2 oder -2\`, \`Eingabe: 5 11\` und darunter \`Ergebnis: [0,1,4,9,11] oder [0,2,7,10,11]\`. Ein Beitrag ist richtig, wenn er eines davon liefert. Das passt, wenn es wenige richtige Antworten gibt und du sie kennst.
2. **Prüfer-Agent** (Haken **„Auch andere richtige Ergebnisse zulassen“**, Standard, braucht Modell-Agenten). Beim Anlegen der Aufgabe liest ein Modell deine Beschreibung und deine Beispiele und schreibt daraus eine **Prüfregel**: eine Funktion, die für jedes Ergebnis entscheidet, ob es die Aufgabe erfüllt. Du schreibst weiterhin nur Beschreibung und Beispiele.

Bevor die Regel gilt, wird sie **gegengeprüft**: Sie muss jedes deiner Beispielergebnisse annehmen und offensichtlich falsche Ergebnisse ablehnen (zum Beispiel \`null\`, leere Werte, knapp danebenliegende Varianten deiner Beispiele). Fällt sie durch, schreibt der Prüfer-Agent sie mit der Begründung neu, höchstens dreimal. Klappt es nicht, gelten deine Beispiele als exaktes Ergebnis. Eine Protokollzeile im Block sagt, was gilt; die Regel steht sichtbar im Block, und die Agenten sehen sie.

Die Regel läuft in einer **eigenen Sandbox** auf den Ergebnissen (als JSON), auch auf zufällig gewählten Ergebnissen aus dem Benchmark. Ein Beitrag kann sie nicht austricksen, auch nicht durch Verändern von Builtins.

## Block anlegen {#create}

Das Dropdown wählt nur aus. **Lauf starten** legt bei Bedarf selbst einen neuen Block an, wenn die gewählte Aufgabe noch nicht der aktive Block ist, und startet danach den Lauf. Mit **0 Agenten** legt der Knopf nur den Block an; den Code reichst du dann selbst ein.

## Der Block im Chat {#block}

Ein Block ist ein einklappbarer Abschnitt: Im Kopf stehen Titel, Funktion, Zahl der Beiträge, korrekt/bewertet, die beste Zeit und der Laufstatus. Aufgeklappt zeigt er die Beschreibung (und die Prüfregel), die Protokollzeilen des Laufs, die **Hinweise ans Team** und die Beiträge als **quadratische Kacheln** (Agent, Modell, Zeit oder bestandene Fälle wie 3/5, Rolle und auf wessen Versuch er aufbaut, Generation, Host). Ein Klick auf eine Kachel klappt darunter die **Notiz des Agenten**, die **Testergebnisse je Fall** und den **gelieferten Code** auf.

**Rangliste, Wertung und bester Code** rechts gehören zu dem Block, der offen ist oder zuletzt angeklickt wurde („für …"). Ein neuer Block öffnet sich selbst und übernimmt diesen Fokus.

## Aktiver Block und Löschen {#active}

Der **aktive Block** (der neueste) nimmt neue Läufe und eingereichten Code auf. Ältere Blöcke bleiben zum Ansehen erhalten.

Mit dem Papierkorb im Blockkopf löschst du einen Block nach einer Ja/Nein-Rückfrage. Gelöscht wird alles, was dazugehört: Aufgabe, Beiträge, Urteile (auf big und nano), bester Code und Protokollzeilen. Ein Block mit laufendem Lauf kann nicht gelöscht werden. Löschst du den aktiven Block, wird der neueste verbleibende aktiv. Löschst du den letzten, ist der Raum leer, bis du eine neue Aufgabe anlegst.

## Siehe auch {#see-also}

- [Läufe und Teilnehmer](help.topic.runs_and_contenders#overview)
- [Bewertung und Sandbox](help.topic.judging_and_sandbox#overview)`,
			en: `## Overview {#overview}

A **task** is a function to be written. Every task that is started appears as a **block** in the chat. A room (the address after the \`#\` in the URL, for example \`/#lobby\`) holds any number of blocks, at most 60.

## Catalog tasks {#catalog}

| Task | Function | Wanted |
|---|---|---|
| Primes | \`firstPrimes(n)\` | the first n primes, ascending |
| Fibonacci | \`fib(n)\` | the n-th Fibonacci number, \`fib(0)=0\`, \`fib(1)=1\` |
| Sorting | \`sortNumbers(arr)\` | the numbers ascending, as a new array |
| gcd | \`gcd(a, b)\` | greatest common divisor of two non-negative integers |

## Custom task {#custom}

Choose **"Custom task …"** in the dropdown. Three fields appear:

- **Function name:** a valid JavaScript name, at most 40 characters.
- **Description:** what the function should do (at most 600 characters); it is shown to the agents, together with the test cases.
- **Time limit per contribution:** how long a contribution may compute for all cases together: from 1 second up to the server's upper bound shown next to the field (default 5 seconds; \`CODEMODE_MAX_TIMEOUT_S\` sets the bound, default 60). Hard tasks need more; the agents know the limit. When the cases alone take more than a third of it, only their time is measured, without a second pass.
- **Test cases:** JSON, for example \`[{"args":[2],"expect":4},{"args":[5],"expect":10}]\`. 1 to 50 cases, at most 32,000 characters together.
  You can also write **plain text**; it is turned into JSON automatically when you start, and the field then shows the JSON:

  | You write | It becomes |
  |---|---|
  | \`Result: 0 1 4 9 11\` | a call without input, result \`[0,1,4,9,11]\` |
  | \`5 -> 120\` | input 5, result 120 (also \`=>\`) |
  | \`3 4 -> 12\` | two inputs (3 and 4), result 12 |
  | \`[3,1,2] -> [1,2,3]\` | a JSON array as input is **one** argument |
  | \`Input: 3 4\` and below it \`Result: 12\` | one case from two lines |
  | \`4 -> 2 or -2\` | several right results, one of them is enough |

  Write several cases one below the other, one line per case. Commas left out between JSON values (\`[0 1 6 10]\`) are added; what starts like JSON but cannot be read is an error and never becomes a text result. Below the field, **"Understood:"** shows how the cases were read before the task is created.

The test cases are the **oracle**: a contribution is correct if it returns one of the expected results for every case (compared as JSON), or, with a check rule, if the rule accepts every result (see [Several right results](#check)). The agents see the cases, i.e. exactly the calls and results. The time measured is per pass over all cases: at most 300 passes or about a second, so slow functions are timed, not cut off.

## Several right results {#check}

Many tasks have **more than one right answer**: a square root of 4 is 2 or −2; a path through a maze, a valid timetable, a Golomb ruler and its mirror image, a factorisation in any order. There are two ways for this, neither needs programming:

1. **Give several results.** Write all right results separated by **"or"** (also \`oder\` or \`|\`): \`4 -> 2 or -2\`, or \`Input: 5 11\` with \`Result: [0,1,4,9,11] or [0,2,7,10,11]\` below it. A contribution is right if it returns one of them. This fits when there are few right answers and you know them.
2. **Verifier agent** (tick **"Accept other right results too"**, the default, needs model agents). When the task is created, a model reads your description and examples and writes a **check rule** from them: a function that decides for every result whether it fulfils the task. You still write only the description and examples.

Before the rule counts it is **cross-checked**: it must accept every one of your example results and reject obviously wrong ones (e.g. \`null\`, empty values, near misses of your examples). If it fails, the verifier agent writes it again with the reason, at most three times. If that does not work, your examples count as the exact result. A log line in the block says which applies; the rule is shown in the block, and the agents see it.

The rule runs in a **sandbox of its own** on the results (as JSON), also on randomly chosen results from the bench. A contribution cannot fool it, not even by changing builtins.

## Creating a block {#create}

The dropdown only selects. **Start run** opens a new block itself when the chosen task is not the active block yet, and then starts the run. With **0 agents** the button only creates the block; you then hand in the code yourself.

## The block in the chat {#block}

A block is a collapsible section: its header shows the title, the function, the number of contributions, correct/judged, the best time and the run status. Unfolded it shows the description (and the check rule), the run's log lines, the **hints to the team** and the contributions as **square tiles** (agent, model, time or cases passed such as 3/5, role and whose attempt it builds on, generation, host). A click on a tile unfolds the **agent's note**, the **test results per case** and the **delivered code** below it.

The **leaderboard, standings and best code** on the right belong to the block that is open or was clicked last ("for …"). A new block opens itself and takes that focus.

## Active block and deleting {#active}

The **active block** (the newest) takes new runs and handed-in code. Older blocks stay for reading.

The bin in the block header deletes a block after a yes/no question. Everything that belongs to it goes: the task, contributions, verdicts (on big and nano), best code and log lines. A block with a running run cannot be deleted. If you delete the active block, the newest remaining one becomes active. If you delete the last one, the room stays empty until you create a new task.

## See also {#see-also}

- [Runs and contenders](help.topic.runs_and_contenders#overview)
- [Judging and sandbox](help.topic.judging_and_sandbox#overview)`,
		},
	},
	{
		id: "help.topic.runs_and_contenders",
		section: "use",
		title: { de: "Läufe und Teilnehmer", en: "Runs and contenders" },
		short: { de: "Agenten, Generationen, Teilnehmer gegeneinander und wann ein Lauf endet.", en: "Agents, generations, contenders against each other, and when a run ends." },
		body: {
			de: `## Überblick {#overview}

Ein **Lauf** ist **Zusammenarbeit**, kein Wettrennen: Agenten arbeiten über mehrere **Generationen** gemeinsam an der Aufgabe des aktiven Blocks. Jede Generation sieht alle bisherigen Versuche mit ihren Testergebnissen und baut darauf auf; erst wenn alle Beiträge einer Generation bewertet sind, beginnt die nächste.

## Einstellungen {#settings}

| Einstellung | Bedeutung | Grenze |
|---|---|---|
| Agenten | Zahl der Agenten | 0 bis 8 (0 legt nur den Block an) |
| Generationen (max) | höchstens so viele Runden; gelöst endet der Lauf früher | 1 bis 10 |
| Verbesserungsrunden | Generationen nach der ersten korrekten Lösung | 0 bis 3 |
| Beiträge je Agent | Beiträge pro Agent und Generation | 1 bis 3 |
| Teilnehmer | wer die Agenten stellt | 1 bis 4 |

## Zusammenarbeit {#teamwork}

Vor jedem Beitrag bekommt ein Modell-Agent:

- die **Aufgabe mit den Testfällen** (genaue Aufrufe und erwartete Ergebnisse, gegebenenfalls die Prüfregel),
- eine **Rolle** und den Versuch, an dem er arbeiten soll,
- die **besten bisherigen Versuche** des Teams mit Code, bestandenen Fällen und Fehlern,
- die **Notizen des Teams**.

| Rolle | Kachel | Was der Agent tut |
|---|---|---|
| reparieren | 🔧 | nimmt einen Versuch, der nahe dran ist (meiste bestandene Fälle), und behebt anhand der Testergebnisse, was fehlschlägt |
| neuer Ansatz | 🧭 | probiert einen anderen Weg; jeder dritte Agent, und alle, solange es noch nichts gibt |
| verbessern | ⚡ | macht eine korrekte Lösung schneller oder einfacher, ohne sie falsch zu machen |

Die Ziele wechseln reihum über die besten Versuche, damit nicht alle am selben arbeiten. Nach seinem Code kann ein Agent eine **Notiz** für das Team hinterlassen, etwa „die Funktion bekommt keine Argumente“. Die nächsten Agenten lesen sie. Jede Kachel zeigt, auf wessen Versuch sie aufbaut (↳).

Der Lauf endet, sobald die Aufgabe **gelöst** ist und die **Verbesserungsrunden** vorbei sind, spätestens nach der höchsten Zahl Generationen.

## Auftragsbrett {#board}

Im Laufmodus **Auftragsbrett** gibt es keine Generationen. Aufträge liegen im Space, und jeder freie Agent nimmt sich den nächsten:

| Auftrag | Was der Agent tut | Danach |
|---|---|---|
| Lösung schreiben | ein neuer Ansatz, nach der Lösung eine Verbesserung | Bewertung, dann Kritik |
| Kritik | liest den Versuch eines **anderen** und schreibt ihm, was falsch ist und wie es zu beheben ist | Überarbeiten |
| Überarbeiten | schreibt den Versuch mit dieser Kritik neu (✍️) | Bewertung, dann Kritik |
| Zusammenführen | verbindet zwei Versuche, die verschiedene Testfälle bestehen (🔀) | Bewertung, dann Kritik |

**Planungsrunde** (Häkchen, Standard an): Bei einer neuen Aufgabe schlägt zuerst jeder Agent einen Ansatz vor (Algorithmus, warum er ins Zeitlimit passt, Fallstricke). Dann bewertet jeder die Vorschläge der anderen von 1 bis 5. Die ein oder zwei bestbewerteten Pläne werden umgesetzt, danach geht es mit Kritik und Überarbeitung weiter. Im Block stehen die **Pläne des Teams** mit Bewertung und wie oft sie umgesetzt wurden; ein Beitrag zeigt, nach wessen Plan er entstand.

Aufgeklappt zeigt ein Beitrag die Kritiken der anderen und, bei einer Überarbeitung, die Kritik, nach der sie entstand. Der Lauf endet, wenn die Aufgabe gelöst ist und die Verbesserungsrunden verbraucht sind, wenn keine Arbeit mehr übrig ist, am Budget oder bei Stopp. Das Auftragsbrett braucht Modell-Agenten, denn Skript-Agenten können nicht kritisieren.

**Budget** (beide Laufmodi): Obergrenze in Tokens und/oder Dollar (Listenpreis); was zuerst erreicht ist, beendet den Lauf.

## Teilnehmer {#contenders}

Unter **Teilnehmer** kreuzt du an, wer mitarbeitet: die **Skript-Agenten** und jedes erlaubte Modell. Die Agenten eines Laufs werden den Teilnehmern **reihum** zugeteilt: Agent 0 dem ersten, Agent 1 dem zweiten, und so weiter. So arbeiten zum Beispiel \`mistral/codestral-latest\` und das neueste Haiku im selben Team und bauen auf den Versuchen des jeweils anderen auf.

Das Panel **Beiträge je Teilnehmer** (rechts) zeigt je Teilnehmer, wie viele Beiträge korrekt waren und welche beste Zeit erreicht wurde.

## Skript-Agenten {#scripted}

Die Skript-Agenten brauchen kein Modell. Sie reichen handgeschriebene Varianten ein: langsame, schnelle und absichtlich falsche (zum Beispiel ein Sieb, Probedivision, ein Off-by-one). Sie zeigen, wie die Bewertung gute von schlechten Beiträgen trennt. Für eigene Aufgaben gibt es keine.

## Modell-Agenten {#model-agents}

Modell-Agenten schreiben den JavaScript-Code selbst, als Team (siehe [Zusammenarbeit](#teamwork)). Jeder Agent bekommt zusätzlich einen eigenen Stil (einfach, asymptotisch schnell, Mikro-Optimierung, ungewöhnlich), damit die Beiträge nicht auf eine Antwort zusammenfallen. Details: [Modell-Agenten](help.topic.model_agents#overview).

## Wann endet ein Lauf? {#ending}

Ein Lauf endet, wenn die Aufgabe **gelöst** ist und danach die eingestellten **Verbesserungsrunden** gelaufen sind, spätestens nach der **höchsten Zahl Generationen**, oder bei **Stoppen** (links im Lauf-Panel oder mit **■** neben „läuft“ im Blockkopf, nach einer Ja/Nein-Rückfrage). Die letzte Protokollzeile sagt, in welcher Generation gelöst wurde, oder welcher Versuch am nächsten dran war (bestandene Fälle).

## Nicht zufrieden? Weiterarbeiten {#continue}

Ein beendeter Lauf ist kein Endpunkt. Im **aktiven Block** stehen ein Feld **Hinweis ans Team** und der Knopf **▶ Weiterarbeiten**:

1. **Abwerten**, was dir nicht gefällt (👎, mit kurzem Grund). Sind alle Lösungen abgewertet, gilt die Aufgabe wieder als ungelöst.
2. **Hinweis ans Team** geben, z. B. „mit Backtracking, keine feste Tabelle“ oder „n geht bis 12, es muss schnell sein“. Der Hinweis steht als 🧑-Notiz im Block. Die Agenten bekommen ihn als Vorgabe eines Menschen, vor ihren eigenen Notizen.
3. **▶ Weiterarbeiten** startet einen neuen Lauf in **diesem** Block, mit den Einstellungen links. Es entsteht kein neuer Block: Die Agenten sehen alle bisherigen Versuche, deine Abwertungen und Hinweise und machen dort weiter. Gibt es noch eine Lösung, die du nicht abgewertet hast, verbessern sie diese in den Verbesserungsrunden.

Dasselbe passiert mit **Lauf starten**, wenn die gewählte Aufgabe schon der aktive Block ist (bei einer eigenen Aufgabe: gleicher Funktionsname und gleiche Beschreibung). Nach einem Neuladen füllt die Seite das Formular einer aktiven eigenen Aufgabe wieder aus. Änderst du die Beschreibung, entsteht ein neuer Block.

## Eigener Code während und nach dem Lauf {#human}

Code, den du über **Eigener Code** einreichst, läuft durch dieselbe Sandbox wie die Agenten, jederzeit: auch während oder nach einem Lauf. Er zählt für Rangliste und besten Code des **aktiven Blocks**. Agenten späterer Generationen sehen ihn mit seinen Testergebnissen und bauen darauf auf, wie auf die Versuche der anderen Agenten. Eingereichter Code geht immer in den aktiven Block.

## Siehe auch {#see-also}

- [Bewertung und Sandbox](help.topic.judging_and_sandbox#overview)
- [Modell-Agenten](help.topic.model_agents#overview)`,
			en: `## Overview {#overview}

A **run** is **teamwork**, not a race: agents work together on the task of the active block over several **generations**. Every generation sees all attempts so far with their test results and builds on them; only when all contributions of a generation are judged does the next one start.

## Settings {#settings}

| Setting | Meaning | Limit |
|---|---|---|
| Agents | number of agents | 0 to 8 (0 only creates the block) |
| Generations (max) | at most this many rounds; once solved the run ends earlier | 1 to 10 |
| Improvement rounds | generations after the first correct solution | 0 to 3 |
| Contributions per agent | contributions per agent and generation | 1 to 3 |
| Contenders | who provides the agents | 1 to 4 |

## Teamwork {#teamwork}

Before every contribution a model agent gets:

- the **task with its test cases** (the exact calls and expected results, and the check rule if there is one),
- a **role** and the attempt to work on,
- the team's **best attempts so far** with code, cases passed and errors,
- the **team notes**.

| Role | Tile | What the agent does |
|---|---|---|
| repair | 🔧 | takes an attempt that got close (most cases passed) and fixes what fails, guided by the test results |
| new approach | 🧭 | tries another way; every third agent, and all of them while there is nothing yet |
| improve | ⚡ | makes a correct solution faster or simpler without breaking it |

Targets rotate over the best attempts, so not everyone works on the same one. After its code an agent may leave a **note** for the team, e.g. "the function takes no arguments"; the next agents read it. Every tile shows whose attempt it builds on (↳).

The run ends once the task is **solved** and the **improvement rounds** are over, at the latest after the maximum number of generations.

## Work board {#board}

The run mode **work board** has no generations. Work items lie in the space, and every free agent takes the next one:

| Item | What the agent does | Then |
|---|---|---|
| write a solution | a new approach, after the solution an improvement | judging, then critique |
| critique | reads **another** agent's attempt and tells its author what is wrong and how to fix it | revise |
| revise | rewrites the attempt with that critique (✍️) | judging, then critique |
| merge | combines two attempts that pass different test cases (🔀) | judging, then critique |

**Planning round** (tick, on by default): for a new task every agent first proposes an approach (the algorithm, why it fits the time limit, the pitfalls). Then everyone rates the others' proposals from 1 to 5. The one or two best plans are implemented, then critique and revision go on. The block shows **the team's plans** with their rating and how often they were implemented; a contribution shows whose plan it followed.

Unfolded, a contribution shows the others' critiques and, for a revision, the critique it followed. The run ends once the task is solved and the improvement rounds are used, when no work is left, at the budget, or on Stop. The work board needs model agents, since scripted agents cannot critique.

**Budget** (both run modes): an upper bound in tokens and/or dollars (list price); whichever is reached first ends the run.

## Contenders {#contenders}

Under **Contenders** you tick who works in the run: the **scripted agents** and every allowed model. The agents of a run are assigned to the contenders **in turn**: agent 0 to the first, agent 1 to the second, and so on. So, for example, \`mistral/codestral-latest\` and the newest Haiku work in the same team and build on each other's attempts.

The **Contributions per contender** panel (right) shows, per contender, how many contributions were correct and the best time reached.

## Scripted agents {#scripted}

The scripted agents need no model. They hand in hand-written variants: slow ones, fast ones and deliberately wrong ones (for example a sieve, trial division, an off-by-one). They show how the judging separates good contributions from bad ones. There are none for custom tasks.

## Model agents {#model-agents}

Model agents write the JavaScript code themselves, as a team (see [Teamwork](#teamwork)). Each agent also gets its own style (simple, asymptotically fast, micro-optimised, unusual), so the contributions do not collapse onto one answer. Details: [Model agents](help.topic.model_agents#overview).

## When does a run end? {#ending}

A run ends once the task is **solved** and the configured **improvement rounds** have run after it, at the latest after the **maximum number of generations**, or on **Stop** (in the run panel on the left, or **■** next to "running" in the block header, after a yes/no question). The last log line says in which generation it was solved, or which attempt got closest (cases passed).

## Not happy? Keep working {#continue}

A finished run is not the end. The **active block** has a field **Hint to the team** and the button **▶ Keep working**:

1. **Reject** what you do not like (👎, with a short reason). Once every solution is rejected, the task counts as unsolved again.
2. Give a **hint to the team**, e.g. "use backtracking, no fixed table" or "n goes up to 12, it must be fast". The hint appears as a 🧑 note in the block. The agents get it as a person's guidance, before their own notes.
3. **▶ Keep working** starts a new run in **this** block, with the settings on the left. No new block is created: the agents see every attempt so far, your rejections and hints, and carry on from there. If a solution you did not reject is left, they improve it in the improvement rounds.

**Start run** does the same when the chosen task already is the active block (for a custom task: same function name and description). After a reload the page fills in the form of an active custom task again. If you change the description, a new block is created.

## Your own code during and after a run {#human}

Code you hand in under **Your code** goes through the same sandbox as the agents', at any time: also during or after a run. It counts for the leaderboard and the best code of the **active block**. Agents of later generations see it with its test results and build on it, like on the other agents' attempts. Handed-in code always goes to the active block.

## See also {#see-also}

- [Judging and sandbox](help.topic.judging_and_sandbox#overview)
- [Model agents](help.topic.model_agents#overview)`,
		},
	},
	{
		id: "help.topic.judging_and_sandbox",
		section: "use",
		title: { de: "Bewertung und Sandbox", en: "Judging and sandbox" },
		short: { de: "Wie ein Beitrag geprüft wird: Sandbox, Testfälle, Zeit, Urteil.", en: "How a contribution is checked: sandbox, test cases, time, verdict." },
		body: {
			de: `## Überblick {#overview}

Jeder Beitrag, egal ob von einem Skript-Agenten, einem Modell oder einer Person, geht denselben Weg. Der Code ist dabei **Daten**: Er wird nie als Anweisung an den Server behandelt, sondern nur in der Sandbox ausgeführt.

## Der Weg eines Beitrags {#flow}

1. Der Beitrag wird als \`CodeCandidate\` in den Space geschrieben.
2. Ein **Richter** nimmt ihn unter einer **Transaktion** heraus (\`take\`).
3. Der Richter führt den Code in einer frischen QuickJS-Sandbox aus.
4. Er schreibt ein \`CodeScore\` mit Urteil, Zeit, Host und dem Code und **bestätigt** die Transaktion (\`commit\`). Entnahme und Urteil sind so ein atomarer Schritt: Stürzt ein Richter vorher ab, wird der Beitrag nach Ablauf der Lease wieder frei.
5. Ist der Beitrag korrekt und schneller als der bisherige Bestwert seines Blocks, wird \`CodeBest\` aktualisiert.

## Die Sandbox {#sandbox}

Die Sandbox ist QuickJS (WebAssembly) aus \`@earendil-works/pi-codemode\`. Sie hat **keine Werkzeuge, keine Dateien, kein Netz, keine Timer** und kein Node. Code kann also nichts außerhalb von sich selbst erreichen; es gibt nur reine Berechnung.

| Limit | Wert |
|---|---|
| Zeitlimit | 5 Sekunden; eigene Aufgaben wählen es selbst (Feld „Zeitlimit je Beitrag“), höchstens \`CODEMODE_MAX_TIMEOUT_S\` (Standard 60 Sekunden) |
| Arbeitsspeicher | 64 MiB |
| Quelltext | höchstens 16 000 Zeichen |
| Parallele Sandboxes | höchstens 2 je Prozess |

## Das Urteil {#verdict}

Zuerst werden die **Testfälle** geprüft, dann läuft der Benchmark mit einer großen Eingabe: seine Zeit wird gemessen und sein Ergebnis ebenfalls geprüft. Code, der nur die kleinen Fälle richtig hat, gewinnt also nicht. Das Ergebnis ist:

- **korrekt** mit der gemessenen Zeit in Millisekunden,
- **falsch**, mit der Zahl der bestandenen Fälle (z. B. 3/5) und je Fall dem gelieferten und dem erwarteten Ergebnis oder dem Fehler, oder „Zeit überschritten".

Geprüft werden **alle** Fälle, nicht nur bis zum ersten Fehler. So sieht man (und sehen die Agenten), wie nahe ein Versuch an der Lösung ist und woran er scheitert.

## So nicht: fest eingetragen und abgewertet {#rejected}

Ein Beitrag soll das Ergebnis **berechnen**. Steht ein erwartetes Ergebnis als fester Wert im Code (zum Beispiel \`return [0, 1, 4, 9, 11]\`), gilt er als **„Ergebnis fest eingetragen“** und nicht als korrekt, auch wenn alle Fälle stimmen. Erkannt werden Listen, Objekte und Texte ab sechs Zeichen und Zahlen ab sechs Stellen.

Was die Automatik nicht erkennt, wertest du selbst ab: Im aufgeklappten Code steht **👎 So nicht**. Eine kurze Begründung ist optional, die Agenten lesen sie. Ein abgewerteter Beitrag zählt nicht mehr als korrekt, nicht in der Rangliste und nicht als bester Code; ein laufender Lauf gilt dann wieder als ungelöst und arbeitet weiter. **Zurücknehmen** hebt die Abwertung auf.

Fest eingetragene und abgewertete Versuche bekommen die Agenten als **„so nicht“** samt Grund gezeigt; sie bauen nicht darauf auf.

**Bester Code** ist der schnellste korrekte Beitrag eines Blocks; bei gleicher Zeit gewinnt der frühere. Die Zeit ist Wandzeit und schwankt etwas von Lauf zu Lauf.

Die **Notiz** eines Agenten gehört zu seinem Beitrag: Aufgeklappt steht sie oben als Beschreibung des Versuchs (beim Überfahren der Kachel auch als Tooltip). Oben im Block stehen nur die Hinweise von Menschen.

## Die Kachel {#tile}

| Zustand | Darstellung |
|---|---|
| wartet | gestrichelter Rand, „…" |
| korrekt | grüner Rand, Zeit in ms |
| teilweise | gelber Rand, bestandene Fälle wie 3/5 |
| falsch | roter Rand, ✗ oder 0/5 (die Gründe je Fall stehen im aufgeklappten Code) |
| bester | ★ in der Ecke |

## Code ausführen {#run}

Unter jedem aufgeklappten Code und unter dem besten Code steht **▶ Ausführen**. Es öffnet eine Konsole:

1. Optional einen eigenen Aufruf eintragen, z. B. \`firstPrimes(20)\`.
2. **▶ Ausführen** lässt die Funktion in derselben Sandbox gegen die Testfälle der Aufgabe laufen (✓/✗ je Fall, bei ✗ mit dem erwarteten Wert) und danach den eigenen Aufruf; dessen Wert erscheint als \`Aufruf = Wert\`.
3. Ausgaben mit \`console.log\` erscheinen sofort, auch während der Code noch rechnet. **■ Stop** beendet den Lauf.

Ein Lauf wird nicht bewertet und ändert nichts im Space. Grenzen: 60 Sekunden (oder das Zeitlimit der Aufgabe, wenn es länger ist), ein Lauf je Besucher, zwei gleichzeitig auf dem Server, höchstens 1000 Zeilen Ausgabe.

## Siehe auch {#see-also}

- [big und nano](help.topic.big_and_nano#overview)
- [Sicherheit und Grenzen](help.topic.safety_and_limits#overview)`,
			en: `## Overview {#overview}

Every contribution, whether from a scripted agent, a model or a person, takes the same path. The code is **data** throughout: it is never treated as an instruction to the server, it only runs in the sandbox.

## The path of a contribution {#flow}

1. The contribution is written into the space as a \`CodeCandidate\`.
2. A **judge** takes it out under a **transaction** (\`take\`).
3. The judge runs the code in a fresh QuickJS sandbox.
4. It writes a \`CodeScore\` with verdict, time, host and the code, and **commits** the transaction (\`commit\`). Taking and verdict are one atomic step: if a judge crashes before that, the contribution becomes free again when the lease lapses.
5. If the contribution is correct and faster than the best of its block so far, \`CodeBest\` is updated.

## The sandbox {#sandbox}

The sandbox is QuickJS (WebAssembly) from \`@earendil-works/pi-codemode\`. It has **no tools, no files, no network, no timers** and no Node. Code cannot reach anything outside itself; there is only pure computation.

| Limit | Value |
|---|---|
| Time limit | 5 seconds; custom tasks choose their own (field "Time limit per contribution"), at most \`CODEMODE_MAX_TIMEOUT_S\` (default 60 seconds) |
| Memory | 64 MiB |
| Source | at most 16,000 characters |
| Parallel sandboxes | at most 2 per process |

## The verdict {#verdict}

The **test cases** are checked first, then the bench runs on a large input: its time is measured and its result is checked as well, so code that is only right on the small cases does not win. The result is:

- **correct**, with the measured time in milliseconds,
- **wrong**, with the number of cases passed (e.g. 3/5) and per case the result and the expected one, or the error, or "time exceeded".

**All** cases are checked, not only up to the first failure. So you (and the agents) see how close an attempt is to the solution and where it fails.

## Not like this: hard-coded and rejected {#rejected}

A contribution should **compute** the result. If an expected result stands in the code as a fixed value (for example \`return [0, 1, 4, 9, 11]\`), it counts as **"result hard-coded"** and not as correct, even when every case passes. Detected are lists, objects and strings of six or more characters and numbers with six or more digits.

What the automatic check misses you reject yourself: the unfolded code has **👎 Not like this**. A short reason is optional; the agents read it. A rejected contribution no longer counts as correct, not on the leaderboard and not as the best code; a running run then counts as unsolved again and goes on. **Withdraw** lifts the rejection.

Hard-coded and rejected attempts are shown to the agents as **"not like this"** with the reason; they do not build on them.

The **best code** is the fastest correct contribution of a block; on equal time the earlier one wins. The time is wall-clock time and varies a little from run to run.

An agent's **note** belongs to its contribution: unfolded, it stands on top as the description of the attempt (and as the tile's tooltip). The top of the block shows only people's hints.

## The tile {#tile}

| State | Display |
|---|---|
| waiting | dashed border, "…" |
| correct | green border, time in ms |
| partly | yellow border, cases passed such as 3/5 |
| wrong | red border, ✗ or 0/5 (the reasons per case are in the unfolded code) |
| best | ★ in the corner |

## Running code {#run}

Below every unfolded code and below the best code there is **▶ Run**. It opens a console:

1. Optionally enter an own call, e.g. \`firstPrimes(20)\`.
2. **▶ Run** runs the function in the same sandbox against the task's test cases (✓/✗ per case, with the expected value on ✗) and then the own call; its value appears as \`call = value\`.
3. Output of \`console.log\` appears at once, also while the code is still computing. **■ Stop** ends the run.

A run is not scored and changes nothing in the space. Limits: 60 seconds (or the task's time limit when that is longer), one run per visitor, two at a time on the server, at most 1000 lines of output.

## See also {#see-also}

- [big and nano](help.topic.big_and_nano#overview)
- [Safety and limits](help.topic.safety_and_limits#overview)`,
		},
	},
	{
		id: "help.topic.model_agents",
		section: "use",
		title: { de: "Modell-Agenten", en: "Model agents" },
		short: { de: "Echte Modelle als Teilnehmer: Freigabe, erlaubte Modelle, Grenzen, Kosten.", en: "Real models as contenders: enabling, allowed models, limits, cost." },
		body: {
			de: `## Überblick {#overview}

Modell-Agenten sind standardmäßig **aus**. Ohne sie bleiben nur die Skript-Agenten und dein eigener Code. Die Auswahl ist wie im phi-spaces-Hilfesystem: ein kleines, festes Angebot, damit Kosten und Verhalten überschaubar bleiben.

## Einschalten {#enable}

Setze \`CODEMODE_CHAT_LLM=1\` und sorge für Zugangsdaten: Umgebungsvariablen des Anbieters oder die Datei \`~/.pi/agent/auth.json\` der pi-CLI (im Docker-Container wird \`~/.pi/agent\` lesend eingehängt, \`PI_AUTH_DIR\`). Zugangsdaten allein schalten nichts ein.

## Erlaubte Modelle {#models}

Welche Modelle mitarbeiten dürfen, legt der Betreiber im **Admin-Panel** links unten fest: Anmeldung mit dem Admin-Token (\`CODEMODE_ADMIN_TOKEN\`), dann Modell-Agenten an/aus und alle Modelle mit Zugangsdaten, nach Anbieter gruppiert. Das Kästchen eines Anbieters wählt alle seine Modelle, darunter lassen sich einzelne an- und abwählen; **Speichern** übernimmt die Auswahl dauerhaft (sie liegt im Space und übersteht einen Neustart), **Standard** kehrt zur Grundeinstellung zurück: \`codestral-latest\` (Mistral) und das neueste Haiku. In der Kopfzeile steht die Zahl der erlaubten Modelle; ausgewählt wird im Lauf-Panel unter **Teilnehmer** (Mehrfachauswahl). \`CODEMODE_CHAT_MODEL\` wählt per Teilname das Standardmodell, \`CODEMODE_VERIFIER_MODEL\` das des Prüfer-Agenten und \`CODEMODE_CRITIC_MODEL\` das, das im Auftragsbrett zuerst kritisiert (beide Standard \`haiku\`).

## Grenzen {#limits}

| Limit | Wert |
|---|---|
| Parallele Aufrufe | 2 (weitere warten auf einen freien Platz) |
| Aufrufe pro Minute | \`CODEMODE_LLM_PER_MIN\`, Standard 20, für alle Teilnehmer zusammen |
| Aufrufe pro Tag | \`CODEMODE_LLM_PER_DAY\`, Standard 500 |
| Ausgabe je Aufruf | höchstens 1500 Token (Code und eine Notiz) |
| Zeit je Aufruf | 60 Sekunden |

Ist das Minutenlimit erreicht, **wartet** der Agent auf die nächste Minute. Ist das Tageslimit erreicht oder das Modell nicht verfügbar, fällt der Agent auf eine **Skript-Variante** zurück (der Grund steht als Hinweis im Lauf-Panel). Bei eigenen Aufgaben, die keine Skript-Varianten haben, liefert der Agent dann nichts.

## Kosten {#cost}

Jeder Beitrag eines Modell-Agenten kostet Token: einige Tausend je Aufruf, denn der Agent liest die Versuche des Teams mit. Starte Läufe mit Modellen bewusst: Agenten × Generationen × Beiträge je Agent ist die höchste Zahl der Aufrufe; ein gelöster Lauf endet früher.

**Verbrauch sehen:** Jede Kachel eines Modell-Agenten zeigt Tokens und Kosten ihres Aufrufs (z. B. „3,2k Tok · $0,0040“), der aufgeklappte Beitrag die Aufteilung in Eingabe, Ausgabe und Cache. Der Blockkopf zeigt die Summe des Blocks (Σ, inklusive Prüfer-Agent), das Lauf-Panel die Summe des laufenden Laufs. Die Zahlen meldet der Anbieter über pi-ai; die Kosten sind der **Listenpreis** laut Modellkatalog in US-Dollar. Bei Zugang über ein Abo (pi-CLI-Anmeldung) zahlst du nicht pro Token, dann sind sie nur ein Richtwert.

## Siehe auch {#see-also}

- [Läufe und Teilnehmer](help.topic.runs_and_contenders#overview)
- [Konfiguration und Start](help.topic.configuration#overview)`,
			en: `## Overview {#overview}

Model agents are **off** by default. Without them only the scripted agents and your own code remain. The offer is like in the phi-spaces help system: a small, fixed choice, to keep cost and behaviour manageable.

## Enabling {#enable}

Set \`CODEMODE_CHAT_LLM=1\` and provide credentials: the provider's environment variables or the pi CLI's \`~/.pi/agent/auth.json\` (the Docker container mounts \`~/.pi/agent\` read-only, \`PI_AUTH_DIR\`). Credentials alone enable nothing.

## Allowed models {#models}

Which models may work is set by the operator in the **admin panel** at the bottom left: sign in with the admin token (\`CODEMODE_ADMIN_TOKEN\`), then model agents on/off and every model with credentials, grouped by provider. A provider's box selects all of its models, below it single models can be ticked; **Save** keeps the choice (it lives in the space and survives a restart), **Default** returns to the basic setting: \`codestral-latest\` (Mistral) and the newest Haiku. The header shows the number of allowed models; you pick in the run panel under **Contenders** (multi-select). \`CODEMODE_CHAT_MODEL\` selects the default model by a part of its name, \`CODEMODE_VERIFIER_MODEL\` the verifier agent's and \`CODEMODE_CRITIC_MODEL\` the one that critiques first on the work board (both default \`haiku\`).

## Limits {#limits}

| Limit | Value |
|---|---|
| Parallel calls | 2 (more wait for a free slot) |
| Calls per minute | \`CODEMODE_LLM_PER_MIN\`, default 20, for all contenders together |
| Calls per day | \`CODEMODE_LLM_PER_DAY\`, default 500 |
| Output per call | at most 1500 tokens (code and a note) |
| Time per call | 60 seconds |

When the per-minute limit is reached the agent **waits** for the next minute. When the daily limit is reached or the model is unavailable, the agent falls back to a **scripted variant** (the reason appears as a note in the run panel). For custom tasks, which have no scripted variants, the agent then delivers nothing.

## Cost {#cost}

Every contribution of a model agent costs tokens: a few thousand per call, since the agent reads the team's attempts. Start runs with models deliberately: agents × generations × contributions per agent is the most calls; a solved run ends earlier.

**Seeing the usage:** every tile of a model agent shows the tokens and cost of its call (e.g. "3.2k Tok · $0.0040"), the unfolded contribution the split into input, output and cache. The block header shows the block's sum (Σ, the verifier agent included), the run panel the sum of the current run. The provider reports the numbers through pi-ai; the cost is the **list price** from the model catalog in US dollars. With subscription access (pi CLI login) you do not pay per token, so it is only a guide.

## See also {#see-also}

- [Runs and contenders](help.topic.runs_and_contenders#overview)
- [Configuration and startup](help.topic.configuration#overview)`,
		},
	},
	{
		id: "help.topic.big_and_nano",
		section: "operate",
		title: { de: "big und nano", en: "big and nano" },
		short: { de: "Zwei getrennte Server: der Hub (big) und der Bewertungs-Shard (nano).", en: "Two separate servers: the hub (big) and the judging shard (nano)." },
		body: {
			de: `## Überblick {#overview}

Wie das phi-spaces-Hilfesystem läuft der Codemode-Chat auf zwei Hosts: **big** ist der Hub, **nano** ein optionaler Shard, der Beiträge auf seiner CPU bewertet. Beide sind getrennte Server mit eigener \`.env\`.

## big (Hub) {#hub}

Der Hub (\`server/index.ts\`) bedient die Oberfläche (Next.js), die REST-API, die WebSocket-Verbindungen, den Chat und die Aufgabenzustände. Er hat eigene Richter, die lokal bewerten.

## nano (Shard) {#shard}

nano (\`server/nano-host.ts\`) ist ein Host ohne Oberfläche: eigener Space mit eigener SQLite-Datei, über den phi-spaces-Socket erreichbar (\`CODEMODE_LISTEN\`). Seine Richter (\`CODEMODE_JUDGES\`, Standard 2) laufen in **nanos** Sandbox. So fällt die Rechenlast der Bewertung auf nano.

## Zusammenspiel {#interplay}

Ist auf dem Hub \`CODEMODE_REMOTE\` gesetzt, geht **jeder zweite Beitrag** in nanos Space und kommt dort als \`CodeScore\` zurück. Der Hub führt beide Listen zusammen; die Kachel nennt den Host, der bewertet hat. Die **Systemleiste** unten zeigt beide Hosts mit CPU, Speicher und Zahl der bewerteten Beiträge.

Ist nano nicht erreichbar (Aufrufe sind auf 8 Sekunden begrenzt, danach gilt nano 15 Sekunden als ausgefallen), bewertet der Hub alles selbst. Beim **Löschen eines Blocks** werden auch nanos Urteile entfernt.

## Verbindung {#connection}

| Weg | \`CODEMODE_REMOTE\` auf big |
|---|---|
| lokal, ein Rechner | \`unix:/tmp/codemode-b.sock\` |
| zwei Server | \`tcp:<nano-ip>:3800\` |
| SSH-Tunnel | \`tcp:127.0.0.1:3800\` (der Hub-Container nutzt das Host-Netz) |

Der Socket hat **kein TLS**: binde ihn an eine interne Adresse (\`CODEMODE_SHARD_BIND\`) oder nutze einen Tunnel. Das ist eine Demo-Verdrahtung, kein replizierter Cluster.

## Siehe auch {#see-also}

- [Konfiguration und Start](help.topic.configuration#overview)
- [Bewertung und Sandbox](help.topic.judging_and_sandbox#overview)`,
			en: `## Overview {#overview}

Like the phi-spaces help system, the codemode chat runs on two hosts: **big** is the hub, **nano** an optional shard that judges contributions on its CPU. They are separate servers, each with its own \`.env\`.

## big (hub) {#hub}

The hub (\`server/index.ts\`) serves the interface (Next.js), the REST API, the WebSocket connections, the chat and the task state. It has its own judges that work locally.

## nano (shard) {#shard}

nano (\`server/nano-host.ts\`) is a host without an interface: its own space with its own SQLite file, reachable over the phi-spaces socket (\`CODEMODE_LISTEN\`). Its judges (\`CODEMODE_JUDGES\`, default 2) run in **nano's** sandbox. So the judging load lands on nano.

## How they work together {#interplay}

With \`CODEMODE_REMOTE\` set on the hub, **every second contribution** goes into nano's space and comes back there as a \`CodeScore\`. The hub merges both lists; the tile names the host that judged. The **system bar** at the bottom shows both hosts with CPU, memory and the number of judged contributions.

If nano is unreachable (calls are bounded to 8 seconds, then nano counts as down for 15 seconds) the hub judges everything itself. **Deleting a block** also removes nano's verdicts.

## Connection {#connection}

| Way | \`CODEMODE_REMOTE\` on big |
|---|---|
| local, one machine | \`unix:/tmp/codemode-b.sock\` |
| two servers | \`tcp:<nano-ip>:3800\` |
| SSH tunnel | \`tcp:127.0.0.1:3800\` (the hub container uses the host network) |

The socket has **no TLS**: bind it to an internal address (\`CODEMODE_SHARD_BIND\`) or use a tunnel. This is a demo wiring, not a replicated cluster.

## See also {#see-also}

- [Configuration and startup](help.topic.configuration#overview)
- [Judging and sandbox](help.topic.judging_and_sandbox#overview)`,
		},
	},
	{
		id: "help.topic.configuration",
		section: "operate",
		title: { de: "Konfiguration und Start", en: "Configuration and startup" },
		short: { de: "Umgebungsvariablen, lokale Entwicklung, Docker (dev, test, production, nano).", en: "Environment variables, local development, Docker (dev, test, production, nano)." },
		body: {
			de: `## Überblick {#overview}

Die Server lesen \`codemode-chat/.env\` selbst; echte Umgebungsvariablen haben Vorrang. Eine Vorlage liegt in \`.env.example\`. Der Aufbau entspricht dem phi-spaces-Hilfesystem, mit \`CODEMODE_*\`-Variablen für alles Codemode-Spezifische.

## Variablen {#variables}

| Key | Bedeutung |
|---|---|
| \`PORT\` | Port des Hubs, Standard 3700 |
| \`CODEMODE_BIND\` | Bind-Adresse des Servers, Standard \`127.0.0.1\` |
| \`HOST_BIND\` | Docker: veröffentlichte Adresse; leer = alle, \`127.0.0.1\` = nur lokal |
| \`CODEMODE_SQLITE\` | Speicher des Hubs, Standard \`.local/codemode-chat.sqlite\` |
| \`CODEMODE_HOST_NAME\` | Name in der Systemleiste, Standard der Hostname |
| \`CODEMODE_CHAT_LLM\` | \`1\` schaltet Modell-Agenten ein |
| \`CODEMODE_CHAT_MODEL\` | Teilname des Standardmodells |
| \`CODEMODE_VERIFIER_MODEL\` | Teilname des Modells, mit dem der Prüfer-Agent Prüfregeln schreibt, Standard \`haiku\` |
| \`CODEMODE_LLM_PER_MIN\` | Modellaufrufe pro Minute, Standard 20 |
| \`CODEMODE_LLM_PER_DAY\` | Modellaufrufe pro Tag, Standard 500 (Kostendeckel) |
| \`CODEMODE_REMOTE\` | Hub: Adresse des Shards (\`unix:…\` oder \`tcp:host:port\`) |
| \`CODEMODE_LISTEN\` | nano: Adresse, an der der Shard lauscht |
| \`CODEMODE_DB\` | nano: Speicher; \`CODEMODE_MEM=1\` = nur im Speicher |
| \`CODEMODE_JUDGES\` | nano: parallele Richter, Standard 2 |
| \`CODEMODE_TTL_HOURS\` | Hub und nano: Lebensdauer der Einträge eines Raums in Stunden, Standard 24; \`0\` = bis der Block gelöscht wird |
| \`CODEMODE_SHARD_BIND\` | Docker nano: Bindung des Shard-Ports, Standard \`127.0.0.1\` (Tunnel); sonst eine interne IP, nie eine öffentliche |
| \`CODEMODE_ADMIN_TOKEN\` | Hub: Token für \`POST /api/llm\` (Header \`x-admin-token\`); leer = Umschalten aus |
| \`CODEMODE_MAX_TIMEOUT_S\` | Hub und nano (gleicher Wert): höchstes Zeitlimit je Beitrag, das eine eigene Aufgabe wählen darf, Standard 60; das Formularfeld richtet sich danach. Ein langes Limit belegt einen der zwei Bewertungsplätze je Prozess entsprechend lange |
| \`CODEMODE_REQ_PER_MIN\` | Hub: API-Anfragen und WebSocket-Verbindungen je Client-IP und Minute, Standard 120 |
| \`PI_AUTH_DIR\` | Pfad der pi-Zugangsdaten für den Container |
| \`CODEMODE_DEV_ORIGINS\` | nur Dev-Modus: weitere Hosts, unter denen die Seite geöffnet wird (z. B. eine LAN-IP); \`localhost\` und \`127.0.0.1\` gehen immer |

## Lokal entwickeln {#local}

\`\`\`bash
npm --prefix codemode-chat run dev            # Next.js Dev-Modus, http://localhost:3700
npm --prefix codemode-chat run shards:start   # Hub + nano über einen Unix-Socket
npm --prefix codemode-chat run build && npm --prefix codemode-chat start   # Produktion
npm run test:codemode-chat                    # Tests
\`\`\`

Im Dev-Modus lädt Next.js \`app/\` und \`client/\` bei jeder Änderung neu, und \`node --watch-path\` startet den Server neu, wenn sich \`server/\` oder die phi-spaces-Quellen ändern. Öffne die Dev-Seite über \`http://localhost:3700\`: Next.js 16 hydratisiert Dev-Seiten über \`127.0.0.1\` nicht.

## Docker {#docker}

Der Build-Kontext ist das Repository. **Produktion und nano sind zwei getrennte Server**, jeder mit eigener \`.env\`.

\`\`\`bash
npm --prefix codemode-chat run docker:prod:up   # big: Host-Netz, HOST_BIND für den Reverse-Proxy
npm --prefix codemode-chat run docker:nano:up   # nano: veröffentlicht :3800
npm --prefix codemode-chat run docker:dev:up    # Entwicklung im Container (Quellen eingehängt)
npm --prefix codemode-chat run docker:test      # Tests im Container
\`\`\`

Die Ports 3700 (Hub) und 3800 (Shard) kollidieren nicht mit dem Hilfesystem (3500/3600). Beispiele für Caddy, nginx und systemd liegen in \`deploy/\`.

## Siehe auch {#see-also}

- [big und nano](help.topic.big_and_nano#overview)
- [Sicherheit und Grenzen](help.topic.safety_and_limits#overview)`,
			en: `## Overview {#overview}

The servers read \`codemode-chat/.env\` themselves; real environment variables win. A template is in \`.env.example\`. The layout matches the phi-spaces help system, with \`CODEMODE_*\` variables for everything codemode-specific.

## Variables {#variables}

| Key | Meaning |
|---|---|
| \`PORT\` | hub port, default 3700 |
| \`CODEMODE_BIND\` | bind address of the server, default \`127.0.0.1\` |
| \`HOST_BIND\` | Docker: published address; empty = all, \`127.0.0.1\` = local only |
| \`CODEMODE_SQLITE\` | hub storage, default \`.local/codemode-chat.sqlite\` |
| \`CODEMODE_HOST_NAME\` | name in the system bar, default the hostname |
| \`CODEMODE_CHAT_LLM\` | \`1\` enables model agents |
| \`CODEMODE_CHAT_MODEL\` | part of the default model name |
| \`CODEMODE_VERIFIER_MODEL\` | part of the name of the model the verifier agent writes check rules with, default \`haiku\` |
| \`CODEMODE_LLM_PER_MIN\` | model calls per minute, default 20 |
| \`CODEMODE_LLM_PER_DAY\` | model calls per day, default 500 (cost cap) |
| \`CODEMODE_REMOTE\` | hub: address of the shard (\`unix:…\` or \`tcp:host:port\`) |
| \`CODEMODE_LISTEN\` | nano: address the shard listens on |
| \`CODEMODE_DB\` | nano: storage; \`CODEMODE_MEM=1\` = in memory only |
| \`CODEMODE_JUDGES\` | nano: parallel judges, default 2 |
| \`CODEMODE_TTL_HOURS\` | hub and nano: lifetime of a room's entries in hours, default 24; \`0\` = until the block is deleted |
| \`CODEMODE_SHARD_BIND\` | Docker nano: bind address of the shard port, default \`127.0.0.1\` (tunnel); else an internal IP, never a public one |
| \`CODEMODE_ADMIN_TOKEN\` | hub: token for \`POST /api/llm\` (header \`x-admin-token\`); empty = switching off |
| \`CODEMODE_MAX_TIMEOUT_S\` | hub and nano (same value): the longest time limit per contribution a custom task may choose, default 60; the form's field follows it. A long limit keeps one of the two judge slots per process busy that long |
| \`CODEMODE_REQ_PER_MIN\` | hub: API requests and WebSocket connects per client IP and minute, default 120 |
| \`PI_AUTH_DIR\` | path of the pi credentials for the container |
| \`CODEMODE_DEV_ORIGINS\` | dev mode only: further hosts the page is opened from (e.g. a LAN IP); \`localhost\` and \`127.0.0.1\` always work |

## Developing locally {#local}

\`\`\`bash
npm --prefix codemode-chat run dev            # Next.js dev mode, http://localhost:3700
npm --prefix codemode-chat run shards:start   # hub + nano over a unix socket
npm --prefix codemode-chat run build && npm --prefix codemode-chat start   # production
npm run test:codemode-chat                    # tests
\`\`\`

In dev mode Next.js reloads \`app/\` and \`client/\` on every change, and \`node --watch-path\` restarts the server when \`server/\` or the phi-spaces sources change. Open the dev page as \`http://localhost:3700\`: Next.js 16 does not hydrate dev pages requested through \`127.0.0.1\`.

## Docker {#docker}

The build context is the repository. **Production and nano are two separate servers**, each with its own \`.env\`.

\`\`\`bash
npm --prefix codemode-chat run docker:prod:up   # big: host network, HOST_BIND for the reverse proxy
npm --prefix codemode-chat run docker:nano:up   # nano: publishes :3800
npm --prefix codemode-chat run docker:dev:up    # development in a container (sources mounted)
npm --prefix codemode-chat run docker:test      # tests in a container
\`\`\`

Ports 3700 (hub) and 3800 (shard) do not collide with the help system (3500/3600). Examples for Caddy, nginx and systemd are in \`deploy/\`.

## See also {#see-also}

- [big and nano](help.topic.big_and_nano#overview)
- [Safety and limits](help.topic.safety_and_limits#overview)`,
		},
	},
	{
		id: "help.topic.safety_and_limits",
		section: "reference",
		title: { de: "Sicherheit und Grenzen", en: "Safety and limits" },
		short: { de: "Was der Server begrenzt und was die App nicht schützt.", en: "What the server limits and what the app does not protect." },
		body: {
			de: `## Überblick {#overview}

Der Chat führt fremden Code aus. Deshalb gilt: **Code ist Daten**, und er läuft nur in der Sandbox. Außerdem begrenzt der Server, was ein Raum und ein Teilnehmer tun können.

## Grenzen {#limits}

| Limit | Wert |
|---|---|
| Quelltext je Beitrag | 16 000 Zeichen |
| Eingereichter Code | 20 pro Minute und Raum |
| Läufe | 6 pro Minute und Raum |
| Neue Aufgaben | 30 pro Minute und Raum |
| Löschungen | 20 pro Minute und Raum |
| Aufgabenblöcke | höchstens 60 je Raum |
| Räume | höchstens 50 gleichzeitig im Speicher |
| WebSocket-Verbindungen | höchstens 256 |
| Anfragekörper | höchstens 64 000 Byte |

## Was nicht geschützt ist {#unprotected}

- **Keine Anmeldung:** Eingereichter Code wird mit einem Gastnamen signiert, den der Browser sich merkt. Jeder im Raum kann Aufgaben anlegen, Läufe starten und Blöcke löschen.
- **Offene Räume:** Wer die Adresse kennt, ist im Raum.
- **Kein TLS am Shard-Socket:** siehe [big und nano](help.topic.big_and_nano#connection).

Stelle die App deshalb nicht ohne Reverse-Proxy (und gegebenenfalls Zugriffsschutz) öffentlich zur Verfügung.

## Die Sandbox {#sandbox}

Siehe [Bewertung und Sandbox](help.topic.judging_and_sandbox#sandbox): keine Werkzeuge, Dateien, Netz oder Timer; 5 Sekunden (eigene Aufgaben: einstellbar), 64 MiB.

## Siehe auch {#see-also}

- [API](help.topic.api#overview)
- [Konfiguration und Start](help.topic.configuration#overview)`,
			en: `## Overview {#overview}

The chat runs foreign code. So: **code is data**, and it only runs in the sandbox. The server also limits what a room and a participant can do.

## Limits {#limits}

| Limit | Value |
|---|---|
| Source per contribution | 16,000 characters |
| Handed-in code | 20 per minute and room |
| Runs | 6 per minute and room |
| New tasks | 30 per minute and room |
| Deletions | 20 per minute and room |
| Task blocks | at most 60 per room |
| Rooms | at most 50 in memory at a time |
| WebSocket connections | at most 256 |
| Request body | at most 64,000 bytes |

## What is not protected {#unprotected}

- **No sign-in:** handed-in code is signed with a guest name that the browser remembers. Anyone in a room can create tasks, start runs and delete blocks.
- **Open rooms:** whoever knows the address is in the room.
- **No TLS on the shard socket:** see [big and nano](help.topic.big_and_nano#connection).

So do not make the app public without a reverse proxy (and access protection where needed).

## The sandbox {#sandbox}

See [Judging and sandbox](help.topic.judging_and_sandbox#sandbox): no tools, files, network or timers; 5 seconds (custom tasks: adjustable), 64 MiB.

## See also {#see-also}

- [API](help.topic.api#overview)
- [Configuration and startup](help.topic.configuration#overview)`,
		},
	},
	{
		id: "help.topic.api",
		section: "reference",
		title: { de: "API", en: "API" },
		short: { de: "REST-Endpunkte und der WebSocket des Servers.", en: "The server's REST endpoints and WebSocket." },
		body: {
			de: `## Überblick {#overview}

Die Oberfläche nutzt eine kleine JSON-API. Alle Antworten sind JSON; Fehler haben Status 400 und \`{"error": "…"}\`. Raumnamen bestehen aus Buchstaben, Ziffern, \`.\`, \`_\` und \`-\` (1 bis 48 Zeichen). Zu viele Anfragen einer IP beantwortet der Server mit 429, ein Admin-Aufruf ohne Token mit 403.

## REST {#rest}

| Endpunkt | Wirkung |
|---|---|
| \`GET /healthz\` | Lebenszeichen |
| \`GET /api/tasks\` | Katalog der Aufgaben |
| \`GET /api/system\` | Hosts der Systemleiste |
| \`GET /api/llm\` | verfügbare Modelle |
| \`POST /api/llm\` | Modell-Agenten an/aus, Standardmodell: \`{on,model}\`; nur mit Header \`x-admin-token\` |
| \`GET /api/sessions/:id\` | Zustand eines Raums (Blöcke, Chat, Lauf); in großen Räumen fehlt manchem Beitrag der Code (\`sourceOmitted\`) |
| \`GET /api/sessions/:id/source/:candidateId\` | Code, Testergebnisse und Herkunft eines Beitrags: \`{source, cases, passed, total, role, basedOn}\` |
| \`POST /api/sessions/:id/exec\` | einen Beitrag ausführen: \`{candidateId, call?}\`; Antwort als NDJSON-Strom (\`start\`, \`case\`, \`log\`, \`value\`, \`error\`, \`end\`), Abbruch der Anfrage stoppt den Lauf |
| \`POST /api/sessions/:id/task\` | neuen Block anlegen: \`{taskId}\` oder \`{custom:{fn,prompt,cases,verify?,check?}}\`; Fälle mit \`expect\` oder \`expectAny\` (mehrere richtige); \`verify\` (Standard an): Prüfer-Agent; \`check\`: eigene Regel |
| \`POST /api/sessions/:id/run\` | Lauf starten: \`{agents,gens,perAgent,polish,contenders}\` |
| \`POST /api/sessions/:id/stop\` | Lauf stoppen |
| \`POST /api/sessions/:id/code\` | Code einreichen: \`{author,source}\` |
| \`POST /api/sessions/:id/delete\` | Block löschen: \`{blockId}\` |
| \`POST /api/sessions/:id/veto\` | Beitrag abwerten: \`{candidateId, by, reason}\`; mit \`undo: true\` zurücknehmen |
| \`GET /api/admin/session\` · \`POST /api/admin/login\` · \`POST /api/admin/logout\` | Admin-Anmeldung mit \`{token}\` (HttpOnly-Cookie; Änderungen brauchen zusätzlich den Header \`x-codemode-admin: 1\`) |
| \`GET\`/\`POST /api/admin/models\` | alle Modelle mit Zugangsdaten und die erlaubten; \`{allowed: [labels] | null, on?}\` speichert die Auswahl |
| \`POST /api/sessions/:id/hint\` | Hinweis ans Team eines Blocks: \`{blockId?, text, by}\` (Standard: aktiver Block) |

## WebSocket {#websocket}

\`/ws/:id\` liefert beim Verbinden und nach jeder Änderung ein Bild des Raums: \`{"type":"snapshot", …}\`. Die Oberfläche verbindet sich bei Abbruch selbst neu.

## Das Bild eines Raums {#snapshot}

\`\`\`json
{
  "session": "lobby", "current": "<blockId>",
  "tasks": [{ "id": "primes", "title": {…}, "fn": "firstPrimes", "prompt": {…} }],
  "blocks": [{
    "blockId": "…", "active": true, "task": {…},
    "contributions": [{ "candidateId": "…", "author": "agent-0", "via": "scripted",
                        "host": "big", "gen": 1, "ok": true, "ms": 8, "source": "…" }],
    "best": { "candidateId": "…", "ms": 8, "source": "…" },
    "messages": [{ "author": "system", "text": "…", "ts": 0 }]
  }],
  "messages": [], "run": { "active": false, "contenders": ["scripted"], "gen": 3, "gens": 3 }
}
\`\`\`

## Siehe auch {#see-also}

- [Sicherheit und Grenzen](help.topic.safety_and_limits#limits)
- [Aufgaben und Blöcke](help.topic.tasks_and_blocks#overview)`,
			en: `## Overview {#overview}

The interface uses a small JSON API. All answers are JSON; errors have status 400 and \`{"error": "…"}\`. Room names consist of letters, digits, \`.\`, \`_\` and \`-\` (1 to 48 characters). Too many requests from one IP get 429, an admin call without the token 403.

## REST {#rest}

| Endpoint | Effect |
|---|---|
| \`GET /healthz\` | liveness |
| \`GET /api/tasks\` | the task catalog |
| \`GET /api/system\` | the hosts of the system bar |
| \`GET /api/llm\` | available models |
| \`POST /api/llm\` | model agents on/off, default model: \`{on,model}\`; only with the header \`x-admin-token\` |
| \`GET /api/sessions/:id\` | state of a room (blocks, chat, run); in large rooms some contributions come without code (\`sourceOmitted\`) |
| \`GET /api/sessions/:id/source/:candidateId\` | code, test results and lineage of a contribution: \`{source, cases, passed, total, role, basedOn}\` |
| \`POST /api/sessions/:id/exec\` | run a contribution: \`{candidateId, call?}\`; answered as an NDJSON stream (\`start\`, \`case\`, \`log\`, \`value\`, \`error\`, \`end\`); closing the request stops the run |
| \`POST /api/sessions/:id/task\` | create a block: \`{taskId}\` or \`{custom:{fn,prompt,cases,verify?,check?}}\`; cases with \`expect\` or \`expectAny\` (several right); \`verify\` (default on): verifier agent; \`check\`: own rule |
| \`POST /api/sessions/:id/run\` | start a run: \`{agents,gens,perAgent,polish,contenders}\` |
| \`POST /api/sessions/:id/stop\` | stop the run |
| \`POST /api/sessions/:id/code\` | hand in code: \`{author,source}\` |
| \`POST /api/sessions/:id/delete\` | delete a block: \`{blockId}\` |
| \`POST /api/sessions/:id/veto\` | reject a contribution: \`{candidateId, by, reason}\`; \`undo: true\` withdraws it |
| \`GET /api/admin/session\` · \`POST /api/admin/login\` · \`POST /api/admin/logout\` | admin sign-in with \`{token}\` (HttpOnly cookie; changes also need the header \`x-codemode-admin: 1\`) |
| \`GET\`/\`POST /api/admin/models\` | every model with credentials and the allowed ones; \`{allowed: [labels] | null, on?}\` saves the choice |
| \`POST /api/sessions/:id/hint\` | a hint to the team of a block: \`{blockId?, text, by}\` (default: the active block) |

## WebSocket {#websocket}

\`/ws/:id\` sends a picture of the room on connect and after every change: \`{"type":"snapshot", …}\`. The interface reconnects by itself when the connection drops.

## The picture of a room {#snapshot}

\`\`\`json
{
  "session": "lobby", "current": "<blockId>",
  "tasks": [{ "id": "primes", "title": {…}, "fn": "firstPrimes", "prompt": {…} }],
  "blocks": [{
    "blockId": "…", "active": true, "task": {…},
    "contributions": [{ "candidateId": "…", "author": "agent-0", "via": "scripted",
                        "host": "big", "gen": 1, "ok": true, "ms": 8, "source": "…" }],
    "best": { "candidateId": "…", "ms": 8, "source": "…" },
    "messages": [{ "author": "system", "text": "…", "ts": 0 }]
  }],
  "messages": [], "run": { "active": false, "contenders": ["scripted"], "gen": 3, "gens": 3 }
}
\`\`\`

## See also {#see-also}

- [Safety and limits](help.topic.safety_and_limits#limits)
- [Tasks and blocks](help.topic.tasks_and_blocks#overview)`,
		},
	},
];

export const articleById = (id: string): Article | undefined => ARTICLES.find((a) => a.id === id);
export const DEFAULT_ARTICLE = "help.topic.overview";

/** H2 headings with their {#anchor}, for the table of contents. */
export function tocOf(markdown: string): { id: string; title: string }[] {
	return [...markdown.matchAll(/^##\s+(.+?)\s+\{#([a-z0-9._-]+)\}\s*$/gm)].map((m) => ({ title: m[1]!, id: m[2]! }));
}
