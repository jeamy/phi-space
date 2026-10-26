// Two fingers on the map: both views feed their pointer events in and read how far the fingers spread since the second
// one came down (or since the last `rebase`). A pinch is no tap, no long press and no drag.

export type Pinch = {
	/** A finger (or the mouse) came down; true when this one starts a pinch. */
	down(id: number, x: number, y: number): boolean;
	/** The distance of the two fingers now over the one at the start (above 1: they spread), or null without a pinch. */
	move(id: number, x: number, y: number): number | null;
	/** The current distance becomes the new start (after a zoom step). */
	rebase(): void;
	up(id: number): void;
	readonly active: boolean;
};

export function pinch(): Pinch {
	const at = new Map<number, { x: number; y: number }>();
	let base = 0;
	const dist = () => { const [a, b] = [...at.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
	return {
		down(id, x, y) { at.set(id, { x, y }); if (at.size === 2) { base = dist(); return true; } return false; },
		move(id, x, y) {
			if (!at.has(id)) return null;
			at.set(id, { x, y });
			return at.size === 2 && base > 0 ? dist() / base : null;
		},
		rebase() { base = dist(); },
		up(id) { at.delete(id); if (at.size < 2) base = 0; },
		get active() { return at.size >= 2; },
	};
}
