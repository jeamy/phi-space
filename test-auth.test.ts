// AP 1b.3 / layer B: the key challenge on top of the gate (federation-plan-v3.md 4.3).
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	SpaceService, RemoteSpace, RemoteError, socketTransport, startGate, NetbirdDirectory, GateIdentity, ProvingService, MemoryKeyDirectory, generateKey, FOREVER, core,
	type Policy, type Signer, type Transport,
} from "./src/index.ts";
import { ctx } from "./test/support/persistent.ts";

type Peer = { id: string; name: string; ip: string; connected: boolean; groups: Array<{ id: string; name: string }> };
const peer = (id: string, ip: string, groups: string[]): Peer => ({ id, name: id, ip, connected: true, groups: groups.map((g) => ({ id: `g-${g}`, name: g })) });
class Clock { t = 1_000_000; now = () => this.t; }
// writing is for admins only: it is what a withheld admin role would be missed for
const policy: Policy = { roles: { admin: { methods: "*" }, member: { methods: ["hello", "generation", "count", "readAll", "stats"] } } };

async function setup(tc: TestContext) {
	const peers: Peer[] = [
		peer("p-admin", "127.0.0.3", ["space-admin", "space-hosts"]),
		peer("p-host", "127.0.0.2", ["space-hosts"]),
		peer("p-other", "127.0.0.4", ["space-admin", "space-hosts"]),
	];
	const server = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(peers)); });
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	tc.after(() => { server.closeAllConnections(); server.close(); });
	const clock = new Clock();
	const keys = new MemoryKeyDirectory();
	const directory = new NetbirdDirectory({ url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, token: "t", now: clock.now });
	const host = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, ctx);
	const service = new SpaceService({ host, ctx, identity: new GateIdentity(), policy });
	const proving = new ProvingService(service, { gateHostId: "host-1", keys, now: clock.now });
	const events: Array<{ event: string; reason?: string }> = [];
	const gate = await startGate(proving, { listen: { host: "127.0.0.1", port: 0 }, directory, keys, revalidateMs: 0, now: clock.now, onEvent: (e) => events.push(e) });
	tc.after(() => gate.close());
	const port = (gate.address() as net.AddressInfo).port;
	const transports: Array<{ close(): void }> = [];
	tc.after(() => transports.forEach((t) => t.close()));
	const transport = (ip: string) => { const t = socketTransport({ host: "127.0.0.1", port }, { localAddress: ip }); transports.push(t); return t; };
	const client = (ip: string, o: Partial<ConstructorParameters<typeof RemoteSpace>[1]> = {}) =>
		new RemoteSpace(transport(ip), { attempts: 2, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 3_000, ...o });
	const withKey = (peerId: string, algorithm: "ed25519" | "ecdsa-p256", roles: string[], keyId = `k-${algorithm}`) => {
		const k = generateKey(algorithm, keyId);
		keys.add({ peerId, keyId, principal: `agent of ${peerId}`, algorithm, publicKey: k.publicKey, roles, state: "active" });
		return k.signer;
	};
	return { clock, keys, gate, events, client, transport, withKey, peers, port };
}
const admin = (signer: Signer, extra: Partial<ConstructorParameters<typeof RemoteSpace>[1]> = {}) => ({ signer, expectedGateHostId: "host-1", ownPeerId: "p-admin", ...extra });

test("without a proof only the A-only roles remain: a member works, the withheld admin role says ProofRequired", async (tc) => {
	const g = await setup(tc);
	const host = g.client("127.0.0.2");
	assert.equal(await host.count(), 0, "a member needs no key");
	await assert.rejects(host.write({ type: "Job", fields: {} }, null, FOREVER), core.PermissionError, "a plain member may not write here");
	const a = g.client("127.0.0.3");
	assert.deepEqual((await a.info()).roles, ["member"], "the admin role of the group is withheld");
	await assert.rejects(a.write({ type: "Job", fields: {} }, null, FOREVER), (e: unknown) => e instanceof RemoteError && e.code === "ProofRequired");
	assert.equal(g.gate.peers().find((p) => p.peerId === "p-admin")?.proven, false);
});

