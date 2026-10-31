// The space service a test runs against (docs/rust-portierung.md, section 5, B3). Without PHI_SPACES_SERVER_CMD: a
// SpaceService in this process on a test host. With it: that server as a process, on a store file of its own, one socket per
// peer and the test hooks of `--test-hooks`, so the same test holds another implementation to the same behaviour. A
// missing binary fails the test; it never falls back to the TypeScript service.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSpace, inProcessTransport, PhiSpaces, startService, RemoteSpace, SpaceService, StaticIdentity, serveSpace, socketTransport, type Call, type Policy, type Reply, type SpaceServer, type Transport } from "../../src/index.ts";
import { ctx } from "./persistent.ts";
import { openTestHost } from "./host.ts";
import { openSqliteHost } from "../../src/store/sqlite.ts";
import type { ClosableStoreHost } from "../../src/store/types.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CMD = process.env.PHI_SPACES_SERVER_CMD?.trim() ? process.env.PHI_SPACES_SERVER_CMD.trim().split(/\s+/) : null;
/** The tests run against another implementation of the service. */
export const OTHER_SERVER = CMD !== null;

type Identities = Record<string, { principal: { peerId: string; agentId?: string }; roles: string[] }>;
export type Case = {
	identities: Identities;
	policy?: Policy;
	limits?: Record<string, number>;
	/** Options of the service; numbers and flags, as SpaceServiceOptions names them. */
	service?: { hostId?: string; authorityId?: string; primaryEpoch?: number; maxPendingPerPrincipal?: number; maxPendingPerPeer?: number; maxCallsPerWindow?: number; wakeOnCommit?: boolean };
	/** Options of the transport (SocketServeOptions). */
	socket?: { maxFrameBytes?: number; maxConnections?: number; maxInflightPerConnection?: number; idleMs?: number };
	/** Named Spaces the store holds when the service starts. */
	named?: string[];
	/** The reaper and delivery run, as in a server; a server always has them. */
	background?: boolean;
};
/** What a test asks of the host itself, where the in-process test holds a PhiSpaces. */
export type Local = Pick<PhiSpaces, "write" | "count" | "readAll" | "changes"> & { revision(): Promise<{ rev: number; streamId: string }>; setLimits(l: Record<string, number>): Promise<unknown> };
export type UnderTest = {
	/** A transport of this peer; a peer the case does not name is known to nobody. */
	transport(peerId: string): Transport;
	/** A unix socket of this peer, for tests of the transport itself. */
	address(peerId: string): Promise<{ path: string } >;
	handle(call: unknown, conn: { peerId?: string }): Promise<Reply>;
	handleText(text: string, conn: { peerId?: string }): Promise<string>;
	local: Local;
	/** Ids of the named Spaces. */
	named: Record<string, string>;
	connections(): Promise<number>;
	close(): Promise<void>;
};

