// AP 1.5: RPC claims and request generations (federation-plan-v3.md 6.2, 11 stage 1, 12.1 rows "1").
import test from "node:test";
import assert from "node:assert/strict";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	PhiSpaces, FOREVER, Space, core, claims, RequestConflict, RequestExpired, ResultExpired, IncarnationChanged, OperationCancelled,
	type Principal, type RequestRef,
} from "../src/index.ts";
import { forEachBackend, InjectedFault, ctx } from "./support/persistent.ts";
import { openTestHost } from "./support/host.ts";
import type { StoreHost } from "../src/store/types.ts";

const memory = () => openTestHost(ctx);
const alice: Principal = { peerId: "peer-a", agentId: "worker-1" };
class Clock { t = 1_000_000; now = () => this.t; }
const client = (h: StoreHost, c: Clock) => new PhiSpaces(h, ctx, c.now);
const req = (generation: string, requestId: string, principal = alice): RequestRef => ({ principal, generation, requestId });
const tick = () => new Promise((r) => setTimeout(r, 30));

test("take with lost answer: the retry returns the stored result after reopen, no second take, no plaintext args", async () => {
	await forEachBackend(async (home) => {
		let h = await home.open();
		const s = new PhiSpaces(h, ctx);
		await s.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
		await s.write({ type: "Job", fields: { n: 2 } }, null, FOREVER);
		const { generation } = await s.issueGeneration(alice);
		const r = req(generation, "take-1");
		const tmpl = { type: "Job", fields: { secretMarker: null } };
		home.faults.arm("loseAnswer");
		await assert.rejects(s.take(tmpl, 0, { request: r }), InjectedFault);
		home.crash(h);
		h = await home.open();
		const again = new PhiSpaces(h, ctx);
		assert.equal(home.faults.fired, 1);
		assert.equal((await again.pollOperation(r)).state, "done", "the deciding commit was durable; only its answer was lost");
		const got = await again.take(tmpl, 0, { request: r });
		assert.equal(got?.fields.n, 1);
		assert.equal(await again.count({ type: "Job" }), 1, "exactly one take");
		assert.deepEqual(await again.pollOperation(r), { state: "done", deadline: (await again.pollOperation(r)).deadline, method: "take", result: got });
		const stored = JSON.stringify((await h.snapshot(Space, ctx))!.rpc);
		assert.ok(!stored.includes("secretMarker"), "claims keep a hash of the arguments, not the arguments");
	});
});

test("immediate mutations: write and txn begin replay their stored result, also after a lost answer", async () => {
	await forEachBackend(async (home) => {
		let h = await home.open();
		const s = new PhiSpaces(h, ctx);
		const { generation } = await s.issueGeneration(alice);
		home.faults.arm("loseAnswer");
		await assert.rejects(s.write({ type: "J", fields: {} }, null, FOREVER, { request: req(generation, "w") }), InjectedFault);
		home.crash(h);
		h = await home.open();
		const s2 = new PhiSpaces(h, ctx);
		const l1 = await s2.write({ type: "J", fields: {} }, null, FOREVER, { request: req(generation, "w") });
		const l2 = await s2.write({ type: "J", fields: {} }, null, FOREVER, { request: req(generation, "w") });
		assert.deepEqual(l1, l2);
		assert.equal(await s2.count({ type: "J" }), 1);
		const t1 = await s2.createTransaction(10_000, { request: req(generation, "t") });
		const t2 = await s2.createTransaction(10_000, { request: req(generation, "t") });
		assert.equal(t1.id, t2.id);
		await s2.commit(t1.id, { request: req(generation, "c") });
		await s2.commit(t1.id, { request: req(generation, "c") }); // a replay, not a second commit of a gone txn
	});
});

test("same request id with different arguments or method is a RequestConflict", async () => {
	const h = await memory();
	try {
		const c = new Clock(), s = client(h, c);
		const { generation } = await s.issueGeneration(alice);
		await s.write({ type: "A", fields: { v: 1 } }, null, FOREVER, { request: req(generation, "x") });
		await assert.rejects(s.write({ type: "A", fields: { v: 2 } }, null, FOREVER, { request: req(generation, "x") }), RequestConflict);
		await assert.rejects(s.take({ type: "A" }, 0, { request: req(generation, "x") }), RequestConflict);
		const bob = { peerId: "peer-b" };
		await assert.rejects(s.write({ type: "A", fields: {} }, null, FOREVER, { request: req(generation, "y", bob) }), RequestExpired, "a generation belongs to one principal");
	} finally { await h.close(ctx); }
});

