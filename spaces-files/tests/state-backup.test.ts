// The deployment state's loss, age and backup (docs/zanzibar-agent-filesystem-plan.en.md, section 6.6; phase 5 exit
// evidence: "Lose the deployment state, restore it from its own backup, and verify the refused start, the new epoch
// and generation, the rebuilt login index and that every file still reads"), and the encrypted archive both backups
// use.
import test from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveInvalid, extractArchive, newBackupKey, readBackupKey, verifyArchive, writeArchive } from "../server/archive.ts";
import { backupState, restoreState } from "../server/backup.ts";
import { FilesService, StateLost } from "../server/service.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "spaces-files-sb-"));

test("the archive: a round trip, and every tampering, truncation, reordering or wrong key refused", () => {
	const dir = tmp();
	try {
		newBackupKey(join(dir, "k"));
		assert.throws(() => newBackupKey(join(dir, "k")), /refusing to replace/);
		assert.equal(statSync(join(dir, "k")).mode & 0o777, 0o600);
		const key = readBackupKey(join(dir, "k"));
		const big = Buffer.alloc(3 * 1024 * 1024 + 5, 7);
		writeFileSync(join(dir, "big"), big);
		const a = join(dir, "a.bk");
		writeArchive(a, key, [{ name: "x/small", bytes: Buffer.from("hello") }, { name: "y/big", file: join(dir, "big") }, { name: "empty", bytes: Buffer.alloc(0) }]);
		assert.deepEqual(verifyArchive(a, key), [{ name: "x/small", size: 5 }, { name: "y/big", size: big.length }, { name: "empty", size: 0 }]);
		const out = join(dir, "out");
		assert.deepEqual(extractArchive(a, key, out), ["x/small", "y/big", "empty"]);
		assert.equal(readFileSync(join(out, "x/small"), "utf8"), "hello");
		assert.ok(readFileSync(join(out, "y/big")).equals(big));
		assert.equal(statSync(join(out, "y/big")).mode & 0o777, 0o600);

		const bytes = readFileSync(a);
		const variant = (name: string, b: Buffer) => { const p = join(dir, name); writeFileSync(p, b); return p; };
		const flipped = Buffer.from(bytes); flipped[bytes.length - 100] ^= 1;
		const chunkAt = (b: Buffer) => { const out: Array<[number, number]> = []; let o = 37; while (o < b.length) { const n = b.readUInt32BE(o); out.push([o, 4 + n]); o += 4 + n; } return out; };
		const parts = chunkAt(bytes).map(([o, n]) => bytes.subarray(o, o + n));
		assert.equal(parts.length, 4, "three full chunks and the final one");
		const head = bytes.subarray(0, 37);
		for (const [name, b] of [
			["flipped", flipped],
			["truncated", bytes.subarray(0, bytes.length - 10)],
			["no-final", Buffer.concat([head, ...parts.slice(0, 3)])],
			["reordered", Buffer.concat([head, parts[1], parts[0], parts[2], parts[3]])],
			["dropped", Buffer.concat([head, parts[0], parts[2], parts[3]])],
			["appended", Buffer.concat([bytes, parts[3]])],
		] as Array<[string, Buffer]>) assert.throws(() => verifyArchive(variant(name, b), key), ArchiveInvalid, name);
		newBackupKey(join(dir, "k2"));
		assert.throws(() => verifyArchive(a, readBackupKey(join(dir, "k2"))), ArchiveInvalid, "another key");
		const evil = join(dir, "evil.bk");
		writeArchive(evil, key, [{ name: "../escape", bytes: Buffer.from("x") }]);
		assert.throws(() => extractArchive(evil, key, join(dir, "out2")), /escapes/);
		const fd = openSync(join(dir, "k3"), "w", 0o644); writeSync(fd, key.toString("base64")); closeSync(fd);
		assert.throws(() => readBackupKey(join(dir, "k3")), /chmod 600/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

async function deployment() {
	const dir = tmp();
	const o = { dataDir: join(dir, "data"), stateDir: join(dir, "state"), blobDir: join(dir, "blobs") };
	newBackupKey(join(dir, "state.key"));
	const key = readBackupKey(join(dir, "state.key"));
	return { dir, o, key };
}
const ID = { issuer: "i", subject: "lea" };

test("a lost, older or foreign deployment state is refused; restore-state brings the backup forward", async () => {
	const { dir, o, key } = await deployment();
	try {
		let svc = await FilesService.open(o);
		await svc.createTenant("acme", { actorId: "lea", homeName: "lea", ...ID });
		let lea = (await svc.login("acme", "user", ID)).handle;
		await svc.write(lea, "lea", "f.txt", Buffer.from("one"), 0, (await svc.issueOperationIds(lea, 1))[0]);
		backupState(svc, join(dir, "s1.bk"), key);
		// after the backup: the signing key moves on, a session and an ID are issued, the file changes
		svc.state.rotateKey(svc.limits.retryWindowMs);
		lea = (await svc.login("acme", "user", ID)).handle;
		const [pending] = await svc.issueOperationIds(lea, 1);
		await svc.write(lea, "lea", "f.txt", Buffer.from("two"), 1, (await svc.issueOperationIds(lea, 1))[0]);
		const epoch = svc.state.epoch();
		await svc.close();

		// lost: the start is refused and no state is created in its place
		renameSync(o.stateDir, join(dir, "state-lost"));
		await assert.rejects(FilesService.open(o), (e) => e instanceof StateLost && /restore the state/.test(e.message));
		assert.throws(() => statSync(join(o.stateDir, "state.sqlite")));
		// older: the backup put in place by hand is refused
		extractArchive(join(dir, "s1.bk"), key, o.stateDir, (n) => n !== "backup.json");
		await assert.rejects(FilesService.open(o), (e) => e instanceof StateLost && /older than the data/.test(e.message));
		rmSync(o.stateDir, { recursive: true });
		// foreign: another deployment's state
		const other = await FilesService.open({ dataDir: join(dir, "d2"), stateDir: o.stateDir, blobDir: join(dir, "b2") });
		await other.close();
		await assert.rejects(FilesService.open(o), (e) => e instanceof StateLost && /another deployment/.test(e.message));
		rmSync(o.stateDir, { recursive: true });

		// restore-state: refuses an occupied directory, then brings the backup forward
		await assert.rejects(restoreState(join(dir, "s1.bk"), key, { ...o, stateDir: join(dir, "state-lost") }), /already holds/);
		const r = await restoreState(join(dir, "s1.bk"), key, o);
		assert.equal(r.mode, "maintenance");
		assert.ok(r.epoch > 1);
		svc = await FilesService.open(o);
		try {
			assert.ok(svc.state.epoch() > epoch - 1 && svc.state.epoch() === r.epoch);
			assert.equal(svc.state.lookupSession(lea), null, "the earlier session ended");
			await svc.setMode("normal");
			const fresh = (await svc.login("acme", "user", ID)).handle;
			assert.deepEqual(svc.state.tenantsFor("i", "lea"), ["acme"], "the login index is rebuilt");
			await assert.rejects(svc.write(fresh, "lea", "g.txt", Buffer.from("x"), 0, pending), (e: Error & { code?: string }) => e.code === "operationIdRejected", "an ID of a retired generation");
			const f = await svc.read(fresh, "lea", "f.txt");
			assert.deepEqual([f.version, f.bytes.toString()], [2, "two"], "every file still reads");
		} finally { await svc.close(); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a new content key seals nothing until a state backup holds it", async () => {
	const { dir, o, key } = await deployment();
	try {
		let svc = await FilesService.open(o);
		await svc.createTenant("acme", { actorId: "lea", homeName: "lea", ...ID });
		backupState(svc, join(dir, "s1.bk"), key);
		const g = svc.state.rotateContentKey();
		assert.equal(svc.state.currentContentKey().generation, g - 1, "not yet backed up");
		const lea = (await svc.login("acme", "user", ID)).handle;
		await svc.write(lea, "lea", "before.txt", Buffer.from("sealed with the old key"), 0, (await svc.issueOperationIds(lea, 1))[0]);
		backupState(svc, join(dir, "s2.bk"), key);
		assert.equal(svc.state.currentContentKey().generation, g);
		await svc.write(lea, "lea", "after.txt", Buffer.from("sealed with the new key"), 0, (await svc.issueOperationIds(lea, 1))[0]);
		await svc.close();
		// losing the state now and restoring the first backup would lose after.txt's key: the newest backup holds it
		rmSync(o.stateDir, { recursive: true });
		await restoreState(join(dir, "s2.bk"), key, o);
		svc = await FilesService.open(o);
		try {
			await svc.setMode("normal");
			const h = (await svc.login("acme", "user", ID)).handle;
			assert.equal((await svc.read(h, "lea", "before.txt")).bytes.toString(), "sealed with the old key");
			assert.equal((await svc.read(h, "lea", "after.txt")).bytes.toString(), "sealed with the new key");
		} finally { await svc.close(); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
