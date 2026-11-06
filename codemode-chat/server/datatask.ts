// Data tasks (docs/codemode-anwendungen.en.md, A step 2): a tools task over a dataset a person uploads. The upload is
// JSON (an array of objects) or CSV (a header row), one item per row with an `id` and an answer column that marks the
// items the question asks for (yes/no). The contribution is `async function solve()`, which returns the ids of those
// items; its only inputs are `tools.list`, `tools.get` and `tools.search` over the items, without the answer column.
//
// Every tenth item (at most 40, at most SAMPLE_BYTES as JSON) is the SAMPLE: it travels with the task (the CodeTask
// entry, the agents' prompt) together with its answer. The rest is the HOLDOUT: it is stored as CodeData entries of
// the block, page by page, and only the judge reads it (judge-host.ts, loadHoldout). The score is the F1 of the ids
// as sets; a contribution is correct with 100 % on both.
import { NO_WAIT, type SpaceLike } from "phi-spaces";
import { TOOL_COST, MAX_CALLS, type Meter, type ToolSpec, type World } from "./tooltask.ts";

export type Value = string | number | boolean | null;
export type DataItem = { id: string } & Record<string, Value>;
export type DataTool = "list" | "get" | "search";
/** What a data task is stored as (CodeTask `data`): everything but the holdout. */
export type DataSpec = {
	question: string;
	tools: DataTool[];
	/** The sample with the answer column taken out, and its answer (the ids, in the dataset's order). */
	sample: DataItem[];
	sampleAnswer: string[];
	/** How many items the holdout has (the page says so; its items stay in CodeData). */
	holdoutSize: number;
	fields: string[];
	timeoutS?: number;
};

export const MAX_ITEMS = 2000;
/** Below the 1 MB a reverse proxy takes by default (nginx's client_max_body_size), with room for the request around it. */
export const MAX_DATA_BYTES = 800_000;
export const MAX_FIELDS = 20;
export const MAX_VALUE_CHARS = 2000;
const SAMPLE_ITEMS = 40, SAMPLE_BYTES = 20_000;
/** One CodeData page: well below the space's 64 KiB per entry. */
const PAGE_BYTES = 40_000;
const YES = new Set(["1", "true", "yes", "y", "ja", "j", "x", "wahr"]), NO = new Set(["0", "false", "no", "n", "nein", "", "falsch"]);

// ---- reading an upload -------------------------------------------------------------------------------------------
/** CSV with a header row: commas or semicolons, quotes with "" inside, line breaks inside quotes. */
export function parseCsv(text: string): Array<Record<string, string>> {
	const t = text.replace(/^﻿/, ""), first = t.split(/\r?\n/, 1)[0] ?? "";
	const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : ",";
	const rows: string[][] = [];
	let row: string[] = [], cell = "", quoted = false;
	for (let i = 0; i < t.length; i++) {
		const c = t[i]!;
		if (quoted) {
			if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
			else cell += c;
		} else if (c === '"' && cell === "") quoted = true;
		else if (c === sep) { row.push(cell); cell = ""; }
		else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
		else cell += c;
	}
	if (quoted) throw new Error("CSV: a quote is not closed");
	if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
	const body = rows.filter((r) => r.some((x) => x.trim() !== ""));
	const head = (body.shift() ?? []).map((h) => h.trim());
	if (!head.length || head.some((h) => !h)) throw new Error("CSV: the first row must name every column");
	if (new Set(head).size !== head.length) throw new Error("CSV: a column name appears twice");
	return body.map((r, n) => {
		if (r.length !== head.length) throw new Error(`CSV: row ${n + 2} has ${r.length} cells, the header ${head.length}`);
		return Object.fromEntries(head.map((h, i) => [h, r[i]!]));
	});
}

/** A value of an upload as an item keeps it: strings (trimmed), finite numbers, booleans, null. */
const value = (v: unknown, where: string): Value => {
	if (v === null || typeof v === "boolean") return v;
	if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error(`${where}: not a finite number`); return v; }
	if (typeof v === "string") { if (v.length > MAX_VALUE_CHARS) throw new Error(`${where}: more than ${MAX_VALUE_CHARS} characters`); return v; }
	throw new Error(`${where}: only text, numbers, true/false and null (no lists or objects)`);
};
const yes = (v: unknown, where: string): boolean => {
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return v !== 0;
	const s = String(v ?? "").trim().toLowerCase();
	if (YES.has(s)) return true;
	if (NO.has(s)) return false;
	throw new Error(`${where}: the answer column takes yes/no, 1/0 or true/false, not "${String(v).slice(0, 40)}"`);
};

