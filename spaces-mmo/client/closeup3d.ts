export const closeBlur = (zoom: number): number => {
	const k = Math.max(0, Math.min(1, (zoom - 2) / 3));
	return k * k * (3 - 2 * k);
};

export const nearDetail = (zoom: number, distance: number, wasNear: boolean): boolean => zoom >= 2 && distance < (wasNear ? 18 : 16);

export function detailCells(ground: string[], x: number, y: number): Array<{ x: number; y: number }> {
	const cells: Array<{ x: number; y: number }> = [];
	for (let yy = Math.max(0, y - 4); yy <= Math.min(ground.length - 1, y + 4); yy++)
		for (let xx = Math.max(0, x - 4); xx <= Math.min((ground[yy]?.length ?? 0) - 1, x + 4); xx++)
			if (ground[yy]![xx] === ":" && Math.hypot(xx - x, yy - y) <= 4) cells.push({ x: xx, y: yy });
	return cells.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y)).slice(0, 24);
}

export function frameSummary(times: number[], calls: number[], triangles: number, geometries: number) {
	const sorted = [...times].sort((a, b) => a - b), count = times.length;
	return {
		frames: count, fps: count ? 1000 * count / times.reduce((a, b) => a + b, 0) : 0,
		p50Ms: sorted[Math.max(0, Math.ceil(count * 0.5) - 1)] ?? 0,
		p95Ms: sorted[Math.max(0, Math.ceil(count * 0.95) - 1)] ?? 0,
		p99Ms: sorted[Math.max(0, Math.ceil(count * 0.99) - 1)] ?? 0,
		drawCalls: calls.length ? calls.reduce((a, b) => a + b, 0) / calls.length : 0,
		triangles, geometries,
	};
}

/** The picture's resolution follows the frame rate, on every device (3D v3: one quality level, the resolution is what
 *  gives): below `slow` milliseconds a frame for a second, it drops by `step`; when frames come faster than `fast` for
 *  `hold` seconds, it rises again, up to the screen's. Never below `floor` pixels per CSS pixel. A drop that brings no
 *  faster frames (the browser holds the page to 30 frames, a phone saving power) is taken back, and the resolution stays
 *  for `rest` seconds; so does it when a rise makes frames slow again. */
export const SHARP = { slow: 1000 / 42, fast: 1000 / 56, step: 0.85, min: 0.5, floor: 0.75, hold: 4, rest: 30 };
/** The shadow map's side in texels by how far the picture's resolution gave way (`scale`, 1 to SHARP.min): it gives
 *  way with the picture. A phone that draws the picture at half the screen's resolution drew a map of 4096² texels for
 *  it at every frame something moved; a quarter of that is still finer than the picture's own pixels. */
export const shadowSizeAt = (scale: number): number => (scale > 0.8 ? 4096 : scale > 0.55 ? 2048 : 1024);
export type Sharpness = { scale: number; sum: number; frames: number; at: number; good: number; before: number | null; restUntil: number; rose: number };
export const sharpness = (): Sharpness => ({ scale: 1, sum: 0, frames: 0, at: 0, good: 0, before: null, restUntil: 0, rose: -Infinity });
/** Counts one frame (`elapsed` ms since the last); once a second decides. Returns whether the scale changed. */
export function sharpen(p: Sharpness, elapsed: number, now: number): boolean {
	if (elapsed > 1000) { p.sum = p.frames = 0; p.at = now; return false; } // a stall (a tab in the background, a new room)
	p.sum += elapsed; p.frames++;
	if (now - p.at < 1000 || p.frames < 10) return false;
	const frame = p.sum / p.frames; p.sum = p.frames = 0; p.at = now;
	if (p.before !== null) {
		const before = p.before; p.before = null;
		// the last drop made frames no faster: not the drawing holds them back
		if (frame > before * 0.92) { p.scale = Math.min(1, p.scale / SHARP.step); p.restUntil = now + SHARP.rest * 1000; return true; }
	}
	if (now < p.restUntil) return false;
	if (frame > SHARP.slow && p.scale > SHARP.min) {
		// a rise that made it slow again: back down, and stay there a while instead of going up and down
		if (now - p.rose < (SHARP.hold + 2) * 1000) p.restUntil = now + SHARP.rest * 1000;
		p.before = frame; p.good = 0; p.scale = Math.max(SHARP.min, p.scale * SHARP.step); return true;
	}
	if (frame < SHARP.fast && p.scale < 1) { if (++p.good >= SHARP.hold) { p.good = 0; p.rose = now; p.scale = Math.min(1, p.scale / SHARP.step); return true; } }
	else p.good = 0;
	return false;
}
