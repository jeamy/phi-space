// The pack newest first: the kind of thing that came last stands first. The page notes when a thing it had not carried
// before came into the pack (by its id, so a thing given, bought, picked up or taken from a chest counts alike) and keeps
// that per kind and figure in the browser (localStorage), so the order stays across a reload.

/** When each kind (by its shown name) last came into the pack. */
export type Arrivals = Map<string, number>;

/** What is new in the pack since `seen` (the ids carried before; null: a full picture just came, nothing in it is new):
 *  the kinds that came get `now`. Gives the ids carried now and whether `at` changed. */
export function noteArrivals(seen: ReadonlySet<string> | null, carried: ReadonlyArray<{ id: string; name: string }>, at: Arrivals, now: number): { seen: Set<string>; changed: boolean } {
	let changed = false;
	if (seen) for (const o of carried) if (!seen.has(o.id) && at.get(o.name) !== now) { at.set(o.name, now); changed = true; }
	return { seen: new Set(carried.map((o) => o.id)), changed };
}

/** Kinds newest first; those never noted after them by name. A seed stands right after what grows of it (`seeds`: seed
 *  name → plant name), in the plant's place, whichever came last: plant and seed count as one kind. */
export function byArrival(at: ReadonlyMap<string, number>, seeds: Readonly<Record<string, string>> = {}): (a: string, b: string) => number {
	const family = (n: string) => seeds[n] ?? n;
	const when = (n: string) => { const f = family(n); return Math.max(at.get(f) ?? 0, ...Object.entries(seeds).filter(([, p]) => p === f).map(([s]) => at.get(s) ?? 0)); };
	return (a, b) => when(b) - when(a) || family(a).localeCompare(family(b)) || Number(a in seeds) - Number(b in seeds) || a.localeCompare(b);
}

const key = (me: string) => `mmo.arrived.${me}`;
export function loadArrivals(me: string): Arrivals {
	try { const v = JSON.parse(localStorage.getItem(key(me)) ?? "{}"); return new Map(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number")); } catch { return new Map(); }
}
/** Saves at most the 200 newest kinds. */
export function saveArrivals(me: string, at: Arrivals): void {
	try { localStorage.setItem(key(me), JSON.stringify(Object.fromEntries([...at].sort((a, b) => b[1] - a[1]).slice(0, 200)))); } catch { /* private window: the order lasts the page */ }
}
