// The gate a test runs against (docs/rust-portierung.en.md, R5). Without PHI_SPACES_SERVER_CMD: startGate in this process, on a
// test host. With it: that server as a process, its clock, keys and events in files a test can change and read between two
// calls. Both ask the same management API, so what a test holds of the directory it holds of both.
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type net from "node:net";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SpaceLifecycle, SpaceLifecycleService } from "../../src/space-lifecycle.ts";
import { BootstrapClosed, CONTROL_SPACE, ControlAccess, EnrollmentService, GateIdentity, MemoryKeyDirectory, NetbirdDirectory, PhiSpaces, ProvingService, SpaceKeyDirectory, SpaceService, Supervisor, bootstrapEnroll, MemberLifecycle, DelegationVerifier, RunGateService, SqliteRecoveryRegister, installBootGuard, createSpace, spaceDoc, core, createEnroll, serveTlsRegister, GrantAuthority, GrantVerifier, RotationService, listSpaces, revokePeerKey, snapshotSpace, socketTransport, startGate, DEFAULT_GROUP_ROLES, rolesOf, type Call, type Connection, type Identity, type RunSpec, type KeyDirectory, type PeerKeyRec, type Policy } from "../../src/index.ts";
import { plainDoc } from "./host.ts";
import { digestJson } from "../../src/canonical.ts";
import { openSqliteHost } from "../../src/store/sqlite.ts";
import { openTestHost } from "./host.ts";
import { ctx } from "./persistent.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CMD = process.env.PHI_SPACES_SERVER_CMD?.trim() ? process.env.PHI_SPACES_SERVER_CMD.trim().split(/\s+/) : null;
export const OTHER_SERVER = CMD !== null;

