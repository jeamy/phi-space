// Deployment bootstrap (docs/betrieb-und-mobile-steuerung.md §4, §8 B8): config validation, alias bindings, plan,
// idempotent apply across two stores, resume after failures, conflicts, worker start, export, admin commands, CLI.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as c from "../src/core.ts";
import { generateKey } from "../src/auth.ts";
import { CONTROL_SPACE, ControlAccess, DEFAULT_POLICY, EnrollmentService, GateIdentity, NetbirdDirectory, ProvingService, RemoteSpace, SpaceKeyDirectory, SpaceService, Supervisor, bootstrapEnroll, hashToken, newEnrollToken, provisionFileSigner, socketTransport, startGate } from "../src/index.ts";
import { DeploymentController, deploymentCommands, validateDeployment, type DeploymentConfig } from "../src/deployment.ts";
import { principalId } from "../src/mailbox.ts";
import { SpaceLifecycle, SpaceLifecycleService, spaceCommands } from "../src/space-lifecycle.ts";
import { createSpace, listSpaces, snapshotSpace, spaceDoc } from "../src/spaces.ts";
import { WorkerAssignments } from "../src/workers.ts";
import { BACKENDS, ctx, PersistentHome, type Backend } from "./support/persistent.ts";

const example = (): DeploymentConfig => ({
	schemaVersion: 1, deployment: "prime-demo", coordinator: "host-a",
	hosts: [{ alias: "host-a", ssh: "pi@vps-a", role: "coordinator" }, { alias: "host-b", ssh: "pi@vps-b", role: "member-host" }],
	spaces: [{ alias: "control-demo", host: "host-a", purpose: "control" }, { alias: "sieve-a", host: "host-a", purpose: "data", maxSpaceBytes: 67108864 }, { alias: "sieve-b", host: "host-b", purpose: "data" }],
	routing: { profile: "single-member-sieve", member: "sieve-a" },
	workers: [{ alias: "sieve-worker-b", host: "host-b", kind: "sieve", targetSpace: "sieve-b", count: 2, runId: "r1" }],
	mobile: { access: "native-overlay", enrollmentRole: "admin" }, credentials: { source: "host-secret-store" },
});

test("config validation lists every problem and refuses secrets", () => {
	const ok = validateDeployment(example());
	assert.deepEqual(ok.errors, []); assert.match(ok.configHash!, /^[0-9a-f]{64}$/);
	assert.equal(validateDeployment(example()).configHash, ok.configHash, "the hash is stable");
	const bad: any = example();
	bad.hosts.push({ alias: "host-b", role: "member-host" });
	bad.spaces.push({ alias: "ctl2", host: "host-b", purpose: "control" });
	bad.workers[0].host = "host-a";
	bad.netbirdSetupKey = "x";
	bad.hosts[1].apiToken = "abc";
	bad.spaces[1].profiles = [{ note: "-----BEGIN PRIVATE KEY-----\nMII" }];
	const errors = validateDeployment(bad).errors.join("\n");
	for (const expected of [/duplicate alias host-b/, /control Space lives on the coordinator/, /exactly one control Space/, /run on the host of their target/, /unknown field netbirdSetupKey/, /apiToken: secret fields/, /looks like a secret/]) assert.match(errors, expected);
});