test("with a proof the roles are the intersection of groups and key: Ed25519 and ECDSA P-256", async (tc) => {
	const g = await setup(tc);
	for (const algorithm of ["ed25519", "ecdsa-p256"] as const) {
		const signer = g.withKey("p-admin", algorithm, ["admin", "member"]);
		const a = g.client("127.0.0.3", admin(signer));
		const lease = await a.write({ type: "Job", fields: { by: algorithm } }, null, FOREVER); // proves by itself on ProofRequired
		assert.ok(lease.id);
		assert.equal(g.gate.peers().filter((p) => p.peerId === "p-admin" && p.proven).length >= 1, true);
	}
	assert.equal(await g.client("127.0.0.2").count({ type: "Job" }), 2);
});

test("neither side can add roles: a key of fewer roles, or a group of fewer roles, grants less", async (tc) => {
	const g = await setup(tc);
	const memberKey = g.withKey("p-admin", "ed25519", ["member"], "k-member"); // the key does not say admin
	const a = g.client("127.0.0.3", admin(memberKey));
	await a.authenticate();
	await assert.rejects(a.write({ type: "Job", fields: {} }, null, FOREVER), (e: unknown) => e instanceof core.PermissionError, "the group says admin, the key does not");
	const adminKey = g.withKey("p-host", "ed25519", ["admin", "member"], "k-too-much"); // the key says admin, p-host's groups do not
	const h = g.client("127.0.0.2", { signer: adminKey, expectedGateHostId: "host-1", ownPeerId: "p-host" });
	await h.authenticate();
	await assert.rejects(h.write({ type: "Job", fields: {} }, null, FOREVER), (e: unknown) => e instanceof core.PermissionError, "the key says admin, the groups do not");
	assert.equal(await h.count(), 0);
});

