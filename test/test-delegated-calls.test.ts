// A router's delegated calls on the wire of a Member host (src/delegation.ts), on either server. TypeScript is the control
// host here: it issues the lease and the grant, the Member under test checks them.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { RemoteSpace, socketTransport, generateKey, DEFAULT_POLICY, GrantAuthority, createSpace, spaceDoc, type Signer } from "../src/index.ts";
import { canonicalJson } from "../src/canonical.ts";
import { RouterLeaseAuthority, delegationForCall, signDelegation, type SignedRouterLease } from "../src/delegation.ts";
import { TestClock, TestKeys, gateUnderTest, type Replicated } from "./support/gate-under-test.ts";
import { argHash } from "../src/claims.ts";
import { openTestHost } from "./support/host.ts";
import { ctx } from "./support/persistent.ts";

type Peer = { id: string; name: string; ip: string; connected: boolean; groups: Array<{ id: string; name: string }> };
const peer = (id: string, ip: string, groups: string[]): Peer => ({ id, name: id, ip, connected: true, groups: groups.map((g) => ({ id: `g-${g}`, name: g })) });
type Reply = { ok: boolean; result?: any; error?: { code: string; message: string } };
type Call = { method: string; args?: Record<string, unknown>; request?: { generation: string; requestId: string }; space?: string; frame?: Record<string, unknown> };

