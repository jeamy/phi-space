// Short help for the "?" buttons beside the controls, German and English (docs/forum-seite-plan-2026-11-26.en.md,
// section 11). Each tip links to the help section that explains the control in full; tests/help.test.ts holds every
// tip to both languages, an existing article and anchor, and a use in the page.
import type { Lang } from "./theme.ts";

export type TipId = "signin" | "name" | "signout" | "rooms" | "newroom" | "invite" | "yourid"
	| "files" | "table" | "plan" | "panes" | "task" | "brief" | "doclang" | "outline" | "criteria" | "docs"
	| "models" | "way" | "rounds" | "budget" | "start" | "stop" | "answer" | "say"
	| "version" | "compare" | "accept" | "object" | "tableview" | "language" | "mode" | "palette"
	| "providers" | "providerkey" | "providersignin" | "loginanswer" | "providertest" | "providerremove" | "allowed" | "limits" | "roomdefaults"
	| "roomlink" | "folders" | "linkcheck" | "fromworkspace" | "workspacefiles" | "pictures" | "picturenote" | "upload" | "filenote"
	| "save" | "saveall" | "savename" | "conflict" | "saveonaccept" | "writesection" | "taskkind" | "roomdocs" | "register" | "refadd" | "refdecide" | "loadback";
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
	providers: {
		text: {
			de: "Die Anbieter dieses Modell-Prozesses; oben die mit Zugang. Das Feld sucht nach Namen.",
			en: "This model process's providers; those with access at the top. The field finds one by name.",
		},
		article: "help.topic.models_and_providers", anchor: "providers",
	},
	providerkey: {
		text: {
			de: "Startet die Anmeldung mit einem Schlüssel. Ihre Fragen erscheinen darunter; der Schlüssel geht verschlüsselt an den Modell-Prozess.",
			en: "Starts the login with a key. Its questions appear below; the key goes encrypted to the model process.",
		},
		article: "help.topic.models_and_providers", anchor: "key",
	},
	providersignin: {
		text: {
			de: "Anmelden mit deinem Konto beim Anbieter: ein Link, vielleicht ein Code, am Ende der Code, den der Anbieter zeigt. Abbrechen beendet die Anmeldung.",
			en: "Signing in with your account at the provider: a link, perhaps a code, at the end the code the provider shows. Cancel ends the login.",
		},
		article: "help.topic.models_and_providers", anchor: "signin",
	},
	loginanswer: {
		text: {
			de: "Deine Antwort auf die Frage der Anmeldung. Sie wird hier verschlüsselt und ist nach einer Minute weg.",
			en: "Your answer to the login's question. It is encrypted here and gone after a minute.",
		},
		article: "help.topic.models_and_providers", anchor: "answer",
	},
	providertest: {
		text: {
			de: "Fragt ein Modell des Anbieters mit ein paar Tokens, ob es antwortet. Braucht eingeschaltete Modellaufrufe.",
			en: "Asks one of the provider's models, with a few tokens, whether it answers. Needs model calls on.",
		},
		article: "help.topic.models_and_providers", anchor: "test",
	},
	providerremove: {
		text: {
			de: "Löscht den Zugang, den eine Anmeldung hier angelegt hat. Zugänge aus der Umgebung des Servers bleiben.",
			en: "Deletes the access a login here created. Access from the server's environment stays.",
		},
		article: "help.topic.models_and_providers", anchor: "remove",
	},
	allowed: {
		text: {
			de: "Welche Modelle die Räume für ihre Läufe wählen dürfen, und ob die Modell-Agenten überhaupt arbeiten.",
			en: "Which models rooms may choose for their runs, and whether the model agents work at all.",
		},
		article: "help.topic.models_and_providers", anchor: "allowed",
	},
	limits: {
		text: {
			de: "Grenzen für alle, innerhalb der Obergrenzen des Betriebs daneben. Leer heißt: die des Betriebs gilt.",
			en: "Limits for everyone, within the operator's ceilings beside them. Empty means the operator's applies.",
		},
		article: "help.topic.budgets_and_limits", anchor: "limits",
	},
	roomdefaults: {
		text: {
			de: "Was ein Lauf in diesem Raum nimmt, wenn niemand anderes wählt. Das Budget ist zugleich das Höchste für ein Mitglied.",
			en: "What a run in this room takes when nobody chooses otherwise. The budget is also the most a member may ask for.",
		},
		article: "help.topic.budgets_and_limits", anchor: "room",
	},
	roomlink: {
		text: {
			de: "Verbindet den Raum über seinen eigenen Agenten mit Ordnern in spaces-files. Was er sieht, entscheiden die Besitzer der Ordner.",
			en: "Links the room to folders in spaces-files through its own agent. What it sees is decided by the folders' owners.",
		},
		article: "help.topic.material", anchor: "link",
	},
	folders: {
		text: {
			de: "Ein Workspace und ein Pfad darin. Lesen gibt es für einen ganzen Workspace oder einen eingeschränkten Ordner.",
			en: "A workspace and a path in it. Viewer applies to a whole workspace or a restricted folder.",
		},
		article: "help.topic.material", anchor: "link",
	},
	linkcheck: {
		text: {
			de: "Fragt spaces-files, was der Agent sieht. Ein Ordner, den er nicht sieht oder der ihm gehört, wird abgelehnt.",
			en: "Asks spaces-files what the agent sees. A folder it does not see, or one it owns, is refused.",
		},
		article: "help.topic.material", anchor: "check",
	},
	fromworkspace: {
		text: {
			de: "Nimmt jetzt eine Kopie der verbundenen Ordner für diese Aufgabe. Auszüge gehen an die Modellanbieter.",
			en: "Takes a copy of the linked folders for this task now. Excerpts go to the model providers.",
		},
		article: "help.topic.material", anchor: "task",
	},
	workspacefiles: {
		text: {
			de: "Die Kopie dieser Aufgabe. Texte lesen die Modelle; andere Dateien kennen sie nur mit Art und Größe.",
			en: "This task's copy. The models read the texts; other files they know only by kind and size.",
		},
		article: "help.topic.material", anchor: "files",
	},
	pictures: {
		text: {
			de: "Fotos oder Skizzen für die Modelle. Die Seite verkleinert sie und entfernt Ort und Kameradaten, bevor sie gesendet werden.",
			en: "Photos or sketches for the models. The page reduces them and removes the place and camera data before they are sent.",
		},
		article: "help.topic.pictures", anchor: "add",
	},
	picturenote: {
		text: {
			de: "Was das Bild zeigt, in Worten. Alle Modelle bekommen diese Beschreibung; deine Korrektur zählt.",
			en: "What the picture shows, in words. Every model gets this description; your correction counts.",
		},
		article: "help.topic.pictures", anchor: "describe",
	},
	upload: {
		text: {
			de: "Legt Dateien in material/ des Projektordners in spaces-files ab, als Agent des Raums. Bis 16 MB je Datei; nichts wird überschrieben.",
			en: "Puts files into material/ of the project folder in spaces-files, as the room's agent. Up to 16 MB a file; nothing is overwritten.",
		},
		article: "help.topic.pictures", anchor: "upload",
	},
	save: {
		text: {
			de: "Schreibt das Dokument dieser Aufgabe als Markdown in den Projektordner, mit dem erzeugten Anhang. Eine geänderte Datei wird nie überschrieben.",
			en: "Writes this task's document as Markdown into the project folder, with the generated appendix. A changed file is never overwritten.",
		},
		article: "help.topic.documents", anchor: "save",
	},
	saveall: {
		text: {
			de: "Speichert jedes Dokument des Raums in seine eigene Datei und das Quellenregister als sources.md. Was nicht gespeichert werden konnte, steht danach in der Liste.",
			en: "Saves every document of the room into a file of its own, and the register of sources as sources.md. What could not be saved is listed afterwards.",
		},
		article: "help.topic.documents", anchor: "save",
	},
	savename: {
		text: {
			de: "Der Name der Datei im Projektordner; .md wird ergänzt. Leer: der Name vom letzten Speichern.",
			en: "The file's name in the project folder; .md is added. Empty: the name of the last save.",
		},
		article: "help.topic.documents", anchor: "save",
	},
	saveonaccept: {
		text: {
			de: "Wird eine Fassung angenommen, von der Mehrheit oder von dir, speichert FORUM sie gleich in den Projektordner. Aus, bis du es einschaltest.",
			en: "When a version is accepted, by the majority or by you, FORUM saves it to the project folder right away. Off until you switch it on.",
		},
		article: "help.topic.documents", anchor: "save",
	},
	taskkind: {
		text: {
			de: "Ein Plan wird an den sieben Kriterien des Forums gemessen. Ein Dokument (Anforderungen, Architektur, Vergleich) an drei allgemeinen und deinen eigenen; es braucht einen Namen, unter dem es gespeichert wird.",
			en: "A plan is held against the forum's seven criteria. A document (requirements, an architecture, a comparison) against three general ones and your own; it needs a name to be saved under.",
		},
		article: "help.topic.documents", anchor: "kinds",
	},
	roomdocs: {
		text: {
			de: "Die Modelle lesen diese Dokumente des Raums so, wie sie jetzt sind: die angenommene Fassung, sonst den neuesten Entwurf. Spätere Fassungen ändern die Kopie nicht.",
			en: "The models read these documents of the room as they are now: the accepted version, else the newest draft. Later versions do not change the copy.",
		},
		article: "help.topic.documents", anchor: "room",
	},
	loadback: {
		text: {
			de: "Liest die gespeicherte Datei aus dem Projektordner. Ist sie neuer als das letzte Speichern, wird ihr Text eine neue Fassung: Abschnitte nach ihren Überschriften, ohne Anhang, mit dir als Autor. Ein Lauf macht danach mit diesem Text weiter.",
			en: "Reads the saved file from the project folder. If it is newer than the last save, its text becomes a new version: sections by their headings, without the appendix, with you as author. A run then goes on from that text.",
		},
		article: "help.topic.documents", anchor: "load",
	},
	register: {
		text: {
			de: "Jede Quelle, die eine Aufgabe liest, kommt als Vorschlag ins Register. Daneben steht, welche Abschnitte sie zitieren. Ein Mitglied nimmt eine Quelle an oder lehnt sie mit Grund ab. Mit „Alle speichern“ wird das Register als sources.md gespeichert.",
			en: "Every source a task reads comes into the register as proposed, with the sections that cite it. A member accepts it, or declines it with the reason. Save all writes the register as sources.md.",
		},
		article: "help.topic.documents", anchor: "register",
	},
	refadd: {
		text: {
			de: "Eine Quelle von Hand: ihre Adresse (https://…), ein Titel und wofür sie da ist. Dieselbe Adresse zweimal bleibt ein Eintrag.",
			en: "A source by hand: its address (https://…), a title and what it is for. The same address twice stays one entry.",
		},
		article: "help.topic.documents", anchor: "register",
	},
	refdecide: {
		text: {
			de: "Angenommen heißt: Diese Quelle darf eine Aussage tragen. Ein Ablehnen braucht den Grund, etwa veraltet, Lizenz unklar oder sagt etwas anderes. Die Lizenz trägst du ein, soweit du sie gefunden hast.",
			en: "Accepted means this source may carry a claim. Declining needs the reason: out of date, licence unclear, says something else. Enter the licence as far as you found it.",
		},
		article: "help.topic.documents", anchor: "register",
	},
	writesection: {
		text: {
			de: "Du schreibst den Abschnitt selbst. Er wird eine neue Fassung mit dir als Autor; ein Modell, das ihn danach überarbeitet, bekommt deinen Text.",
			en: "You write the section yourself. It becomes a new version with you as its author; a model that revises it later gets your text.",
		},
		article: "help.topic.documents", anchor: "people",
	},
	conflict: {
		text: {
			de: "Die Datei im Workspace wurde seit dem letzten Speichern geändert. Beide Texte stehen hier; nichts wurde überschrieben.",
			en: "The file in the workspace was changed since the last save. Both texts are here; nothing was overwritten.",
		},
		article: "help.topic.documents", anchor: "conflict",
	},
	filenote: {
		text: {
			de: "Die Modelle lesen diese Datei nicht. Sie bekommen ihren Namen, ihre Art und Größe und diese Notiz.",
			en: "The models do not read this file. They get its name, kind and size, and this note.",
		},
		article: "help.topic.pictures", anchor: "other",
	},
};
