// Capacity probe of the own store (docs/umstellung-ohne-pi-durable.md, U7, decision D2): SPACES named spaces with
// ENTRIES entries each in one SQLite store; reports write time, file size, reopen time and the RSS of a process that
// opens it and touches every space once.
//   node --experimental-strip-types scripts/capacity-probe.ts [spaces=100] [entries=10000] [dir]
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { BACKGROUND_CONTEXT as ctx } from "../src/context.ts";
import { FOREVER, PhiSpaces, createSpace, openSqliteHost } from "../src/index.ts";

const [spaces, entries] = [Number(process.argv[2] ?? 100), Number(process.argv[3] ?? 10_000)];
const mb = (n: number) => Math.round(n / 1048576);
if (process.argv[2] === "--open") {
	const [, , , path, n] = process.argv;
	const t0 = performance.now(), h = await openSqliteHost(path!), open = performance.now() - t0;
	const t1 = performance.now();
	for (let i = 0; i < Number(n); i++) await new PhiSpaces(h, ctx, Date.now, undefined, undefined, { space: `s${i}` }).count({ type: "Item" });
	console.log(JSON.stringify({ openMs: Math.round(open), touchAllMs: Math.round(performance.now() - t1), rssMb: mb(process.memoryUsage().rss), heapMb: mb(process.memoryUsage().heapUsed) }));
	await h.close(ctx);
} else {
	const dir = process.argv[4] ?? mkdtempSync(join(tmpdir(), "capacity-probe-")), path = join(dir, "store.sqlite");
	try {
		const h = await openSqliteHost(path), t0 = performance.now();
		for (let i = 0; i < spaces; i++) await h.commit((tx) => createSpace(tx, `s${i}`, Date.now()), ctx);
		for (let i = 0; i < spaces; i++) {
			const s = new PhiSpaces(h, ctx, Date.now, undefined, undefined, { space: `s${i}` });
			for (let a = 0; a < entries; a += 500) await Promise.all(Array.from({ length: Math.min(500, entries - a) }, (_, k) => s.write({ type: "Item", fields: { n: a + k, pad: "x".repeat(100) } }, null, FOREVER)));
		}
		const wrote = performance.now() - t0;
		await h.close(ctx);
		console.log(JSON.stringify({ spaces, entries, writeS: Math.round(wrote / 1000), fileMb: mb(statSync(path).size) }));
		const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", process.argv[1]!, "--open", path, String(spaces)], { encoding: "utf8" });
		console.log(r.stdout.trim() || r.stderr);
	} finally { if (!process.argv[4]) rmSync(dir, { recursive: true, force: true }); }
}
