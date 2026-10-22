// A document with parts (DocDef.parts) stored as rows: its head (everything but the parts) and one row per record of
// each part. Arrays keep their order through an `ord` per row; maps are keyed. Shared by the SQLite ledger and its tests.
import type { PartChanges } from "./draft.ts";

export type PartSpec = { readonly path: readonly string[]; readonly kind: "array" | "map" };
/** One stored record of a part: its part (dotted path), its id (array: the record's `id`, else its position's key;
 *  map: the key), its order (arrays), its value. */
export type PartRow = { part: string; id: string; ord: number; value: unknown };

const at = (o: unknown, path: readonly string[]): unknown => path.reduce<unknown>((x, k) => (x !== null && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), o);

/** The head of a document: the value with each part replaced by an empty one (copied only along the parts' paths). */
export function headOf(value: unknown, parts: readonly PartSpec[]): unknown {
	if (value === null || typeof value !== "object") return value;
	const head: Record<string, unknown> = { ...(value as Record<string, unknown>) };
	for (const p of parts) {
		let o: Record<string, unknown> = head;
		for (let i = 0; i < p.path.length - 1; i++) {
			const k = p.path[i]!, next = o[k];
			if (next === null || typeof next !== "object") { o = {}; break; }
			o[k] = { ...(next as Record<string, unknown>) };
			o = o[k] as Record<string, unknown>;
		}
		const last = p.path.at(-1)!;
		if (last in o) o[last] = p.kind === "array" ? [] : {};
	}
	return head;
}

/** A document put together from its head and the rows of its parts (rows of an array in `ord` order). */
export function joinParts(head: unknown, parts: readonly PartSpec[], rows: Map<string, PartRow[]>): unknown {
	if (head === null || typeof head !== "object") return head;
	for (const p of parts) {
		let o = head as Record<string, unknown>;
		for (let i = 0; i < p.path.length - 1; i++) { const n = o[p.path[i]!]; if (n === null || typeof n !== "object") { o = null as never; break; } o = n as Record<string, unknown>; }
		if (!o) continue;
		const last = p.path.at(-1)!, list = rows.get(p.path.join(".")) ?? [];
		if (!(last in o) && !list.length) continue;
		o[last] = p.kind === "array" ? [...list].sort((a, b) => a.ord - b.ord).map((r) => r.value) : Object.fromEntries(list.map((r) => [r.id, r.value]));
	}
	return head;
}

/** The id of an array record (its `id` field, else its batch revision, else its JSON). */
const idOf = (v: unknown): string => {
	if (v !== null && typeof v === "object") { const o = v as Record<string, unknown>; if (typeof o.id === "string" || typeof o.id === "number") return String(o.id); if (typeof o.rev === "number") return `rev:${o.rev}`; }
	return `json:${JSON.stringify(v)}`;
};

/** What a commit changed in the parts of a document, as rows to write and rows to delete. Arrays are compared by their
 *  records' identity (a changed record is a new object); maps use the keys their draft reported. `ords` keeps each
 *  array record's order between commits (per part): a record appended gets the next one; if the order cannot be kept
 *  (a record moved, or one inserted in the middle), every record of the part is written with a fresh order. */
export function partChanges(before: unknown, after: unknown, parts: readonly PartSpec[], mapChanges: PartChanges, ords: Map<string, Map<string, number>>): { put: PartRow[]; del: Array<{ part: string; id: string }> } {
	const put: PartRow[] = [], del: Array<{ part: string; id: string }> = [];
	for (const p of parts) {
		const name = p.path.join("."), now = at(after, p.path), was = at(before, p.path);
		if (p.kind === "map") {
			const m = (now ?? {}) as Record<string, unknown>;
			// a map part that appeared or was replaced as a whole (not through its draft): every key is compared
			const keys = was === now ? (mapChanges.get(name) ?? new Set<string>()) : new Set([...Object.keys((was ?? {}) as object), ...Object.keys(m)]);
			const old = (was ?? {}) as Record<string, unknown>;
			for (const k of keys) {
				if (Object.prototype.hasOwnProperty.call(m, k)) { if (was !== now && old[k] === m[k]) continue; put.push({ part: name, id: k, ord: 0, value: m[k] }); }
				else del.push({ part: name, id: k });
			}
			continue;
		}
		if (was === now) continue;
		const a = (now ?? []) as unknown[], b = (was ?? []) as unknown[];
		if (!ords.has(name)) ords.set(name, new Map());
		const ord = ords.get(name)!;
		const old = new Map(b.map((v) => [idOf(v), v]));
		const ids = a.map(idOf), kept = (id: string) => old.has(id) && ord.has(id);
		const present = new Set(ids);
		for (const id of old.keys()) if (!present.has(id)) { del.push({ part: name, id }); ord.delete(id); }
		// the order holds while kept records stay in their order and new ones only follow them
		let last = -Infinity, fresh = false, holds = true;
		for (const id of ids) {
			if (!kept(id)) { fresh = true; continue; }
			const o = ord.get(id)!;
			if (fresh || o <= last) { holds = false; break; }
			last = o;
		}
		if (!holds) { // renumber the whole part
			ord.clear();
			a.forEach((v, i) => { ord.set(ids[i]!, i); put.push({ part: name, id: ids[i]!, ord: i, value: v }); });
			continue;
		}
		let max = -1;
		for (const o of ord.values()) if (o > max) max = o;
		a.forEach((v, i) => {
			const id = ids[i]!;
			if (kept(id)) { if (old.get(id) !== v) put.push({ part: name, id, ord: ord.get(id)!, value: v }); return; }
			ord.set(id, ++max);
			put.push({ part: name, id, ord: max, value: v });
		});
	}
	return { put, del };
}
