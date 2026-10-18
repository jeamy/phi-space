// Regression/acceptance cases for the AP 1.1–1.9 audit, on real persistent backends.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineDoc } from "@earendil-works/pi-durable";
import { PhiSpaces, SpaceService, StaticIdentity, RemoteSpace, OutcomeUnknown, ResultExpired, CompletionViolation, core, claims, spaceDoc, createSpace, serveSpace, inProcessTransport, type Reply } from "../src/index.ts";
import { forEachBackend, ctx } from "./support/persistent.ts";
import { mailboxPage, ackMailbox, appendMail, MailboxEpochMismatch, InvalidAck } from "../src/mailbox.ts";
import { prepareSieveRun, processSieveTask, collectSieveResults } from "../examples/sieve.ts";

const ids = new StaticIdentity({ a: { principal: { peerId: "a" }, roles: ["member"] }, b: { principal: { peerId: "b" }, roles: ["member"] } });
const ok = (r: Reply): any => { assert.ok(r.ok, JSON.stringify(r)); return (r as { ok: true; result: any }).result; };
const clock = () => { let at = 1_000_000; return { now: () => at, advance: (n: number) => { at += n; } }; };
const service = (h: any, now = Date.now, options = {}) => new SpaceService({ host: h, ctx, identity: ids, now, ...options });

test("AP1 a persisted v4 singleton migrates to v5 without copying or changing old ids and ownership", async () => {
	const fixture = JSON.parse(readFileSync(new URL("./fixtures/space-v4.json", import.meta.url), "utf8"));
	const legacy = defineDoc<core.SpaceState & Record<string, any>>({ kind: "pi-spaces.space", version: 4, scope: "session", initial: () => structuredClone(fixture) });
	await forEachBackend(async home => {
		let h = await home.open(); await h.commit(async tx => { const s = await tx.doc(legacy); s.returned = 1; }, ctx); await home.close(h);
		h = await home.open(); const local = new PhiSpaces(h, ctx);
		await local.write({ type: "New", fields: {} }, null, core.FOREVER);
		const old = await local.read({ type: "Old" }, 0); assert.equal(old?.id, "e40"); assert.ok(old?.gid?.endsWith("/e40"));
		assert.equal(await local.count({ type: "Hidden" }), 0);
		const owner = new PhiSpaces(h, ctx, Date.now, undefined, 5); assert.equal(await owner.count({ type: "Hidden" }, "t31"), 1); await owner.abort("t31");
		assert.equal(await local.count({ type: "Hidden" }), 0); assert.equal(await local.count({ type: "Old" }), 1); assert.equal(await local.count({ type: "New" }), 1);
		await home.close(h); h = await home.open(); const again = new PhiSpaces(h, ctx); assert.equal((await again.read({ type: "Old" }, 0))?.gid, old?.gid);
	});
});

test("AP1 pending replays validate method/template/space, and acceptance is already durable", async () => {
	await forEachBackend(async home => {
		let h = await home.open(), c = clock(), s = service(h, c.now, { maxPendingPerPrincipal: 1 });
		const generation = ok(await s.handle({ method: "generation" }, { peerId: "a" })).generation;
		const request = { generation, requestId: "blocked" };
		const args = { template: { type: "Job" }, timeoutMs: 1000, waitMs: 0 };
		const first = ok(await s.handle({ method: "take", request, args }, { peerId: "a" }));
		assert.equal(first.state, "pending"); assert.equal(first.deadline, c.now() + 1000);
		for (const call of [{ method: "read", request, args }, { method: "take", request, args: { ...args, template: { type: "Other" } } }]) {
			const r = await s.handle(call, { peerId: "a" }); assert.ok(!r.ok && r.error.code === "RequestConflict");
		}
		await h.commit(tx => createSpace(tx, "other", c.now()), ctx);
		const foreign = await s.handle({ method: "take", space: "other", request, args }, { peerId: "a" }); assert.ok(!foreign.ok && foreign.error.code === "RequestExpired");
		home.crash(h); h = await home.open(); s = service(h, c.now, { maxPendingPerPrincipal: 1 });
		assert.equal(ok(await s.handle({ method: "take", request, args }, { peerId: "a" })).state, "pending", "known retry is admitted even at the pending quota");
		const writer = new PhiSpaces(h, ctx, c.now); await writer.write({ type: "Job", fields: { n: 7 } }, null, core.FOREVER);
		const result = ok(await s.handle({ method: "pollOperation", args: { targetRequest: request } }, { peerId: "a" }));
		assert.equal(result.state, "done"); assert.equal(result.result.fields.n, 7); assert.equal(await writer.count({ type: "Job" }), 0);
	});
});

