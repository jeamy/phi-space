//! The epochs of an island (`server/engine/commands/epoch.ts`), so far what other commands ask of them.
use phi_json::{obj, Json};

use crate::context::Ctx;
use crate::j;
use crate::settings::setting;
use crate::space::{fields, refuse, tmpl, Result, Space};

/// `islandOf`.
pub fn island_of(w: &Json, room_id: &str) -> Option<String> {
	let rooms = j::ao(w, "allRooms").unwrap_or(j::a(w, "rooms"));
	j::by(rooms, "roomId", room_id).and_then(|r| j::so(r, "island")).map(str::to_owned)
}

/// `thresholds`.
pub async fn thresholds(space: &Space) -> Result<[f64; 3]> { Ok([setting(space, "epoch.dorf").await?, setting(space, "epoch.stadt").await?, setting(space, "epoch.netz").await?]) }

/// `epochName`.
pub fn epoch_name(w: &Json, epoch: f64) -> String {
	j::a(j::at(w, "epochs"), "names").get((epoch - 1.0) as usize).filter(|_| epoch >= 1.0).and_then(Json::as_str).map_or_else(|| format!("Epoche {}", phi_json::number_text(epoch)), str::to_owned)
}
/// The epoch's name with its article.
pub fn epoch_a(w: &Json, epoch: f64) -> String {
	j::a(j::at(w, "epochs"), "a").get((epoch - 1.0) as usize).filter(|_| epoch >= 1.0).and_then(Json::as_str).map_or_else(|| format!("Epoche {}", phi_json::number_text(epoch)), str::to_owned)
}

/// `epochOf`: an island's epoch as written (1 without an entry; the admin's forcing first).
pub async fn epoch_of(space: &Space, island: Option<&str>, txn: Option<&str>) -> Result<f64> {
	let Some(island) = island else { return Ok(1.0) };
	let forced = setting(space, "epoch.force").await?;
	if forced > 0.0 { return Ok(forced); }
	Ok(space.peek(&tmpl("Epoch", obj! { "island" => island }), txn).await?.map_or(1.0, |e| j::n(fields(&e), "epoch")))
}

/// `needEpoch`: refuses unless the island has reached `need`.
pub async fn need_epoch(c: &Ctx, need: Option<f64>, what: &str) -> Result<()> {
	let Some(need) = need.filter(|n| *n > 1.0) else { return Ok(()) };
	if j::opt(c.w(), "epochs").is_none() { return Ok(()); }
	let island = island_of(c.w(), c.room());
	let have = epoch_of(&c.space, island.as_deref(), c.txn()).await?;
	if have >= need { return Ok(()); }
	let limit = thresholds(&c.space).await?.get((need - 2.0) as usize).copied().unwrap_or(0.0);
	refuse(format!("{what} braucht {} (Epoche {}); {} hat noch nicht genug Bestand (ab {} Punkten; „epoche“ zeigt, wie viele es sind).", epoch_a(c.w(), need), phi_json::number_text(need), island.as_deref().unwrap_or("diese Insel"), phi_json::number_text(limit)))
}
