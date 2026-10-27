// The socket transport: RemoteSpace talking to a SpaceService through a real unix socket and a TCP port on loopback.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpaceService, StaticIdentity, RemoteSpace, serveSpace, socketTransport, startService, PhiSpaces, FOREVER, core, type Connection } from "../src/index.ts";
import { ctx } from "./support/persistent.ts";
import { openTestHost } from "./support/host.ts";

const ids = new StaticIdentity({ "peer-a": { principal: { peerId: "peer-a", agentId: "w1" }, roles: ["member"] }, "peer-obs": { principal: { peerId: "peer-obs" }, roles: ["observer"] } });
const memory = () => openTestHost(ctx);
const sock = () => { const dir = mkdtempSync(join(tmpdir(), "phi-spaces-sock-")); return { dir, path: join(dir, "space.sock"), done: () => rmSync(dir, { recursive: true, force: true }) }; };
// A failing assertion must not leave a listening server behind (the run would hang instead of failing).
const serve = async (t: TestContext, ...a: Parameters<typeof serveSpace>) => { const s = await serveSpace(...a); t.after(() => s.close().catch(() => {})); return s; };
const fast = { sleep: () => Promise.resolve(), backoffMs: 1, attempts: 20 };
const asPeer = (peerId: string) => (): Connection => ({ peerId });

test("RemoteSpace over a unix socket: private file, whole contract, cleaned up on close", async (tc) => {
	const h = await memory(); const f = sock();
	const server = await serve(tc, new SpaceService({ host: h, ctx, identity: ids }), { listen: { path: f.path }, connection: asPeer("peer-a") });
	assert.equal(statSync(f.path).mode & 0o777, 0o600, "only the owner may connect");
	const t = socketTransport({ path: f.path });
	const r = new RemoteSpace(t, fast);
	assert.equal((await r.info()).principal, "peer-a/w1");
	await r.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
	await r.write({ type: "Job", fields: { n: 2 } }, null, FOREVER);
	assert.equal(await r.count({ type: "Job" }), 2);
	assert.equal((await r.take({ type: "Job", fields: { n: 2 } }, 0))?.fields.n, 2);
	const tx = await r.createTransaction(60_000);
	await r.write({ type: "Job", fields: { n: 3 } }, tx.id, FOREVER);
	await r.commit(tx.id);
	assert.deepEqual((await r.readAll({ type: "Job" })).map((e) => e.fields.n), [1, 3]);
	t.close(); await server.close();
	assert.ok(!existsSync(f.path), "the socket file is removed");
	f.done();
});

test("many calls at once on one connection are matched to their replies by id", async (tc) => {
	const h = await memory(); const f = sock();
	const server = await serve(tc, new SpaceService({ host: h, ctx, identity: ids }), { listen: { path: f.path }, connection: asPeer("peer-a") });
	const r = new RemoteSpace(socketTransport({ path: f.path }), fast);
	await r.info();
	await Promise.all(Array.from({ length: 24 }, (_, i) => r.write({ type: "Job", fields: { i } }, null, FOREVER)));
	assert.equal(await r.count({ type: "Job" }), 24);
	const seen = await Promise.all(Array.from({ length: 24 }, () => r.take({ type: "Job" }, 0)));
	assert.deepEqual(seen.map((e) => e!.fields.i as number).sort((a, b) => a - b), Array.from({ length: 24 }, (_, i) => i));
	await server.close(); f.done();
});

test("a connection that dies after the host acted: the retry on a fresh connection finds the stored result", async (tc) => {
	const h = await memory(); const f = sock();
	const real = new SpaceService({ host: h, ctx, identity: ids });
	let killNext = 0; let killed = 0;
	const sockets: net.Socket[] = [];
	const server = await serve(tc, 
		{ handleText: async (text, conn, max) => { const r = await real.handleText(text, conn, max); if (killNext > 0 && JSON.parse(text).method === "write") { killNext--; killed++; sockets.forEach((s) => s.destroy()); await new Promise((x) => setTimeout(x, 20)); } return r; } },
		{ listen: { path: f.path }, connection: (s) => { sockets.push(s); return { peerId: "peer-a" }; } },
	);
	const r = new RemoteSpace(socketTransport({ path: f.path }), fast);
	await r.info();
	killNext = 3;
	for (let i = 0; i < 5; i++) await r.write({ type: "Job", fields: { i } }, null, FOREVER);
	assert.equal(killed, 3);
	assert.equal(await r.count({ type: "Job" }), 5, "five writes, five entries, although three answers were lost with their connection");
	await server.close(); f.done();
});

test("identity comes from the server's connection callback; unknown peers are refused by the service", async (tc) => {
	const h = await memory(); const f = sock();
	const server = await serve(tc, new SpaceService({ host: h, ctx, identity: ids }), { listen: { path: f.path }, connection: asPeer("peer-obs") });
	const r = new RemoteSpace(socketTransport({ path: f.path }), fast);
	await assert.rejects(r.write({ type: "Job", fields: {} }, null, FOREVER), core.PermissionError);
	assert.equal(await r.count(), 0);
	await server.close(); f.done();
	const f2 = sock();
	const open = await serve(tc, new SpaceService({ host: h, ctx, identity: ids }), { listen: { path: f2.path } }); // no connection callback: nobody known
	await assert.rejects(new RemoteSpace(socketTransport({ path: f2.path }), fast).count(), (e: { code?: string }) => e.code === "Unauthenticated");
	await open.close(); f2.done();
});

