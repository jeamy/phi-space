// Records Jev as the planner's estimator on "Shores of the tide" (step 9, docs/codemode-planung.en.md): Jev
// (typesafe/jev-1.13, a decisions model behind OpenRouter's /api/alpha/decisions) reads an island's logbook and says,
// for every room, how often the tide brings a piece there; shores.ts `jevShoreBot` plans its round with these answers
// as the odds, the same round the learner plans with the counted rates. Run by hand, never by the server or the tests:
//   node --experimental-strip-types server/data/fetch-shore-jev.ts [--noul | --seen] [--repeats 3] [--from 34] [--to 233]
// Without --noul Jev chooses one of four classes (SHORE_JEV_CLASSES, the generator's own levels: a hint no bot gets);
// with --noul it is asked only whether a piece lands in the room at the next tide, and its probability of "yes" is the
// room's odds: no levels, nothing of the generator (server/data/shore-jev-noul.json). With --seen it is asked whether
// the logbook shows a piece in the room on any day (server/data/shore-jev-seen.json): a room it says no to counts as
// empty, so the round leaves out the rooms Jev's `noul` gives a small, never zero, probability.
// The judge never calls Jev: the answers are written to server/data/shore-jev.json and replayed, so a bot scores the
// same on every host. Needs JEV_OPENROUTER_API_KEY (codemode-chat/.env).
import { writeFileSync } from "node:fs";
import { loadDotEnv } from "../env.ts";
import { genIsland, shoreLog, shoreOf, shoreRooms } from "../toyisland.ts";

const FILE = new URL("./shore-jev.json", import.meta.url), NOUL_FILE = new URL("./shore-jev-noul.json", import.meta.url), SEEN_FILE = new URL("./shore-jev-seen.json", import.meta.url);
const JEV_MODEL = "typesafe/jev-1.13", JEV_BATCH = 10;
/** What Jev chooses between, and the odds each answer stands for in the round. */
export const SHORE_JEV_CLASSES = {
	never: "the tide brings no piece to this room",
	rare: "a piece lands here at about one tide in ten",
	sometimes: "a piece lands here at about one tide in three",
	often: "a piece lands here at about two tides in three",
} as const;
export type ShoreJevClass = keyof typeof SHORE_JEV_CLASSES;
export const SHORE_JEV_ODDS: Record<ShoreJevClass, number> = { never: 0, rare: 0.1, sometimes: 0.35, often: 0.7 };
export type ShoreJevData = {
	model: string; recorded: string; classes: typeof SHORE_JEV_CLASSES; calls: number; costUsd: number;
	/** Per island, one answer set per repeat: room → [class, confidence]. */
	islands: Record<string, Array<Record<string, [ShoreJevClass, number]>>>;
};
/** The --noul and --seen recordings: per island, one set per repeat, room → Jev's probability of "yes". */
export type ShoreJevNoulData = { model: string; recorded: string; question: string; calls: number; costUsd: number; islands: Record<string, Array<Record<string, number>>> };
const NOUL_QUESTION = (r: string) => `At the next tide, does a piece of driftwood land in room ${r}?`;
const SEEN_QUESTION = (r: string) => `Does the logbook show a piece of driftwood in room ${r} on any of its days?`;

/** The islands of step 9's selection: every made island with at least two rooms of odds 0.35 or more. */
export const shoreCandidates = (from = 34, to = 233): number[] => {
	const out: number[] = [];
	for (let i = from; i <= to; i++) { const w = genIsland(i); if (shoreRooms(w).filter((r) => shoreOf(w, r) >= 0.35).length >= 2) out.push(i); }
	return out;
};

/** The state Jev reads: the logbook as a bot gets it, without the ways (they say nothing of the odds). */
const logState = (n: number) => {
	const days = shoreLog(genIsland(n));
	return {
		logbook: "the harbour master's logbook of this island: each logged day, the tides came at these minutes, and for every room the pieces that landed there that day",
		tidesPerDay: days[0]!.minutes.length, days: days.length,
		entries: days.map((d) => ({ day: d.day, tides: d.minutes, rooms: Object.fromEntries(d.rooms.map((r) => [r.room, r.pieces.map((p) => p.minute)])) })),
	};
};

