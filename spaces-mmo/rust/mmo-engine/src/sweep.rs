//! The sweep (`server/engine/sweep.ts`): what the world gave a world-time life to is taken away when that time is up:
//! flotsam, awake roles, orders, listings, wanted notices, things that turn (spoil or grow up), then the building's part
//! (`build_sweep`). Each thing in a transaction of its own, so what someone takes at that moment is theirs.
use phi_json::{obj, Json};

use crate::clock::{decay_now_of, world_now_of};
use crate::commands::build::{anew, build_sweep};
use crate::context::to_player;
use crate::fire::key_text;
use crate::j;
use crate::js;
use crate::prototypes::{resolve_prototype, spawn, At};
use crate::source::time_now;
use crate::space::{by_id, fields, tmpl, Result, Space, FOREVER, NO_WAIT};

fn txt(v: &Json) -> String { key_text(v) }

/// A transaction of its own: committed when `run` says so, else aborted.
async fn in_txn<'a, F, Fut>(space: &'a Space, run: F) -> Result<()> where F: FnOnce(String) -> Fut, Fut: std::future::Future<Output = Result<bool>> + 'a {
	let txn = space.create_transaction(10_000.0).await?;
	match run(txn.clone()).await {
		Ok(true) => space.commit(&txn).await,
		Ok(false) => space.abort(&txn).await,
		Err(e) => { let _ = space.abort(&txn).await; Err(e) }
	}
}

/// `takeIfLapsed`.
async fn take_if_lapsed(space: &Space, e: &Json, ty: &str) -> Result<()> {
	in_txn(space, |txn| async move { Ok(space.take_if_exists(&by_id(ty, e), NO_WAIT, Some(&txn)).await?.is_some()) }).await
}

/// `wantedLapsed`: taken, and the one who sought it told (its coins go back with the market tick).
async fn wanted_lapsed(space: &Space, e: &Json, w: &Json) -> Result<()> {
	in_txn(space, |txn| async move {
		let Some(t) = space.take_if_exists(&by_id("Wanted", e), NO_WAIT, Some(&txn)).await? else { return Ok(false) };
		let f = fields(&t);
		let count = j::no(f, "count").unwrap_or(1.0);
		let lot = if count > 1.0 { format!("{}× {}", phi_json::number_text(count), txt(j::at(f, "protoName"))) } else { txt(j::at(f, "protoName")) };
		let room = j::s(f, "room");
		let board = j::by(j::ao(w, "allRooms").unwrap_or(j::a(w, "rooms")), "roomId", room).map_or_else(|| room.to_owned(), |r| txt(j::at(r, "name")));
		let price = j::n(f, "price");
		let text = format!("Dein Gesuch nach {lot} am Marktbrett ({board}) ist abgelaufen; niemand hat geliefert. Deine {} Münze{} bekommst du zurück.", phi_json::number_text(price), if price == 1.0 { "" } else { "n" });
		to_player(space, &obj! { "room" => room, "to" => j::at(f, "buyer").clone(), "kind" => "info", "text" => text, "from" => "Marktbrett", "fromId" => "market", "at" => time_now() }, Some(&txn)).await?;
		Ok(true)
	}).await
}

