// AP 1.9: RemoteSpace over an abstract transport (federation-plan-v3.md 6.3).
import test from "node:test";
import assert from "node:assert/strict";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	PiSpaces, SpaceService, StaticIdentity, RemoteSpace, inProcessTransport, OutcomeUnknown, UnsupportedOperation, FOREVER, core, RequestConflict, OperationCancelled,
	type Transport,
} from "./src/index.ts";
import { forEachBackend, ctx } from "./test/support/persistent.ts";

const ids = new StaticIdentity({ "peer-a": { principal: { peerId: "peer-a", agentId: "w1" }, roles: ["member"] }, "peer-obs": { principal: { peerId: "peer-obs" }, roles: ["observer"] } });
const memory = () => Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, ctx);
const service = (h: Harness) => new SpaceService({ host: h, ctx, identity: ids });
const sleep0 = () => Promise.resolve();
const fast = { sleep: sleep0, backoffMs: 1 };

/** Seeded PRNG so a failing run can be repeated. */
const prng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

/** A flaky link: a call can be lost before it arrives, or its answer can be lost after the host acted on it. */
class Flaky implements Transport {
	inner: Transport;
	random: () => number;
	dropRequest = 0;
	dropAnswer = 0;
	stats = { lostRequests: 0, lostAnswers: 0, passed: 0 };
	log: string[] = [];
	constructor(inner: Transport, seed: number) { this.inner = inner; this.random = prng(seed); }
	async request(text: string): Promise<string> {
		if (this.random() < this.dropRequest) { this.stats.lostRequests++; throw new Error("link down"); }
		const answer = await this.inner.request(text);
		if (this.random() < this.dropAnswer) { this.stats.lostAnswers++; throw new Error("answer lost"); }
		this.stats.passed++;
		return answer;
	}
}

test("the SpaceLike contract: the same steps give the same results locally and remotely", async () => {
	const steps = async (s: import("./src/index.ts").SpaceLike) => {
		const out: unknown[] = [];
		await s.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
		await s.write({ type: "Job", fields: { n: 2 } }, null, FOREVER);
		out.push(await s.count({ type: "Job" }));
		out.push((await s.read({ type: "Job" }, 0))?.fields);
		out.push((await s.take({ type: "Job", fields: { n: 2 } }, 0))?.fields);
		out.push(await s.take({ type: "Job", fields: { n: 2 } }, 0));
		out.push(await s.takeIfExists({ type: "Nothing" }, 1_000));
		const t = await s.createTransaction(60_000);
		await s.write({ type: "Job", fields: { n: 3 } }, t.id, FOREVER);
		out.push(await s.count({ type: "Job" }));
		await s.commit(t.id);
		out.push((await s.readAll({ type: "Job" })).map((e) => e.fields));
		const l = await s.write({ type: "Temp", fields: {} }, null, 1_000);
		out.push((await s.renew(l.id, 5_000)) > l.expires);
		await s.cancel(l.id);
		out.push(await s.count({ type: "Temp" }));
		const st = await s.stats();
		out.push([st.entries, st.byType]);
		return out;
	};
	const local = await steps(new PiSpaces(await memory(), ctx, Date.now, undefined, "peer-a/w1"));
	const h = await memory();
	const remote = await steps(new RemoteSpace(inProcessTransport(service(h), { peerId: "peer-a" }), fast));
	assert.deepEqual(remote, local);
});

test("lost requests and lost answers: the retries carry the same identity, every effect happens exactly once", async () => {
	for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
		const h = await memory();
		const link = new Flaky(inProcessTransport(service(h), { peerId: "peer-a" }), seed);
		link.dropRequest = 0.25;
		link.dropAnswer = 0.25;
		const r = new RemoteSpace(link, { ...fast, attempts: 40 });
		for (let i = 0; i < 20; i++) await r.write({ type: "Job", fields: { i } }, null, FOREVER);
		assert.equal(await r.count({ type: "Job" }), 20, `seed ${seed}: every write once, none twice (${JSON.stringify(link.stats)})`);
		const got: number[] = [];
		for (let i = 0; i < 20; i++) { const e = await r.take({ type: "Job" }, 0); got.push(e!.fields.i as number); }
		assert.deepEqual([...got].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i), `seed ${seed}: each entry taken exactly once`);
		assert.equal(await r.count({ type: "Job" }), 0);
		assert.ok(link.stats.lostAnswers > 0 && link.stats.lostRequests > 0, "the link really was flaky");
	}
});

