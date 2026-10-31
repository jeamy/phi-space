// Signed membership instructions on the wire of a Member host (src/membership.ts, `membershipInstruction`), on either server,
// and the journal of their proofs carried from one implementation to the other in the store file.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { RemoteSpace, socketTransport, generateKey, newEnrollToken, hashToken, CONTROL_SPACE, DEFAULT_POLICY, FOREVER, MemberLifecycle, signMembership, type Signer } from "../src/index.ts";
import { openSqliteHost } from "../src/store/sqlite.ts";
import { TestClock, gateUnderTest, OTHER_SERVER, type GateCase } from "./support/gate-under-test.ts";
import { ctx } from "./support/persistent.ts";

type Peer = { id: string; name: string; ip: string; connected: boolean; groups: Array<{ id: string; name: string }> };
const peer = (id: string, ip: string, groups: string[]): Peer => ({ id, name: id, ip, connected: true, groups: groups.map((g) => ({ id: `g-${g}`, name: g })) });
const control = generateKey("ed25519", "control");
const policy = (version: number, member = "a", extra: Record<string, unknown> = {}) => ({ authorityId: "authority", policyVersion: version, rules: [{ type: "Job", mode: "local", member }, { type: "Far", mode: "local", member: "b" }], completionProfiles: [], default: { mode: "local", member: "a" }, ...extra });
const task = { taskType: "Task", resultTypes: ["Done"], equalFields: ["n"], maxResultBytes: 300, maxResultCount: 1, maxLeaseMs: 5_000 };

async function setup(tc: TestContext, extra: Partial<NonNullable<GateCase["membership"]>> = {}) {
	const peers = [peer("p-admin", "127.0.0.3", ["space-enroll"])];
	const server = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(peers)); });
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	tc.after(() => { server.closeAllConnections(); server.close(); });
	const clock = new TestClock(tc, 1_700_000_000_000);
	const gate = await gateUnderTest(tc, { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, clock, gateHostId: "host-1", spaceKeys: true, enrollment: true, membership: { controllerKey: control.publicKey, ...extra }, policy: DEFAULT_POLICY });
	const transports: Array<{ close(): void }> = [];
	tc.after(() => transports.forEach((t) => t.close()));
	const remote = (signer: Signer, space?: string) => {
		const t = socketTransport({ host: "127.0.0.1", port: gate.port }, { localAddress: "127.0.0.3" });
		transports.push(t);
		return new RemoteSpace(t, { ...(space ? { space } : {}), attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 3_000, signer, expectedGateHostId: "host-1", ownPeerId: "p-admin" });
	};
	const token = newEnrollToken();
	await gate.control.bootstrap({ tokenHash: hashToken(token), allowedPeerId: "p-admin" });
	const key = generateKey("ed25519", "k");
	const res = await remote(key.signer, CONTROL_SPACE).enroll(token);
	peers[0] = peer("p-admin", "127.0.0.3", ["space-admin", "space-hosts"]);
	clock.t += 61_000;
	const signer: Signer = { ...key.signer, keyId: res.keyId };
	const space = remote(signer, gate.memberSpace);
	await space.authenticate();
	const base = { authorityId: "authority", memberId: "a", spaceId: gate.memberSpace };
	const q = (id: string, action: string, more: Record<string, unknown> = {}, k = control) => signMembership("instruction", { ...base, id, action, ...more } as never, "control", k.signer);
	const send = async (id: string, action: string, more: Record<string, unknown> = {}) => (await space.requestMembership(await q(id, action, more))).value as unknown as Record<string, any>;
	return { gate, space, remote, signer, q, send };
}