test("a pending request outlives its generation's admission; new ids in that generation are rejected", async () => {
	const h = await memory();
	try {
		const c = new Clock(), s = client(h, c);
		await s.setLimits({ generationAdmitMs: 50 });
		const { generation } = await s.issueGeneration(alice);
		const r = req(generation, "wait-for-job");
		const pending = s.take({ type: "Job" }, FOREVER, { request: r });
		await tick();
		assert.equal((await s.pollOperation(r)).state, "pending");
		c.t += 10_000; // admission over
		await assert.rejects(s.write({ type: "X", fields: {} }, null, FOREVER, { request: req(generation, "new-id") }), RequestExpired);
		await s.write({ type: "Job", fields: { n: 7 } }, null, FOREVER);
		assert.equal((await pending)?.fields.n, 7, "the known request continued and was decided");
		assert.equal((await s.take({ type: "Job" }, FOREVER, { request: r }))?.fields.n, 7, "retry after the generation closed returns the result");
		await assert.rejects(s.take({ type: "Job" }, 0, { request: r }), RequestConflict, "a retry must repeat the arguments");
		assert.equal((await s.pollOperation(r)).state, "done");
	} finally { await h.close(ctx); }
});

test("the deadline is fixed by the first accepted call, not by a retry", async () => {
	const h = await memory();
	try {
		const c = new Clock(), s = client(h, c);
		const { generation } = await s.issueGeneration(alice);
		const r = req(generation, "short");
		const first = s.take({ type: "Job" }, 100, { request: r });
		await tick();
		const dl = (await s.pollOperation(r)).deadline;
		assert.equal(dl, c.t + 100);
		c.t += 60;
		const second = client(h, c).take({ type: "Job" }, 100, { request: r }); // same arguments, later
		await tick();
		assert.equal((await s.pollOperation(r)).deadline, dl);
		c.t += 41;
		await s.write({ type: "Other", fields: {} }); // wakes both
		assert.equal(await first, null);
		assert.equal(await second, null);
		assert.deepEqual(await s.pollOperation(r), { state: "done", deadline: dl, method: "take", result: null });
	} finally { await h.close(ctx); }
});

test("results are kept from their decision; then ResultExpired; after admission and retention RequestExpired", async () => {
	const h = await memory();
	try {
		const c = new Clock(), s = client(h, c);
		await s.setLimits({ claimResultMs: 1000, generationAdmitMs: 5000 });
		const { generation } = await s.issueGeneration(alice);
		const r = req(generation, "late");
		const p = s.take({ type: "Job" }, FOREVER, { request: r });
		await tick();
		c.t += 3000; // pending longer than the retention: that does not count
		await s.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
		assert.equal((await p)?.fields.n, 1);
		c.t += 900;
		assert.equal((await s.take({ type: "Job" }, FOREVER, { request: r }))?.fields.n, 1, "retention counts from the decision");
		c.t += 200;
		await assert.rejects(s.take({ type: "Job" }, FOREVER, { request: r }), ResultExpired);
		assert.equal((await s.pollOperation(r)).resultExpired, true);
		c.t += 10_000; // admission and retention over: the claim goes
		await assert.rejects(s.take({ type: "Job" }, FOREVER, { request: r }), RequestExpired);
		assert.equal(await s.count({ type: "Job" }), 0, "never a second take");
	} finally { await h.close(ctx); }
});

test("cancelOperation ends a pending take; a decided request stays decided", async () => {
	const h = await memory();
	try {
		const c = new Clock(), s = client(h, c);
		const { generation } = await s.issueGeneration(alice);
		const r = req(generation, "cancel-me");
		const blocked = s.take({ type: "Job" }, FOREVER, { request: r });
		await tick();
		assert.equal((await client(h, c).cancelOperation(r, { request: req(generation, "the-cancel") })).state, "cancelled");
		await assert.rejects(blocked, OperationCancelled);
		await s.write({ type: "Job", fields: {} }, null, FOREVER);
		await assert.rejects(s.take({ type: "Job" }, FOREVER, { request: r }), OperationCancelled);
		assert.equal(await s.count({ type: "Job" }), 1, "a cancelled take takes nothing");
		const d = req(generation, "decided");
		await s.take({ type: "Job" }, 0, { request: d });
		assert.equal((await s.cancelOperation(d)).state, "done");
		await assert.rejects(s.pollOperation(req(generation, "never-seen")), RequestExpired);
	} finally { await h.close(ctx); }
});

test("a generation of an earlier incarnation admits no new ids (IncarnationChanged)", async () => {
	const h = await memory();
	try {
		const c = new Clock(), s = client(h, c);
		const { generation } = await s.issueGeneration(alice);
		await s.write({ type: "A", fields: {} }, null, FOREVER, { request: req(generation, "before") });
		await h.commit(async (tx) => { (await tx.doc(Space)).incarnation = "restored"; }, ctx); // what a restore does
		await assert.rejects(s.write({ type: "A", fields: {} }, null, FOREVER, { request: req(generation, "after") }), IncarnationChanged);
		assert.equal((await s.pollOperation(req(generation, "before"))).state, "done", "known results stay readable");
	} finally { await h.close(ctx); }
});