async function setup(tc: TestContext, { replica, ...o }: { maxPendingPerPeer?: number; replica?: Replicated } = {}) {
	const peers = [peer("router", "127.0.0.3", ["space-admin", "space-hosts"]), peer("other", "127.0.0.4", ["space-admin"])];
	const server = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(peers)); });
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	tc.after(() => { server.closeAllConnections(); server.close(); });
	const clock = new TestClock(tc, 1_700_000_000_000), policy = new TestClock(tc, 1), keys = new TestKeys(tc);
	const supervisor = generateKey("ed25519", "supervisor"), routerKey = generateKey("ecdsa-p256", "router-key"), userKey = generateKey("ed25519", "user-key"), user2Key = generateKey("ed25519", "user2-key");
	const add = (peerId: string, k: ReturnType<typeof generateKey>, roles: string[]) => keys.add({ peerId, keyId: k.signer.keyId, principal: peerId, algorithm: k.signer.algorithm, publicKey: k.publicKey, roles, scope: ["*"], state: "active" });
	add("router", routerKey, ["router", "admin", "member"]); add("user", userKey, ["member"]); add("user2", user2Key, ["member"]);
	const root = await openTestHost(ctx);
	tc.after(() => root.close(ctx));
	const control = await root.commit((tx) => createSpace(tx, "control", clock.now()), ctx);
	/** The right supervisor's signature on a lease of another space, authority or key: only the binding is wrong. */
	const foreign = async (o: { controlSpaceId?: string; authorityId?: string; keyId?: string }) => {
		const other = await openTestHost(ctx);
		tc.after(() => other.close(ctx));
		const space = await other.commit((tx) => createSpace(tx, "control", clock.now()), ctx);
		const id = o.controlSpaceId === undefined ? control.spaceId : space.spaceId;
		if (o.controlSpaceId === undefined) await other.commit((tx) => spaceDoc(tx, space.spaceId, clock.now()).then(() => {}), ctx);
		const signed = await new RouterLeaseAuthority({ host: other, ctx, controlSpaceId: space.spaceId, authorityId: o.authorityId ?? "authority", peerId: "supervisor", signer: supervisor.signer, keys: { find: async (p, k) => ({ peerId: p, keyId: k, principal: p, algorithm: "ed25519", publicKey: "", roles: ["router"], state: "active" }) }, assertAuthority: async () => {}, now: clock.now }).issue("router", o.keyId ?? routerKey.signer.keyId);
		const lease = { ...signed.lease, controlSpaceId: id };
		return { ...signed, lease, signature: Buffer.from(await supervisor.signer.sign(Buffer.from("phi-spaces/router-lease/v1\n" + canonicalJson(lease as never)))).toString("base64") };
	};
	const leases = () => new RouterLeaseAuthority({ host: root, ctx, controlSpaceId: control.spaceId, authorityId: "authority", peerId: "supervisor", signer: supervisor.signer, keys, assertAuthority: async () => {}, now: clock.now });
	const authority = (p: string) => { const id = { principal: { peerId: p }, roles: ["member"] }; return new GrantAuthority({ authorityId: "authority", hostId: "control-host", signer: supervisor.signer, keys, identity: { authenticate: () => id }, refreshIdentity: async () => id, now: clock.now }); };
	const grant = (p = "user", k = userKey) => authority(p).issue({ peerId: p, state: { proof: { keyId: k.signer.keyId } } });
	const gate = await gateUnderTest(tc, { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, clock, keys, gateHostId: "host-1", serviceClock: true, policy: DEFAULT_POLICY, ...o, delegation: { supervisorKey: supervisor.publicKey, grantKey: supervisor.publicKey, controlSpaceId: control.spaceId, policy, ...(replica ? { replica } : {}) } });
	const sid = await gate.control.jobsSpace("jobs", []);
	const transports: Array<{ close(): void }> = [];
	tc.after(() => transports.forEach((t) => t.close()));
	const link = async (ip: string, peerId: string, signer: Signer) => {
		const t = socketTransport({ host: "127.0.0.1", port: gate.port }, { localAddress: ip });
		transports.push(t);
		await new RemoteSpace(t, { attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 3_000, signer, expectedGateHostId: "host-1", ownPeerId: peerId }).authenticate();
		return t;
	};
	const wire = await link("127.0.0.3", "router", routerKey.signer);
	let lease: SignedRouterLease = await leases().issue("router", routerKey.signer.keyId);
	const raw = async (t: typeof wire, c: Call): Promise<Reply> => JSON.parse(await t.request(JSON.stringify(c)));
	/** A call as the router sends it; `change` may spoil any part before it is signed or after. */
	const send = async (c: Call, o: { principal?: { peerId: string }; signer?: Signer; g?: any; targetRequest?: any; version?: number; change?: (d: any) => void; after?: (t: any) => void; epoch?: number; replicaConfigVersion?: number; via?: typeof wire; lease?: SignedRouterLease } = {}): Promise<Reply> => {
		const call = { ...c, space: c.space ?? sid };
		const g = o.g ?? await grant(), principal = o.principal ?? { peerId: "user" };
		const d = delegationForCall({ call: call as never, principal, lease: o.lease ?? lease, policyVersion: o.version ?? policy.t, spaceId: sid, primaryEpoch: o.epoch ?? 1, grant: g as never, ...(o.targetRequest ? { targetRequest: o.targetRequest } : {}), ...(o.replicaConfigVersion === undefined ? {} : { replicaConfigVersion: o.replicaConfigVersion }), now: clock.now() });
		o.change?.(d);
		const signed = await signDelegation(o.signer ?? routerKey.signer, d);
		o.after?.(signed);
		return raw(o.via ?? wire, { ...call, frame: { grant: g, delegation: signed } });
	};
	const generation = async (o: Parameters<typeof send>[1] = {}) => (await send({ method: "generation" }, o)).result.generation as string;
	return { foreign, clock, policy, keys, gate, sid, wire, raw, send, generation, grant, authority, leases, link, supervisor, routerKey, userKey, user2Key, control, renew: async () => { lease = await leases().issue("router", routerKey.signer.keyId); return lease; }, lease: () => lease };
}
const refused = (r: Reply, part: string | RegExp) => assert.ok(!r.ok && (typeof part === "string" ? r.error!.message.includes(part) : part.test(r.error!.message)), JSON.stringify(r));

