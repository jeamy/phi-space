// A document with parts (DocDef.parts) stored as rows: its head (everything but the parts) and one row per record of
// each part. Arrays keep their order through an `ord` per row; maps are keyed. Shared by the SQLite ledger and its tests.
import type { PartChanges } from "./draft.ts";

export type PartSpec = import("./types.ts").PartDef;
/** One stored record of a part: its part (dotted path), its id (array: the record's `id`, else its position's key;
 *  map: the key), its order (arrays), its value. */
export type PartRow = { part: string; id: string; ord: number; value: unknown };

export const partAt = (o: unknown, path: readonly string[]): unknown => path.reduce<unknown>((x, k) => (x !== null && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), o);

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
		// no rows: the head's own value stays (empty as the store writes heads, or inline in a document written before its
		// definition had parts)
		if (!list.length) continue;
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
export function partChanges(before: unknown, after: unknown, parts: readonly PartSpec[], mapChanges: PartChanges, ords: Map<string, Map<string, number>>, undo?: Array<() => void>): { put: PartRow[]; del: Array<{ part: string; id: string }> } {
	const put: PartRow[] = [], del: Array<{ part: string; id: string }> = [];
	for (const p of parts) {
		const name = p.path.join("."), now = partAt(after, p.path), was = partAt(before, p.path);
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
		if (!ords.has(name)) { ords.set(name, new Map()); undo?.push(() => ords.delete(name)); }
		const ord = ords.get(name)!, o = track(ord, undo);
		if (alongside(name, a, b, ord, o, put, del)) continue;
		const old = new Map(b.map((v) => [idOf(v), v]));
		const ids = a.map(idOf), kept = (id: string) => old.has(id) && ord.has(id);
		const present = new Set(ids);
		for (const id of old.keys()) if (!present.has(id)) { del.push({ part: name, id }); o.del(id); }
		// the order holds while kept records stay in their order and new ones only follow them
		let last = -Infinity, fresh = false, holds = true;
		for (const id of ids) {
			if (!kept(id)) { fresh = true; continue; }
			const o = ord.get(id)!;
			if (fresh || o <= last) { holds = false; break; }
			last = o;
		}
		if (!holds) { // renumber the whole part
			o.clear();
			a.forEach((v, i) => { o.set(ids[i]!, i); put.push({ part: name, id: ids[i]!, ord: i, value: v }); });
			o.max(a.length - 1);
			continue;
		}
		let max = maxOrd(ord);
		a.forEach((v, i) => {
			const id = ids[i]!;
			if (kept(id)) { if (old.get(id) !== v) put.push({ part: name, id, ord: ord.get(id)!, value: v }); return; }
			o.set(id, ++max);
			put.push({ part: name, id, ord: max, value: v });
		});
		o.max(max);
	}
	return { put, del };
}

/** The highest order of a part's records, kept beside its order map so an append does not scan them all. */
const maxOrds = new WeakMap<Map<string, number>, number>();
const maxOrd = (ord: Map<string, number>): number => {
	let max = maxOrds.get(ord);
	if (max === undefined) { max = -1; for (const o of ord.values()) if (o > max) max = o; maxOrds.set(ord, max); }
	return max;
};

/** Changes of an order map, each with its inverse in `undo` (when the store refuses the commit, Ledger.prepare). */
type OrdWrites = { set(k: string, v: number): void; del(k: string): void; clear(): void; max(m: number): void };
function track(ord: Map<string, number>, undo?: Array<() => void>): OrdWrites {
	if (!undo) return { set: (k, v) => void ord.set(k, v), del: (k) => void ord.delete(k), clear: () => ord.clear(), max: (m) => void maxOrds.set(ord, m) };
	const prevMax = maxOrds.get(ord);
	undo.push(() => (prevMax === undefined ? maxOrds.delete(ord) : maxOrds.set(ord, prevMax)));
	return {
		set: (k, v) => { const had = ord.has(k), was = ord.get(k); undo.push(() => (had ? ord.set(k, was!) : ord.delete(k))); ord.set(k, v); },
		del: (k) => { if (!ord.has(k)) return; const was = ord.get(k)!; undo.push(() => ord.set(k, was)); ord.delete(k); },
		clear: () => { const copy = new Map(ord); undo.push(() => { ord.clear(); for (const [k, v] of copy) ord.set(k, v); }); ord.clear(); },
		max: (m) => void maxOrds.set(ord, m),
	};
}

/** The usual change of an array part without ids for every record: walking both arrays side by side (records are
 *  values, so the same object is the same record), records were only removed, replaced in their place, or appended
 *  (a log that grows at its end and is cut at its start; a take from the middle of the entries). Anything else (false,
 *  nothing pushed) goes to the full comparison. */
function alongside(name: string, a: readonly unknown[], b: readonly unknown[], ord: Map<string, number>, o: OrdWrites, put: PartRow[], del: Array<{ part: string; id: string }>): boolean {
	const gone: string[] = [], changed: Array<{ id: string; v: unknown }> = [];
	let i = 0, j = 0;
	for (; i < b.length && j < a.length; i++) {
		if (a[j] === b[i]) { j++; continue; }
		const was = idOf(b[i]);
		if (!ord.has(was)) return false;
		if (idOf(a[j]) === was) { changed.push({ id: was, v: a[j] }); j++; } // replaced in its place
		else gone.push(was);
	}
	for (; i < b.length; i++) { const was = idOf(b[i]); if (!ord.has(was)) return false; gone.push(was); }
	// what follows the last kept record is new; a record of the part that only moved goes to the full comparison
	const added = a.slice(j).map((v) => ({ id: idOf(v), v }));
	if (added.length) {
		const ids = new Set(added.map((x) => x.id));
		if (ids.size !== added.length) return false;
		for (const x of added) if (ord.has(x.id)) return false; // a removed record came back elsewhere: it moved
	}
	let max = maxOrd(ord);
	for (const id of gone) { del.push({ part: name, id }); o.del(id); }
	for (const x of changed) put.push({ part: name, id: x.id, ord: ord.get(x.id)!, value: x.v });
	for (const x of added) { o.set(x.id, ++max); put.push({ part: name, id: x.id, ord: max, value: x.v }); }
	o.max(max);
	return true;
}
