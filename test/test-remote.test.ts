// AP 1.9: RemoteSpace over an abstract transport (federation-plan-v3.md 6.3).
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
	PhiSpaces, SpaceService, StaticIdentity, RemoteSpace, inProcessTransport, OutcomeUnknown, UnsupportedOperation, FOREVER, core, RequestConflict, OperationCancelled,
	createSpace,
	type Transport,
} from "../src/index.ts";
import { forEachBackend, ctx } from "./support/persistent.ts";
import { openTestHost } from "./support/host.ts";
import { OTHER_SERVER, underTest, type Case } from "./support/service-under-test.ts";
import type { StoreHost } from "../src/store/types.ts";

const ids = new StaticIdentity({ "peer-a": { principal: { peerId: "peer-a", agentId: "w1" }, roles: ["member"] }, "peer-obs": { principal: { peerId: "peer-obs" }, roles: ["observer"] } });
const memory = () => openTestHost(ctx);
const service = (h: StoreHost) => new SpaceService({ host: h, ctx, identity: ids });
const IDENTITIES = { "peer-a": { principal: { peerId: "peer-a", agentId: "w1" }, roles: ["member"] }, "peer-obs": { principal: { peerId: "peer-obs" }, roles: ["observer"] } };
/** The service under test (the TypeScript one, or PHI_SPACES_SERVER_CMD), closed when the test ends. */
const under = async (t: TestContext, c: Partial<Case> = {}) => { const u = await underTest({ identities: IDENTITIES, ...c }); t.after(() => u.close()); return u; };
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

