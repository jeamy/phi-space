// AP 1.8: the transport-independent `space` service (federation-plan-v3.md 6.2).
import test from "node:test";
import assert from "node:assert/strict";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { PiSpaces, SpaceService, StaticIdentity, createSpace, DEFAULT_POLICY, type Reply, type Call, type Policy } from "./src/index.ts";
import { forEachBackend, InjectedFault, ctx } from "./test/support/persistent.ts";

const memory = () => Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, ctx);
const ids = new StaticIdentity({
	"peer-admin": { principal: { peerId: "peer-admin" }, roles: ["admin"] },
	"peer-a": { principal: { peerId: "peer-a", agentId: "w1" }, roles: ["member"] },
	"peer-b": { principal: { peerId: "peer-b" }, roles: ["member"] },
	"peer-obs": { principal: { peerId: "peer-obs" }, roles: ["observer"] },
	"peer-jobs": { principal: { peerId: "peer-jobs" }, roles: ["jobs-only"] },
});
const policy: Policy = { roles: { ...DEFAULT_POLICY.roles, "jobs-only": { methods: ["hello", "generation", "write", "read", "take", "readAll", "count", "changes"], types: ["Job"] } } };
const svc = (h: Harness, extra: Record<string, unknown> = {}) => new SpaceService({ host: h, ctx, identity: ids, policy, ...extra });
const as = (peerId: string) => ({ peerId });
const ok = (r: Reply): any => { assert.ok(r.ok, JSON.stringify(r)); return (r as { ok: true; result: unknown }).result; };
const err = (r: Reply, code: string): any => { assert.ok(!r.ok && r.error.code === code, JSON.stringify(r)); return (r as { ok: false; error: any }).error; };
async function session(s: SpaceService, peer: string, space?: string) {
	const g = ok(await s.handle({ method: "generation", ...(space ? { space } : {}) }, as(peer)));
	let n = 0;
	return {
		call: (method: Call["method"], args: Record<string, any> = {}, requestId?: string, extra: Partial<Call> = {}) =>
			s.handle({ method, ...(space ? { space } : {}), request: { generation: g.generation, requestId: requestId ?? `r${++n}` }, args, ...extra } as Call, as(peer)),
		generation: g.generation as string,
	};
}

test("hello: identity, limits and features; the call cannot name its principal", async () => {
	const h = await memory();
	const s = svc(h, { hostId: "host-1" });
	const r = ok(await s.handle({ method: "hello", args: { protocol: 1 } }, as("peer-a")));
	assert.equal(r.principal, "peer-a/w1");
	assert.equal(r.role, "single");
	assert.equal(r.hostId, "host-1");
	assert.ok(r.spaceId && r.incarnation !== undefined && r.streamId.includes(r.spaceId));
	assert.equal(r.limits.maxFrameBytes, 256 * 1024);
	assert.ok(r.features.includes("write") && r.features.includes("events"), "mailbox methods are offered");
	err(await s.handle({ method: "hello", args: { protocol: 2 } }, as("peer-a")), "UnsupportedProtocol");
	err(await s.handle({ method: "hello", args: { protocol: 1 } }, as("nobody")), "Unauthenticated");
	err(await s.handle({ method: "hello", args: { protocol: 1 } }, {}), "Unauthenticated");
	// a call that tries to bring its own principal is just a call: extra fields change nothing
	const sneaky = await s.handle({ method: "hello", args: { protocol: 1 }, principal: { peerId: "peer-admin" }, roles: ["admin"] } as unknown as Call, as("peer-obs"));
	assert.equal(ok(sneaky).principal, "peer-obs");
	assert.deepEqual(ok(sneaky).roles, ["observer"]);
});

