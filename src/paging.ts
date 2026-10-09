// Exact UTF-8 page sizing, including metadata, separators and cursor/token changes.
import { ResponseBudgetTooSmall } from "./core.ts";
export const encodedBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");
export function bytePage<T, R>(source: readonly T[], offset: number, cap: number, make: (items: T[], next: number | null) => R): R {
	const items: T[] = [];
	let contents = 0;
	for (let i = offset; i < source.length; i++) {
		const next = i + 1 < source.length ? i + 1 : null;
		const size = encodedBytes(source[i]);
		const required = encodedBytes(make([], next)) + contents + size + items.length;
		if (required > cap) {
			if (!items.length) throw new ResponseBudgetTooSmall(required);
			return make(items, i);
		}
		items.push(source[i]); contents += size;
	}
	const result = make(items, null);
	if (encodedBytes(result) > cap) throw new ResponseBudgetTooSmall(encodedBytes(result));
	return result;
}