test("AP1 a reopened pending request reaches its fixed deadline without its original caller", async () => {
	await forEachBackend(async home => {
		let h = await home.open(); const c = clock(); let s = service(h, c.now);
		const generation = ok(await s.handle({ method: "generation" }, { peerId: "a" })).generation;
		const request = { generation, requestId: "timeout" };
		ok(await s.handle({ method: "take", request, args: { template: { type: "Job" }, timeoutMs: 100, waitMs: 0 } }, { peerId: "a" }));
		home.crash(h); h = await home.open(); s = service(h, c.now); c.advance(101);
		const p = ok(await s.handle({ method: "pollOperation", args: { targetRequest: request } }, { peerId: "a" }));
		assert.equal(p.state, "done"); assert.equal(p.result, null);
		const local = new PhiSpaces(h, ctx, c.now); await local.write({ type: "Job", fields: {} }, null, core.FOREVER);
		assert.equal(await local.count({ type: "Job" }), 1, "the expired take never consumes a later entry");
	});
});

test("AP1 snapshots keep five 64KiB entries at one revision during writes and expire explicitly", async () => {
	await forEachBackend(async home => {
		const h = await home.open(), c = clock(), local = new PhiSpaces(h, ctx, c.now);
		for (let i = 0; i < 5; i++) await local.write({ type: "Large", fields: { i, pad: "x".repeat(65_490) } }, null, core.FOREVER);
		const first = await local.readPage({ type: "Large" }, { maxBytes: 140_000 });
		assert.ok(first.token && first.next);
		first.items[0]!.fields.i = -1;
		const replayedFirst = await local.readPage({ type: "Large" }, { token: first.token, maxBytes: 140_000 });
		assert.equal(replayedFirst.items[0]!.fields.i, 0, "mutating a returned local page cannot alter the retained snapshot");
		first.items = replayedFirst.items;
		await local.take({ type: "Large", fields: { i: 4 } }, 0);
		await local.write({ type: "Large", fields: { i: 99 } }, null, core.FOREVER);
		const all = [...first.items]; let after: string | null = first.next;
		while (after) { const p = await local.readPage({ type: "Large" }, { after, maxBytes: 140_000 }); assert.equal(p.token, first.token); assert.equal(p.rev, first.rev); assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 140_000); all.push(...p.items); after = p.next; }
		assert.deepEqual(all.map(e => e.fields.i), [0, 1, 2, 3, 4]);
		assert.equal(new Set(all.map(e => e.id)).size, 5);
		const b = new PhiSpaces(h, ctx, c.now, undefined, "b"); await assert.rejects(b.readPage({ type: "Large" }, { after: first.next }), core.PermissionError);
		c.advance(60_001); await assert.rejects(local.readPage({ type: "Large" }, { after: first.next }), core.SnapshotExpired);
	});
});

test("AP1 one Tx has one revision even when the document is fetched twice; oversize compound writes roll back", async () => {
	await forEachBackend(async home => {
		const h = await home.open(), local = new PhiSpaces(h, ctx);
		await h.commit(async tx => { core.write(await spaceDoc(tx, undefined, 1), 1, { type: "Pair", fields: { n: 1 } }, null, core.FOREVER); core.write(await spaceDoc(tx, undefined, 1), 1, { type: "Pair", fields: { n: 2 } }, null, core.FOREVER); }, ctx);
		const changes = await local.changes(0); assert.equal(changes.rev, 1); assert.equal(changes.batches.length, 1); assert.equal(changes.batches[0]!.ops.length, 2);
		await local.setLimits({ maxCommitBytes: 3000 });
		await assert.rejects(h.commit(async tx => { const s = await spaceDoc(tx, undefined, 1); for (let i = 0; i < 3; i++) core.write(s, 1, { type: "Oversize", fields: { pad: "x".repeat(600) } }, null, core.FOREVER); }, ctx), core.ResourceExhausted);
		assert.equal(await local.count({ type: "Oversize" }), 0); assert.equal((await local.changes(0)).rev, 2);
	});
});