test("rights: methods per role, types per role including the supertypes of an entry", async () => {
	const h = await memory();
	const s = svc(h);
	const obs = await session(s, "peer-obs");
	err(await obs.call("write", { entry: { type: "Job", fields: {} } }), "PermissionDenied");
	err(await obs.call("txn", { action: "begin" }), "PermissionDenied");
	const jobs = await session(s, "peer-jobs");
	ok(await jobs.call("write", { entry: { type: "Job", fields: { n: 1 } } }));
	ok(await jobs.call("write", { entry: { type: "Special", types: ["Job"], fields: { n: 2 } } })); // covered through its supertype
	err(await jobs.call("write", { entry: { type: "Secret", fields: {} } }), "PermissionDenied");
	err(await jobs.call("write", { entry: { type: "Secret", types: ["Other"], fields: {} } }), "PermissionDenied");
	err(await jobs.call("readAll", {}), "PermissionDenied"); // a template without a type is "everything"
	assert.equal(ok(await jobs.call("readAll", { template: { type: "Job" } })).items.length, 2);
	err(await jobs.call("changes", { afterRev: 0 }), "PermissionDenied"); // the stream has all types
	const member = await session(s, "peer-a");
	const admin = await session(s, "peer-admin");
	ok(await admin.call("write", { entry: { type: "Secret", fields: {} } }));
	assert.equal(ok(await member.call("readAll", { template: { type: "Secret" } })).items.length, 1, "a member has no type limits");
});

test("write, take and the lost answer: the same request returns the stored result, one effect", async () => {
	await forEachBackend(async (home) => {
		let h = await home.open();
		let s = svc(h);
		let c = await session(s, "peer-a");
		ok(await c.call("write", { entry: { type: "Job", fields: { n: 1 } } }));
		ok(await c.call("write", { entry: { type: "Job", fields: { n: 2 } } }));
		home.faults.arm("loseAnswer");
		const lost = await c.call("take", { template: { type: "Job" } }, "take-1");
		err(lost, "Internal"); // the transport would see a failure; the commit was durable
		assert.equal(home.faults.fired, 1);
		home.crash(h);
		h = await home.open();
		s = svc(h);
		const again = { call: (m: any, a: any, id: string) => s.handle({ method: m, request: { generation: c.generation, requestId: id }, args: a }, as("peer-a")) };
		const r = ok(await again.call("take", { template: { type: "Job" } }, "take-1"));
		assert.equal(r.state, "done");
		assert.equal(r.entry.fields.n, 1);
		assert.equal(ok(await s.handle({ method: "count", args: { template: { type: "Job" } } }, as("peer-a"))).value, 1, "exactly one entry was taken");
		err(await again.call("take", { template: { type: "Other" } }, "take-1"), "RequestConflict");
		const st = ok(await s.handle({ method: "pollOperation", args: { targetRequest: { generation: c.generation, requestId: "take-1" } } }, as("peer-a")));
		assert.equal(st.state, "done");
		void InjectedFault;
	});
});

test("a blocked take answers pending, keeps running, and a poll sees it done; claims are private to their principal", async () => {
	const h = await memory();
	const s = svc(h);
	const a = await session(s, "peer-a");
	const b = await session(s, "peer-b");
	const first = ok(await a.call("take", { template: { type: "Late" }, timeoutMs: 1_500, waitMs: 80 }, "wait-1"));
	assert.equal(first.state, "pending");
	assert.ok(first.deadline > Date.now());
	ok(await b.call("write", { entry: { type: "Late", fields: { v: 7 } } }));
	const polled = ok(await a.call("pollOperation", { targetRequest: { generation: a.generation, requestId: "wait-1" }, waitMs: 2_000 }, "p1"));
	assert.equal(polled.state, "done");
	assert.equal(polled.result.fields.v, 7);
	const retry = ok(await a.call("take", { template: { type: "Late" }, timeoutMs: 1_500 }, "wait-1"));
	assert.equal(retry.state, "done", "the retry of a decided request returns its result");
	assert.equal(ok(await s.handle({ method: "count", args: { template: { type: "Late" } } }, as("peer-a"))).value, 0);
	err(await b.call("pollOperation", { targetRequest: { generation: a.generation, requestId: "wait-1" } }), "RequestExpired"); // not peer-b's request
	// a miss is final: null, and the retry says the same
	const miss = ok(await a.call("take", { template: { type: "Nothing" }, timeoutMs: 30, ifExists: true }, "miss-1"));
	assert.deepEqual(miss, { state: "done", entry: null });
	assert.deepEqual(ok(await a.call("take", { template: { type: "Nothing" }, timeoutMs: 30, ifExists: true }, "miss-1")), { state: "done", entry: null });
});

