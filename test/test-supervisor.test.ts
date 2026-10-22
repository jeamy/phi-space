// AP 1b.5: the supervisor of the control space and the wire rules around it (federation-plan-v3.md 5, 5.1).
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	SpaceService, RemoteSpace, socketTransport, startGate, NetbirdDirectory, GateIdentity, ProvingService, EnrollmentService, ControlAccess, Supervisor, SpaceKeyDirectory, generateKey,
	bootstrapEnroll, newEnrollToken, hashToken, CONTROL_SPACE, FOREVER, core, PhiSpaces, createSpace, listSpaces, snapshotSpace, spaceDoc, DEFAULT_POLICY, type Signer,
} from "../src/index.ts";
import { forEachBackend, InjectedFault, ctx } from "./support/persistent.ts";
import { openTestHost } from "./support/host.ts";

type Peer = { id: string; name: string; ip: string; connected: boolean; groups: Array<{ id: string; name: string }> };
const peer = (id: string, ip: string, groups: string[]): Peer => ({ id, name: id, ip, connected: true, groups: groups.map((g) => ({ id: `g-${g}`, name: g })) });
class Clock { t = 1_700_000_000_000; now = () => this.t; }
const until = async (f: () => Promise<boolean>, ms = 5_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

async function setup(tc: TestContext) {
	const peers: Peer[] = [peer("p-admin", "127.0.0.3", ["space-enroll"]), peer("p-host", "127.0.0.2", ["space-enroll"]), peer("p-member", "127.0.0.5", ["space-hosts"])];
	const server = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(peers)); });
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	tc.after(() => { server.closeAllConnections(); server.close(); });
	const clock = new Clock();
	const directory = new NetbirdDirectory({ url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, token: "t", now: clock.now });
	const host = await openTestHost(ctx);
	const keys = new SpaceKeyDirectory(host, ctx, clock.now);
	const identity = new GateIdentity();
	const service = new SpaceService({ host, ctx, identity, policy: DEFAULT_POLICY, hostId: "host-1", now: clock.now });
	const front = new EnrollmentService(new ControlAccess(new ProvingService(service, { gateHostId: "host-1", keys, now: clock.now }), { identity, host, ctx }), { host, ctx, now: clock.now });
	const gate = await startGate(front, { listen: { host: "127.0.0.1", port: 0 }, directory, keys, revalidateMs: 0, now: clock.now });
	tc.after(() => gate.close());
	const events: Array<{ commandId: string; kind: string; state: string; requestedBy: string; error?: string }> = [];
	const supervisor = new Supervisor(host, ctx, { now: clock.now, onEvent: (e) => events.push(e) });
	const stop = await supervisor.start();
	tc.after(() => stop());
	const port = (gate.address() as net.AddressInfo).port;
	const transports: Array<{ close(): void }> = [];
	tc.after(() => transports.forEach((t) => t.close()));
	const remote = (ip: string, peerId: string, signer?: Signer, space: string | undefined = CONTROL_SPACE) => {
		const t = socketTransport({ host: "127.0.0.1", port }, { localAddress: ip });
		transports.push(t);
		return new RemoteSpace(t, { ...(space ? { space } : {}), attempts: 2, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 3_000, ...(signer ? { signer, expectedGateHostId: "host-1", ownPeerId: peerId } : {}) });
	};
	/** The first admin is paired through the bootstrap token and then proves its key as admin. */
	const pairAdmin = async () => {
		const token = newEnrollToken();
		await bootstrapEnroll(host, ctx, { tokenHash: hashToken(token), allowedPeerId: "p-admin", now: clock.now });
		const key = generateKey("ed25519", "k");
		const enrolling = remote("127.0.0.3", "p-admin", key.signer);
		const res = await enrolling.enroll(token);
		peers[0] = peer("p-admin", "127.0.0.3", ["space-admin", "space-hosts"]);
		clock.t += 61_000;
		const signer: Signer = { ...key.signer, keyId: res.keyId };
		const admin = remote("127.0.0.3", "p-admin", signer);
		await admin.authenticate();
		return { admin, signer, key, keyId: res.keyId };
	};
	const controlState = async () => { const info = (await listSpaces(host, ctx)).find((i) => i.alias === CONTROL_SPACE)!; return (await snapshotSpace(host, info.spaceId, ctx))!; };
	const results = async (commandId?: string) => core.list(await controlState(), clock.now(), { type: "Result", ...(commandId ? { fields: { commandId } } : {}) }).map((e) => e.fields as Record<string, any>);
	const command = (kind: string, args: Record<string, unknown>, commandId = `c-${Math.random().toString(36).slice(2)}`) => ({ type: "Command", fields: { commandId, kind, args } as core.Fields, commandId });
	return { host, clock, keys, gate, events, peers, remote, pairAdmin, controlState, results, command, supervisor };
}

