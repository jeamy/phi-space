// Remote run Members (docs/betrieb-und-mobile-steuerung.md §7.4 case 3, §8 B4): signed RunGate instructions,
// pauseIncomplete with an unreachable Member, controller restart, admin commands and the composed Gate over TCP.
import test from "node:test";
import assert from "node:assert/strict";
import * as c from "./src/core.ts";
import { generateKey } from "./src/auth.ts";
import { PiSpaces } from "./src/client.ts";
import { GrantVerifier } from "./src/grants.ts";
import { principalId } from "./src/mailbox.ts";
import { RemoteSpace } from "./src/remote.ts";
import { RoutingConflict, validateFederationPolicy } from "./src/routing-semantics.ts";
import { RunController, runCommands, type RunMember, type RunSpec } from "./src/run-controller.ts";
import { RunGateService, remoteRunMember, signRun, type RunGateInstruction, type SignedRun } from "./src/run-member.ts";
import { startFederationHost } from "./src/runtime.ts";
import { socketTransport } from "./src/socket.ts";
import { createSpace, listSpaces, snapshotSpace, spaceDoc } from "./src/spaces.ts";
import { CONTROL_SPACE, Supervisor } from "./src/index.ts";
import { BACKENDS, ctx, PersistentHome } from "./test/support/persistent.ts";

type Host = Awaited<ReturnType<PersistentHome["open"]>>;
const T = (type: string, fields: c.Fields = {}): c.Template => ({ type, fields });
const JOB_PROFILE: c.CompletionProfile = { taskType: "Job", resultTypes: ["Done"], equalFields: ["runId", "n"], maxResultCount: 1, maxLeaseMs: 60_000, gateField: "runId" };
const controllerKey = generateKey("ed25519", "controller");
const pin = (peerId: string, k: ReturnType<typeof generateKey>) => ({ issuer: peerId, algorithm: k.signer.algorithm, publicKey: k.publicKey });
async function jobsSpace(h: Host, alias: string): Promise<string> {
	const sid = (await h.commit(tx => createSpace(tx, alias, Date.now()), ctx)).spaceId;
	await h.commit(async tx => c.setCompletionProfiles(await spaceDoc(tx, sid, Date.now()), [JOB_PROFILE]), ctx);
	return sid;
}
/** Registered preparer: two jobs per Member, idempotent. */
const prepareJobs = (h: Host) => async (run: RunSpec, space: string) => {
	await h.commit(async tx => {
		const s = await spaceDoc(tx, space, Date.now());
		for (const n of [1, 2]) if (!c.count(s, Date.now(), T("Job", { runId: run.runId, n }))) c.write(s, Date.now(), { type: "Job", fields: { runId: run.runId, n } }, null, c.FOREVER);
	}, ctx);
};
function memberService(h: Host, peerId: string, key: ReturnType<typeof generateKey>, authorityId = "authority") {
	return new RunGateService({ host: h, ctx, authorityId, peerId, signer: key.signer, controllerPin: pin("control", controllerKey), preparers: { jobs: prepareJobs(h) }, assertAuthority: async () => {} });
}

