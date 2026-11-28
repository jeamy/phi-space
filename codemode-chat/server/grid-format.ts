// The start check of the grid format (spaces-mmo/docs/3d-welt-und-raster-plan-2026-11-21.en.md section 5, "Start
// condition"): before a process of codemode-chat works on the Space it reads the Space's GridFormat entry and refuses a
// Space whose cells are of another scale than its own CODEMODE_GRID_SCALE (grid.ts).
//
//   no entry                          the Space is at scale 1 (as before the cut)
//   { gridScale, state: "complete" }  at that scale (the migration, server/migrate-grid.ts, or a Space begun at 2)
//   { gridScale: 2, state: "running" } a migration is running or was cut off: no process starts on it
//
// A process at scale 1 never writes the entry, so a binary of today runs on today's Space unchanged. A process at
// scale 2 that finds no entry and no entry with cells (CELL_TYPES, BotRoom) begins the Space at 2: it writes
// { gridScale: 2, state: "complete" } (unique by gridScale, so two that start at once write one). One with cells of
// scale 1 refuses and names the migration.
import type { SpaceLike } from "phi-spaces";
import { FOREVER } from "phi-spaces";
import { GRID_SCALE } from "./grid.ts";

export type GridFormatFields = { gridScale: number; derivedFrom?: number; state: "running" | "complete" };
/** The types that hold cells (the migration converts them), and the rooms' geometry of the page (it takes them). */
export const CELL_TYPES = ["BotEpisode", "PlanMemory", "MemoryFreeze", "Subgoals"] as const;
export const GEOMETRY_TYPES = ["BotRoom"] as const;

export class GridFormatRefused extends Error {}

/** Why a process at `scale` does not start on a Space with these GridFormat entries and entry types; null: it starts
 *  (`begin`: it writes the entry of a Space begun at `scale` first). */
export function gridRefusal(scale: number, markers: GridFormatFields[], types: readonly string[]): { why: string } | { begin: boolean } {
	const kinds = new Set(markers.map((m) => `${m.gridScale}/${m.state}`));
	if (kinds.size > 1) return { why: `the Space holds GridFormat entries that disagree (${[...kinds].join(", ")}); it is damaged, restore it from its backup` };
	const m = markers[0];
	if (m?.state === "running") return { why: `a grid migration to gridScale ${m.gridScale} is running or was cut off (GridFormat "running"): let it finish, or restore the Space from its backup and run it again` };
	const at = m?.gridScale ?? 1;
	if (at === scale) return { begin: false };
	if (at > scale) return { why: `the Space is at gridScale ${at}, this process at ${scale}: set CODEMODE_GRID_SCALE=${at}` };
	const cells = types.filter((t) => ([...CELL_TYPES, ...GEOMETRY_TYPES] as readonly string[]).includes(t));
	if (!m && !cells.length) return { begin: true };
	return { why: `the Space is at gridScale ${at}${cells.length ? ` (it holds ${cells.join(", ")})` : ""}, this process at ${scale}: stop every process of codemode-chat and run npm --prefix codemode-chat run migrate:grid -- --space <address>` };
}

/** Throws GridFormatRefused when the Space is of another grid scale than this process. */
export async function checkGridFormat(space: SpaceLike, scale = GRID_SCALE): Promise<void> {
	const read = async () => ({ markers: (await space.readAll({ type: "GridFormat" })).map((e) => e.fields as unknown as GridFormatFields), types: Object.keys((await space.stats()).byType) });
	let s = await read(), r = gridRefusal(scale, s.markers, s.types);
	if ("begin" in r && r.begin) {
		try { await space.write({ type: "GridFormat", fields: { gridScale: scale, state: "complete" } satisfies GridFormatFields as never }, null, FOREVER, { unique: ["gridScale"] }); }
		catch (e) { if (!/unique/i.test((e as Error).message)) throw e; }
		s = await read(); r = gridRefusal(scale, s.markers, s.types);
	}
	if ("why" in r) throw new GridFormatRefused(`grid format: ${r.why}`);
}

/** The check until the Space answers (a process may start before its Space): a refusal is thrown at once, any other
 *  error is tried again after `retryMs`, `tries` times. */
export async function awaitGridFormat(space: SpaceLike, o: { tries?: number; retryMs?: number; scale?: number } = {}): Promise<void> {
	for (let i = 1; ; i++) {
		try { return await checkGridFormat(space, o.scale); } catch (e) {
			if (e instanceof GridFormatRefused || i >= (o.tries ?? 120)) throw e;
			await new Promise((r) => setTimeout(r, o.retryMs ?? 1000));
		}
	}
}