test("a paired admin pairs a host through the control space: Command -> supervisor -> Result -> enroll -> revokePeer", async (tc) => {
	const g = await setup(tc);
	const { admin } = await g.pairAdmin();
	const token = newEnrollToken();
	const c1 = g.command("createEnroll", { tokenHash: hashToken(token), role: "host", allowedPeerId: "p-host", scope: ["sieve"] });
	await admin.write({ type: c1.type, fields: c1.fields }, null, 60 * 60_000);
	assert.ok(await until(async () => (await g.results(c1.commandId)).length === 1), "the supervisor processed the command");
	const r1 = (await g.results(c1.commandId))[0]!;
	assert.equal(r1.state, "completed");
	assert.deepEqual([r1.result.role, r1.result.allowedPeerId], ["host", "p-host"]);
	assert.equal(r1.requestedBy, "p-admin");
	assert.ok(!JSON.stringify(r1).includes(token), "only the hash");
	// the admin can read the result over the wire
	const seen = await admin.readAll({ type: "Result", fields: { commandId: c1.commandId } });
	assert.equal(seen.length, 1);
	// the host pairs with the token the admin made locally
	const hostKey = generateKey("ed25519", "hk");
	const enrolled = await g.remote("127.0.0.2", "p-host", hostKey.signer).enroll(token);
	assert.equal(enrolled.role, "host");
	assert.equal((await g.keys.find("p-host", enrolled.keyId))?.state, "active");
	// revoking the peer
	const c2 = g.command("revokePeer", { peerId: "p-host" });
	await admin.write({ type: c2.type, fields: c2.fields }, null, 60 * 60_000);
	assert.ok(await until(async () => (await g.results(c2.commandId)).length === 1));
	const r2 = (await g.results(c2.commandId))[0]!;
	assert.deepEqual([r2.state, r2.result.revoked], ["completed", 1]);
	assert.equal((await g.keys.find("p-host", enrolled.keyId))?.state, "revoked");
	assert.deepEqual(g.events.map((e) => [e.kind, e.state]), [["createEnroll", "completed"], ["revokePeer", "completed"]]);
});

test("a repeated commandId acts once; bad arguments and unknown kinds become failed results, not crashes", async (tc) => {
	const g = await setup(tc);
	const { admin } = await g.pairAdmin();
	const token = newEnrollToken();
	const c = g.command("createEnroll", { tokenHash: hashToken(token), role: "host", allowedPeerId: "p-host" }, "same-id");
	await admin.write({ type: c.type, fields: c.fields }, null, 60 * 60_000);
	await admin.write({ type: c.type, fields: c.fields }, null, 60 * 60_000); // the admin's retry
	assert.ok(await until(async () => g.events.length >= 2));
	assert.deepEqual(g.events.map((e) => e.state), ["completed", "duplicate"]);
	assert.equal((await g.results("same-id")).length, 1);
	const bad = g.command("createEnroll", { tokenHash: "nope", role: "host", allowedPeerId: "p-host" });
	const wrongRole = g.command("createEnroll", { tokenHash: hashToken("x"), role: "admin", allowedPeerId: "p-host" });
	const unknown = g.command("rebootEverything", {});
	const noPeer = g.command("revokePeer", {});
	for (const x of [bad, wrongRole, unknown, noPeer]) await admin.write({ type: x.type, fields: x.fields }, null, 60 * 60_000);
	assert.ok(await until(async () => (await g.results()).length >= 5));
	const byId = (id: string) => g.results(id).then((r) => r[0]!);
	assert.match((await byId(bad.commandId)).error, /SHA-256/);
	assert.match((await byId(wrongRole.commandId)).error, /bootstrap/);
	assert.match((await byId(unknown.commandId)).error, /unknown command/);
	assert.match((await byId(noPeer.commandId)).error, /peerId/);
	assert.equal((await g.results()).filter((r) => r.state === "failed").length, 4);
});

