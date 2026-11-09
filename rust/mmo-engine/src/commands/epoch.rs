//! The epochs of an island (`server/engine/commands/epoch.ts`): an island counts its held stock, every building, bed and
//! field by the light points it takes, and reaches the next epoch at a threshold.
use phi_json::{obj, Json};

use crate::clock::decay_now_of;
use crate::context::{msg, msg_transient, Ctx, MsgOpts};
use crate::fire::key_text;
use crate::j;
use crate::settings::setting;
use crate::source::time_now;
use crate::space::{fields, refuse, tmpl, Result, Space, FOREVER, NO_WAIT};

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

/// `epochFor`: the epoch a stock of `points` reaches, at most `count`.
pub fn epoch_for(points: f64, limits: &[f64], count: f64) -> f64 { count.min(1.0 + limits.iter().filter(|t| points >= **t).count() as f64) }

/// The held stock of an island: points, and of them by buildings, beds and fields.
#[derive(Debug, Clone, Copy, Default)]
pub struct Stock { pub points: f64, pub buildings: f64, pub beds: f64, pub fields: f64 }

/// `islandPoints`: the held stock of every island of this region (in the order of its rooms).
pub async fn island_points(space: &Space, w: &Json, now: f64) -> Result<Vec<(String, Stock)>> {
	let mut out: Vec<(String, Stock)> = Vec::new();
	for r in j::a(w, "rooms") { if let Some(i) = j::so(r, "island").filter(|i| !i.is_empty()) { if !out.iter().any(|(k, _)| k == i) { out.push((i.to_owned(), Stock::default())); } } }
	for (ty, what) in [("Building", 0), ("Bed", 1), ("Field", 2)] {
		for e in space.read_all(&obj! { "type" => ty }, None).await? {
			let b = fields(&e);
			if j::n(b, "untilWorldMs").partial_cmp(&now) != Some(std::cmp::Ordering::Greater) { continue; }
			let Some(i) = island_of(w, j::s(b, "room")).filter(|i| !i.is_empty()) else { continue };
			let Some((_, t)) = out.iter_mut().find(|(k, _)| *k == i) else { continue };
			let p = j::no(b, "points").unwrap_or(1.0);
			t.points += p;
			match what { 0 => t.buildings += p, 1 => t.beds += p, _ => t.fields += p }
		}
	}
	Ok(out)
}

async fn written_epoch(space: &Space, island: &str) -> Result<f64> {
	Ok(space.peek(&tmpl("Epoch", obj! { "island" => island }), None).await?.map_or(1.0, |e| j::n(fields(&e), "epoch")))
}

/// What an epoch unlocks: the plans of exactly that epoch, and the fields.
fn unlocks(w: &Json, epoch: f64) -> String {
	let mut names: Vec<String> = j::a(j::at(w, "building"), "plans").iter().filter(|p| j::no(p, "epoch").unwrap_or(1.0) == epoch).map(|p| key_text(j::at(p, "name"))).collect();
	if j::no(j::at(w, "fields"), "epoch").unwrap_or(1.0) == epoch && epoch > 1.0 { names.push("Äcker".into()); }
	names.join(", ")
}