/// `turnItem`: fresh meat spoils and goes, a young animal grows up where it is; its owner is told when it was carried.
async fn turn_item(space: &Space, e: &Json, w: &Json) -> Result<()> {
	in_txn(space, |txn| async move {
		let Some(t) = space.take_if_exists(&by_id("Item", e), NO_WAIT, Some(&txn)).await? else { return Ok(false) };
		let f = fields(&t).clone();
		let p = resolve_prototype(space, j::s(&f, "proto")).await?;
		// in a building's chest beside a barrel or a crate (WorldDef.keeps) it keeps fresh: it turns that much later, once
		let turns = p.as_ref().map(|p| j::at(p, "turns")).filter(|t| j::truthy(t));
		if let Some(turns) = turns.filter(|_| !j::truthy(j::at(&f, "kept")) && f.get("turnsAtMs").is_some_and(|v| !v.is_null())) {
			let proto = j::at(&f, "proto");
			if let Some(k) = j::a(w, "keeps").iter().find(|k| j::a(k, "keeps").iter().any(|x| x == proto)) {
				let loc = j::at(&f, "location").clone();
				if space.count(&tmpl("Building", obj! { "buildId" => loc.clone() }), Some(&txn)).await? > 0.0 && space.count(&tmpl("Item", obj! { "location" => loc, "proto" => j::at(k, "proto").clone() }), Some(&txn)).await? > 0.0 {
					let mut g = j::object(&f);
					g.insert("turnsAtMs", Json::from(j::n(&f, "turnsAtMs") + j::n(turns, "afterMs") * (j::n(k, "factor") - 1.0)));
					g.insert("kept", Json::Bool(true));
					space.write(&anew(&t, Json::Object(g)), Some(&txn), FOREVER).await?;
					return Ok(true);
				}
			}
		}
		let into_key = p.as_ref().and_then(|p| j::so(j::at(p, "turns"), "into")).map(str::to_owned);
		let into = match into_key { Some(k) if !k.is_empty() => resolve_prototype(space, &k).await?, _ => None };
		let loc = txt(j::at(&f, "location"));
		if let Some(i) = &into { spawn(space, Some(&txn), w, i, At { location: loc.clone(), x: j::n(&f, "x"), y: j::n(&f, "y"), ..Default::default() }, &Json::Null).await?; }
		let ch = space.read_all(&tmpl("Character", obj! { "charId" => loc.as_str() }), Some(&txn)).await?;
		if let Some(Json::String(room)) = ch.first().map(|c| j::at(fields(c), "room")) {
			let name = txt(j::at(&f, "name"));
			let text = match &into {
				Some(i) => { let n = txt(j::at(i, "name")); format!("Dein {name} ist herangewachsen: jetzt {} {n}.", if js::re("e$", "").test(&n) { "eine" } else { "ein" }) }
				None => format!("{name} ist verdorben; du wirfst es weg. Geräuchert, gepökelt oder gekocht hält es länger."),
			};
			to_player(space, &obj! { "room" => room.as_str(), "to" => loc.as_str(), "kind" => "info", "text" => text, "from" => "", "fromId" => "", "at" => time_now() }, Some(&txn)).await?;
		}
		Ok(true)
	}).await
}

fn or_inf(f: &Json, k: &str) -> f64 { j::no(f, k).unwrap_or(f64::INFINITY) }

/// `sweepTick`.
pub async fn sweep_tick(space: &Space, w: &Json) -> Result<()> {
	let now = world_now_of(space, None).await?;
	let kept = decay_now_of(space, None).await?;
	for e in space.read_all(&tmpl("Item", obj! { "flotsam" => true }), None).await? {
		if j::no(fields(&e), "expiresWorldMs").is_some_and(|x| x <= now) { take_if_lapsed(space, &e, "Item").await?; }
	}
	for e in space.read_all(&obj! { "type" => "NpcAwake" }, None).await? {
		let until = fields(&e).get("untilWorldMs").filter(|v| !v.is_null()).map_or(0.0, j::number);
		if until <= kept { take_if_lapsed(space, &e, "NpcAwake").await?; }
	}
	for e in space.read_all(&obj! { "type" => "Order" }, None).await? { if or_inf(fields(&e), "expiresWorldMs") <= now { take_if_lapsed(space, &e, "Order").await?; } }
	for e in space.read_all(&obj! { "type" => "Listing" }, None).await? { if or_inf(fields(&e), "expiresWorldMs") <= kept { take_if_lapsed(space, &e, "Listing").await?; } }
	for e in space.read_all(&obj! { "type" => "Wanted" }, None).await? { if or_inf(fields(&e), "expiresWorldMs") <= kept { wanted_lapsed(space, &e, w).await?; } }
	for e in space.read_all(&tmpl("Item", obj! { "turns" => true }), None).await? {
		let f = fields(&e);
		if !j::b(f, "listing") && or_inf(f, "turnsAtMs") <= kept { turn_item(space, &e, w).await?; }
	}
	build_sweep(space, w).await
}