/** Coordinator (store A) and host-b (store B); the lifecycle commands reach each host's own store. */
async function fixture(backend: Backend) {
	const homes = { a: new PersistentHome(backend), b: new PersistentHome(backend) };
	const hosts = { a: await homes.a.open(), b: await homes.b.open() };
	const keys = { control: generateKey("ed25519", "control"), a: generateKey("ed25519", "a"), b: generateKey("ed25519", "b") };
	const pin = (k: ReturnType<typeof generateKey>, issuer: string) => ({ issuer, algorithm: k.signer.algorithm, publicKey: k.publicKey });
	// built over the current hosts (again after a crash: a crashed host is gone, as its process would be)
	const service = (id: "id-a" | "id-b") => ({
		"id-a": new SpaceLifecycleService({ lifecycle: new SpaceLifecycle({ host: hosts.a, ctx }), hostId: "id-a", authorityId: "authority", peerId: "id-a", signer: keys.a.signer, controlPin: pin(keys.control, "control"), assertAuthority: async () => {} }),
		"id-b": new SpaceLifecycleService({ lifecycle: new SpaceLifecycle({ host: hosts.b, ctx }), hostId: "id-b", authorityId: "authority", peerId: "id-b", signer: keys.b.signer, controlPin: pin(keys.control, "control"), assertAuthority: async () => {} }),
	});
	const down = new Set<string>(), fresh = new Set(["id-a", "id-b"]);
	const commands = spaceCommands({ authorityId: "authority", peerId: "control", signer: keys.control.signer, hostPin: async id => pin(id === "id-a" ? keys.a : keys.b, id), send: async (id, t) => { if (down.has(id)) throw new Error("connect ECONNREFUSED"); return service(id as "id-a" | "id-b")[id as "id-a" | "id-b"].apply(t); } });
	const controlSpaceId = (await hosts.a.commit(tx => createSpace(tx, CONTROL_SPACE, Date.now()), ctx)).spaceId;
	const assignments = () => new WorkerAssignments({ host: hosts.a, ctx, authorityId: "authority", peerId: "control", signer: keys.control.signer });
	let workers = assignments();
	const make = () => new DeploymentController({ host: hosts.a, ctx, ports: { hostStatus: async id => ({ fresh: fresh.has(id) }), createSpace: commands.createSpace, workers, controlSpaceId } });
	return { homes, hosts, down, fresh, make, get workers() { return workers; }, controlSpaceId, crashA: async () => { homes.a.crash(hosts.a); hosts.a = await homes.a.open(); workers = assignments(); },
		dispose: async () => { await homes.a.dispose(); await homes.b.dispose(); } };
}

for (const backend of BACKENDS) test(`${backend}: plan blocks unbound or silent hosts; apply creates once, resumes after failures and reuses on repeat`, async () => {
	const o = await fixture(backend);
	try {
		let d = o.make();
		let plan = await d.plan(example());
		assert.equal(plan.ready, false); assert.deepEqual(plan.steps.filter(s => s.status === "blocked").map(s => s.key), ["host:host-a", "host:host-b"]);
		await d.bindHost("host-a", "id-a"); await d.bindHost("host-b", "id-b");
		await assert.rejects(d.bindHost("host-b", "id-c"), /bound to id-b/, "an alias never moves silently");
		o.fresh.delete("id-b");
		plan = await d.plan(example());
		assert.equal(plan.ready, false); assert.match(plan.steps.find(s => s.key === "host:host-b")!.detail, /no fresh Capability/);
		assert.equal((await d.apply(example())).state, "blocked", "a blocked plan changes nothing");
		assert.equal((await listSpaces(o.hosts.b, ctx)).length, 0);
		o.fresh.add("id-b");
		plan = await d.plan(example());
		assert.equal(plan.ready, true);
		assert.deepEqual(plan.steps.filter(s => s.key.startsWith("space:")).map(s => s.status), ["reuse", "create", "create"]);

		o.down.add("id-b");
		await assert.rejects(d.apply(example()), /ECONNREFUSED/, "an unreachable host leaves the job applying");
		await o.crashA(); d = o.make();
		o.down.clear();
		const done = await d.apply(example());
		assert.equal(done.state, "completed");
		const bSpaces = (await listSpaces(o.hosts.b, ctx)).filter(i => i.alias !== "default");
		assert.deepEqual(bSpaces.map(i => i.alias), ["sieve-b"], "exactly one Space on host-b after the retry");
		const aSieve = (await listSpaces(o.hosts.a, ctx)).find(i => i.alias === "sieve-a")!;
		assert.equal(c.limitsOf((await snapshotSpace(o.hosts.a, aSieve.spaceId, ctx))!).maxSpaceBytes, 67108864);
		const listed = (await o.workers.list()).assignments;
		assert.deepEqual(listed.map(w => [w.assignmentId, w.hostId, w.count]), [["prime-demo.sieve-worker-b", "id-b", 0]], "registered, not started");
		assert.deepEqual((await d.apply(example())).state, "completed", "repeat: nothing new");
		const started = await d.startWorkers("go-1", "prime-demo");
		assert.deepEqual(started.map(s => [s.alias, s.count]), [["sieve-worker-b", 2]]);

		const next = example(); next.configRevision = 2; next.spaces.push({ alias: "sieve-b2", host: "host-b", purpose: "data" });
		const nextPlan = await d.plan(next);
		assert.deepEqual(nextPlan.steps.filter(s => s.key.startsWith("space:")).map(s => s.status), ["reuse", "reuse", "reuse", "create"]);
		assert.equal(nextPlan.steps.find(s => s.key === "worker:sieve-worker-b")!.status, "reuse", "running workers are not reset by a new revision");
		assert.equal((await d.apply(next)).state, "completed");
		assert.deepEqual((await listSpaces(o.hosts.b, ctx)).filter(i => i.alias !== "default").map(i => i.alias), ["sieve-b", "sieve-b2"]);
		const retarget = example(); retarget.workers![0]!.runId = "r2";
		assert.equal((await d.plan(retarget)).steps.find(s => s.key === "worker:sieve-worker-b")!.status, "conflict", "no silent restart of running workers");
		const moved = example(); moved.spaces[2]!.host = "host-a"; moved.workers = [];
		assert.equal((await d.plan(moved)).steps.find(s => s.key === "space:sieve-b")!.status, "conflict", "Spaces do not move hosts");

		const exported = await d.export("prime-demo");
		assert.equal(exported.state, "completed"); assert.equal(exported.spaces["sieve-b"]!.host, "host-b");
		assert.deepEqual(exported.workers, [{ alias: "sieve-worker-b", count: 2 }]);
	} finally { await o.dispose(); }
});