/** An upload as a data task's spec and holdout: rows from JSON or CSV, the name of the answer column, the question. */
export function readUpload(x: { question: unknown; rows?: unknown; csv?: unknown; answer: unknown; tools?: unknown; timeoutS?: unknown }): { spec: DataSpec; holdout: DataItem[]; holdoutAnswer: string[] } {
	const question = typeof x.question === "string" ? x.question.trim() : "";
	if (!question || question.length > 1000) throw new Error("A data task needs a question of 1 to 1000 characters");
	const answer = typeof x.answer === "string" ? x.answer.trim() : "";
	if (!answer) throw new Error("Name the answer column (the one that says which items the question asks for)");
	const rows: unknown = typeof x.csv === "string" ? parseCsv(x.csv) : x.rows;
	if (!Array.isArray(rows) || rows.length < 10) throw new Error("A dataset needs at least 10 items");
	if (rows.length > MAX_ITEMS) throw new Error(`A dataset has at most ${MAX_ITEMS} items`);
	if (Buffer.byteLength(JSON.stringify(rows)) > MAX_DATA_BYTES) throw new Error(`A dataset takes at most ${MAX_DATA_BYTES / 1000} KB as JSON`);
	const tools = (Array.isArray(x.tools) ? x.tools : ["list", "get", "search"]).filter((t): t is DataTool => t === "list" || t === "get" || t === "search");
	if (!tools.includes("get") || (!tools.includes("list") && !tools.includes("search"))) throw new Error("A data task needs get, and list or search");
	const fields = new Set<string>(), seen = new Set<string>();
	const items: DataItem[] = [], marked: boolean[] = [];
	rows.forEach((r, n) => {
		if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error(`item ${n + 1}: not an object`);
		const o = r as Record<string, unknown>;
		if (!Object.hasOwn(o, answer)) throw new Error(`item ${n + 1}: no answer column "${answer}"`);
		const id = o.id === undefined || o.id === null || o.id === "" ? `R-${n + 1}` : String(o.id).trim();
		if (!id || id.length > 80) throw new Error(`item ${n + 1}: the id is empty or longer than 80 characters`);
		if (seen.has(id)) throw new Error(`item ${n + 1}: the id ${id} appears twice`);
		seen.add(id);
		const item: DataItem = { id };
		for (const [k, v] of Object.entries(o)) {
			if (k === "id" || k === answer) continue;
			if (!/^[\p{L}_][\p{L}\p{N}_ -]{0,39}$/u.test(k)) throw new Error(`item ${n + 1}: the column name "${k.slice(0, 40)}" is not allowed (letters, digits, _ - and spaces, at most 40)`);
			fields.add(k);
			item[k] = value(v, `item ${n + 1}, ${k}`);
		}
		items.push(item);
		marked.push(yes(o[answer], `item ${n + 1}, ${answer}`));
	});
	if (fields.size > MAX_FIELDS) throw new Error(`A dataset has at most ${MAX_FIELDS} columns besides id and the answer`);
	if (!marked.some(Boolean)) throw new Error("No item is marked in the answer column: the answer would always be empty");
	if (marked.every(Boolean)) throw new Error("Every item is marked in the answer column: the answer would be every id");
	// every tenth item is the sample, as long as it fits; the rest is the holdout
	const sample: DataItem[] = [], sampleAnswer: string[] = [], holdout: DataItem[] = [], holdoutAnswer: string[] = [];
	let bytes = 2;
	items.forEach((it, i) => {
		const size = Buffer.byteLength(JSON.stringify(it)) + 1;
		if (i % 10 === 0 && sample.length < SAMPLE_ITEMS && bytes + size <= SAMPLE_BYTES) { sample.push(it); bytes += size; if (marked[i]) sampleAnswer.push(it.id); }
		else { holdout.push(it); if (marked[i]) holdoutAnswer.push(it.id); }
	});
	if (sample.length < 1 || holdout.length < 5) throw new Error("The dataset is too small to split into a sample and a hidden part");
	if (!holdoutAnswer.length) throw new Error("No marked item is left for the hidden part; mark more items");
	const timeoutS = x.timeoutS === undefined || x.timeoutS === null || x.timeoutS === "" ? undefined : Number(x.timeoutS);
	if (timeoutS !== undefined && !(Number.isFinite(timeoutS) && timeoutS >= 1 && timeoutS <= 120)) throw new Error("The time limit is 1 to 120 seconds");
	return { spec: { question, tools: tools.filter((t, i) => tools.indexOf(t) === i), sample, sampleAnswer, holdoutSize: holdout.length, fields: [...fields], ...(timeoutS !== undefined ? { timeoutS } : {}) }, holdout, holdoutAnswer };
}

