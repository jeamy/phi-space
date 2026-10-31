// AP 1b.4: pairing (federation-plan-v3.md 4.5): tokens, the enroll RPC, bootstrap, limits.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import {
	RemoteSpace, socketTransport, generateKey, newEnrollToken, hashToken, enrollQr, keyFingerprint, BootstrapClosed, CONTROL_SPACE, FOREVER, core, DEFAULT_POLICY,
	type Policy, type Signer,
} from "../src/index.ts";
import { TestClock, gateUnderTest } from "./support/gate-under-test.ts";

type Peer = { id: string; name: string; ip: string; connected: boolean; groups: Array<{ id: string; name: string }> };
const peer = (id: string, ip: string, groups: string[]): Peer => ({ id, name: id, ip, connected: true, groups: groups.map((g) => ({ id: `g-${g}`, name: g })) });
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
	const clock = new TestClock(tc, 1_700_000_000_000);
	const gate = await gateUnderTest(tc, { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, clock, gateHostId: "host-1", spaceKeys: true, enrollment: true, policy });
	const port = gate.port;
	const transports: Array<{ close(): void }> = [];
	tc.after(() => transports.forEach((t) => t.close()));
	/** A device on the control space with the key it wants to enroll. */
	const device = (ip: string, peerId: string, signer: Signer, o: Record<string, unknown> = {}) => {
		const t = socketTransport({ host: "127.0.0.1", port }, { localAddress: ip });
		transports.push(t);
		return new RemoteSpace(t, { space: CONTROL_SPACE, attempts: 2, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 3_000, signer, expectedGateHostId: "host-1", ownPeerId: peerId, ...o });
	};
	const entries = async (type: string) => (await gate.control.entries({ type })).map((e) => e.fields);
	return { clock, gate, peers, device, entries, control: gate.control };
}
const refused = (e: unknown) => e instanceof core.PermissionError && /enrollment refused/.test((e as Error).message);

test("bootstrap: the first admin is paired with a bound one-time token, the power ends with its use", async (tc) => {
	const g = await setup(tc);
	const token = newEnrollToken();
	assert.ok(Buffer.from(token, "base64url").length === 32, "256 bits");
	const rec = await g.control.bootstrap({ tokenHash: hashToken(token), allowedPeerId: "p-admin" });
	assert.equal(rec.role, "admin");
	assert.equal(rec.expiresAt - g.clock.now(), 5 * 60_000);
	const key = generateKey("ed25519", "ignored");
	const admin = g.device("127.0.0.3", "p-admin", key.signer);
	const res = await admin.enroll(token);
	assert.deepEqual({ role: res.role, peerId: res.peerId, keyId: res.keyId }, { role: "admin", peerId: "p-admin", keyId: keyFingerprint(key.publicKey) });
	const stored = await g.control.find("p-admin", res.keyId);
	assert.ok(stored && stored.state === "active" && stored.publicKey === key.publicKey && stored.roles.join() === "admin");
	// a retry with a new connection proof and the same request identity: the stored answer, though the token is spent
	g.clock.t += 5_000;
	assert.deepEqual(await admin.enroll(token), res);
	assert.deepEqual((await g.entries("Enroll")).map((e) => e.state), ["consumed"]);
	// the bootstrap power is closed for good, also for a new hash
	await assert.rejects(g.control.bootstrap({ tokenHash: hashToken(newEnrollToken()), allowedPeerId: "p-admin" }), BootstrapClosed);
	assert.deepEqual((await g.entries("Bootstrap")).map((e) => e.state), ["closed"]);
	// the paired key is a layer-B key: with the admin group the device proves it and is admin
	g.peers[0] = peer("p-admin", "127.0.0.3", ["space-admin", "space-hosts"]);
	g.clock.t += 61_000;
	const same = new RemoteSpace(socketTransport({ host: "127.0.0.1", port: g.gate.port }, { localAddress: "127.0.0.3" }), { attempts: 2, sleep: () => Promise.resolve(), backoffMs: 1, signer: { ...key.signer, keyId: res.keyId }, expectedGateHostId: "host-1", ownPeerId: "p-admin" });
	assert.deepEqual((await same.authenticate()).roles, ["admin"], "the enrolled key proves, and the key says admin");
	assert.ok((await g.gate.peers()).some((p) => p.proven && p.peerId === "p-admin"));
	assert.ok((await same.write({ type: "Job", fields: {} }, null, FOREVER)).id);
	assert.ok(JSON.parse(enrollQr({ endpoint: "tcp://host-b:7421", controlSpaceId: "sp-1", token })).token === token);
});

