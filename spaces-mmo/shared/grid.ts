// A room's cells as one array (docs/3d-welt-und-raster-plan-2026-11-21.en.md section 3, "Performance strategy"): index
// y·w + x instead of "x,y" strings, for searches over a room. The Rust engine has the same (rust/mmo-engine/src/grid.rs).

/** The open cells of a room of `w` × `h` (1: open). */
export type Grid = { w: number; h: number; open: Uint8Array };

export function gridOf(w: number, h: number, open: (x: number, y: number) => boolean): Grid {
	const cells = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (open(x, y)) cells[y * w + x] = 1;
	return { w, h, open: cells };
}

/** The connected parts of the open cells (four neighbours): a label per cell, the same for cells of one part, -1 for a
 *  closed cell. Labels count from 0 in the order the parts are first met, row by row. */
export function components(g: Grid): Int32Array {
	const label = new Int32Array(g.w * g.h).fill(-1), queue = new Int32Array(g.w * g.h);
	let next = 0;
	for (let first = 0; first < g.open.length; first++) {
		if (!g.open[first] || label[first] !== -1) continue;
		let head = 0, tail = 0;
		label[first] = next; queue[tail++] = first;
		while (head < tail) {
			const at = queue[head++]!, x = at % g.w;
			const near = [x + 1 < g.w ? at + 1 : -1, x > 0 ? at - 1 : -1, at + g.w < g.open.length ? at + g.w : -1, at - g.w];
			for (const n of near) if (n >= 0 && g.open[n] && label[n] === -1) { label[n] = next; queue[tail++] = n; }
		}
		next++;
	}
	return label;
}
