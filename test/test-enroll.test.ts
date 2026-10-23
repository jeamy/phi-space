// AP 1b.4: pairing (federation-plan-v3.md 4.5): tokens, the enroll RPC, bootstrap, limits.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import {
	SpaceService, RemoteSpace, RemoteError, socketTransport, startGate, NetbirdDirectory, GateIdentity, ProvingService, EnrollmentService, SpaceKeyDirectory, generateKey,
	createEnroll, bootstrapEnroll, revokePeerKey, newEnrollToken, hashToken, enrollQr, keyFingerprint, BootstrapClosed, CONTROL_SPACE, FOREVER, core, listSpaces, snapshotSpace, DEFAULT_POLICY,
	type Policy, type Signer,
} from "../src/index.ts";
import { ctx } from "./support/persistent.ts";
import { openTestHost, plainDoc } from "./support/host.ts";

type Peer = { id: string; name: string; ip: string; connected: boolean; groups: Array<{ id: string; name: string }> };
const peer = (id: string, ip: string, groups: string[]): Peer => ({ id, name: id, ip, connected: true, groups: groups.map((g) => ({ id: `g-${g}`, name: g })) });
class Clock { t = 1_700_000_000_000; now = () => this.t; }
const policy: Policy = DEFAULT_POLICY;

async function setup(tc: TestContext) {
	const peers: Peer[] = [
		peer("p-admin", "127.0.0.3", ["space-enroll"]),
		peer("p-host", "127.0.0.2", ["space-enroll"]),
		peer("p-stranger", "127.0.0.4", ["space-enroll"]),
		peer("p-member", "127.0.0.5", ["space-hosts"]),
	];
	const server = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(peers)); });
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	tc.after(() => { server.closeAllConnections(); server.close(); });
	const clock = new Clock();
	const directory = new NetbirdDirectory({ url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, token: "t", now: clock.now });
	const host = await openTestHost(ctx);
	const keys = new SpaceKeyDirectory(host, ctx, clock.now);
	const service = new SpaceService({ host, ctx, identity: new GateIdentity(), policy, hostId: "host-1" });
	const events: Array<{ peerId: string; outcome: string; keyId?: string }> = [];
	const front = new EnrollmentService(new ProvingService(service, { gateHostId: "host-1", keys, now: clock.now }), { host, ctx, now: clock.now, onEvent: (e) => events.push(e) });
	const gate = await startGate(front, { listen: { host: "127.0.0.1", port: 0 }, directory, keys, revalidateMs: 0, now: clock.now });
	tc.after(() => gate.close());
	const port = (gate.address() as net.AddressInfo).port;
	const transports: Array<{ close(): void }> = [];
	tc.after(() => transports.forEach((t) => t.close()));
	/** A device on the control space with the key it wants to enroll. */
	const device = (ip: string, peerId: string, signer: Signer, o: Record<string, unknown> = {}) => {
		const t = socketTransport({ host: "127.0.0.1", port }, { localAddress: ip });
		transports.push(t);
		return new RemoteSpace(t, { space: CONTROL_SPACE, attempts: 2, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 3_000, signer, expectedGateHostId: "host-1", ownPeerId: peerId, ...o });
	};
	const control = async () => { const info = (await listSpaces(host, ctx)).find((i) => i.alias === CONTROL_SPACE)!; return (await snapshotSpace(host, info.spaceId, ctx))!; };
	const entries = async (type: string) => core.list(await control(), clock.now(), { type }).map((e) => e.fields as Record<string, unknown>);
	return { host, clock, keys, gate, events, peers, device, control, entries, keysOf: keys };
}
const refused = (e: unknown) => e instanceof core.PermissionError && /enrollment refused/.test((e as Error).message);