test("the SpaceLike contract: the same steps give the same results locally and remotely", async (tc) => {
	const steps = async (s: import("../src/index.ts").SpaceLike) => {
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
	const local = await steps(new PhiSpaces(await memory(), ctx, Date.now, undefined, "peer-a/w1"));
	const u = await under(tc);
	const remote = await steps(new RemoteSpace(u.transport("peer-a"), fast));
	assert.deepEqual(remote, local);
});

test("lost requests and lost answers: the retries carry the same identity, every effect happens exactly once", async (tc) => {
	for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
		const u = await under(tc);
		const link = new Flaky(u.transport("peer-a"), seed);
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

test("after the attempts are used up the caller gets OutcomeUnknown with the request; retrying that request finds the stored result", async (tc) => {
	const run = async (inner: Transport) => {
		const link = new Flaky(inner, 9);
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
	};
	if (OTHER_SERVER) await run((await under(tc)).transport("peer-a"));
	else await forEachBackend(async (home) => { await run(inProcessTransport(service(await home.open()), { peerId: "peer-a" })); });
});

test("a blocked take is polled; the client's own patience ends only the waiting", async (tc) => {
	const u = await under(tc);
	const a = new RemoteSpace(u.transport("peer-a"), { ...fast, maxClientWaitMs: 150 });
	let unknown: OutcomeUnknown | undefined;
	const t0 = Date.now();
	try { await a.take({ type: "Late" }, 10_000); } catch (e) { unknown = e as OutcomeUnknown; }
	assert.ok(unknown instanceof OutcomeUnknown);
	assert.ok(Date.now() - t0 < 2_000, "ended by the client's patience, not by the 10 s deadline");
	assert.equal((await a.pollOperation(unknown!.request)).state, "pending", "the operation goes on");
	await u.local.write({ type: "Late", fields: { v: 42 } }, null, FOREVER);
	const view = await a.pollOperation(unknown!.request, 2_000);
	assert.equal(view.state, "done");
	assert.equal((view.result as { fields: { v: number } }).fields.v, 42, "the entry was not lost although nobody was waiting");
	assert.equal(await u.local.count({ type: "Late" }), 0);
	// a patient client simply gets it
	const patient = new RemoteSpace(u.transport("peer-a"), fast);
	const waiting = patient.take({ type: "Soon" }, 5_000);
	setTimeout(() => void u.local.write({ type: "Soon", fields: { v: 1 } }, null, FOREVER), 100);
	assert.equal((await waiting)?.fields.v, 1);
});

test("cancelOperation ends a pending call for its waiter", async (tc) => {
	const u = await under(tc);
	const a = new RemoteSpace(u.transport("peer-a"), { ...fast, maxClientWaitMs: 100 });
	let unknown: OutcomeUnknown | undefined;
	try { await a.read({ type: "Never" }, 10_000); } catch (e) { unknown = e as OutcomeUnknown; }
	assert.equal((await a.cancelOperation(unknown!.request)).state, "cancelled");
	assert.equal((await a.pollOperation(unknown!.request)).state, "cancelled");
	void OperationCancelled;
});

test("server answers become the usual error classes; mailbox methods work and local hooks remain local", async (tc) => {
	const u = await under(tc);
	const obs = new RemoteSpace(u.transport("peer-obs"), fast);
	await assert.rejects(obs.write({ type: "Job", fields: {} }, null, FOREVER), core.PermissionError);
	const a = new RemoteSpace(u.transport("peer-a"), fast);
	await assert.rejects(a.write({ type: "Job", fields: { big: "x".repeat(70_000) } }, null, FOREVER), core.ResourceExhausted);
	await assert.rejects(a.commit("t-nothing"), core.TransactionError);
	await assert.rejects(a.take({ type: "X" }, 0, { once: { get: async () => undefined, set: async () => {} } }), core.IllegalArgumentError);
	assert.ok((await a.notify({ type: "Job" }, { target: "self", lease: FOREVER })).eventId);
	assert.ok(await a.wait({ type: "Missing" }, { target: "self", timeout: 1, take: false }));
	const unknownSpace = new RemoteSpace(u.transport("peer-a"), { ...fast, space: "nope" });
	await assert.rejects(unknownSpace.count(), (e: { code?: string }) => e.code === "UnknownSpace");
	const nobody = new RemoteSpace(u.transport("stranger"), fast);
	await assert.rejects(nobody.count(), (e: { code?: string }) => e.code === "Unauthenticated");
});

test("the client keeps its calls inside the frame the host announced", async (tc) => {
	const u = await under(tc);
	const a = new RemoteSpace(u.transport("peer-a"), fast);
	const lim = (await a.info()).limits.maxFrameBytes;
	await assert.rejects(a.readPage({ type: "Job", fields: { pad: "z".repeat(lim) } }), core.ResourceExhausted);
	assert.equal(await a.count({ type: "Job" }), 0, "and keeps working afterwards");
});

test("changes through the remote client: batches, long poll, and resync as SnapshotExpired", async (tc) => {
	const u = await under(tc);
	const a = new RemoteSpace(u.transport("peer-a"), fast);
	for (let i = 0; i < 3; i++) await a.write({ type: "Job", fields: { i } }, null, FOREVER);
	const c = await a.changes(0);
	assert.equal(c.rev, c.batches.length);
	assert.equal(c.batches.filter(b => b.ops.some(o => o.op === "put")).length, 3, "three visible writes plus metadata commits");
	await assert.rejects(a.changes(0, { streamId: "other:1" }), core.SnapshotExpired);
	const late = a.changes(c.rev, { waitMs: 2_000 });
	setTimeout(() => void a.write({ type: "Job", fields: { late: 1 } }, null, FOREVER), 100);
	assert.equal((await late).batches.length, 1);
});

test("generations are renewed before they stop admitting, and a known request is answered after that", async (tc) => {
	const u = await under(tc);
	await u.local.setLimits({ generationAdmitMs: 6_000 });
	const inner = u.transport("peer-a");
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

test("spaces lists the host's spaces, also those created at runtime; an observer may ask, a role without it may not", async (tc) => {
	if (OTHER_SERVER) return tc.skip("createSpace at runtime is a host operation the Rust server does not have yet (R5b)");
	const h = await memory();
	const sv = service(h);
	const obs = new RemoteSpace(inProcessTransport(sv, { peerId: "peer-obs" }), fast);
	await obs.stats(); // the first hello registers the default space
	await h.commit((tx) => createSpace(tx, "chat-session-1", Date.now()), ctx);
	const listed = await obs.spaces();
	assert.deepEqual(listed.map((s) => s.alias), ["default", "chat-session-1"]);
	assert.ok(listed.every((s) => typeof s.spaceId === "string" && typeof s.createdAt === "number"));
	const viewer = new SpaceService({ host: h, ctx, identity: new StaticIdentity({ v: { principal: { peerId: "v" }, roles: ["viewer"] } }), policy: { roles: { viewer: { methods: ["hello", "stats"] } } } });
	await assert.rejects(new RemoteSpace(inProcessTransport(viewer, { peerId: "v" }), fast).spaces(), /not allowed/);
	await h.close(ctx);
});

test("batch: begin, takes, writes and commit in one call and one commit; all or nothing; a retried request runs once", async (tc) => {
	const u = await under(tc);
	const r = new RemoteSpace(u.transport("peer-a"), fast);
	await r.write({ type: "Token", fields: { c: 1 } }, null, FOREVER);
	await r.write({ type: "Intent", fields: { c: 1, line: "look" } }, null, FOREVER);
	const local = u.local;
	const rev0 = (await local.revision()).rev;
	const [t, token, intent] = await r.batch([{ op: "begin", lease: 30_000 }, { op: "take", template: { type: "Token" }, txn: "$" }, { op: "take", template: { type: "Intent", fields: { c: 1 } }, txn: "$" }]);
	assert.ok(t && "id" in t);
	assert.equal((token as unknown as { entry: { type: string } }).entry.type, "Token");
	assert.equal((intent as unknown as { entry: { fields: { line: string } } }).entry.fields.line, "look");
	assert.equal((await local.revision()).rev, rev0 + 1, "one commit for the three steps");
	const txn = (t as { id: string }).id;
	const done = await r.batch([{ op: "write", entry: { type: "Msg", fields: { text: "Du schaust." } }, txn, lease: 60_000 }, { op: "write", entry: { type: "Token", fields: { c: 1 } }, txn, lease: FOREVER }, { op: "commit", txn }]);
	assert.equal(done.length, 3);
	assert.deepEqual((await local.readAll(null)).map((e) => e.type).sort(), ["Msg", "Token"]);
	// a step that fails undoes the steps before it
	await r.write({ type: "Spot", fields: { x: 1 } }, null, FOREVER);
	await assert.rejects(r.batch([{ op: "write", entry: { type: "Note", fields: {} }, lease: FOREVER }, { op: "write", entry: { type: "Spot", fields: { x: 1 } }, lease: FOREVER, unique: ["x"] }]), /unique/);
	assert.equal(await local.count({ type: "Note" }), 0, "nothing of a failed batch stays");
	// "$" without a begin is refused
	await assert.rejects(r.batch([{ op: "take", template: { type: "Token" }, txn: "$" }]), /begin/);
	// exactly once: the same request again gives the stored answer and writes nothing more
	const wire = u.transport("peer-a");
	const g = JSON.parse(await wire.request(JSON.stringify({ method: "generation", args: {} }))).result.generation as string;
	const call = JSON.stringify({ method: "batch", args: { ops: [{ op: "write", entry: { type: "Once", fields: {} }, lease: FOREVER }] }, request: { generation: g, requestId: "b-1" } });
	const first = await wire.request(call);
	assert.equal(await wire.request(call), first);
	assert.equal(await local.count({ type: "Once" }), 1);
	// an observer may not batch
	await assert.rejects(new RemoteSpace(u.transport("peer-obs"), fast).batch([{ op: "write", entry: { type: "X", fields: {} } }]), /not allowed/);
});

test("transient writes: announced in the change stream (a put marked transient), never kept; under a transaction at its commit only", async (tc) => {
	const u = await under(tc);
	const r = new RemoteSpace(u.transport("peer-a"), fast);
	const local = u.local;
	const ops = async (after: number) => (await local.changes(after)).batches.flatMap((b) => b.ops.map((o) => o.op === "put" ? `put ${o.type}${o.transient ? " transient" : ""}` : "del"));
	const r0 = (await local.revision()).rev;
	await r.write({ type: "Msg", fields: { text: "hallo" } }, null, FOREVER, { transient: true });
	assert.deepEqual(await ops(r0), ["put Msg transient"]);
	assert.equal(await local.count({ type: "Msg" }), 0, "nothing is kept");
	const t = await r.createTransaction(30_000);
	const r1 = (await local.revision()).rev;
	await r.write({ type: "Msg", fields: { text: "später" } }, t.id, FOREVER, { transient: true });
	assert.deepEqual(await ops(r1), [], "not before the commit");
	await r.commit(t.id);
	assert.deepEqual(await ops(r1), ["put Msg transient"]);
	const t2 = await r.createTransaction(30_000);
	const r2 = (await local.revision()).rev;
	await r.batch([{ op: "write", entry: { type: "Msg", fields: { text: "nie" } }, txn: t2.id, transient: true }, { op: "abort", txn: t2.id }]);
	assert.deepEqual(await ops(r2), [], "an abort announces nothing");
	await assert.rejects(r.write({ type: "Msg", fields: {} }, null, FOREVER, { transient: true, unique: ["x"] }), /transient/);
});
