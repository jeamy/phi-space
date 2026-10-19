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
- **Zwei Hosts:** Ein zweiter Host (nano) kann die Bewertung auf seiner CPU übernehmen. Siehe [big und nano](help.topic.big_and_nano#overview).
- **Zwei Sprachen und Themes:** Oberfläche und Hilfe gibt es in Deutsch und Englisch, mit denselben Paletten wie das phi-spaces-Hilfesystem.

## Einträge im Space {#entries}

| Entry | Bedeutung |
|---|---|
| \`ChatMessage\` | Protokollzeile des Servers im Chat (zum Beispiel „Lauf gestartet“, „Block gelöscht“) |
| \`CodeTask\` | Ein Aufgabenblock eines Raums |
| \`CodeCandidate\` | Ein Beitrag, der auf seine Bewertung wartet |
| \`CodeScore\` | Das Urteil der Sandbox, samt Code (der sichtbare Beitrag) |
| \`CodeBest\` | Der schnellste korrekte Code eines Blocks |
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
- **Two hosts:** a second host (nano) can take over judging on its CPU. See [big and nano](help.topic.big_and_nano#overview).
- **Two languages and themes:** the interface and this help come in German and English, with the same palettes as the phi-spaces help system.

## Entries in the space {#entries}

| Entry | Meaning |
|---|---|
| \`ChatMessage\` | A server log line in the chat (for example "Run started", "Task block deleted") |
| \`CodeTask\` | One task block of a room |
| \`CodeCandidate\` | A contribution waiting for its verdict |
| \`CodeScore\` | The sandbox verdict, with the code (the visible contribution) |
| \`CodeBest\` | The fastest correct code of a block |
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
- **Beschreibung:** was die Funktion tun soll (höchstens 600 Zeichen); sie wird den Agenten gezeigt.
- **Testfälle:** JSON, zum Beispiel \`[{"args":[2],"expect":4},{"args":[5],"expect":10}]\`. 1 bis 50 Fälle, zusammen höchstens 32 000 Zeichen.

Die Testfälle sind das **Orakel**: Ein Beitrag ist nur korrekt, wenn er für jeden Fall genau das erwartete Ergebnis liefert (Vergleich als JSON). Gemessen wird die Zeit, die alle Fälle 300-mal hintereinander brauchen.

Eine eigene Aufgabe hat **keine Skript-Varianten**. Deshalb werden die Skript-Agenten ausgeblendet und automatisch ein Modell gewählt; ohne Modell-Zugang kannst du nur selbst Code einreichen (siehe [Modell-Agenten](help.topic.model_agents#overview)).

## Block anlegen {#create}

Das Dropdown wählt nur aus. **Lauf starten** legt bei Bedarf selbst einen neuen Block an, wenn die gewählte Aufgabe noch nicht der aktive Block ist, und startet danach den Lauf. Mit **0 Agenten** legt der Knopf nur den Block an; den Code reichst du dann selbst ein.

## Der Block im Chat {#block}

Ein Block ist ein einklappbarer Abschnitt: Im Kopf stehen Titel, Funktion, Zahl der Beiträge, korrekt/bewertet, die beste Zeit und der Laufstatus. Aufgeklappt zeigt er die Beschreibung, die Protokollzeilen des Laufs und die Beiträge als **quadratische Kacheln** (Agent, Modell, Zeit oder ✗, Generation, Host). Ein Klick auf eine Kachel klappt darunter den **gelieferten Code** auf.

**Rangliste, Wertung und bester Code** rechts gehören zu dem Block, der offen ist oder zuletzt angeklickt wurde („für …"). Ein neuer Block öffnet sich selbst und übernimmt diesen Fokus.

## Aktiver Block und Löschen {#active}

Der **aktive Block** (der neueste) nimmt neue Läufe und eingereichten Code auf. Ältere Blöcke bleiben zum Ansehen erhalten.

Mit dem Papierkorb im Blockkopf löschst du einen Block nach einer Ja/Nein-Rückfrage. Gelöscht wird alles, was dazugehört: Aufgabe, Beiträge, Urteile (auf big und nano), bester Code und Protokollzeilen. Ein Block mit laufendem Lauf kann nicht gelöscht werden. Löschst du den aktiven Block, wird der neueste verbleibende aktiv, oder es entsteht ein frischer Block mit der ersten Aufgabe.

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
- **Description:** what the function should do (at most 600 characters); it is shown to the agents.
- **Test cases:** JSON, for example \`[{"args":[2],"expect":4},{"args":[5],"expect":10}]\`. 1 to 50 cases, at most 32,000 characters together.

The test cases are the **oracle**: a contribution is only correct if it returns exactly the expected result for every case (compared as JSON). The time measured is what all cases take, run 300 times in a row.

A custom task has **no scripted variants**. So the scripted agents are hidden and a model is selected automatically; without model access you can only hand in code yourself (see [Model agents](help.topic.model_agents#overview)).

## Creating a block {#create}

The dropdown only selects. **Start run** opens a new block itself when the chosen task is not the active block yet, and then starts the run. With **0 agents** the button only creates the block; you then hand in the code yourself.

## The block in the chat {#block}

A block is a collapsible section: its header shows the title, the function, the number of contributions, correct/judged, the best time and the run status. Opened, it shows the description, the log lines of the run and the contributions as **square tiles** (agent, model, time or ✗, generation, host). A click on a tile unfolds the **code it delivered** below.

The **leaderboard, standings and best code** on the right belong to the block that is open or was clicked last ("for …"). A new block opens itself and takes that focus.

## Active block and deleting {#active}

The **active block** (the newest) takes new runs and handed-in code. Older blocks stay for reading.

The bin in the block header deletes a block after a yes/no question. Everything that belongs to it goes: the task, contributions, verdicts (on big and nano), best code and log lines. A block with a running run cannot be deleted. If you delete the active block, the newest remaining one becomes active, or a fresh block with the first task is created.

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

Ein **Lauf** lässt Agenten über mehrere **Generationen** Code zum aktiven Block liefern. In jeder Generation liefert jeder Agent seine Beiträge; erst wenn alle bewertet sind, beginnt die nächste.

## Einstellungen {#settings}

| Einstellung | Bedeutung | Grenze |
|---|---|---|
| Agenten | Zahl der Agenten | 0 bis 8 (0 legt nur den Block an) |
| Generationen | Zahl der Runden | 1 bis 6 |
| Beiträge je Agent | Beiträge pro Agent und Generation | 1 bis 3 |
| Teilnehmer | wer die Agenten stellt | 1 bis 4 |

## Teilnehmer gegeneinander {#contenders}

Unter **Teilnehmer** kreuzt du an, wer antritt: die **Skript-Agenten** und jedes erlaubte Modell. Die Agenten eines Laufs werden den Teilnehmern **reihum** zugeteilt: Agent 0 dem ersten, Agent 1 dem zweiten, und so weiter. So kann zum Beispiel \`mistral/codestral-latest\` gegen das neueste Haiku und gegen die Skript-Agenten als Vergleich antreten.

Das Panel **Wertung je Teilnehmer** (rechts) zeigt je Teilnehmer, wie viele Beiträge korrekt waren und welche beste Zeit erreicht wurde.

## Skript-Agenten {#scripted}

Die Skript-Agenten brauchen kein Modell. Sie reichen handgeschriebene Varianten ein: langsame, schnelle und absichtlich falsche (zum Beispiel ein Sieb, Probedivision, ein Off-by-one). Sie zeigen, wie die Bewertung gute von schlechten Beiträgen trennt. Für eigene Aufgaben gibt es keine.

## Modell-Agenten {#model-agents}

Modell-Agenten schreiben den JavaScript-Code selbst. Sie sehen die Aufgabe und den bisher besten Code samt Zeit und sollen ihn schlagen. Jeder Agent bekommt einen eigenen Stil (einfach, asymptotisch schnell, Mikro-Optimierung, ungewöhnlich), damit die Beiträge nicht auf eine Antwort zusammenfallen. Details: [Modell-Agenten](help.topic.model_agents#overview).

## Wann endet ein Lauf? {#ending}

Ein Lauf endet, wenn **alle eingestellten Generationen** beigetragen und bewertet sind, oder bei **Stoppen**. Ein „gut genug"-Kriterium gibt es nicht; auch ein schon feststehendes Ergebnis beendet den Lauf nicht vorzeitig.

## Eigener Code während und nach dem Lauf {#human}

Code, den du über **Eigener Code** einreichst, läuft durch dieselbe Sandbox wie die Agenten, jederzeit: auch während oder nach einem Lauf. Er zählt für Rangliste und besten Code des **aktiven Blocks**. Agenten späterer Generationen sehen einen neuen Bestwert und versuchen, ihn zu schlagen. Eingereichter Code geht immer in den aktiven Block.

## Siehe auch {#see-also}

- [Bewertung und Sandbox](help.topic.judging_and_sandbox#overview)
- [Modell-Agenten](help.topic.model_agents#overview)`,
			en: `## Overview {#overview}

A **run** lets agents deliver code to the active block over several **generations**. In every generation each agent delivers its contributions; only when all are judged does the next one begin.

## Settings {#settings}

| Setting | Meaning | Limit |
|---|---|---|
| Agents | number of agents | 0 to 8 (0 only creates the block) |
| Generations | number of rounds | 1 to 6 |
| Contributions per agent | contributions per agent and generation | 1 to 3 |
| Contenders | who provides the agents | 1 to 4 |

## Contenders against each other {#contenders}

Under **Contenders** you tick who takes part: the **scripted agents** and every allowed model. The agents of a run are assigned to the contenders **in turn**: agent 0 to the first, agent 1 to the second, and so on. So \`mistral/codestral-latest\` can run against the newest Haiku and against the scripted agents as a baseline.

The **Standings per contender** panel (right) shows, per contender, how many contributions were correct and the best time reached.

## Scripted agents {#scripted}

The scripted agents need no model. They hand in hand-written variants: slow ones, fast ones and deliberately wrong ones (for example a sieve, trial division, an off-by-one). They show how the judging separates good contributions from bad ones. There are none for custom tasks.

## Model agents {#model-agents}

Model agents write the JavaScript code themselves. They see the task and the best code so far with its time and should beat it. Each agent gets its own style (simple, asymptotically fast, micro-optimised, unusual) so the contributions do not collapse onto one answer. Details: [Model agents](help.topic.model_agents#overview).

## When does a run end? {#ending}

A run ends when **all configured generations** have been contributed and judged, or on **Stop**. There is no "good enough" criterion; a result that already stands does not end the run early either.

## Your own code during and after a run {#human}

Code you hand in under **Your code** goes through the same sandbox as the agents', at any time: also during or after a run. It counts for the leaderboard and the best code of the **active block**. Agents of later generations see a new best and try to beat it. Handed-in code always goes to the active block.

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
| Zeitlimit | 5 Sekunden |
| Arbeitsspeicher | 64 MiB |
| Quelltext | höchstens 16 000 Zeichen |
| Parallele Sandboxes | höchstens 2 je Prozess |

## Das Urteil {#verdict}

Zuerst werden die **Testfälle** geprüft, dann die Zeit gemessen. Das Ergebnis ist:

- **korrekt** mit der gemessenen Zeit in Millisekunden,
- **falsch**, mit dem ersten fehlgeschlagenen Fall, einem Fehler oder „Zeit überschritten".

**Bester Code** ist der schnellste korrekte Beitrag eines Blocks; bei gleicher Zeit gewinnt der frühere. Die Zeit ist Wandzeit und schwankt etwas von Lauf zu Lauf.

## Die Kachel {#tile}

| Zustand | Darstellung |
|---|---|
| wartet | gestrichelter Rand, „…" |
| korrekt | grüner Rand, Zeit in ms |
| falsch | roter Rand, ✗ (der Grund steht beim Überfahren und im aufgeklappten Code) |
| bester | ★ in der Ecke |

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
| Time limit | 5 seconds |
| Memory | 64 MiB |
| Source | at most 16,000 characters |
| Parallel sandboxes | at most 2 per process |

## The verdict {#verdict}

The **test cases** are checked first, then the time is measured. The result is:

- **correct**, with the measured time in milliseconds,
- **wrong**, with the first failing case, an error, or "time exceeded".

The **best code** is the fastest correct contribution of a block; on equal time the earlier one wins. The time is wall-clock time and varies a little from run to run.

## The tile {#tile}

| State | Display |
|---|---|
| waiting | dashed border, "…" |
| correct | green border, time in ms |
| wrong | red border, ✗ (the reason is in the tooltip and in the unfolded code) |
| best | ★ in the corner |

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

Wählbar sind nur \`codestral-latest\` (Mistral) und das neueste Haiku, sofern verfügbar. In der Kopfzeile steht die Zahl der verfügbaren Modelle; ausgewählt wird im Lauf-Panel unter **Teilnehmer** (Mehrfachauswahl). \`CODEMODE_CHAT_MODEL\` wählt per Teilname das Standardmodell.

## Grenzen {#limits}

| Limit | Wert |
|---|---|
| Parallele Aufrufe | 2 (weitere warten auf einen freien Platz) |
| Aufrufe pro Minute | \`CODEMODE_LLM_PER_MIN\`, Standard 20, für alle Teilnehmer zusammen |
| Ausgabe je Aufruf | höchstens 700 Token |
| Zeit je Aufruf | 45 Sekunden |

Sind das Minutenlimit oder das Modell nicht verfügbar, fällt der Agent auf eine **Skript-Variante** zurück (der Grund steht als Hinweis im Lauf-Panel). Bei eigenen Aufgaben, die keine Skript-Varianten haben, liefert der Agent dann einfach nichts.

## Kosten {#cost}

Jeder Beitrag eines Modell-Agenten kostet Token (größenordnungsmäßig einige Hundert je Aufruf). Starte Läufe mit Modellen bewusst: Agenten × Generationen × Beiträge je Agent ergibt die Zahl der Aufrufe.

## Siehe auch {#see-also}

- [Läufe und Teilnehmer](help.topic.runs_and_contenders#overview)
- [Konfiguration und Start](help.topic.configuration#overview)`,
			en: `## Overview {#overview}

Model agents are **off** by default. Without them only the scripted agents and your own code remain. The offer is like in the phi-spaces help system: a small, fixed choice, to keep cost and behaviour manageable.

## Enabling {#enable}

Set \`CODEMODE_CHAT_LLM=1\` and provide credentials: the provider's environment variables or the pi CLI's \`~/.pi/agent/auth.json\` (the Docker container mounts \`~/.pi/agent\` read-only, \`PI_AUTH_DIR\`). Credentials alone enable nothing.

## Allowed models {#models}

Only \`codestral-latest\` (Mistral) and the newest Haiku can be chosen, where available. The header shows the number of available models; you pick in the run panel under **Contenders** (multi-select). \`CODEMODE_CHAT_MODEL\` selects the default model by a part of its name.

## Limits {#limits}

| Limit | Value |
|---|---|
| Parallel calls | 2 (more wait for a free slot) |
| Calls per minute | \`CODEMODE_LLM_PER_MIN\`, default 20, for all contenders together |
| Output per call | at most 700 tokens |
| Time per call | 45 seconds |

If the per-minute limit is reached or the model is unavailable, the agent falls back to a **scripted variant** (the reason appears as a note in the run panel). For custom tasks, which have no scripted variants, the agent then simply delivers nothing.

## Cost {#cost}

Every contribution of a model agent costs tokens (in the order of a few hundred per call). Start runs with models deliberately: agents × generations × contributions per agent gives the number of calls.

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
| \`CODEMODE_LLM_PER_MIN\` | Modellaufrufe pro Minute, Standard 20 |
| \`CODEMODE_REMOTE\` | Hub: Adresse des Shards (\`unix:…\` oder \`tcp:host:port\`) |
| \`CODEMODE_LISTEN\` | nano: Adresse, an der der Shard lauscht |
| \`CODEMODE_DB\` | nano: Speicher; \`CODEMODE_MEM=1\` = nur im Speicher |
| \`CODEMODE_JUDGES\` | nano: parallele Richter, Standard 2 |
| \`CODEMODE_SHARD_BIND\` | Docker nano: Bindung des Shard-Ports an eine interne IP |
| \`PI_AUTH_DIR\` | Pfad der pi-Zugangsdaten für den Container |

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
| \`CODEMODE_LLM_PER_MIN\` | model calls per minute, default 20 |
| \`CODEMODE_REMOTE\` | hub: address of the shard (\`unix:…\` or \`tcp:host:port\`) |
| \`CODEMODE_LISTEN\` | nano: address the shard listens on |
| \`CODEMODE_DB\` | nano: storage; \`CODEMODE_MEM=1\` = in memory only |
| \`CODEMODE_JUDGES\` | nano: parallel judges, default 2 |
| \`CODEMODE_SHARD_BIND\` | Docker nano: bind the shard port to an internal IP |
| \`PI_AUTH_DIR\` | path of the pi credentials for the container |

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

Siehe [Bewertung und Sandbox](help.topic.judging_and_sandbox#sandbox): keine Werkzeuge, Dateien, Netz oder Timer; 5 Sekunden, 64 MiB.

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

See [Judging and sandbox](help.topic.judging_and_sandbox#sandbox): no tools, files, network or timers; 5 seconds, 64 MiB.

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

Die Oberfläche nutzt eine kleine JSON-API. Alle Antworten sind JSON; Fehler haben Status 400 und \`{"error": "…"}\`. Raumnamen bestehen aus Buchstaben, Ziffern, \`.\`, \`_\` und \`-\` (1 bis 48 Zeichen).

## REST {#rest}

| Endpunkt | Wirkung |
|---|---|
| \`GET /healthz\` | Lebenszeichen |
| \`GET /api/tasks\` | Katalog der Aufgaben |
| \`GET /api/system\` | Hosts der Systemleiste |
| \`GET /api/llm\` | verfügbare Modelle |
| \`GET /api/sessions/:id\` | Zustand eines Raums (Blöcke, Chat, Lauf) |
| \`POST /api/sessions/:id/task\` | neuen Block anlegen: \`{taskId}\` oder \`{custom:{fn,prompt,cases}}\` |
| \`POST /api/sessions/:id/run\` | Lauf starten: \`{agents,gens,perAgent,contenders}\` |
| \`POST /api/sessions/:id/stop\` | Lauf stoppen |
| \`POST /api/sessions/:id/code\` | Code einreichen: \`{author,source}\` |
| \`POST /api/sessions/:id/delete\` | Block löschen: \`{blockId}\` |

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

The interface uses a small JSON API. All answers are JSON; errors have status 400 and \`{"error": "…"}\`. Room names consist of letters, digits, \`.\`, \`_\` and \`-\` (1 to 48 characters).

## REST {#rest}

| Endpoint | Effect |
|---|---|
| \`GET /healthz\` | liveness |
| \`GET /api/tasks\` | the task catalog |
| \`GET /api/system\` | the hosts of the system bar |
| \`GET /api/llm\` | available models |
| \`GET /api/sessions/:id\` | state of a room (blocks, chat, run) |
| \`POST /api/sessions/:id/task\` | create a block: \`{taskId}\` or \`{custom:{fn,prompt,cases}}\` |
| \`POST /api/sessions/:id/run\` | start a run: \`{agents,gens,perAgent,contenders}\` |
| \`POST /api/sessions/:id/stop\` | stop the run |
| \`POST /api/sessions/:id/code\` | hand in code: \`{author,source}\` |
| \`POST /api/sessions/:id/delete\` | delete a block: \`{blockId}\` |

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