test("claims and generations survive the v4 -> v5 migration path", () => {
	const m = core.migrate({ entries: [], spaceId: "sp-1", incarnation: "abcd0123", rpc: { generations: { g1: {} }, claims: {} } }, 4);
	assert.equal(m.spaceId, "sp-1");
	assert.equal(m.incarnation, "abcd0123");
	assert.ok(m.rpc?.generations.g1);
});

test('current-epoch miss survives reopen and late original/retry commit exactly once',async()=>{
 await forEachBackend(async home=>{let h=await home.open();const c=new Clock();let s=client(h,c);const {generation}=await s.issueGeneration(alice),r=req(generation,'late-original'),entry={type:'Job',fields:{n:1}},hash=claims.argHash('write',{entry,txn:null,lease:FOREVER});
 const before=await h.snapshot(Space,ctx);const proof=await s.resolveOperation(r,'write',hash,1);assert.equal(proof.state,'notAdmitted');assert.deepEqual(await h.snapshot(Space,ctx),before);assert.equal(await s.count(),0);
 home.crash(h);h=await home.open();s=client(h,c);assert.equal((await s.resolveOperation(r,'write',hash,1)).state,'notAdmitted');
 await Promise.all([s.write(entry,null,FOREVER,{request:r}),s.write(entry,null,FOREVER,{request:r})]);assert.equal(await s.count(),1);assert.equal((await s.resolveOperation(r,'write',hash,1)).state,'done');
 await assert.rejects(s.resolveOperation(r,'take',hash,1),RequestConflict);await assert.rejects(s.resolveOperation(r,'write','0'.repeat(64),1),RequestConflict);
 home.crash(h);h=await home.open();s=client(h,c);await s.write(entry,null,FOREVER,{request:r});assert.equal(await s.count(),1);
 });
});
test('missing-request proof rejects expired, forged, foreign, promoted and restored generations',async()=>{
 await forEachBackend(async home=>{const h=await home.open(),c=new Clock(),s=client(h,c),g=await s.issueGeneration(alice),r=req(g.generation,'absent'),hash=claims.argHash('write',{entry:{type:'Job',fields:{}},txn:null,lease:FOREVER});
 await assert.rejects(s.resolveOperation({...r,principal:{peerId:'other'}},'write',hash,1),RequestExpired);
 await assert.rejects(s.resolveOperation({...r,generation:r.generation+'forged'},'write',hash,1),RequestExpired);
 await assert.rejects(s.resolveOperation(r,'write',hash,2),IncarnationChanged);
 await h.commit(async tx=>{(await tx.doc(Space)).primaryEpoch=2;},ctx);await assert.rejects(s.resolveOperation(r,'write',hash,1),IncarnationChanged);
 await h.commit(async tx=>{(await tx.doc(Space)).primaryEpoch=1;(await tx.doc(Space)).invalidGenerations={[r.generation]:true};},ctx);await assert.rejects(s.resolveOperation(r,'write',hash,1),IncarnationChanged);
 await h.commit(async tx=>{delete (await tx.doc(Space)).invalidGenerations;},ctx);c.t=g.admitUntil+1;await assert.rejects(s.resolveOperation(r,'write',hash,1),RequestExpired);assert.equal(await s.count(),0);
 });
});

test('resolution of an existing pending claim still settles its deadline outside the proof commit',async()=>{
 await forEachBackend(async home=>{const h=await home.open(),c=new Clock(),s=client(h,c),{generation}=await s.issueGeneration(alice),r=req(generation,'deadline-take'),tmpl={type:'Job'},hash=claims.argHash('take',{tmpl,timeout:1000,deadline:null,txn:null});
 const pending=s.take(tmpl,1000,{request:r});await tick();assert.equal((await s.resolveOperation(r,'take',hash,1)).state,'pending');c.t+=1001;
 const view=await s.resolveOperation(r,'take',hash,1);assert.equal(view.state,'done');assert.equal('result' in view?view.result:undefined,null);assert.equal(await pending,null);
 });
});

