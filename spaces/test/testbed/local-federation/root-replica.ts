// `run.ts root-replica`: the Root on the control host routes to a replicated Member, the primary/sync Space of replica-a
// and replica-b. A write through the Root sealed only on the primary, the primary killed, the standby promoted and
// degraded to single behind the container fencing adapter: the promoted primary leaves its notice, the Root adopts it and
// routes there, the sealed write resumed through the Root runs on the new primary exactly once (its fork was never
// committed), and the next write lands there too (v3 5.3.1 step 5, 6.2).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { loadFileSigner } from "../../../src/index.ts";
import { BACKGROUND_CONTEXT as ctx } from "../../../src/context.ts";
import { FederationRouting } from "../../../src/federation-policy.ts";
import { openSqliteHost } from "../../../src/store/sqlite.ts";
import { provision } from "./provision.ts";
import { harness, provisionReplicas } from "./replica.ts";
import { GATEWAY, IP, POLICY, REPLICA, RPORT } from "./net.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url)), NET = "phi-federation_fed";
const A = "replica-a", B = "replica-b", SPACE = "sp-0d7f3a52-6c1e-4b8a-9f21-3e5a7c9b1d04", INCARNATION = "1ed6e700";
const container = (host: string) => `phi-federation-${host}-1`;

/** The Root's table and its provisioning name the replicated Member `r` instead of the data host's Member `a`. */
async function provisionRoot(dir: string) {
	const control = JSON.parse(readFileSync(join(dir, "control.config.json"), "utf8"));
	const target = { authorityId: "authority", hostId: A, spaceId: SPACE, dataIncarnation: INCARNATION, primaryEpoch: 1 };
	const endpoint = (host: string) => { const k = loadFileSigner(join(dir, `${host}-key.json`)); return { peerId: `${host}-peer`, keyId: k.keyId, algorithm: k.algorithm, publicKey: k.publicKey, address: { host: REPLICA[host as typeof A], port: RPORT.gate } }; };
	const store = await openSqliteHost(join(dir, "control.sqlite"));
	await store.commit(async (tx) => {
		const d = await tx.doc(FederationRouting, control.controlSpaceId, null);
		d.members = { r: { id: "r", state: "active", target, replication: { primaryReplica: A, standbyReplica: B, replicaConfigVersion: 1, durability: "sync" } } } as never;
		d.policy = { ...(POLICY(1) as object), default: { mode: "local", member: "r" } } as never;
	}, ctx);
	await store.close(ctx);
	control.root.members = { r: { target, ...endpoint(A), replicas: { [B]: endpoint(B) } } };
	control.root.statusIntervalMs = 2000;
	control.capabilities.hostBindings = { ...control.capabilities.hostBindings, [`${A}-peer`]: A, [`${B}-peer`]: B };
	writeFileSync(join(dir, "control.config.json"), JSON.stringify(control), { mode: 0o600 });
}

