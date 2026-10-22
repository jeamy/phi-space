// Puts a backup (backup.ts) in place of the space's SQLite store. Only while no space process serves it: the store is
// replaced as a whole, its WAL files go with it. Refuses when the space answers at CODEMODE_LISTEN or another process
// has the store open (a space in another container sees no socket here), and without --yes it only says what it would do. The store it replaces is kept next to it (<store>.before-restore-<time>).
//
//   node --experimental-strip-types server/restore.ts --from FILE [--db FILE] [--yes]
//   docker: stop the space container first, then
//     docker compose -f docker/docker-compose.yml --profile nano run --rm space \
//       node --experimental-strip-types server/restore.ts --from /data/backups/<file> --yes
import { connect } from "node:net";
import { copyFile, rename, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultDb } from "./backup.ts";
import { DEFAULT_SPACE, parseTarget } from "./space.ts";

/** Whether something answers where the space would listen (then its store is in use). */
async function spaceAnswers(spec = process.env.CODEMODE_LISTEN || DEFAULT_SPACE): Promise<boolean> {
	const target = parseTarget(spec);
	return new Promise((ok) => {
		const s = "path" in target ? connect(target.path) : connect(target.port, target.host === "0.0.0.0" ? "127.0.0.1" : target.host);
		const done = (v: boolean) => { s.destroy(); ok(v); };
		s.once("connect", () => done(true)); s.once("error", () => done(false)); setTimeout(() => done(false), 2000);
	});
}

/** `listen`: where a space process would serve the store (default CODEMODE_LISTEN). */
/** Whether another process has the store open (a space process, also one in another container on the same volume): a
 *  store in WAL mode leaves it only with exclusive access, which an open connection elsewhere denies. */
function storeInUse(db: string): boolean {
	const c = new DatabaseSync(db, { timeout: 0 });
	try { return (c.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode?: string }).journal_mode !== "delete"; }
	catch { return true; }
	finally { c.close(); }
}

export async function restore(o: { from: string; db?: string; yes?: boolean; listen?: string }): Promise<string> {
	const from = resolve(o.from), db = resolve(o.db ?? defaultDb());
	// the backup must be a readable SQLite store
	const check = new DatabaseSync(from, { readOnly: true });
	try { const r = check.prepare("PRAGMA integrity_check").get() as { integrity_check?: string }; if (r.integrity_check !== "ok") throw new Error(`the backup is damaged: ${r.integrity_check}`); }
	finally { check.close(); }
	// two looks: the space's socket (where this process can see it), and the store itself (an open connection anywhere)
	const exists = !!(await stat(db).catch(() => null));
	if ((await spaceAnswers(o.listen)) || (exists && storeInUse(db))) throw new Error("a space process serves the store right now: stop it first");
	const kept = `${db}.before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	if (!o.yes) return `would put ${from} in place of ${db} (the current store kept as ${kept}); add --yes`;
	// the store before goes aside whole, with its WAL (after a crash it holds the newest commits)
	const had = exists;
	for (const ext of ["", "-wal", "-shm"]) if (await stat(db + ext).catch(() => null)) await rename(db + ext, kept + ext);
	await copyFile(from, db);
	return `restored ${from} as ${db}${had ? ` (the store before: ${kept})` : ""}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
	if (!arg("--from")) { console.error("usage: restore.ts --from FILE [--db FILE] [--yes]"); process.exit(2); }
	try { console.log(`[restore] ${await restore({ from: arg("--from")!, ...(arg("--db") ? { db: arg("--db")! } : {}), yes: process.argv.includes("--yes") })}`); }
	catch (e) { console.error(`[restore] ${(e as Error).message}`); process.exit(1); }
}
