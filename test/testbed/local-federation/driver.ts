// One step of the scenario, run in the `client` container (its address is the peer `user`) or the `router` container. Each prints
// what it saw, so the two Members can be held against each other.
import { readFileSync, writeFileSync } from "node:fs";
import { FOREVER, OutcomeUnknown, RemoteSpace, TlsRecoveryRegister, loadFileSigner, socketTransport } from "../../../src/index.ts";
import { signMembership } from "../../../src/membership.ts";
import { signRun } from "../../../src/run-member.ts";
import { signLifecycle } from "../../../src/space-lifecycle.ts";
import { verifyWorkers } from "../../../src/workers.ts";
import { IP, PORT, POLICY } from "./net.ts";

const step = process.argv[2]!;
const state = JSON.parse(readFileSync("/fed/state.json", "utf8")) as Record<string, any>;
const save = () => writeFileSync("/fed/state.json", JSON.stringify(state));
const seen: Record<string, unknown> = {};
// the client gives up on a blocking call after 5 s (OutcomeUnknown): long enough that a call reaches the Member on a loaded machine,
// so `waiting` leaves a request the Member holds rather than one that never arrived
const options = { attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 15_000, maxClientWaitMs: 5_000 };
const line = (host: string, port: number, from: string) => socketTransport({ host, port }, { localAddress: from });
const controlKey = () => loadFileSigner("/fed/control-key.json");
const toControl = () => new RemoteSpace(line(IP.control, PORT.control, IP.client), { ...options, space: "control", signer: loadFileSigner("/fed/user-key.json"), expectedGateHostId: "control-host", ownPeerId: "user" });
async function user() {
	const home = toControl();
	await home.authenticate();
	const member = new RemoteSpace(line(IP.member, PORT.member, IP.client), { ...options, space: state.jobs, signer: loadFileSigner("/fed/user-key.json"), expectedGateHostId: "data-host", ownPeerId: "user", grantProvider: () => home.requestGrant() });
	await member.authenticate();
	return member;
}
async function router() {
	const remote = new RemoteSpace(line(IP.member, PORT.member, IP.router), { ...options, signer: loadFileSigner("/fed/router-key.json"), expectedGateHostId: "data-host", ownPeerId: "router-peer" });
	await remote.authenticate();
	return remote;
}
const run = async (remote: RemoteSpace, commandId: string, kind: string, revision: number, more = {}) => (await remote.requestRunGate(await signRun("instruction", { runId: "r", commandId, kind, revision, authorityId: "authority", spaceId: state.jobs, ...more }, "control-peer", controlKey()) as never)).value as unknown as { state: string };
const member = async (remote: RemoteSpace, id: string, action: string, more = {}) => (await remote.requestMembership(await signMembership("instruction", { authorityId: "authority", memberId: "a", spaceId: state.jobs, id, action, ...more } as never, "control-peer", controlKey()))).value as unknown as { state: string };
const life = async (remote: RemoteSpace, q: Record<string, unknown>) => (await remote.requestSpaceLifecycle(await signLifecycle("instruction", { authorityId: "authority", hostId: "data-host", ...q }, "control-peer", controlKey()) as never)).value;
const refused = async (f: () => Promise<unknown>) => { try { await f(); return false; } catch { return true; } };
/** A call with a grant taken before the break, over a new connection or none at all. */
const held = async () => { const home = toControl(); await home.authenticate(); state.grant = await home.requestGrant(); save(); };
const bare = async () => { const t = line(IP.member, PORT.member, IP.client); try { await new RemoteSpace(t, { ...options, space: state.jobs, signer: loadFileSigner("/fed/user-key.json"), expectedGateHostId: "data-host", ownPeerId: "user" }).authenticate(); const r = JSON.parse(await t.request(JSON.stringify({ method: "count", args: { template: { type: "Job" } }, space: state.jobs, frame: { grant: state.grant } }))) as { ok: boolean; result?: { value: number } }; if (!r.ok) throw new Error(JSON.stringify(r)); return r.result!.value; } finally { t.close(); } };
const until = async <T>(f: () => Promise<T>, ms = 40_000): Promise<T> => { const end = Date.now() + ms; for (;;) { try { return await f(); } catch (e) { if (Date.now() > end) throw e; await new Promise((r) => setTimeout(r, 500)); } } };
const operator = () => new TlsRecoveryRegister({ caFile: "/fed/ca.crt", certFile: "/fed/operator.crt", keyFile: "/fed/operator.key", host: IP.register, port: PORT.register });