export async function rootReplicaScenario() {
	const { dir, env, compose, say, tool, started, docker, runs } = harness();
	const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const root = (...a: string[]) => { const out = JSON.parse(compose("exec", "-T", "control", "node", "--experimental-strip-types", "--no-warnings", "test/testbed/local-federation/root-replica-driver.ts", ...a).trim().split("\n").at(-1)!); say(`root ${a.join(" ")}`, out); return out; };
	const until = (f: () => boolean, what: string, ms = 90_000) => { const end = Date.now() + ms; for (;;) { if (f()) return; if (Date.now() > end) throw new Error(`no ${what}`); execFileSync("sleep", ["1"]); } };
	let fencing: ChildProcess | undefined;
	try {
		await provision(dir);
		await provisionReplicas(dir, "sync");
		await provisionRoot(dir);
		const remote = { register: { caFile: "/fed/ca.crt", certFile: "/fed/operator.crt", keyFile: "/fed/operator.key", host: IP.register, port: 7430 }, fencing: { caFile: "/fed/ca.crt", certFile: "/fed/operator.crt", keyFile: "/fed/operator.key", host: GATEWAY, port: RPORT.fencing } };
		compose("up", "-d", "--no-build", "register", "management", "control", "client");
		fencing = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ROOT, "test/testbed/local-federation/fencing-service.ts"), dir], { stdio: ["ignore", "pipe", "inherit"] });
		await new Promise((resolve, reject) => { fencing!.stdout!.once("data", resolve); fencing!.once("exit", reject); });
		compose("up", "-d", "--no-build", "--no-deps", B); started(B, '"ready":true');
		compose("up", "-d", "--no-build", "--no-deps", A); started(A, '"ready":true');
		runs(container(A), env.REPLICA_A_IMPL); runs(container(B), env.REPLICA_B_IMPL); runs(container("control"), env.CONTROL_IMPL);
		// a write through the Root lands on the provisioned primary
		const first = root("write", "w1", "1");
		assert.ok(first.answer.result, JSON.stringify(first));
		// the standby cut off: the next write through the Root is sealed on the primary only, its outcome unknown
		sh("docker", ["network", "disconnect", NET, container(B)]);
		const sealed = root("write", "w2", "2");
		assert.ok(sealed.answer.error, "a write nobody confirmed is not answered as written");
		docker("kill", "-s", "KILL", container(A));
		const forked = tool(A, { op: "status" });
		assert.equal(forked.head.revision, forked.applied + 1, "the old primary keeps a sealed candidate");
		// the standby promoted behind the fence, then degraded to single: epoch 3, configuration 3
		sh("docker", ["network", "connect", "--ip", REPLICA[B], NET, container(B)]);
		docker("stop", container(B));
		assert.equal(tool(B, { op: "promote", tid: "promote-1", epoch: 1, version: 1, ...remote }).config.primaryEpoch, 2);
		const degraded = tool(B, { op: "degrade", tid: "degrade-1", epoch: 2, version: 2, ...remote });
		assert.equal(degraded.config.durability, "single"); assert.equal(degraded.config.primaryEpoch, 3);
		docker("start", container(B)); started(B, '"ready":true', 90_000, 2);
		runs(container(B), env.REPLICA_B_IMPL);
		// the Root adopts the promoted primary's notice and routes there
		const routing = async () => { docker("stop", container("control")); const s = await openSqliteHost(join(dir, "control.sqlite")); try { const { controlSpaceId } = JSON.parse(readFileSync(join(dir, "control.config.json"), "utf8")); return (await s.snapshot(FederationRouting, controlSpaceId, ctx))!; } finally { await s.close(ctx); docker("start", container("control")); } };
		until(() => root("count").answer.result !== undefined, "count through the Root after the promotion");
		// the sealed write resumed through the Root: the fork never reached the new primary, so it runs there, once
		const resumed = root("resume", "w2");
		assert.ok(resumed.answer.result?.id, JSON.stringify(resumed));
		assert.deepEqual(root("resume", "w2").answer, resumed.answer, "resumed again: the same answer");
		const third = root("write", "w3", "3");
		assert.ok(third.answer.result, JSON.stringify(third));
		assert.equal(root("count").answer.result.count, 3, "w1, w2 once, w3");
		const table = await routing();
		const r = (table.members as Record<string, any>).r;
		say("member r", { target: r.target, replication: r.replication });
		assert.deepEqual([r.target.hostId, r.target.primaryEpoch, r.replication.replicaConfigVersion, r.replication.durability], [B, 3, 3, "single"]);
		console.log("root-replica scenario passed");
	} catch (e) {
		console.error((e as { stderr?: string }).stderr ?? e);
		for (const s of ["control", A, B]) console.error(compose("logs", "--tail", "20", s));
		process.exitCode = 1;
	} finally {
		fencing?.kill();
		compose("down", "-v", "--remove-orphans");
		if (process.env.FED_KEEP) console.log(`kept ${dir}`); else (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
	}
}
