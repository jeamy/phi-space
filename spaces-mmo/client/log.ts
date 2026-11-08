// The game log: the last 300 lines, and the same error twice in a row (a held arrow key against a wall) shows once.
export const LOG_LINES = 300;

export function appendLine<T extends { kind: string; text: string }>(old: T[], l: T): T[] {
	const last = old[old.length - 1];
	if (l.kind === "error" && last?.kind === "error" && last.text === l.text) return old;
	return old.length >= LOG_LINES ? [...old.slice(-(LOG_LINES - 1)), l] : [...old, l];
}

/** Someone coming or going ("Kai geht nach ost.", "Kai kommt an.", "… kommt mit dem Kahn an."): with many players these
 *  fill the log, so the page shows them only when asked to. */
export function isComing(l: { kind: string; text: string }): boolean {
	return l.kind === "info" && /^\S.*\s(?:(?:geht|gehst) nach \S.*|(?:kommt|kommst)(?: mit dem Kahn)? an)\.$/.test(l.text);
}

/** A line for the own figure: the echo of its own command, the answer to it, an error, a whisper or offer to it, a line
 *  naming it. The events show these under "An dich", the rest (what happens around it) under "Allgemein". */
export function isForMe(l: { kind: string; mine?: true; toMe?: true }): boolean {
	return l.kind === "echo" || l.kind === "hint" || l.kind === "error" || !!l.mine || !!l.toMe;
}

/** How many lines of a part are new since `seen`, the last line looked at (undefined: never looked, nothing new yet;
 *  null or a line no longer kept: all). `toMe`: only what others said or offered to the figure, the count of "An dich"
 *  (the answers to its own commands stand beside the command line already). */
export function newSince<T extends object>(list: readonly T[], seen: T | null | undefined, o: { toMe?: boolean } = {}): number {
	const at = seen ? list.lastIndexOf(seen) : -1;
	const since = at >= 0 ? list.slice(at + 1) : seen === undefined ? [] : list;
	return o.toMe ? since.filter((l) => "toMe" in l && l.toMe === true).length : since.length;
}