for (const backend of BACKENDS) test(`${backend}: a refused Space blocks the job until a corrected config resumes it`, async () => {
	const o = await fixture(backend);
	try {
		await o.hosts.b.commit(async tx => { const info = await createSpace(tx, "sieve-b", Date.now()); c.setLimits(await spaceDoc(tx, info.spaceId, Date.now()), { maxEntries: 7 }); }, ctx);
		const d = o.make(); await d.bindHost("host-a", "id-a"); await d.bindHost("host-b", "id-b");
		const cfg = example(); cfg.spaces[2]!.limits = { maxEntries: 9 };
		const blocked = await d.apply(cfg);
		assert.equal(blocked.state, "blocked"); assert.match(blocked.steps["space:sieve-b"]!.error!, /reused only unchanged/);
		const fixed = example(); fixed.spaces[2]!.limits = { maxEntries: 7 };
		const resumed = await d.apply(fixed);
		assert.equal(resumed.state, "completed");
		assert.equal(resumed.steps["space:sieve-a"]!.status, "done");
		assert.deepEqual((await listSpaces(o.hosts.b, ctx)).filter(i => i.alias === "sieve-b").length, 1, "the existing Space is reused, not duplicated");
	} finally { await o.dispose(); }
});

for (const backend of BACKENDS) test(`${backend}: deployment admin commands run through the control-space supervisor`, async () => {
	const o = await fixture(backend);
	try {
		const supervisor = new Supervisor(o.hosts.a, ctx, { asyncCommands: deploymentCommands(o.make()) });
		const stop = await supervisor.start();
		try {
			await o.hosts.a.commit(async tx => c.write(await spaceDoc(tx, o.controlSpaceId, Date.now()), Date.now(), { type: "PeerKey", fields: { peerId: "p-admin", state: "active", roles: ["admin"] } }, null, c.FOREVER), ctx);
			const send = (commandId: string, kind: string, args: any) => o.hosts.a.commit(async tx => c.write(await spaceDoc(tx, o.controlSpaceId, Date.now()), Date.now(), { type: "Command", fields: { commandId, kind, args } }, null, 3_600_000, principalId({ peerId: "p-admin" })), ctx);
			const result = async (commandId: string) => { for (let i = 0; i < 400; i++) { const r = c.list((await snapshotSpace(o.hosts.a, o.controlSpaceId, ctx))!, Date.now(), { type: "Result", fields: { commandId } })[0]?.fields as any; if (r) return r; await new Promise(x => setTimeout(x, 25)); } throw new Error("no result " + commandId); };
			for (const [alias, hostId] of [["host-a", "id-a"], ["host-b", "id-b"]]) { await send(`bind-${alias}`, "bindHostAlias", { alias, hostId }); assert.equal((await result(`bind-${alias}`)).state, "completed"); }
			await send("plan-1", "planDeployment", { config: example() });
			assert.equal((await result("plan-1")).result.ready, true);
			await send("apply-1", "applyDeployment", { config: example() });
			assert.equal((await result("apply-1")).result.state, "completed");
			await send("bad", "applyDeployment", { config: { ...example(), schemaVersion: 2 } });
			assert.equal((await result("bad")).result.state, "blocked");
		} finally { await stop(); }
	} finally { await o.dispose(); }
});

