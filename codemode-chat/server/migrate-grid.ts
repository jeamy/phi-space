// The grid migration of the codemode-chat Space (spaces-mmo/docs/3d-welt-und-raster-plan-2026-11-21.en.md, section 5 and
// phase 2 step 7): the cells it keeps go from gridScale 1 to 2 with the world's cut, offline, every process stopped.
//
//   node --experimental-strip-types server/migrate-grid.ts --space <address> [--check]
//   (npm --prefix codemode-chat run migrate:grid -- --space unix:/path/to/space.sock)
//
// What it changes, each a cell point (x, y) → (2x, 2y):
//   BotEpisode   path, jumps (pairs of steps), subgoalAt: [room, x, y] each
//   PlanMemory   path, and an observation's cells (TideSeen x, y; ChanceSeen rooms[].pieces[].x, y). Its memoryId is
//                made of its content (memory.ts memoryIdOf, observationIdOf), so it is computed anew
//   MemoryFreeze memoryIds: the old ids mapped to the new ones of the same block
//   Subgoals     subgoals[].near
// A path is the arena's turn points (spaces-mmo/server/arena.ts pathOf), and recall costs a step by its Manhattan length:
// the doubled turn points are the same way at scale 2, and its cost doubles as NEAR and JUMP_CELLS do. Nothing is
// inserted. Lengths that count rooms (`fromFire`) and everything else stay.
// What goes: BotRoom (the page's room geometry at scale 1; the next verdict stores it anew from the arena at scale 2).
// What refuses it: BotRun or BotCall entries (a durable judge's log of a run in flight: its calls are of scale 1), a
//   Process entry other than the Space's own (a process of codemode-chat is running, or died within its lease: wait
//   for it), and a GridFormat entry at gridScale 2 "running" (a migration cut off: restore the backup).
// Order: everything is computed in memory first; then the GridFormat entry { gridScale: 2, derivedFrom: 1, state:
// "running" }, the entries in transactions of at most BATCH_ENTRIES and BATCH_BYTES, each entry taken with NO_WAIT
// (one held or gone ends it), read back and compared, then "complete". A Space without a GridFormat entry is at scale 1.
// The entries written anew keep their fields (`ts` among them: the memory's order and its MAX_MEMORY eviction go by it)
// and get a fresh lease of CODEMODE_TTL_HOURS (entryLeaseMs): the Space does not tell an entry's remaining lease.
// Not migrated: text (the models' plans and critiques, chat messages, a verdict's case lines) and the bots' code; a
// bot that wrote cells of scale 1 into its code finds them wrong at scale 2, as a person would.
import { fileURLToPath } from "node:url";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import type { PathStep } from "./bottask.ts";
import { CELL_TYPES, GEOMETRY_TYPES, type GridFormatFields } from "./grid-format.ts";
import { memoryIdOf, observationIdOf } from "./memory.ts";
import type { Subgoal } from "./subgoals.ts";
import type { ChanceSeen, TideSeen } from "./toyisland.ts";

export const FROM = 1, TO = 2;
type E = { id: string; type: string; types: string[]; fields: Record<string, unknown> };
/** A change: the entry taken and what is written instead (none: it goes). */
type Change = { from: E; to: E | null };
export type GridMigrationResult = { outcome: "migrated" | "already" | "checked" | "refused"; report: string[]; notes: string[]; changed: number; dropped: number };

const DROP: readonly string[] = GEOMETRY_TYPES, REFUSE = ["BotRun", "BotCall", "Process"];
const BATCH_ENTRIES = 100, BATCH_BYTES = 64 * 1024, TXN_MS = 60_000;

const step = (s: PathStep): PathStep => [s[0], s[1] * TO, s[2] * TO];
const steps = (v: unknown): PathStep[] | undefined => (Array.isArray(v) ? (v as PathStep[]).map(step) : undefined);
const cell = <T extends { x: number; y: number }>(c: T): T => ({ ...c, x: c.x * TO, y: c.y * TO });
/** An observation at scale 2: its cells doubled, the rest (minutes, exits, fromFire: rooms, not cells) as it was. */
export function scaleObservation(o: TideSeen | ChanceSeen): TideSeen | ChanceSeen {
	return "rooms" in o ? { ...o, rooms: o.rooms.map((r) => ({ ...r, pieces: r.pieces.map(cell) })) } : cell(o);
}
const blockKey = (f: Record<string, unknown>) => `${String(f.session)}\u0000${String(f.blockId)}`;

