// `npm run testbed:federation -- change [C-M]` (`C`: the runtime of both control hosts, `M`: of the Member): the control host on a primary/sync main store with a sync standby, killed, and the authority moved to the
// promoted standby by a change the recovery admin signs (src/control-host-change.ts). The Member follows the recorded change and comes back on the new
// endpoint; a client's grants and Jobs are held across it. Without the Root: its journal on the control host is not part of this change.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import { OwnSyncStore, PrimarySyncJournal, SqliteRecoveryRegister, bootstrapPrimarySync, listSpaces, loadFileSigner, provisionFileSigner } from "../../../src/index.ts";
import { BACKGROUND_CONTEXT as ctx } from "../../../src/context.ts";
import { openSqliteHost } from "../../../src/store/sqlite.ts";
import { provision } from "./provision.ts";
import { CONTROL_B, IP, PORT, RPORT, peer } from "./net.ts";
import { certify, harness } from "./replica.ts";
import { createHash, X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const container = (service: string) => `phi-federation-${service}-1`, sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8" });

async function provisionChange(dir: string) {
	certify(dir, ["control-b", "fencing"]);
	const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
	const write = (name: string, v: unknown) => writeFileSync(join(dir, name), JSON.stringify(v), { mode: 0o600 });
	const print = (name: string) => createHash("sha256").update(new X509Certificate(readFileSync(join(dir, `${name}.crt`))).raw).digest("hex");
	write("register-peers.json", { ...read("register-peers.json"), [print("control-b")]: {} });
	write("peers.json", [...read("peers.json"), peer("control-b-peer", CONTROL_B, ["space-hosts"])]);
	const b = provisionFileSigner(join(dir, "control-b-key.json")), admin = provisionFileSigner(join(dir, "admin-key.json")), a = loadFileSigner(join(dir, "control-key.json"));
	provisionFileSigner(join(dir, "stranger-key.json"));
	const recoveryAdmin = { algorithm: admin.algorithm, publicKey: admin.publicKey }, cc = read("control.config.json"), cs = cc.controlSpaceId;
	// the main store goes under primary/sync, single at first; every Space in it follows the control Space's replica configuration
	const store = await openSqliteHost(join(dir, "control.sqlite")), spaces = await listSpaces(store, ctx);
	await store.close(ctx);
	const incarnation = spaces.find((i) => i.spaceId === cs)!.incarnation, siblings = spaces.map((i) => i.spaceId).filter((id) => id !== cs);
	const genesis = { spaceId: cs, authorityId: "authority", primaryEpoch: 1, replicaConfigVersion: 1, primaryReplica: "control-host", standbyReplica: null, durability: "single" };
	const journal = new PrimarySyncJournal(join(dir, "main-control", "journal.sqlite"), genesis as never, { self: "control-host" }), raw = new OwnSyncStore(join(dir, "control.sqlite"));
	await bootstrapPrimarySync(raw, journal, ctx);
	await raw.close(ctx); journal.close();
	const permits = Object.fromEntries(spaces.map((i) => [i.spaceId, { state: "active", authorityId: "authority", dataIncarnation: i.incarnation, role: "primary", primaryEpoch: 1, replicaConfigVersion: 1, durability: "single", transitionId: "setup" }]));
	const external = new SqliteRecoveryRegister(join(dir, "external.sqlite")), installed = new SqliteRecoveryRegister(join(dir, "installed-control.sqlite"));
	const boot = (await external.get<Record<string, never>>("boot:control-host"))!;
	await external.compareAndSet("boot:control-host", boot.version, { ...boot.value, spaces: permits } as never);
	await external.compareAndSet("boot:control-host-b", null, { hostId: "control-host-b", state: "active", spaces: {} } as never);
	for (const [id, p] of Object.entries(permits)) { const key = `installed:control-host:${id}`, cur = await installed.get(key); await installed.compareAndSet(key, cur?.version ?? null, p as never); }
	external.close(); installed.close();
	const pin = (hostId: string, key: { algorithm: string; publicKey: string }, ip: string) => ({ hostId, algorithm: key.algorithm, publicKey: key.publicKey, ip });
	const main = (name: string, other: ReturnType<typeof pin>) => ({ dir: `/fed/main-${name}`, genesis, port: RPORT.sync, incarnation, siblings, peers: [other] });
	const bindings = { ...cc.capabilities.hostBindings, "control-b-peer": "control-host-b" };
	write("control.config.json", { ...cc, root: undefined, recoveryAdmin, capabilities: { hostBindings: bindings }, mainSync: main("control", pin("control-host-b", b, CONTROL_B)) });
	write("control-b.config.json", { ...cc, root: undefined, recoveryAdmin, capabilities: { hostBindings: bindings }, hostId: "control-host-b", peerId: "control-b-peer", controlHostId: "control-host-b", listen: { host: CONTROL_B, port: PORT.control }, keyFile: "/fed/control-b-key.json",
		installedRegisterFile: "/fed/installed-control-b.sqlite", registerTls: { ...cc.registerTls, certFile: "/fed/control-b.crt", keyFile: "/fed/control-b.key" }, control: { address: { host: CONTROL_B, port: PORT.control }, algorithm: b.algorithm, publicKey: b.publicKey },
		mainSync: main("control-b", pin("control-host", a, IP.control)) });
	write("member.config.json", { ...read("member.config.json"), recoveryAdmin });
}

export async function changeScenario() {
	const { dir, env, compose, drive, tool, started, docker, runs } = harness("change", "change-driver.ts");
	const remote = { register: { caFile: "/fed/ca.crt", certFile: "/fed/operator.crt", keyFile: "/fed/operator.key", host: IP.register, port: PORT.register }, fencing: { caFile: "/fed/ca.crt", certFile: "/fed/operator.crt", keyFile: "/fed/operator.key", host: "172.30.7.1", port: RPORT.fencing } };
	let fencing: ChildProcess | undefined;
	try {
		await provision(dir);
		await provisionChange(dir);
		compose("up", "-d", "--no-build", "register", "management", "client");
		fencing = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ROOT, "test/testbed/local-federation/fencing-service.ts"), dir], { stdio: ["ignore", "pipe", "inherit"] });
		await new Promise((resolve, reject) => { fencing!.stdout!.once("data", resolve); fencing!.once("exit", reject); });
		// control-b listens as an empty replica; control-a takes it as its sync standby, then serves
		compose("up", "-d", "--no-build", "--no-deps", "control-b"); started("control-b", '"mainReplicaListening":true');
		const stood = tool("control-a", { op: "set-standby", tid: "standby-b", target: "control-host-b", ...remote }, "control");
		assert.equal(stood.config.standbyReplica, "control-host-b"); assert.equal(stood.config.durability, "sync");
		compose("up", "-d", "--no-build", "--no-deps", "control-a"); started("control-a", '"ready":true');
		compose("up", "-d", "--no-build", "--no-deps", "member"); started("member", "member ready");
		runs(container("control-a"), env.CONTROL_A_IMPL); runs(container("control-b"), env.CONTROL_B_IMPL); runs(container("member"), env.MEMBER_IMPL);
		assert.equal(drive("job", "control-host", "first").write, "answered");
		if (process.env.FED_PASS === "1") { console.log("change pass 1 passed"); return; }
		drive("hold", "control-host");
		// the control host killed: what is left to a client
		docker("kill", "-s", "KILL", container("control-a"));
		const gap = drive("gap", "control-host");
		assert.ok(gap.held.refused, "without its control host the Member answers no call, not even with a grant taken before");
		assert.ok(gap.fresh.refused, "no new grant without a control host");
		// a change is not recorded before the promotion shows in the register
		assert.match(drive("record", "control-host-b").recorded.message, /not the active primary/, "the register refuses a change before the promotion");
		const stale = tool("control-a", { op: "status" }, "control");
		// control-b promoted behind the fence, then single without its fenced standby
		docker("stop", container("control-b"));
		const promoted = tool("control-b", { op: "promote", tid: "promote-control", epoch: 1, version: 2, ...remote }, "control-b");
		assert.equal(promoted.verified, true); assert.equal(promoted.config.primaryReplica, "control-host-b"); assert.equal(promoted.config.primaryEpoch, 2);
		const single = tool("control-b", { op: "degrade", tid: "degrade-control", epoch: 2, version: 3, ...remote }, "control-b");
		assert.equal(single.config.durability, "single"); assert.equal(single.config.primaryEpoch, 3);
		// a change signed by a key the hosts do not pin is refused; the recovery admin's is recorded
		assert.match(drive("record", "control-host-b", "stranger").recorded.message, /invalid recovery admin signature/, "an unpinned signature is refused");
		assert.equal(drive("record", "control-host-b").recorded, "control-host-b");
		docker("start", container("control-b")); started("control-b", '"ready":true');
		// the Member follows the recorded change, restarts and works against the new control host
		started("member", "controlHostChanged");
		assert.equal(drive("installed", "member").follows, "control-host-b");
		started("member", "member ready", 90_000, 2); runs(container("member"), env.MEMBER_IMPL);
		const after = drive("job", "control-host-b", "second");
		assert.equal(after.write, "answered"); assert.deepEqual(after.jobs, ["first", "second"]);
		const old = drive("gap", "control-host");
		assert.equal(old.held.refused, "PermissionError", "a grant of the old control host's key is refused once the Member follows");
		assert.ok(old.fresh.refused, "the old control host grants nothing");
		// the old control host started by hand is refused
		docker("start", container("control-a"));
		assert.notEqual(sh("timeout", ["60", "docker", "wait", container("control-a")]).trim(), "0", "the fenced control host does not boot");
		assert.ok(sh("sh", ["-c", `docker logs ${container("control-a")} 2>&1`]).split("\n").some((l) => l.startsWith("BootBlocked")), "it is refused by a boot check");
		// what the stores hold: the promoted history carries everything the old primary applied
		docker("stop", container("control-b"));
		const now = tool("control-b", { op: "status", revision: stale.applied }, "control-b");
		assert.equal(now.atRevision, stale.appliedHash, "the old primary's applied history is a prefix of the promoted one");
		console.log("change scenario passed");
	} catch (e) {
		console.error((e as { stderr?: string }).stderr ?? e);
		for (const s of ["control-a", "control-b", "member"]) console.error(compose("logs", "--tail", "15", s));
		process.exitCode = 1;
	} finally {
		fencing?.kill();
		compose("down", "-v", "--remove-orphans");
		if (process.env.FED_KEEP) console.log(`kept ${dir}`); else rmSync(dir, { recursive: true, force: true });
	}
}
