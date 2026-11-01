// A Member behind a TypeScript control host, as a deployment runs it: its config file, its keys, the TLS register, the
// management API, the wire. Without PHI_SPACES_SERVER_CMD the Member is TypeScript too, with it that server (`--member`).
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROL_SPACE, FOREVER, GrantAuthority, createEnroll, hashToken, newEnrollToken, RemoteSpace, SqliteRecoveryRegister, SpaceKeyDirectory, core, createSpace, generateKey, listSpaces, snapshotSpace, provisionFileSigner, serveTlsRegister, socketTransport, spaceDoc, startConfiguredFederation, type Signer } from "../src/index.ts";
import { RouterLeaseAuthority, delegationForCall, signDelegation } from "../src/delegation.ts";
import { FederationRouting, applyFederationPolicyIn } from "../src/federation-policy.ts";
import { signMembership } from "../src/membership.ts";
import { signRun } from "../src/run-member.ts";
import { signLifecycle } from "../src/space-lifecycle.ts";
import { openSqliteHost } from "../src/store/sqlite.ts";
import { ctx } from "./support/persistent.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CMD = process.env.PHI_SPACES_SERVER_CMD?.trim() ? process.env.PHI_SPACES_SERVER_CMD.trim().split(/\s+/) : null;
const peer = (id: string, ip: string, groups: string[]) => ({ id, name: id, ip, connected: true, groups: groups.map((g) => ({ id: `g-${g}`, name: g })) });
const CONTROL_IP = "127.0.0.5", MEMBER_IP = "127.0.0.1", USER_IP = "127.0.0.3", ROUTER_IP = "127.0.0.4", PHONE_IP = "127.0.0.6", PAIRED_IP = "127.0.0.7"; // a host reaches its control host from the Member address: on loopback that is 127.0.0.1
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

