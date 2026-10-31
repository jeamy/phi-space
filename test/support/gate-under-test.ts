// The gate a test runs against (docs/rust-portierung.en.md, R5). Without PHI_SPACES_SERVER_CMD: startGate in this process, on a
// test host. With it: that server as a process, its clock, keys and events in files a test can change and read between two
// calls. Both ask the same management API, so what a test holds of the directory it holds of both.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type net from "node:net";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { GateIdentity, MemoryKeyDirectory, NetbirdDirectory, ProvingService, SpaceService, socketTransport, startGate, type PeerKeyRec, type Policy } from "../../src/index.ts";
import { openTestHost } from "./host.ts";
import { ctx } from "./persistent.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CMD = process.env.PHI_SPACES_SERVER_CMD?.trim() ? process.env.PHI_SPACES_SERVER_CMD.trim().split(/\s+/) : null;
export const OTHER_SERVER = CMD !== null;

const scratch = (tc: TestContext) => { const dir = mkdtempSync("/tmp/phi-gut-"); tc.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const put = (file: string, text: string) => { writeFileSync(`${file}.tmp`, text); renameSync(`${file}.tmp`, file); };

/** The gate's clock. */
export class TestClock {
	private at = 1_000_000;
	readonly file: string;
	constructor(tc: TestContext) { this.file = join(scratch(tc), "clock"); put(this.file, String(this.at)); }
	get t() { return this.at; }
	set t(v: number) { this.at = v; put(this.file, String(v)); }
	now = () => this.at;
}

/** The control space's keys, as the gate sees them. */
export class TestKeys extends MemoryKeyDirectory {
	private list = new Map<string, PeerKeyRec>();
	readonly file: string;
	constructor(tc: TestContext) { super(); this.file = join(scratch(tc), "keys.json"); put(this.file, "[]"); }
	private save() { put(this.file, JSON.stringify([...this.list.values()])); }
	override add(rec: PeerKeyRec) { super.add(rec); this.list.set(`${rec.peerId}\n${rec.keyId}`, { ...rec }); this.save(); }
	override revoke(peerId: string, keyId: string) { super.revoke(peerId, keyId); const k = this.list.get(`${peerId}\n${keyId}`); if (k) k.state = "revoked"; this.save(); }
}

export type GateCase = { url: string; token?: string; cacheMs?: number; clock: TestClock; keys?: TestKeys; gateHostId?: string; policy?: Policy; host?: string; handshakeMs?: number; maxConnectionsPerPeer?: number; connectionsPerSecondPerPeer?: number };
type Seen = { event: string; ip: string; peerId?: string; reason?: string };
export type GateUnderTest = { port: number; readonly events: Seen[]; peers(): Promise<Array<{ peerId: string; ip: string; roles: string[]; proven: boolean }>>; revalidate(): Promise<number> };

async function inProcess(tc: TestContext, c: GateCase): Promise<GateUnderTest> {
	const directory = new NetbirdDirectory({ url: c.url, token: c.token ?? "t", now: c.clock.now, ...(c.cacheMs === undefined ? {} : { cacheMs: c.cacheMs }) });
	const host = await openTestHost(ctx);
	tc.after(() => host.close(ctx));
	const service = new SpaceService({ host, ctx, identity: new GateIdentity(), ...(c.policy ? { policy: c.policy } : {}) });
	const front = c.gateHostId && c.keys ? new ProvingService(service, { gateHostId: c.gateHostId, keys: c.keys, now: c.clock.now }) : service;
	const events: Seen[] = [];
	const gate = await startGate(front, {
		listen: { host: c.host ?? "127.0.0.1", port: 0 }, directory, revalidateMs: 0, now: c.clock.now, onEvent: (e) => events.push(e),
		...(c.keys ? { keys: c.keys } : {}), ...(c.handshakeMs === undefined ? {} : { handshakeMs: c.handshakeMs }),
		...(c.maxConnectionsPerPeer === undefined ? {} : { maxConnectionsPerPeer: c.maxConnectionsPerPeer }), ...(c.connectionsPerSecondPerPeer === undefined ? {} : { connectionsPerSecondPerPeer: c.connectionsPerSecondPerPeer }),
	});
	tc.after(() => gate.close());
	return { port: (gate.address() as net.AddressInfo).port, events, peers: async () => gate.peers(), revalidate: () => gate.revalidate() };
}

async function asProcess(tc: TestContext, c: GateCase): Promise<GateUnderTest> {
	const dir = scratch(tc), eventsFile = join(dir, "events"), config = join(dir, "case.json"), hooksPath = join(dir, "hooks.sock");
	put(eventsFile, "");
	writeFileSync(config, JSON.stringify({
		hooks: hooksPath, endpoints: [], identities: {}, policy: c.policy?.roles,
		gate: { host: c.host ?? "127.0.0.1", port: 0, url: c.url, token: c.token ?? "t", cacheMs: c.cacheMs, handshakeMs: c.handshakeMs, maxConnectionsPerPeer: c.maxConnectionsPerPeer, connectionsPerSecondPerPeer: c.connectionsPerSecondPerPeer, clockFile: c.clock.file, eventsFile, keysFile: c.keys?.file, gateHostId: c.gateHostId },
	}));
	const proc = spawn(CMD![0]!, [...CMD!.slice(1), "--store", "memory", "--listen", `unix:${join(dir, "unused.sock")}`, "--test-hooks", config], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
	const port = await new Promise<number>((resolve, reject) => {
		let out = "";
		const seen = (d: Buffer) => { out += d; const m = /ready on tcp:[^:]+:(\d+)/.exec(out); if (m) resolve(Number(m[1])); };
		proc.stdout.on("data", seen);
		proc.stderr.on("data", seen);
		proc.on("error", reject);
		proc.on("exit", (code) => reject(new Error(`the server under test exited (${code}):\n${out}`)));
	});
	const hooks = socketTransport({ path: hooksPath });
	tc.after(async () => { hooks.close(); await new Promise<void>((r) => { proc.removeAllListeners("exit"); proc.once("exit", () => r()); proc.kill("SIGTERM"); }); });
	const hook = async <T,>(name: string) => { const r = JSON.parse(await hooks.request(JSON.stringify({ hook: name }))) as { result: T }; return r.result; };
	return {
		port,
		get events() { return readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Seen); },
		peers: () => hook("peers"),
		revalidate: () => hook("revalidate"),
	};
}

export const gateUnderTest = (tc: TestContext, c: GateCase): Promise<GateUnderTest> => OTHER_SERVER ? asProcess(tc, c) : inProcess(tc, c);
