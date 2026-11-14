// Task catalog: what the agents are asked to write, how a contribution is checked (cases) and timed (bench), and a few
// hand-written variants that the scripted (model-free) agents hand in. All code here runs only in the sandbox.
import { MAX_CHECK_CHARS, maxTimeoutMs } from "./judge.ts";
import { arenaAddress, describeBotTools, MAX_BOT_CALLS, type BotSpec } from "./bottask.ts";
import { describeHarnessTools, type HarnessSpec } from "./harnesstask.ts";
import { ANLEGER_EPISODES, ANLEGER_FIRE, ANLEGER_PLANS, ANLEGER_VARIANTS, episodeList, ISLAND_EPISODES, ISLAND_MAP, ISLAND_MEMORY_VARIANTS, ISLAND_VARIANTS } from "./island.ts";
import { checkSpec, dataToolSpec, describeDataTools, type DataItem, type DataSpec } from "./datatask.ts";
import { describeTools, FRUSTRATION, MAX_CALLS, PI_SOURCE, PI_WINDOWS, PI_WINDOWS_BUGS, type ToolSpec } from "./tooltask.ts";

/** One test call. `expect` is the exact result, `expectAny` several results that are all right ("[0,1,4,9,11] oder
 *  [0,2,7,10,11]"); a task with a check rule may give neither (the rule decides). */
export type Case = { args: unknown[]; expect?: unknown; expectAny?: unknown[] };
export type Task = {
	id: string;
	title: { de: string; en: string };
	fn: string;
	prompt: { de: string; en: string };
	cases: Case[];
	/** Sandbox statements timed by the judge (they call `fn` by name and leave their result in `__out`); may also
	 *  `return { ok: false, error }` early. */
	bench: string;
	/** What `__out` must equal after the bench (computed here, compared outside the timed part); omitted: not checked. */
	benchExpect?: unknown;
	/** Optional sandbox expression for the bench input, evaluated BEFORE the contribution runs; the bench reads it as `__in`. */
	benchInput?: string;
	variants: string[];
	/** Custom tasks: a JavaScript predicate `(result, args) => boolean` that decides a case instead of `expect`, for
	 *  tasks with more than one right answer. Runs in its own sandbox on the JSON results. */
	check?: string;
	/** Who wrote the check rule: the verifier agent (from the description and the examples) or the API caller. */
	checkBy?: "verifier" | "user";
	/** Custom tasks: the time a contribution has for its cases and the bench (default: the judge's 5 s). */
	timeoutMs?: number;
	/** "text": a question whose answer is a text, judged by agents against `criteria` (no code, no sandbox). */
	kind?: "code" | "text" | "tools" | "bot" | "harness";
	/** "tools": the tools and data of the sandbox (tooltask.ts); the one case is the sample world's answer. */
	tools?: ToolSpec;
	/** "bot": what the bot must reach in its world of its own (bottask.ts, the arena of spaces-mmo). */
	bot?: BotSpec;
	/** A long run that survives its judge (durable-run.ts): every tool answer is logged, a judge that takes over replays
	 *  them and goes on. Bot tasks only. */
	durable?: true;
	/** An uploaded data task (datatask.ts): its spec without the holdout, so it can be stored and handed on. */
	data?: DataSpec;
	/** "harness": the implementations a judging script rates, shown and hidden (harnesstask.ts). */
	harness?: HarnessSpec;
	/** What happens behind the task, for the people on the page only (never in an agent's prompt): where the data
	 *  comes from, whether models are needed, what a tool does in the background. */
	about?: { de: string; en: string };
	criteria?: string[];
	/** Who wrote the criteria: the person (the optional field) or the verifier agent (when it was empty). */
	criteriaBy?: "user" | "verifier";
};

export const isText = (t: Task): boolean => t.kind === "text";
export const isBot = (t: Task): t is Task & { bot: BotSpec } => t.kind === "bot" && !!t.bot;
export const isHarness = (t: Task): t is Task & { harness: HarnessSpec } => t.kind === "harness" && !!t.harness;
export const isTools = (t: Task): t is Task & { tools: ToolSpec } => t.kind === "tools" && !!t.tools;

/** A text task: a question (up to 2000 characters) and 0 to 12 criteria of a good answer (one line each). */
export function textTask(x: { prompt: unknown; criteria?: unknown; criteriaBy?: unknown }): Task {
	const prompt = typeof x.prompt === "string" ? x.prompt.trim() : "";
	if (!prompt || prompt.length > 2000) throw new Error("A text task needs a question of 1 to 2000 characters");
	const raw = Array.isArray(x.criteria) ? x.criteria : typeof x.criteria === "string" ? x.criteria.split(/\r?\n/) : [];
	const criteria = raw.map((c) => String(c).replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean);
	if (criteria.length > 12 || criteria.some((c) => c.length > 200)) throw new Error("At most 12 criteria of up to 200 characters");
	return { id: "text", kind: "text", fn: "answer", title: { de: "Textaufgabe", en: "Text task" }, prompt: { de: prompt, en: prompt }, cases: [], bench: "", variants: [], criteria, ...(criteria.length ? { criteriaBy: x.criteriaBy === "verifier" ? "verifier" as const : "user" as const } : {}) };
}

/** The spec a text task is stored as (CodeTask). */
export const textSpec = (t: Task) => ({ prompt: t.prompt.en, criteria: t.criteria ?? [], ...(t.criteriaBy ? { criteriaBy: t.criteriaBy } : {}) });

const primes = (n: number) => { const p: number[] = []; for (let c = 2; p.length < n; c++) if (p.every((d) => d * d > c || c % d !== 0)) p.push(c); return p; };
const fibs = (n: number) => { let a = 0, b = 1; for (let i = 0; i < n; i++) [a, b] = [b, a + b]; return a; };
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcg = (seed: number) => () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % 100000;
const sampleArrays = (() => { const r = lcg(7); return [[], [1], [3, 1, 2], [10, 9, 100, -5, 0, 2, 2], Array.from({ length: 40 }, r)]; })();
const sortInput = (() => { const r = lcg(11); return Array.from({ length: 4000 }, r); })(); // the sandbox builds the same numbers
const gcdSum = (() => { let x = 0; for (let i = 1; i < 3000; i++) x += gcd(1000003 * i, 999983 * (i + 7)); return x; })();

/** The sort functions the harness task rates: good and bad, some hidden. The hard-coded ones know the cases of "Sort
 *  numbers" by heart; the slow ones are right but quadratic (hundreds of ms for 2000 numbers in QuickJS, against 5 to 30). */
const SORT_HARNESS: HarnessSpec = {
	target: "sortNumbers", runMs: 3000,
	good: [{ label: "the reference (built-in sort)", source: `function sortNumbers(a){return [...a].sort((x,y)=>x-y)}` }],
	bad: [
		{ label: "sorts as text", source: `function sortNumbers(a){return [...a].sort()}` },
		{ label: "knows the examples by heart", source: `const T=${JSON.stringify(Object.fromEntries(sampleArrays.map((a) => [JSON.stringify(a), [...a].sort((x, y) => x - y)])))};function sortNumbers(a){return T[JSON.stringify(a)]??[...a]}` },
		{ label: "bubble sort", source: `function sortNumbers(a){const b=[...a];for(let i=0;i<b.length;i++)for(let j=0;j<b.length-1-i;j++)if(b[j]>b[j+1]){const t=b[j];b[j]=b[j+1];b[j+1]=t}return b}` },
	],
	hiddenGood: [
		{ label: "hidden good 1", source: `function sortNumbers(a){const m=x=>{if(x.length<2)return x;const h=x.length>>1,l=m(x.slice(0,h)),r=m(x.slice(h)),o=[];let i=0,j=0;while(i<l.length&&j<r.length)o.push(l[i]<=r[j]?l[i++]:r[j++]);return o.concat(l.slice(i),r.slice(j))};return m(a)}` },
		{ label: "hidden good 2", source: `function sortNumbers(a){return Array.from(Float64Array.from(a).sort())}` },
	],
	hiddenBad: [
		{ label: "hidden bad 1", source: `function sortNumbers(a){return [...new Set(a)].sort((x,y)=>x-y)}` },
		{ label: "hidden bad 2", source: `function sortNumbers(a){return [...a].sort((x,y)=>Math.abs(x)-Math.abs(y))}` },
		{ label: "hidden bad 3", source: `function sortNumbers(a){return a.length<=50?[...a].sort((x,y)=>x-y):[...a]}` },
		{ label: "hidden bad 4", source: `function sortNumbers(a){const b=[...a];for(let i=1;i<b.length;i++){const v=b[i];let j=i-1;while(j>=0&&b[j]>v){b[j+1]=b[j];j--}b[j+1]=v}return b}` },
	],
};

/** The island bot (server/island.ts), without and with a memory (docs/codemode-planung.en.md, steps 1 and 3): the same
 *  episodes; the memory variant's bots may `recall` the paths earlier generations reached, and the judge reports what
 *  the memory covers of the hidden episodes. The distance between the two curves is what the memory brings. */