test("cancelOperation ends a pending call; transactions and leases run through the service", async () => {
	const h = await memory();
	const s = svc(h);
	const a = await session(s, "peer-a");
	assert.equal(ok(await a.call("read", { template: { type: "Never" }, timeoutMs: 1_200, waitMs: 30 }, "blocked")).state, "pending");
	const c = ok(await a.call("cancelOperation", { targetRequest: { generation: a.generation, requestId: "blocked" } }));
	assert.equal(c.state, "cancelled");
	const t = ok(await a.call("txn", { action: "begin", leaseMs: 60_000 }));
	ok(await a.call("write", { entry: { type: "Job", fields: { n: 1 } }, txn: t.id }));
	assert.equal(ok(await a.call("readAll", { template: { type: "Job" } })).items.length, 0, "not visible before the commit");
	assert.deepEqual(ok(await a.call("txn", { action: "commit", id: t.id })), { state: "committed" });
	const e = ok(await a.call("readAll", { template: { type: "Job" } })).items[0];
	assert.ok(e.gid.includes("/"));
	const l = ok(await a.call("write", { entry: { type: "Temp", fields: {} }, leaseMs: 1_000 }));
	assert.ok(ok(await a.call("lease", { action: "renew", id: l.id, ms: 60_000 })).expires > l.expires);
	ok(await a.call("lease", { action: "cancel", id: l.id }));
	err(await a.call("lease", { action: "renew", id: "e-nothing", ms: 1 }), "TransactionError");
	const other = await session(s, "peer-b");
	const t2 = ok(await a.call("txn", { action: "begin" }));
	err(await other.call("txn", { action: "commit", id: t2.id }), "PermissionDenied");
});

test("pages by bytes through the service: ResponseBudgetTooSmall carries requiredBytes, changes give batches or resync", async () => {
	const h = await memory();
	const s = svc(h);
	const a = await session(s, "peer-a");
	for (let i = 0; i < 12; i++) ok(await a.call("write", { entry: { type: "Job", fields: { i, pad: "x".repeat(200) } } }));
	const small = err(await a.call("readAll", { template: { type: "Job" }, maxBytes: 150 }), "ResponseBudgetTooSmall");
	assert.ok(small.requiredBytes > 150);
	const seen: string[] = [];
	let cursor: string | null = null;
	do { const p: any = ok(await a.call("readAll", { template: { type: "Job" }, maxBytes: small.requiredBytes + 700, cursor })); seen.push(...p.items.map((e: any) => e.id)); cursor = p.next; } while (cursor);
	assert.equal(new Set(seen).size, 12);
	const ch = ok(await a.call("changes", { afterRev: 0, maxBytes: 4_000 }));
	assert.ok(ch.batches.length >= 1 && ch.rev >= 12);
	const done = ok(await a.call("changes", { afterRev: ch.rev }));
	assert.equal(done.batches.length, 0);
	const waited = Date.now();
	const late = a.call("changes", { afterRev: ch.rev, waitMs: 2_000 });
	await new Promise((r) => setTimeout(r, 120));
	ok(await a.call("write", { entry: { type: "Job", fields: { late: true } } }));
	assert.equal(ok(await late).batches.length, 1, "the long poll returns as soon as there is a batch");
	assert.ok(Date.now() - waited < 1_900);
	assert.equal(ok(await a.call("changes", { afterRev: 9_999 })).resync, true);
	assert.equal(ok(await a.call("changes", { afterRev: 0, streamId: "somewhere-else:0" })).resync, true);
});

