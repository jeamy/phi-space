// A map part kept on the disk (PartDef.disk; docs/umstellung-ohne-pi-durable.md, U2c): to the code of a document it is
// a plain object of records by key, but a record is read from the store when it is asked for, and memory holds only
//
//   - what commits wrote that is not yet durable (the store's read connection does not see it yet), with the deletions,
//     until the commit that wrote it is durable;
//   - the records without an `at` value (a Space's open requests): few, and asked for on every new request.
//
// Questions that would scan the whole map go to `map[DISK_MAP]` (store/types.ts), answered from the store's indexes.
// Enumerating the map still works (it reads every key from the store), but in strict mode (tests) it throws, so code that
// would scan a day of claims on every operation fails loudly instead of slowly.
import { DISK_MAP, type DiskMapQuery } from "./types.ts";

/** What the store answers about one map part on its disk. Values are JSON text. */
export interface DiskMapSource {
	get(id: string): string | undefined;
	ids(): string[];
	/** Rows with `at <= t` and either no flag, or a flag and a group in `inGroups` or none of `known`; by id, at most `limit`. */
	due(t: number, limit: number, inGroups: readonly string[], known: readonly string[]): Array<[string, string]>;
	/** The smallest `at` above `t` among rows without flag. */
	nextAt(t: number): number | undefined;
	/** Ids of rows of group `g`, at most `limit`. */
	group(g: string, limit: number): string[];
	/** Rows without `at`. */
	unindexed(): Array<[string, string]>;
	/** The first ids in id order, at most `limit`. */
	firstIds(limit: number): string[];
	/** Rows after id `after` (null: from the start) in id order, at most `limit`. */
	after(after: string | null, limit: number): Array<[string, string]>;
}

const GONE = Symbol("gone");
type Held = { v: unknown; stamp: number };

function deepFreeze(v: unknown): void {
	if (typeof v !== "object" || v === null || Object.isFrozen(v)) return;
	Object.freeze(v);
	for (const x of Object.values(v)) deepFreeze(x);
}
const parse = (json: string): unknown => { const v = JSON.parse(json); deepFreeze(v); return v; };

export class DiskMap {
	readonly proxy: Record<string, unknown>;
	readonly #src: DiskMapSource;
	readonly #fields: { at: string; group: string; flag: string };
	readonly #stamp: () => number;
	/** Written and not yet durable (stamp: the number of the commit that wrote it), and the records without `at`. */
	readonly #held = new Map<string, Held>();

	constructor(src: DiskMapSource, fields: { at: string; group: string; flag: string }, stamp: () => number, strict: boolean) {
		this.#src = src;
		this.#fields = fields;
		this.#stamp = stamp;
		for (const [id, json] of src.unindexed()) this.#held.set(id, { v: parse(json), stamp: 0 });
		const query = this.#query();
		const read = (k: string | symbol) => (typeof k === "symbol" ? undefined : this.read(k));
		this.proxy = new Proxy({} as Record<string, unknown>, {
			get: (_t, k) => (k === DISK_MAP ? query : read(k)),
			has: (_t, k) => k === DISK_MAP || read(k) !== undefined,
			set: (_t, k, v) => { if (typeof k === "symbol") return false; this.write(k, v); return true; },
			deleteProperty: (_t, k) => { if (typeof k !== "symbol") this.write(k, GONE); return true; },
			defineProperty: (_t, k, d) => { if (typeof k === "symbol" || !("value" in d)) return false; this.write(k, d.value); return true; },
			getOwnPropertyDescriptor: (_t, k) => { const v = read(k); return v === undefined ? undefined : { value: v, writable: true, enumerable: true, configurable: true }; },
			ownKeys: () => {
				if (strict) throw new Error("a map part on the disk is not enumerated (it holds a day of claims): ask its DISK_MAP query");
				return this.keys();
			},
			getPrototypeOf: () => Object.prototype,
			setPrototypeOf: () => false,
			preventExtensions: () => false,
		});
	}

	/** Builds one from a map in memory (a document that was new in this process): every record is held until the commit
	 *  that writes it (`stamp`) is durable. */
	static adopt(src: DiskMapSource, fields: { at: string; group: string; flag: string }, stamp: () => number, strict: boolean, from: Record<string, unknown>, written: number): DiskMap {
		const m = new DiskMap(src, fields, stamp, strict);
		for (const [k, v] of Object.entries(from)) m.#held.set(k, { v, stamp: written });
		return m;
	}

