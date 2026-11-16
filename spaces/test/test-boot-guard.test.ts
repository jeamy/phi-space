// The boot guard on the wire (src/boot.ts), on either server: what a host serves depends on the external authorization and the
// local installation together, and a fence reaches open connections at their next call.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RemoteSpace, socketTransport, SqliteRecoveryRegister, FOREVER } from "../src/index.ts";
import { TestClock, gateUnderTest } from "./support/gate-under-test.ts";

const peer = (id: string, ip: string, groups: string[]) => ({ id, name: id, ip, connected: true, groups: groups.map((g) => ({ id: `g-${g}`, name: g })) });

async function setup(tc: TestContext) {
	const server = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify([peer("p", "127.0.0.2", ["space-hosts"])])); });
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	tc.after(() => { server.closeAllConnections(); server.close(); });
	const dir = mkdtempSync("/tmp/phi-boot-");
	tc.after(() => rmSync(dir, { recursive: true, force: true }));
	const files = { external: join(dir, "external.sqlite"), installed: join(dir, "installed.sqlite") };
	const external = new SqliteRecoveryRegister(files.external), installed = new SqliteRecoveryRegister(files.installed);
	tc.after(() => { external.close(); installed.close(); });
	const gate = await gateUnderTest(tc, { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, clock: new TestClock(tc), boot: files });
	const sid = await gate.control.jobsSpace("jobs", []);
	const info = await gate.control.spaceInfo("jobs");
	gate.armBoot();
	const t = socketTransport({ host: "127.0.0.1", port: gate.port }, { localAddress: "127.0.0.2" });
	tc.after(() => t.close());
	const client = new RemoteSpace(t, { space: sid, attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 5_000 });
	const permit = (more: Record<string, unknown> = {}) => ({ state: "active", authorityId: "authority", dataIncarnation: info.incarnation, role: "local", transitionId: "t1", ...more });
	const set = async (r: SqliteRecoveryRegister, key: string, value: Record<string, unknown>) => r.compareAndSet(key, (await r.get(key))?.version ?? null, value as never);
	const boot = (state: string, spaces: Record<string, unknown>) => set(external, "boot:host-1", { hostId: "host-1", state, spaces });
	const install = (p: Record<string, unknown>) => set(installed, `installed:host-1:${sid}`, p);
	const allow = async (p = permit()) => { await boot("active", { [sid]: p }); await install(p); };
	return { sid, client, permit, boot, install, allow, external, set };
}
const blocked = (p: Promise<unknown>) => assert.rejects(p, /internal error/);

test("nothing is served without the external authorization and the local installation together", async (tc) => {
	const g = await setup(tc);
	await blocked(g.client.count({ type: "Job" }));
	await g.boot("active", { [g.sid]: g.permit() });
	await blocked(g.client.count({ type: "Job" })); // installed nothing yet
	await g.install(g.permit({ transitionId: "other" }));
	await blocked(g.client.count({ type: "Job" }));
	await g.install(g.permit());
	assert.equal(await g.client.count({ type: "Job" }), 0);
	await g.client.write({ type: "Job", fields: {} }, null, FOREVER);
	assert.equal(await g.client.count({ type: "Job" }), 1);
});

test("a permit binds the host, the authority, the data and the state of the Space", async (tc) => {
	const g = await setup(tc);
	for (const wrong of [{ authorityId: "other" }, { dataIncarnation: "00000000" }, { state: "revoked" }, { erasureEpoch: 1 }, { authorityMarker: true }, { role: "standby" }]) {
		await g.allow(g.permit(wrong));
		await blocked(g.client.count({ type: "Job" }));
	}
	await g.boot("active", {});
	await blocked(g.client.count({ type: "Job" }));
	await g.allow();
	assert.equal(await g.client.count({ type: "Job" }), 0);
});

test("a fence reaches an open connection at its next call, and only an active host comes back", async (tc) => {
	const g = await setup(tc);
	await g.allow();
	assert.equal(await g.client.count({ type: "Job" }), 0);
	for (const state of ["fenced", "quarantine"]) {
		await g.boot(state, { [g.sid]: g.permit() });
		await blocked(g.client.count({ type: "Job" }));
		await blocked(g.client.write({ type: "Job", fields: {} }, null, FOREVER));
	}
	await g.boot("active", { [g.sid]: g.permit() });
	assert.equal(await g.client.count({ type: "Job" }), 0);
	await g.set(g.external, "boot:host-1", { hostId: "someone-else", state: "active", spaces: { [g.sid]: g.permit() } });
	await blocked(g.client.count({ type: "Job" }));
});

test("a register that cannot be read blocks the host, and reading again brings it back", async (tc) => {
	const g = await setup(tc);
	await g.allow();
	assert.equal(await g.client.count({ type: "Job" }), 0);
	const db = (g.external as unknown as { db: { exec(sql: string): void } }).db;
	db.exec("ALTER TABLE records RENAME TO hidden");
	await blocked(g.client.count({ type: "Job" }));
	db.exec("ALTER TABLE hidden RENAME TO records");
	assert.equal(await g.client.count({ type: "Job" }), 0);
});

test("the deletion floor is external: a Space cannot lower it", async (tc) => {
	const g = await setup(tc);
	await g.allow();
	assert.equal(await g.client.count({ type: "Job" }), 0);
	const floor = { spaceId: g.sid, epoch: 1, state: "pending", commandHash: "a".repeat(64), archiveDeadline: 2_000, archivesPending: true };
	await g.external.compareAndSet(`erasure:${g.sid}`, null, floor);
	await blocked(g.client.count({ type: "Job" }));
});
