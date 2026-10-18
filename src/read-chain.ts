// Bounded, read-only traversal of an entry-linked list from one immutable snapshot.
import * as core from "./core.ts";
import { jsonBytes } from "./json.ts";

export type ChainOptions = { head?: core.Template; cursor?: string; nextField?: string; limit?: number; maxBytes?: number };
export type ChainPage = { items: core.EntryView[]; next: string; ready: boolean; rev: number; streamId: string };

export function readChain(state: Readonly<core.SpaceState>, now: number, template: core.Template, o: ChainOptions = {}, owner?: core.Target): ChainPage {
	core.assertAdminIdle(state);
	const limit = o.limit ?? 100, field = o.nextField ?? "next";
	const cap = Math.min(o.maxBytes ?? core.limitsOf(state).maxFrameBytes, core.limitsOf(state).maxFrameBytes);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) throw new core.IllegalArgumentError("chain limit must be between 1 and 512");
	if (!Number.isSafeInteger(cap) || cap < 1 || typeof field !== "string" || !field || field.length > 128) throw new core.IllegalArgumentError("invalid chain budget or pointer field");
	if (o.cursor !== undefined && typeof o.cursor !== "string") throw new core.IllegalArgumentError("invalid chain cursor");
	if (o.cursor === undefined && !o.head) throw new core.IllegalArgumentError("a chain needs a head or cursor");
	const result: ChainPage = { items: [], next: o.cursor ?? "", ready: true, rev: core.revision(state), streamId: core.streamIdOf(state) };
	const pointer = (entry: core.EntryView) => {
		const value = entry.fields[field];
		if (typeof value !== "string") throw new core.IllegalArgumentError("chain pointer must be a string");
		return value;
	};
	if (o.cursor === undefined) {
		const head = core.list(state, now, o.head!, null, 1, owner)[0];
		if (!head) throw new core.IllegalArgumentError("chain head unavailable");
		result.ready = head.fields.ready !== false;
		result.next = pointer(head);
	}
	const index = new Map(state.entries.map(entry => [entry.id, entry]));
	const seen = new Set<string>();
	while (result.next && result.items.length < limit && result.ready) {
		const id = result.next;
		if (seen.has(id)) throw new core.IllegalArgumentError("cyclic entry chain");
		seen.add(id);
		const raw = index.get(id);
		// Preserve exactly the normal read visibility, expiry, lock and template rules.
		const entry = raw && core.list({ ...state, entries: [raw] }, now, { ...template, id }, null, 1, owner)[0];
		if (!entry) throw new core.IllegalArgumentError("chain node unavailable");
		const next = pointer(entry);
		const candidate = { ...result, items: [...result.items, entry], next };
		const bytes = jsonBytes(candidate);
		if (bytes > cap) {
			if (!result.items.length) throw new core.ResponseBudgetTooSmall(bytes);
			break; // cursor still points at the unconsumed node
		}
		result.items.push(entry); result.next = next;
	}
	if (jsonBytes(result) > cap) throw new core.ResponseBudgetTooSmall(jsonBytes(result));
	return result;
}
