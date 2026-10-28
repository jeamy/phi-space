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