async function askNoul(key: string, state: unknown, rooms: string[], question: (r: string) => string): Promise<{ answers: Record<string, number>; model: string; cost: number }> {
	const body = { model: JEV_MODEL, state, questions: Object.fromEntries(rooms.map((r) => [r, { type: "noul", instructions: question(r) }])) };
	for (let attempt = 1; ; attempt++) {
		const r = await fetch("https://openrouter.ai/api/alpha/decisions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
		const j = await r.json().catch(() => ({})) as { model?: string; answers?: Record<string, { noul: number }>; usage?: { cost?: number }; error?: { message: string } };
		if (r.ok && j.answers && rooms.every((x) => typeof j.answers![x]?.noul === "number")) {
			return { answers: Object.fromEntries(rooms.map((x) => [x, Math.round(j.answers![x]!.noul * 1000) / 1000])), model: j.model ?? JEV_MODEL, cost: j.usage?.cost ?? 0 };
		}
		if (attempt >= 4) throw new Error(`Jev: ${r.status} ${j.error?.message ?? "no valid answers"}`);
		await new Promise((res) => setTimeout(res, 2000 * attempt));
	}
}

async function ask(key: string, state: unknown, rooms: string[]): Promise<{ answers: Record<string, [ShoreJevClass, number]>; model: string; cost: number }> {
	const body = {
		model: JEV_MODEL, state,
		questions: Object.fromEntries(rooms.map((r) => [r, { type: "choice", instructions: `How often does the tide bring a piece of driftwood to room ${r}, judged from the logbook in the state?`, criteria: SHORE_JEV_CLASSES }])),
	};
	for (let attempt = 1; ; attempt++) {
		const r = await fetch("https://openrouter.ai/api/alpha/decisions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
		const j = await r.json().catch(() => ({})) as { model?: string; answers?: Record<string, { choice: string; confidence: number }>; usage?: { cost?: number }; error?: { message: string } };
		if (r.ok && j.answers && rooms.every((x) => j.answers![x]?.choice! in SHORE_JEV_CLASSES)) {
			return { answers: Object.fromEntries(rooms.map((x) => [x, [j.answers![x]!.choice as ShoreJevClass, Math.round(j.answers![x]!.confidence * 100) / 100]])), model: j.model ?? JEV_MODEL, cost: j.usage?.cost ?? 0 };
		}
		if (attempt >= 4) throw new Error(`Jev: ${r.status} ${j.error?.message ?? "no valid answers"}`);
		await new Promise((res) => setTimeout(res, 2000 * attempt));
	}
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	loadDotEnv();
	const key = process.env.JEV_OPENROUTER_API_KEY;
	if (!key) throw new Error("JEV_OPENROUTER_API_KEY is not set (codemode-chat/.env)");
	const args = process.argv.slice(2), opt = (k: string, d: number) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
	const repeats = opt("--repeats", 3), islands = shoreCandidates(opt("--from", 34), opt("--to", 233));
	const seen = args.includes("--seen"), noul = seen || args.includes("--noul"), file = seen ? SEEN_FILE : noul ? NOUL_FILE : FILE;
	const question = seen ? SEEN_QUESTION : NOUL_QUESTION;
	const data: ShoreJevData | ShoreJevNoulData = noul
		? { model: JEV_MODEL, recorded: new Date().toISOString().slice(0, 10), question: question("<room>"), calls: 0, costUsd: 0, islands: {} }
		: { model: JEV_MODEL, recorded: new Date().toISOString().slice(0, 10), classes: SHORE_JEV_CLASSES, calls: 0, costUsd: 0, islands: {} };
	for (const [k, n] of islands.entries()) {
		const rooms = shoreRooms(genIsland(n)).sort(), state = logState(n);
		for (let rep = 0; rep < repeats; rep++) {
			const set: Record<string, unknown> = {};
			for (let i = 0; i < rooms.length; i += JEV_BATCH) {
				const a = noul ? await askNoul(key, state, rooms.slice(i, i + JEV_BATCH), question) : await ask(key, state, rooms.slice(i, i + JEV_BATCH));
				Object.assign(set, a.answers); data.model = a.model; data.calls++; data.costUsd += a.cost;
			}
			((data.islands as Record<string, unknown[]>)[n] ??= []).push(set);
		}
		process.stdout.write(`\r${k + 1}/${islands.length} islands, ${data.calls} calls, ${data.costUsd.toFixed(4)} $`);
		writeFileSync(file, JSON.stringify(data));
	}
	data.costUsd = Math.round(data.costUsd * 1e5) / 1e5;
	writeFileSync(file, JSON.stringify(data));
	console.log(`\nJev ${data.model}: ${islands.length} islands × ${repeats} → ${file.pathname}`);
}