/** The Root's own agent, on a line of the control host's peer; a step in the `control` container. */
async function agent() {
	const t = line(IP.control, PORT.control, IP.control);
	await new RemoteSpace(t, { ...options, signer: loadFileSigner("/fed/root-host.json"), expectedGateHostId: "control-host", ownPeerId: "control-peer" }).authenticate();
	return async (method: string, args: Record<string, unknown>) => {
		const r = JSON.parse(await t.request(JSON.stringify({ method, args: { agentId: "worker", ...args } }))) as { ok: boolean; result?: any; error?: { code: string } };
		if (!r.ok) throw new Error(r.error!.code);
		return r.result;
	};
}
/** The adminPeer `boss` in the `admin` container: a command written into the control Space and the Result the Root writes back. */
async function admin() {
	const remote: RemoteSpace = new RemoteSpace(line(IP.control, PORT.control, IP.admin), { ...options, space: "control", signer: loadFileSigner("/fed/admin-key.json"), expectedGateHostId: "control-host", ownPeerId: "boss", grantProvider: () => remote.requestGrant() });
	await remote.authenticate();
	return async (commandId: string, kind: string, args: Record<string, unknown>) => {
		await remote.write({ type: "Command", fields: { commandId, kind, args: args as never } }, null, 3_600_000);
		for (let i = 0; i < 1200; i++) { const r = (await remote.readAll({ type: "Result", fields: { commandId } }))[0]?.fields as Record<string, any> | undefined; if (r) return r; await new Promise((r2) => setTimeout(r2, 50)); }
		throw new Error(`no result for ${commandId}`);
	};
}
const code = (f: () => Promise<unknown>) => f().then(() => "answered", (e: Error) => e.message);
const ROOTED = (n: number) => ({ type: "Rooted", fields: { n } });