test('legacy signed generations still replay known claims but never prove a missing request',async()=>{
 const {createHmac}=await import('node:crypto');
 await forEachBackend(async home=>{const h=await home.open(),c=new Clock(),s=client(h,c),{generation}=await s.issueGeneration(alice);
 const legacy=await h.commit(async tx=>{const state=await tx.doc(Space),st=state.rpc!,record={...st.generations[generation]!};delete record.primaryEpoch;const nonce=generation.split('.')[0]!,input={nonce,...record},keys=[...new Set([...Object.keys(input),'agentId','peerId'])].sort(),signed=nonce+'.'+createHmac('sha256',st.signingKey!).update(JSON.stringify(input,keys)).digest('hex');delete st.generations[generation];st.generations[signed]=record;delete st.bytes;return signed;},ctx);
 const r=req(legacy,'legacy'),entry={type:'Job',fields:{n:1}},hash=claims.argHash('write',{entry,txn:null,lease:FOREVER});
 await assert.rejects(s.resolveOperation(r,'write',hash,1),IncarnationChanged);await s.write(entry,null,FOREVER,{request:r});
 assert.equal((await s.resolveOperation(r,'write',hash,1)).state,'done');home.crash(h);const reopened=await home.open(),again=client(reopened,c);await again.write(entry,null,FOREVER,{request:r});assert.equal(await again.count(),1);
 });
});

test("the sweep looks at the claims only when one can be due, and still drops each one on time", () => {
	const s = core.initialState(), t0 = 1_000_000, keep = core.limitsOf(s).claimResultMs;
	const { generation } = claims.issueGeneration(s, t0, alice);
	const done = (requestId: string, at: number) => { const a = claims.admit(s, at, { generation, requestId, principal: alice }, "write", {}, at + 60_000); claims.decide(s, at, a.key, { state: "done", result: { ok: true } }); return a.key; };
	const first = done("r1", t0);
	claims.sweep(s, t0 + 1);
	const at = s.rpc!.sweepAt!;
	assert.equal(at, Math.min(t0 + keep, t0 + core.limitsOf(s).generationAdmitMs + 1)); // the first claim's result, or its generation
	// nothing can be due before then: a sweep in between changes nothing (and scans nothing)
	claims.sweep(s, at - 1);
	assert.equal(s.rpc!.claims[first]!.resultExpired, undefined);
	// a decision that comes due earlier lowers the mark; a shorter retention makes the next sweep scan everything
	core.setLimits(s, { claimResultMs: 1000 }, t0 + 2);
	assert.equal(s.rpc!.sweepAt, undefined);
	const second = done("r2", t0 + 3);
	claims.sweep(s, t0 + 1003);
	assert.equal(s.rpc!.claims[first]!.resultExpired, true); // both are now past the shorter retention
	assert.equal(s.rpc!.claims[second]!.resultExpired, true);
	assert.equal(claims.lookup(s, { generation, requestId: "r1", principal: alice }, t0 + 1003).resultExpired, true);
	// once their generation stops admitting, the claims and the generation go
	const end = t0 + core.limitsOf(s).generationAdmitMs + 2;
	claims.sweep(s, end);
	assert.equal(Object.keys(s.rpc!.claims).length, 0);
	assert.equal(Object.keys(s.rpc!.generations).length, 0);
	assert.equal(s.rpc!.sweepAt, Number.MAX_SAFE_INTEGER); // nothing left that could become due
});

test("a generation that stopped admitting but still has claims makes no sweep due (it goes with its last claim)", () => {
	const s = core.initialState(), t0 = 1_000_000, keep = core.limitsOf(s).claimResultMs, admit = core.limitsOf(s).generationAdmitMs;
	const { generation } = claims.issueGeneration(s, t0, alice);
	const a = claims.admit(s, t0 + 10, { generation, requestId: "r1", principal: alice }, "write", {}, t0 + 60_000);
	claims.decide(s, t0 + 10, a.key, { state: "done", result: null });
	claims.sweep(s, t0 + admit + 5); // the generation is closed, the result is kept for a day
	assert.equal(s.rpc!.sweepAt, t0 + 10 + keep, "the next sweep is when the claim's result expires, not at every operation");
	claims.sweep(s, t0 + 10 + keep);
	assert.equal(Object.keys(s.rpc!.claims).length, 0);
	assert.equal(Object.keys(s.rpc!.generations).length, 0, "the generation went with its last claim");
});

test("after a pause, more due claims than one sweep takes are dropped in steps while the client keeps working", async () => {
	const h = await memory();
	try {
		const c = new Clock(), s = client(h, c);
		await s.setLimits({ claimResultMs: 1000, generationAdmitMs: 500 });
		const { generation } = await s.issueGeneration(alice);
		for (let i = 0; i < 600; i++) await s.write({ type: "Job", fields: { i } }, null, FOREVER, { request: req(generation, `w${i}`) });
		c.t += 10_000; // all 600 are due at once; a sweep takes 256
		await s.write({ type: "Job", fields: { i: -1 } }, null, FOREVER); // maintenance goes on until done, it does not give up
		for (const i of [0, 299, 599]) await assert.rejects(s.pollOperation(req(generation, `w${i}`)), RequestExpired);
		assert.equal(await s.count({ type: "Job" }), 601);
	} finally { await h.close(ctx); }
});