test("wrong proofs are refused: unknown key, another peer's key, other connection's challenge, replay, expiry, revoked key", async (tc) => {
	const g = await setup(tc);
	const good = g.withKey("p-admin", "ed25519", ["admin", "member"], "k-good");
	const other = generateKey("ed25519", "k-good"); // same id, other private key
	const call = async (r: RemoteSpace, method: string, args: Record<string, unknown>) => {
		try { return { ok: true as const, result: await (r as unknown as { send(c: unknown): Promise<unknown> }).send({ method, args }) }; } catch (e) { return { ok: false as const, error: e as Error }; }
	};
	const a = g.client("127.0.0.3");
	await a.info();
	const ch = (await call(a, "challenge", { protocol: 1 })) as { ok: true; result: Record<string, unknown> };
	assert.equal(ch.ok, true);
	const { expiresAt, ...challenge } = ch.result;
	assert.ok((expiresAt as number) - (challenge.issuedAt as number) === 30_000);
	const { signedBytes } = await import("./src/index.ts");
	const sig = (s: Signer) => async () => Buffer.from(await s.sign(signedBytes(challenge as never))).toString("base64");
	// a signature made with another private key
	let r = await call(a, "prove", { keyId: "k-good", signature: await sig(other.signer)(), challenge });
	assert.ok(!r.ok && /does not match/.test(r.error.message), String(!r.ok && r.error.message));
	// the challenge is spent by a failed attempt: even the right signature is refused afterwards
	r = await call(a, "prove", { keyId: "k-good", signature: await sig(good)(), challenge });
	assert.ok(!r.ok && /no open challenge/.test(r.error.message));
	// fresh challenge: an unknown key id
	const fresh = async (c: RemoteSpace) => { const x = (await call(c, "challenge", { protocol: 1 })) as { ok: true; result: Record<string, unknown> }; const { expiresAt: _e, ...v } = x.result; return v; };
	let v = await fresh(a);
	r = await call(a, "prove", { keyId: "k-nope", signature: "AAAA", challenge: v });
	assert.ok(!r.ok && /unknown key/.test(r.error.message));
	// a challenge issued on another connection is not valid here
	const b = g.client("127.0.0.3");
	await b.info();
	const vb = await fresh(b);
	v = await fresh(a);
	r = await call(a, "prove", { keyId: "k-good", signature: Buffer.from(await good.sign(signedBytes(vb as never))).toString("base64"), challenge: vb });
	assert.ok(!r.ok && /not the challenge issued on this connection/.test(r.error.message));
	// the right key of another peer: bound to p-admin, used from p-other
	const c = g.client("127.0.0.4");
	await c.info();
	const vc = await fresh(c);
	r = await call(c, "prove", { keyId: "k-good", signature: Buffer.from(await good.sign(signedBytes(vc as never))).toString("base64"), challenge: vc });
	assert.ok(!r.ok && /unknown key for this peer/.test(r.error.message));
	// expiry
	const d = g.client("127.0.0.3");
	await d.info();
	const vd = await fresh(d);
	g.clock.t += 31_000;
	r = await call(d, "prove", { keyId: "k-good", signature: Buffer.from(await good.sign(signedBytes(vd as never))).toString("base64"), challenge: vd });
	assert.ok(!r.ok && /expired/.test(r.error.message));
	// the real thing works, once; a replay of the same proof does not
	const e = g.client("127.0.0.3");
	await e.info();
	const ve = await fresh(e);
	const goodSig = Buffer.from(await good.sign(signedBytes(ve as never))).toString("base64");
	r = await call(e, "prove", { keyId: "k-good", signature: goodSig, challenge: ve });
	assert.ok(r.ok);
	r = await call(e, "prove", { keyId: "k-good", signature: goodSig, challenge: ve });
	assert.ok(!r.ok && /no open challenge/.test(r.error.message), "a nonce is used once");
	// a revoked key
	g.keys.revoke("p-admin", "k-good");
	const f = g.client("127.0.0.3");
	await f.info();
	const vf = await fresh(f);
	r = await call(f, "prove", { keyId: "k-good", signature: Buffer.from(await good.sign(signedBytes(vf as never))).toString("base64"), challenge: vf });
	assert.ok(!r.ok && /revoked/.test(r.error.message));
	assert.ok(g.events.length > 0);
});

test("the client signs only for the host and the peer it means: a relayed or foreign challenge is not answered", async (tc) => {
	const g = await setup(tc);
	let signed = 0;
	const real = generateKey("ed25519", "k-1");
	g.keys.add({ peerId: "p-admin", keyId: "k-1", principal: "x", algorithm: "ed25519", publicKey: real.publicKey, roles: ["admin", "member"], state: "active" });
	const counting: Signer = { keyId: "k-1", algorithm: "ed25519", sign: (d) => { signed++; return real.signer.sign(d); } };
	// the wrong host: another gate answers
	const wrongHost = g.client("127.0.0.3", { signer: counting, expectedGateHostId: "host-2", ownPeerId: "p-admin" });
	await assert.rejects(wrongHost.write({ type: "Job", fields: {} }, null, FOREVER), (e: unknown) => e instanceof RemoteError && e.code === "AuthorityMismatch" && /not from host-2/.test(e.message));
	// the host saw another peer on the connection: the challenge was meant for someone else
	const relayed = g.client("127.0.0.4", { signer: counting, expectedGateHostId: "host-1", ownPeerId: "p-admin" }); // arrives from p-other
	await assert.rejects(relayed.write({ type: "Job", fields: {} }, null, FOREVER), (e: unknown) => e instanceof RemoteError && e.code === "AuthorityMismatch" && /not p-admin/.test(e.message));
	assert.equal(signed, 0, "nothing was signed");
	assert.throws(() => new RemoteSpace({ request: async () => "" } as Transport, { signer: counting }), core.IllegalArgumentError);
});