/** Checks a stored spec (a CodeTask's `data`, a candidate's): the shape only, the upload was checked when it came. */
export function checkSpec(x: unknown): DataSpec {
	const s = x as DataSpec;
	if (!s || typeof s.question !== "string" || !Array.isArray(s.tools) || !Array.isArray(s.sample) || !Array.isArray(s.sampleAnswer) || typeof s.holdoutSize !== "number" || !Array.isArray(s.fields)) throw new Error("not a data task");
	return s;
}

// ---- the holdout as CodeData pages -------------------------------------------------------------------------------
type Page = { items: DataItem[]; answer: string[] };
export function pages(holdout: DataItem[], answer: string[]): Page[] {
	const marked = new Set(answer), out: Page[] = [];
	let cur: Page = { items: [], answer: [] }, bytes = 0;
	for (const it of holdout) {
		const size = Buffer.byteLength(JSON.stringify(it)) + it.id.length + 8;
		if (cur.items.length && bytes + size > PAGE_BYTES) { out.push(cur); cur = { items: [], answer: [] }; bytes = 0; }
		cur.items.push(it); if (marked.has(it.id)) cur.answer.push(it.id); bytes += size;
	}
	if (cur.items.length) out.push(cur);
	return out;
}

/** Writes the holdout of a block, page by page (each entry stays well below the space's limit per entry). */
export async function storeHoldout(space: SpaceLike, key: { session: string; blockId: string }, holdout: DataItem[], answer: string[], ttl: number): Promise<number> {
	const ps = pages(holdout, answer);
	// `hidden`: the dashboard shows no fields of such an entry (src/dashboard.ts); pages written before a failure go again
	try { for (let n = 0; n < ps.length; n++) await space.write({ type: "CodeData", fields: { ...key, page: n, of: ps.length, ...ps[n]!, hidden: true } as never }, null, ttl); }
	catch (e) { for (const x of await space.readAll({ type: "CodeData", fields: key }, { limit: 1000 }).catch(() => [])) await space.take({ type: "CodeData", id: x.id } as never, NO_WAIT).catch(() => null); throw e; }
	return ps.length;
}

/** The holdout of a block, or null when a page is missing (the block was deleted, or its upload is not complete). */
export async function loadHoldout(space: SpaceLike, key: { session: string; blockId: string }): Promise<{ items: DataItem[]; answer: string[] } | null> {
	const es = await space.readAll({ type: "CodeData", fields: key }, { limit: 1000 });
	const ps = es.map((e) => e.fields as unknown as Page & { page: number; of: number }).sort((a, b) => a.page - b.page);
	if (!ps.length || ps.length !== ps[0]!.of || ps.some((p, i) => p.page !== i)) return null;
	return { items: ps.flatMap((p) => p.items), answer: ps.flatMap((p) => p.answer) };
}

// ---- the tools and the score ------------------------------------------------------------------------------------
/** F1 of two id lists as sets; 0 when `got` is not a list of distinct strings. Order does not matter. */
export function setScore(got: unknown, want: unknown): number {
	if (!Array.isArray(got) || !got.every((x) => typeof x === "string") || new Set(got).size !== got.length || !Array.isArray(want)) return 0;
	const w = new Set(want as string[]), hit = got.filter((x) => w.has(x)).length;
	if (!got.length && !w.size) return 1;
	return hit === 0 ? 0 : (2 * hit) / (got.length + w.size);
}

