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