test("after the attempts are used up the caller gets OutcomeUnknown with the request; retrying that request finds the stored result", async () => {
	await forEachBackend(async (home) => {
		const h = await home.open();
		const link = new Flaky(inProcessTransport(service(h), { peerId: "peer-a" }), 9);
		const r = new RemoteSpace(link, { ...fast, attempts: 3 });
		await r.write({ type: "Job", fields: { n: 1 } }, null, FOREVER); // establishes hello and the generation
		link.dropAnswer = 1; // the host acts, but nothing ever comes back
		let unknown: OutcomeUnknown | undefined;
		try { await r.write({ type: "Job", fields: { n: 2 } }, null, FOREVER); } catch (e) { unknown = e as OutcomeUnknown; }
		assert.ok(unknown instanceof OutcomeUnknown, "not a failure: nobody knows");
		link.dropAnswer = 0;
		const view = await r.pollOperation(unknown!.request);
		assert.equal(view.state, "done", "it did happen");
		const again = await r.write({ type: "Job", fields: { n: 2 } }, null, FOREVER, { request: { principal: { peerId: "ignored" }, ...unknown!.request } });
		assert.ok(again.id, "the stored lease comes back");
		assert.equal(await r.count({ type: "Job" }), 2, "still two entries: the retry did not write again");
		await assert.rejects(r.write({ type: "Other", fields: {} }, null, FOREVER, { request: { principal: { peerId: "x" }, ...unknown!.request } }), RequestConflict);
	});
});

test("a blocked take is polled; the client's own patience ends only the waiting", async () => {
	const h = await memory();
	const sv = service(h);
	const a = new RemoteSpace(inProcessTransport(sv, { peerId: "peer-a" }), { ...fast, maxClientWaitMs: 150 });
	let unknown: OutcomeUnknown | undefined;
	const t0 = Date.now();
	try { await a.take({ type: "Late" }, 10_000); } catch (e) { unknown = e as OutcomeUnknown; }
	assert.ok(unknown instanceof OutcomeUnknown);
	assert.ok(Date.now() - t0 < 2_000, "ended by the client's patience, not by the 10 s deadline");
	assert.equal((await a.pollOperation(unknown!.request)).state, "pending", "the operation goes on");
	await new PiSpaces(h, ctx).write({ type: "Late", fields: { v: 42 } }, null, FOREVER);
	const view = await a.pollOperation(unknown!.request, 2_000);
	assert.equal(view.state, "done");
	assert.equal((view.result as { fields: { v: number } }).fields.v, 42, "the entry was not lost although nobody was waiting");
	assert.equal(await new PiSpaces(h, ctx).count({ type: "Late" }), 0);
	// a patient client simply gets it
	const patient = new RemoteSpace(inProcessTransport(sv, { peerId: "peer-a" }), fast);
	const waiting = patient.take({ type: "Soon" }, 5_000);
	setTimeout(() => void new PiSpaces(h, ctx).write({ type: "Soon", fields: { v: 1 } }, null, FOREVER), 100);
	assert.equal((await waiting)?.fields.v, 1);
});

test("cancelOperation ends a pending call for its waiter", async () => {
	const h = await memory();
	const sv = service(h);
	const a = new RemoteSpace(inProcessTransport(sv, { peerId: "peer-a" }), { ...fast, maxClientWaitMs: 100 });
	let unknown: OutcomeUnknown | undefined;
	try { await a.read({ type: "Never" }, 10_000); } catch (e) { unknown = e as OutcomeUnknown; }
	assert.equal((await a.cancelOperation(unknown!.request)).state, "cancelled");
	assert.equal((await a.pollOperation(unknown!.request)).state, "cancelled");
	void OperationCancelled;
});

