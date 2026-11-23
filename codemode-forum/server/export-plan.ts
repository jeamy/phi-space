// Writes the result of a plan task to a file: the plan and its generated appendix (export.ts), read from the running
// space. The person runs this; no process of the forum writes into a repository
// (docs/gemeinsame-planung-plan-2026-11-22.en.md, section 11).
//
//   node --experimental-strip-types server/export-plan.ts --room <room> --block <id> --out <file>
//        [--table A|B] [--version N] [--plain] [--space unix:/path.sock|tcp:HOST:PORT]
//   without --table and --version: the result (what a person accepted, else the result of the run with both tables,
//   else what a table accepted, else the newest draft); --plain leaves the appendix out;
//   default --space: FORUM_SPACE (unix:/tmp/codemode-forum-space.sock)
import "./env.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SpaceLike } from "phi-spaces";
import { exportPlan } from "./export.ts";
import { connectSpace } from "./space.ts";

/** Writes the export of `block` in `room` to `out`; returns what was written. Throws when there is no document. */
export async function writeExport(space: SpaceLike, o: { room: string; block: string; out: string; table?: "A" | "B"; version?: number; plain?: boolean }): Promise<{ file: string; bytes: number; table: string; version: number; how: string }> {
	const x = await exportPlan(space, o.room, o.block, { ...(o.table ? { table: o.table } : {}), ...(o.version !== undefined ? { version: o.version } : {}) });
	if (!x) throw new Error(`no document for block ${o.block} in room ${o.room}${o.table || o.version !== undefined ? " at that table and version" : ""}`);
	const file = resolve(o.out), text = o.plain ? x.plan : x.markdown;
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, text, "utf8");
	return { file, bytes: Buffer.byteLength(text, "utf8"), table: x.chosen.table, version: x.chosen.version, how: x.chosen.how };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
	const room = arg("--room"), block = arg("--block"), out = arg("--out"), table = arg("--table"), version = arg("--version");
	if (!room || !block || !out || (table && table !== "A" && table !== "B") || (version && !/^\d{1,6}$/.test(version))) {
		console.error("usage: export-plan.ts --room <room> --block <id> --out <file> [--table A|B] [--version N] [--plain] [--space ADDRESS]");
		process.exit(2);
	}
	const conn = connectSpace(arg("--space"));
	try {
		const r = await writeExport(conn.space, { room, block, out, ...(table ? { table: table as "A" | "B" } : {}), ...(version ? { version: Number(version) } : {}), plain: process.argv.includes("--plain") });
		console.log(`[export] ${r.file} (${r.bytes} bytes): table ${r.table}, version ${r.version} (${r.how})`);
	} catch (e) { console.error(`[export] ${(e as Error).message}`); process.exitCode = 1; }
	finally { conn.close(); }
}
