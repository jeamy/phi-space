// The mobile runtime with this package's bundle (src/with-agent.ts): pi-serverd from the sibling checkout
// (PI_SERVER_RUNTIME_DIR overrides it; PI_SERVERD_SOURCE another pi-serverd.mjs) serves the space and the agent sessions.
// Skips when the runtime is not installed; this package installs nothing for it.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { RemoteSpace, PhiSpaces, piServerTransport, openSqliteHost, FOREVER, BACKGROUND_CONTEXT } from "../../src/index.ts";

test("built bundle in actual pi-serverd serves space and sessions; the space has its own store; socket grants are explicit", async t => {
	const runtime = process.env.PI_SERVER_RUNTIME_DIR ?? resolve(fileURLToPath(new URL("../../..", import.meta.url)), "pi-termux-mobile/runtime");
	if (!existsSync(join(runtime, "node_modules/@earendil-works/pi-server"))) { t.skip("native mobile runtime not installed"); return; }
	const { build } = await import("esbuild");
	const { readdirSync, copyFileSync, symlinkSync, writeFileSync } = await import("node:fs");
	const { spawn } = await import("node:child_process");
	const { Client } = await import(pathToFileURL(join(runtime, "node_modules/@earendil-works/pi-client/dist/index.js")).href);
	const { createUnixTransportFactory } = await import(pathToFileURL(join(runtime, "node_modules/@earendil-works/pi-client/dist/unix.js")).href);
	const dir = mkdtempSync("/tmp/phi-spaces-serverd-acceptance-");
	let child: any, client: any, output = "";
	try {
		for (const name of readdirSync(runtime)) if (name.endsWith(".mjs")) copyFileSync(join(runtime, name), join(dir, name));
		copyFileSync(process.env.PI_SERVERD_SOURCE ?? join(runtime, "pi-serverd.mjs"), join(dir, "pi-serverd.mjs"));
		symlinkSync(join(runtime, "node_modules"), join(dir, "node_modules"), "dir");
		await build({ entryPoints: [fileURLToPath(new URL("../src/with-agent.ts", import.meta.url))], outfile: join(dir, "phi-spaces.mjs"), bundle: true, format: "esm", platform: "node", target: "node22", external: ["@earendil-works/*"], legalComments: "none" });
		writeFileSync(join(dir, "auth.json"), "{}");
		const serverId = randomUUID(), path = join(dir, "server.sock");
		child = spawn(process.execPath, [join(dir, "pi-serverd.mjs")], { cwd: dir, env: { ...process.env, PI_SERVERD_STATE_DIR: join(dir, "state"), PI_SERVERD_AUTH_FILE: join(dir, "auth.json"), PI_WORKDIR: dir, PI_SERVERD_SOCK: path, PI_SERVERD_ID: serverId, PI_SERVERD_SPACE_PRINCIPAL: "local-operator", PI_SERVERD_SPACE_ROLES: "member" }, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", (b: Buffer) => { output += b.toString(); }); child.stderr.on("data", (b: Buffer) => { output += b.toString(); });
		const until = Date.now() + 15000;
		while (!output.includes("pi-serverd on ")) { if (child.exitCode !== null || Date.now() >= until) throw new Error(`serverd did not start: ${output}`); await new Promise(r => setTimeout(r, 25)); }
		client = await Client.connect({ serverId, transportFactory: createUnixTransportFactory({ path }) });
		assert.deepEqual(await client.request({ serverId }, { serviceId: "sessions", member: "list", args: [] }), { sessions: [] });
		const remote = new RemoteSpace(piServerTransport(call => client.request({ serverId }, call)));
		assert.equal((await remote.info()).principal, "local-operator");
		await remote.write({ type: "Daemon", fields: { proof: "built" } }, null, FOREVER);
		assert.equal((await remote.take({ type: "Daemon" }, 0))?.fields.proof, "built");
		assert.equal(await remote.count({ type: "Daemon" }), 0);
		assert.deepEqual(await client.request({ serverId }, { serviceId: "sessions", member: "list", args: [] }), { sessions: [] });
		await remote.write({ type: "Persist", fields: {} }, null, FOREVER);
		await client.dispose(); client = undefined;
		const stopped = new Promise<void>(r => child.once("exit", () => r())); child.kill("SIGTERM"); await stopped;
		// the space is a store of its own beside the sessions' harness, and outlives the daemon
		const stored = await openSqliteHost(join(dir, "state", "space.sqlite"));
		try { assert.equal(await new PhiSpaces(stored, BACKGROUND_CONTEXT).count({ type: "Persist" }), 1); } finally { await stored.close(BACKGROUND_CONTEXT); }
		output = "";
		child = spawn(process.execPath, [join(dir, "pi-serverd.mjs")], { cwd: dir, env: { ...process.env, PI_SERVERD_STATE_DIR: join(dir, "state"), PI_SERVERD_AUTH_FILE: join(dir, "auth.json"), PI_WORKDIR: dir, PI_SERVERD_SOCK: path, PI_SERVERD_ID: serverId, PI_SERVERD_SPACE_PRINCIPAL: "", PI_SERVERD_SPACE_ROLES: "" }, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", (b: Buffer) => { output += b.toString(); }); child.stderr.on("data", (b: Buffer) => { output += b.toString(); });
		const disabledUntil = Date.now() + 15000;
		while (!output.includes("pi-serverd on ")) { if (child.exitCode !== null || Date.now() >= disabledUntil) throw new Error(`disabled serverd did not start: ${output}`); await new Promise(r => setTimeout(r, 25)); }
		client = await Client.connect({ serverId, transportFactory: createUnixTransportFactory({ path }) });
		const denied = await client.request({ serverId }, { serviceId: "space", member: "hello", args: [{ method: "hello", args: {}, principal: { peerId: "local-operator" }, roles: ["admin"] }] });
		assert.equal(denied.error.code, "Unauthenticated", "no implicit grant from socket/SSH or forged JSON identity");
		assert.deepEqual(await client.request({ serverId }, { serviceId: "sessions", member: "list", args: [] }), { sessions: [] });

	} finally {
		await client?.dispose().catch(() => {});
		if (child && child.exitCode === null) { const exited = new Promise<void>(r => child.once("exit", () => r())); child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 3000); await exited; clearTimeout(timer); }
		rmSync(dir, { recursive: true, force: true });
	}
});
