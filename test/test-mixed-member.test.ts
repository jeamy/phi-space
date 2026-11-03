// A Member behind a TypeScript control host, as a deployment runs it: its config file, its keys, the TLS register, the
// management API, the wire. Without PHI_SPACES_SERVER_CMD the Member is TypeScript too, with it that server (`--member`).
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROL_SPACE, FOREVER, GrantAuthority, createEnroll, hashToken, newEnrollToken, RemoteSpace, SqliteRecoveryRegister, SpaceKeyDirectory, core, createSpace, generateKey, listSpaces, snapshotSpace, provisionFileSigner, loadFileSigner, serveTlsRegister, socketTransport, spaceDoc, startConfiguredFederation, type Signer } from "../src/index.ts";
import { DelegationEpochs, delegationForCall, signDelegation } from "../src/delegation.ts";
import { verifyDetached } from "../src/grants.ts";
import { canonicalJson } from "../src/canonical.ts";
import { FederationRouting, applyFederationPolicyIn, verifyFederationPolicy } from "../src/federation-policy.ts";
import { signMembership } from "../src/membership.ts";
import { signRun } from "../src/run-member.ts";
import { signLifecycle } from "../src/space-lifecycle.ts";
import { openSqliteHost } from "../src/store/sqlite.ts";
import { ctx } from "./support/persistent.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CMD = process.env.PHI_SPACES_SERVER_CMD?.trim() ? process.env.PHI_SPACES_SERVER_CMD.trim().split(/\s+/) : null;
const CONTROL = process.env.PHI_SPACES_CONTROL_CMD?.trim() ? process.env.PHI_SPACES_CONTROL_CMD.trim().split(/\s+/) : null; // the control host's server; the Member's is the other
const peer = (id: string, ip: string, groups: string[]) => ({ id, name: id, ip, connected: true, groups: groups.map((g) => ({ id: `g-${g}`, name: g })) });
const CONTROL_IP = "127.0.0.5", MEMBER_IP = "127.0.0.1", USER_IP = "127.0.0.3", ROUTER_IP = "127.0.0.4", PHONE_IP = "127.0.0.6", PAIRED_IP = "127.0.0.7", SECOND_ROUTER_IP = "127.0.0.8", ADMIN_IP = "127.0.0.9"; // a host reaches its control host from the Member address: on loopback that is 127.0.0.1
const GATED = { taskType: "Gated", resultTypes: ["GatedDone"], equalFields: ["runId", "n"], maxResultCount: 1, maxResultBytes: 1024, maxLeaseMs: 60_000, gateField: "runId" };
const freePort = () => new Promise<number>((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as net.AddressInfo; s.close(() => r(port)); }); });

