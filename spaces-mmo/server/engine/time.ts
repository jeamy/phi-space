// SPACES_MMO_TIME_SCALE (default 1): real time per game time, 0.002 lets a game hour pass in 7.2 real seconds. Since the world
// has a clock (docs/weltzeit.md) it is only the starting value: a new world's clock gets `rate = 1 / timeScale()`, and from then
// on the rate stored in the clock decides (an operator changes it with `clock rate <n>`). No duration of the world is multiplied
// by it any more.

export function timeScale(): number {
	const v = Number(process.env.SPACES_MMO_TIME_SCALE);
	return Number.isFinite(v) && v > 0 ? v : 1;
}
