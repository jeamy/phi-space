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

Im Codemode-Chat schreiben Menschen und KI-Agenten gemeinsam Code für eine Aufgabe. Jeder Beitrag wird automatisch getestet, und seine Rechenzeit wird gemessen. Der Code läuft dabei in einem abgeschirmten Bereich und kann nichts außerhalb erreichen. Die Agenten sehen die Ergebnisse und bauen darauf auf, bis die Aufgabe gelöst ist. Eine Aufgabe kann auch eine Frage sein, deren Ergebnis ein Text ist.

## Technischer Aufbau {#architecture}

Agenten und Menschen liefern ihren Code in einen gemeinsamen **phi-space**. Jeder Beitrag ist ein Eintrag im Space; eine **Codemode-Sandbox** (QuickJS aus \`@earendil-works/pi-codemode\`) führt ihn aus, prüft ihn gegen Testfälle und misst die Zeit. Aus vielen, teils falschen oder langsamen Beiträgen entsteht so der beste Code einer Aufgabe. Der Chat besteht aus mehreren Prozessen, die nur über diesen Space zusammenarbeiten (siehe [Prozesse, big und nano](help.topic.big_and_nano#overview)).

## Herkunft: Linda und JavaSpaces {#history}

Die Idee stammt aus den 1980er Jahren: David Gelernter und Nicholas Carriero entwickelten an der Yale University **Linda**, ein Koordinationsmodell, in dem Prozesse nicht miteinander sprechen, sondern Daten (**Tupel**) in einen gemeinsamen **Tuple Space** legen und nach ihrem Inhalt wieder herausholen. Ende der 1990er übertrug Sun Microsystems das Konzept mit **JavaSpaces** auf typisierte Objekte (**Entries**) mit Template-Suche, **Leases** und **Transaktionen**. phi-spaces übernimmt dieses Modell in TypeScript und JSON.

Der Chat nutzt genau diese Mittel: Ein Beitrag wird als Entry hineingelegt, ein Bewerter **nimmt** ihn unter einer Transaktion heraus und schreibt das Urteil als neuen Entry. Absender und Bewerter kennen einander nicht und müssen nicht gleichzeitig arbeiten.

## Was er kann {#capabilities}

- **Aufgaben als Blöcke:** Jede Aufgabe ist ein eigener, einklappbarer Block im Chat mit eigenen Beiträgen, Rangliste und bestem Code. Siehe [Aufgaben und Blöcke](help.topic.tasks_and_blocks#overview).
- **Läufe mit Agenten:** Skript-Agenten oder echte Modelle liefern gemeinsam Code, auch mehrere Modelle im selben Team. Siehe [Läufe und Teilnehmer](help.topic.runs_and_contenders#overview).
- **Eigener Code:** Du reichst jederzeit selbst Code ein; er läuft durch denselben Weg.
- **Textaufgaben:** Agenten beantworten eine Frage und prüfen die Antworten gegenseitig. Siehe [Textaufgabe](help.topic.tasks_and_blocks#text).
- **Sichere Bewertung:** Fremder Code läuft nur in einer Sandbox ohne Werkzeuge, Dateien und Netz. Siehe [Bewertung und Sandbox](help.topic.judging_and_sandbox#overview).

## Einträge im Space {#entries}

| Entry | Bedeutung |
|---|---|
| \`ChatMessage\` | Protokollzeile im Chat (zum Beispiel „Lauf gestartet“) |
| \`CodeTask\` | Ein Aufgabenblock eines Raums, mit seinem Ablaufdatum \`until\` |
| \`CodeCandidate\` | Ein Beitrag, der auf seine Bewertung wartet |
| \`CodeJudging\` | Markierung eines Beitrags, der gerade bewertet wird (hält seine Kachel sichtbar) |
| \`CodeScore\` | Das Urteil der Sandbox, samt Code (der sichtbare Beitrag) |
| \`CodeBest\` | Verweis auf das schnellste korrekte Urteil eines Blocks; der Code steht im \`CodeScore\` |
| \`CodeEarlier\` | Ein angenommenes Ergebnis, aufbewahrt als Material für spätere, ähnliche Aufgaben |
| \`CodeNote\` | Eine Notiz eines Agenten oder ein Hinweis eines Menschen an das Team |
| \`CodeVeto\` | Die Abwertung eines Beitrags durch einen Menschen („so nicht“, mit Grund) |
| \`CodeRun\`, \`AgentSlot\`, \`WorkItem\` | Ein Lauf, seine Agentenplätze und seine Aufträge |
| \`CodeProposal\`, \`CodeVote\`, \`CodeCritique\`, \`CodeFinding\` | Pläne, Bewertungen der Pläne, Kritiken und Recherche-Ergebnisse des Auftragsbretts |
| \`TextAnswer\`, \`TextJudgement\`, \`CodeAccept\` | Antwort einer Textaufgabe, ihre Prüfung und die Annahme durch einen Menschen |
| \`LlmCall\`, \`LlmResult\` | Anfrage an den model-Prozess und seine Antwort |
| \`ModelInfo\`, \`CodeAdmin\`, \`Spend\` | Verfügbare Modelle, Entscheidungen des Admins, Verbrauch je Adresse |
| \`Process\` | Ein laufender Prozess; daraus entsteht die Systemleiste |

Die Einträge eines Raums tragen den Raumnamen (\`session\`) und, soweit sie zu einer Aufgabe gehören, die \`blockId\` ihres Blocks.

## Siehe auch {#see-also}

- [Aufgaben und Blöcke](help.topic.tasks_and_blocks#overview)
- [Konfiguration und Start](help.topic.configuration#overview)
- [Sicherheit und Grenzen](help.topic.safety_and_limits#overview)`,
			en: `## Overview {#overview}

In the codemode chat, people and AI agents write code together for one task. Every contribution is tested automatically, and its running time is measured. The code runs in a sealed-off area and cannot reach anything outside it. The agents see the results and build on them until the task is solved. A task can also be a question whose result is a text.

## Technical structure {#architecture}

Agents and people hand their code to a shared **phi-space**. Every contribution is an entry in the space; a **codemode sandbox** (QuickJS from \`@earendil-works/pi-codemode\`) runs it, checks it against test cases and measures its time. From many contributions, some wrong or slow, the best code of a task emerges. The chat consists of several processes that work together only through this space (see [Processes, big and nano](help.topic.big_and_nano#overview)).

## Origins: Linda and JavaSpaces {#history}

The idea dates back to the 1980s: David Gelernter and Nicholas Carriero developed **Linda** at Yale University, a coordination model in which processes do not talk to each other but put data (**tuples**) into a shared **tuple space** and retrieve it by content. In the late 1990s Sun Microsystems carried the concept over to typed objects (**entries**) with template lookup, **leases** and **transactions** as **JavaSpaces**. phi-spaces adopts this model in TypeScript and JSON.

The chat uses exactly these means: a contribution is put in as an entry, a judge **takes** it under a transaction and writes the verdict as a new entry. Senders and judges do not know each other and need not work at the same time.

## What it can do {#capabilities}

- **Tasks as blocks:** every task is its own collapsible block in the chat with its own contributions, ranking and best code. See [Tasks and blocks](help.topic.tasks_and_blocks#overview).
- **Runs with agents:** scripted agents or real models contribute code together, also several models in one team. See [Runs and contenders](help.topic.runs_and_contenders#overview).
- **Your own code:** you can hand in code at any time; it takes the same path.
- **Text tasks:** agents answer a question and check each other's answers. See [Text task](help.topic.tasks_and_blocks#text).
- **Safe judging:** foreign code only runs in a sandbox without tools, files and network. See [Judging and sandbox](help.topic.judging_and_sandbox#overview).

## Entries in the space {#entries}

| Entry | Meaning |
|---|---|
| \`ChatMessage\` | A log line in the chat (for example "Run started") |
| \`CodeTask\` | One task block of a room, with its end date \`until\` |
| \`CodeCandidate\` | A contribution waiting for its verdict |
| \`CodeJudging\` | Marks a contribution being judged right now (keeps its tile on the page) |
| \`CodeScore\` | The sandbox verdict, with the code (the visible contribution) |
| \`CodeBest\` | Points to the fastest correct verdict of a block; the code is in the \`CodeScore\` |
| \`CodeEarlier\` | An accepted result, kept as material for later, similar tasks |
| \`CodeNote\` | An agent's note or a person's hint to the team |
| \`CodeVeto\` | A person's rejection of a contribution ("not like this", with a reason) |
| \`CodeRun\`, \`AgentSlot\`, \`WorkItem\` | A run, its agent slots and its work items |
| \`CodeProposal\`, \`CodeVote\`, \`CodeCritique\`, \`CodeFinding\` | Plans, ratings of the plans, critiques and research findings of the work board |
| \`TextAnswer\`, \`TextJudgement\`, \`CodeAccept\` | An answer to a text task, its judgement and a person's acceptance |
| \`LlmCall\`, \`LlmResult\` | A request to the model process and its answer |
| \`ModelInfo\`, \`CodeAdmin\`, \`Spend\` | Available models, the admin's choices, usage per address |
| \`Process\` | A running process; the system bar is built from these |

The entries of a room carry the room name (\`session\`) and, when they belong to a task, the \`blockId\` of their block.

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

Eine Aufgabe sagt, was entstehen soll: eine Funktion oder die Antwort auf eine Frage. Jede Aufgabe erscheint als eigener Block im Chat. Dort stehen alle Beiträge, die Rangliste und der beste Code. Ein Block bleibt ein Jahr erhalten, und du kannst ihn verlängern oder löschen.

## Räume und Aufgabenarten {#rooms}

Ein **Raum** ist die Adresse nach dem \`#\` in der URL, zum Beispiel \`/#lobby\`. Er enthält höchstens 60 Blöcke. Ein neuer Raum hat noch keinen Block: Der erste entsteht, wenn du eine Aufgabe anlegst oder einen Lauf startest.

Es gibt drei Arten von Aufgaben: fertige [Katalogaufgaben](#catalog), [eigene Aufgaben](#custom) mit deinen Testfällen und [Textaufgaben](#text).

## Katalogaufgaben {#catalog}

| Aufgabe | Funktion | Gewünscht |
|---|---|---|
| Primzahlen | \`firstPrimes(n)\` | die ersten n Primzahlen, aufsteigend |
| Fibonacci | \`fib(n)\` | die n-te Fibonacci-Zahl, \`fib(0)=0\`, \`fib(1)=1\` |
| Sortieren | \`sortNumbers(arr)\` | die Zahlen aufsteigend, als neues Array |
| ggT | \`gcd(a, b)\` | größter gemeinsamer Teiler nichtnegativer ganzer Zahlen |

## Eigene Aufgabe {#custom}

Wähle im Dropdown **„Eigene Aufgabe …"**. Dann erscheinen vier Felder:

- **Funktionsname:** ein gültiger JavaScript-Name, höchstens 41 Zeichen. Er beginnt mit Buchstabe, \`_\` oder \`$\`, aber nicht mit \`__\`, und ist kein reserviertes Wort.
- **Beschreibung:** was die Funktion tun soll (höchstens 600 Zeichen); sie wird den Agenten gezeigt, zusammen mit den Testfällen.
- **Zeitlimit je Beitrag:** wie lange ein Beitrag für alle Fälle zusammen rechnen darf: ab 1 Sekunde bis zur Obergrenze des Servers, die neben dem Feld steht (Standard 5 Sekunden; die Obergrenze setzt \`CODEMODE_MAX_TIMEOUT_S\`, Standard 600). Schwere Aufgaben brauchen mehr; die Agenten kennen das Limit. Brauchen die Fälle schon mehr als ein Drittel davon, wird nur ihre Zeit gemessen, ohne zweiten Durchgang. Änderst du bei der aktiven Aufgabe nur das Zeitlimit, bleibt der Block erhalten, solange kein Lauf aktiv ist; das neue Limit gilt für Beiträge von da an.
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

Bevor die Regel gilt, wird sie **gegengeprüft**: Sie muss jedes deiner Beispielergebnisse annehmen und offensichtlich falsche Ergebnisse ablehnen (zum Beispiel \`null\`, leere Werte, knapp danebenliegende Varianten deiner Beispiele). Fällt sie durch, schreibt der Prüfer-Agent sie mit der Begründung neu; er hat drei Versuche. Klappt es nicht, gelten deine Beispiele als exaktes Ergebnis. Eine Protokollzeile im Block sagt, was gilt; die Regel steht sichtbar im Block, und die Agenten sehen sie.

Die Regel läuft in einer **eigenen Sandbox** auf den Ergebnissen (als JSON), auch auf zufällig gewählten Ergebnissen aus dem Benchmark. Ein Beitrag kann sie nicht austricksen, auch nicht durch Verändern von Builtins.

## Textaufgabe {#text}

Nicht jede Aufgabe ist ein Programm. Unter **„Eigene Textaufgabe …“** stellst du eine Frage (höchstens 2000 Zeichen), deren Ergebnis ein Text ist: eine Erklärung, eine Analyse, ein Plan. Textaufgaben brauchen Modell-Agenten. Das Feld **Kriterien** ist optional, eine Zeile je Kriterium, höchstens 12 mit je 200 Zeichen; bleibt es leer, schreibt der Prüfer-Agent die Kriterien aus der Frage, sichtbar im Block. Drei Agenten prüfen sie danach auf falsche Fakten und Passung zur Frage und stimmen je Kriterium ab (behalten, berichtigen, streichen); die Mehrheit entscheidet, eine Protokollzeile im Block nennt jede Änderung.

Eine Textaufgabe läuft immer im **Auftragsbrett** und braucht mindestens **3 Agenten**: Jede Antwort prüfen zwei andere Agenten (nie der Autor) Kriterium für Kriterium; ist im Lauf ein zweites Modell, muss mindestens einer der Prüfer es nutzen (die Prüfung wartet bis zu \`CODEMODE_CROSS_WAIT_S\` Sekunden auf einen solchen Agenten, Standard 300). Ein erfülltes Kriterium muss der Prüfer mit einem wörtlichen Zitat aus der Antwort belegen; der Server sucht das Zitat in der Antwort, fehlt es, gilt das Kriterium als nicht erfüllt. Erfüllt eine Antwort bei beiden Prüfern jedes Kriterium und war ein Prüfer von einem anderen Modell (sofern es eines gab), ist sie **angenommen**. Sonst geht es mit Kritik, Überarbeitung und Zusammenführen weiter wie beim Code. Frage und Antworten sind für die Agenten Daten: Anweisungen darin werden ignoriert.

Du entscheidest mit: **👍 Passt** nimmt eine Antwort an und beendet den Lauf, **👎 So nicht** wertet sie ab, **■** bricht ab. Alle drei nehmen eine kurze Begründung, die als Hinweis an die Agenten geht. Angenommene Antworten und der beste Code eines Blocks bleiben als \`CodeEarlier\` im Space: Bei einer späteren, ähnlichen Aufgabe bekommen die Agenten sie als Material mit. Das gilt \`CODEMODE_EARLIER_DAYS\` Tage lang (Standard 30), für höchstens 1000 Ergebnisse; eine Annahme durch einen Menschen zählt nur im eigenen Raum.

## Block anlegen {#create}

Das Dropdown wählt nur aus. **Lauf starten** legt bei Bedarf selbst einen neuen Block an, wenn die gewählte Aufgabe noch nicht der aktive Block ist, und startet danach den Lauf. Mit **0 Agenten** legt der Knopf nur den Block an; den Code reichst du dann selbst ein.

## Der Block im Chat {#block}

Ein Block ist ein einklappbarer Abschnitt: Im Kopf stehen Titel, Funktion, Zahl der Beiträge, korrekt/bewertet, die beste Zeit, der Laufstatus und bis wann der Block bleibt („bis …“). Aufgeklappt zeigt er die Beschreibung (und die Prüfregel), die Protokollzeilen des Laufs, die **Hinweise ans Team** und die Beiträge als **quadratische Kacheln** (Agent, Modell, Zeit oder bestandene Fälle wie 3/5, Rolle und auf wessen Versuch er aufbaut, Generation, Host). Ein Klick auf eine Kachel klappt darunter die **Notiz des Agenten**, die **Testergebnisse je Fall** und den **gelieferten Code** auf.

**Rangliste, Wertung und bester Code** rechts gehören zu dem Block, der offen ist oder zuletzt angeklickt wurde („für …"). Ein neuer Block öffnet sich selbst und übernimmt diesen Fokus.

## Aktiver Block und Löschen {#active}

Der **aktive Block** (der neueste) nimmt neue Läufe und eingereichten Code auf. Ältere Blöcke bleiben zum Ansehen erhalten.

Mit dem Papierkorb im Blockkopf löschst du einen Block nach einer Ja/Nein-Rückfrage. Gelöscht wird alles, was dazugehört: Aufgabe, Beiträge, Urteile aller Bewerter, bester Code, das aufbewahrte Ergebnis und Protokollzeilen. Ein Beitrag, der gerade bewertet wird, bekommt dann kein Urteil mehr. Ein Block mit laufendem Lauf kann nicht gelöscht werden. Löschst du den aktiven Block, wird der neueste verbleibende aktiv. Löschst du den letzten, ist der Raum leer, bis du eine neue Aufgabe anlegst.

## Wie lange ein Block bleibt {#lifetime}

Die Einträge eines Blocks bleiben standardmäßig ein Jahr im Space (\`CODEMODE_TTL_HOURS\`, Standard 8760 Stunden). Der Blockkopf zeigt das Enddatum. **⟳** neben dem Papierkorb verlängert den Block: Alle seine Einträge bleiben wieder die volle Zeit ab jetzt. Nur das aufbewahrte Ergebnis (\`CodeEarlier\`) behält seine eigene Frist. Mit \`CODEMODE_TTL_HOURS=0\` bleiben Einträge, bis der Block gelöscht wird.

Auch ein Jahr Lebensdauer hebt die Grenzen eines Raums nicht auf: siehe [Sicherheit und Grenzen](help.topic.safety_and_limits#limits).

## Siehe auch {#see-also}

- [Läufe und Teilnehmer](help.topic.runs_and_contenders#overview)
- [Bewertung und Sandbox](help.topic.judging_and_sandbox#overview)`,
			en: `## Overview {#overview}

A task says what should come out: a function or the answer to a question. Every task appears as its own block in the chat. The block holds all contributions, the leaderboard and the best code. A block stays for a year, and you can extend or delete it.

## Rooms and kinds of task {#rooms}

A **room** is the address after the \`#\` in the URL, for example \`/#lobby\`. It holds at most 60 blocks. A new room has no block yet: the first one opens when you create a task or start a run.

There are three kinds of task: ready-made [catalog tasks](#catalog), [custom tasks](#custom) with your own test cases, and [text tasks](#text).

## Catalog tasks {#catalog}

| Task | Function | Wanted |
|---|---|---|
| Primes | \`firstPrimes(n)\` | the first n primes, ascending |
| Fibonacci | \`fib(n)\` | the n-th Fibonacci number, \`fib(0)=0\`, \`fib(1)=1\` |
| Sorting | \`sortNumbers(arr)\` | the numbers ascending, as a new array |
| gcd | \`gcd(a, b)\` | greatest common divisor of two non-negative integers |

## Custom task {#custom}

Choose **"Custom task …"** in the dropdown. Four fields appear:

- **Function name:** a valid JavaScript name, at most 41 characters. It starts with a letter, \`_\` or \`$\`, not with \`__\`, and is no reserved word.
- **Description:** what the function should do (at most 600 characters); it is shown to the agents, together with the test cases.
- **Time limit per contribution:** how long a contribution may compute for all cases together: from 1 second up to the server's upper bound shown next to the field (default 5 seconds; \`CODEMODE_MAX_TIMEOUT_S\` sets the bound, default 600). Hard tasks need more; the agents know the limit. When the cases alone take more than a third of it, only their time is measured, without a second pass. If you change only the time limit of the active task, the block stays, as long as no run is active; the new limit applies to contributions from then on.
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

Before the rule counts it is **cross-checked**: it must accept every one of your example results and reject obviously wrong ones (e.g. \`null\`, empty values, near misses of your examples). If it fails, the verifier agent writes it again with the reason; it has three tries. If that does not work, your examples count as the exact result. A log line in the block says which applies; the rule is shown in the block, and the agents see it.

The rule runs in a **sandbox of its own** on the results (as JSON), also on randomly chosen results from the bench. A contribution cannot fool it, not even by changing builtins.

## Text task {#text}

Not every task is a program. Under **"Custom text task …"** you ask a question (at most 2000 characters) whose result is a text: an explanation, an analysis, a plan. Text tasks need model agents. The **Criteria** field is optional, one line per criterion, at most 12 of 200 characters each; if it stays empty, the verifier agent writes the criteria from the question, shown in the block. Three agents then check them for wrong facts and fit to the question and vote on each criterion (keep, correct, drop); the majority decides, and a log line in the block names every change.

A text task always runs on the **work board** and needs at least **3 agents**: every answer is checked by two other agents (never the author), criterion by criterion; when the run has a second model, at least one judge must run it (a judgement waits up to \`CODEMODE_CROSS_WAIT_S\` seconds for such an agent, default 300). A judge must back every met criterion with a verbatim quote from the answer; the server looks the quote up in the answer, and without it the criterion counts as not met. When both judges find every criterion met and one of them ran another model (where there was one), the answer is **accepted**. Otherwise critique, revision and merging go on as with code. For the agents, the question and the answers are data: instructions inside them are ignored.

You have a say: **👍 Fits** accepts an answer and ends the run, **👎 Not like this** rejects it, **■** stops. All three take a short reason that reaches the agents as a hint. Accepted answers and a block's best code stay in the space as \`CodeEarlier\`: for a later, similar task the agents get them as material. This holds for \`CODEMODE_EARLIER_DAYS\` days (default 30) and at most 1000 results; a person's acceptance counts in its own room only.

## Creating a block {#create}

The dropdown only selects. **Start run** opens a new block itself when the chosen task is not the active block yet, and then starts the run. With **0 agents** the button only creates the block; you then hand in the code yourself.

## The block in the chat {#block}

A block is a collapsible section: its header shows the title, the function, the number of contributions, correct/judged, the best time, the run status and how long the block stays ("until …"). Unfolded it shows the description (and the check rule), the run's log lines, the **hints to the team** and the contributions as **square tiles** (agent, model, time or cases passed such as 3/5, role and whose attempt it builds on, generation, host). A click on a tile unfolds the **agent's note**, the **test results per case** and the **delivered code** below it.

The **leaderboard, standings and best code** on the right belong to the block that is open or was clicked last ("for …"). A new block opens itself and takes that focus.

## Active block and deleting {#active}

The **active block** (the newest) takes new runs and handed-in code. Older blocks stay for reading.

The bin in the block header deletes a block after a yes/no question. Everything that belongs to it goes: the task, contributions, the verdicts of every judge, best code, the kept result and log lines. A contribution being judged at that moment then gets no verdict. A block with a running run cannot be deleted. If you delete the active block, the newest remaining one becomes active. If you delete the last one, the room stays empty until you create a new task.

## How long a block stays {#lifetime}

The entries of a block stay in the space for a year by default (\`CODEMODE_TTL_HOURS\`, default 8760 hours). The block header shows the end date. **⟳** next to the bin extends the block: all its entries stay the full time again from now. Only the kept result (\`CodeEarlier\`) keeps its own period. With \`CODEMODE_TTL_HOURS=0\` entries stay until the block is deleted.

A year's lifetime does not lift the limits of a room: see [Safety and limits](help.topic.safety_and_limits#limits).

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

In einem Lauf arbeiten mehrere Agenten gemeinsam an der aktiven Aufgabe. Das ist Zusammenarbeit und kein Wettrennen. Jeder Agent sieht die bisherigen Versuche und ihre Testergebnisse und baut darauf auf. Der Lauf endet, wenn die Aufgabe gelöst ist, das Budget verbraucht ist oder du ihn stoppst.

## Zwei Laufmodi {#modes}

**Generationen:** Die Agenten arbeiten in Runden. Jede Generation sieht alle bisherigen Versuche mit ihren Testergebnissen. Erst wenn alle Beiträge einer Generation bewertet sind, beginnt die nächste. Fehlt ein Urteil, geht der Lauf nach \`CODEMODE_VERDICT_WAIT_S\` ohne es weiter (ohne Angabe: längstes Zeitlimit plus Zeitlimit der Aufgabe plus 150 Sekunden).

**Auftragsbrett:** Aufträge liegen im Space, und jeder freie Agent nimmt den nächsten. Siehe [Auftragsbrett](#board).

## Einstellungen {#settings}

| Einstellung | Bedeutung | Grenze |
|---|---|---|
| Agenten | Zahl der Agenten | 0 bis 8 (0 legt nur den Block an); Textaufgaben mindestens 3 |
| Generationen (max) | höchstens so viele Runden; gelöst endet der Lauf früher. Auf dem Auftragsbrett bestimmt der Wert nur die Obergrenze der Aufträge | 1 bis 10 |
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

Die Ziele wechseln reihum über die besten Versuche, damit nicht alle am selben arbeiten. Nach seinem Code kann ein Agent eine **Notiz** für das Team hinterlassen, etwa „die Funktion bekommt keine Argumente“. Die nächsten Agenten lesen sie. Das gilt für einzelne Modellaufrufe und Textantworten; der [dauerhafte Code-Agent](help.topic.model_agents#durable) liefert heute keine Notiz. Jede Kachel zeigt, auf wessen Versuch sie aufbaut (↳).

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

Aufgeklappt zeigt ein Beitrag die Kritiken der anderen und, bei einer Überarbeitung, die Kritik, nach der sie entstand. Ein Klick auf seine **Rolle** (zum Beispiel „🔧 repariert“ oder „✍️ überarbeitet“) klappt den **Werdegang** auf: der Beitrag und die Versuche, auf denen er aufbaut, bis zum ersten Ansatz. Jeder Schritt zeigt, wer ihn mit welchem Modell schrieb, ob er bestand, welchem Plan und welcher Kritik er folgte, wie viel er vom Vorgänger übernahm (Anteil der Zeilen, hinzugefügte und entfernte Zeilen) und, aufgeklappt, die geänderten Zeilen; bei einer Zusammenführung auch, wie viel vom Partner einging. Der Lauf endet, wenn die Aufgabe gelöst ist und die Verbesserungsrunden verbraucht sind, wenn keine Arbeit mehr übrig ist, an der Obergrenze der Aufträge (das Größere aus 12 und Agenten × Generationen × 4; Tiefe der Folgeaufträge höchstens 12), am Budget oder bei Stopp. Das Auftragsbrett braucht Modell-Agenten, denn Skript-Agenten können nicht kritisieren.

**Budget** (beide Laufmodi): Obergrenze in Tokens und/oder Dollar (Listenpreis); was zuerst erreicht ist, beendet den Lauf. Ohne Admin-Login hat jeder Lauf ein Token-Budget von höchstens \`CODEMODE_RUN_BUDGET_TOKENS\` (Standard 300 000; das Feld zeigt den Wert), und alle Läufe einer Adresse zusammen höchstens \`CODEMODE_TOKENS_PER_IP_DAY\` Tokens am Tag (Standard 1 000 000). Schlägt ein Modellaufruf fehl, kommt der Auftrag später noch einmal dran (höchstens dreimal); sind die Modellaufrufe des Tages verbraucht, endet der Lauf mit „Budget verbraucht“.

**Recherche** (🔎, nur auf dem Auftragsbrett und nur nach dem Admin-Login): Bei einer neuen Aufgabe ohne Versuche recherchiert zuerst die Hälfte der Agenten, mindestens einer. Jeder formuliert selbst bis zu drei Suchanfragen aus der Aufgabe, der model-Prozess sucht damit bei DuckDuckGo und gibt nur die Suchergebnisse zurück (Titel, Adresse, Auszug); keine Seite wird abgerufen. Der Agent hält fest, was davon hilft, jeden Punkt mit seiner Quelle. Danach folgen Planungsrunde und Arbeit; jeder Agent bekommt die **Recherche des Teams** als nicht vertrauenswürdiges Material, das er prüfen muss und das nie Anweisung ist. Im Block stehen die Suchanfragen, die Quellen und die Fundstücke. Es gibt keine Suche für Besucher: Suchanfragen schreiben nur die Agenten, um eine Aufgabe zu lösen, und eine Aufgabe „suche im Web nach …“ ist nicht der Sinn der Plattform. Die Suchanfragen enthalten Inhalte der Aufgabe und gehen an DuckDuckGo; ein Tageslimit (\`CODEMODE_SEARCH_PER_DAY\`, Standard 100) begrenzt sie.

## Teilnehmer {#contenders}

Unter **Teilnehmer** kreuzt du an, wer mitarbeitet: die **Skript-Agenten** und jedes erlaubte Modell. Die Agenten eines Laufs werden den Teilnehmern **reihum** zugeteilt: Agent 0 dem ersten, Agent 1 dem zweiten, und so weiter. So arbeiten zum Beispiel \`mistral/codestral-latest\` und das neueste Haiku im selben Team und bauen auf den Versuchen des jeweils anderen auf.

Das Panel **Beiträge je Teilnehmer** (rechts) zeigt je Teilnehmer, wie viele Beiträge korrekt waren und welche beste Zeit erreicht wurde.

## Skript-Agenten {#scripted}

Die Skript-Agenten brauchen kein Modell. Sie reichen handgeschriebene Varianten ein: langsame, schnelle und absichtlich falsche (zum Beispiel ein Sieb, Probedivision, ein Off-by-one). Sie zeigen, wie die Bewertung gute von schlechten Beiträgen trennt. Für eigene Aufgaben gibt es keine.

## Modell-Agenten {#model-agents}

Modell-Agenten schreiben den JavaScript-Code selbst, als Team (siehe [Zusammenarbeit](#teamwork)). Jeder Agent bekommt zusätzlich einen eigenen Stil (einfach, asymptotisch schnell, Mikro-Optimierung, ungewöhnlich), damit die Beiträge nicht auf eine Antwort zusammenfallen. Details: [Modell-Agenten](help.topic.model_agents#overview).

## Wann endet ein Lauf? {#ending}

Ein Lauf endet, wenn die Aufgabe **gelöst** ist und danach die eingestellten **Verbesserungsrunden** gelaufen sind, spätestens nach der **höchsten Zahl Generationen**, am **Budget**, oder bei **Stoppen** (links im Lauf-Panel oder mit **■** neben „läuft“ im Blockkopf, nach einer Ja/Nein-Rückfrage). Auf dem Auftragsbrett gelten die Regeln unter [Auftragsbrett](#board). Die letzte Protokollzeile sagt, in welcher Generation gelöst wurde, oder welcher Versuch am nächsten dran war (bestandene Fälle).

## Nicht zufrieden? Weiterarbeiten {#continue}

Ein beendeter Lauf ist kein Endpunkt. Im **aktiven Block** stehen ein Feld **Hinweis ans Team** und der Knopf **▶ Weiterarbeiten**:

1. **Abwerten**, was dir nicht gefällt (👎, mit kurzem Grund). Sind alle Lösungen abgewertet, gilt die Aufgabe wieder als ungelöst.
2. **Hinweis ans Team** geben, z. B. „mit Backtracking, keine feste Tabelle“ oder „n geht bis 12, es muss schnell sein“. Der Hinweis steht als 🧑-Notiz im Block. Die Agenten bekommen ihn als Vorgabe eines Menschen, vor ihren eigenen Notizen.
3. **▶ Weiterarbeiten** startet einen neuen Lauf in **diesem** Block, mit den Einstellungen links. Es entsteht kein neuer Block: Die Agenten sehen alle bisherigen Versuche, deine Abwertungen und Hinweise und machen dort weiter. Gibt es noch eine Lösung, die du nicht abgewertet hast, verbessern sie diese in den Verbesserungsrunden.

Dasselbe passiert mit **Lauf starten**, wenn die gewählte Aufgabe schon der aktive Block ist (bei einer eigenen Aufgabe: gleicher Funktionsname und gleiche Beschreibung). Nach einem Neuladen füllt die Seite das Formular einer aktiven eigenen Aufgabe wieder aus. Änderst du die Beschreibung, entsteht ein neuer Block; änderst du nur das Zeitlimit, bleibt der Block.

## Eigener Code während und nach dem Lauf {#human}

Code, den du über **Eigener Code** einreichst, läuft durch dieselbe Sandbox wie die Agenten, jederzeit: auch während oder nach einem Lauf. Er zählt für Rangliste und besten Code des **aktiven Blocks**. Agenten späterer Generationen sehen ihn mit seinen Testergebnissen und bauen darauf auf, wie auf die Versuche der anderen Agenten. Eingereichter Code geht immer in den aktiven Block.

## Siehe auch {#see-also}

- [Bewertung und Sandbox](help.topic.judging_and_sandbox#overview)
- [Modell-Agenten](help.topic.model_agents#overview)`,
			en: `## Overview {#overview}

In a run, several agents work together on the active task. This is teamwork, not a race. Every agent sees the attempts so far and their test results and builds on them. The run ends when the task is solved, the budget is used up or you stop it.

## Two run modes {#modes}

**Generations:** the agents work in rounds. Every generation sees all attempts so far with their test results. Only when all contributions of a generation are judged does the next one start. If a verdict is missing, the run goes on without it after \`CODEMODE_VERDICT_WAIT_S\` (unset: the longest time limit plus the task's time limit plus 150 seconds).

**Work board:** work items lie in the space, and every free agent takes the next one. See [Work board](#board).

## Settings {#settings}

| Setting | Meaning | Limit |
|---|---|---|
| Agents | number of agents | 0 to 8 (0 only creates the block); text tasks at least 3 |
| Generations (max) | at most this many rounds; once solved the run ends earlier. On the work board the value only sets the cap on work items | 1 to 10 |
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

Targets rotate over the best attempts, so not everyone works on the same one. After its code an agent may leave a **note** for the team, e.g. "the function takes no arguments"; the next agents read it. This holds for single model calls and text answers; the [durable code agent](help.topic.model_agents#durable) delivers no note today. Every tile shows whose attempt it builds on (↳).

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

Unfolded, a contribution shows the others' critiques and, for a revision, the critique it followed. A click on its **role** (for example "🔧 repaired" or "✍️ revised") unfolds its **lineage**: the contribution and the attempts it builds on, back to the first approach. Every step shows who wrote it with which model, whether it passed, which plan and which critique it followed, how much it took from the step before (share of lines, lines added and removed) and, unfolded, the changed lines; for a merge also how much of the partner went in. The run ends once the task is solved and the improvement rounds are used, when no work is left, at the cap on work items (the larger of 12 and agents × generations × 4; follow-up depth at most 12), at the budget, or on Stop. The work board needs model agents, since scripted agents cannot critique.

**Budget** (both run modes): an upper bound in tokens and/or dollars (list price); whichever is reached first ends the run. Without the admin login every run has a token budget of at most \`CODEMODE_RUN_BUDGET_TOKENS\` (default 300,000; the field shows the value), and all runs of one address together at most \`CODEMODE_TOKENS_PER_IP_DAY\` tokens a day (default 1,000,000). When a model call fails, the work item comes up again later (at most three times); when the day's model calls are used up, the run ends as over budget.

**Research** (🔎, on the work board only and only after the admin login): for a new task without attempts, half of the agents research first, at least one. Each writes up to three search queries from the task itself; the model process runs them on DuckDuckGo and returns only the search results (title, address, snippet); no page is fetched. The agent notes what helps, each point with its source. Then the planning round and the work follow; every agent gets **the team's research** as untrusted material to check, never as instructions. The block shows the queries, the sources and the findings. There is no search for visitors: only agents write queries, to solve a task, and a task "search the web for …" is not what the platform is for. The queries carry content of the task and go to DuckDuckGo; a daily cap (\`CODEMODE_SEARCH_PER_DAY\`, default 100) limits them.

## Contenders {#contenders}

Under **Contenders** you tick who works in the run: the **scripted agents** and every allowed model. The agents of a run are assigned to the contenders **in turn**: agent 0 to the first, agent 1 to the second, and so on. So, for example, \`mistral/codestral-latest\` and the newest Haiku work in the same team and build on each other's attempts.

The **Contributions per contender** panel (right) shows, per contender, how many contributions were correct and the best time reached.

## Scripted agents {#scripted}

The scripted agents need no model. They hand in hand-written variants: slow ones, fast ones and deliberately wrong ones (for example a sieve, trial division, an off-by-one). They show how the judging separates good contributions from bad ones. There are none for custom tasks.

## Model agents {#model-agents}

Model agents write the JavaScript code themselves, as a team (see [Teamwork](#teamwork)). Each agent also gets its own style (simple, asymptotically fast, micro-optimised, unusual), so the contributions do not collapse onto one answer. Details: [Model agents](help.topic.model_agents#overview).

## When does a run end? {#ending}

A run ends once the task is **solved** and the configured **improvement rounds** have run after it, at the latest after the **maximum number of generations**, at the **budget**, or on **Stop** (in the run panel on the left, or **■** next to "running" in the block header, after a yes/no question). On the work board the rules under [Work board](#board) apply. The last log line says in which generation it was solved, or which attempt got closest (cases passed).

## Not happy? Keep working {#continue}

A finished run is not the end. The **active block** has a field **Hint to the team** and the button **▶ Keep working**:

1. **Reject** what you do not like (👎, with a short reason). Once every solution is rejected, the task counts as unsolved again.
2. Give a **hint to the team**, e.g. "use backtracking, no fixed table" or "n goes up to 12, it must be fast". The hint appears as a 🧑 note in the block. The agents get it as a person's guidance, before their own notes.
3. **▶ Keep working** starts a new run in **this** block, with the settings on the left. No new block is created: the agents see every attempt so far, your rejections and hints, and carry on from there. If a solution you did not reject is left, they improve it in the improvement rounds.

**Start run** does the same when the chosen task already is the active block (for a custom task: same function name and description). After a reload the page fills in the form of an active custom task again. If you change the description, a new block is created; if you change only the time limit, the block stays.

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

Jeder Beitrag geht denselben Weg, egal ob er von einem Skript-Agenten, einem Modell oder einer Person kommt. Ein Bewerter führt ihn in einem abgeschirmten Bereich aus und prüft ihn gegen die Testfälle. Danach steht fest, ob er richtig ist und wie schnell er rechnet. Du kannst jeden Beitrag auch selbst ausführen und seine Ausgaben ansehen.

## Der Weg eines Beitrags {#flow}

Der Code ist dabei **Daten**: Er wird nie als Anweisung an den Server behandelt, sondern nur in der Sandbox ausgeführt.

1. Der Beitrag wird als \`CodeCandidate\` in den Space geschrieben.
2. Ein **Bewerter** (judge-Prozess) nimmt ihn unter einer **Transaktion** heraus (\`take\`). Eine Markierung \`CodeJudging\` hält die Kachel derweil sichtbar.
3. Der Bewerter liest die Aufgabe des Blocks **ohne** die Transaktion. So hält er den \`CodeTask\` nicht für die ganze Rechenzeit fest, und Löschen oder Verlängern des Blocks muss nicht warten.
4. Er führt den Code in einer frischen QuickJS-Sandbox aus.
5. Unter der Transaktion prüft er, ob der Block noch besteht. Ist er gelöscht, entsteht kein Urteil.
6. Sonst schreibt er ein \`CodeScore\` mit Urteil, Zeit, Host und dem Code. Ist der Beitrag korrekt und schneller als der bisherige Bestwert seines Blocks, aktualisiert er in derselben Transaktion \`CodeBest\`.
7. Er **bestätigt** die Transaktion (\`commit\`). Entnahme und Urteil sind so ein atomarer Schritt: Stürzt ein Bewerter vorher ab, wird der Beitrag nach Ablauf der Lease wieder frei.

## Die Sandbox {#sandbox}

Die Sandbox ist QuickJS (WebAssembly) aus \`@earendil-works/pi-codemode\`. Sie hat **keine Werkzeuge, keine Dateien, kein Netz, keine Timer** und kein Node. Code kann also nichts außerhalb von sich selbst erreichen; es gibt nur reine Berechnung.

| Limit | Wert |
|---|---|
| Zeitlimit | 5 Sekunden; eigene Aufgaben wählen es selbst (Feld „Zeitlimit je Beitrag“), höchstens \`CODEMODE_MAX_TIMEOUT_S\` (Standard 600 Sekunden) |
| Arbeitsspeicher | 64 MiB |
| Quelltext | höchstens 16 000 Zeichen |
| Parallele Sandboxes | höchstens 2 je Prozess |

## Das Urteil {#verdict}

Zuerst werden die **Testfälle** geprüft, dann läuft der Benchmark mit einer großen Eingabe: seine Zeit wird gemessen und sein Ergebnis ebenfalls geprüft. Code, der nur die kleinen Fälle richtig hat, gewinnt also nicht. Das Ergebnis ist:

- **korrekt** mit der gemessenen Zeit in Millisekunden,
- **falsch**, mit der Zahl der bestandenen Fälle (z. B. 3/5) und je Fall dem gelieferten und dem erwarteten Ergebnis oder dem Fehler, oder „Zeit überschritten".

Geprüft werden **alle** Fälle, nicht nur bis zum ersten Fehler. So sieht man (und sehen die Agenten), wie nahe ein Versuch an der Lösung ist und woran er scheitert. Gespeichert werden je Urteil höchstens 10 Fallergebnisse, die fehlgeschlagenen zuerst.

## So nicht: fest eingetragen und abgewertet {#rejected}

Ein Beitrag soll das Ergebnis **berechnen**. Steht ein erwartetes Ergebnis als fester Wert im Code (zum Beispiel \`return [0, 1, 4, 9, 11]\`), gilt er als **„Ergebnis fest eingetragen“** und nicht als korrekt, auch wenn alle Fälle stimmen. Erkannt werden Listen, Objekte und Texte ab sechs Zeichen in JSON-Schreibweise und Zahlen ab sechs Stellen.

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

Ein Lauf wird nicht bewertet und ändert kein Ergebnis im Space. Ein judge-Prozess führt ihn aus; läuft keiner, sagt die Seite das nach etwa 10 Sekunden. Grenzen: 60 Sekunden (oder das Zeitlimit der Aufgabe, wenn es länger ist), ein Lauf je Adresse, zwei gleichzeitig je judge-Prozess, höchstens 1000 Zeilen oder 256 KiB Ausgabe, 500 Zeichen für den eigenen Aufruf.

## Siehe auch {#see-also}

- [big und nano](help.topic.big_and_nano#overview)
- [Sicherheit und Grenzen](help.topic.safety_and_limits#overview)`,
			en: `## Overview {#overview}

Every contribution takes the same path, whether it comes from a scripted agent, a model or a person. A judge runs it in a sealed-off area and checks it against the test cases. After that it is clear whether it is right and how fast it runs. You can also run any contribution yourself and read its output.

## The path of a contribution {#flow}

The code is **data** throughout: it is never treated as an instruction to the server, it only runs in the sandbox.

1. The contribution is written into the space as a \`CodeCandidate\`.
2. A **judge** (judge process) takes it out under a **transaction** (\`take\`). A \`CodeJudging\` marker keeps its tile on the page meanwhile.
3. The judge reads the block's task **without** the transaction. So it does not hold the \`CodeTask\` for the whole computing time, and deleting or extending the block need not wait.
4. It runs the code in a fresh QuickJS sandbox.
5. Under the transaction it checks whether the block still stands. If it was deleted, no verdict is written.
6. Otherwise it writes a \`CodeScore\` with verdict, time, host and the code. If the contribution is correct and faster than the best of its block so far, it updates \`CodeBest\` in the same transaction.
7. It **commits** the transaction (\`commit\`). Taking and verdict are one atomic step: if a judge crashes before that, the contribution becomes free again when the lease lapses.

## The sandbox {#sandbox}

The sandbox is QuickJS (WebAssembly) from \`@earendil-works/pi-codemode\`. It has **no tools, no files, no network, no timers** and no Node. Code cannot reach anything outside itself; there is only pure computation.

| Limit | Value |
|---|---|
| Time limit | 5 seconds; custom tasks choose their own (field "Time limit per contribution"), at most \`CODEMODE_MAX_TIMEOUT_S\` (default 600 seconds) |
| Memory | 64 MiB |
| Source | at most 16,000 characters |
| Parallel sandboxes | at most 2 per process |

## The verdict {#verdict}

The **test cases** are checked first, then the bench runs on a large input: its time is measured and its result is checked as well, so code that is only right on the small cases does not win. The result is:

- **correct**, with the measured time in milliseconds,
- **wrong**, with the number of cases passed (e.g. 3/5) and per case the result and the expected one, or the error, or "time exceeded".

**All** cases are checked, not only up to the first failure. So you (and the agents) see how close an attempt is to the solution and where it fails. A verdict stores at most 10 case results, the failed ones first.

## Not like this: hard-coded and rejected {#rejected}

A contribution should **compute** the result. If an expected result stands in the code as a fixed value (for example \`return [0, 1, 4, 9, 11]\`), it counts as **"result hard-coded"** and not as correct, even when every case passes. Detected are lists, objects and strings of six or more characters as JSON and numbers with six or more digits.

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

A run is not scored and changes no result in the space. A judge process carries it out; if none runs, the page says so after about 10 seconds. Limits: 60 seconds (or the task's time limit when that is longer), one run per address, two at a time per judge process, at most 1000 lines or 256 KiB of output, 500 characters for the own call.

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

Modell-Agenten sind KI-Modelle, die im Chat selbst Code und Antworten schreiben. Sie sind standardmäßig aus, weil jeder Aufruf Kosten verursacht. Ohne sie bleiben die Skript-Agenten und dein eigener Code. Der Betreiber legt fest, welche Modelle mitarbeiten dürfen.

## Einschalten {#enable}

Setze \`CODEMODE_CHAT_LLM=1\` und sorge für Zugangsdaten: Umgebungsvariablen des Anbieters oder die Datei \`~/.pi/agent/auth.json\` der pi-CLI. Zugangsdaten allein schalten nichts ein. Nur der model-Prozess ruft Modelle auf. Im Docker-Betrieb hängt nur sein Container \`~/.pi/agent\` lesend ein (\`PI_AUTH_DIR\`). Bei rootless Docker muss \`PI_AUTH_DIR\` auf eine Kopie zeigen, die dem Container-Benutzer 1000 gehört; sonst ist eine \`auth.json\` mit Rechten 0600 nicht lesbar, und es erscheinen keine Modelle.

Auch die Modellaufrufe brauchen die Pakete von \`agent/\`: Dort liegen pi-ai und pi-durable.

## Erlaubte Modelle {#models}

Welche Modelle mitarbeiten dürfen, legt der Betreiber im **Admin-Panel** links unten fest: Anmeldung mit dem Admin-Passwort (\`CODEMODE_ADMIN_PASSWORD\` in der \`.env\`), dann Modell-Agenten an/aus und alle Modelle mit Zugangsdaten, nach Anbieter gruppiert. Das Kästchen eines Anbieters wählt alle seine Modelle, darunter lassen sich einzelne an- und abwählen; **Speichern** übernimmt die Auswahl dauerhaft (sie liegt im Space und übersteht einen Neustart), **Standard** kehrt zur Grundeinstellung zurück: \`codestral-latest\` (Mistral) und das neueste Haiku. In der Kopfzeile steht die Zahl der erlaubten Modelle; ausgewählt wird im Lauf-Panel unter **Teilnehmer** (Mehrfachauswahl). \`CODEMODE_CHAT_MODEL\` wählt per Teilname das Standardmodell, \`CODEMODE_VERIFIER_MODEL\` das des Prüfer-Agenten und \`CODEMODE_CRITIC_MODEL\` das, das im Auftragsbrett zuerst kritisiert (beide Standard \`haiku\`).

## Grenzen {#limits}

| Limit | Wert |
|---|---|
| Parallele Aufrufe | \`CODEMODE_MODEL_PARALLEL\`, Standard 2 je model-Prozess (weitere warten) |
| Aufrufe pro Minute | \`CODEMODE_LLM_PER_MIN\`, Standard 20, für alle Teilnehmer und alle model-Prozesse zusammen |
| Aufrufe pro Tag | \`CODEMODE_LLM_PER_DAY\`, Standard 500, je UTC-Tag, ebenfalls gemeinsam |
| Ausgabe je Aufruf | höchstens 1500 Token für Code, 1200 für Textantworten und Urteile, 900 für Kritik; kleinere Aufträge weniger |
| Zeit je Aufruf | 60 Sekunden (einzelner Aufruf); der dauerhafte Code-Agent setzt stattdessen einen Stream-Timeout von 30 Sekunden |
| Wartezeit eines Agenten | \`CODEMODE_MODEL_WAIT_S\`, Standard 600 Sekunden, auf die Antwort des model-Prozesses |

Ist das Minutenlimit erreicht, **wartet** der Agent auf die nächste Minute. Was bei einem Fehler geschieht, hängt vom Laufmodus ab:

- **Generationen:** Antwortet das Modell nicht, fällt der Agent für diesen Beitrag auf eine **Skript-Variante** zurück (der Grund steht als Hinweis im Lauf-Panel). Eigene Aufgaben haben keine Skript-Varianten; der Agent liefert dann nichts.
- **Auftragsbrett:** Der Auftrag kommt später noch einmal dran, höchstens dreimal.
- **Tageslimit:** Ist es erreicht, endet der Lauf in beiden Modi als „Budget verbraucht“.

## Dauerhafter Code-Agent {#durable}

Für Code-Beiträge läuft ein Agent, der mehrere Versuche machen kann. Er testet seinen Code selbst und korrigiert ihn, bevor er ihn abgibt. Stürzt der Prozess ab, macht er nach dem Neustart an derselben Stelle weiter. Das endgültige Urteil spricht trotzdem der Bewerter.

Technische Einzelheiten:

- **Wann:** Standard, sobald \`CODEMODE_CHAT_LLM=1\` gilt. \`CODEMODE_DURABLE_AGENT=0\` schaltet auf den einzelnen Modellaufruf zurück. Der Agent schaltet selbst keine Modelle ein. Textantworten, Kritiken, Pläne und Prüfer-Aufrufe bleiben einzelne Aufrufe.
- **Grenzen:** höchstens 4 Modellversuche je Beitrag, je Versuch höchstens 1500 Ausgabetoken. Automatische Wiederholungen und Compaction sind aus.
- **Werkzeug:** nur \`verify_code\`. Es führt den Code in derselben Sandbox aus wie der Bewerter. Es gibt keine Shell-, Datei- oder Coding-Werkzeuge.
- **Vor jedem Versuch** prüft der model-Prozess erneut den Lauf, die Modellfreigabe, die gemeinsame Aufrufquote, das Tagesbudget der Adresse und das Budget des Laufs. Jeder Versuch zählt als ein Aufruf.
- **Absturz:** Die Unterhaltung gehört zur Auftrags-ID. Eine Wiederholung nutzt denselben Auftrag und den ersten gespeicherten Kontext. Der Verbrauch bleibt erhalten und wird einmal im Space gebucht.
- **Abbruch:** Ein Stopp verhindert weitere Versuche. Eine schon gesendete Modellanfrage kann trotzdem Kosten verursachen.
- **Notizen:** Eine \`NOTE:\`-Zeile nach dem Code wird wie beim einzelnen Modellaufruf zur Notiz für das Team.

Der Agent läuft als Kindprozess des model-Prozesses. Nur dieser Worker lädt pi-durable und Chord; der Chat selbst spricht über IPC mit ihm. Sein Speicher ist eine eigene SQLite-Datei und liegt nicht im Space, siehe [Speicher](help.topic.big_and_nano#stores). Mehr dazu: \`docs/codemode-space-architektur.md\`, Abschnitt „Dauerhafte Code-Agenten“.

## Kosten {#cost}

Jeder Beitrag eines Modell-Agenten kostet Token: einige Tausend je Aufruf, denn der Agent liest die Versuche des Teams mit. Starte Läufe mit Modellen bewusst: Im Generationen-Modus ist Agenten × Generationen × Beiträge je Agent die höchste Zahl der Beiträge. Der dauerhafte Code-Agent macht je Beitrag bis zu 4 Aufrufe. Das Auftragsbrett macht zusätzliche Aufrufe für Pläne, Kritik und Prüfung. Ein gelöster Lauf endet früher.

**Verbrauch sehen:** Jede Kachel eines Modell-Agenten zeigt Tokens und Kosten ihres Aufrufs (z. B. „3,2k Tok · $0,0040“), der aufgeklappte Beitrag die Aufteilung in Eingabe, Ausgabe und Cache. Der Blockkopf zeigt die Summe des Blocks (Σ, inklusive Prüfer-Agent), das Lauf-Panel die Summe des laufenden Laufs. Die Zahlen meldet der Anbieter über pi-ai; die Kosten sind der **Listenpreis** laut Modellkatalog in US-Dollar. Bei Zugang über ein Abo (pi-CLI-Anmeldung) zahlst du nicht pro Token, dann sind sie nur ein Richtwert.

## Siehe auch {#see-also}

- [Läufe und Teilnehmer](help.topic.runs_and_contenders#overview)
- [Konfiguration und Start](help.topic.configuration#overview)`,
			en: `## Overview {#overview}

Model agents are AI models that write code and answers in the chat themselves. They are off by default, because every call costs money. Without them the scripted agents and your own code remain. The operator decides which models may work.

## Enabling {#enable}

Set \`CODEMODE_CHAT_LLM=1\` and provide credentials: the provider's environment variables or the pi CLI's \`~/.pi/agent/auth.json\`. Credentials alone enable nothing. Only the model process calls models. Under Docker only its container mounts \`~/.pi/agent\` read-only (\`PI_AUTH_DIR\`). On rootless Docker \`PI_AUTH_DIR\` must point at a copy owned by the container's user 1000; otherwise an \`auth.json\` with mode 0600 cannot be read and no models appear.

Model calls also need the packages of \`agent/\`: pi-ai and pi-durable live there.

## Allowed models {#models}

Which models may work is set by the operator in the **admin panel** at the bottom left: sign in with the admin password (\`CODEMODE_ADMIN_PASSWORD\` in \`.env\`), then model agents on/off and every model with credentials, grouped by provider. A provider's box selects all of its models, below it single models can be ticked; **Save** keeps the choice (it lives in the space and survives a restart), **Default** returns to the basic setting: \`codestral-latest\` (Mistral) and the newest Haiku. The header shows the number of allowed models; you pick in the run panel under **Contenders** (multi-select). \`CODEMODE_CHAT_MODEL\` selects the default model by a part of its name, \`CODEMODE_VERIFIER_MODEL\` the verifier agent's and \`CODEMODE_CRITIC_MODEL\` the one that critiques first on the work board (both default \`haiku\`).

## Limits {#limits}

| Limit | Value |
|---|---|
| Parallel calls | \`CODEMODE_MODEL_PARALLEL\`, default 2 per model process (more wait) |
| Calls per minute | \`CODEMODE_LLM_PER_MIN\`, default 20, for all contenders and all model processes together |
| Calls per day | \`CODEMODE_LLM_PER_DAY\`, default 500, per UTC day, shared as well |
| Output per call | at most 1500 tokens for code, 1200 for text answers and judgements, 900 for critiques; smaller items less |
| Time per call | 60 seconds (single call); the durable code agent sets a stream timeout of 30 seconds instead |
| An agent's wait | \`CODEMODE_MODEL_WAIT_S\`, default 600 seconds, for the model process's answer |

When the per-minute limit is reached the agent **waits** for the next minute. What happens on a failure depends on the run mode:

- **Generations:** when the model does not answer, the agent falls back to a **scripted variant** for this contribution (the reason appears as a note in the run panel). Custom tasks have no scripted variants; the agent then delivers nothing.
- **Work board:** the item comes up again later, at most three times.
- **Daily limit:** when it is reached, the run ends as over budget in both modes.

## Durable code agent {#durable}

Code contributions are written by an agent that can make several attempts. It tests its code itself and corrects it before handing it in. If the process crashes, it continues from the same point after the restart. The final verdict still comes from the judge.

Technical details:

- **When:** the default as soon as \`CODEMODE_CHAT_LLM=1\` holds. \`CODEMODE_DURABLE_AGENT=0\` switches back to the single model call. The agent enables no models by itself. Text answers, critiques, plans and verifier calls stay single calls.
- **Limits:** at most 4 model attempts per contribution, at most 1500 output tokens per attempt. Automatic retries and compaction are off.
- **Tool:** only \`verify_code\`. It runs the code in the same sandbox as the judge. There are no shell, file or coding tools.
- **Before every attempt** the model process checks again the run, the model choice, the shared call quota, the address's day allowance and the run's budget. Every attempt counts as one call.
- **Crash:** the conversation belongs to the work item's id. A repeat uses the same submission and the first stored context. The usage is kept and booked once in the space.
- **Stop:** a stop prevents further attempts. A model request already sent may still cost money.
- **Notes:** a \`NOTE:\` line after the code becomes a note for the team, as with a single model call.

The agent runs as a child process of the model process. Only this worker loads pi-durable and Chord; the chat itself talks to it over IPC. Its store is an SQLite file of its own and is not part of the space, see [Stores](help.topic.big_and_nano#stores). More: \`docs/codemode-space-architektur.md\`, section "Dauerhafte Code-Agenten".

## Cost {#cost}

Every contribution of a model agent costs tokens: a few thousand per call, since the agent reads the team's attempts. Start runs with models deliberately: in generations mode, agents × generations × contributions per agent is the most contributions. The durable code agent makes up to 4 calls per contribution. The work board makes additional calls for plans, critiques and judging. A solved run ends earlier.

**Seeing the usage:** every tile of a model agent shows the tokens and cost of its call (e.g. "3.2k Tok · $0.0040"), the unfolded contribution the split into input, output and cache. The block header shows the block's sum (Σ, the verifier agent included), the run panel the sum of the current run. The provider reports the numbers through pi-ai; the cost is the **list price** from the model catalog in US dollars. With subscription access (pi CLI login) you do not pay per token, so it is only a guide.

## See also {#see-also}

- [Runs and contenders](help.topic.runs_and_contenders#overview)
- [Configuration and startup](help.topic.configuration#overview)`,
		},
	},
	{
		id: "help.topic.big_and_nano",
		section: "operate",
		title: { de: "Prozesse, big und nano", en: "Processes, big and nano" },
		short: { de: "Jede Rolle ein eigener Prozess, alle reden nur über einen Space; welcher Prozess auf welchem Host läuft, ist Konfiguration.", en: "Every role its own process, all of them talk only through one space; which process runs on which host is configuration." },
		body: {
			de: `## Überblick {#overview}

Der Chat besteht aus mehreren kleinen Programmen, von denen jedes eine Aufgabe hat. Sie sprechen nie direkt miteinander, sondern nur über einen gemeinsamen Speicher. Stürzt eines ab, geht seine Arbeit nicht verloren und wird neu aufgenommen. Im Betrieb laufen die Programme auf zwei Rechnern, die big und nano heißen.

## Die Prozesse {#hub}

Im Codemode-Chat ist **alles Space**: Jede Rolle läuft als eigener Prozess, und die Prozesse reden nur über einen gemeinsamen phi-space miteinander. Kein Prozess hält Zustand nur in seinem Speicher. Stirbt ein Prozess, laufen seine Transaktionen und Leases ab, und seine Arbeit erscheint wieder für einen anderen Prozess derselben Rolle.

| Prozess | Datei | Aufgabe |
|---|---|---|
| space | \`server/space-host.ts\` | trägt den Space (eigener SQLite-Speicher von phi-spaces) und stellt ihn über den phi-spaces-Socket bereit (\`CODEMODE_LISTEN\`) |
| judge | \`server/judge-host.ts\` | nimmt einen Beitrag in einer Transaktion, bewertet ihn in der Sandbox dieses Rechners und schreibt Urteil und besten Code in derselben Transaktion; führt auch das ▶ der Seite aus |
| agents | \`server/agent-host.ts\` | übernimmt die Agentenplätze eines Laufs und arbeitet dessen Aufträge ab, jeden in einer eigenen Transaktion; stirbt der Prozess, übernimmt ein anderer die Plätze. Macht auch die Arbeit beim Anlegen einer Aufgabe (Prüfregel, Kriterien) |
| model | \`server/model-host.ts\` | macht jeden Modellaufruf (nur dieser Prozess braucht Zugangsdaten): nimmt die Anfrage eines Agenten, baut den Kontext aus dem Space und schreibt die Antwort in derselben Transaktion. Startet den [dauerhaften Code-Agenten](help.topic.model_agents#durable) als Kindprozess und führt die Websuche aus |
| web | \`server/index.ts\` | Oberfläche (Next.js), REST-API, WebSocket; folgt dem Änderungsstrom des Space und schickt neue Snapshots |

Lokal startet \`npm run dev\` (oder \`npm start\`) alle fünf Prozesse und startet einen beendeten Prozess nach einer Sekunde neu; \`CODEMODE_ROLES\` wählt, welche auf diesem Rechner laufen.

## Wer läuft wo {#hosts}

| Rechner | Container | Bemerkung |
|---|---|---|
| nano | \`space\`, \`judge-nano\` | hält den Zustand; Start mit \`docker:nano:up\` |
| big | \`web\`, \`judge-big\`, \`agents\`, \`model\` | macht die meiste Arbeit; Start mit \`docker:big:up\` |

\`docker:big:up\` nutzt immer \`docker/docker-compose.hostnet.yml\`: Die Rollen teilen das Host-Netz und erreichen nano über den SSH-Tunnel auf \`127.0.0.1\`, und der web-Prozess lauscht nur dort. \`docker:local:up\` startet beide Seiten auf einem Rechner als Testumgebung (web auf Port 3710, Space auf \`127.0.0.1:3810\`).

## Speicher {#stores}

| Speicher | Datei | Gehört |
|---|---|---|
| Space | \`codemode-space.sqlite\` im Volume \`codemode-space-data\` auf nano | space-Prozess |
| Dauerhafter Code-Agent | \`codemode-agent.sqlite\` im Volume \`codemode-agent-data\` auf big | model-Prozess |

Der Space nutzt den eigenen SQLite-Speicher von phi-spaces. Eine Datei im früheren pi-durable-Format wird abgelehnt, nicht übernommen. Der Speicher des Agenten ist dagegen ein pi-durable-Speicher. Er hat genau einen Besitzer: Jeder model-Prozess braucht einen eigenen, dauerhaft eingehängten Pfad (\`CODEMODE_DURABLE_STORE\`). Er wird nicht zwischen Rechnern repliziert.

## Mehrere Bewerter {#shard}

Bewerter-Prozesse können auf jedem Rechner laufen, der den Space erreicht (\`CODEMODE_SPACE\`), auch mehrere. Sie teilen sich die Beiträge von selbst: Wer frei ist, nimmt den nächsten. Die Kachel nennt den Host, der bewertet hat (\`CODEMODE_HOST_NAME\`).

## Zusammenspiel {#interplay}

Jeder Prozess hält einen \`Process\`-Eintrag im Space und verlängert ihn alle 10 Sekunden. Die **Systemleiste** unten zeigt daraus jeden Host mit seinen Rollen, CPU, Speicher und der Zahl der Beiträge, die seine Bewerter bewertet haben. Ein Bewerter, der mitten in der Bewertung stirbt, lässt seine Transaktion ablaufen; dann nimmt ein anderer den Beitrag. Das dauert höchstens \`CODEMODE_JUDGE_LEASE_MS\`, Standard \`CODEMODE_MAX_TIMEOUT_S\` + 30 s, also 630 s, weil die Sandbox während eines Falls keine Verlängerung zulässt. Nach zwei solchen Abstürzen beim selben Beitrag bekommt er ein Fehlurteil. Beim **Löschen eines Blocks** gehen alle seine Urteile mit.

## Verbindung {#connection}

| Weg | \`CODEMODE_LISTEN\` (space) / \`CODEMODE_SPACE\` (die anderen) |
|---|---|
| lokal, ein Rechner | \`unix:/tmp/codemode-space.sock\` (Standard) |
| zwei Rechner | \`tcp:0.0.0.0:3800\` / \`tcp:<host>:3800\` |
| SSH-Tunnel | \`tcp:127.0.0.1:3800\` auf beiden Seiten |

Der Socket hat **kein TLS** und behandelt jede Verbindung als Prozess des Chats: binde ihn an eine interne Adresse oder nutze einen Tunnel, nie eine öffentliche Schnittstelle. Auf nano setzt \`CODEMODE_SPACE_BIND\` die Adresse (Standard \`127.0.0.1\`), auf big zeigt \`CODEMODE_SPACE\` dorthin.

## Siehe auch {#see-also}

- [Konfiguration und Start](help.topic.configuration#overview)
- [Bewertung und Sandbox](help.topic.judging_and_sandbox#overview)`,
			en: `## Overview {#overview}

The chat consists of several small programs, each with one job. They never talk to each other directly, only through one shared store. If one crashes, its work is not lost and gets picked up again. In operation the programs run on two machines called big and nano.

## The processes {#hub}

In the codemode chat **everything is space**: every role runs as its own process, and the processes talk to each other only through one shared phi-space. No process keeps state only in its memory. When a process dies, its transactions and leases lapse, and its work comes back for another process of the same role.

| Process | File | Job |
|---|---|---|
| space | \`server/space-host.ts\` | owns the space (phi-spaces' own SQLite store) and serves it over the phi-spaces socket (\`CODEMODE_LISTEN\`) |
| judge | \`server/judge-host.ts\` | takes a contribution under a transaction, judges it in this machine's sandbox and writes the verdict and the best code in that same transaction; also runs the page's ▶ |
| agents | \`server/agent-host.ts\` | takes the agent slots of a run and does its work items, each in a transaction of its own; when the process dies, another one takes the slots over. Also does the work of creating a task (check rule, criteria) |
| model | \`server/model-host.ts\` | makes every model call (only this process needs credentials): takes an agent's request, builds the context from the space and writes the answer in the same transaction. Starts the [durable code agent](help.topic.model_agents#durable) as a child process and runs the web searches |
| web | \`server/index.ts\` | interface (Next.js), REST API, WebSocket; follows the space's change stream and pushes fresh snapshots |

Locally \`npm run dev\` (or \`npm start\`) starts all five and restarts a process that ended after a second; \`CODEMODE_ROLES\` picks the ones that run on this machine.

## Who runs where {#hosts}

| Host | Containers | Remark |
|---|---|---|
| nano | \`space\`, \`judge-nano\` | keeps the state; start with \`docker:nano:up\` |
| big | \`web\`, \`judge-big\`, \`agents\`, \`model\` | does most of the work; start with \`docker:big:up\` |

\`docker:big:up\` always uses \`docker/docker-compose.hostnet.yml\`: the roles share the host network and reach nano through the SSH tunnel on \`127.0.0.1\`, and the web process listens there only. \`docker:local:up\` starts both sides on one machine as a test bed (web on port 3710, the space on \`127.0.0.1:3810\`).

## Stores {#stores}

| Store | File | Owner |
|---|---|---|
| Space | \`codemode-space.sqlite\` in the volume \`codemode-space-data\` on nano | space process |
| Durable code agent | \`codemode-agent.sqlite\` in the volume \`codemode-agent-data\` on big | model process |

The space uses phi-spaces' own SQLite store. A file in the earlier pi-durable format is refused, not taken over. The agent's store, by contrast, is a pi-durable store. It has exactly one owner: every model process needs its own durably mounted path (\`CODEMODE_DURABLE_STORE\`). It is not replicated between hosts.

## Several judges {#shard}

Judge processes can run on any machine that reaches the space (\`CODEMODE_SPACE\`), as many as you like. They share the contributions by themselves: whoever is free takes the next one. The tile names the host that judged (\`CODEMODE_HOST_NAME\`).

## How they work together {#interplay}

Every process keeps a \`Process\` entry in the space and renews it every 10 seconds. From these the **system bar** at the bottom shows every host with its roles, CPU, memory and the number of contributions its judges judged. A judge that dies in the middle of a judgement lets its transaction lapse; then another one takes the contribution. That takes at most \`CODEMODE_JUDGE_LEASE_MS\`, default \`CODEMODE_MAX_TIMEOUT_S\` + 30 s, so 630 s, because the sandbox allows no renewal while a case runs. After two such crashes on the same contribution it gets a failed verdict. **Deleting a block** takes all its verdicts along.

## Connection {#connection}

| Way | \`CODEMODE_LISTEN\` (space) / \`CODEMODE_SPACE\` (the others) |
|---|---|
| local, one machine | \`unix:/tmp/codemode-space.sock\` (default) |
| two machines | \`tcp:0.0.0.0:3800\` / \`tcp:<host>:3800\` |
| SSH tunnel | \`tcp:127.0.0.1:3800\` on both sides |

The socket has **no TLS** and treats every connection as a process of the chat: bind it to an internal address or use a tunnel, never a public interface. On nano \`CODEMODE_SPACE_BIND\` sets the address (default \`127.0.0.1\`), on big \`CODEMODE_SPACE\` points to it.

## See also {#see-also}

- [Configuration and startup](help.topic.configuration#overview)
- [Judging and sandbox](help.topic.judging_and_sandbox#overview)`,
		},
	},
	{
		id: "help.topic.configuration",
		section: "operate",
		title: { de: "Konfiguration und Start", en: "Configuration and startup" },
		short: { de: "Umgebungsvariablen, lokale Entwicklung, Docker (nano, big, lokal, dev, test), Sicherung.", en: "Environment variables, local development, Docker (nano, big, local, dev, test), backups." },
		body: {
			de: `## Überblick {#overview}

Der Chat liest seine Einstellungen aus einer Datei und aus Umgebungsvariablen. Für den Start reichen wenige Zeilen, alles andere hat Standardwerte. Lokal startet ein einziger Befehl alle Programme. Im Betrieb läuft jedes Programm in einem eigenen Container.

## Variablen {#variables}

Die Prozesse lesen \`codemode-chat/.env\` selbst; echte Umgebungsvariablen haben Vorrang. Eine Vorlage liegt in \`.env.example\`. Der Aufbau entspricht dem phi-spaces-Hilfesystem, mit \`CODEMODE_*\`-Variablen für alles Codemode-Spezifische.

| Key | Bedeutung |
|---|---|
| \`PORT\` | Port des web-Prozesses, Standard 3700 |
| \`CODEMODE_BIND\` | Bind-Adresse des web-Prozesses, Standard \`127.0.0.1\` |
| \`HOST_BIND\` | Docker: veröffentlichte Adresse. Container \`web\`: Standard \`127.0.0.1\`, auch wenn leer. Dev-Container: leer = alle |
| \`CODEMODE_SQLITE\` | space: Speicher, Standard \`.local/codemode-space.sqlite\`; \`CODEMODE_MEM=1\` = nur im Speicher |
| \`CODEMODE_LISTEN\` | space: Adresse, an der der Space bereitsteht, Standard \`unix:/tmp/codemode-space.sock\` |
| \`CODEMODE_SPACE\` | alle anderen Prozesse: Adresse des Space (\`unix:…\` oder \`tcp:host:port\`) |
| \`CODEMODE_SPACE_CALL_TIMEOUT\`, \`CODEMODE_SPACE_CONNECT_TIMEOUT\` | Millisekunden je Aufruf (30 000) und für den Verbindungsaufbau (5000) |
| \`CODEMODE_ROLES\` | \`npm run dev\` / \`npm start\`: welche Prozesse auf diesem Rechner laufen, Standard alle fünf (\`space,judge,agents,model,web\`) |
| \`CODEMODE_HOST_NAME\` | Name in der Systemleiste, Standard der Hostname |
| \`CODEMODE_CHAT_LLM\` | \`1\` schaltet Modell-Agenten ein |
| \`CODEMODE_DURABLE_AGENT\` | \`0\` schaltet den dauerhaften Code-Agenten ab; Standard an, sobald Modell-Agenten an sind |
| \`CODEMODE_DURABLE_STORE\` | Speicher des Agenten, Standard \`codemode-agent.sqlite\` neben \`CODEMODE_SQLITE\`, sonst in \`.local/\` |
| \`CODEMODE_CHAT_MODEL\` | Teilname des Standardmodells |
| \`CODEMODE_VERIFIER_MODEL\` | Teilname des Modells, mit dem der Prüfer-Agent Prüfregeln schreibt, Standard \`haiku\` |
| \`CODEMODE_CRITIC_MODEL\` | Teilname des Modells, das auf dem Auftragsbrett zuerst kritisiert, Standard \`haiku\` |
| \`CODEMODE_LLM_PER_MIN\` | Modellaufrufe pro Minute, Standard 20 |
| \`CODEMODE_LLM_PER_DAY\` | Modellaufrufe pro Tag, Standard 500 (Kostendeckel) |
| \`CODEMODE_MODEL_PARALLEL\` | model: gleichzeitige Aufrufe je Prozess, Standard 2 |
| \`CODEMODE_MODEL_WAIT_S\` | wie lange ein Agent auf die Antwort eines Modellaufrufs wartet, Standard 600 |
| \`CODEMODE_SEARCH_PER_DAY\` | Websuchen pro Tag, Standard 100 |
| \`CODEMODE_RUN_BUDGET_TOKENS\` | Token-Budget eines Besucher-Laufs, Standard 300 000; \`0\` = keines |
| \`CODEMODE_TOKENS_PER_IP_DAY\` | Tokens aller Besucher-Läufe einer Adresse am Tag, Standard 1 000 000; \`0\` = keine Grenze |
| \`CODEMODE_EARLIER_DAYS\` | wie lange angenommene Ergebnisse Material bleiben, Standard 30; \`0\` = immer |
| \`CODEMODE_CROSS_WAIT_S\` | Textaufgaben: Wartezeit auf einen Prüfer mit anderem Modell, Standard 300 |
| \`CODEMODE_JUDGES\` | judge: parallele Bewerter je Prozess, Standard 2 |
| \`CODEMODE_JUDGE_LEASE_MS\` | judge: Lease der Transaktion eines Bewerters; stirbt er, ist sein Beitrag danach wieder frei, Standard \`CODEMODE_MAX_TIMEOUT_S\` + 30 s (630 000) |
| \`CODEMODE_VERDICT_WAIT_S\` | wie lange ein Lauf auf ein Urteil wartet; ohne Angabe die längste Dauer eines Bewerters, bei Text 600 |
| \`CODEMODE_AGENT_SLOTS\` | agents: Agenten je Prozess, Standard 16 |
| \`CODEMODE_AGENT_LEASE_MS\` | agents: Lease von Platz und Auftrag, Standard 60 000 |
| \`CODEMODE_TTL_HOURS\` | Lebensdauer der Einträge eines Raums in Stunden, Standard 8760 (ein Jahr); ⟳ am Block verlängert ihn um so viel ab jetzt, 🗑 löscht ihn; \`0\` = bis der Block gelöscht wird |
| \`CODEMODE_ADMIN_PASSWORD\` | web: Passwort des Admin-Logins (Panel links unten; für Skripte als Header \`x-admin-token\`); leer = kein Admin. Älterer Name: \`CODEMODE_ADMIN_TOKEN\` |
| \`CODEMODE_MAX_TIMEOUT_S\` | höchstes Zeitlimit je Beitrag, das eine eigene Aufgabe wählen darf, Standard 600; das Formularfeld richtet sich danach. Ein langes Limit belegt einen Bewerter entsprechend lange |
| \`CODEMODE_REQ_PER_MIN\` | web: API-Anfragen und WebSocket-Verbindungen je Client-IP und Minute, Standard 120 |
| \`PI_AUTH_DIR\` | Pfad der pi-Zugangsdaten für den Container |
| \`PI_CODEMODE_DIR\` | pi-codemode aus einem Checkout laden statt aus \`node_modules\` |
| \`CODEMODE_DEV_ORIGINS\` | nur Dev-Modus: weitere Hosts, unter denen die Seite geöffnet wird (z. B. eine LAN-IP); \`localhost\` und \`127.0.0.1\` gehen immer |
| \`CODEMODE_SPACE_BIND\`, \`CODEMODE_SPACE_PORT\` | nano: Adresse und Port, auf denen der Space veröffentlicht wird, Standard \`127.0.0.1\` und 3800 |
| \`NANO_JUDGES\`, \`NANO_CPUS\`, \`NANO_HOST_NAME\` | nano: Bewerter (1), CPU-Grenze, Name in der Systemleiste |
| \`BIG_JUDGES\`, \`BIG_HOST_NAME\` | big: Bewerter (2), Name in der Systemleiste |
| \`CODEMODE_BACKUP_KEEP\` | Zahl der aufbewahrten Sicherungen des Space, Standard 7 |

## Lokal entwickeln {#local}

\`\`\`bash
npm --prefix codemode-chat run dev            # alle fünf Prozesse (web im Next.js-Dev-Modus), http://localhost:3700
npm --prefix codemode-chat run space          # oder ein einzelner Prozess: space | judge | agents | model | web
npm --prefix codemode-chat run build && npm --prefix codemode-chat start   # Produktion
npm --prefix codemode-chat run typecheck      # Typprüfung
npm run test:codemode-chat                    # Tests
\`\`\`

Im Dev-Modus lädt Next.js \`app/\` und \`client/\` bei jeder Änderung neu, und \`node --watch-path\` startet jeden Prozess neu, wenn sich \`server/\` oder die phi-spaces-Quellen ändern. Öffne die Dev-Seite über \`http://localhost:3700\`: Next.js 16 hydratisiert Dev-Seiten über \`127.0.0.1\` nicht.

## Docker {#docker}

Der Build-Kontext ist das Repository. \`docker/docker-compose.yml\` startet aus einem Image einen Container je Rolle. Die Datei \`codemode-chat/.env\` muss bestehen; alle Rollen-Container lesen sie, also erreichen dort eingetragene API-Schlüssel jeden dieser Container. Die Einordnung der Rollen steht unter [Prozesse, big und nano](help.topic.big_and_nano#hosts).

\`\`\`bash
npm --prefix codemode-chat run docker:nano:up   # nano: space und judge-nano; baut das Image selbst
npm --prefix codemode-chat run docker:big:up    # big: web, judge-big, agents, model; baut das Image selbst
npm --prefix codemode-chat run docker:image     # das Image bauen (vor docker:local:up nötig)
npm --prefix codemode-chat run docker:local:up  # beide auf einem Rechner, http://localhost:3710
npm --prefix codemode-chat run docker:dev:up    # alle Rollen in einem Container, Quellen eingehängt
npm --prefix codemode-chat run docker:test      # Tests im Container
\`\`\`

\`docker:prod:up\` ist absichtlich gesperrt: Ein Rechner fährt ein Profil. \`down\` und \`logs\` gibt es zu \`nano\`, \`big\`, \`local\` und \`dev\`.

Die Ports 3700 (web) und 3800 (Space über TCP) kollidieren nicht mit dem Hilfesystem (3500/3600). Beispiele für Caddy, nginx und systemd liegen in \`deploy/\`.

## Sicherung {#backup}

\`npm --prefix codemode-chat run docker:backup\` schreibt im laufenden Betrieb eine konsistente Kopie des Space nach \`/data/backups\` im Volume und behält die neuesten \`CODEMODE_BACKUP_KEEP\`. \`server/restore.ts\` spielt eine Kopie bei gestopptem Space zurück; es lehnt ab, solange ein Prozess den Speicher offen hat.

Diese Sicherung umfasst **nicht** den Speicher des dauerhaften Code-Agenten (\`codemode-agent.sqlite\`). Sichere ihn getrennt, einschließlich seines WAL-Zustands, vor allem vor einem Upgrade: pi-durable 1.4.0 hebt eine ältere Datei auf Schema 2, und 1.3.0 oder älter kann sie danach nicht mehr öffnen.

## Pakete und Versionen {#versions}

Alle Abhängigkeiten sind auf exakte Versionen festgelegt. Der Chat nutzt pi-codemode 1.4.0, Next.js 16.4.3 und React 19.3.0. \`phi-spaces\` kommt als Paket \`file:..\` aus dem Repository, keine Importe in \`../src\`. Die Pakete des Agenten (pi-durable, pi-ai, Chord, alle 1.4.0) gehören zu \`agent/\` und werden dort installiert.

## Siehe auch {#see-also}

- [big und nano](help.topic.big_and_nano#overview)
- [Sicherheit und Grenzen](help.topic.safety_and_limits#overview)`,
			en: `## Overview {#overview}

The chat reads its settings from a file and from environment variables. A few lines are enough to start, and everything else has a default. Locally one command starts all programs. In operation every program runs in a container of its own.

## Variables {#variables}

The processes read \`codemode-chat/.env\` themselves; real environment variables win. A template is in \`.env.example\`. The layout matches the phi-spaces help system, with \`CODEMODE_*\` variables for everything codemode-specific.

| Key | Meaning |
|---|---|
| \`PORT\` | port of the web process, default 3700 |
| \`CODEMODE_BIND\` | bind address of the web process, default \`127.0.0.1\` |
| \`HOST_BIND\` | Docker: published address. Container \`web\`: default \`127.0.0.1\`, also when empty. Dev container: empty = all |
| \`CODEMODE_SQLITE\` | space: storage, default \`.local/codemode-space.sqlite\`; \`CODEMODE_MEM=1\` = in memory only |
| \`CODEMODE_LISTEN\` | space: address the space is served on, default \`unix:/tmp/codemode-space.sock\` |
| \`CODEMODE_SPACE\` | every other process: address of the space (\`unix:…\` or \`tcp:host:port\`) |
| \`CODEMODE_SPACE_CALL_TIMEOUT\`, \`CODEMODE_SPACE_CONNECT_TIMEOUT\` | milliseconds per call (30,000) and to connect (5000) |
| \`CODEMODE_ROLES\` | \`npm run dev\` / \`npm start\`: which processes run on this machine, default all five (\`space,judge,agents,model,web\`) |
| \`CODEMODE_HOST_NAME\` | name in the system bar, default the hostname |
| \`CODEMODE_CHAT_LLM\` | \`1\` enables model agents |
| \`CODEMODE_DURABLE_AGENT\` | \`0\` turns the durable code agent off; default on as soon as model agents are on |
| \`CODEMODE_DURABLE_STORE\` | the agent's store, default \`codemode-agent.sqlite\` next to \`CODEMODE_SQLITE\`, else in \`.local/\` |
| \`CODEMODE_CHAT_MODEL\` | part of the default model name |
| \`CODEMODE_VERIFIER_MODEL\` | part of the name of the model the verifier agent writes check rules with, default \`haiku\` |
| \`CODEMODE_CRITIC_MODEL\` | part of the name of the model that critiques first on the work board, default \`haiku\` |
| \`CODEMODE_LLM_PER_MIN\` | model calls per minute, default 20 |
| \`CODEMODE_LLM_PER_DAY\` | model calls per day, default 500 (cost cap) |
| \`CODEMODE_MODEL_PARALLEL\` | model: calls at once per process, default 2 |
| \`CODEMODE_MODEL_WAIT_S\` | how long an agent waits for the answer of a model call, default 600 |
| \`CODEMODE_SEARCH_PER_DAY\` | web searches per day, default 100 |
| \`CODEMODE_RUN_BUDGET_TOKENS\` | token budget of a visitor's run, default 300,000; \`0\` = none |
| \`CODEMODE_TOKENS_PER_IP_DAY\` | tokens of all visitor runs of one address per day, default 1,000,000; \`0\` = no limit |
| \`CODEMODE_EARLIER_DAYS\` | how long accepted results stay as material, default 30; \`0\` = always |
| \`CODEMODE_CROSS_WAIT_S\` | text tasks: wait for a judge of another model, default 300 |
| \`CODEMODE_JUDGES\` | judge: parallel judges per process, default 2 |
| \`CODEMODE_JUDGE_LEASE_MS\` | judge: lease of a judge's transaction; when it dies, its contribution is free again after it, default \`CODEMODE_MAX_TIMEOUT_S\` + 30 s (630,000) |
| \`CODEMODE_VERDICT_WAIT_S\` | how long a run waits for a verdict; unset: a judge's worst case, text 600 |
| \`CODEMODE_AGENT_SLOTS\` | agents: agents per process, default 16 |
| \`CODEMODE_AGENT_LEASE_MS\` | agents: lease of a slot and a work item, default 60,000 |
| \`CODEMODE_TTL_HOURS\` | lifetime of a room's entries in hours, default 8760 (a year); ⟳ on a block extends it by as much from now, 🗑 deletes it; \`0\` = until the block is deleted |
| \`CODEMODE_ADMIN_PASSWORD\` | web: password of the admin login (panel at the bottom left; for scripts as the header \`x-admin-token\`); empty = no admin. Older name: \`CODEMODE_ADMIN_TOKEN\` |
| \`CODEMODE_MAX_TIMEOUT_S\` | the longest time limit per contribution a custom task may choose, default 600; the form's field follows it. A long limit keeps one judge busy that long |
| \`CODEMODE_REQ_PER_MIN\` | web: API requests and WebSocket connects per client IP and minute, default 120 |
| \`PI_AUTH_DIR\` | path of the pi credentials for the container |
| \`PI_CODEMODE_DIR\` | load pi-codemode from a checkout instead of \`node_modules\` |
| \`CODEMODE_DEV_ORIGINS\` | dev mode only: further hosts the page is opened from (e.g. a LAN IP); \`localhost\` and \`127.0.0.1\` always work |
| \`CODEMODE_SPACE_BIND\`, \`CODEMODE_SPACE_PORT\` | nano: address and port the space is published on, default \`127.0.0.1\` and 3800 |
| \`NANO_JUDGES\`, \`NANO_CPUS\`, \`NANO_HOST_NAME\` | nano: judges (1), CPU cap, name in the system bar |
| \`BIG_JUDGES\`, \`BIG_HOST_NAME\` | big: judges (2), name in the system bar |
| \`CODEMODE_BACKUP_KEEP\` | backups of the space kept, default 7 |

## Developing locally {#local}

\`\`\`bash
npm --prefix codemode-chat run dev            # all five processes (web in Next.js dev mode), http://localhost:3700
npm --prefix codemode-chat run space          # or one process: space | judge | agents | model | web
npm --prefix codemode-chat run build && npm --prefix codemode-chat start   # production
npm --prefix codemode-chat run typecheck      # type check
npm run test:codemode-chat                    # tests
\`\`\`

In dev mode Next.js reloads \`app/\` and \`client/\` on every change, and \`node --watch-path\` restarts each process when \`server/\` or the phi-spaces sources change. Open the dev page as \`http://localhost:3700\`: Next.js 16 does not hydrate dev pages requested through \`127.0.0.1\`.

## Docker {#docker}

The build context is the repository. \`docker/docker-compose.yml\` starts one container per role from one image. The file \`codemode-chat/.env\` must exist; every role container reads it, so API keys entered there reach each of these containers. Where the roles belong is under [Processes, big and nano](help.topic.big_and_nano#hosts).

\`\`\`bash
npm --prefix codemode-chat run docker:nano:up   # nano: space and judge-nano; builds the image itself
npm --prefix codemode-chat run docker:big:up    # big: web, judge-big, agents, model; builds the image itself
npm --prefix codemode-chat run docker:image     # build the image (needed before docker:local:up)
npm --prefix codemode-chat run docker:local:up  # both on one machine, http://localhost:3710
npm --prefix codemode-chat run docker:dev:up    # all roles in one container, sources mounted
npm --prefix codemode-chat run docker:test      # tests in a container
\`\`\`

\`docker:prod:up\` is refused on purpose: one host runs one profile. \`down\` and \`logs\` exist for \`nano\`, \`big\`, \`local\` and \`dev\`.

Ports 3700 (web) and 3800 (the space over TCP) do not collide with the help system (3500/3600). Examples for Caddy, nginx and systemd are in \`deploy/\`.

## Backups {#backup}

\`npm --prefix codemode-chat run docker:backup\` writes a consistent copy of the space into \`/data/backups\` in the volume while it runs, and keeps the newest \`CODEMODE_BACKUP_KEEP\`. \`server/restore.ts\` puts a copy back while the space is stopped; it refuses while any process has the store open.

This backup does **not** cover the durable code agent's store (\`codemode-agent.sqlite\`). Back it up separately, with its WAL state, above all before an upgrade: pi-durable 1.4.0 moves an older file to schema 2, and 1.3.0 or older cannot open it afterwards.

## Packages and versions {#versions}

All dependencies are pinned to exact versions. The chat uses pi-codemode 1.4.0, Next.js 16.4.3 and React 19.3.0. \`phi-spaces\` comes as the package \`file:..\` from the repository, with no imports into \`../src\`. The agent's packages (pi-durable, pi-ai, Chord, all 1.4.0) belong to \`agent/\` and are installed there.

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

Der Chat führt Code aus, den andere geschrieben haben. Dieser Code läuft nur in einem abgeschirmten Bereich ohne Zugriff auf Dateien oder Netz. Zusätzlich begrenzt der Server, wie viel ein Raum und ein Besucher tun können. Besucher melden sich nicht an, deshalb sollte der Chat nicht ungeschützt im Internet stehen.

## Grenzen {#limits}

**Code ist Daten**: Er läuft nur in der Sandbox. Die Grenzen je Raum und Minute zählt jeder web-Prozess für sich.

| Limit | Wert |
|---|---|
| Quelltext je Beitrag | 16 000 Zeichen, als JSON höchstens 40 000 Byte |
| Eingereichter Code | 20 pro Minute und Raum |
| Läufe | 6 pro Minute und Raum |
| Neue Aufgaben | 30 pro Minute und Raum |
| Löschungen | 20 pro Minute und Raum |
| Verlängerungen | 20 pro Minute und Raum |
| Hinweise ans Team | 20 pro Minute und Raum |
| Abwertungen, Annahmen | je 30 pro Minute und Raum |
| API-Anfragen | \`CODEMODE_REQ_PER_MIN\`, Standard 120 pro Minute und Adresse |
| Admin-Anmeldungen | 10 Versuche pro Minute und Adresse |
| Aufgabenblöcke | höchstens 60 je Raum |
| Beiträge, Protokollzeilen, Notizen | die Seite liest je Raum höchstens 1000, 500 und 300; ältere Protokollzeilen weichen |
| Räume | höchstens 50 gleichzeitig im Speicher eines web-Prozesses |
| WebSocket-Verbindungen | höchstens 256 je web-Prozess |
| Anfragekörper | höchstens 64 000 Byte |

## Was nicht geschützt ist {#unprotected}

- **Keine Anmeldung für Besucher:** Eingereichter Code trägt einen Gastnamen, den der Browser sich merkt. Jeder im Raum kann Aufgaben anlegen, Läufe starten und Blöcke löschen oder verlängern. Nur Betreiber melden sich mit \`CODEMODE_ADMIN_PASSWORD\` an (Modellauswahl, Recherche, Läufe ohne Besucher-Budget).
- **Offene Räume:** Wer die Adresse kennt, ist im Raum.
- **Kein TLS am Space-Socket:** siehe [Prozesse, big und nano](help.topic.big_and_nano#connection).

Stelle die App deshalb nicht ohne Reverse-Proxy (und gegebenenfalls Zugriffsschutz) öffentlich zur Verfügung.

## Die Sandbox {#sandbox}

Siehe [Bewertung und Sandbox](help.topic.judging_and_sandbox#sandbox): keine Werkzeuge, Dateien, Netz oder Timer; 5 Sekunden (eigene Aufgaben: einstellbar), 64 MiB.

## Siehe auch {#see-also}

- [API](help.topic.api#overview)
- [Konfiguration und Start](help.topic.configuration#overview)`,
			en: `## Overview {#overview}

The chat runs code that others wrote. This code only runs in a sealed-off area without access to files or the network. The server also limits how much a room and a visitor can do. Visitors do not sign in, so the chat should not stand unprotected on the internet.

## Limits {#limits}

**Code is data**: it only runs in the sandbox. The limits per room and minute are counted by each web process for itself.

| Limit | Value |
|---|---|
| Source per contribution | 16,000 characters, at most 40,000 bytes as JSON |
| Handed-in code | 20 per minute and room |
| Runs | 6 per minute and room |
| New tasks | 30 per minute and room |
| Deletions | 20 per minute and room |
| Extensions | 20 per minute and room |
| Hints to the team | 20 per minute and room |
| Rejections, acceptances | 30 each per minute and room |
| API requests | \`CODEMODE_REQ_PER_MIN\`, default 120 per minute and address |
| Admin logins | 10 tries per minute and address |
| Task blocks | at most 60 per room |
| Contributions, log lines, notes | the page reads at most 1000, 500 and 300 per room; older log lines give way |
| Rooms | at most 50 in the memory of a web process at a time |
| WebSocket connections | at most 256 per web process |
| Request body | at most 64,000 bytes |

## What is not protected {#unprotected}

- **No sign-in for visitors:** handed-in code carries a guest name that the browser remembers. Anyone in a room can create tasks, start runs and delete or extend blocks. Only operators sign in, with \`CODEMODE_ADMIN_PASSWORD\` (choice of models, research, runs without the visitor budget).
- **Open rooms:** whoever knows the address is in the room.
- **No TLS on the space socket:** see [Processes, big and nano](help.topic.big_and_nano#connection).

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

Die Oberfläche spricht mit dem Server über eine kleine Schnittstelle. Du kannst dieselbe Schnittstelle auch aus eigenen Skripten nutzen. Änderungen in einem Raum kommen laufend über eine offene Verbindung. Dieser Artikel listet alle Adressen auf.

## Grundregeln {#conventions}

Alle Antworten sind JSON, außer dem NDJSON-Strom von \`exec\`. Raumnamen bestehen aus Buchstaben, Ziffern, \`.\`, \`_\` und \`-\` (1 bis 48 Zeichen).

| Status | Bedeutung |
|---|---|
| 400 | Fehler in der Anfrage: \`{"error": "…"}\` |
| 403 | Admin-Aufruf ohne Berechtigung, falsches Passwort oder Recherche ohne Admin-Login |
| 404 | unbekannter Beitrag oder Plan |
| 405 | falsche Methode |
| 429 | zu viele Anfragen dieser Adresse |
| 503 | kein judge-Prozess nimmt \`exec\` an |

\`/healthz\` und \`GET /api/tasks\` zählen nicht gegen die Anfragegrenze.

Admin-Aufrufe gehen auf zwei Wegen: mit dem Passwort im Header \`x-admin-token\` oder mit dem Cookie der Anmeldung (12 Stunden gültig), bei POST zusätzlich mit dem Header \`x-codemode-admin: 1\`.

## REST {#rest}

| Endpunkt | Wirkung |
|---|---|
| \`GET /healthz\` | Lebenszeichen |
| \`GET /api/tasks\` | Katalog der Aufgaben |
| \`GET /api/system\` | Hosts der Systemleiste |
| \`GET /api/llm\` | verfügbare Modelle |
| \`POST /api/llm\` | Modell-Agenten an/aus, Standardmodell: \`{on,model}\`; nur als Admin |
| \`GET /api/sessions/:id\` | Zustand eines Raums (Blöcke, Chat, Lauf); in großen Räumen fehlt manchem Beitrag der Code (\`sourceOmitted\`) |
| \`GET /api/sessions/:id/source/:candidateId\` | Code, Testergebnisse und Herkunft eines Beitrags: \`{source, cases, passed, total, role, basedOn}\` |
| \`GET /api/sessions/:id/lineage/:candidateId\` | Werdegang eines Beitrags, höchstens 8 Schritte |
| \`GET /api/sessions/:id/plan/:id\` | Text eines Plans oder Recherche-Ergebnisses |
| \`POST /api/sessions/:id/exec\` | einen Beitrag ausführen: \`{candidateId, call?}\`; Antwort als NDJSON-Strom (\`start\`, \`case\`, \`log\`, \`value\`, \`error\`, \`end\`), Abbruch der Anfrage stoppt den Lauf |
| \`POST /api/sessions/:id/task\` | neuen Block anlegen: \`{taskId}\` oder \`{custom:{fn,prompt,cases,verify?,check?,timeoutS?}}\`; Fälle mit \`expect\` oder \`expectAny\` (1 bis 10 richtige); \`verify\` (Standard an): Prüfer-Agent; \`check\`: eigene Regel, höchstens 2000 Zeichen |
| \`POST /api/sessions/:id/run\` | Lauf starten: \`{agents,gens,perAgent,polish,contenders,board?,plan?,research?,budgetTokens?,budgetUsd?,lang?}\`; über die API mindestens 1 Agent; \`research\` nur als Admin |
| \`POST /api/sessions/:id/stop\` | Lauf stoppen: \`{by?, reason?}\`; der Grund geht als Hinweis an die Agenten |
| \`POST /api/sessions/:id/code\` | Code einreichen: \`{author,source}\` |
| \`POST /api/sessions/:id/delete\` | Block löschen: \`{blockId}\` |
| \`POST /api/sessions/:id/extend\` | Block verlängern (alle seine Einträge bleiben wieder \`CODEMODE_TTL_HOURS\` ab jetzt): \`{blockId}\` → \`{until}\` |
| \`POST /api/sessions/:id/veto\` | Beitrag abwerten: \`{candidateId, by, reason}\`; mit \`undo: true\` zurücknehmen |
| \`GET /api/admin/session\` · \`POST /api/admin/login\` · \`POST /api/admin/logout\` | Admin-Anmeldung mit \`{password}\` (\`{token}\` ist die ältere Form); HttpOnly-Cookie, siehe [Grundregeln](#conventions) |
| \`GET\`/\`POST /api/admin/models\` | alle Modelle mit Zugangsdaten und die erlaubten; \`{allowed: [labels] | null, on?}\` speichert die Auswahl |
| \`POST /api/sessions/:id/task\` mit \`{text:{prompt,criteria?}}\` | Textaufgabe anlegen (ohne Kriterien schreibt sie der Prüfer-Agent) |
| \`POST /api/sessions/:id/accept\` | Antwort annehmen (👍): \`{candidateId, by, reason}\`; \`undo: true\` nimmt zurück; beendet den Lauf |
| \`POST /api/sessions/:id/hint\` | Hinweis ans Team eines Blocks: \`{blockId?, text, by}\` (Standard: aktiver Block) |

## WebSocket {#websocket}

\`/ws/:id\` liefert beim Verbinden und nach jeder Änderung ein Bild des Raums: \`{"type":"snapshot", …}\`. Die Oberfläche verbindet sich bei Abbruch selbst neu.

## Das Bild eines Raums {#snapshot}

\`\`\`json
{
  "session": "lobby", "current": "<blockId>",
  "tasks": [{ "id": "primes", "title": {…}, "fn": "firstPrimes", "prompt": {…} }],
  "limits": { "maxTimeoutS": 600, "runBudgetTokens": 300000 },
  "blocks": [{
    "blockId": "…", "active": true, "until": 0, "task": {…},
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

The interface talks to the server through a small programming interface. You can use the same interface from your own scripts. Changes in a room arrive continuously over an open connection. This article lists all addresses.

## Conventions {#conventions}

All answers are JSON, except the NDJSON stream of \`exec\`. Room names consist of letters, digits, \`.\`, \`_\` and \`-\` (1 to 48 characters).

| Status | Meaning |
|---|---|
| 400 | an error in the request: \`{"error": "…"}\` |
| 403 | an admin call without permission, a wrong password, or research without the admin login |
| 404 | an unknown contribution or plan |
| 405 | the wrong method |
| 429 | too many requests from this address |
| 503 | no judge process takes \`exec\` |

\`/healthz\` and \`GET /api/tasks\` do not count against the request limit.

Admin calls work in two ways: with the password in the header \`x-admin-token\`, or with the login's cookie (valid for 12 hours), for POST also with the header \`x-codemode-admin: 1\`.

## REST {#rest}

| Endpoint | Effect |
|---|---|
| \`GET /healthz\` | liveness |
| \`GET /api/tasks\` | the task catalog |
| \`GET /api/system\` | the hosts of the system bar |
| \`GET /api/llm\` | available models |
| \`POST /api/llm\` | model agents on/off, default model: \`{on,model}\`; admin only |
| \`GET /api/sessions/:id\` | state of a room (blocks, chat, run); in large rooms some contributions come without code (\`sourceOmitted\`) |
| \`GET /api/sessions/:id/source/:candidateId\` | code, test results and lineage of a contribution: \`{source, cases, passed, total, role, basedOn}\` |
| \`GET /api/sessions/:id/lineage/:candidateId\` | how a contribution came about, at most 8 steps |
| \`GET /api/sessions/:id/plan/:id\` | the text of a plan or research finding |
| \`POST /api/sessions/:id/exec\` | run a contribution: \`{candidateId, call?}\`; answered as an NDJSON stream (\`start\`, \`case\`, \`log\`, \`value\`, \`error\`, \`end\`); closing the request stops the run |
| \`POST /api/sessions/:id/task\` | create a block: \`{taskId}\` or \`{custom:{fn,prompt,cases,verify?,check?,timeoutS?}}\`; cases with \`expect\` or \`expectAny\` (1 to 10 right results); \`verify\` (default on): verifier agent; \`check\`: own rule, at most 2000 characters |
| \`POST /api/sessions/:id/run\` | start a run: \`{agents,gens,perAgent,polish,contenders,board?,plan?,research?,budgetTokens?,budgetUsd?,lang?}\`; at least 1 agent through the API; \`research\` admin only |
| \`POST /api/sessions/:id/stop\` | stop the run: \`{by?, reason?}\`; the reason reaches the agents as a hint |
| \`POST /api/sessions/:id/code\` | hand in code: \`{author,source}\` |
| \`POST /api/sessions/:id/delete\` | delete a block: \`{blockId}\` |
| \`POST /api/sessions/:id/extend\` | extend a block (all its entries stay \`CODEMODE_TTL_HOURS\` from now again): \`{blockId}\` → \`{until}\` |
| \`POST /api/sessions/:id/veto\` | reject a contribution: \`{candidateId, by, reason}\`; \`undo: true\` withdraws it |
| \`GET /api/admin/session\` · \`POST /api/admin/login\` · \`POST /api/admin/logout\` | admin sign-in with \`{password}\` (\`{token}\` is the older form); HttpOnly cookie, see [Conventions](#conventions) |
| \`GET\`/\`POST /api/admin/models\` | every model with credentials and the allowed ones; \`{allowed: [labels] | null, on?}\` saves the choice |
| \`POST /api/sessions/:id/task\` with \`{text:{prompt,criteria?}}\` | create a text task (without criteria the verifier agent writes them) |
| \`POST /api/sessions/:id/accept\` | accept an answer (👍): \`{candidateId, by, reason}\`; \`undo: true\` withdraws; ends the run |
| \`POST /api/sessions/:id/hint\` | a hint to the team of a block: \`{blockId?, text, by}\` (default: the active block) |

## WebSocket {#websocket}

\`/ws/:id\` sends a picture of the room on connect and after every change: \`{"type":"snapshot", …}\`. The interface reconnects by itself when the connection drops.

## The picture of a room {#snapshot}

\`\`\`json
{
  "session": "lobby", "current": "<blockId>",
  "tasks": [{ "id": "primes", "title": {…}, "fn": "firstPrimes", "prompt": {…} }],
  "limits": { "maxTimeoutS": 600, "runBudgetTokens": 300000 },
  "blocks": [{
    "blockId": "…", "active": true, "until": 0, "task": {…},
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