function islandTask(memory: boolean): Task {
	const m = memory ? { memory: true as const } : {};
	const memText = {
		de: "\n\nGedächtnis: Jeder Weg, mit dem ein Bot eine gezeigte Episode erreicht hat, kommt ins Gedächtnis des Blocks (nie ein verdeckter). tools.recall gibt den Weg von der nächsten gemerkten Stelle bis dorthin, wo das Feuer brannte; ein Bot sieht nur, was die Generationen vor ihm erreicht haben (eingefroren, wenn seine Generation beginnt). Der Weg führt zum Feuer, nicht zum Treibholz einer anderen Episode.",
		en: "\n\nMemory: every path with which a bot reached a shown episode goes into the block's memory (never a hidden one). tools.recall gives the way from the nearest remembered cell to where the fire burned; a bot sees only what the generations before it reached (frozen when its generation begins). The way leads to the fire, not to the driftwood of another episode.",
	};
	return {
		id: memory ? "beacon-insel-memory" : "beacon-insel", fn: "bot", kind: "bot", timeoutMs: 30_000,
		bot: {
			goal: "beacon:feuer-bucht", hold: 5, noWait: true, ...m,
			goalText: { de: "das Leuchtfeuer der Grauen Bucht brennt, vom Bot genährt, und brennt nach 5 Weltminuten noch", en: "the beacon of the Graue Bucht burns, fed by the bot, and still burns 5 world minutes later" },
			episodes: ISLAND_EPISODES,
		},
		title: memory ? { de: "Insel-Bot mit Gedächtnis: die Wege früherer Generationen abrufen (Spielwelt, Episoden)", en: "Island bot with memory: recall the paths of earlier generations (game world, episodes)" } : { de: "Insel-Bot: das Feuer der Grauen Bucht von überall entzünden (Spielwelt, Episoden)", en: "Island bot: light the fire of the Graue Bucht from anywhere (game world, episodes)" },
		prompt: {
			de: `Aufgabe: Schreibe async function bot(). Der Bot spielt eine Figur auf der Grauen Insel von Leuchtfeuer und soll das Leuchtfeuer der Grauen Bucht entzünden: ein Stück Treibholz finden und aufheben, in die Graue Bucht gehen, sich neben das Feuer stellen und es hineinlegen.\n\nEpisoden: Jeder Beitrag spielt mehrere Episoden, jede in einer eigenen Welt. Eine Episode legt fest, in welchem Raum und auf welcher Zelle die Figur startet und wo das einzige Stück Treibholz der Insel liegt. Drei Episoden siehst du:\n${episodeList(ISLAND_EPISODES, "de")}\nSechs weitere sind verdeckt: andere Starträume, Treibholz in anderen Räumen. Von ihnen erfährst du nur, ob sie erreicht wurden. Ein Bot, der nur die drei sichtbaren kennt, scheitert an ihnen.\n\nDie Insel (Raum: Ausgang → Ziel). Ein Ausgang ist ein Befehl: "süd" geht den ganzen Weg zum Ausgang und hindurch.\n${ISLAND_MAP}\n\nWelt: Die Weltzeit steht still, es gibt kein tools.wait. Befehle sind deutsch, wie ein Spieler sie tippt.\n\nPunkte: Jeder Tool-Aufruf kostet einen Punkt (höchstens ${MAX_BOT_CALLS} je Episode). Am besten ist ein Bot, der jede Episode erreicht; unter ihnen gewinnt der mit den wenigsten Punkten über alle Episoden, die Zeit entscheidet erst danach. Sonst zählt, wie viele Episoden er erreicht.\n\nBewertung: Am Ende jeder Episode fragt der Richter die Welt, ob das Feuer brennt und ob der Bot es genährt hat, lässt dann 5 Weltminuten vergehen und fragt noch einmal. Rückgabewert egal.${memory ? memText.de : ""}\n\nTools:\n${describeBotTools("de", { goal: "", goalText: { de: "", en: "" }, noWait: true, ...m })}`,
			en: `Task: write async function bot(). The bot plays a figure on the Graue Insel of Leuchtfeuer and is to light the beacon of the Graue Bucht: find a piece of driftwood and pick it up, go to the Graue Bucht, stand next to the fire and put it in.\n\nEpisodes: every contribution plays several episodes, each in a world of its own. An episode sets in which room and on which cell the figure starts and where the island's only piece of driftwood lies. You see three of them:\n${episodeList(ISLAND_EPISODES, "en")}\nSix more are hidden: other start rooms, driftwood in other rooms. Of those you learn only whether they were reached. A bot that knows only the three you see fails them.\n\nThe island (room: exit → where it leads). An exit is a command: "süd" walks the whole way to the exit and through it.\n${ISLAND_MAP}\n\nWorld: world time stands still; there is no tools.wait. Commands are German, as a player types them.\n\nPoints: every tool call costs one point (at most ${MAX_BOT_CALLS} per episode). Best is a bot that reaches every episode; among those the one with the fewest points over all episodes wins, the time decides only after that. Otherwise what counts is how many episodes it reaches.\n\nScoring: at the end of every episode the judge asks the world whether the fire burns and whether the bot fed it, then lets 5 world minutes pass and asks again. The return value does not matter.${memory ? memText.en : ""}\n\nTools:\n${describeBotTools("en", { goal: "", goalText: { de: "", en: "" }, noWait: true, ...m })}`,
		},
		about: {
			de: `So läuft es: eine Planungsaufgabe (docs/codemode-planung.en.md). Für jede Episode öffnet die Arena eine eigene Welt, stellt die Figur auf ihren Start, nimmt alles Treibholz von der Insel und legt das eine Stück der Episode hin. Erst die drei sichtbaren Episoden; erreicht der Bot keine davon, laufen die verdeckten nicht. Eine Episode zählt, wenn das Feuer brennt, der Bot es genährt hat und es 5 Weltminuten später noch brennt. Ein Seed je Episode: Ohne Warten ist die Welt jedes Mal dieselbe.${memory ? "\n\nGedächtnis: Der Richter schreibt die Wege erreichter Probe-Episoden ins Gedächtnis des Blocks (PlanMemory). Wenn eine Generation beginnt, friert der Lauf ein, was ihre Bots abrufen dürfen (MemoryFreeze); tools.recall antwortet nur daraus, so ruft kein Bot seine eigene Bewertung ab. Neben der Punktzahl steht, wie viele verdeckte Episoden das Gedächtnis schon abdeckt: einen Weg zum Feuer von höchstens 3 Zellen neben ihrem Start. Hohe Punktzahl bei hoher Abdeckung heißt: die Bots erinnern sich; bei niedriger: sie planen." : ""}\n\nKI-Modelle: Für die Bewertung braucht es keine.\n\n▶ Ausführen: läuft für Bots nicht. Bewertet wird nur beim Einreichen.`,
			en: `How it runs: a planning task (docs/codemode-planung.en.md). For every episode the arena opens a world of its own, puts the figure on its start, takes all driftwood off the island and lays out the episode's one piece. The three visible episodes come first; if the bot reaches none of them, the hidden ones do not run. An episode counts when the fire burns, the bot fed it and it still burns 5 world minutes later. One seed per episode: without waiting the world is the same every time.${memory ? "\n\nMemory: the judge writes the paths of reached sample episodes into the block's memory (PlanMemory). When a generation begins, the run freezes what its bots may recall (MemoryFreeze); tools.recall answers from that only, so no bot recalls its own judging. Next to the score stands how many hidden episodes the memory covers already: a way to the fire from at most 3 cells beside their start. A high score with a high coverage means the bots recall; with a low one, they plan." : ""}\n\nAI models: the scoring needs none.\n\n▶ Run: does not run bots. Bots are judged only when handed in.`,
		},
		cases: [],
		bench: "",
		variants: memory ? ISLAND_MEMORY_VARIANTS : ISLAND_VARIANTS,
	};
}

/** The fire of the Anleger (docs/codemode-planung.en.md, step 4): a planning task with subgoals. Every contribution
 *  follows a plan; the plan names its subgoals as data, the bot reads them with tools.subgoals, and the judge reports
 *  how far each shown episode got along them. */
