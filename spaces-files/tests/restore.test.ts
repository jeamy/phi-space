// The data backup and its restore (docs/zanzibar-agent-filesystem-plan.en.md, section 6.5; phase 5 exit evidence):
// an online backup while saves go on, the restore as a journal that a crash at any step resumes, a backup whose blob
// copy misses a referenced blob closing that tenant alone, old sessions and IDs refused, and normal admission closed
// until every tenant is reconciled, with only the approved reconciler admitted meanwhile.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractArchive, newBackupKey, readBackupKey, verifyArchive, writeArchive } from "../server/archive.ts";
import { backupData, backupState, restoreData, type RestoreStep } from "../server/backup.ts";
import { FilesService } from "../server/service.ts";

const DRIVER = fileURLToPath(new URL("./support/restore-driver.ts", import.meta.url));
const code = (c: string) => (e: Error & { code?: string }) => { assert.equal(e.code, c, e.message); return true; };
const LEA = { issuer: "i", subject: "lea" }, ADM = { issuer: "i", subject: "adm" }, MAX = { issuer: "i", subject: "max" };

async function deployment() {
	const dir = mkdtempSync(join(tmpdir(), "spaces-files-rs-"));
	const o = { dataDir: join(dir, "data"), stateDir: join(dir, "state"), blobDir: join(dir, "blobs") };
	newBackupKey(join(dir, "data.key"));
	newBackupKey(join(dir, "state.key"));
	const svc = await FilesService.open(o);
	for (const t of ["acme", "globex"]) await svc.createTenant(t, { actorId: "adm", homeName: "adm", ...ADM });
	await svc.provisionActor("acme", { actorKind: "user", actorId: "adm" }, "user", "lea", "lea", LEA);
	const login = async (t: string, id: typeof LEA) => (await svc.login(t, "user", id)).handle;
	const put = async (h: string, ws: string, path: string, text: string, v: number) => svc.write(h, ws, path, Buffer.from(text), v, (await svc.issueOperationIds(h, 1))[0]);
	return { dir, o, svc, key: readBackupKey(join(dir, "data.key")), stateKey: readBackupKey(join(dir, "state.key")), keyFile: join(dir, "data.key"), login, put };
}

test("an online backup during saves, the restore, its gates and the reconciliation", async () => {
	const d = await deployment();
	let svc = d.svc;
	try {
		const lea = await d.login("acme", LEA);
		await d.put(lea, "lea", "brief.md", "v1", 0);
		const g = await d.login("globex", ADM);
		await d.put(g, "adm", "g.md", "globex", 0);
		// saves go on while the backup runs; the backup holds a consistent store and every blob it names
		const saving = (async () => { for (let v = 1; v < 6; v++) await d.put(lea, "lea", "brief.md", `v${v + 1}`, v); })();
		const b = await backupData(svc, join(d.dir, "data.bk"), d.key);
		await saving;
		assert.ok(b.blobs >= 2);
		assert.ok(verifyArchive(join(d.dir, "data.bk"), d.key).some((e) => e.name === "store/files.sqlite"));
		// after the backup: a pending retry and max's registration, both gone with the restore
		const [pending] = await svc.issueOperationIds(lea, 1);
		await svc.provisionActor("acme", { actorKind: "user", actorId: "adm" }, "user", "max", "max", MAX);
		await svc.close();

		const r = await restoreData(join(d.dir, "data.bk"), d.key, d.o);
		assert.deepEqual(r.tenants.map((t) => [t.tenantId, t.missing]), [["acme", 0], ["globex", 0]]);
		assert.equal(readdirSync(d.dir).filter((n) => n.startsWith("data.before-restore-")).length, 1, "the replaced data is kept aside");
		assert.deepEqual(await restoreData(join(d.dir, "data.bk"), d.key, d.o), r, "repeating a finished restore changes nothing");
		svc = await FilesService.open(d.o);
		assert.equal(svc.state.mode(), "maintenance");
		assert.equal(svc.state.lookupSession(lea), null, "the old session is gone");
		await assert.rejects(svc.login("acme", "user", MAX), code("unauthenticated"), "max is not in the backup");

		// a backed-up administrator proves nothing during the restore; only the approved reconciler continues
		const adm = (await svc.login("acme", "user", ADM)).handle;
		await assert.rejects(svc.listActors(adm), code("unavailable"));
		svc.state.rosterAdd("acme", "i", "adm");
		svc.state.approveReconciler("acme", "i", "adm");
		assert.equal((await svc.listActors(adm)).length, 2);
		assert.deepEqual((await svc.maintenanceList(adm, "lea", ".")).map((e) => e.name), ["brief.md"]);
		await assert.rejects(svc.listActors((await svc.login("globex", "user", ADM)).handle), code("unavailable"), "approved for acme only");
		await assert.rejects(svc.setMode("normal"), /waits for the reconciliation of acme, globex/);
		svc.state.markReconciled("acme");
		await assert.rejects(svc.setMode("normal"), /globex/);
		svc.state.markReconciled("globex");
		await svc.setMode("normal");
		assert.equal(svc.state.restoreEpoch(), null);

		const fresh = (await svc.login("acme", "user", LEA)).handle;
		await assert.rejects(svc.write(fresh, "lea", "x.md", Buffer.from("x"), 0, pending), code("operationIdRejected"), "an ID from before the restore");
		const f = await svc.read(fresh, "lea", "brief.md");
		assert.ok(f.version >= 1 && f.version <= 6, "the restored version is one the backup saw");
		assert.equal(f.bytes.toString(), `v${f.version}`);
		assert.equal((await svc.read((await svc.login("globex", "user", ADM)).handle, "adm", "g.md")).bytes.toString(), "globex");
		// the blobs newer than the store copy are orphans now, and the sweep removes them
		assert.ok((await svc.sweepBlobs("acme")) !== null);
	} finally { await svc.close().catch(() => {}); rmSync(d.dir, { recursive: true, force: true }); }
});

