//! Wind (`server/engine/commands/wind.ts`): each island has a level that moves a step now and then, from a lull to a gale;
//! a storm surge makes it a gale at once. A mill grinds by the wind that blows when the load comes. `wetter` tells it.
use phi_json::{obj, Json};

use crate::context::{msg, msg_transient, room_of, Ctx, MsgOpts};
use crate::fire::key_text;
use crate::j;
use crate::source::{random_int, time_now};
use crate::space::{fields, tmpl, refuse, Result, Space, FOREVER, NO_WAIT};

const BREEZE: f64 = 1.0;
async fn level_of(space: &Space, island: Option<&str>, txn: Option<&str>) -> Result<f64> {
	let Some(island) = island.filter(|i| !i.is_empty()) else { return Ok(BREEZE) };
	Ok(space.peek(&tmpl("Wind", obj! { "island" => island }), txn).await?.map_or(BREEZE, |e| j::n(fields(&e), "level")))
}
fn island_of<'a>(w: &'a Json, room: &str) -> Option<&'a str> { j::by(j::a(w, "rooms"), "roomId", room).and_then(|r| j::so(r, "island")).filter(|i| !i.is_empty()) }
/// `windFactor`: how fast a mill in `room` grinds now (1 is its plain pace).
pub async fn wind_factor(space: &Space, w: &Json, room: &str, txn: Option<&str>) -> Result<f64> {
	let Some(d) = j::opt(w, "wind") else { return Ok(1.0) };
	let level = level_of(space, island_of(w, room), txn).await?;
	Ok(j::a(d, "mill").get(level as usize).filter(|_| level >= 0.0 && level.fract() == 0.0).and_then(Json::as_f64).unwrap_or(1.0))
}

async fn set_level(space: &Space, w: &Json, island: &str, level: f64, lease_ms: f64) -> Result<bool> {
	let txn = space.create_transaction(10_000.0).await?;
	let r: Result<bool> = async {
		let was = space.take_if_exists(&tmpl("Wind", obj! { "island" => island }), NO_WAIT, Some(&txn)).await?;
		let before = was.map_or(BREEZE, |e| j::n(fields(&e), "level"));
		if before == level { return Ok(false); }
		space.write(&tmpl("Wind", obj! { "island" => island, "level" => level }), Some(&txn), FOREVER).await?;
		let top = j::a(j::at(w, "wind"), "names").len() as f64 - 1.0;
		let text = if level == top { format!("Über {island} frischt der Wind zum Sturm auf.") } else if before == top { format!("Über {island} lässt der Sturm nach.") } else { String::new() };
		if !text.is_empty() {
			for r in j::a(w, "rooms").iter().filter(|x| j::so(x, "island") == Some(island)) {
				let m = obj! { "room" => j::at(r, "roomId").clone(), "to" => "*", "kind" => "world", "text" => text.as_str(), "from" => "", "at" => time_now() };
				space.write_with(&obj! { "type" => "Msg", "fields" => m }, Some(&txn), lease_ms, msg_transient(space, "*", "world").await).await?;
			}
		}
		Ok(true)
	}.await;
	match r {
		Ok(true) => { space.commit(&txn).await?; Ok(true) }
		Ok(false) => { space.abort(&txn).await?; Ok(false) }
		Err(e) => { let _ = space.abort(&txn).await; Err(e) }
	}
}

/// `windTick`: each island's wind moves a step up, a step down or stays. How many changed.
pub async fn wind_tick(space: &Space, w: &Json, lease_ms: f64) -> Result<f64> {
	let Some(d) = j::opt(w, "wind") else { return Ok(0.0) };
	let top = j::a(d, "names").len() as f64 - 1.0;
	let mut islands: Vec<&str> = Vec::new();
	for r in j::a(w, "rooms") { if let Some(i) = j::so(r, "island").filter(|i| !i.is_empty()) { if !islands.contains(&i) { islands.push(i); } } }
	let mut changed = 0.0;
	for island in islands {
		let level = level_of(space, Some(island), None).await?;
		let next = 0f64.max(top.min(level + random_int(0.0, 3.0) - 1.0));
		if set_level(space, w, island, next, lease_ms).await? { changed += 1.0; }
	}
	Ok(changed)
}

/// `stormRaisesWind`: a storm surge is a gale on its island.
pub async fn storm_raises_wind(space: &Space, w: &Json, room_id: Option<&str>, lease_ms: f64) -> Result<()> {
	let island = room_id.and_then(|r| island_of(w, r));
	if let (Some(d), Some(island)) = (j::opt(w, "wind"), island) { set_level(space, w, island, j::a(d, "names").len() as f64 - 1.0, lease_ms).await?; }
	Ok(())
}

/// `wetter`.
pub async fn wetter(c: &mut Ctx, _arg: &str) -> Result<()> {
	let Some(d) = j::opt(c.w(), "wind").cloned() else { return refuse("In dieser Welt gibt es kein Wetter.") };
	let room = room_of(c, None).await?;
	let island = j::so(&room, "island").filter(|i| !i.is_empty()).map(str::to_owned);
	let level = level_of(&c.space, j::so(&room, "island"), c.txn()).await?;
	let fog = c.space.peek(&tmpl("Fog", obj! { "room" => j::at(&room, "roomId").clone() }), c.txn()).await?;
	let at = |a: &str| j::a(&d, a).get(level as usize).filter(|_| level >= 0.0 && level.fract() == 0.0);
	let pace = at("mill").and_then(Json::as_f64).unwrap_or(1.0);
	let thick = fog.map_or(0.0, |f| j::n(fields(&f), "level"));
	let name = at("names").map_or_else(|| "undefined".to_owned(), key_text);
	let mills = if pace == 1.0 { "die Mühlen mahlen in ihrem Takt".to_owned() } else if pace > 1.0 { format!("die Mühlen mahlen {}-mal so schnell", phi_json::number_text(pace)) } else { "die Mühlen mahlen nur langsam".to_owned() };
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &format!("{name}{}; {mills}. {}", island.map_or_else(String::new, |i| format!(" über {i}")), if thick > 0.0 { "Nebel liegt über dem Land." } else { "Die Sicht ist klar." }), MsgOpts::default()).await
}