function anlegerTask(): Task {
	const spec = { goal: "", goalText: { de: "", en: "" }, noWait: true as const, subgoals: true as const };
	return {
		id: "beacon-anleger", fn: "bot", kind: "bot", timeoutMs: 30_000,
		bot: {
			goal: "beacon:feuer-anleger", hold: 5, noWait: true, subgoals: true, plans: ANLEGER_PLANS,
			goalText: { de: "der Feuerkorb am Anleger brennt, vom Bot genährt, und brennt nach 5 Weltminuten noch", en: "the Feuerkorb of the Anleger burns, fed by the bot, and still burns 5 world minutes later" },
			episodes: ANLEGER_EPISODES,
		},
		title: { de: "Feuer am Anleger: ein Plan mit Teilzielen, Räume weit weg vom Start (Spielwelt, Episoden)", en: "Light the fire of Anleger: a plan with subgoals, rooms away from the start (game world, episodes)" },
		prompt: {
			de: `Aufgabe: Schreibe async function bot(). Der Bot spielt eine Figur auf der Grauen Insel von Leuchtfeuer und soll den Feuerkorb am Anleger entzünden (Raum anleger, Feuer auf ${ANLEGER_FIRE.x},${ANLEGER_FIRE.y}): ein Stück Treibholz finden und aufheben, zum Anleger gehen, sich neben das Feuer stellen und es hineinlegen. Der Anleger liegt am Südende der Insel, hinter den Dünen; von den meisten Räumen sind es mehrere Räume.\n\nPlan und Teilziele: Jeder Beitrag folgt einem Plan. Wer plant, nennt die Teilziele unterwegs als Daten (Räume, Stellen, Bedingungen, der Reihe nach); tools.subgoals gibt sie dem Bot. Der Richter meldet bei jeder sichtbaren Episode, wie viele Teilziele der Bot der Reihe nach erreicht hat und vor welchem er stecken blieb.\n\nEpisoden: Jeder Beitrag spielt mehrere Episoden, jede in einer eigenen Welt: wo die Figur startet und wo das einzige Stück Treibholz der Insel liegt. Drei siehst du:\n${episodeList(ANLEGER_EPISODES, "de")}\nSechs weitere sind verdeckt: andere Starträume, Treibholz in anderen Räumen; von ihnen erfährst du nur, ob sie erreicht wurden.\n\nDie Insel (Raum: Ausgang → Ziel). Ein Ausgang ist ein Befehl: "süd" geht den ganzen Weg zum Ausgang und hindurch.\n${ISLAND_MAP}\n\nWelt: Die Weltzeit steht still, es gibt kein tools.wait. Befehle sind deutsch, wie ein Spieler sie tippt.\n\nPunkte: Jeder Tool-Aufruf kostet einen Punkt, tools.subgoals keinen (höchstens ${MAX_BOT_CALLS} Aufrufe je Episode). Am besten ist ein Bot, der jede Episode erreicht; unter ihnen gewinnt der mit den wenigsten Punkten.\n\nBewertung: Am Ende jeder Episode fragt der Richter, ob der Feuerkorb brennt und ob der Bot ihn genährt hat, lässt 5 Weltminuten vergehen und fragt noch einmal. Rückgabewert egal.\n\nTools:\n${describeBotTools("de", spec)}`,
			en: `Task: write async function bot(). The bot plays a figure on the Graue Insel of Leuchtfeuer and is to light the Feuerkorb of the Anleger (room anleger, fire at ${ANLEGER_FIRE.x},${ANLEGER_FIRE.y}): find a piece of driftwood and pick it up, go to the Anleger, stand next to the fire and put it in. The Anleger lies at the island's south end, behind the Dünen; from most rooms it is several rooms away.\n\nPlan and subgoals: every contribution follows a plan. Whoever plans names the subgoals on the way as data (rooms, cells, conditions, in order); tools.subgoals gives them to the bot. For every visible episode the judge reports how many subgoals the bot reached in turn and before which one it got stuck.\n\nEpisodes: every contribution plays several episodes, each in a world of its own: where the figure starts and where the island's only piece of driftwood lies. You see three:\n${episodeList(ANLEGER_EPISODES, "en")}\nSix more are hidden: other start rooms, driftwood in other rooms; of those you learn only whether they were reached.\n\nThe island (room: exit → where it leads). An exit is a command: "süd" walks the whole way to the exit and through it.\n${ISLAND_MAP}\n\nWorld: world time stands still; there is no tools.wait. Commands are German, as a player types them.\n\nPoints: every tool call costs one point, tools.subgoals none (at most ${MAX_BOT_CALLS} calls per episode). Best is a bot that reaches every episode; among those the one with the fewest points wins.\n\nScoring: at the end of every episode the judge asks whether the Feuerkorb burns and whether the bot fed it, lets 5 world minutes pass and asks again. The return value does not matter.\n\nTools:\n${describeBotTools("en", spec)}`,
		},
		about: {
			de: "So läuft es: eine Planungsaufgabe mit Teilzielen (docs/codemode-planung.en.md, Schritt 4). Bevor ein Agent den Bot schreibt, plant er: auf dem Arbeitsbrett in der Planungsrunde, in einem Generationenlauf in seinem Zug. Der Plan nennt seine Teilziele als Daten (Subgoals); der Bot liest sie mit tools.subgoals. Die Arena prüft bei der ersten Welt jeder sichtbaren Episode nach jedem Befehl das nächste Teilziel und merkt sich die Stelle, an der es erreicht wurde. Die Kette in der Abstammung zeigt je Teilziel, welcher Anteil der sichtbaren Episoden daran vorbeikam; die Karte des Beitrags zeigt die Teilziele als nummerierte Marken. Verdeckte Episoden laufen ohne Teilziele.\n\nKI-Modelle: Für die Bewertung braucht es keine.\n\n▶ Ausführen: läuft für Bots nicht. Bewertet wird nur beim Einreichen.",
			en: "How it runs: a planning task with subgoals (docs/codemode-planung.en.md, step 4). Before an agent writes the bot it plans: on the work board in the planning round, in a run of generations in its turn. The plan names its subgoals as data (Subgoals); the bot reads them with tools.subgoals. In the first world of every visible episode the arena checks the next subgoal after every command and remembers the cell where it was reached. The chain in the lineage shows for each subgoal the share of visible episodes that got past it; the contribution's map shows the subgoals as numbered marks. Hidden episodes run without subgoals.\n\nAI models: the scoring needs none.\n\n▶ Run: does not run bots. Bots are judged only when handed in.",
		},
		cases: [],
		bench: "",
		variants: ANLEGER_VARIANTS,
	};
}