test("only an admin who proved a key writes commands; the control space is closed for everyone else and for everything but Command", async (tc) => {
	const g = await setup(tc);
	const { admin } = await g.pairAdmin();
	const member = g.remote("127.0.0.5", "p-member");
	await assert.rejects(member.write({ type: "Command", fields: { commandId: "m", kind: "revokePeer", args: { peerId: "p-admin" } } }, null, FOREVER), core.PermissionError);
	await assert.rejects(member.readAll({ type: "Result" }), core.PermissionError);
	// an admin group without a proof is no admin
	const unproven = g.remote("127.0.0.3", "p-admin");
	await assert.rejects(unproven.write({ type: "Command", fields: { commandId: "u", kind: "revokePeer", args: { peerId: "p-host" } } }, null, FOREVER), core.PermissionError);
	// the admin: Command only
	await assert.rejects(admin.write({ type: "PeerKey", fields: { peerId: "p-admin", keyId: "evil", roles: ["admin"], state: "active" } }, null, FOREVER), core.PermissionError);
	await assert.rejects(admin.write({ type: "Enroll", fields: {} }, null, FOREVER), core.PermissionError);
	await assert.rejects(admin.readAll({ type: "Enroll" }), core.PermissionError);
	await assert.rejects(admin.readAll(), core.PermissionError, "everything is not a type");
	await assert.rejects(admin.take({ type: "Command" }, 0), core.PermissionError);
	await assert.rejects(admin.stats(), core.PermissionError);
	assert.equal((await admin.readAll({ type: "PeerKey" })).length, 1, "keys are readable for the audit");
	assert.equal((await g.controlState()).entries.some((e) => e.type === "Command"), false);
});

test("a command whose writer holds no active admin key fails; the revoked admin loses its power", async (tc) => {
	const g = await setup(tc);
	const { admin } = await g.pairAdmin();
	// written straight into the control space by someone who is no admin (as a local tool might)
	const local = new PhiSpaces(g.host, ctx, g.clock.now, undefined, "p-ghost", { space: CONTROL_SPACE });
	await local.write({ type: "Command", fields: { commandId: "ghost", kind: "revokePeer", args: { peerId: "p-admin" } } }, null, FOREVER);
	assert.ok(await until(async () => (await g.results("ghost")).length === 1));
	assert.equal((await g.results("ghost"))[0]!.state, "failed");
	assert.match((await g.results("ghost"))[0]!.error, /no active admin key/);
	// an admin revokes itself: the next command of that key is refused
	const self = g.command("revokePeer", { peerId: "p-admin" });
	await admin.write({ type: self.type, fields: self.fields }, null, 60 * 60_000);
	assert.ok(await until(async () => (await g.results(self.commandId)).length === 1));
	assert.equal((await g.results(self.commandId))[0]!.state, "completed");
	await local.write({ type: "Command", fields: { commandId: "after", kind: "revokePeer", args: { peerId: "p-host" } } }, null, FOREVER);
	assert.ok(await until(async () => (await g.results("after")).length === 1));
	assert.equal((await g.results("after"))[0]!.state, "failed");
});

