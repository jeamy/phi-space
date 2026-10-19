// Short field help for the "?" buttons next to the controls (DE/EN). Each tip links to the help section that
// explains the field in full.
import type { Lang } from "./theme.ts";

export type TipId = "task" | "fn" | "prompt" | "cases" | "agents" | "gens" | "per" | "contenders" | "start" | "code" | "board" | "standings" | "best";
type Tip = { text: Record<Lang, string>; article: string; anchor: string };

export const TIPS: Record<TipId, Tip> = {
	task: {
		text: {
			de: "Wähle eine Katalogaufgabe (Primzahlen, Fibonacci, Sortieren, ggT) oder „Eigene Aufgabe …“. Jede neu gestartete Aufgabe wird ein eigener Block im Chat mit eigener Rangliste.",
			en: "Pick a catalog task (primes, Fibonacci, sorting, gcd) or \"Custom task …\". Every task you start becomes its own block in the chat with its own leaderboard.",
		},
		article: "help.topic.tasks_and_blocks", anchor: "catalog",
	},
	fn: {
		text: {
			de: "Name der Funktion, die jeder Beitrag definieren muss, z. B. „Golomb“. Beginnt mit Buchstabe, _ oder $, danach auch Ziffern; höchstens 41 Zeichen.",
			en: "Name of the function every contribution must define, e.g. \"Golomb\". Starts with a letter, _ or $, then digits too; at most 41 characters.",
		},
		article: "help.topic.tasks_and_blocks", anchor: "custom",
	},
	prompt: {
		text: {
			de: "Was soll die Funktion tun? Diesen Text bekommen die Modell-Agenten als Aufgabe. Je genauer (Eingaben, Ausgabe, Grenzfälle), desto besser der Code.",
			en: "What should the function do? The model agents receive this text as their task. The more precise (inputs, output, edge cases), the better the code.",
		},
		article: "help.topic.tasks_and_blocks", anchor: "custom",
	},
	cases: {
		text: {
			de: "Gegen diese Fälle prüft die Sandbox jeden Beitrag. JSON oder einfacher Text, eine Zeile je Fall: „5 -> 120“, „3 4 -> 12“, „[3,1,2] -> [1,2,3]“ oder „Ergebnis: 0 1 4 9 11“ (ohne Eingabe). 1 bis 50 Fälle.",
			en: "The sandbox checks every contribution against these cases. JSON or plain text, one line per case: \"5 -> 120\", \"3 4 -> 12\", \"[3,1,2] -> [1,2,3]\" or \"Result: 0 1 4 9 11\" (no input). 1 to 50 cases.",
		},
		article: "help.topic.tasks_and_blocks", anchor: "custom",
	},
	agents: {
		text: {
			de: "Wie viele Agenten im Lauf Code schreiben (0 bis 8). Sie werden reihum auf die Teilnehmer verteilt. Mit 0 wird nur der Aufgabenblock angelegt, den Code reichst du selbst ein.",
			en: "How many agents write code in the run (0 to 8). They are assigned to the contenders in turn. With 0 only the task block is created and you hand in the code yourself.",
		},
		article: "help.topic.runs_and_contenders", anchor: "settings",
	},
	gens: {
		text: {
			de: "Runden des Laufs (1 bis 6). Jede Generation sieht den bisher besten Code des Blocks und versucht ihn zu schlagen.",
			en: "Rounds of the run (1 to 6). Every generation sees the best code of the block so far and tries to beat it.",
		},
		article: "help.topic.runs_and_contenders", anchor: "settings",
	},
	per: {
		text: {
			de: "Wie viele Beiträge jeder Agent pro Generation liefert (1 bis 3). Mehr Beiträge kosten bei Modell-Agenten mehr Aufrufe.",
			en: "How many contributions each agent delivers per generation (1 to 3). More contributions cost model agents more calls.",
		},
		article: "help.topic.runs_and_contenders", anchor: "settings",
	},
	contenders: {
		text: {
			de: "Wer im Lauf antritt, bis zu vier gleichzeitig: Skript-Agenten (zufällige Varianten aus dem Katalog, kostenlos) und Modell-Agenten. Mehrere Haken = sie treten gegeneinander an. Eigene Aufgaben brauchen ein Modell.",
			en: "Who competes in the run, up to four at once: scripted agents (random catalog variants, free) and model agents. Several ticks = they compete against each other. Custom tasks need a model.",
		},
		article: "help.topic.runs_and_contenders", anchor: "contenders",
	},
	start: {
		text: {
			de: "Legt einen neuen Aufgabenblock an (wenn die gewählte Aufgabe noch nicht aktiv ist) und startet den Lauf. Der Lauf endet nach der letzten Generation oder mit „Stoppen“; eigener Code zählt auch danach noch.",
			en: "Creates a new task block (when the chosen task is not active yet) and starts the run. The run ends after the last generation or with \"Stop\"; your own code still counts afterwards.",
		},
		article: "help.topic.runs_and_contenders", anchor: "ending",
	},
	code: {
		text: {
			de: "Reiche eigenen Code für den aktiven Block ein. Er muss die Funktion mit dem angezeigten Namen definieren und läuft in derselben Sandbox wie der Code der Agenten (5 s, 64 MiB, kein Netz).",
			en: "Hand in your own code for the active block. It must define the function with the name shown and runs in the same sandbox as the agents' code (5 s, 64 MiB, no network).",
		},
		article: "help.topic.runs_and_contenders", anchor: "human",
	},
	board: {
		text: {
			de: "Die schnellsten korrekten Beiträge des gewählten Blocks. Gemessen wird die Laufzeit über alle Testfälle; bei Gleichstand gewinnt der frühere Beitrag.",
			en: "The fastest correct contributions of the selected block. Time is measured over all test cases; on a tie the earlier contribution wins.",
		},
		article: "help.topic.judging_and_sandbox", anchor: "verdict",
	},
	standings: {
		text: {
			de: "Vergleich der Teilnehmer im gewählten Block: korrekte Beiträge von bewerteten und die beste Zeit je Teilnehmer.",
			en: "Comparison of the contenders in the selected block: correct contributions out of judged ones and the best time per contender.",
		},
		article: "help.topic.runs_and_contenders", anchor: "contenders",
	},
	best: {
		text: {
			de: "Der Code des Siegers im gewählten Block. Ein Klick auf einen anderen Block zeigt dessen besten Code. ▶ Ausführen lässt ihn in der Sandbox laufen, mit Konsole und Stop.",
			en: "The winner's code in the selected block. Click another block to see its best code. ▶ Run runs it in the sandbox, with a console and Stop.",
		},
		article: "help.topic.judging_and_sandbox", anchor: "verdict",
	},
};
