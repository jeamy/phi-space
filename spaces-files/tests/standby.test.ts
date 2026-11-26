// The standby of the deployment state and the blobs (docs/zanzibar-agent-filesystem-plan.en.md, section 6.7): after a
// mix of every kind of state change, each table and both key files are the same on the standby as on the primary (a
// table SQLite's sessions would skip shows here); a change the standby does not confirm is never answered and closes
// admission, and the standby never sees it; a blob is on the standby before its row commits; every open seeds anew.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONTENT_KEYS_FILE, DeploymentState, KEYS_FILE, STATE_FILE } from "../server/deployment.ts";
import { FilesService } from "../server/service.ts";
import { localStandby, promoteStandby } from "../server/standby.ts";

const code = (c: string) => (e: Error & { code?: string }) => { assert.equal(e.code, c, e.message); return true; };

function dirs() {
	const root = mkdtempSync(join(tmpdir(), "spaces-files-standby-"));
	const d = (n: string) => ({ dataDir: join(root, n, "data"), stateDir: join(root, n, "state"), blobDir: join(root, n, "blobs") });
	return { root, a: d("a"), b: d("b") };
}

/** Every row of every table, by table, in primary-key order. */
function tables(stateDir: string): Record<string, unknown[]> {
	const db = new DatabaseSync(join(stateDir, STATE_FILE), { readOnly: true });
	try {
		const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
		return Object.fromEntries(names.map((n) => {
			const cols = (db.prepare(`PRAGMA table_info("${n}")`).all() as Array<{ cid: number }>).map((c) => c.cid + 1).join(", ");
			return [n, db.prepare(`SELECT * FROM "${n}" ORDER BY ${cols}`).all().map((r) => ({ ...r }))];
		}));
	} finally { db.close(); }
}

test("every table and both key files are the same on the standby after a mix of state changes", async () => {
	const { root, a, b } = dirs();
	try {
		const s = await FilesService.open({ ...a, standby: { stateDir: b.stateDir, blobDir: b.blobDir } });
		try {
			await s.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: "i", subject: "lea" });
			const lea = (await s.login("acme", "user", { issuer: "i", subject: "lea" })).handle;
			await s.write(lea, "lea", "a.md", Buffer.from("one"), 0, (await s.issueOperationIds(lea, 1))[0]);
			const st = s.state;
			st.rotateKey(60_000);
			st.rotateContentKey();
			st.rosterAdd("acme", "i", "ops");
			st.rosterRemove("acme", "i", "ops");
			st.rosterAdd("acme", "i", "ops2");
			st.operatorAudit("test.mix", { n: 1 });
			st.closeTenant("acme", "test", { why: "mix" });
			st.reopenTenant("acme");
			st.journalRestore("intent", { archive: "x" });
			st.endRestore();
			st.commitFloor(st.now() + 1);
			st.createSession({ tenantId: "acme", actorKind: "user", actorId: "lea" });
			st.endSession(lea);
			st.addLogin("i", "max", "acme");
			assert.deepEqual(tables(b.stateDir), tables(a.stateDir));
			for (const f of [KEYS_FILE, CONTENT_KEYS_FILE]) assert.deepEqual(readFileSync(join(b.stateDir, f)), readFileSync(join(a.stateDir, f)), f);
			// the blob is on the standby, under the same path
			const list = (dir: string) => readdirSync(dir, { recursive: true }).map(String).filter((p) => /\/[A-Za-z0-9_-]{22}$/.test(p)).sort();
			assert.deepEqual(list(b.blobDir), list(a.blobDir));
			assert.equal(list(b.blobDir).length, 1);
		} finally { await s.close(); }
		// a write made without the standby (an offline command) is undone on the standby by the next open's seed
		const offline = await DeploymentState.open({ dir: a.stateDir });
		offline.operatorAudit("offline", {});
		offline.close();
		assert.notDeepEqual(tables(b.stateDir), tables(a.stateDir));
		const again = await FilesService.open({ ...a, standby: { stateDir: b.stateDir, blobDir: b.blobDir } });
		try { assert.deepEqual(tables(b.stateDir), tables(a.stateDir), "seeded anew on open"); }
		finally { await again.close(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a change the standby does not confirm is never answered, closes admission, and the standby never has it", async () => {
	const { root, a, b } = dirs();
	try {
		const s = await FilesService.open({ ...a, standby: { stateDir: b.stateDir, blobDir: b.blobDir } });
		try {
			await s.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: "i", subject: "lea" });
			const sessions = (dir: string) => (tables(dir).sessions ?? []).length;
			assert.equal(sessions(b.stateDir), 0);
			// the standby goes away (here: it was promoted, which fences this primary)
			promoteStandby({ stateDir: b.stateDir, blobDir: b.blobDir });
			await assert.rejects(s.login("acme", "user", { issuer: "i", subject: "lea" }), code("unavailable"), "no handle is handed out");
			assert.equal(s.admission.open, false, "admission is closed");
			assert.equal(sessions(b.stateDir), 0, "the standby never has the session");
			await assert.rejects(s.login("acme", "user", { issuer: "i", subject: "lea" }), code("unavailable"), "and nothing more is written");
		} finally { await s.close(); }
		// the promoted standby opens as a deployment of its own; the fenced primary cannot seed it again
		await assert.rejects(FilesService.open({ ...a, standby: { stateDir: b.stateDir, blobDir: b.blobDir } }), /promoted/);
		const p = await FilesService.open({ ...b });
		try { assert.deepEqual(await p.tenants(), [], "the Space store is not here: the primary/sync journal carries it"); }
		finally { await p.close(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a blob the standby does not take fails the save before its commit", async () => {
	const { root, a, b } = dirs();
	try {
		const standby = await localStandby({ stateDir: b.stateDir, blobDir: b.blobDir });
		standby.close();
		const s = await FilesService.open({ ...a, standby: { stateDir: b.stateDir, blobDir: b.blobDir } });
		try {
			await s.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: "i", subject: "lea" });
			const lea = (await s.login("acme", "user", { issuer: "i", subject: "lea" })).handle;
			const op = (await s.issueOperationIds(lea, 1))[0];
			// the blob directory alone refuses (promoted): the state still follows, the save does not happen
			const { writeFileSync } = await import("node:fs");
			writeFileSync(join(b.blobDir, "standby-promoted"), "x");
			await assert.rejects(s.write(lea, "lea", "a.md", Buffer.from("one"), 0, op), code("unavailable"));
			await assert.rejects(s.read(lea, "lea", "a.md"), code("notFound"), "nothing committed");
			rmSync(join(b.blobDir, "standby-promoted"));
			assert.deepEqual(await s.write(lea, "lea", "a.md", Buffer.from("one"), 0, op), { version: 1 }, "the retry with the same ID applies once");
		} finally { await s.close(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});