test("AP1 late subscriptions preserve reservations, and a foreign transaction cannot be counted", async () => {
	await forEachBackend(async home => {
		const h = await home.open(), s = service(h), local = new PhiSpaces(h, ctx);
		await local.setLimits({ maxCommitBytes: 3000 });
		const a = new RemoteSpace(inProcessTransport(s, { peerId: "a" })); const b = new RemoteSpace(inProcessTransport(s, { peerId: "b" }));
		const t = await a.createTransaction(60000); await a.write({ type: "Private", fields: { pad: "x".repeat(1300) } }, t.id, core.FOREVER);
		await assert.rejects(b.count({ type: "Private" }, t.id), core.PermissionError);
		await assert.rejects(local.notify({ type: "Private" }, { target: "listener", lease: core.FOREVER }), core.ResourceExhausted);
		await a.commit(t.id); assert.equal(await a.count({ type: "Private" }), 1);
	});
});

test("AP1 bounded settle resumes expired transactions from durable state, all batches fit", async () => {
	await forEachBackend(async home => {
		let h = await home.open(); const c = clock(); let local = new PhiSpaces(h, ctx, c.now);
		await local.setLimits({ maxCommitBytes: 3000 });
		for (let i = 0; i < 8; i++) await local.write({ type: "Return", fields: { i, pad: "x".repeat(700) } }, null, core.FOREVER);
		for (let i = 0; i < 8; i++) { const t = await local.createTransaction(100); await local.take({ type: "Return", fields: { i } }, 0, { txn: t.id }); }
		const before = (await local.changes(0)).rev; c.advance(101);
		await h.commit(async tx => core.settle(await spaceDoc(tx, undefined, c.now()), c.now()), ctx);
		assert.ok(Object.keys((await h.snapshot((await import("../src/doc.ts")).Space, ctx))!.txns).length > 0, "cleanup uses more than one commit");
		home.crash(h); h = await home.open(); local = new PhiSpaces(h, ctx, c.now);
		await local.write({ type: "Wake", fields: {} }, null, core.FOREVER);
		assert.equal(await local.count({ type: "Return" }), 8);
		for (const batch of (await local.changes(before)).batches) assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 3000);
	});
});

test("AP1 mailbox byte pages, prefix ACK, TTL gap/new epoch and old ACK isolation", () => {
	const s = core.initialState(), p = { peerId: "a", agentId: "one" };
	for (let i = 0; i < 6; i++) appendMail(s, p, { kind: "entry", eventId: `n${i}`, seq: i + 1, target: "a", handback: { pad: "x".repeat(200) } }, 1);
	assert.throws(() => mailboxPage(s, p, 1, { maxBytes: 20 }), core.ResponseBudgetTooSmall);
	let page = mailboxPage(s, p, 1, { maxBytes: 800 }); const epoch = page.mailboxEpoch;
	assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 800);
	assert.throws(() => ackMailbox(s, p, epoch, 6), InvalidAck, "undelivered items cannot be ACKed");
	assert.throws(() => mailboxPage(s, p, 1, { after: 6 }), core.IllegalArgumentError, "an undelivered cursor cannot skip messages");
	const seq = [...page.events.map(e => e.seq)];
	while (page.more) { page = mailboxPage(s, p, 1, { mailboxEpoch: epoch, after: page.next, maxBytes: 800 }); seq.push(...page.events.map(e => e.seq)); }
	assert.deepEqual(seq, [1, 2, 3, 4, 5, 6]);
	assert.equal(ackMailbox(s, p, epoch, 3).acked, 3); assert.equal(ackMailbox(s, p, epoch, 3).acked, 3);
	core.setLimits(s, { mailboxTtlMs: 100 });
	const expired = mailboxPage(s, p, 102, { mailboxEpoch: epoch, after: 3 }); assert.ok(expired.gap); assert.notEqual(expired.mailboxEpoch, epoch);
	appendMail(s, p, { kind: "entry", eventId: "fresh", seq: 7, target: "a", handback: null }, 103);
	assert.throws(() => ackMailbox(s, p, epoch, 6), MailboxEpochMismatch);
	assert.equal(mailboxPage(s, p, 103, { mailboxEpoch: expired.mailboxEpoch }).events[0]!.event.eventId, "fresh");
});