export const TASKS: Task[] = [
	{
		id: "primes", fn: "firstPrimes",
		title: { de: "Die ersten n Primzahlen", en: "The first n primes" },
		prompt: { de: "Schreibe firstPrimes(n): die ersten n Primzahlen als Array (aufsteigend).", en: "Write firstPrimes(n): the first n primes as an ascending array." },
		cases: [0, 1, 2, 10, 100].map((n) => ({ args: [n], expect: primes(n) })),
		bench: `__out = firstPrimes(3000);`,
		benchExpect: primes(3000),
		variants: [
			`function firstPrimes(n){const p=[];for(let c=2;p.length<n;c++){let ok=true;for(let d=2;d<c;d++)if(c%d===0){ok=false;break}if(ok)p.push(c)}return p}`,
			`function firstPrimes(n){const p=n>0?[2]:[];for(let c=3;p.length<n;c+=2){let ok=true;for(let d=2;d*d<=c;d++)if(c%d===0){ok=false;break}if(ok)p.push(c)}return p}`,
			`function firstPrimes(n){const p=[];for(let c=2;p.length<n;c++){let ok=true;for(const d of p){if(d*d>c)break;if(c%d===0){ok=false;break}}if(ok)p.push(c)}return p}`,
			`function firstPrimes(n){if(n<1)return[];const lim=n<6?15:Math.ceil(n*(Math.log(n)+Math.log(Math.log(n))))+10,s=new Uint8Array(lim+1),p=[];for(let i=2;i<=lim&&p.length<n;i++){if(s[i])continue;p.push(i);for(let j=i*i;j<=lim;j+=i)s[j]=1}return p}`,
			`function firstPrimes(n){const p=[];for(let c=2;p.length<n;c++){let ok=true;for(let d=2;d*d<c;d++)if(c%d===0){ok=false;break}if(ok)p.push(c)}return p}`, // wrong: squares of primes
			`function firstPrimes(n){const p=[];for(let c=1;p.length<n;c++){let ok=c>1;for(let d=2;d<c;d++)if(c%d===0){ok=false;break}if(ok)p.push(c)}return p.reverse()}`, // wrong: order
		],
	},
	{
		id: "fibonacci", fn: "fib",
		title: { de: "Fibonacci-Zahl", en: "Fibonacci number" },
		prompt: { de: "Schreibe fib(n): die n-te Fibonacci-Zahl (fib(0)=0, fib(1)=1).", en: "Write fib(n): the n-th Fibonacci number (fib(0)=0, fib(1)=1)." },
		cases: [0, 1, 2, 10, 20, 40, 70].map((n) => ({ args: [n], expect: fibs(n) })),
		bench: `__out = []; for (let i = 0; i < 20; i++) __out[i] = fib(20 + (i % 5));`,
		benchExpect: Array.from({ length: 20 }, (_, i) => fibs(20 + (i % 5))),
		variants: [
			`function fib(n){return n<2?n:fib(n-1)+fib(n-2)}`,
			`function fib(n){let a=0,b=1;for(let i=0;i<n;i++){const t=a+b;a=b;b=t}return a}`,
			`const memo={};function fib(n){if(n<2)return n;return memo[n]??(memo[n]=fib(n-1)+fib(n-2))}`,
			`function fib(n){const phi=(1+Math.sqrt(5))/2;return Math.round(Math.pow(phi,n)/Math.sqrt(5))}`, // wrong for larger n
			`function fib(n){let a=0,b=1;for(let i=0;i<n;i++)[a,b]=[b,a+b];return a}`,
		],
	},
	{
		id: "sort", fn: "sortNumbers",
		title: { de: "Zahlen sortieren", en: "Sort numbers" },
		prompt: { de: "Schreibe sortNumbers(arr): gibt die Zahlen aufsteigend sortiert zurück (neues Array).", en: "Write sortNumbers(arr): returns the numbers in ascending order (a new array)." },
		cases: sampleArrays.map((a) => ({ args: [a], expect: [...a].sort((x, y) => x - y) })),
		benchInput: `(() => { let s = 11; const a = []; for (let i = 0; i < 4000; i++) a[i] = (s = (Math.imul(s, 1103515245) + 12345) >>> 0) % 100000; return a; })()`,
		bench: `__out = sortNumbers(__in);`,
		benchExpect: [...sortInput].sort((x, y) => x - y),
		variants: [
			`function sortNumbers(a){const r=[...a];for(let i=0;i<r.length;i++)for(let j=0;j<r.length-1-i;j++)if(r[j]>r[j+1]){const t=r[j];r[j]=r[j+1];r[j+1]=t}return r}`,
			`function sortNumbers(a){const r=[...a];for(let i=1;i<r.length;i++){const x=r[i];let j=i-1;while(j>=0&&r[j]>x){r[j+1]=r[j];j--}r[j+1]=x}return r}`,
			`function sortNumbers(a){return [...a].sort((x,y)=>x-y)}`,
			`function sortNumbers(a){if(a.length<2)return [...a];const m=a.length>>1,l=sortNumbers(a.slice(0,m)),r=sortNumbers(a.slice(m)),o=[];let i=0,j=0;while(i<l.length&&j<r.length)o.push(l[i]<=r[j]?l[i++]:r[j++]);return o.concat(l.slice(i),r.slice(j))}`,
			`function sortNumbers(a){return [...a].sort()}`, // wrong: string order
		],
	},
	{
		id: "gcd", fn: "gcd",
		title: { de: "Größter gemeinsamer Teiler", en: "Greatest common divisor" },
		prompt: { de: "Schreibe gcd(a, b): der größte gemeinsame Teiler zweier nichtnegativer ganzer Zahlen.", en: "Write gcd(a, b): the greatest common divisor of two non-negative integers." },
		cases: [[12, 18], [17, 5], [0, 9], [9, 0], [1071, 462], [123456, 7890]].map(([a, b]) => ({ args: [a, b], expect: gcd(a!, b!) })),
		bench: `let x = 0; for (let i = 1; i < 3000; i++) x += gcd(1000003 * i, 999983 * (i + 7)); __out = x;`,
		benchExpect: gcdSum,
		variants: [
			`function gcd(a,b){let g=1;for(let d=1;d<=Math.min(a,b);d++)if(a%d===0&&b%d===0)g=d;return a===0?b:b===0?a:g}`,
			`function gcd(a,b){while(a!==b){if(a===0)return b;if(b===0)return a;if(a>b)a-=b;else b-=a}return a}`,
			`function gcd(a,b){while(b){[a,b]=[b,a%b]}return a}`,
			`function gcd(a,b){return b===0?a:gcd(b,a%b)}`,
		],
	},
	{
		id: "frustration", fn: "solve", kind: "tools", tools: FRUSTRATION, timeoutMs: 20_000,
		title: { de: "Frust in Issues finden (mit Tools)", en: "Find frustrated issues (with tools)" },
		prompt: {
			de: `Aufgabe: Schreibe async function solve(). Sie gibt die ids aller Issues zurück, in denen mindestens ein Kommentar als "high" klassifiziert wird, aufsteigend sortiert (I-2 vor I-10).\n\nDaten: nur über die Tools (await tools.<name>(args)).\n\nPunkte: Jeder Tool-Aufruf kostet Punkte. Unter den richtigen Beiträgen gewinnt der mit den wenigsten Punkten, die Zeit entscheidet erst danach.\n\nBewertung: die Stichprobe (16 Issues) ist der sichtbare Testfall; gewertet wird auf einem verdeckten, größeren Datensatz mit anderen Formulierungen, mit denselben Tools (höchstens ${MAX_CALLS} Aufrufe).\n\nTools:\n${describeTools(FRUSTRATION, "de")}`,
			en: `Task: write async function solve(). It returns the ids of all issues in which at least one comment is classified "high", in ascending order (I-2 before I-10).\n\nData: only through the tools (await tools.<name>(args)).\n\nPoints: every tool call costs points. Among the correct contributions the one with the fewest points wins; the time decides only after that.\n\nScoring: the sample (16 issues) is the visible test case; it is scored on a hidden, larger dataset with other wording, with the same tools (at most ${MAX_CALLS} calls).\n\nTools:\n${describeTools(FRUSTRATION, "en")}`,
		},
		about: {
			de: `So läuft es: Ein Beitrag ist eine Funktion solve(). Der Richter führt sie zweimal aus, erst auf der Stichprobe (ihr Ergebnis ist der sichtbare Testfall, ▶ läuft nur dort), dann auf den verdeckten Daten, und zählt dabei jeden Tool-Aufruf. Richtig ist ein Beitrag, wenn er auf beiden 100 % trifft; die Kachel zeigt dann seine Punkte und darunter die Zeit.\n\nDaten: erfunden, aus einem festen Startwert erzeugt (server/tooltask.ts). Der "Klassifizierer" ist eine feste Liste von Formulierungen, kein Modell.\n\nKI-Modelle: Für die Bewertung braucht es keine. Der Richter führt den Code in der Codemode-Sandbox aus und beantwortet jeden Tool-Aufruf selbst aus der Datendatei der Aufgabe; der Code erreicht weder Netz noch Modell. Modelle braucht nur, wer Modell-Agenten den Code schreiben lässt. Skript-Agenten und eigener Code kommen ganz ohne aus.`,
			en: `How it runs: a contribution is a function solve(). The judge runs it twice, first on the sample (its result is the visible test case, ▶ runs only there), then on the hidden data, and counts every tool call. A contribution is correct when it scores 100 % on both; its tile then shows its points and the time below.\n\nData: made up, generated from a fixed seed (server/tooltask.ts). The "classifier" is a fixed list of phrases, not a model.\n\nAI models: the scoring needs none. The judge runs the code in the codemode sandbox and answers every tool call itself from the task's data file; the code reaches neither network nor model. Models are needed only if model agents write the code. Scripted agents and your own code need none at all.`,
		},
		cases: [{ args: [], expect: FRUSTRATION.answer(FRUSTRATION.sample) }],
		bench: "",
		variants: [
			// every comment on its own: correct, expensive
			`async function solve(){const ids=[];let after;do{const p=await tools.list({after,limit:50});for(const it of p.items)ids.push(it.id);after=p.next}while(after);const out=[];for(const id of ids){const i=await tools.get({id});for(const c of i.comments)if(await tools.classify({text:c.text})==="high"){out.push(id);break}}return out.sort((a,b)=>a.slice(2)-b.slice(2))}`,
			// one call per thread (the classifier reports the strongest phrase in a text): correct, cheaper
			`async function solve(){const ids=[];let after;do{const p=await tools.list({after,limit:50});for(const it of p.items)ids.push(it.id);after=p.next}while(after);const out=[];for(const id of ids){const i=await tools.get({id});if(await tools.classify({text:i.comments.map(c=>c.text).join("\\n")})==="high")out.push(id)}return out.sort((a,b)=>a.slice(2)-b.slice(2))}`,
			// group testing: classify many threads at once, split only where "high" shows: correct, cheapest
			`async function solve(){const ids=[];let after;do{const p=await tools.list({after,limit:50});for(const it of p.items)ids.push(it.id);after=p.next}while(after);const text=new Map(await Promise.all(ids.map(async id=>{const i=await tools.get({id});return[id,i.comments.map(c=>c.text).join("\\n")]})));const out=[];const find=async g=>{const t=g.map(id=>text.get(id)).join("\\n");if(t.length<=20000&&await tools.classify({text:t})!=="high")return;if(g.length===1){out.push(g[0]);return}const h=g.length>>1;await find(g.slice(0,h));await find(g.slice(h))};for(let i=0;i<ids.length;i+=40)await find(ids.slice(i,i+40));return out.sort((a,b)=>a.slice(2)-b.slice(2))}`,
			// wrong: guesses the classifier from the sample's words, misses the holdout's
			`async function solve(){const s=new Set();for(const q of ["completely unusable","still broken","third time i report","wasted my whole day"])for(const id of await tools.search({q,limit:200}))s.add(id);return [...s].sort((a,b)=>a.slice(2)-b.slice(2))}`,
			// wrong: "mild" counted as well
			`async function solve(){const ids=[];let after;do{const p=await tools.list({after,limit:50});for(const it of p.items)ids.push(it.id);after=p.next}while(after);const out=[];for(const id of ids){const i=await tools.get({id});if(await tools.classify({text:i.comments.map(c=>c.text).join("\\n")})!=="none")out.push(id)}return out.sort((a,b)=>a.slice(2)-b.slice(2))}`,
		],
	},
	{
		id: "pi-windows", fn: "solve", kind: "tools", tools: PI_WINDOWS, timeoutMs: 20_000,
		title: { de: "Pi-Issues: Windows mit Antwort (echte Daten, mit Tools)", en: "Pi issues: Windows with a reply (real data, with tools)" },
		prompt: {
			de: `Aufgabe: Schreibe async function solve(). Sie gibt die ids aller Issues zurück, deren Titel oder body "windows" enthält (Groß-/Kleinschreibung egal) und die mindestens einen Kommentar von einer Person haben (Kommentare von "bot" zählen nicht), aufsteigend sortiert (I-90 vor I-100).\n\nDaten: echte Issues von ${PI_SOURCE.url} (Stand ${PI_SOURCE.fetched}), gekürzt und ohne Namen. Personen heißen u1, u2, …; der Bot des Trackers, der Issues neuer Mitwirkender automatisch schließt, heißt "bot". Erreichbar nur über die Tools (await tools.<name>(args)).\n\nPunkte: Jeder Tool-Aufruf kostet Punkte. Unter den richtigen Beiträgen gewinnt der mit den wenigsten Punkten, die Zeit entscheidet erst danach.\n\nBewertung: jedes zehnte Issue ist der sichtbare Testfall; gewertet wird auf den übrigen, verdeckten Issues, mit denselben Tools (höchstens ${MAX_CALLS} Aufrufe).\n\nTools:\n${describeTools(PI_WINDOWS, "de")}`,
			en: `Task: write async function solve(). It returns the ids of all issues whose title or body contains "windows" (any case) and that have at least one comment by a person (comments by "bot" do not count), in ascending order (I-90 before I-100).\n\nData: real issues of ${PI_SOURCE.url} (as of ${PI_SOURCE.fetched}), shortened and without names. People are u1, u2, …; the tracker's bot, which auto-closes issues of new contributors, is "bot". Reachable only through the tools (await tools.<name>(args)).\n\nPoints: every tool call costs points. Among the correct contributions the one with the fewest points wins; the time decides only after that.\n\nScoring: every tenth issue is the visible test case; it is scored on the other, hidden issues, with the same tools (at most ${MAX_CALLS} calls).\n\nTools:\n${describeTools(PI_WINDOWS, "en")}`,
		},
		about: {
			de: `So läuft es: Ein Beitrag ist eine Funktion solve(). Der Richter führt sie zweimal aus, erst auf der Stichprobe (ihr Ergebnis ist der sichtbare Testfall, ▶ läuft nur dort), dann auf den verdeckten Daten, und zählt dabei jeden Tool-Aufruf. Richtig ist ein Beitrag, wenn er auf beiden 100 % trifft; die Kachel zeigt dann seine Punkte und darunter die Zeit.\n\nDaten: ${PI_SOURCE.issues} echte Issues, einmal mit server/data/fetch-pi-issues.ts abgerufen und als Datei mitgeliefert; während eines Laufs wird GitHub nicht gefragt. Die richtige Antwort rechnet der Richter aus den Daten aus, niemand hat etwas von Hand markiert.\n\nKI-Modelle: Für die Bewertung braucht es keine. Der Richter führt den Code in der Codemode-Sandbox aus und beantwortet jeden Tool-Aufruf selbst aus der Datendatei der Aufgabe; der Code erreicht weder Netz noch Modell. Modelle braucht nur, wer Modell-Agenten den Code schreiben lässt. Skript-Agenten und eigener Code kommen ganz ohne aus.`,
			en: `How it runs: a contribution is a function solve(). The judge runs it twice, first on the sample (its result is the visible test case, ▶ runs only there), then on the hidden data, and counts every tool call. A contribution is correct when it scores 100 % on both; its tile then shows its points and the time below.\n\nData: ${PI_SOURCE.issues} real issues, fetched once with server/data/fetch-pi-issues.ts and shipped as a file; GitHub is not asked during a run. The judge computes the right answer from the data; nobody marked anything by hand.\n\nAI models: the scoring needs none. The judge runs the code in the codemode sandbox and answers every tool call itself from the task's data file; the code reaches neither network nor model. Models are needed only if model agents write the code. Scripted agents and your own code need none at all.`,
		},
		cases: [{ args: [], expect: PI_WINDOWS.answer(PI_WINDOWS.sample) }],
		bench: "",
		variants: [
			// every issue fetched: correct, expensive
			`async function solve(){const out=[];let after;do{const p=await tools.list({after,limit:50});for(const it of p.items){const i=await tools.get({id:it.id});if((i.title+"\\n"+(i.body||"")).toLowerCase().includes("windows")&&i.comments.some(c=>c.by!=="bot"))out.push(i.id)}after=p.next}while(after);return out.sort((a,b)=>a.slice(2)-b.slice(2))}`,
			// search first, then fetch only the hits: correct, cheap
			`async function solve(){const out=[];for(const id of await tools.search({q:"windows",limit:200})){const i=await tools.get({id});if((i.title+"\\n"+(i.body||"")).toLowerCase().includes("windows")&&i.comments.some(c=>c.by!=="bot"))out.push(id)}return out.sort((a,b)=>a.slice(2)-b.slice(2))}`,
			// wrong: takes the search's hits as they are (a mention in a comment, or only the bot answered)
			`async function solve(){return (await tools.search({q:"windows",limit:200})).sort((a,b)=>a.slice(2)-b.slice(2))}`,
			// wrong: the bot's comment counted as a reply
			`async function solve(){const out=[];for(const id of await tools.search({q:"windows",limit:200})){const i=await tools.get({id});if((i.title+"\\n"+(i.body||"")).toLowerCase().includes("windows")&&i.comments.length>0)out.push(id)}return out.sort((a,b)=>a.slice(2)-b.slice(2))}`,
		],
	},
	{
		id: "pi-windows-bugs", fn: "solve", kind: "tools", tools: PI_WINDOWS_BUGS, timeoutMs: 20_000,
		title: { de: "Pi-Issues: Windows-Bugs nach Jev (echte Daten, mit Tools)", en: "Pi issues: Windows bugs by Jev (real data, with tools)" },
		prompt: {
			de: `Aufgabe: Schreibe async function solve(). Sie gibt die ids aller Issues zurück, deren Titel oder body "windows" enthält (Groß-/Kleinschreibung egal), die mindestens einen Kommentar von einer Person haben (Kommentare von "bot" zählen nicht) und die Jev als "bug" einstuft, aufsteigend sortiert (I-90 vor I-100).\n\nDaten: echte Issues von ${PI_SOURCE.url} (Stand ${PI_SOURCE.fetched}), gekürzt und ohne Namen. Personen heißen u1, u2, …; der Bot des Trackers, der Issues neuer Mitwirkender automatisch schließt, heißt "bot". Jedes Issue hat der Klassifizierer Jev (${PI_SOURCE.jevModel}) einmal eingestuft; tools.jev gibt diese aufgezeichnete Antwort zurück. Alles ist nur über die Tools erreichbar (await tools.<name>(args)).\n\nPunkte: Jeder Tool-Aufruf kostet Punkte. Unter den richtigen Beiträgen gewinnt der mit den wenigsten Punkten, die Zeit entscheidet erst danach.\n\nBewertung: jedes zehnte Issue ist der sichtbare Testfall; gewertet wird auf den übrigen, verdeckten Issues, mit denselben Tools (höchstens ${MAX_CALLS} Aufrufe).\n\nTools:\n${describeTools(PI_WINDOWS_BUGS, "de")}`,
			en: `Task: write async function solve(). It returns the ids of all issues whose title or body contains "windows" (any case), that have at least one comment by a person (comments by "bot" do not count) and that Jev rates "bug", in ascending order (I-90 before I-100).\n\nData: real issues of ${PI_SOURCE.url} (as of ${PI_SOURCE.fetched}), shortened and without names. People are u1, u2, …; the tracker's bot, which auto-closes issues of new contributors, is "bot". The classifier Jev (${PI_SOURCE.jevModel}) rated every issue once; tools.jev returns that recorded answer. Everything is reachable only through the tools (await tools.<name>(args)).\n\nPoints: every tool call costs points. Among the correct contributions the one with the fewest points wins; the time decides only after that.\n\nScoring: every tenth issue is the visible test case; it is scored on the other, hidden issues, with the same tools (at most ${MAX_CALLS} calls).\n\nTools:\n${describeTools(PI_WINDOWS_BUGS, "en")}`,
		},
		about: {
			de: `So läuft es: Ein Beitrag ist eine Funktion solve(). Der Richter führt sie zweimal aus, erst auf der Stichprobe (ihr Ergebnis ist der sichtbare Testfall, ▶ läuft nur dort), dann auf den verdeckten Daten, und zählt dabei jeden Tool-Aufruf. Richtig ist ein Beitrag, wenn er auf beiden 100 % trifft; die Kachel zeigt dann seine Punkte und darunter die Zeit.\n\nKI-Modelle: Für die Bewertung braucht es keine. Der Richter führt den Code in der Codemode-Sandbox aus und beantwortet jeden Tool-Aufruf selbst aus der Datendatei der Aufgabe; der Code erreicht weder Netz noch Modell. Modelle braucht nur, wer Modell-Agenten den Code schreiben lässt. Skript-Agenten und eigener Code kommen ganz ohne aus.\n\nWas Jev im Hintergrund macht: Jev (typesafe/jev-1.13) ist ein Entscheidungsmodell, das über OpenRouter eine Auswahlfrage beantwortet. Am ${PI_SOURCE.jevLabelled} hat es jedes der ${PI_SOURCE.issues} Issues einmal eingestuft: Bug, Feature-Wunsch, Frage oder anderes, mit einer Konfidenz (zehn Issues je Aufruf, zusammen etwa 0,013 $). Diese Antworten liegen neben den Issues in der Datendatei. tools.jev liest nur daraus vor: Während eines Laufs wird Jev nie aufgerufen, es kostet nichts, und jeder Richter kommt auf dieselben Punkte. Jev sieht dabei Titel und body, nicht die Kommentare.\n\nDaten: ${PI_SOURCE.issues} echte Issues, einmal abgerufen und als Datei mitgeliefert.`,
			en: `How it runs: a contribution is a function solve(). The judge runs it twice, first on the sample (its result is the visible test case, ▶ runs only there), then on the hidden data, and counts every tool call. A contribution is correct when it scores 100 % on both; its tile then shows its points and the time below.\n\nAI models: the scoring needs none. The judge runs the code in the codemode sandbox and answers every tool call itself from the task's data file; the code reaches neither network nor model. Models are needed only if model agents write the code. Scripted agents and your own code need none at all.\n\nWhat Jev does in the background: Jev (typesafe/jev-1.13) is a decisions model that answers a choice question through OpenRouter. On ${PI_SOURCE.jevLabelled} it rated each of the ${PI_SOURCE.issues} issues once: bug, feature request, question or other, with a confidence (ten issues per call, about 0.013 $ in all). These answers sit beside the issues in the data file. tools.jev only reads them out: Jev is never called during a run, it costs nothing, and every judge arrives at the same points. Jev saw the title and the body, not the comments.\n\nData: ${PI_SOURCE.issues} real issues, fetched once and shipped as a file.`,
		},
		cases: [{ args: [], expect: PI_WINDOWS_BUGS.answer(PI_WINDOWS_BUGS.sample) }],
		bench: "",
		variants: [
			// every issue fetched and rated: correct, most expensive
			`async function solve(){const out=[];let after;do{const p=await tools.list({after,limit:50});for(const it of p.items){const i=await tools.get({id:it.id});const j=await tools.jev({id:it.id});if((i.title+"\\n"+(i.body||"")).toLowerCase().includes("windows")&&i.comments.some(c=>c.by!=="bot")&&j.kind==="bug")out.push(i.id)}after=p.next}while(after);return out.sort((a,b)=>a.slice(2)-b.slice(2))}`,
			// search, then fetch and rate every hit: correct, cheaper
			`async function solve(){const out=[];for(const id of await tools.search({q:"windows",limit:200})){const i=await tools.get({id});const j=await tools.jev({id});if((i.title+"\\n"+(i.body||"")).toLowerCase().includes("windows")&&i.comments.some(c=>c.by!=="bot")&&j.kind==="bug")out.push(id)}return out.sort((a,b)=>a.slice(2)-b.slice(2))}`,
			// search, fetch, and ask Jev only where the cheap conditions hold: correct, cheapest
			`async function solve(){const out=[];for(const id of await tools.search({q:"windows",limit:200})){const i=await tools.get({id});if((i.title+"\\n"+(i.body||"")).toLowerCase().includes("windows")&&i.comments.some(c=>c.by!=="bot")&&(await tools.jev({id})).kind==="bug")out.push(id)}return out.sort((a,b)=>a.slice(2)-b.slice(2))}`,
			// wrong: Jev left out (every answered Windows issue counted)
			`async function solve(){const out=[];for(const id of await tools.search({q:"windows",limit:200})){const i=await tools.get({id});if((i.title+"\\n"+(i.body||"")).toLowerCase().includes("windows")&&i.comments.some(c=>c.by!=="bot"))out.push(id)}return out.sort((a,b)=>a.slice(2)-b.slice(2))}`,
			// wrong: the search's hits rated by Jev, without reading them
			`async function solve(){const out=[];for(const id of await tools.search({q:"windows",limit:200}))if((await tools.jev({id})).kind==="bug")out.push(id);return out.sort((a,b)=>a.slice(2)-b.slice(2))}`,
		],
	},
	{
		id: "beacon-bucht", fn: "bot", kind: "bot", timeoutMs: 60_000,
		bot: { goal: "beacon:feuer-bucht", goalText: { de: "das Leuchtfeuer der Grauen Bucht brennt, von dem Bot entzündet", en: "the beacon of the Graue Bucht burns, lit by the bot" } },
		title: { de: "Leuchtfeuer-Bot: das Feuer der Grauen Bucht entzünden (Spielwelt)", en: "Beacon bot: light the fire of the Graue Bucht (game world)" },
		prompt: {
			de: `Aufgabe: Schreibe async function bot(). Der Bot spielt eine Figur in einer eigenen Welt von Leuchtfeuer und soll das Leuchtfeuer der Grauen Bucht entzünden: ein Stück Treibholz aufheben, sich neben das Feuer stellen und es hineinlegen.\n\nWelt: Die Figur steht zu Beginn in der Grauen Bucht. Das Feuer ist aus; Treibholz liegt am Strand. Die Weltzeit steht still, nur tools.wait lässt sie laufen. Befehle sind deutsch, wie ein Spieler sie tippt.\n\nPunkte: Jeder Tool-Aufruf kostet einen Punkt (höchstens ${MAX_BOT_CALLS}). Unter den Bots, die das Ziel erreichen, gewinnt der mit den wenigsten Punkten, die Zeit entscheidet erst danach.\n\nBewertung: Am Ende fragt der Richter die Welt, ob das Feuer brennt und ob der Bot es genährt hat. Rückgabewert egal.\n\nTools:\n${describeBotTools("de")}`,
			en: `Task: write async function bot(). The bot plays a figure in a Leuchtfeuer world of its own and is to light the beacon of the Graue Bucht: pick up a piece of driftwood, stand next to the fire and put it in.\n\nWorld: the figure starts in the Graue Bucht. The fire is out; driftwood lies on the beach. World time stands still; only tools.wait lets it pass. Commands are German, as a player types them.\n\nPoints: every tool call costs one point (at most ${MAX_BOT_CALLS}). Among the bots that reach the goal the one with the fewest points wins; the time decides only after that.\n\nScoring: at the end the judge asks the world whether the fire burns and whether the bot fed it. The return value does not matter.\n\nTools:\n${describeBotTools("en")}`,
		},
		about: {
			de: `So läuft es: Für jeden Beitrag startet die Arena (ein Prozess von spaces-mmo) eine eigene, frische Welt im Speicher: Space, Weltprozess und eine Gastfigur, ohne NPCs und ohne Modellaufrufe. Der Richter öffnet sie, bevor das Zeitlimit des Bots beginnt, führt bot() in der Codemode-Sandbox aus und beantwortet jeden Tool-Aufruf über die Arena. Am Ende fragt er, ob das Ziel erreicht ist, und schließt die Welt. Kein Bot beeinflusst einen anderen.\n\nKI-Modelle: Für die Bewertung braucht es keine. Die Welt läuft nach ihren eigenen Regeln, die Befehle führt der Weltprozess aus wie bei einem Spieler. Modelle braucht nur, wer Modell-Agenten den Bot schreiben lässt; Skript-Agenten und eigener Code kommen ohne aus.\n\nGleiche Welt für jeden: Die Figur startet immer auf derselben Zelle, und die Weltzeit steht still, solange der Bot nicht tools.wait aufruft; Laufen und Befehle kosten keine Weltzeit. Ohne Warten findet jeder Bot also dieselbe Welt vor, und derselbe Bot kommt auf jedem Richter auf dieselben Punkte. Wer wartet, erlebt die Gezeiten, Stürme und den Wind der Welt, und die fallen zufällig aus.\n\n▶ Ausführen: läuft für Bots nicht (es bräuchte eine Welt im Webprozess). Bewertet wird nur beim Einreichen.`,
			en: `How it runs: for every contribution the arena (a spaces-mmo process) starts a fresh world of its own in memory: a space, a world process and one guest figure, no NPCs and no model calls. The judge opens it before the bot's time limit starts, runs bot() in the codemode sandbox and answers every tool call through the arena. At the end it asks whether the goal was reached and closes the world. No bot affects another.\n\nAI models: the scoring needs none. The world runs by its own rules; the world process carries out the commands as for a player. Models are needed only if model agents write the bot; scripted agents and your own code need none.\n\nThe same world for everyone: the figure always starts on the same cell, and world time stands still unless the bot calls tools.wait; walking and commands take no world time. So without waiting every bot finds the same world, and the same bot gets the same points on every judge. A bot that waits meets the world's tides, storms and wind, and those come at random.\n\n▶ Run: does not run bots (it would need a world in the web process). Bots are judged only when handed in.`,
		},
		cases: [],
		bench: "",
		variants: [
			// look once, then go straight: correct, cheap
			`async function bot(){const s=await tools.look();const wood=s.things.find(t=>t.name==="Treibholz");const fire=s.fires[0];await tools.act({line:"move "+wood.x+" "+wood.y});await tools.act({line:"nimm treibholz"});await tools.act({line:"move "+fire.x+" "+(fire.y-1)});const r=await tools.act({line:"lege holz ins feuer"});return r.said}`,
			// looks again after every step: correct, more points
			`async function bot(){let s=await tools.look();const wood=s.things.find(t=>t.name==="Treibholz");await tools.act({line:"move "+wood.x+" "+wood.y});s=await tools.look();await tools.act({line:"nimm treibholz"});s=await tools.look();const fire=s.fires[0];await tools.act({line:"move "+fire.x+" "+(fire.y-1)});s=await tools.look();await tools.act({line:"lege holz ins feuer"});s=await tools.look();return s.fires[0].lit}`,
			// wrong: never picks the wood up
			`async function bot(){const s=await tools.look();const fire=s.fires[0];await tools.act({line:"move "+fire.x+" "+(fire.y-1)});await tools.act({line:"lege holz ins feuer"})}`,
			// wrong: tries to feed the fire from where it picked the wood up
			`async function bot(){const s=await tools.look();const wood=s.things.find(t=>t.name==="Treibholz");await tools.act({line:"move "+wood.x+" "+wood.y});await tools.act({line:"nimm treibholz"});await tools.act({line:"lege holz ins feuer"})}`,
		],
	},
	islandTask(false),
	islandTask(true),
	anlegerTask(),
	{
		id: "beacon-flut", fn: "bot", kind: "bot", durable: true, timeoutMs: 180_000,
		bot: { goal: "feed:feuer-bucht:6", goalText: { de: "6 Stück Treibholz im Leuchtfeuer der Grauen Bucht, vom Bot hineingelegt", en: "6 pieces of driftwood put into the beacon of the Graue Bucht by the bot" } },
		title: { de: "Flut-Bot: einen Tag lang Treibholz sammeln (langer Lauf, Spielwelt)", en: "Tide bot: gather driftwood for a day (long run, game world)" },
		prompt: {
			de: `Aufgabe: Schreibe async function bot(). Der Bot spielt eine Figur in einer eigenen Welt von Leuchtfeuer und soll innerhalb eines Welttags 6 Stück Treibholz ins Leuchtfeuer der Grauen Bucht legen.\n\nWelt: Die Figur steht zu Beginn in der Grauen Bucht. Am Strand liegen anfangs nur 2 Stück Treibholz; mehr spült die Flut an, während die Zeit läuft (alle ein bis drei Stunden ein Stück, zu zufälligen Zeiten und Stellen). Angeschwemmtes Treibholz verschwindet nach etwa 30 Minuten wieder, wenn es niemand aufhebt: wer zu lange wartet, verpasst es. Die Weltzeit steht still, nur tools.wait lässt sie laufen, höchstens 1440 Minuten (ein Tag) insgesamt. "lege holz ins feuer" legt ein Stück hinein, neben dem Feuer stehend. Befehle sind deutsch, wie ein Spieler sie tippt.\n\nPunkte: Jeder Tool-Aufruf kostet einen Punkt (höchstens ${MAX_BOT_CALLS}). Unter den Bots, die das Ziel erreichen, gewinnt der mit den wenigsten Punkten, die Zeit entscheidet erst danach.\n\nBewertung: Am Ende fragt der Richter die Welt, wie viele Stück der Bot ins Feuer gelegt hat (mindestens 6). Rückgabewert egal.\n\nTools:\n${describeBotTools("de")}`,
			en: `Task: write async function bot(). The bot plays a figure in a Leuchtfeuer world of its own and is to put 6 pieces of driftwood into the beacon of the Graue Bucht within one world day.\n\nWorld: the figure starts in the Graue Bucht. At first only 2 pieces of driftwood lie on the beach; the tide washes up more while time passes (a piece every one to three hours, at random times and places). Washed-up driftwood is gone again after about 30 minutes unless someone picks it up: a bot that waits too long misses it. World time stands still; only tools.wait lets it pass, at most 1440 minutes (a day) in all. "lege holz ins feuer" puts one piece in, standing next to the fire. Commands are German, as a player types them.\n\nPoints: every tool call costs one point (at most ${MAX_BOT_CALLS}). Among the bots that reach the goal the one with the fewest points wins; the time decides only after that.\n\nScoring: at the end the judge asks the world how many pieces the bot put into the fire (at least 6). The return value does not matter.\n\nTools:\n${describeBotTools("en")}`,
		},
		about: {
			de: `So läuft es: Wie beim Leuchtfeuer-Bot öffnet die Arena für jeden Beitrag eine eigene Welt, nur dauert ein Lauf hier rund fünfzig bis hundert Tool-Aufrufe und eine Viertelminute. Dieser Lauf übersteht den Absturz seines Richters: Jede Antwort der Welt wird in den Space geschrieben, bevor der Bot sie bekommt. Stirbt der Richter, übernimmt ein anderer, startet den Bot neu mit demselben Startwert für Zufall und Uhr und spielt ihm die gespeicherten Antworten in derselben Reihenfolge ein; der Bot rechnet genauso wie beim ersten Mal und landet an derselben Stelle. Dann geht es live weiter, in derselben Welt (sie überlebt den Richter). Ein Befehl, der beim Absturz gerade unterwegs war, wird nicht doppelt ausgeführt: die Welt erkennt ihn wieder. Kein KI-Modell nötig.`,
			en: `How it runs: as with the beacon bot, the arena opens a world of its own for every contribution, only a run here takes about fifty to a hundred tool calls and a quarter of a minute. This run survives a crash of its judge: every answer of the world is written to the space before the bot gets it. If the judge dies, another one takes over, starts the bot again with the same seed for randomness and clock and hands it the stored answers in the same order; the bot computes exactly as the first time and arrives at the same point. Then it goes on live, in the same world (it outlives the judge). A command that was on its way when the judge died is not carried out twice: the world recognises it. No AI model is needed.`,
		},
		cases: [],
		bench: "",
		variants: [
			// gathers what lies there, feeds it, waits 20 minutes, looks again: correct
			`async function bot(){let fed=0,s=await tools.look();const fire=s.fires[0];for(let i=0;i<72;i++){let got=0;for(const w of s.things.filter(t=>t.name==="Treibholz")){await tools.act({line:"move "+w.x+" "+w.y});const r=await tools.act({line:"nimm treibholz"});if(r.said.some(x=>/hebst/.test(x)))got++}if(got){await tools.act({line:"move "+fire.x+" "+(fire.y-1)});for(let k=0;k<got;k++){const r=await tools.act({line:"lege holz ins feuer"});if(r.said.some(x=>/legst/.test(x)))fed++}}if(fed>=6)return fed;await tools.wait({minutes:20});s=await tools.look()}return fed}`,
			// the same, and it looks again after every piece: correct, more points
			`async function bot(){let fed=0,s=await tools.look();const fire=s.fires[0];for(let i=0;i<72;i++){let got=0;for(const w of s.things.filter(t=>t.name==="Treibholz")){await tools.act({line:"move "+w.x+" "+w.y});const r=await tools.act({line:"nimm treibholz"});await tools.look();if(r.said.some(x=>/hebst/.test(x)))got++}if(got){await tools.act({line:"move "+fire.x+" "+(fire.y-1)});for(let k=0;k<got;k++){const r=await tools.act({line:"lege holz ins feuer"});if(r.said.some(x=>/legst/.test(x)))fed++}}if(fed>=6)return fed;await tools.wait({minutes:20});s=await tools.look()}return fed}`,
			// wrong: never waits, so only the first two pieces
			`async function bot(){const s=await tools.look();const fire=s.fires[0];for(const w of s.things.filter(t=>t.name==="Treibholz")){await tools.act({line:"move "+w.x+" "+w.y});await tools.act({line:"nimm treibholz"})}await tools.act({line:"move "+fire.x+" "+(fire.y-1)});await tools.act({line:"lege holz ins feuer"});await tools.act({line:"lege holz ins feuer"})}`,
			// wrong: gives up after four pieces
			`async function bot(){let fed=0,s=await tools.look();const fire=s.fires[0];for(let i=0;i<72&&fed<4;i++){for(const w of s.things.filter(t=>t.name==="Treibholz")){await tools.act({line:"move "+w.x+" "+w.y});await tools.act({line:"nimm treibholz"});await tools.act({line:"move "+fire.x+" "+(fire.y-1)});const r=await tools.act({line:"lege holz ins feuer"});if(r.said.some(x=>/legst/.test(x)))fed++;if(fed>=4)break}await tools.wait({minutes:20});s=await tools.look()}return fed}`,
		],
	},
	{
		id: "harness-sort", fn: "rate", kind: "harness", timeoutMs: 10_000,
		harness: SORT_HARNESS,
		title: { de: "Bewertungsskript: Sortierfunktionen prüfen", en: "Eval harness: rate sort functions" },
		prompt: {
			de: `Aufgabe: Schreibe async function rate(). Sie bewertet eine Implementierung von sortNumbers(arr) mit einer Zahl: höher ist besser. Gefordert ist von sortNumbers: die Zahlen aufsteigend sortiert als neues Array, alle Zahlen (auch doppelte und negative), und schnell (O(n log n), nicht quadratisch).\n\nDen Code der Implementierung siehst du nicht. Du rufst sie über ein Werkzeug auf:\n${describeHarnessTools(SORT_HARNESS, "de")}\n\nWertung: Der Richter ruft rate() einmal pro Implementierung auf. Gute Implementierungen sind die Referenz (eingebautes sort) und versteckte weitere. Schlechte sind diese drei und versteckte weitere: eine sortiert als Text ("10" vor "9"), eine kennt nur die Beispiele der Aufgabe "Zahlen sortieren" auswendig, eine ist Bubblesort (richtig, aber quadratisch). rate() zählt nur, wenn jede gute Implementierung eine echt höhere Zahl bekommt als jede schlechte. Zeiten hängen von der Maschine ab: vergleiche eine gemessene Zeit mit etwas, das rate() selbst misst (2000 Zahlen sortiert ein O(n log n)-Verfahren in rund 5 bis 30 ms, Bubblesort braucht hunderte).\n\nPunkte: Jeder run kostet 1 Punkt; gezählt werden die Aufrufe bei den gezeigten Implementierungen. Unter den richtigen Bewertungsskripten gewinnt das mit den wenigsten Punkten, danach das schnellste.`,
			en: `Task: write async function rate(). It rates an implementation of sortNumbers(arr) with a number: higher is better. What sortNumbers must do: return the numbers in ascending order as a new array, all of them (duplicates and negatives too), and fast (O(n log n), not quadratic).\n\nYou do not see the implementation's code. You call it through a tool:\n${describeHarnessTools(SORT_HARNESS, "en")}\n\nScoring: the judge calls rate() once per implementation. The good ones are the reference (built-in sort) and hidden others. The bad ones are these three and hidden others: one sorts as text ("10" before "9"), one knows only the examples of the task "Sort numbers" by heart, one is bubble sort (right, but quadratic). rate() counts only when every good implementation gets a strictly higher number than every bad one. Times depend on the machine: compare a measured time with something rate() times itself (an O(n log n) sort takes about 5 to 30 ms for 2000 numbers, bubble sort hundreds).\n\nPoints: every run costs 1 point, counted on the shown implementations. Among correct harnesses the one with the fewest points wins, then the fastest.`,
		},
		about: {
			de: `So läuft es: Der Beitrag ist kein Sortierverfahren, sondern ein Prüfskript. Der Richter ruft rate() für jede Implementierung einmal in einer eigenen Sandbox auf; jeder tools.run startet die Implementierung in einer weiteren, frischen Sandbox, so dass sie das Prüfskript nicht täuschen kann und es ihren Code nie sieht. Die Implementierungen liegen in der Aufgabe fest, bevor ein Skript geschrieben wird: niemand bewertet seine eigene Arbeit. Ein Teil davon ist versteckt wie das Holdout der Tools-Aufgaben; von ihnen zeigt die Seite nur, ob sie richtig eingeordnet wurden, nicht ihre Zahl und nicht ihre Fehlermeldung. Kein KI-Modell nötig: nur Modell-Agenten, die das Skript schreiben, brauchen eines.`,
			en: `How it runs: the contribution is not a sort but a test script. The judge calls rate() once per implementation in a sandbox of its own; every tools.run starts the implementation in another, fresh sandbox, so it cannot fool the script, and the script never sees its code. The implementations are fixed in the task before any script is written: nobody grades their own work. Some of them are hidden like the holdout of the tools tasks; the page shows of them only whether they were ordered right, not their number and not their error message. No AI model is needed: only model agents writing the script use one.`,
		},
		cases: [],
		bench: "",
		variants: [
			// one run: a large array with duplicates and negatives against its own merge sort, timed against that sort (timed
			// before and after the run, the slower counts: a machine busy for a moment does not make a good one slow)
			`async function rate(){let s=3;const a=[];for(let i=0;i<2000;i++)a.push(((s=(Math.imul(s,1103515245)+12345)>>>0)%2001)-1000);const own=x=>{if(x.length<2)return x;const h=x.length>>1,l=own(x.slice(0,h)),r=own(x.slice(h)),o=[];let i=0,j=0;while(i<l.length&&j<r.length)o.push(l[i]<=r[j]?l[i++]:r[j++]);return o.concat(l.slice(i),r.slice(j))};let base=0,want;const time=()=>{const t=Date.now();want=own(a);base=Math.max(base,Date.now()-t)};time();time();const r=await tools.run({args:[a]});time();if(r.error||!Array.isArray(r.value)||r.value.length!==want.length)return 0;for(let i=0;i<want.length;i++)if(r.value[i]!==want[i])return 0;return r.ms>3*base+5?0.5:1}`,
			// the same and three small runs first: correct, more points
			`async function rate(){const own=x=>[...x].sort((p,q)=>p-q);for(const x of [[],[1],[3,-1,3,2]]){const r=await tools.run({args:[x]});if(r.error||JSON.stringify(r.value)!==JSON.stringify(own(x)))return 0}let s=3;const a=[];for(let i=0;i<2000;i++)a.push(((s=(Math.imul(s,1103515245)+12345)>>>0)%2001)-1000);const ms=x=>{if(x.length<2)return x;const h=x.length>>1,l=ms(x.slice(0,h)),r=ms(x.slice(h)),o=[];let i=0,j=0;while(i<l.length&&j<r.length)o.push(l[i]<=r[j]?l[i++]:r[j++]);return o.concat(l.slice(i),r.slice(j))};let base=0;const time=()=>{const t=Date.now();ms(a);base=Math.max(base,Date.now()-t)};time();time();const r=await tools.run({args:[a]});time();if(r.error||JSON.stringify(r.value)!==JSON.stringify(own(a)))return 0;return r.ms>3*base+5?0.5:1}`,
			// wrong: checks only the examples of "Sort numbers" (the hard-coded one passes)
			`async function rate(){for(const x of [[3,1,2],[10,9,100,-5,0,2,2]]){const r=await tools.run({args:[x]});if(r.error||JSON.stringify(r.value)!==JSON.stringify([...x].sort((p,q)=>p-q)))return 0}return 1}`,
			// wrong: right results only, speed ignored (bubble sort scores like the reference)
			`async function rate(){let s=3;const a=[];for(let i=0;i<2000;i++)a.push(((s=(Math.imul(s,1103515245)+12345)>>>0)%2001)-1000);const r=await tools.run({args:[a]});return !r.error&&JSON.stringify(r.value)===JSON.stringify([...a].sort((p,q)=>p-q))?1:0}`,
			// wrong: rates everything the same
			`async function rate(){return 1}`,
		],
	},
];

