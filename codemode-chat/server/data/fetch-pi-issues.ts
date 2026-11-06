// Fetches the dataset of the catalog tasks "pi-windows" and "pi-windows-bugs" (tasks.ts): recent issues of
// github.com/earendil-works/pi, shortened and without names, written to server/data/pi-issues.json. Run by hand, never
// by the server or the tests:
//   node --experimental-strip-types server/data/fetch-pi-issues.ts --fetch 1000  (needs `gh` logged in)
//   node --experimental-strip-types server/data/fetch-pi-issues.ts --jev         (labels the file's issues with Jev)
// The texts belong to their authors, so the file keeps only what the tasks need: the title, the body and the first
// comments, each cut short; logins become u1, u2, … (a bot becomes "bot"), and @mentions and links to other people's
// repositories lose the name.
//
// --jev asks Jev (typesafe/jev-1.13, a decisions model behind OpenRouter's /api/alpha/decisions) once per issue what
// kind of issue it is, ten issues per call, and stores its answers in the file. The judge never calls Jev: its tool
// `jev` replays these recorded answers, so a contribution scores the same on every host and costs no tokens. Needs
// JEV_OPENROUTER_API_KEY (codemode-chat/.env); 1000 issues are 100 calls, about 0.013 $.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { loadDotEnv } from "../env.ts";

const FILE = new URL("./pi-issues.json", import.meta.url);
const REPO = "earendil-works/pi";
const BODY_CHARS = 600, COMMENT_CHARS = 400, MAX_COMMENTS = 8;
const JEV_MODEL = "typesafe/jev-1.13", JEV_BATCH = 10;
/** What Jev chooses between; the descriptions go to Jev as the choice's criteria. */
export const JEV_KINDS = {
	bug: "reports something that does not work as it should",
	feature: "asks for new behaviour or an improvement",
	question: "asks how something works or for help",
	other: null,
} as const;

type Issue = { id: string; title: string; body: string; comments: Array<{ by: string; text: string }> };
type JevAnswer = { kind: keyof typeof JEV_KINDS; confidence: number };
type Data = { source: string; fetched: string; note: string; issues: Issue[]; jev?: { model: string; labelled: string; kinds: typeof JEV_KINDS; answers: Record<string, JevAnswer> } };

function fetchIssues(count: number): Data {
	type Raw = { number: number; title: string; body: string; comments: Array<{ author: { login: string } | null; body: string }> };
	const raw = JSON.parse(execFileSync("gh", ["issue", "list", "-R", REPO, "--state", "all", "--limit", String(count), "--json", "number,title,body,comments"], { encoding: "utf8", maxBuffer: 1 << 28 })) as Raw[];
	const isBot = (login: string) => /\[bot\]$|^github-actions$|bot$/i.test(login);
	const names = new Map<string, string>();
	const who = (login: string | undefined) => {
		if (!login || isBot(login)) return "bot";
		if (!names.has(login)) names.set(login, `u${names.size + 1}`);
		return names.get(login)!;
	};
	const scrub = (text: string, max: number) => {
		const t = (text ?? "")
			.replace(/github\.com\/(?!earendil-works\b)[\w.-]+/gi, "github.com/someone")
			.replace(/(^|[^\w/])@[\w-]+/g, "$1@someone")
			.replace(/\r\n/g, "\n").trim();
		return t.length > max ? `${t.slice(0, max)}…` : t;
	};
	raw.sort((a, b) => a.number - b.number);
	const issues = raw.map((i) => ({
		id: `I-${i.number}`,
		title: scrub(i.title, 200),
		body: scrub(i.body, BODY_CHARS),
		comments: i.comments.slice(0, MAX_COMMENTS).map((c) => ({ by: who(c.author?.login), text: scrub(c.body, COMMENT_CHARS) })),
	}));
	return { source: `https://github.com/${REPO}/issues`, fetched: new Date().toISOString().slice(0, 10), note: "shortened, names replaced (server/data/fetch-pi-issues.ts)", issues };
}

async function labelWithJev(data: Data): Promise<Data> {
	loadDotEnv();
	const key = process.env.JEV_OPENROUTER_API_KEY;
	if (!key) throw new Error("JEV_OPENROUTER_API_KEY is not set (codemode-chat/.env)");
	const answers: Record<string, JevAnswer> = {};
	let model = "", cost = 0;
	for (let i = 0; i < data.issues.length; i += JEV_BATCH) {
		const batch = data.issues.slice(i, i + JEV_BATCH);
		const body = {
			model: JEV_MODEL,
			state: Object.fromEntries(batch.map((x) => [x.id, { title: x.title, body: x.body }])),
			questions: Object.fromEntries(batch.map((x) => [x.id, { type: "choice", instructions: `What kind of issue is ${x.id} in the state?`, criteria: JEV_KINDS }])),
		};
		const r = await fetch("https://openrouter.ai/api/alpha/decisions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
		const j = await r.json() as { model?: string; answers?: Record<string, { choice: string; confidence: number }>; usage?: { cost?: number }; error?: { message: string } };
		if (!r.ok || !j.answers) throw new Error(`Jev: ${r.status} ${j.error?.message ?? "no answers"}`);
		for (const x of batch) {
			const a = j.answers[x.id];
			if (!a || !(a.choice in JEV_KINDS)) throw new Error(`Jev gave no valid answer for ${x.id}`);
			answers[x.id] = { kind: a.choice as JevAnswer["kind"], confidence: Math.round(a.confidence * 100) / 100 };
		}
		model = j.model ?? model; cost += j.usage?.cost ?? 0;
		process.stdout.write(`\r${Math.min(i + JEV_BATCH, data.issues.length)}/${data.issues.length}`);
	}
	console.log(`\nJev ${model}: ${Object.keys(answers).length} answers, ${cost.toFixed(5)} $`);
	return { ...data, jev: { model, labelled: new Date().toISOString().slice(0, 10), kinds: JEV_KINDS, answers } };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	const args = process.argv.slice(2), at = args.indexOf("--fetch");
	let data: Data = at >= 0 ? fetchIssues(Number(args[at + 1] ?? 1000)) : JSON.parse(readFileSync(FILE, "utf8"));
	if (args.includes("--jev")) data = await labelWithJev(data);
	else if (at >= 0) delete data.jev; // fresh issues: old Jev answers would not match them
	writeFileSync(FILE, `${JSON.stringify(data, null, "\t")}\n`);
	console.log(`${data.issues.length} issues (${data.issues[0]?.id} … ${data.issues.at(-1)?.id}), Jev: ${data.jev ? "yes" : "no"} → ${FILE.pathname}`);
}
