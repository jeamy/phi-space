// Short help for the "?" buttons beside the controls, German and English (docs/forum-seite-plan-2026-11-26.en.md,
// section 11). Each tip links to the help section that explains the control in full; tests/help.test.ts holds every
// tip to both languages, an existing article and anchor, and a use in the page.
import type { Lang } from "./theme.ts";

export type TipId = "signin" | "name" | "signout" | "rooms" | "newroom" | "invite" | "yourid"
	| "files" | "table" | "plan" | "panes" | "task" | "brief" | "doclang" | "outline" | "criteria" | "docs"
	| "models" | "way" | "rounds" | "budget" | "start" | "stop" | "answer" | "say"
	| "version" | "compare" | "accept" | "object" | "tableview" | "language" | "mode" | "palette";
type Tip = { text: Record<Lang, string>; article: string; anchor: string };

export const TIPS: Record<TipId, Tip> = {
	signin: {
		text: {
			de: "Du meldest dich beim Anmeldedienst an, nicht beim Forum selbst. Dasselbe Konto gilt auch für die Dateien.",
			en: "You sign in at the sign-in service, not at the forum itself. The same account also serves the files.",
		},
		article: "help.topic.signing_in", anchor: "account",
	},
	name: {
		text: {
			de: "So sehen dich die anderen am Tisch und in der Liste der Personen eines Raums. Du kannst ihn jederzeit ändern.",
			en: "This is how the others see you at the table and in a room's list of people. You can change it at any time.",
		},
		article: "help.topic.signing_in", anchor: "name",
	},
	signout: {
		text: {
			de: "Beendet deine Sitzung hier und beim Anmeldedienst. Beim nächsten Mal fragt er wieder nach deinem Passwort.",
			en: "Ends your session here and at the sign-in service. Next time it asks for your password again.",
		},
		article: "help.topic.signing_in", anchor: "signout",
	},
	rooms: {
		text: {
			de: "Die Räume, in denen du eine Rolle hast: Besitz, Mitglied oder mitlesend. Andere Räume gibt es für dich nicht.",
			en: "The rooms in which you have a role: owner, member or reading along. Other rooms do not exist for you.",
		},
		article: "help.topic.signing_in", anchor: "rooms",
	},
	newroom: {
		text: {
			de: "Ein neuer Raum gehört dir. Sein Name besteht aus Buchstaben, Ziffern, Punkten und Bindestrichen und ist für alle eindeutig.",
			en: "A new room belongs to you. Its name is made of letters, digits, dots and dashes and is unique for everyone.",
		},
		article: "help.topic.signing_in", anchor: "rooms",
	},
	invite: {
		text: {
			de: "Gib die ID der Person ein, die sie dir aus ihrem Menü nennt. Mitglieder schreiben im Raum mit, Mitlesende sehen nur zu.",
			en: "Enter the person's ID, which they read to you from their menu. Members write in the room, readers only watch.",
		},
		article: "help.topic.signing_in", anchor: "invite",
	},
	yourid: {
		text: {
			de: "Diese ID gibst du jemandem, der dich in einen Raum einladen will. Sie verrät weder Namen noch Adresse.",
			en: "You give this ID to someone who wants to invite you to a room. It tells neither your name nor your address.",
		},
		article: "help.topic.signing_in", anchor: "invite",
	},
	files: {
		text: {
			de: "Das Material der gezeigten Aufgabe: die Dokumente, die du ihr mitgegeben hast. Die Modelle lesen nur darin.",
			en: "The material of the task shown: the documents you gave it. The models read only in these.",
		},
		article: "help.topic.forum", anchor: "panes",
	},
	table: {
		text: {
			de: "Hier arbeiten die Modelle: Aufgaben, Läufe, ihre Diskussion und ihre Fragen an dich.",
			en: "Here the models work: tasks, runs, their discussion and their questions to you.",
		},
		article: "help.topic.forum", anchor: "panes",
	},
	plan: {
		text: {
			de: "Das Dokument, das am Tisch entsteht, Fassung für Fassung, mit Einwänden und Abstimmungen.",
			en: "The document the table writes, version by version, with objections and ballots.",
		},
		article: "help.topic.forum", anchor: "panes",
	},
	panes: {
		text: {
			de: "Auf dem Telefon siehst du einen Bereich auf einmal; hier wechselst du zwischen Dateien, Tisch und Plan.",
			en: "On a phone you see one part at a time; here you switch between files, table and plan.",
		},
		article: "help.topic.phone", anchor: "tabs",
	},
	task: {
		text: {
			de: "Ein Raum kann mehrere Aufgaben haben. Wähle, welche du siehst; Tisch und Plan zeigen dann deren Stand.",
			en: "A room can hold several tasks. Choose the one you see; table and plan then show its state.",
		},
		article: "help.topic.first_plan", anchor: "brief",
	},
	brief: {
		text: {
			de: "Schreib, wofür der Plan ist und was er leisten muss. Daran messen die Modelle jede Fassung.",
			en: "Write what the plan is for and what it must achieve. The models measure every version against it.",
		},
		article: "help.topic.first_plan", anchor: "brief",
	},
	doclang: {
		text: {
			de: "In dieser Sprache schreiben die Modelle das Dokument, unabhängig von der Sprache der Seite.",
			en: "The models write the document in this language, whatever the language of the page.",
		},
		article: "help.topic.first_plan", anchor: "brief",
	},
	outline: {
		text: {
			de: "Wenn du die Überschriften vorgibst, schreiben die Modelle genau diese Abschnitte. Leer lassen sie die Modelle selbst.",
			en: "If you give the headings, the models write exactly these sections. Left empty, the models choose them.",
		},
		article: "help.topic.first_plan", anchor: "brief",
	},
	criteria: {
		text: {
			de: "Was der Plan auf jeden Fall erfüllen muss, eins je Zeile. Jedes Modell prüft jede Fassung daran.",
			en: "What the plan must meet in any case, one a line. Every model checks every version against them.",
		},
		article: "help.topic.first_plan", anchor: "brief",
	},
	docs: {
		text: {
			de: "Text, den die Modelle lesen dürfen. Auszüge daraus gehen an die Anbieter der gewählten Modelle.",
			en: "Text the models may read. Excerpts of it go to the providers of the chosen models.",
		},
		article: "help.topic.first_plan", anchor: "brief",
	},
	models: {
		text: {
			de: "Mindestens drei verschiedene Modelle; jedes bringt eine eigene Sicht an den Tisch.",
			en: "At least three different models; each brings a view of its own to the table.",
		},
		article: "help.topic.first_plan", anchor: "run",
	},
	way: {
		text: {
			de: "Abwechselnd, gleichzeitig, oder beide Arbeitsweisen gegeneinander mit einem Vergleich am Ende.",
			en: "Taking turns, at the same time, or both ways against each other with a comparison at the end.",
		},
		article: "help.topic.table", anchor: "ways",
	},
	rounds: {
		text: {
			de: "Wie oft die Modelle höchstens überarbeiten und abstimmen, bevor der Lauf endet.",
			en: "How often at most the models revise and vote before the run ends.",
		},
		article: "help.topic.table", anchor: "ways",
	},
	budget: {
		text: {
			de: "So viele Tokens darf der Lauf verbrauchen; ist das Budget aufgebraucht, hält er an.",
			en: "The run may use this many tokens; when the budget is used up, it stops.",
		},
		article: "help.topic.table", anchor: "budget",
	},
	start: {
		text: {
			de: "Die Modelle melden sich, besprechen den Auftrag und beginnen zu schreiben. Der Browser fragt dabei, ob er dir Fragen der Modelle melden darf.",
			en: "The models report, discuss the brief and start writing. The browser asks whether it may tell you about the models' questions.",
		},
		article: "help.topic.first_plan", anchor: "run",
	},
	stop: {
		text: {
			de: "Hält den Lauf sofort an. Was geschrieben ist, bleibt; ein neuer Lauf macht dort weiter.",
			en: "Stops the run at once. What is written stays; a new run goes on from there.",
		},
		article: "help.topic.first_plan", anchor: "run",
	},
	answer: {
		text: {
			de: "Ein Modell fragt dich. Der Tisch wartet eine Weile auf deine Antwort; deine Antwort gilt vor jeder Entscheidung.",
			en: "A model asks you. The table waits a while for your answer; your answer outranks any decision.",
		},
		article: "help.topic.table", anchor: "you",
	},
	say: {
		text: {
			de: "Sag dem Tisch etwas, jederzeit. Die Modelle lesen es vor ihrem nächsten Schritt.",
			en: "Say something to the table, at any time. The models read it before their next step.",
		},
		article: "help.topic.table", anchor: "you",
	},
	version: {
		text: {
			de: "Jede Änderung ergibt eine neue Fassung. Hier liest du eine ältere nach.",
			en: "Every change makes a new version. Here you read an older one.",
		},
		article: "help.topic.plan", anchor: "versions",
	},
	compare: {
		text: {
			de: "Zeigt, was sich gegenüber einer anderen Fassung geändert hat, Zeile für Zeile.",
			en: "Shows what changed against another version, line by line.",
		},
		article: "help.topic.plan", anchor: "compare",
	},
	accept: {
		text: {
			de: "Du nimmst diese Fassung als Ergebnis an, auch ohne Mehrheit der Modelle.",
			en: "You accept this version as the result, even without a majority of the models.",
		},
		article: "help.topic.plan", anchor: "accept",
	},
	object: {
		text: {
			de: "Sag, was an einem Abschnitt nicht stimmt. Ein Einwand von dir kann kein Modell ablehnen.",
			en: "Say what is wrong with a section. No model can decline an objection of yours.",
		},
		article: "help.topic.plan", anchor: "object",
	},
	tableview: {
		text: {
			de: "Haben zwei Tische gearbeitet, wählst du hier das Dokument, oder beide nebeneinander.",
			en: "When two tables worked, you choose the document here, or both side by side.",
		},
		article: "help.topic.plan", anchor: "tables",
	},
	language: {
		text: {
			de: "Die Sprache der Seite. Dein Browser merkt sie sich.",
			en: "The language of the page. Your browser remembers it.",
		},
		article: "help.topic.forum", anchor: "settings",
	},
	mode: {
		text: {
			de: "Helle oder dunkle Seite. Dein Browser merkt es sich.",
			en: "A light or a dark page. Your browser remembers it.",
		},
		article: "help.topic.forum", anchor: "settings",
	},
	palette: {
		text: {
			de: "Die Farben der Seite. Dein Browser merkt sie sich.",
			en: "The colours of the page. Your browser remembers them.",
		},
		article: "help.topic.forum", anchor: "settings",
	},
};