test("a lost bootstrap token is replaced while unused: the old hash is invalid", async (tc) => {
	const g = await setup(tc);
	const lost = newEnrollToken(), fresh = newEnrollToken();
	await g.control.bootstrap({ tokenHash: hashToken(lost), allowedPeerId: "p-admin" });
	await g.control.bootstrap({ tokenHash: hashToken(fresh), allowedPeerId: "p-admin" });
	assert.deepEqual((await g.entries("Enroll")).map((e) => e.state).sort(), ["invalid", "open"]);
	await assert.rejects(g.device("127.0.0.3", "p-admin", generateKey("ed25519", "k").signer).enroll(lost), refused);
	g.clock.t += 61_000;
	assert.equal((await g.device("127.0.0.3", "p-admin", generateKey("ed25519", "k").signer).enroll(fresh)).role, "admin");
});

test("hosts get bound one-time tokens and only the role host; an admin token only comes through the bootstrap", async (tc) => {
	const g = await setup(tc);
	await assert.rejects(g.control.create({ tokenHash: hashToken("x"), role: "admin", allowedPeerId: "p-host" }), core.IllegalArgumentError);
	await assert.rejects(g.control.create({ tokenHash: "not-a-hash", role: "host", allowedPeerId: "p-host" }), core.IllegalArgumentError);
	await assert.rejects(g.control.create({ tokenHash: hashToken("x"), role: "host", allowedPeerId: "" }), core.IllegalArgumentError);
	const token = newEnrollToken();
	const a = await g.control.create({ tokenHash: hashToken(token), role: "host", allowedPeerId: "p-host", scope: ["sieve"], ttlMs: 60 * 60_000 });
	assert.equal(a.expiresAt - g.clock.now(), 5 * 60_000, "never longer than 5 minutes");
	assert.deepEqual(await g.control.create({ tokenHash: hashToken(token), role: "host", allowedPeerId: "p-host" }), a, "idempotent");
	const res = await g.device("127.0.0.2", "p-host", generateKey("ecdsa-p256", "k").signer).enroll(token);
	assert.deepEqual([res.role, res.peerId, res.scope], ["host", "p-host", ["sieve"]]);
	assert.equal((await g.control.find("p-host", res.keyId))?.algorithm, "ecdsa-p256");
});

test("the token is never stored, logged or shared: only its hash is in the control space, claims and events", async (tc) => {
	const g = await setup(tc);
	const token = newEnrollToken();
	await g.control.create({ tokenHash: hashToken(token), role: "host", allowedPeerId: "p-host" });
	const dev = g.device("127.0.0.2", "p-host", generateKey("ed25519", "k").signer);
	await dev.enroll(token);
	const state = await g.control.state();
	const everything = state + JSON.stringify(g.gate.enrollEvents);
	assert.ok(!everything.includes(token), "the plain token is nowhere");
	assert.ok(everything.includes(hashToken(token)), "its hash is");
	const claims = JSON.stringify((JSON.parse(state) as { rpc?: { claims?: unknown } }).rpc?.claims ?? {});
	assert.ok(!claims.includes(token) && !claims.includes("signature"), "the claim keeps hashes, not the request");
});

test("the order of the checks: a wrong peer does not burn the token, wrong signatures do, three end it", async (tc) => {
	const g = await setup(tc);
	const token = newEnrollToken();
	await g.control.create({ tokenHash: hashToken(token), role: "host", allowedPeerId: "p-host" });
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
	await g.control.create({ tokenHash: hashToken(token), role: "host", allowedPeerId: "p-host" });
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
	assert.deepEqual(g.gate.enrollEvents.map((e) => e.outcome), ["unknown-token", "rate-limited", "bad-key", "expired"]);
});

