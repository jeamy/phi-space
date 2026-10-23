// Maintenance of an exclusively owned, stopped own SQLite store (store/sqlite.ts) after an erasure (data-admin): the
// store keeps no revision history (a row is overwritten or deleted), but the bytes of deleted rows can remain in free
// pages and in the WAL. With secure_delete the file is rewritten (VACUUM) and the WAL emptied, under the owner lock and
// the caller's fencing check, then checked for integrity. Public as compactErasedSqlite (erasure-sqlite.ts).
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { openFiles } from "./sqlite.ts";

export async function compactErasedOwnStore(path: string, assertExclusiveFenced: () => Promise<void>): Promise<{ documents: number; revisionsRemoved: number; pagesBefore: number; pagesAfter: number; completed: true }> {
	await assertExclusiveFenced();
	const absolute = resolve(path), stat = lstatSync(absolute);
	if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(absolute) !== absolute) throw new Error("owned regular SQLite file required");
	// the owner lock and the format check: a running host or a store of another program is refused
	const { read: db, lock } = openFiles(absolute);
	try {
		db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON");
		const pages = () => (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
		const checkpoint = (what: string) => { const c = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | undefined; if (c && Number(c.busy) !== 0) throw new Error(`${what} checkpoint is busy; remain fenced`); };
		checkpoint("SQLite history");
		const pagesBefore = pages();
		db.exec("VACUUM");
		checkpoint("compacted SQLite");
		await assertExclusiveFenced();
		if ((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check !== "ok") throw new Error("compacted SQLite integrity check failed");
		// no document has a revision history here (the result keeps its earlier shape)
		return { documents: 0, revisionsRemoved: 0, pagesBefore, pagesAfter: pages(), completed: true };
	} finally {
		db.close();
		try { lock.exec("ROLLBACK"); } catch { /* ends with the connection */ }
		lock.close();
	}
}
