// The mobile runtime with this package's bundle (src/with-agent.ts): pi-serverd from the sibling checkout
// (PI_SERVER_RUNTIME_DIR overrides it; PI_SERVERD_SOURCE another pi-serverd.mjs) serves the agent sessions as calls over
// its conversation socket (remote-calls.mjs) and, when configured, the space on a socket of its own.
// Skips when the runtime is not installed; this package installs nothing for it.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { PhiSpaces, connectSpace, openSqliteHost, FOREVER, BACKGROUND_CONTEXT } from "../../src/index.ts";

test("built bundle in actual pi-serverd serves sessions and space; the space has its own store; socket grants are explicit", async t => {
	const runtime = process.env.PI_SERVER_RUNTIME_DIR ?? resolve(fileURLToPath(new URL("../../..", import.meta.url)), "pi-termux-mobile/runtime");
	if (!existsSync(join(runtime, "node_modules/@earendil-works/pi-durable")) || !existsSync(join(runtime, "remote-calls.mjs"))) { t.skip("mobile runtime not installed"); return; }
	const { build } = await import("esbuild");
	const { readdirSync, copyFileSync, symlinkSync, writeFileSync } = await import("node:fs");
	const { spawn } = await import("node:child_process");
	const dir = mkdtempSync("/tmp/phi-spaces-serverd-acceptance-");
	let child: any, output = "";
	const links: { close(): void }[] = [];
	const start = async (env: Record<string, string>) => {
		output = "";
		child = spawn(process.execPath, [join(dir, "pi-serverd.mjs")], { cwd: dir, env: { ...process.env, PI_SERVERD_STATE_DIR: join(dir, "state"), PI_SERVERD_AUTH_FILE: join(dir, "auth.json"), PI_WORKDIR: dir, PI_SERVERD_SOCK: join(dir, "server.sock"), PI_SERVERD_SPACE_SOCK: join(dir, "space.sock"), PI_SERVERD_ID: serverId, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", (b: Buffer) => { output += b.toString(); }); child.stderr.on("data", (b: Buffer) => { output += b.toString(); });
		const until = Date.now() + 15000;
		while (!output.includes("pi-serverd on ")) { if (child.exitCode !== null || Date.now() >= until) throw new Error(`serverd did not start: ${output}`); await new Promise(r => setTimeout(r, 25)); }
	};
	const stop = async () => { const stopped = new Promise<void>(r => child.once("exit", () => r())); child.kill("SIGTERM"); await stopped; };
	const open = (sock: string) => { const l = connectSpace(`unix:${join(dir, sock)}`, { callTimeoutMs: 10_000 }); links.push(l); return l.space; };
	const serverId = randomUUID();
	try {
		for (const name of readdirSync(runtime)) if (name.endsWith(".mjs")) copyFileSync(join(runtime, name), join(dir, name));
		copyFileSync(process.env.PI_SERVERD_SOURCE ?? join(runtime, "pi-serverd.mjs"), join(dir, "pi-serverd.mjs"));
		symlinkSync(join(runtime, "node_modules"), join(dir, "node_modules"), "dir");
		await build({ entryPoints: [fileURLToPath(new URL("../src/with-agent.ts", import.meta.url))], outfile: join(dir, "phi-spaces.mjs"), bundle: true, format: "esm", platform: "node", target: "node22", external: ["@earendil-works/*"], legalComments: "none" });
		writeFileSync(join(dir, "auth.json"), "{}");
		const { callRemote } = await import(pathToFileURL(join(dir, "remote-calls.mjs")).href);
		await start({ PI_SERVERD_SPACE_PRINCIPAL: "local-operator", PI_SERVERD_SPACE_ROLES: "member" });
		const calls = open("server.sock");
		assert.equal((await calls.info()).hostId, serverId);
		assert.deepEqual(await callRemote(calls, { member: "list" }), { sessions: [] });
		const remote = open("space.sock");
		assert.equal((await remote.info()).principal, "local-operator");
		await remote.write({ type: "Daemon", fields: { proof: "built" } }, null, FOREVER);
		assert.equal((await remote.take({ type: "Daemon" }, 0))?.fields.proof, "built");
		assert.equal(await remote.count({ type: "Daemon" }), 0);
		await remote.write({ type: "Persist", fields: {} }, null, FOREVER);
		// the conversation socket is a store of its own: nothing of the daemon's space is there
		assert.equal(await calls.count({ type: "Persist" }), 0);
		assert.deepEqual(await callRemote(calls, { member: "list" }), { sessions: [] });
		for (const l of links.splice(0)) l.close();
		await stop();
		// the space is a store of its own beside the sessions' harness, and outlives the daemon
		const stored = await openSqliteHost(join(dir, "state", "space.sqlite"));
		try { assert.equal(await new PhiSpaces(stored, BACKGROUND_CONTEXT).count({ type: "Persist" }), 1); } finally { await stored.close(BACKGROUND_CONTEXT); }
		// without a configured peer there is no space socket: SSH access to the conversation socket grants no space role
		await start({ PI_SERVERD_SPACE_PRINCIPAL: "", PI_SERVERD_SPACE_ROLES: "" });
		assert.equal(existsSync(join(dir, "space.sock")), false, "no implicit grant from socket/SSH");
		assert.deepEqual(await callRemote(open("server.sock"), { member: "list" }), { sessions: [] });
	} finally {
		for (const l of links) l.close();
		if (child && child.exitCode === null) { const exited = new Promise<void>(r => child.once("exit", () => r())); child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 3000); await exited; clearTimeout(timer); }
		rmSync(dir, { recursive: true, force: true });
	}
});
