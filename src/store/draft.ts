// Copy-on-write drafts of JSON documents (docs/umstellung-ohne-pi-durable.md, U2). A commit callback works on a draft:
// reads go through to the committed value, the first write to an object copies it (and its ancestors) shallowly, so the
// committed value and every snapshot of it stay as they were. `finish()` returns the new value, in which every object
// the commit did not change is the very same object as before: the store finds what changed by identity. After
// `finish()` (or `discard()`) the draft is revoked; a late write throws instead of reaching a later commit.
//
// Parts (DocDef.parts) are the big collections of a document whose records are immutable values: their records are
// handed out as they are, never wrapped, so a scan over ten thousand entries costs what it costs without a draft. A
// record changes by being replaced. An array part is copied on its first write; a map part is changed in place with an
// undo log (copying a map of 150 000 claims per commit is what made drafts slow), and reports the keys it changed.

import { diskMapOf } from "./types.ts";

type Obj = Record<string | symbol, unknown> | unknown[];

/** A big collection of a document: an array of records, or a map of records by key. */
export type DraftPart = { readonly path: readonly string[]; readonly kind: "array" | "map" };
/** What a commit changed in a map part: the keys written or deleted (the store writes those rows). */
export type PartChanges = Map<string, Set<string>>;

/** The bookkeeping of one drafted object. */
type State = {
	kind: "object" | "array" | "map";
	path: string;
	base: Obj;
	copy: Obj | null;
	parent: State | null;
	children: Map<string | symbol, unknown>; // child proxies handed out, by key
	assigned: Set<unknown>; // part arrays: the records written in this commit (only they can hold drafts)
	undo: Map<string, { had: boolean; old: unknown }>; // map parts: what to restore when the commit fails
	proxy: Obj;
	revoke: () => void;
};

const STATE = Symbol("phi-spaces.draft");
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null;
const latest = (s: State): Obj => s.copy ?? s.base;
const shallow = (o: Obj): Obj => (Array.isArray(o) ? o.slice() : Object.assign(Object.create(Object.getPrototypeOf(o)), o));
const own = (o: object, k: string | symbol) => Object.prototype.hasOwnProperty.call(o, k);

export type Draft<T> = {
	readonly value: T;
	/** The new value. `changes`: the keys written in each map part (by its dotted path), which no identity shows. */
	finish(): T;
	readonly changes: PartChanges;
	/** After finish: the records written into parts by this commit (the store freezes them when it publishes). */
	readonly fresh: unknown[];
	discard(): void;
};