const scratch = (tc: TestContext) => { const dir = mkdtempSync("/tmp/phi-gut-"); tc.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const put = (file: string, text: string) => { writeFileSync(`${file}.tmp`, text); renameSync(`${file}.tmp`, file); };

/**
 * Every Space of the host is replicated (primary/sync): its replica configuration version and primary epoch as the
 * journal says, and the promotion evidence for NotCommitted (`proof` 0: none; else the hash of its value).
 */
export type Replicated = { version: TestClock; epoch: TestClock; proof: TestClock };
const proofHash = (t: number) => digestJson(String(t));

/** The gate's clock. */
export class TestClock {
	private at: number;
	readonly file: string;
	constructor(tc: TestContext, at = 1_000_000) { this.at = at; this.file = join(scratch(tc), "clock"); put(this.file, String(this.at)); }
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

export type GateCase = {
	url: string; token?: string; cacheMs?: number; clock: TestClock; keys?: TestKeys; gateHostId?: string; policy?: Policy; host?: string; handshakeMs?: number; maxConnectionsPerPeer?: number; connectionsPerSecondPerPeer?: number;
	/** Keys from the control space, pairing, its wire rules, its supervisor; the service then runs on the case's clock if asked. */
	spaceKeys?: boolean; enrollment?: boolean; controlAccess?: boolean; supervisor?: boolean; serviceClock?: boolean;
	/** This host issues grants (authority "authority") and serves the rotation of own keys. */
	grants?: boolean;
	/** This host is a run Member under the controller `control` with this key; its run kind `jobs` writes two Jobs. */
	runGates?: { controllerKey: string };
	/** This host is Member `a` with a Space of its own, under the Control host `control` with this key. */
	/** The authority's public keys, and its installed policy version (a clock's value, so a test can move it). */
	delegation?: { supervisorKey: string; grantKey: string; controlSpaceId: string; policy: TestClock; replica?: Replicated };
	maxPendingPerPeer?: number;
	/** The boot guard over these register files; in this process it is armed by `armBoot`, once the host has its Spaces. */
	boot?: { external: string; installed: string };
	membership?: { controllerKey: string; seed?: (lifecycle: MemberLifecycle) => Promise<void> };
	/** This host takes Space lifecycle instructions of the Control host `control` with this key. */
	spaceLifecycle?: { controllerKey: string };
};
/** The grant signing key: PKCS#8 and SPKI of Ed25519 end in the seed and the public key. */
const grantKey = () => { const { publicKey, privateKey } = generateKeyPairSync("ed25519"); return { privateKey, publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"), seed: privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64") }; };
type Seen = { event: string; ip: string; peerId?: string; reason?: string };
type EnrollSeen = { peerId: string; outcome: string; keyId?: string };
type CommandSeen = { commandId: string; kind: string; state: string; requestedBy: string; error?: string };
type Enroll = { tokenHash: string; allowedPeerId: string; role?: string; scope?: string[]; ttlMs?: number };
/** What a test does on the host itself. */
export type HostSide = {
	bootstrap(o: Enroll): Promise<Record<string, any>>;
	create(o: Enroll): Promise<Record<string, any>>;
	revoke(peerId: string, keyId: string): Promise<boolean>;
	find(peerId: string, keyId: string): Promise<PeerKeyRec | null>;
	entries(template: { type: string; fields?: Record<string, unknown> }): Promise<Array<{ fields: Record<string, any> }>>;
	/** The control space's document, as text. */
	state(): Promise<string>;
	writeAs(owner: string, entry: { type: string; fields: Record<string, unknown> }, leaseMs: number): Promise<unknown>;
	/** A named Space with these completion profiles; its id. */
	jobsSpace(alias: string, profiles: core.CompletionProfile[]): Promise<string>;
	jobs(space: string): Promise<Array<{ fields: Record<string, any> }>>;
	spaceInfo(alias: string): Promise<{ spaceId: string; incarnation: string }>;
};
export type GateUnderTest = { armBoot(): void; memberKey: string; memberSpace: string; /** Ends the server under test; its store file stays. */ stop(): Promise<string | null>; port: number; readonly events: Seen[]; readonly enrollEvents: EnrollSeen[]; readonly commandEvents: CommandSeen[]; control: HostSide; peers(): Promise<Array<{ peerId: string; ip: string; roles: string[]; proven: boolean }>>; revalidate(): Promise<number> };

async function inProcess(tc: TestContext, c: GateCase): Promise<GateUnderTest> {
	const directory = new NetbirdDirectory({ url: c.url, token: c.token ?? "t", now: c.clock.now, ...(c.cacheMs === undefined ? {} : { cacheMs: c.cacheMs }) });
	const host = await openTestHost(ctx);
	tc.after(() => host.close(ctx));
	const identity = new GateIdentity();
	const keys: KeyDirectory | undefined = c.spaceKeys ? new SpaceKeyDirectory(host, ctx, c.clock.now) : c.keys;
	const verifier = c.delegation && new DelegationVerifier({ host, ctx, authorityId: "authority", controlSpaceId: c.delegation.controlSpaceId, supervisorPeerId: "supervisor", supervisorKey: { algorithm: "ed25519", publicKey: c.delegation.supervisorKey }, keys: keys!, grants: new GrantVerifier({ authorityId: "authority", issuerHostId: "control-host", publicKey: c.delegation.grantKey, algorithm: "ed25519", now: c.clock.now }), policy: async () => ({ authorityId: "authority", policyVersion: c.delegation!.policy.t }), now: c.clock.now,
		...(c.delegation.replica ? { replicaConfig: () => ({ replicaConfigVersion: c.delegation!.replica!.version.t, primaryEpoch: c.delegation!.replica!.epoch.t }) } : {}) });
	const replica = c.delegation?.replica;
	const service = new SpaceService({ host, ctx, identity, ...(c.policy ? { policy: c.policy } : {}), ...(c.serviceClock ? { now: c.clock.now } : {}), ...(c.maxPendingPerPeer ? { maxPendingPerPeer: c.maxPendingPerPeer } : {}),
		...(replica ? { epochForSpace: async () => replica.epoch.t, promotionProof: async () => (replica.proof.t ? { hash: proofHash(replica.proof.t) } : null) } : {}),
		...(verifier ? { authorize: async (call: Call, id: Identity, conn: Connection) => { const auth = call.frame?.delegation ? await verifier.check(call, id, conn) : new GrantVerifier({ authorityId: "authority", issuerHostId: "control-host", publicKey: c.delegation!.grantKey, algorithm: "ed25519", now: c.clock.now }).check(call.frame?.grant, id, call, conn); auth.check(); return auth; } } : {}) });
	const proving = c.gateHostId && keys ? new ProvingService(service, { gateHostId: c.gateHostId, keys, now: c.clock.now }) : service;
	const access = c.controlAccess ? new ControlAccess(proving as ProvingService, { identity, host, ctx }) : proving;
	const enrollEvents: EnrollSeen[] = [], commandEvents: CommandSeen[] = [];
	const front = c.enrollment ? new EnrollmentService(access as ProvingService, { host, ctx, now: c.clock.now, ...(c.spaceKeys ? { keys: keys! } : {}), onEvent: (e) => enrollEvents.push(e) }) : access;
	const events: Seen[] = [];
	let served = front as ProvingService;
	if (c.grants) {
		const key = grantKey(), signer = { keyId: "grants", algorithm: "ed25519" as const, sign: (d: Uint8Array) => sign(null, Buffer.from(d), key.privateKey) };
		const verifier = new GrantVerifier({ authorityId: "authority", issuerHostId: "host-1", publicKey: key.publicKey, algorithm: "ed25519", now: c.clock.now });
		const refreshIdentity = async (conn: Connection) => { await directory.refresh(); const p = await directory.lookup(conn.overlayIp!); return p && p.id === conn.peerId ? identity.authenticate({ ...conn, credentials: { roles: rolesOf(p.groups, DEFAULT_GROUP_ROLES) } }) : null; };
		const authority = new GrantAuthority({ authorityId: "authority", hostId: "host-1", signer, keys: keys!, identity, now: c.clock.now, refreshIdentity });
		const inner = new RotationService(front as ProvingService, { host, ctx, keys: keys!, identity, verifier, now: c.clock.now });
		served = { handle: (x: unknown, conn: Connection) => inner.handle(x, conn), async handleText(t: string, conn: Connection, max?: number) {
			const call = JSON.parse(t) as { method?: string; args?: { purpose?: "effect" | "resolution"; agentId?: string } };
			if (call?.method !== "grant") return inner.handleText(t, conn, max);
			try { return JSON.stringify({ ok: true, result: await authority.issue(conn, call.args?.purpose ?? "effect", call.args?.agentId) }); }
			catch (e) { return JSON.stringify({ ok: false, error: { code: !(conn.state as { proof?: unknown } | undefined)?.proof && (conn.credentials as { roles?: string[] } | undefined)?.roles?.some((r) => ["admin", "host"].includes(r)) ? "ProofRequired" : "PermissionDenied", message: (e as Error).message } }); }
		} } as unknown as ProvingService;
	}
	const member = grantKey();
	if (c.runGates) {
		const signer = { keyId: "member", algorithm: "ed25519" as const, sign: (d: Uint8Array) => sign(null, Buffer.from(d), member.privateKey) };
		const preparers = { jobs: async (run: RunSpec, space: string) => { await host.commit(async (tx) => { const s = await spaceDoc(tx, space, Date.now()); for (const n of [1, 2]) if (!core.count(s, Date.now(), { type: "Job", fields: { runId: run.runId, n } })) core.write(s, Date.now(), { type: "Job", fields: { runId: run.runId, n } }, null, core.FOREVER); }, ctx); } };
		const runs = new RunGateService({ host, ctx, authorityId: "authority", peerId: "host-1", signer, controllerPin: { issuer: "control", algorithm: "ed25519", publicKey: c.runGates.controllerKey }, preparers, assertAuthority: async () => {} });
		const inner = served;
		served = { handle: (x: unknown, conn: Connection) => inner.handle(x, conn), async handleText(t: string, conn: Connection, max?: number) {
			const call = JSON.parse(t) as { method?: string; args?: { instruction?: never } };
			if (call?.method !== "runGateInstruction") return inner.handleText(t, conn, max);
			try {
				const id = await identity.authenticate(conn);
				if (!(conn.state as { proof?: unknown } | undefined)?.proof || !id?.roles.some((r) => ["router", "host", "admin"].includes(r))) throw new Error("epoch notice requires proven service peer");
				return JSON.stringify({ ok: true, result: await runs.apply(call.args?.instruction as never) });
			} catch (e) { return JSON.stringify({ ok: false, error: { code: "PermissionDenied", message: (e as Error).message } }); }
		} } as unknown as ProvingService;
	}
	if (verifier) {
		const inner = served;
		served = { handle: (x: unknown, conn: Connection) => inner.handle(x, conn), async handleText(t: string, conn: Connection, max?: number) {
			const call = JSON.parse(t) as { method?: string; space?: string; args?: { signedNotice?: never } };
			if (call?.method !== "epochNotice") return inner.handleText(t, conn, max);
			try {
				const id = await identity.authenticate(conn);
				if (!(conn.state as { proof?: unknown } | undefined)?.proof || !id?.roles.some((r) => ["router", "host", "admin"].includes(r))) throw new Error("epoch notice requires proven service peer");
				await verifier.epochNotice(call.args?.signedNotice as never, call.space as never);
				return JSON.stringify({ ok: true, result: { installed: true } });
			} catch (e) { return JSON.stringify({ ok: false, error: { code: "PermissionDenied", message: (e as Error).message } }); }
		} } as unknown as ProvingService;
	}
	let memberSpace = "";
	if (c.membership) {
		memberSpace = (await host.commit((tx) => createSpace(tx, "member", Date.now()), ctx)).spaceId;
		const signer = { keyId: "member", algorithm: "ed25519" as const, sign: (d: Uint8Array) => sign(null, Buffer.from(d), member.privateKey) };
		const lifecycle = new MemberLifecycle({ host, ctx, memberId: "a", spaceId: memberSpace, authorityId: "authority", peerId: "host-1", signer, controlPin: { issuer: "control", algorithm: "ed25519", publicKey: c.membership.controllerKey }, assertAuthority: async () => {} });
		const inner = served;
		served = { handle: (x: unknown, conn: Connection) => inner.handle(x, conn), async handleText(t: string, conn: Connection, max?: number) {
			const call = JSON.parse(t) as { method?: string; args?: { instruction?: never } };
			if (call?.method !== "membershipInstruction") return inner.handleText(t, conn, max);
			try {
				const id = await identity.authenticate(conn);
				if (!(conn.state as { proof?: unknown } | undefined)?.proof || !id?.roles.some((r) => ["router", "host", "admin"].includes(r))) throw new Error("epoch notice requires proven service peer");
				return JSON.stringify({ ok: true, result: await lifecycle.apply(call.args?.instruction as never) });
			} catch (e) { return JSON.stringify({ ok: false, error: { code: "PermissionDenied", message: (e as Error).message } }); }
		} } as unknown as ProvingService;
	}
	if (c.spaceLifecycle) {
		const signer = { keyId: "member", algorithm: "ed25519" as const, sign: (d: Uint8Array) => sign(null, Buffer.from(d), member.privateKey) };
		const lifecycle = new SpaceLifecycleService({ lifecycle: new SpaceLifecycle({ host, ctx, now: () => Date.now() }), hostId: "host-1", authorityId: "authority", peerId: "host-1", signer, controlPin: { issuer: "control", algorithm: "ed25519", publicKey: c.spaceLifecycle.controllerKey }, assertAuthority: async () => {} });
		const inner = served;
		served = { handle: (x: unknown, conn: Connection) => inner.handle(x, conn), async handleText(t: string, conn: Connection, max?: number) {
			const call = JSON.parse(t) as { method?: string; args?: { instruction?: never } };
			if (call?.method !== "spaceLifecycleInstruction") return inner.handleText(t, conn, max);
			try {
				const id = await identity.authenticate(conn);
				if (!(conn.state as { proof?: unknown } | undefined)?.proof || !id?.roles.some((r) => ["router", "host", "admin"].includes(r))) throw new Error("epoch notice requires proven service peer");
				return JSON.stringify({ ok: true, result: await lifecycle.apply(call.args?.instruction as never) });
			} catch (e) { return JSON.stringify({ ok: false, error: { code: "PermissionDenied", message: (e as Error).message } }); }
		} } as unknown as ProvingService;
	}
	const gate = await startGate(served, {
		listen: { host: c.host ?? "127.0.0.1", port: 0 }, directory, revalidateMs: 0, now: c.clock.now, onEvent: (e) => events.push(e),
		...(keys ? { keys } : {}), ...(c.handshakeMs === undefined ? {} : { handshakeMs: c.handshakeMs }),
		...(c.maxConnectionsPerPeer === undefined ? {} : { maxConnectionsPerPeer: c.maxConnectionsPerPeer }), ...(c.connectionsPerSecondPerPeer === undefined ? {} : { connectionsPerSecondPerPeer: c.connectionsPerSecondPerPeer }),
	});
	tc.after(() => gate.close());
	if (c.supervisor) { const stop = await new Supervisor(host, ctx, { now: c.clock.now, onEvent: (e) => commandEvents.push(e) }).start(); tc.after(() => stop()); }
	const controlState = async () => { const info = (await listSpaces(host, ctx)).find((i) => i.alias === CONTROL_SPACE)!; return (await snapshotSpace(host, info.spaceId, ctx))!; };
	const control: HostSide = {
		bootstrap: (o) => bootstrapEnroll(host, ctx, { ...o, now: c.clock.now }),
		create: (o) => createEnroll(host, ctx, { ...o, role: o.role ?? "", now: c.clock.now }),
		revoke: (peerId, keyId) => revokePeerKey(host, ctx, peerId, keyId, c.clock.now),
		find: (peerId, keyId) => new SpaceKeyDirectory(host, ctx, c.clock.now).find(peerId, keyId),
		entries: async (t) => core.list(await controlState(), c.clock.now(), t as never) as never,
		state: async () => JSON.stringify(plainDoc(await controlState())),
		writeAs: (owner, entry, leaseMs) => new PhiSpaces(host, ctx, c.clock.now, undefined, owner, { space: CONTROL_SPACE }).write(entry as never, null, leaseMs),
		jobsSpace: async (alias, profiles) => { const id = (await host.commit((tx) => createSpace(tx, alias, Date.now()), ctx)).spaceId; await host.commit(async (tx) => core.setCompletionProfiles(await spaceDoc(tx, id, Date.now()), profiles), ctx); return id; },
		jobs: async (space) => core.list((await snapshotSpace(host, space, ctx))!, Date.now(), { type: "Job" }) as never,
		spaceInfo: async (alias) => (await listSpaces(host, ctx)).find((i) => i.alias === alias)!,
	};
	const armBoot = () => { if (c.boot) { const stop = installBootGuard(host, ctx, { hostId: "host-1", authorityId: "authority", external: new SqliteRecoveryRegister(c.boot.external), installed: new SqliteRecoveryRegister(c.boot.installed) }); tc.after(stop); } };
	return { armBoot, memberKey: member.publicKey, memberSpace, stop: async () => null, port: (gate.address() as net.AddressInfo).port, events, enrollEvents, commandEvents, control, peers: async () => gate.peers(), revalidate: () => gate.revalidate() };
}

async function asProcess(tc: TestContext, c: GateCase): Promise<GateUnderTest> {
	const member = grantKey();
	const dir = scratch(tc), eventsFile = join(dir, "events"), config = join(dir, "case.json"), hooksPath = join(dir, "hooks.sock");
	put(eventsFile, "");
	const storeFile = join(dir, "s.sqlite");
	let memberSpace = "";
	if (c.membership) {
		const seed = await openSqliteHost(storeFile);
		memberSpace = (await seed.commit((tx) => createSpace(tx, "member", Date.now()), ctx)).spaceId;
		await c.membership.seed?.(new MemberLifecycle({ host: seed, ctx, memberId: "a", spaceId: memberSpace, authorityId: "authority", peerId: "host-1", signer: { keyId: "member", algorithm: "ed25519", sign: (d) => sign(null, Buffer.from(d), member.privateKey) }, controlPin: { issuer: "control", algorithm: "ed25519", publicKey: c.membership.controllerKey }, assertAuthority: async () => {} }));
		await seed.close(ctx);
	}
	writeFileSync(config, JSON.stringify({
		hooks: hooksPath, endpoints: [], identities: {}, policy: c.policy?.roles, maxPendingPerPeer: c.maxPendingPerPeer,
		gate: { host: c.host ?? "127.0.0.1", port: 0, url: c.url, token: c.token ?? "t", cacheMs: c.cacheMs, handshakeMs: c.handshakeMs, maxConnectionsPerPeer: c.maxConnectionsPerPeer, connectionsPerSecondPerPeer: c.connectionsPerSecondPerPeer, clockFile: c.clock.file, eventsFile, keysFile: c.keys?.file, gateHostId: c.gateHostId, spaceKeys: c.spaceKeys, enrollment: c.enrollment, controlAccess: c.controlAccess, supervisor: c.supervisor, serviceClock: c.serviceClock, boot: c.boot ? { hostId: "host-1", authorityId: "authority", ...c.boot } : undefined, delegation: c.delegation ? { authorityId: "authority", controlSpaceId: c.delegation.controlSpaceId, supervisor: "supervisor", supervisorKey: c.delegation.supervisorKey, issuer: "control-host", grantKey: c.delegation.grantKey, policyFile: c.delegation.policy.file, ...(c.delegation.replica ? { replica: { versionFile: c.delegation.replica.version.file, epochFile: c.delegation.replica.epoch.file, proofFile: c.delegation.replica.proof.file } } : {}) } : undefined, membership: c.membership ? { memberId: "a", spaceId: memberSpace, authorityId: "authority", peerId: "host-1", seed: member.seed, controller: "control", controllerKey: c.membership.controllerKey } : undefined, runGates: c.runGates ? { authorityId: "authority", peerId: "host-1", seed: member.seed, controller: "control", controllerKey: c.runGates.controllerKey } : undefined, spaceLifecycle: c.spaceLifecycle ? { hostId: "host-1", authorityId: "authority", peerId: "host-1", seed: member.seed, controller: "control", controllerKey: c.spaceLifecycle.controllerKey } : undefined, grants: c.grants ? (() => { const k = grantKey(); return { authorityId: "authority", hostId: "host-1", seed: k.seed, publicKey: k.publicKey }; })() : undefined },
	}));
	const proc = spawn(CMD![0]!, [...CMD!.slice(1), "--store", c.membership || c.spaceLifecycle ? storeFile : "memory", "--listen", `unix:${join(dir, "unused.sock")}`, "--test-hooks", config], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
	const port = await new Promise<number>((resolve, reject) => {
		let out = "";
		const seen = (d: Buffer) => { out += d; const m = /ready on tcp:[^:]+:(\d+)/.exec(out); if (m) resolve(Number(m[1])); };
		proc.stdout.on("data", seen);
		proc.stderr.on("data", seen);
		proc.on("error", reject);
		proc.on("exit", (code) => reject(new Error(`the server under test exited (${code}):\n${out}`)));
	});
	const hooks = socketTransport({ path: hooksPath });
	let stopped = false;
	const stop = async () => { if (stopped) return storeFile; stopped = true; hooks.close(); await new Promise<void>((r) => { proc.removeAllListeners("exit"); proc.once("exit", () => r()); proc.kill("SIGTERM"); }); return storeFile; };
	tc.after(stop);
	const hook = async <T,>(name: string, line: Record<string, unknown> = {}) => {
		const r = JSON.parse(await hooks.request(JSON.stringify({ hook: name, now: c.clock.now(), ...line }))) as { ok: boolean; result: T; class?: string; message?: string };
		if (r.ok) return r.result;
		throw r.class === "BootstrapClosed" ? new BootstrapClosed(r.message) : r.class === "IllegalArgumentError" ? new core.IllegalArgumentError(r.message!) : new Error(r.message);
	};
	const seen = <T,>(key: string): T[] => readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T).filter((e) => key in (e as object));
	return {
		armBoot: () => {},
		memberKey: member.publicKey,
		memberSpace,
		stop,
		port,
		get events() { return seen<Seen>("event"); },
		get enrollEvents() { return seen<EnrollSeen>("outcome"); },
		get commandEvents() { return seen<CommandSeen>("commandId"); },
		control: {
			bootstrap: (o) => hook("bootstrapEnroll", o),
			create: (o) => hook("createEnroll", o),
			revoke: (peerId, keyId) => hook("revokePeerKey", { peerId, keyId }),
			find: (peerId, keyId) => hook("findKey", { peerId, keyId }),
			entries: (template) => hook("entries", { template }),
			state: async () => JSON.stringify(await hook("controlState")),
			writeAs: (owner, entry, leaseMs) => hook("writeAs", { owner, entry, leaseMs }),
			jobsSpace: (alias, profiles) => hook("jobsSpace", { alias, profiles }),
			jobs: (space) => hook("jobs", { space }),
			spaceInfo: (alias) => hook("spaceInfo", { alias }),
		},
		peers: () => hook("peers"),
		revalidate: () => hook("revalidate"),
	};
}

type RegisterConfig = { host: string; port: number; caFile: string; certFile: string; keyFile: string; peers: Record<string, { operator?: boolean; writeKeys?: string[] }> };
/** The register server: `peersChanged` after a test changed `peers`, which the process reads from a file. */
export async function registerUnderTest(db: Parameters<typeof serveTlsRegister>[0], file: string, config: RegisterConfig) {
	if (!OTHER_SERVER) return { ...(await serveTlsRegister(db, config)), peersChanged: () => {} };
	const peersFile = `${file}.peers.json`, configFile = `${file}.config.json`, save = () => put(peersFile, JSON.stringify(config.peers));
	save();
	writeFileSync(configFile, JSON.stringify({ ...config, peers: undefined, peersFile, file }));
	const proc = spawn(CMD![0]!, [...CMD!.slice(1), "--tls-register", configFile], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
	const port = await new Promise<number>((resolve, reject) => {
		let out = "";
		const seen = (d: Buffer) => { out += d; const m = /ready on tcp:[^:]+:(\d+)/.exec(out); if (m) resolve(Number(m[1])); };
		proc.stdout.on("data", seen);
		proc.stderr.on("data", seen);
		proc.on("exit", (code) => reject(new Error(`the register exited (${code}):\n${out}`)));
	});
	return { address: () => ({ port }), peersChanged: save, close: () => new Promise<void>((r) => { proc.removeAllListeners("exit"); proc.once("exit", () => r()); proc.kill("SIGTERM"); }) };
}

export const gateUnderTest = (tc: TestContext, c: GateCase): Promise<GateUnderTest> => OTHER_SERVER ? asProcess(tc, c) : inProcess(tc, c);
