// pi-spaces: a JavaSpaces-style space as a pi-durable extension.
//   core.ts    pure spec semantics (entries, templates, leases, transactions, notify)
//   client.ts  JavaSpace-shaped API over a Session document, with blocking read/take
//   index.ts   LLM tools, prompt section, event delivery
import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import { defineDoc, defineExtension, defineTool, section, type Harness, type Tx } from "@earendil-works/pi-durable";
import { JavaSpace, Space, type Once } from "./client.ts";
import * as core from "./core.ts";

export * from "./client.ts";
export { core };

const MAX_WAIT_MS = 60_000; // a blocking tool holds the turn: cap it

// Exactly-once per tool call: recorded in the same commit as the change, keyed by the tool task. Task documents
// retire when the task is terminal, so there is nothing to clean up.
const Claim = defineDoc<{ done: boolean; value: core.Json }>({
	kind: "pi-spaces.claim",
	version: 1,
	scope: "task",
	initial: () => ({ done: false, value: null }),
});
const onceFor = (taskId: any): Once => ({
	get: async (tx: Tx) => { const c = await tx.doc(Claim, taskId); return c.done ? c.value : undefined; },
	set: async (tx: Tx, v) => { const c = await tx.doc(Claim, taskId); c.done = true; c.value = v; },
});

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v ?? null) }] });
const Fields = Type.Optional(Type.Record(Type.String(), Type.Any()));
const TemplateParams = {
	type: Type.Optional(Type.String({ description: "Entry type; also matches subtypes" })),
	fields: Fields,
	timeoutMs: Type.Optional(Type.Number({ minimum: 0, description: `Wait up to this long (max ${MAX_WAIT_MS}). 0 = do not wait.` })),
	ifExists: Type.Optional(Type.Boolean({ description: "Do not wait for a match to appear; wait only while matches are locked by another transaction" })),
	txn: Type.Optional(Type.String()),
};

