// A client and the recovery admin of `run.ts change`, in the `client` container. Each step prints what it was answered.
import { readFileSync, writeFileSync } from "node:fs";
import { FOREVER, RemoteSpace, SqliteRecoveryRegister, TlsRecoveryRegister, loadFileSigner, recordControlHostChange, signControlHostChange, socketTransport } from "../../../src/index.ts";
import { CONTROL_B, IP, PORT } from "./net.ts";

const [step, host, label] = process.argv.slice(2);
const state = JSON.parse(readFileSync("/fed/state.json", "utf8")) as Record<string, string>;
const options = { attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 20_000, maxClientWaitMs: 500 };
const CONTROL: Record<string, string> = { "control-host": IP.control, "control-host-b": CONTROL_B };
const signer = () => loadFileSigner("/fed/user-key.json"), line = (ip: string, port: number) => socketTransport({ host: ip, port }, { localAddress: IP.client, connectTimeoutMs: 8000 });
const operator = () => new TlsRecoveryRegister({ caFile: "/fed/ca.crt", certFile: "/fed/operator.crt", keyFile: "/fed/operator.key", host: IP.register, port: PORT.register });
const refusal = (e: unknown) => ({ refused: (e as Error).constructor.name, code: (e as { code?: string }).code ?? null, message: (e as Error).message.slice(0, 80) });
const until = async <T>(f: () => Promise<T>, ms = 90_000): Promise<T> => { const end = Date.now() + ms; for (;;) { try { return await f(); } catch (e) { if (Date.now() > end) throw e; await new Promise((r) => setTimeout(r, 1000)); } } };
async function control(hostId: string) {
	const home = new RemoteSpace(line(CONTROL[hostId]!, PORT.control), { ...options, space: "control", signer: signer(), expectedGateHostId: hostId, ownPeerId: "user" });
	await home.authenticate();
	return home;
}
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
} else throw new Error(`unknown step ${step}`);
console.log(JSON.stringify({ step, host, ...seen }));
process.exit(0);