test("an instruction binds its signature, authority, Member and Space; its id binds it for good", async (tc) => {
	const g = await setup(tc);
	const good = await g.q("add", "prepareAdd");
	await assert.rejects(g.space.requestMembership({ ...good, signature: "bad" }), /invalid membership signature/);
	await assert.rejects(g.space.requestMembership(await g.q("add", "prepareAdd", {}, generateKey("ed25519", "rogue"))), /invalid membership signature/);
	await assert.rejects(g.space.requestMembership({ ...good, issuer: "someone" }), /invalid membership signature/);
	for (const wrong of [{ authorityId: "other" }, { memberId: "b" }, { spaceId: "sp-other" }, { id: "" }]) await assert.rejects(g.space.requestMembership(await g.q("add", "prepareAdd", wrong)), /binding mismatch/);
	await assert.rejects(g.remote(g.signer, g.gate.memberSpace).requestMembership(good), /proven service peer/);
	await assert.rejects(g.send("x", "activate"), /activation needs matching frozen add/);
	await assert.rejects(g.send("x", "nonsense"), /unknown membership action/);
	const first = await g.send("add", "prepareAdd");
	assert.deepEqual(await g.send("add", "prepareAdd"), first, "the same instruction gets the same proof");
	await assert.rejects(g.send("add", "prepareAdd", { expectedAdmissionVersion: 7 }), /changed instruction/);
	await assert.rejects(g.send("again", "prepareAdd"), /already managed or frozen/);
	await assert.rejects(g.send("again", "drain", { expectedAdmissionVersion: 9 }), /admission version mismatch/);
});

test("a Member goes through its life: add, activate, policy, profiles, drain, freeze, detach, and back", async (tc) => {
	const g = await setup(tc);
	await g.space.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
	const add = await g.send("life", "prepareAdd");
	assert.deepEqual([add.state, add.admissionVersion, add.entryTypes, add.stock.length, add.empty], ["adding", 1, ["Job"], 1, false]);
	await assert.rejects(g.space.write({ type: "Job", fields: {} }, null, FOREVER), /Member admission is adding/);
	await assert.rejects(g.send("life", "activate", { policy: policy(1, "b") }), /another Member/, "stock that lies elsewhere stops the activation");
	await assert.rejects(g.send("life", "activate", { policy: { ...policy(1), authorityId: "other" } }), /activation needs matching/);
	const on = await g.send("life", "activate", { policy: policy(1) });
	assert.deepEqual([on.state, on.admissionVersion], ["active", 2]);
	await g.space.write({ type: "Job", fields: { n: 2 } }, null, FOREVER);
	await assert.rejects(g.space.write({ type: "Far", fields: {} }, null, FOREVER), /another Member/);
	assert.equal((await g.send("p2", "policy", { policy: policy(2) })).state, "active");
	await assert.rejects(g.send("p1", "policy", { policy: policy(1) }), /invalid installed policy transition/);
	await assert.rejects(g.send("p2b", "policy", { policy: policy(2, "a", { rules: [] }) }), /version changed content/);
	await assert.rejects(g.send("p3", "policy", { policy: policy(3, "a", { completionProfiles: [{ ...task, taskType: "Job" }] }) }), /existing Task requires controlled transition/);
	const next = policy(3, "a", { completionProfiles: [task] });
	await assert.rejects(g.send("pf", "profileFreeze", { policy: policy(3, "b") }), /may only change profiles/);
	await assert.rejects(g.send("px", "profileInstall", { policy: next }), /profile install requires/);
	assert.equal((await g.send("pf2", "profileFreeze", { policy: next })).state, "profileFrozen");
	await assert.rejects(g.space.write({ type: "Job", fields: {} }, null, FOREVER), /Member admission is profileFrozen/);
	await assert.rejects(g.send("pf2", "profileResume", { policy: next }), /profile resume requires/);
	await assert.rejects(g.send("other", "profileInstall", { policy: next }), /profile install requires/);
	await assert.rejects(g.send("pf2", "profileInstall", { policy: policy(3, "a", { completionProfiles: [{ ...task, maxResultCount: 2 }] }) }), /profile install requires/);
	assert.equal((await g.send("pf2", "profileInstall", { policy: next })).state, "profileFrozen");
	const resumed = await g.send("pf2", "profileResume", { policy: next });
	assert.deepEqual([resumed.state, resumed.admissionVersion], ["active", 5]);
	await assert.rejects(g.send("f", "freeze"), /freeze requires drained/);
	assert.equal((await g.send("d", "drain")).state, "draining");
	await assert.rejects(g.space.write({ type: "Job", fields: {} }, null, FOREVER), /no bounded completion allowance/);
	await assert.rejects(g.send("f", "freeze"), /physical entries or open work/);
	for (let i = 0; i < 2; i++) assert.ok(await g.space.take({ type: "Job" }, 0));
	const frozen = await g.send("f", "freeze");
	assert.deepEqual([frozen.state, frozen.empty], ["removing", true]);
	await assert.rejects(g.send("other", "detach"), /detach requires matching removal/);
	const off = await g.send("f", "detach");
	assert.deepEqual([off.state, off.admissionVersion], ["detached", 8]);
	const again = await g.send("back", "prepareAdd");
	assert.deepEqual([again.state, again.admissionVersion], ["adding", 9]);
	const gone = await g.send("back", "rejectAdd");
	assert.deepEqual([gone.state, gone.admissionVersion], ["local", 10], "the journal keeps the version though the membership went");
	assert.equal((await g.send("back2", "prepareAdd")).admissionVersion, 11);
});

