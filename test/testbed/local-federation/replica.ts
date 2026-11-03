// `npm run testbed:federation -- replica`: a primary/sync Space on two hosts of the configured runtime, with the primary killed. A client's writes through
// the gate, the standby cut off, a write nobody confirmed, promotion and degradeToSingle behind the container fencing adapter, the old primary back through
// quarantine, and both stores compared. The fencing service runs on this machine, outside the fenced containers; of systemd only the unit is stood in for (fencing-service.ts).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { FOREVER, SqliteRecoveryRegister, core, listSpaces, provisionFileSigner, spaceDoc } from "../../../src/index.ts";
import { BACKGROUND_CONTEXT as ctx } from "../../../src/context.ts";
import { openSqliteHost } from "../../../src/store/sqlite.ts";
import { provision } from "./provision.ts";
import { GATEWAY, IP, REPLICA, RPORT, peer } from "./net.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url)), COMPOSE = join(ROOT, "test/testbed/local-federation/compose.yml"), NET = "phi-federation_fed";
const sh = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) => execFileSync(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const A = "replica-a", B = "replica-b", SPACE = "sp-0d7f3a52-6c1e-4b8a-9f21-3e5a7c9b1d04", INCARNATION = "1ed6e700";
const container = (host: string) => `phi-federation-${host}-1`;

/** Client certificates of the CA that `provision` made, and the fencing service's server certificate on the bridge address. */
export function certify(dir: string, names: string[]) {
	const openssl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
	for (const name of names) {
		openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`]);
		writeFileSync(join(dir, `${name}.ext`), name === "fencing" ? `subjectAltName=IP:${GATEWAY}\nextendedKeyUsage=serverAuth\n` : "extendedKeyUsage=clientAuth\n");
		openssl(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "2", "-extfile", `${name}.ext`]);
		chmodSync(join(dir, `${name}.key`), 0o600); chmodSync(join(dir, `${name}.crt`), 0o600);
	}
}

export async function provisionReplicas(dir: string, mode: "sync" | "entry") {
	certify(dir, [A, B, "fencing"]);
	const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
	const write = (name: string, v: unknown) => writeFileSync(join(dir, name), JSON.stringify(v), { mode: 0o600 });
	const print = (name: string) => createHash("sha256").update(new X509Certificate(readFileSync(join(dir, `${name}.crt`))).raw).digest("hex");
	write("register-peers.json", { ...read("register-peers.json"), [print(A)]: {}, [print(B)]: {} });
	write("peers.json", [...read("peers.json"), peer("replica-a-peer", REPLICA[A], ["space-hosts"]), peer("replica-b-peer", REPLICA[B], ["space-hosts"])]);
	const keys = { [A]: provisionFileSigner(join(dir, `${A}-key.json`)), [B]: provisionFileSigner(join(dir, `${B}-key.json`)) }, now = Date.now(), base = read("member.config.json"), { controlSpaceId } = base;
	const control = await openSqliteHost(join(dir, "control.sqlite"));
	await control.commit(async (tx) => {
		const s = await spaceDoc(tx, controlSpaceId, now);
		for (const [host, k] of Object.entries(keys)) core.write(s, now, { type: "PeerKey", fields: { peerId: `${host}-peer`, keyId: k.keyId, principal: `${host}-peer`, algorithm: k.algorithm, publicKey: k.publicKey, roles: ["host"], scope: ["*"], state: "active" } }, null, FOREVER);
	}, ctx);
	await control.close(ctx);
	const genesis = { spaceId: SPACE, authorityId: "authority", primaryEpoch: 1, replicaConfigVersion: 1, primaryReplica: A, standbyReplica: B, durability: "sync" };
	const external = new SqliteRecoveryRegister(join(dir, "external.sqlite"));
	for (const host of [A, B]) {
		const store = await openSqliteHost(join(dir, `${host}.sqlite`));
		await store.commit((tx) => spaceDoc(tx, undefined, now).then(() => {}), ctx);
		const spaces: Record<string, unknown> = mode === "sync" ? { [SPACE]: { state: "active", authorityId: "authority", dataIncarnation: INCARNATION, role: host === A ? "primary" : "standby", primaryEpoch: 1, replicaConfigVersion: 1, durability: "sync", transitionId: "setup" } } : {};
		for (const i of await listSpaces(store, ctx)) spaces[i.spaceId] = { state: "active", authorityId: "authority", dataIncarnation: i.incarnation, role: "local", transitionId: "t1" };
		await store.close(ctx);
		await external.compareAndSet(`boot:${host}`, null, { hostId: host, state: "active", spaces } as never);
		const other = host === A ? B : A, identity = { caFile: "/fed/ca.crt", certFile: `/fed/${host}.crt`, keyFile: `/fed/${host}.key` };
		const syncSpaces = [{ alias: "ledger", spaceId: SPACE, incarnation: INCARNATION, dir: `/fed/sync-${host}`, genesis, port: RPORT.sync, peers: [{ hostId: other, algorithm: keys[other as typeof A].algorithm, publicKey: keys[other as typeof A].publicKey, ip: REPLICA[other as typeof A] }] }];
		// lww and set types of the default Space, each host a replica that pulls the other's stream over its gate
		const entryReplication = { space: "default", spaceId: "logical-board", replicaId: host, incarnation: `e-${host}`, members: [A, B].map((r) => ({ replicaId: r, incarnation: `e-${r}` })), rules: [{ type: "Sensor", variant: "lww", keyFields: ["sensorId"] }, { type: "Tag", variant: "set" }], pollMs: 500,
			peers: [{ replicaId: other, hostId: other, peerId: `${other}-peer`, address: { host: REPLICA[other as typeof A], port: RPORT.gate } }] };
		write(`${host}.config.json`, { ...base, membership: undefined, capabilities: undefined, runGates: undefined, spaceLifecycle: undefined, hostId: host, peerId: `${host}-peer`, listen: { host: REPLICA[host as typeof A], port: RPORT.gate }, keyFile: `/fed/${host}-key.json`, installedRegisterFile: `/fed/installed-${host}.sqlite`, registerTls: { ...base.registerTls, ...identity },
			...(mode === "sync" ? { syncSpaces } : { entryReplication }) });
	}
	external.close();
}

/** The containers of a compose profile and what drives them: the client's steps, the hosts' tool, their log lines. */
export function harness(profile = "replica", driver = "replica-driver.ts") {
	const dir = mkdtempSync(join(tmpdir(), "phi-fed-")), env = { FED_DIR: dir, FED_UID: String(process.getuid!()), FED_GID: String(process.getgid!()), MEMBER_IMPL: process.env.MEMBER_IMPL ?? "ts", CONTROL_IMPL: process.env.CONTROL_IMPL ?? "ts", DATA_B_IMPL: process.env.DATA_B_IMPL ?? "ts", CONTROL_B_IMPL: process.env.CONTROL_B_IMPL ?? "ts", CONTROL_A_IMPL: process.env.CONTROL_A_IMPL ?? "ts", REPLICA_A_IMPL: process.env.REPLICA_A_IMPL ?? "ts", REPLICA_B_IMPL: process.env.REPLICA_B_IMPL ?? "ts" };
	const compose = (...a: string[]) => sh("docker", ["compose", "-f", COMPOSE, "--profile", profile, ...a], env);
	const say = (name: string, v: unknown) => console.log(`  ${name} ${JSON.stringify(v)}`);
	const drive = (...a: string[]) => { const out = JSON.parse(compose("exec", "-T", "client", "node", "--experimental-strip-types", "--no-warnings", `test/testbed/local-federation/${driver}`, ...a).trim().split("\n").at(-1)!); say(a.slice(0, 2).join(" "), out); return out; };
	const tool = (host: string, q: Record<string, unknown>, name = host) => { const out = JSON.parse(compose("run", "--rm", "-T", "--no-deps", host, "node", "--experimental-strip-types", "--no-warnings", "test/testbed/local-federation/replica-host.ts", "tool", name, JSON.stringify(q)).trim().split("\n").at(-1)!); say(`tool ${host} ${q.op}`, out); return out; };
	const started = (host: string, text: string, ms = 90_000, times = 1) => { const end = Date.now() + ms; for (;;) { const r = execFileSync("docker", ["logs", container(host)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); if (r.split("\n").filter((l) => l.includes(text)).length >= times) return; if (Date.now() > end) throw new Error(`${host}: no ${text}`); execFileSync("sleep", ["0.5"]); } };
	const docker = (...a: string[]) => sh("docker", a);
	// the scenarios answer alike on either runtime: a container is held to run the one it was asked for
	const runs = (name: string, impl: string) => assert.equal(execFileSync("docker", ["top", name], { encoding: "utf8" }).includes("phi-space-server"), impl === "rust", `${name} runs on ${impl}`);
	return { dir, env, compose, say, drive, tool, started, docker, runs };
}

export async function replicaScenario() {
	const { dir, env, compose, say, drive, tool, started, docker } = harness();
	let fencing: ChildProcess | undefined;
	try {
		await provision(dir);
		await provisionReplicas(dir, "sync");
		const remote = { register: { caFile: "/fed/ca.crt", certFile: "/fed/operator.crt", keyFile: "/fed/operator.key", host: IP.register, port: 7430 }, fencing: { caFile: "/fed/ca.crt", certFile: "/fed/operator.crt", keyFile: "/fed/operator.key", host: GATEWAY, port: RPORT.fencing } };
		compose("up", "-d", "--no-build", "register", "management", "control", "client");
		fencing = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ROOT, "test/testbed/local-federation/fencing-service.ts"), dir], { stdio: ["ignore", "pipe", "inherit"] });
		await new Promise((resolve, reject) => { fencing!.stdout!.once("data", resolve); fencing!.once("exit", reject); });
		compose("up", "-d", "--no-build", "--no-deps", B);
		started(B, '"ready":true');
		compose("up", "-d", "--no-build", "--no-deps", A);
		started(A, '"ready":true');

		// five writes the standby confirmed; then, on the same session, the standby cut off: the answer must not claim the write
		const holding = spawn("docker", ["compose", "-f", COMPOSE, "--profile", "replica", "exec", "-T", "client", "node", "--experimental-strip-types", "--no-warnings", "test/testbed/local-federation/replica-driver.ts", "hold", A, "before", "5"], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
		const lines: string[] = [];
		const held = new Promise<string[]>((resolve) => { holding.stdout.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean))); holding.on("exit", () => resolve(lines)); });
		while (!lines.some((l) => l.includes('"holding"'))) await new Promise((r) => setTimeout(r, 200));
		sh("docker", ["network", "disconnect", NET, container(B)]);
		writeFileSync(join(dir, "go"), "");
		const hold = JSON.parse((await held).at(-1)!);
		say("hold replica-a", hold);
		assert.deepEqual(hold.writes.slice(0, 5), Array(5).fill("answered"));
		assert.equal(hold.writes[5].refused, "CommitSealedPending", "a write nobody confirmed is answered with an unknown outcome, not as written");
		// the primary killed, and it stays down
		docker("kill", "-s", "KILL", container(A));
		assert.equal(docker("inspect", "-f", "{{.State.Running}}", container(A)).trim(), "false");
		const forked = tool(A, { op: "status" });
		assert.equal(forked.head.revision, forked.applied + 1, "the old primary keeps a sealed candidate");
		assert.ok(/\\"label\\":\\"fork\\"/.test(forked.candidate), "the candidate is the client's write");
		// the standby comes back, stops serving, and is promoted behind the fence
		sh("docker", ["network", "connect", "--ip", REPLICA[B], NET, container(B)]);
		docker("stop", container(B));
		const promoted = tool(B, { op: "promote", tid: "promote-1", epoch: 1, version: 1, ...remote });
		assert.equal(promoted.verified, true);
		assert.equal(promoted.config.primaryReplica, B); assert.equal(promoted.config.primaryEpoch, 2);
		assert.equal(docker("inspect", "-f", "{{.HostConfig.RestartPolicy.Name}}", container(A)).trim(), "no");
		// an operator starts the fenced host anyway: it refuses to boot, and the client is not served
		docker("start", container(A));
		assert.notEqual(sh("timeout", ["60", "docker", "wait", container(A)]).trim(), "0", "a fenced host does not boot");
		const refusedBoot = execFileSync("sh", ["-c", `docker logs ${container(A)} 2>&1`], { encoding: "utf8" }).split("\n").filter((l) => l.startsWith("BootBlocked")).at(-1);
		say("fenced start", refusedBoot);
		assert.ok(refusedBoot, "the fenced host is refused by a boot check, not by a crash");
		assert.ok(drive("gone", A).gone.refused, "and the client is not served");
		// the promoted host serves; without a standby a write stays sealed, and degradeToSingle completes it
		docker("start", container(B)); started(B, '"ready":true');
		assert.equal(drive("count", B).count, 5);
		// a new session's first commit is its registration: that is what stays sealed, the write itself never runs
		assert.equal(drive("write", B, "sealed").writes[0].code, "CommitSealed");
		docker("stop", container(B));
		const degraded = tool(B, { op: "degrade", tid: "degrade-1", epoch: 2, version: 2, ...remote });
		assert.equal(degraded.config.durability, "single"); assert.equal(degraded.config.primaryEpoch, 3); assert.equal(degraded.recoveredCommitted.length, 1);
		docker("start", container(B));
		assert.deepEqual(drive("write", B, "single", "3").writes, Array(3).fill("answered"));
		assert.equal(drive("count", B).count, 8, "five and three: the sealed write had not run, and the fork is not there");
		// the fork's request, unknown on the promoted host, is NotCommitted by the journal's promotion evidence (v3 6.2): a
		// durable negative claim, so the original sent again has no effect
		const fork = drive("resolve", B, JSON.stringify(hold.writes[5].request));
		say("fork resolved", fork);
		assert.equal(fork.resolved.state, "done"); assert.equal(fork.resolved.error?.code, "NotCommitted", JSON.stringify(fork.resolved));
		assert.equal(fork.again.refused, "NotCommitted", "the late original meets the negative claim");
		assert.equal(drive("count", B).count, 8, "and it never takes effect");
		assert.deepEqual(drive("write", B, "retried").writes, ["answered"], "the client writes again after an unknown outcome");
		// the old primary released into quarantine, its history set aside, and made the standby
		assert.equal(drive("release", A, "release-1").state, "quarantine");
		docker("stop", container(A));
		tool(A, { op: "wipe" });
		docker("start", container(A)); started(A, '"quarantine":true');
		docker("stop", container(B));
		const stood = tool(B, { op: "set-standby", tid: "standby-1", target: A, ...remote });
		assert.equal(stood.config.standbyReplica, A); assert.equal(stood.config.durability, "sync");
		started(A, '"leftQuarantine":true');
		drive("readmit", A, "readmit-1");
		docker("start", container(A)); started(A, '"ready":true');
		docker("start", container(B));
		assert.deepEqual(drive("write", B, "after", "3").writes, Array(3).fill("answered"));
		// what the stores hold
		docker("stop", container(B)); docker("stop", container(A));
		const a = tool(A, { op: "status", materialize: true, revision: forked.head.revision }), b = tool(B, { op: "status", materialize: true, revision: forked.head.revision });
		assert.equal(a.snapshot, b.snapshot); assert.deepEqual(a.head, b.head); assert.deepEqual(a.entries, b.entries);
		assert.equal(b.entries.length, 12); assert.equal(b.entries.filter((e: { label: string }) => e.label === "fork").length, 0);
		assert.notEqual(b.atRevision, forked.head.hash, "the fork is not in the promoted history");
		// every primary left the notice of its transitions in the control Space (5.3.1 step 5): no host reported a refusal
		for (const host of [A, B]) {
			const refused = execFileSync("sh", ["-c", `docker logs ${container(host)} 2>&1`], { encoding: "utf8" }).split("\n").filter((l) => l.startsWith("Replica notice:"));
			assert.deepEqual(refused, [], `${host} could not leave its replica notice`);
		}
		console.log("replica scenario passed");
	} catch (e) {
		console.error((e as { stderr?: string }).stderr ?? e);
		for (const s of [A, B]) console.error(compose("logs", "--tail", "15", s));
		process.exitCode = 1;
	} finally {
		fencing?.kill();
		compose("down", "-v", "--remove-orphans");
		if (process.env.FED_KEEP) console.log(`kept ${dir}`); else rmSync(dir, { recursive: true, force: true });
	}
}