async function inProcess(c: Case): Promise<UnderTest> {
	const host: ClosableStoreHost = await openTestHost(ctx);
	const named: Record<string, string> = {};
	for (const name of c.named ?? []) named[name] = (await host.commit((tx) => createSpace(tx, name, Date.now()), ctx)).spaceId;
	const stopService = c.background ? await startService(host, ctx) : null;
	const service = new SpaceService({ host, ctx, identity: new StaticIdentity(c.identities), ...(c.policy ? { policy: c.policy } : {}), ...c.service });
	const local = new PhiSpaces(host, ctx);
	if (c.limits) await local.setLimits(c.limits);
	const servers = new Map<string, SpaceServer>();
	let closed = false;
	const dir = mkdtempSync("/tmp/phi-sut-");
	return {
		transport: (peerId) => inProcessTransport(service, { peerId }),
		async address(peerId) {
			const path = join(dir, `${servers.size}.sock`);
			servers.set(peerId, await serveSpace(service, { listen: { path }, connection: () => ({ peerId }), ...c.socket }));
			return { path };
		},
		handle: (call, conn) => service.handle(call as Call, conn),
		handleText: (text, conn) => service.handleText(text, conn),
		local: local as unknown as Local,
		named,
		connections: async () => [...servers.values()].reduce((n, s) => n + s.connections(), 0),
		async close() {
			if (closed) return;
			closed = true;
			for (const s of servers.values()) await s.close();
			await stopService?.();
			await host.close(ctx);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

async function asProcess(c: Case): Promise<UnderTest> {
	const dir = mkdtempSync("/tmp/phi-sut-");
	const HOST = "peer-under-test-host";
	const identities: Identities = { ...c.identities, [HOST]: { principal: { peerId: HOST }, roles: ["member"] } };
	const peers = [...Object.keys(identities)];
	const socket = (peer: string | null) => join(dir, `p${peer === null ? "x" : peers.indexOf(peer)}.sock`);
	const named: Record<string, string> = {};
	if (c.named) {
		const seed = await openSqliteHost(join(dir, "s.sqlite"));
		for (const name of c.named) named[name] = (await seed.commit((tx) => createSpace(tx, name, Date.now()), ctx)).spaceId;
		await seed.close(ctx);
	}
	const config = join(dir, "case.json");
	writeFileSync(config, JSON.stringify({ hooks: join(dir, "hooks.sock"), endpoints: [...peers.map((peer) => ({ listen: `unix:${socket(peer)}`, peer })), { listen: `unix:${socket(null)}`, peer: null }], identities, policy: c.policy?.roles, limits: c.limits, ...c.service, ...c.socket }));
	const proc: ChildProcess = await new Promise((resolve, reject) => {
		const p = spawn(CMD![0]!, [...CMD!.slice(1), "--store", join(dir, "s.sqlite"), "--listen", `unix:${socket(HOST)}`, "--test-hooks", config], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		p.stdout!.on("data", (d: Buffer) => { out += d; if (out.includes("ready on")) resolve(p); });
		p.stderr!.on("data", (d: Buffer) => { out += d; });
		p.on("error", reject);
		p.on("exit", (code) => reject(new Error(`the server under test exited (${code}):\n${out}`)));
	});
	const open: { close(): void }[] = [];
	const transport = (peerId: string): Transport => { const t = socketTransport({ path: socket(peerId in identities ? peerId : null) }, { requestTimeoutMs: 30_000, ...(c.socket?.maxFrameBytes ? { maxFrameBytes: c.socket.maxFrameBytes } : {}) }); open.push(t); return t; };
	const hooks = socketTransport({ path: join(dir, "hooks.sock") });
	const hook = async (line: Record<string, unknown>) => { const r = JSON.parse(await hooks.request(JSON.stringify(line))) as { ok: boolean; result?: unknown; message?: string }; if (!r.ok) throw new Error(r.message); return r.result; };
	const own = transport(HOST);
	const remote = new RemoteSpace(own, { sleep: () => Promise.resolve(), backoffMs: 1 });
	const local: Local = Object.assign(Object.create(remote) as RemoteSpace, {
		async revision() { const r = JSON.parse(await own.request(JSON.stringify({ method: "count", args: {} }))) as { result: { rev: number; streamId: string } }; return { rev: r.result.rev, streamId: r.result.streamId }; },
		setLimits: (limits: Record<string, number>) => hook({ hook: "setLimits", limits }),
	}) as unknown as Local;
	const peersOpen = new Map<string, Transport>();
	const of = (peerId: string | undefined) => { const k = peerId ?? "-"; let t = peersOpen.get(k); if (!t) peersOpen.set(k, t = transport(k)); return t; };
	const handleText = (text: string, conn: { peerId?: string }) => of(conn.peerId).request(text);
	let closed = false;
	return {
		transport,
		address: async (peerId) => ({ path: socket(peerId in identities ? peerId : null) }),
		handle: async (call, conn) => JSON.parse(await handleText(JSON.stringify(call), conn)) as Reply,
		handleText,
		local,
		named,
		connections: async () => await hook({ hook: "connections" }) as number,
		async close() {
			if (closed) return;
			closed = true;
			for (const t of open) t.close();
			hooks.close();
			await new Promise<void>((r) => { proc.removeAllListeners("exit"); proc.once("exit", () => r()); proc.kill("SIGTERM"); });
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

export const underTest = (c: Case): Promise<UnderTest> => OTHER_SERVER ? asProcess(c) : inProcess(c);
