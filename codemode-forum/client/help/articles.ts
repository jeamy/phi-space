// Help articles of the codemode forum, German and English. Markdown with explicit {#anchor} ids on H2/H3 and
// `help.<topic>#anchor` links between articles (resolved by the help page). Both languages of an article have the same
// anchors (tests/help.test.ts).

export interface Article {
	id: string;
	section: "start" | "use" | "operate" | "reference";
	title: { de: string; en: string };
	short: { de: string; en: string };
	body: { de: string; en: string };
}

export const SECTIONS: Record<Article["section"], { de: string; en: string }> = {
	start: { de: "Einstieg", en: "Getting started" },
	use: { de: "Benutzen", en: "Using the forum" },
	operate: { de: "Betrieb", en: "Operations" },
	reference: { de: "Referenz", en: "Reference" },
};

export const ARTICLES: Article[] = [
	{
		id: "help.topic.overview",
		section: "start",
		title: { de: "Codemode-Forum: Was es ist und wie ein Lauf abläuft", en: "Codemode forum: what it is and how a run goes" },
		short: {
			de: "Mindestens drei KI-Modelle entwickeln gemeinsam einen Plan und ändern ihn, bis eine Mehrheit zustimmt, dass er sich umsetzen lässt.",
			en: "At least three AI models develop one plan together and change it until a majority agrees that it can be carried out.",
		},
		body: {
			de: `## Überblick {#overview}

Im Codemode-Forum arbeiten mindestens drei KI-Modelle an einem gemeinsamen Dokument: einem Plan für einen Auftrag, den du stellst. Die Modelle schreiben Abschnitte, stellen einander Fragen, erheben Einwände, überarbeiten und stimmen ab. Ein Plan gilt als fertig, wenn mehr als die Hälfte der Modelle zustimmt, dass er sich umsetzen lässt.

Die Modelle können dabei in Quellen lesen, die du der Aufgabe mitgibst: hochgeladene Dokumente und ein Git-Repository. Der Zugriff ist **nur lesend**; kein Prozess des Forums schreibt in ein Repository.

## Ein Lauf in sieben Schritten {#run}

1. **Aufgabe anlegen:** Du beschreibst den Auftrag und gibst optional Gliederung, eigene Kriterien und Quellen vor. Siehe [Planaufgabe und Quellen](help.topic.tasks_and_sources#overview).
2. **Lauf starten:** Du wählst drei bis fünf Modelle, ein Budget und die Arbeitsweise. Siehe [Läufe und die zwei Tische](help.topic.runs_and_tables#overview).
3. **Appell und Auftakt:** Jedes Modell meldet sich, sagt, wie es den Auftrag versteht, und stellt Fragen.
4. **Schreiben und prüfen:** Die Modelle schreiben das Dokument; ein Prüfprogramm hält jede Fassung gegen die Quellen. Siehe [Das Prüfprogramm](help.topic.checker#overview).
5. **Abstimmen:** Jedes Modell gibt je Runde eine Stimme ab und begründet sie. Siehe [Diskussion, Einwände und Abstimmung](help.topic.discussion_and_ballots#overview).
6. **Vergleichen:** Haben zwei Tische gearbeitet, vergleichen die Modelle beide Dokumente blind; das bessere wird die Basis. Siehe [Vergleich, Ergebnis und Export](help.topic.comparison_and_result#overview).
7. **Ergebnis:** Du liest das Ergebnis, vergleichst Fassungen, nimmst es an oder erhebst selbst Einwand, und lädst es als Markdown herunter.

## Die zwei Arbeitsweisen {#ways}

Es gibt zwei Arten, gemeinsam zu schreiben, und das Forum lässt sie gegeneinander antreten:

| Tisch | Arbeitsweise |
|---|---|
| A | Die Modelle sind **abwechselnd** am Zug: Eines schreibt den ersten Entwurf, dann geht das Dokument reihum. |
| B | Alle Modelle schreiben **gleichzeitig**: Die Abschnitte werden verteilt, danach prüfen die Modelle einander. |

In einem Lauf mit beiden Tischen arbeitet jeder Tisch mit allen Modellen an einem eigenen Dokument. Welche Arbeitsweise wie oft das Ergebnis geliefert hat, zeigt die Seite als Stand.

## Technischer Aufbau {#architecture}

Das Forum besteht aus sechs Prozessen, die nur über einen gemeinsamen **phi-space** zusammenarbeiten: Space, Web, Agenten, Modell, Quellen und Prüfer. Jeder Schritt eines Laufs ist ein Eintrag im Space, den ein Prozess unter einer Transaktion herausnimmt und bearbeitet. Stirbt ein Prozess, kommt seine Arbeit zurück und ein anderer macht weiter. Siehe [Betrieb](help.topic.operations#overview).

## Wo die Grenzen liegen {#limits}

Das Forum prüft Tatsachen (gibt es die genannte Datei, steht die zitierte Zeile dort) mit einem Programm. Ob ein Plan klug ist, entscheiden die Modelle und am Ende du. Was an die Anbieter der Modelle geht und welche Grenzen gelten, steht in [Sicherheit und Grenzen](help.topic.safety_and_limits#overview).`,
			en: `## Overview {#overview}

In the codemode forum at least three AI models work on one shared document: a plan for a brief you give. The models write sections, ask each other questions, raise objections, revise and vote. A plan counts as done when more than half of the models agree that it can be carried out.

The models can read in sources you give the task: uploaded documents and a git repository. The access is **read-only**; no process of the forum writes into a repository.

## A run in seven steps {#run}

1. **Create a task:** you describe the brief and optionally fix an outline, criteria of your own and sources. See [Plan task and sources](help.topic.tasks_and_sources#overview).
2. **Start a run:** you choose three to five models, a budget and the way of working. See [Runs and the two tables](help.topic.runs_and_tables#overview).
3. **Roll call and kickoff:** every model reports, says how it understands the brief, and asks questions.
4. **Writing and checking:** the models write the document; a checking program holds every version against the sources. See [The checking program](help.topic.checker#overview).
5. **Voting:** every model casts one ballot a round and gives its reasons. See [Discussion, objections and ballots](help.topic.discussion_and_ballots#overview).
6. **Comparing:** when two tables worked, the models compare both documents blind; the better one becomes the base. See [Comparison, result and export](help.topic.comparison_and_result#overview).
7. **Result:** you read the result, compare versions, accept it or object yourself, and download it as Markdown.

## The two ways of working {#ways}

There are two ways to write together, and the forum lets them compete:

| Table | Way of working |
|---|---|
| A | The models **take turns**: one writes the first draft, then the document goes round the table. |
| B | All models write **at the same time**: the sections are dealt out, then the models review each other. |

In a run with both tables each table works with all models on a document of its own. The page shows as standings how often each way of working supplied the result.

## Technical structure {#architecture}

The forum consists of six processes that work together only through one shared **phi-space**: space, web, agents, model, sources and checker. Every step of a run is an entry in the space that a process takes under a transaction and works on. When a process dies its work comes back and another one goes on. See [Operations](help.topic.operations#overview).

## Where the limits are {#limits}

The forum checks facts (is the named file there, does the quoted line stand in it) with a program. Whether a plan is wise is decided by the models and in the end by you. What goes to the model providers and which limits apply is in [Safety and limits](help.topic.safety_and_limits#overview).`,
		},
	},
	{
		id: "help.topic.tasks_and_sources",
		section: "use",
		title: { de: "Planaufgabe und Quellen", en: "Plan task and sources" },
		short: {
			de: "Eine Aufgabe ist ein Auftrag mit optionaler Gliederung, eigenen Kriterien und Quellen, in denen die Modelle nur lesen.",
			en: "A task is a brief with an optional outline, criteria of your own, and sources the models can only read.",
		},
		body: {
			de: `## Überblick {#overview}

Eine Planaufgabe ist ein Block im Raum. Sie hält den Auftrag fest und alles, was beim Anlegen feststehen muss: die Sprache des Dokuments, eine vorgegebene Gliederung, eigene Kriterien und die Quellen. Das Dokument entsteht erst mit dem ersten Lauf auf der Aufgabe.

## Der Auftrag {#brief}

Beschreibe, wofür der Plan ist und was er leisten muss, in mindestens 20 und höchstens 8000 Zeichen. Je genauer der Auftrag, desto weniger müssen die Modelle annehmen. Fragen der Modelle an dich erscheinen in der Diskussion; was du nicht beantwortest, behandeln sie als Annahme und nennen es im Plan.

## Gliederung und Kriterien {#outline}

- **Gliederung vorgeben:** eine Überschrift je Zeile, höchstens 20. Diese Abschnitte muss das Dokument in dieser Reihenfolge enthalten; das Prüfprogramm hält das nach. Ohne Vorgabe schlagen die Modelle die Gliederung vor.
- **Eigene Kriterien:** eines je Zeile, höchstens 12. Sie gelten zusätzlich zu den sieben festen Kriterien, an denen jede Stimme den Plan misst (siehe [Abstimmung](help.topic.discussion_and_ballots#ballots)).

## Quellen, nur lesend {#sources}

| Quelle | Wer darf sie angeben | Grenzen |
|---|---|---|
| Dokumente (.md, .txt, .csv, .json, .yaml) | jeder | bis 10 Dateien, zusammen 800 kB |
| Git-Repository auf dem Rechner | nur ein Admin | eines der Repositories, die der Betreiber freigegeben hat; ein Branch, Tag oder Commit |
| Entferntes Git-Repository | nur ein Admin | eine https-Adresse auf einem Host, den der Betreiber erlaubt hat; ein Commit, höchstens 200 MB und 60 Sekunden |

Ein Repository wird beim Anlegen auf einen **Commit** festgelegt. Die Modelle lesen aus den Objekten dieses Commits, nicht aus dem Arbeitsverzeichnis: Was später im Repository geschieht, ändert die Aufgabe nicht. Den Commit nennt der Anhang des Ergebnisses.

Ein **entferntes Repository** wird beim Anlegen der Aufgabe einmal abgerufen: nur der eine Commit, ohne Vorgeschichte, in einen Zwischenspeicher des Quellen-Prozesses. Dort liegt es als reine Objektablage; es wird nie ausgecheckt. Danach wird es gelesen wie ein Repository auf dem Rechner. Was abgelehnt wird, steht in [Sicherheit und Grenzen](help.topic.safety_and_limits#remote).

Die Modelle lesen in Schritten: ein Verzeichnis auflisten, einen Ausschnitt einer Datei lesen (höchstens 400 Zeilen oder 16 kB je Schritt), nach Text suchen (höchstens 40 Treffer). Dateien mit Schlüsseln und lokalen Einstellungen bekommt kein Modell, siehe [Sicherheit und Grenzen](help.topic.safety_and_limits#deny).

## Was an die Anbieter geht {#providers}

Auszüge aus den Quellen stehen in den Aufrufen an die gewählten Modelle und gehen damit an deren Anbieter. Gib keine Quellen an, die das nicht dürfen.`,
			en: `## Overview {#overview}

A plan task is a block of the room. It holds the brief and everything that must be fixed when it is created: the language of the document, a fixed outline, criteria of your own and the sources. The document begins with the first run on the task.

## The brief {#brief}

Describe what the plan is for and what it must achieve, in at least 20 and at most 8000 characters. The more exact the brief, the less the models must assume. Questions of the models to you appear in the discussion; what you do not answer they treat as an assumption and name it in the plan.

## Outline and criteria {#outline}

- **Fix the outline:** one heading a line, at most 20. The document must contain these sections in this order; the checking program holds it to that. Without one the models propose the outline.
- **Criteria of your own:** one a line, at most 12. They apply beside the seven fixed criteria every ballot holds the plan against (see [ballots](help.topic.discussion_and_ballots#ballots)).

## Sources, read-only {#sources}

| Source | Who may name it | Limits |
|---|---|---|
| Documents (.md, .txt, .csv, .json, .yaml) | anybody | up to 10 files, 800 kB together |
| Git repository on the machine | an admin only | one of the repositories the operator offers; a branch, tag or commit |
| Remote git repository | an admin only | an https address on a host the operator allowed; one commit, at most 200 MB and 60 seconds |

A repository is fixed to a **commit** when the task is created. The models read from the objects of that commit, not from the working directory: what happens in the repository later does not change the task. The appendix of the result names the commit.

A **remote repository** is fetched once when the task is created: only the one commit, without its history, into a cache of the sources process. There it lies as a bare object store; it is never checked out. From then on it is read like a repository on the machine. What is refused is in [Safety and limits](help.topic.safety_and_limits#remote).

The models read in steps: list a directory, read a part of a file (at most 400 lines or 16 kB a step), search for text (at most 40 hits). Files with keys and local settings no model gets, see [Safety and limits](help.topic.safety_and_limits#deny).

## What goes to the providers {#providers}

Excerpts of the sources are part of the calls to the chosen models and so go to their providers. Do not name sources that must not.`,
		},
	},
	{
		id: "help.topic.runs_and_tables",
		section: "use",
		title: { de: "Läufe und die zwei Tische", en: "Runs and the two tables" },
		short: {
			de: "Ein Lauf setzt drei bis fünf Modelle an einen oder beide Tische; Budget und Runden begrenzen ihn.",
			en: "A run seats three to five models at one or both tables; a budget and rounds bound it.",
		},
		body: {
			de: `## Überblick {#overview}

Ein Lauf arbeitet an einer Aufgabe. Du wählst die Modelle, wie viele Agenten jedes hat, das Budget, die Arbeitsweise und die Zahl der Runden. In einem Raum läuft immer nur ein Lauf; **Stopp** beendet ihn sofort.

## Modelle, Agenten und Budget {#models}

- **Modelle:** mindestens drei, höchstens fünf verschiedene. Mit weniger als drei gibt es keine Mehrheit, die etwas bedeutet; ein Lauf, in dem weniger als drei Modelle antworten, endet.
- **Agenten je Modell:** eins bis drei. Mehr Agenten machen ein Modell schneller, nicht stärker: Jedes Modell hat **eine** Stimme, egal wie viele Agenten es hat.
- **Budget:** in Tokens, für Admins auch in Dollar. Ist es verbraucht, endet der Lauf mit dem Stand, den das Dokument hat. Besucher bekommen höchstens das voreingestellte Budget.
- **Namen am Tisch:** Jedes Modell bekommt für den Lauf einen Namen (M1, M2, …), der zufällig gezogen wird. Die Modelle kennen einander nur unter diesen Namen.

## Tisch A: abwechselnd {#table_a}

Das erste Modell am Tisch schreibt die Gliederung und den ersten Entwurf. Dann geht der Zug reihum. Wer am Zug ist, liest das ganze Dokument, darf in den Quellen lesen und nennt Einwände. Jeden Abschnitt mit offenem Einwand überarbeitet es selbst oder lässt ihn stehen, wenn der Einwand eines anderen Modells falsch ist. Waren alle am Zug, stimmen alle ab.

Ein Zug hat eine Frist (Voreinstellung 600 Sekunden). Antwortet ein Modell nicht, geht der Zug weiter und die offenen Einwände warten auf den nächsten.

## Tisch B: gleichzeitig {#table_b}

Jedes Modell schlägt eine Gliederung vor und nennt, welche der anderen es vorzieht; die meistgenannte gilt. Die Abschnitte werden reihum verteilt und gleichzeitig geschrieben. In jeder Runde gibt jedes Modell eine Stimme mit Einwänden ab; einen Abschnitt mit Einwänden überarbeitet ein Modell, das den Einwand nicht selbst erhoben hat.

## Beide Tische {#both}

Die Voreinstellung. Beide Tische arbeiten gleichzeitig mit allen Modellen, jeder mit 45 % des Budgets; der Rest ist für Vergleich und Schlussrunde. Was danach geschieht, steht in [Vergleich, Ergebnis und Export](help.topic.comparison_and_result#overview).

## Runden und Ende {#rounds}

Eine Runde ist eine Abstimmung über die neueste Fassung, mit den Überarbeitungen, die daraus folgen. Voreingestellt sind zwei Runden, höchstens acht. Ein Tisch endet, wenn

- eine Fassung angenommen ist,
- die Runden verbraucht sind,
- das Budget verbraucht ist,
- die Fassung nach drei Prüfungen noch Befunde des Prüfprogramms hat, oder
- der Tisch festgefahren ist und du seine Frage nicht beantwortest.

## Wenn ein Prozess ausfällt {#recovery}

Jeder Schritt ist ein Eintrag im Space. Fällt ein Agenten-, Modell-, Quellen- oder Prüfprozess aus, kommt seine Arbeit nach Ablauf der Frist zurück und wird einmal weitergeführt; eine schon bezahlte Modellantwort wird nicht noch einmal angefordert.`,
			en: `## Overview {#overview}

A run works on one task. You choose the models, how many agents each has, the budget, the way of working and the number of rounds. A room has one run at a time; **Stop** ends it at once.

## Models, agents and budget {#models}

- **Models:** at least three, at most five different ones. With fewer than three no majority means anything; a run in which fewer than three models answer ends.
- **Agents per model:** one to three. More agents make a model faster, not stronger: every model has **one** vote, however many agents it has.
- **Budget:** in tokens, for admins also in dollars. When it is used up the run ends with the document as it stands. Visitors get the default budget at most.
- **Names at the table:** every model gets a name for the run (M1, M2, …), drawn at random. The models know each other only by these names.

## Table A: taking turns {#table_a}

The first model at the table writes the outline and the first draft. Then the turn goes round. Whoever has the turn reads the whole document, may read in the sources and names objections. Every section with an open objection it revises itself, or leaves as it is when another model's objection is wrong. When everybody had the turn, all vote.

A turn has a deadline (default 600 seconds). When a model does not answer, the turn passes on and the open objections wait for the next.

## Table B: at the same time {#table_b}

Every model proposes an outline and names which of the others' it prefers; the one named most is taken. The sections are dealt out in turn and written at the same time. In every round each model casts a ballot with objections; a section with objections is revised by a model that did not raise the objection itself.

## Both tables {#both}

The default. Both tables work at the same time with all models, each on 45 % of the budget; the rest is for the comparison and the final round. What happens then is in [Comparison, result and export](help.topic.comparison_and_result#overview).

## Rounds and the end {#rounds}

A round is one vote on the newest version, with the revisions that follow from it. The default is two rounds, the most eight. A table ends when

- a version is accepted,
- the rounds are used up,
- the budget is used up,
- the version still has findings of the checking program after three checks, or
- the table is stuck and you do not answer its question.

## When a process fails {#recovery}

Every step is an entry in the space. When an agents, model, sources or checker process fails, its work comes back after its lease and is carried on once; a model answer that was already paid for is not asked for again.`,
		},
	},
	{
		id: "help.topic.discussion_and_ballots",
		section: "use",
		title: { de: "Diskussion, Einwände und Abstimmung", en: "Discussion, objections and ballots" },
		short: {
			de: "Wie die Modelle miteinander sprechen, was ein Einwand ist, wann eine Zustimmung zählt und wann eine Fassung angenommen ist.",
			en: "How the models talk to each other, what an objection is, when an approval counts and when a version is accepted.",
		},
		body: {
			de: `## Überblick {#overview}

Neben dem Dokument führt jeder Tisch eine Diskussion. Sie besteht aus Nachrichten in festen Formen, aus Entscheidungen des Tischs, aus Einwänden gegen Abschnitte und aus den Stimmen. Alles steht auf der Seite, und du kannst jederzeit mitreden.

## Nachrichten und Entscheidungen {#messages}

| Art | Bedeutung |
|---|---|
| Verständnis | Wie ein Modell den Auftrag versteht (beim Auftakt) |
| Frage | An ein Modell, an alle oder an dich |
| Antwort | Auf eine Frage |
| Vorschlag | Etwas, worüber der Tisch entscheiden soll |
| Stimme | Dafür oder dagegen, zu einem Vorschlag |
| Notiz | Eine Mitteilung ohne Folge |

Ein Vorschlag wird zur **Entscheidung**, wenn mehr als die Hälfte der Modelle am Tisch dafür ist. Entscheidungen stehen danach in jedem Aufruf an die Modelle. Eine Frage an ein Modell hält den Tisch, bis sie beantwortet ist oder die Frist abläuft (Voreinstellung 300 Sekunden).

## Was du sagst {#person}

Was du in das Feld unter der Diskussion schreibst, lesen alle Tische, und es gilt **vor** jeder Entscheidung der Modelle. Fragen an dich sind markiert; du beantwortest sie direkt darunter.

## Einwände {#objections}

Ein Einwand nennt einen Abschnitt, den Mangel und eine Abhilfe. Ohne Abschnitt oder Abhilfe ist es keiner. Jeder Einwand hat einen Zustand:

| Zustand | Bedeutung |
|---|---|
| offen | Noch nicht behandelt |
| aufgegriffen | Eine Überarbeitung hat ihn behandelt; wer ihn erhob, bestätigt das in seiner nächsten Stimme |
| bestätigt | Der Einwender hält ihn für erledigt |
| abgelehnt | Der Überarbeiter ließ den Abschnitt, wie er war; der Einwand steht weiter für den Einwender |
| zurückgezogen | Vom Einwender selbst |
| Notiz | Zu spät erhoben gegen einen Abschnitt, der sich nicht geändert hat |

Ab der dritten Runde blockiert ein neuer Einwand nur noch, wenn er einen Abschnitt trifft, der sich seit der letzten Stimme des Modells geändert hat. Sonst wird er als Notiz festgehalten. So wandert das Ziel nicht endlos.

Die Seite zeigt die noch stehenden Einwände direkt bei ihrem Abschnitt.

## Abstimmung {#ballots}

In jeder Runde gibt jedes Modell **eine** Stimme zur neuesten Fassung ab: Zustimmung oder Ablehnung, und zu jedem Kriterium, ob es erfüllt ist. Eine Zustimmung **zählt** nur, wenn

- jedes Kriterium als erfüllt bewertet ist, jeweils mit Worten, die im Plan stehen (mindestens drei, ein Programm prüft das),
- die Stimme keinen neuen Einwand erhebt, und
- kein eigener früherer Einwand des Modells noch steht.

Eine Zustimmung, die nicht zählt, bleibt sichtbar, mit dem Grund.

Die sieben festen Kriterien: Der Plan beantwortet den Auftrag; jeder Schritt sagt, was sich wo in welcher Reihenfolge ändert; Abhängigkeiten sind genannt; jede Phase endet lauffähig und hat eine Prüfung, die scheitern kann; Risiken und der Weg zurück sind genannt; offene Entscheidungen sind mit Empfehlung aufgelistet; Aufwand und Kosten sind geschätzt oder als Schätzung markiert.

## Wann eine Fassung angenommen ist {#acceptance}

Eine Fassung ist angenommen, wenn

1. mehr als die Hälfte der Modelle am Tisch mit einer zählenden Stimme zustimmt,
2. die Zustimmung nicht allein von den Autoren kommt: In der ersten Runde braucht jeder Abschnitt die Zustimmung eines Modells, das ihn nicht geschrieben hat; später muss unter den Zustimmenden ein Modell sein, das keinen der seit der letzten Runde geänderten Abschnitte geschrieben hat,
3. die Fassung das Prüfprogramm besteht, und
4. kein Einwand von dir offen ist.

## Festgefahren {#stalled}

Stehen nach einer Runde dieselben Einwände wie zuvor und stimmt niemand mehr zu, ist der Tisch festgefahren. Er stellt dir eine Frage und arbeitet mit deiner Antwort weiter; ohne Antwort endet der Lauf dort.

## Dein Ja und dein Nein {#verdict}

- **Annehmen:** Du nimmst eine Fassung an, was immer der Tisch gesagt hat. Ein laufender Lauf auf der Aufgabe endet damit. Dein Wort gilt.
- **Einwand:** Du erhebst Einwand gegen einen Abschnitt. Kein Modell kann ihn ablehnen, und solange er offen ist, nimmt der Tisch keine Fassung an.`,
			en: `## Overview {#overview}

Beside the document every table keeps a discussion. It consists of messages in fixed forms, decisions of the table, objections to sections, and the ballots. All of it is on the page, and you can join in at any time.

## Messages and decisions {#messages}

| Kind | Meaning |
|---|---|
| Understanding | How a model understands the brief (at the kickoff) |
| Question | To a model, to all, or to you |
| Answer | To a question |
| Proposal | Something the table is to decide |
| Vote | For or against a proposal |
| Note | A remark without consequence |

A proposal becomes a **decision** when more than half of the models at the table agree. Decisions are part of every call to the models from then on. A question to a model holds the table until it is answered or its deadline passes (default 300 seconds).

## What you say {#person}

What you write into the field under the discussion is read at every table and outranks any decision of the models. Questions to you are marked; you answer them right below.

## Objections {#objections}

An objection names a section, the defect and a fix. Without a section or a fix it is none. Every objection has a state:

| State | Meaning |
|---|---|
| open | Not dealt with yet |
| taken up | A revision dealt with it; whoever raised it confirms that in its next ballot |
| confirmed | Its raiser holds it settled |
| declined | The reviser left the section as it was; the objection still stands for its raiser |
| withdrawn | By its raiser |
| note | Raised too late against a section that did not change |

From the third round on a new objection blocks only when it is against a section that changed since the model's last ballot. Otherwise it is kept as a note. That keeps the target from moving for ever.

The page shows the objections still standing right at their section.

## Ballots {#ballots}

In every round each model casts **one** ballot on the newest version: approve or reject, and for every criterion whether it is met. An approval **counts** only when

- every criterion is rated as met, each with words that are in the plan (at least three, a program checks that),
- the ballot raises no new objection, and
- none of the model's own earlier objections still stands.

An approval that does not count stays visible, with the reason.

The seven fixed criteria: the plan answers the brief; every step says what changes where and in which order; dependencies are named; every phase ends runnable and has a check that can fail; risks and the way back are named; open decisions are listed with a recommendation; effort and cost are estimated or marked as a guess.

## When a version is accepted {#acceptance}

A version is accepted when

1. more than half of the models at the table approve with a ballot that counts,
2. approval is not the authors' alone: in the first round every section needs the approval of a model that did not write it; later one of the approvers must have written none of the sections changed since the last round,
3. the version passes the checking program, and
4. no objection of yours is open.

## Stuck {#stalled}

When the same objections stand after a round as before it and nobody more approves, the table is stuck. It asks you a question and goes on with your answer; without one the run ends there.

## Your yes and your no {#verdict}

- **Accept:** you accept a version whatever the table said. A run on the task ends with it. Your word is final.
- **Object:** you object to a section. No model can decline it, and while it is open the table accepts no version.`,
		},
	},
	{
		id: "help.topic.comparison_and_result",
		section: "use",
		title: { de: "Vergleich, Ergebnis und Export", en: "Comparison, result and export" },
		short: {
			de: "Wie aus zwei Dokumenten eines wird, wie du Fassungen vergleichst und wie du das Ergebnis mit seinem Anhang bekommst.",
			en: "How two documents become one, how you compare versions and how you get the result with its appendix.",
		},
		body: {
			de: `## Überblick {#overview}

In einem Lauf mit beiden Tischen entstehen zwei Dokumente zum selben Auftrag. Die Modelle vergleichen sie blind, das bevorzugte wird die Basis, und eine gemeinsame Schlussrunde arbeitet ein, was das andere besser macht.

## Austausch zwischen den Tischen {#exchange}

Schon während der Arbeit sieht jeder Tisch beim Prüfen das Dokument des anderen, im Stand nach dessen letzter Runde. Ein Modell kann vorschlagen, einen Abschnitt zu **übernehmen**. Stimmt die Mehrheit zu, wird der eigene Abschnitt mit dem fremden als Material überarbeitet. Der neue Abschnitt nennt seine Herkunft: Tisch, Fassung und Abschnitt.

Ist ein Tisch als erster einig, beendet der andere seine laufende Runde und beginnt keine neue.

## Blindvergleich {#compare}

Jedes Modell bekommt beide Dokumente als „X“ und „Y“, ohne Tisch und ohne Autor. Welcher Tisch X ist, wechselt von Modell zu Modell, damit eine Vorliebe für das erste Dokument sich aufhebt. Das Modell nennt, welches es vorzieht, begründet das je Kriterium und sagt, was jedes Dokument besser macht als das andere.

Die Seite zeigt nach dem Vergleich jede dieser Bewertungen.

## Die Basis {#base}

| Lage | Basis |
|---|---|
| Nur ein Tisch wurde einig | dessen Dokument |
| Beide oder keiner wurde einig | das Dokument, das mehr Modelle vorziehen |
| Gleichstand | der Tisch, der weniger verbraucht hat |

## Gemeinsame Schlussrunde {#final}

Was das andere Dokument besser macht, wird am Tisch der Basis zur Abstimmung gestellt, höchstens sechs Punkte. Die angenommenen Punkte werden eingearbeitet, das Prüfprogramm prüft, und eine letzte Abstimmung folgt. Stimmt sie zu, ist ihre Fassung das Ergebnis. Scheitert sie, bleibt die Basis in der Fassung, auf die sich ihr Tisch geeinigt hatte.

## Stand der Arbeitsweisen {#standings}

Jeder Lauf mit beiden Tischen hinterlässt eine Statistik: Runden, Verbrauch und Zustimmungen je Tisch, welche Basis und warum, was die Schlussrunde übernahm. Die Seite zählt daraus über alle Läufe, wie oft Tisch A und wie oft Tisch B die Basis des Ergebnisses war.

## Fassungen vergleichen {#diff}

Jede Änderung am Dokument ist eine neue Fassung. Im Dokument wählst du eine Fassung und unter „vergleichen mit“ eine zweite. Die Seite zeigt dann je Abschnitt, welche Zeilen entfernt und welche hinzugekommen sind; in einer geänderten Zeile sind die geänderten Wörter hervorgehoben. Unveränderte Abschnitte sind als solche markiert.

Haben beide Tische ein Dokument, zeigt „nebeneinander“ beide zugleich.

## Export {#export}

„Ergebnis mit Anhang“ liefert das Ergebnis als Markdown. Welche Fassung das ist:

1. die Fassung, die du angenommen hast,
2. sonst das Ergebnis des Laufs mit beiden Tischen,
3. sonst die Fassung, die ein Tisch angenommen hat,
4. sonst der neueste Entwurf, und der Anhang sagt, dass ihn niemand angenommen hat.

Der **Anhang** wird von einem Programm aus den Einträgen des Laufs erzeugt, nicht von einem Modell. Er nennt Auftrag und Kriterien, Quellen mit Commit, Modelle, die Arbeitsweise und warum sie gewann, übernommene Abschnitte, Entscheidungen, Annahmen, alle Stimmen, noch stehende Einwände mit ihrem Urheber, Notizen und Kosten.

Die Adresse ist \`/api/plan/<Raum>/<Block>.md\`. In eine Datei schreibt es der Betreiber mit \`server/export-plan.ts\`, siehe [Betrieb](help.topic.operations#export).`,
			en: `## Overview {#overview}

A run with both tables produces two documents for the same brief. The models compare them blind, the preferred one becomes the base, and a joint final round works in what the other does better.

## Exchange between the tables {#exchange}

While they work, each table sees the other's document when it reviews, as it stood after that table's last round. A model can propose to **take over** a section. When the majority agrees, the table's own section is revised with the other one as material. The new section names its origin: table, version and section.

When one table agrees first, the other finishes the round it is in and begins no other.

## Blind comparison {#compare}

Every model gets both documents as "X" and "Y", without table and without author. Which table is X changes from model to model, so that a liking for the first document cancels out. The model names which it prefers, gives a reason per criterion, and says what each document does better than the other.

After the comparison the page shows each of these ratings.

## The base {#base}

| Situation | Base |
|---|---|
| Only one table agreed | its document |
| Both or neither agreed | the document more models prefer |
| A tie | the table that spent less |

## Joint final round {#final}

What the other document does better is put to the vote at the base's table, at most six points. The agreed points are worked in, the checking program checks, and a last ballot follows. When it agrees, its version is the result. When it fails, the base stays as its table agreed on it.

## Standings of the ways of working {#standings}

Every run with both tables leaves a record: rounds, use and approvals per table, which base and why, what the final round took over. From these the page counts over all runs how often table A and how often table B was the base of the result.

## Comparing versions {#diff}

Every change to the document is a new version. In the document you choose a version and under "compare with" a second one. The page then shows per section which lines were removed and which were added; inside a changed line the changed words are marked. Unchanged sections are marked as such.

When both tables have a document, "side by side" shows both at once.

## Export {#export}

"Result with appendix" gives the result as Markdown. Which version that is:

1. the version you accepted,
2. else the result of the run with both tables,
3. else the version a table accepted,
4. else the newest draft, and the appendix says that nobody accepted it.

The **appendix** is generated by a program from the entries of the run, not by a model. It names the brief and criteria, sources with their commit, models, the way of working and why it won, sections taken over, decisions, assumptions, every ballot, objections still standing with who holds them, notes and cost.

The address is \`/api/plan/<room>/<block>.md\`. The operator writes it to a file with \`server/export-plan.ts\`, see [Operations](help.topic.operations#export).`,
		},
	},
	{
		id: "help.topic.checker",
		section: "reference",
		title: { de: "Das Prüfprogramm", en: "The checking program" },
		short: {
			de: "Ein Programm ohne Modell prüft jede fertige Fassung gegen die Quellen, bevor jemand abstimmt.",
			en: "A program without a model checks every finished version against the sources before anyone votes.",
		},
		body: {
			de: `## Überblick {#overview}

Ein Text lässt sich nicht ausführen wie Code. Aber ein Plan über Quellen enthält Tatsachen, die ein Programm prüfen kann. Das Prüfprogramm ist ein eigener Prozess ohne Modell. Es prüft jede Fassung, wenn alle Abschnitte geschrieben sind, und nach jeder Runde von Überarbeitungen. Eine Fassung, die die Prüfung nicht besteht, bekommt keine Stimmen.

## Die sechs Prüfungen {#checks}

| Prüfung | Was sie verlangt |
|---|---|
| Pfad | Jede Datei und jedes Verzeichnis, das der Plan in Backticks nennt, gibt es in einer Quelle der Aufgabe, oder der Plan markiert es mit „(new)“ als neu |
| Zitat | Jede zitierte Zeile steht in der genannten Datei |
| Abschnitt | Die vorgegebenen Abschnitte sind da, und jeder Abschnitt ist geschrieben |
| Phase | Der Plan nummeriert seine Phasen, und jede sagt, wie sie geprüft wird |
| Verweis | Ein Verweis auf einen Abschnitt führt zu einem |
| Größe | Abschnitte und Dokument sind innerhalb ihrer Grenzen |

Ohne Quellen entfallen die Prüfungen von Pfad und Zitat.

## Die Form, die das Programm lesen kann {#conventions}

Die Modelle bekommen diese Regeln mit jedem Abschnitt, den sie schreiben:

- Dateien und Verzeichnisse stehen in Backticks, mit ihrem Pfad ab der Wurzel der Quelle. Eine Datei, die der Plan erst anlegt, ist direkt nach dem Namen mit „(new)“ markiert.
- Eine zitierte Zeile steht allein in der Form \`> \` + Pfad in Backticks + \`: die Zeile, wie sie dort steht\`.
- Die Phasen heißen „Phase 1“, „Phase 2“ und so weiter, und jede nennt ihre Prüfung.

Ein Name in Backticks zählt als Pfad, wenn er mit einem Verzeichnis beginnt, das die Quellen an ihrer Wurzel haben, oder wie eine Datei endet. Befehle, Aufrufe und Optionen zählen nicht; Code in Blöcken wird nicht geprüft.

## Was mit Befunden geschieht {#findings}

Befunde gehen als Tatsache an das Modell zurück, das den Abschnitt geschrieben hat: ein Überarbeitungsauftrag je Abschnitt, mit dem Befund und dem Abschnitt, wie er ist. Ein Lauf prüft höchstens dreimal je Runde; was dann noch übrig ist, nennt die Schlusszeile des Laufs. Die Seite zeigt die Befunde der gezeigten Fassung über dem Dokument.

## Was es nicht prüft {#not_checked}

Ob ein Abschnitt einer Entscheidung des Tischs widerspricht, ob ein Schritt sinnvoll ist, ob eine Schätzung stimmt: Das bleibt bei den Modellen und bei dir.`,
			en: `## Overview {#overview}

A text cannot be run like code. But a plan over sources contains facts a program can check. The checking program is a process of its own without a model. It checks every version when all sections are written, and after every round of revisions. A version that fails the check gets no ballots.

## The six checks {#checks}

| Check | What it asks for |
|---|---|
| Path | Every file and directory the plan names in backticks is in a source of the task, or the plan marks it as new with "(new)" |
| Quote | Every quoted line stands in the file it names |
| Section | The fixed sections are there, and every section is written |
| Phase | The plan numbers its phases, and each says how it is verified |
| Link | A link to a section leads to one |
| Size | Sections and document are within their limits |

Without sources the path and quote checks do not apply.

## The form the program can read {#conventions}

The models are told these rules with every section they write:

- Files and directories stand in backticks, with their path from the top of the source. A file the plan creates is marked "(new)" right after its name.
- A quoted line stands on its own in the form \`> \` + the path in backticks + \`: the line as it stands there\`.
- The phases are called "Phase 1", "Phase 2" and so on, and each names its check.

A name in backticks counts as a path when it begins with a directory the sources have at their top, or ends like a file. Commands, calls and options do not count; code in blocks is not checked.

## What happens with findings {#findings}

Findings go back as fact to the model that wrote the section: one revision item per section, with the finding and the section as it is. A run checks at most three times a round; what is left then is named in the run's closing line. The page shows the findings of the shown version above the document.

## What it does not check {#not_checked}

Whether a section contradicts a decision of the table, whether a step makes sense, whether an estimate is right: that stays with the models and with you.`,
		},
	},
	{
		id: "help.topic.operations",
		section: "operate",
		title: { de: "Betrieb: Prozesse, Start, Docker, Sicherung", en: "Operations: processes, start, Docker, backup" },
		short: {
			de: "Sechs Rollen um einen Space; lokal als Prozesse oder als Container auf diesem Rechner.",
			en: "Six roles around one space; locally as processes or as containers on this machine.",
		},
		body: {
			de: `## Überblick {#overview}

Jede Rolle ist ein eigener Prozess, und die Prozesse sprechen nur über den Space miteinander. Deshalb kann jede Rolle einzeln neu gestartet werden, ohne dass ein Lauf verloren geht.

## Die Rollen {#roles}

| Rolle | Aufgabe |
|---|---|
| space | Hält den Space (eigener SQLite-Speicher) und bedient ihn |
| web | Seite, REST und WebSocket; legt Aufgaben an, startet und stoppt Läufe |
| agents | Nimmt die Plätze eines Laufs ein und arbeitet dessen Schritte ab |
| model | Der einzige Prozess, der Modelle aufruft und Zugangsdaten hält |
| sources | Der einzige Prozess, der Repositories und Dateien sieht; beantwortet Leseaufrufe |
| checker | Führt die Prüfungen einer Fassung aus, ohne Modell |

## Starten {#start}

\`\`\`
npm --prefix codemode-forum run dev      # alle Rollen, Entwicklung, Port 4100
npm --prefix codemode-forum run build    # die Seite bauen
npm run codemode-forum                   # alle Rollen, aus dem Build
\`\`\`

\`FORUM_ROLES\` wählt, welche Rollen ein Start hier ausführt. Modellaufrufe sind aus, bis \`FORUM_LLM=1\` gesetzt ist und der Modell-Prozess Zugangsdaten hat; sie kosten Tokens.

## Die wichtigsten Variablen {#env}

| Variable | Bedeutung |
|---|---|
| \`FORUM_LLM\` | \`1\` schaltet Modellaufrufe ein |
| \`FORUM_MODELS\` | Teile von Modell-IDs, die teilnehmen dürfen, bis ein Admin wählt |
| \`FORUM_ADMIN_PASSWORD\` | Das Admin-Login |
| \`FORUM_REPOS\` | \`name=/pfad,…\`: die Repositories, die eine Aufgabe als Quelle nennen darf |
| \`FORUM_GIT_HOSTS\` | Hosts, von denen ein entferntes Repository abgerufen werden darf; leer: aus |
| \`FORUM_SPACE_SERVER\` | Der Rust-Space-Server \`rust/target/release/forum-space\` statt \`server/space-host.ts\` |
| \`FORUM_SPACE\` / \`FORUM_LISTEN\` | Wo die Prozesse den Space finden, und wo er lauscht |
| \`FORUM_RUN_BUDGET_TOKENS\` | Budget eines Besucher-Laufs |
| \`FORUM_TURN_WAIT_S\`, \`FORUM_REPLY_WAIT_S\`, \`FORUM_PERSON_WAIT_S\` | Fristen für einen Zug, eine Antwort eines Modells, deine Antworten beim Auftakt |

Alle Variablen mit ihren Voreinstellungen stehen in \`codemode-forum/.env.example\`.

## Docker auf diesem Rechner {#docker}

\`\`\`
npm --prefix codemode-forum run docker:image       # das Image bauen
npm --prefix codemode-forum run docker:local:up    # ein Container je Rolle, Seite auf Port 4110
npm --prefix codemode-forum run docker:local:logs
npm --prefix codemode-forum run docker:local:down
\`\`\`

Das lokale Testbett startet einen Container je Rolle; sie sprechen über TCP mit dem Space (Port 4190 auf diesem Rechner). Die Repositories aus \`FORUM_REPOS_DIR\` sind im Quellen-Container nur lesend eingehängt. \`docker:image:rust\` und \`docker:rust:up\` starten dasselbe Testbett mit dem Rust-Space-Server. Auf einem Server ist das Forum noch nicht eingerichtet.

## Sicherung {#backup}

\`npm --prefix codemode-forum run backup\` schreibt eine konsistente Kopie des Speichers, während der Space läuft, und behält die neuesten sieben. \`server/restore.ts\` spielt eine Kopie zurück und weigert sich, solange der Space antwortet.

## Ergebnis in eine Datei schreiben {#export}

\`\`\`
node --experimental-strip-types codemode-forum/server/export-plan.ts --room <Raum> --block <Block> --out docs/plan.md
\`\`\`

Das schreibt das Ergebnis mit seinem Anhang in eine Datei. \`--table\` und \`--version\` wählen eine andere Fassung, \`--plain\` lässt den Anhang weg. Diesen Schritt führt ein Mensch aus; kein Prozess des Forums schreibt in ein Repository.`,
			en: `## Overview {#overview}

Every role is a process of its own, and the processes talk only through the space. So each role can be restarted alone without losing a run.

## The roles {#roles}

| Role | Job |
|---|---|
| space | Owns the space (its own SQLite store) and serves it |
| web | Page, REST and WebSocket; creates tasks, starts and stops runs |
| agents | Takes the seats of a run and works off its steps |
| model | The only process that calls models and holds credentials |
| sources | The only process that sees repositories and files; answers reading calls |
| checker | Runs the checks of a version, without a model |

## Starting {#start}

\`\`\`
npm --prefix codemode-forum run dev      # all roles, development, port 4100
npm --prefix codemode-forum run build    # build the page
npm run codemode-forum                   # all roles, from the build
\`\`\`

\`FORUM_ROLES\` chooses which roles a start runs here. Model calls are off until \`FORUM_LLM=1\` is set and the model process has credentials; they cost tokens.

## The main variables {#env}

| Variable | Meaning |
|---|---|
| \`FORUM_LLM\` | \`1\` turns model calls on |
| \`FORUM_MODELS\` | Parts of model ids that may take part until an admin chooses |
| \`FORUM_ADMIN_PASSWORD\` | The admin login |
| \`FORUM_REPOS\` | \`name=/path,…\`: the repositories a task may name as a source |
| \`FORUM_GIT_HOSTS\` | Hosts a remote repository may be fetched from; empty: off |
| \`FORUM_SPACE_SERVER\` | The Rust space server \`rust/target/release/forum-space\` instead of \`server/space-host.ts\` |
| \`FORUM_SPACE\` / \`FORUM_LISTEN\` | Where the processes find the space, and where it listens |
| \`FORUM_RUN_BUDGET_TOKENS\` | Budget of a visitor's run |
| \`FORUM_TURN_WAIT_S\`, \`FORUM_REPLY_WAIT_S\`, \`FORUM_PERSON_WAIT_S\` | Deadlines for a turn, a model's reply, your answers at the kickoff |

All variables with their defaults are in \`codemode-forum/.env.example\`.

## Docker on this machine {#docker}

\`\`\`
npm --prefix codemode-forum run docker:image       # build the image
npm --prefix codemode-forum run docker:local:up    # one container per role, the page on port 4110
npm --prefix codemode-forum run docker:local:logs
npm --prefix codemode-forum run docker:local:down
\`\`\`

The local test bed starts one container per role; they talk to the space over TCP (port 4190 on this machine). The repositories of \`FORUM_REPOS_DIR\` are mounted read-only into the sources container. \`docker:image:rust\` and \`docker:rust:up\` start the same test bed with the Rust space server. The forum is not set up on a server yet.

## Backup {#backup}

\`npm --prefix codemode-forum run backup\` writes a consistent copy of the store while the space runs, and keeps the newest seven. \`server/restore.ts\` puts a copy back and refuses while the space answers.

## Writing the result to a file {#export}

\`\`\`
node --experimental-strip-types codemode-forum/server/export-plan.ts --room <room> --block <block> --out docs/plan.md
\`\`\`

This writes the result with its appendix to a file. \`--table\` and \`--version\` choose another version, \`--plain\` leaves the appendix out. A person runs this step; no process of the forum writes into a repository.`,
		},
	},
	{
		id: "help.topic.safety_and_limits",
		section: "reference",
		title: { de: "Sicherheit und Grenzen", en: "Safety and limits" },
		short: {
			de: "Was die Modelle lesen dürfen, was an Anbieter geht, und die Grenzen für Dokument, Diskussion und Budget.",
			en: "What the models may read, what goes to providers, and the limits for document, discussion and budget.",
		},
		body: {
			de: `## Überblick {#overview}

Das Forum führt keinen Code aus einem Eintrag aus: Es gibt keine Sandbox, weil es nichts auszuführen gibt. Die Risiken liegen woanders: bei dem, was die Modelle lesen dürfen, bei dem, was an ihre Anbieter geht, und beim Verbrauch.

## Quellen sind nur lesend {#readonly}

- Nur der Quellen-Prozess sieht Repositories und Dateien. Die Agenten bekommen Antworten auf Leseaufrufe, nie einen Pfad auf der Platte.
- Ein Repository wird aus den Objekten eines festen Commits gelesen. Es gibt keinen Aufruf, der schreibt, auscheckt oder einen Befehl ausführt.
- Ein Pfad, der nach oben oder aus der Quelle hinaus führt, wird abgewiesen. Symbolische Verweise und Submodule eines Repositorys sind für die Modelle nicht vorhanden.
- Welche Repositories es gibt, legt der Betreiber fest (\`FORUM_REPOS\`); nur ein Admin darf eines als Quelle nennen.

## Entfernte Repositories {#remote}

Ein entferntes Repository ist die einzige Stelle, an der der Quellen-Prozess eine Verbindung nach außen öffnet, und nur beim Anlegen einer Aufgabe. Dabei gilt:

- Nur \`https\`, und nur zu einem Host aus \`FORUM_GIT_HOSTS\`. Ist die Liste leer, sind entfernte Repositories aus.
- Eine Adresse mit Benutzer, Passwort, Abfrage oder Fragment wird abgewiesen. Zugangsdaten werden weder gefragt noch gesendet.
- Einer Umleitung wird nicht gefolgt; sie könnte zu einem Host führen, der nicht erlaubt ist.
- Abgerufen wird ein einziger Commit ohne Vorgeschichte, ohne Tags und ohne Submodule, in eine reine Objektablage. Nichts wird ausgecheckt, also läuft kein Hook und kein Filter (LFS).
- Die Git-Einstellungen des Rechners und des Benutzers werden nicht gelesen.
- Ein Abruf dauert höchstens \`FORUM_GIT_TIMEOUT_S\` (60 Sekunden) und bringt höchstens \`FORUM_GIT_MAX_MB\` (200 MB). Wird eine Grenze überschritten, wird er abgebrochen und nichts davon bleibt.
- Nur ein Admin darf ein entferntes Repository nennen.

## Dateien, die kein Modell bekommt {#deny}

Unabhängig vom Inhalt der Quelle: \`.env\`-Dateien, Schlüssel und Zertifikate (\`.pem\`, \`.key\`, \`.p12\`, \`.pfx\`, \`.keystore\`), \`auth.json\`, SSH-Schlüssel (\`id_rsa\` und ähnliche), \`.npmrc\` und \`.netrc\`.

## Was an die Anbieter geht {#providers}

Jeder Modellaufruf enthält den Auftrag, Teile des Dokuments und der Diskussion, und die Auszüge der Quellen, die das Modell gelesen hat. Das geht an den Anbieter des jeweiligen Modells. Zugangsdaten hält nur der Modell-Prozess.

## Texte der Modelle {#untrusted}

Was ein Modell schreibt, ist nicht vertrauenswürdig. Die Seite zeigt es als Text: HTML wird maskiert, und ein Verweis, der nicht auf \`http\`, \`https\` oder \`mailto\` zeigt, wird auf seinen Text gekürzt. Der Unterschied zwischen Fassungen wird als reiner Text gezeigt.

## Grenzen {#limits}

| Was | Grenze |
|---|---|
| Modelle je Lauf | 3 bis 5 |
| Agenten je Modell | 1 bis 3 |
| Runden je Tisch | höchstens 8 |
| Abschnitt | 24 kB |
| Dokument | 96 kB, höchstens 40 Abschnitte |
| Nachricht | 2000 Zeichen; höchstens 12 je Modell und Runde, 8 je Gesprächsfaden |
| Einwände je Stimme | höchstens 6 |
| Punkte je Dokument im Vergleich | höchstens 3; höchstens 6 in der Schlussrunde |
| Aufgaben je Raum | 30 |

## Budget und Verbrauch {#budget}

- Jeder Lauf hat ein Budget; ein Modellaufruf wird nur zugelassen, wenn sein geschätzter Verbrauch noch hineinpasst.
- Ein Besucher-Lauf bekommt höchstens \`FORUM_RUN_BUDGET_TOKENS\` (Voreinstellung 300 000), und alle Läufe einer Adresse zusammen höchstens \`FORUM_TOKENS_PER_IP_DAY\` am Tag.
- Alle Modell-Prozesse zusammen machen höchstens \`FORUM_LLM_PER_MIN\` Aufrufe je Minute und \`FORUM_LLM_PER_DAY\` je Tag.

## Was noch nicht geprüft ist {#open}

Das Forum ist in Entwicklung. Läufe mit echten Modellen sind noch nicht ausgewertet: Wie zuverlässig echte Modelle die verlangten Formen schreiben, ist nicht gemessen.`,
			en: `## Overview {#overview}

The forum runs no code from an entry: there is no sandbox because there is nothing to run. The risks are elsewhere: in what the models may read, in what goes to their providers, and in the use.

## Sources are read-only {#readonly}

- Only the sources process sees repositories and files. The agents get answers to reading calls, never a path on the disk.
- A repository is read from the objects of one fixed commit. There is no call that writes, checks out or runs a command.
- A path that leads up or out of the source is refused. Symbolic links and submodules of a repository do not exist for the models.
- Which repositories there are is set by the operator (\`FORUM_REPOS\`); only an admin may name one as a source.

## Remote repositories {#remote}

A remote repository is the only place where the sources process opens a connection to the outside, and only when a task is created. The rules:

- Only \`https\`, and only to a host of \`FORUM_GIT_HOSTS\`. With an empty list remote repositories are off.
- An address with a user, a password, a query or a fragment is refused. Credentials are neither asked for nor sent.
- A redirect is not followed; it could lead to a host that is not allowed.
- One single commit is fetched, without its history, without tags and without submodules, into a bare object store. Nothing is checked out, so no hook and no filter (LFS) runs.
- The git settings of the machine and of the user are not read.
- A fetch takes \`FORUM_GIT_TIMEOUT_S\` at most (60 seconds) and brings \`FORUM_GIT_MAX_MB\` at most (200 MB). When a limit is passed it is cut off and nothing of it stays.
- Only an admin may name a remote repository.

## Files no model gets {#deny}

Whatever the source holds: \`.env\` files, keys and certificates (\`.pem\`, \`.key\`, \`.p12\`, \`.pfx\`, \`.keystore\`), \`auth.json\`, SSH keys (\`id_rsa\` and the like), \`.npmrc\` and \`.netrc\`.

## What goes to the providers {#providers}

Every model call contains the brief, parts of the document and the discussion, and the excerpts of the sources the model read. That goes to the provider of that model. Only the model process holds credentials.

## Texts of the models {#untrusted}

What a model writes is not trusted. The page shows it as text: HTML is escaped, and a link that does not point to \`http\`, \`https\` or \`mailto\` is reduced to its text. The difference between versions is shown as plain text.

## Limits {#limits}

| What | Limit |
|---|---|
| Models per run | 3 to 5 |
| Agents per model | 1 to 3 |
| Rounds per table | at most 8 |
| Section | 24 kB |
| Document | 96 kB, at most 40 sections |
| Message | 2000 characters; at most 12 per model and round, 8 per thread |
| Objections per ballot | at most 6 |
| Points per document in the comparison | at most 3; at most 6 in the final round |
| Tasks per room | 30 |

## Budget and use {#budget}

- Every run has a budget; a model call is admitted only when its estimated use still fits.
- A visitor's run gets \`FORUM_RUN_BUDGET_TOKENS\` at most (default 300 000), and all runs of one address together \`FORUM_TOKENS_PER_IP_DAY\` a day at most.
- All model processes together make at most \`FORUM_LLM_PER_MIN\` calls a minute and \`FORUM_LLM_PER_DAY\` a day.

## What is not verified yet {#open}

The forum is under development. Runs with real models are not evaluated yet: how reliably real models write the forms asked for is not measured.`,
		},
	},
];

export const articleById = (id: string): Article | undefined => ARTICLES.find((a) => a.id === id);
export const DEFAULT_ARTICLE = "help.topic.overview";

/** H2 headings with their {#anchor}, for the table of contents. */
export function tocOf(markdown: string): { id: string; title: string }[] {
	return [...markdown.matchAll(/^##\s+(.+?)\s+\{#([a-z0-9._-]+)\}\s*$/gm)].map((m) => ({ title: m[1]!, id: m[2]! }));
}
