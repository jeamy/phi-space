// Task catalog: what the agents are asked to write, how a contribution is checked (cases) and timed (bench), and a few
// hand-written variants that the scripted (model-free) agents hand in. All code here runs only in the sandbox.
import { MAX_CHECK_CHARS, maxTimeoutMs } from "./judge.ts";
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
	kind?: "code" | "text" | "tools";
	/** "tools": the tools and data of the sandbox (tooltask.ts); the one case is the sample world's answer. */
	tools?: ToolSpec;
	/** What happens behind the task, for the people on the page only (never in an agent's prompt): where the data
	 *  comes from, whether models are needed, what a tool does in the background. */
	about?: { de: string; en: string };
	criteria?: string[];
	/** Who wrote the criteria: the person (the optional field) or the verifier agent (when it was empty). */
	criteriaBy?: "user" | "verifier";
};

export const isText = (t: Task): boolean => t.kind === "text";
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
];

export const taskById = (id: string): Task | undefined => TASKS.find((t) => t.id === id);

/** A task as it may be stored or handed to another process: a tools task without its data and functions (the holdout
 *  must never leave the judge), and `restoreTask` brings them back from the catalog. */
export const portableTask = (t: Task): Task => (t.kind === "tools" ? (({ tools: _tools, ...rest }) => rest)(t) : t);
export const restoreTask = (t: Task): Task => (t.kind === "tools" && !t.tools ? taskById(t.id) ?? t : t);

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
export function taskFromSpec(f: { taskId?: unknown; custom?: unknown; text?: unknown; fn?: unknown; prompt?: unknown; cases?: unknown }): Task | null {
	if (f.taskId === "text") { try { return textTask((f.text ?? {}) as { prompt: unknown }); } catch { return null; } }
	if (f.taskId === "custom") {
		const c = (f.custom ?? { fn: f.fn, prompt: f.prompt, cases: f.cases }) as { fn: string; prompt: string; cases: Case[]; check?: string; checkBy?: "verifier" | "user"; timeoutS?: number };
		try { return customTask(c); } catch { return null; }
	}
	return taskById(String(f.taskId)) ?? null;
}
