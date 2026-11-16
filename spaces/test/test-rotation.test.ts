// Own-key rotation and grants on the wire of a control host (src/rotation.ts, the `grant` call of src/runtime.ts), on either server.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { RemoteSpace, socketTransport, generateKey, newEnrollToken, hashToken, rotationBytes, CONTROL_SPACE, core, DEFAULT_POLICY, type Signer } from "../src/index.ts";
import { TestClock, gateUnderTest } from "./support/gate-under-test.ts";

type Peer = { id: string; name: string; ip: string; connected: boolean; groups: Array<{ id: string; name: string }> };
const peer = (id: string, ip: string, groups: string[]): Peer => ({ id, name: id, ip, connected: true, groups: groups.map((g) => ({ id: `g-${g}`, name: g })) });
const until = async (f: () => Promise<boolean>, ms = 5_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

async function setup(tc: TestContext, supervisor = true) {
	const peers = [peer("p-admin", "127.0.0.3", ["space-enroll"])];
	let down = false;
	const server = http.createServer((_req, res) => { res.statusCode = down ? 503 : 200; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(peers)); });
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	tc.after(() => { server.closeAllConnections(); server.close(); });
	const clock = new TestClock(tc, 1_700_000_000_000);
	const gate = await gateUnderTest(tc, { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, clock, gateHostId: "host-1", spaceKeys: true, enrollment: true, controlAccess: true, supervisor, serviceClock: true, grants: true, policy: DEFAULT_POLICY });
	const transports: Array<{ close(): void }> = [];
	tc.after(() => transports.forEach((t) => t.close()));
	const remote = (signer: Signer, granted = true) => {
		const t = socketTransport({ host: "127.0.0.1", port: gate.port }, { localAddress: "127.0.0.3" });
		transports.push(t);
		const r: RemoteSpace = new RemoteSpace(t, { space: CONTROL_SPACE, attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 3_000, signer, expectedGateHostId: "host-1", ownPeerId: "p-admin", ...(granted ? { grantProvider: () => r.requestGrant() } : {}) });
		return r;
	};
	const token = newEnrollToken();
	await gate.control.bootstrap({ tokenHash: hashToken(token), allowedPeerId: "p-admin" });
	const key = generateKey("ed25519", "k");
	const res = await remote(key.signer, false).enroll(token);
	peers[0] = peer("p-admin", "127.0.0.3", ["space-admin", "space-hosts"]);
	clock.t += 61_000;
	const signer: Signer = { ...key.signer, keyId: res.keyId };
	const admin = remote(signer);
	await admin.authenticate();
	const results = async (commandId: string) => (await gate.control.entries({ type: "Result", fields: { commandId } })).map((e) => e.fields);
	return { clock, gate, remote, admin, signer, keyId: res.keyId, results, mgmt: (on: boolean) => { down = !on; } };
}

test("a rotation swaps the key in one command: the new one keeps the rights, the old one is revoked and proves nothing", async (tc) => {
	const g = await setup(tc);
	const next = generateKey("ecdsa-p256", "next");
	const challenge = await g.admin.rotationChallenge(next.signer.algorithm, next.publicKey);
	assert.equal(challenge.expiresAt - challenge.issuedAt, 30_000);
	const accepted = await g.admin.rotateKey(challenge, next.signer);
	assert.equal(accepted.state, "accepted");
	assert.ok(await until(async () => (await g.results(accepted.commandId)).length === 1));
	const r = (await g.results(accepted.commandId))[0]!;
	assert.equal(r.state, "completed", JSON.stringify(r));
	const newKey = await g.gate.control.find("p-admin", challenge.newKeyId);
	assert.deepEqual([newKey?.state, newKey?.roles, newKey?.algorithm, newKey?.publicKey], ["active", ["admin"], "ecdsa-p256", next.publicKey]);
	assert.equal((await g.gate.control.find("p-admin", g.keyId))?.state, "revoked");
	await assert.rejects(g.remote(g.signer, false).authenticate(), /revoked/);
	const rotated = g.remote({ ...next.signer, keyId: challenge.newKeyId });
	assert.deepEqual((await rotated.authenticate()).roles, ["admin"]);
	assert.deepEqual(await rotated.rotationStatus(accepted.commandId), r);
	assert.deepEqual(await rotated.rotationStatus("no-such-command"), { state: "pending" });
	assert.equal((await g.gate.control.entries({ type: "Rotation" })).length, 0, "the challenge is spent");
});

test("a rotation needs both signatures, the open challenge and a grant; nothing is queued without them", async (tc) => {
	const g = await setup(tc);
	const next = generateKey("ed25519", "next"), other = generateKey("ed25519", "other");
	await assert.rejects(g.remote(g.signer, false).rotationChallenge("ed25519", next.publicKey), /requires a proven app key/);
	const proven = g.remote(g.signer, false);
	await proven.authenticate();
	await assert.rejects(proven.rotationChallenge("ed25519", next.publicKey), /signed control grant/);
	const challenge = await g.admin.rotationChallenge("ed25519", next.publicKey);
	await assert.rejects(g.admin.rotateKey(challenge, other.signer), /valid signatures from both keys/);
	await assert.rejects(g.admin.rotateKey({ ...challenge, newKeyId: "changed" }, next.signer), /unknown, used or changed/);
	await assert.rejects(g.admin.rotateKey({ ...challenge, peerId: "p-other" }, next.signer), /belongs to another key/);
	assert.equal((await g.gate.control.entries({ type: "Command" })).length, 0);
	await assert.rejects(g.admin.rotationChallenge("ed25519", (await g.gate.control.find("p-admin", g.keyId))!.publicKey), /must differ/);
	await assert.rejects(g.admin.rotationChallenge("rsa" as never, next.publicKey), /invalid replacement key/);
	g.clock.t += 31_000;
	await assert.rejects(g.admin.rotateKey(challenge, next.signer), /owner or expiry/);
});

test("three open challenges are the limit, a retried request is answered from its claim", async (tc) => {
	const g = await setup(tc, false); // the command stays where the retry can count it
	const keys = [1, 2, 3, 4].map((n) => generateKey("ed25519", `n${n}`));
	const open = [];
	for (const k of keys.slice(0, 3)) open.push(await g.admin.rotationChallenge("ed25519", k.publicKey));
	await assert.rejects(g.admin.rotationChallenge("ed25519", keys[3]!.publicKey), (e: unknown) => e instanceof core.ResourceExhausted);
	const send = (g.admin as unknown as { send(c: unknown): Promise<any> }).send.bind(g.admin);
	const { generation } = await send({ method: "rotationGeneration" });
	const c = open[0]!, bytes = rotationBytes(c), b64 = async (s: Signer) => Buffer.from(await s.sign(bytes)).toString("base64");
	const call = { method: "rotateKey", request: { generation, requestId: "r-1" }, args: { challenge: c, oldSignature: await b64(g.signer), newSignature: await b64(keys[0]!.signer) } };
	const first = await send(call);
	assert.deepEqual(await send(call), first, "the same answer, and no second command");
	assert.equal((await g.gate.control.entries({ type: "Command" })).length, 1);
});

test("a grant is issued on the directory's word of now: a management API that is down gives none", async (tc) => {
	const g = await setup(tc);
	assert.ok(await g.admin.requestGrant());
	g.mgmt(false);
	await assert.rejects(g.admin.requestGrant(), /management API/);
	g.mgmt(true);
	assert.ok(await g.admin.requestGrant());
	await assert.rejects(g.admin.requestGrant("nonsense" as never), /invalid grant purpose/);
});
