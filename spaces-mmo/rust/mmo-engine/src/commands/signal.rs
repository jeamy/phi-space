//! Signal fires (`server/engine/commands/signal.ts`): `signalfeuer` tells the chains of this island and the longest runs of
//! the islands of this region.
use phi_json::obj;

use crate::clock::world_now_of;
use crate::context::{msg, Ctx, MsgOpts};
use crate::fire::{chains_of, key_text};
use crate::j;
use crate::js;
use crate::space::{fields, Result};

/// `spanText`: a span of world time in words.
pub fn span_text(ms: f64) -> String {
	let (min, h, d) = (js::round(ms / 60_000.0), js::round(ms / 3_600_000.0), js::round(ms / (24.0 * 3_600_000.0)));
	let nt = phi_json::number_text;
	if min < 60.0 { return format!("{} Weltminute{}", nt(1f64.max(min)), if min == 1.0 { "" } else { "n" }); }
	if h < 48.0 { return format!("{} Weltstunde{}", nt(h), if h == 1.0 { "" } else { "n" }); }
	format!("{} Welttage", nt(d))
}

/// `signalfeuer`.
pub async fn signalfeuer(c: &mut Ctx, _arg: &str) -> Result<()> {
	let w = c.world.clone();
	let room_of = |id: &str| j::by(j::a(&w, "rooms"), "roomId", id);
	let room_name = |id: &str| room_of(id).map_or_else(|| id.to_owned(), |r| key_text(j::at(r, "name")));
	let island = room_of(c.room()).and_then(|r| j::opt(r, "island")).map_or_else(|| key_text(j::at(&w, "title")), key_text);
	let fire = |id: &str| j::by(j::a(&w, "beacons"), "beaconId", id).map_or_else(|| id.to_owned(), |b| key_text(j::at(b, "name")));
	let now = world_now_of(&c.space, c.txn()).await?;
	let chains: Vec<_> = chains_of(&c.space, &w, c.txn()).await?.into_iter().filter(|x| x.islands.contains(&island)).collect();
	let mut lines: Vec<String> = chains.iter().map(|x| format!("Die Signalfeuer in {} verbinden die Feuer {}; {}",
		x.rooms.iter().map(|r| room_name(r)).collect::<Vec<_>>().join(", "), x.fires.iter().map(|f| fire(f)).collect::<Vec<_>>().join(", "),
		if x.lit { "die Kette brennt, ihre Feuer teilen ihr Licht.".to_owned() } else { format!("die Kette ist unterbrochen; aus: {}.", x.out.iter().map(|o| fire(&o.0)).collect::<Vec<_>>().join(", ")) })).collect();
	if chains.is_empty() { lines.push(format!("Auf {island} bilden keine Signalfeuer eine Kette. Ein Signalfeuer (ab der Epoche Netz) in zwei Räumen nebeneinander, auch über eine Fähre, im Licht zweier Feuer verbindet sie: Solange beide brennen, teilen sie ihr Licht.")); }
	let mut runs: Vec<(String, f64, f64)> = c.space.read_all(&obj! { "type" => "FireChain" }, c.txn()).await?.iter().map(|e| {
		let f = fields(e);
		let since = j::n(f, "since");
		(key_text(j::at(f, "island")), since, j::n(f, "best").max(if since != 0.0 && !since.is_nan() { now - since } else { 0.0 }))
	}).filter(|r| r.2 > 0.0).collect();
	runs.sort_by(|a, b| { let d = b.2 - a.2; if d != 0.0 && !d.is_nan() { d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal) } else { js::locale_compare(&a.0, &b.0) } });
	if let Some(here) = runs.iter().find(|r| r.0 == island) { if here.1 != 0.0 && !here.1.is_nan() { lines.push(format!("Die Kette brennt auf {island} seit {} ohne Unterbrechung.", span_text(now - here.1))); } }
	if !runs.is_empty() { lines.push(format!("Am längsten brannte eine Kette hier in der Gegend: {}.", runs.iter().take(5).enumerate().map(|(i, r)| format!("{}. {} ({})", i + 1, r.0, span_text(r.2))).collect::<Vec<_>>().join(", "))); }
	let me = c.char_id().to_owned();
	for line in lines { msg(c, &me, "info", &line, MsgOpts::default()).await?; }
	Ok(())
}