test("bootstrap: the first admin is paired with a bound one-time token, the power ends with its use", async (tc) => {
	const g = await setup(tc);
	const token = newEnrollToken();
	assert.ok(Buffer.from(token, "base64url").length === 32, "256 bits");
	const rec = await bootstrapEnroll(g.host, ctx, { tokenHash: hashToken(token), allowedPeerId: "p-admin", now: g.clock.now });
	assert.equal(rec.role, "admin");
	assert.equal(rec.expiresAt - g.clock.now(), 5 * 60_000);
	const key = generateKey("ed25519", "ignored");
	const admin = g.device("127.0.0.3", "p-admin", key.signer);
	const res = await admin.enroll(token);
	assert.deepEqual({ role: res.role, peerId: res.peerId, keyId: res.keyId }, { role: "admin", peerId: "p-admin", keyId: keyFingerprint(key.publicKey) });
	const stored = await g.keys.find("p-admin", res.keyId);
	assert.ok(stored && stored.state === "active" && stored.publicKey === key.publicKey && stored.roles.join() === "admin");
	// a retry with a new connection proof and the same request identity: the stored answer, though the token is spent
	g.clock.t += 5_000;
	assert.deepEqual(await admin.enroll(token), res);
	assert.deepEqual((await g.entries("Enroll")).map((e) => e.state), ["consumed"]);
	// the bootstrap power is closed for good, also for a new hash
	await assert.rejects(bootstrapEnroll(g.host, ctx, { tokenHash: hashToken(newEnrollToken()), allowedPeerId: "p-admin", now: g.clock.now }), BootstrapClosed);
	assert.deepEqual((await g.entries("Bootstrap")).map((e) => e.state), ["closed"]);
	// the paired key is a layer-B key: with the admin group the device proves it and is admin
	g.peers[0] = peer("p-admin", "127.0.0.3", ["space-admin", "space-hosts"]);
	g.clock.t += 61_000;
	const same = new RemoteSpace(socketTransport({ host: "127.0.0.1", port: (g.gate.address() as net.AddressInfo).port }, { localAddress: "127.0.0.3" }), { attempts: 2, sleep: () => Promise.resolve(), backoffMs: 1, signer: { ...key.signer, keyId: res.keyId }, expectedGateHostId: "host-1", ownPeerId: "p-admin" });
	assert.deepEqual((await same.authenticate()).roles, ["admin"], "the enrolled key proves, and the key says admin");
	assert.ok(g.gate.peers().some((p) => p.proven && p.peerId === "p-admin"));
	assert.ok((await same.write({ type: "Job", fields: {} }, null, FOREVER)).id);
	assert.ok(JSON.parse(enrollQr({ endpoint: "tcp://host-b:7421", controlSpaceId: "sp-1", token })).token === token);
});

test("a lost bootstrap token is replaced while unused: the old hash is invalid", async (tc) => {
	const g = await setup(tc);
	const lost = newEnrollToken(), fresh = newEnrollToken();
	await bootstrapEnroll(g.host, ctx, { tokenHash: hashToken(lost), allowedPeerId: "p-admin", now: g.clock.now });
	await bootstrapEnroll(g.host, ctx, { tokenHash: hashToken(fresh), allowedPeerId: "p-admin", now: g.clock.now });
	assert.deepEqual((await g.entries("Enroll")).map((e) => e.state).sort(), ["invalid", "open"]);
	await assert.rejects(g.device("127.0.0.3", "p-admin", generateKey("ed25519", "k").signer).enroll(lost), refused);
	g.clock.t += 61_000;
	assert.equal((await g.device("127.0.0.3", "p-admin", generateKey("ed25519", "k").signer).enroll(fresh)).role, "admin");
});

test("hosts get bound one-time tokens and only the role host; an admin token only comes through the bootstrap", async (tc) => {
	const g = await setup(tc);
	await assert.rejects(createEnroll(g.host, ctx, { tokenHash: hashToken("x"), role: "admin", allowedPeerId: "p-host", now: g.clock.now }), core.IllegalArgumentError);
	await assert.rejects(createEnroll(g.host, ctx, { tokenHash: "not-a-hash", role: "host", allowedPeerId: "p-host", now: g.clock.now }), core.IllegalArgumentError);
	await assert.rejects(createEnroll(g.host, ctx, { tokenHash: hashToken("x"), role: "host", allowedPeerId: "", now: g.clock.now }), core.IllegalArgumentError);
	const token = newEnrollToken();
	const a = await createEnroll(g.host, ctx, { tokenHash: hashToken(token), role: "host", allowedPeerId: "p-host", scope: ["sieve"], ttlMs: 60 * 60_000, now: g.clock.now });
	assert.equal(a.expiresAt - g.clock.now(), 5 * 60_000, "never longer than 5 minutes");
	assert.deepEqual(await createEnroll(g.host, ctx, { tokenHash: hashToken(token), role: "host", allowedPeerId: "p-host", now: g.clock.now }), a, "idempotent");
	const res = await g.device("127.0.0.2", "p-host", generateKey("ecdsa-p256", "k").signer).enroll(token);
	assert.deepEqual([res.role, res.peerId, res.scope], ["host", "p-host", ["sieve"]]);
	assert.equal((await g.keys.find("p-host", res.keyId))?.algorithm, "ecdsa-p256");
});

