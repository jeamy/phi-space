// The start check of the grid format (docs/3d-welt-und-raster-plan-2026-11-21.en.md section 5, "Start condition"): before a
// process writes to a world or region space it reads the store's GridFormat entry and the entry types it holds and
// refuses a store this binary cannot run. It only reads; the loader writes an empty store's GridFormat entry (loader.ts),
// the migration a migrated one's (scripts/migrate-footprints.ts).
import type { SpaceLike } from "phi-spaces";
import { gridRefusal, type GridFormatFields } from "../../shared/grid-format.ts";
import type { WorldDef } from "./world.ts";

export class GridFormatRefused extends Error {}

/** Runs the check until the space answers (a process may start before its space): a refusal is thrown at once, any
 *  other error is tried again after `retryMs`, `tries` times. */
export async function awaitGridFormat(space: SpaceLike, w: Pick<WorldDef, "id" | "gridScale" | "derivedFrom" | "typeclasses">, o: { tries?: number; retryMs?: number } = {}): Promise<void> {
	for (let i = 1; ; i++) {
		try { return await checkGridFormat(space, w); } catch (e) {
			if (e instanceof GridFormatRefused || i >= (o.tries ?? 60)) throw e;
			await new Promise((r) => setTimeout(r, o.retryMs ?? 1000));
		}
	}
}

/** Throws GridFormatRefused when `space` holds a store in a grid format this binary does not run. */
export async function checkGridFormat(space: SpaceLike, w: Pick<WorldDef, "id" | "gridScale" | "derivedFrom" | "typeclasses">): Promise<void> {
	const markers = (await space.readAll({ type: "GridFormat" })).map((e) => e.fields as unknown as GridFormatFields);
	const types = Object.keys((await space.stats()).byType);
	const why = gridRefusal(w, markers, types);
	if (why) throw new GridFormatRefused(`grid format: ${why}`);
}