/** What the migration would change, from the entries of the types it reads; and what refuses it. */
export function planGridMigration(entries: readonly E[]): { changes: Change[]; refusals: string[]; notes: string[] } {
	const changes: Change[] = [], refusals: string[] = [], notes: string[] = [];
	const ids = new Map<string, Map<string, string>>(); // block → old memoryId → new
	const with_ = (e: E, fields: Record<string, unknown>): Change => ({ from: e, to: { ...e, fields } });
	for (const e of entries) {
		const f = e.fields;
		if (e.type === "PlanMemory") {
			const path = steps(f.path) ?? [], obs = f.obs ? scaleObservation(f.obs as TideSeen | ChanceSeen) : undefined;
			const was = String(f.memoryId), made = f.obs ? observationIdOf(f.obs as TideSeen | ChanceSeen) : memoryIdOf(String(f.goal), f.path as PathStep[]);
			if (made !== was) notes.push(`PlanMemory ${was} in ${String(f.blockId)}: its id is not made of its content (its id stays: a judge at scale 2 does not find it a duplicate)`);
			const id = made === was ? (obs ? observationIdOf(obs) : memoryIdOf(String(f.goal), path)) : was;
			const m = ids.get(blockKey(f)) ?? new Map<string, string>();
			if (m.has(was)) refusals.push(`PlanMemory ${was} twice in block ${String(f.blockId)}`);
			m.set(was, id); ids.set(blockKey(f), m);
			changes.push(with_(e, { ...f, memoryId: id, path, ...(obs ? { obs } : {}) }));
		} else if (e.type === "BotEpisode") {
			const jumps = Array.isArray(f.jumps) ? (f.jumps as Array<[PathStep, PathStep]>).map(([a, b]) => [step(a), step(b)]) : undefined;
			changes.push(with_(e, { ...f, path: steps(f.path) ?? [], ...(jumps ? { jumps } : {}), ...(Array.isArray(f.subgoalAt) ? { subgoalAt: steps(f.subgoalAt) } : {}) }));
		} else if (e.type === "Subgoals") {
			if (!Array.isArray(f.subgoals) || !(f.subgoals as Subgoal[]).some((g) => g.near)) continue;
			changes.push(with_(e, { ...f, subgoals: (f.subgoals as Subgoal[]).map((g) => (g.near ? { ...g, near: cell(g.near) } : g)) }));
		} else if (DROP.includes(e.type)) changes.push({ from: e, to: null });
		else if (e.type === "Process" && f.role === "space") continue; // the Space's own process: it runs the migration's calls
		else if (REFUSE.includes(e.type)) refusals.push(e.type === "Process"
			? `a ${String(f.role)} process (${String(f.name ?? "")}, pid ${String(f.pid)}) is announced: stop every process of codemode-chat (or wait out the lease of one that died) and run the migration again`
			: `${e.type} ${e.id}: a durable judge's run is in flight (its calls are of scale 1): let it finish, or wait out its lease, then run the migration again`);
	}
	// the freezes name the new ids of their block; an id the block dropped since stays as it was (it names nothing either way)
	for (const e of entries.filter((x) => x.type === "MemoryFreeze")) {
		const m = ids.get(blockKey(e.fields)), was = Array.isArray(e.fields.memoryIds) ? (e.fields.memoryIds as string[]) : [];
		const now = was.map((id) => m?.get(id) ?? id);
		const gone = was.filter((id) => !m?.has(id)).length;
		if (gone) notes.push(`MemoryFreeze ${String(e.fields.freezeId)} in ${String(e.fields.blockId)}: ${gone} of its ${was.length} paths are gone already`);
		if (now.some((id, i) => id !== was[i])) changes.push(with_(e, { ...e.fields, memoryIds: now }));
	}
	return { changes, refusals, notes };
}

/** A canonical text of an entry's fields (keys sorted), to compare what was written with the plan. */
function canon(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
	if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
	return JSON.stringify(v);
}

async function inTxn<T>(space: SpaceLike, f: (txn: string) => Promise<T>): Promise<T> {
	const txn = (await space.createTransaction(TXN_MS)).id;
	try { const v = await f(txn); await space.commit(txn); return v; }
	catch (e) { await space.abort(txn).catch(() => {}); throw e; }
}

const readTypes = async (space: SpaceLike, types: readonly string[]): Promise<E[]> => (await Promise.all(types.map((type) => space.readAll({ type })))).flat() as unknown as E[];