async function setup(tc: TestContext) {
	const dir = mkdtempSync("/tmp/phi-mixed-");
	tc.after(() => rmSync(dir, { recursive: true, force: true }));
	const certs = pki(dir);
	const external = new SqliteRecoveryRegister(join(dir, "external.sqlite"));
	tc.after(() => external.close());
	const register = await serveTlsRegister(external, { ...certs.identity("server"), host: "127.0.0.1", port: 0, peers: { [certs.print("control")]: {}, [certs.print("member")]: {} } });
	tc.after(() => register.close());
	const peers = [peer("control-peer", CONTROL_IP, ["space-hosts"]), peer("member-peer", MEMBER_IP, ["space-hosts"]), peer("user", USER_IP, ["space-hosts"]), peer("router-peer", ROUTER_IP, ["space-hosts"]), peer("phone", PHONE_IP, ["space-enroll"]), peer("phone", PAIRED_IP, ["space-hosts"])]; // before and after pairing: the directory is cached for a minute
	const management = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(peers)); });
	await new Promise<void>((r) => management.listen(0, "127.0.0.1", r));
	tc.after(() => { management.closeAllConnections(); management.close(); });
	writeFileSync(join(dir, "token"), "t", { mode: 0o600 });
	const controlKey = provisionFileSigner(join(dir, "control.json")), memberKey = provisionFileSigner(join(dir, "member.json"));
	const userKey = generateKey("ed25519", "user-key"), routerKey = generateKey("ed25519", "router-key");
	const now = Date.now();
	// the control host's store: its Space, its keys, its permit
	const control = await openSqliteHost(join(dir, "control.sqlite"));
	tc.after(() => control.close(ctx));
	const space = await control.commit((tx) => createSpace(tx, CONTROL_SPACE, now), ctx);
	await control.commit(async (tx) => {
		const s = await spaceDoc(tx, space.spaceId, now);
		const put = (peerId: string, k: Signer & { publicKey?: string }, publicKey: string, roles: string[]) => core.write(s, now, { type: "PeerKey", fields: { peerId, keyId: k.keyId, principal: peerId, algorithm: k.algorithm, publicKey, roles, scope: ["*"], state: "active" } }, null, FOREVER);
		put("member-peer", memberKey, memberKey.publicKey, ["host"]);
		put("user", userKey.signer, userKey.publicKey, ["member"]);
		put("router-peer", routerKey.signer, routerKey.publicKey, ["host", "router", "member"]);
	}, ctx);
	await control.commit((tx) => spaceDoc(tx, undefined, now).then(() => {}), ctx);
	const routing = (version: number) => ({ authorityId: "authority", policyVersion: version, rules: [], completionProfiles: [], default: { mode: "local", member: "a" } }) as never;
	await control.commit(async (tx) => { (await tx.doc(FederationRouting, space.spaceId, null)).members.a = { id: "a", state: "active" } as never; await applyFederationPolicyIn(tx, space.spaceId, "authority", routing(1), 0); }, ctx);
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
	const root = await startConfiguredFederation(control, ctx, write("control", { ...base("control", CONTROL_IP, controlPort), hostId: "control-host", peerId: "control-peer", mode: "control", capabilities: { hostBindings: { "control-peer": "control-host", "member-peer": "data-host" } } }));
	tc.after(() => root.close());
	// the Member's store, seeded as a provisioning does; its permits
	const storeFile = join(dir, "member.sqlite"), seed = await openSqliteHost(storeFile);
	const jobs = await seed.commit((tx) => createSpace(tx, "jobs", now), ctx);
	await seed.commit((tx) => spaceDoc(tx, undefined, now).then(() => {}), ctx);
	// the permits are only external: the start installs them where the data is the one they name
	const memberSpaces: Record<string, unknown> = {};
	for (const i of await listSpaces(seed, ctx)) memberSpaces[i.spaceId] = permit(i.incarnation);
	await external.compareAndSet("boot:data-host", null, { hostId: "data-host", state: "active", spaces: memberSpaces } as never);
	const config = write("member", { ...base("member", MEMBER_IP, memberPort), hostId: "data-host", peerId: "member-peer", mode: "member", membership: { memberId: "a", spaceId: jobs.spaceId }, capabilities: { tools: ["sieve"], models: [], dataSpaces: [jobs.spaceId] } });
	await seed.close(ctx);
	const start = async () => {
		if (!CMD) {
			const host = await openSqliteHost(storeFile), member = await startConfiguredFederation(host, ctx, config);
			return async () => { await member.close(); await host.close(ctx); };
		}
		const proc = spawn(CMD[0]!, [...CMD.slice(1), "--store", storeFile, "--member", config], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
		await new Promise<void>((resolve, reject) => {
			let out = "";
			const seen = (d: Buffer) => { out += d; if (out.includes("ready on")) resolve(); };
			proc.stdout.on("data", seen); proc.stderr.on("data", seen);
			proc.on("exit", (code) => reject(new Error(`the member exited (${code}):\n${out}`)));
		});
		return () => new Promise<void>((r) => { proc.removeAllListeners("exit"); proc.once("exit", () => r()); proc.kill("SIGTERM"); });
	};
	let stop = await start();
	tc.after(() => stop());
	const restart = async () => { await stop(); stop = await start(); };
	const transports: Array<{ close(): void }> = [];
	tc.after(() => transports.forEach((t) => t.close()));
	const toControl = (() => { const t = socketTransport({ host: CONTROL_IP, port: controlPort }, { localAddress: USER_IP }); transports.push(t); return new RemoteSpace(t, { space: "control", attempts: 2, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 5_000, signer: userKey.signer, expectedGateHostId: "control-host", ownPeerId: "user" }); })();
	const toMember = (grants = true) => { const t = socketTransport({ host: MEMBER_IP, port: memberPort }, { localAddress: USER_IP }); transports.push(t); return new RemoteSpace(t, { space: jobs.spaceId, attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 8_000, signer: userKey.signer, expectedGateHostId: "data-host", ownPeerId: "user", ...(grants ? { grantProvider: () => toControl.requestGrant() } : {}) }); };
	const authority = () => new GrantAuthority({ authorityId: "authority", hostId: "control-host", signer: controlKey, keys: new SpaceKeyDirectory(control, ctx), identity: { authenticate: () => ({ principal: { peerId: "user" }, roles: ["member"] }) }, refreshIdentity: async () => ({ principal: { peerId: "user" }, roles: ["member"] }) });
	/** A router's line to the Member: proven, its role from the directory. */
	const router = async () => {
		const t = socketTransport({ host: MEMBER_IP, port: memberPort }, { localAddress: ROUTER_IP });
		transports.push(t);
		const remote = new RemoteSpace(t, { attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 8_000, signer: routerKey.signer, expectedGateHostId: "data-host", ownPeerId: "router-peer" });
		await remote.authenticate();
		return { t, remote };
	};
	const leases = new RouterLeaseAuthority({ host: control, ctx, controlSpaceId: space.spaceId, authorityId: "authority", peerId: "control-peer", signer: controlKey, keys: new SpaceKeyDirectory(control, ctx), assertAuthority: async () => {} });
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
		await createEnroll(control, ctx, { tokenHash: hashToken(token), role: "member", allowedPeerId: "phone", scope: ["*"] });
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
	return { user, phone, toMember, toControl, external, jobs, control, space, userKey, routerKey, controlKey, authority, config, storeFile, router, leases, routing, restart };
}

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
	const taken = await g.control.commit(async (tx) => { const s = await spaceDoc(tx, g.space.spaceId, Date.now()), p = core.probe(s, Date.now(), { type: "PeerKey", fields: { peerId: "user" } }, null, true); if (p.status !== "found") throw new Error("no key"); core.write(s, Date.now(), { type: "PeerKey", fields: { ...core.plain(p.entry.fields), state: "revoked" } as core.Fields }, null, FOREVER); return true; }, ctx);
	assert.ok(taken);
	await assert.rejects(g.toMember(false).authenticate(), /revoked/);
	await assert.rejects(user.count({ type: "Job" }));
});

test("a Member publishes what it offers at the control host and in its data Space", async (tc) => {
	const g = await setup(tc);
	const entries = async (id: string) => { const s = (await snapshotSpace(g.control, id, ctx))!; return core.list(s, Date.now(), { type: "Capability", fields: { hostId: "data-host" } }).map((e) => e.fields as Record<string, any>); };
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

test("a device pairs at the control host and works on the Member with what that gave it", async (tc) => {
	const g = await setup(tc);
	const device = await g.phone();
	await assert.doesNotReject(async () => {
		await device.authenticate();
		await device.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
	});
	assert.equal(await device.count({ type: "Job" }), 1);
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
	for (const k of ["root", "syncSpaces", "entryReplication", "recovery"]) await refused({ [k]: { any: 1 } }, new RegExp(`${k} is not served`));
	await refused({ recoveryAdmin: { any: 1 } }, /recoveryAdmin is not served/);
	await refused({ capabilities: { tools: [""] } }, /invalid capability report/);
	await refused({ mode: "control" }, /a control host stays on TypeScript/);
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
	await refused({}, /the control host changed/);
});

test("a router's delegated call follows the policy the control host signs now, and old versions stop", async (tc) => {
	const g = await setup(tc);
	const { t } = await g.router();
	const lease = await g.leases.issue("router-peer", g.routerKey.signer.keyId);
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
	await g.control.commit((tx) => applyFederationPolicyIn(tx, g.space.spaceId, "authority", g.routing(2), 1), ctx);
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
