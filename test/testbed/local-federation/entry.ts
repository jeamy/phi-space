// `npm run testbed:federation -- entry [A-B]`: lww and set types of one Space replicated between two hosts of the configured runtime (`A-B`: the
// runtime of replica-a and replica-b, ts or rust each), each pulling the other's
// stream over its gate. A client writes through the gates while one host is cut off and killed, then while the other is cut off, and once on both at
// nearly the same time; both gates and both stores must end with the same entries.
import { rmSync } from "node:fs";
import assert from "node:assert/strict";
import { provision } from "./provision.ts";
import { REPLICA } from "./net.ts";
import { harness, provisionReplicas } from "./replica.ts";

const A = "replica-a", B = "replica-b", NET = "phi-federation_fed";
const container = (host: string) => `phi-federation-${host}-1`;
const sensor = (sensorId: string, v: number) => ({ type: "Sensor", fields: { sensorId, v } }), tag = (name: string) => ({ type: "Tag", fields: { tag: name } });

export async function entryScenario() {
	const { dir, env, compose, drive, tool, started, docker, runs } = harness();
	const cut = (host: string) => docker("network", "disconnect", NET, container(host)), heal = (host: string) => docker("network", "connect", "--ip", REPLICA[host as typeof A], NET, container(host));
	/** Waits until the host's gate shows `want`, and holds that it does. */
	const shows = (host: string, want: unknown[]) => assert.deepEqual(drive("view", host, JSON.stringify(want)).view, want, `${host} shows the merged entries`);
	try {
		await provision(dir);
		await provisionReplicas(dir, "entry");
		compose("up", "-d", "--no-build", "register", "management", "control", "client");
		compose("up", "-d", "--no-build", "--no-deps", A, B);
		started(A, '"ready":true'); started(B, '"ready":true');
		runs(container(A), env.REPLICA_A_IMPL); runs(container(B), env.REPLICA_B_IMPL);
		assert.equal(drive("put", A, "s1", "1").write, "answered");
		shows(B, [sensor("s1", 1)]);
		assert.equal(drive("take", A).take.refused, "MergeTypeNotExclusive", "a merge type has no exclusive take");
		// b cut off and killed while a is written; it comes back and catches up
		cut(B);
		assert.equal(drive("put", A, "s1", "2").write, "answered");
		assert.equal(drive("put", A, "s2", "1").write, "answered");
		assert.equal(drive("tag", A, "x-a").write, "answered");
		assert.ok(drive("gone", B).gone.refused, "the cut-off host serves no client");
		docker("kill", "-s", "KILL", container(B));
		heal(B);
		docker("start", container(B)); started(B, '"ready":true', 90_000, 2);
		runs(container(B), env.REPLICA_B_IMPL);
		shows(B, [sensor("s1", 2), sensor("s2", 1), tag("x-a")]);
		// a cut off while b is written, a tag removed among them
		cut(A);
		assert.equal(drive("put", B, "s1", "3").write, "answered");
		assert.equal(drive("tag", B, "x-b").write, "answered");
		assert.equal(drive("untag", B, "x-a").untag, "answered");
		heal(A);
		shows(A, [sensor("s1", 3), sensor("s2", 1), tag("x-b")]);
		// the same key on both, one after the other: the later write wins on both
		assert.equal(drive("put", A, "s2", "7").write, "answered");
		assert.equal(drive("put", B, "s2", "8").write, "answered");
		const final = [sensor("s1", 3), sensor("s2", 8), tag("x-b")];
		shows(A, final); shows(B, final);
		// what the stores hold
		docker("stop", container(A)); docker("stop", container(B));
		assert.deepEqual(tool(A, {}).entries, final); assert.deepEqual(tool(B, {}).entries, final);
		console.log("entry scenario passed");
	} catch (e) {
		console.error((e as { stderr?: string }).stderr ?? e);
		for (const s of [A, B]) console.error(compose("logs", "--tail", "15", s));
		process.exitCode = 1;
	} finally {
		compose("down", "-v", "--remove-orphans");
		if (process.env.FED_KEEP) console.log(`kept ${dir}`); else rmSync(dir, { recursive: true, force: true });
	}
}
