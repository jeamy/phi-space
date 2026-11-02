// `npm run testbed:federation -- control-restore`: the control Space restored from its backup onto another host under a new authority, while the
// control host is lost. The old control host is fenced; the target and the Member are stopped and restart-locked by the fencing service and run their
// recovery-only services, quiesced by what the ssh fence status says. The target imports the backup, the Member installs the new authority, the first
// admin key is authorized, and after the old grants have expired both come back on it. A client is answered under it; a grant of the old one is refused.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { SqliteRecoveryRegister, createSpace, listSpaces, provisionFileSigner, spaceDoc } from "../../../src/index.ts";
import { createHash, X509Certificate } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "../../../src/context.ts";
import { openSqliteHost } from "../../../src/store/sqlite.ts";
import { FederationRouting } from "../../../src/federation-policy.ts";
import { provision } from "./provision.ts";
import { CONTROL_B, FENCE_SSH, IP, PORT, peer } from "./net.ts";
import { certify, harness } from "./replica.ts";
import { backup, provisionSsh } from "./restore.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const container = (service: string) => `phi-federation-${service}-1`;

async function provisionControlRestore(dir: string) {
	certify(dir, ["fencing", "control-b"]);
	const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
	const write = (name: string, v: unknown) => writeFileSync(join(dir, name), JSON.stringify(v), { mode: 0o600 });
	const print = (name: string) => createHash("sha256").update(new X509Certificate(readFileSync(join(dir, `${name}.crt`))).raw).digest("hex");
	write("register-peers.json", { ...read("register-peers.json"), [print("control-b")]: {} });
	// the client's peer is also an admin's: the first admin after the restore works from it
	write("peers.json", [...read("peers.json").map((p: { id: string }) => p.id === "user" ? peer("user", IP.client, ["space-hosts", "space-admin"]) : p), peer("control-b-peer", CONTROL_B, ["space-hosts"])]);
	const operator = provisionFileSigner(join(dir, "operator-key.json")), successor = provisionFileSigner(join(dir, "control-key-2.json"));
	for (const name of ["admin-key", "member-key-2", "user-key-2"]) provisionFileSigner(join(dir, `${name}.json`));
	const control = read("control.config.json"), state = read("state.json"), now = Date.now(), register = { caFile: "/fed/ca.crt", certFile: "/fed/operator.crt", keyFile: "/fed/operator.key", host: IP.register, port: PORT.register };
	const store = await openSqliteHost(join(dir, "control.sqlite")), incarnation = (await listSpaces(store, ctx)).find((i) => i.spaceId === control.controlSpaceId)!.incarnation;
	await store.close(ctx);
	// the target holds the control Space under the same identity, admitted like any Space of its own
	const target = await openSqliteHost(join(dir, "control-b.sqlite"));
	await target.commit((tx) => createSpace(tx, "control", now, { spaceId: control.controlSpaceId, incarnation }).then(() => {}), ctx);
	await target.commit((tx) => spaceDoc(tx, undefined, now).then(() => {}), ctx);
	const spaces = Object.fromEntries((await listSpaces(target, ctx)).map((i) => [i.spaceId, { state: "active", authorityId: "authority", dataIncarnation: i.incarnation, role: "local", transitionId: "t1" }]));
	await target.close(ctx);
	// a provisioned authority record carries its (empty) lineage of successor decisions
	const external = new SqliteRecoveryRegister(join(dir, "external.sqlite")), authority = (await external.get<Record<string, never>>(`authority:${control.controlSpaceId}`))!;
	await external.compareAndSet(`authority:${control.controlSpaceId}`, authority.version, { ...authority.value, lineage: {} } as never);
	await external.compareAndSet("boot:control-host-b", null, { hostId: "control-host-b", state: "active", spaces } as never);
	external.close();
	// each host knows the authority it was provisioned under, which a successor decision replaces
	for (const host of ["control-b", "member"]) {
		const installed = new SqliteRecoveryRegister(join(dir, `installed-${host}.sqlite`)), key = `installed-authority:${control.controlSpaceId}`;
		if (!await installed.get(key)) await installed.compareAndSet(key, null, { authorityId: "authority" } as never);
		installed.close();
	}
	write("control.config.json", { ...control, root: undefined });
	write("control-b.config.json", { ...control, root: undefined, hostId: "control-host-b", peerId: "control-b-peer", controlHostId: "control-host-b", listen: { host: CONTROL_B, port: PORT.control }, keyFile: "/fed/control-key-2.json", installedRegisterFile: "/fed/installed-control-b.sqlite",
		registerTls: { ...control.registerTls, certFile: "/fed/control-b.crt", keyFile: "/fed/control-b.key" }, control: { address: { host: CONTROL_B, port: PORT.control }, algorithm: successor.algorithm, publicKey: successor.publicKey },
		capabilities: { hostBindings: { ...control.capabilities.hostBindings, "control-b-peer": "control-host-b" } } });
	write("control-b.recovery.json", { hostId: "control-host-b", path: "/fed/recovery-only-control.sock", installedRegisterFile: "/fed/installed-control-b.sqlite", operatorKeyFile: "/fed/operator-key.json", supervisorKeyFile: "/fed/control-key-2.json", snapshotDirectory: "/fed/snapshots", fenceTargets: { "control-host": `control-host@${FENCE_SSH}` }, registerTls: register, fenceStatus: `control-host-b@${FENCE_SSH}` });
	write("member.recovery.json", { hostId: "data-host", path: "/fed/recovery-only-member.sock", installedRegisterFile: "/fed/installed-member.sqlite", operator: { algorithm: operator.algorithm, publicKey: operator.publicKey }, registerTls: register, fenceStatus: `data-host@${FENCE_SSH}` });
	write("fenced.json", { "control-host": "control" });
	write("state.json", { ...state, controlIncarnation: incarnation });
	provisionSsh(dir);
}

