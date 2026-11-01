// Signed Space lifecycle instructions on the wire of a host (src/space-lifecycle.ts, `spaceLifecycleInstruction`), on either server.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteSpace, SqliteRecoveryRegister, socketTransport, generateKey, newEnrollToken, hashToken, CONTROL_SPACE, core, listSpaces, snapshotSpace, type Signer } from "../src/index.ts";
import { SpaceLifecycle, signLifecycle, spaceCommands, verifyLifecycle, type SpaceLifecycleInstruction } from "../src/space-lifecycle.ts";
import { signRun } from "../src/run-member.ts";
import { openSqliteHost } from "../src/store/sqlite.ts";
import { ctx } from "./support/persistent.ts";
import { TestClock, TestKeys, gateUnderTest, type GateUnderTest } from "./support/gate-under-test.ts";

const peer = (id: string, ip: string, groups: string[]) => ({ id, name: id, ip, connected: true, groups: groups.map((g) => ({ id: `g-${g}`, name: g })) });
const JOB: core.CompletionProfile = { taskType: "Job", resultTypes: ["Done"], equalFields: ["runId", "n"], maxResultCount: 1, maxLeaseMs: 60_000, gateField: "runId" };
const PROFILE: core.CompletionProfile = { taskType: "Note", resultTypes: ["Done"], equalFields: ["n"], maxResultCount: 1 };
const control = generateKey("ed25519", "control");
type Q = Omit<SpaceLifecycleInstruction, "authorityId" | "hostId"> & { authorityId?: string; hostId?: string };

async function setup(tc: TestContext) {
	const peers = [peer("p-admin", "127.0.0.3", ["space-enroll"])];
	const server = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(peers)); });
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	tc.after(() => { server.closeAllConnections(); server.close(); });
	const clock = new TestClock(tc, Date.now());
	const gate: GateUnderTest = await gateUnderTest(tc, { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, clock, gateHostId: "host-1", spaceKeys: true, enrollment: true, spaceLifecycle: { controllerKey: control.publicKey }, runGates: { controllerKey: control.publicKey } });
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
	const sign = (q: Q, k = control) => signLifecycle("instruction", { authorityId: "authority", hostId: "host-1", ...q } as SpaceLifecycleInstruction, "control", k.signer);
	const send = async (q: Q) => (await proven.requestSpaceLifecycle(await sign(q))).value;
	return { gate, remote, signer, proven, sign, send };
}

test("an instruction is bound to the control key, the authority and this host", async (tc) => {
	const g = await setup(tc);
	const q: Q = { commandId: "c1", action: "create", alias: "jobs" };
	await assert.rejects(g.proven.requestSpaceLifecycle({ ...(await g.sign(q)), signature: (await g.sign({ ...q, alias: "other" })).signature }), /invalid Space lifecycle instruction signature/);
	await assert.rejects(g.proven.requestSpaceLifecycle(await g.sign(q, generateKey("ed25519", "rogue"))), /invalid Space lifecycle instruction signature/);
	await assert.rejects(g.proven.requestSpaceLifecycle({ ...(await g.sign(q)), issuer: "someone-else" }), /invalid Space lifecycle instruction signature/);
	await assert.rejects(g.proven.requestSpaceLifecycle(await g.sign({ ...q, authorityId: "other" })), /another authority or host/);
	await assert.rejects(g.proven.requestSpaceLifecycle(await g.sign({ ...q, hostId: "host-2" })), /another authority or host/);
	await assert.rejects(g.remote(g.signer).requestSpaceLifecycle(await g.sign(q)), /proven service peer/, "a connection without a proof");
	await assert.rejects(g.send({ commandId: "bad id", action: "create", alias: "jobs" }), /invalid Space lifecycle request/);
	await assert.rejects(g.send({ commandId: "x", action: "explode" as never, alias: "jobs" }), /invalid Space lifecycle request/);
	await assert.rejects(g.send({ commandId: "x", action: "create" }), /create needs an alias/);
	await assert.rejects(g.send({ commandId: "x", action: "archive" }), /archive needs a spaceId/);
	await assert.rejects(g.send({ commandId: "x", action: "create", alias: "No Alias" }), /alias: 1-64/);
	assert.ok(!await g.gate.control.spaceInfo("jobs"), "nothing was created");
	const signed = await g.proven.requestSpaceLifecycle(await g.sign(q));
	assert.equal(signed.issuer, "host-1");
	assert.deepEqual(Object.keys(verifyLifecycle("result", signed, { issuer: "host-1", algorithm: "ed25519", publicKey: g.gate.memberKey })).sort(), ["action", "alias", "commandId", "spaceId", "state"]);
	assert.throws(() => verifyLifecycle("result", signed, { issuer: "host-1", algorithm: "ed25519", publicKey: control.publicKey }), core.PermissionError, "signed by the host's key, nobody else's");
});

