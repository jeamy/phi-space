// Bounded immutable entry snapshots. Tokens are private to a host/space/principal/query and expire on restart.
import { randomBytes } from "node:crypto";
import * as core from "./core.ts";
import { canonicalJson } from "./canonical.ts";
import { bytePage, encodedBytes } from "./paging.ts";

type Record = { snapshotEpoch:number; token: string; streamId: string; query: string; owner: core.Target | undefined; rev: number; expires: number; bytes: number; items: core.EntryView[] };
const hosts = new WeakMap<object, Map<string, Record>>();
export type SnapshotPageOptions = { maxBytes?: number; after?: string | null; token?: string; txn?: string | null };

export function snapshotPage(host: object, state: Readonly<core.SpaceState>, now: number, tmpl: core.Template, o: SnapshotPageOptions, owner?: core.Target): core.Page {
	core.assertAdminIdle(state);
	let cache = hosts.get(host); if (!cache) { cache = new Map(); hosts.set(host, cache); }
	for (const [key, s] of cache) if (s.expires <= now) cache.delete(key);
	const limits = core.limitsOf(state), streamId = core.streamIdOf(state);
	const query = canonicalJson({ tmpl, txn: o.txn ?? null } as unknown as core.Json);
	let token = o.token;
	let offset = 0;
	if (o.after != null) {
		const match = /^(ss[0-9a-f]{32})\.(\d+)$/.exec(o.after);
		if (!match || (token !== undefined && token !== match[1])) throw new core.IllegalArgumentError("invalid snapshot cursor");
		token = match[1]; offset = Number(match[2]);
	}
	let record = token ? cache.get(token) : undefined;
	if (token && (!record || record.streamId !== streamId || record.snapshotEpoch !== (state.snapshotEpoch??0))) throw new core.SnapshotExpired("the entry snapshot expired or belongs to another incarnation");
	if (record && (record.owner !== owner || record.query !== query)) throw new core.PermissionError("the snapshot belongs to another principal or query");
	const fresh = record === undefined;
	if (!record) {
		const items = core.list(state, now, tmpl, o.txn ?? null, Number.MAX_SAFE_INTEGER, owner);
		const bytes = encodedBytes(items);
		if (bytes > limits.maxSnapshotBytes) throw new core.ResourceExhausted("the snapshot exceeds maxSnapshotBytes");
		record = { snapshotEpoch:state.snapshotEpoch??0, token: `ss${randomBytes(16).toString("hex")}`, streamId, query, owner, rev: core.revision(state), expires: core.until(now, limits.snapshotTtlMs), bytes, items };
	}
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.items.length) throw new core.IllegalArgumentError("invalid snapshot position");
	const budget = o.maxBytes ?? limits.maxFrameBytes;
	if (!Number.isSafeInteger(budget) || budget < 1) throw new core.IllegalArgumentError("maxBytes must be positive");
	const rec = record;
	const page = bytePage(rec.items, offset, Math.min(budget, limits.maxFrameBytes), (items, next) => ({ items, next: next === null ? null : `${rec.token}.${next}`, token: rec.token, streamId: rec.streamId, rev: rec.rev }));
	// A failed page never consumes a token or evicts another snapshot.
	if (fresh) {
		const own = () => [...cache!.values()].filter(s => s.streamId === streamId);
		while (own().length >= limits.maxSnapshots || own().reduce((n, s) => n + s.bytes, 0) + rec.bytes > limits.maxSnapshotBytes) {
			const first = own()[0]; if (!first) break; cache.delete(first.token);
		}
		cache.set(rec.token, rec);
	}
	return core.plain(page); // Local callers must not be able to mutate the retained snapshot through a page.
}
