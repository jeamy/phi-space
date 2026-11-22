// A backup of the space's SQLite store while the space runs: VACUUM INTO writes a consistent copy in one read
// transaction (the store is in WAL mode, so the space goes on writing meanwhile). The copies are
// <dir>/forum-space-<UTC time>.sqlite; beyond FORUM_BACKUP_KEEP (default 7) the oldest are removed.
//
//   node --experimental-strip-types server/backup.ts [--db FILE] [--dir DIR]
//   default --db: FORUM_SQLITE (codemode-forum/.local/forum-space.sqlite); default --dir: <the db's directory>/backups
import { ROOT } from "./env.ts";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The store a space process of this host opens (the same default as space-host.ts). */
export const defaultDb = () => process.env.FORUM_SQLITE || join(ROOT, ".local", "forum-space.sqlite");
const PREFIX = "forum-space-";

/** Writes one backup of `db` into `dir` and keeps the newest `keep`; returns its path. */
export async function backup(o: { db?: string; dir?: string; keep?: number } = {}): Promise<{ file: string; bytes: number; removed: string[] }> {
	const db = resolve(o.db ?? defaultDb()), dir = resolve(o.dir ?? join(dirname(db), "backups"));
	await stat(db); // a store that is not there is an error, not an empty backup
	await mkdir(dir, { recursive: true });
	const file = join(dir, `${PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
	const conn = new DatabaseSync(db, { readOnly: true, timeout: 10_000 });
	try { conn.prepare("VACUUM INTO ?").run(file); }
	finally { conn.close(); }
	// the newest `keep` stay (their names sort by time)
	const keep = Math.max(1, o.keep ?? Number(process.env.FORUM_BACKUP_KEEP || 7));
	const all = (await readdir(dir)).filter((f) => f.startsWith(PREFIX) && f.endsWith(".sqlite")).sort();
	const removed = all.slice(0, Math.max(0, all.length - keep));
	for (const f of removed) await rm(join(dir, f), { force: true });
	return { file, bytes: (await stat(file)).size, removed };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
	const r = await backup({ ...(arg("--db") ? { db: arg("--db")! } : {}), ...(arg("--dir") ? { dir: arg("--dir")! } : {}) });
	console.log(`[backup] ${r.file} (${r.bytes} bytes)${r.removed.length ? `; removed ${r.removed.length} older` : ""}`);
}