test("a delegated call works as its principal, and each binding of it is checked", async (tc) => {
	const g = await setup(tc);
	const generation = await g.generation();
	assert.ok(generation);
	const request = () => ({ generation, requestId: `r-${Math.random()}` });
	const write = () => ({ method: "write", args: { entry: { type: "Job", fields: { n: 1 } }, leaseMs: 60_000 }, request: request() });
	const done = await g.send(write());
	assert.ok(done.ok, JSON.stringify(done));
	const seen = await g.send({ method: "readAll", args: { template: { type: "Job" } } });
	assert.match(JSON.stringify(seen.result), /"owner":"\[\\"user\\",null\]"/, "the entry belongs to the principal, not the router");
	refused(await g.send(write(), { signer: generateKey("ecdsa-p256", "router-key").signer }), "invalid router signature/key");
	refused(await g.send(write(), { signer: g.userKey.signer }), "requires its proven router connection");
	refused(await g.send(write(), { after: (t) => { t.delegation.routerLease = { ...t.delegation.routerLease, signature: "AAAA" }; } }), "invalid router signature/key");
	refused(await g.send(write(), { change: (d) => { d.routerLease = { ...d.routerLease, signature: "AAAA" }; } }), "invalid supervisor signature");
	refused(await g.send(write(), { change: (d) => { d.targetSpace = "sp-other"; } }), "audience mismatch");
	refused(await g.send(write(), { change: (d) => { d.operation = "take"; } }), "operation/principal mismatch");
	refused(await g.send(write(), { change: (d) => { d.argumentHash = "0".repeat(64); } }), "request/hash mismatch");
	refused(await g.send(write(), { change: (d) => { d.requestId = "other"; } }), "request/hash mismatch");
	refused(await g.send(write(), { epoch: 2 }), "target epoch");
	refused(await g.send(write(), { principal: { peerId: "user2" } }), "original principal grant");
	refused(await g.send(write(), { change: (d) => { d.expiresAt = d.routerLease.lease.expiresAt + 1; } }), /delegation or lease expired/);
	refused(await g.raw(g.wire, { ...write(), space: g.sid, frame: { grant: await g.grant() } }), /another principal|another app key/);
	const held = await g.grant();
	g.keys.revoke("user", g.userKey.signer.keyId);
	refused(await g.send(write(), { g: held }), "original principal key revoked");
});

test("a lease binds its authority, its control space and the router's key", async (tc) => {
	const g = await setup(tc);
	const generation = await g.generation();
	const write = (id: string) => ({ method: "write", args: { entry: { type: "Job", fields: {} }, leaseMs: 60_000 }, request: { generation, requestId: id } });
	assert.ok((await g.send(write("own"), { lease: await g.foreign({}) })).ok, "the same lease of a second host is good: the test spoils one thing at a time");
	refused(await g.send(write("a"), { lease: await g.foreign({ authorityId: "other" }) }), "lease authority/epochs mismatch");
	refused(await g.send(write("c"), { lease: await g.foreign({ controlSpaceId: "other" }) }), "lease authority/epochs mismatch");
	refused(await g.send(write("k"), { lease: await g.foreign({ keyId: "another-key" }) }), "requires its proven router connection");
});

test("the router's own key and a lease that ran out end its calls", async (tc) => {
	const g = await setup(tc);
	const generation = await g.generation();
	const write = (id: string) => ({ method: "write", args: { entry: { type: "Job", fields: {} }, leaseMs: 60_000 }, request: { generation, requestId: id } });
	g.clock.t += 59_000;
	refused(await g.send(write("late"), { g: await g.grant() }), "delegation or lease expired");
	await g.renew();
	g.keys.revoke("router", g.routerKey.signer.keyId);
	refused(await g.send(write("gone")), "invalid router signature/key");
});

test("a new request needs the installed policy; what it began goes on under its own", async (tc) => {
	const g = await setup(tc);
	const generation = await g.generation();
	const take = { method: "take", args: { template: { type: "Task" }, timeoutMs: 30_000, waitMs: 0 }, request: { generation, requestId: "p1" } };
	assert.equal((await g.send(take)).result.state, "pending");
	g.policy.t = 2;
	const old = await g.send({ method: "write", args: { entry: { type: "Job", fields: {} }, leaseMs: 60_000 }, request: { generation, requestId: "w" } }, { version: 1 });
	assert.equal(old.error?.code, "StalePolicyVersion", JSON.stringify(old));
	const poll = { method: "pollOperation", args: { targetRequest: { generation, requestId: "p1" }, waitMs: 0 } };
	refused(await g.send(poll, { version: 1 }), "requires targetRequest");
});

