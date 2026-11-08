//! World time (`shared/worldtime.ts`, `server/engine/worldtime.ts`): the clock entry and what follows from it.
use phi_json::{obj, Json};

use crate::j;
use crate::source::time_now;

pub const WORLD_MINUTE_MS: f64 = 60_000.0;
pub const WORLD_HOUR_MS: f64 = 60.0 * WORLD_MINUTE_MS;
pub const WORLD_DAY_MS: f64 = 24.0 * WORLD_HOUR_MS;
pub const CLOCK_VERSION: f64 = 1.0;
pub const DEFAULT_START_HOUR: f64 = 8.0;
pub const MIN_RATE: f64 = 0.001;
pub const MAX_RATE: f64 = 100_000.0;

/// `worldNow(clock, realNow)`.
pub fn world_at(clock: &Json, real_now: f64) -> f64 {
	if j::b(clock, "paused") { return j::n(clock, "worldAnchorMs"); }
	j::n(clock, "worldAnchorMs") + (real_now - j::n(clock, "realAnchorMs")) * j::n(clock, "rate")
}
/// `worldNow(clock)` at the engine's time.
pub fn world_now(clock: &Json) -> f64 { world_at(clock, time_now()) }

/// `decayNow(clock, realNow)`.
pub fn decay_at(clock: &Json, real_now: f64) -> f64 {
	let (Some(anchor), Some(rate)) = (j::no(clock, "decayAnchorMs"), j::no(clock, "decayRate")) else { return world_at(clock, real_now) };
	if j::b(clock, "paused") { return anchor; }
	anchor + (real_now - j::n(clock, "realAnchorMs")) * rate
}
pub fn decay_now(clock: &Json) -> f64 { decay_at(clock, time_now()) }

fn clamp_rate(rate: f64) -> f64 { MAX_RATE.min(MIN_RATE.max(rate)) }

/// `initialClock`.
pub fn initial_clock(world_id: &str, start_hour: f64, real_now: f64, time_scale: f64) -> Json {
	obj! { "worldId" => world_id, "epoch" => 1.0, "realAnchorMs" => real_now, "worldAnchorMs" => start_hour * WORLD_HOUR_MS, "rate" => clamp_rate(1.0 / time_scale), "paused" => false, "version" => CLOCK_VERSION }
}

/// `nextAtHour`: the first world time strictly after `after_ms` at which the clock shows `hour` o'clock.
pub fn next_at_hour(after_ms: f64, hour: f64) -> f64 {
	let day = (after_ms / WORLD_DAY_MS).floor();
	for d in [day, day + 1.0] {
		let at = d * WORLD_DAY_MS + hour * WORLD_HOUR_MS;
		if at > after_ms { return at; }
	}
	(day + 2.0) * WORLD_DAY_MS + hour * WORLD_HOUR_MS
}

/// `timeScale()` (`server/engine/time.ts`): SPACES_MMO_TIME_SCALE when it is a positive number, else 1.
pub fn time_scale() -> f64 {
	let v = std::env::var("SPACES_MMO_TIME_SCALE").map_or(f64::NAN, |s| j::number(&Json::from(s)));
	if v.is_finite() && v > 0.0 { v } else { 1.0 }
}
