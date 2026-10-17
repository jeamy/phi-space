// Worker control (docs/betrieb-und-mobile-steuerung.md §7.3, §8 B6): desired state on the control host, signed
// per-host lists, local reconciliation of registered worker kinds, backoff, persistence and composition with runs.
import test from "node:test";
import assert from "node:assert/strict";
import * as c from "../src/core.ts";
import { generateKey } from "../src/auth.ts";
import { PiSpaces } from "../src/client.ts";
import { GrantVerifier } from "../src/grants.ts";
import { RemoteSpace } from "../src/remote.ts";
import { RunController, localRunMember } from "../src/run-controller.ts";
import { startFederationHost } from "../src/runtime.ts";
import { socketTransport } from "../src/socket.ts";
import { createSpace, spaceDoc } from "../src/spaces.ts";
import { WorkerAssignments, WorkerSupervisor, appliedWorkers, startWorkerSupervisor, type SignedWorkers, type WorkerKind } from "../src/workers.ts";
import { SIEVE_WORKER_KIND, collectSieveResults, configureGatedSieveSpace, prepareSieveRun, type SieveConfig } from "../examples/sieve.ts";
import { BACKENDS, ctx, PersistentHome } from "./support/persistent.ts";

type Host = Awaited<ReturnType<PersistentHome["open"]>>;
const controlKey = generateKey("ed25519", "control");
const pin = { issuer: "control", algorithm: controlKey.signer.algorithm, publicKey: controlKey.publicKey };
const until = async (f: () => boolean | Promise<boolean>, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await new Promise(r => setTimeout(r, 5)); } return false; };
const assignments = (h: Host, incarnation = "c1") => new WorkerAssignments({ host: h, ctx, authorityId: "authority", peerId: "control", signer: controlKey.signer, identity: async () => ({ incarnation }) });

/** A worker kind whose steps the test releases one by one. */
function gatedKind() {
	const started: Array<() => void> = []; let busy = 0, done = 0;
	const kind: WorkerKind = { step: () => new Promise<boolean>(resolve => { busy++; started.push(() => { busy--; done++; resolve(true); }); }) };
	return { kind, started, get busy() { return busy; }, get done() { return done; } };
}

for (const backend of BACKENDS) test(`${backend}: assignments are idempotent, per host and signed; hosts read only their share`, async () => {
	const home = new PersistentHome(backend);
	try {
		const h = await home.open(), w = assignments(h);
		const a = await w.set("c1", { assignmentId: "sieve-a", hostId: "host-a", kind: "sieve", targetSpace: "sp-1", count: 2, runId: "r1" });
		assert.equal(a.generation, 1);
		assert.deepEqual(await w.set("c1", { assignmentId: "sieve-a", hostId: "host-a", kind: "sieve", targetSpace: "sp-1", count: 2, runId: "r1" }), a, "same command, same result");
		await assert.rejects(w.set("c1", { assignmentId: "sieve-a", hostId: "host-a", kind: "sieve", targetSpace: "sp-1", count: 3, runId: "r1" }), c.IllegalArgumentError);
		await assert.rejects(w.set("c2", { assignmentId: "sieve-a", hostId: "host-b", kind: "sieve", targetSpace: "sp-1", count: 1 }), c.RunGateConflict, "an assignment keeps its host");
		await assert.rejects(w.set("c3", { assignmentId: "x", hostId: "host-a", kind: "sieve", targetSpace: "sp-1", count: 65 }), c.IllegalArgumentError);
		await w.set("c4", { assignmentId: "other", hostId: "host-b", kind: "sieve", targetSpace: "sp-2", count: 1, runId: "r1" });
		const list = await w.forHost("host-a");
		assert.equal(list.value.generation, 2); assert.equal(list.value.incarnation, "c1");
		assert.deepEqual(list.value.assignments.map(x => x.assignmentId), ["sieve-a"]);
	} finally { await home.dispose(); }
});