test("frame checks, size limits and bad calls", async () => {
	const h = await memory();
	const s = svc(h, { authorityId: "auth-1", primaryEpoch: 3 });
	const a = await session(s, "peer-a", undefined);
	ok(await a.call("write", { entry: { type: "Job", fields: {} } }, "f1", { frame: { authorityId: "auth-1", primaryEpoch: 3 } }));
	err(await a.call("write", { entry: { type: "Job", fields: {} } }, "f2", { frame: { authorityId: "auth-2" } }), "AuthorityMismatch");
	err(await a.call("write", { entry: { type: "Job", fields: {} } }, "f3", { frame: { primaryEpoch: 2 } }), "StaleEpoch");
	err(await s.handle({ method: "write", args: { entry: { type: "Job", fields: {} } } }, as("peer-a")), "BadRequest"); // no request identity
	err(await a.call("write", { entry: { fields: {} } }), "BadRequest");
	err(await a.call("write", { entry: { type: "Job", fields: [] } }), "BadRequest");
	err(await a.call("write", { entry: { type: "Job", fields: {} }, leaseMs: -5 }), "BadRequest");
	err(await a.call("take", { template: "not a template" }), "BadRequest");
	err(await s.handle({ method: "frobnicate" }, as("peer-a")), "UnsupportedMethod");
	err(await s.handle("nonsense", as("peer-a")), "BadRequest");
	err(await s.handle({ method: "wait", args: {} }, as("peer-a")), "BadRequest");
	assert.equal(ok(await s.handle({ method: "events", args: {} }, as("peer-a"))).events.length, 0);
	const big = JSON.stringify({ method: "hello", args: { protocol: 1, pad: "z".repeat(300_000) } });
	assert.equal(JSON.parse(await s.handleText(big, as("peer-a"))).error.code, "ResourceExhausted");
	assert.equal(JSON.parse(await s.handleText("{not json", as("peer-a"))).error.code, "BadRequest");
	assert.equal(JSON.parse(await s.handleText(JSON.stringify({ method: "hello", args: { protocol: 1 } }), as("peer-a"))).ok, true);
	const huge = await a.call("write", { entry: { type: "Job", fields: { v: "y".repeat(70_000) } } });
	err(huge, "ResourceExhausted"); // maxEntryBytes
});

test("limits of the space come back as ResourceExhausted; too many pending operations are refused", async () => {
	const h = await memory();
	const s = svc(h, { maxPendingPerPrincipal: 2 });
	const a = await session(s, "peer-a");
	assert.equal(ok(await a.call("take", { template: { type: "X1" }, timeoutMs: 1_200, waitMs: 20 })).state, "pending");
	assert.equal(ok(await a.call("take", { template: { type: "X2" }, timeoutMs: 1_200, waitMs: 20 })).state, "pending");
	err(await a.call("take", { template: { type: "X3" }, timeoutMs: 1_200, waitMs: 20 }), "ResourceExhausted");
	const other = await session(s, "peer-b");
	assert.equal(ok(await other.call("take", { template: { type: "X3" }, timeoutMs: 1_200, waitMs: 20 })).state, "pending", "the limit is per principal");
	for (const id of ["r1", "r2"]) ok(await a.call("cancelOperation", { targetRequest: { generation: a.generation, requestId: id } }));
	const ownLimit = await new PiSpaces(h, ctx).setLimits({ maxEntries: 1 });
	assert.equal(ownLimit.maxEntries, 1);
	ok(await a.call("write", { entry: { type: "Job", fields: {} } }));
	err(await a.call("write", { entry: { type: "Job", fields: {} } }), "ResourceExhausted");
});

test("named spaces: the call names its space by alias or id, the default alias works too", async () => {
	const h = await memory();
	const info = await h.commit((tx) => createSpace(tx, "sieve", Date.now()), ctx);
	const s = svc(h);
	const named = await session(s, "peer-a", "sieve");
	ok(await named.call("write", { entry: { type: "Job", fields: { in: "sieve" } } }));
	const byId = await session(s, "peer-a", info.spaceId);
	assert.equal(ok(await byId.call("readAll", { template: { type: "Job" } })).items.length, 1);
	const dflt = await session(s, "peer-a");
	assert.equal(ok(await dflt.call("readAll", { template: { type: "Job" } })).items.length, 0, "the default space does not see it");
	const viaAlias = await session(s, "peer-a", "default");
	assert.equal(ok(await viaAlias.call("readAll", { template: { type: "Job" } })).items.length, 0);
	err(await s.handle({ method: "generation", space: "nope" }, as("peer-a")), "UnknownSpace");
	const hello = ok(await s.handle({ method: "hello", space: "sieve", args: { protocol: 1 } }, as("peer-a")));
	assert.equal(hello.spaceId, info.spaceId);
	assert.equal(hello.alias, "sieve");
});
