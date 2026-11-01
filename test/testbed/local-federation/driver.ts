// One step of the scenario, run in the `client` container (its address is the peer `user`) or the `router` container. Each prints
// what it saw, so the two Members can be held against each other.
import { readFileSync, writeFileSync } from "node:fs";
import { FOREVER, OutcomeUnknown, RemoteSpace, TlsRecoveryRegister, loadFileSigner, socketTransport } from "../../../src/index.ts";
import { signMembership } from "../../../src/membership.ts";
import { signRun } from "../../../src/run-member.ts";
import { signLifecycle } from "../../../src/space-lifecycle.ts";
import { IP, PORT, POLICY } from "./net.ts";

const step = process.argv[2]!;
const state = JSON.parse(readFileSync("/fed/state.json", "utf8")) as Record<string, any>;
const save = () => writeFileSync("/fed/state.json", JSON.stringify(state));
const seen: Record<string, unknown> = {};
const options = { attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 15_000, maxClientWaitMs: 500 };
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

const steps: Record<string, () => Promise<void>> = {
	async ready() { await until(user, 90_000); seen.ready = true; },
	async routerReady() { await until(router, 90_000); seen.routerReady = true; },
	async setup() {
		const r = await router();
		seen.add = (await member(r, "t1", "prepareAdd")).state;
		seen.retry = (await member(r, "t1", "prepareAdd")).state;
		seen.active = (await member(r, "t1", "activate", { policy: POLICY(1) })).state;
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
