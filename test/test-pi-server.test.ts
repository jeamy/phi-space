// Optional native integration: use the pi-server/pi-client already installed by the mobile runtime.
// No dependency is installed by this repository. Set PI_SERVER_RUNTIME_DIR for a different runtime checkout.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { PhiSpaces, SpaceService, StaticIdentity, RemoteSpace, withSpaceService, piServerTransport, FOREVER } from "../src/index.ts";
import { PersistentHome, ctx } from "./support/persistent.ts";

test("native pi-server Unix RPC preserves sessions and routes RemoteSpace through space", async t => {
	const runtime = process.env.PI_SERVER_RUNTIME_DIR ?? resolve(fileURLToPath(new URL("../..", import.meta.url)), "pi-termux-mobile/runtime");
	const serverPath = join(runtime, "node_modules/@earendil-works/pi-server/dist/transports/unix/index.js");
	if (!existsSync(serverPath)) { t.skip("set PI_SERVER_RUNTIME_DIR to an installed mobile runtime for native pi-server acceptance"); return; }
	const { createUnixServer } = await import(pathToFileURL(serverPath).href);
	const { Client } = await import(pathToFileURL(join(runtime, "node_modules/@earendil-works/pi-client/dist/index.js")).href);
	const { createUnixTransportFactory } = await import(pathToFileURL(join(runtime, "node_modules/@earendil-works/pi-client/dist/unix.js")).href);
	const home = new PersistentHome(), dir = mkdtempSync("/tmp/phi-spaces-native-server-");
	let server: any, client: any;
	try {
		const h = await home.open();
		const svc = new SpaceService({ host: h, ctx, identity: new StaticIdentity({ trusted: { principal: { peerId: "trusted" }, roles: ["member"] } }) });
		let released = 0;
		const services = withSpaceService({ attachClient: () => ({ invokeService: async call => { assert.equal(call.serviceId, "sessions"); assert.equal(call.member, "list"); return { sessions: [{ id: "existing" }] }; }, release: () => { released++; } }) }, svc, () => ({ peerId: "trusted" }));
		const serverId = randomUUID(), path = join(dir, "server.sock");
		server = createUnixServer({ serverServices: services, resolveSession: async () => { throw new Error("no session attach in this smoke test"); }, openSession: async () => { throw new Error("no session attach in this smoke test"); } }, { serverId, path });
		await server.start();
		client = await Client.connect({ serverId, transportFactory: createUnixTransportFactory({ path }) });
		assert.deepEqual(await client.request({ serverId }, { serviceId: "sessions", member: "list", args: [] }), { sessions: [{ id: "existing" }] });
		const remote = new RemoteSpace(piServerTransport(call => client.request({ serverId }, call)));
		assert.equal((await remote.info()).principal, "trusted");
		await remote.write({ type: "Native", fields: { n: 1 } }, null, FOREVER);
		assert.equal((await remote.take({ type: "Native" }, 0))?.fields.n, 1);
		assert.equal(await new PhiSpaces(h, ctx).count({ type: "Native" }), 0);
		const forged = await client.request({ serverId }, { serviceId: "space", member: "hello", args: [{ method: "hello", args: { protocol: 1 }, principal: { peerId: "attacker" }, roles: ["admin"] }] });
		assert.equal(forged.result.principal, "trusted", "client presentation/arguments cannot replace the trusted connection identity");
		await client.dispose(); client = undefined; await server.close(); server = undefined; assert.ok(released > 0);
	} finally { await client?.dispose().catch(() => {}); await server?.close().catch(() => {}); await home.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