for (const backend of BACKENDS) test(`${backend}: the supervisor scales loops, stops after the current task, restarts on a new target and rejects what it cannot run`, async () => {
	const home = new PersistentHome(backend);
	try {
		const h = await home.open();
		const s1 = (await h.commit(tx => createSpace(tx, "jobs-1", Date.now()), ctx)).spaceId, s2 = (await h.commit(tx => createSpace(tx, "jobs-2", Date.now()), ctx)).spaceId;
		const w = assignments(h), g = gatedKind();
		const sup = new WorkerSupervisor({ host: h, ctx, hostId: "host-a", authorityId: "authority", controllerPin: pin, kinds: { gated: g.kind }, fetch: () => w.forHost("host-a") });
		try {
			await w.set("up", { assignmentId: "a1", hostId: "host-a", kind: "gated", targetSpace: s1, count: 2 });
			let sum = await sup.reconcile();
			assert.equal(sum.assignments.a1!.active, 2); assert.equal(sum.generation, 1);
			assert.ok(await until(() => g.busy === 2), "two loops each hold a task");
			await w.set("down", { assignmentId: "a1", hostId: "host-a", kind: "gated", targetSpace: s1, count: 1 });
			sum = await sup.reconcile();
			assert.deepEqual([sum.assignments.a1!.active, sum.assignments.a1!.stopping], [1, 1], "one loop finishes its task before it stops");
			g.started.shift()!(); g.started.shift()!();
			assert.ok(await until(() => sup.summary().assignments.a1!.stopping === 0));
			assert.ok(await until(() => g.busy === 1), "only one loop keeps taking work");
			await w.set("move", { assignmentId: "a1", hostId: "host-a", kind: "gated", targetSpace: s2, count: 1 });
			sum = await sup.reconcile();
			assert.equal(sum.assignments.a1!.targetSpace, s2); assert.equal(sum.assignments.a1!.stopping, 1, "the old target's loop ends after its task");
			await w.set("bad-kind", { assignmentId: "a2", hostId: "host-a", kind: "shell", targetSpace: s1, count: 1 });
			await w.set("bad-space", { assignmentId: "a3", hostId: "host-a", kind: "gated", targetSpace: "sp-elsewhere", count: 1 });
			sum = await sup.reconcile();
			assert.match(sum.assignments.a2!.rejected!, /no registered worker kind/); assert.match(sum.assignments.a3!.rejected!, /not on this host/);
			assert.equal(sum.assignments.a2!.active, 0);
		} finally { for (const f of g.started.splice(0)) f(); const stopping = sup.stop(); for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 5)); for (const f of g.started.splice(0)) f(); } await stopping; }
	} finally { await home.dispose(); }
});

for (const backend of BACKENDS) test(`${backend}: forged, replayed and foreign lists are refused; workers resume from the persisted state without control`, async () => {
	const home = new PersistentHome(backend);
	try {
		let h = await home.open();
		const sid = (await h.commit(tx => createSpace(tx, "jobs", Date.now()), ctx)).spaceId;
		const w = assignments(h);
		let steps = 0;
		const kind: WorkerKind = { step: async () => { steps++; return false; } };
		let fetch: () => Promise<SignedWorkers> = () => w.forHost("host-a");
		const sleeps: number[] = [];
		const make = (host: Host) => new WorkerSupervisor({ host, ctx, hostId: "host-a", authorityId: "authority", controllerPin: pin, kinds: { idle: kind }, fetch: () => fetch(), sleep: async (ms, signal) => { sleeps.push(ms); await new Promise(r => setTimeout(r, 1)); if (signal.aborted) return; }, backoff: { minMs: 10, maxMs: 80 } });
		let sup = make(h);
		try {
		await w.set("one", { assignmentId: "idle", hostId: "host-a", kind: "idle", targetSpace: sid, count: 1 });
		const first = await w.forHost("host-a");
		assert.equal((await sup.reconcile()).assignments.idle!.active, 1);
		assert.ok(await until(() => sleeps.length >= 6));
		assert.deepEqual(sleeps.slice(0, 5), [10, 20, 40, 80, 80], "no work: exponential backoff up to the cap, never a spin");

		fetch = async () => ({ ...first, value: { ...first.value, assignments: [] } });
		let sum = await sup.reconcile();
		assert.match(sum.fetchError!, /signature/); assert.equal(sum.assignments.idle!.active, 1, "a forged list changes nothing");
		fetch = async () => ({ ...(await w.forHost("host-b")) });
		assert.match((await sup.reconcile()).fetchError!, /another host/);
		await w.set("two", { assignmentId: "idle", hostId: "host-a", kind: "idle", targetSpace: sid, count: 2 });
		fetch = () => w.forHost("host-a");
		assert.equal((await sup.reconcile()).assignments.idle!.desired, 2);
		fetch = async () => first; // an older, genuinely signed list
		sum = await sup.reconcile();
		assert.equal(sum.assignments.idle!.desired, 2, "an older generation is a replay"); assert.equal(sum.generation, 2);
		const restored = assignments(h, "c2");
		fetch = () => restored.forHost("host-a");
		sum = await sup.reconcile();
		assert.match(sum.blocked!, /control identity changed/); assert.equal(sum.assignments.idle!.desired, 2, "the old desired state keeps running, visibly blocked");

		await sup.stop();
		home.crash(h); h = await home.open();
		fetch = async () => { throw new Error("control unreachable"); };
		sup = make(h);
		sum = await sup.reconcile();
		assert.equal(sum.assignments.idle!.active, 2, "after a restart the persisted state runs without the coordinator");
		assert.match(sum.fetchError!, /unreachable/);
		assert.ok(steps > 0);
		} finally { await sup.stop(); }
	} finally { await home.dispose(); }
});

