//! Dates in world time (`server/engine/schedule.ts`): so far what the loader writes.
use phi_json::Json;

use crate::j;
use crate::space::{by_id, fields, tmpl, Error, Result, Space, FOREVER, NO_WAIT};

/// `ensureSchedule`: writes the date unless one with its id exists; `refresh`: an existing one whose kind or payload
/// differs takes the new ones and keeps its due time. True when something was written.
pub async fn ensure_schedule(space: &Space, txn: Option<&str>, f: &Json, refresh: bool) -> Result<bool> {
	if j::s(f, "missed") == "replay-bounded" { return Err(Error::Other("missed: replay-bounded is not implemented".into())); }
	let have = match space.read_existing(&tmpl("WorldSchedule", phi_json::obj! { "scheduleId" => j::at(f, "scheduleId").clone() }), txn, 5_000.0).await {
		Ok(h) => h,
		Err(Error::StillHeld(_)) => return Ok(false),
		Err(e) => return Err(e),
	};
	if let Some(have) = have {
		let h = fields(&have);
		if !refresh || (j::at(h, "kind") == j::at(f, "kind") && j::at(h, "payload").to_json_text() == j::at(f, "payload").to_json_text() && j::at(h, "missed") == j::at(f, "missed")) { return Ok(false); }
		if space.take_if_exists(&by_id("WorldSchedule", &have), NO_WAIT, txn).await?.is_none() { return Ok(false); }
		let mut g = j::object(f);
		g.insert("dueWorldMs", j::at(h, "dueWorldMs").clone());
		g.insert("clockEpoch", j::at(h, "clockEpoch").clone());
		space.write(&phi_json::obj! { "type" => "WorldSchedule", "fields" => Json::Object(g) }, txn, FOREVER).await?;
		return Ok(true);
	}
	space.write(&phi_json::obj! { "type" => "WorldSchedule", "fields" => f.clone() }, txn, FOREVER).await?;
	Ok(true)
}