export const taskById = (id: string): Task | undefined => TASKS.find((t) => t.id === id);
/** The catalog this process offers: bot tasks only with an arena (CODEMODE_ARENA), since no judge could judge them otherwise. */
export const offeredTasks = (): Task[] => TASKS.filter((t) => t.kind !== "bot" || !!arenaAddress());

/** A task as it may be stored or handed to another process: a tools task without its data and functions (the holdout
 *  must never leave the judge), and `restoreTask` brings them back from the catalog. */
/** A data task from its spec; `holdout` only in the judge (judge-host.ts loads it), else only the sample is judged. */
export function dataTask(spec: DataSpec, holdout?: { items: DataItem[]; answer: string[] }): Task {
	const s = checkSpec(spec), n = s.sample.length, h = s.holdoutSize;
	return {
		id: "data", fn: "solve", kind: "tools", data: s, tools: dataToolSpec(s, holdout), ...(s.timeoutS !== undefined ? { timeoutMs: Math.round(s.timeoutS * 1000) } : { timeoutMs: 20_000 }),
		title: { de: "Eigene Datenaufgabe", en: "Custom data task" },
		prompt: {
			de: `Aufgabe: Schreibe async function solve(). Sie gibt die ids aller Einträge zurück, auf die diese Frage zutrifft (als Array, Reihenfolge egal):\n${s.question}\n\nDaten: ein hochgeladener Datensatz, nur über die Tools (await tools.<name>(args)). Felder eines Eintrags: id, ${s.fields.join(", ")}. Die Probe (${n} Einträge) ist der sichtbare Testfall; bewertet wird außerdem auf ${h} verborgenen Einträgen mit denselben Tools.\n\nPunkte: Jeder Tool-Aufruf kostet Punkte. Unter den richtigen Beiträgen gewinnt der mit den wenigsten Punkten, die Zeit entscheidet erst danach.\n\nBewertung: Übereinstimmung der ids mit der Antwort (F1), auf der Probe und den verborgenen Einträgen je 100 %.\n\nTools:\n${describeDataTools(s, "de")}`,
			en: `Task: write async function solve(). It returns the ids of all items this question applies to (an array, any order):\n${s.question}\n\nData: an uploaded dataset, only through the tools (await tools.<name>(args)). Fields of an item: id, ${s.fields.join(", ")}. The sample (${n} items) is the visible test case; it is also scored on ${h} hidden items with the same tools.\n\nPoints: every tool call costs points. Among the correct contributions the one with the fewest points wins; the time decides only after that.\n\nScoring: agreement of the ids with the answer (F1), 100 % on the sample and on the hidden items.\n\nTools:\n${describeDataTools(s, "en")}`,
		},
		about: {
			de: `So läuft es: Der Datensatz wurde auf dieser Seite hochgeladen. Jeder zehnte Eintrag (höchstens ${40}) ist die Probe, die Agenten und Seite mit Antwort sehen; der Rest liegt verborgen im Space und nur der Richter liest ihn. Kein KI-Modell nötig: nur Modell-Agenten, die den Code schreiben, brauchen eines.`,
			en: `How it runs: the dataset was uploaded on this page. Every tenth item (at most 40) is the sample, which agents and page see with its answer; the rest lies hidden in the space, and only the judge reads it. No AI model is needed: only model agents writing the code use one.`,
		},
		cases: [{ args: [], expect: s.sampleAnswer }],
		bench: "",
		variants: [],
	};
}

