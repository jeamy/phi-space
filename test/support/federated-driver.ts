// FederatedSpace (src/federated-space.ts) over real RouterControllers and scripted Members, for rust/phi-host/tests/federated_space.rs. Each
// reply carries the calls the Members saw and every journal document, so both sides can be held against each other byte for byte.
//
//   node --experimental-strip-types --no-warnings test/support/federated-driver.ts
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { digestJson } from "../../src/canonical.ts";
import { openOwnMemoryHost, type OwnStoreHost } from "../../src/store/host.ts";
import { FederatedSpace, FederationOperations } from "../../src/federated-space.ts";
import { FederationJournalLayout, parentJournalKey, partitionRouterId } from "../../src/federation-journals.ts";
import { RouterCommands, RouterController, RouterJournal, type RouterReceipt, type RouterStep } from "../../src/router.ts";
import { FederationRouting } from "../../src/federation-policy.ts";
import { TransportFailure } from "../../src/remote.ts";
import { ReplicaConfigPending } from "../../src/core.ts";

type Line = Record<string, any>;
let host: OwnStoreHost, space: FederatedSpace, routers: RouterController[] = [], main: RouterController, partitions = 1, state: any, clock = 1000, generation = 0, seq = 0;
let plan: any[] = [], steps: any[] = [], events: any[] = [], snapshots: any[] = [], active: boolean[] = [], calls: unknown[] = [];
const ID = "f1", CONTROL = "ctl", AUTHORITY = "a", tail = (s: string) => s.slice(-8);
const defaultResult = (s: Readonly<RouterStep>): unknown => s.method === "wait" ? `reg-${tail(s.requestId)}` : s.method === "txn" ? { id: `t-${tail(s.requestId)}` } : s.method === "lease" ? null : { id: `x-${tail(s.requestId)}` };
const receipt = (s: Readonly<RouterStep>): RouterReceipt => {
	const next = plan.shift() ?? { outcome: "done", result: defaultResult(s) };
	if (next === "throw") throw new Error("the line broke");
	return { target: s.target, principal: s.principal, method: s.method, generation: s.generation, requestId: s.requestId, argHash: s.argHash, ...next };
};
const target: any = { protocol: "phi-spaces-rpc-v1", invoke: async (s: RouterStep) => receipt(s), resolve: async (s: RouterStep) => receipt(s) };
const io = {
	step: async (member: string, principal: any, method: any, args: any, policyVersion?: number, origin?: any) => {
		calls.push(["step", member, method, args, policyVersion ?? null, origin?.requestId ?? null]);
		const how = steps.shift();
		if (how === "transport") throw new TransportFailure("no line");
		if (how === "pending") throw new ReplicaConfigPending("wait");
		return { target: state.members[member].target, principal, generation: `g-${++generation}`, method, args, policyVersion: policyVersion ?? state.policy.policyVersion };
	},
	snapshot: async (member: string, _p: any, template: any, txn?: string) => {
		calls.push(["snapshot", member, template, txn ?? null]);
		if (snapshots.shift() === "throw") throw new Error("no snapshot");
		return { entries: [{ id: `e-${member}` }], revision: 3 };
	},
	events: async (member: string, _p: any, registration: any) => {
		calls.push(["events", member, registration.requestId]);
		const page = events.shift();
		if (page === "gap") return { epoch: "ep", events: [], gap: true };
		if (!page) return { epoch: "ep", events: [] };
		return { epoch: "ep", events: [{ seq: ++seq, event: { eventId: page.other ? "other" : registration.result, kind: page.kind, ...(page.entry ? { entry: page.entry } : {}), ...(page.txn ? { txn: page.txn } : {}) } }] };
	},
	ack: async (member: string, _p: any, epoch: string, n: number) => { calls.push(["ack", member, epoch, n]); },
	txnActive: async (member: string, _p: any, txn: string) => { calls.push(["txnActive", member, txn]); return active.shift() ?? true; },
};
async function open() {
	const assertAuthority = async () => {};
	const make = (routerId: string) => new RouterController({ host, ctx, routerId, authorityId: AUTHORITY, target, assertAuthority, now: () => clock });
	main = make(ID);
	routers = partitions === 1 ? [main] : Array.from({ length: partitions }, (_, n) => make(partitionRouterId(ID, n)));
	space = new FederatedSpace({ host, ctx, id: ID, router: main, journalPartitions: partitions, partitionRouters: routers, state: async () => structuredClone(state), io: io as any, assertAuthority, now: () => clock, controlSpaceId: CONTROL });
	await space.initializeJournals();
	await RouterController.recoverMany([main, ...routers]);
}
async function run(l: Line): Promise<unknown> {
	const q = { id: l.id, principal: l.principal, ...(l.txn ? { txn: l.txn } : {}) };
	switch (l.op) {
		case "season":
			await host?.close(ctx); host = openOwnMemoryHost(); partitions = l.partitions; state = l.state; generation = 0; seq = 0;
			await host.commit(async (tx) => { Object.assign(await tx.doc(FederationRouting, CONTROL, null), state); }, ctx);
			return open().then(() => null);
		case "restart": return open().then(() => null);
		case "write": return space.write(l.entry, q, l.leaseMs ?? undefined);
		case "read": return space.read(l.template, q);
		case "take": return space.take(l.template, q);
		case "begin": return space.createTransaction(l.member, l.leaseMs, q);
		case "finish": return space.finishTransaction(l.origin, l.action, q);
		case "takeWaiting": return space.takeWaiting(l.template, l.timeoutMs, l.txnLeaseMs, q);
		case "readWaiting": return space.readWaiting(l.template, l.timeoutMs, q);
		case "resume": return space.resume(l.id);
		case "readAll": return space.readAll(l.template, l.principal, { allowPartial: l.partial === true });
		case "count": return space.count(l.template, l.principal, { allowPartial: l.partial === true });
		default: throw new Error(`unknown line ${l.op}`);
	}
}
async function docs() {
	const out: Record<string, unknown> = { layout: (await host.snapshot(FederationJournalLayout, ID, ctx)) ?? null };
	for (let p = 0; p < partitions; p++) { const key = parentJournalKey(ID, partitions, p); out[`ops:${p}`] = (await host.snapshot(FederationOperations, key, ctx)) ?? null; }
	for (const r of new Set([main, ...routers])) {
		const index = await host.snapshot(RouterJournal, r.journalId, ctx);
		out[`journal:${r.journalId}`] = index ?? null;
		for (const id of Object.keys(index?.refs ?? {})) out[`command:${r.journalId}:${id}`] = (await host.snapshot(RouterCommands, digestJson([r.journalId, id]), ctx))?.command ?? null;
	}
	return out;
}
for await (const text of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	if (!text.trim()) continue;
	const l = JSON.parse(text) as Line;
	plan = l.plan ?? []; steps = l.steps ?? []; events = l.events ?? []; snapshots = l.snapshots ?? []; active = l.active ?? []; calls = []; clock += 1;
	let out: Record<string, unknown>;
	try { out = { ok: true, result: (await run(l)) ?? null }; } catch (e) { out = { ok: false, error: (e as Error).constructor.name, message: (e as Error).message }; }
	console.log(JSON.stringify({ ...out, calls, docs: await docs() }));
}