test("activating installs the policy's completion profiles", async (tc) => {
	const g = await setup(tc);
	await g.send("a", "prepareAdd");
	await g.send("a", "activate", { policy: policy(1, "a", { completionProfiles: [task] }) });
	await g.space.write({ type: "Task", fields: { n: 1 } }, null, FOREVER);
	await assert.rejects(g.space.take({ type: "Task" }, 0), /profiled tasks/);
});

test("TypeScript's proofs are Rust's when the file comes the other way", { skip: OTHER_SERVER ? false : "only with another server" }, async (tc) => {
	let early: Awaited<ReturnType<MemberLifecycle["apply"]>> | undefined, signed: Parameters<MemberLifecycle["apply"]>[0] | undefined;
	const g = await setup(tc, { seed: async (lifecycle) => {
		signed = await signMembership("instruction", { authorityId: "authority", memberId: "a", spaceId: (lifecycle as unknown as { o: { spaceId: string } }).o.spaceId, id: "early", action: "prepareAdd" } as never, "control", control.signer);
		early = await lifecycle.apply(signed);
	} });
	assert.deepEqual((await g.space.requestMembership(signed!)).value, early!.value, "Rust answers from the journal TypeScript wrote");
	assert.equal((await g.send("early", "activate", { policy: policy(1) })).admissionVersion, 2, "and goes on from it");
});

test("Rust's proofs are TypeScript's after a handover of the file", { skip: OTHER_SERVER ? false : "only with another server" }, async (tc) => {
	const g = await setup(tc);
	await g.send("h1", "prepareAdd");
	const instruction = await g.q("h2", "activate", { policy: policy(1) });
	await assert.rejects(g.space.requestMembership(instruction), /activation needs matching/);
	const sent = await g.q("h1", "activate", { policy: policy(1) });
	const proof = (await g.space.requestMembership(sent)).value;
	const again = await g.q("h1", "prepareAdd");
	const added = (await g.space.requestMembership(again)).value;
	const file = await g.gate.stop();
	const host = await openSqliteHost(file!);
	tc.after(() => host.close(ctx));
	const key = generateKey("ed25519", "m");
	const lifecycle = new MemberLifecycle({ host, ctx, memberId: "a", spaceId: g.gate.memberSpace, authorityId: "authority", peerId: "host-1", signer: key.signer, controlPin: { issuer: "control", algorithm: "ed25519", publicKey: control.publicKey }, assertAuthority: async () => {} });
	assert.deepEqual((await lifecycle.apply(sent)).value, proof, "TypeScript answers from the journal Rust wrote");
	assert.deepEqual((await lifecycle.apply(again)).value, added);
	assert.equal((await lifecycle.apply(await signMembership("instruction", { authorityId: "authority", memberId: "a", spaceId: g.gate.memberSpace, id: "h3", action: "drain" } as never, "control", control.signer))).value.admissionVersion, 3, "and goes on from it");
});