export const spaces = defineExtension({
	name: "spaces",
	tools: [
		defineTool({
			name: "space_write",
			description: "Write an entry {type, fields} into the shared space. ttlMs is its lease (entry vanishes afterwards).",
			parameters: Type.Object({ type: Type.String(), fields: Type.Record(Type.String(), Type.Any()), types: Type.Optional(Type.Array(Type.String())), ttlMs: Type.Optional(Type.Number()), txn: Type.Optional(Type.String()) }),
			replay: "safe",
			execute: async (a, api, ctx) => {
				const lease = await api.commit(async (tx) => {
					const c = await tx.doc(Claim, api.taskId);
					if (c.done) return c.value;
					const l = core.write(await tx.doc(Space), Date.now(), { type: a.type, ...(a.types ? { types: a.types } : {}), fields: a.fields as core.Fields }, a.txn ?? null, a.ttlMs ?? core.ANY);
					c.done = true; c.value = l as unknown as core.Json;
					return l;
				}, ctx);
				return text(lease);
			},
		}),
		defineTool({
			name: "space_read",
			description: "Read (not remove) an entry matching the template; absent/null fields are wildcards. Returns null on timeout.",
			parameters: Type.Object(TemplateParams),
			replay: "safe",
			execute: async (a, api, ctx) => {
				const deadline = await api.memo<number>("deadline", Date.now() + Math.max(0, Math.min(a.timeoutMs ?? 0, MAX_WAIT_MS)), ctx);
				const s = new JavaSpace(api, ctx);
				const t = { type: a.type ?? null, fields: (a.fields ?? {}) as core.Fields };
				return text(await (a.ifExists ? s.readIfExists : s.read).call(s, t, 0, { txn: a.txn ?? null, deadline }));
			},
		}),
		defineTool({
			name: "space_take",
			description: "Take (remove and return) an entry matching the template. Each entry is taken at most once. Pass txn to make the take undoable: if you never commit, it returns to the space when the txn lease expires.",
			parameters: Type.Object(TemplateParams),
			replay: "safe",
			execute: async (a, api, ctx) => {
				const deadline = await api.memo<number>("deadline", Date.now() + Math.max(0, Math.min(a.timeoutMs ?? 0, MAX_WAIT_MS)), ctx);
				const s = new JavaSpace(api, ctx);
				const t = { type: a.type ?? null, fields: (a.fields ?? {}) as core.Fields };
				const o = { txn: a.txn ?? null, deadline, once: onceFor(api.taskId) };
				return text(await (a.ifExists ? s.takeIfExists : s.take).call(s, t, 0, o));
			},
		}),
		defineTool({
			name: "space_txn",
			description: "Transactions group writes/takes atomically. begin returns {id, expires}; commit makes them permanent, abort undoes them. An expired txn aborts.",
			parameters: Type.Object({ action: Type.Union([Type.Literal("begin"), Type.Literal("commit"), Type.Literal("abort")]), txn: Type.Optional(Type.String()), leaseMs: Type.Optional(Type.Number()) }),
			replay: "unsafe",
			execute: async (a, api, ctx) => {
				const s = new JavaSpace(api, ctx);
				if (a.action === "begin") return text(await s.createTransaction(a.leaseMs ?? core.ANY));
				if (!a.txn) throw new core.IllegalArgumentError("txn required");
				await (a.action === "commit" ? s.commit(a.txn) : s.abort(a.txn));
				return text("ok");
			},
		}),
		defineTool({
			name: "space_wait",
			description: "Wait for a matching entry WITHOUT blocking this turn. Returns at once with a wait id; when an entry appears (or the timeout passes) the space sends you a message. A take-wait hands you the entry under a transaction: commit it with space_txn when done, or it returns to the space when the lease lapses. Use this for long waits; space_take/space_read with timeoutMs block the turn.",
			parameters: Type.Object({ type: Type.Optional(Type.String()), fields: Fields, mode: Type.Optional(Type.Union([Type.Literal("take"), Type.Literal("read")])), timeoutMs: Type.Number({ minimum: 0, description: "How long the wait stays registered (up to 1 day)" }), txnLeaseMs: Type.Optional(Type.Number({ description: "Lease for the transaction that holds a taken entry (default 1 h)" })) }),
			replay: "safe",
			execute: async (a, api, ctx) => {
				const id = await api.commit(async (tx) => {
					const c = await tx.doc(Claim, api.taskId);
					if (c.done) return c.value as string;
					const w = core.addWaiter(await tx.doc(Space), Date.now(), { template: { type: a.type ?? null, fields: (a.fields ?? {}) as core.Fields }, take: a.mode !== "read", target: api.conversationId as unknown as string, timeout: Math.min(a.timeoutMs, core.MAX_LEASE_MS), ...(a.txnLeaseMs === undefined ? {} : { txnLeaseMs: a.txnLeaseMs }) });
					c.done = true; c.value = w;
					return w;
				}, ctx);
				return text({ waitId: id });
			},
		}),
		defineTool({
			name: "space_notify",
			description: "Subscribe to future writes matching the template: each one sends you a message (until ttlMs passes or you cancel with space_lease). Unlike space_wait this is not one-shot and takes nothing.",
			parameters: Type.Object({ type: Type.Optional(Type.String()), fields: Fields, ttlMs: Type.Optional(Type.Number({ minimum: 0 })), handback: Type.Optional(Type.Any()) }),
			replay: "safe",
			execute: async (a, api, ctx) => {
				const r = await api.commit(async (tx) => {
					const c = await tx.doc(Claim, api.taskId);
					if (c.done) return c.value;
					const n = core.notify(await tx.doc(Space), Date.now(), { type: a.type ?? null, fields: (a.fields ?? {}) as core.Fields }, null, a.ttlMs ?? core.ANY, (a.handback ?? null) as core.Json, api.conversationId as unknown as string);
					c.done = true; c.value = n as unknown as core.Json;
					return n;
				}, ctx);
				return text(r);
			},
		}),
		defineTool({
			name: "space_lease",
			description: "Renew or cancel a lease (entry, notify registration or transaction id).",
			parameters: Type.Object({ action: Type.Union([Type.Literal("renew"), Type.Literal("cancel")]), id: Type.String(), ms: Type.Optional(Type.Number()) }),
			replay: "unsafe",
			execute: async (a, api, ctx) => {
				const s = new JavaSpace(api, ctx);
				return text(a.action === "renew" ? await s.renew(a.id, a.ms ?? core.ANY) : (await s.cancel(a.id), "ok"));
			},
		}),
	],
	sections: [
		section("spaces", async (input, rc) => {
			const d = await input.read.snapshot(Space, rc);
			const n = d?.entries.length ?? 0;
			return `Shared space (${n} entries). Entries are {type, fields}. space_write/space_read/space_take match by template: absent or null fields are wildcards. Prefer wrapping a take in a transaction (space_txn) when the work can fail.`;
		}),
	],
});

const describe = (e: core.SpaceEvent): string => {
	const en = e.entry ? ` ${e.entry.type} ${JSON.stringify(e.entry.fields)}` : "";
	const hb = e.handback === null ? "" : ` (handback: ${JSON.stringify(e.handback)})`;
	if (e.kind === "timeout") return `[space] your wait ${e.eventId} timed out${hb}`;
	if (e.kind === "waiter") {
		const hold = e.txn ? ` You hold it under transaction ${e.txn}: call space_txn commit when done, or abort to return it. If you do nothing it returns to the space when the lease lapses.` : "";
		return `[space] your wait ${e.eventId} was served:${en}${hb}.${hold}`;
	}
	return `[space event ${e.eventId} #${e.seq}] a${en} entry was written${hb}`;
};

const MAX_TRIES = 5; // a poisoned event is dropped after this many failed deliveries

/**
 * Deliver outbox events (notify, served waiters, timeouts) as input to their conversations. One failing event does not
 * hold back the others: it is retried on the next trigger and dropped after MAX_TRIES. `requestId` makes redelivery
 * harmless. Delivered and given-up events leave the outbox in one commit.
 */