/** A draft of `base` (a JSON value: plain objects, arrays, primitives) with the given parts. */
export function draftOf<T>(base: T, parts: readonly DraftPart[] = []): Draft<T> {
	if (!isObject(base)) throw new TypeError("a draft needs an object");
	const partKind = new Map(parts.map((p) => [p.path.join("."), p.kind]));
	const states: State[] = [];
	const changes: PartChanges = new Map();
	const fresh: unknown[] = [];
	let done = false;
	const live = () => { if (done) throw new TypeError("this commit's draft is finished"); };

	const stateOf = (v: unknown): State | undefined => (isObject(v) ? ((v as Record<symbol, unknown>)[STATE] as State | undefined) : undefined);
	const modify = (s: State) => {
		if (s.copy) return;
		s.copy = shallow(s.base);
		// the copy keeps the proxies already handed out for its children: a later write through them lands in this copy
		for (const [k, child] of s.children) (s.copy as Record<string | symbol, unknown>)[k] = child;
		if (s.parent) modify(s.parent);
	};

	const create = (value: Obj, parent: State | null, key: string | symbol | null): Obj => {
		const path = parent === null ? "" : parent.path === "" ? String(key) : `${parent.path}.${String(key)}`;
		const kind = partKind.get(path) === "map" && !Array.isArray(value) ? "map" : partKind.get(path) === "array" && Array.isArray(value) ? "array" : "object";
		const s = { kind, path, base: value, copy: null, parent, children: new Map(), assigned: new Set(), undo: new Map() } as unknown as State;
		const handler: ProxyHandler<object> = kind === "map" ? mapHandler(s) : objectHandler(s);
		const { proxy, revoke } = Proxy.revocable(value as object, handler);
		s.proxy = proxy as Obj;
		s.revoke = revoke;
		states.push(s);
		return proxy as Obj;
	};

	// a part array's methods run on the array itself, not element by element through this proxy: its records are values
	const readMethods = new Set<string | symbol>(["find", "findIndex", "findLast", "findLastIndex", "filter", "some", "every", "map", "forEach", "indexOf", "lastIndexOf", "includes", "slice", "reduce", "reduceRight", "at", "entries", "values", "keys", "join", "flatMap", "flat", "concat", "toSorted", "toReversed", Symbol.iterator]);
	const writeMethods = new Set<string | symbol>(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);
	const partMethod = (s: State, k: string | symbol): unknown => {
		const native = (Array.prototype as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[k as string]!;
		if (readMethods.has(k)) return (...args: unknown[]) => native.apply(latest(s), args);
		return (...args: unknown[]) => {
			live();
			modify(s);
			const added = k === "push" || k === "unshift" ? args : k === "splice" ? args.slice(2) : k === "fill" ? args.slice(0, 1) : [];
			for (const v of added) if (isObject(v)) s.assigned.add(v);
			return native.apply(s.copy, args);
		};
	};

	// an object or an array (a part array hands out its records unwrapped)
	const objectHandler = (s: State): ProxyHandler<object> => ({
		get(_t, k) {
			if (k === STATE) return s;
			if (s.kind === "array" && (readMethods.has(k) || writeMethods.has(k))) return partMethod(s, k);
			const cur = latest(s), v = Reflect.get(cur, k);
			if (typeof k === "symbol" || !isObject(v)) return v;
			if (stateOf(v)) return v; // already a draft (assigned in this commit, or a child handed out before)
			if (!own(cur, k)) return v; // prototype members (array methods)
			if (s.kind === "array") return v; // a record of a part: immutable, replaced to change
			const known = s.children.get(k);
			if (known !== undefined && stateOf(known)?.base === v) return known;
			const child = create(v, s, k);
			s.children.set(k, child);
			if (s.copy) (s.copy as Record<string | symbol, unknown>)[k] = child;
			return child;
		},
		set(_t, k, v) {
			live();
			// writing what is there already changes nothing (and must not wake the document's watches)
			const cur = latest(s);
			if (own(cur, k) && Object.is(Reflect.get(cur, k), v)) return true;
			modify(s);
			(s.copy as Record<string | symbol, unknown>)[k] = v;
			s.children.delete(k);
			if (stateOf(v)) s.children.set(k, v);
			if (s.kind === "array" && isObject(v)) s.assigned.add(v);
			return true;
		},
		deleteProperty(_t, k) {
			live();
			if (!own(latest(s), k)) return true;
			modify(s);
			delete (s.copy as Record<string | symbol, unknown>)[k];
			s.children.delete(k);
			return true;
		},
		has: (_t, k) => k === STATE || Reflect.has(latest(s), k),
		ownKeys: () => Reflect.ownKeys(latest(s)),
		getOwnPropertyDescriptor(_t, k) {
			const d = Reflect.getOwnPropertyDescriptor(latest(s), k);
			if (!d) return d;
			// the target is the base: a property it has as non-configurable (an array's length) must be reported so;
			// any other one, also one only the copy has, as configurable
			const t = Reflect.getOwnPropertyDescriptor(s.base, k);
			return { ...d, configurable: t ? t.configurable !== false : true };
		},
		defineProperty(_t, k, d) {
			live();
			modify(s);
			return Reflect.defineProperty(s.copy as object, k, d);
		},
		getPrototypeOf: () => Object.getPrototypeOf(latest(s)),
		setPrototypeOf: () => false,
	});

	// a map part: changed in place (its base is the committed map), undone on failure; records handed out unwrapped
	const mapHandler = (s: State): ProxyHandler<object> => {
		const m = s.base as Record<string, unknown>;
		const note = (k: string) => {
			if (!s.undo.has(k)) s.undo.set(k, { had: own(m, k), old: m[k] });
			if (!changes.has(s.path)) changes.set(s.path, new Set());
			changes.get(s.path)!.add(k);
		};
		return {
			get: (_t, k) => (k === STATE ? s : Reflect.get(m, k)),
			set(_t, k, v) {
				live();
				if (typeof k === "symbol") return false;
				if (own(m, k) && Object.is(m[k], v)) return true;
				note(k);
				m[k] = v;
				if (isObject(v)) s.assigned.add(v);
				return true;
			},
			deleteProperty(_t, k) {
				live();
				if (typeof k === "symbol" || !own(m, k)) return true;
				note(k);
				delete m[k];
				return true;
			},
			defineProperty: () => false,
		};
	};

	/** The final value of a drafted or plain value: drafts give their (finished) latest value, plain objects assigned in
	 *  this commit are searched for drafts inside them. */
	const seen = new Map<object, unknown>();
	const finalize = (v: unknown): unknown => {
		if (!isObject(v)) return v;
		if (seen.has(v)) return seen.get(v);
		const s = stateOf(v);
		if (!s && diskMapOf(v)) return v; // a map part on the disk (store/disk-map.ts) holds no drafts and is not enumerated
		if (s?.kind === "map") {
			// the map itself is the committed one; only the records written in this commit can hold drafts
			seen.set(v, s.base);
			for (const k of changes.get(s.path) ?? []) { const r = (s.base as Record<string, unknown>)[k]; if (isObject(r) && s.assigned.has(r)) { const f = finalize(r); (s.base as Record<string, unknown>)[k] = f; fresh.push(f); } }
			return s.base;
		}
		if (s && !s.copy) { seen.set(v, s.base); return s.base; } // read only: the committed object itself
		const obj = s ? (s.copy as Obj) : v;
		seen.set(v, obj);
		if (s?.kind === "array") {
			// unchanged records are committed values without drafts: only the ones written now are looked into
			const a = obj as unknown[];
			for (let i = 0; i < a.length; i++) { const c = a[i]; if (isObject(c) && (stateOf(c) || s.assigned.has(c))) { const f = finalize(c); if (f !== c) a[i] = f; fresh.push(f); } }
		} else if (s || hasDraftInside(obj)) for (const k of Object.keys(obj)) {
			const c = (obj as Record<string, unknown>)[k], f = finalize(c);
			if (f !== c) (obj as Record<string, unknown>)[k] = f;
		}
		return obj;
	};
	// a plain object assigned in this commit can hold drafts (an entry built from drafted parts); one that holds none is
	// left as it is, so the scan stops at committed objects
	const hasDraftInside = (o: Obj, depth = 0): boolean => {
		if (depth > 64) return false;
		for (const k of Object.keys(o)) {
			const c = (o as Record<string, unknown>)[k];
			if (!isObject(c)) continue;
			if (stateOf(c)) return true;
			if (diskMapOf(c)) continue;
			if (hasDraftInside(c, depth + 1)) return true;
		}
		return false;
	};

	const root = create(base, null, null);
	const end = () => { done = true; for (const s of states) s.revoke(); };
	return {
		get value() { live(); return root as unknown as T; },
		changes,
		fresh,
		finish() {
			live();
			const out = finalize(root) as T;
			end();
			return out;
		},
		discard() {
			if (done) return;
			// map parts were changed in place: put back what they held
			for (const s of states) if (s.kind === "map") for (const [k, u] of [...s.undo].reverse()) { const m = s.base as Record<string, unknown>; if (u.had) m[k] = u.old; else delete m[k]; }
			changes.clear();
			end();
		},
	};
}

/** Whether a value is a draft of a commit. */
export const isDraft = (v: unknown): boolean => isObject(v) && (v as Record<symbol, unknown>)[STATE] !== undefined;

/** A detached copy of a value a commit returns or a draft hands out (a callback's result must not be a draft). */
export function detach<T>(v: T): T {
	if (!isObject(v)) return v;
	if (Array.isArray(v)) return v.map(detach) as unknown as T;
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(v)) out[k] = detach((v as Record<string, unknown>)[k]);
	return out as T;
}