test("a command is processed in one commit: a fault before it leaves the command, a retry gives exactly one result", async () => {
	await forEachBackend(async (home) => {
		const h = await home.open();
		const clock = new Clock();
		const info = await h.commit((tx) => createSpace(tx, CONTROL_SPACE, clock.now()), ctx);
		await h.commit(async (tx) => { const s = await spaceDoc(tx, info.spaceId, clock.now()); core.write(s, clock.now(), { type: "PeerKey", fields: { peerId: "p-admin", keyId: "k", principal: "x", algorithm: "ed25519", publicKey: "AA==", roles: ["admin"], state: "active" } }, null, FOREVER); }, ctx);
		await new PhiSpaces(h, ctx, clock.now, undefined, "p-admin", { space: CONTROL_SPACE }).write({ type: "Command", fields: { commandId: "once", kind: "createEnroll", args: { tokenHash: hashToken("t"), role: "host", allowedPeerId: "p-host" } } }, null, FOREVER);
		home.faults.arm("failBeforeCommit");
		await assert.rejects(new Supervisor(h, ctx, { now: clock.now }).tick(), InjectedFault);
		home.crash(h); // a failed commit poisons the session: reopen, as after a crash
		const h2 = await home.open();
		const sup = new Supervisor(h2, ctx, { now: clock.now });
		const control = async () => (await snapshotSpace(h2, info.spaceId, ctx))!;
		assert.equal(core.list(await control(), clock.now(), { type: "Command" }).length, 1, "nothing happened: the command is still there");
		assert.equal(core.list(await control(), clock.now(), { type: "Result" }).length, 0);
		assert.equal(await sup.tick(), 1);
		assert.equal(await sup.tick(), 0);
		assert.equal(core.list(await control(), clock.now(), { type: "Result" }).length, 1);
		assert.equal(core.list(await control(), clock.now(), { type: "Enroll" }).length, 1, "and exactly one effect");
	});
});

test('persistent remote admin command runs outside Control commit and resumes after lost answer',async()=>{
 await forEachBackend(async home=>{let host=await home.open();const now=()=>100000;const info=await host.commit(tx=>createSpace(tx,CONTROL_SPACE,now()),ctx);await host.commit(async tx=>{const s=await spaceDoc(tx,info.spaceId,now());core.write(s,now(),{type:'PeerKey',fields:{peerId:'admin',principal:'admin',keyId:'k',state:'active',roles:['admin'],scope:['*'],algorithm:'ed25519',publicKey:'fixture'}},null,FOREVER);core.write(s,now(),{type:'Command',fields:{commandId:'remote-1',kind:'remote',args:{value:7}}},null,FOREVER,'admin');},ctx);
 let effect=false,attempts=0;const make=()=>new Supervisor(host,ctx,{now,asyncCommands:{remote:async(id,args,by)=>{assert.equal(id,'remote-1');assert.equal(by,'admin');await host.commit(async tx=>{await spaceDoc(tx,info.spaceId,now());},ctx);attempts++;if(!effect){effect=true;throw Error('committed reply lost');}return{value:args.value!};}}});
 await make().tick();assert.equal((await new PhiSpaces(host,ctx,now,undefined,undefined,{space:CONTROL_SPACE}).readAll({type:'Result'})).length,0);home.crash(host);host=await home.open();await make().tick();const r=await new PhiSpaces(host,ctx,now,undefined,undefined,{space:CONTROL_SPACE}).readAll({type:'Result'});assert.equal(r.length,1);assert.equal(r[0]!.fields.state,'completed');assert.equal(attempts,2);await make().tick();assert.equal(attempts,2);
 });
});

test("stopping the supervisor waits for a pass in flight, so it never runs on against a closing store", async () => {
	const host = await openTestHost(ctx);
	await host.commit((tx) => createSpace(tx, CONTROL_SPACE, 1_000), ctx);
	let gate: (() => void) | undefined, committing = false, armed = false;
	const slow = new Proxy(host, { get(t, k) { const v = Reflect.get(t, k, t); if (k !== "commit") return typeof v === "function" ? v.bind(t) : v;
		return async (...a: Parameters<typeof host.commit>) => { if (!armed) return host.commit(...a); armed = false; committing = true; await new Promise<void>((r) => { gate = r; }); try { return await host.commit(...a); } finally { committing = false; } }; } }) as typeof host;
	const stop = await new Supervisor(slow, ctx, { onError: (e) => assert.fail(String(e)) }).start();
	armed = true;
	// start() itself ran a first pass; the next pass is triggered by a new Command and parks in commit.
	await new PhiSpaces(host, ctx, () => 2_000, undefined, undefined, { space: CONTROL_SPACE }).write({ type: "Command", fields: { commandId: "c1", kind: "noop" } }, null, FOREVER);
	assert.ok(await until(async () => committing), "a pass is in flight");
	let stopped = false;const stopping = stop().then(() => { stopped = true; });
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(stopped, false, "stop waits for the pass in flight");
	gate!();await stopping;assert.equal(committing, false);
	await host.close(ctx);
});