test("server answers become the usual error classes; mailbox methods work and local hooks remain local", async () => {
	const h = await memory();
	const sv = service(h);
	const obs = new RemoteSpace(inProcessTransport(sv, { peerId: "peer-obs" }), fast);
	await assert.rejects(obs.write({ type: "Job", fields: {} }, null, FOREVER), core.PermissionError);
	const a = new RemoteSpace(inProcessTransport(sv, { peerId: "peer-a" }), fast);
	await assert.rejects(a.write({ type: "Job", fields: { big: "x".repeat(70_000) } }, null, FOREVER), core.ResourceExhausted);
	await assert.rejects(a.commit("t-nothing"), core.TransactionError);
	await assert.rejects(a.take({ type: "X" }, 0, { once: { get: async () => undefined, set: async () => {} } }), core.IllegalArgumentError);
	assert.ok((await a.notify({ type: "Job" }, { target: "self", lease: FOREVER })).eventId);
	assert.ok(await a.wait({ type: "Missing" }, { target: "self", timeout: 1, take: false }));
	const unknownSpace = new RemoteSpace(inProcessTransport(sv, { peerId: "peer-a" }), { ...fast, space: "nope" });
	await assert.rejects(unknownSpace.count(), (e: { code?: string }) => e.code === "UnknownSpace");
	const nobody = new RemoteSpace(inProcessTransport(sv, { peerId: "stranger" }), fast);
	await assert.rejects(nobody.count(), (e: { code?: string }) => e.code === "Unauthenticated");
});

test("the client keeps its calls inside the frame the host announced", async () => {
	const h = await memory();
	const a = new RemoteSpace(inProcessTransport(service(h), { peerId: "peer-a" }), fast);
	const lim = (await a.info()).limits.maxFrameBytes;
	await assert.rejects(a.readPage({ type: "Job", fields: { pad: "z".repeat(lim) } }), core.ResourceExhausted);
	assert.equal(await a.count({ type: "Job" }), 0, "and keeps working afterwards");
});

test("changes through the remote client: batches, long poll, and resync as SnapshotExpired", async () => {
	const h = await memory();
	const a = new RemoteSpace(inProcessTransport(service(h), { peerId: "peer-a" }), fast);
	for (let i = 0; i < 3; i++) await a.write({ type: "Job", fields: { i } }, null, FOREVER);
	const c = await a.changes(0);
	assert.equal(c.rev, c.batches.length);
	assert.equal(c.batches.filter(b => b.ops.some(o => o.op === "put")).length, 3, "three visible writes plus metadata commits");
	await assert.rejects(a.changes(0, { streamId: "other:1" }), core.SnapshotExpired);
	const late = a.changes(c.rev, { waitMs: 2_000 });
	setTimeout(() => void a.write({ type: "Job", fields: { late: 1 } }, null, FOREVER), 100);
	assert.equal((await late).batches.length, 1);
});

test("generations are renewed before they stop admitting, and a known request is answered after that", async () => {
	const h = await memory();
	await new PiSpaces(h, ctx).setLimits({ generationAdmitMs: 6_000 });
	const inner = inProcessTransport(service(h), { peerId: "peer-a" });
	const methods: string[] = [];
	const counting: Transport = { request: (text) => { methods.push(JSON.parse(text).method); return inner.request(text); } };
	let t = Date.now();
	const r = new RemoteSpace(counting, { ...fast, generationMarginMs: 5_000, now: () => t });
	await r.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
	await r.write({ type: "Job", fields: { n: 2 } }, null, FOREVER);
	assert.equal(methods.filter((m) => m === "generation").length, 1, "one generation serves the calls inside its admission time");
	t += 2_000; // less than the margin left: the next call starts under a new generation
	await r.write({ type: "Job", fields: { n: 3 } }, null, FOREVER);
	assert.equal(methods.filter((m) => m === "generation").length, 2, "renewed shortly before the admission ends");
	assert.equal(await r.count({ type: "Job" }), 3);
});