test("a backup whose blob copy misses a referenced blob closes that tenant alone", async () => {
	const d = await deployment();
	let svc = d.svc;
	try {
		await d.put(await d.login("acme", LEA), "lea", "a.md", "acme", 0);
		await d.put(await d.login("globex", ADM), "adm", "g.md", "globex", 0);
		await backupData(svc, join(d.dir, "full.bk"), d.key);
		await svc.close();
		// the same backup with one of acme's blobs left out
		const x = join(d.dir, "x");
		extractArchive(join(d.dir, "full.bk"), d.key, x);
		const acmeBlobs = readdirSync(join(x, "blobs", "acme"), { recursive: true }).map(String).filter((n) => /\/[A-Za-z0-9_-]{22}$/.test(n));
		const names = verifyArchive(join(d.dir, "full.bk"), d.key).map((e) => e.name).filter((n) => n !== `blobs/acme/${acmeBlobs[0]}`);
		writeArchive(join(d.dir, "holed.bk"), d.key, names.map((n) => ({ name: n, file: join(x, n) })));
		const r = await restoreData(join(d.dir, "holed.bk"), d.key, d.o);
		assert.deepEqual(r.tenants.map((t) => [t.tenantId, t.missing]), [["acme", 1], ["globex", 0]]);
		svc = await FilesService.open(d.o);
		for (const t of ["acme", "globex"]) svc.state.markReconciled(t);
		await svc.setMode("normal");
		await assert.rejects(svc.login("acme", "user", LEA).then((l) => svc.read(l.handle, "lea", "a.md")), code("unavailable"), "acme stays closed, across the restart");
		assert.deepEqual(svc.state.closedTenants().map((c) => [c.tenantId, c.reason]), [["acme", "inconsistentState"]]);
		assert.equal((await svc.read((await svc.login("globex", "user", ADM)).handle, "adm", "g.md")).bytes.toString(), "globex");
	} finally { await svc.close().catch(() => {}); rmSync(d.dir, { recursive: true, force: true }); }
});

for (const step of ["intent", "verified", "installed", "rekeyed", "checked"] as RestoreStep[]) {
	test(`a restore killed after its step "${step}" resumes to the same outcome`, async () => {
		const d = await deployment();
		let svc = d.svc;
		try {
			await d.put(await d.login("acme", LEA), "lea", "a.md", "kept", 0);
			await backupData(svc, join(d.dir, "data.bk"), d.key);
			backupState(svc, join(d.dir, "state.bk"), d.stateKey);
			await svc.close();
			const child = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", DRIVER, d.o.dataDir, d.o.stateDir, d.o.blobDir, join(d.dir, "data.bk"), d.keyFile, step], { stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			child.stdout.on("data", (c) => { out += c; });
			child.stderr.on("data", (c) => { out += c; });
			const exit = await new Promise<NodeJS.Signals | null>((r) => child.once("exit", (_c, sig) => r(sig)));
			assert.equal(exit, "SIGKILL", out);
			// a start in between finds the service closed for the restore, never in normal mode
			if (step !== "intent" && step !== "verified" && existsSync(join(d.o.dataDir, "files.sqlite"))) {
				const mid = await FilesService.open(d.o).catch(() => null);
				if (mid) { assert.equal(mid.state.mode(), "maintenance"); await mid.close(); }
			}
			const r = await restoreData(join(d.dir, "data.bk"), d.key, d.o);
			assert.deepEqual(r.tenants.map((t) => [t.tenantId, t.missing]), [["acme", 0], ["globex", 0]]);
			svc = await FilesService.open(d.o);
			assert.equal(svc.state.mode(), "maintenance");
			for (const t of ["acme", "globex"]) svc.state.markReconciled(t);
			await svc.setMode("normal");
			assert.equal((await svc.read((await svc.login("acme", "user", LEA)).handle, "lea", "a.md")).bytes.toString(), "kept");
		} finally { await svc.close().catch(() => {}); rmSync(d.dir, { recursive: true, force: true }); }
	});
}