test("only unpaired peers may start enrollment; an unproven member cannot resolve it", async (tc) => {
	const g = await setup(tc);
	const token = newEnrollToken();
	await g.control.create({ tokenHash: hashToken(token), role: "host", allowedPeerId: "p-member" });
	await assert.rejects(g.device("127.0.0.5", "p-member", generateKey("ed25519", "k").signer).enroll(token), (e: unknown) => e instanceof core.PermissionError && /requires a current app-key proof/.test((e as Error).message));
	assert.equal((await g.entries("Enroll"))[0]!.state, "open");
});

test("a paired peer with a proven key resolves its own request but starts no new enrollment", async (tc) => {
	const g = await setup(tc);
	const first = newEnrollToken(), second = newEnrollToken();
	await g.control.create({ tokenHash: hashToken(first), role: "member", allowedPeerId: "p-host" }); // what its group grants: the proof keeps a role
	const key = generateKey("ed25519", "k");
	const res = await g.device("127.0.0.2", "p-host", key.signer).enroll(first);
	g.peers[1] = peer("p-host", "127.0.0.2", ["space-hosts"]);
	g.clock.t += 61_000;
	await g.control.create({ tokenHash: hashToken(second), role: "host", allowedPeerId: "p-host" });
	const paired = g.device("127.0.0.2", "p-host", { ...key.signer, keyId: res.keyId });
	await paired.authenticate();
	await assert.rejects(paired.enroll(second), (e: unknown) => e instanceof core.PermissionError && /only resolve existing/.test((e as Error).message));
	assert.equal((await g.entries("PeerKey")).length, 1);
	assert.equal((await g.entries("Enroll")).find((e) => e.tokenHash === hashToken(second))?.state, "open");
});

test("enrollStatus tells a device the fate of its own request and nobody else's", async (tc) => {
	const g = await setup(tc);
	const token = newEnrollToken();
	await g.control.create({ tokenHash: hashToken(token), role: "host", allowedPeerId: "p-host" });
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
	await g.control.bootstrap({ tokenHash: hashToken(token), allowedPeerId: "p-admin" });
	const key = generateKey("ed25519", "k");
	const res = await g.device("127.0.0.3", "p-admin", key.signer).enroll(token);
	g.peers[0] = peer("p-admin", "127.0.0.3", ["space-admin", "space-hosts"]);
	g.clock.t += 61_000;
	const port = g.gate.port;
	const signer = { ...key.signer, keyId: res.keyId };
	const a = new RemoteSpace(socketTransport({ host: "127.0.0.1", port }, { localAddress: "127.0.0.3" }), { attempts: 2, sleep: () => Promise.resolve(), backoffMs: 1, signer, expectedGateHostId: "host-1", ownPeerId: "p-admin" });
	await a.authenticate();
	await a.write({ type: "Job", fields: {} }, null, FOREVER);
	assert.equal((await g.gate.peers()).some((p) => p.proven), true);
	assert.equal(await g.control.revoke("p-admin", res.keyId), true);
	g.clock.t += 1_000;
	assert.ok((await g.gate.revalidate()) >= 1, "the proven connection is closed");
	const b = new RemoteSpace(socketTransport({ host: "127.0.0.1", port }, { localAddress: "127.0.0.3" }), { attempts: 2, sleep: () => Promise.resolve(), backoffMs: 1, signer, expectedGateHostId: "host-1", ownPeerId: "p-admin" });
	await assert.rejects(b.authenticate(), (e: unknown) => e instanceof core.PermissionError && /revoked/.test((e as Error).message));
	assert.equal((await g.gate.peers()).some((p) => p.proven), false, "nothing proven is left");
	assert.equal((await g.control.find("p-admin", res.keyId))?.state, "revoked");
});
