// Two fingers on the map: both views feed their pointer events in and read how far the fingers spread since the second
// one came down (or since the last `rebase`). A pinch is no tap, no long press and no drag.

export type Pinch = {
	/** A finger (or the mouse) came down; true when this one starts a pinch. */
	down(id: number, x: number, y: number): boolean;
	/** The distance of the two fingers now over the one at the start (above 1: they spread), or null without a pinch. */
	move(id: number, x: number, y: number): number | null;
	/** The point between the two fingers. */
	readonly center: { x: number; y: number } | null;
	/** How far the two fingers turned since the start, in radians (clockwise on the screen is positive). */
	readonly twist: number;
	/** The current distance and direction become the new start (after a zoom step). */
	rebase(): void;
	/** What the two fingers do, decided once they moved far enough: "tilt" when both move up or down together (and keep their
	 *  distance), "pinch" for anything else (zoom and turn), null while it is not clear yet. */
	readonly gesture: "tilt" | "pinch" | null;
	/** How far the point between the fingers went down since the last `rebase`, in px (up is negative). */
	readonly lift: number;
	up(id: number): void;
	readonly active: boolean;
};

export function pinch(): Pinch {
	const at = new Map<number, { x: number; y: number }>();
	let base = 0, baseDir = 0, baseY = 0, gesture: "tilt" | "pinch" | null = null;
	let start: Array<{ x: number; y: number }> = [];
	const centerY = () => { const [a, b] = [...at.values()]; return a && b ? (a.y + b.y) / 2 : 0; };
	/** Decided after 14 px: both fingers vertical the same way, more up/down than sideways, the distance kept within a fifth. */
	const decide = () => {
		const now = [...at.values()];
		if (gesture || now.length < 2 || start.length < 2) return;
		const d = now.map((p, i) => ({ x: p.x - start[i]!.x, y: p.y - start[i]!.y }));
		if (Math.max(...d.map((v) => Math.hypot(v.x, v.y))) < 14) return;
		const startDist = Math.hypot(start[0]!.x - start[1]!.x, start[0]!.y - start[1]!.y);
		const together = Math.sign(d[0]!.y) === Math.sign(d[1]!.y) && d.every((v) => Math.abs(v.y) > Math.abs(v.x) * 1.5);
		gesture = together && startDist > 0 && Math.abs(dist() / startDist - 1) < 0.2 ? "tilt" : "pinch";
	};
	const dist = () => { const [a, b] = [...at.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
	const dir = () => { const [a, b] = [...at.values()]; return a && b ? Math.atan2(b.y - a.y, b.x - a.x) : 0; };
	return {
		down(id, x, y) { at.set(id, { x, y }); if (at.size === 2) { base = dist(); baseDir = dir(); baseY = centerY(); gesture = null; start = [...at.values()].map((p) => ({ ...p })); return true; } return false; },
		move(id, x, y) {
			if (!at.has(id)) return null;
			at.set(id, { x, y });
			if (at.size === 2) decide();
			return at.size === 2 && base > 0 ? dist() / base : null;
		},
		rebase() { base = dist(); baseDir = dir(); baseY = centerY(); },
		get gesture() { return gesture; },
		get lift() { return at.size < 2 ? 0 : centerY() - baseY; },
		get center() { const [a, b] = [...at.values()]; return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null; },
		// the shorter way round: the direction jumps by a full turn where atan2 wraps
		get twist() { return at.size < 2 ? 0 : Math.atan2(Math.sin(dir() - baseDir), Math.cos(dir() - baseDir)); },
		up(id) { at.delete(id); if (at.size < 2) { base = 0; gesture = null; } },
		get active() { return at.size >= 2; },
	};
}
