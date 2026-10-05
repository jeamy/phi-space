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
	timeoutMs: Type.Optional(Type.Number({ description: `Wait up to this long (max ${MAX_WAIT_MS}). 0 = do not wait.` })),
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
				const deadline = await api.memo<number>("deadline", Date.now() + Math.min(a.timeoutMs ?? 0, MAX_WAIT_MS), ctx);
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
				const deadline = await api.memo<number>("deadline", Date.now() + Math.min(a.timeoutMs ?? 0, MAX_WAIT_MS), ctx);
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
			parameters: Type.Object({ type: Type.Optional(Type.String()), fields: Fields, mode: Type.Optional(Type.Union([Type.Literal("take"), Type.Literal("read")])), timeoutMs: Type.Number({ description: "How long the wait stays registered (up to 1 day)" }), txnLeaseMs: Type.Optional(Type.Number({ description: "Lease for the transaction that holds a taken entry (default 1 h)" })) }),
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

/** Deliver outbox events (notify, served waiters, timeouts) as input to their conversations. `requestId` makes redelivery harmless. */
export async function deliverEvents(harness: Harness, ctx: Context): Promise<number> {
	const snap = await harness.snapshot(Space, ctx);
	const events = [...(snap?.outbox ?? [])];
	for (const e of events) {
		const conv = e.target ? await harness.conversation(e.target as any, ctx) : undefined;
		if (conv) await conv.submit({ type: "input", requestId: `${e.eventId}:${e.seq}`, content: describe(e) }, ctx);
		await harness.commit(async (tx) => {
			const s = await tx.doc(Space);
			s.outbox = s.outbox.filter((x) => !(x.eventId === e.eventId && x.seq === e.seq));
		}, ctx);
	}
	return events.length;
}

/**
 * Reaper: removes expired entries/leases, aborts expired transactions and times out waiters at the moment they lapse
 * instead of at the next operation. Stateless (`settle` is idempotent), so after a restart just start it again.
 */
export async function startMaintenance(harness: Harness, ctx: Context, now: () => number = Date.now): Promise<() => Promise<void>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const tick = async () => {
		if (stopped) return;
		clearTimeout(timer);
		const next = await harness.commit(async (tx) => {
			const s = await tx.doc(Space);
			core.settle(s, now());
			return core.nextExpiry(s);
		}, ctx);
		if (!stopped && next < core.FOREVER) timer = setTimeout(() => void tick().catch(() => {}), Math.max(1, next - now()));
	};
	await tick(); // creates the doc, so the watch below has something to observe
	const watch = await harness.watchDoc(Space, ctx);
	watch?.start(async () => { await tick(); });
	return async () => { stopped = true; clearTimeout(timer); await watch?.stop(); };
}

/** Delivery plus reaper: everything the space needs to run in the background. */
export async function startService(harness: Harness, ctx: Context): Promise<() => Promise<void>> {
	const stops = [await startMaintenance(harness, ctx), await startDelivery(harness, ctx)];
	return async () => { for (const stop of stops) await stop(); };
}

/** Deliver whenever the space changes. Returns a stop function. */
export async function startDelivery(harness: Harness, ctx: Context): Promise<() => Promise<void>> {
	await harness.commit(async (tx) => { await tx.doc(Space); }, ctx);
	const watch = await harness.watchDoc(Space, ctx);
	watch?.start(async () => { await deliverEvents(harness, ctx); });
	await deliverEvents(harness, ctx); // events committed before the watch started
	return async () => { await watch?.stop(); };
}
