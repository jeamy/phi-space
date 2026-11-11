// Online backup of the world Spaces' SQLite files (run by mmo-backup.sh inside the game image, node:sqlite): each
// world-<region>.sqlite of /d is copied page by page to /out while the Space process keeps running (SQLite's backup API
// reads one consistent state, the WAL included), then the copy is checked with quick_check. Prints one line per file;
// exits 1 if a copy is not sound.
import { DatabaseSync, backup } from "node:sqlite";
import { readdirSync, statSync } from "node:fs";

const files = readdirSync("/d").filter((f) => /^world-[a-z]+\.sqlite$/.test(f)).sort();
let bad = 0;
for (const f of files) {
	const t0 = Date.now();
	const src = new DatabaseSync(`/d/${f}`, { readOnly: true });
	const pages = await backup(src, `/out/${f}`);
	src.close();
	const copy = new DatabaseSync(`/out/${f}`, { readOnly: true });
	const check = String(Object.values(copy.prepare("pragma quick_check").get())[0]);
	copy.close();
	if (check !== "ok") bad++;
	console.log(`${f} pages=${pages} bytes=${statSync(`/out/${f}`).size} ms=${Date.now() - t0} check=${check}`);
}
if (!files.length) { console.log("no world-*.sqlite in /d"); bad++; }
process.exit(bad ? 1 : 0);