test("a higher epoch ends the older lease and fences what it left waiting", async (tc) => {
	const g = await setup(tc);
	const generation = await g.generation();
	const old = g.lease();
	let hash = "";
	const take = { method: "take", args: { template: { type: "Task" }, timeoutMs: 30_000, waitMs: 0 }, request: { generation, requestId: "p1" } };
	assert.equal((await g.send(take, { change: (d) => { hash = d.argumentHash; } })).result.state, "pending");
	const fresh = await g.renew();
	const write = (id: string) => ({ method: "write", args: { entry: { type: "Task", fields: {} }, leaseMs: 60_000 }, request: { generation, requestId: id } });
	const notice = { method: "epochNotice", space: g.sid, args: { signedNotice: await g.leases().notice(1) } };
	assert.ok((await g.raw(g.wire, notice)).ok, "the supervisor's word");
	refused(await g.raw(g.wire, { ...notice, args: { signedNotice: { ...notice.args.signedNotice, signature: "AAAA" } } }), "invalid supervisor signature");
	refused(await g.send(write("old"), { lease: old }), "superseded by higher epoch");
	assert.ok((await g.send(write("new"), { lease: fresh })).ok, "the new lease works");
	const left = await g.send({ method: "count", args: { template: { type: "Task" } } }, { lease: fresh });
	assert.ok(left.ok, JSON.stringify(left));
	assert.equal(left.result.value, 1, "the old lease's take does not run on though a Task is there");
	const poll = { method: "pollOperation", args: { targetRequest: { generation, requestId: "p1" }, waitMs: 0 } };
	const target = { requestId: "p1", requestGeneration: generation, method: "take", argumentHash: hash, policyVersion: 1 };
	assert.equal((await g.send(poll, { lease: fresh, targetRequest: target })).result.state, "done", "a poll under the current lease takes it up again");
});

test("a follow-up names its own request", async (tc) => {
	const g = await setup(tc);
	const generation = await g.generation();
	let hash = "";
	const begun = await g.send({ method: "txn", args: { action: "begin", leaseMs: 30_000 }, request: { generation, requestId: "b" } }, { change: (d) => { hash = d.argumentHash; } });
	const txn = begun.result.id as string;
	const commit = { method: "txn", args: { action: "commit", id: txn }, request: { generation, requestId: "c" } };
	refused(await g.send(commit), "follow-up requires targetRequest");
	const target = { requestId: "b", requestGeneration: generation, method: "txn.begin", argumentHash: hash, policyVersion: 1 };
	refused(await g.send(commit, { targetRequest: { ...target, requestId: "nope" } }), "does not name own bound claim");
	refused(await g.send(commit, { targetRequest: { ...target, argumentHash: "0".repeat(64) } }), "does not name own bound claim");
	refused(await g.send({ method: "write", args: { entry: { type: "Job", fields: {} } }, request: { generation, requestId: "w" } }, { targetRequest: target }), "forbidden for this follow-up");
	refused(await g.send({ ...commit, args: { action: "commit", id: "t-other" } }, { targetRequest: target }), "not bound to target result");
	assert.ok((await g.send(commit, { targetRequest: target })).ok);
});

test("an epoch notice by alias fences the same Space", async (tc) => {
	const g = await setup(tc);
	const generation = await g.generation();
	const old = g.lease();
	await g.renew();
	assert.ok((await g.raw(g.wire, { method: "epochNotice", space: "jobs", args: { signedNotice: await g.leases().notice(1) } })).ok);
	refused(await g.send({ method: "write", args: { entry: { type: "Task", fields: {} }, leaseMs: 60_000 }, request: { generation, requestId: "w" } }, { lease: old }), "superseded by higher epoch");
});

test("a grant that ran out completes no waiting take; a resolution grant looks, an effect grant goes on", async (tc) => {
	const g = await setup(tc);
	const issue = (purpose: "effect" | "resolution") => g.authority("router").issue({ peerId: "router", state: { proof: { keyId: g.routerKey.signer.keyId } } }, purpose);
	const as = async (c: Call, purpose: "effect" | "resolution" = "effect") => g.raw(g.wire, { ...c, space: g.sid, frame: { grant: await issue(purpose) } });
	const generation = (await as({ method: "generation" })).result.generation as string;
	const later = { template: { type: "Later" } };
	assert.equal((await as({ method: "take", args: { ...later, timeoutMs: 3_600_000, waitMs: 0 }, request: { generation, requestId: "p" } })).result.state, "pending");
	g.clock.t += 61_000;
	const count = async () => (await as({ method: "count", args: later })).result.value;
	assert.ok((await as({ method: "write", args: { entry: { type: "Later", fields: {} }, leaseMs: 3_600_000 }, request: { generation, requestId: "w" } })).ok);
	assert.equal(await count(), 1, "an expired grant cannot complete the old take");
	const poll = { method: "pollOperation", args: { targetRequest: { generation, requestId: "p" }, waitMs: 0 } };
	assert.equal((await as(poll, "resolution")).result.state, "pending");
	assert.equal(await count(), 1);
	refused(await as({ method: "write", args: { entry: { type: "Later", fields: {} }, leaseMs: 1000 }, request: { generation, requestId: "x" } }, "resolution"), /resolution/);
	assert.equal((await as(poll)).result.state, "done");
	assert.equal(await count(), 0);
});