test("an open proven connection ends when its key is revoked, and the failure count ends a guessing connection", async (tc) => {
	const g = await setup(tc);
	const signer = g.withKey("p-admin", "ed25519", ["admin", "member"], "k-live");
	const a = g.client("127.0.0.3", admin(signer));
	await a.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
	assert.equal(g.gate.peers().some((p) => p.proven), true);
	g.keys.revoke("p-admin", "k-live");
	g.clock.t += 1_000;
	assert.ok((await g.gate.revalidate()) >= 1);
	assert.ok(g.events.some((e) => e.event === "revoked" && /key of this connection was revoked/.test(e.reason ?? "")), JSON.stringify(g.events));
	// guessing: five wrong proofs on one connection, then nothing more is tried
	const guesser = g.client("127.0.0.3");
	await guesser.info();
	const send = (guesser as unknown as { send(c: unknown): Promise<unknown> }).send.bind(guesser);
	const messages: string[] = [];
	for (let i = 0; i < 7; i++) {
		try { const c = (await send({ method: "challenge", args: { protocol: 1 } })) as Record<string, unknown>; const { expiresAt: _e, ...v } = c; await send({ method: "prove", args: { keyId: "k-live", signature: "AAAA", challenge: v } }); }
		catch (e) { messages.push((e as Error).message); }
	}
	assert.ok(messages.some((m) => /too many wrong proofs/.test(m)), messages.join(" | "));
});

for (const algorithm of ['ed25519','ecdsa-p256'] as const)
test(`concurrent RemoteSpace instances share one transport without replacing ${algorithm} challenges`, async tc => {
 const g=await setup(tc),base=g.withKey('p-admin',algorithm,['admin','member'],'shared-'+algorithm),transport=g.transport('127.0.0.3');
 const delayed:Signer={...base,sign:async bytes=>{await new Promise(r=>setTimeout(r,10));return base.sign(bytes);}};
 const clients=Array.from({length:8},()=>new RemoteSpace(transport,{...admin(delayed),attempts:1}));
 const replies=await Promise.all(clients.map(c=>c.authenticate()));
 assert.ok(replies.every(r=>r.keyId===base.keyId));for(const r of replies)assert.deepEqual(r.roles,['admin','member']);
 assert.equal(await clients[0]!.count(),0);
});

test('a rejected shared-transport proof releases the next authentication and preserves host pinning',async tc=>{
 const g=await setup(tc),good=g.withKey('p-admin','ed25519',['admin','member'],'queue-good'),other=generateKey('ed25519','queue-good'),transport=g.transport('127.0.0.3');
 const wrongHost=new RemoteSpace(transport,{...admin(good),expectedGateHostId:'foreign-host',attempts:1});
 const badKey=new RemoteSpace(transport,{...admin(other.signer),attempts:1}),valid=new RemoteSpace(transport,{...admin(good),attempts:1});
 const replies=await Promise.allSettled([wrongHost.authenticate(),badKey.authenticate(),valid.authenticate()]);
 assert.equal(replies[0]!.status,'rejected');if(replies[0]!.status==='rejected')assert.equal(replies[0]!.reason.code,'AuthorityMismatch');
 assert.equal(replies[1]!.status,'rejected');if(replies[1]!.status==='rejected')assert.ok(replies[1]!.reason instanceof core.PermissionError);
 assert.equal(replies[2]!.status,'fulfilled');assert.equal(await valid.count(),0);
});

test('an unfinished authentication does not block another transport',async tc=>{
 const g=await setup(tc),base=g.withKey('p-admin','ed25519',['admin','member'],'parallel-transports');
 let started!:()=>void,release!:()=>void;const signing=new Promise<void>(r=>{started=r;}),resume=new Promise<void>(r=>{release=r;});
 const delayed:Signer={...base,sign:async bytes=>{started();await resume;return base.sign(bytes);}};
 const first=g.client('127.0.0.3',admin(delayed)),second=g.client('127.0.0.3',admin(base));
 const pending=first.authenticate();await signing;
 try{assert.equal((await second.authenticate()).keyId,base.keyId);}finally{release();await pending;}
});