for (const backend of BACKENDS) test(`${backend}: case 3: an unreachable remote Member keeps the pause incomplete across a controller restart`, async () => {
	const homes = [new PersistentHome(backend), new PersistentHome(backend), new PersistentHome(backend)];
	try {
		let control = await homes[0]!.open();
		const b = await homes[1]!.open(), d = await homes[2]!.open();
		const keys = { b: generateKey("ed25519", "b"), d: generateKey("ed25519", "d") };
		const sb = await jobsSpace(b, "jobs-b"), sd = await jobsSpace(d, "jobs-d");
		const services: Record<string, RunGateService> = { [sb]: memberService(b, "b", keys.b), [sd]: memberService(d, "d", keys.d) };
		let down = false, loseReply = false;
		const member = (spaceId: string): RunMember => remoteRunMember({
			spaceId, authorityId: "authority", peerId: "control", signer: controllerKey.signer,
			memberPin: spaceId === sb ? pin("b", keys.b) : pin("d", keys.d),
			send: async t => {
				if (spaceId === sd && down) throw new Error("Member unreachable");
				const ack = await services[spaceId]!.apply(t);
				if (spaceId === sd && loseReply) { loseReply = false; throw new Error("reply lost"); }
				return ack;
			},
		});
		let controller = new RunController({ host: control, ctx, member });
		loseReply = true; // the prepare effect on d is durable, only its ACK is lost
		const first = await controller.start("go", { runId: "run-r", kind: "jobs", config: null, members: [sb, sd] });
		assert.equal(first.state, "preparing"); assert.match(first.pending!.errors[sd]!, /reply lost/);
		const started = await controller.advance("run-r");
		assert.equal(started.state, "running", "the repeated prepare returns the stored ACK, no second preparation");
		assert.equal(await new PiSpaces(d, ctx, Date.now, undefined, undefined, { space: sd }).count(T("Job")), 2);

		down = true;
		const incomplete = await controller.pause("halt", "run-r");
		assert.equal(incomplete.state, "pauseIncomplete");
		assert.deepEqual(incomplete.pending!.applied, [sb]); assert.deepEqual(incomplete.pending!.missing, [sd]);
		const worker = new PiSpaces(d, ctx, Date.now, undefined, undefined, { space: sd }), tx = await worker.createTransaction(30_000);
		assert.ok(await worker.take(T("Job"), 0, { txn: tx.id }), "the unreachable Member works on until its own fence");
		await worker.write({ type: "Done", fields: { runId: "run-r", n: 1 } }, tx.id, c.FOREVER);
		await worker.commit(tx.id);
		assert.equal(await new PiSpaces(b, ctx, Date.now, undefined, undefined, { space: sb }).take(T("Job"), 0, { txn: (await new PiSpaces(b, ctx, Date.now, undefined, undefined, { space: sb }).createTransaction(30_000)).id }), null, "the confirmed Member is paused");

		homes[0]!.crash(control);
		control = await homes[0]!.open();
		controller = new RunController({ host: control, ctx, member });
		assert.deepEqual(await controller.pending(), ["run-r"]);
		assert.equal((await controller.status("run-r"))!.state, "pauseIncomplete", "never reported as paused while an ACK is missing");
		await assert.rejects(controller.resume("again", "run-r"), /still applying pause/);
		down = false;
		const paused = await controller.advance("run-r");
		assert.equal(paused.state, "paused"); assert.equal(paused.revision, 3);
		assert.equal((await controller.resume("go-on", "run-r")).state, "running");
	} finally { for (const h of homes) await h.dispose(); }
});