export async function migrateGrid(space: SpaceLike, o: { check?: boolean; ttl: number; log?: (line: string) => void }): Promise<GridMigrationResult> {
	const log = o.log ?? (() => {});
	const result = (outcome: GridMigrationResult["outcome"], report: string[], more: Partial<GridMigrationResult> = {}): GridMigrationResult => ({ outcome, report, notes: [], changed: 0, dropped: 0, ...more });
	const markers = (await space.readAll({ type: "GridFormat" })).map((e) => e.fields as unknown as GridFormatFields);
	if (new Set(markers.map((x) => `${x.gridScale}/${x.state}`)).size > 1) return result("refused", [`the Space holds GridFormat entries that disagree; it is damaged, restore it from its backup`]);
	const m = markers[0];
	if (m?.gridScale === TO && m.state === "running") return result("refused", [`a grid migration of this Space was cut off (GridFormat gridScale ${TO} running): restore it from its backup and run the migration again`]);
	if (m?.gridScale === TO) return result("already", []);
	if (m && (m.gridScale !== FROM || m.state !== "complete")) return result("refused", [`the Space's GridFormat is gridScale ${m.gridScale} ${m.state}: this migration goes from ${FROM} to ${TO}`]);

	const entries = await readTypes(space, [...CELL_TYPES, ...DROP, ...REFUSE]);
	const plan = planGridMigration(entries);
	const counts = { notes: plan.notes, changed: plan.changes.filter((c) => c.to).length, dropped: plan.changes.filter((c) => !c.to).length };
	if (o.check) return result("checked", plan.refusals, counts);
	if (plan.refusals.length) return result("refused", plan.refusals, counts);

	// the marker first: from here on the Space is "running" until the last step writes "complete"
	await inTxn(space, async (txn) => {
		for (let i = 0; i < markers.length; i++) if (!(await space.takeIfExists({ type: "GridFormat" }, NO_WAIT, { txn }))) throw new Error("the GridFormat entry is gone or held: is another migration running?");
		await space.write({ type: "GridFormat", fields: { gridScale: TO, derivedFrom: FROM, state: "running" } satisfies GridFormatFields as never }, txn, FOREVER);
	});
	log(`[migrate-grid] GridFormat gridScale ${TO} running`);

	const groups: Change[][] = [];
	let batch: Change[] = [], bytes = 0;
	for (const c of plan.changes) {
		const n = c.to ? JSON.stringify(c.to.fields).length : 0;
		if (batch.length && (batch.length >= BATCH_ENTRIES || bytes + n > BATCH_BYTES)) { groups.push(batch); batch = []; bytes = 0; }
		batch.push(c); bytes += n;
	}
	if (batch.length) groups.push(batch);
	let written = 0;
	for (const g of groups) await inTxn(space, async (txn) => {
		for (const c of g) if (!(await space.takeIfExists({ id: c.from.id }, NO_WAIT, { txn }))) throw new Error(`${c.from.type} ${c.from.id} is gone or held: is a process running? restore the backup and run the migration again`);
		for (const c of g) {
			if (!c.to) continue;
			const types = c.to.types.slice(1);
			// BotRoom aside, every entry here was written with the lease of CODEMODE_TTL_HOURS
			await space.write({ type: c.to.type, ...(types.length ? { types } : {}), fields: c.to.fields as never }, txn, o.ttl);
			written++;
		}
	});
	log(`[migrate-grid] ${written} entries written in ${groups.length} transactions, ${counts.dropped} taken`);

	// read back: the entries with cells are what the plan says, nothing to drop is left
	const changed = new Set(plan.changes.map((c) => c.from.id));
	const want = [...entries.filter((e) => !changed.has(e.id) && (CELL_TYPES as readonly string[]).includes(e.type)), ...plan.changes.flatMap((c) => (c.to ? [c.to] : []))].map((e) => `${e.type} ${canon(e.fields)}`).sort();
	const now = await readTypes(space, [...CELL_TYPES, ...DROP]);
	const got = now.filter((e) => (CELL_TYPES as readonly string[]).includes(e.type)).map((e) => `${e.type} ${canon(e.fields)}`).sort();
	const differ = [...want.filter((x, i) => got[i] !== x).slice(0, 5).map((x) => `expected ${x.slice(0, 200)}`), ...(want.length !== got.length ? [`${want.length} entries with cells expected, ${got.length} found`] : [])];
	if (now.some((e) => DROP.includes(e.type))) differ.push("BotRoom entries left");
	if (differ.length) throw new Error(`the migrated Space differs (the GridFormat entry stays "running"; restore the backup):\n  ${differ.join("\n  ")}`);
	await inTxn(space, async (txn) => {
		if (!(await space.takeIfExists({ type: "GridFormat" }, NO_WAIT, { txn }))) throw new Error("the GridFormat entry is gone or held: is another migration running?");
		await space.write({ type: "GridFormat", fields: { gridScale: TO, derivedFrom: FROM, state: "complete" } satisfies GridFormatFields as never }, txn, FOREVER);
	});
	log(`[migrate-grid] GridFormat gridScale ${TO} complete`);
	return result("migrated", [], counts);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await import("./env.ts");
	const args = process.argv.slice(2);
	const at = args.indexOf("--space"), address = at >= 0 ? args[at + 1] : undefined;
	if (!address) { console.error("usage: npm run migrate:grid -- --space <address> [--check]"); process.exit(2); }
	const { connectSpace, entryLeaseMs } = await import("./space.ts");
	const { space, close } = connectSpace(address, { callTimeoutMs: 120_000 });
	try {
		const r = await migrateGrid(space, { check: args.includes("--check"), ttl: entryLeaseMs(), log: (l) => console.log(l) });
		console.log(`[migrate-grid] ${r.outcome}: ${r.changed} entries changed, ${r.dropped} taken`);
		for (const l of r.notes.slice(0, 50)) console.log(`  note: ${l}`);
		for (const l of r.report.slice(0, 200)) console.log(`  ${l}`);
		process.exitCode = r.outcome === "refused" || r.report.length ? 1 : 0;
	} finally { close(); }
}
