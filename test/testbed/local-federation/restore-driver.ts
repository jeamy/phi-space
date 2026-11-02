// A client and the operator of `run.ts restore`, in the `client` container. Each step prints what it was answered.
import { readFileSync } from "node:fs";
import { FOREVER, RecoveryClient, RemoteSpace, TlsFencing, TlsRecoveryRegister, loadFileSigner, socketTransport } from "../../../src/index.ts";
import { DATA_B, GATEWAY, IP, PORT, RPORT } from "./net.ts";

const [step, host, label] = process.argv.slice(2);
const state = JSON.parse(readFileSync("/fed/state.json", "utf8")) as Record<string, string>;
const options = { attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 20_000, maxClientWaitMs: 500 };
const DATA: Record<string, string> = { "data-host": IP.member, "data-host-b": DATA_B };
const signer = () => loadFileSigner("/fed/user-key.json"), line = (ip: string, port: number) => socketTransport({ host: ip, port }, { localAddress: IP.client, connectTimeoutMs: 8000 });
const tls = { caFile: "/fed/ca.crt", certFile: "/fed/operator.crt", keyFile: "/fed/operator.key" };
const refusal = (e: unknown) => ({ refused: (e as Error).constructor.name, message: (e as Error).message.slice(0, 100) });
const until = async <T>(f: () => Promise<T>, ms = 90_000): Promise<T> => { const end = Date.now() + ms; for (;;) { try { return await f(); } catch (e) { if (Date.now() > end) throw e; await new Promise((r) => setTimeout(r, 1000)); } } };
async function notes(hostId: string) {
	const home = new RemoteSpace(line(IP.control, PORT.control), { ...options, space: "control", signer: signer(), expectedGateHostId: "control-host", ownPeerId: "user" });
	await home.authenticate();
	const space = new RemoteSpace(line(DATA[hostId]!, PORT.member), { ...options, space: state.notes, signer: signer(), expectedGateHostId: hostId, ownPeerId: "user", grantProvider: () => home.requestGrant() });
	await space.authenticate();
	return space;
}
const labels = async (space: RemoteSpace) => (await space.readAll({ type: "Note" })).map((e) => (e.fields as { label: string }).label).sort();

const seen: Record<string, unknown> = {};
if (step === "note") {
	const space = await until(() => notes(host!));
	seen.write = await space.write({ type: "Note", fields: { label } }, null, FOREVER).then(() => "answered", refusal);
	seen.notes = await labels(space);
} else if (step === "notes") {
	seen.notes = await notes(host!).then(labels, refusal);
} else if (step === "take") {
	const space = await until(() => notes(host!));
	seen.take = await space.take({ type: "Note", fields: { label } }, 0).then((e) => e ? "taken" : "none", refusal);
} else if (step === "release") {
	// the operator releases what the restore brought back unverified, at the target's private recovery endpoint
	const target = new RecoveryClient(`/fed/recovery-${label}.sock`, { hostId: host!, signer: loadFileSigner("/fed/operator-key.json") });
	seen.release = await target.call("releaseRestored", { commandId: "release-notes-1", recoveryId: "restore-notes-1", scope: { type: "Note" } }).catch(refusal);
} else if (step === "fence") {
	const proof = await new TlsFencing({ ...tls, host: GATEWAY, port: RPORT.fencing, kind: "container" }).fence(host!, "data restore");
	seen.fenced = proof.restartLocked;
} else if (step === "restore") {
	// the operator at the target's private recovery endpoint: submit, then advance until the restore is installed
	const target = new RecoveryClient(`/fed/recovery-${label}.sock`, { hostId: host!, signer: loadFileSigner("/fed/operator-key.json") });
	const request = { recoveryId: "restore-notes-1", space: state.notes, snapshotRef: "notes.json", targetHostId: host, expectedDataIncarnation: state.notesIncarnation, expectedPrimaryEpoch: 1 };
	const states: string[] = [];
	let job = await target.call("restoreDataSpace", request as never).catch(refusal) as { state?: string; refused?: string };
	if (job.refused) seen.submit = job;
	for (const end = Date.now() + 150_000; job.state && job.state !== "completed" && Date.now() < end;) {
		if (states.at(-1) !== job.state) states.push(job.state);
		job = await target.call("advanceRestore", { recoveryId: request.recoveryId }) as { state: string };
		if (job.state !== "completed") await new Promise((r) => setTimeout(r, 2000));
	}
	if (job.state) states.push(job.state);
	seen.states = states;
	const register = new TlsRecoveryRegister({ ...tls, host: IP.register, port: PORT.register });
	seen.placement = (await register.get<{ hostId: string }>(`placement:${state.notes}`))?.value.hostId;
	seen.source = (await register.get<{ state: string }>("boot:data-host"))?.value.state;
	register.close();
} else throw new Error(`unknown step ${step}`);
console.log(JSON.stringify({ step, host, ...seen }));
process.exit(0);