test("AP1 remote wait/notify use their own mailbox; ACK does not commit a take; closure persists", async () => {
	await forEachBackend(async home => {
		let h = await home.open(), s = service(h); let a = new RemoteSpace(inProcessTransport(s, { peerId: "a" }));
		const n = await a.notify({ type: "News" }, { target: "self", lease: core.FOREVER });
		await a.wait({ type: "Job" }, { target: "self", timeout: 60000, take: true, txnLeaseMs: 60000 });
		const local = new PhiSpaces(h, ctx); await local.write({ type: "News", fields: { n: 1 } }, null, core.FOREVER); await local.write({ type: "Job", fields: { n: 2 } }, null, core.FOREVER);
		home.crash(h); h = await home.open(); s = service(h); a = new RemoteSpace(inProcessTransport(s, { peerId: "a" }));
		const p = await a.events(); assert.equal(p.events.length, 2); const task = p.events.find(e => e.event.kind === "waiter")!.event;
		await a.ack(p.mailboxEpoch, p.next); assert.equal((await a.stats()).locked, 1, "delivery ACK leaves the take transaction open");
		await a.abort(task.txn!); assert.equal(await a.count({ type: "Job" }), 1);
		await a.cancel(n.lease.id); const closed = await a.events({ mailboxEpoch: p.mailboxEpoch, after: p.next }); assert.equal(closed.events[0]!.event.kind, "registrationClosed");
		const b = new RemoteSpace(inProcessTransport(s, { peerId: "b" })); assert.equal((await b.events()).events.length, 0);
	});
});

test("AP1 generation signatures and principal/space/incarnation binding survive reopen", async () => {
	await forEachBackend(async home => {
		let h = await home.open(); let local = new PhiSpaces(h, ctx);
		const p = { peerId: "a" }, g = await local.issueGeneration(p); assert.match(g.generation, /^g[0-9a-f]{32}\.[0-9a-f]{64}$/);
		home.crash(h); h = await home.open(); local = new PhiSpaces(h, ctx);
		await local.write({ type: "Signed", fields: {} }, null, core.FOREVER, { request: { principal: p, generation: g.generation, requestId: "first" } });
		await assert.rejects(local.write({ type: "Signed", fields: {} }, null, core.FOREVER, { request: { principal: p, generation: g.generation.slice(0, -1) + (g.generation.endsWith("0") ? "1" : "0"), requestId: "forged" } }), claims.RequestExpired);
	});
});

test("AP1 RemoteSpace reports expired results and respects client patience during a hanging transport", async () => {
	const hello = { principal: "a", limits: { maxFrameBytes: 262144 } };
	const expired = new RemoteSpace({ request: async text => { const c = JSON.parse(text); return JSON.stringify({ ok: true, result: c.method === "hello" ? hello : c.method === "generation" ? { generation: "g", admitUntil: Date.now() + 60000 } : c.method === "take" ? { state: "pending" } : { state: "done", resultExpired: true, method: "take", deadline: 1 } }); } });
	await assert.rejects(expired.take(null, 0), ResultExpired);
	const hanging = new RemoteSpace({ request: async text => { const c = JSON.parse(text); if (c.method === "take") return new Promise<string>(() => {}); return JSON.stringify({ ok: true, result: c.method === "hello" ? hello : { generation: "g", admitUntil: Date.now() + 60000 } }); } }, { maxClientWaitMs: 20, callTimeoutMs: 1000, attempts: 5 });
	await hanging.info(); const start = Date.now(); await assert.rejects(hanging.take(null, 0), OutcomeUnknown); assert.ok(Date.now() - start < 150, "the client deadline cuts off transport waits and retries");
});

