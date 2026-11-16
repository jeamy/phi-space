// A client, the recovery admin and the operator of `run.ts change` and `run.ts control-restore`, in the `client` container. Each step prints what it was answered.
import { readFileSync, writeFileSync } from "node:fs";
import { FOREVER, RecoveryClient, RemoteSpace, SqliteRecoveryRegister, TlsFencing, TlsRecoveryRegister, loadFileSigner, recordControlHostChange, signControlHostChange, socketTransport } from "../../../src/index.ts";
import { CONTROL_B, GATEWAY, IP, PORT, POLICY, RPORT } from "./net.ts";

const [step, host, label, key] = process.argv.slice(2);
const state = JSON.parse(readFileSync("/fed/state.json", "utf8")) as Record<string, string>;
const options = { attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 20_000, maxClientWaitMs: 500 };
const CONTROL: Record<string, string> = { "control-host": IP.control, "control-host-b": CONTROL_B };
const signer = () => loadFileSigner(`/fed/${key ?? "user-key"}.json`), line = (ip: string, port: number) => socketTransport({ host: ip, port }, { localAddress: IP.client, connectTimeoutMs: 8000 });
const operator = () => new TlsRecoveryRegister({ caFile: "/fed/ca.crt", certFile: "/fed/operator.crt", keyFile: "/fed/operator.key", host: IP.register, port: PORT.register });
const refusal = (e: unknown) => ({ refused: (e as Error).constructor.name, code: (e as { code?: string }).code ?? null, message: (e as Error).message.slice(0, 80) });
const until = async <T>(f: () => Promise<T>, ms = 90_000): Promise<T> => { const end = Date.now() + ms; for (;;) { try { return await f(); } catch (e) { if (Date.now() > end) throw e; await new Promise((r) => setTimeout(r, 1000)); } } };
async function control(hostId: string) {
	const home = new RemoteSpace(line(CONTROL[hostId]!, PORT.control), { ...options, space: "control", signer: signer(), expectedGateHostId: hostId, ownPeerId: "user" });
	await home.authenticate();
	return home;
}
const recovery = (hostId: string, name: string) => new RecoveryClient(`/fed/recovery-only-${name}.sock`, { hostId, signer: loadFileSigner("/fed/operator-key.json") });
const jobs = (grant: () => Promise<unknown>) => new RemoteSpace(line(IP.member, PORT.member), { ...options, space: state.jobs, signer: signer(), expectedGateHostId: "data-host", ownPeerId: "user", grantProvider: grant as never });

