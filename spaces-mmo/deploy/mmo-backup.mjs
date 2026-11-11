// Online backup of SQLite files in a volume (run by mmo-backup.sh inside the game image, node:sqlite): every file under
// /d whose path relative to /d matches the regular expression MATCH (the folder `backups` left out) is copied page by
// page to the same path under /out while its Space process keeps running (SQLite's backup API reads one consistent
// state, the WAL included), then the copy is checked with quick_check. Prints one line per file; exits 1 if a copy is not
// sound or nothing matched.
import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const match = new RegExp(process.env.MATCH ?? "^world-[a-z]+\\.sqlite$");
const walk = (dir, rel = "") => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
	const r = rel ? `${rel}/${e.name}` : e.name;
	if (e.isDirectory()) return r === "backups" ? [] : walk(dir, r);
	return e.isFile() && match.test(r) ? [r] : [];
});
const files = walk("/d").sort();
let bad = 0;
for (const f of files) {
	const t0 = Date.now();
	mkdirSync(dirname(`/out/${f}`), { recursive: true });
	const src = new DatabaseSync(`/d/${f}`, { readOnly: true });
	const pages = await backup(src, `/out/${f}`);
	src.close();
	const copy = new DatabaseSync(`/out/${f}`, { readOnly: true });
	const check = String(Object.values(copy.prepare("pragma quick_check").get())[0]);
	copy.close();
	if (check !== "ok") bad++;
	console.log(`${f} pages=${pages} bytes=${statSync(`/out/${f}`).size} ms=${Date.now() - t0} check=${check}`);
}
if (!files.length) { console.log(`nothing in /d matches ${match}`); bad++; }
process.exit(bad ? 1 : 0);