test("limits: an oversized frame ends the connection, too many connections are refused, idle ones are closed", async (tc) => {
	const h = await memory(); const f = sock();
	const server = await serve(tc, new SpaceService({ host: h, ctx, identity: ids }), { listen: { path: f.path }, connection: asPeer("peer-a"), maxFrameBytes: 2_000, maxConnections: 2, idleMs: 300 });
	const closed = (s: net.Socket) => new Promise<void>((r) => s.once("close", () => r()));
	const connect = () => new Promise<net.Socket>((res, rej) => { const s = net.createConnection(f.path); s.once("connect", () => res(s)); s.once("error", rej); });
	// oversized: announce 1 MB
	const bad = await connect();
	const header = Buffer.alloc(8); header.writeUInt32BE(1_000_000, 0); header.writeUInt32BE(1, 4);
	bad.write(header);
	await closed(bad);
	// the server is fine: two connections are allowed, a third is closed at once
	const c1 = await connect(); const c2 = await connect();
	for (let i = 0; i < 50 && server.connections() < 2; i++) await new Promise((r) => setTimeout(r, 10));
	assert.equal(server.connections(), 2);
	const c3 = await connect();
	await closed(c3);
	// idle: both close after the idle time
	await Promise.all([closed(c1), closed(c2)]);
	for (let i = 0; i < 50 && server.connections() > 0; i++) await new Promise((r) => setTimeout(r, 10)); // the server learns of a close a moment later
	assert.equal(server.connections(), 0);
	// a client whose own frame limit is larger than the server's gets the answer ResourceExhausted... or a closed connection, never a hang
	const r = new RemoteSpace(socketTransport({ path: f.path }, { maxFrameBytes: 1_000_000 }), { ...fast, attempts: 2 });
	await assert.rejects(r.write({ type: "Job", fields: { pad: "z".repeat(5_000) } }, null, FOREVER));
	await server.close(); f.done();
});

test("the client reconnects after the host restarted, and a TCP port on loopback works the same", async (tc) => {
	const h = await memory(); const f = sock();
	const svc = new SpaceService({ host: h, ctx, identity: ids });
	let server = await serve(tc, svc, { listen: { path: f.path }, connection: asPeer("peer-a") });
	const r = new RemoteSpace(socketTransport({ path: f.path }), { ...fast, sleep: (ms) => new Promise((x) => setTimeout(x, Math.min(ms, 20))) });
	await r.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
	await server.close();
	server = await serve(tc, svc, { listen: { path: f.path }, connection: asPeer("peer-a") });
	await r.write({ type: "Job", fields: { n: 2 } }, null, FOREVER);
	assert.equal(await r.count({ type: "Job" }), 2);
	await server.close(); f.done();
	const tcp = await serve(tc, svc, { listen: { host: "127.0.0.1", port: 0 }, connection: asPeer("peer-a") });
	const port = (tcp.address() as net.AddressInfo).port;
	const rt = new RemoteSpace(socketTransport({ host: "127.0.0.1", port }), fast);
	assert.equal(await rt.count({ type: "Job" }), 2);
	await rt.write({ type: "Job", fields: { n: 3 } }, null, FOREVER);
	assert.equal(await new PhiSpaces(h, ctx).count({ type: "Job" }), 3);
	await tcp.close();
});

test("a call without an answer fails after requestTimeoutMs; the next call gets a fresh connection, a late answer is dropped", async (tc) => {
	const s = sock(); tc.after(s.done);
	let first = true, release: (v: string) => void = () => {}, connections = 0;
	await serve(tc, { handleText: (text: string) => first ? (first = false, new Promise<string>(r => { release = r; })) : Promise.resolve("answer:" + text) }, { listen: { path: s.path }, connection: () => { connections++; return {}; } });
	const t = socketTransport({ path: s.path }, { requestTimeoutMs: 100 }); tc.after(() => t.close());
	const started = Date.now();
	await assert.rejects(t.request("stuck"), /request timed out/);
	assert.ok(Date.now() - started < 2000);
	release("late");
	assert.equal(await t.request("next"), "answer:next");
	assert.equal(connections, 2, "the stuck connection was dropped");
	const unbounded = socketTransport({ path: s.path }); tc.after(() => unbounded.close());
	assert.equal(await unbounded.request("plain"), "answer:plain");
});

test("a blocking call and a change poll end at the commit that serves them, not at a polling interval", async (tc) => {
	const h = await memory(); const f = sock();
	const stopService = await startService(h, ctx);
	tc.after(() => stopService());
	await serve(tc, new SpaceService({ host: h, ctx, identity: ids }), { listen: { path: f.path }, connection: asPeer("peer-a") });
	const t = socketTransport({ path: f.path });
	tc.after(() => { t.close(); f.done(); });
	const a = new RemoteSpace(t, fast), b = new RemoteSpace(t, fast);
	const median = (xs: number[]) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
	const takes: number[] = [], polls: number[] = [];
	for (let i = 0; i < 7; i++) {
		const waiting = b.take({ type: "Wake", fields: { i } }, 5_000);
		await new Promise((r) => setTimeout(r, 30));
		await a.write({ type: "Wake", fields: { i } }, null, FOREVER);
		const written = performance.now();
		assert.ok(await waiting);
		takes.push(performance.now() - written);
		const rev = (await a.readPage({ type: "-" })).rev;
		const polled = (a.changes as (r: number, o: { waitMs: number }) => Promise<{ batches: unknown[] }>)(rev, { waitMs: 5_000 });
		await new Promise((r) => setTimeout(r, 30));
		await a.write({ type: "Seen", fields: { i } }, null, FOREVER);
		const seen = performance.now();
		assert.ok((await polled).batches.length > 0);
		polls.push(performance.now() - seen);
	}
	// the service looked every 50 ms before: a median of about 25 ms after the commit
	assert.ok(median(takes) < 15, `blocking take: ${takes.map(Math.round)} ms after the write`);
	assert.ok(median(polls) < 15, `change poll: ${polls.map(Math.round)} ms after the write`);
});
