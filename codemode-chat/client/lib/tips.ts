// Short field help for the "?" buttons next to the controls (DE/EN). Each tip links to the help section that
// explains the field in full.
import type { Lang } from "./theme.ts";

export type TipId = "task" | "fn" | "prompt" | "cases" | "verify" | "agents" | "gens" | "per" | "polish" | "contenders" | "start" | "code" | "board" | "standings" | "best";
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
			de: "Gegen diese Fälle prüft die Sandbox jeden Beitrag. JSON oder einfacher Text, eine Zeile je Fall: „5 -> 120“, „3 4 -> 12“, „[3,1,2] -> [1,2,3]“ oder „Ergebnis: 0 1 4 9 11“ (ohne Eingabe). Mehrere richtige Ergebnisse: „4 -> 2 oder -2“. 1 bis 50 Fälle. Die Agenten sehen die Fälle.",
			en: "The sandbox checks every contribution against these cases. JSON or plain text, one line per case: \"5 -> 120\", \"3 4 -> 12\", \"[3,1,2] -> [1,2,3]\" or \"Result: 0 1 4 9 11\" (no input). Several right results: \"4 -> 2 or -2\". 1 to 50 cases. The agents see the cases.",
		},
		article: "help.topic.tasks_and_blocks", anchor: "custom",
	},
	verify: {
		text: {
			de: "Für Aufgaben mit mehreren richtigen Antworten. Ein Prüfer-Agent liest Beschreibung und Beispiele und schreibt daraus eine Prüfregel; sie muss deine Beispiele annehmen und offensichtlich falsche Ergebnisse ablehnen, sonst schreibt er sie neu. Ohne Haken zählen nur die angegebenen Ergebnisse (mehrere mit „oder“).",
			en: "For tasks with more than one right answer. A verifier agent reads the description and the examples and writes a check rule from them; it must accept your examples and reject obviously wrong results, or the agent writes it again. Without the tick only the given results count (several with \"or\").",
		},
		article: "help.topic.tasks_and_blocks", anchor: "check",
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
			de: "Höchstens so viele Runden (1 bis 10). Jede Generation sieht alle bisherigen Versuche mit ihren Testergebnissen und die Notizen des Teams. Ist die Aufgabe gelöst, endet der Lauf nach den Verbesserungsrunden früher.",
			en: "At most this many rounds (1 to 10). Every generation sees all attempts so far with their test results and the team's notes. Once the task is solved, the run ends earlier, after the improvement rounds.",
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
	polish: {
		text: {
			de: "Wie viele Generationen nach der ersten korrekten Lösung noch weiterlaufen, um sie schneller oder einfacher zu machen (0 bis 3). 0: der Lauf endet, sobald die Aufgabe gelöst ist.",
			en: "How many generations still run after the first correct solution, to make it faster or simpler (0 to 3). 0: the run ends as soon as the task is solved.",
		},
		article: "help.topic.runs_and_contenders", anchor: "teamwork",
	},
	contenders: {
		text: {
			de: "Wer im Lauf mitarbeitet, bis zu vier gleichzeitig: Skript-Agenten (zufällige Varianten aus dem Katalog, kostenlos) und Modell-Agenten. Mehrere Modelle arbeiten zusammen und bauen auf den Versuchen der anderen auf. Eigene Aufgaben brauchen ein Modell.",
			en: "Who works in the run, up to four at once: scripted agents (random catalog variants, free) and model agents. Several models work together and build on each other's attempts. Custom tasks need a model.",
		},
		article: "help.topic.runs_and_contenders", anchor: "contenders",
	},
	start: {
		text: {
			de: "Legt einen neuen Aufgabenblock an (wenn die gewählte Aufgabe noch nicht aktiv ist) und startet den Lauf. Er endet, wenn die Aufgabe gelöst ist und die Verbesserungsrunden vorbei sind, spätestens nach der höchsten Zahl Generationen oder mit „Stoppen“; eigener Code zählt auch danach noch.",
			en: "Creates a new task block (when the chosen task is not active yet) and starts the run. It ends once the task is solved and the improvement rounds are over, at the latest after the maximum number of generations or with \"Stop\"; your own code still counts afterwards.",
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
			de: "Was jeder Teilnehmer im gewählten Block beigetragen hat: korrekte von bewerteten Beiträgen und die beste Zeit.",
			en: "What each contender contributed in the selected block: correct out of judged contributions and the best time.",
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
