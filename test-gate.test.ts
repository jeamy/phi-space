// AP 1b.2 / layer A: the gate resolves the overlay address of a connection to a NetBird peer and its groups.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { SpaceService, RemoteSpace, socketTransport, startGate, NetbirdDirectory, GateIdentity, FOREVER, core, type Gate, type GateOptions } from "./src/index.ts";
import { ctx } from "./test/support/persistent.ts";

type Peer = { id: string; name: string; ip: string; connected: boolean; groups: Array<{ id: string; name: string }> };
const peer = (id: string, ip: string, groups: string[]): Peer => ({ id, name: id, ip, connected: true, groups: groups.map((g) => ({ id: `g-${g}`, name: g })) });

/** A stand-in for the management API: a list of peers, counters, and failure modes. */
class Management {
	peers: Peer[] = [];
	requests = 0;
	status = 200;
	delayMs = 0;
	lastAuth = "";
	server = http.createServer((req, res) => {
		this.requests++;
		this.lastAuth = String(req.headers.authorization ?? "");
		setTimeout(() => {
			if (req.url !== "/api/peers") { res.statusCode = 404; res.end("{}"); return; }
			res.statusCode = this.status;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify(this.status === 200 ? this.peers : { message: "boom" }));
		}, this.delayMs);
	});
	url = "";
	async start(tc: TestContext) {
		await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
		this.url = `http://127.0.0.1:${(this.server.address() as net.AddressInfo).port}`;
		tc.after(() => { this.server.closeAllConnections(); this.server.close(); });
		return this;
	}
}
const memory = () => Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, ctx);
class Clock { t = 1_000_000; now = () => this.t; }

async function setup(tc: TestContext, o: Partial<GateOptions> = {}, dirOpts: { cacheMs?: number } = {}) {
	const mgmt = await new Management().start(tc);
	mgmt.peers = [
		peer("p-host", "127.0.0.2", ["space-hosts"]),
		peer("p-admin", "127.0.0.3", ["space-admin", "space-hosts"]),
		peer("p-obs", "127.0.0.4", ["space-observer"]),
		peer("p-nogroup", "127.0.0.5", ["something-else"]),
		peer("p-both", "127.0.0.7", ["space-hosts", "space-observer"]),
	];
	const clock = new Clock();
	const directory = new NetbirdDirectory({ url: mgmt.url, token: "secret-token", now: clock.now, ...dirOpts });
	const h = await memory();
	const service = new SpaceService({ host: h, ctx, identity: new GateIdentity() });
	const events: Array<{ event: string; ip: string; peerId?: string; reason?: string }> = [];
	const gate = await startGate(service, { listen: { host: "127.0.0.1", port: 0 }, directory, revalidateMs: 0, now: clock.now, onEvent: (e) => events.push(e), ...o });
	tc.after(() => gate.close());
	const port = (gate.address() as net.AddressInfo).port;
	const as = (ip: string, attempts = 2) => new RemoteSpace(socketTransport({ host: "127.0.0.1", port }, { localAddress: ip }), { attempts, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 3_000 });
	return { mgmt, clock, directory, gate, events, as, port, h };
}

test("the peer behind the address decides: roles come from its groups, the principal is its peer id", async (tc) => {
	const g = await setup(tc);
	const host = g.as("127.0.0.2");
	const hello = await host.info();
	assert.equal(hello.principal, "p-host");
	assert.deepEqual(hello.roles, ["member"]);
	await host.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
	assert.equal(await host.count({ type: "Job" }), 1);
	assert.deepEqual((await g.as("127.0.0.3").info()).roles, ["member"], "admin is withheld until a key is proven (layer B)");
	const obs = g.as("127.0.0.4");
	assert.deepEqual((await obs.info()).roles, ["observer"]);
	assert.equal(await obs.count({ type: "Job" }), 1, "an observer reads");
	await assert.rejects(obs.write({ type: "Job", fields: {} }, null, FOREVER), core.PermissionError);
	assert.deepEqual((await g.as("127.0.0.7").info()).roles, ["member", "observer"], "the union over the groups");
	assert.equal(g.mgmt.lastAuth, "Token secret-token");
});

test("no peer, or no group that grants a role: no access at all, and the refusals are reported", async (tc) => {
	const g = await setup(tc);
	await assert.rejects(g.as("127.0.0.5").count()); // a peer in an unrelated group
	await assert.rejects(g.as("127.0.0.6").count()); // an address nobody owns
	const reasons = g.events.filter((e) => e.event === "refused").map((e) => e.reason);
	assert.ok(reasons.some((r) => r?.includes("no group")), JSON.stringify(reasons));
	assert.ok(reasons.some((r) => r?.includes("no peer owns")), JSON.stringify(reasons));
	assert.equal(g.gate.peers().length, 0);
});

test("the directory answer is cached: many connections, one request; stale after the cache time", async (tc) => {
	const g = await setup(tc);
	const clients = Array.from({ length: 8 }, () => g.as("127.0.0.2"));
	await Promise.all(clients.map((c) => c.count()));
	assert.equal(g.directory.requests, 1);
	g.clock.t += 30_000;
	await g.as("127.0.0.3").count();
	assert.equal(g.directory.requests, 1, "still within the 60 s");
	g.clock.t += 31_000;
	await g.as("127.0.0.3").count();
	assert.equal(g.directory.requests, 2, "refreshed once it is older than the cache time");
	assert.throws(() => new NetbirdDirectory({ url: g.mgmt.url, token: "t", cacheMs: 0 }));
	const capped = new NetbirdDirectory({ url: g.mgmt.url, token: "t", cacheMs: 600_000 });
	await capped.lookup("127.0.0.2");
	g.clock.t += 0; // the cache time can never exceed 60 s, whatever is asked
	assert.ok((capped as unknown as { o: { cacheMs: number } }).o.cacheMs <= 60_000);
});