for (const backend of BACKENDS) test(`${backend}: workers complete a gated sieve run, go idle while it is paused and continue after resume`, async () => {
	const home = new PersistentHome(backend);
	try {
		const h = await home.open(), sid = (await h.commit(tx => createSpace(tx, "sieve", Date.now()), ctx)).spaceId;
		await configureGatedSieveSpace(h, sid);
		const config: SieveConfig = { runId: "wrun", start: 1, end: 1001, blockSize: 64 };
		const runs = new RunController({ host: h, ctx, member: id => localRunMember(h, ctx, id, (run, space) => prepareSieveRun(h, run.config as SieveConfig, { space }).then(() => {})) });
		assert.equal((await runs.start("start", { runId: "wrun", kind: "sieve", config, members: [sid] })).state, "running");
		await runs.pause("p", "wrun");
		const w = assignments(h);
		await w.set("go", { assignmentId: "sieve-workers", hostId: "host-a", kind: "sieve", targetSpace: sid, count: 2, runId: "wrun" });
		let steps = 0;
		const counted: WorkerKind = { requiresRun: true, step: async x => { steps++; return SIEVE_WORKER_KIND.step(x); } };
		const sup = new WorkerSupervisor({ host: h, ctx, hostId: "host-a", authorityId: "authority", controllerPin: pin, kinds: { sieve: counted }, fetch: () => w.forHost("host-a"), backoff: { minMs: 5, maxMs: 40 } });
		const published: unknown[] = [];
		const stop = startWorkerSupervisor(sup, { intervalMs: 20, publish: async s => { published.push(s); } });
		try {
			await new Promise(r => setTimeout(r, 300));
			const space = new PiSpaces(h, ctx, Date.now, undefined, undefined, { space: sid });
			assert.equal(await space.count({ type: "SieveResult" }), 0, "paused: no task is taken");
			assert.ok(steps < 40, `idle workers back off instead of spinning (${steps} steps in 300 ms)`);
			await runs.resume("r", "wrun");
			assert.ok(await until(async () => (await space.count({ type: "SieveResult" })) === 16, 20_000), "the workers finish all 16 segments");
			assert.equal((await collectSieveResults(space, config)).length, 168);
			assert.ok(published.length > 1, "the periodic pass publishes summaries");
			assert.ok(sup.summary().assignments["sieve-workers"]!.tasks === 16);
		} finally { await stop(); }
	} finally { await home.dispose(); }
});

test("appliedWorkers reads the newest worker summary per host from Capability entries", () => {
	const s = c.initialState();
	c.write(s, 0, { type: "Capability", fields: { hostId: "host-a", at: 10, metrics: { workers: { generation: 1 } } } }, null, c.FOREVER);
	c.write(s, 0, { type: "Capability", fields: { hostId: "host-a", at: 20, metrics: { workers: { generation: 2 } } } }, null, c.FOREVER);
	c.write(s, 0, { type: "Capability", fields: { hostId: "host-b", at: 5, metrics: {} } }, null, c.FOREVER);
	assert.deepEqual(appliedWorkers(s, 1), { "host-a": { at: 20, workers: { generation: 2 } as any } });
});

for (const backend of BACKENDS) test(`${backend}: the control Gate gives a proven host only its own signed assignments`, async () => {
	const home = new PersistentHome(backend);
	try {
		const h = await home.open(), hostKey = generateKey("ed25519", "host-a");
		await h.commit(tx => createSpace(tx, "control", Date.now()), ctx);
		const w = assignments(h);
		await w.set("a", { assignmentId: "mine", hostId: "peer-host-a", kind: "sieve", targetSpace: "sp-1", count: 1 });
		await w.set("b", { assignmentId: "theirs", hostId: "peer-host-b", kind: "sieve", targetSpace: "sp-2", count: 1 });
		let active = true;
		const runtime = await startFederationHost(h, ctx, {
			hostId: "control-host", authorityId: "authority", unsafeSkipBootGuardForTests: true, groupRoles: { "space-hosts": ["host"] },
			keys: { find: async (peer, k) => peer === "peer-host-a" && k === hostKey.signer.keyId ? { peerId: peer, principal: peer, keyId: k, algorithm: "ed25519", publicKey: hostKey.publicKey, state: active ? "active" : "revoked", roles: ["host"], scope: ["*"] } : null },
			verifier: new GrantVerifier({ authorityId: "authority", issuerHostId: "control-host", algorithm: "ed25519", publicKey: controlKey.publicKey }),
			directory: { refresh: async () => {}, lookup: async ip => ip === "127.0.0.2" ? { id: "peer-host-a", name: "host-a", ip, connected: true, groups: ["space-hosts"] } : null },
			listen: { host: "127.0.0.1", port: 0 }, revalidateMs: 0,
			control: { host: h, authority: {} as any, workers: w },
		});
		const socket = socketTransport({ host: "127.0.0.1", port: (runtime.address() as any).port }, { localAddress: "127.0.0.2" });
		try {
			const remote = new RemoteSpace(socket, { signer: hostKey.signer, ownPeerId: "peer-host-a", expectedGateHostId: "control-host", attempts: 1 });
			await remote.authenticate();
			const list = await remote.workerAssignments();
			assert.deepEqual(list.value.assignments.map(x => x.assignmentId), ["mine"], "the host comes from the proven connection");
			active = false;
			await assert.rejects(remote.workerAssignments(), /proven host|authorized/);
		} finally { socket.close(); await runtime.close(); }
	} finally { await home.dispose(); }
});