/** A short line for `list`: the "title" column, else the first text column, cut to 80 characters. */
const headline = (it: DataItem, fields: string[]): string => {
	const f = fields.includes("title") ? "title" : fields.find((k) => typeof it[k] === "string");
	return f ? String(it[f] ?? "").slice(0, 80) : "";
};

const DESCRIPTIONS = (fields: string[]): Record<DataTool, { de: string; en: string }> => ({
	list: {
		de: "listet die Einträge seitenweise: { after?: string (eine id), limit?: number (1..50, Standard 20) } → { items: Array<{ id, line }> (line: eine kurze Zeile des Eintrags), next: string | null }. 1 Punkt je Aufruf.",
		en: "lists the items, a page at a time: { after?: string (an id), limit?: number (1..50, default 20) } → { items: Array<{ id, line }> (line: a short line of the item), next: string | null }. 1 point per call.",
	},
	get: {
		de: `ein Eintrag mit allen Feldern: { id: string } → { id, ${fields.join(", ")} } oder null. 1 Punkt.`,
		en: `one item with all its fields: { id: string } → { id, ${fields.join(", ")} }, or null. 1 point.`,
	},
	search: {
		de: "die ids der Einträge, in deren Textfeldern der Text vorkommt (Groß-/Kleinschreibung egal): { q: string, limit?: number (1..200, Standard 50) } → string[]. 2 Punkte.",
		en: "the ids of the items whose text fields contain the text (case-insensitive): { q: string, limit?: number (1..200, default 50) } → string[]. 2 points.",
	},
});
export const describeDataTools = (s: DataSpec, lang: "de" | "en"): string => s.tools.map((n) => `- tools.${n}(args): ${DESCRIPTIONS(s.fields)[n][lang]}`).join("\n");

/** The tools of one world of a data task, every call counted on `m`. */
export function dataTools(s: DataSpec, items: DataItem[], m: Meter) {
	const byId = new Map(items.map((i) => [i.id, i]));
	const text = new Map(items.map((i) => [i.id, Object.values(i).filter((v) => typeof v === "string").join("\n").toLowerCase()]));
	const arg = (a: unknown) => (a && typeof a === "object" ? (a as Record<string, unknown>) : {});
	const impl: Record<DataTool, (a: Record<string, unknown>) => unknown> = {
		list: (a) => {
			const limit = Math.max(1, Math.min(50, Math.floor(Number(a.limit ?? 20)) || 20));
			const from = typeof a.after === "string" ? items.findIndex((i) => i.id === a.after) + 1 : 0;
			const page = items.slice(from, from + limit);
			return { items: page.map((i) => ({ id: i.id, line: headline(i, s.fields) })), next: from + limit < items.length ? page.at(-1)!.id : null };
		},
		get: (a) => { const i = byId.get(String(a.id)); return i ? { ...i } : null; },
		search: (a) => {
			const q = String(a.q ?? "").toLowerCase(), limit = Math.max(1, Math.min(200, Math.floor(Number(a.limit ?? 50)) || 50));
			return q ? items.filter((i) => text.get(i.id)!.includes(q)).slice(0, limit).map((i) => i.id) : [];
		},
	};
	return s.tools.map((name) => ({
		name, description: DESCRIPTIONS(s.fields)[name].en,
		execute: (a: unknown) => {
			if (m.total >= MAX_CALLS) throw new Error(`more than ${MAX_CALLS} tool calls`);
			m.total++; m.calls[name] = (m.calls[name] ?? 0) + 1; m.cost += TOOL_COST[name];
			return impl[name](arg(a));
		},
	}));
}

/** The ToolSpec of a data task: the sample from the spec, the holdout given (the judge loads it) or empty (then only
 *  the sample is judged: an agent checking its code has no holdout). */
export function dataToolSpec(s: DataSpec, holdout?: { items: DataItem[]; answer: string[] }): ToolSpec {
	const answers = new Map<World["name"], string[]>([["sample", s.sampleAnswer], ["holdout", holdout?.answer ?? []]]);
	return {
		tools: s.tools,
		sample: { name: "sample", issues: [], items: s.sample },
		holdout: { name: "holdout", issues: [], items: holdout?.items ?? [] },
		...(holdout ? {} : { holdoutMissing: true }),
		answer: (w) => answers.get(w.name) ?? [],
		score: setScore,
		toolsFor: (w, m) => dataTools(s, (w.items ?? []) as DataItem[], m),
	};
}