test("the token is never stored, logged or shared: only its hash is in the control space, claims and events", async (tc) => {
	const g = await setup(tc);
	const token = newEnrollToken();
	await createEnroll(g.host, ctx, { tokenHash: hashToken(token), role: "host", allowedPeerId: "p-host", now: g.clock.now });
	const dev = g.device("127.0.0.2", "p-host", generateKey("ed25519", "k").signer);
	await dev.enroll(token);
	const everything = JSON.stringify(plainDoc([await g.control(), g.events])) + JSON.stringify(plainDoc(await snapshotSpace(g.host, (await listSpaces(g.host, ctx)).find((i) => i.alias === CONTROL_SPACE)!.spaceId, ctx)));
	assert.ok(!everything.includes(token), "the plain token is nowhere");
	assert.ok(everything.includes(hashToken(token)), "its hash is");
	const claims = JSON.stringify(plainDoc((await g.control()).rpc?.claims ?? {}));
	assert.ok(!claims.includes(token) && !claims.includes("signature"), "the claim keeps hashes, not the request");
});

test("the order of the checks: a wrong peer does not burn the token, wrong signatures do, three end it", async (tc) => {
	const g = await setup(tc);
	const token = newEnrollToken();
	await createEnroll(g.host, ctx, { tokenHash: hashToken(token), role: "host", allowedPeerId: "p-host", now: g.clock.now });
	const stranger = g.device("127.0.0.4", "p-stranger", generateKey("ed25519", "k").signer);
	await assert.rejects(stranger.enroll(token), refused);
	assert.equal((await g.entries("Enroll"))[0]!.attempts, 0, "another peer cannot burn the token");
	assert.equal((await g.entries("Enroll"))[0]!.state, "open");
	// the bound peer with a signature that is not made by the key it sends
	const real = generateKey("ed25519", "real"), other = generateKey("ed25519", "other");
	const lying: Signer = { ...other.signer, publicKey: real.publicKey };
	for (let i = 1; i <= 3; i++) {
		g.clock.t += 61_000;
		await assert.rejects(g.device("127.0.0.2", "p-host", lying).enroll(token), refused);
		assert.equal((await g.entries("Enroll"))[0]!.attempts, i);
	}
	assert.equal((await g.entries("Enroll"))[0]!.state, "invalid", "three failures: the token is dead");
	g.clock.t += 61_000;
	await assert.rejects(g.device("127.0.0.2", "p-host", real.signer).enroll(token), refused, "even the right key cannot use it now");
	assert.equal((await g.entries("PeerKey")).length, 0);
});

test("one attempt per peer and minute, bad keys and unknown tokens are refused alike, expired tokens are dead", async (tc) => {
	const g = await setup(tc);
	const token = newEnrollToken();
	await createEnroll(g.host, ctx, { tokenHash: hashToken(token), role: "host", allowedPeerId: "p-host", now: g.clock.now });
	const key = generateKey("ed25519", "k");
	const unknown = await g.device("127.0.0.2", "p-host", key.signer).enroll(newEnrollToken()).catch((e: Error) => e);
	assert.ok(refused(unknown));
	// the second attempt within the minute is limited, whatever it carries
	await assert.rejects(g.device("127.0.0.2", "p-host", key.signer).enroll(token), (e: unknown) => e instanceof core.ResourceExhausted);
	g.clock.t += 61_000;
	// a key of the wrong shape counts as a failed attempt
	const badShape: Signer = { ...key.signer, publicKey: Buffer.from("too short").toString("base64") };
	const wrongWorld = await g.device("127.0.0.2", "p-host", badShape).enroll(token).catch((e: Error) => e);
	assert.equal((wrongWorld as Error).message, (unknown as Error).message, "the same answer for every reason");
	assert.equal((await g.entries("Enroll"))[0]!.attempts, 1);
	g.clock.t += 6 * 60_000; // the token has run out
	await assert.rejects(g.device("127.0.0.2", "p-host", key.signer).enroll(token), refused);
	assert.equal((await g.entries("Enroll"))[0]!.state, "invalid");
	assert.deepEqual(g.events.map((e) => e.outcome), ["unknown-token", "rate-limited", "bad-key", "expired"]);
});