test("signed instructions bind authority, Space, run kind and both keys", async () => {
	const home = new PersistentHome("jsonl");
	try {
		const h = await home.open(), key = generateKey("ed25519", "b"), sid = await jobsSpace(h, "jobs");
		const service = memberService(h, "b", key);
		const q: RunGateInstruction = { runId: "r", commandId: "p", kind: "prepare", revision: 1, authorityId: "authority", spaceId: sid, spec: { runId: "r", kind: "jobs", config: null, members: [sid] } };
		const sign = (v: RunGateInstruction, k = controllerKey) => signRun("instruction", v, "control", k.signer);
		await assert.rejects(service.apply({ ...(await sign(q)), signature: (await sign({ ...q, revision: 2 })).signature }), c.PermissionError);
		await assert.rejects(service.apply(await sign(q, generateKey("ed25519", "rogue"))), c.PermissionError);
		await assert.rejects(service.apply(await sign({ ...q, authorityId: "other" })), c.PermissionError);
		await assert.rejects(service.apply(await sign({ ...q, spaceId: "sp-unknown" })), /no local Space/);
		await assert.rejects(service.apply(await sign({ ...q, spec: { ...q.spec!, kind: "shell" } })), /no registered preparer/);
		await assert.rejects(service.apply(await sign({ ...q, spec: { ...q.spec!, members: ["sp-other"] } })), /manifest/);
		const ack = await service.apply(await sign(q));
		assert.equal((ack.value as c.RunGateAck).state, "preparing"); assert.equal(ack.issuer, "b");
		const forged = remoteRunMember({ spaceId: sid, authorityId: "authority", peerId: "control", signer: controllerKey.signer, memberPin: pin("b", generateKey("ed25519", "b2")), send: t => service.apply(t) });
		await assert.rejects(forged.prepare(q.spec!, { runId: "r", commandId: "p", kind: "prepare", revision: 1 }), c.PermissionError, "an ACK signed by another key is not a confirmation");
		const genuine = remoteRunMember({ spaceId: sid, authorityId: "authority", peerId: "control", signer: controllerKey.signer, memberPin: pin("b", key), send: t => service.apply(t) });
		const view = await genuine.recover("r", "rec-x");
		assert.deepEqual([view.recoveryId, view.present, view.gate!.state, view.stable], ["rec-x", true, "preparing", true], "a signed recover instruction returns the signed recovery view");
	} finally { await home.dispose(); }
});

test("federation policies carry gated profiles and cannot drop them under an active run", () => {
	const policy = { authorityId: "authority", policyVersion: 1, default: { mode: "local" as const, member: "a" }, rules: [], completionProfiles: [{ ...JOB_PROFILE, maxResultBytes: 1024 } as any] };
	const members = { a: { id: "a", target: { authorityId: "authority", hostId: "h", spaceId: "sp-a" } as any, state: "active" as const } };
	validateFederationPolicy(policy, members as any);
	assert.throws(() => validateFederationPolicy({ ...policy, completionProfiles: [{ ...policy.completionProfiles[0], gateField: "other" }] }, members as any), RoutingConflict);
	const s = c.initialState(); c.setCompletionProfiles(s, [JOB_PROFILE], 0);
	c.applyRunGate(s, 0, { runId: "r", commandId: "p", kind: "prepare", revision: 1 });
	assert.throws(() => c.assertGatedProfilesKept(s, [{ ...JOB_PROFILE, gateField: undefined }]), c.RunGateConflict, "MemberLifecycle checks this before installing a policy");
	c.assertGatedProfilesKept(s, [JOB_PROFILE]);
});

for (const backend of BACKENDS) test(`${backend}: admins start and pause runs through control-space commands; refusals are results`, async () => {
	const home = new PersistentHome(backend);
	try {
		const h = await home.open(), sid = await jobsSpace(h, "jobs"), key = generateKey("ed25519", "self"), service = memberService(h, "self", key);
		const controller = new RunController({ host: h, ctx, member: spaceId => remoteRunMember({ spaceId, authorityId: "authority", peerId: "control", signer: controllerKey.signer, memberPin: pin("self", key), send: t => service.apply(t) }) });
		const supervisor = new Supervisor(h, ctx, { asyncCommands: runCommands(controller) });
		const stop = await supervisor.start();
		try {
			const controlId = (await listSpaces(h, ctx)).find(i => i.alias === CONTROL_SPACE)!.spaceId;
			await h.commit(async tx => c.write(await spaceDoc(tx, controlId, Date.now()), Date.now(), { type: "PeerKey", fields: { peerId: "p-admin", state: "active", roles: ["admin"] } }, null, c.FOREVER), ctx);
			const send = (commandId: string, kind: string, args: c.Fields) => h.commit(async tx => c.write(await spaceDoc(tx, controlId, Date.now()), Date.now(), { type: "Command", fields: { commandId, kind, args } }, null, 3_600_000, principalId({ peerId: "p-admin" })), ctx);
			const result = async (commandId: string) => {
				for (let i = 0; i < 200; i++) {
					const r = c.list((await snapshotSpace(h, controlId, ctx))!, Date.now(), T("Result", { commandId }));
					if (r.length) return r[0]!.fields as any;
					await new Promise(r => setTimeout(r, 25));
				}
				throw new Error(`no result for ${commandId}`);
			};
			await send("cmd-start", "startRun", { runId: "via-admin", kind: "jobs", config: null, members: [sid] });
			const started = await result("cmd-start");
			assert.equal(started.state, "completed"); assert.equal(started.result.state, "running"); assert.equal(started.requestedBy, "p-admin");
			await send("cmd-pause", "pauseRun", { runId: "via-admin" });
			assert.equal((await result("cmd-pause")).result.state, "paused");
			await send("cmd-bad", "pauseRun", { runId: "via-admin" });
			const refused = await result("cmd-bad");
			assert.equal(refused.state, "failed"); assert.match(refused.result.error, /cannot pause/);
			await send("cmd-list", "listRuns", {});
			assert.deepEqual((await result("cmd-list")).result.map((r: any) => [r.runId, r.state]), [["via-admin", "paused"]]);
			await send("cmd-status", "runStatus", { runId: "nope" });
			assert.equal((await result("cmd-status")).result.phase, "failed");
		} finally { await stop(); }
	} finally { await home.dispose(); }
});

