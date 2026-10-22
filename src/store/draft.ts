// Copy-on-write drafts of JSON documents (docs/umstellung-ohne-pi-durable.md, U2). A commit callback works on a draft:
// reads go through to the committed value, the first write to an object copies it (and its ancestors) shallowly, so the
// committed value and every snapshot of it stay as they were. `finish()` returns the new value, in which every object
// the commit did not change is the very same object as before: the store finds what changed by identity. After
// `finish()` (or `discard()`) the draft is revoked; a late write throws instead of reaching a later commit.

type Obj = Record<string | symbol, unknown> | unknown[];

/** The bookkeeping of one drafted object. */
type State = {
	base: Obj;
	copy: Obj | null;
	parent: State | null;
	key: string | symbol | null;
	children: Map<string | symbol, unknown>; // child proxies handed out, by key
	proxy: Obj;
	revoke: () => void;
};

const STATE = Symbol("phi-spaces.draft");
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null;
const latest = (s: State): Obj => s.copy ?? s.base;
const shallow = (o: Obj): Obj => (Array.isArray(o) ? o.slice() : Object.assign(Object.create(Object.getPrototypeOf(o)), o));

export type Draft<T> = { readonly value: T; finish(): T; discard(): void };

/** A draft of `base` (a JSON value: plain objects, arrays, primitives). */
export function draftOf<T>(base: T): Draft<T> {
	if (!isObject(base)) throw new TypeError("a draft needs an object");
	const states: State[] = [];
	let done = false;

	const stateOf = (v: unknown): State | undefined => (isObject(v) ? ((v as Record<symbol, unknown>)[STATE] as State | undefined) : undefined);
	const modify = (s: State) => {
		if (s.copy) return;
		s.copy = shallow(s.base);
		// the copy keeps the proxies already handed out for its children: a later write through them lands in this copy
		for (const [k, child] of s.children) (s.copy as Record<string | symbol, unknown>)[k] = child;
		if (s.parent) modify(s.parent);
	};
	const create = (value: Obj, parent: State | null, key: string | symbol | null): Obj => {
		const s = { base: value, copy: null, parent, key, children: new Map() } as unknown as State;
		const { proxy, revoke } = Proxy.revocable(value as object, {
			get(_t, k) {
				if (k === STATE) return s;
				const cur = latest(s), v = Reflect.get(cur, k);
				if (typeof k === "symbol" || !isObject(v)) return v;
				if (stateOf(v)) return v; // already a draft (assigned in this commit, or a child handed out before)
				if (!Object.prototype.hasOwnProperty.call(cur, k)) return v; // prototype members (array methods)
				const known = s.children.get(k);
				if (known !== undefined && stateOf(known)?.base === v) return known;
				const child = create(v, s, k);
				s.children.set(k, child);
				if (s.copy) (s.copy as Record<string | symbol, unknown>)[k] = child;
				return child;
			},
			set(_t, k, v) {
				if (done) throw new TypeError("this commit's draft is finished");
				// writing what is there already changes nothing (and must not wake the document's watches)
				const cur = latest(s);
				if (Object.prototype.hasOwnProperty.call(cur, k) && Object.is(Reflect.get(cur, k), v)) return true;
				modify(s);
				(s.copy as Record<string | symbol, unknown>)[k] = v;
				s.children.delete(k);
				if (stateOf(v)) s.children.set(k, v);
				return true;
			},
			deleteProperty(_t, k) {
				if (done) throw new TypeError("this commit's draft is finished");
				if (!Object.prototype.hasOwnProperty.call(latest(s), k)) return true;
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
				if (done) throw new TypeError("this commit's draft is finished");
				modify(s);
				return Reflect.defineProperty(s.copy as object, k, d);
			},
			getPrototypeOf: () => Object.getPrototypeOf(latest(s)),
			setPrototypeOf: () => false,
		});
		s.proxy = proxy as Obj;
		s.revoke = revoke;
		states.push(s);
		return proxy as Obj;
	};

	/** The final value of a drafted or plain value: drafts give their (finished) latest value, plain objects assigned in
	 *  this commit are searched for drafts inside them. */
	const seen = new Map<object, unknown>();
	const finalize = (v: unknown): unknown => {
		if (!isObject(v)) return v;
		if (seen.has(v)) return seen.get(v);
		const s = stateOf(v);
		if (s && !s.copy) { seen.set(v, s.base); return s.base; } // read only: the committed object itself
		const obj = s ? (s.copy as Obj) : v;
		seen.set(v, obj);
		if (s || hasDraftInside(obj)) for (const k of Object.keys(obj)) {
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
			if (hasDraftInside(c, depth + 1)) return true;
		}
		return false;
	};

	const root = create(base, null, null);
	const end = () => { done = true; for (const s of states) s.revoke(); };
	return {
		get value() { if (done) throw new TypeError("this commit's draft is finished"); return root as unknown as T; },
		finish() {
			if (done) throw new TypeError("this commit's draft is finished");
			const out = finalize(root) as T;
			end();
			return out;
		},
		discard() { if (!done) end(); },
	};
}

/** Whether a value is a draft of a commit (or holds none at its top). */
export const isDraft = (v: unknown): boolean => isObject(v) && (v as Record<symbol, unknown>)[STATE] !== undefined;

/** A detached copy of a value a commit returns or a draft hands out (a callback's result must not be a draft). */
export function detach<T>(v: T): T {
	if (!isObject(v)) return v;
	if (Array.isArray(v)) return v.map(detach) as unknown as T;
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(v)) out[k] = detach((v as Record<string, unknown>)[k]);
	return out as T;
}