const steps: Record<string, () => Promise<void>> = {
	async ready() { await until(user, 90_000); seen.ready = true; },
	async routerReady() { await until(router, 90_000); seen.routerReady = true; },
	async setup() {
		const r = await router();
		seen.add = (await member(r, "t1", "prepareAdd")).state;
		seen.retry = (await member(r, "t1", "prepareAdd")).state;
		seen.active = (await member(r, "t1", "activate", { policy: POLICY(1) })).state;
	},
	async rootFirst() {
		const root = await until(agent, 90_000);
		const wrote = await until(() => root("rootWrite", { id: "w1", entry: ROOTED(1), leaseMs: 600_000 }));
		seen.retry = JSON.stringify(await root("rootWrite", { id: "w1", entry: ROOTED(1), leaseMs: 600_000 })) === JSON.stringify(wrote);
		seen.conflict = await code(() => root("rootWrite", { id: "w1", entry: ROOTED(9), leaseMs: 600_000 }));
		seen.count = (await root("rootCount", { template: { type: "Rooted" } })).count;
	},
	async rootMemberDown() { seen.down = await code(async () => (await agent())("rootWrite", { id: "w2", entry: ROOTED(2), leaseMs: 600_000 })); },
	async rootMemberBack() {
		const root = await until(agent);
		await until(() => root("rootResume", { id: "w2" }));
		seen.count = (await until(() => root("rootCount", { template: { type: "Rooted" } }))).count;
	},
	async rootAfterKill() {
		const root = await until(agent, 90_000);
		seen.count = (await until(() => root("rootCount", { template: { type: "Rooted" } }))).count;
		seen.resumed = await code(() => root("rootResume", { id: "w1" }));
		await until(() => root("rootWrite", { id: "w3", entry: ROOTED(3), leaseMs: 600_000 }));
	},
	async rootHandedOver() {
		const root = await until(agent, 90_000);
		seen.retry = await until(() => code(() => root("rootResume", { id: "w3" })));
		seen.fresh = await code(() => until(() => root("rootTake", { id: "t1", template: { type: "Rooted", fields: { n: 1 } } })));
		seen.count = (await until(() => root("rootCount", { template: { type: "Rooted" } }))).count;
	},
	async rootAfterKill2() {
		const root = await until(agent, 90_000);
		seen.count = (await until(() => root("rootCount", { template: { type: "Rooted" } }))).count;
	},
	async prepare() {
		const spec = { runId: "r", kind: "tasks", config: { tasks: [{ type: "Gated", fields: { n: 1 } }, { type: "Gated", fields: { n: 2 } }] }, members: [state.jobs] };
		seen.prepare = (await run(await router(), "p", "prepare", 1, { spec })).state;
	},
	async work() {
		const u = await user();
		await u.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
		seen.tasks = await u.count({ type: "Gated" });
		seen.behindGate = await u.take({ type: "Gated" }, 0);
	},
	async pause() {
		const r = await router();
		seen.release = (await run(r, "go", "release", 2)).state;
		state.pause = await run(r, "hold", "pause", 3);
		seen.pause = state.pause.state;
		save();
	},
	async waiting() {
		const u = await user();
		try { await u.take({ type: "Later" }, FOREVER); } catch (e) { seen.waiting = e instanceof OutcomeUnknown; state.pending = (e as OutcomeUnknown).request; }
		save();
	},
	async afterKillRouter() {
		const r = await until(router);
		seen.pauseSame = JSON.stringify(await run(r, "hold", "pause", 3)) === JSON.stringify(state.pause);
		seen.outdated = await refused(() => run(r, "other", "pause", 3));
	},
	async afterKill() {
		const u = await until(user);
		await u.write({ type: "Later", fields: {} }, null, FOREVER);
		seen.taken = (await u.pollOperation(state.pending, 0)).state;
		seen.later = await u.count({ type: "Later" });
		seen.jobs = await u.count({ type: "Job" });
	},
	async grant() { await held(); },
	async broken() { seen.refused = await refused(bare); },
	async healed() { seen.value = await until(async () => { await held(); return bare(); }); },
	async fence() {
		const external = operator(), key = "boot:data-host";
		const set = async (s: string) => { const b = (await external.get<Record<string, never>>(key))!; await external.compareAndSet(key, b.version, { ...b.value, state: s } as never); };
		await held();
		await set("fenced");
		seen.fenced = await refused(bare);
		await set("active");
		seen.back = await until(bare);
	},
	// in the `router` container: run rx stopped on the Member before the Root ever starts it
	async adminPrepare() { seen.rxStop = (await run(await router(), "rx-stop", "stop", 1, { runId: "rx" })).state; },
	// the admin commands of the Root (own result, held against the other pairings apart from the scenario's)
	async admin() {
		const command = await until(admin, 60_000);
		const done = async (id: string, kind: string, args: Record<string, unknown>) => { const r = await command(id, kind, args); if (r.state !== "completed") throw new Error(`${kind}: ${JSON.stringify(r)}`); return r.result as Record<string, any>; };
		// a reason without the Space IDs each provisioning draws anew, so the pairings can be held against each other
		const failed = async (id: string, kind: string, args: Record<string, unknown>) => { const r = await command(id, kind, args); if (r.state !== "failed") throw new Error(`${kind} did not fail: ${JSON.stringify(r)}`); return String(r.result?.error ?? r.error).replaceAll(state.jobs, "<jobs>").replace(/sp-[0-9a-f-]{36}/g, "<space>"); };
		const tasks = (runId: string, ns: number[]) => ({ runId, kind: "tasks", config: { tasks: ns.map((n) => ({ type: "Gated", fields: { n } })) }, members: [state.jobs] });
		// a Member that refuses: the router stopped run rx there first (step `adminPrepare`), so the Root's prepare meets a
		// terminal gate of another command; the start fails with the Member's reason and the run loop leaves it
		seen.refused = await failed("run-0", "startRun", tasks("rx", [0]));
		seen.refusedPending = (await done("run-0-status", "runStatus", { runId: "rx" })).pending?.refused?.map((x: string) => x === state.jobs ? "<jobs>" : x);
		// the stop goes to the Member too, which has its own stop of rx from another command: refused as well
		seen.refusedStop = await failed("run-0-stop", "stopRun", { runId: "rx" });
		// a run through its gates on the Member: prepare, release, pause, stop
		seen.dry = await done("run-dry", "startRun", { ...tasks("ra", [10, 11]), dryRun: true });
		seen.started = (await done("run-1", "startRun", tasks("ra", [10, 11]))).state;
		seen.paused = (await done("run-2", "pauseRun", { runId: "ra" })).state;
		seen.stopped = (await done("run-3", "stopRun", { runId: "ra" })).state;
		seen.revision = (await done("run-4", "runStatus", { runId: "ra" })).revision;
		seen.runs = (await done("run-5", "listRuns", {})).length;
		seen.pauseStopped = await failed("run-6", "pauseRun", { runId: "ra" });
		// worker assignments, pulled by their host in the step `workerPull`
		const assigned = await done("w-1", "setWorkers", { assignmentId: "w1", hostId: "data-host", kind: "sieve", targetSpace: state.jobs, count: 2 });
		seen.workers = [assigned.generation, assigned.count, (await done("w-2", "listWorkers", {})).assignments.length];
		// a Space through its life on the Member, under its permits
		seen.archive = (await done("s-1", "archiveSpace", { hostId: "data-host", spaceId: state.notes })).state;
		seen.reactivate = (await done("s-2", "reactivateSpace", { hostId: "data-host", spaceId: state.notes })).state;
		seen.unpermitted = await failed("s-3", "createSpace", { hostId: "data-host", alias: "unpermitted" });
		seen.nowhere = await failed("s-4", "archiveSpace", { hostId: "nowhere", spaceId: state.notes });
		// the deployment: an alias binding and a plan against the hosts' heartbeats
		seen.bind = await done("d-1", "bindHostAlias", { alias: "data", hostId: "data-host" });
		const plan = await done("d-2", "planDeployment", { config: { schemaVersion: 1, deployment: "demo", coordinator: "ctl", hosts: [{ alias: "ctl", role: "coordinator" }, { alias: "data", role: "member-host" }], spaces: [{ alias: "control", host: "ctl", purpose: "control" }, { alias: "more", host: "data", purpose: "data" }] } });
		seen.plan = [plan.ready, plan.steps.map((x: any) => `${x.key}:${x.status}`)];
		seen.exported = (await done("d-3", "exportDeployment", { deployment: "demo" })).hosts;
		// data administration: a Space the control host does not carry
		seen.purgeNowhere = await failed("p-1", "purgeTasks", { spaceId: "sp-nowhere", template: { type: "Task" } });
		const audit = await done("audit-1", "auditLog", { limit: 50 }) as unknown as { kind: string; state: string; requestedBy: string }[];
		seen.audit = [...new Set(audit.map((r) => `${r.kind}:${r.state}:${r.requestedBy}`))].sort();
	},
	// the Member host pulls its worker assignments under the control key (in the `member` container, from the Member's address)
	async workerPull() {
		const t = line(IP.control, PORT.control, IP.member);
		const remote = new RemoteSpace(t, { ...options, space: "control", signer: loadFileSigner("/fed/member-key.json"), expectedGateHostId: "control-host", ownPeerId: "member-peer" });
		await remote.authenticate();
		const key = controlKey(), list = verifyWorkers(await remote.workerAssignments(), { issuer: "control-peer", algorithm: key.algorithm, publicKey: key.publicKey! });
		seen.pulled = [list.hostId, list.generation, list.assignments.map((a) => a.assignmentId)];
	},
	async finish() {
		const r = await router();
		seen.stop = (await run(r, "end", "stop", 4)).state;
		seen.archive = (await life(r, { commandId: "a", action: "archive", spaceId: state.notes })).state;
		seen.create = await refused(() => life(r, { commandId: "c", action: "create", alias: "unpermitted" }));
		seen.reactivate = (await life(r, { commandId: "b", action: "reactivate", spaceId: state.notes })).state;
		seen.drain = (await member(r, "t3", "drain")).state;
	},
};
await steps[step]!();
console.log(JSON.stringify({ step, ...seen }));
process.exit(0);