for (const backend of BACKENDS) test(`${backend}: the composed Gate accepts only signed run gate instructions from a proven peer over TCP`, async () => {
	const home = new PersistentHome(backend);
	try {
		const h = await home.open(), key = generateKey("ed25519", "b"), sid = await jobsSpace(h, "jobs");
		const runtime = await startFederationHost(h, ctx, {
			hostId: "b", authorityId: "authority", unsafeSkipBootGuardForTests: true, groupRoles: { "space-hosts": ["host"] },
			runGates: memberService(h, "b", key),
			keys: { find: async (peer, k) => peer === "control" && k === controllerKey.signer.keyId ? { peerId: "control", principal: "control", keyId: k, algorithm: "ed25519", publicKey: controllerKey.publicKey, state: "active", roles: ["host"], scope: ["*"] } : null },
			verifier: new GrantVerifier({ authorityId: "authority", issuerHostId: "control", algorithm: "ed25519", publicKey: controllerKey.publicKey }),
			directory: { refresh: async () => {}, lookup: async ip => ip === "127.0.0.2" ? { id: "control", name: "control", ip, connected: true, groups: ["space-hosts"] } : null },
			listen: { host: "127.0.0.1", port: 0 }, revalidateMs: 0,
		});
		const socket = socketTransport({ host: "127.0.0.1", port: (runtime.address() as any).port }, { localAddress: "127.0.0.2" });
		try {
			const remote = new RemoteSpace(socket, { space: sid, signer: controllerKey.signer, ownPeerId: "control", expectedGateHostId: "b", attempts: 1 });
			await remote.authenticate();
			const member = remoteRunMember({ spaceId: sid, authorityId: "authority", peerId: "control", signer: controllerKey.signer, memberPin: pin("b", key), send: t => remote.requestRunGate(t) });
			const controller = new RunController({ host: h, ctx, member: () => member });
			assert.equal((await controller.start("tcp", { runId: "tcp-run", kind: "jobs", config: null, members: [sid] })).state, "running");
			const signed: SignedRun<RunGateInstruction> = await signRun("instruction", { runId: "tcp-run", commandId: "x", kind: "pause", revision: 3, authorityId: "authority", spaceId: sid }, "control", controllerKey.signer);
			await assert.rejects(remote.requestRunGate({ ...signed, signature: "bad" }));
			assert.equal((await controller.pause("tcp-pause", "tcp-run")).state, "paused");
		} finally { socket.close(); await runtime.close(); }
	} finally { await home.dispose(); }
});
