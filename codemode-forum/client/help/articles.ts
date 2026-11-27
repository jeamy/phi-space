// Help articles of the codemode forum, German and English. Markdown with explicit {#anchor} ids on H2/H3 and
// `help.<topic>#anchor` links between articles (resolved by the help page). Both languages of an article have the same
// anchors (tests/help.test.ts).

export interface Article {
	id: string;
	section: "start" | "use" | "configure" | "operate" | "reference";
	/** Written for newcomers (docs/forum-seite-plan-2026-11-26.en.md, section 11): a word of "Words used here" is
	 *  linked to its entry where it first appears (tests/help.test.ts). */
	plain?: true;
	title: { de: string; en: string };
	short: { de: string; en: string };
	body: { de: string; en: string };
}

export const SECTIONS: Record<Article["section"], { de: string; en: string }> = {
	start: { de: "Einstieg", en: "Getting started" },
	use: { de: "Benutzen", en: "Using the forum" },
	configure: { de: "Einrichten", en: "Configure" },
	operate: { de: "Betrieb", en: "Operations" },
	reference: { de: "Referenz", en: "Reference" },
};

export const ARTICLES: Article[] = [
	{
		id: "help.topic.forum",
		section: "start",
		plain: true,
		title: { de: "Was ist FORUM?", en: "What is FORUM?" },
		short: {
			de: "Du und mehrere KI-Modelle arbeitet gemeinsam einen Plan aus. Die vier Orte der Seite und die drei Teile eines Raums.",
			en: "You and several AI models work out a plan together. The page's four places and the three parts of a room.",
		},
		body: {
			de: `## Überblick {#overview}

Nach dieser Seite weißt du, wofür FORUM da ist, welche vier Orte die Seite hat und aus welchen drei Teilen ein [Raum](help.topic.words#room) besteht.

In FORUM arbeiten du und mehrere KI-[Modelle](help.topic.words#model) gemeinsam einen Plan aus. Du schreibst den [Auftrag](help.topic.words#brief): wofür der Plan ist und was er leisten muss. Die Modelle besprechen ihn, schreiben den Plan, prüfen einander und stimmen ab. Du beantwortest ihre Fragen und entscheidest am Ende.

Wie du anfängst, steht in [Dein erster Plan in sechs Schritten](help.topic.first_plan#overview).

## Die vier Orte {#places}

| Ort | Was du dort tust |
|---|---|
| Räume | du siehst die Räume, in denen du bist, und was jeder gerade tut; du legst einen neuen an |
| Ein Raum | du arbeitest an einem Plan: Dateien, [Tisch](help.topic.words#table), Plan |
| Einstellungen | dein Name, das Aussehen der Seite, die Personen in deinen Räumen |
| Hilfe | diese Seiten; das „?“ neben einem Bedienelement öffnet einen kurzen Hinweis |

Steht bei einem Raum „wartet auf dich“, hat dich ein Modell etwas gefragt.

## Die drei Teile eines Raums {#panes}

- **Dateien:** das Material der gezeigten Aufgabe, also die Dokumente, die du ihr mitgegeben hast. Die Modelle lesen nur darin.
- **Tisch:** hier arbeiten die Modelle: die Aufgaben, die Läufe, ihre Diskussion und ihre Fragen an dich. Siehe [Der Tisch](help.topic.table#overview).
- **Plan:** das Dokument, das am Tisch entsteht, [Fassung](help.topic.words#version) für Fassung. Siehe [Der Plan](help.topic.plan#overview).

Auf einem breiten Bildschirm siehst du alle drei nebeneinander, auf einem Tablet zwei, auf einem Telefon einen nach dem anderen. Siehe [Auf dem Telefon](help.topic.phone#overview).

## Deine Einstellungen {#settings}

Sprache, hell oder dunkel und die Farben merkt sich dein Browser, für dieses Gerät. Deinen Namen und die Personen in deinen Räumen hält FORUM.

## Die Expertenansicht {#expert}

Die Seite, die FORUM vorher hatte, bleibt unter /expert erreichbar: mit dem Stand der beiden Arbeitsweisen und beiden Tischen nebeneinander. Sie ist in [Codemode-Forum: Was es ist und wie ein Lauf abläuft](help.topic.overview#overview) erklärt.`,
			en: `## Overview {#overview}

After this page you know what FORUM is for, which four places the page has and which three parts a [room](help.topic.words#room) has.

In FORUM you and several AI [models](help.topic.words#model) work out a plan together. You write the [brief](help.topic.words#brief): what the plan is for and what it must achieve. The models discuss it, write the plan, check each other and vote. You answer their questions and decide in the end.

How to begin is in [Your first plan in six steps](help.topic.first_plan#overview).

## The four places {#places}

| Place | What you do there |
|---|---|
| Rooms | you see the rooms you are in and what each is doing; you make a new one |
| A room | you work on a plan: files, [table](help.topic.words#table), plan |
| Settings | your name, the look of the page, the people in your rooms |
| Help | these pages; the "?" beside a control opens a short tip |

When a room says "waiting for you", a model has asked you something.

## The three parts of a room {#panes}

- **Files:** the material of the task shown, that is the documents you gave it. The models read only in these.
- **Table:** here the models work: the tasks, the runs, their discussion and their questions to you. See [The table](help.topic.table#overview).
- **Plan:** the document the table writes, [version](help.topic.words#version) by version. See [The plan](help.topic.plan#overview).

On a wide screen you see all three side by side, on a tablet two, on a phone one after the other. See [On the phone](help.topic.phone#overview).

## Your settings {#settings}

Your browser keeps the language, light or dark and the colours, for this device. FORUM keeps your name and the people in your rooms.

## The expert view {#expert}

The page FORUM had before stays at /expert: with the standings of the two ways of working and both tables side by side. It is explained in [Codemode forum: what it is and how a run goes](help.topic.overview#overview).`,
		},
	},
	{
		id: "help.topic.first_plan",
		section: "start",
		plain: true,
		title: { de: "Dein erster Plan in sechs Schritten", en: "Your first plan in six steps" },
		short: {
			de: "Vom neuen Raum bis zum heruntergeladenen Plan, am Beispiel einer App für den Sternenhimmel.",
			en: "From a new room to the downloaded plan, with an app for the starry sky as the example.",
		},
		body: {
			de: `## Überblick {#overview}

Nach dieser Seite hast du einen [Raum](help.topic.words#room) angelegt, ihm einen [Auftrag](help.topic.words#brief) gegeben und die [Modelle](help.topic.words#model) einen ersten Plan ausarbeiten lassen. Das Beispiel: eine App, die den Sternenhimmel für einen Ort und eine Zeit zeigt.

## 1 Einen Raum anlegen {#room}

Unter „Räume“ gibst du dem neuen Raum einen Namen, etwa \`sternenhimmel\`, und wählst „Raum anlegen“. Der Raum gehört dir. Wen du dazuholst, steht in [Anmelden](help.topic.signing_in#invite).

## 2 Den Auftrag schreiben {#brief}

Im Raum öffnest du „Neue Aufgabe“ und schreibst den Auftrag, zum Beispiel: „Eine App, die den Sternenhimmel zu einer bestimmten Zeit an einem bestimmten Ort zeigt, mit Kometen, Asteroiden, Sternbildern und Messier-Objekten.“

Dazu kannst du wählen:

- die Sprache des Dokuments;
- eine Gliederung, wenn du die Überschriften vorgeben willst;
- Kriterien, die der Plan auf jeden Fall erfüllen muss, eines je Zeile;
- Dokumente, die die Modelle lesen dürfen. Auszüge daraus gehen an die Anbieter der gewählten Modelle.

## 3 Einen Lauf starten {#run}

Unter „Einen Lauf starten“ hakst du mindestens drei Modelle an, lässt die Arbeitsweise, wie sie ist, und wählst „Lauf starten“. Das [Budget](help.topic.words#budget) begrenzt, wie viel der Lauf verbrauchen darf. „Stopp“ hält ihn sofort an; was geschrieben ist, bleibt.

## 4 Dem Tisch antworten {#answer}

Die Modelle melden sich, sagen, wie sie den Auftrag verstehen, und stellen Fragen. Eine Frage an dich ist hervorgehoben, und der Raum steht in der Liste auf „wartet auf dich“. Du antwortest im Feld darunter. Was am [Tisch](help.topic.words#table) sonst geschieht, steht in [Der Tisch](help.topic.table#overview).

## 5 Lesen und annehmen {#accept}

Unter „Plan“ wächst das Dokument [Fassung](help.topic.words#version) für Fassung. Stimmt mehr als die Hälfte der Modelle zu, ist es angenommen. Du kannst auch selbst eine Fassung annehmen oder einen [Einwand](help.topic.words#objection) gegen einen Abschnitt erheben. Siehe [Der Plan](help.topic.plan#overview).

## 6 Mitnehmen {#download}

„Ergebnis mit Anhang (.md)“ lädt den Plan mit seinen Entscheidungen als Markdown-Datei herunter.`,
			en: `## Overview {#overview}

After this page you have made a [room](help.topic.words#room), given it a [brief](help.topic.words#brief) and let the [models](help.topic.words#model) work out a first plan. The example: an app that shows the starry sky for a place and a time.

## 1 Make a room {#room}

Under "Rooms" you give the new room a name, such as \`starry-sky\`, and choose "Create room". The room belongs to you. Whom you bring in is in [Signing in](help.topic.signing_in#invite).

## 2 Write the brief {#brief}

In the room you open "New task" and write the brief, for example: "An app that shows the starry sky at a given time and place, with comets, asteroids, constellations and Messier objects."

Besides it you can choose:

- the language of the document;
- an outline, if you want to give the headings;
- criteria the plan must meet in any case, one a line;
- documents the models may read. Excerpts of them go to the providers of the chosen models.

## 3 Start a run {#run}

Under "Start a run" you tick at least three models, leave the way of working as it is and choose "Start run". The [budget](help.topic.words#budget) limits how much the run may use. "Stop" ends it at once; what is written stays.

## 4 Answer the table {#answer}

The models report, say how they understand the brief and ask questions. A question to you is marked, and the room's list says "waiting for you". You answer in the field below it. What else happens at the [table](help.topic.words#table) is in [The table](help.topic.table#overview).

## 5 Read and accept {#accept}

Under "Plan" the document grows [version](help.topic.words#version) by version. When more than half of the models agree, it is accepted. You can also accept a version yourself or raise an [objection](help.topic.words#objection) to a section. See [The plan](help.topic.plan#overview).

## 6 Take it with you {#download}

"Result with appendix (.md)" downloads the plan with its decisions as a Markdown file.`,
		},
	},
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

Neu hier? [Wörter, die hier vorkommen](help.topic.words#overview) erklärt zehn Wörter in je einem Satz, und [Anmelden](help.topic.signing_in#overview) zeigt, wie du hineinkommst und wer deine Räume sieht.

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

New here? [Words used here](help.topic.words#overview) explains ten words in one sentence each, and [Signing in](help.topic.signing_in#overview) shows how you get in and who sees your rooms.

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
		id: "help.topic.words",
		section: "start",
		plain: true,
		title: { de: "Wörter, die hier vorkommen", en: "Words used here" },
		short: {
			de: "Zehn Wörter, die in FORUM eine feste Bedeutung haben, mit je einem Satz erklärt.",
			en: "Ten words that have a fixed meaning in FORUM, each explained in one sentence.",
		},
		body: {
			de: `## Überblick {#overview}

Nach dieser Seite kennst du die zehn Wörter, mit denen die Hilfe und die Seite arbeiten. Jede andere Hilfeseite verlinkt ein solches Wort beim ersten Vorkommen hierher.

## Personen und Orte {#places}

### Raum {#room}

Ein Raum ist der Ort, an dem ein Plan entsteht; er gehört der Person, die ihn angelegt hat, und sie lädt andere ein.

### Workspace {#workspace}

Ein Workspace ist dein Bereich in den Dateien, mit Ordnern, Dateien und den Rechten daran.

### Ordner {#folder}

Ein Ordner in einem Workspace hält Material, aus dem ein Raum liest, oder das Projekt, in das er seinen Plan speichert.

### Freigabe {#grant}

Eine Freigabe ist das Recht, das die Besitzerin oder der Besitzer eines Ordners einem Raum gibt, und sie lässt sich jederzeit zurücknehmen.

## Am Tisch {#work}

### Tisch {#table}

Der Tisch sind die KI-Modelle und du, die gemeinsam an einem Plan arbeiten: Sie fragen, schlagen vor und stimmen ab.

### Modell {#model}

Ein Modell ist ein KI-Sprachmodell eines Anbieters, das am Tisch mitarbeitet.

### Auftrag {#brief}

Der Auftrag sagt in deinen Worten, was geplant werden soll; an ihm misst der Tisch den Plan.

### Fassung {#version}

Jede Änderung am Plan ergibt eine neue Fassung, und die älteren bleiben lesbar.

### Einwand {#objection}

Ein Einwand ist ein Grund, von einem Modell oder von dir, warum sich der Plan so nicht umsetzen lässt, und er muss beantwortet werden.

### Budget {#budget}

Das Budget sagt, wie viele Modellaufrufe ein Lauf verbrauchen darf; ist es aufgebraucht, hält der Lauf an.`,
			en: `## Overview {#overview}

After this page you know the ten words the help and the page work with. Every other help page links such a word here where it first appears.

## People and places {#places}

### Room {#room}

A room is the place where a plan is worked out; it belongs to the person who made it, and they invite others.

### Workspace {#workspace}

A workspace is your area in Files, with folders, files and the rights to them.

### Folder {#folder}

A folder in a workspace holds material a room reads from, or the project into which it saves its plan.

### Grant {#grant}

A grant is the right a folder's owner gives a room, and it can be taken back at any time.

## At the table {#work}

### Table {#table}

The table is the AI models and you, working on one plan together: they ask, propose and vote.

### Model {#model}

A model is an AI language model of a provider that works at the table.

### Brief {#brief}

The brief says in your words what is to be planned; the table measures the plan against it.

### Version {#version}

Every change to the plan makes a new version, and the older ones stay readable.

### Objection {#objection}

An objection is a reason, from a model or from you, why the plan cannot be carried out as written, and it must be answered.

### Budget {#budget}

The budget says how many model calls a run may use; when it is used up, the run stops.`,
		},
	},
	{
		id: "help.topic.signing_in",
		section: "configure",
		plain: true,
		title: { de: "Anmelden", en: "Signing in" },
		short: {
			de: "Ein Konto für FORUM und die Dateien, dein Name, deine Räume, Einladen und Abmelden.",
			en: "One account for FORUM and Files, your name, your rooms, inviting and signing out.",
		},
		body: {
			de: `## Überblick {#overview}

Nach dieser Seite kannst du dich anmelden, den Namen wählen, den andere sehen, einen [Raum](help.topic.words#room) anlegen, andere einladen und dich wieder abmelden.

![Ein Konto, zwei Anwendungen: Du öffnest die Seite, FORUM schickt dich zum Anmeldedienst, dein Passwort gibst du nur dort ein, und der Dienst sagt FORUM, wer du bist, nie dein Passwort. Die Dateien nutzen dasselbe Konto mit einer eigenen Sitzung.](/help/img/forum-signin-de.svg)

## Ein Konto für beides {#account}

FORUM speichert keine Passwörter. Wenn du dich anmeldest, schickt es dich zum Anmeldedienst, und dort gibst du dein Passwort ein. Danach sagt der Dienst FORUM, wer du bist.

Dasselbe Konto öffnet auch die Dateien, den Ort für deine [Workspaces](help.topic.words#workspace) und [Ordner](help.topic.words#folder). Beide halten jeweils eine eigene Sitzung.

Eine Sitzung endet nach einer Stunde ohne Nutzung und spätestens nach zwölf Stunden. Dann meldest du dich wieder an.

## Dein Name {#name}

Im Menü unter deinem Namen oben auf der Seite änderst du den Namen, den die anderen am [Tisch](help.topic.words#table) und in der Liste der Personen eines Raums sehen. Dein Konto beim Anmeldedienst bleibt dabei unverändert.

## Deine Räume {#rooms}

Jeder Raum gehört der Person, die ihn angelegt hat. Du siehst nur die Räume, in denen du eine Rolle hast; jeden anderen Raum gibt es für dich nicht, auch wenn du seinen Namen kennst.

| Rolle | Was sie darf |
|---|---|
| Besitz | alles, und sie entscheidet, wer noch im Raum ist |
| Mitglied | schreibt im Raum mit: stellt den [Auftrag](help.topic.words#brief), startet Läufe, antwortet, nimmt an oder widerspricht |
| liest mit | sieht alles im Raum und ändert nichts |

Einen Raum legst du unter „Neuer Raum“ an. Sein Name besteht aus Buchstaben, Ziffern, Punkten und Bindestrichen, und zwei Räume heißen nie gleich.

## Jemanden einladen {#invite}

Du lädst eine Person über ihre ID ein. Sie findet sie unten in ihrer Liste der Räume und nennt sie dir, zum Beispiel in einer Nachricht. Die ID verrät weder ihren Namen noch ihre Adresse.

Als Besitzerin oder Besitzer öffnest du „Personen im Raum“, gibst die ID ein und wählst „als Mitglied“ oder „zum Mitlesen“. Mit „entfernen“ nimmst du jemanden wieder heraus; der Raum verschwindet sofort aus seiner Liste.

## Abmelden {#signout}

„Abmelden“ im Menü unter deinem Namen beendet deine Sitzung hier und beim Anmeldedienst. Die nächste Anmeldung fragt wieder nach deinem Passwort. Die Dateien behalten ihre eigene Sitzung, bis du dich auch dort abmeldest.

## Ein zweiter Faktor {#factor}

Der Anmeldedienst kann außer dem Passwort einen zweiten Faktor verlangen, etwa einen Code aus einer App auf deinem Telefon. Ob er das tut, legt fest, wer den Dienst betreibt; FORUM selbst sieht den Code nie.`,
			en: `## Overview {#overview}

After this page you can sign in, choose the name others see, make a [room](help.topic.words#room), invite others and sign out again.

![One account, two applications: you open the page, FORUM sends you to the sign-in service, you give your password only there, and the service tells FORUM who you are, never your password. Files uses the same account with a session of its own.](/help/img/forum-signin.svg)

## One account for both {#account}

FORUM keeps no passwords. When you sign in, it sends you to the sign-in service, and there you enter your password. Then the service tells FORUM who you are.

The same account also opens Files, the place for your [workspaces](help.topic.words#workspace) and [folders](help.topic.words#folder). Each of the two keeps a session of its own.

A session ends after an hour without use, and after twelve hours at most. Then you sign in again.

## Your name {#name}

In the menu under your name at the top of the page you change the name the others see at the [table](help.topic.words#table) and in a room's list of people. Your account at the sign-in service stays as it is.

## Your rooms {#rooms}

Every room belongs to the person who made it. You see only the rooms in which you have a role; any other room does not exist for you, even if you know its name.

| Role | What it may do |
|---|---|
| Owner | everything, and decides who else is in the room |
| Member | writes in the room: gives the [brief](help.topic.words#brief), starts runs, answers, accepts or disagrees |
| Reads along | sees everything in the room and changes nothing |

You make a room under "New room". Its name is made of letters, digits, dots and dashes, and no two rooms share one.

## Inviting someone {#invite}

You invite a person by their ID. They find it at the bottom of their list of rooms and tell you, for example in a message. The ID tells neither their name nor their address.

As the owner you open "People in this room", enter the ID and choose "as a member" or "to read along". With "remove" you take someone out again; the room is gone from their list at once.

## Signing out {#signout}

"Sign out" in the menu under your name ends your session here and at the sign-in service. The next sign-in asks for your password again. Files keeps its own session until you sign out there too.

## A second factor {#factor}

The sign-in service can ask for a second factor besides your password, such as a code from an app on your phone. Whether it does is set by whoever runs the service; FORUM itself never sees the code.`,
		},
	},
	{
		id: "help.topic.table",
		section: "use",
		plain: true,
		title: { de: "Der Tisch: wie die Modelle zu einem Plan kommen", en: "The table: how the models work it out" },
		short: {
			de: "Appell, Diskussion, Schreiben, Prüfen und Abstimmen, und wann du gefragt wirst.",
			en: "Roll call, discussion, writing, checking and voting, and when you are asked.",
		},
		body: {
			de: `## Überblick {#overview}

Nach dieser Seite weißt du, wie die [Modelle](help.topic.words#model) am [Tisch](help.topic.words#table) zu einem Plan kommen und wann du mitredest.

![Wie der Tisch zu einem Plan kommt: Dein Auftrag, dann Appell und Auftakt, Diskussion, Schreiben, Prüfprogramm und Abstimmung. Stimmt mehr als die Hälfte zu, ist der Plan angenommen; sonst folgt mit den Einwänden die nächste Runde. Du antwortest in der Diskussion und widersprichst oder nimmst selbst an.](/help/img/forum-table-de.svg)

## Die Schritte {#steps}

1. **Appell:** Jedes Modell meldet sich unter einem Namen am Tisch (M1, M2, …). Welches Modell dahintersteht, erfahren die anderen nicht.
2. **Auftakt:** Jedes Modell sagt, wie es den [Auftrag](help.topic.words#brief) versteht, und stellt Fragen.
3. **Diskussion:** Die Modelle machen Vorschläge, fragen einander und stimmen darüber ab. Ein Vorschlag, dem die meisten zustimmen, wird eine Entscheidung, an die sich alle halten.
4. **Schreiben:** Erst die Gliederung, dann die Abschnitte.
5. **Prüfen:** Ein Programm prüft Tatsachen, etwa ob ein zitierter Satz wirklich im Material steht.
6. **Abstimmen:** Jedes Modell stimmt über die [Fassung](help.topic.words#version) ab. Stimmt mehr als die Hälfte zu, ist der Plan angenommen; sonst werden die [Einwände](help.topic.words#objection) aufgegriffen und die nächste Runde beginnt.

## Du am Tisch {#you}

- **Eine Frage an dich** ist hervorgehoben. Der Tisch wartet eine Weile auf deine Antwort; kommt keine, macht er ohne sie weiter.
- **Etwas sagen** kannst du jederzeit im Feld unter der Diskussion. Die Modelle lesen es vor ihrem nächsten Schritt.
- Was du sagst, gilt vor jeder Entscheidung der Modelle.

## Arbeitsweisen und Runden {#ways}

| Arbeitsweise | So arbeiten die Modelle |
|---|---|
| abwechselnd | ein Modell nach dem anderen ist am Zug |
| gleichzeitig | die Abschnitte werden verteilt, danach prüfen die Modelle einander |
| beide im Wettbewerb | beide Arbeitsweisen an je einem eigenen Dokument, dann ein blinder Vergleich und eine gemeinsame Schlussrunde |

Die Zahl der Runden sagt, wie oft die Modelle höchstens überarbeiten und abstimmen.

## Was ein Lauf kostet {#budget}

Jeder Aufruf eines Modells verbraucht Tokens. Das [Budget](help.topic.words#budget) eines Laufs sagt, wie viele er verbrauchen darf; ist es aufgebraucht, hält der Lauf an. Was ein Lauf verbraucht hat, steht in seiner Zeile unter „Tisch“.`,
			en: `## Overview {#overview}

After this page you know how the [models](help.topic.words#model) at the [table](help.topic.words#table) reach a plan and when you have a say.

![How the table reaches a plan: your brief, then roll call and kickoff, discussion, writing, the checking program and the ballots. When more than half agree, the plan is accepted; otherwise the next round follows with the objections. You answer in the discussion, and object or accept yourself.](/help/img/forum-table.svg)

## The steps {#steps}

1. **Roll call:** every model reports under a name at the table (M1, M2, …). The others are not told which model is behind it.
2. **Kickoff:** every model says how it understands the [brief](help.topic.words#brief) and asks questions.
3. **Discussion:** the models make proposals, ask each other and vote on them. A proposal most of them agree to becomes a decision everyone keeps to.
4. **Writing:** first the outline, then the sections.
5. **Checking:** a program checks facts, such as whether a quoted sentence really stands in the material.
6. **Voting:** every model votes on the [version](help.topic.words#version). When more than half agree, the plan is accepted; otherwise the [objections](help.topic.words#objection) are taken up and the next round begins.

## You at the table {#you}

- **A question to you** is marked. The table waits a while for your answer; if none comes, it goes on without it.
- **You can say something** at any time in the field below the discussion. The models read it before their next step.
- What you say outranks any decision of the models.

## Ways of working and rounds {#ways}

| Way of working | How the models work |
|---|---|
| taking turns | one model after the other has the turn |
| at the same time | the sections are dealt out, then the models review each other |
| both in competition | both ways, each on a document of its own, then a blind comparison and a joint final round |

The number of rounds says how often at most the models revise and vote.

## What a run costs {#budget}

Every call of a model uses tokens. A run's [budget](help.topic.words#budget) says how many it may use; when it is used up, the run stops. What a run has used stands in its line under "Table".`,
		},
	},
	{
		id: "help.topic.plan",
		section: "use",
		plain: true,
		title: { de: "Der Plan: Fassungen, Annehmen, Herunterladen", en: "The plan: versions, accepting, downloading" },
		short: {
			de: "Fassungen lesen und vergleichen, einen Plan annehmen oder widersprechen, und ihn mitnehmen.",
			en: "Reading and comparing versions, accepting a plan or objecting, and taking it with you.",
		},
		body: {
			de: `## Überblick {#overview}

Nach dieser Seite kannst du jede [Fassung](help.topic.words#version) des Plans lesen und vergleichen, ihn annehmen oder ihm widersprechen und ihn herunterladen.

## Fassungen {#versions}

Jede Änderung am Plan ergibt eine neue Fassung; die älteren bleiben lesbar. Unter „Fassung“ wählst du, welche du liest. Ohne Wahl siehst du die neueste, oder das Ergebnis, wenn es eines gibt. Neben jedem Abschnitt steht, welches [Modell](help.topic.words#model) ihn zuletzt geschrieben hat.

## Vergleichen {#compare}

Unter „vergleichen mit“ wählst du eine andere Fassung. Dann zeigt jeder Abschnitt, was gestrichen und was hinzugekommen ist, Zeile für Zeile; unveränderte Abschnitte bleiben kurz.

## Annehmen {#accept}

Stimmt mehr als die Hälfte der Modelle einer Fassung zu, ist sie angenommen. Du kannst auch selbst eine Fassung annehmen, mit „Diese Fassung annehmen“: Sie gilt dann als Ergebnis, auch ohne Mehrheit.

## Widersprechen {#object}

Stimmt an einem Abschnitt etwas nicht, wählst du den Abschnitt, schreibst, was falsch ist, und erhebst den [Einwand](help.topic.words#objection). Kein Modell kann einen Einwand von dir ablehnen; die nächste Runde muss ihn aufgreifen. Einwände stehen beim Abschnitt, bis sie erledigt sind.

## Zwei Tische {#tables}

Haben in einem Lauf beide Arbeitsweisen gearbeitet, hat jeder [Tisch](help.topic.words#table) ein eigenes Dokument. Unter „Welcher Tisch“ wählst du eines, oder beide nebeneinander. Darüber steht, wie die Modelle beide blind verglichen haben und welches das Ergebnis wurde.

## Herunterladen {#download}

„Ergebnis mit Anhang (.md)“ lädt den Plan mit seinen Entscheidungen und dem Verlauf als Markdown-Datei. „diese Fassung (.md)“ lädt nur die Fassung, die du gerade liest.`,
			en: `## Overview {#overview}

After this page you can read and compare every [version](help.topic.words#version) of the plan, accept it or object to it, and download it.

## Versions {#versions}

Every change to the plan makes a new version; the older ones stay readable. Under "Version" you choose which one you read. Without a choice you see the newest, or the result when there is one. Beside every section stands which [model](help.topic.words#model) wrote it last.

## Comparing {#compare}

Under "compare with" you choose another version. Then every section shows what was struck out and what was added, line by line; sections that did not change stay short.

## Accepting {#accept}

When more than half of the models agree to a version, it is accepted. You can also accept a version yourself, with "Accept this version": it then counts as the result, even without a majority.

## Objecting {#object}

When something is wrong in a section, you choose the section, write what is wrong and raise the [objection](help.topic.words#objection). No model can decline an objection of yours; the next round must take it up. Objections stand beside their section until they are settled.

## Two tables {#tables}

When both ways of working worked in a run, each [table](help.topic.words#table) has a document of its own. Under "Which table" you choose one, or both side by side. Above them stands how the models compared both blind and which one became the result.

## Downloading {#download}

"Result with appendix (.md)" downloads the plan with its decisions and its course as a Markdown file. "this version (.md)" downloads only the version you are reading.`,
		},
	},
	{
		id: "help.topic.phone",
		section: "use",
		plain: true,
		title: { de: "Auf dem Telefon", en: "On the phone" },
		short: {
			de: "Die drei Bereiche unten, rechtzeitig antworten, FORUM auf den Startbildschirm legen.",
			en: "The three parts at the bottom, answering in time, putting FORUM on the home screen.",
		},
		body: {
			de: `## Überblick {#overview}

Nach dieser Seite findest du dich in einem [Raum](help.topic.words#room) auf dem Telefon zurecht, verpasst keine Frage und öffnest FORUM vom Startbildschirm.

## Die drei Bereiche {#tabs}

Auf einem schmalen Bildschirm zeigt ein Raum einen Bereich auf einmal. Unten wechselst du zwischen **Dateien**, **[Tisch](help.topic.words#table)** und **Plan**. Eine Zahl bei „Tisch“ heißt: So viele Fragen warten auf dich. Die Adresse merkt sich den Bereich, ein Link kann also direkt auf den Plan zeigen.

## Rechtzeitig antworten {#answer}

Fragt dich ein [Modell](help.topic.words#model) etwas, wartet der Tisch eine Weile, in der Regel zwei Minuten, dann macht er ohne deine Antwort weiter. Lass die Seite offen, solange ein Lauf arbeitet. In der Liste der Räume steht „wartet auf dich“, und der Titel des Tabs zeigt, wie viele Räume warten. Wenn du einen Lauf startest, fragt der Browser, ob FORUM dir Mitteilungen zeigen darf; erlaubst du es, meldet sich die offene Seite mit einer Mitteilung, sobald eine Frage auf dich wartet, auch wenn du gerade in einem anderen Tab bist. Eine geschlossene Seite meldet nichts.

Tippst du eine Antwort, verschwindet die Leiste unten, und das Feld bleibt über der Tastatur.

## Auf den Startbildschirm {#home}

Im Menü deines Browsers wählst du „Zum Startbildschirm hinzufügen“. FORUM öffnet sich dann wie eine App, ohne die Leisten des Browsers. Es braucht weiterhin eine Verbindung.`,
			en: `## Overview {#overview}

After this page you find your way around a [room](help.topic.words#room) on a phone, miss no question and open FORUM from the home screen.

## The three parts {#tabs}

On a narrow screen a room shows one part at a time. At the bottom you switch between **Files**, **[Table](help.topic.words#table)** and **Plan**. A number at "Table" means: that many questions wait for you. The address keeps the part, so a link can point straight at the plan.

## Answering in time {#answer}

When a [model](help.topic.words#model) asks you something, the table waits a while, usually two minutes, then it goes on without your answer. Keep the page open while a run works. The list of rooms says "waiting for you", and the tab's title shows how many rooms wait. When you start a run, the browser asks whether FORUM may show you notifications; if you allow it, the open page notifies you as soon as a question waits for you, even while you are in another tab. A closed page notifies nothing.

While you type an answer, the bar at the bottom steps aside and the field stays above the keyboard.

## On the home screen {#home}

In your browser's menu you choose "Add to Home screen". FORUM then opens like an app, without the browser's bars. It still needs a connection.`,
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
| Material aus dem Workspace | wer im Raum schreibt, sobald der Raum verbunden ist | eine Kopie beim Anlegen, bis 400 Dateien und 4 MB Text; siehe [Material aus den Dateien](help.topic.material#task) |
| Bilder für die Modelle | wer im Raum schreibt | eine verkleinerte Kopie ohne Ort und Kameradaten, bis zwölf je Aufgabe; siehe [Fotos und andere Dateien](help.topic.pictures#add) |

Ein Repository wird beim Anlegen auf einen **Commit** festgelegt. Die Modelle lesen aus den Objekten dieses Commits, nicht aus dem Arbeitsverzeichnis: Was später im Repository geschieht, ändert die Aufgabe nicht. Den Commit nennt der Anhang des Ergebnisses.

Ein **entferntes Repository** wird beim Anlegen der Aufgabe einmal abgerufen: nur der eine Commit, ohne Vorgeschichte, in einen Zwischenspeicher des Quellen-Prozesses. Dort liegt es als reine Objektablage; es wird nie ausgecheckt. Danach wird es gelesen wie ein Repository auf dem Rechner. Was abgelehnt wird, steht in [Sicherheit und Grenzen](help.topic.safety_and_limits#remote).

Die Modelle lesen in Schritten: ein Verzeichnis auflisten, einen Ausschnitt einer Datei lesen (höchstens 400 Zeilen oder 16 kB je Schritt), nach Text suchen (höchstens 40 Treffer). Dateien mit Schlüsseln und lokalen Einstellungen bekommt kein Modell, siehe [Sicherheit und Grenzen](help.topic.safety_and_limits#deny).

## Was an die Anbieter geht {#providers}

Auszüge aus den Quellen stehen in den Aufrufen an die gewählten Modelle und gehen damit an deren Anbieter. Gib keine Quellen an, die das nicht dürfen. Was genau hinausgeht, steht in [Was dieses System verlässt](help.topic.what_leaves#providers).`,
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
| Material from the workspace | whoever writes in the room, once the room is linked | a copy when the task is created, up to 400 files and 4 MB of text; see [Material from the files](help.topic.material#task) |
| Pictures for the models | whoever writes in the room | a reduced copy without the place and camera data, up to twelve a task; see [Photos and other files](help.topic.pictures#add) |

A repository is fixed to a **commit** when the task is created. The models read from the objects of that commit, not from the working directory: what happens in the repository later does not change the task. The appendix of the result names the commit.

A **remote repository** is fetched once when the task is created: only the one commit, without its history, into a cache of the sources process. There it lies as a bare object store; it is never checked out. From then on it is read like a repository on the machine. What is refused is in [Safety and limits](help.topic.safety_and_limits#remote).

The models read in steps: list a directory, read a part of a file (at most 400 lines or 16 kB a step), search for text (at most 40 hits). Files with keys and local settings no model gets, see [Safety and limits](help.topic.safety_and_limits#deny).

## What goes to the providers {#providers}

Excerpts of the sources are part of the calls to the chosen models and so go to their providers. Do not name sources that must not. What leaves exactly is in [What leaves this system](help.topic.what_leaves#providers).`,
		},
	},
	{
		id: "help.topic.material",
		section: "use",
		plain: true,
		title: { de: "Material aus den Dateien", en: "Material from the files" },
		short: {
			de: "Einen Raum mit Ordnern in spaces-files verbinden, prüfen, was er sieht, und einer Aufgabe eine Kopie davon mitgeben.",
			en: "Linking a room to folders in spaces-files, checking what it sees, and giving a task a copy of them.",
		},
		body: {
			de: `## Überblick {#overview}

Ein [Raum](help.topic.words#room) kann Material aus einem [Workspace](help.topic.words#workspace) in spaces-files lesen: Anforderungen, Tabellen, Notizen, Bilder. Dafür hat jeder Raum dort einen eigenen Agenten. Was dieser Agent sieht, entscheiden die Besitzerinnen und Besitzer der [Ordner](help.topic.words#folder), nicht FORUM. Wer sieht was, steht in [Wer sieht was](help.topic.who_sees_what#overview).

## Verbinden {#link}

Nur wem der Raum gehört, verbindet ihn. Unter dem [Tisch](help.topic.words#table) zeigt der Bereich **Workspace** den Namen des Agenten (\`room-<Raum>\`) und drei Schritte:

1. Eine Verwaltung von spaces-files registriert den Agenten für den Host, den die Seite nennt.
2. Wer die Ordner besitzt, gibt dem Agenten dort eine [Freigabe](help.topic.words#grant): Lesen auf den Ordner, der nur gelesen wird, Bearbeiten auf den Projektordner. Lesen gilt für einen ganzen Workspace oder für einen eingeschränkten Ordner darin.
3. Zurück im Raum nennst du beide Ordner, prüfst und verbindest.

## Prüfen {#check}

**Prüfen** fragt spaces-files, was der Agent sieht. Die Seite nennt die Workspaces, die er sieht, und für jeden genannten Ordner, wie viele Einträge er hat. Abgelehnt wird ein Ordner, den der Agent nicht sieht, und einer, der ihm gehört: Ein Raum darf nie selbst Rechte weitergeben können, auch nicht in seinem eigenen Bereich.

## Material für eine Aufgabe {#task}

Beim Anlegen einer Aufgabe nimmt das Häkchen **Material aus dem Workspace mitnehmen** eine Kopie beider Ordner, so wie sie jetzt sind. Der Ordner zum Lesen erscheint darin als \`reference/\`, der Projektordner als \`project/\`. Textdateien bis 200 kB werden kopiert; jede andere Datei steht mit ihrer Art und Größe in der Liste, aber ihr Inhalt nicht. Die Art erkennt FORUM am Inhalt, nicht am Namen. Dateien mit Schlüsseln und lokalen Einstellungen bleiben draußen.

Grenzen einer Kopie: 400 Dateien, zusammen 4 MB Text, acht Ebenen tief. Was darüber liegt, wird mit der Zahl abgelehnt und nie still gekürzt.

## Die Dateien der Kopie {#files}

Der Bereich **Dateien** zeigt die Kopie der gezeigten Aufgabe: jede Datei mit Größe, bei den nicht kopierten mit ihrer Art. Die [Modelle](help.topic.words#model) am Tisch lesen daraus wie aus hochgeladenen Dokumenten: auflisten, einen Ausschnitt lesen, suchen.

## Freigabe zurücknehmen {#revoke}

Nimmt jemand die Freigabe in spaces-files zurück, scheitert die nächste Kopie mit dem Grund. Eine Kopie, die eine Aufgabe schon genommen hat, bleibt bei ihr, bis die Aufgabe oder der Raum gelöscht wird. **Verbindung lösen** trennt den Raum; seine Aufgaben behalten ihre Kopien.`,
			en: `## Overview {#overview}

A [room](help.topic.words#room) can read material from a [workspace](help.topic.words#workspace) in spaces-files: requirements, spreadsheets, notes, pictures. For that each room has an agent of its own there. What that agent sees is decided by the owners of the [folders](help.topic.words#folder), not by FORUM. Who sees what is in [Who sees what](help.topic.who_sees_what#overview).

## Linking {#link}

Only the room's owner links it. Under the [table](help.topic.words#table), the part **Workspace** shows the agent's name (\`room-<room>\`) and three steps:

1. An administrator of spaces-files registers the agent for the host the page names.
2. Whoever owns the folders gives the agent a [grant](help.topic.words#grant) there: viewer on the folder that is only read, editor on the project folder. Viewer applies to a whole workspace or to a restricted folder in it.
3. Back in the room you name both folders, check and link.

## Checking {#check}

**Check** asks spaces-files what the agent sees. The page names the workspaces it sees and, for each folder named, how many entries it holds. A folder the agent does not see is refused, and so is one it owns: a room must never be able to pass rights on, not even in its own space.

## Material for a task {#task}

When a task is created, the tick **Take material from the workspace** takes a copy of both folders as they are now. The folder to read appears in it as \`reference/\`, the project folder as \`project/\`. Text files up to 200 kB are copied; every other file is in the list with its kind and size, but not its contents. FORUM tells the kind by the contents, not by the name. Files with keys and local settings stay out.

Limits of a copy: 400 files, 4 MB of text together, eight levels deep. What lies beyond is refused with the number and never cut silently.

## The files of the copy {#files}

The part **Files** shows the copy of the task shown: every file with its size, those not copied with their kind. The [models](help.topic.words#model) at the table read from it as from uploaded documents: list, read a part, search.

## Revoking {#revoke}

When somebody revokes the access in spaces-files, the next copy fails with the reason. A copy a task already took stays with it until the task or the room is deleted. **Unlink** separates the room; its tasks keep their copies.`,
		},
	},
	{
		id: "help.topic.pictures",
		section: "use",
		plain: true,
		title: { de: "Fotos und andere Dateien", en: "Photos and other files" },
		short: {
			de: "Bilder für die Modelle, ihre Beschreibung, Dateien in den Projektordner hochladen, PDFs und was mit anderen Dateien geschieht.",
			en: "Pictures for the models, their description, uploading files to the project folder, PDFs, and what becomes of other files.",
		},
		body: {
			de: `## Überblick {#overview}

Zu einer Aufgabe gehören oft Fotos, Skizzen, PDFs oder Tabellen. FORUM nimmt sie auf zwei Wegen: als **Bilder für die [Modelle](help.topic.words#model)**, die bei der Aufgabe bleiben, und als Dateien im Projektordner eines verbundenen [Workspace](help.topic.words#workspace). Was davon an die Modellanbieter geht, steht in [Was dieses System verlässt](help.topic.what_leaves#providers).

## Bilder hinzufügen {#add}

Beim Anlegen einer Aufgabe oder später im Bereich **Dateien** wählst du **Bilder hinzufügen**. Auf dem Telefon bietet das die Kamera und die Fotos an, am Schreibtisch die Dateiauswahl. Die Seite macht von jedem Bild eine verkleinerte Kopie: die längere Seite höchstens 1568 Pixel, als JPEG neu geschrieben. Dabei fällt alles weg, was die Datei sonst trägt: Kamera, Zeit und der Ort der Aufnahme. FORUM nimmt eine Kopie, die doch solche Daten trägt, nicht an.

Grenzen: zwölf Bilder je Aufgabe, 400 kB je Bild. Ein Bild, das zweimal ankommt (etwa weil die Antwort verloren ging), zählt einmal.

## Die Beschreibung {#describe}

Nicht jedes Modell kann Bilder sehen. Darum beschreibt zu Beginn eines Laufs das erste Modell am [Tisch](help.topic.words#table), das Bilder nimmt, jedes noch nicht beschriebene Bild einmal: was es zeigt, jeden Text darin, was es für den [Auftrag](help.topic.words#brief) bedeuten kann. Diese Beschreibung bekommen alle Modelle; die Modelle, die Bilder nehmen, bekommen die Bilder dazu.

Ein Lauf auf einer Aufgabe mit Bildern braucht deshalb mindestens ein solches Modell am Tisch und wird sonst mit diesem Grund abgelehnt. Stimmt eine Beschreibung nicht, schreibst du sie neu und speicherst sie: Dein Text zählt, auch in späteren Läufen.

## Dateien hochladen {#upload}

Ist der [Raum](help.topic.words#room) mit einem Workspace verbunden, nimmt der Bereich **Dateien** auch Dateien an, auf dem Schreibtisch auch durch Hineinziehen. Der Agent des Raums legt sie in \`material/\` des Projektordners ab; das Protokoll des Raums nennt, wer sie geschickt hat. Gibt es den Namen dort schon, bekommt die neue Datei einen Namen mit Zahl: Nichts wird überschrieben. Eine Datei bis 16 MB; ihre Art erkennt FORUM am Inhalt, nicht am Namen.

## Bilder und PDFs aus dem Workspace {#workspace}

Die Kopie einer Aufgabe zeigt Bilder (JPEG, PNG, WebP, GIF) im Bereich **Dateien** als Bild. Ein SVG wird nur als Bild gezeigt, nie in die Seite gesetzt.

Aus einem PDF nimmt FORUM beim Anlegen der Aufgabe den Text, mit einer Marke an jeder Seite, so dass die Modelle darin suchen und eine Stelle als „Seite 12“ nennen können. Das geschieht in einem abgeschotteten Prozess ohne Netz, ohne Dateien und ohne Schlüssel. Grenzen: 300 Seiten und 2 MB Text je PDF. Ein gescanntes PDF hat keinen Text; die Aufgabe sagt das und nennt die Datei mit ihrer Art. Ein verschlüsseltes oder kaputtes PDF wird ebenso benannt.

## Andere Dateien {#other}

Tabellen, Office-Dateien, Archive, Ton und Video lesen die Modelle nicht. Sie kennen ihren Namen, ihre Art und ihre Größe und die Notiz, die eine Person dazu schreibt, zum Beispiel: „die Ausschreibung als Tabelle, die Fristen stehen im zweiten Blatt“. Die Notiz schreibst du im Bereich **Dateien** neben der Datei.`,
			en: `## Overview {#overview}

A task often comes with photos, sketches, PDFs or spreadsheets. FORUM takes them in two ways: as **pictures for the [models](help.topic.words#model)**, which stay with the task, and as files in the project [folder](help.topic.words#folder) of a linked [workspace](help.topic.words#workspace). What of them goes to the model providers is in [What leaves this system](help.topic.what_leaves#providers).

## Adding pictures {#add}

When you create a task, or later in the part **Files**, choose **Add pictures**. On a phone this offers the camera and the photos, on a desk the file chooser. The page makes a reduced copy of each picture: the longer side at most 1568 pixels, written anew as JPEG. That drops everything else the file carries: the camera, the time and the place it was taken. FORUM does not take a copy that still carries such data.

Limits: twelve pictures a task, 400 kB a picture. A picture that arrives twice (because the reply was lost, say) counts once.

## The description {#describe}

Not every model can see pictures. So when a run begins, the first model at the [table](help.topic.words#table) that takes pictures describes each picture not yet described, once: what it shows, every text in it, what it may mean for the [brief](help.topic.words#brief). Every model gets that description; the models that take pictures get the pictures as well.

A run on a task with pictures therefore needs at least one such model at the table, and is refused with that reason otherwise. If a description is wrong, write it anew and save it: your text counts, in later runs too.

## Uploading files {#upload}

When the [room](help.topic.words#room) is linked to a workspace, the part **Files** also takes files, on a desk by dropping them as well. The room's agent puts them into \`material/\` of the project folder; the room's log names who sent them. If the name is taken there, the new file gets a name with a number: nothing is overwritten. A file up to 16 MB; FORUM tells its kind by the contents, not by the name.

## Pictures and PDFs from the workspace {#workspace}

A task's copy shows pictures (JPEG, PNG, WebP, GIF) in the part **Files** as pictures. An SVG is shown as a picture only, never placed into the page.

From a PDF FORUM takes the text when the task is created, with a mark at every page, so that the models can search it and name a place as "page 12". That happens in a sealed-off process without network, without files and without keys. Limits: 300 pages and 2 MB of text a PDF. A scanned PDF has no text; the task says so and names the file with its kind. An encrypted or broken PDF is named the same way.

## Other files {#other}

Spreadsheets, office files, archives, sound and video the models do not read. They know their name, kind and size, and the note a person writes about them, for example: "the tender as a spreadsheet, the deadlines are on the second sheet". You write the note in the part **Files** beside the file.`,
		},
	},
	{
		id: "help.topic.who_sees_what",
		section: "use",
		plain: true,
		title: { de: "Wer sieht was", en: "Who sees what" },
		short: {
			de: "Was der Agent eines Raums in spaces-files sieht, was die Personen im Raum sehen, und wer es beendet.",
			en: "What a room's agent sees in spaces-files, what the people in the room see, and who ends it.",
		},
		body: {
			de: `## Überblick {#overview}

Zwischen einem [Raum](help.topic.words#room) und den Dateien steht genau ein Agent je Raum. Er sieht, was ihm in spaces-files gegeben wurde, und nichts sonst.

![Wer sieht was: Die Besitzerin oder der Besitzer gibt dem Agenten des Raums Lesen auf einen Ordner und Bearbeiten auf den Projektordner und kann beides jederzeit entziehen. Der Agent liest beide; alles andere im Workspace sieht der Raum nie. Beim Anlegen einer Aufgabe entsteht eine Kopie der Texte; die Personen im Raum sehen sie, und Auszüge daraus gehen in den Aufrufen an die Modellanbieter.](/help/img/forum-access-de.svg)

## Der Agent des Raums {#agent}

Jeder Raum hat in spaces-files seinen eigenen Agenten. Ein gemeinsamer Agent für alle Räume ginge nicht: Dann könnte eine Aufgabe in einem Raum einen [Ordner](help.topic.words#folder) nennen, der für einen anderen freigegeben wurde. So prüft spaces-files selbst, was jeder Raum darf. Die [Freigabe](help.topic.words#grant) steht im Protokoll von spaces-files.

## Die Personen im Raum {#people}

Wer im Raum ist, sieht die Kopie der Aufgaben, den [Tisch](help.topic.words#table) und den Plan, auch wer nur mitliest. Den Raum mit den Ordnern verbinden oder die Verbindung lösen kann nur, wem er gehört. Wer dich einlädt, gibt dir also auch die Kopien zu sehen.

## Beenden {#revoke}

Die Besitzerin oder der Besitzer der Ordner nimmt die Freigabe in spaces-files zurück, wann immer sie oder er will. Ab dann liest der Raum nichts Neues mehr; Kopien, die Aufgaben schon genommen haben, bleiben, bis die Aufgabe oder der Raum gelöscht wird. Mehr dazu in [Material aus den Dateien](help.topic.material#revoke).`,
			en: `## Overview {#overview}

Between a [room](help.topic.words#room) and the files there is exactly one agent per room. It sees what it was given in spaces-files, and nothing else.

![Who may see what: the folder owner grants the room's agent viewer on a folder and editor on the project folder and can revoke both at any time. The agent reads both; everything else in the workspace is never visible to the room. A copy of the text is taken when a task is created; the people in the room see it, and excerpts of it go to the model providers in prompts.](/help/img/forum-access.svg)

## The room's agent {#agent}

Each room has its own agent in spaces-files. One agent for all rooms would not do: a task in one room could then name a [folder](help.topic.words#folder) that was shared with another. This way spaces-files itself checks what each room may do. The [grant](help.topic.words#grant) is in spaces-files' audit.

## The people in the room {#people}

Whoever is in the room sees the copy of its tasks, the [table](help.topic.words#table) and the plan, even those who only read along. Only the room's owner links it to folders or unlinks it. Whoever invites you therefore also shows you the copies.

## Ending it {#revoke}

The owner of the folders revokes the access in spaces-files whenever they want. From then on the room reads nothing new; copies tasks already took stay until the task or the room is deleted. More in [Material from the files](help.topic.material#revoke).`,
		},
	},
	{
		id: "help.topic.what_leaves",
		section: "reference",
		plain: true,
		title: { de: "Was dieses System verlässt", en: "What leaves this system" },
		short: {
			de: "Was an die Modellanbieter geht, was in spaces-files zurückgeht, und was nie hinausgeht.",
			en: "What goes to the model providers, what goes back to spaces-files, and what never leaves.",
		},
		body: {
			de: `## Überblick {#overview}

FORUM läuft auf eigenen Rechnern. Hinaus gehen nur die Aufrufe an die [Modelle](help.topic.words#model) und, ab einer späteren Stufe, was ein [Raum](help.topic.words#room) in seinen Projektordner speichert.

## An die Modellanbieter {#providers}

Jeder Aufruf an ein Modell geht an dessen Anbieter. Darin stehen der [Auftrag](help.topic.words#brief), was am [Tisch](help.topic.words#table) gesagt wurde, der Plan und die Auszüge aus den Quellen, die das Modell gelesen hat: aus hochgeladenen Dokumenten, aus Repositories und aus der Kopie der [Ordner](help.topic.words#folder), auch der Text aus PDFs. Die Bilder einer Aufgabe gehen nur an Modelle, die Bilder nehmen; ihre Beschreibungen an alle ([Fotos und andere Dateien](help.topic.pictures#describe)). Gib keine Quellen an, die das nicht dürfen. Welche Anbieter es gibt, legt die Verwaltung fest ([Modelle und Anbieter](help.topic.models_and_providers#overview)).

## In spaces-files {#files}

Die Dateien selbst bleiben in spaces-files. FORUM nimmt beim Anlegen einer Aufgabe eine Kopie der Texte (und des Texts aus PDFs) in seinen eigenen Speicher; Bilder und andere Dateien kennt es nur mit Name, Art, Größe und deiner Notiz. Hinein schreibt FORUM nur, was du hochlädst, in den Ordner \`material/\` des Projektordners ([Fotos und andere Dateien](help.topic.pictures#upload)).

## Was nie hinausgeht {#never}

Schlüssel der Anbieter und der Dateien, Dateien mit Schlüsseln und lokalen Einstellungen, deine Anmeldung und was du bei einer Anmeldung eines Anbieters eintippst. Die Gründe stehen in [Sicherheit und Grenzen](help.topic.safety_and_limits#overview).`,
			en: `## Overview {#overview}

FORUM runs on machines of its own. Only the calls to the [models](help.topic.words#model) leave it and, from a later stage on, what a [room](help.topic.words#room) saves into its project [folder](help.topic.words#folder).

## To the model providers {#providers}

Every call to a model goes to its provider. It holds the [brief](help.topic.words#brief), what was said at the [table](help.topic.words#table), the plan and the excerpts of the sources the model read: from uploaded documents, from repositories and from the copy of the folders, the text of PDFs too. The pictures of a task go only to models that take pictures; their descriptions to all ([Photos and other files](help.topic.pictures#describe)). Do not name sources that must not go there. Which providers there are is set by the administrators ([Models and providers](help.topic.models_and_providers#overview)).

## In spaces-files {#files}

The files themselves stay in spaces-files. When a task is created, FORUM takes a copy of the text (and of the text of PDFs) into its own store; pictures and other files it knows only by name, kind, size and your note. It writes only what you upload, into the project folder's \`material/\` ([Photos and other files](help.topic.pictures#upload)).

## What never leaves {#never}

The keys of the providers and of the files, files with keys and local settings, your sign-in and what you type into a provider's sign-in. The reasons are in [Safety and limits](help.topic.safety_and_limits#overview).`,
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
			de: "Sechs Rollen um einen Space; lokal als Prozesse oder Container, auf den Servern big und nano.",
			en: "Six roles around one space; locally as processes or containers, on the servers big and nano.",
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

Das lokale Testbett startet einen Container je Rolle; sie sprechen über TCP mit dem Space (Port 4190 auf diesem Rechner). Die Repositories aus \`FORUM_REPOS_DIR\` sind im Quellen-Container nur lesend eingehängt. \`docker:image:rust\` und \`docker:rust:up\` starten dasselbe Testbett mit dem Rust-Space-Server.

## Auf den Servern {#servers}

Die Seite läuft unter \`https://codeforum.eibrain.org\`, die Anmeldung unter \`https://id.eibrain.org\`; beide stehen hinter nginx auf big.

| Was | Wo |
|---|---|
| web, agents, model, sources | big, im Host-Netz, die Seite nur auf 127.0.0.1:4100: \`npm --prefix codemode-forum run docker:big:up\` |
| space, checker | nano, der Rust-Space-Server auf 127.0.0.1:4180: \`docker:nano:rust:up\`; big erreicht ihn über die Benutzer-Unit \`forum-nano-tunnel\` |
| Keycloak und seine Datenbank | big, Compose-Projekt \`phi-idp\` auf 127.0.0.1:4300: \`idp/server.sh\` |
| nginx | \`codemode-forum/docker/nginx-codeforum.conf\` und \`idp/nginx-id.conf\` |

Ein Update ist \`git pull --ff-only\` und das Skript des Hosts. Die Admin-Konsole von Keycloak ist von außen gesperrt; sie ist über \`ssh -L 4300:127.0.0.1:4300 big\` und \`http://localhost:4300/admin/\` erreichbar. Modellaufrufe bleiben dort aus (\`FORUM_LLM=0\`), bis der Betrieb sie einschaltet. Zugänge zu den Anbietern gibt die Verwaltung auf der Seite ([Modelle und Anbieter](help.topic.models_and_providers#overview)); die Grenzen stehen in [Budgets und Grenzen](help.topic.budgets_and_limits#ceilings).

Die Sicherung macht \`codemode-forum/deploy/forum-backup.sh\` täglich über einen systemd-Timer: nano kopiert den Speicher des Space, big sichert die Datenbank von Keycloak. Beide tauschen ihre Kopien aus, sodass jeder Host beide hat (\`~/phi-backup/forum\`, 30 Tage). Wie eine Kopie zurückgespielt wird, steht im Kopf des Skripts.

## Sicherung {#backup}

\`npm --prefix codemode-forum run backup\` schreibt eine konsistente Kopie des Speichers, während der Space läuft, und behält die neuesten sieben. \`server/restore.ts\` spielt eine Kopie zurück und weigert sich, solange der Space antwortet.

## Anmeldung {#signin}

Mit \`FORUM_LOGIN=oidc\` steht das Forum hinter einem OpenID-Anbieter (auf diesem Rechner Keycloak aus \`idp/\`): \`FORUM_PUBLIC_ORIGIN\` ist die Adresse der Seite, \`FORUM_OIDC_ISSUER\`, \`FORUM_OIDC_CLIENT_ID\` und \`FORUM_OIDC_CLIENT_SECRET\` nennen Anbieter und Client, \`FORUM_ADMINS\` die Administratoren als Paare aus Issuer und Subject. Personen und Sitzungen liegen im Space (\`ForumUser\`, \`UserSession\`), wer in welchem Raum ist in \`RoomAccess\`. Das Admin-Passwort gilt dann nur noch für Skripte. Was Personen dabei sehen, steht in [Anmelden](help.topic.signing_in#overview).

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

The local test bed starts one container per role; they talk to the space over TCP (port 4190 on this machine). The repositories of \`FORUM_REPOS_DIR\` are mounted read-only into the sources container. \`docker:image:rust\` and \`docker:rust:up\` start the same test bed with the Rust space server.

## On the servers {#servers}

The page runs at \`https://codeforum.eibrain.org\`, the sign-in at \`https://id.eibrain.org\`; both are behind nginx on big.

| What | Where |
|---|---|
| web, agents, model, sources | big, on the host network, the page on 127.0.0.1:4100 only: \`npm --prefix codemode-forum run docker:big:up\` |
| space, checker | nano, the Rust space server on 127.0.0.1:4180: \`docker:nano:rust:up\`; big reaches it through the user unit \`forum-nano-tunnel\` |
| Keycloak and its database | big, compose project \`phi-idp\` on 127.0.0.1:4300: \`idp/server.sh\` |
| nginx | \`codemode-forum/docker/nginx-codeforum.conf\` and \`idp/nginx-id.conf\` |

An update is \`git pull --ff-only\` and the host's script. Keycloak's admin console is closed from outside; it is reached through \`ssh -L 4300:127.0.0.1:4300 big\` and \`http://localhost:4300/admin/\`. Model calls stay off there (\`FORUM_LLM=0\`) until the operator turns them on. Administrators give the providers access on the page ([Models and providers](help.topic.models_and_providers#overview)); the limits are in [Budgets and limits](help.topic.budgets_and_limits#ceilings).

The backup is \`codemode-forum/deploy/forum-backup.sh\`, run daily by a systemd timer: nano copies the space's store and big dumps Keycloak's database. They exchange their copies, so each host holds both (\`~/phi-backup/forum\`, 30 days). The script's head says how to restore a copy.

## Backup {#backup}

\`npm --prefix codemode-forum run backup\` writes a consistent copy of the store while the space runs, and keeps the newest seven. \`server/restore.ts\` puts a copy back and refuses while the space answers.

## Sign-in {#signin}

With \`FORUM_LOGIN=oidc\` the forum is behind an OpenID provider (on this machine Keycloak from \`idp/\`): \`FORUM_PUBLIC_ORIGIN\` is the page's address, \`FORUM_OIDC_ISSUER\`, \`FORUM_OIDC_CLIENT_ID\` and \`FORUM_OIDC_CLIENT_SECRET\` name the provider and the client, \`FORUM_ADMINS\` the administrators as pairs of issuer and subject. People and sessions are kept in the space (\`ForumUser\`, \`UserSession\`), who is in which room in \`RoomAccess\`. The admin password then serves scripts only. What people see of it is in [Signing in](help.topic.signing_in#overview).

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
	{
		id: "help.topic.models_and_providers",
		section: "configure",
		title: { de: "Modelle und Anbieter", en: "Models and providers" },
		short: {
			de: "Wie eine Administratorin oder ein Administrator den Modellen Zugang gibt: Schlüssel eintragen, anmelden, testen, entfernen.",
			en: "How an administrator gives the models access: enter a key, sign in, test, remove.",
		},
		body: {
			de: `## Überblick {#overview}

Die Modelle am Tisch kommen von Anbietern wie Anthropic, OpenAI oder Mistral. Jeder Anbieter braucht einen Zugang: einen Schlüssel oder eine Anmeldung mit deinem Konto dort. Unter **Einstellungen → Modelle und Anbieter** gibst du ihn, ohne den Server anzufassen. Das dürfen nur Administratorinnen und Administratoren.

## Wo der Zugang liegt {#where}

Nur der Modell-Prozess ruft Modelle auf, und nur er hält die Zugänge: in einer Datei, die nur er lesen kann. Die Seite und der gemeinsame Space sehen nie einen Schlüssel im Klartext. Was du in ein Feld der Anmeldung tippst, wird schon im Web-Prozess für genau diesen Modell-Prozess und genau diese Frage verschlüsselt und ist nach einer Minute weg, ob er es abgeholt hat oder nicht.

Zugänge aus der Umgebung des Servers (etwa \`ANTHROPIC_API_KEY\`) zeigt die Liste mit ihrer Herkunft. Ändern kann sie nur, wer den Server betreibt.

## Die Liste der Anbieter {#providers}

Oben stehen die Anbieter, die schon Zugang haben, mit seiner Art (Schlüssel oder angemeldet) und Herkunft. Die übrigen liegen in einer Falte darunter; das Suchfeld findet einen nach Namen. Laufen mehrere Modell-Prozesse, hat jeder seine eigene Liste und seine eigenen Zugänge.

## Einen Schlüssel eintragen {#key}

**Schlüssel eintragen** startet die Anmeldung des Anbieters. Sie fragt nacheinander, was sie braucht, meist nur den Schlüssel, manchmal auch eine Region oder ein Konto. Jede Frage erscheint unter dem Anbieter mit einem Feld und **Senden**. Den Schlüssel holst du dir in der Konsole des Anbieters; der Link steht oft schon in der Anmeldung.

## Mit einem Konto anmelden {#signin}

Manche Anbieter erlauben die Anmeldung mit einem Abo oder Konto statt eines Schlüssels. Die Anmeldung zeigt dann einen Link zum Öffnen, manchmal einen Code, den du dort eingibst, und fragt am Ende nach dem Code, den dir der Anbieter zeigt. Das geht auch vom Telefon: nichts muss auf dem Rechner des Modell-Prozesses geöffnet werden. Eine Anmeldung, die zehn Minuten keine Antwort bekommt, endet von selbst. **Abbrechen** beendet sie sofort.

## Eine Frage beantworten {#answer}

Was du in ein Feld der Anmeldung schreibst, geht verschlüsselt an den Modell-Prozess, der gefragt hat. Ein Tippfehler ist kein Problem: Die Anmeldung meldet, dass sie nicht geklappt hat, und du beginnst sie neu. Die Meldung wiederholt nie, was du eingegeben hast.

## Testen {#test}

**Testen** schickt einem Modell des Anbieters eine Frage von ein paar Tokens und zeigt, ob und wie schnell es antwortet. So merkst du ein abgelaufenes Konto vor einem Lauf und nicht mittendrin. Der Test kostet ein paar Tokens und zählt wie jeder Aufruf. Wenn Modellaufrufe im Prozess aus sind (\`FORUM_LLM\`), kannst du dich anmelden, aber nicht testen.

## Entfernen {#remove}

**Entfernen** löscht einen Zugang, den eine Anmeldung auf der Seite angelegt hat. Zugänge aus der Umgebung des Servers bleiben.

## Erlaubte Modelle {#allowed}

Nicht jedes Modell mit Zugang soll mitarbeiten. Unter **Erlaubte Modelle** hakst du die an, die Räume für ihre Läufe wählen dürfen, und schaltest die Modell-Agenten insgesamt an oder aus. Ohne eigene Wahl gilt, was \`FORUM_MODELS\` nennt. Wie viel die erlaubten Modelle verbrauchen dürfen, steht in [Budgets und Grenzen](help.topic.budgets_and_limits#overview).

## Wer was sieht {#audit}

Jede Anmeldung, jedes Entfernen, jeder Test und jede geänderte Grenze wird mit Name und Zeit vermerkt, nie mit einem Schlüssel.`,
			en: `## Overview {#overview}

The models at the table come from providers such as Anthropic, OpenAI or Mistral. Each provider needs access: a key, or a sign-in with your account there. Under **Settings → Models and providers** you give it without touching the server. Only administrators may.

## Where the access is kept {#where}

Only the model process calls models, and only it holds the access: in a file only it can read. The page and the shared space never see a key in the clear. What you type into a field of a login is encrypted in the web process for exactly that model process and that question, and is gone after a minute whether it was fetched or not.

Access from the server's environment (such as \`ANTHROPIC_API_KEY\`) is listed with where it comes from. Only the person who runs the server can change it.

## The list of providers {#providers}

At the top are the providers that already have access, with its kind (key or signed in) and where it comes from. The others are in a fold below; the search field finds one by name. When several model processes run, each has a list and access of its own.

## Entering a key {#key}

**Enter a key** starts the provider's login. It asks for what it needs one after the other, mostly just the key, sometimes a region or an account as well. Each question appears below the provider with a field and **Send**. You get the key from the provider's console; the login often shows the link.

## Signing in with an account {#signin}

Some providers let you sign in with a subscription or account instead of a key. The login then shows a link to open, sometimes a code to enter there, and at the end asks for the code the provider shows you. This works from a phone too: nothing needs to be opened on the model process's machine. A login that gets no answer for ten minutes ends by itself. **Cancel** ends it at once.

## Answering a question {#answer}

What you write into a field of a login goes encrypted to the model process that asked. A typing mistake does no harm: the login says it failed and you start it again. The message never repeats what you typed.

## Testing {#test}

**Test** sends one of the provider's models a question of a few tokens and shows whether and how quickly it answers. So you notice an expired account before a run, not in the middle of one. The test costs a few tokens and counts like every call. When model calls are off in the process (\`FORUM_LLM\`), you can sign in but not test.

## Removing {#remove}

**Remove** deletes access that a login on the page created. Access from the server's environment stays.

## Allowed models {#allowed}

Not every model with access should take part. Under **Allowed models** you tick those rooms may choose for their runs, and turn the model agents on or off as a whole. Without a choice of your own, \`FORUM_MODELS\` decides. How much the allowed models may use is in [Budgets and limits](help.topic.budgets_and_limits#overview).

## Who sees what {#audit}

Every login, removal, test and changed limit is recorded with a name and a time, never with a key.`,
		},
	},
	{
		id: "help.topic.budgets_and_limits",
		section: "configure",
		title: { de: "Budgets und Grenzen", en: "Budgets and limits" },
		short: {
			de: "Wie viel Modellaufrufe kosten dürfen: die Grenzen des Betriebs, die der Verwaltung, die Voreinstellungen eines Raums und ein einzelner Lauf.",
			en: "How much model calls may cost: the operator's limits, the administrators', a room's defaults and a single run.",
		},
		body: {
			de: `## Überblick {#overview}

Jeder Modellaufruf kostet Tokens und damit Geld. Vier Stufen begrenzen das, jede innerhalb der darüber:

1. **Der Betrieb** legt in der Umgebung des Servers die Obergrenzen fest. Die Seite kann sie nicht überschreiten.
2. **Die Verwaltung** setzt auf der Seite engere Grenzen für alle.
3. **Die Besitzerin oder der Besitzer eines Raums** setzt Voreinstellungen für die Läufe dort.
4. **Wer einen Lauf startet**, wählt Modelle und Budget innerhalb dessen, was der Raum erlaubt.

## Die Grenzen der Verwaltung {#limits}

Unter **Einstellungen → Grenzen** stehen vier Werte, jeder mit der Obergrenze des Betriebs daneben und dem, was gerade gilt:

| Wert | Bedeutung |
|---|---|
| Modellaufrufe pro Minute | alle Modell-Prozesse zusammen; ein voller Takt wartet auf die nächste Minute |
| Modellaufrufe pro Tag | alle zusammen, je Tag (UTC) |
| Tokens pro Person und Tag | was die Läufe einer Person an einem Tag zusammen verbrauchen dürfen |
| Größtes Budget eines Laufs | das Höchste, was der Lauf eines Mitglieds verlangen kann |

Ein leeres Feld heißt: es gilt die Grenze des Betriebs. Ein Wert darüber wird abgelehnt.

## Die Obergrenzen des Betriebs {#ceilings}

Sie stehen in der \`.env\` des Servers: \`FORUM_LLM_PER_MIN\`, \`FORUM_LLM_PER_DAY\`, \`FORUM_TOKENS_PER_IP_DAY\`, \`FORUM_RUN_BUDGET_TOKENS\` und \`FORUM_PERSON_WAIT_S\`. Senkt der Betrieb eine davon später, gilt ein höherer Wert der Seite nur noch bis zur neuen Grenze.

## Die Voreinstellungen eines Raums {#room}

Wem ein Raum gehört, der findet am Tisch die Falte **Voreinstellungen des Raums**: die Modelle (drei bis fünf), die Arbeitsweise, die Runden, die Agenten je Modell, das Budget eines Laufs und wie lange der Tisch auf dich wartet. Ein neuer Lauf übernimmt sie, solange niemand etwas anderes wählt. Das Budget ist zugleich das Höchste, was ein Mitglied für einen Lauf verlangen kann. Jede Änderung steht als Zeile im Raum.

## Ein einzelner Lauf {#run}

Beim Start eines Laufs wählst du die Modelle und das Budget. Ein Lauf endet, sobald sein Budget verbraucht ist; der Plan bleibt in dem Stand, den er bis dahin hat.

## Was ein Test kostet {#test}

Der Test eines Anbieters ([Modelle und Anbieter](help.topic.models_and_providers#test)) kostet ein paar Tokens und zählt bei den Aufrufen mit, nicht beim Budget einer Person.`,
			en: `## Overview {#overview}

Every model call costs tokens, and so money. Four levels limit that, each within the one above:

1. **The operator** sets the ceilings in the server's environment. The page cannot go above them.
2. **The administrators** set tighter limits for everyone on the page.
3. **A room's owner** sets defaults for the runs there.
4. **Whoever starts a run** chooses models and budget within what the room allows.

## The administrators' limits {#limits}

Under **Settings → Limits** are four values, each with the operator's ceiling beside it and what is in force now:

| Value | Meaning |
|---|---|
| Model calls per minute | all model processes together; a full minute waits for the next |
| Model calls per day | all together, per day (UTC) |
| Tokens per person and day | what one person's runs may use together in a day |
| Largest budget of a run | the most a member's run may ask for |

An empty field means the operator's limit applies. A value above it is refused.

## The operator's ceilings {#ceilings}

They are in the server's \`.env\`: \`FORUM_LLM_PER_MIN\`, \`FORUM_LLM_PER_DAY\`, \`FORUM_TOKENS_PER_IP_DAY\`, \`FORUM_RUN_BUDGET_TOKENS\` and \`FORUM_PERSON_WAIT_S\`. If the operator lowers one later, a higher value from the page only counts up to the new ceiling.

## A room's defaults {#room}

A room's owner finds the fold **The room's defaults** at the table: the models (three to five), the way of working, the rounds, the agents per model, a run's budget and how long the table waits for you. A new run takes them as long as nobody chooses otherwise. The budget is also the most a member may ask for in one run. Every change is a line in the room.

## A single run {#run}

When you start a run you choose the models and the budget. A run ends as soon as its budget is used up; the plan stays as far as it got.

## What a test costs {#test}

Testing a provider ([Models and providers](help.topic.models_and_providers#test)) costs a few tokens and counts among the calls, not against a person's budget.`,
		},
	},
];

export const articleById = (id: string): Article | undefined => ARTICLES.find((a) => a.id === id);
export const DEFAULT_ARTICLE = "help.topic.forum";

/** The words of "Words used here" (help.topic.words), by their anchor there, with the forms each language uses. */
export const WORDS: Record<string, { de: string[]; en: string[] }> = {
	room: { de: ["Raum", "Raums", "Räume", "Räumen"], en: ["room", "rooms"] },
	workspace: { de: ["Workspace", "Workspaces"], en: ["workspace", "workspaces"] },
	folder: { de: ["Ordner", "Ordners", "Ordnern"], en: ["folder", "folders"] },
	grant: { de: ["Freigabe", "Freigaben"], en: ["grant", "grants"] },
	table: { de: ["Tisch", "Tische", "Tisches", "Tischen"], en: ["table", "tables"] },
	model: { de: ["Modell", "Modelle", "Modells", "Modellen"], en: ["model", "models"] },
	brief: { de: ["Auftrag", "Aufträge", "Auftrags", "Aufträgen"], en: ["brief", "briefs"] },
	version: { de: ["Fassung", "Fassungen"], en: ["version", "versions"] },
	objection: { de: ["Einwand", "Einwände", "Einwands", "Einwänden"], en: ["objection", "objections"] },
	budget: { de: ["Budget", "Budgets"], en: ["budget", "budgets"] },
};

/** H2 headings with their {#anchor}, for the table of contents. */
export function tocOf(markdown: string): { id: string; title: string }[] {
	return [...markdown.matchAll(/^##\s+(.+?)\s+\{#([a-z0-9._-]+)\}\s*$/gm)].map((m) => ({ title: m[1]!, id: m[2]! }));
}