test("create reuses an alias unchanged, a command ID names one request, and the control side reads the result", async (tc) => {
	const g = await setup(tc);
	const made = await g.send({ commandId: "c1", action: "create", alias: "jobs", limits: { maxEntries: 50 }, profiles: [PROFILE] });
	assert.equal(made.state, "active"); assert.equal(made.existed, undefined);
	assert.deepEqual(await g.send({ commandId: "c1", action: "create", alias: "jobs", limits: { maxEntries: 50 }, profiles: [PROFILE] }), made, "same command, same result");
	const again = await g.send({ commandId: "c2", action: "create", alias: "jobs", limits: { maxEntries: 50 }, profiles: [PROFILE] });
	assert.deepEqual([again.spaceId, again.existed], [made.spaceId, true], "a second create reuses the Space");
	await assert.rejects(g.send({ commandId: "c3", action: "create", alias: "jobs", limits: { maxEntries: 60 } }), /reused only unchanged/);
	await assert.rejects(g.send({ commandId: "c3", action: "create", alias: "jobs", profiles: [] }), /reused only unchanged/);
	await assert.rejects(g.send({ commandId: "c3", action: "create", alias: "jobs", limits: { nonsense: 1 } as never }), /reused only unchanged/);
	await assert.rejects(g.send({ commandId: "c1", action: "create", alias: "other" }), /was used for another/);
	await assert.rejects(g.send({ commandId: "c4", action: "create", alias: "fresh", limits: { maxEntries: -1 } }));
	assert.ok(!await g.gate.control.spaceInfo("fresh"), "a refused setting leaves no Space behind");
	const failed: string[] = [];
	const commands = spaceCommands({ authorityId: "authority", peerId: "control", signer: control.signer, hostPin: async () => ({ issuer: "host-1", algorithm: "ed25519", publicKey: g.gate.memberKey }), send: async (_h, t) => g.proven.requestSpaceLifecycle(t) });
	const outcome = await commands.deleteSpace("k1", { hostId: "host-1", spaceId: made.spaceId }) as { phase: string; error: string };
	failed.push(outcome.phase);
	assert.deepEqual(failed, ["failed"]); assert.match(outcome.error, /archive the Space first/);
	assert.equal(((await commands.createSpace("k2", { hostId: "host-1", alias: "via-admin" })) as { state: string }).state, "active");
});

test("archiving stops new work and keeps the data readable; deletion needs an empty archived Space and keeps the id reserved", async (tc) => {
	const g = await setup(tc);
	const made = await g.send({ commandId: "c1", action: "create", alias: "jobs" });
	const space = g.remote(g.signer, made.spaceId);
	await space.authenticate();
	await space.write({ type: "Note", fields: { n: 1 } }, null, core.FOREVER);
	await assert.rejects(g.send({ commandId: "d0", action: "delete", spaceId: made.spaceId }), /archive the Space first/);
	assert.equal((await g.send({ commandId: "a1", action: "archive", spaceId: made.spaceId })).state, "archived");
	assert.equal((await g.send({ commandId: "a2", action: "archive", spaceId: made.spaceId })).state, "archived", "archiving twice is fine");
	await assert.rejects(space.write({ type: "Note", fields: { n: 2 } }, null, core.FOREVER), /archived/);
	await assert.rejects(space.createTransaction(1000), /archived/);
	await assert.rejects(space.take({ type: "Note" }, 0), /archived/);
	assert.equal(await space.count({ type: "Note" }), 1, "reads stay possible");
	await assert.rejects(g.send({ commandId: "c2", action: "create", alias: "jobs" }), /names an archived Space/);
	await assert.rejects(g.send({ commandId: "d1", action: "delete", spaceId: made.spaceId }), /still holds 1 entries/);
	await g.send({ commandId: "r1", action: "reactivate", spaceId: made.spaceId });
	assert.ok(await space.take({ type: "Note" }, 0));
	await g.send({ commandId: "a3", action: "archive", spaceId: made.spaceId });
	await assert.rejects(g.send({ commandId: "d2", action: "delete", spaceId: made.spaceId }), /retains request claims/, "claims stay reachable until they expire");
	const empty = await g.send({ commandId: "c3", action: "create", alias: "empty" });
	await assert.rejects(g.send({ commandId: "d3", action: "delete", spaceId: empty.spaceId }), /archive the Space first/);
	await g.send({ commandId: "a4", action: "archive", spaceId: empty.spaceId });
	const gone = await g.send({ commandId: "d4", action: "delete", spaceId: empty.spaceId });
	assert.equal(gone.state, "deleted");
	assert.deepEqual(await g.send({ commandId: "d4", action: "delete", spaceId: empty.spaceId }), gone, "the journal answers a repeated delete");
	assert.ok(!await g.gate.control.spaceInfo("empty"));
	await assert.rejects(g.send({ commandId: "a5", action: "archive", spaceId: empty.spaceId }), /no Space/);
	const late = g.remote(g.signer, empty.spaceId);
	await assert.rejects(late.write({ type: "Note", fields: {} }, null, 1000), /unknown space/i);
	await assert.rejects(late.count({ type: "Note" }), /unknown space/i, "a read does not reach a deleted Space either");
	const fresh = await g.send({ commandId: "c4", action: "create", alias: "empty" });
	assert.notEqual(fresh.spaceId, empty.spaceId, "the alias is free again, the old id stays reserved");
	const file = await g.gate.stop();
	if (!file) return;
	// the same file on the other implementation: the journal, the mark and the tombstone
	const host = await openSqliteHost(file);
	tc.after(() => host.close(ctx));
	const life = new SpaceLifecycle({ host, ctx });
	assert.deepEqual(await life.apply({ commandId: "d4", action: "delete", spaceId: empty.spaceId }), gone);
	assert.equal((await snapshotSpace(host, made.spaceId, ctx))?.archived?.commandId, "a3");
	assert.equal(await snapshotSpace(host, empty.spaceId, ctx), undefined);
	assert.deepEqual((await listSpaces(host, ctx)).filter((i) => i.alias === "empty").map((i) => i.spaceId), [fresh.spaceId]);
});

