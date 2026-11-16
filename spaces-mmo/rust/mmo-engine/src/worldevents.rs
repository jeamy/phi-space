//! The world's dates (`server/engine/worldevents.ts`): so far what the loader writes.
use phi_json::{obj, Json};

use crate::j;
use crate::worldtime::next_at_hour;

/// `tickJobs`: the recurring jobs and their periods in world time.
pub fn tick_jobs(w: &Json) -> Vec<(&'static str, f64)> {
	let mut out = vec![
		("fire", 15_000.0), ("fog", j::n(j::at(w, "fog"), "stepMs")), ("flood", j::n(j::at(w, "flood"), "everyMs")),
		("sweep", 10_000.0), ("orders", j::n(j::at(w, "orders"), "everyMs")), ("market", 60_000.0),
	];
	if let Some(s) = j::opt(w, "storm") { out.push(("storm", j::n(s, "everyMs"))); }
	if let Some(s) = j::opt(w, "wind") { out.push(("wind", j::n(s, "stepMs"))); }
	if j::opt(w, "garden").is_some() { out.push(("garden", 60_000.0)); }
	if let (Some(_), Some(wild)) = (j::opt(w, "garden"), j::opt(w, "wild")) { out.push(("wild", j::n(wild, "checkWorldMs"))); }
	if let Some(e) = j::opt(w, "epochs") { out.push(("epoch", j::n(e, "checkWorldMs"))); }
	out
}

/// `worldSchedules`: the dates a world defines, each with whether its period may have changed (`refresh`).
pub fn world_schedules(w: &Json, epoch: f64, after_world_ms: f64) -> Vec<(Json, bool)> {
	let mut out = Vec::new();
	if let Some(ev) = j::opt(w, "evening") {
		let hour = j::n(ev, "hour");
		out.push((obj! { "scheduleId" => "evening", "clockEpoch" => epoch, "dueWorldMs" => next_at_hour(after_world_ms, hour), "kind" => "evening", "payload" => obj! { "hour" => hour }, "missed" => "coalesce" }, true));
	}
	for (job, every) in tick_jobs(w) {
		out.push((obj! { "scheduleId" => format!("tick.{job}"), "clockEpoch" => epoch, "dueWorldMs" => after_world_ms + every, "kind" => "tick", "payload" => obj! { "job" => job, "everyMs" => every }, "missed" => "coalesce" }, true));
	}
	out
}
