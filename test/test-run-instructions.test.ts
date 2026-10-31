// Signed RunGate instructions on the wire of a Member host (src/run-member.ts, `runGateInstruction`), on either server.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { RemoteSpace, socketTransport, generateKey, newEnrollToken, hashToken, CONTROL_SPACE, DEFAULT_POLICY, core, type Signer } from "../src/index.ts";
import { remoteRunMember, signRun, type RunGateInstruction } from "../src/run-member.ts";
import { TestClock, gateUnderTest } from "./support/gate-under-test.ts";

type Peer = { id: string; name: string; ip: string; connected: boolean; groups: Array<{ id: string; name: string }> };
const peer = (id: string, ip: string, groups: string[]): Peer => ({ id, name: id, ip, connected: true, groups: groups.map((g) => ({ id: `g-${g}`, name: g })) });
const JOB: core.CompletionProfile = { taskType: "Job", resultTypes: ["Done"], equalFields: ["runId", "n"], maxResultCount: 1, maxLeaseMs: 60_000, gateField: "runId" };
const controller = generateKey("ed25519", "controller");

async function setup(tc: TestContext) {
	const peers = [peer("p-admin", "127.0.0.3", ["space-enroll"])];
	const server = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(peers)); });
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	tc.after(() => { server.closeAllConnections(); server.close(); });
	const clock = new TestClock(tc, 1_700_000_000_000);
	const gate = await gateUnderTest(tc, { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, clock, gateHostId: "host-1", spaceKeys: true, enrollment: true, serviceClock: true, runGates: { controllerKey: controller.publicKey }, policy: DEFAULT_POLICY });
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
	const proven = remote(signer);
	await proven.authenticate();
	const sid = await gate.control.jobsSpace("jobs", [JOB]);
	return { gate, remote, signer, proven, sid };
}

test("signed instructions bind authority, Space, run kind and both keys", async (tc) => {
	const g = await setup(tc);
	const q: RunGateInstruction = { runId: "r", commandId: "p", kind: "prepare", revision: 1, authorityId: "authority", spaceId: g.sid, spec: { runId: "r", kind: "jobs", config: null, members: [g.sid] } };
	const sign = (v: RunGateInstruction, k = controller) => signRun("instruction", v, "control", k.signer);
	await assert.rejects(g.proven.requestRunGate({ ...(await sign(q)), signature: (await sign({ ...q, revision: 2 })).signature }), /invalid run gate instruction signature/);
	await assert.rejects(g.proven.requestRunGate(await sign(q, generateKey("ed25519", "rogue"))), /invalid run gate instruction signature/);
	await assert.rejects(g.proven.requestRunGate({ ...(await sign(q)), issuer: "someone-else" }), /invalid run gate instruction signature/);
	await assert.rejects(g.proven.requestRunGate(await sign({ ...q, authorityId: "other" })), /another authority/);
	await assert.rejects(g.proven.requestRunGate(await sign({ ...q, spaceId: "sp-unknown" })), /no local Space/);
	await assert.rejects(g.proven.requestRunGate(await sign({ ...q, spec: { ...q.spec!, kind: "shell" } })), /no registered preparer/);
	await assert.rejects(g.proven.requestRunGate(await sign({ ...q, spec: { ...q.spec!, members: ["sp-other"] } })), /manifest/);
	await assert.rejects(g.remote(g.signer).requestRunGate(await sign(q)), /proven service peer/, "a connection without a proof");
	assert.equal((await g.gate.control.jobs(g.sid)).length, 0, "nothing was prepared");
	const ack = await g.proven.requestRunGate(await sign(q));
	assert.equal((ack.value as core.RunGateAck).state, "preparing");
	assert.equal(ack.issuer, "host-1");
	assert.equal((await g.gate.control.jobs(g.sid)).length, 2, "the registered preparer wrote the run's tasks");
	await g.proven.requestRunGate(await sign(q));
	assert.equal((await g.gate.control.jobs(g.sid)).length, 2, "a replay writes nothing new");
	const send = (t: Parameters<typeof g.proven.requestRunGate>[0]) => g.proven.requestRunGate(t);
	const member = (publicKey: string) => remoteRunMember({ spaceId: g.sid, authorityId: "authority", peerId: "control", signer: controller.signer, memberPin: { issuer: "host-1", algorithm: "ed25519", publicKey }, send });
	await assert.rejects(member(generateKey("ed25519", "b2").publicKey).prepare(q.spec!, { runId: "r", commandId: "p", kind: "prepare", revision: 1 }), core.PermissionError, "an ACK signed by another key is no confirmation");
	const genuine = member(g.gate.memberKey);
	assert.equal((await genuine.gate({ runId: "r", commandId: "go", kind: "release", revision: 2 })).state, "running");
	const view = await genuine.recover("r", "rec-x");
	assert.deepEqual([view.recoveryId, view.present, view.gate!.state, view.stable], ["rec-x", true, "running", true], "a signed recover instruction returns the signed recovery view");
});