test("the default and the control Space have no lifecycle, and a running run keeps its Space", async (tc) => {
	const g = await setup(tc);
	for (const alias of ["default", CONTROL_SPACE]) await assert.rejects(g.send({ commandId: `x-${alias}`, action: "archive", spaceId: (await g.gate.control.spaceInfo(alias)).spaceId }), /have no lifecycle/);
	const sid = await g.gate.control.jobsSpace("jobs", [JOB]);
	const spec = { runId: "r", kind: "jobs", config: null, members: [sid] };
	await g.proven.requestRunGate(await signRun("instruction", { runId: "r", commandId: "p", kind: "prepare", revision: 1, authorityId: "authority", spaceId: sid, spec }, "control", control.signer));
	await assert.rejects(g.send({ commandId: "a1", action: "archive", spaceId: sid }), /a run on it is not stopped/);
	await g.proven.requestRunGate(await signRun("instruction", { runId: "r", commandId: "s", kind: "stop", revision: 2, authorityId: "authority", spaceId: sid }, "control", control.signer));
	assert.equal((await g.send({ commandId: "a2", action: "archive", spaceId: sid })).state, "archived");
});

test("a boot guard blocks what no permit names, so create waits for a provisioned permit", async (tc) => {
	const dir = mkdtempSync(join(tmpdir(), "phi-life-"));
	tc.after(() => rmSync(dir, { recursive: true, force: true }));
	const files = { external: join(dir, "external.sqlite"), installed: join(dir, "installed.sqlite") };
	const server = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify([peer("p-admin", "127.0.0.3", ["space-admin", "space-hosts"])])); });
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	tc.after(() => { server.closeAllConnections(); server.close(); });
	const keys = new TestKeys(tc), key = generateKey("ed25519", "k");
	keys.add({ peerId: "p-admin", keyId: key.signer.keyId, principal: "p-admin", algorithm: "ed25519", publicKey: key.publicKey, roles: ["admin", "member"], state: "active" });
	const gate = await gateUnderTest(tc, { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, clock: new TestClock(tc, Date.now()), gateHostId: "host-1", keys, spaceLifecycle: { controllerKey: control.publicKey }, boot: files });
	const sid = await gate.control.jobsSpace("jobs", []);
	const info = await gate.control.spaceInfo("jobs");
	const external = new SqliteRecoveryRegister(files.external), installed = new SqliteRecoveryRegister(files.installed);
	tc.after(() => { external.close(); installed.close(); });
	const permit = { state: "active", authorityId: "authority", dataIncarnation: info.incarnation, role: "local", transitionId: "t1" };
	await installed.compareAndSet(`installed:host-1:${sid}`, null, permit as never);
	await external.compareAndSet("boot:host-1", null, { hostId: "host-1", state: "active", spaces: { [sid]: permit } } as never);
	gate.armBoot();
	const t = socketTransport({ host: "127.0.0.1", port: gate.port }, { localAddress: "127.0.0.3" });
	tc.after(() => t.close());
	const proven = new RemoteSpace(t, { attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 3_000, signer: key.signer, expectedGateHostId: "host-1", ownPeerId: "p-admin" });
	await proven.authenticate();
	const send = async (q: Q) => (await proven.requestSpaceLifecycle(await signLifecycle("instruction", { authorityId: "authority", hostId: "host-1", ...q } as SpaceLifecycleInstruction, "control", control.signer))).value;
	await assert.rejects(send({ commandId: "c2", action: "create", alias: "unpermitted" }), /boot permission/);
	assert.ok(!await gate.control.spaceInfo("unpermitted"), "nothing was made");
	assert.equal((await send({ commandId: "a1", action: "archive", spaceId: sid })).state, "archived", "a Space with its permit moves on");
	const flip = async (state: string) => { const b = (await external.get<Record<string, never>>("boot:host-1"))!; await external.compareAndSet("boot:host-1", b.version, { ...b.value, state } as never); };
	await flip("fenced");
	await assert.rejects(send({ commandId: "r1", action: "reactivate", spaceId: sid }), /boot authorization/);
	await flip("active");
	assert.equal((await send({ commandId: "r1", action: "reactivate", spaceId: sid })).state, "active", "the refused command left no line in the journal");
});
