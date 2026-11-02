// A client and the operator of `run.ts replica`, in the `client` container. Each step prints what it was answered.
import { existsSync, readFileSync } from "node:fs";
import { FOREVER, RemoteSpace, TlsFencing, TlsRecoveryRegister, loadFileSigner, readmitSpace, releaseHostToQuarantine, socketTransport } from "../../../src/index.ts";
import { GATEWAY, IP, PORT, REPLICA, RPORT } from "./net.ts";

const [step, name, label, count] = process.argv.slice(2);
const state = JSON.parse(readFileSync("/fed/state.json", "utf8")) as Record<string, any>;
const options = { attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 40_000, maxClientWaitMs: 500 };
const signer = () => loadFileSigner("/fed/user-key.json"), line = (host: string, port: number) => socketTransport({ host, port }, { localAddress: IP.client, connectTimeoutMs: 8000 });
const tls = { caFile: "/fed/ca.crt", certFile: "/fed/operator.crt", keyFile: "/fed/operator.key" };
const operator = () => new TlsRecoveryRegister({ ...tls, host: IP.register, port: PORT.register });
async function ledger(host: string) {
	const home = new RemoteSpace(line(IP.control, PORT.control), { ...options, space: "control", signer: signer(), expectedGateHostId: "control-host", ownPeerId: "user" });
	await home.authenticate();
	const space = new RemoteSpace(line(REPLICA[host as keyof typeof REPLICA], RPORT.gate), { ...options, space: "ledger", signer: signer(), expectedGateHostId: host, ownPeerId: "user", grantProvider: () => home.requestGrant() });
	await space.authenticate();
	return space;
}
const until = async <T>(f: () => Promise<T>, ms = 60_000): Promise<T> => { const end = Date.now() + ms; for (;;) { try { return await f(); } catch (e) { if (Date.now() > end) throw e; await new Promise((r) => setTimeout(r, 500)); } } };
const refusal = (e: unknown) => ({ refused: (e as Error).constructor.name, code: (e as { code?: string }).code ?? null, message: (e as Error).message.slice(0, 80) });

const seen: Record<string, unknown> = {};
if (step === "write") {
	const space = await until(() => ledger(name!)), out: unknown[] = [];
	for (let n = 0; n < Number(count ?? 1); n++) {
		try { await space.write({ type: "Ledger", fields: { label, n } }, null, FOREVER); out.push("answered"); }
		catch (e) { out.push(refusal(e)); break; }
	}
	seen.writes = out;
} else if (step === "hold") {
	// writes `count`, waits until the scenario has cut the standby off (/fed/go), then writes once more on the same session
	const space = await until(() => ledger(name!)), out: unknown[] = [];
	for (let n = 0; n < Number(count); n++) { await space.write({ type: "Ledger", fields: { label, n } }, null, FOREVER); out.push("answered"); }
	console.log(JSON.stringify({ holding: true }));
	while (!existsSync("/fed/go")) await new Promise((r) => setTimeout(r, 200));
	try { await space.write({ type: "Ledger", fields: { label: "fork", n: 0 } }, null, FOREVER); out.push("answered"); } catch (e) { out.push(refusal(e)); }
	seen.writes = out;
} else if (step === "count") {
	const space = await until(() => ledger(name!));
	seen.count = await until(() => space.count({ type: "Ledger" }));
} else if (step === "gone") {
	seen.gone = await ledger(name!).then((s) => s.count({ type: "Ledger" })).then((n) => `served ${n}`, refusal);
} else if (step === "release") {
	const register = operator();
	seen.state = (await releaseHostToQuarantine(register, name!, label!, new TlsFencing({ ...tls, host: GATEWAY, port: RPORT.fencing, kind: "container" }))).state;
	register.close();
} else if (step === "readmit") {
	const register = operator(), boot = (await register.get<{ spaces: Record<string, { role: string; state: string; dataIncarnation: string }> }>(`boot:${name}`))!.value;
	const done: string[] = [];
	for (const [id, p] of Object.entries(boot.spaces)) if (p.role === "local" && p.state === "revoked") { await readmitSpace(register, name!, id, { transitionId: label!, expectedDataIncarnation: p.dataIncarnation }); done.push(id); }
	seen.readmitted = done.length;
	register.close();
} else if (step === "boot") {
	seen.state = (await operator().get<{ state: string }>(`boot:${name}`))?.value.state;
} else throw new Error(`unknown step ${step}`);
console.log(JSON.stringify({ step, name, ...seen }));
process.exit(0);
