// The game's cells in the 3D view's world units (docs/3d-welt-und-raster-plan-2026-11-21.en.md section 3, "3D"): a
// cell's edge is 1 / gridScale world units, so a room covers the same ground at both scales, and the middle of a cell
// lies half an edge from its border. Heights, model sizes and everything else made of world units stay as they are; a
// figure or a thing on one cell keeps the size of a cell of scale 1. The forward and the inverse transform share the
// room's origin (its middle), so a tap names the cell a thing stands on.
import { gridScale } from "../shared/rules.ts";

/** The edge of a cell in world units: 1 at scale 1, 0.5 at scale 2. */
export const cellEdge = (): number => 1 / gridScale();

/** The world x (or z) of the middle of cell `x` of a room `w` cells wide; a fraction of a cell (a figure on its way, the
 *  middle of an area) maps the same way. At scale 1 it is the old `x - w / 2 + 0.5` to the bit. */
export const toWorld = (x: number, w: number, e = cellEdge()): number => (x - w / 2 + 0.5) * e;

/** The world x (or z) of a cell's border: `x` cells from the room's west (north) edge. */
export const borderWorld = (x: number, w: number, e = cellEdge()): number => (x - w / 2) * e;

/** The cell a world x (or z) lies in (the inverse of toWorld), whether or not it lies inside the room. */
export const toCell = (wx: number, w: number, e = cellEdge()): number => Math.floor(wx / e + w / 2);

/** How far a terrace's corner rounds in plan (world units; terraces3d.ts). */
export const CORNER = 0.42;
/** The same in cells: CORNER, at most 0.45 of a cell. */
export const cornerCells = (e = cellEdge()): number => Math.min(CORNER / e, 0.45);

/** How far a terrace's rounded edge reaches in from its side, in world units: `size` (terrace.ts), at most 0.45 of a cell,
 *  so a strip one cell wide keeps a top. */
export const edgeSize = (size: number, e = cellEdge()): number => Math.min(size, 0.45 * e);
