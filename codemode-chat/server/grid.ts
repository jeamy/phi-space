// The grid scale of the world the bots play (spaces-mmo/docs/3d-welt-und-raster-plan-2026-11-21.en.md, section 2.2,
// "Arena and codemode-chat"): what codemode-chat keeps in cells (the episodes' cells, the fires a text names, the
// lengths behind "near", the toy islands) changes with the world's grid in one cut. At scale 2 a cell is half as wide:
// a cell of scale 1 becomes the cell point (2x, 2y), a length doubles, and a fire or an exit covers 2 × 2 cells.
// CODEMODE_GRID_SCALE says which (1 or 2; default 1); it is read once, as spaces-mmo's processes read theirs. The arena
// says its own in `open` and `map` (arenaClient refuses one that differs: there is no arena at scale 1 beside a judge
// at scale 2). codemode-chat imports nothing from spaces-mmo, so this is its own copy of the number.

const SUPPORTED = [1, 2];

function fromEnv(): number {
	const v = process.env.CODEMODE_GRID_SCALE?.trim();
	if (!v) return 1;
	const n = Number(v);
	if (!SUPPORTED.includes(n)) throw new Error(`CODEMODE_GRID_SCALE: ${SUPPORTED.join(" or ")}, not ${v}`);
	return n;
}

/** The grid scale: 1 or 2. */
export const GRID_SCALE = fromEnv();
/** A length of scale 1 (cells apart, cells of reach) at this scale. */
export const cells = (n: number): number => n * GRID_SCALE;
/** A cell of scale 1 as the cell point at this scale: its north-west cell. */
export const point = <T extends { x: number; y: number }>(c: T): T => ({ ...c, x: c.x * GRID_SCALE, y: c.y * GRID_SCALE });
/** A fire's or an exit's area beyond its cell, as the arena gives it: nothing at scale 1, `w`, `h` at scale 2. */
export const area = (): { w?: number; h?: number } => (GRID_SCALE > 1 ? { w: GRID_SCALE, h: GRID_SCALE } : {});
