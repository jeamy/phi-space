// Task catalog: what the agents are asked to write, how a contribution is checked (cases) and timed (bench), and a few
// hand-written variants that the scripted (model-free) agents hand in. All code here runs only in the sandbox.
export type Case = { args: unknown[]; expect: unknown };
export type Task = {
	id: string;
	title: { de: string; en: string };
	fn: string;
	prompt: { de: string; en: string };
	cases: Case[];
	/** Sandbox statements timed by the judge (they call `fn` by name); may `return { ok: false, error }` when a large input is answered wrongly. */
	bench: string;
	/** Optional sandbox expression for the bench input, evaluated BEFORE the contribution runs; the bench reads it as `__in`. */
	benchInput?: string;
	variants: string[];
};

const primes = (n: number) => { const p: number[] = []; for (let c = 2; p.length < n; c++) if (p.every((d) => d * d > c || c % d !== 0)) p.push(c); return p; };
const fibs = (n: number) => { let a = 0, b = 1; for (let i = 0; i < n; i++) [a, b] = [b, a + b]; return a; };
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcg = (seed: number) => () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % 100000;
const sampleArrays = (() => { const r = lcg(7); return [[], [1], [3, 1, 2], [10, 9, 100, -5, 0, 2, 2], Array.from({ length: 40 }, r)]; })();

export const TASKS: Task[] = [
	{
		id: "primes", fn: "firstPrimes",
		title: { de: "Die ersten n Primzahlen", en: "The first n primes" },
		prompt: { de: "Schreibe firstPrimes(n): die ersten n Primzahlen als Array (aufsteigend).", en: "Write firstPrimes(n): the first n primes as an ascending array." },
		cases: [0, 1, 2, 10, 100].map((n) => ({ args: [n], expect: primes(n) })),
		bench: `const r = firstPrimes(3000); if (r.length !== 3000 || r[2999] !== ${primes(3000)[2999]}) return { ok: false, error: "wrong on n = 3000" };`,
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
		bench: `for (let i = 0; i < 20; i++) fib(24);`,
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
		bench: `const r = sortNumbers(__in); if (!r || r.length !== 4000) return { ok: false, error: "wrong length on 4000 numbers" }; for (let i = 1; i < 4000; i++) if (r[i - 1] > r[i]) return { ok: false, error: "not sorted on 4000 numbers" };`,
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
		bench: `let x = 0; for (let i = 1; i < 3000; i++) x += gcd(1000003 * i, 999983 * (i + 7));`,
		variants: [
			`function gcd(a,b){let g=1;for(let d=1;d<=Math.min(a,b);d++)if(a%d===0&&b%d===0)g=d;return a===0?b:b===0?a:g}`,
			`function gcd(a,b){while(a!==b){if(a===0)return b;if(b===0)return a;if(a>b)a-=b;else b-=a}return a}`,
			`function gcd(a,b){while(b){[a,b]=[b,a%b]}return a}`,
			`function gcd(a,b){return b===0?a:gcd(b,a%b)}`,
		],
	},
];

export const taskById = (id: string): Task | undefined => TASKS.find((t) => t.id === id);

/** A user-defined task: the function name and the cases are the oracle; the bench runs every case 300 times. */
// Names a custom task cannot use as its function: reserved words, and the `__` prefix the judge keeps for itself.
const RESERVED = new Set("arguments await break case catch class const continue debugger default delete do else enum eval export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof undefined var void while with yield NaN Infinity".split(" "));

export function customTask(x: { fn: string; prompt: string; cases: Case[] }): Task {
	if (typeof x.fn !== "string" || !/^[A-Za-z_$][\w$]{0,40}$/.test(x.fn) || x.fn.startsWith("__") || RESERVED.has(x.fn)) throw new Error("Invalid function name");
	if (!Array.isArray(x.cases) || x.cases.length < 1 || x.cases.length > 50) throw new Error("1 to 50 cases required");
	for (const c of x.cases) if (!c || !Array.isArray(c.args)) throw new Error("Every case needs args (array) and expect");
	if (JSON.stringify(x.cases).length > 32_000) throw new Error("Cases too large");
	const t = { id: "custom", fn: x.fn, title: { de: "Eigene Aufgabe", en: "Custom task" }, prompt: { de: x.prompt, en: x.prompt }, cases: x.cases, variants: [] };
	// index loops and the judge's captured Reflect.apply: a contribution that patches iterators cannot empty the bench
	return { ...t, bench: `for (let __r = 0; __r < 300; __r++) for (let __j = 0; __j < __cases.length; __j++) __apply(${x.fn}, undefined, __cases[__j].args);` };
}

/** The task a CodeTask / CodeCandidate entry stands for: a catalog id, or a custom spec (fn, prompt, cases). */
export function taskFromSpec(f: { taskId?: unknown; custom?: unknown; fn?: unknown; prompt?: unknown; cases?: unknown }): Task | null {
	if (f.taskId === "custom") {
		const c = (f.custom ?? { fn: f.fn, prompt: f.prompt, cases: f.cases }) as { fn: string; prompt: string; cases: Case[] };
		try { return customTask(c); } catch { return null; }
	}
	return taskById(String(f.taskId)) ?? null;
}