test("only unpaired peers may start enrollment; an unproven member cannot resolve it", async (tc) => {
	const g = await setup(tc);
	const token = newEnrollToken();
	await createEnroll(g.host, ctx, { tokenHash: hashToken(token), role: "host", allowedPeerId: "p-member", now: g.clock.now });
	await assert.rejects(g.device("127.0.0.5", "p-member", generateKey("ed25519", "k").signer).enroll(token), (e: unknown) => e instanceof core.PermissionError && /requires a current app-key proof/.test((e as Error).message));
	assert.equal((await g.entries("Enroll"))[0]!.state, "open");
});

test("enrollStatus tells a device the fate of its own request and nobody else's", async (tc) => {
	const g = await setup(tc);
	const token = newEnrollToken();
	await createEnroll(g.host, ctx, { tokenHash: hashToken(token), role: "host", allowedPeerId: "p-host", now: g.clock.now });
	const dev = g.device("127.0.0.2", "p-host", generateKey("ed25519", "k").signer);
	assert.equal((await dev.enrollStatus({ generation: "g-nothing", requestId: "r" })).state, "unknown");
	const res = await dev.enroll(token);
	const status = await dev.enrollStatus();
	assert.equal(status.state, "done");
	assert.equal((status.result as { keyId: string }).keyId, res.keyId);
	// another peer asking for that request id finds nothing
	const sneak = g.device("127.0.0.4", "p-stranger", generateKey("ed25519", "k").signer);
	const mine = (dev as unknown as { enrollRequest: { generation: string; requestId: string } }).enrollRequest;
	assert.equal((await sneak.enrollStatus(mine)).state, "unknown");
});

test("a revoked key ends its proven connection through the control space; the device cannot prove it again", async (tc) => {
	const g = await setup(tc);
	const token = newEnrollToken();
	await bootstrapEnroll(g.host, ctx, { tokenHash: hashToken(token), allowedPeerId: "p-admin", now: g.clock.now });
	const key = generateKey("ed25519", "k");
	const res = await g.device("127.0.0.3", "p-admin", key.signer).enroll(token);
	g.peers[0] = peer("p-admin", "127.0.0.3", ["space-admin", "space-hosts"]);
	g.clock.t += 61_000;
	const port = (g.gate.address() as net.AddressInfo).port;
	const signer = { ...key.signer, keyId: res.keyId };
	const a = new RemoteSpace(socketTransport({ host: "127.0.0.1", port }, { localAddress: "127.0.0.3" }), { attempts: 2, sleep: () => Promise.resolve(), backoffMs: 1, signer, expectedGateHostId: "host-1", ownPeerId: "p-admin" });
	await a.authenticate();
	await a.write({ type: "Job", fields: {} }, null, FOREVER);
	assert.equal(g.gate.peers().some((p) => p.proven), true);
	assert.equal(await revokePeerKey(g.host, ctx, "p-admin", res.keyId, g.clock.now), true);
	g.clock.t += 1_000;
	assert.ok((await g.gate.revalidate()) >= 1, "the proven connection is closed");
	const b = new RemoteSpace(socketTransport({ host: "127.0.0.1", port }, { localAddress: "127.0.0.3" }), { attempts: 2, sleep: () => Promise.resolve(), backoffMs: 1, signer, expectedGateHostId: "host-1", ownPeerId: "p-admin" });
	await assert.rejects(b.authenticate(), (e: unknown) => e instanceof core.PermissionError && /revoked/.test((e as Error).message));
	assert.equal(g.gate.peers().some((p) => p.proven), false, "nothing proven is left");
	assert.equal((await g.keys.find("p-admin", res.keyId))?.state, "revoked");
});