test("bootstrap CLI --check validates offline and fails on secrets", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bootstrap-"));
	try {
		const run = (cfg: unknown) => { const f = join(dir, "d.json"); writeFileSync(f, JSON.stringify(cfg)); try { return { code: 0, out: JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/bootstrap-spaces.ts", "--check", "--config", f], { encoding: "utf8" })) }; } catch (e: any) { return { code: e.status as number, out: JSON.parse(e.stdout) }; } };
		const ok = run(example());
		assert.equal(ok.code, 0); assert.equal(ok.out.valid, true); assert.equal(ok.out.configHash, validateDeployment(example()).configHash);
		const bad = run({ ...example(), credentials: { source: "host-secret-store", password: "x" } });
		assert.equal(bad.code, 1); assert.match(bad.out.errors.join(" "), /password: secret fields/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const backend of BACKENDS) test(`${backend}: the bootstrap CLI binds, plans and applies as a paired admin through the real Gate`, async (tc) => {
	const o = await fixture(backend);
	const dir = mkdtempSync(join(tmpdir(), "pi-bootstrap-e2e-"));
	try {
		const peers = [{ id: "p-admin", name: "p-admin", ip: "127.0.0.3", connected: true, groups: [{ id: "g-e", name: "space-enroll" }] }];
		const server = http.createServer((_q, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(peers)); });
		await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
		tc.after(() => { server.closeAllConnections(); server.close(); });
		let offset = 0; const now = () => Date.now() + offset;
		const h = o.hosts.a, keys = new SpaceKeyDirectory(h, ctx, now), identity = new GateIdentity();
		const service = new SpaceService({ host: h, ctx, identity, policy: DEFAULT_POLICY, hostId: "host-1", now });
		const front = new EnrollmentService(new ControlAccess(new ProvingService(service, { gateHostId: "host-1", keys, now }), { identity, host: h, ctx }), { host: h, ctx, now });
		const gate = await startGate(front, { listen: { host: "127.0.0.1", port: 0 }, directory: new NetbirdDirectory({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "t", now }), keys, revalidateMs: 0, now });
		tc.after(() => gate.close());
		const stop = await new Supervisor(h, ctx, { now, asyncCommands: deploymentCommands(o.make()) }).start();
		tc.after(() => stop());
		const port = (gate.address() as AddressInfo).port, keyFile = join(dir, "admin.key"), signer = provisionFileSigner(keyFile);
		const token = newEnrollToken();
		await bootstrapEnroll(h, ctx, { tokenHash: hashToken(token), allowedPeerId: "p-admin", now });
		const t = socketTransport({ host: "127.0.0.1", port }, { localAddress: "127.0.0.3" });
		try { assert.equal((await new RemoteSpace(t, { space: CONTROL_SPACE, signer, ownPeerId: "p-admin", expectedGateHostId: "host-1", attempts: 2 }).enroll(token)).keyId, signer.keyId); } finally { t.close(); }
		peers[0]!.groups = [{ id: "g-a", name: "space-admin" }];
		offset += 61_000; // the directory cache expires; the admin group applies
		const cfg = join(dir, "d.json"); writeFileSync(cfg, JSON.stringify(example()));
		const cli = async (...args: string[]) => {
			try { const r = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/bootstrap-spaces.ts", ...args, "--coordinator", `127.0.0.1:${port}`, "--gate-host", "host-1", "--peer", "p-admin", "--key", keyFile, "--local-address", "127.0.0.3", "--wait-ms", "20000"], { encoding: "utf8" }); return { code: 0, out: JSON.parse(r.stdout) }; }
			catch (e: any) { return { code: e.code as number, out: e.stdout ? JSON.parse(e.stdout) : e.stderr }; }
		};
		const blocked = await cli("--plan", "--config", cfg);
		assert.equal(blocked.code, 2); assert.equal(blocked.out.result.ready, false);
		assert.equal((await cli("--bind", "host-a=id-a")).code, 0);
		assert.equal((await cli("--bind", "host-b=id-b")).code, 0);
		const plan = await cli("--plan", "--config", cfg);
		assert.equal(plan.code, 0, JSON.stringify(plan.out)); assert.equal(plan.out.result.ready, true);
		const applied = await cli("--apply", "--config", cfg);
		assert.equal(applied.code, 0, JSON.stringify(applied.out)); assert.equal(applied.out.result.state, "completed");
		assert.ok((await listSpaces(o.hosts.b, ctx)).some(i => i.alias === "sieve-b"));
		assert.equal((await cli("--export", "--config", cfg)).out.result.state, "completed");
	} finally { rmSync(dir, { recursive: true, force: true }); await o.dispose(); }
});
