// Read-only test-bed inspection. Recovery runs on a private copy, never on a live harness directory.
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { DatabaseSync, backup } from "node:sqlite";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { core, listSpaces, snapshotSpace, type SpaceInfo } from "../../src/index.ts";

export type InspectedItem = { kind: string; id: string; type: string; state: string; value: unknown };
export type InspectedSpace = SpaceInfo & { storage: string; stats: core.SpaceStats; items: InspectedItem[]; truncated: number };
export type Inspection = {
	version: 1; capturedAt: string; root: string; spaces: InspectedSpace[]; errors: string[];
	reports: { path: string; updatedAt: string; current: boolean; value: unknown }[];
};

async function discover(root: string): Promise<{ stores: string[]; reports: string[] }> {
	const stores: string[] = [], reports: string[] = [];
	async function walk(dir: string, depth: number): Promise<void> {
		for (const e of await readdir(dir, { withFileTypes: true })) {
			if (e.isFile() && e.name === "main.jsonl") stores.push(dir);
			if (e.isFile() && e.name === "harness.sqlite") stores.push(join(dir,e.name));
			if (e.isFile() && e.name === "report.json") reports.push(join(dir, e.name));
			if (e.isDirectory() && depth < 4 && !["node_modules", ".git"].includes(e.name)) await walk(join(dir, e.name), depth + 1);
		}
	}
	await walk(root, 0);
	return { stores: stores.sort(), reports: reports.sort() };
}

async function copiedSpaces(dir: string): Promise<InspectedSpace[]> {
	let last: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		const copy = await mkdtemp(join(tmpdir(), "pi-spaces-inspect-"));
		let h: Harness | undefined;
		try {
			let storage;
			if (dir.endsWith("/harness.sqlite")) {
				const database=new DatabaseSync(dir,{readOnly:true});
				try { await backup(database,join(copy,"harness.sqlite")); } finally { database.close(); }
				storage=await openNodeSqliteStorage(join(copy,"harness.sqlite"));
			} else {
				const before=await readFile(join(dir,"main.jsonl"));
				await writeFile(join(copy,"main.jsonl"),before);
				for(const e of await readdir(dir,{withFileTypes:true}))if(e.isFile()&&/^(doc|task)-\d+\.jsonl$/.test(e.name))await cp(join(dir,e.name),join(copy,e.name));
				if(!before.equals(await readFile(join(dir,"main.jsonl"))))throw new Error("storage changed during inspection; retrying");
				storage=await openNodeJsonlStorage(copy,ctx);
			}
			h=await Harness.open(storage,{models:createModels(),registry:createRegistry()},ctx);
			const result: InspectedSpace[] = [];
			const now = Date.now();
			for (const info of await listSpaces(h, ctx)) {
				const s = await snapshotSpace(h, info.spaceId, ctx);
				if (!s) continue;
				const activeTxn = (id: string | null): boolean => !!id && !!s.txns[id] && s.txns[id].expires > now;
				const items: InspectedItem[] = s.entries.map(e => ({
					kind: "entry", id: e.id, type: e.type,
					state: e.expires <= now || (e.writtenUnder && !activeTxn(e.writtenUnder)) ? "expired" : e.writtenUnder ? "uncommitted" : activeTxn(e.takenBy) ? "reserved" : e.readBy.some(activeTxn) ? "read-locked" : "visible",
					value: e,
				}));
				for (const [kind, records] of [
					["txn", Object.values(s.txns)], ["notify", s.regs], ["waiter", s.waiters], ["outbox", s.outbox],
				] as const) for (const r of records) items.push({ kind, id: "id" in r ? String(r.id) : String(r.eventId), type: kind, state: "stored", value: r });
				for (const [id, c] of Object.entries(s.rpc?.claims ?? {})) items.push({ kind: "claim", id, type: c.method, state: c.state, value: c });
				for(const[id,c]of Object.entries(s.restoredClaims??{}))items.push({kind:"historical-claim",id,type:c.method,state:c.state==="pending"?"unknownOutcome":c.state,value:c});
				for(const id of Object.keys(s.invalidGenerations??{}))items.push({kind:"generation",id,type:"generation",state:"invalidated",value:{generation:id}});
				if(s.restore)items.push({kind:"restore",id:s.restore.recoveryId,type:s.restore.kind,state:s.restore.stage,value:s.restore});
				if(s.authorityTransition)items.push({kind:"authority-transition",id:s.authorityTransition.recoveryId,type:"authority",state:s.authorityTransition.stage,value:s.authorityTransition});
				result.push({ ...info, storage: dir, stats: core.stats(s, now), items: items.slice(0, 20_000), truncated: Math.max(0, items.length - 20_000) });
			}
			return result;
		} catch (e) { last = e; }
		finally { await h?.close(ctx); await rm(copy, { recursive: true, force: true }); }
	}
	throw last;
}

export async function inspect(root: string, reportsOnly = false): Promise<Inspection> {
	const output: Inspection = { version: 1, capturedAt: new Date().toISOString(), root: resolve(root), spaces: [], errors: [], reports: [] };
	let found;
	try { found = await discover(output.root); }
	catch (e) { output.errors.push(`${output.root}: ${(e as Error).message}`); return output; }
	if (!reportsOnly) for (const dir of found.stores) {
		try { output.spaces.push(...await copiedSpaces(dir)); }
		catch (e) { output.errors.push(`${dir}: ${(e as Error).message}`); }
	}
	for (const path of found.reports) {
		try {
			const value = JSON.parse(await readFile(path, "utf8"));
			let current = false;
			try { current = JSON.parse(await readFile(join(path, "../phone.json"), "utf8")).config.runId === value.runId; } catch { /* Unknown provenance remains non-current. */ }
			output.reports.push({ path, updatedAt: (await stat(path)).mtime.toISOString(), current, value });
		} catch (e) { output.errors.push(`${path}: ${(e as Error).message}`); }
	}
	return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	const root = args[0] ?? "/data";
	if (args.slice(1).some(a => a !== "--reports-only")) throw new Error("usage: inspect.mjs [root] [--reports-only]");
	const result = await inspect(root, args.includes("--reports-only"));
	console.log(JSON.stringify(result));
	process.exitCode = result.errors.length ? 1 : 0;
}