/// `epochTick`: each island of the region whose epoch changed gets its entry written anew and is told.
pub async fn epoch_tick(space: &Space, w: &Json, lease_ms: f64) -> Result<Vec<(String, f64)>> {
	let Some(eps) = j::opt(w, "epochs") else { return Ok(vec![]) };
	let last = j::a(eps, "names").len() as f64;
	let now = decay_now_of(space, None).await?;
	let limits = thresholds(space).await?;
	let force = setting(space, "epoch.force").await?;
	let mut changed = Vec::new();
	for (island, t) in island_points(space, w, now).await? {
		let epoch = if force > 0.0 { force.min(last) } else { epoch_for(t.points, &limits, last) };
		if epoch == written_epoch(space, &island).await? { continue; }
		let txn = space.create_transaction(10_000.0).await?;
		let r: Result<bool> = async {
			let old = space.take_if_exists(&tmpl("Epoch", obj! { "island" => island.as_str() }), NO_WAIT, Some(&txn)).await?;
			let was = old.as_ref().map_or(1.0, |e| j::n(fields(e), "epoch"));
			if was == epoch { return Ok(false); }
			let e = tmpl("Epoch", obj! { "island" => island.as_str(), "epoch" => epoch, "points" => t.points, "at" => now });
			let wr = if old.is_some() { space.write(&e, Some(&txn), FOREVER).await } else { space.write_unique(&e, Some(&txn), FOREVER, &["island"]).await };
			match wr { Err(err) if err.to_string().contains("unique entry already exists") => return Ok(false), Err(err) => return Err(err), Ok(_) => {} }
			let n = phi_json::number_text(epoch);
			let text = if epoch > was {
				let u = unlocks(w, epoch);
				format!("{island} ist jetzt {} (Epoche {n}): {} lassen sich jetzt bauen.", epoch_a(w, epoch), if u.is_empty() { "neue Pläne".to_owned() } else { u })
			} else { format!("{island} ist wieder {} (Epoche {n}): zu viel ist verfallen. Was steht, arbeitet weiter; neue Pläne der höheren Stufe warten, bis der Bestand wieder reicht.", epoch_a(w, epoch)) };
			for r in j::a(w, "rooms").iter().filter(|x| j::so(x, "island") == Some(island.as_str())) {
				let m = obj! { "room" => j::at(r, "roomId").clone(), "to" => "*", "kind" => "world", "text" => text.as_str(), "from" => "", "at" => time_now() };
				space.write_with(&obj! { "type" => "Msg", "fields" => m }, Some(&txn), lease_ms, msg_transient(space, "*", "world").await).await?;
			}
			Ok(true)
		}.await;
		match r { Ok(true) => { space.commit(&txn).await?; changed.push((island, epoch)); } Ok(false) => space.abort(&txn).await?, Err(err) => { let _ = space.abort(&txn).await; return Err(err); } }
	}
	Ok(changed)
}

fn cap(t: &str) -> String { let mut ch = t.chars(); ch.next().map_or_else(String::new, |c| c.to_uppercase().chain(ch).collect()) }

/// `epoche`.
pub async fn epoche(c: &mut Ctx, _arg: &str) -> Result<()> {
	let Some(eps) = j::opt(c.w(), "epochs").cloned() else { return refuse("In dieser Welt gibt es keine Epochen.") };
	let Some(island) = island_of(c.w(), c.room()).filter(|i| !i.is_empty()) else { return refuse("Dieser Ort gehört zu keiner Insel.") };
	let now = decay_now_of(&c.space, c.txn()).await?;
	let limits = thresholds(&c.space).await?;
	let t = island_points(&c.space, c.w(), now).await?.into_iter().find(|(k, _)| *k == island).map(|(_, t)| t).unwrap_or_default();
	let epoch = epoch_of(&c.space, Some(&island), c.txn()).await?;
	let last = j::a(&eps, "names").len() as f64;
	let nt = phi_json::number_text;
	let parts = format!("Bauten {}, Beete {}, Äcker {}", nt(t.buildings), nt(t.beds), nt(t.fields));
	let next = if epoch < last {
		let u = unlocks(c.w(), epoch + 1.0);
		let limit = limits.get((epoch - 1.0) as usize).filter(|_| epoch >= 1.0).map_or_else(|| "undefined".to_owned(), |l| nt(*l));
		format!(" {} braucht {limit} Punkte{}.", cap(&epoch_a(c.w(), epoch + 1.0)), if u.is_empty() { String::new() } else { format!("; dann gibt es {u}") })
	} else { String::new() };
	let forced = setting(&c.space, "epoch.force").await? > 0.0;
	let due = if forced { " (Zum Testen festgesetzt: Einstellung „Epoche erzwingen“.)" } else if epoch_for(t.points, &limits, last) != epoch { " (Die Zählung holt das bald nach.)" } else { "" };
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &format!("{island} ist {} (Epoche {}): {} Punkte gehaltener Bestand ({parts}).{next}{due}", epoch_a(c.w(), epoch), nt(epoch), nt(t.points)), MsgOpts::default()).await
}