export const portableTask = (t: Task): Task => (t.kind === "tools" ? (({ tools: _tools, ...rest }) => rest)(t) : t.kind === "harness" ? (({ harness: _harness, ...rest }) => rest)(t) : t);
export const restoreTask = (t: Task): Task => (t.id === "data" && t.data && !t.tools ? dataTask(t.data) : (t.kind === "tools" && !t.tools) || (t.kind === "harness" && !t.harness) ? taskById(t.id) ?? t : t);

/** A user-defined task: the function name and the cases are the oracle; the bench runs every case 300 times. */
// Names a custom task cannot use as its function: reserved words, and the `__` prefix the judge keeps for itself.
const RESERVED = new Set("arguments await break case catch class const continue debugger default delete do else enum eval export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof undefined var void while with yield NaN Infinity".split(" "));

export function customTask(x: { fn: string; prompt: string; cases: Case[]; check?: string; checkBy?: "verifier" | "user"; timeoutS?: unknown }): Task {
	if (typeof x.fn !== "string" || !/^[A-Za-z_$][\w$]{0,40}$/.test(x.fn) || x.fn.startsWith("__") || RESERVED.has(x.fn)) throw new Error("Invalid function name");
	if (!Array.isArray(x.cases) || x.cases.length < 1 || x.cases.length > 50) throw new Error("1 to 50 cases required");
	const check = typeof x.check === "string" && x.check.trim() ? x.check.trim() : undefined;
	if (check !== undefined && check.length > MAX_CHECK_CHARS) throw new Error(`The check rule has at most ${MAX_CHECK_CHARS} characters`);
	for (const c of x.cases) {
		if (!c || !Array.isArray(c.args)) throw new Error("Every case needs args (an array)");
		if (Object.hasOwn(c, "expectAny") && (!Array.isArray(c.expectAny) || c.expectAny.length < 1 || c.expectAny.length > 10)) throw new Error("expectAny holds 1 to 10 results");
		if (check === undefined && !Object.hasOwn(c, "expect") && !Object.hasOwn(c, "expectAny")) throw new Error("Every case needs expect (or expectAny), or the task a check rule");
	}
	if (JSON.stringify(x.cases).length > 32_000) throw new Error("Cases too large");
	// an expected result that is text looking like test cases or a number list was almost certainly JSON that could not
	// be read (e.g. commas left out): the agents would chase a string nobody meant
	const typo = (v: unknown) => typeof v === "string" && /^\s*[[{]/.test(v) && (/"?\b(args|expect)\b"?\s*:/.test(v) || /^\s*\[[-\d.\s,]*\]\s*$/.test(v));
	for (const c of x.cases) if ((Object.hasOwn(c, "expectAny") ? c.expectAny! : [c.expect]).some(typo)) throw new Error("An expected result is text that looks like JSON (test cases or a number list); check the JSON, e.g. commas between the numbers");
	const maxS = maxTimeoutMs() / 1000, timeoutS = x.timeoutS === undefined || x.timeoutS === null || x.timeoutS === "" ? undefined : Number(x.timeoutS);
	if (timeoutS !== undefined && !(Number.isFinite(timeoutS) && timeoutS >= 1 && timeoutS <= maxS)) throw new Error(`The time limit is 1 to ${maxS} seconds`);
	const t = { id: "custom", fn: x.fn, title: { de: "Eigene Aufgabe", en: "Custom task" }, prompt: { de: x.prompt, en: x.prompt }, cases: x.cases, variants: [], ...(check !== undefined ? { check, checkBy: x.checkBy === "verifier" ? "verifier" as const : "user" as const } : {}), ...(timeoutS !== undefined ? { timeoutMs: Math.round(timeoutS * 1000) } : {}) };
	// Rounds of all cases until 300 rounds or about a second, whichever comes first; the time is per round, so a slow
	// function is timed, not timed out. Index loops and the judge's captured Reflect.apply: a contribution that patches
	// iterators cannot empty the bench. Every call is checked (fixed results), or one random round is kept for the check
	// rule, so code that is right only on the first calls (a call counter) does not win.
	const call = `let __v = __apply(${x.fn}, undefined, __cases[__j].args); if (__v && typeof __v.then === "function") __v = await __v;`;
	const keep = check !== undefined
		? `__last[__j] = __v; if (__r === __pick) __picked[__j] = __v;`
		: `if (!__match(__v, __cases[__j])) return { ok: false, error: "inconsistent on repeated calls" };`;
	return { ...t, bench: `const __deadline = __now() + 1000; let __r = 0;
for (; __r < 300 && (__r === 0 || __now() < __deadline); __r++) for (let __j = 0; __j < __cases.length; __j++) { ${call} ${keep} }
__rounds = __r;` };
}

/** The spec a custom task is stored as (CodeTask, CodeCandidate). */
export const customSpec = (t: Task) => ({ fn: t.fn, prompt: t.prompt.en, cases: t.cases, ...(t.check !== undefined ? { check: t.check, checkBy: t.checkBy ?? "user" } : {}), ...(t.timeoutMs !== undefined ? { timeoutS: t.timeoutMs / 1000 } : {}) });

/** The results a case accepts (empty: a check rule decides). */
export const expectedOf = (c: Case): unknown[] => (Object.hasOwn(c, "expectAny") ? c.expectAny! : Object.hasOwn(c, "expect") ? [c.expect] : []);

/** The task a CodeTask / CodeCandidate entry stands for: a catalog id, or a custom spec (fn, prompt, cases). */
export function taskFromSpec(f: { taskId?: unknown; custom?: unknown; text?: unknown; data?: unknown; fn?: unknown; prompt?: unknown; cases?: unknown }): Task | null {
	if (f.taskId === "data") { try { return dataTask(f.data as DataSpec); } catch { return null; } }
	if (f.taskId === "text") { try { return textTask((f.text ?? {}) as { prompt: unknown }); } catch { return null; } }
	if (f.taskId === "custom") {
		const c = (f.custom ?? { fn: f.fn, prompt: f.prompt, cases: f.cases }) as { fn: string; prompt: string; cases: Case[]; check?: string; checkBy?: "verifier" | "user"; timeoutS?: number };
		try { return customTask(c); } catch { return null; }
	}
	return taskById(String(f.taskId)) ?? null;
}