function pki(dir: string) {
	const openssl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
	openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=ca", "-days", "2"]);
	for (const name of ["server", "control", "member"]) {
		openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`]);
		writeFileSync(join(dir, `${name}.ext`), name === "server" ? "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n" : "extendedKeyUsage=clientAuth\n");
		openssl(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "2", "-extfile", `${name}.ext`]);
		chmodSync(join(dir, `${name}.key`), 0o600); chmodSync(join(dir, `${name}.crt`), 0o600);
	}
	chmodSync(join(dir, "ca.crt"), 0o600);
	return { identity: (name: string) => ({ caFile: join(dir, "ca.crt"), certFile: join(dir, `${name}.crt`), keyFile: join(dir, `${name}.key`) }), print: (name: string) => createHash("sha256").update(new X509Certificate(readFileSync(join(dir, `${name}.crt`))).raw).digest("hex") };
}

async function spawned(cmd: string[], args: string[]) {
	const proc = spawn(cmd[0]!, [...cmd.slice(1), ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
	await new Promise<void>((resolve, reject) => {
		let out = "";
		const seen = (d: Buffer) => { out += d; if (out.includes("ready on")) resolve(); };
		proc.stdout.on("data", seen); proc.stderr.on("data", seen);
		proc.on("exit", (code) => reject(new Error(`the server exited (${code}):\n${out}`)));
	});
	return () => new Promise<void>((r) => { proc.removeAllListeners("exit"); proc.once("exit", () => r()); proc.kill("SIGTERM"); });
}

async function setup(tc: TestContext, more: Record<string, unknown> = {}) {
	const dir = mkdtempSync("/tmp/phi-mixed-");
	tc.after(() => rmSync(dir, { recursive: true, force: true }));
	const certs = pki(dir);
	const external = new SqliteRecoveryRegister(join(dir, "external.sqlite"));
	tc.after(() => external.close());
	const register = await serveTlsRegister(external, { ...certs.identity("server"), host: "127.0.0.1", port: 0, peers: { [certs.print("control")]: {}, [certs.print("member")]: {} } });
	tc.after(() => register.close());
	const peers = [peer("control-peer", CONTROL_IP, ["space-hosts"]), peer("member-peer", MEMBER_IP, ["space-hosts"]), peer("user", USER_IP, ["space-hosts"]), peer("router-peer", ROUTER_IP, ["space-hosts"]), peer("phone", PHONE_IP, ["space-enroll"]), peer("phone", PAIRED_IP, ["space-hosts"]), peer("router-two", SECOND_ROUTER_IP, ["space-hosts"]), peer("boss", ADMIN_IP, ["space-admin"])]; // before and after pairing: the directory is cached for a minute
	const management = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(peers)); });
	await new Promise<void>((r) => management.listen(0, "127.0.0.1", r));
	tc.after(() => { management.closeAllConnections(); management.close(); });
	writeFileSync(join(dir, "token"), "t", { mode: 0o600 });
	const controlKey = provisionFileSigner(join(dir, "control.json")), memberKey = provisionFileSigner(join(dir, "member.json"));
	const userKey = generateKey("ed25519", "user-key"), routerKey = generateKey("ed25519", "router-key"), pairKey = generateKey("ed25519", "router-two-key"), adminKey = generateKey("ed25519", "admin-key");
	const now = Date.now();
	// the control host's store: its Space, its keys, its permit
	let control = await openSqliteHost(join(dir, "control.sqlite"));
	const space = await control.commit((tx) => createSpace(tx, CONTROL_SPACE, now), ctx);
	await control.commit(async (tx) => {
		const s = await spaceDoc(tx, space.spaceId, now);
		const put = (peerId: string, k: Signer & { publicKey?: string }, publicKey: string, roles: string[]) => core.write(s, now, { type: "PeerKey", fields: { peerId, keyId: k.keyId, principal: peerId, algorithm: k.algorithm, publicKey, roles, scope: ["*"], state: "active" } }, null, FOREVER);
		put("member-peer", memberKey, memberKey.publicKey, ["host"]);
		put("user", userKey.signer, userKey.publicKey, ["member"]);
		put("router-peer", routerKey.signer, routerKey.publicKey, ["host", "router", "member"]);
		put("boss", adminKey.signer, adminKey.publicKey, ["admin"]);
		put("router-two", pairKey.signer, pairKey.publicKey, ["host", "router", "member"]);
	}, ctx);
	await control.commit((tx) => spaceDoc(tx, undefined, now).then(() => {}), ctx);
	const routing = (version: number, rules: unknown[] = []) => ({ authorityId: "authority", policyVersion: version, rules, completionProfiles: [GATED], default: { mode: "local", member: "a" } }) as never;
	await control.commit(async (tx) => { (await tx.doc(FederationRouting, space.spaceId, null)).members.a = { id: "a", state: "active", target: { authorityId: "authority", hostId: "data-host", spaceId: "sp-a", dataIncarnation: "00000000", primaryEpoch: 1 } } as never; (await tx.doc(FederationRouting, space.spaceId, null)).members.b = { id: "b", state: "active", target: { authorityId: "authority", hostId: "other-host", spaceId: "sp-b", dataIncarnation: "00000000", primaryEpoch: 1 } } as never; await applyFederationPolicyIn(tx, space.spaceId, "authority", routing(1), 0); }, ctx);
	const permit = (incarnation: string) => ({ state: "active", authorityId: "authority", dataIncarnation: incarnation, role: "local", transitionId: "t1" });
	const installedControl = new SqliteRecoveryRegister(join(dir, "installed-control.sqlite"));
	tc.after(() => installedControl.close());
	const spaces: Record<string, unknown> = {};
	for (const i of await listSpaces(control, ctx)) { spaces[i.spaceId] = permit(i.incarnation); await installedControl.compareAndSet(`installed:control-host:${i.spaceId}`, null, permit(i.incarnation)); }
	await external.compareAndSet("boot:control-host", null, { hostId: "control-host", state: "active", spaces } as never);
	await external.compareAndSet(`authority:${space.spaceId}`, null, { state: "active", authorityId: "authority", hostId: "control-host", supervisorKey: controlKey.publicKey });
	const [controlPort, memberPort] = [await freePort(), await freePort()];
	const base = (name: string, host: string, port: number) => ({ authorityId: "authority", controlHostId: "control-host", controlSpaceId: space.spaceId, listen: { host, port }, keyFile: join(dir, `${name}.json`), installedRegisterFile: join(dir, `installed-${name}.sqlite`), registerTls: { ...certs.identity(name), host: "127.0.0.1", port: (register.address() as net.AddressInfo).port, batchReads: true }, management: { url: `http://127.0.0.1:${(management.address() as net.AddressInfo).port}`, tokenFile: join(dir, "token") }, control: { address: { host: CONTROL_IP, port: controlPort }, algorithm: controlKey.algorithm, publicKey: controlKey.publicKey } });
	const write = (name: string, config: unknown) => { const file = join(dir, `${name}.config.json`); writeFileSync(file, JSON.stringify(config), { mode: 0o600 }); return file; };
	const controlConfig = write("control", { ...base("control", CONTROL_IP, controlPort), hostId: "control-host", peerId: "control-peer", mode: "control", capabilities: { hostBindings: { "control-peer": "control-host", "member-peer": "data-host" } } });
	const startControl = async () => {
		if (!CONTROL) { control = await openSqliteHost(join(dir, "control.sqlite")); const root = await startConfiguredFederation(control, ctx, controlConfig); return async () => { await root.close(); await control.close(ctx); }; }
		return spawned(CONTROL, ["--store", join(dir, "control.sqlite"), "--control", controlConfig]);
	};
	await control.close(ctx);
	let stopControl = await startControl();
	tc.after(() => stopControl());
	/** The control host's store in a test's hands: on another server only while that is down, as its process holds the file. */
	const withControl = async <T>(f: (host: Awaited<ReturnType<typeof openSqliteHost>>) => Promise<T>): Promise<T> => {
		if (!CONTROL) return f(control);
		await stopControl();
		const host = await openSqliteHost(join(dir, "control.sqlite"));
		try { return await f(host); } finally { await host.close(ctx); stopControl = await startControl(); toControl = homeLine(); await toControl.authenticate().catch(() => {}); } // its connection went with the process
	};
	// the Member's store, seeded as a provisioning does; its permits
	const storeFile = join(dir, "member.sqlite"), seed = await openSqliteHost(storeFile);
	const jobs = await seed.commit((tx) => createSpace(tx, "jobs", now), ctx), notes = await seed.commit((tx) => createSpace(tx, "notes", now), ctx);
	await seed.commit((tx) => spaceDoc(tx, undefined, now).then(() => {}), ctx);
	// the permits are only external: the start installs them where the data is the one they name
	const memberSpaces: Record<string, unknown> = {};
	for (const i of await listSpaces(seed, ctx)) memberSpaces[i.spaceId] = permit(i.incarnation);
	await external.compareAndSet("boot:data-host", null, { hostId: "data-host", state: "active", spaces: memberSpaces } as never);
	const config = write("member", { ...base("member", MEMBER_IP, memberPort), hostId: "data-host", peerId: "member-peer", mode: "member", membership: { memberId: "a", spaceId: jobs.spaceId }, capabilities: { tools: ["sieve"], models: [], dataSpaces: [jobs.spaceId] }, ...more });
	await seed.close(ctx);
	const start = async () => {
		if (!CMD) {
			const host = await openSqliteHost(storeFile), member = await startConfiguredFederation(host, ctx, config);
			return async () => { await member.close(); await host.close(ctx); };
		}
		return spawned(CMD, ["--store", storeFile, "--member", config]);
	};
	let stop = await start();
	tc.after(() => stop());
	const restart = async () => { await stop(); stop = await start(); };
	const transports: Array<{ close(): void }> = [];
	tc.after(() => transports.forEach((t) => t.close()));
	const homeLine = () => { const t = socketTransport({ host: CONTROL_IP, port: controlPort }, { localAddress: USER_IP }); transports.push(t); return new RemoteSpace(t, { space: "control", attempts: 2, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 5_000, signer: userKey.signer, expectedGateHostId: "control-host", ownPeerId: "user" }); };
	let toControl = homeLine();
	const toMember = (grants = true) => { const t = socketTransport({ host: MEMBER_IP, port: memberPort }, { localAddress: USER_IP }); transports.push(t); return new RemoteSpace(t, { space: jobs.spaceId, attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 8_000, signer: userKey.signer, expectedGateHostId: "data-host", ownPeerId: "user", ...(grants ? { grantProvider: () => toControl.requestGrant() } : {}) }); };
	const authority = () => new GrantAuthority({ authorityId: "authority", hostId: "control-host", signer: controlKey, keys: { find: async (peerId: string, keyId: string) => ({ peerId, keyId, principal: peerId, algorithm: "ed25519" as const, publicKey: userKey.publicKey, roles: ["member"], scope: ["*"], state: "active" as const }) }, identity: { authenticate: () => ({ principal: { peerId: "user" }, roles: ["member"] }) }, refreshIdentity: async () => ({ principal: { peerId: "user" }, roles: ["member"] }) });
	/** A router's line to the Member: proven, its role from the directory. */
	const router = async () => {
		const t = socketTransport({ host: MEMBER_IP, port: memberPort }, { localAddress: ROUTER_IP });
		transports.push(t);
		const remote = new RemoteSpace(t, { attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 8_000, signer: routerKey.signer, expectedGateHostId: "data-host", ownPeerId: "router-peer" });
		await remote.authenticate();
		return { t, remote };
	};
	/** A user's line to the Member, proven, without a client's retries. */
	const user = async () => {
		const t = socketTransport({ host: MEMBER_IP, port: memberPort }, { localAddress: USER_IP });
		transports.push(t);
		await new RemoteSpace(t, { attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 8_000, signer: userKey.signer, expectedGateHostId: "data-host", ownPeerId: "user" }).authenticate();
		return { t: () => t };
	};
	/** A device paired at the control host: its token, its own key, a client of each host. */
	const phone = async () => {
		const token = newEnrollToken();
		await withControl((host) => createEnroll(host, ctx, { tokenHash: hashToken(token), role: "member", allowedPeerId: "phone", scope: ["*"] }));
		const line = (address: { host: string; port: number }, localAddress: string) => { const t = socketTransport(address, { localAddress }); transports.push(t); return t; };
		const key = generateKey("ed25519", "phone-key");
		const options = { attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 8_000, ownPeerId: "phone" };
		const pairing: RemoteSpace = new RemoteSpace(line({ host: CONTROL_IP, port: controlPort }, PHONE_IP), { ...options, space: "control", signer: key.signer, expectedGateHostId: "control-host", grantProvider: () => pairing.requestGrant() });
		const paired = await pairing.enroll(token);
		const signer: Signer = { ...key.signer, keyId: paired.keyId };
		const home = new RemoteSpace(line({ host: CONTROL_IP, port: controlPort }, PAIRED_IP), { ...options, space: "control", signer, expectedGateHostId: "control-host" });
		await home.authenticate();
		return new RemoteSpace(line({ host: MEMBER_IP, port: memberPort }, PAIRED_IP), { ...options, space: jobs.spaceId, signer, expectedGateHostId: "data-host", grantProvider: () => home.requestGrant() });
	};
	/** A line to the control host from an address, not yet proven. */
	const atControl = (ip: string, signer: Signer, ownPeerId: string) => { const t = socketTransport({ host: CONTROL_IP, port: controlPort }, { localAddress: ip }); transports.push(t); const remote: RemoteSpace = new RemoteSpace(t, { space: "control", attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 8_000, signer, expectedGateHostId: "control-host", ownPeerId, grantProvider: (call) => (call.method as string) === "routerLease" ? remote.requestGrant() : Promise.resolve(undefined as never) }); return { t, remote }; };
	/** One start of the control host that must fail: what it said, or null when it stood. */
	const tryControl = async () => { try { await (await startControl())(); return null; } catch (e) { if (!CONTROL) await control.close(ctx); return (e as Error).message; } };
	/** The Member's store in a test's hands, its process down. */
	const withMember = async <T>(f: (host: Awaited<ReturnType<typeof openSqliteHost>>) => Promise<T>): Promise<T> => {
		await stop();
		const host = await openSqliteHost(storeFile);
		try { return await f(host); } finally { await host.close(ctx); stop = await start(); }
	};
	return { tryControl, withMember, controlPort, adminKey, ADMIN_IP, PAIR_IP: SECOND_ROUTER_IP, pairKey, controlDown: async (f: () => Promise<void>) => { await stopControl(); try { await f(); } finally { stopControl = await startControl(); } }, controlStore: join(dir, "control.sqlite"), atControl, controlConfig, ROUTER_IP, USER_IP, withControl, notes, user, phone, toMember, get toControl() { return toControl; }, external, jobs, space, userKey, routerKey, controlKey, authority, config, storeFile, router, routing, restart };
}

test("a control host with a Root serves federated work to its own agents, also after a restart", async (tc) => {
	const g = await setup(tc);
	const dir = dirname(g.controlStore), sid = g.jobs.spaceId;
	const { remote } = await g.router();
	const member = (id: string, action: string, more = {}) => signMembership("instruction", { authorityId: "authority", memberId: "a", spaceId: sid, id, action, ...more } as never, "control-peer", g.controlKey).then((t) => remote.requestMembership(t as never));
	await member("t1", "prepareAdd");
	await member("t1", "activate", { policy: g.routing(1) });
	const routerKey = provisionFileSigner(join(dir, "root-router.json")), hostKey = provisionFileSigner(join(dir, "root-host.json"));
	const config = JSON.parse(readFileSync(g.config, "utf8")), memberKey = loadFileSigner(join(dir, "member.json"));
	const target = { authorityId: "authority", hostId: "data-host", spaceId: sid, dataIncarnation: g.jobs.incarnation, primaryEpoch: 1 };
	await g.controlDown(async () => {
		const host = await openSqliteHost(g.controlStore), now = Date.now();
		await host.commit(async (tx) => {
			const s = await spaceDoc(tx, g.space.spaceId, now);
			for (const [k, roles] of [[routerKey, ["host", "router", "member"]], [hostKey, ["host", "member"]]] as const) core.write(s, now, { type: "PeerKey", fields: { peerId: "control-peer", keyId: k.keyId, principal: "control-peer", algorithm: k.algorithm, publicKey: k.publicKey!, roles: [...roles], scope: ["*"], state: "active" } }, null, FOREVER);
			const d = await tx.doc(FederationRouting, g.space.spaceId, null);
			d.policy = g.routing(1); d.members = { a: { id: "a", state: "active", target } } as never;
		}, ctx);
		await host.close(ctx);
		const file = JSON.parse(readFileSync(g.controlConfig, "utf8"));
		file.root = { id: "root", keyFile: join(dir, "root-router.json"), hostKeyFile: join(dir, "root-host.json"), leaseFile: join(dir, "root-lease"), journalPartitions: 1, members: { a: { target, peerId: "member-peer", keyId: memberKey.keyId, algorithm: memberKey.algorithm, publicKey: memberKey.publicKey, address: { host: config.listen.host, port: config.listen.port } } } };
		writeFileSync(g.controlConfig, JSON.stringify(file), { mode: 0o600 });
	});
	const line = async () => {
		const t = socketTransport({ host: CONTROL_IP, port: g.controlPort }, { localAddress: CONTROL_IP });
		tc.after(() => t.close());
		await new RemoteSpace(t, { attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 8_000, signer: hostKey, expectedGateHostId: "control-host", ownPeerId: "control-peer" }).authenticate();
		return (method: string, args: Record<string, unknown>) => t.request(JSON.stringify({ method, args })).then((r) => JSON.parse(r) as { ok: boolean; result?: any; error?: { code: string; message: string } });
	};
	let root = await line();
	const principal = { agentId: "worker" };
	const wrote = await root("rootWrite", { ...principal, id: "w1", entry: { type: "Job", fields: { n: 1 } }, leaseMs: 60_000 });
	assert.equal(wrote.ok, true, JSON.stringify(wrote));
	assert.deepEqual((await root("rootWrite", { ...principal, id: "w1", entry: { type: "Job", fields: { n: 1 } }, leaseMs: 60_000 })).result, wrote.result, "a retry finds the journalled answer");
	assert.equal((await root("rootWrite", { ...principal, id: "w1", entry: { type: "Job", fields: { n: 2 } }, leaseMs: 60_000 })).error?.code, "RoutingConflict");
	assert.equal((await root("rootCount", { ...principal, template: { type: "Job" } })).result.count, 1);
	const read = await root("rootRead", { ...principal, id: "r1", template: { type: "Job" } });
	assert.equal(read.result?.fields?.n ?? read.result?.entry?.fields?.n, 1, JSON.stringify(read));
	await g.controlDown(async () => {});
	root = await line();
	const taken = await root("rootTake", { ...principal, id: "t1", template: { type: "Job" } });
	assert.equal(taken.ok, true, JSON.stringify(taken));
	assert.equal((await root("rootCount", { ...principal, template: { type: "Job" } })).result.count, 0, "after a restart the journal goes on");
	// a stranger gets nothing
	const stranger = await g.user();
	const refused = JSON.parse(await stranger.t().request(JSON.stringify({ method: "rootCount", args: {} })));
	assert.equal(refused.ok, false);
});

test("a Root reports its Members, and a new router takes the journal over and tells them", async (tc) => {
	const g = await setup(tc);
	const dir = dirname(g.controlStore), sid = g.jobs.spaceId;
	const { remote } = await g.router();
	const member = (id: string, action: string, more = {}) => signMembership("instruction", { authorityId: "authority", memberId: "a", spaceId: sid, id, action, ...more } as never, "control-peer", g.controlKey).then((t) => remote.requestMembership(t as never));
	await member("t1", "prepareAdd");
	await member("t1", "activate", { policy: g.routing(1) });
	const routerKey = provisionFileSigner(join(dir, "root-router.json")), hostKey = provisionFileSigner(join(dir, "root-host.json"));
	const config = JSON.parse(readFileSync(g.config, "utf8")), memberKey = loadFileSigner(join(dir, "member.json"));
	const target = { authorityId: "authority", hostId: "data-host", spaceId: sid, dataIncarnation: g.jobs.incarnation, primaryEpoch: 1 };
	const lease = join(dir, "root-lease");
	const setRoot = (more: Record<string, unknown>) => {
		const file = JSON.parse(readFileSync(g.controlConfig, "utf8"));
		file.root = { id: "root", keyFile: join(dir, "root-router.json"), hostKeyFile: join(dir, "root-host.json"), leaseFile: lease, journalPartitions: 1, statusIntervalMs: 1000, members: { a: { target, peerId: "member-peer", keyId: memberKey.keyId, algorithm: memberKey.algorithm, publicKey: memberKey.publicKey, address: { host: config.listen.host, port: config.listen.port } } }, ...more };
		writeFileSync(g.controlConfig, JSON.stringify(file), { mode: 0o600 });
	};
	await g.controlDown(async () => {
		const host = await openSqliteHost(g.controlStore), now = Date.now();
		await host.commit(async (tx) => {
			const s = await spaceDoc(tx, g.space.spaceId, now);
			for (const [k, roles] of [[routerKey, ["host", "router", "member"]], [hostKey, ["host", "member"]]] as const) core.write(s, now, { type: "PeerKey", fields: { peerId: "control-peer", keyId: k.keyId, principal: "control-peer", algorithm: k.algorithm, publicKey: k.publicKey!, roles: [...roles], scope: ["*"], state: "active" } }, null, FOREVER);
			// as a Member's heartbeat leaves it; its own may fall into this restart, and the next is a minute away
			core.write(s, now, { type: "Capability", fields: { hostId: "data-host", resources: {}, tools: ["sieve"], models: [], metrics: {}, at: now } }, null, 120_000);
			const d = await tx.doc(FederationRouting, g.space.spaceId, null);
			d.policy = g.routing(1); d.members = { a: { id: "a", state: "active", target } } as never;
		}, ctx);
		await host.close(ctx);
		setRoot({});
	});
	const line = async () => {
		const t = socketTransport({ host: CONTROL_IP, port: g.controlPort }, { localAddress: CONTROL_IP });
		tc.after(() => t.close());
		await new RemoteSpace(t, { attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 8_000, signer: hostKey, expectedGateHostId: "control-host", ownPeerId: "control-peer" }).authenticate();
		return (method: string, args: Record<string, unknown>) => t.request(JSON.stringify({ method, args })).then((r) => JSON.parse(r) as { ok: boolean; result?: any; error?: { code: string; message: string } });
	};
	let root = await line();
	const wrote = await root("rootWrite", { agentId: "worker", id: "w1", entry: { type: "Job", fields: { n: 1 } }, leaseMs: 60_000 });
	assert.equal(wrote.ok, true, JSON.stringify(wrote));
	await new Promise((r) => setTimeout(r, 2500));
	await g.controlDown(async () => {
		// the heartbeat: the Member answered, its tools reached the routing, and the entry says so
		const host = await openSqliteHost(g.controlStore);
		const routing = await host.snapshot(FederationRouting, g.space.spaceId, ctx), s = await snapshotSpace(host, g.space.spaceId, ctx);
		const status = s!.entries.filter((e) => e.type === "MemberStatus");
		await host.close(ctx);
		assert.deepEqual((routing!.members.a as { capabilities?: { names: string[] } }).capabilities?.names, ["sieve"], JSON.stringify(routing));
		assert.equal(status.length, 1, JSON.stringify(status));
		assert.equal(status[0]!.fields.reachable, true, JSON.stringify(status));
		assert.equal(status[0]!.fields.memberId, "a");
		assert.ok(Number.isInteger(status[0]!.fields.revision), JSON.stringify(status));
		// the lease record lost: without leave to take over nothing starts, with it the epoch rises
		rmSync(lease);
		assert.match((await g.tryControl()) ?? "it stood", /lost its lease record/);
		setRoot({ takeover: true, takeoverWaitMs: 5000 });
	});
	root = await line();
	const taken = await root("rootTake", { agentId: "worker", id: "t1", template: { type: "Job" } });
	assert.equal(taken.ok, true, JSON.stringify(taken));
	await new Promise((r) => setTimeout(r, 2500));
	await g.withMember(async (host) => {
		const d = await host.snapshot(DelegationEpochs, canonicalJson(["authority", sid]), ctx);
		assert.equal(d?.routerEpoch, 2, `the Member heard of the new router: ${JSON.stringify(d)}`);
	});
});

test("an admin adds and drains a Member by command, and the Root works by what that decided", async (tc) => {
	const g = await setup(tc);
	const dir = dirname(g.controlStore), sid = g.jobs.spaceId;
	const routerKey = provisionFileSigner(join(dir, "root-router.json")), hostKey = provisionFileSigner(join(dir, "root-host.json"));
	const config = JSON.parse(readFileSync(g.config, "utf8")), memberKey = loadFileSigner(join(dir, "member.json"));
	const target = { authorityId: "authority", hostId: "data-host", spaceId: sid, dataIncarnation: g.jobs.incarnation, primaryEpoch: 1 };
	await g.controlDown(async () => {
		const host = await openSqliteHost(g.controlStore), now = Date.now();
		await host.commit(async (tx) => {
			const s = await spaceDoc(tx, g.space.spaceId, now);
			for (const [k, roles] of [[routerKey, ["host", "router", "member"]], [hostKey, ["host", "member"]]] as const) core.write(s, now, { type: "PeerKey", fields: { peerId: "control-peer", keyId: k.keyId, principal: "control-peer", algorithm: k.algorithm, publicKey: k.publicKey!, roles: [...roles], scope: ["*"], state: "active" } }, null, FOREVER);
			const d = await tx.doc(FederationRouting, g.space.spaceId, null);
			d.policy = null; d.members = {};
		}, ctx);
		await host.close(ctx);
		const file = JSON.parse(readFileSync(g.controlConfig, "utf8"));
		file.root = { id: "root", keyFile: join(dir, "root-router.json"), hostKeyFile: join(dir, "root-host.json"), leaseFile: join(dir, "root-lease"), journalPartitions: 1, allowMembershipCommands: true, adminPeer: { peerId: "boss", address: g.ADMIN_IP }, members: { a: { target, peerId: "member-peer", keyId: memberKey.keyId, algorithm: memberKey.algorithm, publicKey: memberKey.publicKey, address: { host: config.listen.host, port: config.listen.port } } } };
		writeFileSync(g.controlConfig, JSON.stringify(file), { mode: 0o600 });
	});
	const t = socketTransport({ host: CONTROL_IP, port: g.controlPort }, { localAddress: g.ADMIN_IP });
	tc.after(() => t.close());
	const admin: RemoteSpace = new RemoteSpace(t, { space: "control", attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 8_000, signer: g.adminKey.signer, expectedGateHostId: "control-host", ownPeerId: "boss", grantProvider: () => admin.requestGrant() });
	await admin.authenticate();
	const command = async (commandId: string, kind: string, args: Record<string, unknown>) => {
		await admin.write({ type: "Command", fields: { commandId, kind, args: args as never } }, null, 3_600_000);
		for (let i = 0; i < 400; i++) { const r = (await admin.readAll({ type: "Result", fields: { commandId } }))[0]?.fields as Record<string, any> | undefined; if (r) return r; await new Promise((r2) => setTimeout(r2, 25)); }
		throw new Error("no result");
	};
	const line = socketTransport({ host: CONTROL_IP, port: g.controlPort }, { localAddress: CONTROL_IP });
	tc.after(() => line.close());
	await new RemoteSpace(line, { attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 8_000, signer: hostKey, expectedGateHostId: "control-host", ownPeerId: "control-peer" }).authenticate();
	const root = (method: string, args: Record<string, unknown>) => line.request(JSON.stringify({ method, args })).then((r) => JSON.parse(r) as { ok: boolean; result?: any; error?: { code: string; message: string } });
	const member = { id: "a", state: "adding", target };
	const added = await command("add-1", "addMember", { member });
	assert.deepEqual([added.state, added.result?.phase, added.result?.policyVersion], ["completed", "completed", 1], JSON.stringify(added));
	const wrote = await root("rootWrite", { id: "w1", entry: { type: "Job", fields: { n: 1 } }, leaseMs: 60_000 });
	assert.equal(wrote.ok, true, JSON.stringify(wrote));
	// profiles go through a transition of their own: the Member freezes, installs and resumes under signed instructions
	const installed = await admin.requestRoutingPolicy();
	const extra = { taskType: "Extra", resultTypes: ["ExtraDone"], equalFields: ["n"], maxResultCount: 1, maxResultBytes: 1024, maxLeaseMs: 60_000 };
	const moved = await command("profiles-1", "migrateProfiles", { policy: { ...installed.policy, policyVersion: installed.policy.policyVersion + 1, completionProfiles: [...installed.policy.completionProfiles, extra] } });
	assert.deepEqual([moved.state, moved.result?.phase], ["completed", "completed"], JSON.stringify(moved));
	await g.withMember(async (host) => {
		const s = await snapshotSpace(host, sid, ctx);
		assert.ok(s!.completionProfiles?.some((p) => p.taskType === "Extra"), JSON.stringify(s!.completionProfiles));
	});
	const drained = await command("drain-1", "drain", { member });
	assert.equal(drained.result?.phase, "completed", JSON.stringify(drained));
	assert.equal((await root("rootWrite", { id: "w2", entry: { type: "Job", fields: { n: 2 } }, leaseMs: 60_000 })).error?.code, "MemberDrained", "a drained Member takes no new work");
	assert.equal((await command("add-1", "addMember", { member })).result?.phase, "completed", "a command seen before keeps its result");
	// the read-only views need no Root work: what was done, who asked, and no payloads
	const audit = await command("audit-1", "auditLog", { limit: 2 });
	assert.equal(audit.result.length, 2, JSON.stringify(audit));
	for (const r of audit.result) { assert.equal(r.requestedBy, "boss"); assert.equal(r.state, "completed"); assert.equal(r.result, undefined); }
	assert.ok(Array.isArray((await command("alerts-1", "listAlerts", {})).result));
});

test("a Member serves on the grants of its control host and follows its keys and its fence", async (tc) => {
	const g = await setup(tc);
	await g.toControl.authenticate();
	const user = g.toMember();
	await user.authenticate();
	assert.ok(await user.write({ type: "Job", fields: { n: 1 } }, null, FOREVER), "a grant of the control host counts here");
	assert.equal(await user.count({ type: "Job" }), 1);
	await assert.rejects(g.toMember(false).count({ type: "Job" }), /signed control grant|proof/i, "without a grant nothing is served");
	const held = await g.authority().issue({ peerId: "user", state: { proof: { keyId: g.userKey.signer.keyId } } });
	assert.ok(held);
	// the fence of the external register
	const boot = (await g.external.get<any>("boot:data-host"))!;
	await g.external.compareAndSet("boot:data-host", boot.version, { ...boot.value, state: "fenced" });
	await assert.rejects(user.count({ type: "Job" }));
	const fenced = (await g.external.get<any>("boot:data-host"))!;
	await g.external.compareAndSet("boot:data-host", fenced.version, { ...fenced.value, state: "active" });
	assert.equal(await user.count({ type: "Job" }), 1, "and back");
	// another authority takes over: this host stops following at once
	const a = (await g.external.get<any>(`authority:${g.space.spaceId}`))!;
	await g.external.compareAndSet(`authority:${g.space.spaceId}`, a.version, { ...a.value, hostId: "elsewhere" });
	if (CMD) await assert.rejects(user.count({ type: "Job" }));
	await g.external.compareAndSet(`authority:${g.space.spaceId}`, a.version + 1, a.value);
	// the key is revoked at the control host: the Member asks afresh and refuses
	const taken = await g.withControl((host) => host.commit(async (tx) => { const s = await spaceDoc(tx, g.space.spaceId, Date.now()), p = core.probe(s, Date.now(), { type: "PeerKey", fields: { peerId: "user" } }, null, true); if (p.status !== "found") throw new Error("no key"); core.write(s, Date.now(), { type: "PeerKey", fields: { ...core.plain(p.entry.fields), state: "revoked" } as core.Fields }, null, FOREVER); return true; }, ctx));
	assert.ok(taken);
	await assert.rejects(g.toMember(false).authenticate(), /revoked/);
	await assert.rejects(user.count({ type: "Job" }));
});

test("a Member publishes what it offers at the control host and in its data Space", async (tc) => {
	const g = await setup(tc);
	const entries = async (id: string) => { const s = (await g.withControl((host) => snapshotSpace(host, id, ctx)))!; return core.list(s, Date.now(), { type: "Capability", fields: { hostId: "data-host" } }).map((e) => e.fields as Record<string, any>); };
	if (CONTROL) await new Promise((r) => setTimeout(r, 3000)); // a look at its file stops that host: not before the first beat
	let seen: Array<Record<string, any>> = [];
	for (let i = 0; i < 400 && !seen.length; i++) { seen = await entries(g.space.spaceId); if (!seen.length) await new Promise((r) => setTimeout(r, 50)); }
	assert.equal(seen.length, 1, "the heartbeat arrived");
	assert.deepEqual([seen[0]!.hostId, seen[0]!.tools, seen[0]!.models], ["data-host", ["sieve"], []]);
	assert.ok(seen[0]!.resources.cpus >= 1 && seen[0]!.resources.memoryBytes > 0 && seen[0]!.metrics.freeMemoryBytes > 0 && seen[0]!.at > 0);
	await g.toControl.authenticate();
	const user = g.toMember();
	await user.authenticate();
	assert.equal(await user.count({ type: "Capability" }), 1, "and it stands in the data Space");
});

test("work left waiting survives a restart of the Member", async (tc) => {
	const g = await setup(tc);
	await g.toControl.authenticate();
	const user = g.toMember();
	await user.authenticate();
	const grant = await g.authority().issue({ peerId: "user", state: { proof: { keyId: g.userKey.signer.keyId } } });
	const { t } = await g.user();
	const send = async (c: Record<string, unknown>) => JSON.parse(await t().request(JSON.stringify({ ...c, space: g.jobs.spaceId, frame: { grant } }))) as { result: Record<string, any> };
	const generation = (await send({ method: "generation" })).result.generation as string;
	assert.equal((await send({ method: "take", args: { template: { type: "Later" }, timeoutMs: 3_600_000, waitMs: 0 }, request: { generation, requestId: "p" } })).result.state, "pending");
	await g.restart();
	await g.user();
	const after = g.toMember();
	await after.authenticate();
	await after.write({ type: "Later", fields: { n: 1 } }, null, FOREVER);
	const { t: again } = await g.user();
	const done = JSON.parse(await again().request(JSON.stringify({ method: "pollOperation", args: { targetRequest: { generation, requestId: "p" }, waitMs: 0 }, space: g.jobs.spaceId, frame: { grant } }))) as { result: { state: string } };
	assert.equal(done.result.state, "done");
	assert.equal(await after.count({ type: "Later" }), 0, "the take came through once");
});

test("the control host runs a run on the Member and moves a Space through its life; its next policy arrives by itself", async (tc) => {
	const g = await setup(tc, { runGates: true, spaceLifecycle: true });
	let { remote } = await g.router();
	const sid = g.jobs.spaceId, sign = (v: unknown) => signRun("instruction", v, "control-peer", g.controlKey) as never;
	const step = async (commandId: string, kind: string, revision: number, more = {}) => (await remote.requestRunGate(await sign({ runId: "r", commandId, kind, revision, authorityId: "authority", spaceId: sid, ...more }))).value as unknown as { state: string };
	const member = async (id: string, action: string, more = {}) => remote.requestMembership(await signMembership("instruction", { authorityId: "authority", memberId: "a", spaceId: sid, id, action, ...more } as never, "control-peer", g.controlKey));
	await member("t1", "prepareAdd");
	await member("t1", "activate", { policy: g.routing(1) });
	await g.toControl.authenticate();
	const user = g.toMember();
	await user.authenticate();
	await assert.rejects(remote.requestRunGate(await signRun("instruction", { runId: "r", commandId: "x", kind: "stop", revision: 1, authorityId: "authority", spaceId: sid }, "control-peer", generateKey("ed25519", "rogue").signer) as never), /invalid run gate instruction signature/);
	const spec = { runId: "r", kind: "tasks", config: { tasks: [{ type: "Gated", fields: { n: 1 } }, { type: "Gated", fields: { n: 2 } }] }, members: [sid] };
	assert.equal((await step("p", "prepare", 1, { spec })).state, "preparing");
	assert.equal((await step("p", "prepare", 1, { spec })).state, "preparing", "a retried instruction");
	assert.equal(await user.count({ type: "Gated" }), 2, "the manifest's tasks, once");
	assert.equal(await user.take({ type: "Gated" }, 0), null, "held behind the gate");
	assert.equal((await step("go", "release", 2)).state, "running");
	const txn = await user.createTransaction(30_000);
	assert.ok(await user.take({ type: "Gated" }, 0, { txn: txn.id }));
	await user.abort(txn.id);
	const paused = await step("hold", "pause", 3);
	assert.ok(["pausing", "paused"].includes(paused.state), paused.state);
	await g.restart();
	({ remote } = await g.router());
	assert.deepEqual(await step("hold", "pause", 3), paused, "the gate and its answer outlive the process");
	const again = g.toMember();
	await again.authenticate();
	assert.equal(await again.take({ type: "Gated" }, 0), null, "paused stays paused");
	await assert.rejects(step("other", "pause", 3), /revision|conflict/i, "an outdated instruction changes nothing");
	assert.equal((await step("end", "stop", 4)).state, "stopped");
	// a Space through its life, under this host's permits
	const life = async (q: Record<string, unknown>) => (await remote.requestSpaceLifecycle(await signLifecycle("instruction", { authorityId: "authority", hostId: "data-host", ...q }, "control-peer", g.controlKey) as never)).value;
	const notes = g.notes.spaceId;
	assert.equal((await life({ commandId: "a", action: "archive", spaceId: notes })).state, "archived");
	assert.equal((await life({ commandId: "a", action: "archive", spaceId: notes })).state, "archived", "a retry");
	await assert.rejects(life({ commandId: "c", action: "create", alias: "unpermitted" }), /boot permission/);
	await assert.rejects(life({ commandId: "m", action: "archive", spaceId: sid }), /federation Member/);
	assert.equal((await life({ commandId: "b", action: "reactivate", spaceId: notes })).state, "active");
	// the control host signs a new policy: the next call of a user brings it
	await again.write({ type: "Far", fields: {} }, null, 60_000);
	await g.withControl((host) => host.commit((tx) => applyFederationPolicyIn(tx, g.space.spaceId, "authority", g.routing(2, [{ type: "Far", mode: "local", member: "b" }]), 1), ctx));
	await assert.rejects(again.write({ type: "Far", fields: {} }, null, 60_000), /another Member|RoutingConflict|Member b|belongs/i);
	// a policy this Member cannot take stops its calls, it does not pass for the old one
	await g.withControl((host) => host.commit(async (tx) => { (await tx.doc(FederationRouting, g.space.spaceId, null)).policy!.rules = []; }, ctx));
	await assert.rejects(again.count({ type: "Job" }), /policy changed within version/);
	const many = Array.from({ length: 65 }, (_, n) => ({ type: "Gated", fields: { n } }));
	await assert.rejects(remote.requestRunGate(await sign({ runId: "r2", commandId: "p2", kind: "prepare", revision: 1, authorityId: "authority", spaceId: sid, spec: { runId: "r2", kind: "tasks", config: { tasks: many }, members: [sid] } })), /at most 64 tasks/);
});

test("a device pairs at the control host and works on the Member with what that gave it", async (tc) => {
	const g = await setup(tc);
	const device = await g.phone();
	await assert.doesNotReject(async () => {
		await device.authenticate();
		await device.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
	});
	assert.equal(await device.count({ type: "Job" }), 1);
});

test("a control host hands keys, policy and the directory only to who may have them", async (tc) => {
	const g = await setup(tc);
	const ask = async (t: { request(s: string): Promise<string> }, c: Record<string, unknown>) => JSON.parse(await t.request(JSON.stringify(c))) as { ok: boolean; result?: any; error?: { code: string; message: string } };
	const lookup = { method: "keyLookup", args: { peerId: "user", keyId: g.userKey.signer.keyId } };
	const user = g.atControl(g.USER_IP, g.userKey.signer, "user"), router = g.atControl(g.ROUTER_IP, g.routerKey.signer, "router-peer");
	const bareLookup = await ask(router.t, lookup);
	assert.equal(bareLookup.error?.code, "ProofRequired", "no key without a proof");
	assert.equal((await ask(router.t, { method: "routingPolicy", space: "control" })).error?.code, "ProofRequired");
	assert.equal((await ask(router.t, { method: "capabilityHeartbeat", space: "control", args: {} })).error?.code, "ProofRequired");
	await user.remote.authenticate();
	const admin0 = await user.remote.requestGrant();
	assert.match((await ask(user.t, lookup)).error?.message ?? "", /key lookup requires/, "a member is no service peer");
	assert.match((await ask(user.t, { method: "routingPolicy", space: "control", frame: { grant: await user.remote.requestGrant() } })).error?.message ?? "", /policy requires proven service peer/);
	assert.match((await ask(user.t, { method: "capabilityHeartbeat", space: "control", args: {} })).error?.message ?? "", /capability requires a currently proven host/);
	await router.remote.authenticate();
	assert.equal((await ask(router.t, lookup)).result.publicKey, g.userKey.publicKey);
	assert.equal((await ask(router.t, { method: "keyLookup", args: { peerId: "user", keyId: "none" } })).result ?? null, null);
	assert.equal((await ask(router.t, { method: "keyLookup", args: { peerId: 1 } })).error?.code, "BadRequest");
	assert.match((await ask(router.t, { method: "routingPolicy", space: "control" })).error?.message ?? "", /grant/, "a policy needs a grant");
	const grant = await router.remote.requestGrant();
	const signed = (await ask(router.t, { method: "routingPolicy", space: "control", frame: { grant } })).result;
	assert.equal(verifyFederationPolicy(signed, { authorityId: "authority", peerId: "control-peer", algorithm: "ed25519", publicKey: g.controlKey.publicKey }).policyVersion, 1);
	const beat = (report: unknown, g2 = grant) => ask(router.t, { method: "capabilityHeartbeat", space: "control", args: { report }, frame: { grant: g2 } });
	const report = { hostId: "router-peer", resources: {}, tools: [], models: [], metrics: {} };
	assert.match((await beat({ ...report, hostId: "data-host" })).error?.message ?? "", /associated proven host/, "another host's name");
	for (const bad of [{ ...report, tools: [""] }, { ...report, resources: [] }, { ...report, hostId: "" }, { ...report, metrics: { pad: "x".repeat(16_385) } }]) assert.equal((await beat(bad)).ok, false, JSON.stringify(bad).slice(0, 60));
	assert.equal((await beat(report, undefined)).ok, true);
	assert.match((await ask(router.t, { method: "capabilityHeartbeat", space: "control", args: { report } })).error?.message ?? "", /grant/, "a heartbeat needs a grant");
	// leases
	assert.match((await ask(user.t, { method: "routerLease", space: "control", frame: { grant: admin0 } })).error?.message ?? "", /lease requires proven router/, "a member is no router");
	assert.match((await ask(router.t, { method: "routerLease", space: "control" })).error?.message ?? "", /grant/, "a lease needs a grant");
	const first = await router.remote.requestRouterLease();
	const check = (l: typeof first) => verifyDetached("ed25519", g.controlKey.publicKey, Buffer.from("phi-spaces/router-lease/v1\n" + canonicalJson(l.lease as never)), l.signature);
	assert.ok(check(first)); assert.deepEqual([first.issuer, first.lease.routerPeerId, first.lease.routerEpoch, first.lease.expiresAt - first.lease.issuedAt, first.lease.controlPrimaryEpoch], ["control-peer", "router-peer", 1, 60_000, 1]);
	const renewed = await router.remote.requestRouterLease({ id: first.lease.id, routerEpoch: 1 });
	assert.deepEqual([renewed.lease.id, renewed.lease.routerEpoch, check(renewed)], [first.lease.id, 1, true], "a renewal keeps id and epoch");
	await assert.rejects(router.remote.requestRouterLease({ id: "other", routerEpoch: 1 }), /no longer owns current epoch/);
	await assert.rejects(router.remote.requestRouterLease({ id: first.lease.id, routerEpoch: 2 }), /no longer owns current epoch/);
	const third = await router.remote.requestRouterLease({ id: "other", routerEpoch: 1, token: renewed } as never).then((l) => l, (e: Error) => e.message);
	assert.match(String(third), /no longer owns/, "a token of another id");
	const forged = await router.remote.requestRouterLease({ id: "other", routerEpoch: 1, token: { ...renewed, lease: { ...renewed.lease, id: "other" } } } as never).then((l) => l, (e: Error) => e.message);
	assert.match(String(forged), /no longer owns/, "a token whose signature does not cover it");
	assert.equal((await router.remote.requestRouterLease({ id: first.lease.id, routerEpoch: 1, token: { ...renewed, signature: "AAAA" } } as never)).lease.routerEpoch, 1, "the live record still names it");
	const after = await router.remote.requestRouterLease();
	assert.equal(after.lease.routerEpoch, 2, "a new lease raises the epoch");
	await assert.rejects(router.remote.requestRouterLease({ id: first.lease.id, routerEpoch: 1 }), /no longer owns current epoch/, "the old one is out");
	const rival = g.atControl(g.PAIR_IP, g.pairKey.signer, "router-two");
	await rival.remote.authenticate();
	await assert.rejects(rival.remote.requestRouterLease(), /previous router lease is live/, "a second router waits for the first");
	// the control Space itself
	assert.match((await ask(router.t, { method: "membershipInstruction", space: "control", args: { instruction: {} } })).error?.message ?? "", /for admins who proved their key/, "the notices stop at it too");
	const nothing = await ask(router.t, { method: "count", space: "control", args: { template: { type: "Job" } } });
	assert.match(nothing.error?.message ?? "", /for admins who proved their key/, "the control Space stays the admins'");
	assert.match((await ask(router.t, { method: "count", args: { template: { type: "Job" } } })).error?.message ?? "", /signed control grant/, "no call without a grant");
	assert.ok((await ask(router.t, { method: "count", args: { template: { type: "Job" } }, frame: { grant } })).ok, "and one with it");
	const admin = await user.remote.requestGrant();
	assert.equal((await ask(user.t, { method: "readAll", space: "control", args: { template: { type: "PeerKey" } }, frame: { grant: admin } })).ok, false, "keys are no business of a member");
	assert.equal((await ask(user.t, { method: "write", space: "control", args: { entry: { type: "PeerKey", fields: {} }, leaseMs: 1000 }, frame: { grant: admin } })).ok, false);
	// no policy installed
	await g.withControl((host) => host.commit(async (tx) => { (await tx.doc(FederationRouting, g.space.spaceId, null)).policy = null; }, ctx));
	const next = g.atControl(g.ROUTER_IP, g.routerKey.signer, "router-peer");
	await next.remote.authenticate();
	assert.match((await ask(next.t, { method: "routingPolicy", space: "control", frame: { grant: await next.remote.requestGrant() } })).error?.message ?? "", /no federation policy installed/);
	// a fenced control host serves nothing
	const boot = (await g.external.get<any>("boot:control-host"))!, held = await next.remote.requestGrant();
	assert.ok((await ask(next.t, { method: "generation", frame: { grant: held } })).ok);
	await g.external.compareAndSet("boot:control-host", boot.version, { ...boot.value, state: "fenced" });
	assert.equal((await ask(next.t, { method: "generation", frame: { grant: held } })).ok, false, "a fenced host serves nothing");
	await g.external.compareAndSet("boot:control-host", boot.version + 1, boot.value);
});

test("an admin sets the policy by command: the control host checks it and Members follow", async (tc) => {
	const g = await setup(tc);
	const t = socketTransport({ host: "127.0.0.5", port: g.controlPort }, { localAddress: g.ADMIN_IP });
	tc.after(() => t.close());
	const admin: RemoteSpace = new RemoteSpace(t, { space: "control", attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 8_000, signer: g.adminKey.signer, expectedGateHostId: "control-host", ownPeerId: "boss", grantProvider: () => admin.requestGrant() });
	await admin.authenticate();
	const leasing = g.atControl(g.ROUTER_IP, g.routerKey.signer, "router-peer");
	await leasing.remote.authenticate();
	const held = await leasing.remote.requestRouterLease();
	await leasing.remote.requestRouterLease({ id: held.lease.id, routerEpoch: held.lease.routerEpoch });
	assert.equal(await g.withControl((host) => host.commit(async (tx) => (await spaceDoc(tx, g.space.spaceId, Date.now())).entries.filter((e) => e.type === "RouterLease").length, ctx)), 1, "a renewal replaces the lease");
	await admin.authenticate(); // the store was in the test's hands
	const command = async (commandId: string, args: Record<string, unknown>) => {
		await admin.write({ type: "Command", fields: { commandId, kind: "setPolicy", args: args as never } }, null, 3_600_000);
		for (let i = 0; i < 200; i++) { const r = (await admin.readAll({ type: "Result", fields: { commandId } }))[0]?.fields as Record<string, any> | undefined; if (r) return r; await new Promise((r2) => setTimeout(r2, 25)); }
		throw new Error("no result");
	};
	const failed = async (id: string, args: Record<string, unknown>, part: RegExp) => { const r = await command(id, args); assert.equal(r.state, "failed", JSON.stringify(r)); assert.match(r.error, part); };
	await failed("c1", { policy: g.routing(3), expectedVersion: 2 }, /stale policy command/);
	await failed("c2", { policy: g.routing(3), expectedVersion: 1 }, /policy version must advance/);
	await failed("c3", { policy: { ...(g.routing(2) as object), authorityId: "other" }, expectedVersion: 1 }, /stale policy command/);
	await failed("c4", { policy: g.routing(2, [{ type: "Capability", mode: "local", member: "a" }]), expectedVersion: 1 }, /directory types are protected/);
	await failed("c5", { policy: g.routing(2, [{ type: "Far", mode: "local", member: "nobody" }]), expectedVersion: 1 }, /unregistered rule member/);
	const done = await command("c6", { policy: g.routing(2, [{ type: "Far", mode: "local", member: "b" }]), expectedVersion: 1 });
	assert.deepEqual([done.state, done.result], ["completed", { policyVersion: 2 }]);
	await failed("c7", { policy: g.routing(2), expectedVersion: 1 }, /stale policy command/);
	await failed("c8", { policy: g.routing(3), expectedVersion: 2 }, /existing type rule may only disappear/);
	assert.equal((await command("c9", { policy: g.routing(3, [{ type: "Far", mode: "local", member: "b" }, { type: "Next", mode: "local", member: "a" }]), expectedVersion: 2 })).state, "completed");
	const router = g.atControl(g.ROUTER_IP, g.routerKey.signer, "router-peer");
	await router.remote.authenticate();
	const read = JSON.parse(await router.t.request(JSON.stringify({ method: "routingPolicy", space: "control", frame: { grant: await router.remote.requestGrant() } }))) as { result: { policy: { policyVersion: number } } };
	assert.equal(read.result.policy.policyVersion, 3, "the signed policy is the new one");
	await g.withControl((host) => host.snapshot(FederationRouting, g.space.spaceId, ctx).then((d) => assert.equal(d?.policy?.policyVersion, 3, "and the file says so for the other server")));
});

test("what a control host does not carry stops it at the start", { skip: CONTROL ? false : "the refusals of the other server" }, async (tc) => {
	const g = await setup(tc);
	const config = JSON.parse(readFileSync(g.controlConfig, "utf8")) as Record<string, any>;
	await g.controlDown(async () => {
		const refused = async (change: Record<string, unknown>, part: RegExp) => {
			const file = `${g.controlConfig}.other`;
			rmSync(file, { force: true });
			writeFileSync(file, JSON.stringify({ ...config, ...change }), { mode: 0o600 });
			const proc = spawn(CONTROL![0]!, [...CONTROL!.slice(1), "--store", g.controlStore, "--control", file], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
			let out = "";
			proc.stderr.on("data", (d: Buffer) => { out += d; });
			const code = await new Promise((r) => proc.on("exit", r));
			assert.equal(code, 1, out);
			assert.match(out, part);
		};
		for (const k of ["syncSpaces", "registerSshTarget", "registerReadSocket", "membership", "runGates", "spaceLifecycle"]) await refused({ [k]: { any: 1 } }, new RegExp(`${k} is not served`));
		await refused({ mode: "member" }, /runs as a control host/);
		await refused({ peerId: "someone-else" }, /does not belong to the provisioned NetBird peer/);
		await refused({ hostId: "other" }, /identity disagrees/);
		await refused({ controlSpaceId: "sp-other" }, /identity disagrees/);
		await refused({ control: { ...config.control, publicKey: g.userKey.publicKey } }, /disagrees with installed authority/);
	});
	const aOnly = async () => { const user = g.atControl(g.USER_IP, g.userKey.signer, "user"); return JSON.parse(await user.t.request(JSON.stringify({ method: "grant", args: { purpose: "effect" } }))) as { ok: boolean; error?: { message: string } }; };
	assert.equal((await aOnly()).ok, true, "A-only rights stand without a recovery");
	await g.external.compareAndSet("access:authority", null, { authorityId: "authority", aOnlyAllowed: true });
	await g.controlDown(async () => {});
	assert.equal((await aOnly()).ok, true, "the register allows them");
	await g.external.compareAndSet("access:authority", 1, { authorityId: "authority", aOnlyAllowed: false });
	await g.controlDown(async () => {});
	assert.match((await aOnly()).error?.message ?? "", /A-only rights remain disabled/, "the register ends them after a recovery");
});

test("what a Member does not carry stops it at the start instead of being ignored", { skip: CMD ? false : "the refusals of the other server" }, async (tc) => {
	const g = await setup(tc);
	const config = JSON.parse(readFileSync(g.config, "utf8")) as Record<string, unknown>;
	const refused = async (change: Record<string, unknown>, part: RegExp) => {
		const file = `${g.config}.other`;
		rmSync(file, { force: true });
		writeFileSync(file, JSON.stringify({ ...config, ...change }), { mode: 0o600 });
		const proc = spawn(CMD![0]!, [...CMD!.slice(1), "--store", `${g.storeFile}.other`, "--member", file], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
		let out = "";
		proc.stderr.on("data", (d: Buffer) => { out += d; });
		const code = await new Promise((r) => proc.on("exit", r));
		assert.equal(code, 1, out);
		assert.match(out, part);
	};
	for (const k of ["root", "registerSshTarget", "registerReadSocket"]) await refused({ [k]: { any: 1 } }, new RegExp(`${k} is not served`));
	await refused({ capabilities: { tools: [""] } }, /invalid capability report/);
	await refused({ mode: "control" }, /a control host starts with --control/);
	await refused({ peerId: "someone-else" }, /does not belong to the provisioned NetBird peer/);
	const boot = (await g.external.get<any>("boot:data-host"))!;
	await g.external.compareAndSet("boot:data-host", boot.version, { ...boot.value, state: "fenced" });
	await refused({}, /not authorized for normal boot/);
	await g.external.compareAndSet("boot:data-host", boot.version + 1, boot.value);
	const a = (await g.external.get<any>(`authority:${g.space.spaceId}`))!;
	await g.external.compareAndSet(`authority:${g.space.spaceId}`, a.version, { ...a.value, hostId: "elsewhere" });
	await refused({}, /control authority is not the installed one/);
	await g.external.compareAndSet(`authority:${g.space.spaceId}`, a.version + 1, a.value);
	const local = new SqliteRecoveryRegister(config.installedRegisterFile as string);
	tc.after(() => local.close());
	await local.compareAndSet(`installed-authority:${g.space.spaceId}`, null, { targetHostId: "other" });
	await refused({}, /control endpoint must be reprovisioned for the installed authority successor/);
});

test("a router's delegated call follows the policy the control host signs now, and old versions stop", async (tc) => {
	const g = await setup(tc);
	const { t } = await g.router();
	const home = g.atControl(g.ROUTER_IP, g.routerKey.signer, "router-peer");
	await home.remote.authenticate();
	const lease = await home.remote.requestRouterLease();
	const grant = await g.authority().issue({ peerId: "user", state: { proof: { keyId: g.userKey.signer.keyId } } });
	const send = async (c: Record<string, unknown>, policyVersion: number) => {
		const call = { ...c, space: g.jobs.spaceId };
		const d = delegationForCall({ call: call as never, principal: { peerId: "user" }, lease, policyVersion, spaceId: g.jobs.spaceId, primaryEpoch: 1, grant: grant as never, now: Date.now() });
		return JSON.parse(await t.request(JSON.stringify({ ...call, frame: { grant, delegation: await signDelegation(g.routerKey.signer, d) } }))) as { ok: boolean; result?: any; error?: { message: string } };
	};
	const first = await send({ method: "generation" }, 1);
	assert.ok(first.ok, JSON.stringify(first));
	const write = await send({ method: "write", args: { entry: { type: "Job", fields: { n: 1 } }, txn: null, leaseMs: FOREVER }, request: { generation: first.result.generation, requestId: "r1" } }, 1);
	assert.ok(write.ok, JSON.stringify(write));
	assert.equal((await send({ method: "count", args: { template: { type: "Job" } } }, 1)).result.value, 1);
	assert.match((await send({ method: "count", args: { template: { type: "Job" } } }, 7)).error?.message ?? "", /policy/i, "a version the control host does not sign");
	await g.withControl((host) => host.commit((tx) => applyFederationPolicyIn(tx, g.space.spaceId, "authority", g.routing(2), 1), ctx));
	assert.match((await send({ method: "count", args: { template: { type: "Job" } } }, 1)).error?.message ?? "", /policy/i, "the old version stops at once");
	assert.equal((await send({ method: "count", args: { template: { type: "Job" } } }, 2)).result.value, 1);
});

test("signed instructions reach the Member, a drain holds over a restart, and what it was not given is refused", async (tc) => {
	const g = await setup(tc);
	const base = { authorityId: "authority", memberId: "a", spaceId: g.jobs.spaceId };
	const q = (id: string, action: string, more: Record<string, unknown> = {}, k = g.controlKey as Signer) => signMembership("instruction", { ...base, id, action, ...more } as never, "control-peer", k);
	let { remote } = await g.router();
	const send = async (id: string, action: string, more: Record<string, unknown> = {}) => (await remote.requestMembership(await q(id, action, more))).value as unknown as Record<string, any>;
	await assert.rejects(remote.requestMembership(await q("x", "prepareAdd", {}, generateKey("ed25519", "rogue").signer)), /invalid membership signature/);
	await assert.rejects(remote.requestMembership(await q("x", "prepareAdd", { memberId: "b" })), /binding mismatch/);
	const added = await send("t1", "prepareAdd");
	assert.deepEqual(await send("t1", "prepareAdd"), added, "a retry gets the same proof");
	await send("t1", "activate", { policy: g.routing(1) });
	await g.toControl.authenticate();
	const user = g.toMember();
	await user.authenticate();
	await user.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
	const drained = await send("t3", "drain");
	assert.equal(drained.state, "draining");
	await assert.rejects(user.write({ type: "Job", fields: { n: 2 } }, null, FOREVER), /no bounded completion allowance/);
	await g.restart();
	({ remote } = await g.router());
	assert.deepEqual(await send("t3", "drain"), drained, "the journal outlives the process");
	const back = g.toMember();
	await back.authenticate();
	await assert.rejects(back.write({ type: "Job", fields: { n: 2 } }, null, FOREVER), /no bounded completion allowance/, "and so does the drain");
	assert.equal(await back.count({ type: "Job" }), 1);
	const run = await signRun("instruction", { runId: "r", commandId: "p", kind: "stop", revision: 1, authorityId: "authority", spaceId: g.jobs.spaceId }, "control-peer", g.controlKey) as never;
	await assert.rejects(remote.requestRunGate(run), /run gates not configured/);
	const life = await signLifecycle("instruction", { commandId: "c", action: "create", alias: "x", authorityId: "authority", hostId: "data-host" }, "control-peer", g.controlKey) as never;
	await assert.rejects(remote.requestSpaceLifecycle(life), /space lifecycle not configured/);
});