test("the waiting work of a router counts for that router, whoever it is for", async (tc) => {
	const g = await setup(tc, { maxPendingPerPeer: 2 });
	const generation = await g.generation();
	const take = (id: string, generation: string) => ({ method: "take", args: { template: { type: "Task" }, timeoutMs: 30_000, waitMs: 0 }, request: { generation, requestId: id } });
	for (const id of ["a", "b"]) assert.equal((await g.send(take(id, generation))).result.state, "pending");
	const other = { principal: { peerId: "user2" }, g: await g.grant("user2", g.user2Key) };
	const second = await g.generation(other);
	const full = await g.send(take("c", second), other);
	assert.equal(full.error?.code, "ResourceExhausted", JSON.stringify(full));
	assert.match(full.error!.message, /for this peer/);
});

test("a replicated Member: new work waits until the router adopts its configuration, and an unknown older request is NotCommitted only with promotion evidence", async (tc) => {
	const replica: Replicated = { version: new TestClock(tc, 1), epoch: new TestClock(tc, 1), proof: new TestClock(tc, 0) };
	const g = await setup(tc, { replica });
	const pending = (r: Reply) => assert.equal(r.error?.code, "ReplicaConfigPending", JSON.stringify(r));
	refused(await g.send({ method: "generation" }), "is not adopted by the router yet");
	const generation = await g.generation({ replicaConfigVersion: 1 });
	const write = (id: string, n: number) => ({ method: "write", args: { entry: { type: "Job", fields: { n } }, leaseMs: 60_000 }, request: { generation, requestId: id } });
	pending(await g.send(write("w0", 0)));
	const done = await g.send(write("w1", 1), { replicaConfigVersion: 1 });
	assert.ok(done.ok, JSON.stringify(done));
	const hash = (n: number) => argHash("write", { entry: { type: "Job", fields: { n } }, txn: null, lease: 60_000 } as never);
	const target = (id: string, n: number) => ({ requestId: id, requestGeneration: generation, method: "write", argumentHash: hash(n), policyVersion: 1 });
	// promoted: epoch 2, configuration 2
	replica.version.t = 2; replica.epoch.t = 2;
	pending(await g.send(write("w2", 2), { replicaConfigVersion: 1 }));
	pending(await g.send(write("w2", 2), { epoch: 2, replicaConfigVersion: 1 }));
	refused(await g.send(write("w2", 2), { epoch: 3, replicaConfigVersion: 2 }), "target epoch does not match");
	const fresh = await g.generation({ epoch: 2, replicaConfigVersion: 2 });
	assert.ok((await g.send({ ...write("w3", 3), request: { generation: fresh, requestId: "w3" } }, { epoch: 2, replicaConfigVersion: 2 })).ok);
	// a follow-up of work admitted before the change continues under its original binding
	const poll = await g.send({ method: "pollOperation", args: { targetRequest: { generation, requestId: "w1" }, waitMs: 0 } }, { targetRequest: target("w1", 1), replicaConfigVersion: 1 });
	assert.equal(poll.result?.state, "done", JSON.stringify(poll));
	// the request that never arrived: unknown without evidence, NotCommitted with it, and the late original meets it
	const resolve = (o: { replicaConfigVersion: number }) => g.send({ method: "resolveOperation", args: { targetRequest: { generation, requestId: "lost" }, method: "write", argumentHash: hash(7), primaryEpoch: 1 } }, { targetRequest: target("lost", 7), ...o });
	pending(await resolve({ replicaConfigVersion: 1 }));
	const without = await resolve({ replicaConfigVersion: 2 });
	assert.equal(without.error?.code, "IncarnationChanged", JSON.stringify(without));
	replica.proof.t = 7;
	const decided = await resolve({ replicaConfigVersion: 2 });
	assert.equal(decided.result?.error?.code, "NotCommitted", JSON.stringify(decided));
	assert.deepEqual(await resolve({ replicaConfigVersion: 2 }), decided, "repeatable");
	const late = await g.send(write("lost", 7), { replicaConfigVersion: 2 });
	assert.equal(late.error?.code, "NotCommitted", JSON.stringify(late));
	const count = await g.send({ method: "count", args: { template: { type: "Job" } } }, { epoch: 2, replicaConfigVersion: 2 });
	assert.equal(count.result?.value, 2, JSON.stringify(count));
});