export async function deliverEvents(harness: Harness, ctx: Context, o: ServiceOptions = {}): Promise<number> {
	const now = o.now ?? Date.now;
	const retryMs = o.retryMs ?? 1000;
	const snap = await harness.snapshot(Space, ctx);
	const events = (snap?.outbox ?? []).filter((e) => (e.retryAt ?? 0) <= now()); // failed ones wait for their backoff
	const done = new Set<string>(); // submitted
	const dropped = new Set<string>(); // nobody to deliver to: no target, or the conversation no longer exists
	const failed = new Set<string>();
	const key = (e: core.SpaceEvent) => `${e.eventId}:${e.seq}`;
	for (const e of events) {
		try {
			const conv = e.target != null && e.target !== "" ? await harness.conversation(e.target as any, ctx) : undefined;
			if (!conv) dropped.add(key(e));
			else {
				await conv.submit({ type: "input", requestId: key(e), content: describe(e) }, ctx);
				done.add(key(e));
			}
		} catch {
			failed.add(key(e));
		}
	}
	if (done.size === 0 && dropped.size === 0 && failed.size === 0) return 0;
	await harness.commit(async (tx) => {
		const s = await tx.doc(Space);
		s.outbox = s.outbox.filter((x) => !done.has(key(x)) && !dropped.has(key(x)));
		for (const x of s.outbox) if (failed.has(key(x))) { x.tries = (x.tries ?? 0) + 1; x.retryAt = now() + retryMs * x.tries; }
		s.outbox = s.outbox.filter((x) => (x.tries ?? 0) < MAX_TRIES);
	}, ctx);
	return done.size;
}

/**
 * Reaper: removes expired entries/leases, aborts expired transactions and times out waiters at the moment they lapse
 * instead of at the next operation. Stateless (`settle` is idempotent), so after a restart just start it again.
 */
export type ServiceOptions = { now?: () => number; onError?: (e: unknown) => void; retryMs?: number };

export async function startMaintenance(harness: Harness, ctx: Context, o: ServiceOptions = {}): Promise<() => Promise<void>> {
	const now = o.now ?? Date.now;
	const onError = o.onError ?? ((e) => console.error("pi-spaces reaper:", e));
	const retryMs = o.retryMs ?? 1000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const arm = (ms: number) => { clearTimeout(timer); if (!stopped) timer = setTimeout(() => void tick(), Math.max(1, ms)); };
	// A failed commit must not end the reaper (and a throwing watch listener would end the watch): log and retry.
	const tick = async (): Promise<void> => {
		if (stopped) return;
		clearTimeout(timer);
		try {
			const next = await harness.commit(async (tx) => {
				const s = await tx.doc(Space);
				core.settle(s, now());
				return core.nextExpiry(s);
			}, ctx);
			if (next < core.FOREVER) arm(next - now());
		} catch (e) {
			onError(e);
			arm(retryMs);
		}
	};
	await tick(); // creates the doc, so the watch below has something to observe
	const watch = await harness.watchDoc(Space, ctx);
	watch?.start(tick); // tick never throws
	return async () => { stopped = true; clearTimeout(timer); await watch?.stop(); };
}

/** Delivery plus reaper: everything the space needs to run in the background. */
export async function startService(harness: Harness, ctx: Context, o: ServiceOptions = {}): Promise<() => Promise<void>> {
	const stops = [await startMaintenance(harness, ctx, o), await startDelivery(harness, ctx, o)];
	return async () => { for (const stop of stops) await stop(); };
}

/** Deliver whenever the space changes, and retry failed events on a timer. Returns a stop function. */
export async function startDelivery(harness: Harness, ctx: Context, o: ServiceOptions = {}): Promise<() => Promise<void>> {
	const onError = o.onError ?? ((e) => console.error("pi-spaces delivery:", e));
	const retryMs = o.retryMs ?? 1000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const run = async (): Promise<void> => {
		if (stopped) return;
		clearTimeout(timer);
		try {
			await deliverEvents(harness, ctx, o);
			let next = Infinity; // wake for the earliest backed-off retry; the commit that set it re-triggers run() once, harmlessly
			for (const e of (await harness.snapshot(Space, ctx))?.outbox ?? []) if (e.retryAt !== undefined) next = Math.min(next, e.retryAt);
			if (next < Infinity && !stopped) timer = setTimeout(() => void run(), Math.max(1, next - (o.now ?? Date.now)()));
		} catch (e) {
			onError(e);
			if (!stopped) timer = setTimeout(() => void run(), retryMs);
		}
	};
	await harness.commit(async (tx) => { await tx.doc(Space); }, ctx);
	const watch = await harness.watchDoc(Space, ctx);
	watch?.start(run); // run never throws, so the watch is not ended by a listener error
	await run(); // events committed before the watch started
	return async () => { stopped = true; clearTimeout(timer); await watch?.stop(); };
}
