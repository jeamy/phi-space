// How a contribution grew out of the ones before it: a line diff between an attempt and the attempt it built on, and
// how much of the earlier one it kept. Lines are compared without their indentation and trailing spaces.

/** What changed from `before` to `after`: the share of `before`'s lines that stayed, the lines added and removed, and
 *  the changed lines with a little context (`+`/`-`/` ` prefixes, at most `maxLines`; `…` marks skipped lines). */
export type LineDiff = { kept: number; added: number; removed: number; hunks: string; cut?: true };

const MAX_LINES = 800; // longer sources are compared in their first lines only (the sandbox caps code at 20 000 chars)

export function lineDiff(before: string, after: string, maxLines = 80): LineDiff {
	const a = before.split("\n").slice(0, MAX_LINES), b = after.split("\n").slice(0, MAX_LINES);
	const ka = a.map((l) => l.trim()), kb = b.map((l) => l.trim());
	// longest common subsequence of the lines (n·m table; both sides are at most MAX_LINES long)
	const n = a.length, m = b.length, w = m + 1;
	const lcs = new Uint16Array((n + 1) * w);
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = ka[i] === kb[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
	const ops: Array<[" " | "-" | "+", string]> = [];
	let i = 0, j = 0;
	while (i < n && j < m) {
		if (ka[i] === kb[j]) { ops.push([" ", b[j]!]); i++; j++; }
		else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) ops.push(["-", a[i++]!]);
		else ops.push(["+", b[j++]!]);
	}
	while (i < n) ops.push(["-", a[i++]!]);
	while (j < m) ops.push(["+", b[j++]!]);
	const same = ops.filter((o) => o[0] === " " && o[1].trim()).length, before0 = ka.filter(Boolean).length;
	// the changed lines with two lines of context; runs of unchanged lines in between become "…"
	const show = new Set<number>();
	ops.forEach((o, k) => { if (o[0] !== " ") for (let x = k - 2; x <= k + 2; x++) show.add(x); });
	const out: string[] = [];
	let gap = false, cut = false;
	for (let k = 0; k < ops.length; k++) {
		if (!show.has(k)) { gap = true; continue; }
		if (out.length >= maxLines) { cut = true; break; }
		if (gap && out.length) out.push("…");
		gap = false;
		out.push(`${ops[k]![0]} ${ops[k]![1]}`);
	}
	return { kept: before0 ? Math.min(1, same / before0) : 0, added: ops.filter((o) => o[0] === "+" && o[1].trim()).length, removed: ops.filter((o) => o[0] === "-" && o[1].trim()).length, hunks: out.join("\n"), ...(cut ? { cut: true as const } : {}) };
}

/** The share of `part`'s non-empty lines that appear in `whole` (how much of a merge partner went into the merge). */
export function shareOf(part: string, whole: string): number {
	const have = new Set(whole.split("\n").map((l) => l.trim()).filter(Boolean)), lines = part.split("\n").map((l) => l.trim()).filter(Boolean);
	return lines.length ? lines.filter((l) => have.has(l)).length / lines.length : 0;
}
