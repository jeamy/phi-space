// Test cases from what a person types: JSON, or plain text that is turned into JSON.
//
//   [{"args":[2],"expect":4}]          JSON as it is
//   Ergebnis: 0 1 4 9 11               one case without input; the result is the array [0,1,4,9,11]
//   5 -> 120                           input 5, result 120   (also =>, → and ⇒)
//   Eingabe: 3 4                       two lines (input line, result line) make one case
//   Ergebnis: 12
//   [3,1,2] -> [1,2,3]                 a JSON array as input is ONE argument; "5 3" are two arguments
//
//   5 11 -> [0,1,4,9,11] oder [0,2,7,10,11]   several right results (also "or" and "|"): any of them counts
//   Eingabe: 5 11                      an input line alone: a call without a fixed result (for a task with a check rule)
//
// Labels such as Ergebnis/Result/Erwartet/Expected/Ausgabe/Output/Eingabe/Input are ignored.
//
// JSON with the commas left out between values ("[0 1 6 10]", {"args": [] "expect": 4}) is read with them. What starts
// like JSON ("[" or "{") but cannot be read even so is an error, never a text result: a test case typed as JSON must not
// silently become the expected string.

export type Case = { args: unknown[]; expect?: unknown; expectAny?: unknown[] };

const RESULT = "ergebnis|ausgabe|erwartet|result|output|expected";
const INPUT = "eingabe|input|args?";
const label = (kind: string) => new RegExp(`^\\s*(?:${kind})\\s*[:=]\\s*`, "i");
const ARROW = /\s*(?:->|=>|→|⇒)\s*/;

/** The commas a person left out between JSON values, put back (outside strings): "[0 1 6]" → "[0,1,6]". */
export function addCommas(s: string): string {
	let out = "", inString = false, escaped = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i]!;
		if (inString) { out += c; if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') inString = false; continue; }
		if (/\s/.test(c)) {
			let j = i; while (j < s.length && /\s/.test(s[j]!)) j++;
			const prev = out.trimEnd().at(-1) ?? "", next = s[j] ?? "";
			out += /[\d"\]}a-z]/.test(prev) && /[-\d"[{tfn]/.test(next) ? "," : " ";
			i = j - 1;
			continue;
		}
		if (c === '"') inString = true;
		out += c;
	}
	return out;
}

const parse = (s: string): { ok: true; value: unknown } | { ok: false } => { try { return { ok: true, value: JSON.parse(s) }; } catch { return { ok: false }; } };
/** JSON as typed, or with the left-out commas put back when it starts like JSON. */
const json = (s: string): { ok: true; value: unknown } | { ok: false } => {
	const j = parse(s);
	return j.ok || !/^\s*[[{]/.test(s) ? j : parse(addCommas(s));
};
/** JSON that cannot be read is an error, not a text value. */
const startsLikeJson = (s: string) => /^\s*[[{]/.test(s);
const unreadable = (s: string): never => { throw new Error(`not readable as JSON: ${s.trim().slice(0, 60)}`); };
/** {args, expect} or, for a task with a check rule, {args} alone. */
const isCase = (v: unknown): v is Case => !!v && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as Case).args);
const isNumber = (tok: string) => tok !== "" && Number.isFinite(Number(tok));
const token = (tok: string): unknown => { const j = json(tok); return j.ok ? j.value : tok; };
const words = (s: string) => s.split(/[\s,;]+/).filter(Boolean);

/** A result: JSON, a list of numbers ("0 1 4 9 11"), a single value, or the text itself. */
function parseValue(raw: string): unknown {
	const s = raw.trim();
	const j = json(s);
	if (j.ok) return j.value;
	if (startsLikeJson(s)) unreadable(s);
	const ws = words(s);
	if (ws.length === 1) return token(ws[0]!);
	if (ws.length > 1 && ws.every(isNumber)) return ws.map(Number);
	return s;
}

const ALTERNATIVES = /\s+(?:oder|or|\|)\s+/i;

/** The result side of a case: one value, or several right ones separated by "oder" / "or" / "|" (a JSON value that
 *  merely contains such a word stays one value). */
function result(raw: string): { expect: unknown } | { expectAny: unknown[] } {
	const s = raw.trim();
	if (json(s).ok || !ALTERNATIVES.test(s)) return { expect: parseValue(s) };
	const parts = s.split(ALTERNATIVES).filter((p) => p.trim());
	return parts.length > 1 ? { expectAny: parts.map(parseValue) } : { expect: parseValue(s) };
}

/** Arguments: a JSON array is one argument, otherwise the words are the arguments. */
function parseArgs(raw: string): unknown[] {
	const s = raw.trim();
	if (!s) return [];
	const j = json(s);
	if (j.ok) return [j.value];
	if (startsLikeJson(s)) unreadable(s);
	return words(s).map(token);
}

/** The cases, or null when nothing could be read (also when something that starts like JSON cannot be read). */
export function parseCases(text: string): Case[] | null {
	try { return readCases(text); } catch { return null; }
}

function readCases(text: string): Case[] | null {
	const t = text.trim();
	if (!t) return null;
	const j = json(t);
	if (j.ok) {
		const v = j.value;
		if (Array.isArray(v) && v.length && v.every(isCase)) return v;
		if (isCase(v)) return [v];
		return [{ args: [], expect: v }]; // any other JSON value is the result of a call without input
	}
	const lines = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
	const out: Case[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const next = lines[i + 1];
		if (label(INPUT).test(line) && next && label(RESULT).test(next)) { // "Eingabe: …" followed by "Ergebnis: …"
			out.push({ args: parseArgs(line.replace(label(INPUT), "")), ...result(next.replace(label(RESULT), "")) });
			i++;
			continue;
		}
		if (label(INPUT).test(line) && !ARROW.test(line)) { out.push({ args: parseArgs(line.replace(label(INPUT), "")) }); continue; } // input only
		const [left, right] = line.split(ARROW, 2) as [string, string | undefined];
		if (right !== undefined) out.push({ args: parseArgs(left.replace(label(INPUT), "")), ...result(right.replace(label(RESULT), "")) });
		else out.push({ args: [], ...result(line.replace(label(RESULT), "")) });
	}
	return out.length ? out : null;
}