	read(k: string): unknown {
		const h = this.#held.get(k);
		if (h) return h.v === GONE ? undefined : h.v;
		const json = this.#src.get(k);
		return json === undefined ? undefined : parse(json);
	}

	write(k: string, v: unknown): void { this.#held.set(k, { v, stamp: this.#stamp() }); }

	keys(): string[] {
		const out = new Set(this.#src.ids());
		for (const [k, h] of this.#held) h.v === GONE ? out.delete(k) : out.add(k);
		return [...out];
	}

	/** Commits up to `durable` are on the disk: what they wrote is read from there from now on. */
	settle(durable: number): void {
		for (const [k, h] of this.#held) if (h.stamp <= durable && (h.v === GONE || this.#at(h.v) !== undefined)) this.#held.delete(k);
	}

	/** How many records memory holds (open ones and what is not yet durable). */
	get held(): number { return this.#held.size; }

	#at(v: unknown): number | undefined { const a = (v as Record<string, unknown> | null)?.[this.#fields.at]; return typeof a === "number" ? a : undefined; }
	#field(v: unknown, f: string): unknown { return (v as Record<string, unknown>)[f]; }

	#query(): DiskMapQuery<unknown> {
		const f = this.#fields;
		return {
			entries: () => this.keys().map((k) => [k, this.read(k)] as [string, unknown]),
			page: (after, limit) => {
				const out = new Map<string, unknown>();
				// rows that memory holds are judged by what memory holds: ask the disk for enough to make up for them
				for (const [k, json] of this.#src.after(after, limit + this.#held.size)) if (!this.#held.has(k)) out.set(k, parse(json));
				for (const [k, h] of this.#held) if (h.v !== GONE && (after === null || k > after)) out.set(k, h.v);
				return [...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, limit);
			},
			any: () => {
				for (const h of this.#held.values()) if (h.v !== GONE) return true;
				// a row of the disk counts unless memory holds that record (deleted, or changed: then counted above)
				return this.#src.firstIds(this.#held.size + 1).some((k) => !this.#held.has(k));
			},
			unindexed: () => {
				const out: Array<[string, unknown]> = [];
				for (const [k, h] of this.#held) if (h.v !== GONE && this.#at(h.v) === undefined) out.push([k, h.v]);
				return out;
			},
			due: (t, limit, groups, pick) => {
				const out = new Set<string>();
				// rows that memory holds are judged by what memory holds: ask the disk for enough to make up for them
				for (const [k, json] of this.#src.due(t, limit + this.#held.size, groups.in, groups.known)) {
					if (this.#held.has(k)) continue;
					if (pick(parse(json))) out.add(k);
				}
				const inGroups = new Set(groups.in), known = new Set(groups.known);
				for (const [k, h] of this.#held) {
					if (h.v === GONE) continue;
					const at = this.#at(h.v);
					if (at === undefined || at > t) continue;
					const g = String(this.#field(h.v, f.group));
					if (this.#field(h.v, f.flag) && !inGroups.has(g) && known.has(g)) continue;
					if (pick(h.v)) out.add(k);
				}
				return [...out].sort().slice(0, limit);
			},
			nextAt: (t) => {
				// the disk's answer may be a row memory has since changed: an earlier answer only makes a sweep come early
				let min = this.#src.nextAt(t);
				for (const h of this.#held.values()) {
					if (h.v === GONE || this.#field(h.v, f.flag)) continue;
					const at = this.#at(h.v);
					if (at !== undefined && at > t && (min === undefined || at < min)) min = at;
				}
				return min;
			},
			hasGroup: (g) => {
				for (const h of this.#held.values()) if (h.v !== GONE && this.#field(h.v, f.group) === g) return true;
				// a row of the disk counts unless memory holds that record (changed or deleted): ask for enough rows
				return this.#src.group(g, this.#held.size + 1).some((k) => !this.#held.has(k));
			},
		};
	}
}

/** Whether a value is the proxy of a map part on the disk. */
export const isDiskMap = (v: unknown): boolean => typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[DISK_MAP] !== undefined;
