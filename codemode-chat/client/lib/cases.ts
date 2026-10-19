// Test cases from what a person types: JSON, or plain text that is turned into JSON.
//
//   [{"args":[2],"expect":4}]          JSON as it is
//   Ergebnis: 0 1 4 9 11               one case without input; the result is the array [0,1,4,9,11]
//   5 -> 120                           input 5, result 120   (also =>, → and ⇒)
//   Eingabe: 3 4                       two lines (input line, result line) make one case
//   Ergebnis: 12
//   [3,1,2] -> [1,2,3]                 a JSON array as input is ONE argument; "5 3" are two arguments
//
// Labels such as Ergebnis/Result/Erwartet/Expected/Ausgabe/Output/Eingabe/Input are ignored.

export type Case = { args: unknown[]; expect: unknown };

const RESULT = "ergebnis|ausgabe|erwartet|result|output|expected";
const INPUT = "eingabe|input|args?";
const label = (kind: string) => new RegExp(`^\\s*(?:${kind})\\s*[:=]\\s*`, "i");
const ARROW = /\s*(?:->|=>|→|⇒)\s*/;

const json = (s: string): { ok: true; value: unknown } | { ok: false } => { try { return { ok: true, value: JSON.parse(s) }; } catch { return { ok: false }; } };
const isCase = (v: unknown): v is Case => !!v && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as Case).args) && "expect" in (v as object);
const isNumber = (tok: string) => tok !== "" && Number.isFinite(Number(tok));
const token = (tok: string): unknown => { const j = json(tok); return j.ok ? j.value : tok; };
const words = (s: string) => s.split(/[\s,;]+/).filter(Boolean);

/** A result: JSON, a list of numbers ("0 1 4 9 11"), a single value, or the text itself. */
function parseValue(raw: string): unknown {
	const s = raw.trim();
	const j = json(s);
	if (j.ok) return j.value;
	const ws = words(s);
	if (ws.length === 1) return token(ws[0]!);
	if (ws.length > 1 && ws.every(isNumber)) return ws.map(Number);
	return s;
}

/** Arguments: a JSON array is one argument, otherwise the words are the arguments. */
function parseArgs(raw: string): unknown[] {
	const s = raw.trim();
	if (!s) return [];
	const j = json(s);
	if (j.ok) return [j.value];
	return words(s).map(token);
}

/** The cases, or null when nothing could be read. */
export function parseCases(text: string): Case[] | null {
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
			out.push({ args: parseArgs(line.replace(label(INPUT), "")), expect: parseValue(next.replace(label(RESULT), "")) });
			i++;
			continue;
		}
		const [left, right] = line.split(ARROW, 2) as [string, string | undefined];
		if (right !== undefined) out.push({ args: parseArgs(left.replace(label(INPUT), "")), expect: parseValue(right.replace(label(RESULT), "")) });
		else out.push({ args: [], expect: parseValue(line.replace(label(RESULT), "")) });
	}
	return out.length ? out : null;
}