test("AP1 socket refuses regular files and active listeners; responses fit the configured frame", async () => {
	const dir = mkdtempSync("/tmp/phi-spaces-safe-socket-");
	try {
		const path = join(dir, "socket"); writeFileSync(path, "keep");
		await assert.rejects(serveSpace({ handleText: async () => "{}" }, { listen: { path } })); assert.equal(readFileSync(path, "utf8"), "keep");
		rmSync(path); const server = await serveSpace({ handleText: async () => "{}" }, { listen: { path } });
		try { await assert.rejects(serveSpace({ handleText: async () => "{}" }, { listen: { path } })); } finally { await server.close(); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
	await forEachBackend(async home => {
		const h = await home.open(), s = service(h); await new PhiSpaces(h, ctx).write({ type: "Budget", fields: { pad: "x".repeat(100) } }, null, core.FOREVER);
		const r = await s.handleText(JSON.stringify({ method: "readAll", args: { template: { type: "Budget" }, maxBytes: 324 } }), { peerId: "a" }, 324);
		assert.ok(Buffer.byteLength(r) <= 324); assert.equal(JSON.parse(r).ok, false);
	});
});

test("AP1 named remote sieve enforces completion at every task commit", async () => {
	await forEachBackend(async home => {
		const h = await home.open(); await h.commit(tx => createSpace(tx, "sieve-ap1", Date.now()), ctx);
		const config = { runId: "acceptance", start: 1, end: 401, blockSize: 80 };
		await prepareSieveRun(h, config, { space: "sieve-ap1" });
		const remote = new RemoteSpace(inProcessTransport(service(h), { peerId: "a" }), { space: "sieve-ap1" });
		const tx = await remote.createTransaction(60000); const task = await remote.take({ type: "SieveTask" }, 0, { txn: tx.id }); assert.ok(task);
		await assert.rejects(remote.commit(tx.id), CompletionViolation); await remote.abort(tx.id);
		while (await processSieveTask(remote, config.runId)) { /* each commit validates the local profile */ }
		const primes = await collectSieveResults(remote, config); assert.equal(primes.length, 78); assert.equal(primes[primes.length - 1], 397);
		assert.equal(await remote.count({ type: "SieveTask" }), 0); assert.equal(await new PhiSpaces(h, ctx).count({ type: "SieveResult" }), 0);
	});
});

test("AP1 a task written and taken in its own txn still needs a completion result", async () => {
	await forEachBackend(async home => {
		const local = new PhiSpaces(await home.open(), ctx); await local.setCompletionProfiles([{ taskType: "Task", resultTypes: ["Result"], equalFields: ["key"], maxResultCount: 1 }]);
		const tx = await local.createTransaction(60000); await local.write({ type: "Task", fields: { key: 1 } }, tx.id, core.FOREVER);
		await local.take({ type: "Task" }, 0, { txn: tx.id }); await assert.rejects(local.commit(tx.id), CompletionViolation);
		await local.write({ type: "Result", fields: { key: 1 } }, tx.id, core.FOREVER); await local.commit(tx.id); assert.equal(await local.count({ type: "Result" }), 1);
	});
});

test("AP1 mailbox loss releases an unacknowledged FOREVER take, an ACKed take remains owned", async () => {
	await forEachBackend(async home => {
		const h = await home.open(), c = clock(), local = new PhiSpaces(h, ctx, c.now);
		await local.setLimits({ mailboxTtlMs: 100 }); const svc = service(h, c.now);
		const a = new RemoteSpace(inProcessTransport(svc, { peerId: "a" }));
		await a.wait({ type: "Lost" }, { target: "self", timeout: core.FOREVER, txnLeaseMs: core.FOREVER });
		await local.write({ type: "Lost", fields: {} }, null, core.FOREVER);
		assert.equal((await local.stats()).locked, 1);
		c.advance(101); await local.write({ type: "Wake", fields: {} }, null, core.FOREVER);
		assert.equal(await local.count({ type: "Lost" }), 1, "lost take delivery returns its task despite an infinite lease");
		await a.wait({ type: "Held" }, { target: "self", timeout: core.FOREVER, txnLeaseMs: core.FOREVER });
		await local.write({ type: "Held", fields: {} }, null, core.FOREVER); const p = await a.events();
		const held = p.events.find(item => item.event.entry?.type === "Held")!;
		await a.ack(p.mailboxEpoch, p.next); c.advance(101); await local.write({ type: "Wake", fields: {} }, null, core.FOREVER);
		assert.equal(await local.count({ type: "Held" }), 0, "ACKed delivery retains its independent transaction"); await a.abort(held.event.txn!);
		assert.equal(await local.count({ type: "Held" }), 1);
	});
});

test("AP1 full consumer mailbox does not prevent reserved completion; fanout resumes after crash and ACK", async () => {
	await forEachBackend(async home => {
		let h = await home.open(); const c = clock(); let local = new PhiSpaces(h, ctx, c.now);
		await local.setLimits({ maxMailboxBytes: 650, notifyIntervalMs: 0 });
		let svc = service(h, c.now); let a = new RemoteSpace(inProcessTransport(svc, { peerId: "a" }));
		await a.notify({ type: "Result" }, { target: "self", lease: core.FOREVER });
		const tx = await local.createTransaction(60000); await local.write({ type: "Result", fields: { tag: "completion", pad: "x".repeat(180) } }, tx.id, core.FOREVER);
		await local.write({ type: "Result", fields: { tag: "fill", pad: "x".repeat(180) } }, null, core.FOREVER);
		await local.commit(tx.id); assert.equal(await local.count({ type: "Result" }), 2);
		assert.ok(((await h.snapshot((await import("../src/doc.ts")).Space, ctx))!.jobs?.length ?? 0) > 0, "completion persists its deferred event");
		home.crash(h); h = await home.open(); local = new PhiSpaces(h, ctx, c.now); svc = service(h, c.now); a = new RemoteSpace(inProcessTransport(svc, { peerId: "a" }));
		const first = await a.events(); assert.equal(first.events[0]!.event.entry!.fields.tag, "fill"); await a.ack(first.mailboxEpoch, first.next);
		const second = await a.events(); assert.equal(second.events[0]!.event.entry!.fields.tag, "completion");
	});
});

test("AP1 claim GC processes bounded expired batches and is inert for live claims", () => {
	const s = core.initialState(), p = { peerId: "gc" }, g = claims.issueGeneration(s, 1, p);
	for (let i = 0; i < 300; i++) { const ad = claims.admit(s, 1, { principal: p, generation: g.generation, requestId: String(i) }, "write", {}, core.FOREVER); claims.decide(s, 1, ad.key, { state: "done", result: null }); }
	core.seal(s); const before = JSON.stringify(s); claims.sweep(s, 2); assert.equal(JSON.stringify(s), before, "no self-induced watch loop over a live claim scan");
	core.setLimits(s, { maxCommitBytes: 3000, claimResultMs: 10, generationAdmitMs: 10 });
	core.beginCommit(s); claims.sweep(s, g.admitUntil + 1); assert.ok(Object.keys(s.rpc!.claims).length > 0 && Object.keys(s.rpc!.claims).length < 300);
	for (let i = 0; i < 40 && Object.keys(s.rpc!.claims).length; i++) { core.beginCommit(s); core.settle(s, g.admitUntil + 1); }
	assert.equal(Object.keys(s.rpc!.claims).length, 0);
});

test("AP1 peer-wide pending quota is atomic across agents and allows a known pending replay", async () => {
	await forEachBackend(async home => {
		const h = await home.open(); const identity = new StaticIdentity({ one: { principal: { peerId: "shared", agentId: "one" }, roles: ["member"] }, two: { principal: { peerId: "shared", agentId: "two" }, roles: ["member"] } });
		const svc = new SpaceService({ host: h, ctx, identity, maxPendingPerPeer: 1 });
		const one = ok(await svc.handle({ method: "generation" }, { peerId: "one" })).generation;
		const two = ok(await svc.handle({ method: "generation" }, { peerId: "two" })).generation;
		const call = { method: "take", request: { generation: one, requestId: "pending" }, args: { template: { type: "Later" }, timeoutMs: 60000, waitMs: 0 } };
		assert.equal(ok(await svc.handle(call, { peerId: "one" })).state, "pending");
		const refused = await svc.handle({ ...call, request: { generation: two, requestId: "other" } }, { peerId: "two" }); assert.ok(!refused.ok); assert.equal(refused.error.code, "ResourceExhausted");
		assert.equal(ok(await svc.handle(call, { peerId: "one" })).state, "pending");
	});
});

test("AP1 call rate quota rejects excess calls and resets after its configured window", async () => {
	await forEachBackend(async home => {
		const c = clock(), svc = service(await home.open(), c.now, { maxCallsPerWindow: 2, rateWindowMs: 100 });
		ok(await svc.handle({ method: "hello", args: { protocol: 1 } }, { peerId: "a" })); ok(await svc.handle({ method: "hello", args: { protocol: 1 } }, { peerId: "a" }));
		const refused = await svc.handle({ method: "hello", args: { protocol: 1 } }, { peerId: "a" }); assert.ok(!refused.ok); assert.equal(refused.error.code, "ResourceExhausted");
		c.advance(101); ok(await svc.handle({ method: "hello", args: { protocol: 1 } }, { peerId: "a" }));
	});
});
