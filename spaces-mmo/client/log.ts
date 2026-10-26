// The game log: the last 300 lines, and the same error twice in a row (a held arrow key against a wall) shows once.
export const LOG_LINES = 300;

export function appendLine<T extends { kind: string; text: string }>(old: T[], l: T): T[] {
	const last = old[old.length - 1];
	if (l.kind === "error" && last?.kind === "error" && last.text === l.text) return old;
	return old.length >= LOG_LINES ? [...old.slice(-(LOG_LINES - 1)), l] : [...old, l];
}