const seen: Record<string, unknown> = {};
if (step === "job") {
	// a grant from this control host, a Job written on the Member with it, and what the Member holds
	const member = await until(async () => { const home = await control(host!), m = jobs(() => home.requestGrant()); await m.authenticate(); await m.count({ type: "Job" }); return m; });
	seen.write = await member.write({ type: "Job", fields: { label } }, null, FOREVER).then(() => "answered", refusal);
	seen.jobs = (await member.readAll({ type: "Job" })).map((e) => (e.fields as { label: string }).label).sort();
} else if (step === "hold") {
	writeFileSync("/fed/grant.json", JSON.stringify(await (await control(host!)).requestGrant()));
	seen.held = true;
} else if (step === "gap") {
	// the control host is gone: what a grant taken before gets on the Member, and whether a new one is to be had
	const held = JSON.parse(readFileSync("/fed/grant.json", "utf8")), member = jobs(async () => held);
	seen.held = await member.authenticate().then(() => member.count({ type: "Job" })).then((n) => `counted ${n}`, refusal);
	seen.fresh = await control(host!).then((h) => h.requestGrant()).then(() => "granted", refusal);
} else if (step === "record") {
	// the recovery admin signs the change; the register takes it only once the promotion shows there
	// at the epoch of the target's primary permit, or, while it is still the standby, the one a promotion would give it
	const register = operator(), p = (await register.get<{ spaces: Record<string, { primaryEpoch: number; role: string }> }>("boot:control-host-b"))!.value.spaces[state.controlSpace]!;
	const target = { primaryEpoch: p.role === "primary" ? p.primaryEpoch : p.primaryEpoch + 1 };
	const b = loadFileSigner("/fed/control-b-key.json"), admin = loadFileSigner(`/fed/${label ?? "admin"}-key.json`), pinned = JSON.parse(readFileSync("/fed/control.config.json", "utf8")).recoveryAdmin;
	const change = { recoveryId: "change-1", authorityId: "authority", controlSpaceId: state.controlSpace, fromHostId: "control-host", targetHostId: "control-host-b", primaryEpoch: target.primaryEpoch, supervisorKey: b.publicKey, algorithm: b.algorithm, address: { host: CONTROL_B, port: PORT.control } };
	seen.recorded = await recordControlHostChange(register, await signControlHostChange(change as never, admin), pinned).then((c) => c.targetHostId, refusal);
	register.close();
} else if (step === "installed") {
	const installed = new SqliteRecoveryRegister("/fed/installed-member.sqlite");
	seen.follows = (await installed.get<{ targetHostId?: string }>(`installed-authority:${state.controlSpace}`))?.value.targetHostId ?? null;
	installed.close();
} else if (step === "fence" || step === "release") {
	const fencing = new TlsFencing({ caFile: "/fed/ca.crt", certFile: "/fed/operator.crt", keyFile: "/fed/operator.key", host: GATEWAY, port: RPORT.fencing, kind: "container" });
	seen[step] = step === "fence" ? (await fencing.fence(host!, "control restore")).restartLocked : await fencing.release(host!).then(() => true);
} else if (step === "restore-control" || step === "finish-restore") {
	// the operator at the control host's recovery-only endpoint: submit and advance to the wait for the Members, or after it to completion
	const control = recovery(host!, "control"), recoveryId = "control-restore-1", states: string[] = [];
	const request = { recoveryId, controlSpaceId: state.controlSpace, snapshotRef: "control.json", expectedAuthorityId: "authority", expectedDataIncarnation: state.controlIncarnation, expectedPrimaryEpoch: 1, targetHostId: host, confirmedMembers: [host!, "data-host"] };
	// a conflict answers a lost race in the register; the same recovery ID continues it
	const submit = async (): Promise<unknown> => { try { return await control.call("restoreControlSpace", request as never); } catch (e) { if ((e as Error).constructor.name !== "RegisterConflict") throw e; seen.conflicts = Number(seen.conflicts ?? 0) + 1; return submit(); } };
	let job = (step === "restore-control" ? await submit() : await control.call("controlRestoreStatus", { recoveryId })) as { state: string; proof: unknown };
	const goal = step === "restore-control" ? "waiting" : "completed";
	for (const end = Date.now() + 150_000; job.state !== goal && Date.now() < end;) {
		if (states.at(-1) !== job.state) states.push(job.state);
		try { job = await control.call("advanceControlRestore", { recoveryId }) as typeof job; } catch (e) { if (!/not expired/.test((e as Error).message)) throw e; await new Promise((r) => setTimeout(r, 3000)); }
	}
	states.push(job.state);
	if (step === "restore-control") writeFileSync("/fed/proof.json", JSON.stringify(job.proof));
	seen.states = states;
} else if (step === "install") {
	// the Member installs the new authority at its recovery-only endpoint, step by step
	const member = recovery("data-host", "member"), proof = JSON.parse(readFileSync("/fed/proof.json", "utf8"));
	let done = { completed: false };
	for (let n = 0; n < 50 && !done.completed; n++) done = await member.call("installAuthority", { proof }) as typeof done;
	seen.installed = done.completed;
} else if (step === "authorize") {
	// the first admin, and new keys for the Member host and the client: a restore revokes every key, and an old one is never revived
	// the admin key on the client's peer, which is the one with an overlay address here
	const keys = [["user", "admin-key", ["admin"]], ["member-peer", "member-key-2", ["host"]], ["user", "user-key-2", ["member"]]] as const, out: unknown[] = [];
	for (const [peerId, file, roles] of keys) { const k = loadFileSigner(`/fed/${file}.json`); out.push(await recovery(host!, "control").call("authorizeRecoveryKey", { recoveryId: "control-restore-1", key: { peerId, publicKey: k.publicKey, algorithm: k.algorithm, roles: [...roles], scope: ["*"] } }).then(() => true, refusal)); }
	const old = loadFileSigner("/fed/user-key.json");
	out.push(await recovery(host!, "control").call("authorizeRecoveryKey", { recoveryId: "control-restore-1", key: { peerId: "user", publicKey: old.publicKey, algorithm: old.algorithm, roles: ["member"], scope: ["*"] } }).then(() => "revived", refusal));
	seen.authorized = out;
} else if (step === "policy") {
	// the first admin sets the routing policy anew, under the new authority, by a supervisor command
	const register = operator(), authorityId = (await register.get<{ authorityId: string }>(`authority:${state.controlSpace}`))!.value.authorityId;
	register.close();
	const t = line(CONTROL[host!]!, PORT.control);
	const admin: RemoteSpace = new RemoteSpace(t, { ...options, space: "control", signer: loadFileSigner("/fed/admin-key.json"), expectedGateHostId: host!, ownPeerId: "user", grantProvider: () => admin.requestGrant() });
	await admin.authenticate();
	const policy = { ...(POLICY(Number(label ?? 2)) as object), authorityId };
	await admin.write({ type: "Command", fields: { commandId: `policy-after-restore-${label ?? 2}-${key ?? "first"}`, kind: "setPolicy", args: { policy, expectedVersion: Number(label ?? 2) - 1 } as never } }, null, 3_600_000);
	let result = undefined as Record<string, unknown> | undefined;
	for (let i = 0; i < 200 && !result; i++) { result = (await admin.readAll({ type: "Result", fields: { commandId: `policy-after-restore-${label ?? 2}-${key ?? "first"}` } }))[0]?.fields as unknown as typeof result; if (!result) await new Promise((r) => setTimeout(r, 100)); }
	seen.policy = result ? { state: result.state, error: result.error ?? null } : null;
} else if (step === "authority") {
	const register = operator(), a = (await register.get<{ authorityId: string; hostId: string; state: string }>(`authority:${state.controlSpace}`))!.value;
	seen.authority = { renamed: a.authorityId !== "authority", hostId: a.hostId, state: a.state };
	register.close();
} else throw new Error(`unknown step ${step}`);
console.log(JSON.stringify({ step, host, ...seen }));
process.exit(0);
