// What a finger means on the map, and names that do not cover one another (docs/3d-welt-und-raster-plan-2026-11-21.en.md
// section 3, "2D", and section 2.3, decision 1). At scale 2 a cell is 16 pixels at nominal zoom, less than a finger: a
// tap on free ground names the cell under it, but a tap within TOUCH_PX of a figure, a thing or an exit names that
// instead. The radius is in screen pixels, the same in 2D and 3D; a mouse points exactly and keeps the cell. Four
// figures side by side carry four names: each is lifted, in screen pixels, until it covers no other. Pure: the views
// give the screen positions.
import type { CharView, ObjView } from "../shared/frames.ts";

/** How far from a figure, a thing or an exit a finger still names it (CSS pixels on the screen). */
export const TOUCH_PX = 24;

type Cell = { x: number; y: number };
/** Something a finger may mean: the cells it covers, and whether it is a figure (its body stands above its cell). */
export type TouchTarget = { cells: Cell[]; figure: boolean };

/** What draws nothing a finger could mean, or lies under everything (a track, a road, a zone's tint). */
const UNDER = new Set(["road", "track", "zone", "train", "liner"]);

/** The figures (not the own one: a tap beside it is a step) and the things of the room a finger may mean. */
export function touchTargets(chars: Map<string, CharView>, objs: Map<string, ObjView>, room: string, me: string): TouchTarget[] {
	const out: TouchTarget[] = [];
	for (const c of chars.values()) if (c.charId !== me) out.push({ cells: [{ x: c.x, y: c.y }], figure: true });
	for (const o of objs.values()) {
		if (o.location !== room || UNDER.has(o.kind) || (o.through && o.kind !== "exit")) continue;
		const cells: Cell[] = [];
		for (let y = o.y; y < o.y + (o.h ?? 1); y++) for (let x = o.x; x < o.x + (o.w ?? 1); x++) cells.push({ x, y });
		out.push({ cells, figure: false });
	}
	return out;
}

/** The cell a finger names: `cell` (under the finger) when something stands on it or nothing is near; else the cell of
 *  the target nearest to the finger on the screen within `radius` (the nearest cell of an area). `screenOf(x, y, body)`
 *  is where a cell's middle lies on the screen, or with `body` the middle of a figure standing on it. */
export function touchPick(cell: Cell | null, tap: Cell, targets: TouchTarget[], screenOf: (x: number, y: number, body: boolean) => Cell | null, radius = TOUCH_PX): Cell | null {
	if (cell && targets.some((t) => t.cells.some((c) => c.x === cell.x && c.y === cell.y))) return cell;
	let best: Cell | null = null, nearest = radius;
	for (const t of targets) for (const c of t.cells) for (const body of t.figure ? [false, true] : [false]) {
		const p = screenOf(c.x, c.y, body);
		if (!p) continue;
		const d = Math.hypot(p.x - tap.x, p.y - tap.y);
		if (d <= nearest) { nearest = d; best = c; }
	}
	return best ?? cell;
}

/** A name's box on the screen (left, top, width, height in pixels); `first` puts it before the others (the own name). */
export type LabelBox = { id: string; x: number; y: number; w: number; h: number; first?: boolean };

/** How far (pixels, up) each name is lifted so that none covers another: the own name first, then from the front (the
 *  lowest on the screen) backwards, each at the lowest of its places that is free: its own, or one, two, … names'
 *  heights higher. At most `levels` lifts; a name that finds no free place stays where it is. */
export function liftLabels(boxes: LabelBox[], levels = 6): Map<string, number> {
	const order = [...boxes].sort((a, b) => Number(!!b.first) - Number(!!a.first) || b.y - a.y || a.x - b.x);
	const placed: Array<{ x: number; y: number; w: number; h: number }> = [], out = new Map<string, number>();
	const meets = (a: { x: number; y: number; w: number; h: number }) => placed.some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
	for (const box of order) {
		let lift = 0;
		for (let k = 0; k <= levels; k++) if (!meets({ ...box, y: box.y - k * box.h })) { lift = k * box.h; break; }
		placed.push({ ...box, y: box.y - lift });
		out.set(box.id, lift);
	}
	return out;
}