test("management API down: the cache serves for its lifetime, then new connections are refused; they work again afterwards", async (tc) => {
	const g = await setup(tc);
	await g.as("127.0.0.2").count(); // fills the cache
	g.mgmt.status = 503;
	g.clock.t += 20_000;
	assert.equal(await g.as("127.0.0.2").count(), 0, "served from a 20 s old answer");
	g.clock.t += 45_000; // the answer is 65 s old now and cannot be renewed
	await assert.rejects(g.as("127.0.0.2").count());
	assert.ok(g.events.some((e) => e.event === "refused" && e.reason?.includes("management API")), JSON.stringify(g.events));
	g.mgmt.status = 200;
	assert.equal(await g.as("127.0.0.2").count(), 0, "and back to normal");
});

test("revalidation closes the connections of a peer that lost its roles or vanished; others stay", async (tc) => {
	const g = await setup(tc);
	const a = g.as("127.0.0.2", 1);
	const b = g.as("127.0.0.3", 1);
	await a.count(); await b.count();
	assert.equal(g.gate.peers().length, 2);
	g.mgmt.peers = g.mgmt.peers.map((p) => (p.id === "p-host" ? { ...p, groups: [] } : p));
	g.clock.t += 1_000;
	assert.equal(await g.gate.revalidate(), 1);
	assert.deepEqual(g.gate.peers().map((p) => p.peerId), ["p-admin"]);
	await assert.rejects(a.count(), "the old connection is gone and a new one is refused");
	assert.equal(await b.count(), 0, "an unaffected peer keeps working");
	g.mgmt.peers = g.mgmt.peers.filter((p) => p.id !== "p-admin"); // the peer is removed
	assert.equal(await g.gate.revalidate(), 1);
	await assert.rejects(b.count());
	const revoked = g.events.filter((e) => e.event === "revoked").map((e) => e.reason);
	assert.deepEqual(revoked, ["the roles of the peer changed", "the peer is gone"]);
	// roles that change without disappearing also end the connection (the new roles apply to the next one)
	g.mgmt.peers = [...g.mgmt.peers, peer("p-admin", "127.0.0.3", ["space-hosts"])];
	g.clock.t += 61_000; // the cached list does not know the peer yet
	const again = g.as("127.0.0.3", 1);
	await again.count();
	g.mgmt.peers = g.mgmt.peers.map((p) => (p.id === "p-admin" ? { ...p, groups: [{ id: "g", name: "space-observer" }] } : p));
	assert.equal(await g.gate.revalidate(), 1);
});

test("a peer that is not identified within the handshake time is closed; a slow API does not hold the gate", async (tc) => {
	const g = await setup(tc, { handshakeMs: 150 });
	g.mgmt.delayMs = 600;
	await assert.rejects(g.as("127.0.0.2", 1).count());
	assert.ok(g.events.some((e) => e.reason?.includes("not identified in time")), JSON.stringify(g.events));
	g.mgmt.delayMs = 0;
	await new Promise((r) => setTimeout(r, 700)); // the slow refresh is still in flight and is shared by the next lookup
	assert.equal(await g.as("127.0.0.2").count(), 0);
});

test("connections per peer and new connections per second are limited", async (tc) => {
	const g = await setup(tc, { maxConnectionsPerPeer: 2, connectionsPerSecondPerPeer: 100 });
	const raw = (ip: string) => new Promise<net.Socket>((res, rej) => { const s = net.createConnection({ host: "127.0.0.1", port: g.port, localAddress: ip }); s.once("connect", () => res(s)); s.once("error", rej); });
	const closed = (s: net.Socket) => new Promise<void>((r) => s.once("close", () => r()));
	// a connection is identified when its first frame arrives: send an empty hello-ish frame so the gate resolves the peer
	const knock = (s: net.Socket) => { const body = Buffer.from(JSON.stringify({ method: "hello", args: { protocol: 1 } })); const h = Buffer.alloc(8); h.writeUInt32BE(body.length, 0); h.writeUInt32BE(1, 4); s.write(Buffer.concat([h, body])); };
	const c1 = await raw("127.0.0.2"); knock(c1);
	const c2 = await raw("127.0.0.2"); knock(c2);
	for (let i = 0; i < 100 && g.gate.peers().length < 2; i++) await new Promise((r) => setTimeout(r, 10));
	const c3 = await raw("127.0.0.2"); knock(c3);
	await closed(c3);
	assert.equal(g.gate.peers().length, 2);
	assert.ok(g.events.some((e) => e.reason?.includes("already 2 connections")));
	const other = await raw("127.0.0.3"); knock(other);
	await new Promise((r) => setTimeout(r, 100));
	assert.ok(!other.destroyed, "another peer has its own count");
	for (const s of [c1, c2, other]) s.destroy();
	const slow = await setup(tc, { connectionsPerSecondPerPeer: 2, maxConnectionsPerPeer: 50 });
	const refusals = async () => {
		const out: boolean[] = [];
		for (let i = 0; i < 4; i++) { try { await slow.as("127.0.0.2", 1).count(); out.push(true); } catch { out.push(false); } }
		return out;
	};
	assert.deepEqual(await refusals(), [true, true, false, false], "a bucket of two, no time passing");
});

test("the gate refuses to listen on a wildcard address", async (tc) => {
	const mgmt = await new Management().start(tc);
	const service = new SpaceService({ host: await memory(), ctx, identity: new GateIdentity() });
	const directory = new NetbirdDirectory({ url: mgmt.url, token: "t" });
	for (const host of ["0.0.0.0", "::", ""]) await assert.rejects(startGate(service, { listen: { host, port: 0 }, directory }), /overlay address only/);
});