/** The Member `a` in the new control host's routing table, as provision.ts writes it, under the authority the restore installed. */
async function registerMember(dir: string) {
	const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")), installed = new SqliteRecoveryRegister(join(dir, "installed-control-b.sqlite"));
	const authorityId = (await installed.get<{ authorityId: string }>(`installed-authority:${state.controlSpace}`))!.value.authorityId;
	installed.close();
	const member = await openSqliteHost(join(dir, "member.sqlite")), jobs = (await listSpaces(member, ctx)).find((i) => i.spaceId === state.jobs)!;
	await member.close(ctx);
	const host = await openSqliteHost(join(dir, "control-b.sqlite"));
	await host.commit(async (tx) => { const d = await tx.doc(FederationRouting, state.controlSpace, null); d.members = { a: { id: "a", state: "active", target: { hostId: "data-host", spaceId: jobs.spaceId, authorityId, dataIncarnation: jobs.incarnation, primaryEpoch: 1 } } } as never; }, ctx);
	await host.close(ctx);
}

export async function controlRestoreScenario() {
	const { dir, compose, drive, started, docker } = harness("restore", "change-driver.ts");
	const recovery = (service: string, name: string) => compose("run", "-d", "--no-deps", "--name", `phi-federation-recovery-${name}-1`, "-v", `${dir}/passwd:/etc/passwd:ro`, service, "node", "--experimental-strip-types", "--no-warnings", "test/testbed/local-federation/replica-host.ts", "recovery", name);
	let fencing: ChildProcess | undefined;
	try {
		await provision(dir);
		await provisionControlRestore(dir);
		compose("up", "-d", "--no-build", "register", "management", "control", "member", "client", "fence-ssh");
		fencing = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ROOT, "test/testbed/local-federation/fencing-service.ts"), dir], { stdio: ["ignore", "pipe", "inherit"] });
		await new Promise((resolve, reject) => { fencing!.stdout!.once("data", resolve); fencing!.once("exit", reject); });
		started("control", "control ready"); started("member", "member ready");
		assert.equal(drive("job", "control-host", "first").write, "answered");
		await backup(dir, JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).controlSpace, "control", "control.json");
		drive("hold", "control-host");
		// the control host lost and fenced; the target and the Member stopped and locked for their part of the transition
		docker("kill", "-s", "KILL", container("control"));
		compose("create", "--no-build", "control-b");
		for (const host of ["control-host", "control-host-b", "data-host"]) assert.equal(drive("fence", host).fence, true);
		recovery("control-b", "control-b"); recovery("member", "member");
		started("recovery-control-b", '"recoveryReady":true'); started("recovery-member", '"recoveryReady":true');
		const imported = drive("restore-control", "control-host-b");
		assert.equal(imported.states.at(-1), "waiting");
		assert.equal(drive("install", "data-host").installed, true);
		const authorized = drive("authorize", "control-host-b").authorized;
		assert.deepEqual(authorized.slice(0, 3), [true, true, true]);
		assert.equal(authorized[3].refused, "RegisterConflict", "an old key is not revived through a restore");
		assert.equal(drive("finish-restore", "control-host-b").states.at(-1), "completed");
		assert.deepEqual(drive("authority", "control-host-b").authority, { renamed: true, hostId: "control-host-b", state: "active" });
		docker("rm", "-f", "phi-federation-recovery-control-b-1", "phi-federation-recovery-member-1");
		// the operator points the Member at the new control host; the control host comes back from its fence
		const member = JSON.parse(readFileSync(join(dir, "member.config.json"), "utf8")), b = JSON.parse(readFileSync(join(dir, "control-b.config.json"), "utf8"));
		writeFileSync(join(dir, "member.config.json"), JSON.stringify({ ...member, controlHostId: "control-host-b", control: b.control, keyFile: "/fed/member-key-2.json" }), { mode: 0o600 });
		assert.equal(drive("release", "control-host-b").release, true);
		started("control-b", "ready");
		// the routing table is not part of the control Space's backup: on the new host no Member is registered, and no policy can name one
		assert.deepEqual(drive("policy", "control-host-b", "1").policy, { state: "failed", error: "default member is not registered" });
		// a configured control host takes no addMember command, so the operator registers the Member in its store, as a provisioning does
		docker("stop", container("control-b"));
		await registerMember(dir);
		docker("start", container("control-b")); started("control-b", "ready", 90_000, 2);
		assert.deepEqual(drive("policy", "control-host-b", "1", "registered").policy, { state: "completed", error: null }, "the first admin sets the policy under the new authority");
		assert.equal(drive("release", "data-host").release, true);
		started("member", "member ready", 90_000, 2);
		const after = drive("job", "control-host-b", "second", "user-key-2");
		assert.equal(after.write, "answered"); assert.deepEqual(after.jobs, ["first", "second"]);
		assert.ok(drive("gap", "control-host-b").held.refused, "a grant of the old authority is refused");
		// the old control host started by hand is refused
		docker("start", container("control"));
		assert.notEqual(execFileSync("timeout", ["60", "docker", "wait", container("control")], { encoding: "utf8" }).trim(), "0", "the old control host does not boot");
		console.log("control restore scenario passed");
	} catch (e) {
		console.error((e as { stderr?: string }).stderr ?? e);
		for (const s of ["control-b", "member", "fence-ssh"]) console.error(compose("logs", "--tail", "15", s));
		for (const name of ["recovery-control-b", "recovery-member"]) { try { console.error(execFileSync("sh", ["-c", `docker logs --tail 15 phi-federation-${name}-1 2>&1`], { encoding: "utf8" })); } catch { /* not started */ } }
		process.exitCode = 1;
	} finally {
		fencing?.kill();
		// FED_HOLD keeps the containers and FED_DIR of a run for a look; `docker compose -p phi-federation down -v` ends it
		if (process.env.FED_HOLD) { console.log(`held ${dir}`); return; }
		try { docker("rm", "-f", "phi-federation-recovery-control-b-1", "phi-federation-recovery-member-1"); } catch { /* gone */ }
		compose("down", "-v", "--remove-orphans");
		if (process.env.FED_KEEP) console.log(`kept ${dir}`); else rmSync(dir, { recursive: true, force: true });
	}
}
