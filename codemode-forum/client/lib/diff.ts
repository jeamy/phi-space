// The difference between two versions of a section, for the page: by lines, and inside a line that was replaced by
// one other line by words, so a changed sentence in a long paragraph shows as that sentence and not as the paragraph.
// Pure and small on purpose: a section holds at most 24 kB, so the quadratic table of the longest common subsequence
// stays small; beyond LIMIT cells the two texts are shown as removed and added whole.

export type Part = { op: "same" | "del" | "add"; text: string };
/** A line of the difference. A changed line (`del` directly followed by its `add`) carries the words that differ. */
export type Line = { op: "same" | "del" | "add"; text: string; words?: Part[] };

const LIMIT = 4_000_000;

/** The longest common subsequence of two lists as steps from the first to the second. */
export function diffTokens(a: string[], b: string[]): Part[] {
	// what both begin and end with needs no table
	let start = 0, endA = a.length, endB = b.length;
	while (start < endA && start < endB && a[start] === b[start]) start++;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
	const x = a.slice(start, endA), y = b.slice(start, endB), n = x.length, m = y.length;
	const mid: Part[] = [];
	if (n * m > LIMIT) mid.push(...x.map((text): Part => ({ op: "del", text })), ...y.map((text): Part => ({ op: "add", text })));
	else if (n || m) {
		const w = m + 1, table = new Uint32Array((n + 1) * w);
		for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i * w + j] = x[i] === y[j] ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
		for (let i = 0, j = 0; i < n || j < m; ) {
			if (i < n && j < m && x[i] === y[j]) { mid.push({ op: "same", text: x[i]! }); i++; j++; }
			else if (j >= m || (i < n && table[(i + 1) * w + j]! >= table[i * w + j + 1]!)) mid.push({ op: "del", text: x[i++]! });
			else mid.push({ op: "add", text: y[j++]! });
		}
	}
	return [...a.slice(0, start).map((text): Part => ({ op: "same", text })), ...mid, ...a.slice(endA).map((text): Part => ({ op: "same", text }))];
}

/** Words and the blanks between them, so that joining the parts gives the line back. */
const words = (line: string) => line.match(/\s+|[^\s\w]|\w+/gu) ?? [];

/** Neighbours with the same step, joined. */
const joined = (parts: Part[]): Part[] => {
	const out: Part[] = [];
	for (const p of parts) { const last = out.at(-1); if (last && last.op === p.op) last.text += p.text; else out.push({ ...p }); }
	return out;
};

/** The difference between two texts, line by line. */
export function diffText(before: string, after: string): Line[] {
	const steps = diffTokens(before.split("\n"), after.split("\n")), out: Line[] = [];
	for (let i = 0; i < steps.length; ) {
		if (steps[i]!.op === "same") { out.push({ op: "same", text: steps[i++]!.text }); continue; }
		// a run of removed lines and the added lines after it: pair them in order, word by word
		const dels: string[] = [], adds: string[] = [];
		while (i < steps.length && steps[i]!.op === "del") dels.push(steps[i++]!.text);
		while (i < steps.length && steps[i]!.op === "add") adds.push(steps[i++]!.text);
		const pairs = Math.min(dels.length, adds.length);
		for (let k = 0; k < pairs; k++) {
			const parts = joined(diffTokens(words(dels[k]!), words(adds[k]!)));
			// two lines that share next to nothing are simply one removed and one added
			const shared = parts.filter((p) => p.op === "same").reduce((n, p) => n + p.text.trim().length, 0);
			const paired = shared * 3 >= Math.min(dels[k]!.trim().length, adds[k]!.trim().length);
			out.push({ op: "del", text: dels[k]!, ...(paired ? { words: parts.filter((p) => p.op !== "add") } : {}) }, { op: "add", text: adds[k]!, ...(paired ? { words: parts.filter((p) => p.op !== "del") } : {}) });
		}
		for (const text of dels.slice(pairs)) out.push({ op: "del", text });
		for (const text of adds.slice(pairs)) out.push({ op: "add", text });
	}
	return out;
}

/** How many lines were removed and added. */
export const diffCount = (lines: Line[]) => ({ del: lines.filter((l) => l.op === "del").length, add: lines.filter((l) => l.op === "add").length });

/** The difference with the unchanged stretches cut to `context` lines around each change; a cut is a `gap` with the
 *  number of lines left out. */
export function withContext(lines: Line[], context = 2): Array<Line | { op: "gap"; count: number }> {
	const keep = lines.map(() => false);
	lines.forEach((l, i) => { if (l.op !== "same") for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true; });
	const out: Array<Line | { op: "gap"; count: number }> = [];
	for (let i = 0; i < lines.length; ) {
		if (keep[i]) { out.push(lines[i++]!); continue; }
		let n = 0;
		while (i < lines.length && !keep[i]) { n++; i++; }
		out.push({ op: "gap", count: n });
	}
	return out;
}
