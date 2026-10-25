// Game time: every duration of the world (burn time, fog steps, the tide) is multiplied by SPACES_MMO_TIME_SCALE
// (default 1), so a test plays an hour in seconds. Lease and session times of the system are not game time.

export function timeScale(): number {
	const v = Number(process.env.SPACES_MMO_TIME_SCALE);
	return Number.isFinite(v) && v > 0 ? v : 1;
}

/** A world duration in real milliseconds, at least `min`. */
export const gameMs = (ms: number, min = 50): number => Math.max(min, Math.round(ms * timeScale()));
